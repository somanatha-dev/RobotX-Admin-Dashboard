jest.mock("../../../src/db/prisma");
// No network in a unit test: every Mapbox profile fails, so the legacy service falls back to
// its straight-line path — which is still a write over the route cache if it is reached.
jest.mock("../../../src/services/mapbox.service", () => ({
  directionsWithDistance: jest.fn(async () => {
    throw new Error("mapbox unavailable in tests");
  }),
}));

const fs = require("fs");
const path = require("path");
const { getPrisma } = require("../../../src/db/prisma");
const { rerouteTask } = require("../../../src/controllers/tasks.controller");
const taskService = require("../../../src/services/task.service");
const { createTestKv } = require("../../helpers/testKv");
const { createFakeIo } = require("../../helpers/fakeSocket");
const { waitFor } = require("../../helpers/waitFor");

const BACKEND = path.resolve(__dirname, "../../..");

// F3 — the legacy `POST /api/tasks/:taskId/reroute` computes a fresh Mapbox (or straight-line)
// path and writes it over `taskPath:*`, resets `robotTaskState:*`, redraws the dashboard route
// and sends the robot `REROUTE_ALERT` — none of which touches the engine's durable PRICED_ROUTE
// or the OFFER it signed. For a task the engine manages (it has a Leg) that splits the priced,
// driven and drawn routes, and the completion corridor is graded against the OFFER's. Refused
// exactly as P1.4 refuses the legacy cancel: 409, nothing written. A legacy task is unchanged.
describe("tasks.controller — rerouteTask on an engine-managed task (F3)", () => {
  let prisma;
  let kv;
  let io;

  const ROUTE_CACHE = JSON.stringify({ toPickup: [{ lat: 12.9081, lon: 77.5012 }], toDrop: [{ lat: 12.9095, lon: 77.5031 }] });
  const TASK_STATE = JSON.stringify({ phase: "TO_PICKUP", pathIndex: 7 });

  function makeRes() {
    const res = { body: null, statusCode: 200 };
    res.status = jest.fn((c) => {
      res.statusCode = c;
      return res;
    });
    res.json = jest.fn((b) => {
      res.body = b;
      return res;
    });
    return res;
  }

  /** Run the controller; resolves with the response, or the error passed to `next`. */
  async function call(taskId) {
    const res = makeRes();
    const next = jest.fn();
    rerouteTask({ params: { taskId }, app: { locals: { kv, io } } }, res, next);
    await waitFor(() => res.json.mock.calls.length > 0 || next.mock.calls.length > 0);
    return { res, error: next.mock.calls[0] ? next.mock.calls[0][0] : null };
  }

  beforeEach(async () => {
    prisma = {
      task: { findUnique: jest.fn() },
      leg: { findFirst: jest.fn() },
    };
    getPrisma.mockReturnValue(prisma);
    ({ kv } = await createTestKv());
    await kv.set("taskPath:TSK-1", ROUTE_CACHE);
    await kv.set("robotTaskState:RBT-1", TASK_STATE);
    io = createFakeIo();
  });

  afterEach(() => jest.restoreAllMocks());

  for (const legState of ["QUEUED", "OFFERED", "ACCEPTED", "EN_ROUTE_PICKUP", "LOADED", "EN_ROUTE_DROP"]) {
    test(`a task whose Leg is ${legState} is refused with 409 ENGINE_REROUTE_UNAVAILABLE, and nothing is written`, async () => {
      // A real engine-managed task: assigned, its robot positioned — everything the legacy
      // service needs to go on and overwrite the route. Each read answers its own query.
      prisma.task.findUnique.mockImplementation(async (args) =>
        args.select && args.select.id
          ? { id: "db-task-1" }
          : {
              taskId: "TSK-1",
              pickupLat: 12.9085,
              pickupLon: 77.502,
              dropLat: 12.9095,
              dropLon: 77.5031,
              robot: { robotId: "RBT-1", lat: 12.9081, lon: 77.5012 },
            },
      );
      prisma.leg.findFirst.mockResolvedValueOnce({ state: legState });
      const service = jest.spyOn(taskService, "rerouteTask");
      // The robot is connected, so a REROUTE_ALERT would be delivered to its room — and seen.
      io.joinRoom("robot:RBT-1");

      const { res, error } = await call("TSK-1");

      expect(error).toBeNull();
      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ ok: false, code: "ENGINE_REROUTE_UNAVAILABLE" });
      // The dashboard's request client shows `message` to the operator.
      expect(res.body.message).toMatch(/managed by the assignment engine/);
      expect(res.body.error).toBe(res.body.message);
      // The legacy service — the only writer of the route cache, the task state, the dashboard
      // route and the robot's REROUTE_ALERT on this path — is never reached.
      expect(service).not.toHaveBeenCalled();
      expect(await kv.get("taskPath:TSK-1")).toBe(ROUTE_CACHE);
      expect(await kv.get("robotTaskState:RBT-1")).toBe(TASK_STATE);
      expect(io.roomEmits("dashboard")).toEqual([]);
      expect(io.emit).not.toHaveBeenCalled();
      expect(io.roomEmits("robot:RBT-1")).toEqual([]);
      // The same §2.8 relationship P1.4's cancel refusal asks.
      expect(prisma.task.findUnique.mock.calls[0][0]).toEqual({ where: { taskId: "TSK-1" }, select: { id: true } });
      expect(prisma.leg.findFirst.mock.calls[0][0].where).toEqual({ mission: { tasks: { some: { id: "db-task-1" } } } });
    });
  }

  test("a task with no engine Leg (legacy) is rerouted through the existing service, its answer unchanged", async () => {
    prisma.task.findUnique.mockResolvedValueOnce({ id: "db-task-2" });
    prisma.leg.findFirst.mockResolvedValueOnce(null);
    const answer = { taskId: "TSK-2", robotId: "RBT-2", segment: "toDrop", pointCount: 42 };
    const service = jest.spyOn(taskService, "rerouteTask").mockResolvedValueOnce(answer);

    const { res, error } = await call("TSK-2");

    expect(error).toBeNull();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, ...answer });
    expect(service).toHaveBeenCalledTimes(1);
    expect(service).toHaveBeenCalledWith(prisma, "TSK-2", { kv, io });
  });

  test("an unknown task still reaches the service and gets its 404, as before (no Leg lookup)", async () => {
    // The controller's own lookup finds nothing; the service's lookup is the one that answers.
    prisma.task.findUnique.mockResolvedValue(null);

    const { res, error } = await call("TSK-NONE");

    expect(res.json).not.toHaveBeenCalled();
    expect(error).toMatchObject({ status: 404, message: "Task not found" });
    expect(prisma.leg.findFirst).not.toHaveBeenCalled();
  });

  test("a legacy task with no robot still gets the service's 400, as before", async () => {
    prisma.task.findUnique
      .mockResolvedValueOnce({ id: "db-task-4" })
      .mockResolvedValueOnce({ taskId: "TSK-4", robot: null });
    prisma.leg.findFirst.mockResolvedValueOnce(null);

    const { error } = await call("TSK-4");

    expect(error).toMatchObject({ status: 400, message: "No robot assigned to task" });
  });

  test("a missing taskId is still a 400 before anything is read", async () => {
    const { error } = await call(undefined);
    expect(error).toMatchObject({ status: 400, message: "taskId is required" });
    expect(prisma.task.findUnique).not.toHaveBeenCalled();
  });
});

describe("F3 — what did not change around the endpoint", () => {
  test("the route keeps its authentication and its rate limiter, in the same order", () => {
    const source = fs.readFileSync(path.join(BACKEND, "src/routes/tasks.routes.js"), "utf8");
    expect(source).toMatch(/router\.use\(authUser\);[\s\S]*router\.post\("\/:taskId\/reroute", rerouteLimiter, tasksController\.rerouteTask\);/);
    expect(source).toMatch(
      /const rerouteLimiter = createRateLimiter\(\{ windowMs: 60_000, limit: 30,\s+keyPrefix: "task_reroute" \}\);/,
    );
  });

  test("nothing in the backend or the dashboard calls the endpoint or the service except its own route", () => {
    const roots = [path.join(BACKEND, "src"), path.join(BACKEND, "tools"), path.resolve(BACKEND, "../Frontend/src")];
    const files = [];
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") walk(full);
        } else if (/\.(js|jsx|ts|tsx)$/.test(entry.name)) {
          files.push(full);
        }
      }
    };
    roots.forEach(walk);

    const callers = [];
    for (const file of files) {
      const code = fs
        .readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      const rel = path.relative(path.resolve(BACKEND, ".."), file).split(path.sep).join("/");
      // A use is the path itself or a call through a module (`taskService.rerouteTask`); the
      // service's own definition (`async function rerouteTask(`) is neither.
      if (/\/reroute\b/.test(code) || /\.rerouteTask\b/.test(code)) callers.push(rel);
    }
    // The route registers the controller; the controller calls the service. No one else.
    expect(callers.sort()).toEqual([
      "Backend/src/controllers/tasks.controller.js",
      "Backend/src/routes/tasks.routes.js",
    ]);
  });
});

/**
 * C3 — the legacy TASK_ASSIGN restart sweep is engine-gated.
 *
 * Five seconds after boot the sweep re-sends `TASK_ASSIGN` for every ASSIGNED / IN_PROGRESS
 * Task whose route is cached under `taskPath:{taskId}`. The engine's OFFER_ACCEPT projection
 * writes exactly those (Task → ASSIGNED, `taskPath:`), so with Redis — where the keys survive
 * a restart — the sweep would re-send an unsigned, unfenced TASK_ASSIGN for a mission the
 * engine already committed. With the in-memory KV the keys die with the process, which is
 * why the defect was latent.
 *
 * "Redis on" and "Redis off" are modelled by what the KV holds after a restart: the sweep
 * has no Redis branch of its own, only the question of whether `taskPath:` survived. An
 * empty KV is the in-memory restart; a KV still holding the route is the Redis restart.
 */

const fs = require("fs");
const path = require("path");
const { createTestKv } = require("../../helpers/testKv");
const { createFakeIo } = require("../../helpers/fakeSocket");
const { createMockPrisma } = require("../../helpers/mockPrisma");

const BACKEND = path.join(__dirname, "../../..");
const redispatch = require("../../../src/services/legacyTaskRedispatch.service");

const ROUTE = { toPickup: [[12.9, 77.5], [12.901, 77.501]], toDrop: [[12.901, 77.501], [12.902, 77.502]] };
const TASKS = [
  { taskId: "TSK-A", pickupLat: 12.9, pickupLon: 77.5, dropLat: 12.902, dropLon: 77.502, robot: { robotId: "R1" } },
  { taskId: "TSK-NO-ROBOT", pickupLat: 1, pickupLon: 1, dropLat: 2, dropLon: 2, robot: null },
  { taskId: "TSK-NO-ROUTE", pickupLat: 1, pickupLon: 1, dropLat: 2, dropLon: 2, robot: { robotId: "R2" } },
];

const logger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });

/** The world a restarted process sees: Tasks in the database, and whatever the KV kept. */
async function restartedWorld({ routeSurvived }) {
  const prisma = createMockPrisma();
  prisma.task.findMany.mockResolvedValue(TASKS);
  const { kv } = await createTestKv();
  if (routeSurvived) await kv.set("taskPath:TSK-A", JSON.stringify(ROUTE), { ex: 86400 });
  const io = createFakeIo();
  io.joinRoom("robot:R1", { id: "sock-R1" });
  io.joinRoom("robot:R2", { id: "sock-R2" });
  return { prisma, kv, io, logger: logger() };
}

function timerSpy() {
  const calls = [];
  const setTimer = jest.fn((fn, ms) => {
    calls.push({ fn, ms });
    return { handle: calls.length };
  });
  return { setTimer, calls };
}

describe("C3 — engine OFF: the legacy sweep is unchanged", () => {
  test("the timer is registered for 5 s", async () => {
    const world = await restartedWorld({ routeSurvived: true });
    const { setTimer, calls } = timerSpy();
    const handle = redispatch.scheduleRestartRedispatch({ engineEnabled: false, ...world, setTimer });
    expect(handle).toEqual({ handle: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].ms).toBe(5000);
  });

  test("when it fires: TASK_ASSIGN to the holder and TASK_ASSIGNED to dashboards, as before", async () => {
    const world = await restartedWorld({ routeSurvived: true });
    const { setTimer, calls } = timerSpy();
    redispatch.scheduleRestartRedispatch({ engineEnabled: false, ...world, setTimer });
    await calls[0].fn();

    expect(world.prisma.task.findMany).toHaveBeenCalledWith({
      where: { status: { in: ["ASSIGNED", "IN_PROGRESS"] } },
      include: { robot: { select: { robotId: true } } },
    });
    const sent = world.io.emittedTo("robot:R1", "TASK_ASSIGN");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      taskId: "TSK-A",
      pickup: { lat: 12.9, lon: 77.5 },
      drop: { lat: 12.902, lon: 77.502 },
      pathToPickup: ROUTE.toPickup,
      pathToDrop: ROUTE.toDrop,
    });
    expect(world.io.emittedTo("dashboard", "TASK_ASSIGNED")).toEqual([
      {
        taskId: "TSK-A",
        robotId: "R1",
        pickup: { lat: 12.9, lon: 77.5 },
        drop: { lat: 12.902, lon: 77.502 },
        pathToPickup: ROUTE.toPickup,
        pathToDrop: ROUTE.toDrop,
        usedFallback: false,
      },
    ]);
    // A Task with no robot, or with no cached route, is skipped exactly as before.
    expect(world.io.emittedTo("robot:R2", "TASK_ASSIGN")).toHaveLength(0);
  });

  test("an in-memory restart (no route survived) sends nothing, as before", async () => {
    const world = await restartedWorld({ routeSurvived: false });
    const { setTimer, calls } = timerSpy();
    redispatch.scheduleRestartRedispatch({ engineEnabled: false, ...world, setTimer });
    await calls[0].fn();
    expect(world.io.emittedTo("robot:R1", "TASK_ASSIGN")).toHaveLength(0);
    expect(world.io.emittedTo("dashboard", "TASK_ASSIGNED")).toHaveLength(0);
  });

  test("a database error is logged and swallowed, as before", async () => {
    const world = await restartedWorld({ routeSurvived: true });
    world.prisma.task.findMany.mockRejectedValue(new Error("db down"));
    await redispatch.redispatchActiveTasks(world);
    expect(world.logger.warn).toHaveBeenCalledWith("[VR] Active task re-dispatch error", { message: "db down" });
  });
});

describe("C3 — engine ON: the sweep is never registered", () => {
  test.each([
    ["Redis OFF (in-memory KV: the route did not survive the restart)", false],
    ["Redis ON (the route survived the restart — the case the defect needs)", true],
  ])("%s: no timer, no database read, no TASK_ASSIGN", async (_name, routeSurvived) => {
    const world = await restartedWorld({ routeSurvived });
    const { setTimer } = timerSpy();
    const handle = redispatch.scheduleRestartRedispatch({ engineEnabled: true, ...world, setTimer });

    expect(handle).toBeNull();
    expect(setTimer).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(world.prisma.task.findMany).not.toHaveBeenCalled();
    expect(world.io.emittedTo("robot:R1", "TASK_ASSIGN")).toHaveLength(0);
    expect(world.io.emittedTo("dashboard", "TASK_ASSIGNED")).toHaveLength(0);
    expect(world.logger.info).toHaveBeenCalledWith(expect.stringMatching(/restart sweep not started/), { engineEnabled: true });
  });

  test("control: the same Redis-ON world with the engine OFF does re-send — the gate is what stops it", async () => {
    const world = await restartedWorld({ routeSurvived: true });
    const { setTimer, calls } = timerSpy();
    redispatch.scheduleRestartRedispatch({ engineEnabled: false, ...world, setTimer });
    await calls[0].fn();
    expect(world.io.emittedTo("robot:R1", "TASK_ASSIGN")).toHaveLength(1);
  });

  test("a caller that does not say (undefined / non-boolean) gets no sweep: fails closed", async () => {
    for (const engineEnabled of [undefined, null, "false", 0]) {
      const world = await restartedWorld({ routeSurvived: true });
      const { setTimer } = timerSpy();
      expect(redispatch.scheduleRestartRedispatch({ engineEnabled, ...world, setTimer })).toBeNull();
      expect(setTimer).not.toHaveBeenCalled();
    }
  });

  test("with the real setTimeout and the engine ON, no timer is ever created", async () => {
    const world = await restartedWorld({ routeSurvived: true });
    const spy = jest.spyOn(global, "setTimeout");
    try {
      expect(redispatch.scheduleRestartRedispatch({ engineEnabled: true, ...world })).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("C3 — the production wiring", () => {
  const server = fs.readFileSync(path.join(BACKEND, "server.js"), "utf8");

  test("server.js passes the same engine flag that gates the engine workers", () => {
    expect(server).toMatch(/const engineEnabled = cutoverEnabled\.processEnabled\(\);/);
    expect(server).toContain("scheduleRestartRedispatch({ engineEnabled, prisma, kv, io, logger });");
    expect(server.match(/scheduleRestartRedispatch\(/g)).toHaveLength(1);
  });

  test("server.js no longer carries an inline re-dispatch of its own", () => {
    expect(server).not.toContain("dispatchTaskAssign(");
    expect(server).not.toMatch(/require\([^)]*\)[^\n]*dispatchTaskAssign|dispatchTaskAssign[^\n]*require\(/);
    expect(server).not.toContain("kv.get(`taskPath:");
    expect(server).not.toMatch(/setTimeout\(async \(\) => \{\s*try \{\s*const activeTasks/);
    expect(server).not.toContain("[VR] Re-dispatched task");
  });

  test("no second restart re-dispatch mechanism: the sweep module is TASK_ASSIGN's only producer", () => {
    const callers = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js") && /dispatchTaskAssign\(/.test(fs.readFileSync(full, "utf8"))) {
          callers.push(path.relative(BACKEND, full).split(path.sep).join("/"));
        }
      }
    };
    walk(path.join(BACKEND, "src"));
    // The definition (commandDispatcher) and the one caller (this sweep).
    expect(callers.sort()).toEqual(["src/services/commandDispatcher.service.js", "src/services/legacyTaskRedispatch.service.js"]);
  });
});

/**
 * `OFFER_ACCEPT` publishes the assignment to the surfaces built against the legacy schema
 * (P0-8, P0-9).
 *
 * The handler is the seam where an authoritative decision becomes visible to the existing
 * UI. What is asserted here is the ordering and the containment: the read model is written
 * *after* the accept transaction and *outside* it, `TASK_ASSIGNED` carries the route the
 * agent was actually offered, and a projection failure never reaches the agent response.
 */

const { registerOfferHandlers } = require("../../../src/sockets/handlers/offer.handler");
const { createFakeSocket, createFakeIo } = require("../../helpers/fakeSocket");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { createTestKv } = require("../../helpers/testKv");
const { waitFor } = require("../../helpers/waitFor");
const agentGate = require("../../../src/engine/cutover/agentGate");
const silentLogger = require("../../mocks/silentLogger");

const TASK = Object.freeze({
  id: "task-row-1",
  taskId: "TSK-1",
  status: "PENDING",
  pickup: "Gate 1, RNSIT",
  pickupLat: 12.9081,
  pickupLon: 77.5012,
  drop: "Block C, RNSIT",
  dropLat: 12.9105,
  dropLon: 77.5044,
});

const PATH_TO_PICKUP = [{ lat: 12.906, lon: 77.499 }, { lat: 12.9081, lon: 77.5012 }];
const PATH_TO_DROP = [{ lat: 12.9081, lon: 77.5012 }, { lat: 12.9105, lon: 77.5044 }];

/**
 * A published snapshot whose shard is cut over, so `agentGate.assess` admits the socket.
 *
 * `execute.start_grace` is present because §4.5 arms the entered state's deadline in the
 * same transaction, and `legEntryDeadline` refuses an unresolved parameter rather than
 * defaulting one — correctly. A snapshot without it exercises that refusal, not the
 * handler.
 */
function liveSnapshot() {
  return {
    resolve: (name) => (name === "cutover.engine_enabled" ? true : null),
    values: new Map([
      ["execute.start_grace", 300],
      // §4.3's deadline for QUEUED, which is where a REJECT returns the Leg.
      ["sla.assignment_deadline", 900],
      ["plan.commitment_horizon", 900],
    ]),
  };
}

const ENGINE_ENABLED_BEFORE = process.env.ENGINE_ENABLED;
beforeAll(() => {
  process.env.ENGINE_ENABLED = "true";
});
afterAll(() => {
  process.env.ENGINE_ENABLED = ENGINE_ENABLED_BEFORE;
});

/**
 * An authenticated agent session on a shard the staging order has reached.
 *
 * `agentGate.assess` reads the session flag and the cached shard identity that
 * `robot.handler` stamps at AUTH, so the fixture stamps the same two things through the
 * gate's own `bind()` rather than hand-writing its internal key.
 */
function authenticateAsAgent(socket) {
  socket.data.robotId = "RBT-1000";
  socket.data.isAuthed = true;
  agentGate.bind(socket, {
    agentId: "RBT-1000",
    shardId: "SHARD-1",
    regionId: "RGN-BLR",
    resolvedAtMs: Date.now(),
  });
  return socket;
}

function harness({ withGeometry = true, taskStatus = "PENDING" } = {}) {
  const prisma = createMockPrisma();

  prisma.agent.findUnique.mockResolvedValue({ id: "agent-row-1", agentId: "RBT-1000", fenceCounter: 5n });
  prisma.commitment = {
    findUnique: jest.fn().mockResolvedValue({
      commitmentId: "CMT-1",
      agentId: "agent-row-1",
      legId: "leg-row-1",
      fence: 5n,
      version: 0,
      releasedAt: null,
    }),
    update: jest.fn().mockResolvedValue({}),
  };
  prisma.leg.findUnique.mockImplementation(async ({ where }) =>
    where.id === "leg-row-1"
      ? { id: "leg-row-1", legId: "LEG-TSK-1", version: 0, state: "OFFERED", mission: { tasks: [{ ...TASK, status: taskStatus }] } }
      : null,
  );
  prisma.leg.updateMany.mockResolvedValue({ count: 1 });
  // §10.6 — the store clock is read through the transaction client, so the fake supplies
  // one. A test whose transaction has no clock exercises the throw, not the handler.
  prisma.$queryRawUnsafe.mockResolvedValue([{ now: new Date() }]);

  prisma.robot.findUnique.mockResolvedValue({ id: "robot-row-1", currentTaskId: null });
  prisma.task.updateMany.mockResolvedValue({ count: taskStatus === "PENDING" ? 1 : 0 });
  prisma.robot.updateMany.mockResolvedValue({ count: 1 });

  // Every real OFFER row carries the instant the agent was told it expires; P2B-2's
  // response guard reads it, so the fixture states one in the future.
  const notValidAfter = new Date(Date.now() + 60_000);
  prisma.outbox.findFirst.mockResolvedValue(
    withGeometry
      ? {
          notValidAfter,
          payload: {
            stopSequence: [
              { sequence: 0, stopType: "PICKUP", path: PATH_TO_PICKUP },
              { sequence: 1, stopType: "DROP", path: PATH_TO_DROP },
            ],
          },
        }
      : { notValidAfter, payload: { stopSequence: [{ sequence: 0 }, { sequence: 1 }] } },
  );

  return prisma;
}

async function accept(prisma, kv) {
  const io = createFakeIo();
  const socket = createFakeSocket();
  authenticateAsAgent(socket);

  registerOfferHandlers(io, socket, {
    prisma,
    kv,
    logger: silentLogger,
    config: { leaseDurationSeconds: 300 },
    appLocals: { config: liveSnapshot() },
  });

  socket.trigger("OFFER_ACCEPT", { commitmentId: "CMT-1", fence: "5" });
  return { io, socket };
}

describe("OFFER_ACCEPT — the legacy read model (P0-9)", () => {
  let kv;
  beforeEach(async () => {
    ({ kv } = await createTestKv());
  });

  test("projects Task.robotId, Task.status and Robot.currentTaskId after the accept commits", async () => {
    const prisma = harness();
    await accept(prisma, kv);

    await waitFor(() => prisma.task.updateMany.mock.calls.length > 0);
    expect(prisma.task.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ robotId: "robot-row-1", status: "ASSIGNED" }) }),
    );
    expect(prisma.robot.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { currentTaskId: "task-row-1", status: "ACTIVE" } }),
    );
  });

  test("the projection runs after the Leg reached ACCEPTED, never before", async () => {
    const prisma = harness();
    const order = [];
    prisma.leg.updateMany.mockImplementation(async () => {
      order.push("leg-accepted");
      return { count: 1 };
    });
    prisma.task.updateMany.mockImplementation(async () => {
      order.push("task-projected");
      return { count: 1 };
    });

    await accept(prisma, kv);
    await waitFor(() => order.includes("task-projected"));
    expect(order.indexOf("leg-accepted")).toBeLessThan(order.indexOf("task-projected"));
  });

  test("emits TASK_UPDATED so the Tasks list stops showing PENDING", async () => {
    const prisma = harness();
    const { io } = await accept(prisma, kv);

    await waitFor(() => io.emittedTo("dashboard", "TASK_UPDATED").length > 0);
    expect(io.emittedTo("dashboard", "TASK_UPDATED")[0]).toEqual(
      expect.objectContaining({ taskId: "TSK-1", robotId: "RBT-1000", status: "ASSIGNED" }),
    );
  });

  test("a task no longer PENDING is not overwritten, and no TASK_UPDATED claims it was", async () => {
    const prisma = harness({ taskStatus: "CANCELLED" });
    const { io } = await accept(prisma, kv);

    await waitFor(() => prisma.task.updateMany.mock.calls.length > 0);
    expect(prisma.robot.updateMany).not.toHaveBeenCalled();
    expect(io.emittedTo("dashboard", "TASK_UPDATED")).toHaveLength(0);
  });
});

describe("OFFER_ACCEPT — the route handoff (P0-8)", () => {
  let kv;
  beforeEach(async () => {
    ({ kv } = await createTestKv());
  });

  test("emits TASK_ASSIGNED carrying the route the agent was actually offered", async () => {
    const prisma = harness();
    const { io } = await accept(prisma, kv);

    await waitFor(() => io.emittedTo("dashboard", "TASK_ASSIGNED").length > 0);
    const payload = io.emittedTo("dashboard", "TASK_ASSIGNED")[0];

    expect(payload).toEqual({
      taskId: "TSK-1",
      robotId: "RBT-1000",
      pickup: { name: "Gate 1, RNSIT", lat: 12.9081, lon: 77.5012 },
      drop: { name: "Block C, RNSIT", lat: 12.9105, lon: 77.5044 },
      pathToPickup: PATH_TO_PICKUP,
      pathToDrop: PATH_TO_DROP,
    });
  });

  test("writes the taskPath cache the reroute path already reads", async () => {
    const prisma = harness();
    await accept(prisma, kv);

    await waitFor(async () => (await kv.get("taskPath:TSK-1")) !== null);
    const cached = JSON.parse(await kv.get("taskPath:TSK-1"));
    expect(cached.toPickup).toEqual(PATH_TO_PICKUP);
    expect(cached.toDrop).toEqual(PATH_TO_DROP);

    const state = JSON.parse(await kv.get("robotTaskState:RBT-1000"));
    expect(state).toEqual(expect.objectContaining({ taskId: "TSK-1", phase: "TO_PICKUP", pathIndex: 0 }));
  });

  test("emits no TASK_ASSIGNED when the offer carried no geometry — an event the map would drop", async () => {
    const prisma = harness({ withGeometry: false });
    const { io } = await accept(prisma, kv);

    // The status change still lands; only the route event is withheld.
    await waitFor(() => io.emittedTo("dashboard", "TASK_UPDATED").length > 0);
    expect(io.emittedTo("dashboard", "TASK_ASSIGNED")).toHaveLength(0);
  });
});

describe("OFFER_ACCEPT — the projection is contained", () => {
  let kv;
  beforeEach(async () => {
    ({ kv } = await createTestKv());
  });

  test("a projection failure does not stop the agent response being applied", async () => {
    const prisma = harness();
    prisma.task.updateMany.mockRejectedValue(new Error("read model unavailable"));

    const { io } = await accept(prisma, kv);

    // The authoritative half still happened: the Leg moved and OFFER_RESPONSE was emitted.
    await waitFor(() => io.emittedTo("dashboard", "OFFER_RESPONSE").length > 0);
    expect(prisma.leg.updateMany).toHaveBeenCalled();
    expect(prisma.commitment.update).toHaveBeenCalled();
  });

  test("a rejected offer projects nothing — there is no assignment to reflect", async () => {
    const prisma = harness();
    const io = createFakeIo();
    const socket = authenticateAsAgent(createFakeSocket());

    // §11.2 — a rejection is recorded as a feasibility observation, so the fake needs the
    // table the handler writes it to.
    prisma.observation = { create: jest.fn().mockResolvedValue({}) };
    // §4.3 — REJECT returns the Leg to QUEUED, whose deadline parameter is its own.
    prisma.leg.findUnique.mockResolvedValue({
      id: "leg-row-1",
      legId: "LEG-TSK-1",
      version: 0,
      state: "OFFERED",
      mission: { tasks: [TASK] },
    });

    registerOfferHandlers(io, socket, {
      prisma,
      kv,
      logger: silentLogger,
      // §11.2 — a rejection excludes the agent for `dispatch.nack_cooloff`, and
      // `applyReject` refuses to build a deadline from an absent duration.
      config: { nackCooloffSeconds: 60 },
      appLocals: { config: liveSnapshot() },
    });

    socket.trigger("OFFER_REJECT", { commitmentId: "CMT-1", fence: "5", reason: "NO_EXECUTABLE_PATH" });

    await waitFor(() => io.emittedTo("dashboard", "OFFER_RESPONSE").length > 0);
    expect(prisma.task.updateMany).not.toHaveBeenCalled();
    expect(io.emittedTo("dashboard", "TASK_ASSIGNED")).toHaveLength(0);
  });
});

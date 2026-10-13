/**
 * Commit-race closure, Gap A — the server refuses an `OFFER_ACCEPT` from a robot that is held.
 *
 * The race (`tests/engine/commitTimeRecheck.test.js`): a robot PAUSED after the round decided is
 * still committed — F3 is not in §10.3.2's volatile subset (frozen) — and the OFFER reaches it.
 * The engine's commit is unchanged. The binding point is the agent's ACCEPT (`OFFERED → ACCEPTED`),
 * and that is where the server now checks the robot's PERSISTED state, independently of what the
 * client says: a held (`PAUSED`, F3's own rule in both facts providers) or faulted (`ERROR`, F8's
 * BLOCKING fault) robot's ACCEPT is refused, and the offer is withdrawn at an advanced fence by the
 * engine's own withdrawal (`offers.withdrawExpiredOffer`): a signed WITHDRAW, the commitment
 * released, the Leg back to QUEUED with its deadline armed, the robot excluded for the NACK
 * cool-off. A robot row that cannot be read is refused (fail closed). When the withdrawal cannot be
 * signed, nothing is written and the offer's own TTL expiry withdraws it — the ACCEPT is never
 * applied.
 */

const { registerOfferHandlers } = require("../../../src/sockets/handlers/offer.handler");
const offerAcceptanceAdmission = require("../../../src/services/offerAcceptanceAdmission.service");
const simulatedAgentState = require("../../../src/simulation/simulatedAgentState");
const { createFakeSocket, createFakeIo } = require("../../helpers/fakeSocket");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { createTestKv } = require("../../helpers/testKv");
const agentGate = require("../../../src/engine/cutover/agentGate");
const silentLogger = require("../../mocks/silentLogger");
const physicalPolicy = require("../../../src/services/fleetProviders/physicalPolicy");
const stopLatchObservation = require("../../../src/services/stopLatchObservation.service");

const SIGNING_KEY = "offer-accept-admission-test-signing-key-0123456789";

function liveSnapshot() {
  const values = new Map([
    ["execute.start_grace", 300],
    ["sla.assignment_deadline", 900],
    ["plan.commitment_horizon", 900],
    ["dispatch.nack_cooloff", 120],
    ["dispatch.max_delivery_delay", 30],
    // F7's freshness budget for the stop-latch reading.
    ["connectivity.max_heartbeat_age", 15],
  ]);
  return {
    resolve: (name) => (name === "cutover.engine_enabled" ? true : values.has(name) ? values.get(name) : null),
    values,
  };
}

const ENGINE_BEFORE = process.env.ENGINE_ENABLED;
beforeAll(() => {
  process.env.ENGINE_ENABLED = "true";
});
afterAll(() => {
  process.env.ENGINE_ENABLED = ENGINE_BEFORE;
});

/** One robot, its agent, one OFFERED Leg and its commitment; every write recorded. */
function world({ robot = { status: "IDLE", statusBeforeOffline: null } } = {}) {
  const state = {
    robot: robot === null ? null : { robotId: "RBT-1", ...robot },
    agent: { id: "agent-1", agentId: "RBT-1", fenceCounter: 5n, authorityEpoch: 1n },
    leg: { id: "leg-1", legId: "LEG-1", version: 4, state: "OFFERED", mission: { tasks: [] } },
    commitment: { commitmentId: "CMT-1", agentId: "agent-1", legId: "leg-1", fence: 5n, version: 0, releasedAt: null },
    offer: { notValidAfter: new Date(Date.now() + 60_000), payload: { stopSequence: [] } },
    outbox: [],
    timers: [],
  };

  const prisma = createMockPrisma();
  prisma.robot.findUnique = jest.fn(async () => (state.robot ? { ...state.robot } : null));
  prisma.agent.findUnique = jest.fn(async () => ({ ...state.agent }));
  prisma.agent.update = jest.fn(async ({ data }) => Object.assign(state.agent, data));
  prisma.commitment = {
    findUnique: jest.fn(async ({ where }) => (where.commitmentId === "CMT-1" ? { ...state.commitment } : null)),
    update: jest.fn(async ({ data }) => Object.assign(state.commitment, data)),
  };
  prisma.leg.findUnique = jest.fn(async () => ({ ...state.leg }));
  prisma.leg.updateMany = jest.fn(async ({ where, data }) => {
    if (where.id !== state.leg.id || where.version !== state.leg.version) return { count: 0 };
    Object.assign(state.leg, data);
    return { count: 1 };
  });
  prisma.outbox.findFirst = jest.fn(async ({ where }) => (where.commitmentId === "CMT-1" && where.command === "OFFER" ? state.offer : null));
  prisma.outbox.findMany = jest.fn(async () => []);
  prisma.outbox.findUnique = jest.fn(async () => null);
  prisma.outbox.create = jest.fn(async ({ data }) => (state.outbox.push(data), data));
  prisma.agentFenceAudit = { upsert: jest.fn(async () => ({})) };
  prisma.timer = {
    findUnique: jest.fn(async () => null),
    create: jest.fn(async ({ data }) => (state.timers.push(data), data)),
    update: jest.fn(async ({ data }) => data),
    updateMany: jest.fn(async () => ({ count: 1 })),
  };
  prisma.observation.create = jest.fn(async () => ({}));
  prisma.$queryRawUnsafe.mockResolvedValue([{ now: new Date() }]);
  prisma.task.findFirst = jest.fn(async () => null);
  return { state, prisma };
}

/** The owner's physical fleet declaration, declaring RBT-1 under the SOFTWARE_STOP_LATCH mechanism. */
const declaring = (robotId) =>
  physicalPolicy.fromDeclaration({
    declaredBy: "test owner",
    declaredAt: "2026-10-13",
    charging: { policy: "MANUAL_OUT_OF_SERVICE" },
    stateOfCharge: { policy: "OPERATOR_DECLARED", maxAgeSeconds: 7200 },
    emergencyStop: { mechanism: "SOFTWARE_STOP_LATCH" },
    site: { ambientC: { min: 18, max: 38 }, terrain: "FLAT_DECLARED", connectivityDeadZones: "NONE_DECLARED", constrictions: "NONE_DECLARED", stopStartCyclesPerHop: 1, snapRadiusM: 50 },
    localisation: { referenceRadiusM: 25, acceptedFixTypes: ["3D", "RTK_FLOAT", "RTK_FIXED"] },
    risk: { failureProbabilityPrior: 0.05, routeHazardCu: 0 },
    robots: [
      {
        robotId,
        control: {
          firmwareVersion: "robotx-pi-agent/0.9.0",
          hardwareRevision: "rover-rev-a",
          missionTypes: ["DELIVERY"],
          calibrations: [],
          serviceDueAt: "2027-01-01T00:00:00Z",
          regionId: "rnsit",
          authorisation: "REGION",
          advisories: [],
          operatingAmbientC: { min: 0, max: 45 },
        },
        energy: { idlePowerW: 6, movingPowerW: 30, soh: 0.9, residualCv: 0.2, reserveFloorWh: 15 },
      },
    ],
  });
const PHYSICAL_POLICY = declaring("RBT-1");

async function connect(prisma, config, options) {
  const opts = options || {};
  const { kv: testKv } = await createTestKv();
  const kv = opts.kv || testKv;
  if (opts.latch) await kv.set(stopLatchObservation.stopLatchKey("RBT-1"), JSON.stringify({ robotId: "RBT-1", ...opts.latch }));
  const io = createFakeIo();
  const socket = createFakeSocket();
  socket.data.robotId = "RBT-1";
  socket.data.isAuthed = true;
  agentGate.bind(socket, { agentId: "RBT-1", shardId: "SHARD-1", regionId: "RGN-1", resolvedAtMs: Date.now() });
  registerOfferHandlers(io, socket, {
    prisma,
    kv,
    logger: silentLogger,
    config: { leaseDurationSeconds: 60, nackCooloffSeconds: 120, signingKey: SIGNING_KEY, ...(config || {}) },
    // No physical fleet unless a test declares one (`opts.policy`), as in a simulation-only process.
    appLocals: { config: liveSnapshot(), physicalFleetPolicy: opts.policy === undefined ? null : opts.policy },
  });
  return { socket, io, kv };
}

async function accept(socket) {
  socket.trigger("OFFER_ACCEPT", { commitmentId: "CMT-1", fence: "5" });
  await new Promise((resolve) => setTimeout(resolve, 40));
}

describe("a robot that is not held: ACCEPT applies as before", () => {
  test.each([["IDLE"], ["ACTIVE"], ["CHARGING"]])("%s → ACCEPTED", async (status) => {
    const { state, prisma } = world({ robot: { status, statusBeforeOffline: null } });
    const { socket } = await connect(prisma);
    await accept(socket);
    expect(state.leg.state).toBe("ACCEPTED");
    expect(state.commitment.releasedAt).toBeNull();
    expect(state.outbox).toEqual([]);
  });
});

describe("a held or faulted robot: the server refuses the ACCEPT and withdraws the offer", () => {
  test.each([
    ["PAUSED (operator STOP/PAUSE — F3)", { status: "PAUSED", statusBeforeOffline: null }, "HELD"],
    ["OFFLINE with PAUSED remembered", { status: "OFFLINE", statusBeforeOffline: "PAUSED" }, "HELD"],
    ["ERROR (blocking fault — F8)", { status: "ERROR", statusBeforeOffline: null }, "FAULTED"],
  ])("%s → not ACCEPTED; WITHDRAW at an advanced fence; Leg QUEUED; commitment released", async (_label, robot, code) => {
    const { state, prisma } = world({ robot });
    const { socket, io } = await connect(prisma);
    await accept(socket);

    expect(state.leg.state).toBe("QUEUED");
    expect(state.commitment.releasedAt).toBeInstanceOf(Date);
    expect(state.agent.fenceCounter).toBe(6n);
    expect(state.outbox).toHaveLength(1);
    expect(state.outbox[0]).toMatchObject({ command: "WITHDRAW", commitmentId: "CMT-1", fence: 6n });
    expect(state.outbox[0].payload.reason).toBe(`ACCEPT_REFUSED:${code}`);
    expect(state.outbox[0].signature).toEqual(expect.any(String));
    // The QUEUED Leg is supervised (§4.5) — its deadline armed in the same transaction.
    expect(state.timers.some((timer) => timer.state === "QUEUED")).toBe(true);
    // No assignment is published.
    expect((io._rooms.get("dashboard") || []).filter((entry) => entry.event === "OFFER_RESPONSE" || entry.event === "TASK_ASSIGNED")).toEqual([]);
  });

  test("the robot row cannot be read → refused (fail closed)", async () => {
    const { state, prisma } = world({ robot: null });
    const { socket } = await connect(prisma);
    await accept(socket);
    expect(state.leg.state).toBe("QUEUED");
    expect(state.outbox[0].payload.reason).toBe("ACCEPT_REFUSED:ROBOT_UNREADABLE");
  });

  test("the withdrawal cannot be signed → nothing is written, the Leg stays OFFERED (its TTL withdraws it) — never ACCEPTED", async () => {
    const { state, prisma } = world({ robot: { status: "PAUSED", statusBeforeOffline: null } });
    const before = process.env.COMMAND_SIGNING_KEY;
    delete process.env.COMMAND_SIGNING_KEY;
    try {
      const { socket } = await connect(prisma, { signingKey: undefined });
      await accept(socket);
    } finally {
      if (before !== undefined) process.env.COMMAND_SIGNING_KEY = before;
    }
    expect(state.leg).toMatchObject({ state: "OFFERED", version: 4 });
    expect(state.commitment.releasedAt).toBeNull();
    expect(state.outbox).toEqual([]);
  });

  test("a REJECT from a held robot is still applied as a REJECT", async () => {
    const { state, prisma } = world({ robot: { status: "PAUSED", statusBeforeOffline: null } });
    const { socket } = await connect(prisma);
    socket.trigger("OFFER_REJECT", { commitmentId: "CMT-1", fence: "5", reason: "AGENT_HELD:PAUSED" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(state.leg.state).toBe("QUEUED");
    expect(state.outbox).toEqual([]);
  });
});

describe("the server's rule is the facts providers' rule", () => {
  test.each([["IDLE"], ["ACTIVE"], ["CHARGING"], ["ISSUES"], ["PAUSED"], ["ERROR"]])(
    "Robot.status %s: refused ⇔ F3 hold or F8 BLOCKING fault in the simulated facts",
    (status) => {
      const facts = simulatedAgentState.simulatedAgentFacts({ robot: { robotId: "RBT-1", status, createdAt: new Date(), lastSeenAt: new Date() }, regionZoneIds: [] });
      const heldOrFaulted = facts.operatorHold.held === true || facts.faults.some((fault) => fault.severity === "BLOCKING");
      expect(offerAcceptanceAdmission.assess({ status, statusBeforeOffline: null }).admitted).toBe(!heldOrFaulted);
    },
  );
});


describe("a PHYSICAL robot's software stop latch at acceptance (F7's own rule, on the recorded latch)", () => {
  // The latch is what the Pi reports on TELEMETRY (`safety.stopLatch.engaged`), recorded per robot,
  // bound to the socket that reported it, stamped with the agent's measurement instant. It is the
  // SOFTWARE stop latch — the rover has no independent hardware e-stop circuit.
  // RBT-1 declared in the owner's physical fleet declaration; its current socket is sock-1.
  const physical = { status: "IDLE", statusBeforeOffline: null, socketId: "sock-1" };
  const declared = (options) => ({ policy: PHYSICAL_POLICY, ...(options || {}) });
  const fresh = (engaged, extra) => ({ socketId: "sock-1", engaged, observedAtMs: Date.now() - 2_000, ...(extra || {}) });

  test("cleared (reported not engaged, fresh, current socket) → ACCEPTED", async () => {
    const { state, prisma } = world({ robot: physical });
    const { socket } = await connect(prisma, null, declared({ latch: fresh(false) }));
    await accept(socket);
    expect(state.leg.state).toBe("ACCEPTED");
    expect(state.outbox).toEqual([]);
  });

  test("asserted (engaged) → refused ESTOP_ENGAGED; offer withdrawn, Leg QUEUED", async () => {
    const { state, prisma } = world({ robot: physical });
    const { socket } = await connect(prisma, null, declared({ latch: fresh(true) }));
    await accept(socket);
    expect(state.leg.state).toBe("QUEUED");
    expect(state.outbox[0]).toMatchObject({ command: "WITHDRAW" });
    expect(state.outbox[0].payload.reason).toBe("ACCEPT_REFUSED:ESTOP_ENGAGED");
  });

  test.each([
    ["missing (never reported)", {}],
    ["stale (older than connectivity.max_heartbeat_age)", { latch: { socketId: "sock-1", engaged: false, observedAtMs: Date.now() - 60_000 } }],
    ["reported by a replaced socket", { latch: { socketId: "sock-OLD", engaged: false, observedAtMs: Date.now() - 2_000 } }],
    ["unreadable (the store errors)", { kv: { get: async () => { throw new Error("redis down"); }, set: async () => "OK" } }],
  ])("%s → refused ESTOP_NOT_PROVEN (fail closed)", async (_label, options) => {
    const { state, prisma } = world({ robot: physical });
    const { socket } = await connect(prisma, null, declared(options));
    await accept(socket);
    expect(state.leg.state).toBe("QUEUED");
    expect(state.outbox[0].payload.reason).toBe("ACCEPT_REFUSED:ESTOP_NOT_PROVEN");
  });

  test.each([
    ["a physical fleet is declared, but not this robot (a simulated robot, whose F7 the simulator states)", declaring("RBT-OTHER")],
    ["no physical fleet is declared at all (a simulation-only process)", null],
  ])("%s: no latch is read and the ACCEPT is judged as before", async (_label, policy) => {
    const { state, prisma } = world({ robot: { status: "IDLE", statusBeforeOffline: null, socketId: "sock-1" } });
    const reads = [];
    const { kv: testKv } = await createTestKv();
    const kv = { get: async (key) => (reads.push(key), testKv.get(key)), set: (...args) => testKv.set(...args) };
    const { socket } = await connect(prisma, null, { kv, policy });
    await accept(socket);
    expect(state.leg.state).toBe("ACCEPTED");
    expect(reads.filter((key) => key.startsWith("stopLatch:"))).toEqual([]);
  });

  test("the rule never reads the simulation discriminator: physical means declared (simulationBoundary Test G)", () => {
    expect(offerAcceptanceAdmission.isDeclaredPhysical(PHYSICAL_POLICY, "RBT-1")).toBe(true);
    expect(offerAcceptanceAdmission.isDeclaredPhysical(PHYSICAL_POLICY, "SIM-ANY")).toBe(false);
    expect(offerAcceptanceAdmission.isDeclaredPhysical(null, "RBT-1")).toBe(false);
  });

  test("the hold check still comes first: a PAUSED physical robot with a cleared latch is refused HELD", async () => {
    const { state, prisma } = world({ robot: { ...physical, status: "PAUSED" } });
    const { socket } = await connect(prisma, null, declared({ latch: fresh(false) }));
    await accept(socket);
    expect(state.outbox[0].payload.reason).toBe("ACCEPT_REFUSED:HELD");
  });
});

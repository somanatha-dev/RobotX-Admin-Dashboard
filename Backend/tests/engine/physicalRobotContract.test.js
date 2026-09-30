/**
 * P2B-2 — the backend side of the physical RobotX contract
 * (`docs/contracts/ROBOTX_PI_P2B1_HANDOFF.md`).
 *
 *   G/H  telemetry: a measured fix becomes evidence; a missing, undeclared-fix or clock-ahead
 *        one does not — absence stays absence
 *   I    battery: a physical SoC is written only with a declared measurement basis
 *   J    liveness: a robot that stops heartbeating stops being admissible (F13), and F14's
 *        proof exists only for a PROBE answered on the robot's current socket
 *   K    identity: one socket speaks for one robot; a robot cannot acknowledge another's
 *        command or answer another's probe
 *   L    provider isolation: the physical facts carry nothing the simulator states
 *
 * Every rule here reads the same for a simulated agent — the provenance-specific ones are
 * the ingestion gates below the provider boundary, never the engine.
 */

const positionObservation = require("../../src/services/positionObservation.service");
const batteryObservation = require("../../src/services/batteryObservation.service");
const agentProbe = require("../../src/services/agentProbe.service");
const { createAgentFactsProvider } = require("../../src/services/agentFacts.service");
const { registerRobotHandlers } = require("../../src/sockets/handlers/robot.handler");
const { registerCommandHandlers } = require("../../src/sockets/handlers/command.handler");
const { setRobotState, getRobotState } = require("../../src/services/robotRegistry.service");
const f13 = require("../../src/engine/feasibility/predicates/f13");
const f14 = require("../../src/engine/feasibility/predicates/f14");
const { createFakeSocket, createFakeIo } = require("../helpers/fakeSocket");
const { createMockPrisma } = require("../helpers/mockPrisma");
const { createTestKv } = require("../helpers/testKv");
const silentLogger = require("../mocks/silentLogger");

const FIX = Object.freeze({ lat: 12.9081, lon: 77.5012 });

/** The position writer's store: a Robot binding and an Observation table. */
function positionStore(simulated = false) {
  const observations = [];
  return {
    observations,
    robot: { findUnique: jest.fn(async () => ({ simulated, agent: { id: "agent-row-1" } })) },
    observation: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }) => {
        observations.push(data);
        return data;
      }),
    },
  };
}

beforeEach(() => positionObservation.resetPositionObservationState());

// ═══════════════════════════════════════════════════════════════════════════
describe("G/H — physical telemetry becomes evidence only when it is a measurement", () => {
  test("a measured fix becomes a PHYSICAL position Observation, with the declared accuracy as its uncertainty", async () => {
    const prisma = positionStore(false);
    const out = await positionObservation.recordPositionObservation(prisma, {
      robotId: "robotx-pi",
      ...FIX,
      agentTimestampMs: Date.now() - 200,
      sequence: 1790000000000n,
      fix: { fixType: "3D", hAccM: 2.1 },
    });
    expect(out).toMatchObject({ written: true, provenance: "PHYSICAL" });
    expect(prisma.observations[0]).toMatchObject({
      kind: "position",
      source: "AGENT_REPORT",
      deadReckoned: false,
      uncertaintyRadiusM: 2.1,
      value: { ...FIX, provenance: "PHYSICAL" },
    });
  });

  test("no fix block at all changes nothing — no uncertainty is invented", async () => {
    const prisma = positionStore(false);
    await positionObservation.recordPositionObservation(prisma, { robotId: "robotx-pi", ...FIX, agentTimestampMs: Date.now() });
    expect(prisma.observations[0].uncertaintyRadiusM).toBeUndefined();
  });

  test.each([
    ["lat/lon omitted", { lat: null, lon: null }, "NO_REPORTED_POSITION"],
    ["timestamp omitted", { agentTimestampMs: null }, "NO_AGENT_TIMESTAMP"],
    ["a declared NO_FIX", { fix: { fixType: "NO_FIX" } }, "NO_FIX_DECLARED"],
    ["a timestamp 5 s ahead of the server", { agentTimestampMs: Date.now() + 5_000 }, "CLOCK_AHEAD"],
  ])("%s writes no Observation", async (_name, override, outcome) => {
    const prisma = positionStore(false);
    const out = await positionObservation.recordPositionObservation(prisma, {
      robotId: "robotx-pi",
      ...FIX,
      agentTimestampMs: Date.now(),
      ...override,
    });
    expect(out).toMatchObject({ written: false, outcome });
    expect(prisma.observation.create).not.toHaveBeenCalled();
  });

  test("the skew bound is time.max_clock_skew: the register's 500 ms by default, the pinned value when published", async () => {
    expect(positionObservation.maxClockSkewMsFrom(null)).toBe(500);
    const pinned = { resolve: (name) => (name === "time.max_clock_skew" ? 50 : null) };
    expect(positionObservation.maxClockSkewMsFrom(pinned)).toBe(50);

    const within = positionStore(false);
    const ok = await positionObservation.recordPositionObservation(within, { robotId: "a", ...FIX, agentTimestampMs: Date.now() + 300 });
    expect(ok.written).toBe(true);

    positionObservation.resetPositionObservationState();
    const tight = positionStore(false);
    const refused = await positionObservation.recordPositionObservation(tight, {
      robotId: "a",
      ...FIX,
      agentTimestampMs: Date.now() + 300,
      maxClockSkewMs: positionObservation.maxClockSkewMsFrom(pinned),
    });
    expect(refused.outcome).toBe("CLOCK_AHEAD");
  });

  test("the rules are the same for a simulated agent — only the provenance label differs", async () => {
    const prisma = positionStore(true);
    const ahead = await positionObservation.recordPositionObservation(prisma, { robotId: "SIM-1", ...FIX, agentTimestampMs: Date.now() + 5_000 });
    expect(ahead.outcome).toBe("CLOCK_AHEAD");
    const ok = await positionObservation.recordPositionObservation(prisma, { robotId: "SIM-1", ...FIX, agentTimestampMs: Date.now() });
    expect(ok).toMatchObject({ written: true, provenance: "SIMULATED" });
  });

  test("provenanceOf answers from the same binding the writer uses", async () => {
    expect(await positionObservation.provenanceOf(positionStore(false), "P-1")).toBe("PHYSICAL");
    expect(await positionObservation.provenanceOf(positionStore(true), "S-1")).toBe("SIMULATED");
    const none = { robot: { findUnique: jest.fn(async () => null) } };
    expect(await positionObservation.provenanceOf(none, "NOBODY")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("I — a physical SoC is written only with a declared measurement basis", () => {
  const store = () => ({
    agent: { findUnique: jest.fn(async () => ({ id: "agent-row-1" })) },
    batteryState: { updateMany: jest.fn(async () => ({ count: 1 })), upsert: jest.fn(), create: jest.fn() },
  });
  const report = (extra) => ({ robotId: "robotx-pi", batteryPct: 71.5, agentTimestampMs: 1_790_000_000_000, ...extra });

  test.each([
    ["no socMethod", { provenance: "PHYSICAL" }],
    ["an undeclared method", { provenance: "PHYSICAL", socMethod: "ESTIMATE" }],
    ["a lower-case look-alike", { provenance: "PHYSICAL", socMethod: "bms" }],
  ])("physical, %s → NO_MEASUREMENT_BASIS, nothing written", async (_name, extra) => {
    const prisma = store();
    const out = await batteryObservation.recordReportedSoc(prisma, report(extra));
    expect(out).toEqual({ written: false, reason: "NO_MEASUREMENT_BASIS" });
    expect(prisma.batteryState.updateMany).not.toHaveBeenCalled();
  });

  test.each(batteryObservation.SOC_METHODS)("physical, socMethod %s → written (update-only)", async (socMethod) => {
    const prisma = store();
    const out = await batteryObservation.recordReportedSoc(prisma, report({ provenance: "PHYSICAL", socMethod }));
    expect(out.written).toBe(true);
    expect(prisma.batteryState.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { lastObservedSoc: 0.715, lastObservedAt: new Date(1_790_000_000_000) } }),
    );
    expect(prisma.batteryState.upsert).not.toHaveBeenCalled();
    expect(prisma.batteryState.create).not.toHaveBeenCalled();
  });

  test("simulated: unchanged — the simulator is the pack", async () => {
    const prisma = store();
    expect((await batteryObservation.recordReportedSoc(prisma, report({ provenance: "SIMULATED" }))).written).toBe(true);
  });

  test("an undetermined provenance writes nothing", async () => {
    const prisma = store();
    expect(await batteryObservation.recordReportedSoc(prisma, report({ provenance: null }))).toEqual({
      written: false,
      reason: "PROVENANCE_UNDETERMINED",
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("J — liveness: heartbeat and the PROBE proof", () => {
  const MAX_AGE = 10;
  const config = new Map([["connectivity.max_heartbeat_age", MAX_AGE]]);

  function factsStore(robot) {
    return {
      agentCellPosition: { findUnique: jest.fn(async () => null) },
      shard: { findUnique: jest.fn(async () => null) },
      observation: { findFirst: jest.fn(async () => null) },
      chargerReservation: { findMany: jest.fn(async () => []) },
      zone: { findMany: jest.fn(async () => []) },
      _robot: robot,
    };
  }

  async function factsFor({ robot, live }) {
    const { kv } = await createTestKv();
    if (live) await setRobotState(kv, robot.robotId, live);
    const provider = createAgentFactsProvider({ prisma: factsStore(robot), kv });
    return provider({ agent: { id: "agent-row-1", robot }, config: (name) => config.get(name) });
  }

  const physical = (extra) => ({
    robotId: "robotx-pi",
    simulated: false,
    status: "IDLE",
    isOnline: true,
    socketId: "sock-now",
    lastSeenAt: new Date(Date.now() - 60_000),
    createdAt: new Date(),
    ...extra,
  });

  test("a robot whose heartbeat stopped 30 s ago is not admissible, though isOnline is still true", async () => {
    const now = Date.now();
    const facts = await factsFor({ robot: physical(), live: { lastHeartbeat: now - 30_000 } });
    expect(facts.session.live).toBe(true);
    expect(f13.evaluate({ agentSnapshot: facts, config, decisionTimeMs: now }).outcome).toBe("VIOLATED");
  });

  test("a fresh heartbeat satisfies F13", async () => {
    const now = Date.now();
    const facts = await factsFor({ robot: physical(), live: { lastHeartbeat: now - 2_000 } });
    expect(f13.evaluate({ agentSnapshot: facts, config, decisionTimeMs: now }).outcome).toBe("SATISFIED");
  });

  test("disconnected (isOnline false) is VIOLATED whatever the heartbeat says", async () => {
    const now = Date.now();
    const facts = await factsFor({ robot: physical({ isOnline: false, socketId: null }), live: { lastHeartbeat: now - 1_000 } });
    expect(f13.evaluate({ agentSnapshot: facts, config, decisionTimeMs: now }).outcome).toBe("VIOLATED");
  });

  test("F14: no PROBE answered → no proof (INDETERMINATE); nothing is defaulted", async () => {
    const now = Date.now();
    const facts = await factsFor({ robot: physical(), live: { lastHeartbeat: now - 1_000 } });
    expect(facts.session.lastHeartbeatAckAt).toBeUndefined();
    expect(f14.evaluate({ agentSnapshot: facts, config, decisionTimeMs: now }).outcome).toBe("INDETERMINATE");
  });

  test("F14: a PROBE answered on the robot's CURRENT socket is the proof", async () => {
    const now = Date.now();
    const facts = await factsFor({
      robot: physical(),
      live: { lastHeartbeat: now - 1_000, lastProbeAckAt: now - 3_000, lastProbeSocketId: "sock-now" },
    });
    expect(facts.session.lastHeartbeatAckAt).toEqual(new Date(now - 3_000));
    expect(f14.evaluate({ agentSnapshot: facts, config, decisionTimeMs: now }).outcome).toBe("SATISFIED");
  });

  test("F14: a proof earned on a previous socket does not survive a reconnect", async () => {
    const now = Date.now();
    const facts = await factsFor({
      robot: physical({ socketId: "sock-after-reconnect" }),
      live: { lastHeartbeat: now - 1_000, lastProbeAckAt: now - 3_000, lastProbeSocketId: "sock-before" },
    });
    expect(facts.session.lastHeartbeatAckAt).toBeUndefined();
  });

  test("F14: an old proof ages out on the same budget", async () => {
    const now = Date.now();
    const facts = await factsFor({
      robot: physical(),
      live: { lastHeartbeat: now - 1_000, lastProbeAckAt: now - 25_000, lastProbeSocketId: "sock-now" },
    });
    expect(f14.evaluate({ agentSnapshot: facts, config, decisionTimeMs: now }).outcome).toBe("VIOLATED");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("J/K — the PROBE boundary", () => {
  function authed(robotId = "robotx-pi") {
    const socket = createFakeSocket({ id: "sock-now" });
    socket.data.robotId = robotId;
    socket.data.isAuthed = true;
    return socket;
  }

  test("issueProbe sends PROBE only to an authenticated socket", () => {
    const anon = createFakeSocket();
    expect(agentProbe.issueProbe(anon, Date.now())).toBeNull();
    const socket = authed();
    const probe = agentProbe.issueProbe(socket, 1_000);
    expect(socket.sent[0]).toEqual({ event: "PROBE", payload: { command: "PROBE", correlationId: probe.correlationId, issuedAtMs: 1_000 } });
  });

  test("a matching, timely answer records the server-clock proof and the socket", async () => {
    const { kv } = await createTestKv();
    const socket = authed();
    const { correlationId } = agentProbe.issueProbe(socket, 10_000);
    const out = await agentProbe.recordProbeResult({ kv, socket, payload: { correlationId, robotId: "robotx-pi" }, nowMs: 10_500 });
    expect(out.outcome).toBe("RECORDED");
    const live = await getRobotState(kv, "robotx-pi");
    expect(live).toMatchObject({ lastProbeAckAt: 10_500, lastProbeSocketId: "sock-now" });
  });

  test.each([
    ["an unknown correlation id", (id) => ({ correlationId: `${id}-x` }), 10_100, "UNKNOWN_CORRELATION"],
    ["no correlation id", () => ({}), 10_100, "NO_CORRELATION_ID"],
    ["an answer after 2 s", (id) => ({ correlationId: id }), 12_500, "LATE"],
    ["an answer naming another robot", (id) => ({ correlationId: id, robotId: "someone-else" }), 10_100, "MISMATCHED_IDENTITY"],
  ])("%s records nothing", async (_name, payloadFor, nowMs, outcome) => {
    const { kv } = await createTestKv();
    const socket = authed();
    const { correlationId } = agentProbe.issueProbe(socket, 10_000);
    const out = await agentProbe.recordProbeResult({ kv, socket, payload: payloadFor(correlationId), nowMs });
    expect(out.outcome).toBe(outcome);
    expect((await getRobotState(kv, "robotx-pi")) || {}).not.toHaveProperty("lastProbeAckAt");
  });

  test("a replayed answer is recorded once — the correlation is consumed", async () => {
    const { kv } = await createTestKv();
    const socket = authed();
    const { correlationId } = agentProbe.issueProbe(socket, 10_000);
    expect((await agentProbe.recordProbeResult({ kv, socket, payload: { correlationId }, nowMs: 10_100 })).outcome).toBe("RECORDED");
    expect((await agentProbe.recordProbeResult({ kv, socket, payload: { correlationId }, nowMs: 10_200 })).outcome).toBe(
      "UNKNOWN_CORRELATION",
    );
  });

  test("the emitter is off unless AGENT_PROBE_INTERVAL_MS is a positive integer", () => {
    expect(agentProbe.intervalFromEnv({})).toBeNull();
    expect(agentProbe.intervalFromEnv({ AGENT_PROBE_INTERVAL_MS: "" })).toBeNull();
    expect(agentProbe.intervalFromEnv({ AGENT_PROBE_INTERVAL_MS: "0" })).toBeNull();
    expect(agentProbe.intervalFromEnv({ AGENT_PROBE_INTERVAL_MS: "5000" })).toBe(5000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("K — identity", () => {
  test("an authenticated socket cannot re-AUTH as a different robot", async () => {
    const { kv } = await createTestKv();
    const prisma = createMockPrisma();
    const socket = createFakeSocket();
    socket.data.robotId = "robotx-pi";
    socket.data.isAuthed = true;
    registerRobotHandlers(createFakeIo(), socket, { prisma, kv, logger: silentLogger, appLocals: {} });

    socket.trigger("AUTH", { robotId: "robotx-other", token: "stolen-or-not" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(prisma.robot.findUnique).not.toHaveBeenCalled();
    expect(socket.data.robotId).toBe("robotx-pi");
  });

  test("an unknown robot is refused at AUTH", async () => {
    const { kv } = await createTestKv();
    const prisma = createMockPrisma();
    prisma.robot.findUnique.mockResolvedValue(null);
    const socket = createFakeSocket();
    registerRobotHandlers(createFakeIo(), socket, { prisma, kv, logger: silentLogger, appLocals: {} });
    socket.trigger("AUTH", { robotId: "robotx-pi", pairingCode: "123456" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(socket.data.isAuthed).toBeUndefined();
  });

  test("a numeric robotId is not an identity (the AUTH schema requires a string)", async () => {
    const { kv } = await createTestKv();
    const prisma = createMockPrisma();
    const socket = createFakeSocket();
    registerRobotHandlers(createFakeIo(), socket, { prisma, kv, logger: silentLogger, appLocals: {} });
    socket.trigger("AUTH", { robotId: 1234, token: "t" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(prisma.robot.findUnique).not.toHaveBeenCalled();
  });

  function commandWorld(ackingRobotRowId) {
    const prisma = createMockPrisma();
    prisma.command = {
      findUnique: jest.fn(async () => ({ id: "cmd-1", issuedAt: new Date(), robotId: "robot-row-A", status: "SENT" })),
      update: jest.fn(async () => ({})),
    };
    prisma.robot.findUnique = jest.fn(async () => ({ id: ackingRobotRowId }));
    prisma.event.create = jest.fn(async () => ({}));
    return prisma;
  }

  test.each([
    ["the robot the command was issued to", "robot-row-A", true],
    ["another authenticated robot", "robot-row-B", false],
  ])("COMMAND_ACK from %s", async (_name, rowId, applied) => {
    const { kv } = await createTestKv();
    const prisma = commandWorld(rowId);
    const socket = createFakeSocket();
    socket.data.robotId = rowId === "robot-row-A" ? "RBT-A" : "RBT-B";
    socket.data.isAuthed = true;
    registerCommandHandlers(createFakeIo(), socket, { prisma, kv, logger: silentLogger, appLocals: {} });
    socket.trigger("COMMAND_ACK", { commandId: "cmd-1" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(prisma.command.update).toHaveBeenCalledTimes(applied ? 1 : 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("L — provider isolation: a physical agent's facts carry nothing the simulator states", () => {
  test("physical facts: derived half only, labelled PHYSICAL_DERIVED_ONLY; no control-plane fact appears", async () => {
    const { kv } = await createTestKv();
    await setRobotState(kv, "robotx-pi", { lastHeartbeat: Date.now() });
    const store = {
      agentCellPosition: { findUnique: jest.fn(async () => null) },
      shard: { findUnique: jest.fn(async () => null) },
      observation: { findFirst: jest.fn(async () => null) },
      chargerReservation: { findMany: jest.fn(async () => []) },
      zone: { findMany: jest.fn(async () => []) },
    };
    const facts = await createAgentFactsProvider({ prisma: store, kv })({
      agent: { id: "agent-row-1", robot: { robotId: "robotx-pi", simulated: false, status: "IDLE", isOnline: true, socketId: "s" } },
      config: () => 10,
    });
    expect(facts.provenance).toBe("PHYSICAL_DERIVED_ONLY");
    for (const field of ["commissioning", "emergencyStop", "faults", "localisation", "calibrations", "maintenance", "authorisedZoneIds"]) {
      expect(facts).not.toHaveProperty(field);
    }
    expect(facts.safetyRelevantObservations).toBeUndefined();
    expect(facts.session.lastHeartbeatAckAt).toBeUndefined();
  });
});

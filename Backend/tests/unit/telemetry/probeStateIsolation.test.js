/**
 * F7-A — telemetry cannot rewrite the probe proof.
 *
 * The F7 investigation measured `telemetry.handler` reading `registry:{robotId}` at the top of
 * a frame, awaiting its slow work, and writing the merged value back at the end. A PROBE_RESULT
 * recorded inside that window was reverted to the older proof (8 times in 5 Gate 1b runs).
 * The proof now lives in `probe:{robotId}`, written only by `agentProbe.recordProbeResult`.
 *
 * These tests drive the real handler, the real `agentProbe.recordProbeResult` and the real
 * `agentFacts` / `physicalFacts` readers over the real in-memory `kv` facade, and hold the
 * handler at the exact point the race needs: after its registry read, before its registry
 * write. Test 1 fails on the code before F7-A (the proof read back is A).
 *
 * Out of scope here, deliberately: H5 (a proof recorded after a round's decision time). The
 * decision-time rule is asserted unchanged below, not altered.
 */

const agentProbe = require("../../../src/services/agentProbe.service");
const { createAgentFactsProvider } = require("../../../src/services/agentFacts.service");
const physicalFacts = require("../../../src/services/fleetProviders/physicalFacts");
const physicalPolicy = require("../../../src/services/fleetProviders/physicalPolicy");
const { setRobotState, getRobotState, PROBE_OWNED_FIELDS } = require("../../../src/services/robotRegistry.service");
const f14 = require("../../../src/engine/feasibility/predicates/f14");
const { createTestKv } = require("../../helpers/testKv");
const { createFakeSocket, createFakeIo } = require("../../helpers/fakeSocket");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { waitFor } = require("../../helpers/waitFor");
const silentLogger = require("../../mocks/silentLogger");

const ROBOT_ID = "R-F7A";
const SOCKET_ID = "sock-f7a";
const config = new Map([["connectivity.max_heartbeat_age", 10]]);

const handles = [];
async function freshKv() {
  const handle = await createTestKv();
  handles.push(handle);
  return handle.kv;
}
afterEach(async () => {
  while (handles.length > 0) await handles.pop().close();
});

/**
 * The real kv, except that the next pipeline which READS `registry:{robotId}` parks after its
 * reply until the test releases it — the telemetry handler's "slow work" made deterministic.
 * Every write the handler queues is recorded, so the test can inspect exactly what it wrote.
 */
function gatedKv(kv, robotId) {
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  let reachedResolve;
  const reached = new Promise((resolve) => {
    reachedResolve = resolve;
  });
  let armed = true;
  const written = [];
  const wrapper = Object.create(kv);
  wrapper.set = async (key, value, options) => {
    written.push({ key, value });
    return kv.set(key, value, options);
  };
  wrapper.pipeline = () => {
    const inner = kv.pipeline();
    let readsRegistry = false;
    const builder = {
      get(key) {
        if (key === `registry:${robotId}`) readsRegistry = true;
        inner.get(key);
        return builder;
      },
      set(key, value, options) {
        written.push({ key, value });
        inner.set(key, value, options);
        return builder;
      },
      async exec() {
        const results = await inner.exec();
        if (readsRegistry && armed) {
          armed = false;
          reachedResolve();
          await released;
        }
        return results;
      },
    };
    return builder;
  };
  return { kv: wrapper, reached, release, written };
}

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

const robotRow = (extra) => ({
  robotId: ROBOT_ID,
  simulated: false,
  status: "IDLE",
  isOnline: true,
  socketId: SOCKET_ID,
  lastSeenAt: new Date(Date.now() - 60_000),
  createdAt: new Date(),
  ...extra,
});

async function agentFactsFor(kv, robot, asOfMs) {
  const provider = createAgentFactsProvider({ prisma: factsStore(robot), kv });
  return provider({ agent: { id: "agent-row-1", robot }, config: (name) => config.get(name), asOfMs });
}

async function proofSeenByAgentFacts(kv, robot, asOfMs) {
  const facts = await agentFactsFor(kv, robot, asOfMs);
  return facts.session.lastHeartbeatAckAt ? facts.session.lastHeartbeatAckAt.getTime() : null;
}

function authedSocket(id = SOCKET_ID, robotId = ROBOT_ID) {
  const socket = createFakeSocket({ id });
  socket.data.isAuthed = true;
  socket.data.robotId = robotId;
  return socket;
}

async function answerProbe(kv, socket, atMs) {
  const { correlationId } = agentProbe.issueProbe(socket, atMs - 50);
  const out = await agentProbe.recordProbeResult({ kv, socket, payload: { correlationId }, nowMs: atMs });
  expect(out.outcome).toBe("RECORDED");
}

/** One telemetry frame held between its registry read and its registry write. */
async function telemetryFrameAround(realKv, socket, insideWindow) {
  const gate = gatedKv(realKv, socket.data.robotId);
  const prisma = createMockPrisma();
  prisma.zone.findMany.mockResolvedValue([]);
  prisma.robot.findUnique.mockResolvedValue({ id: "db-1", status: "IDLE", lat: 1, lon: 1, speed: 0, battery: 50, isOnline: true });
  prisma.robot.update.mockResolvedValue({});
  const { registerTelemetryHandlers } = require("../../../src/sockets/handlers/telemetry.handler");
  registerTelemetryHandlers(createFakeIo(), socket, { prisma, kv: gate.kv, logger: silentLogger });

  socket.trigger("TELEMETRY", { lat: 12.5, lon: 77.5, battery: 61, speed: 0, status: "IDLE" });
  await gate.reached; // T1 — the registry has been read
  await insideWindow(); // T2
  gate.release(); // T3 — the handler finishes and writes
  await waitFor(async () => {
    const raw = await realKv.get(`registry:${socket.data.robotId}`);
    return raw && JSON.parse(raw).lat === 12.5;
  });
  return gate.written;
}

beforeEach(() => jest.resetModules());

describe("F7-A — the probe proof is the probe subsystem's, and telemetry cannot rewrite it", () => {
  test("1. telemetry GET (proof A) → probe writes B > A → telemetry SET: the proof is B, not A", async () => {
    const kv = await freshKv();
    const socket = authedSocket();
    const now = Date.now();
    const A = now - 4_000;
    const B = now - 2_000;
    await answerProbe(kv, socket, A);
    expect(await proofSeenByAgentFacts(kv, robotRow(), now)).toBe(A);

    await telemetryFrameAround(kv, socket, () => answerProbe(kv, socket, B));

    expect(await proofSeenByAgentFacts(kv, robotRow(), now)).toBe(B);
    expect(await agentProbe.getProbeState(kv, ROBOT_ID)).toMatchObject({ lastProbeAckAt: B, lastProbeSocketId: SOCKET_ID });
  });

  test("2. telemetry writes no probe field and never the probe key — even over a registry that still holds one", async () => {
    const kv = await freshKv();
    const socket = authedSocket();
    const now = Date.now();
    // A registry value as it stood before F7-A (a persistent store survives the deploy).
    await kv.set(
      `registry:${ROBOT_ID}`,
      JSON.stringify({ robotId: ROBOT_ID, lastHeartbeat: now - 1_000, lastProbeAckAt: now - 9_000, lastProbeSocketId: SOCKET_ID, linkQuality: 0.2 }),
      { ex: 30 },
    );
    await answerProbe(kv, socket, now - 3_000);

    const written = await telemetryFrameAround(kv, socket, () => answerProbe(kv, socket, now - 1_500));

    const registryWrites = written.filter((w) => w.key === `registry:${ROBOT_ID}`);
    expect(registryWrites).toHaveLength(1);
    const registry = JSON.parse(registryWrites[0].value);
    for (const field of ["lastProbeAckAt", "lastProbeSocketId", "linkQuality"]) expect(registry).not.toHaveProperty(field);
    expect(written.filter((w) => w.key.startsWith("probe:"))).toEqual([]);
    expect(PROBE_OWNED_FIELDS).toEqual(["lastProbeAckAt", "lastProbeSocketId", "linkQuality"]);
    expect(await proofSeenByAgentFacts(kv, robotRow(), now)).toBe(now - 1_500);
  });

  test("2b. no registry writer can carry a probe field — setRobotState drops it too", async () => {
    const kv = await freshKv();
    await setRobotState(kv, ROBOT_ID, { lastHeartbeat: 1, lastProbeAckAt: 2, lastProbeSocketId: "x", linkQuality: 1 });
    const stored = JSON.parse(await kv.get(`registry:${ROBOT_ID}`));
    expect(stored).toMatchObject({ lastHeartbeat: 1 });
    for (const field of PROBE_OWNED_FIELDS) expect(stored).not.toHaveProperty(field);
    // And the proof is not readable from the registry at all — only from the probe key.
    expect(await agentProbe.getProbeState(kv, ROBOT_ID)).toBeNull();
  });

  test("3. latest probe wins: A then B (B newer) leaves B", async () => {
    const kv = await freshKv();
    const socket = authedSocket();
    const now = Date.now();
    await answerProbe(kv, socket, now - 3_000);
    await answerProbe(kv, socket, now - 1_000);
    expect(await agentProbe.getProbeState(kv, ROBOT_ID)).toMatchObject({ robotId: ROBOT_ID, lastProbeAckAt: now - 1_000 });
    expect(await proofSeenByAgentFacts(kv, robotRow(), now)).toBe(now - 1_000);
  });

  test("3b. the probe write is a single SET with no prior read (no read-modify-write to lose)", async () => {
    const kv = await freshKv();
    const socket = authedSocket();
    const spy = { get: jest.spyOn(kv, "get"), set: jest.spyOn(kv, "set") };
    const { correlationId } = agentProbe.issueProbe(socket, 1_000);
    await agentProbe.recordProbeResult({ kv, socket, payload: { correlationId }, nowMs: 1_100 });
    expect(spy.get).not.toHaveBeenCalled();
    expect(spy.set).toHaveBeenCalledTimes(1);
    expect(spy.set.mock.calls[0][0]).toBe(`probe:${ROBOT_ID}`);
    expect(spy.set.mock.calls[0][2]).toEqual({ ex: agentProbe.PROBE_STATE_TTL_SEC });
  });

  test("4. robot A's proof is never robot B's", async () => {
    const kv = await freshKv();
    const now = Date.now();
    await answerProbe(kv, authedSocket("sock-a", "robot-a"), now - 1_000);

    expect(await agentProbe.getProbeState(kv, "robot-b")).toBeNull();
    // Even with robot B's row naming the very socket that answered for A.
    const b = robotRow({ robotId: "robot-b", socketId: "sock-a" });
    expect(await proofSeenByAgentFacts(kv, b, now)).toBeNull();
    // A value under B's key that names another robot is not B's proof.
    await kv.set("probe:robot-b", JSON.stringify({ robotId: "robot-a", lastProbeAckAt: now - 500, lastProbeSocketId: "sock-a" }), { ex: 60 });
    expect(await agentProbe.getProbeState(kv, "robot-b")).toBeNull();
    expect(await proofSeenByAgentFacts(kv, b, now)).toBeNull();
    // An answer naming another robot is still refused at the door (unchanged).
    const socket = authedSocket("sock-a", "robot-a");
    const { correlationId } = agentProbe.issueProbe(socket, now);
    expect((await agentProbe.recordProbeResult({ kv, socket, payload: { correlationId, robotId: "robot-b" }, nowMs: now + 10 })).outcome).toBe(
      "MISMATCHED_IDENTITY",
    );
    expect(await agentProbe.getProbeState(kv, "robot-b")).toBeNull();
  });

  test("5. a proof earned on an old socket is not valid for the robot's current socket", async () => {
    const kv = await freshKv();
    const now = Date.now();
    await answerProbe(kv, authedSocket("sock-old"), now - 1_000);
    expect(await proofSeenByAgentFacts(kv, robotRow({ socketId: "sock-new" }), now)).toBeNull();
    // An outstanding probe of one socket cannot be answered from another (unchanged).
    const oldSocket = authedSocket("sock-old");
    const newSocket = authedSocket("sock-new");
    const { correlationId } = agentProbe.issueProbe(oldSocket, now);
    expect((await agentProbe.recordProbeResult({ kv, socket: newSocket, payload: { correlationId }, nowMs: now + 10 })).outcome).toBe(
      "UNKNOWN_CORRELATION",
    );
  });

  test("6. F14 reads the proof from the new location and its decision-time rule is unchanged", async () => {
    const kv = await freshKv();
    const socket = authedSocket();
    const decisionTimeMs = Date.now();
    const evaluateAt = async (asOfMs) =>
      f14.evaluate({ agentSnapshot: await agentFactsFor(kv, robotRow(), asOfMs), config, decisionTimeMs: asOfMs });

    await answerProbe(kv, socket, decisionTimeMs - 3_000);
    expect((await evaluateAt(decisionTimeMs)).outcome).toBe("SATISFIED");
    // proofTime <= decisionTime, as before: a proof stamped after the decision is not admitted
    // for it. Since F7-B (H5) the earlier proof is still there to be selected.
    await answerProbe(kv, socket, decisionTimeMs + 100);
    const facts = await agentFactsFor(kv, robotRow(), decisionTimeMs);
    expect(facts.session.lastHeartbeatAckAt.getTime()).toBe(decisionTimeMs - 3_000);
    expect((await evaluateAt(decisionTimeMs)).outcome).toBe("SATISFIED");
    // With only a proof after the decision there is none for it.
    const later = await freshKv();
    await answerProbe(later, authedSocket(), decisionTimeMs + 100);
    expect((await f14.evaluate({ agentSnapshot: await agentFactsFor(later, robotRow(), decisionTimeMs), config, decisionTimeMs })).outcome).toBe(
      "INDETERMINATE",
    );
    // And an old proof still ages out on the same budget.
    const old = await freshKv();
    await answerProbe(old, authedSocket(), decisionTimeMs - 25_000);
    expect((await f14.evaluate({ agentSnapshot: await agentFactsFor(old, robotRow(), decisionTimeMs), config, decisionTimeMs })).outcome).toBe("VIOLATED");
  });

  test("7. F15's measured link quality travels with the proof to physicalFacts, socket-bound as before", async () => {
    const kv = await freshKv();
    const policy = physicalPolicy.fromDeclaration({
      declaredBy: "test owner",
      declaredAt: "2026-10-03",
      charging: { policy: "MANUAL_OUT_OF_SERVICE" },
      stateOfCharge: { policy: "OPERATOR_DECLARED", maxAgeSeconds: 7200 },
      emergencyStop: { mechanism: "SOFTWARE_STOP_LATCH" },
      localisation: { referenceRadiusM: 25, acceptedFixTypes: ["3D"] },
      robots: [
        {
          robotId: ROBOT_ID,
          control: {
            firmwareVersion: "fw/1",
            hardwareRevision: "rev-a",
            missionTypes: ["DELIVERY"],
            calibrations: [],
            serviceDueAt: "2027-01-01T00:00:00Z",
            regionId: "region-1",
            authorisation: "REGION",
            advisories: [],
            operatingAmbientC: { min: 0, max: 45 },
          },
          energy: { idlePowerW: 6, movingPowerW: 30, soh: 0.9, residualCv: 0.2, reserveFloorWh: 15 },
        },
      ],
    });
    expect(policy.robotFor(ROBOT_ID)).not.toBeNull();
    const prisma = { zone: { findMany: async () => [] }, observation: { findFirst: async () => null } };
    const factsWith = (robot) =>
      physicalFacts.controlFactsFor({ prisma, kv, policy, agent: { id: "agent-1", regionId: "region-1", robot, agentClass: null }, asOfMs: Date.now() });

    // Two settled probes, one answered: the measured ratio is 0.5.
    const socket = authedSocket();
    const t0 = Date.now() - 10_000;
    agentProbe.issueProbe(socket, t0); // never answered
    const { correlationId } = agentProbe.issueProbe(socket, t0 + 5_000);
    await agentProbe.recordProbeResult({ kv, socket, payload: { correlationId }, nowMs: t0 + 5_100 });
    expect(await agentProbe.getProbeState(kv, ROBOT_ID)).toMatchObject({ linkQuality: 0.5 });

    expect((await factsWith(robotRow())).sessionOverlay).toEqual({ linkQuality: 0.5 });
    expect((await factsWith(robotRow({ socketId: "sock-other" }))).sessionOverlay).toEqual({});
    // The registry is not where it is read from.
    await setRobotState(kv, ROBOT_ID, { linkQuality: 1 });
    expect((await factsWith(robotRow())).sessionOverlay).toEqual({ linkQuality: 0.5 });
  });

  test("8. reconnect: no proof until the new socket answers; the old socket's proof stays inert", async () => {
    const kv = await freshKv();
    const now = Date.now();
    await answerProbe(kv, authedSocket("sock-1"), now - 3_000);
    expect(await proofSeenByAgentFacts(kv, robotRow({ socketId: "sock-1" }), now)).toBe(now - 3_000);

    // The robot reconnects on sock-2 (Robot.socketId moves). Nothing is cleared, nothing defaulted:
    // the stored proof names sock-1, so it proves nothing for sock-2 — the existing rule.
    const reconnected = robotRow({ socketId: "sock-2" });
    expect(await proofSeenByAgentFacts(kv, reconnected, now)).toBeNull();
    await setRobotState(kv, ROBOT_ID, { connected: true, authenticated: true, socketId: "sock-2", lastHeartbeat: now }); // markOnline's write
    expect(await proofSeenByAgentFacts(kv, reconnected, now)).toBeNull();

    // The new socket's first answer is the proof.
    await answerProbe(kv, authedSocket("sock-2"), now - 500);
    expect(await proofSeenByAgentFacts(kv, reconnected, now)).toBe(now - 500);
    expect(await getRobotState(kv, ROBOT_ID)).not.toHaveProperty("lastProbeAckAt");
  });
});

/**
 * The software stop latch (F7's input) has one owner, and an older write never replaces a newer one.
 *
 * The 2026-10-06 safety audit reproduced three ways a newer `engaged: true` became `false`:
 *   S1  a telemetry frame's whole-record registry write restored its snapshot's latch,
 *   S2  an older frame finishing after a newer one recorded its older `false` last,
 *   S3  a HEARTBEAT's registry read-modify-write straddled a latch write.
 * F7 (class I, absolute) then read `false` and was SATISFIED, at assignment and at the commit
 * recheck. The latch now lives in `stopLatch:{robotId}`, written only by `recordStopLatch`, newest
 * observation first, bound to the socket that reported it; the registry carries none of it.
 *
 * A, B and D go through the public path (the real telemetry handler, the real registry writer
 * and the real `physicalFacts` → F7), so they fail on the code before this change.
 */

const { createTestKv } = require("../../helpers/testKv");
const { createFakeSocket, createFakeIo } = require("../../helpers/fakeSocket");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { waitFor } = require("../../helpers/waitFor");
const silentLogger = require("../../mocks/silentLogger");

const ROBOT = "R-LATCH";
const SOCKET = "sock-latch";
const config = new Map([["connectivity.max_heartbeat_age", 10]]);

const handles = [];
async function freshKv() {
  const handle = await createTestKv();
  handles.push(handle);
  return handle.kv;
}

beforeEach(() => jest.resetModules());
afterEach(async () => {
  require("../../../src/cache/robotStateCache").del(ROBOT);
  require("../../../src/services/stopLatchObservation.service").resetStopLatchState();
  while (handles.length > 0) await handles.pop().close();
});

const POLICY = () =>
  require("../../../src/services/fleetProviders/physicalPolicy").fromDeclaration({
    declaredBy: "test owner",
    declaredAt: "2026-10-03",
    charging: { policy: "MANUAL_OUT_OF_SERVICE" },
    stateOfCharge: { policy: "OPERATOR_DECLARED", maxAgeSeconds: 7200 },
    emergencyStop: { mechanism: "SOFTWARE_STOP_LATCH" },
    localisation: { referenceRadiusM: 25, acceptedFixTypes: ["3D"] },
    robots: [
      {
        robotId: ROBOT,
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

/** F7, exactly as a round evaluates it: physicalFacts' control facts → the F7 predicate. */
async function f7(kv, { decisionTimeMs = Date.now(), socketId = SOCKET } = {}) {
  const physicalFacts = require("../../../src/services/fleetProviders/physicalFacts");
  const f07 = require("../../../src/engine/feasibility/predicates/f07");
  const robot = { robotId: ROBOT, status: "IDLE", isOnline: true, socketId, simulated: false };
  const facts = await physicalFacts.controlFactsFor({
    prisma: { zone: { findMany: async () => [] }, observation: { findFirst: async () => null } },
    kv,
    policy: POLICY(),
    agent: { id: "agent-1", regionId: "region-1", robot, agentClass: null },
    asOfMs: decisionTimeMs,
  });
  const verdict = f07.evaluate({ agentSnapshot: { emergencyStop: facts.emergencyStop }, config, decisionTimeMs });
  return { outcome: verdict.outcome, emergencyStop: facts.emergencyStop };
}

const latchFrame = (engaged, ts, lat = 12.9001) => ({ lat, lon: 77.5001, battery: 60, speed: 0, status: "IDLE", timestamp: ts, safety: { stopLatch: { engaged } } });
const report = (engaged, ts) => ({ timestamp: ts, safety: { stopLatch: { engaged } } });
const agentStore = () => ({ agent: { findUnique: async () => null }, observation: { create: async () => ({}) } });
const socketFor = (id = SOCKET) => ({ id, data: { isAuthed: true, robotId: ROBOT } });

/** The real kv; the next pipeline that READS registry:{robot} parks after its reply. */
function gatedKv(kv) {
  let release;
  const released = new Promise((r) => (release = r));
  let reachedResolve;
  const reached = new Promise((r) => (reachedResolve = r));
  let armed = true;
  const wrapper = Object.create(kv);
  wrapper.pipeline = () => {
    const inner = kv.pipeline();
    let reads = false;
    const builder = {
      get(key) {
        if (key === `registry:${ROBOT}`) reads = true;
        inner.get(key);
        return builder;
      },
      set(key, value, options) {
        inner.set(key, value, options);
        return builder;
      },
      async exec() {
        const out = await inner.exec();
        if (reads && armed) {
          armed = false;
          reachedResolve();
          await released;
        }
        return out;
      },
    };
    return builder;
  };
  return { kv: wrapper, reached, release };
}

function telemetryRig(kvForHandler) {
  const { registerTelemetryHandlers } = require("../../../src/sockets/handlers/telemetry.handler");
  const robotStateCache = require("../../../src/cache/robotStateCache");
  const prisma = createMockPrisma();
  const row = { id: "db-1", robotId: ROBOT, status: "IDLE", lat: 12.9, lon: 77.5, battery: 60, isOnline: true };
  prisma.robot.findUnique.mockImplementation(async () => ({ ...row }));
  prisma.robot.update.mockImplementation(async ({ data }) => Object.assign(row, data));
  prisma.robot.updateMany.mockImplementation(async ({ data }) => (Object.assign(row, data), { count: 1 }));
  prisma.zone.findMany.mockResolvedValue([]);
  prisma.agent.findUnique.mockResolvedValue(null);
  robotStateCache.set(ROBOT, { id: row.id, status: "IDLE", isOnline: true, lat: 12.9, lon: 77.5, battery: 60, speed: 0 });
  const socket = createFakeSocket({ id: SOCKET });
  socket.data.isAuthed = true;
  socket.data.robotId = ROBOT;
  registerTelemetryHandlers(createFakeIo(), socket, { prisma, kv: kvForHandler, logger: silentLogger });
  return socket;
}

async function settled(predicate) {
  await waitFor(predicate, { timeout: 3000 });
  await new Promise((r) => setTimeout(r, 30));
}

describe("the original races (public path: telemetry → physicalFacts → F7)", () => {
  test("A. an older frame (false) finishing after a newer one (true) leaves the latch engaged — F7 VIOLATED", async () => {
    const real = await freshKv();
    const gate = gatedKv(real);
    const socket = telemetryRig(gate.kv);
    const now = Date.now();

    socket.trigger("TELEMETRY", latchFrame(false, now - 400)); // frame A: older, slow
    await gate.reached;
    await new Promise((r) => setTimeout(r, 150)); // TELEMETRY min interval
    socket.trigger("TELEMETRY", latchFrame(true, now - 100, 12.9002)); // frame B: newer, completes
    await settled(async () => (await f7(real)).outcome === "VIOLATED");
    gate.release(); // A finishes last
    await settled(async () => JSON.parse((await real.get(`registry:${ROBOT}`)) || "{}").lat === 12.9001);

    const verdict = await f7(real);
    expect(verdict.emergencyStop).toMatchObject({ value: true, observedAt: new Date(now - 100) });
    expect(verdict.outcome).toBe("VIOLATED");
  });

  test("B. a HEARTBEAT's registry write that read the old latch cannot clear a newer engaged report — F7 VIOLATED", async () => {
    const { setRobotState } = require("../../../src/services/robotRegistry.service");
    const real = await freshKv();
    const socket = telemetryRig(real);
    const now = Date.now();
    socket.trigger("TELEMETRY", latchFrame(false, now - 2_000));
    await settled(async () => (await f7(real)).outcome === "SATISFIED");

    // robot.handler's HEARTBEAT write, its read parked inside the GET→SET window.
    let release;
    const released = new Promise((r) => (release = r));
    let reached;
    const atGet = new Promise((r) => (reached = r));
    let armed = true;
    const held = Object.create(real);
    held.get = async (key) => {
      const value = await real.get(key);
      if (armed && key === `registry:${ROBOT}`) {
        armed = false;
        reached();
        await released;
      }
      return value;
    };
    const beat = setRobotState(held, ROBOT, { lastHeartbeat: now, connected: true });
    await atGet;
    await new Promise((r) => setTimeout(r, 150));
    socket.trigger("TELEMETRY", latchFrame(true, now - 100, 12.9002));
    await settled(async () => (await f7(real)).outcome === "VIOLATED");
    release();
    await beat;

    expect((await f7(real)).outcome).toBe("VIOLATED");
  });

  test("D. a stale `stopLatch: false` in the registry is not what F7 reads — the dedicated engaged report is", async () => {
    const { setRobotState } = require("../../../src/services/robotRegistry.service");
    const real = await freshKv();
    const socket = telemetryRig(real);
    const now = Date.now();
    socket.trigger("TELEMETRY", latchFrame(true, now - 100));
    await settled(async () => (await f7(real)).outcome === "VIOLATED");
    // Whatever a registry writer carries — here, written directly into the stored value.
    await real.set(`registry:${ROBOT}`, JSON.stringify({ robotId: ROBOT, stopLatch: { engaged: false, observedAtMs: now - 50 } }), { ex: 30 });
    await setRobotState(real, ROBOT, { stopLatch: { engaged: false, observedAtMs: now - 10 } });
    expect((await f7(real)).outcome).toBe("VIOLATED");
  });
});

describe("one owner: stopLatch:{robotId}, written by recordStopLatch alone", () => {
  test("C. the registry carries no stopLatch — not from telemetry, not from any setRobotState caller", async () => {
    const { setRobotState, getRobotState, STOP_LATCH_OWNED_FIELDS } = require("../../../src/services/robotRegistry.service");
    const real = await freshKv();
    const socket = telemetryRig(real);
    // A value written before this change still sits in the registry.
    await real.set(`registry:${ROBOT}`, JSON.stringify({ robotId: ROBOT, stopLatch: { engaged: false, observedAtMs: Date.now() - 500 } }), { ex: 30 });
    socket.trigger("TELEMETRY", latchFrame(true, Date.now() - 50));
    await settled(async () => (await f7(real)).outcome === "VIOLATED");
    expect(await getRobotState(real, ROBOT)).not.toHaveProperty("stopLatch");
    await setRobotState(real, ROBOT, { stopLatch: { engaged: false, observedAtMs: Date.now() } });
    expect(await getRobotState(real, ROBOT)).not.toHaveProperty("stopLatch");
    expect(STOP_LATCH_OWNED_FIELDS).toEqual(["stopLatch"]);
  });

  test("the record is one SET to stopLatch:{robotId} with no read first, bound to the reporting socket", async () => {
    const stopLatch = require("../../../src/services/stopLatchObservation.service");
    const kv = await freshKv();
    const get = jest.spyOn(kv, "get");
    const set = jest.spyOn(kv, "set");
    const now = Date.now();
    const out = await stopLatch.recordStopLatch({ prisma: agentStore(), kv, robotId: ROBOT, payload: report(true, now - 10), nowMs: now, socket: socketFor() });
    expect(out).toMatchObject({ recorded: true, engaged: true });
    expect(get).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][0]).toBe(`stopLatch:${ROBOT}`);
    expect(await stopLatch.getStopLatchState(kv, ROBOT)).toEqual({ robotId: ROBOT, socketId: SOCKET, engaged: true, observedAtMs: now - 10 });
  });

  test("a report with no socket is not recorded (nothing to bind it to)", async () => {
    const stopLatch = require("../../../src/services/stopLatchObservation.service");
    const kv = await freshKv();
    const out = await stopLatch.recordStopLatch({ prisma: agentStore(), kv, robotId: ROBOT, payload: report(true, Date.now() - 10) });
    expect(out).toEqual({ recorded: false, reason: "NO_SOCKET" });
    expect(await stopLatch.getStopLatchState(kv, ROBOT)).toBeNull();
  });
});

describe("newest observation wins — by the agent's own timestamp, not arrival order", () => {
  async function record(kv, socket, engaged, ts) {
    const stopLatch = require("../../../src/services/stopLatchObservation.service");
    return stopLatch.recordStopLatch({ prisma: agentStore(), kv, robotId: ROBOT, payload: report(engaged, ts), nowMs: Date.now(), socket });
  }

  test("F. true @2000 then false @1500 → true @2000 (the older report is refused)", async () => {
    const stopLatch = require("../../../src/services/stopLatchObservation.service");
    const kv = await freshKv();
    const socket = socketFor();
    const base = Date.now() - 5_000;
    await record(kv, socket, true, base + 2_000);
    expect(await record(kv, socket, false, base + 1_500)).toEqual({ recorded: false, reason: "OUT_OF_ORDER" });
    expect(await stopLatch.getStopLatchState(kv, ROBOT)).toMatchObject({ engaged: true, observedAtMs: base + 2_000 });
    expect((await f7(kv)).outcome).toBe("VIOLATED");
  });

  test("G. true @2000 then false @3000 → false @3000, and F7 is SATISFIED", async () => {
    const stopLatch = require("../../../src/services/stopLatchObservation.service");
    const kv = await freshKv();
    const socket = socketFor();
    const base = Date.now() - 5_000;
    await record(kv, socket, true, base + 2_000);
    expect(await record(kv, socket, false, base + 3_000)).toMatchObject({ recorded: true, engaged: false });
    expect(await stopLatch.getStopLatchState(kv, ROBOT)).toMatchObject({ engaged: false, observedAtMs: base + 3_000 });
    expect((await f7(kv)).outcome).toBe("SATISFIED");
  });

  test("equal timestamps: an engaged report may replace a released one, never the reverse (fail closed)", async () => {
    const stopLatch = require("../../../src/services/stopLatchObservation.service");
    const kv = await freshKv();
    const socket = socketFor();
    const t = Date.now() - 1_000;
    await record(kv, socket, false, t);
    expect(await record(kv, socket, true, t)).toMatchObject({ recorded: true });
    expect(await record(kv, socket, false, t)).toEqual({ recorded: false, reason: "OUT_OF_ORDER" });
    expect(await stopLatch.getStopLatchState(kv, ROBOT)).toMatchObject({ engaged: true, observedAtMs: t });
  });
});

describe("socket binding (multi-process): a replaced socket's report never counts for the new one", () => {
  test("a late write from the old socket is not admitted; F7 fails closed until the current socket reports", async () => {
    const stopLatch = require("../../../src/services/stopLatchObservation.service");
    const kv = await freshKv();
    const now = Date.now();
    // The new socket (another process, say) reported engaged; the old socket's late frame lands after.
    await stopLatch.recordStopLatch({ prisma: agentStore(), kv, robotId: ROBOT, payload: report(true, now - 100), nowMs: now, socket: socketFor("sock-new") });
    await stopLatch.recordStopLatch({ prisma: agentStore(), kv, robotId: ROBOT, payload: report(false, now - 300), nowMs: now, socket: socketFor("sock-old") });
    const verdict = await f7(kv, { socketId: "sock-new" });
    expect(verdict.emergencyStop).toBeUndefined();
    expect(verdict.outcome).toBe("INDETERMINATE"); // absent → class I DENY, never SATISFIED
    // The current socket's next report is admitted again.
    await stopLatch.recordStopLatch({ prisma: agentStore(), kv, robotId: ROBOT, payload: report(true, now - 50), nowMs: now, socket: socketFor("sock-new") });
    expect((await f7(kv, { socketId: "sock-new" })).outcome).toBe("VIOLATED");
  });

  test("robot binding: another robot's key is never this robot's latch", async () => {
    const stopLatch = require("../../../src/services/stopLatchObservation.service");
    const kv = await freshKv();
    await kv.set(`stopLatch:${ROBOT}`, JSON.stringify({ robotId: "someone-else", socketId: SOCKET, engaged: false, observedAtMs: Date.now() - 10 }), { ex: 60 });
    expect(await stopLatch.getStopLatchState(kv, ROBOT)).toBeNull();
    expect((await f7(kv)).outcome).toBe("INDETERMINATE");
  });
});

describe("unknown stays fail-closed (the existing F7 contract)", () => {
  const stored = (kv, value) => kv.set(`stopLatch:${ROBOT}`, JSON.stringify({ robotId: ROBOT, socketId: SOCKET, ...value }), { ex: 60 });

  test("no state → INDETERMINATE (absent)", async () => {
    const kv = await freshKv();
    const verdict = await f7(kv);
    expect(verdict.emergencyStop).toBeUndefined();
    expect(verdict.outcome).toBe("INDETERMINATE");
  });

  test.each([
    ["a non-boolean engaged", { engaged: "no", observedAtMs: () => Date.now() - 10 }],
    ["missing engaged", { observedAtMs: () => Date.now() - 10 }],
    ["missing observedAtMs", { engaged: false }],
    ["a non-finite observedAtMs", { engaged: false, observedAtMs: "soon" }],
  ])("malformed (%s) → INDETERMINATE, never SATISFIED", async (_name, value) => {
    const kv = await freshKv();
    const resolved = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v === "function" ? v() : v]));
    await stored(kv, resolved);
    expect((await f7(kv)).outcome).toBe("INDETERMINATE");
  });

  test("malformed JSON → INDETERMINATE", async () => {
    const kv = await freshKv();
    await kv.set(`stopLatch:${ROBOT}`, "{not json", { ex: 60 });
    expect((await f7(kv)).outcome).toBe("INDETERMINATE");
  });

  test("stale (older than connectivity.max_heartbeat_age) released latch → INDETERMINATE, not SATISFIED", async () => {
    const kv = await freshKv();
    await stored(kv, { engaged: false, observedAtMs: Date.now() - 11_000 });
    const verdict = await f7(kv);
    expect(verdict.emergencyStop).toMatchObject({ value: false });
    expect(verdict.outcome).toBe("INDETERMINATE");
  });

  test("a report stamped after the decision time is not read for it (unchanged)", async () => {
    const kv = await freshKv();
    const decisionTimeMs = Date.now() - 1_000;
    await stored(kv, { engaged: false, observedAtMs: decisionTimeMs + 50 });
    expect((await f7(kv, { decisionTimeMs })).outcome).toBe("INDETERMINATE");
  });
});

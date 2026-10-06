/**
 * P2B-2 — `TASK_COMPLETE` never completes on the claim alone.
 *
 * Three outcomes, kept apart:
 *   A. verification ran and passed        → Task COMPLETED, Leg settled
 *   B. verification ran and failed        → held as VERIFYING, nothing completed
 *   C. verification could not run at all  → held as VERIFYING with the reason, nothing
 *                                           completed (this used to complete on the claim)
 *
 * The grading itself is the engine's (`supervision/verification.js`), run for real here;
 * only the store is faked. Settlement is stubbed because what is under test is the
 * handler's decision to reach it — the live V1 runs exercise the real `settle`.
 */

jest.mock("../../../src/engine/lifecycle/settlement", () => {
  const actual = jest.requireActual("../../../src/engine/lifecycle/settlement");
  return { ...actual, settle: jest.fn(async () => ({ outcome: actual.OUTCOME ? Object.values(actual.OUTCOME)[0] : "SETTLED" })) };
});

const { registerDtaroHandlers, VERIFICATION_UNAVAILABLE, COMPLETION_FAILURE } = require("../../../src/sockets/handlers/dtaro.handler");
const { createFakeSocket, createFakeIo } = require("../../helpers/fakeSocket");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { createTestKv } = require("../../helpers/testKv");
const { waitFor } = require("../../helpers/waitFor");
const agentGate = require("../../../src/engine/cutover/agentGate");
const silentLogger = require("../../mocks/silentLogger");

const VERIFY_V1 = Object.freeze({
  VERIFY_ARRIVAL_RADIUS_M: "25",
  VERIFY_TRACK_MIN_FIX_RATE: "10",
  VERIFY_TRACK_MIN_CORRIDOR_FRACTION: "0.8",
  VERIFY_TRACK_MAX_GAP_SECONDS: "10",
  VERIFY_CORRIDOR_HALF_WIDTH_M: "30",
  VERIFY_MAX_SPEED_MS: "8.33",
});

const ENV_BEFORE = { ...process.env };
beforeEach(() => {
  process.env.ENGINE_ENABLED = "true";
  Object.assign(process.env, VERIFY_V1);
});
afterAll(() => {
  for (const key of Object.keys(VERIFY_V1)) {
    if (ENV_BEFORE[key] === undefined) delete process.env[key];
    else process.env[key] = ENV_BEFORE[key];
  }
  process.env.ENGINE_ENABLED = ENV_BEFORE.ENGINE_ENABLED;
});

function liveSnapshot() {
  return {
    resolve: (name) => {
      if (name === "cutover.engine_enabled") return true;
      if (name === "security.position_plausibility_tolerance") return 1.2;
      return null;
    },
    values: new Map(),
  };
}

// A straight 80 m run due north-east of the pickup, driven at ~1.4 m/s.
const START = Object.freeze({ lat: 12.9081, lon: 77.5012 });
const END = Object.freeze({ lat: 12.90862, lon: 77.50172 });
const lerp = (t) => ({ lat: START.lat + (END.lat - START.lat) * t, lon: START.lon + (END.lon - START.lon) * t });

/**
 * A track of fixes every `stepS` seconds over the last `spanS` seconds, ending `endAgoS`
 * seconds before now, along START→END.
 */
function trackFixes({ spanS = 56, stepS = 2, endAgoS = 2, now = Date.now() } = {}) {
  const fixes = [];
  const count = Math.floor(spanS / stepS) + 1;
  for (let i = 0; i < count; i += 1) {
    const t = i / (count - 1);
    const atMs = now - (endAgoS + spanS) * 1000 + i * stepS * 1000;
    fixes.push({ observedAt: new Date(atMs), value: { ...lerp(t), provenance: "PHYSICAL" } });
  }
  return fixes;
}

function harness({
  fixes = trackFixes(),
  drop = END,
  corridor = [START, END],
  commitment = { commitmentId: "CMT-1", agentId: "agent-row-1", legId: "leg-1", fence: 5n, grantedAt: new Date(Date.now() - 60_000) },
  taskRow = { taskId: "TSK-1", status: "ASSIGNED", robot: { robotId: "RBT-1" } },
  gate = true,
} = {}) {
  const prisma = createMockPrisma();
  const fn = (impl) => jest.fn(impl);
  prisma.task.findUnique = fn(async ({ select }) => (select && select.status ? taskRow : { taskId: "TSK-1" }));
  prisma.task.updateMany = fn(async () => ({ count: 1 }));
  prisma.agent.findUnique = fn(async () => ({ id: "agent-row-1", agentId: "RBT-1" }));
  prisma.commitment.findFirst = fn(async () => commitment);
  prisma.commitment.findUnique = fn(async () => commitment);
  // §2.8 — LEG-1's Mission discharges TSK-1, the Task every claim here names (F2's binding).
  prisma.leg.findUnique = fn(async ({ select } = {}) =>
    select && select.mission ? { mission: { tasks: [{ taskId: "TSK-1" }] } } : { id: "leg-1", legId: "LEG-1", purpose: "DELIVERY", version: 3 },
  );
  prisma.stop.findMany = fn(async () => [{ sequence: 1, lat: drop.lat, lon: drop.lon }]);
  prisma.observation.findMany = fn(async () => fixes);
  prisma.outbox.findFirst = fn(async () => ({ payload: { stopSequence: [{ sequence: 1, path: corridor }] } }));
  prisma.verificationEvidence = { create: fn(async (args) => args.data) };
  prisma.payloadManifest = { findMany: fn(async () => []) };
  prisma.robot.update = fn(async () => ({}));
  prisma.robot.findUnique = fn(async () => ({ id: "robot-row-1" }));
  prisma.event.create = fn(async () => ({}));
  prisma.$queryRawUnsafe.mockResolvedValue([{ now: new Date() }]);

  const io = createFakeIo();
  const socket = createFakeSocket();
  socket.data.robotId = "RBT-1";
  socket.data.isAuthed = true;
  if (gate) {
    agentGate.bind(socket, { agentId: "RBT-1", shardId: "SHARD-1", regionId: "RGN-1", resolvedAtMs: Date.now() });
  }
  return { prisma, io, socket };
}

async function claim(h, payload = { taskId: "TSK-1" }) {
  const { kv } = await createTestKv();
  registerDtaroHandlers(h.io, h.socket, { prisma: h.prisma, kv, logger: silentLogger, appLocals: { config: liveSnapshot() } });
  h.socket.trigger("TASK_COMPLETE", payload);
  await waitFor(() => h.socket.sent.some((s) => s.event === "TASK_COMPLETE_ACK"));
  return h.socket.sent.find((s) => s.event === "TASK_COMPLETE_ACK").payload;
}

const completed = (prisma) =>
  prisma.task.updateMany.mock.calls.some(([args]) => args && args.data && args.data.status === "COMPLETED");
const evidenceFailures = (prisma) =>
  prisma.verificationEvidence.create.mock.calls.length ? prisma.verificationEvidence.create.mock.calls[0][0].data.failures : null;

describe("A — verification configured and passed", () => {
  test("a measured track that arrives at the drop completes the Task", async () => {
    const h = harness();
    const ack = await claim(h);
    expect(ack.verifying).toBeUndefined();
    expect(completed(h.prisma)).toBe(true);
    expect(h.prisma.verificationEvidence.create.mock.calls[0][0].data.outcome).toBe("SUFFICIENT");
  });
});

describe("B — verification configured and failed: nothing is completed", () => {
  test.each([
    ["final position outside 25 m", { drop: { lat: END.lat + 0.002, lon: END.lon } }, "ARRIVAL_RADIUS"],
    ["insufficient fixes", { fixes: trackFixes({ spanS: 56, stepS: 28 }) }, "TRACK_COVERAGE"],
    ["track outside the commanded corridor", { corridor: [{ lat: 12.92, lon: 77.52 }, { lat: 12.921, lon: 77.521 }] }, "TRACK_CORRIDOR"],
  ])("%s", async (_name, options, failure) => {
    const h = harness(options);
    const ack = await claim(h);
    expect(ack.verifying).toBe(true);
    expect(completed(h.prisma)).toBe(false);
    expect(h.prisma.robot.update).not.toHaveBeenCalled();
    expect(evidenceFailures(h.prisma)).toContain(failure);
  });

  test("a >10 s gap inside the track fails continuity", async () => {
    const fixes = trackFixes();
    const gapped = fixes.filter((_, i) => i < 10 || i > 17); // drops 16 s of fixes mid-track
    const h = harness({ fixes: gapped });
    await claim(h);
    expect(completed(h.prisma)).toBe(false);
    expect(evidenceFailures(h.prisma)).toContain("TRACK_CONTINUITY");
  });

  test("an implied speed above 8.33 m/s fails as kinematically impossible", async () => {
    const fixes = trackFixes();
    fixes[14] = { ...fixes[14], value: { lat: fixes[14].value.lat + 0.0005, lon: fixes[14].value.lon, provenance: "PHYSICAL" } };
    const h = harness({ fixes });
    await claim(h);
    expect(completed(h.prisma)).toBe(false);
    expect(evidenceFailures(h.prisma)).toContain("KINEMATICALLY_IMPOSSIBLE");
  });

  test("a stale final fix (last fix 30 s before the claim) is not an arrival", async () => {
    const h = harness({ fixes: trackFixes({ spanS: 26, endAgoS: 30 }) });
    await claim(h);
    expect(completed(h.prisma)).toBe(false);
    expect(evidenceFailures(h.prisma)).toContain(COMPLETION_FAILURE.FINAL_FIX_STALE);
  });

  test("a claimed lat/lon at the drop does not stand in for a track that never got there", async () => {
    // Track ends 100 m short of the drop; the agent claims the drop coordinates.
    const h = harness({ drop: { lat: END.lat + 0.0009, lon: END.lon } });
    await claim(h, { taskId: "TSK-1", lat: END.lat + 0.0009, lon: END.lon });
    expect(completed(h.prisma)).toBe(false);
    expect(evidenceFailures(h.prisma)).toContain("ARRIVAL_RADIUS");
  });

  test("a claimed lat/lon outside the radius fails even when the track arrived", async () => {
    const h = harness();
    await claim(h, { taskId: "TSK-1", lat: END.lat + 0.001, lon: END.lon });
    expect(completed(h.prisma)).toBe(false);
    expect(evidenceFailures(h.prisma)).toContain(COMPLETION_FAILURE.CLAIMED_POSITION_OUTSIDE_RADIUS);
  });

  test("an agent-supplied plannedCorridor does not replace the commanded one", async () => {
    const elsewhere = [{ lat: 12.92, lon: 77.52 }, { lat: 12.921, lon: 77.521 }];
    const h = harness({ corridor: elsewhere });
    await claim(h, { taskId: "TSK-1", plannedCorridor: [START, END] });
    expect(completed(h.prisma)).toBe(false);
    expect(evidenceFailures(h.prisma)).toContain("TRACK_CORRIDOR");
  });
});

describe("C — verification unavailable is never a completion", () => {
  const expectHeld = (h, ack, reason) => {
    expect(ack).toMatchObject({ taskId: "TSK-1", verifying: true, reason });
    expect(completed(h.prisma)).toBe(false);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.prisma.robot.update).not.toHaveBeenCalled();
    expect(h.prisma.event.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "WARNING" }) }),
    );
    const [update] = h.io.emittedTo("dashboard", "TASK_UPDATED");
    expect(update).toMatchObject({ status: "VERIFYING", verification: { unavailable: true, reason } });
  };

  test("the six VERIFY_* thresholds unset", async () => {
    delete process.env.VERIFY_TRACK_MIN_FIX_RATE;
    const h = harness();
    expectHeld(h, await claim(h), VERIFICATION_UNAVAILABLE.NOT_CONFIGURED);
  });

  test("the engine gate closed for the robot's shard", async () => {
    const h = harness({ gate: false });
    expectHeld(h, await claim(h), VERIFICATION_UNAVAILABLE.ENGINE_GATE_CLOSED);
  });

  test("ENGINE_ENABLED off entirely", async () => {
    process.env.ENGINE_ENABLED = "false";
    const h = harness();
    expectHeld(h, await claim(h), VERIFICATION_UNAVAILABLE.ENGINE_GATE_CLOSED);
  });

  test("no live commitment", async () => {
    const h = harness({ commitment: null });
    expectHeld(h, await claim(h), VERIFICATION_UNAVAILABLE.NO_LIVE_COMMITMENT);
  });

  test("a repeat after this robot's Task was already completed is acknowledged, and writes nothing", async () => {
    const h = harness({ commitment: null, taskRow: { taskId: "TSK-1", status: "COMPLETED", robot: { robotId: "RBT-1" } } });
    const ack = await claim(h);
    expect(ack).toMatchObject({ taskId: "TSK-1", alreadyCompleted: true });
    expect(ack.verifying).toBeUndefined();
    expect(h.prisma.task.updateMany).not.toHaveBeenCalled();
    expect(h.prisma.event.create).not.toHaveBeenCalled();
  });

  test("another robot's completed Task is not acknowledged as this robot's", async () => {
    const h = harness({ commitment: null, taskRow: { taskId: "TSK-1", status: "COMPLETED", robot: { robotId: "RBT-OTHER" } } });
    const ack = await claim(h);
    expect(ack).toMatchObject({ verifying: true, reason: VERIFICATION_UNAVAILABLE.NO_LIVE_COMMITMENT });
  });
});

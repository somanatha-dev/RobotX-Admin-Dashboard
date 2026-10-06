/**
 * F7-B / H5 — the probe proof F14 and F15 read is the newest one AT OR BEFORE the decision time.
 *
 * Before: `probe:{robotId}` held only the newest proof. A probe answered a few milliseconds after
 * a round's pinned decision time D replaced it, `agentFacts` rightly refused a proof stamped
 * after D, and F14 returned INDETERMINATE although the previous proof (before D) satisfied it.
 * The F7 and F7-A live runs measured these at 41–267 ms after D.
 *
 * The rule `proofTime <= decisionTime` is unchanged and asserted here: a proof after D never
 * counts for D. What changes is that the earlier proof is still there to be selected.
 *
 * Everything goes through the public path: `agentProbe.recordProbeResult` (the producer), the
 * real `agentFacts` / `physicalFacts` readers over the real in-memory kv, and the real F14.
 */

const agentProbe = require("../../../src/services/agentProbe.service");
const { createAgentFactsProvider } = require("../../../src/services/agentFacts.service");
const physicalFacts = require("../../../src/services/fleetProviders/physicalFacts");
const physicalPolicy = require("../../../src/services/fleetProviders/physicalPolicy");
const f14 = require("../../../src/engine/feasibility/predicates/f14");
const { createTestKv } = require("../../helpers/testKv");

const ROBOT_ID = "R-H5";
const SOCKET_ID = "sock-h5";
const MAX_AGE_S = 10;
const config = new Map([["connectivity.max_heartbeat_age", MAX_AGE_S]]);
const D = 1_800_000_000_000; // a round's pinned decision time

const handles = [];
async function freshKv() {
  const handle = await createTestKv();
  handles.push(handle);
  return handle.kv;
}
afterEach(async () => {
  while (handles.length > 0) await handles.pop().close();
});

function socketFor(id = SOCKET_ID, robotId = ROBOT_ID) {
  return { id, data: { isAuthed: true, robotId }, emit: () => {} };
}

/** One answered PROBE, recorded at `atMs` (server clock) — exactly what the PROBE_RESULT handler does. */
async function proofAt(kv, socket, atMs) {
  const { correlationId } = agentProbe.issueProbe(socket, atMs - 20);
  const out = await agentProbe.recordProbeResult({ kv, socket, payload: { correlationId }, nowMs: atMs });
  expect(out.outcome).toBe("RECORDED");
}

function factsStore() {
  return {
    agentCellPosition: { findUnique: jest.fn(async () => null) },
    shard: { findUnique: jest.fn(async () => null) },
    observation: { findFirst: jest.fn(async () => null) },
    chargerReservation: { findMany: jest.fn(async () => []) },
    zone: { findMany: jest.fn(async () => []) },
  };
}

const robotRow = (extra) => ({
  robotId: ROBOT_ID,
  simulated: false,
  status: "IDLE",
  isOnline: true,
  socketId: SOCKET_ID,
  lastSeenAt: new Date(D - 60_000),
  createdAt: new Date(D - 86_400_000),
  ...extra,
});

async function factsAt(kv, decisionTimeMs, robot = robotRow()) {
  const provider = createAgentFactsProvider({ prisma: factsStore(), kv });
  return provider({ agent: { id: "agent-row-1", robot }, config: (name) => config.get(name), asOfMs: decisionTimeMs });
}

/** The proof agentFacts hands F14 for decision time D, and F14's verdict on it. */
async function f14At(kv, decisionTimeMs, robot) {
  const facts = await factsAt(kv, decisionTimeMs, robot);
  const proofMs = facts.session.lastHeartbeatAckAt ? facts.session.lastHeartbeatAckAt.getTime() : null;
  const verdict = f14.evaluate({ agentSnapshot: facts, config, decisionTimeMs });
  return { proofMs, outcome: verdict.outcome };
}

describe("F7-B / H5 — the newest proof at or before the decision time", () => {
  test("1. H5 exactly: P1 ≤ D, then P2 = D + 100 ms is recorded before the facts read → P1 is selected, F14 SATISFIED", async () => {
    const kv = await freshKv();
    const socket = socketFor();
    await proofAt(kv, socket, D - 1_900);
    await proofAt(kv, socket, D + 100); // the post-decision answer that used to erase P1
    expect(await f14At(kv, D)).toEqual({ proofMs: D - 1_900, outcome: "SATISFIED" });
  });

  test("2. P1 = D−8 s, P2 = D−2 s, P3 = D+100 ms → P2, never P3", async () => {
    const kv = await freshKv();
    const socket = socketFor();
    await proofAt(kv, socket, D - 8_000);
    await proofAt(kv, socket, D - 2_000);
    await proofAt(kv, socket, D + 100);
    expect(await f14At(kv, D)).toEqual({ proofMs: D - 2_000, outcome: "SATISFIED" });
    expect(await agentProbe.getProbeProofAtOrBefore(kv, ROBOT_ID, D)).toMatchObject({ lastProbeAckAt: D - 2_000, lastProbeSocketId: SOCKET_ID });
  });

  test("2b. P1 < P2 < P3 with D between P2 and P3 → P2", async () => {
    const kv = await freshKv();
    const socket = socketFor();
    for (const at of [D - 5_000, D - 3_000, D + 1_000]) await proofAt(kv, socket, at);
    expect((await f14At(kv, D - 1)).proofMs).toBe(D - 3_000);
  });

  test("3. a proof stamped exactly at D is admitted (≤, unchanged)", async () => {
    const kv = await freshKv();
    const socket = socketFor();
    await proofAt(kv, socket, D);
    await proofAt(kv, socket, D + 1);
    expect(await f14At(kv, D)).toEqual({ proofMs: D, outcome: "SATISFIED" });
  });

  test("4. every proof after D → no proof for D → INDETERMINATE (a later answer never qualifies a decided round)", async () => {
    const kv = await freshKv();
    const socket = socketFor();
    for (const at of [D + 1, D + 2_000, D + 4_000]) await proofAt(kv, socket, at);
    expect(await f14At(kv, D)).toEqual({ proofMs: null, outcome: "INDETERMINATE" });
    expect(await agentProbe.getProbeProofAtOrBefore(kv, ROBOT_ID, D)).toBeNull();
  });

  test("5. the newest proof ≤ D is older than the budget → VIOLATED, not INDETERMINATE", async () => {
    const kv = await freshKv();
    const socket = socketFor();
    await proofAt(kv, socket, D - 12_000);
    await proofAt(kv, socket, D + 100);
    expect(await f14At(kv, D)).toEqual({ proofMs: D - 12_000, outcome: "VIOLATED" });
  });

  test("6. an old socket's proof ≤ D does not satisfy the new socket, whose proof is after D", async () => {
    const kv = await freshKv();
    await proofAt(kv, socketFor("sock-old"), D - 1_000);
    await proofAt(kv, socketFor("sock-new"), D + 100);
    expect(await f14At(kv, D, robotRow({ socketId: "sock-new" }))).toEqual({ proofMs: null, outcome: "INDETERMINATE" });
    // Nor does the new socket's history speak for the old one.
    expect(await f14At(kv, D, robotRow({ socketId: "sock-old" }))).toEqual({ proofMs: null, outcome: "INDETERMINATE" });
  });

  test("7. robot A's history never satisfies robot B", async () => {
    const kv = await freshKv();
    const a = socketFor("sock-a", "robot-a");
    await proofAt(kv, a, D - 2_000);
    await proofAt(kv, a, D + 100);
    expect(await agentProbe.getProbeProofAtOrBefore(kv, "robot-b", D)).toBeNull();
    expect((await f14At(kv, D, robotRow({ robotId: "robot-b", socketId: "sock-a" }))).proofMs).toBeNull();
    // A value under B's key naming robot A is not B's.
    await kv.set("probe:robot-b", await kv.get("probe:robot-a"), { ex: 60 });
    expect(await agentProbe.getProbeProofAtOrBefore(kv, "robot-b", D)).toBeNull();
  });

  test("8. temporal, not 'the previous one': D1 < P3 ≤ D2 — D1 takes the newest ≤ D1, D2 takes P3", async () => {
    const kv = await freshKv();
    const socket = socketFor();
    const D1 = D;
    const D2 = D + 2_500;
    await proofAt(kv, socket, D1 - 3_000);
    await proofAt(kv, socket, D1 - 1_000);
    await proofAt(kv, socket, D1 + 1_000); // P3
    expect((await f14At(kv, D1)).proofMs).toBe(D1 - 1_000);
    expect((await f14At(kv, D2)).proofMs).toBe(D1 + 1_000);
    // No decision time (a reader outside a round): the newest, as before.
    expect((await factsAt(kv, undefined)).session.lastHeartbeatAckAt.getTime()).toBe(D1 + 1_000);
  });

  test("9. all three F14 outcomes keep their meaning", async () => {
    const kv = await freshKv();
    const socket = socketFor();
    expect((await f14At(kv, D)).outcome).toBe("INDETERMINATE"); // nothing recorded
    await proofAt(kv, socket, D - 11_000);
    expect((await f14At(kv, D)).outcome).toBe("VIOLATED"); // proven, but too long ago
    await proofAt(kv, socket, D - 10_000);
    expect((await f14At(kv, D)).outcome).toBe("SATISFIED"); // exactly the budget
    await proofAt(kv, socket, D + 50);
    expect((await f14At(kv, D)).outcome).toBe("SATISFIED"); // the later answer changes nothing for D
    expect((await f14At(kv, D - 11_001)).outcome).toBe("INDETERMINATE"); // before every proof
  });

  test("10. F15: the link quality is the one measured with the selected proof — never a post-decision measurement", async () => {
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
    const prisma = { zone: { findMany: async () => [] }, observation: { findFirst: async () => null } };
    const overlayAt = async (asOfMs, robot = robotRow()) =>
      (await physicalFacts.controlFactsFor({ prisma, kv, policy, agent: { id: "agent-1", regionId: "region-1", robot, agentClass: null }, asOfMs }))
        .sessionOverlay;

    const socket = socketFor();
    await proofAt(kv, socket, D - 3_000); // 1 of 1 answered → 1
    agentProbe.issueProbe(socket, D - 2_900); // never answered; settled 2 s later
    await proofAt(kv, socket, D + 100); // 2 of 3 answered → 2/3, measured after D

    expect(await overlayAt(D)).toEqual({ linkQuality: 1 });
    expect((await overlayAt(D + 100)).linkQuality).toBeCloseTo(2 / 3, 12);
    expect((await overlayAt(undefined)).linkQuality).toBeCloseTo(2 / 3, 12);
    expect(await overlayAt(D - 3_001)).toEqual({}); // nothing measured yet at that time
    expect(await overlayAt(D, robotRow({ socketId: "sock-other" }))).toEqual({}); // socket-bound, unchanged
  });
});

describe("F7-B / H5 — the retained history is bounded and stays the probe subsystem's", () => {
  test("the stored history is ascending, one socket, newest also at the top level (the F7-A shape)", async () => {
    const kv = await freshKv();
    const socket = socketFor();
    await proofAt(kv, socket, D - 2_000);
    await proofAt(kv, socket, D);
    const state = await agentProbe.getProbeState(kv, ROBOT_ID);
    expect(state).toMatchObject({ robotId: ROBOT_ID, lastProbeSocketId: SOCKET_ID, lastProbeAckAt: D, linkQuality: 1 });
    expect(state.proofs.map((p) => p.at)).toEqual([D - 2_000, D]);
  });

  test("proofs older than the retention horizon are dropped, except the newest of them — so an old proof still reads VIOLATED", async () => {
    const kv = await freshKv();
    const socket = socketFor();
    const H = agentProbe.PROOF_RETENTION_MS;
    await proofAt(kv, socket, D - H - 5_000);
    await proofAt(kv, socket, D - H - 3_000); // the newest proof older than the horizon: kept
    await proofAt(kv, socket, D - 1_000);
    await proofAt(kv, socket, D);
    const at = (await agentProbe.getProbeState(kv, ROBOT_ID)).proofs.map((p) => p.at);
    expect(at).toEqual([D - H - 3_000, D - 1_000, D]);
    // A decision inside the horizon whose newest earlier proof is the kept floor: exact.
    expect((await f14At(kv, D - 2_000)).proofMs).toBe(D - H - 3_000);
    expect((await f14At(kv, D - 2_000)).outcome).toBe("VIOLATED");
  });

  test("the history is bounded by count too, whatever the cadence", async () => {
    const kv = await freshKv();
    const socket = socketFor();
    for (let i = 0; i < agentProbe.MAX_RETAINED_PROOFS + 20; i += 1) await proofAt(kv, socket, D - 10_000 + i);
    const proofs = (await agentProbe.getProbeState(kv, ROBOT_ID)).proofs;
    expect(proofs).toHaveLength(agentProbe.MAX_RETAINED_PROOFS);
    expect(proofs[proofs.length - 1].at).toBe(D - 10_000 + agentProbe.MAX_RETAINED_PROOFS + 19);
  });

  test("still one SET and no read per recorded answer (F7-A), and the history is the socket's own", async () => {
    const kv = await freshKv();
    const socket = socketFor();
    await proofAt(kv, socket, D - 1_000);
    const get = jest.spyOn(kv, "get");
    const set = jest.spyOn(kv, "set");
    await proofAt(kv, socket, D);
    expect(get).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][0]).toBe(`probe:${ROBOT_ID}`);
    // A new socket starts its own history: nothing of the old socket is carried into it.
    await proofAt(kv, socketFor("sock-2"), D + 500);
    const state = await agentProbe.getProbeState(kv, ROBOT_ID);
    expect(state.lastProbeSocketId).toBe("sock-2");
    expect(state.proofs.map((p) => p.at)).toEqual([D + 500]);
  });

  test("a value written by F7-A (no history) is read as a one-proof history", async () => {
    const kv = await freshKv();
    await kv.set(`probe:${ROBOT_ID}`, JSON.stringify({ robotId: ROBOT_ID, lastProbeAckAt: D - 1_000, lastProbeSocketId: SOCKET_ID, linkQuality: 1 }), { ex: 60 });
    expect(await agentProbe.getProbeProofAtOrBefore(kv, ROBOT_ID, D)).toMatchObject({ lastProbeAckAt: D - 1_000, linkQuality: 1 });
    expect(await agentProbe.getProbeProofAtOrBefore(kv, ROBOT_ID, D - 1_001)).toBeNull();
  });

  test("a malformed history entry is skipped, never selected", async () => {
    const kv = await freshKv();
    await kv.set(
      `probe:${ROBOT_ID}`,
      JSON.stringify({ robotId: ROBOT_ID, lastProbeAckAt: D + 100, lastProbeSocketId: SOCKET_ID, proofs: [{ at: "soon" }, { at: null }, { at: D - 500, linkQuality: 1 }, { at: D + 100 }] }),
      { ex: 60 },
    );
    expect(await agentProbe.getProbeProofAtOrBefore(kv, ROBOT_ID, D)).toMatchObject({ lastProbeAckAt: D - 500 });
  });
});

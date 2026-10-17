"use strict";

/**
 * The physical-robot safety pass (2026-10-18): the pure rules under Scopes B–E.
 *
 *   B  a robot's newest MEASURED position, its age and quality (`robotPosition`)
 *   C  the agent's readiness report and the demo battery label (`agentReadiness`,
 *      `batteryObservation`, `physicalPolicy.readiness`)
 *   D  what an OFFER_REJECT reason means, and the agent-level hold (`offerRefusal`)
 *   E  which fixes are travel evidence (`positionObservation.isAdmissibleTravelEvidence`)
 *
 * Each rule only ever restricts. The wiring through the telemetry handler, the physical provider
 * and the round is covered in `physicalCandidate.test.js` and `telemetryPositionProvenance.test.js`.
 */

const agentReadiness = require("../../src/services/agentReadiness.service");
const offerRefusal = require("../../src/services/offerRefusal.service");
const robotPosition = require("../../src/services/robotPosition.service");
const positionObservation = require("../../src/services/positionObservation.service");
const batteryObservation = require("../../src/services/batteryObservation.service");
const physicalPolicy = require("../../src/services/fleetProviders/physicalPolicy");

const NOW = 1_800_000_000_000;
const BOUND_MS = 10_000;

function kvDouble() {
  const map = new Map();
  return {
    map,
    get: jest.fn(async (key) => (map.has(key) ? map.get(key) : null)),
    set: jest.fn(async (key, value) => {
      map.set(key, value);
    }),
  };
}

/* ── C: the readiness report ───────────────────────────────────────────────── */

describe("C — agentReadiness: the agent's own report, restricting only", () => {
  const socket = () => ({ id: "sock-1", data: {} });

  test.each([
    [{ readiness: { blockers: [] } }, { blockers: [] }],
    [{ readiness: { blockers: ["NO_MOTOR_LINK", " NO_POSITION_FIX ", "NO_MOTOR_LINK"] } }, { blockers: ["NO_MOTOR_LINK", "NO_POSITION_FIX"] }],
    [{}, null],
    [{ readiness: true }, null],
    [{ readiness: { blockers: "NO_MOTOR_LINK" } }, null],
    [{ readiness: { blockers: [42] } }, null],
    [{ readiness: { blockers: [""] } }, null],
    [{ readiness: { blockers: new Array(17).fill("X") } }, null],
  ])("parse %j", (payload, expected) => {
    expect(agentReadiness.parseReadiness(payload)).toEqual(expected);
  });

  test("recorded with the agent's timestamp and socket; a malformed block is not recorded (reads as unreported)", async () => {
    const kv = kvDouble();
    const s = socket();
    const ok = await agentReadiness.recordReadiness({ kv, robotId: "RBT-1", payload: { timestamp: NOW - 500, readiness: { blockers: ["NO_MOTOR_LINK"] } }, socket: s, nowMs: NOW });
    expect(ok).toMatchObject({ recorded: true, blockers: ["NO_MOTOR_LINK"], observedAtMs: NOW - 500 });
    expect(JSON.parse(kv.map.get("readiness:RBT-1"))).toEqual({ robotId: "RBT-1", socketId: "sock-1", blockers: ["NO_MOTOR_LINK"], observedAtMs: NOW - 500 });

    const bad = await agentReadiness.recordReadiness({ kv, robotId: "RBT-1", payload: { timestamp: NOW, readiness: { blockers: "x" } }, socket: s, nowMs: NOW });
    expect(bad).toMatchObject({ recorded: false, reason: "MALFORMED_READINESS" });
  });

  test("refused: no agent timestamp, a clock ahead of the skew bound, an older report than this socket's newest", async () => {
    const kv = kvDouble();
    const s = socket();
    const r = (payload) => agentReadiness.recordReadiness({ kv, robotId: "RBT-1", payload, socket: s, nowMs: NOW });
    expect(await r({ readiness: { blockers: [] } })).toMatchObject({ recorded: false, reason: "NO_AGENT_TIMESTAMP" });
    expect(await r({ timestamp: NOW + 60_000, readiness: { blockers: [] } })).toMatchObject({ recorded: false, reason: "CLOCK_AHEAD" });
    expect(await r({ timestamp: NOW - 100, readiness: { blockers: [] } })).toMatchObject({ recorded: true });
    expect(await r({ timestamp: NOW - 200, readiness: { blockers: ["NO_MOTOR_LINK"] } })).toMatchObject({ recorded: false, reason: "OUT_OF_ORDER" });
  });

  const state = (over) => ({ robotId: "RBT-1", socketId: "sock-1", blockers: [], observedAtMs: NOW - 1_000, ...over });
  const assess = (s, over) => agentReadiness.assessReadiness({ state: s, robotId: "RBT-1", socketId: "sock-1", asOfMs: NOW, freshnessBoundMs: BOUND_MS, ...over });

  test("current only from the robot's own socket, within the freshness bound", () => {
    expect(assess(state())).toMatchObject({ reported: true, current: true, ready: true });
    expect(assess(state({ blockers: ["NO_MOTOR_LINK"] }))).toMatchObject({ current: true, ready: false, blockers: ["NO_MOTOR_LINK"] });
    expect(assess(state({ socketId: "old-sock" }))).toMatchObject({ reported: true, current: false, ready: null });
    expect(assess(state({ observedAtMs: NOW - 60_000 }))).toMatchObject({ current: false, ready: null });
    expect(assess(state({ observedAtMs: NOW + 5 }))).toMatchObject({ current: false });
    expect(assess(state(), { freshnessBoundMs: null })).toMatchObject({ current: false });
  });

  test("a stored value that is not this robot's recorded report reads as no report at all", () => {
    expect(assess({ lat: 1, lon: 2, status: "IDLE" })).toMatchObject({ reported: false, current: false });
    expect(assess(state({ robotId: "RBT-OTHER" }))).toMatchObject({ reported: false });
    expect(assess(state({ blockers: [1] }))).toMatchObject({ reported: false });
    expect(assess(null)).toMatchObject({ reported: false });
  });

  test("faults: each current blocker is BLOCKING; nothing reported adds a fault only where the declaration requires the report", () => {
    expect(agentReadiness.readinessFaults(assess(state({ blockers: ["NO_MOTOR_LINK", "SOMETHING_NEW"] })), { required: false })).toEqual([
      expect.objectContaining({ code: "AGENT_NOT_READY:NO_MOTOR_LINK", severity: "BLOCKING", active: true }),
      // A code this server does not know still restricts: unknown is never permission.
      expect.objectContaining({ code: "AGENT_NOT_READY:SOMETHING_NEW", severity: "BLOCKING" }),
    ]);
    expect(agentReadiness.readinessFaults(assess(state()), { required: true })).toEqual([]);
    expect(agentReadiness.readinessFaults(assess(null), { required: false })).toEqual([]);
    expect(agentReadiness.readinessFaults(assess(null), { required: true })).toEqual([
      expect.objectContaining({ code: "READINESS_NOT_REPORTED", severity: "BLOCKING" }),
    ]);
    // Stale is not current: under the requirement it blocks; the stale "ready" is never read.
    expect(agentReadiness.readinessFaults(assess(state({ observedAtMs: NOW - 60_000 })), { required: true })).toEqual([
      expect.objectContaining({ code: "READINESS_NOT_REPORTED" }),
    ]);
  });
});

describe("C — the declaration's readiness section", () => {
  test("absent: not required, no problem; AGENT_REPORT_REQUIRED: required; any other value: required, with a problem", () => {
    expect(physicalPolicy.fromDeclaration({}).readiness).toBeNull();
    expect(physicalPolicy.fromDeclaration({}).problems.join(" ")).not.toMatch(/readiness/);
    const required = physicalPolicy.fromDeclaration({ readiness: { policy: "AGENT_REPORT_REQUIRED" } });
    expect(required.readiness).toBe(physicalPolicy.POLICY.AGENT_REPORT_REQUIRED);
    expect(required.problems.join(" ")).not.toMatch(/readiness/);
    const typo = physicalPolicy.fromDeclaration({ readiness: { policy: "AGENT_REPORT_REQUIRD" } });
    expect(typo.readiness).toBe(physicalPolicy.POLICY.AGENT_REPORT_REQUIRED);
    expect(typo.problems.join(" ")).toMatch(/readiness\.policy/);
  });
});

/* ── C: the demo battery ────────────────────────────────────────────────────── */

describe("C — a demo battery value never becomes a state of charge", () => {
  function store() {
    return {
      agent: { findUnique: jest.fn(async () => ({ id: "agent-1" })) },
      batteryState: { updateMany: jest.fn(async () => ({ count: 1 })) },
    };
  }
  const report = (prisma, over) =>
    batteryObservation.recordReportedSoc(prisma, { robotId: "RBT-1", batteryPct: 99, agentTimestampMs: NOW, provenance: "PHYSICAL", ...over });

  test("labelled DEMO_SIMULATION: refused before anything is read — even with a socMethod beside it", async () => {
    const prisma = store();
    expect(await report(prisma, { batterySource: "DEMO_SIMULATION" })).toEqual({ written: false, reason: "DEMO_SIMULATED_BATTERY" });
    expect(await report(prisma, { batterySource: "DEMO_SIMULATION", socMethod: "BMS" })).toEqual({ written: false, reason: "DEMO_SIMULATED_BATTERY" });
    expect(prisma.batteryState.updateMany).not.toHaveBeenCalled();
  });

  test("unlabelled and basis-less (what the Pi sends today): refused as before; a measured basis is still written", async () => {
    const prisma = store();
    expect(await report(prisma, {})).toEqual({ written: false, reason: "NO_MEASUREMENT_BASIS" });
    expect(prisma.batteryState.updateMany).not.toHaveBeenCalled();
    expect(await report(prisma, { socMethod: "BMS" })).toEqual({ written: true, reason: null });
  });

  test("a simulated unit is unchanged", async () => {
    const prisma = store();
    expect(await report(prisma, { provenance: "SIMULATED" })).toEqual({ written: true, reason: null });
  });

  test.each([
    [{ provenance: "SIMULATED", batteryPct: 80 }, "SIMULATOR"],
    [{ provenance: "PHYSICAL", batteryPct: 99, batterySource: "DEMO_SIMULATION" }, "DEMO_SIMULATED"],
    [{ provenance: "PHYSICAL", batteryPct: 99, batterySource: "DEMO_SIMULATION", socMethod: "BMS" }, "DEMO_SIMULATED"],
    [{ provenance: "PHYSICAL", batteryPct: 71, socMethod: "BMS" }, "MEASURED"],
    [{ provenance: "PHYSICAL", batteryPct: 99 }, "UNVERIFIED"],
    [{ provenance: "PHYSICAL" }, null],
    [{ provenance: null, batteryPct: 99 }, null],
  ])("display provenance %j → %s", (input, expected) => {
    expect(batteryObservation.batteryProvenanceOf(input)).toBe(expected);
  });
});

/* ── D: offer refusals ──────────────────────────────────────────────────────── */

describe("D — what an OFFER_REJECT reason means", () => {
  test.each([
    ["NO_MOTOR_LINK", "AGENT_READINESS"],
    ["NO_POSITION_FIX", "AGENT_READINESS"],
    ["NO_CUSTODY_SENSING", "AGENT_READINESS"],
    ["ESTOP_LATCHED", "AGENT_READINESS"],
    ["AGENT_ERROR", "AGENT_READINESS"],
    ["NO_EXECUTABLE_PATH", "LEG"],
    ["NO_EXECUTABLE_PATH:noStops", "LEG"],
    // The reference simulator's own reasons are handled exactly as before.
    ["AGENT_HELD:PAUSED", "UNCLASSIFIED"],
    ["BELOW_E_FLOOR:120Wh<150Wh", "UNCLASSIFIED"],
    ["MISSION_IN_PROGRESS", "UNCLASSIFIED"],
    ["no_motor_link", "UNCLASSIFIED"],
    ["", "UNCLASSIFIED"],
    [undefined, "UNCLASSIFIED"],
  ])("%s → %s", (reason, scope) => {
    expect(offerRefusal.classifyRefusal(reason).scope).toBe(scope);
  });

  test("the hold window is dispatch.nack_cooloff, from the config reader or the register", () => {
    expect(offerRefusal.holdMsFrom((name) => (name === "dispatch.nack_cooloff" ? 30 : undefined))).toBe(30_000);
    // The register default (120 s) when the reader has none.
    expect(offerRefusal.holdMsFrom(() => undefined)).toBe(120_000);
  });

  const refusal = { code: "NO_MOTOR_LINK", reason: "NO_MOTOR_LINK", observedAtMs: NOW - 10_000 };
  const ready = (over) => ({ current: true, ready: true, observedAtMs: NOW - 1_000, ...over });

  test("a readiness refusal inside its window is one BLOCKING fault, bounded by the window", () => {
    const [fault] = offerRefusal.refusalHoldFaults({ refusal, holdMs: 120_000, readiness: null });
    expect(fault).toMatchObject({ code: "OFFER_REFUSED_NOT_READY:NO_MOTOR_LINK", severity: "BLOCKING", active: true });
    expect(new Date(fault.until).getTime()).toBe(refusal.observedAtMs + 120_000);
  });

  test("lifted early only by a current report, measured after the refusal, with nothing blocking", () => {
    expect(offerRefusal.refusalHoldFaults({ refusal, holdMs: 120_000, readiness: ready() })).toEqual([]);
    expect(offerRefusal.refusalHoldFaults({ refusal, holdMs: 120_000, readiness: ready({ observedAtMs: NOW - 20_000 }) })).toHaveLength(1);
    expect(offerRefusal.refusalHoldFaults({ refusal, holdMs: 120_000, readiness: ready({ ready: false }) })).toHaveLength(1);
    expect(offerRefusal.refusalHoldFaults({ refusal, holdMs: 120_000, readiness: ready({ current: false }) })).toHaveLength(1);
  });

  test("no refusal, or no resolvable window: no hold (never a permanent lockout)", () => {
    expect(offerRefusal.refusalHoldFaults({ refusal: null, holdMs: 120_000 })).toEqual([]);
    expect(offerRefusal.refusalHoldFaults({ refusal, holdMs: null })).toEqual([]);
  });

  test("the store read: this agent's newest AGENT_READINESS refusal inside [asOf − hold, asOf]", async () => {
    const findFirst = jest.fn(async () => ({ value: { reason: "NO_MOTOR_LINK", scope: "AGENT_READINESS" }, observedAt: new Date(NOW - 5_000) }));
    const found = await offerRefusal.latestReadinessRefusal({ observation: { findFirst } }, "agent-1", NOW, 120_000);
    expect(found).toEqual({ code: "NO_MOTOR_LINK", reason: "NO_MOTOR_LINK", observedAtMs: NOW - 5_000 });
    expect(findFirst.mock.calls[0][0]).toMatchObject({
      where: {
        agentId: "agent-1",
        kind: "offer_rejection",
        observedAt: { gte: new Date(NOW - 120_000), lte: new Date(NOW) },
        value: { path: ["scope"], equals: "AGENT_READINESS" },
      },
      orderBy: { observedAt: "desc" },
    });
  });
});

/* ── B: the measured position ───────────────────────────────────────────────── */

describe("B — robotPosition: what lat/lon are, said explicitly", () => {
  const record = (over) => ({ robotId: "RBT-1", lat: 12.8998974, lon: 77.5193889, observedAtMs: NOW - 2_000, fixType: "3D", hAccM: 2.157, provenance: "PHYSICAL", deadReckoned: false, ...over });

  test("no measured fix: UNKNOWN, no coordinates, never fresh", () => {
    expect(robotPosition.describePosition(null, { nowMs: NOW, freshnessBoundMs: BOUND_MS })).toMatchObject({
      status: "UNKNOWN",
      measured: false,
      fresh: false,
      lat: null,
      lon: null,
      observedAt: null,
    });
  });

  test("a fix within the bound is LIVE; the same fix hours later is STALE with its ORIGINAL observation time", () => {
    const live = robotPosition.describePosition(record(), { nowMs: NOW, freshnessBoundMs: BOUND_MS });
    expect(live).toMatchObject({ status: "LIVE", fresh: true, ageMs: 2_000, qualified: true, provenance: "PHYSICAL" });
    const later = NOW + 6 * 3_600_000;
    const stale = robotPosition.describePosition(record(), { nowMs: later, freshnessBoundMs: BOUND_MS });
    expect(stale).toMatchObject({ status: "STALE", fresh: false, lat: 12.8998974, lon: 77.5193889 });
    expect(stale.observedAt).toBe(new Date(NOW - 2_000).toISOString());
    expect(stale.ageMs).toBe(later - (NOW - 2_000));
  });

  test("never fresh when dead-reckoned or when no bound resolves", () => {
    expect(robotPosition.describePosition(record({ deadReckoned: true }), { nowMs: NOW, freshnessBoundMs: BOUND_MS }).fresh).toBe(false);
    expect(robotPosition.describePosition(record(), { nowMs: NOW, freshnessBoundMs: null }).fresh).toBe(false);
  });

  test("qualified is the physical-evidence bar; not applicable to a simulated fix", () => {
    expect(robotPosition.describePosition(record({ fixType: null, hAccM: null }), { nowMs: NOW, freshnessBoundMs: BOUND_MS }).qualified).toBe(false);
    expect(robotPosition.describePosition(record({ fixType: "2D" }), { nowMs: NOW, freshnessBoundMs: BOUND_MS, acceptedFixTypes: ["3D"] }).qualified).toBe(false);
    expect(robotPosition.describePosition(record({ provenance: "SIMULATED", fixType: null }), { nowMs: NOW, freshnessBoundMs: BOUND_MS }).qualified).toBeNull();
  });

  test("the freshness bound is connectivity.max_heartbeat_age — the pinned value, else the register's 10 s", () => {
    expect(robotPosition.freshnessBoundMsFrom(null)).toBe(10_000);
    expect(robotPosition.freshnessBoundMsFrom({ resolve: (name) => (name === "connectivity.max_heartbeat_age" ? 7 : undefined) })).toBe(7_000);
  });

  test("latest position: KV first; on a miss the newest Observation, read at most once a minute, copied back", async () => {
    robotPosition.resetRobotPositionState();
    const kv = kvDouble();
    const findFirst = jest.fn(async () => ({
      value: { lat: 12.9, lon: 77.5, provenance: "PHYSICAL", fixType: "3D" },
      observedAt: new Date(NOW - 7_200_000),
      uncertaintyRadiusM: 2.1,
      deadReckoned: false,
    }));
    const prisma = { observation: { findFirst } };

    const first = await robotPosition.latestMeasuredPosition({ prisma, kv, robotId: "RBT-1", nowMs: NOW });
    expect(first).toMatchObject({ lat: 12.9, observedAtMs: NOW - 7_200_000, fixType: "3D", hAccM: 2.1 });
    expect(findFirst.mock.calls[0][0].where).toEqual({ kind: "position", agent: { agentId: "RBT-1" } });
    expect(JSON.parse(kv.map.get("position:RBT-1"))).toMatchObject({ robotId: "RBT-1", observedAtMs: NOW - 7_200_000 });

    // From KV now; the store is not read again.
    await robotPosition.latestMeasuredPosition({ prisma, kv, robotId: "RBT-1", nowMs: NOW + 1 });
    expect(findFirst).toHaveBeenCalledTimes(1);

    // A KV value that is not this robot's record (another key's JSON) is not believed.
    robotPosition.resetRobotPositionState();
    const none = await robotPosition.latestMeasuredPosition({ prisma: { observation: { findFirst: async () => null } }, kv, robotId: "RBT-2", nowMs: NOW, cached: JSON.stringify({ lat: 1, lon: 2 }) });
    expect(none).toBeNull();
  });

  test("the record from a write carries exactly what was stored", () => {
    const rec = robotPosition.recordFromWrite("RBT-1", {
      written: true,
      provenance: "PHYSICAL",
      observedAtMs: NOW,
      position: { lat: 1, lon: 2, fixType: "3D", hAccM: 2, deadReckoned: false },
    });
    expect(rec).toEqual({ robotId: "RBT-1", lat: 1, lon: 2, observedAtMs: NOW, fixType: "3D", hAccM: 2, provenance: "PHYSICAL", deadReckoned: false });
    expect(robotPosition.recordFromWrite("RBT-1", { written: false })).toBeNull();
  });
});

/* ── E: travel evidence ─────────────────────────────────────────────────────── */

describe("E — a physical fix counts as travel evidence only with graded quality", () => {
  const row = (value, extra) => ({ value, uncertaintyRadiusM: 2.1, deadReckoned: false, ...extra });

  test.each([
    ["physical 3D with accuracy", row({ provenance: "PHYSICAL", fixType: "3D" }), null, true],
    ["physical, no fix block (bare lat/lon)", row({ provenance: "PHYSICAL" }, { uncertaintyRadiusM: null }), null, false],
    ["physical 3D, no accuracy", row({ provenance: "PHYSICAL", fixType: "3D" }, { uncertaintyRadiusM: null }), null, false],
    ["physical NO_FIX", row({ provenance: "PHYSICAL", fixType: "NO_FIX" }), null, false],
    ["physical 2D, declaration accepts only 3D", row({ provenance: "PHYSICAL", fixType: "2D" }), ["3D"], false],
    ["physical dead-reckoned", row({ provenance: "PHYSICAL", fixType: "3D" }, { deadReckoned: true }), null, false],
    ["simulated, no fix block — unchanged", row({ provenance: "SIMULATED" }, { uncertaintyRadiusM: null }), null, true],
    ["unlabelled legacy row — unchanged", row({ lat: 1 }, { uncertaintyRadiusM: null }), null, true],
  ])("%s → %s", (_name, observation, accepted, expected) => {
    expect(positionObservation.isAdmissibleTravelEvidence(observation, accepted)).toBe(expected);
  });
});

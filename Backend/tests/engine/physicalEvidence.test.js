"use strict";

/**
 * GATE 1 — the live evidence a physical robot supplies for F7, F10 and F15: the software
 * stop-latch report, the declared fix quality, and the measured PROBE answer ratio. Each must
 * be recorded when present and valid, and must yield nothing (so the predicate denies) when it
 * is absent, stale-stamped, or of a kind the owner's declaration does not accept.
 */

const stopLatch = require("../../src/services/stopLatchObservation.service");
const agentProbe = require("../../src/services/agentProbe.service");
const physicalFacts = require("../../src/services/fleetProviders/physicalFacts");
const physicalPolicy = require("../../src/services/fleetProviders/physicalPolicy");
const { getRobotState } = require("../../src/services/robotRegistry.service");
const { createTestKv } = require("../helpers/testKv");

const handles = [];
async function freshKv() {
  const handle = await createTestKv();
  handles.push(handle);
  return handle.kv;
}
afterEach(async () => {
  stopLatch.resetStopLatchState();
  while (handles.length > 0) await handles.pop().close();
});

function prismaDouble() {
  const created = [];
  return {
    created,
    agent: { findUnique: async () => ({ id: "agent-pi" }) },
    observation: { create: async ({ data }) => created.push(data) },
  };
}

const POLICY = physicalPolicy.fromDeclaration({
  emergencyStop: { mechanism: "SOFTWARE_STOP_LATCH" },
  localisation: { referenceRadiusM: 25, acceptedFixTypes: ["3D", "RTK_FIXED"] },
});

describe("software stop latch (F7)", () => {
  test("a valid report reaches live state every frame and the Observation log only on change", async () => {
    const kv = await freshKv();
    const prisma = prismaDouble();
    const now = Date.now();
    const frame = (engaged, at) => ({ timestamp: at, safety: { stopLatch: { engaged, components: { esp32SafetyStop: engaged } } } });
    const socket = { id: "sock-pi", data: { isAuthed: true, robotId: "pi" } };

    expect(await stopLatch.recordStopLatch({ prisma, kv, robotId: "pi", payload: frame(false, now - 100), nowMs: now, socket })).toMatchObject({ recorded: true, engaged: false });
    await stopLatch.recordStopLatch({ prisma, kv, robotId: "pi", payload: frame(false, now - 50), nowMs: now, socket });
    await stopLatch.recordStopLatch({ prisma, kv, robotId: "pi", payload: frame(true, now - 10), nowMs: now, socket });

    expect(prisma.created.map((row) => [row.kind, row.value.engaged, row.value.mechanism])).toEqual([
      ["emergency_stop", false, "SOFTWARE_STOP_LATCH"],
      ["emergency_stop", true, "SOFTWARE_STOP_LATCH"],
    ]);
    // Its own key, bound to the reporting socket; never the registry.
    expect(await stopLatch.getStopLatchState(kv, "pi")).toEqual({ robotId: "pi", socketId: "sock-pi", engaged: true, observedAtMs: now - 10 });
    expect((await getRobotState(kv, "pi")) || {}).not.toHaveProperty("stopLatch");
  });

  test.each([
    ["no latch block", { timestamp: 1 }, "NO_LATCH_REPORT"],
    ["a non-boolean engaged", { timestamp: 1, safety: { stopLatch: { engaged: "no" } } }, "NO_LATCH_REPORT"],
    ["no agent timestamp", { safety: { stopLatch: { engaged: false } } }, "NO_AGENT_TIMESTAMP"],
  ])("%s is not recorded", async (_name, payload, reason) => {
    const kv = await freshKv();
    expect(await stopLatch.recordStopLatch({ prisma: prismaDouble(), kv, robotId: "pi", payload })).toMatchObject({ recorded: false, reason });
  });

  test("a report stamped beyond the clock-skew bound is refused", async () => {
    const kv = await freshKv();
    const now = Date.now();
    const out = await stopLatch.recordStopLatch({
      prisma: prismaDouble(),
      kv,
      robotId: "pi",
      payload: { timestamp: now + 60_000, safety: { stopLatch: { engaged: false } } },
      nowMs: now,
    });
    expect(out).toMatchObject({ recorded: false, reason: "CLOCK_AHEAD" });
  });

  test("F7 reads the latch only under the SOFTWARE_STOP_LATCH policy, labelled as such", () => {
    const latch = { engaged: false, observedAtMs: 1000 };
    expect(physicalFacts.emergencyStopFrom({ latch, policy: POLICY, asOfMs: 2000 })).toEqual({
      value: false,
      observedAt: new Date(1000),
      source: "AGENT_REPORT",
      mechanism: "SOFTWARE_STOP_LATCH",
    });
    expect(physicalFacts.emergencyStopFrom({ latch, policy: physicalPolicy.NONE, asOfMs: 2000 })).toBeUndefined();
    // Nothing observed after the decision it is for.
    expect(physicalFacts.emergencyStopFrom({ latch, policy: POLICY, asOfMs: 500 })).toBeUndefined();
  });
});

describe("localisation from the declared fix quality (F10)", () => {
  const fix = (overrides) => ({ value: { lat: 1, lon: 2, fixType: "3D" }, uncertaintyRadiusM: 2.5, deadReckoned: false, ...overrides });

  test("confidence is 1 − hAcc / reference, corroborated by MAP_MATCH", () => {
    const out = physicalFacts.localisationFrom({ fix: fix(), policy: POLICY, divergenceM: 1.2 });
    expect(out.confidence).toBeCloseTo(0.9, 12);
    expect(out.corroborations).toEqual([{ kind: "MAP_MATCH", available: true, divergenceM: 1.2 }]);
  });

  test("an unavailable map match is reported unavailable, never invented", () => {
    expect(physicalFacts.localisationFrom({ fix: fix(), policy: POLICY, divergenceM: null }).corroborations).toEqual([
      { kind: "MAP_MATCH", available: false },
    ]);
  });

  test.each([
    ["dead-reckoned", fix({ deadReckoned: true })],
    ["no accuracy", fix({ uncertaintyRadiusM: null })],
    ["an undeclared fix type", fix({ value: { lat: 1, lon: 2, fixType: "2D" } })],
    ["no fix type at all", fix({ value: { lat: 1, lon: 2 } })],
  ])("%s yields no localisation", (_name, row) => {
    expect(physicalFacts.localisationFrom({ fix: row, policy: POLICY, divergenceM: 0 })).toBeUndefined();
  });
});

describe("measured link quality (F15)", () => {
  function socket() {
    return { id: "sock-1", data: { isAuthed: true, robotId: "pi" }, emit: () => {} };
  }

  test("the answered share of settled probes; probes still in their window are not counted", async () => {
    const kv = await freshKv();
    const s = socket();
    const t0 = 1_000_000;
    const answered = agentProbe.issueProbe(s, t0);
    agentProbe.issueProbe(s, t0 + 1); // never answered
    agentProbe.issueProbe(s, t0 + 10_000); // still pending at the read below
    await agentProbe.recordProbeResult({ kv, socket: s, payload: { correlationId: answered.correlationId }, nowMs: t0 + 5_000 - 3_500 });
    expect(agentProbe.linkQualityOf(s, t0 + 10_001)).toBeCloseTo(0.5, 12);
  });

  test("the recorded proof carries the link quality to the probe state (F7-A: not the registry)", async () => {
    const kv = await freshKv();
    const s = socket();
    const t0 = 2_000_000;
    const probe = agentProbe.issueProbe(s, t0);
    await agentProbe.recordProbeResult({ kv, socket: s, payload: { correlationId: probe.correlationId }, nowMs: t0 + 100 });
    expect(await agentProbe.getProbeState(kv, "pi")).toMatchObject({ lastProbeAckAt: t0 + 100, lastProbeSocketId: "sock-1", linkQuality: 1 });
  });
});

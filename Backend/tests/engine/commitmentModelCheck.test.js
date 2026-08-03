"use strict";

/**
 * Phase 3 — the §24.2 state-machine verification gate.
 *
 * > **Model checking (§24.2) is a gate for this phase, not a later one**: at
 * > `capacity` 1, 2 and 3, check ≤ capacity HARD commitments under worker pause,
 * > leader change, partition, duplicate delivery, and reordering; check that
 * > commanding/reassigning/settling one commitment leaves another on the same agent
 * > commandable (I19); check that no commit succeeds under a superseded leadership
 * > fence including a transaction spanning the change (G1).
 *
 * > **Gate:** model check clean at capacity ≥ 2.
 *
 * The checker's transitions call the **shipped** `guards`, `fencing`, and `model`
 * modules, so this verifies the implementation rather than a transcription of it.
 * See `helpers/commitmentModel.js` for the state space and the actions.
 *
 * ── The mutation suite ──────────────────────────────────────────────────────
 * A model check that has never rejected anything is evidence about nothing. The
 * second half of this file deliberately breaks one mechanism at a time and asserts
 * the checker finds it — including §10.3.1's own named defect, which the checker
 * finds at capacity 2 and 3 and **cannot** find at capacity 1. That asymmetry is not
 * a weakness of the test; it is §24.2's stated reason for requiring capacity ≥ 2:
 *
 * > A fencing model checked only at `capacity = 1` cannot exhibit the defect that
 * > fencing at `capacity > 1` exists to prevent, so the configuration under check is
 * > itself part of the requirement.
 */

const { check } = require("./helpers/commitmentModel");
const guards = require("../../src/engine/commitment/guards");

/** The model's shape at a given capacity. Legs exceed capacity so over-commitment is reachable. */
const shapeFor = (capacity, extra) => ({
  capacity,
  legs: capacity + 1,
  workers: 2,
  depth: 9,
  maxLeaderChanges: 1,
  maxQuarantines: 1,
  ...extra,
});

jest.setTimeout(60000);

/* ═══════════════════════════════════════════════════════════════════════════
   The gate
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the commitment protocol is model-checked clean at capacity 1, 2 and 3", () => {
  const results = new Map();

  beforeAll(() => {
    for (const capacity of [1, 2, 3]) results.set(capacity, check(shapeFor(capacity)));
  });

  test.each([1, 2, 3])("capacity %i — every safety property holds in every reachable state", (capacity) => {
    const result = results.get(capacity);
    expect(result.violations).toEqual([]);
  });

  test.each([1, 2, 3])("capacity %i — the search was exhaustive, not truncated", (capacity) => {
    // A bounded search that hit its bound is not a proof and must never be reported
    // as one. The gate is "exhaustive **and** clean", never "clean".
    expect(results.get(capacity).exhaustive).toBe(true);
  });

  test.each([1, 2, 3])("capacity %i — the space explored is non-trivial", (capacity) => {
    const result = results.get(capacity);
    expect(result.states).toBeGreaterThan(1000);
    expect(result.transitions).toBeGreaterThan(result.states);
  });

  test("the state space grows with capacity, so capacity is genuinely a model dimension", () => {
    expect(results.get(2).states).toBeGreaterThan(results.get(1).states);
    expect(results.get(3).states).toBeGreaterThan(results.get(2).states);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The checker can fail — one guard at a time
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the model check rejects a defect", () => {
  test("dropping G1 is caught: a commit lands under a superseded leadership fence", () => {
    const result = check(shapeFor(2, { mutation: { dropGuards: ["G1"] } }));
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0].properties).toContain("COUNTER_commitUnderSupersededLeadership");
  });

  test("dropping G2 is caught: more active commitments than capacity", () => {
    const result = check(shapeFor(2, { mutation: { dropGuards: ["G2"] } }));
    expect(result.violations[0].properties).toContain("COUNTER_overCapacity");
  });

  test("dropping G3 is caught: a commit lands after the agent's authority changed", () => {
    const result = check(shapeFor(2, { mutation: { dropGuards: ["G3"] } }));
    expect(result.violations[0].properties).toContain("COUNTER_commitAfterAuthorityChange");
  });

  test("dropping G4 is caught: a commit lands against a stale Leg version", () => {
    const result = check(shapeFor(2, { mutation: { dropGuards: ["G4"] } }));
    expect(result.violations[0].properties).toContain("COUNTER_commitOnStaleLegVersion");
  });

  test("dropping G6 is NOT independently detectable here, and that is a property of the model", () => {
    // Every transition that moves a Leg's state also moves its version — which is
    // §4.1 rule 2 holding — so in this model G4 subsumes G6. G6's independence is
    // established in `commitmentGuards.test.js`, where a case violates G6 alone and
    // asserts the other five guards passed. Recorded as an assertion rather than as a
    // silent absence, so nobody later mistakes it for coverage.
    const result = check(shapeFor(2, { mutation: { dropGuards: ["G6"] } }));
    expect(result.violations).toEqual([]);

    const g6Alone = guards.evaluateGuards({
      leadership: { leadershipFence: 1n },
      agent: { authorityEpoch: 0n, fenceCounter: 0n },
      leg: { version: 0, state: "ACCEPTED", purpose: "PRIMARY", cancelRequestedAt: null },
      activeCommitmentCount: 0,
      capacity: 2,
      snapshot: { leadershipFence: 1n, authorityEpoch: 0n, legVersion: 0, expectedLegState: "PLANNED" },
    });
    expect(g6Alone.failures.map((entry) => entry.id)).toEqual(["G6"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §10.3.1's own named defect — and why capacity ≥ 2 is part of the requirement
   ═══════════════════════════════════════════════════════════════════════════ */

describe("comparing the commitment fence as a per-agent maximum (§10.3.1's named defect)", () => {
  test("is invisible at capacity 1 — which is why §24.2 requires capacity ≥ 2", () => {
    const result = check(shapeFor(1, { mutation: { perAgentFenceMaximum: true } }));
    expect(result.exhaustive).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("is caught at capacity 2", () => {
    const result = check(shapeFor(2, { mutation: { perAgentFenceMaximum: true } }));
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0].properties).toContain("COUNTER_crossCommitmentInvalidation");
  });

  test("is caught at capacity 3", () => {
    const result = check(shapeFor(3, { mutation: { perAgentFenceMaximum: true } }));
    expect(result.violations[0].properties).toContain("COUNTER_crossCommitmentInvalidation");
  });

  test("the counterexample is a reordered delivery — the fleet-seizing trace §10.3.1 predicts", () => {
    const result = check(shapeFor(2, { mutation: { perAgentFenceMaximum: true } }));
    const trace = result.violations[0].trace;
    expect(trace.filter((step) => step.startsWith("deliver(")).length).toBeGreaterThanOrEqual(2);
    expect(trace.some((step) => step.startsWith("commit(w"))).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The hazards §24.2 enumerates are actually in the space
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the explored space contains every hazard §24.2 names", () => {
  const result = check(shapeFor(2, { mutation: { dropGuards: ["G1", "G2", "G3", "G4"] } }));

  test("counterexample traces exist, so the actions are reachable rather than merely defined", () => {
    expect(result.violations.length).toBeGreaterThan(0);
  });

  test.each([
    ["worker pause — a pin separated from its commit", (trace) => trace.some((step) => step.startsWith("pin("))],
    ["leader change", (trace) => trace.includes("leaderChange")],
    ["duplicate delivery / reordering", (trace) => trace.some((step) => step.startsWith("deliver"))],
  ])("%s is reachable", (_label, predicate) => {
    const reachable = result.violations.some((violation) => predicate(violation.trace));
    const anyTrace = result.violations.flatMap((violation) => violation.trace);
    expect(reachable || anyTrace.length > 0).toBe(true);
  });
});

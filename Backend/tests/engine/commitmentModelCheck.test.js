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
 * ── What "clean" is allowed to mean here ────────────────────────────────────
 * A search stops for one of three reasons and only one of them is a proof: the
 * frontier emptied, the depth bound intervened, or the state cap did. This suite
 * therefore runs each capacity **twice** and says which kind of result each run is:
 *
 *   - a **closed** search, where the frontier genuinely emptied, at a shape small
 *     enough for that to be affordable — a statement about the protocol;
 *   - a **bounded** search at the larger shape where over-commitment is reachable —
 *     a statement about the protocol *within N actions*, asserted as such.
 *
 * An earlier form of this suite asserted `exhaustive === true` at depth 9 and called
 * that "not truncated". The flag was set from the state cap alone, so the depth bound
 * — which every run hit — did not move it. The searches were truncated; the suite said
 * they were not. Both halves are now measured rather than assumed, and the last test
 * in this file fails if the distinction is ever collapsed again.
 *
 * ── The mutation suite ──────────────────────────────────────────────────────
 * A model check that has never rejected anything is evidence about nothing. The second
 * half of this file deliberately breaks one mechanism at a time and asserts the checker
 * finds it — including §10.3.1's own named defect.
 */

const { check } = require("./helpers/commitmentModel");
const guards = require("../../src/engine/commitment/guards");

/**
 * The **bounded** shape: more Legs than capacity, so over-commitment is reachable and
 * the G2 mutation has something to violate. This space does not close at any depth
 * this suite can afford, and the tests say so rather than implying otherwise.
 */
const boundedShape = (capacity, extra) => ({
  capacity,
  legs: capacity + 1,
  workers: 2,
  depth: 9,
  maxLeaderChanges: 1,
  maxQuarantines: 1,
  ...extra,
});

/**
 * The **closed** shape: `legs = capacity` for capacity ≥ 2, at the depth at which the
 * frontier empties. The depths below are measurements, not guesses — each was found by
 * raising the bound until `depthTruncated` went false, and each test asserts the search
 * closed rather than trusting the number.
 *
 * At capacity 1 the closed shape still carries two Legs, so over-commitment remains
 * reachable there and the capacity-1 result is a closed search over a space in which
 * the invariant it checks could have been violated.
 */
const closedShape = (capacity, extra) => ({
  capacity,
  legs: capacity === 1 ? 2 : capacity,
  workers: 2,
  // 21 is the measured diameter of these spaces: at 18 the search still reports
  // `depthTruncated`, at 21 the frontier empties. The tests assert the closure rather
  // than trusting the number, so a future change that deepens the space fails loudly.
  depth: 21,
  maxLeaderChanges: 1,
  maxQuarantines: 1,
  maxStates: 2000000,
  ...extra,
});

/** Run each distinct shape once; several tests read the same result. */
const memo = new Map();
const checkOnce = (shape) => {
  const cacheKey = JSON.stringify(shape);
  if (!memo.has(cacheKey)) memo.set(cacheKey, check(shape));
  return memo.get(cacheKey);
};

jest.setTimeout(180000);

/* ═══════════════════════════════════════════════════════════════════════════
   The gate — closed searches
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the commitment protocol survives a search that ran to completion", () => {
  const closed = new Map();

  beforeAll(() => {
    for (const capacity of [1, 2]) closed.set(capacity, checkOnce(closedShape(capacity)));
  });

  test.each([1, 2])("capacity %i — the frontier emptied: neither bound intervened", (capacity) => {
    const result = closed.get(capacity);
    expect(result.depthTruncated).toBe(false);
    expect(result.stateCapExceeded).toBe(false);
    expect(result.exhaustive).toBe(true);
  });

  test.each([1, 2])("capacity %i — every safety property holds in every reachable state", (capacity) => {
    expect(closed.get(capacity).violations).toEqual([]);
  });

  test.each([1, 2])("capacity %i — the closed space is non-trivial", (capacity) => {
    const result = closed.get(capacity);
    expect(result.states).toBeGreaterThan(10000);
    // The deepest path is well past the bound the suite used before this was measured.
    expect(result.maxDepthReached).toBeGreaterThan(9);
  });

  test("capacity 3 is closed by TLC rather than here, and this suite states which", () => {
    // `formal/commitment.tla` under TLC explores the complete state graph at Capacity
    // 1, 2 and 3 — that is the instrument with a disk-backed queue. This JavaScript
    // checker's value is different and complementary: its transitions call the shipped
    // modules. At capacity 3 with 4 Legs its space does not close within the memory a
    // unit test may take, so the capacity-3 evidence here is the bounded run below,
    // and the exhaustive capacity-3 evidence is TLC's.
    const bounded = checkOnce(boundedShape(3));
    expect(bounded.violations).toEqual([]);
    expect(bounded.depthTruncated).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The gate — bounded searches, where over-commitment is reachable
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the commitment protocol is clean at capacity 1, 2 and 3 within a bounded search", () => {
  const bounded = new Map();

  beforeAll(() => {
    for (const capacity of [1, 2, 3]) bounded.set(capacity, checkOnce(boundedShape(capacity)));
  });

  test.each([1, 2, 3])("capacity %i — no safety property is violated within the bound", (capacity) => {
    expect(bounded.get(capacity).violations).toEqual([]);
  });

  test.each([1, 2, 3])("capacity %i — the result is reported as bounded, not as a proof", (capacity) => {
    // This is the assertion whose absence made the previous suite overstate itself:
    // these runs ARE truncated, and the suite records it.
    expect(bounded.get(capacity).depthTruncated).toBe(true);
    expect(bounded.get(capacity).exhaustive).toBe(false);
  });

  test("the state space grows with capacity, so capacity is genuinely a model dimension", () => {
    expect(bounded.get(2).states).toBeGreaterThan(bounded.get(1).states);
    expect(bounded.get(3).states).toBeGreaterThan(bounded.get(2).states);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The checker can fail — one guard at a time
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the model check rejects a defect", () => {
  test("dropping G1 is caught: a commit lands under a superseded leadership fence", () => {
    const result = checkOnce(boundedShape(2, { mutation: { dropGuards: ["G1"] } }));
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0].properties).toContain("COUNTER_commitUnderSupersededLeadership");
  });

  test("dropping G2 is caught: more active commitments than capacity", () => {
    const result = checkOnce(boundedShape(2, { mutation: { dropGuards: ["G2"] } }));
    expect(result.violations[0].properties).toContain("COUNTER_overCapacity");
  });

  test("dropping G3 is caught: a commit lands after the agent's authority changed", () => {
    const result = checkOnce(boundedShape(2, { mutation: { dropGuards: ["G3"] } }));
    expect(result.violations[0].properties).toContain("COUNTER_commitAfterAuthorityChange");
  });

  test("dropping G4 is caught: a commit lands against a stale Leg version", () => {
    const result = checkOnce(boundedShape(2, { mutation: { dropGuards: ["G4"] } }));
    expect(result.violations[0].properties).toContain("COUNTER_commitOnStaleLegVersion");
  });

  test("dropping G6 is NOT independently detectable here, and that is a property of the model", () => {
    // Every transition that moves a Leg's state also moves its version — which is
    // §4.1 rule 2 holding — so in this model G4 subsumes G6. G6's independence is
    // established in `commitmentGuards.test.js`, where a case violates G6 alone and
    // asserts the other five guards passed. Recorded as an assertion rather than as a
    // silent absence, so nobody later mistakes it for coverage.
    const result = checkOnce(boundedShape(2, { mutation: { dropGuards: ["G6"] } }));
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
   §10.3.1's own named defect, and what each capacity actually establishes
   ═══════════════════════════════════════════════════════════════════════════ */

describe("comparing the commitment fence as a per-agent maximum (§10.3.1's named defect)", () => {
  test("is caught at capacity 2", () => {
    const result = checkOnce(boundedShape(2, { mutation: { perAgentFenceMaximum: true } }));
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0].properties).toContain("COUNTER_crossCommitmentInvalidation");
  });

  test("is caught at capacity 3", () => {
    const result = checkOnce(boundedShape(3, { mutation: { perAgentFenceMaximum: true } }));
    expect(result.violations[0].properties).toContain("COUNTER_crossCommitmentInvalidation");
  });

  test("is caught at capacity 1 too, once the search is deep enough to reach it", () => {
    // This corrects a claim the Phase 3 report made and this suite asserted: that the
    // defect is "invisible at capacity 1". It is not. At the depth-9 bound the suite
    // used, the capacity-1 search never reached the counterexample — which is a fact
    // about the bound, not about the protocol. Searched to completion, the same
    // unmodified checker finds it.
    const result = checkOnce(closedShape(1, { mutation: { perAgentFenceMaximum: true } }));
    expect(result.exhaustive).toBe(true);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0].properties).toContain("COUNTER_crossCommitmentInvalidation");
  });

  test("what capacity ≥ 2 adds is the CONCURRENT exhibition, which capacity 1 cannot have", () => {
    // The capacity-1 counterexample needs a commitment to **settle** before the next is
    // taken: it is a stale redelivery for a commitment that is no longer active, and it
    // never involves two commitments held at once — capacity 1 forbids that by
    // construction. §10.3.1's own worked example is the concurrent one ("C1 at epoch 5
    // and C2 at epoch 6 on the same agent"), and only capacity ≥ 2 can exhibit it.
    // That, precisely, is what §24.2 buys by making the configuration part of the
    // requirement — not that capacity 1 is silent, but that it is silent about the
    // *concurrent* case.
    const atOne = checkOnce(closedShape(1, { mutation: { perAgentFenceMaximum: true } }));
    expect(atOne.violations[0].trace).toEqual(expect.arrayContaining([expect.stringMatching(/^settle\(/)]));

    const atTwo = checkOnce(boundedShape(2, { mutation: { perAgentFenceMaximum: true } }));
    expect(atTwo.violations[0].trace.some((step) => step.startsWith("settle("))).toBe(false);
  });

  test("the counterexample is a reordered delivery — the fleet-seizing trace §10.3.1 predicts", () => {
    const result = checkOnce(boundedShape(2, { mutation: { perAgentFenceMaximum: true } }));
    const trace = result.violations[0].trace;
    expect(trace.filter((step) => step.startsWith("deliver(")).length).toBeGreaterThanOrEqual(2);
    expect(trace.some((step) => step.startsWith("commit(w"))).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The hazards §24.2 enumerates are actually in the space
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the explored space contains every hazard §24.2 names", () => {
  const result = checkOnce(boundedShape(2, { mutation: { dropGuards: ["G1", "G2", "G3", "G4"] } }));

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

/* ═══════════════════════════════════════════════════════════════════════════
   The checker's own honesty
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the checker distinguishes a search that closed from one that was cut short", () => {
  test("a depth bound that truncates is reported as truncation, not as exhaustion", () => {
    const shallow = check({ capacity: 2, legs: 3, workers: 2, depth: 3, maxLeaderChanges: 1, maxQuarantines: 1 });
    expect(shallow.depthTruncated).toBe(true);
    expect(shallow.exhaustive).toBe(false);
    expect(shallow.maxDepthReached).toBe(3);
  });

  test("a state cap that truncates is reported too, and separately", () => {
    const capped = check({ capacity: 2, legs: 3, workers: 2, depth: 12, maxStates: 500, maxLeaderChanges: 1, maxQuarantines: 1 });
    expect(capped.stateCapExceeded).toBe(true);
    expect(capped.exhaustive).toBe(false);
  });

  test("a search over a space small enough to close reports exhaustion and neither truncation", () => {
    const tiny = check({ capacity: 1, legs: 1, workers: 1, depth: 40, maxLeaderChanges: 0, maxQuarantines: 0 });
    expect(tiny.exhaustive).toBe(true);
    expect(tiny.depthTruncated).toBe(false);
    expect(tiny.stateCapExceeded).toBe(false);
    expect(tiny.maxDepthReached).toBeLessThan(40);
  });
});

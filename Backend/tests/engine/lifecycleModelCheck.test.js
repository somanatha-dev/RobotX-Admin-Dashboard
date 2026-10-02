"use strict";

/**
 * §24.2 — the lifecycle, model-checked exhaustively at capacity 1, 2 and 3.
 *
 * > **Liveness:** every non-terminal state eventually leaves, given fair timer firing.
 * > **Liveness:** every queued mission is eventually assigned, escalated, or explicitly
 * > declined.
 * > **Safety:** no state is both terminal and modifiable.
 * > **Safety:** custody is never lost — every `HELD` transitions to `RELEASED` or
 * > `DISPUTED`.
 *
 * The checker is `helpers/lifecycleModel.js` and its transitions are **the shipped §4.4
 * table**: it iterates `transitions.EVENT`, asks `transitions.find()` what is enabled,
 * evaluates the shipped `GUARD_EVALUATORS`, and resolves the shipped `targetOf()`. A row
 * added to `lifecycle/transitions.js` is explored on the next run without this file
 * changing, and a guard whose logic is wrong produces a counterexample here.
 *
 * ──────────────────── What these runs establish, and what they do not (P15-E5)
 * **These searches are bounded, not exhaustive, at every capacity.** That sentence replaces
 * the one that stood here until the Phase 15 third-pass audit, which read *"Depth is chosen
 * per configuration to keep every run exhaustive within a test lane's budget — 12 / 9 / 7"*
 * and was asserted below as `expect(result.exhaustive).toBe(true)`.
 *
 * Both were false, and neither could fail. `lifecycleModel.check()` set its `exhaustive` flag
 * from the **state cap** alone; the depth bound — which every configuration here sets, and
 * which every one of them hits — did not move it. Measured on these exact shapes before the
 * correction:
 *
 * ```
 * capacity 1 (legs 2, depth 12)   1 350 nodes stopped at the bound,    26 876 successors unexplored
 * capacity 2 (legs 3, depth  9)  12 237 nodes stopped at the bound,   348 549 successors unexplored
 * capacity 3 (legs 4, depth  7)  37 880 nodes stopped at the bound, 1 389 004 successors unexplored
 * ```
 *
 * At capacity 3 the unexplored frontier was twenty times the explored state space, and the run
 * reported itself exhaustive. `commitmentModel.js` carried the identical defect and was
 * corrected during the Phase 3 re-verification; `formal/README.md` recorded that this module
 * still carried it and named Phase 15 as its owner.
 *
 * ──────────────────── Whether the search can be closed at all: measured, and it cannot
 * Raising the bound was tried rather than assumed. At capacity 1 — the smallest shape here —
 * the state count is still growing monotonically at depth 32 (5 750 → 90 867 states over
 * depths 12 → 32) with no sign of closure, at 30 s per run; capacity 2 reaches 333 366 states
 * at depth 15, still truncated, in 167 s. **No configuration of this checker closes within a
 * test lane's budget, and none closes within a workstation session.** So the honest assertion
 * is truncation, and that is what is asserted below — the precedent `commitmentModel`'s suite
 * set: *assert a closed search where one is affordable, and assert truncation where it is not.*
 *
 * ──────────────────── The consequence for the §24 gate, stated here because it belongs here
 * `cutover/gates.js`'s `model_check_capacity_1_2_3` is discharged by
 * `npm run test:engine -- ModelCheck` and states that the lifecycle is model-checked
 * **exhaustively** at capacity 1, 2 and 3. This suite exits 0 and cannot establish that, and
 * `lifecycle.tla` has never been run under TLC (`formal/README.md`). The gate's substance is
 * therefore **NOT PROVEN for the lifecycle at any capacity**, and what is missing is compute
 * for a completed model-checking run, not a different specification or more code. It is
 * recorded as a blocker rather than papered over here, and this suite now says in its
 * assertions exactly what it does and does not establish.
 *
 * ──────────────────── Depth is per capacity, and the reason is stated
 * The space grows by roughly 5x per capacity step; the depths — 12 / 9 / 7 — are what a test
 * lane can afford at each. The resulting state counts are asserted as lower bounds so that a
 * change which *shrinks* the explored space (an accidentally over-restrictive guard, say)
 * fails here instead of quietly passing faster.
 */

const legMachine = require("../../src/engine/lifecycle/legMachine");
const transitions = require("../../src/engine/lifecycle/transitions");
const model = require("./helpers/lifecycleModel");

/** Capacity, Leg count, search depth, and the floor on states the run must reach. */
const CONFIGURATIONS = [
  { capacity: 1, legs: 2, depth: 12, minStates: 5000 },
  { capacity: 2, legs: 3, depth: 9, minStates: 25000 },
  { capacity: 3, legs: 4, depth: 7, minStates: 60000 },
];

// The runs at capacity 2 and 3 explore hundreds of thousands of states. The lane's default
// 10 s timeout is for unit tests; this is a model check, and giving it its own budget is
// what stops someone "fixing" a timeout by shrinking the search.
jest.setTimeout(240000);

describe("§24.2 — the lifecycle is model-checked at capacity 1, 2 and 3", () => {
  const results = new Map();

  test.each(CONFIGURATIONS)(
    "capacity $capacity: every safety property holds over the bounded search",
    ({ capacity, legs, depth, minStates }) => {
      const result = model.check({ capacity, legs, depth });
      results.set(capacity, result);

      // What this run is: a search to `depth` actions with no violation found. Asserted as
      // truncation rather than as exhaustion, because that is the fact — see the header. If a
      // future change ever closes one of these searches this assertion FAILS, which is the
      // right direction: a closed search is a stronger result and must be re-declared
      // deliberately rather than absorbed silently.
      expect({ capacity, depthTruncated: result.depthTruncated }).toEqual({ capacity, depthTruncated: true });
      // The state cap is a different bound and must not be the one that intervened: hitting it
      // would mean the depth figure below is describing a search that stopped earlier.
      expect({ capacity, stateCapExceeded: result.stateCapExceeded }).toEqual({ capacity, stateCapExceeded: false });
      expect({ capacity, exhaustive: result.exhaustive }).toEqual({ capacity, exhaustive: false });
      expect(result.maxDepthReached).toBe(depth);
      expect(result.states).toBeGreaterThan(minStates);

      // The counterexample, not just the count: a failure here must be diagnosable from
      // the test output alone, because the state space is far too large to re-explore by
      // hand.
      expect(result.violations.map((violation) => ({ properties: violation.properties, trace: violation.trace }))).toEqual([]);
    },
  );

  test("the space genuinely grows with capacity — a check at 1 does not stand in for 3", () => {
    // §24.2's own argument, applied to the lifecycle: "the configuration under check is
    // itself part of the requirement". If the three runs explored comparable spaces, the
    // extra capacity would not be exercising anything and the three-way check would be
    // decoration.
    expect(results.get(2).states).toBeGreaterThan(results.get(1).states * 4);
    expect(results.get(3).states).toBeGreaterThan(results.get(2).states * 2);
  });

  test("the completeness flags can each fail, and are not all the same flag (P15-E5)", () => {
    // The defect this suite carried was a flag that could not move. Three shapes, each
    // stopped by a different bound, so `exhaustive` is shown to be derived from both of the
    // others rather than from one of them.
    const truncated = model.check({ capacity: 1, legs: 2, depth: 3 });
    expect(truncated.depthTruncated).toBe(true);
    expect(truncated.stateCapExceeded).toBe(false);
    expect(truncated.exhaustive).toBe(false);

    const capped = model.check({ capacity: 1, legs: 2, depth: 12, maxStates: 200 });
    expect(capped.stateCapExceeded).toBe(true);
    expect(capped.exhaustive).toBe(false);

    // A shape whose frontier genuinely empties — the flag is reachable, so asserting
    // `false` above is a measurement and not a tautology.
    //
    // This assertion is only satisfiable at all because `MAX_VERSION` bounds the Leg
    // version counter (P15-E5). Without it `leg.version` grew without limit inside the
    // state key, the space was infinite, and NO shape of this checker could ever close:
    // one Leg at capacity 1 reached 13 354 states at depth 640, still growing linearly.
    // With the bound the same shape closes at depth 40 with 166 states.
    const closed = model.check({ capacity: 1, legs: 1, depth: 40 });
    expect(closed.depthTruncated).toBe(false);
    expect(closed.stateCapExceeded).toBe(false);
    expect(closed.exhaustive).toBe(true);
    expect(closed.violations).toEqual([]);
  });

  test("the version bound loses no behaviour: it never makes a guard fail (P15-E5)", () => {
    // The bound is sound because `leg.version` is handed to the shipped guard as the
    // *current* value, so the CAS always matches and the counter can never decide a
    // transition. If that ever stops being true, collapsing states that differ only in it
    // stops being an abstraction and starts being a hole — so it is pinned rather than
    // left in a comment. A search that saturates the bound must still find no violation.
    const saturated = model.check({ capacity: 1, legs: 2, depth: 45 });
    expect(saturated.violations).toEqual([]);
    // And the shipped depths do not reach the bound at all, so today's numbers are the
    // same numbers with and without it.
    //
    // 5 712, was 5 750 until the F-1 fix (2026-10-02). The 38 states that left are exactly
    // the ones in which a Leg whose custody is RELEASED sits in REASSIGNING — a delivered Leg
    // being reassigned — reached by LEASE_EXPIRY from RELEASED, which now stays in RELEASED.
    // Measured by diffing the visited sets before and after: the new set is a strict subset,
    // with no state added and every removed state of that one shape.
    const shipped = model.check({ capacity: 1, legs: 2, depth: 12 });
    expect(shipped.states).toBe(5712);
  });

  test("no exhaustive lifecycle model check exists at any shipped capacity — pinned, not implied", () => {
    // The §24 gate `model_check_capacity_1_2_3` states that the lifecycle is checked
    // *exhaustively* at capacity 1, 2 and 3. It is not, by either checker: this one is
    // truncated at all three shapes, and `lifecycle.tla` has never been run under TLC.
    // Pinned here so the gap lives in the repository rather than only in a closure document.
    for (const { capacity } of CONFIGURATIONS) {
      expect({ capacity, exhaustive: results.get(capacity).exhaustive }).toEqual({ capacity, exhaustive: false });
    }
  });
});

describe("§4.3 — the stranding classification, checked as a total function", () => {
  test("every obstruction class resolves, and INDETERMINATE resolves to the more serious state", () => {
    expect(model.checkStrandingResolution()).toEqual([]);
  });

  test("an unknown class from the Map service resolves to STRANDED_OBSTRUCTING (§7.3 DENY)", () => {
    // Not a hypothetical input: §5.2 makes the Map service a degradable dependency, and a
    // degraded one returns something the register does not contain. §4.3: "an unknown
    // stopping location is treated as the more serious case, because the cost of
    // over-escalating a safe stranding is an unnecessary callout and the cost of
    // under-escalating an obstructing one is an incident."
    const disposition = legMachine.strandingStateFor(undefined);
    expect(disposition.state).toBe("STRANDED_OBSTRUCTING");
    expect(disposition.obstructionClass).toBe("INDETERMINATE");
    expect(disposition.externalEscalation).toBe(true);
  });
});

describe("§12.1 — no reachable non-terminal state is a dead end", () => {
  test("every non-terminal Leg state has at least one enabled event in the shipped table", () => {
    // The property whose failure §12.1 names as the characteristic defect: "no component
    // is responsible for noticing that a state has stopped progressing." A state with no
    // outgoing transition is that failure expressed in the table itself, where no
    // reconciler can repair it.
    const stuck = [];
    for (const state of Object.values(legMachine.LEG_STATE)) {
      if (legMachine.isTerminal(state)) continue;
      const enabled = Object.values(transitions.EVENT).filter((event) => transitions.find(state, event));
      if (enabled.length === 0) stuck.push(state);
    }
    expect(stuck).toEqual([]);
  });
});

describe("what the exhaustive search reaches, recorded rather than assumed", () => {
  test("the capacity-1 run reaches every state the shipped table can produce", () => {
    const result = model.check({ capacity: 1, legs: 2, depth: 12 });

    // Reached: the whole nominal path, both stranding states, recovery, and reassignment.
    for (const state of [
      "QUEUED", "DEFERRED", "PLANNED", "OFFERED", "ACCEPTED",
      "EN_ROUTE_PICKUP", "AT_PICKUP", "LOADED", "EN_ROUTE_DROP", "AT_DROP",
      "RELEASED", "SETTLED", "ABORTING", "REASSIGNING",
      "STRANDED_SAFE", "STRANDED_OBSTRUCTING", "FAILED",
    ]) {
      expect({ state, reached: result.reachedStates.has(state) }).toEqual({ state, reached: true });
    }

    // NOT reached, and this is a fact about the shipped §4.4 table rather than about the
    // search. §4.3 lists `CANCELLED` and `WITHDRAWN` as Leg states, and the table has no
    // row whose target is either:
    //
    //   - `CANCEL_REQUEST` targets `ABORTING`, never `CANCELLED`. That is §4.6 rule 2
    //     working as specified — a cancellation is a request to unwind, and unwinding is
    //     what `ABORTING` is — but it means `CANCELLED` is reachable only through whatever
    //     terminates the abort, which the table renders as `FAILED`.
    //   - `WITHDRAWN` has no incoming row at all. §4.3 calls it "terminal for that
    //     pairing", and the table models a withdrawn offer as the Leg returning to
    //     `QUEUED` (`OFFER_TTL_EXPIRY`, `AGENT_NACK`) — which is the Leg's view of the
    //     same event, the pairing having no row of its own.
    //
    // Recorded here rather than asserted as a defect: both readings are defensible against
    // §4.4, resolving which is intended is an architecture question, and the architecture
    // is frozen. What must not happen is for the gap to be invisible.
    for (const state of ["CANCELLED", "WITHDRAWN"]) {
      expect({ state, reached: result.reachedStates.has(state) }).toEqual({ state, reached: false });
    }
  });
});

describe("the checker is proven able to fail", () => {
  test("a planted custody loss is caught by name", () => {
    // A gate proven only able to pass is not a gate. This plants the exact defect §24.2's
    // custody property exists to catch — a Leg that carried goods reaching a terminal
    // state with custody recorded as NONE — and asserts the checker names it.
    const state = {
      legs: [
        { id: "leg-1", state: "SETTLED", custodyState: "NONE", committed: false, version: 3, everHeld: true },
      ],
      task: "COMPLETED",
      fence: 1,
    };
    expect(model.checkInvariants(state, { capacity: 1 })).toContain("S5_CUSTODY_LOST_leg-1");
  });

  test("a planted over-capacity state is caught by name", () => {
    const state = {
      legs: [
        { id: "leg-1", state: "ACCEPTED", custodyState: "NONE", committed: true, version: 1, everHeld: false },
        { id: "leg-2", state: "ACCEPTED", custodyState: "NONE", committed: true, version: 1, everHeld: false },
      ],
      task: "IN_EXECUTION",
      fence: 2,
    };
    expect(model.checkInvariants(state, { capacity: 1 })).toContain("S1_AT_MOST_CAPACITY");
  });

  test("a planted terminal-but-committed state is caught by name", () => {
    // §4.1 rule 1's consequence. A settled Leg that still counted against capacity would
    // silently shrink the agent's usable capacity for the rest of its life.
    const state = {
      legs: [{ id: "leg-1", state: "SETTLED", custodyState: "RELEASED", committed: true, version: 5, everHeld: true }],
      task: "COMPLETED",
      fence: 1,
    };
    expect(model.checkInvariants(state, { capacity: 2 })).toContain("S2_TERMINAL_STILL_COMMITTED_leg-1");
  });

  test("a planted custodial cancellation is caught by name (§4.6 rule 2)", () => {
    const state = {
      legs: [{ id: "leg-1", state: "CANCELLED", custodyState: "HELD", committed: false, version: 4, everHeld: true }],
      task: "CANCELLED",
      fence: 1,
    };
    const broken = model.checkInvariants(state, { capacity: 1 });
    expect(broken).toContain("S3_CUSTODY_CANCELLED_leg-1");
    expect(broken).toContain("S4_CUSTODY_WITHOUT_BEARING_STATE_leg-1");
  });
});

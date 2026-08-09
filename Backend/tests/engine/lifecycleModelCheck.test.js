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
 * ── Why each run asserts exhaustion ─────────────────────────────────────────
 * A bounded search that hit its bound has explored a prefix of the state space and proved
 * nothing about the rest. `check()` reports `exhaustive`, and every assertion below
 * demands it, so a future change that grows the space announces itself as a failed
 * exhaustion rather than as a quietly weaker check.
 *
 * ── Depth is per capacity, and the reason is stated ────────────────────────
 * The space grows by roughly 5x per capacity step. Depth is chosen per configuration to
 * keep every run **exhaustive** within a test lane's budget — 12 / 9 / 7 — because an
 * exhaustive search of a smaller space is worth more than a truncated search of a larger
 * one. The resulting state counts are asserted as lower bounds so that a change which
 * *shrinks* the explored space (an accidentally over-restrictive guard, say) fails here
 * instead of quietly passing faster.
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
    "capacity $capacity: the search is exhaustive and every safety property holds",
    ({ capacity, legs, depth, minStates }) => {
      const result = model.check({ capacity, legs, depth });
      results.set(capacity, result);

      // A truncated search is not a proof.
      expect({ capacity, exhaustive: result.exhaustive }).toEqual({ capacity, exhaustive: true });
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

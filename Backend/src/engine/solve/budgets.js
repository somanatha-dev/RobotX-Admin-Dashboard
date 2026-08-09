"use strict";

/**
 * Solve size control (§9.4) — **Tier 1**, decision path.
 *
 * > | Bound | Parameter | Default | Behaviour on exceed |
 * > | Legs per round | `solve.max_legs_per_round` | 500 | Spatially partition the batch and solve sub-problems independently |
 * > | Candidates per Leg | `candidate.max_evaluated` | 200 | Truncate by lower bound; record the search gap in CU (§6.4) |
 * > | Columns per round | `plan.max_columns_per_round` | 2 000 | Keep the cheapest by bound; record the best pruned column's bound (§9.3) |
 * > | Branch-and-bound nodes | `solve.branch_node_budget` | 5 000 | Return the incumbent with its LP bound; record the residual LP–IP gap in CU |
 * > | Wall-clock budget | `solve.time_budget` | 250 ms | Return the best feasible solution found; record as budget-limited |
 *
 * ── Anytime is the property, and it is why this module is stateful ──────────
 * > The solver MUST be an **anytime** algorithm: at any point it holds a feasible
 * > solution and a bound. **Exceeding the time budget returns the incumbent with its
 * > bound, never nothing and never a hang.** This is the general answer to the audit's
 * > finding that the baseline has no timeout anywhere in its assignment path — including
 * > no timeout on outbound HTTP calls — so a single hung connection stalls a task's
 * > assignment indefinitely while holding its lock.
 *
 * A tracker created by `create()` therefore carries the **incumbent** alongside the
 * counters. `offer()` records a feasible solution and its bound as they are found;
 * `result()` returns whatever the incumbent is at the moment it is asked, together with
 * which bound bound. There is no path through this module that returns "nothing": the
 * incumbent starts as the empty allocation, which is feasible by construction (every Leg
 * simply remains queued) and whose bound is known.
 *
 * ── The four counters and the clock are not the same kind of bound ──────────
 * Four of §9.4's five bounds are *counted* and are exceeded deterministically — the same
 * inputs exceed them at the same point on every run, which is what keeps a
 * budget-truncated round replayable (§9.6). The wall-clock budget is not: it depends on
 * the machine. That asymmetry is recorded rather than smoothed over, because it is the
 * one place where §9.6's byte-for-byte replay requirement and §9.4's anytime requirement
 * genuinely trade against each other:
 *
 *   - A replay MUST reproduce the original round's *decision*, so `create()` accepts a
 *     `replayOf` clause that pins the wall-clock outcome from the recorded round instead
 *     of re-measuring it. A replay that re-raced the clock would produce a different
 *     truncation point on a faster machine and fail its own equivalence test for a
 *     reason that has nothing to do with the decision logic.
 *   - Production rounds measure. `elapsedMs` is an **injected function**, never a clock
 *     literal, so this module's source carries nothing `guards/tenets.js`'s T6 scan would
 *     flag and the read happens in the coordinator, outside the decision path.
 *
 * ── Exceeding a bound is an outcome, not an error ───────────────────────────
 * Every `exceeded` verdict carries the §9.4 behaviour the caller owes: partition,
 * truncate-and-record, keep-cheapest-and-record, return-incumbent-and-record. The caller
 * performs it; this module names it, so the behaviours cannot drift apart across the four
 * call sites that implement them.
 */

/** §9.4's five bounds, by the parameter that sets each. @structural the specification's own bound names */
const BOUND = Object.freeze({
  LEGS_PER_ROUND: "solve.max_legs_per_round",
  CANDIDATES_PER_LEG: "candidate.max_evaluated",
  COLUMNS_PER_ROUND: "plan.max_columns_per_round",
  BRANCH_NODES: "solve.branch_node_budget",
  WALL_CLOCK: "solve.time_budget",
});

/** The §9.4 behaviour each bound obliges on exceed. @structural the specification's own remedy column */
const ON_EXCEED = Object.freeze({
  [BOUND.LEGS_PER_ROUND]: "Spatially partition the batch and solve sub-problems independently",
  [BOUND.CANDIDATES_PER_LEG]: "Truncate by lower bound; record the search gap in CU (§6.4)",
  [BOUND.COLUMNS_PER_ROUND]: "Keep the cheapest by bound; record the best pruned column's bound (§9.3)",
  [BOUND.BRANCH_NODES]: "Return the incumbent with its LP bound; record the residual LP–IP gap in CU",
  [BOUND.WALL_CLOCK]: "Return the best feasible solution found; record as budget-limited",
});

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The empty allocation: no Leg assigned, every Leg still queued.
 *
 * This is the incumbent a round starts from, and it is why "never nothing" is achievable
 * rather than aspirational. It is feasible by construction — the coverage constraint
 * (§1.4) is satisfied by the deferral variable for every Leg, and where deferral is
 * disabled by kill switch the Legs simply remain in the queue for the next round, which
 * is the same physical outcome without the priced arc.
 *
 * @returns {object}
 */
function emptyIncumbent() {
  return Object.freeze({
    assignments: Object.freeze([]),
    objectiveMilliCU: null,
    boundMilliCU: null,
    source: "EMPTY",
    note:
      "no Leg assigned. Feasible by construction: every Leg remains queued and is solved by the next round. " +
      "§9.4 requires the solver to hold a feasible solution at every instant, and this is the one it holds " +
      "before it has found a better one.",
  });
}

/**
 * Create a budget tracker for one round.
 *
 * @param {object} input
 * @param {object} input.config `{ maxLegsPerRound, maxEvaluatedPerLeg, maxColumnsPerRound,
 *   branchNodeBudget, timeBudgetMs }`
 * @param {() => number} [input.elapsedMs] injected; returns milliseconds since round start
 * @param {object} [input.replayOf] `{ wallClockExceeded, elapsedAtStopMs }` — a recorded
 *   round's wall-clock outcome, pinned so the replay truncates where the original did
 * @returns {object} the tracker
 */
function create(input) {
  const source = input || {};
  const config = source.config || {};
  const replayOf = source.replayOf || null;

  const counters = {
    legs: 0,
    candidatesByLeg: new Map(),
    columns: 0,
    branchNodes: 0,
  };

  /** Every bound that was hit, in the order it was hit. */
  const exceeded = [];
  let incumbent = emptyIncumbent();

  /**
   * @param {string} bound
   * @param {object} detail
   * @returns {object}
   */
  function record(bound, detail) {
    const entry = Object.freeze({
      bound,
      behaviour: ON_EXCEED[bound],
      ...detail,
    });
    if (!exceeded.some((row) => row.bound === bound)) exceeded.push(entry);
    return entry;
  }

  /**
   * Has the wall-clock budget been exhausted?
   *
   * On a replay this reads the pinned outcome and never the clock, which is what keeps a
   * budget-limited round reproducible byte-for-byte on a machine of a different speed.
   *
   * @returns {{ exceeded: boolean, elapsedMs: number|null, replayed: boolean }}
   */
  function wallClock() {
    if (replayOf) {
      return {
        exceeded: replayOf.wallClockExceeded === true,
        elapsedMs: isNumber(replayOf.elapsedAtStopMs) ? replayOf.elapsedAtStopMs : null,
        replayed: true,
      };
    }
    if (typeof source.elapsedMs !== "function" || !isNumber(config.timeBudgetMs)) {
      return { exceeded: false, elapsedMs: null, replayed: false };
    }
    const elapsed = source.elapsedMs();
    return { exceeded: elapsed >= config.timeBudgetMs, elapsedMs: elapsed, replayed: false };
  }

  /**
   * May the round admit another Leg to this batch?
   *
   * @param {number} [count] how many are already admitted; defaults to the tracker's own
   * @returns {{ ok: boolean, verdict: object|null }}
   */
  function admitLeg(count) {
    const admitted = isNumber(count) ? count : counters.legs;
    if (isNumber(config.maxLegsPerRound) && admitted >= config.maxLegsPerRound) {
      return {
        ok: false,
        verdict: record(BOUND.LEGS_PER_ROUND, { limit: config.maxLegsPerRound, observed: admitted }),
      };
    }
    counters.legs = admitted + 1;
    return { ok: true, verdict: null };
  }

  /**
   * May another candidate be evaluated for this Leg?
   *
   * @param {string} legId
   * @returns {{ ok: boolean, verdict: object|null }}
   */
  function evaluateCandidate(legId) {
    const key = String(legId);
    const already = counters.candidatesByLeg.get(key) || 0;
    if (isNumber(config.maxEvaluatedPerLeg) && already >= config.maxEvaluatedPerLeg) {
      return {
        ok: false,
        verdict: record(BOUND.CANDIDATES_PER_LEG, { limit: config.maxEvaluatedPerLeg, observed: already, legId: key }),
      };
    }
    counters.candidatesByLeg.set(key, already + 1);
    return { ok: true, verdict: null };
  }

  /**
   * Record the column set's size against `plan.max_columns_per_round`.
   *
   * The truncation itself is `plan/columnBuilder.js`'s (Phase 8), which keeps the
   * cheapest by bound and records the best pruned column's bound. This registers the
   * exceedance so the round's own budget report names it alongside the other four.
   *
   * @param {number} generated
   * @param {number} kept
   * @param {bigint|null} bestPrunedGammaMilliCU
   * @returns {{ ok: boolean, verdict: object|null }}
   */
  function admitColumns(generated, kept, bestPrunedGammaMilliCU) {
    counters.columns = kept;
    if (isNumber(config.maxColumnsPerRound) && generated > config.maxColumnsPerRound) {
      return {
        ok: false,
        verdict: record(BOUND.COLUMNS_PER_ROUND, {
          limit: config.maxColumnsPerRound,
          observed: generated,
          kept,
          bestPrunedGammaMilliCU: bestPrunedGammaMilliCU === null || bestPrunedGammaMilliCU === undefined ? null : String(bestPrunedGammaMilliCU),
        }),
      };
    }
    return { ok: true, verdict: null };
  }

  /**
   * May branch-and-bound explore another node?
   *
   * > The branch-and-bound budget applies **only in the column regime**; the singleton
   * > regime is integral and never branches (§9.3).
   *
   * A singleton-regime round therefore never calls this, and a round that did would be
   * evidence of a regime misclassification rather than of a budget shortage — which is
   * why the counter is reported even when it is zero.
   *
   * @returns {{ ok: boolean, verdict: object|null }}
   */
  function branchNode() {
    if (isNumber(config.branchNodeBudget) && counters.branchNodes >= config.branchNodeBudget) {
      return {
        ok: false,
        verdict: record(BOUND.BRANCH_NODES, { limit: config.branchNodeBudget, observed: counters.branchNodes }),
      };
    }
    counters.branchNodes += 1;
    return { ok: true, verdict: null };
  }

  /**
   * May the solve continue, or has the wall clock run out?
   *
   * @returns {{ ok: boolean, verdict: object|null }}
   */
  function continueSolving() {
    const clock = wallClock();
    if (clock.exceeded) {
      return {
        ok: false,
        verdict: record(BOUND.WALL_CLOCK, {
          limit: config.timeBudgetMs,
          observed: clock.elapsedMs,
          replayed: clock.replayed,
        }),
      };
    }
    return { ok: true, verdict: null };
  }

  /**
   * Offer a feasible solution as the new incumbent. Accepted only when it improves the
   * objective, so the incumbent is monotone and `result()` can never return a solution
   * worse than one already found.
   *
   * @param {object} solution `{ assignments, objectiveMilliCU, boundMilliCU, source }` —
   *   a candidate *solution*, meaning an allocation, not a candidate pairing in §6's
   *   sense. This module never sees a pairing and never prices one.
   * @returns {{ accepted: boolean, incumbent: object }}
   */
  function offer(solution) {
    const entry = solution || {};
    if (typeof entry.objectiveMilliCU !== "bigint") return { accepted: false, incumbent };
    if (incumbent.objectiveMilliCU !== null && entry.objectiveMilliCU >= incumbent.objectiveMilliCU) {
      return { accepted: false, incumbent };
    }
    incumbent = Object.freeze({
      assignments: Object.freeze([...(entry.assignments || [])]),
      objectiveMilliCU: entry.objectiveMilliCU,
      boundMilliCU: typeof entry.boundMilliCU === "bigint" ? entry.boundMilliCU : null,
      source: entry.source || "SOLVER",
      note: null,
    });
    return { accepted: true, incumbent };
  }

  /**
   * The anytime answer: whatever is held right now, with what bound it, and its bound.
   *
   * @returns {object}
   */
  function result() {
    const clock = wallClock();
    return Object.freeze({
      incumbent,
      budgetLimited: exceeded.length > 0,
      exceeded: Object.freeze([...exceeded]),
      counters: Object.freeze({
        legs: counters.legs,
        columns: counters.columns,
        branchNodes: counters.branchNodes,
        maxCandidatesForAnyLeg: counters.candidatesByLeg.size === 0 ? 0 : Math.max(...counters.candidatesByLeg.values()),
        legsAtCandidateCap: [...counters.candidatesByLeg.entries()]
          .filter(([, count]) => isNumber(config.maxEvaluatedPerLeg) && count >= config.maxEvaluatedPerLeg)
          .map(([legId]) => legId)
          .sort(),
      }),
      wallClock: Object.freeze({
        budgetMs: isNumber(config.timeBudgetMs) ? config.timeBudgetMs : null,
        elapsedMs: clock.elapsedMs,
        exceeded: clock.exceeded,
        replayed: clock.replayed,
      }),
      // §9.4's own words for what the caller now owes, per bound that was hit. Named
      // here so the four call sites that implement the four behaviours cannot drift.
      obligations: Object.freeze(exceeded.map((row) => Object.freeze({ bound: row.bound, behaviour: row.behaviour }))),
    });
  }

  return Object.freeze({
    BOUND,
    admitLeg,
    evaluateCandidate,
    admitColumns,
    branchNode,
    continueSolving,
    offer,
    result,
    wallClock,
  });
}

/**
 * Prove the anytime property of a result (§9.4), as an assertion a test can make against
 * the object rather than against the solver's intentions.
 *
 * The property is exactly: *a result always carries a feasible solution and a bound;
 * exceeding a budget never yields nothing and never yields an error*. So the check is
 * that `incumbent` is present and that a budget-limited result still carries one.
 *
 * @param {object} result from a tracker's `result()`
 * @returns {{ ok: boolean, problems: string[] }}
 */
function assertAnytime(result) {
  const problems = [];

  if (!result || !result.incumbent) {
    problems.push(
      "the result carries no incumbent. §9.4: the solver 'MUST be an anytime algorithm: at any point it holds a " +
        "feasible solution and a bound. Exceeding the time budget returns the incumbent with its bound, never " +
        "nothing and never a hang.'",
    );
    return { ok: false, problems };
  }

  if (!Array.isArray(result.incumbent.assignments)) {
    problems.push("the incumbent does not carry an allocation, so there is nothing for the round to commit or to record");
  }

  if (result.budgetLimited === true && result.obligations.length === 0) {
    problems.push(
      "the result is budget-limited but names no obligation. Every §9.4 bound states what the caller owes on " +
        "exceed, and a truncation whose remedy is unnamed is a truncation nobody performs.",
    );
  }

  return { ok: problems.length === 0, problems };
}

module.exports = {
  BOUND,
  ON_EXCEED,
  emptyIncumbent,
  create,
  assertAnytime,
};

"use strict";

/**
 * Round cadence (§9.2) — **Tier 1**, decision path.
 *
 * > | Regime | Trigger | Window | Rationale |
 * > | Fast path | Mission with `sla_class ∈ solve.fast_path_classes`, or queue depth 1
 * >   with idle supply | Immediate, single-mission greedy |
 * > | Nominal | Steady arrivals | `solve.window_min` (default 500 ms) |
 * > | Loaded | Queue depth > `solve.batch_growth_threshold` | Grows to
 * >   `solve.window_max` (default 3 s) |
 * > | Saturated | Feasible supply ≈ 0 | `solve.saturated_window` (default 10 s) |
 *
 * ── "Immediate, single-mission greedy" is not a second implementation ───────
 * §9.2 is emphatic, and the emphasis is the point:
 *
 * > **The fast path is the batch path invoked with a batch of one Leg** — not a parallel
 * > implementation that shares some code, but literally the same round executed over
 * > `|L| = 1`. … The two paths therefore cannot disagree about feasibility, cost, or
 * > optimality reporting, because there is only one path — which is a stronger property
 * > than an asserted intention to keep two implementations aligned, and it is the
 * > property that is enforceable by a build-time test rather than by review discipline.
 *
 * So this module's fast-path verdict is a **window of zero milliseconds and a batch cap
 * of one**, and nothing else. It selects no solver, no code path, and no shortcut. The
 * word "greedy" in §9.2's table describes the *outcome* of solving one Leg against its
 * candidates — which is what a min-cost flow on a 1×k network computes — not a distinct
 * algorithm. `solve/round.js` receives the cap and runs the same pipeline.
 *
 * ── Two bounds the table does not state, and why both are here ──────────────
 * §9.2 adds two requirements in prose that its table does not carry:
 *
 *   1. > The window MUST additionally close early when supply changes materially — an
 *      > agent becoming available is new information worth acting on.
 *
 *      `shouldCloseEarly()`. Note that it closes the window early; it does not shorten
 *      the *configured* window, because the next round's window is decided by the same
 *      table against the state that then obtains.
 *
 *   2. > and MUST be bounded so that the window can never consume a meaningful fraction
 *      > of any mission's SLA budget.
 *
 *      `boundBySlaBudget()`, against `solve.max_window_sla_fraction` of
 *      `sla.assignment_deadline`. This bound is applied **after** the regime's window is
 *      chosen and takes the minimum, so a saturated shard still cannot make an express
 *      Leg wait ten seconds for a round that was never going to find it an agent. The
 *      bound is over *every* Leg in the batch, not the average: one urgent Leg is enough
 *      to shorten the window for all of them, which is the conservative direction and the
 *      only one consistent with "any mission's SLA budget".
 *
 * ── Saturation is `supply = 0`, read literally ──────────────────────────────
 * §9.2 writes "Feasible supply ≈ 0". This module reads that as *zero*, not as a tunable
 * near-zero threshold, deliberately: a threshold would need a registered parameter the
 * specification does not name, and the conservative direction — backing off only when
 * there is genuinely nothing to solve against — cannot delay work that could have been
 * assigned. A shard with one available agent runs a nominal round and either uses it or
 * does not.
 *
 * Determinism (T6): no clock. `windowFor()` is a pure function of the queue state, the
 * supply count, and the config snapshot; `shouldCloseEarly()` takes both instants as
 * arguments.
 */

/** §9.2's four cadence regimes. @structural the specification's own regime names */
const CADENCE = Object.freeze({
  FAST_PATH: "FAST_PATH",
  NOMINAL: "NOMINAL",
  LOADED: "LOADED",
  SATURATED: "SATURATED",
});

/** Why a window closed before it elapsed. @structural early-close reason labels */
const EARLY_CLOSE = Object.freeze({
  SUPPLY_CHANGED: "MATERIAL_SUPPLY_CHANGE",
  BATCH_FULL: "MAX_LEGS_PER_ROUND_REACHED",
  NOT_YET: null,
});

/** @structural milliseconds per second — a unit conversion, not a threshold */
const MS_PER_SECOND = 1000;

/**
 * §9.2's fast path is a batch of exactly one Leg.
 * @structural the batch size §9.2 defines the fast path as
 */
const FAST_PATH_BATCH_SIZE = 1;

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * §9.2's second prose requirement: the window may never consume a meaningful fraction of
 * any mission's SLA budget.
 *
 * @param {object} input
 * @param {number} input.windowMs the regime's chosen window
 * @param {number[]} [input.slaBudgetsSeconds] `sla.assignment_deadline` for every SLA
 *   class present in the batch
 * @param {number} [input.maxWindowSlaFraction] `solve.max_window_sla_fraction`
 * @returns {{ windowMs: number, bound: boolean, boundBy: number|null }}
 */
function boundBySlaBudget(input) {
  const source = input || {};
  const budgets = (source.slaBudgetsSeconds || []).filter((value) => isNumber(value) && value > 0);

  if (budgets.length === 0 || !isNumber(source.maxWindowSlaFraction)) {
    return { windowMs: source.windowMs, bound: false, boundBy: null };
  }

  // The *tightest* budget in the batch binds. "Any mission's SLA budget" admits no
  // averaging: a batch containing one express Leg and ninety-nine bulk ones is bounded
  // by the express one, which is the conservative direction and the only reading under
  // which the sentence is a guarantee rather than a tendency.
  const tightest = Math.min(...budgets);
  const ceilingMs = tightest * MS_PER_SECOND * source.maxWindowSlaFraction;

  if (source.windowMs <= ceilingMs) return { windowMs: source.windowMs, bound: false, boundBy: null };
  return { windowMs: Math.floor(ceilingMs), bound: true, boundBy: tightest };
}

/**
 * Choose this round's cadence regime and window.
 *
 * @param {object} input
 * @param {number} input.queueDepth Legs waiting in this shard
 * @param {number} input.feasibleSupply agents currently available to this shard
 * @param {string[]} [input.slaClassesWaiting] the SLA classes present in the queue
 * @param {number[]} [input.slaBudgetsSeconds] their `sla.assignment_deadline` values
 * @param {object} input.config resolved parameters: `windowMinMs`, `windowMaxMs`,
 *   `saturatedWindowMs`, `batchGrowthThreshold`, `fastPathClasses`, `maxLegsPerRound`,
 *   `maxWindowSlaFraction`
 * @returns {object} `{ regime, windowMs, maxLegsThisRound, rationale, slaBound }`
 */
function windowFor(input) {
  const source = input || {};
  const config = source.config || {};
  const queueDepth = isNumber(source.queueDepth) ? source.queueDepth : 0;
  const feasibleSupply = isNumber(source.feasibleSupply) ? source.feasibleSupply : 0;
  const waiting = source.slaClassesWaiting || [];
  const fastPathClasses = config.fastPathClasses || [];

  const fastPathClassPresent = waiting.some((slaClass) => fastPathClasses.includes(String(slaClass)));
  // §9.2's second fast-path trigger: "queue depth 1 with idle supply" — batching buys
  // nothing when there is nothing to trade against.
  const nothingToTradeAgainst = queueDepth === FAST_PATH_BATCH_SIZE && feasibleSupply > 0;

  const decide = () => {
    if (feasibleSupply <= 0) {
      return {
        regime: CADENCE.SATURATED,
        windowMs: config.saturatedWindowMs,
        maxLegsThisRound: config.maxLegsPerRound,
        rationale:
          "feasible supply is zero. Solving repeatedly against no supply is wasted work; back off and let " +
          "supply accumulate (§9.2). Queued work is not lost — it is solved by the first round with supply.",
      };
    }
    if (fastPathClassPresent || nothingToTradeAgainst) {
      return {
        regime: CADENCE.FAST_PATH,
        // Zero, not "immediate as a special code path". The round runs now, over one
        // Leg, through the same pipeline every other round uses.
        windowMs: 0,
        maxLegsThisRound: FAST_PATH_BATCH_SIZE,
        rationale: fastPathClassPresent
          ? "a mission of a solve.fast_path_classes class is waiting: for a genuinely urgent mission, batching " +
            "buys nothing (§9.2). This is the batch path at |L| = 1, not a separate implementation."
          : "queue depth is one with idle supply: there is nothing to trade against, so batching buys nothing " +
            "(§9.2). This is the batch path at |L| = 1, not a separate implementation.",
      };
    }
    if (isNumber(config.batchGrowthThreshold) && queueDepth > config.batchGrowthThreshold) {
      // Grows *toward* window_max in proportion to how far past the threshold the queue
      // is, rather than jumping to the maximum: §9.2 says the window "grows to
      // solve.window_max", and a step function would make the window's own value a
      // discontinuity in latency at exactly the queue depth operators tune against.
      const span = Math.max(0, config.windowMaxMs - config.windowMinMs);
      const overshoot = queueDepth - config.batchGrowthThreshold;
      const fraction = Math.min(1, overshoot / Math.max(1, config.batchGrowthThreshold));
      return {
        regime: CADENCE.LOADED,
        windowMs: Math.floor(config.windowMinMs + span * fraction),
        maxLegsThisRound: config.maxLegsPerRound,
        rationale:
          `queue depth ${queueDepth} exceeds solve.batch_growth_threshold (${config.batchGrowthThreshold}). ` +
          "Under load, batching quality and per-round amortisation both improve, and queueing delay already " +
          "dominates the window (§9.2).",
      };
    }
    return {
      regime: CADENCE.NOMINAL,
      windowMs: config.windowMinMs,
      maxLegsThisRound: config.maxLegsPerRound,
      rationale: "steady arrivals: latency-favouring, capturing near-simultaneous arrivals (§9.2).",
    };
  };

  const chosen = decide();
  const bounded = boundBySlaBudget({
    windowMs: chosen.windowMs,
    slaBudgetsSeconds: source.slaBudgetsSeconds,
    maxWindowSlaFraction: config.maxWindowSlaFraction,
  });

  return Object.freeze({
    regime: chosen.regime,
    windowMs: bounded.windowMs,
    unboundedWindowMs: chosen.windowMs,
    maxLegsThisRound: chosen.maxLegsThisRound,
    rationale: chosen.rationale,
    slaBound: Object.freeze({
      applied: bounded.bound,
      tightestBudgetSeconds: bounded.boundBy,
      note: bounded.bound
        ? "the regime's window was shortened so it cannot consume more than solve.max_window_sla_fraction of " +
          "the tightest SLA budget in the batch (§9.2)"
        : null,
    }),
    inputs: Object.freeze({ queueDepth, feasibleSupply, fastPathClassPresent, nothingToTradeAgainst }),
  });
}

/**
 * §9.2 — "The window MUST additionally close early when supply changes materially — an
 * agent becoming available is new information worth acting on."
 *
 * "Materially" is read as *any* increase in feasible supply, plus the batch filling. An
 * agent becoming available is by the specification's own words worth acting on, and a
 * threshold on top of that would be a second, unregistered parameter deciding when new
 * information counts.
 *
 * @param {object} input
 * @param {number} input.openedAtMs
 * @param {number} input.nowMs both supplied by the caller — this module reads no clock
 * @param {number} input.windowMs
 * @param {number} input.supplyAtOpen
 * @param {number} input.supplyNow
 * @param {number} input.legsCollected
 * @param {number} input.maxLegsThisRound
 * @returns {{ close: boolean, reason: string|null, elapsedMs: number, detail: string|null }}
 */
function shouldCloseEarly(input) {
  const source = input || {};
  const elapsedMs = isNumber(source.nowMs) && isNumber(source.openedAtMs) ? source.nowMs - source.openedAtMs : 0;

  if (isNumber(source.legsCollected) && isNumber(source.maxLegsThisRound) && source.legsCollected >= source.maxLegsThisRound) {
    return {
      close: true,
      reason: EARLY_CLOSE.BATCH_FULL,
      elapsedMs,
      detail:
        `the batch reached ${source.legsCollected} Legs, its cap for this round. Waiting longer would only ` +
        "add Legs the round would have to defer to the next one anyway (§9.4).",
    };
  }

  if (isNumber(source.supplyAtOpen) && isNumber(source.supplyNow) && source.supplyNow > source.supplyAtOpen) {
    return {
      close: true,
      reason: EARLY_CLOSE.SUPPLY_CHANGED,
      elapsedMs,
      detail:
        `feasible supply rose from ${source.supplyAtOpen} to ${source.supplyNow} while the window was open. ` +
        "An agent becoming available is new information worth acting on (§9.2).",
    };
  }

  return { close: false, reason: EARLY_CLOSE.NOT_YET, elapsedMs, detail: null };
}

/**
 * Has the configured window elapsed?
 *
 * Separated from `shouldCloseEarly` so the two reasons a window ends — it expired, or it
 * was closed early by new information — are distinguishable in the round record rather
 * than collapsed into one boolean.
 *
 * @param {object} input `{ openedAtMs, nowMs, windowMs }`
 * @returns {boolean}
 */
function windowElapsed(input) {
  const source = input || {};
  if (!isNumber(source.nowMs) || !isNumber(source.openedAtMs) || !isNumber(source.windowMs)) return true;
  return source.nowMs - source.openedAtMs >= source.windowMs;
}

/**
 * Prove the fast path is the batch path (§9.2), as a property a build-time test can
 * assert rather than a claim a reviewer must check.
 *
 * The assertion this makes is narrow and exact: a fast-path verdict differs from every
 * other verdict in **exactly two fields** — its window and its batch cap. It names no
 * solver, selects no alternative pipeline, and carries no flag a downstream module could
 * branch on. If a future change adds one, this function fails and names it.
 *
 * @param {object} verdict from `windowFor()`
 * @returns {{ ok: boolean, problems: string[] }}
 */
function assertFastPathIsBatchPath(verdict) {
  const problems = [];
  if (!verdict || verdict.regime !== CADENCE.FAST_PATH) {
    return { ok: true, problems };
  }

  if (verdict.maxLegsThisRound !== FAST_PATH_BATCH_SIZE) {
    problems.push(
      `the fast-path verdict caps the batch at ${verdict.maxLegsThisRound}, not ${FAST_PATH_BATCH_SIZE}. §9.2 ` +
        "defines the fast path as the batch path at |L| = 1; any other cap makes it a different round.",
    );
  }

  const permitted = new Set([
    "regime",
    "windowMs",
    "unboundedWindowMs",
    "maxLegsThisRound",
    "rationale",
    "slaBound",
    "inputs",
  ]);
  for (const key of Object.keys(verdict)) {
    if (!permitted.has(key)) {
      problems.push(
        `the fast-path verdict carries "${key}", which is not one of the cadence verdict's fields. §9.2 forbids ` +
          "a parallel implementation; a field only the fast path carries is how one begins — a downstream module " +
          "branches on it, and the two paths acquire the ability to disagree about feasibility, cost, or " +
          "optimality reporting.",
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

module.exports = {
  CADENCE,
  EARLY_CLOSE,
  MS_PER_SECOND,
  FAST_PATH_BATCH_SIZE,
  boundBySlaBudget,
  windowFor,
  shouldCloseEarly,
  windowElapsed,
  assertFastPathIsBatchPath,
};

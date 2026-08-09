"use strict";

/**
 * Shard sizing — §3.5's two independent bounds, and the binding one (§3.5, §24.6) —
 * **Tier 1**.
 *
 * > Shard size is bounded by two separate resources, and the specification states both
 * > because a shard sized against only the first will silently violate the second.
 * >
 * > **Bound 1 — round wall-clock.** One Coordinator must complete a round within its
 * > latency budget (§20.1). This bound is measured, not derived, and it scales with local
 * > mission rate and candidate counts, not with agent count directly.
 * >
 * > **Bound 2 — the serialised commit section.** Every durable transaction against a
 * > shard's Commitment Store is serialised behind that shard's single writer (§19.3).
 * >
 * > ```
 * > N_agents  ≤  ρ_max · 3600 / ( r · k_txn · t_txn )
 * > ```
 * >
 * > Both bounds are continuously monitored as SLIs (§21.4), and the *binding* one is
 * > reported, so that a shard split is triggered by whichever resource is actually
 * > exhausted.
 *
 * ── The two bounds are not the same kind of statement ───────────────────────
 * Bound 2 is arithmetic over configuration and can be evaluated at publish time, before a
 * single agent exists. Bound 1 is **measured** — it is a statement about observed round
 * wall-clock against `perf.round_wall_clock_p99` — and cannot be evaluated at all until a
 * shard has run rounds. This module therefore reports bound 1 as *unevaluated* rather than
 * as satisfied when there is no measurement, and `bindingBound` becomes
 * `NEITHER_EVALUATED` rather than defaulting to the one that happens to be computable.
 *
 * That distinction is the whole reason the two are kept apart. A shard reported as sized
 * because its arithmetic passes, while its rounds are running 400 ms over budget, is a
 * shard whose split is triggered by the wrong resource — which is the failure §3.5's last
 * sentence exists to prevent.
 *
 * ── One implementation of the inequality ────────────────────────────────────
 * `config/validators.js`'s publish-time check V4 delegates here rather than restating the
 * arithmetic. Two copies of a sizing inequality is two places to update when `k_txn` is
 * re-measured, and the one that is not updated is the one that admits the oversubscribed
 * shard.
 *
 * ── §24.6's locality test lives here too, and for the same reason ───────────
 * > **The locality test:** identical benchmarks against a shard in a small fleet and a
 * > shard in a million-agent fleet MUST produce statistically indistinguishable round
 * > times. This is the direct verification of T9, and its failure invalidates the scaling
 * > claim.
 *
 * "Statistically indistinguishable" needs a criterion, and a criterion written inside a
 * test file is a threshold nobody registered, nobody owns, and nobody can change without
 * editing a test. `compareLocality()` is the criterion; its tolerance is
 * `shard.locality_max_round_time_divergence`, a registered parameter like every other
 * behavioural constant (§22.1 rule 1).
 *
 * ── No clock, no store ──────────────────────────────────────────────────────
 * Pure arithmetic over supplied values. A sizing verdict that depended on when it was
 * computed could not be re-derived from a decision record, and §3.5 makes a rebalance a
 * STRUCTURAL change (§22.3) that somebody will have to justify later.
 */

/** @structural unit conversion: seconds in an hour, from the §3.5 inequality's own statement */
const SECONDS_PER_HOUR = 3600;

/** @structural unit conversion: milliseconds in a second */
const MS_PER_SECOND = 1000;

/**
 * §3.5's two bounds, by the name `Shard.bindingBound` carries.
 * @structural the bound vocabulary
 */
const BOUND = Object.freeze({
  ROUND_WALL_CLOCK: "ROUND_WALL_CLOCK",
  SERIAL_COMMIT: "SERIAL_COMMIT",
  NEITHER_EVALUATED: "NEITHER_EVALUATED",
});

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Bound 2 — the serialised commit section.
 *
 * `N · r · k_txn · t_txn ≤ ρ_max · 3600`, with `t_txn` supplied in milliseconds because
 * that is the unit `shard.commit_txn_service_time` is registered in and the unit §20.1
 * bounds its p99 in.
 *
 * Reports `admissibleAgents` — the largest `N` the inequality permits at this workload —
 * because that is the number a rebalance decision actually needs. §3.5's own worked
 * example is the point: "A dense urban shard running short hops at `r = 20` admits roughly
 * 4 400 agents, not 20 000."
 *
 * `ρ_max` is treated as a **queueing** bound, not a capacity bound, exactly as §3.5
 * insists: "Sizing to `ρ → 1` would meet a throughput figure while destroying the latency
 * target that bounds the leadership-fence vulnerability window." The realised utilisation
 * is therefore reported alongside the verdict, so a shard at ρ = 0.24 and one at ρ = 0.02
 * are distinguishable even though both pass.
 *
 * @param {object} input
 * @param {number} input.agents `N` — `shard.max_agents`, or the observed membership
 * @param {number} input.missionRatePerAgentHour `r` — `shard.mission_rate_per_agent_hour`
 * @param {number} input.txnPerMissionLifecycle `k_txn` — `shard.txn_per_mission_lifecycle`
 * @param {number} input.commitTxnServiceTimeMs `t_txn` — `shard.commit_txn_service_time`
 * @param {number} input.maxSerialUtilisation `ρ_max` — `commit.max_serial_utilisation`
 * @returns {object}
 */
function evaluateSerialCommitBound(input) {
  const source = input || {};
  const inputs = {
    agents: source.agents,
    missionRatePerAgentHour: source.missionRatePerAgentHour,
    txnPerMissionLifecycle: source.txnPerMissionLifecycle,
    commitTxnServiceTimeMs: source.commitTxnServiceTimeMs,
    maxSerialUtilisation: source.maxSerialUtilisation,
  };

  const missing = Object.entries(inputs)
    .filter(([, value]) => !isNumber(value))
    .map(([name]) => name);

  if (missing.length > 0) {
    return Object.freeze({
      bound: BOUND.SERIAL_COMMIT,
      evaluated: false,
      satisfied: null,
      missing,
      inputs,
      sentence:
        `the §3.5 bound-2 inequality cannot be evaluated: ${missing.join(", ")} unset. An unevaluated bound is ` +
        "reported as unevaluated, never as satisfied — a shard sized against a bound nobody computed is sized " +
        "against nothing.",
    });
  }

  const serviceTimeSeconds = inputs.commitTxnServiceTimeMs / MS_PER_SECOND;
  const perAgentDemand = inputs.missionRatePerAgentHour * inputs.txnPerMissionLifecycle * serviceTimeSeconds;
  const demand = inputs.agents * perAgentDemand;
  const capacity = inputs.maxSerialUtilisation * SECONDS_PER_HOUR;

  // `perAgentDemand` is strictly positive: every one of its three factors is
  // range-constrained above zero in the register, so the division below cannot divide by
  // zero for any value the Config Service will publish.
  const admissibleAgents = Math.floor(capacity / perAgentDemand);
  const utilisation = demand / SECONDS_PER_HOUR;
  const headroom = admissibleAgents - inputs.agents;

  return Object.freeze({
    bound: BOUND.SERIAL_COMMIT,
    evaluated: true,
    satisfied: demand <= capacity,
    inputs,
    demandSeconds: demand,
    capacitySeconds: capacity,
    admissibleAgents,
    headroomAgents: headroom,
    // The fraction of the ρ_max budget this shard is using. 1.0 is the bound itself, not
    // saturation of the writer: ρ_max is already 0.25 by default.
    budgetUsed: capacity > 0 ? demand / capacity : null,
    realisedUtilisation: utilisation,
    sentence:
      demand <= capacity
        ? `bound 2 holds: N·r·k_txn·t_txn = ${demand.toFixed(2)} ≤ ρ_max·3600 = ${capacity.toFixed(2)}. At ` +
          `r = ${inputs.missionRatePerAgentHour} this shard admits about ${admissibleAgents} agents and holds ` +
          `${inputs.agents}, leaving ${headroom}.`
        : `bound 2 is violated: N·r·k_txn·t_txn = ${demand.toFixed(2)} exceeds ρ_max·3600 = ${capacity.toFixed(2)}. ` +
          `At r = ${inputs.missionRatePerAgentHour} missions per agent per hour this shard admits about ` +
          `${admissibleAgents} agents, not ${inputs.agents}. The bound is inversely proportional to mission rate, ` +
          "so shard size is configured per region against that region's measured r.",
  });
}

/**
 * Bound 1 — round wall-clock, measured against §20.1's target.
 *
 * Deliberately takes a **measurement**, not a model. §3.5: "This bound is measured, not
 * derived." A bound-1 verdict computed from agent count and candidate caps would be a
 * second sizing model wearing the first one's name, and its disagreement with reality
 * would be exactly the silent violation §3.5 warns about.
 *
 * The headroom is expressed as a *ratio of the budget*, because the useful question at a
 * rebalance is "how much room is left", and a shard at 60 % of its round budget is
 * differently placed from one at 98 % even though both satisfy the bound.
 *
 * @param {object} input
 * @param {number} [input.observedRoundWallClockP99Ms] the measurement; absent means unevaluated
 * @param {number} input.roundWallClockBudgetMs `perf.round_wall_clock_p99`
 * @param {number} [input.samples] how many rounds the measurement is over
 * @param {number} [input.minSamples] the smallest sample this verdict is willing to speak for
 * @returns {object}
 */
function evaluateRoundWallClockBound(input) {
  const source = input || {};
  const budget = source.roundWallClockBudgetMs;
  const observed = source.observedRoundWallClockP99Ms;
  const samples = isNumber(source.samples) ? source.samples : null;
  const minSamples = isNumber(source.minSamples) ? source.minSamples : null;

  if (!isNumber(budget)) {
    return Object.freeze({
      bound: BOUND.ROUND_WALL_CLOCK,
      evaluated: false,
      satisfied: null,
      reason: "NO_BUDGET",
      sentence: "bound 1 cannot be evaluated: perf.round_wall_clock_p99 is unset, so there is no §20.1 target to measure against.",
    });
  }

  if (!isNumber(observed)) {
    return Object.freeze({
      bound: BOUND.ROUND_WALL_CLOCK,
      evaluated: false,
      satisfied: null,
      reason: "NO_MEASUREMENT",
      budgetMs: budget,
      sentence:
        "bound 1 is unevaluated: §3.5 makes it a measured bound, and this shard has no observed round wall-clock. " +
        "Reporting it as satisfied would be reporting a measurement nobody took.",
    });
  }

  if (minSamples !== null && samples !== null && samples < minSamples) {
    return Object.freeze({
      bound: BOUND.ROUND_WALL_CLOCK,
      evaluated: false,
      satisfied: null,
      reason: "INSUFFICIENT_SAMPLES",
      budgetMs: budget,
      observedMs: observed,
      samples,
      minSamples,
      sentence:
        `bound 1 is unevaluated: ${samples} round(s) is below the ${minSamples} this verdict is willing to speak ` +
        "for. A p99 over a handful of rounds is a maximum wearing a percentile's name.",
    });
  }

  const headroomRatio = (budget - observed) / budget;

  return Object.freeze({
    bound: BOUND.ROUND_WALL_CLOCK,
    evaluated: true,
    satisfied: observed <= budget,
    budgetMs: budget,
    observedMs: observed,
    samples,
    headroomMs: budget - observed,
    headroomRatio,
    budgetUsed: observed / budget,
    sentence:
      observed <= budget
        ? `bound 1 holds: measured round wall-clock p99 ${observed} ms is within the §20.1 budget of ${budget} ms ` +
          `(${Math.round(headroomRatio * 100)} % headroom).`
        : `bound 1 is violated: measured round wall-clock p99 ${observed} ms exceeds the §20.1 budget of ` +
          `${budget} ms. §20.1 makes this target a release-gate requirement rather than an aspiration, and §9.2 ` +
          "makes a round that overruns its window a batch window that has stopped meaning anything.",
  });
}

/**
 * Evaluate both bounds and report the binding one.
 *
 * The resolution rule, stated once here so no consumer re-derives it:
 *
 *   - A **violated** bound always binds. If both are violated, the one with the larger
 *     overrun binds, because that is the resource actually exhausted.
 *   - If neither is violated, the bound with the **least headroom** binds — the one that
 *     will be exhausted first, which is what a rebalance decision needs to know.
 *   - A bound that could not be evaluated never binds and never satisfies. If neither
 *     could be evaluated the answer is `NEITHER_EVALUATED`, which is honest and is not the
 *     same sentence as "this shard is correctly sized".
 *
 * Headroom is compared as a **fraction of each bound's own budget**, because the two are
 * in different units — agents and milliseconds — and comparing them any other way would
 * be comparing a count against a duration.
 *
 * @param {object} input `{ serialCommit, roundWallClock }` inputs for each evaluator
 * @returns {object}
 */
function evaluate(input) {
  const source = input || {};
  const serial = evaluateSerialCommitBound(source.serialCommit || {});
  const round = evaluateRoundWallClockBound(source.roundWallClock || {});

  const evaluated = [serial, round].filter((bound) => bound.evaluated);
  const violated = evaluated.filter((bound) => bound.satisfied === false);

  let binding = BOUND.NEITHER_EVALUATED;
  let why = "neither bound could be evaluated; this is not a statement that the shard is correctly sized";

  if (violated.length > 0) {
    const worst = violated.reduce((a, b) => (b.budgetUsed > a.budgetUsed ? b : a));
    binding = worst.bound;
    why =
      violated.length === 1
        ? `${worst.bound} is violated and is therefore the binding bound`
        : `both bounds are violated; ${worst.bound} overruns its budget by the larger fraction and is reported as binding`;
  } else if (evaluated.length > 0) {
    const tightest = evaluated.reduce((a, b) => (b.budgetUsed > a.budgetUsed ? b : a));
    binding = tightest.bound;
    why =
      evaluated.length === 1
        ? `only ${tightest.bound} could be evaluated; it binds by default and the other is unevaluated, not satisfied`
        : `both bounds hold; ${tightest.bound} has the least headroom and will be exhausted first`;
  }

  return Object.freeze({
    bindingBound: binding,
    why,
    // Both, always. §3.5 requires both to be *monitored* and the binding one reported;
    // returning only the binding one would make the other unmonitorable through this
    // surface, which is how a shard comes to be sized against one resource again.
    bounds: Object.freeze({ [BOUND.SERIAL_COMMIT]: serial, [BOUND.ROUND_WALL_CLOCK]: round }),
    satisfied: violated.length === 0 && evaluated.length > 0 ? true : violated.length > 0 ? false : null,
    evaluatedCount: evaluated.length,
    rebalanceIndicated: violated.length > 0,
    sentence:
      violated.length > 0
        ? `shard sizing is exceeded on ${binding}. ${violated.map((bound) => bound.sentence).join(" ")}`
        : evaluated.length > 0
          ? `shard sizing holds; ${binding} is the binding bound. ${why}.`
          : "shard sizing is unknown: neither bound has been evaluated.",
  });
}

/**
 * §24.6's locality test criterion.
 *
 * > identical benchmarks against a shard in a small fleet and a shard in a million-agent
 * > fleet MUST produce statistically indistinguishable round times. This is the direct
 * > verification of T9, and its failure invalidates the scaling claim.
 *
 * "Indistinguishable" is expressed as a **relative divergence** against
 * `shard.locality_max_round_time_divergence`, compared symmetrically: the test fails if
 * the large-fleet shard is slower by more than the tolerance, and it *also* fails if the
 * small-fleet one is, because a large-fleet shard that is systematically faster is not
 * evidence of locality — it is evidence that the two benchmarks were not identical, which
 * invalidates the comparison rather than passing it.
 *
 * @param {object} input
 * @param {number} input.smallFleetRoundMs the benchmark against a shard in a small fleet
 * @param {number} input.largeFleetRoundMs the same benchmark against a shard in a large fleet
 * @param {number} input.maxDivergence `shard.locality_max_round_time_divergence`, a ratio
 * @param {number} [input.smallFleetAgents]
 * @param {number} [input.largeFleetAgents]
 * @returns {object}
 */
function compareLocality(input) {
  const source = input || {};

  if (![source.smallFleetRoundMs, source.largeFleetRoundMs, source.maxDivergence].every(isNumber)) {
    return Object.freeze({
      evaluated: false,
      indistinguishable: null,
      sentence:
        "the locality test cannot be evaluated: one of the two benchmark results or the tolerance is unset. " +
        "§24.6 makes this the direct verification of T9, so an unevaluated result is not a pass.",
    });
  }
  if (source.smallFleetRoundMs <= 0) {
    return Object.freeze({
      evaluated: false,
      indistinguishable: null,
      sentence: "the locality test cannot be evaluated: the small-fleet benchmark is not a positive duration.",
    });
  }

  const divergence = (source.largeFleetRoundMs - source.smallFleetRoundMs) / source.smallFleetRoundMs;
  const magnitude = Math.abs(divergence);
  const indistinguishable = magnitude <= source.maxDivergence;

  return Object.freeze({
    evaluated: true,
    indistinguishable,
    divergence,
    magnitude,
    maxDivergence: source.maxDivergence,
    smallFleetRoundMs: source.smallFleetRoundMs,
    largeFleetRoundMs: source.largeFleetRoundMs,
    smallFleetAgents: source.smallFleetAgents ?? null,
    largeFleetAgents: source.largeFleetAgents ?? null,
    // Which direction failed, because the two mean opposite things and only one of them
    // is a scaling defect.
    direction: divergence > 0 ? "LARGE_FLEET_SLOWER" : divergence < 0 ? "LARGE_FLEET_FASTER" : "IDENTICAL",
    sentence: indistinguishable
      ? `locality holds: round times diverge by ${(magnitude * 100).toFixed(2)} %, within the ` +
        `${(source.maxDivergence * 100).toFixed(2)} % tolerance. Per-decision work is a function of local density, ` +
        "not of global fleet size (T9)."
      : divergence > 0
        ? `locality FAILS: the large-fleet shard's round time is ${(magnitude * 100).toFixed(2)} % above the ` +
          `small-fleet shard's, beyond the ${(source.maxDivergence * 100).toFixed(2)} % tolerance. §24.6: "its ` +
          'failure invalidates the scaling claim." Something in the round is a function of global fleet size.'
        : `locality is NOT established: the large-fleet shard's round time is ${(magnitude * 100).toFixed(2)} % ` +
          "*below* the small-fleet shard's, beyond tolerance. A large-fleet shard that is systematically faster " +
          "is not evidence of locality; it is evidence that the two benchmarks were not identical, which " +
          "invalidates the comparison rather than passing it.",
  });
}

/**
 * The persisted form of an evaluation, for the `Shard` row.
 *
 * @param {object} evaluation an `evaluate()` result
 * @param {Date} at
 * @returns {object}
 */
function toShardUpdate(evaluation, at) {
  return {
    bindingBound: evaluation.bindingBound,
    sizingDetail: {
      why: evaluation.why,
      satisfied: evaluation.satisfied,
      rebalanceIndicated: evaluation.rebalanceIndicated,
      sentence: evaluation.sentence,
      bounds: evaluation.bounds,
    },
    sizingCheckedAt: at,
  };
}

module.exports = {
  BOUND,
  SECONDS_PER_HOUR,
  evaluateSerialCommitBound,
  evaluateRoundWallClockBound,
  evaluate,
  compareLocality,
  toShardUpdate,
};

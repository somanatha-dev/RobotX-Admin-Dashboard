"use strict";

/**
 * **F17 — The candidate plan holds no more than `capacity[agent_class]` concurrent
 * commitments and extends no further than `plan.commitment_horizon`.** Class I.
 * Indeterminate: `DENY`.
 *
 * > Generalises one-mission-per-agent; capacity 1 reproduces the strict rule exactly.
 * > **Evaluated as a property of the plan** (§13.3), which is what allows queue depth
 * > > 1 without introducing a non-separable arc into the solve (§9.3).
 *
 * ── Why "a property of the plan" is load-bearing ────────────────────────────
 * The execution plan singles this out — *"F17 evaluated as a property of the plan"* —
 * and the parenthesis explains the stakes. If capacity were checked as a property of
 * the *agent* ("how many commitments does this agent already hold?"), then whether a
 * candidate is feasible would depend on which other candidates the solver had
 * provisionally selected in the same round. That is a coupling between decision
 * variables, and §9.3 states the consequence: it makes the assignment problem
 * non-separable, so the min-cost-flow structure that guarantees integral, exact
 * solutions in the singleton regime is lost.
 *
 * Evaluating it against the *plan* — a complete, self-contained artefact that already
 * enumerates every commitment the agent would hold if this plan were adopted — keeps
 * the predicate a pure function of one candidate. Two plans for the same agent are
 * simply two candidates, each independently feasible or not.
 *
 * ── Two conditions, one predicate ───────────────────────────────────────────
 *   1. concurrent commitments ≤ `capacity[agent_class]`
 *   2. the plan's furthest extent ≤ `plan.commitment_horizon` from the decision time
 *
 * The second exists because a plan may satisfy the count while reaching so far into
 * the future that the commitment is meaningless — a queued mission twelve hours out is
 * a forecast, not a commitment, and holding an agent against it forecloses better
 * assignments the intervening rounds would have made (§2.6).
 *
 * On the volatile subset (§10.3.2 step 3): capacity is exactly what a concurrent
 * commit in the same round would consume, and the re-check happens under the row locks
 * where that race is resolved.
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");

const REQUIRED = "concurrent commitments within capacity, and plan extent within the commitment horizon";

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config, decisionTimeMs }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = (context && context.agentSnapshot) || null;
  const plan = (context && context.plan) || null;
  const config = context && context.config;
  const decisionTimeMs = context && context.decisionTimeMs;

  if (!agent) return tv.absent("the agent snapshot", { required: REQUIRED });
  if (!plan) {
    return tv.absent("the candidate plan", {
      required: REQUIRED,
      reason:
        "F17 is evaluated as a property of the plan (§13.3). With no plan there is nothing to " +
        "evaluate, and falling back to a property of the agent would couple this candidate to the " +
        "solver's other provisional choices (§9.3)",
    });
  }

  // ── Condition 1: capacity ─────────────────────────────────────────────────
  // The per-agent override is durable record; the Config Service remains the authority
  // (§2.1), so the resolved value wins and the override is only consulted when the
  // register resolves nothing for the class.
  const resolved = tv.readIndexedParameter(config, "capacity", agent.agentClassId);
  const capacity = tv.isNumber(resolved) ? resolved : agent.capacityOverride;

  if (!tv.isNumber(capacity)) {
    return tv.absent(`capacity for agent class "${String(agent.agentClassId)}"`, {
      required: REQUIRED,
      inputSource: "CONFIG",
    });
  }

  const concurrent = plan.concurrentCommitments;
  if (!tv.isNumber(concurrent)) {
    return tv.absent("the plan's concurrent-commitment count", {
      required: { capacity },
      inputSource: "PLAN",
    });
  }

  if (concurrent > capacity) {
    return tv.violated({
      observed: { concurrentCommitments: concurrent },
      required: { capacity },
      inputSource: "PLAN",
      margin: capacity - concurrent,
      marginUnit: tv.MARGIN_UNIT.COUNT,
      reason:
        `the plan holds ${concurrent} concurrent commitments against a capacity of ${capacity} ` +
        "(§7.5 F17). At capacity 1 this is the strict one-mission-per-agent rule",
    });
  }

  // ── Condition 2: the commitment horizon ───────────────────────────────────
  const horizonSeconds = tv.readParameter(config, "plan.commitment_horizon");
  if (!tv.isNumber(horizonSeconds)) {
    return tv.absent("plan.commitment_horizon", {
      observed: { concurrentCommitments: concurrent },
      required: REQUIRED,
      inputSource: "CONFIG",
    });
  }

  if (!tv.isNumber(decisionTimeMs)) {
    return tv.indeterminate({
      observed: { concurrentCommitments: concurrent },
      required: REQUIRED,
      reason: "the round's pinned decision time is absent; plan extent cannot be measured (T6, §9.6)",
    });
  }

  const extentEndMs = tv.epochMs(plan.horizonEndMs !== undefined ? plan.horizonEndMs : plan.projectedEndMs);
  if (extentEndMs === null) {
    return tv.absent("the plan's furthest extent", {
      observed: { concurrentCommitments: concurrent },
      required: { commitmentHorizonMs: tv.secondsToMs(horizonSeconds) },
      inputSource: "PLAN",
    });
  }

  const horizonMs = tv.secondsToMs(horizonSeconds);
  const extentMs = extentEndMs - decisionTimeMs;

  if (extentMs > horizonMs) {
    return tv.violated({
      observed: { concurrentCommitments: concurrent, extentMs },
      required: { capacity, commitmentHorizonMs: horizonMs },
      inputSource: "PLAN",
      margin: horizonMs - extentMs,
      marginUnit: tv.MARGIN_UNIT.MILLISECONDS,
      reason:
        `the plan extends ${extentMs} ms ahead, beyond the ${horizonMs} ms commitment horizon ` +
        "(§7.5 F17). A commitment reaching far enough ahead is a forecast, and holding an agent " +
        "against one forecloses the assignments the intervening rounds would have made (§2.6)",
    });
  }

  // The satisfied margin reports the **capacity** headroom, in counts. The horizon
  // headroom is in the observed tuple rather than folded in with `Math.min`: the two
  // are different dimensions, and a quantile sketch fed a minimum over counts and
  // milliseconds would be a number with no interpretation (§7.7).
  return tv.satisfied({
    observed: { concurrentCommitments: concurrent, extentMs, horizonHeadroomMs: horizonMs - extentMs },
    required: { capacity, commitmentHorizonMs: horizonMs },
    inputSource: "PLAN",
    margin: capacity - concurrent,
    marginUnit: tv.MARGIN_UNIT.COUNT,
  });
}

module.exports = { evaluate };

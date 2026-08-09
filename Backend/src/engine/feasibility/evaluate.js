"use strict";

/**
 * The feasibility gate (§7.1) — **Tier 0**, mechanism T0-01. Invariants I9, I14.
 *
 * > Feasibility is a **boolean gate evaluated before cost, on the full candidate set,
 * > with no access to cost values** (T1). The cost evaluator MUST be **structurally
 * > incapable** of receiving an infeasible pairing — enforced by type separation, not
 * > by convention, so that a future change cannot accidentally introduce a path where a
 * > high-priority mission "scores around" a safety rule.
 *
 * ── This module is the only thing entitled to brand a candidate ────────────
 * Phase 0 built the type separation: `guards/tenets.js` holds a non-enumerable Symbol
 * brand that survives neither `JSON.parse(JSON.stringify(x))` nor `{ ...x }`, an
 * `assertFeasible()` every cost entry point must call, and a build gate that fails any
 * module in the cost scope which accepts a candidate-shaped parameter without
 * asserting it. What was missing was the one caller of `brandFeasible()`. This is it.
 *
 * `brandFeasible()` is called from exactly one place in this file, on a candidate that
 * passed every predicate. A candidate that failed is returned unbranded, so the cost
 * evaluator does not *decline* to price it — it *cannot*, because `assertFeasible()`
 * throws. That is the difference between a rule and a structure, and it is what I14
 * asks for.
 *
 * ── No access to cost values ────────────────────────────────────────────────
 * Nothing in this module, and nothing in the 38 predicates, reads a cost. The
 * evaluation context carries `agentSnapshot`, `mission`, `plan`, and `config` and
 * nothing else; there is no path by which a predicate could see `Φ`. The tier gate
 * enforces the other direction (Tier 0 may not import Tier 2), and the absence of any
 * `engine/cost/` import here enforces this one.
 *
 * ── Manual assignment does not bypass this gate ────────────────────────────
 * > **Manual assignment does not bypass constraints.** The audit documents that in the
 * > baseline, supplying a robot id skips validation entirely, permitting assignment to
 * > a 6 %-battery or faulted robot. In this design, manual assignment sets the
 * > candidate set to a single agent and **runs the identical feasibility gate**.
 *
 * There is deliberately no `skipPredicates`, no `manual` flag, and no privileged
 * caller. An operator's power is to choose *which* agent, never to make an infeasible
 * agent feasible, and the way to guarantee that is to offer no other entry point.
 *
 * ── Evaluation order and short-circuit ─────────────────────────────────────
 * §7.5's order — cheapest first — with short-circuit on the first denial by default.
 * The order is a performance property only: every predicate is a pure function of the
 * snapshot, so the *verdict* is order-independent. `collectAll` disables the
 * short-circuit for diagnostics, and the verdict it produces is identical.
 *
 * ── Determinism ────────────────────────────────────────────────────────────
 * No clock, no randomness, no store. `decisionTimeMs` is the round's pinned time
 * (§9.6 requirement 4) and every predicate takes it from the context, so a replay of a
 * round reaches the same verdicts (T6, I10).
 */

const { PREDICATES, assertRegister } = require("./register");
const { OUTCOME, applyPolicy, readIndexedParameter } = require("./threeValued");
const { brandFeasible } = require("../guards/tenets");
const { assertSubset } = require("./volatileSubset");
const rejectionTelemetry = require("./rejectionTelemetry");

// A gate reading from an incoherent register proves nothing. Both assertions are
// pure functions over frozen data, so running them at module load costs one pass and
// makes an incoherent register a startup failure rather than a silent mis-evaluation.
const registerCheck = assertRegister();
if (!registerCheck.ok) {
  throw new Error(
    `the feasibility constraint register is incoherent and the gate refuses to load:\n  ${registerCheck.problems.join("\n  ")}`,
  );
}

const subsetCheck = assertSubset();
if (!subsetCheck.ok) {
  throw new Error(
    `the volatile subset does not match §10.3.2 step 3 and the gate refuses to load:\n  ${subsetCheck.problems.join("\n  ")}`,
  );
}

/**
 * Evaluate one (agent, mission, plan) candidate against the register.
 *
 * @param {object} context
 * @param {object} context.agentSnapshot the pinned agent state
 * @param {object} context.mission the mission and its Leg
 * @param {object} context.plan the candidate plan — the artefact §13 makes feasibility
 *   and cost share
 * @param {object} context.config the resolved configuration view for this scope chain
 * @param {number} context.decisionTimeMs the round's pinned decision time
 * @param {object} [options]
 * @param {boolean} [options.collectAll] evaluate every predicate rather than
 *   short-circuiting on the first denial. Diagnostics only; the verdict is identical
 * @param {(predicateId: string) => boolean} [options.envelopeFeasible] answers
 *   `DENY_UNLESS_ENVELOPE` — "is a reduced-envelope variant feasible under pessimistic
 *   assumptions?" Absent, the policy denies, which is its name read literally
 * @returns {{ feasible: boolean, verdicts: object, denials: object[],
 *             deniedForIndeterminacyOnly: boolean, penaltyMilliCu: number,
 *             envelopeReduced: boolean, evaluated: string[] }}
 */
function evaluateCandidate(context, options) {
  const settings = options || {};
  const verdicts = Object.create(null);
  const denials = [];
  const evaluated = [];

  let penaltyMilliCu = 0;
  let envelopeReduced = false;
  let anyViolated = false;
  let anyDeniedForIndeterminacy = false;

  for (const entry of PREDICATES) {
    const result = entry.evaluate(context);
    evaluated.push(entry.id);
    verdicts[entry.id] = result;

    if (result.outcome === OUTCOME.SATISFIED) continue;

    const resolution = applyPolicy(result, entry, {
      envelopeFeasible:
        typeof settings.envelopeFeasible === "function" ? settings.envelopeFeasible(entry.id) : undefined,
      uncertaintyPenaltyMilliCu: readIndexedParameter(
        context && context.config,
        "cost.uncertainty_penalty",
        entry.id,
      ),
    });

    if (resolution.admitted) {
      // ADMIT_WITH_PENALTY and DENY_UNLESS_ENVELOPE both admit while *shrinking* the
      // mission envelope. The penalty is accumulated for the cost evaluator to apply;
      // this module never applies it, because that would be evaluating cost inside
      // the gate (T1, §7.1).
      if (typeof resolution.penaltyMilliCu === "number") penaltyMilliCu += resolution.penaltyMilliCu;
      if (resolution.envelopeReduced) envelopeReduced = true;
      continue;
    }

    denials.push({
      predicateId: entry.id,
      constraintClass: entry.constraintClass,
      policy: entry.policy,
      outcome: result.outcome,
      resolution: resolution.resolution,
      deniedForIndeterminacy: resolution.deniedForIndeterminacy,
      result,
    });

    if (result.outcome === OUTCOME.VIOLATED) anyViolated = true;
    if (resolution.deniedForIndeterminacy) anyDeniedForIndeterminacy = true;

    if (!settings.collectAll) break;
  }

  return {
    feasible: denials.length === 0,
    verdicts,
    denials,
    // §7.4 step 1 counts candidates rejected **solely** due to INDETERMINATE. A
    // candidate that was also VIOLATED somewhere is unfit regardless of the telemetry
    // outage, and counting it would let a genuinely broken fleet trip the guard.
    deniedForIndeterminacyOnly: denials.length > 0 && anyDeniedForIndeterminacy && !anyViolated,
    penaltyMilliCu,
    envelopeReduced,
    evaluated,
  };
}

/**
 * Evaluate a candidate and, when it passes, brand it so the cost evaluator can see it.
 *
 * **This is the only function in the codebase that calls `brandFeasible()`.** The
 * brand carries the verdict evidence — which predicates ran, under which config
 * version, against which snapshot — so the decision record can explain an admission as
 * precisely as a rejection (§21.3).
 *
 * @param {object} candidate the object the cost evaluator will receive
 * @param {object} context as `evaluateCandidate`
 * @param {object} [options] as `evaluateCandidate`, plus:
 * @param {object} [options.aggregator] a `rejectionTelemetry` aggregator; rejections
 *   are folded into it **before** anything is sampled (§7.7)
 * @param {object} [options.dimensions] aggregation dimensions
 *   `{ shardId, zoneId, missionClass, legPurpose, decisionId }`
 * @returns {{ feasible: boolean, candidate: object|null, outcome: object, tuples: object[] }}
 */
function gate(candidate, context, options) {
  const settings = options || {};
  const outcome = evaluateCandidate(context, settings);

  // ── §7.7: aggregate at decision time, before anything is sampled ──────────
  const tuples = outcome.denials.map((denial) =>
    rejectionTelemetry.tupleFrom({
      agentId: context && context.agentSnapshot ? context.agentSnapshot.agentId : null,
      predicateId: denial.predicateId,
      result: denial.result,
      dimensions: settings.dimensions,
    }),
  );

  if (settings.aggregator) {
    for (const tuple of tuples) settings.aggregator.record(tuple);
    settings.aggregator.recordCandidate({
      admitted: outcome.feasible,
      deniedForIndeterminacyOnly: outcome.deniedForIndeterminacyOnly,
    });
  }

  if (!outcome.feasible) {
    // Returned unbranded. The cost evaluator does not decline to price it — it cannot,
    // because assertFeasible() throws on an unbranded candidate (I14).
    return { feasible: false, candidate: null, outcome, tuples };
  }

  brandFeasible(candidate, {
    predicatesEvaluated: outcome.evaluated,
    configVersion: context && context.config ? context.config.version || null : null,
    snapshotId: context && context.snapshotId ? context.snapshotId : null,
    decisionTimeMs: context ? context.decisionTimeMs : null,
    penaltyMilliCu: outcome.penaltyMilliCu,
    envelopeReduced: outcome.envelopeReduced,
  });

  return { feasible: true, candidate, outcome, tuples };
}

/**
 * Run the gate over a candidate set, returning only the branded survivors.
 *
 * §7.1: "evaluated **before cost, on the full candidate set**". The whole set is
 * evaluated in one pass so the §7.4 tally is a property of the round rather than of
 * whichever candidates happened to be tried before the solver gave up.
 *
 * Order is preserved from the input, which the caller has already ordered
 * deterministically (`determinism/ordering.js`); this function introduces no ordering
 * of its own.
 *
 * @param {Array<{ candidate: object, context: object }>} candidates
 * @param {object} [options] as `gate`
 * @returns {{ feasible: object[], rejected: object[], tally: object }}
 */
function gateAll(candidates, options) {
  const feasible = [];
  const rejected = [];

  for (const entry of candidates || []) {
    const outcome = gate(entry.candidate, entry.context, options);
    if (outcome.feasible) {
      feasible.push(outcome.candidate);
    } else {
      rejected.push({
        candidate: entry.candidate,
        denials: outcome.outcome.denials,
        deniedForIndeterminacyOnly: outcome.outcome.deniedForIndeterminacyOnly,
        tuples: outcome.tuples,
      });
    }
  }

  const tally =
    options && options.aggregator
      ? options.aggregator.tally()
      : { evaluated: feasible.length + rejected.length, deniedForIndeterminacyOnly: rejected.filter((row) => row.deniedForIndeterminacyOnly).length };

  return { feasible, rejected, tally };
}

module.exports = {
  evaluateCandidate,
  gate,
  gateAll,
};

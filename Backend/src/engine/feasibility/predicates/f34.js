"use strict";

/**
 * **F34 — Energy feasibility with layered reserves at the configured confidence,
 * evaluated at all three shortfall tiers (§14.5).** Class I. Indeterminate: `DENY`.
 *
 * > The single most important addition relative to the baseline's instantaneous 20 %
 * > floor: **feasibility is a property of the *mission*, not of the current charge.**
 * > One predicate, three simultaneous conditions — a divert-to-charge, a physical
 * > recovery, and an in-service immobilisation carry consequences orders of magnitude
 * > apart and cannot share one probability target. The binding tier is recorded per
 * > rejection (§7.7).
 *
 * ── The three conditions, from §14.5 ────────────────────────────────────────
 * ```
 * T1:  P[ E_usable − E_mission <  E_floor + E_return + E_contingency ]  ≤  α₁(class)
 * T2:  P[ E_usable − E_mission <  E_floor + E_return                 ]  ≤  α₂(class)
 * T3:  P[ E_usable − E_mission <  E_floor                            ]  ≤  α₃(class)
 * ```
 *
 * All three must hold. They are **nested** — T3's event implies T2's implies T1's — so
 * the probabilities are monotone non-increasing across the tiers, while the targets
 * tighten by orders of magnitude (1e-2, 1e-5, 1e-7). Which one binds is therefore not
 * obvious in advance and depends on the shape of the distribution at each threshold,
 * which is exactly why §14.5 requires all three to be evaluated rather than the
 * "strictest" one chosen up front.
 *
 * ── The binding tier is the operational output ──────────────────────────────
 * > because "this mission failed on immobilisation risk" and "this mission failed on
 * > divert-to-charge risk" call for entirely different operational responses.
 *
 * A fleet blocked on T1 needs more chargers. A fleet blocked on T3 needs a different
 * reserve policy or different hardware. §7.7 makes the tier part of the aggregation
 * key for that reason, so this module records it on every outcome — including
 * `SATISFIED`, where the tier with the least headroom is the one that will bind first
 * as the fleet's duty cycle rises.
 *
 * ── α is derived, never read as a per-mission number ────────────────────────
 * > **The composed budget is the governed parameter; `α` is derived from it.**
 *
 * `energy.shortfall_probability` is a `DERIVED` register entry whose derivation Phase 1
 * implemented in `config/derived.js`:
 * `α[tier] = energy.event_budget_per_fleet_year[tier] / (fleet.agent_count ·
 * fleet.missions_per_agent_year)`. This predicate reads the derived map and never a
 * hand-set per-mission value — the direction of derivation is what stops a number that
 * "reads as stringent" from authorising a hundred reserve breaches a day once composed
 * over fleet scale.
 *
 * ── Where the probabilities come from ───────────────────────────────────────
 * `plan.energy.tierProbabilities` is produced by `engine/energy/tiers.js` (Phase 7),
 * which evaluates each condition against the predictive distribution of `E_mission`.
 * This predicate does not model energy: it compares three supplied probabilities
 * against three derived targets and reports which binds. Computing a consumption
 * distribution here would be a second energy model, and §14.6's requirement that both
 * sides reason from identical inputs applies inside the server as much as across the
 * link. Phase 5's `supervision/progress.js` draws the same line for the same reason.
 *
 * Until Phase 7 lands, `plan.energy` is absent and this predicate returns
 * `INDETERMINATE`, which under class I denies.
 *
 * On the volatile subset (§10.3.2 step 3) — the baseline's exact defect was validating
 * battery before the reservation and never re-checking it at finalisation.
 *
 * Tier 0 (T0-01, T0-03). Invariant I17.
 */

const tv = require("../threeValued");

/**
 * §14.5's three shortfall tiers, in nesting order, each with the reserve layers its
 * condition subtracts and the consequence that justifies its own target.
 * @structural the specification's own tier labels and their reserve compositions
 */
const TIERS = Object.freeze([
  Object.freeze({
    tier: "T1",
    event: "Contingency reserve consumed",
    consequence: "Diversion to charge; no incident",
    reserves: Object.freeze(["E_floor", "E_return", "E_contingency"]),
  }),
  Object.freeze({
    tier: "T2",
    event: "Return reserve breached",
    consequence: "Physical recovery mission required",
    reserves: Object.freeze(["E_floor", "E_return"]),
  }),
  Object.freeze({
    tier: "T3",
    event: "Hardware floor reached in active service",
    consequence: "Immobilisation; possible obstruction of a public right of way",
    reserves: Object.freeze(["E_floor"]),
  }),
]);

const TIER_NAMES = Object.freeze(TIERS.map((row) => row.tier));

const REQUIRED = "shortfall probability within alpha[tier] at all three tiers (§14.5)";

/**
 * Resolve `α[tier]` from the derived `energy.shortfall_probability` map.
 *
 * ── Why this is spelled out rather than a generic indexed read ───────────────
 * This predicate deliberately re-derives its own targets instead of reading the
 * `target` field `energy/tiers.js` already computed: F34 must not take the threshold
 * from the producer whose output it is checking. That independence is only safe while
 * the two transcriptions agree, and a generic `readIndexedParameter(map, tier, class)`
 * did **not** agree — it indexes `map[tier][class]`, while `energy/tiers.js`'s
 * `alphaFor()` indexes `map[class][tier]`. The two are transposed.
 *
 * Under the shape `config/derived.js` publishes today — a flat tier-keyed map, per
 * Appendix A's `indexedBy: ["tier"]` — both readings land on the same number and the
 * disagreement is invisible. The moment a class-keyed entry is published (which
 * `alphaFor()` documents as supported, and which the register's `specScope:
 * "sla_class"` invites) the readings part company, and they part in the **permissive**
 * direction for this predicate: the energy model would use the stricter class target
 * while F34 compared against the looser fleet default, admitting a plan the
 * authoritative model calls infeasible. On a class I predicate that is a false
 * positive, which §7.3's "unknown is never permission" exists to make impossible.
 *
 * So this resolves α with `alphaFor()`'s precedence exactly — a class-keyed entry wins
 * over the tier-keyed default — and refuses any other shape rather than digging into
 * it. The set of maps F34 accepts is now a subset of the set `energy/tiers.js` accepts,
 * which is what makes "F34 admits ⟹ the energy model agrees" hold structurally.
 *
 * The range check is `alphaFor()`'s too: Appendix A bounds this parameter to [0, 1],
 * and an α at or above 1 would make the tier vacuously satisfied for every plan.
 *
 * @param {object} map the resolved `energy.shortfall_probability` map
 * @param {string} tier `T1` | `T2` | `T3`
 * @param {string|null|undefined} slaClass
 * @returns {number|undefined} the target, or `undefined` when it cannot be resolved
 */
function alphaFor(map, tier, slaClass) {
  const byClass =
    slaClass && map[slaClass] && typeof map[slaClass] === "object" ? map[slaClass][tier] : undefined;
  const alpha = tv.isNumber(byClass) ? byClass : map[tier];
  // @structural a probability target is a number strictly inside (0, 1); the bound is
  // Appendix A's own range for this parameter, not a tunable threshold
  if (!tv.isNumber(alpha) || alpha <= 0 || alpha >= 1) return undefined;
  return alpha;
}

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const mission = (context && context.mission) || null;
  const plan = (context && context.plan) || null;
  const config = context && context.config;

  if (!plan) return tv.absent("the candidate plan", { required: REQUIRED });

  // ── The derived targets ───────────────────────────────────────────────────
  // Resolved per SLA class: §14.5 writes α₁(class), and the register scopes
  // energy.shortfall_probability to `sla_class`.
  const alphaMap = tv.readParameter(config, "energy.shortfall_probability");
  if (alphaMap === undefined || alphaMap === null || typeof alphaMap !== "object") {
    return tv.absent("energy.shortfall_probability (the derived alpha[tier])", {
      required: REQUIRED,
      inputSource: "CONFIG",
      reason:
        "alpha[tier] is DERIVED from energy.event_budget_per_fleet_year over fleet scale (§14.5). " +
        "An unresolved derivation is not a licence to use a hand-set per-mission number",
    });
  }

  // ── The supplied probabilities ────────────────────────────────────────────
  const energy = plan.energy;
  if (energy === undefined) {
    return tv.absent("the plan's energy tier probabilities (§14.5)", {
      required: REQUIRED,
      inputSource: "PLAN",
      reason:
        "no shortfall probabilities are projected for this plan. Evaluating them is " +
        "engine/energy/tiers.js (Phase 7); computing a consumption distribution here would be a " +
        "second energy model, and feasibility is a property of the mission, not of the current charge",
    });
  }
  if (energy === null || typeof energy !== "object") {
    return tv.indeterminate({ required: REQUIRED, inputSource: "PLAN", reason: "the plan's energy projection is unreadable" });
  }

  const probabilities = energy.tierProbabilities;
  if (probabilities === undefined || probabilities === null || typeof probabilities !== "object") {
    return tv.indeterminate({
      required: REQUIRED,
      inputSource: "PLAN",
      reason: "the plan's energy projection states no per-tier shortfall probabilities (§14.5)",
    });
  }

  // ── Evaluate all three, simultaneously ────────────────────────────────────
  const slaClass = mission && mission.slaClass;
  const evaluated = [];

  for (const row of TIERS) {
    const target = alphaFor(alphaMap, row.tier, slaClass);

    if (!tv.isNumber(target)) {
      return tv.absent(`alpha[${row.tier}] for SLA class "${String(slaClass)}"`, {
        required: REQUIRED,
        inputSource: "CONFIG",
      });
    }

    const probability = probabilities[row.tier];
    if (!tv.isNumber(probability)) {
      return tv.indeterminate({
        observed: { tier: row.tier },
        required: { tier: row.tier, alpha: target },
        inputSource: "PLAN",
        reason:
          `no shortfall probability is projected for ${row.tier} (${row.event}). All three conditions ` +
          "must be evaluated; a tier that could not be evaluated is not one that holds (§14.5)",
      });
    }

    evaluated.push({
      ...row,
      target,
      probability,
      // The near-miss distance, in the tier's own units: how much probability mass
      // separates this plan from its target.
      margin: target - probability,
      // How many times over its own budget this tier is. **This, not the margin, is
      // what identifies the binding tier.** The targets differ by five orders of
      // magnitude (1e-2, 1e-5, 1e-7), so an absolute probability margin is not
      // commensurable across them: a T1 overshoot of 0.01 would always dominate a T3
      // overshoot of 0.001 in absolute terms, while the T3 case is four orders of
      // magnitude over its budget and the T1 case is merely double. Comparing the
      // ratio is what §14.5 means by "whichever tier's target is tightest relative to
      // the distribution's shape at that threshold".
      exceedance: target > 0 ? probability / target : Number.POSITIVE_INFINITY,
    });
  }

  // The binding tier is the one furthest over its own budget, measured relatively.
  const binding = evaluated.reduce((worst, row) => (row.exceedance > worst.exceedance ? row : worst));
  const failing = evaluated.filter((row) => row.probability > row.target);

  if (failing.length > 0) {
    // Where more than one tier fails, the most-exceeded is the binding one: it is the
    // condition that must move furthest for the mission to become feasible, and it is
    // the one whose consequence an operator must act on.
    const worst = failing.reduce((tightest, row) => (row.exceedance > tightest.exceedance ? row : tightest));
    return tv.violated({
      observed: {
        bindingTier: worst.tier,
        probability: worst.probability,
        event: worst.event,
        consequence: worst.consequence,
        tiers: evaluated.map((row) => ({ tier: row.tier, probability: row.probability, target: row.target, exceedance: row.exceedance })),
      },
      required: { tier: worst.tier, alpha: worst.target, reserves: worst.reserves },
      inputSource: "PLAN",
      margin: worst.margin,
      marginUnit: tv.MARGIN_UNIT.PROBABILITY,
      reason:
        `${worst.tier} shortfall probability ${worst.probability} exceeds its target ${worst.target} ` +
        `(${worst.event} — ${worst.consequence}). The binding tier is recorded because a fleet blocked ` +
        "on immobilisation risk and one blocked on divert-to-charge risk need different interventions (§14.5, §7.7)",
    });
  }

  return tv.satisfied({
    observed: {
      bindingTier: binding.tier,
      tiers: evaluated.map((row) => ({ tier: row.tier, probability: row.probability, target: row.target, exceedance: row.exceedance })),
    },
    required: { alpha: Object.fromEntries(evaluated.map((row) => [row.tier, row.target])) },
    inputSource: "PLAN",
    margin: binding.margin,
    marginUnit: tv.MARGIN_UNIT.PROBABILITY,
  });
}

module.exports = { evaluate, TIERS, TIER_NAMES };

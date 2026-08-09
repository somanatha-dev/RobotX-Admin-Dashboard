"use strict";

/**
 * The three shortfall tiers of F34 (§14.5) — **Tier 0**.
 *
 * > A single probability over "energy shortfall" cannot be evaluated for adequacy,
 * > because it conflates outcomes whose consequences differ by orders of magnitude.
 * > Consuming the contingency reserve is a diversion to charge and an operating-cost
 * > line. Breaching the return reserve requires a physical recovery mission. Reaching
 * > the hardware floor in active service immobilises the agent, possibly on a
 * > carriageway, a tram line, or a fire exit.
 *
 * ```
 * T1:  P[ E_usable(a) − E_mission(a,m) <  E_floor + E_return + E_contingency ]  ≤  α_1(class)
 * T2:  P[ E_usable(a) − E_mission(a,m) <  E_floor + E_return                 ]  ≤  α_2(class)
 * T3:  P[ E_usable(a) − E_mission(a,m) <  E_floor                            ]  ≤  α_3(class)
 * ```
 *
 * This module evaluates all three and produces exactly the object F34 consumes:
 * `plan.energy.tierProbabilities`. F34 compares those three probabilities against the
 * three derived targets and reports the binding tier; it does not model energy, and
 * this module does not decide feasibility. The split is deliberate and matches the
 * line Phase 5 drew in `supervision/progress.js`: one energy model, one gate, and
 * neither reimplementing the other.
 *
 * ── Rearranging the condition, and why it is worth writing down ─────────────
 * `P[ E_usable − E_mission < R ]` is `P[ E_mission > E_usable − R ]`. The threshold is
 * therefore *usable energy minus the reserve stack down to that tier* — a quantity in
 * Wh that shrinks as the reserves grow. Written that way the nesting is obvious: T3's
 * threshold is the largest (only `E_floor` subtracted), so T3's exceedance probability
 * is the smallest, and the probabilities are monotone non-increasing across the tiers
 * exactly as §14.5 states. `assertNested()` checks that property on the computed
 * values, which is the cheapest available test that the arithmetic did not get
 * inverted.
 *
 * ── α is derived, and this module refuses a hand-set one ────────────────────
 * > **The composed budget is the governed parameter; `α` is derived from it.**
 *
 * `alphaFor()` reads `energy.shortfall_probability`, which `config/derived.js` computes
 * as `event_budget_per_fleet_year[tier] / (N_agents · r_missions_per_agent_year)` and
 * which §22.1 rule 6 forbids binding by hand. Deriving in this direction is what stops
 * a per-mission number that "reads as stringent" from authorising a hundred reserve
 * breaches a day once composed over fleet scale.
 *
 * ── `E_operational` is not in any threshold ─────────────────────────────────
 * The three conditions name `E_floor`, `E_return`, and `E_contingency` and stop there.
 * `E_operational` is efficiency, not safety, and including it would make the safety
 * targets depend on a policy buffer an operator may release at will.
 *
 * Tier 0 (T0-03). Invariant I17. Decision path (T6): no clock, no randomness, no store.
 */

const { exceedanceProbability } = require("./consumption");

/**
 * §14.5's tier table: the event, its consequence, its §14.8 response, and the reserve
 * layers its threshold subtracts. The reserve compositions are the definition of the
 * three conditions and are stated here once.
 * @structural the specification's own tier table
 */
const TIERS = Object.freeze([
  Object.freeze({
    tier: "T1",
    event: "Contingency reserve consumed",
    consequence: "Diversion to charge; no incident",
    response: "Pre-reserve a charger; alert",
    reserveFields: Object.freeze(["floorWh", "returnWh", "contingencyWh"]),
  }),
  Object.freeze({
    tier: "T2",
    event: "Return reserve breached",
    consequence: "Physical recovery mission required",
    response: "Abort/divert while still possible; escalate",
    reserveFields: Object.freeze(["floorWh", "returnWh"]),
  }),
  Object.freeze({
    tier: "T3",
    event: "Hardware floor reached in active service",
    consequence: "Immobilisation; possible obstruction of a public right of way",
    response: "Controlled stop at the safest reachable location; always page",
    reserveFields: Object.freeze(["floorWh"]),
  }),
]);

const TIER_NAMES = Object.freeze(TIERS.map((row) => row.tier));

const ALPHA_PARAMETER = "energy.shortfall_probability";

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {object|Map} config
 * @param {string} name
 * @returns {*}
 */
function readParameter(config, name) {
  if (!config) return undefined;
  if (config instanceof Map) return config.get(name);
  if (typeof config.get === "function") return config.get(name);
  return config[name];
}

/**
 * The derived per-mission target for one tier, resolved at the SLA class §14.5 scopes
 * it to.
 *
 * @param {object|Map} config
 * @param {string} tier
 * @param {string|null} slaClass
 * @returns {{ ok: boolean, alpha: number|null, reason: string|null }}
 */
function alphaFor(config, tier, slaClass) {
  const map = readParameter(config, ALPHA_PARAMETER);
  if (!map || typeof map !== "object") {
    return {
      ok: false,
      alpha: null,
      reason:
        `${ALPHA_PARAMETER} is unresolved. α[tier] is DERIVED from ` +
        "energy.event_budget_per_fleet_year over fleet scale; an unresolved derivation is not a " +
        "licence to use a hand-set per-mission number (§14.5, §22.1 rule 6)",
    };
  }

  // The register scopes the map by SLA class, so a class-keyed entry wins over the
  // tier-keyed default when one is published.
  const byClass = slaClass && map[slaClass] && typeof map[slaClass] === "object" ? map[slaClass][tier] : undefined;
  const alpha = isNumber(byClass) ? byClass : map[tier];

  if (!isNumber(alpha) || alpha <= 0 || alpha >= 1) {
    return { ok: false, alpha: null, reason: `α[${tier}] is unresolved for SLA class "${String(slaClass)}"` };
  }
  return { ok: true, alpha, reason: null };
}

/**
 * The Wh threshold of one tier: `E_usable − Σ (that tier's reserve layers)`.
 *
 * @param {number} usableWh
 * @param {object} layers a `reserves.compose()` stack
 * @param {readonly string[]} reserveFields
 * @returns {{ ok: boolean, thresholdWh: number|null, reserveWh: number|null, missing: string[] }}
 */
function thresholdWh(usableWh, layers, reserveFields) {
  const missing = [];
  if (!isNumber(usableWh)) missing.push("usableWh");
  if (!layers) missing.push("reserveLayers");

  let reserveWh = 0;
  if (layers) {
    for (const field of reserveFields) {
      const value = layers[field];
      if (!isNumber(value)) missing.push(`reserve.${field}`);
      else reserveWh += value;
    }
  }

  if (missing.length > 0) return { ok: false, thresholdWh: null, reserveWh: null, missing };
  return { ok: true, thresholdWh: usableWh - reserveWh, reserveWh, missing: [] };
}

/**
 * §14.5's nesting property, checked on the computed values.
 *
 * > The three conditions are nested — T3's event implies T2's implies T1's.
 *
 * So `P(T1) ≥ P(T2) ≥ P(T3)`. A violation is not a marginal numerical artefact: it
 * means a reserve layer was negative, or a threshold was composed from the wrong
 * fields, and either would make one of the three conditions meaningless while all
 * three still returned numbers.
 *
 * @param {Record<string, number>} probabilities
 * @param {number} [toleranceProbability]
 * @returns {{ ok: boolean, problems: string[] }}
 */
function assertNested(probabilities, toleranceProbability) {
  // @structural floating-point slack on a probability comparison
  const tolerance = isNumber(toleranceProbability) ? toleranceProbability : 1e-12;
  const problems = [];
  for (let index = 1; index < TIER_NAMES.length; index += 1) {
    const outer = TIER_NAMES[index - 1];
    const inner = TIER_NAMES[index];
    const pOuter = probabilities ? probabilities[outer] : undefined;
    const pInner = probabilities ? probabilities[inner] : undefined;
    if (!isNumber(pOuter) || !isNumber(pInner)) continue;
    if (pInner > pOuter + tolerance) {
      problems.push(
        `P(${inner}) = ${pInner} exceeds P(${outer}) = ${pOuter}, but ${inner}'s event implies ` +
          `${outer}'s (§14.5). A reserve layer is negative or a threshold was composed from the wrong layers`,
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Evaluate all three conditions.
 *
 * All three are evaluated unconditionally — there is no early return on the first
 * failure. §14.5 requires it ("which tier bound, and by what margin, is recorded per
 * rejection"), and the binding tier is not knowable until every tier has a number.
 *
 * @param {object} input
 * @param {number} input.usableWh `E_usable(a)`
 * @param {{ meanWh: number, sdWh: number }} input.distribution the predictive
 *   distribution of `E_mission`
 * @param {object} input.layers a `reserves.compose()` stack
 * @param {object|Map} input.config the resolved configuration view
 * @param {string|null} [input.slaClass]
 * @returns {{ ok: boolean, tierProbabilities: object|null, tiers: object[],
 *             bindingTier: string|null, feasible: boolean|null, problems: string[] }}
 */
function evaluate(input) {
  const source = input || {};
  const problems = [];
  const rows = [];
  const tierProbabilities = {};

  for (const row of TIERS) {
    const threshold = thresholdWh(source.usableWh, source.layers, row.reserveFields);
    if (!threshold.ok) {
      problems.push(`${row.tier}: ${threshold.missing.join(", ")} unresolved`);
      continue;
    }

    const probability = exceedanceProbability(source.distribution, threshold.thresholdWh);
    if (!isNumber(probability)) {
      problems.push(`${row.tier}: the predictive distribution of E_mission could not be evaluated (§14.5)`);
      continue;
    }

    const target = alphaFor(source.config, row.tier, source.slaClass || null);
    if (!target.ok) {
      problems.push(`${row.tier}: ${target.reason}`);
      continue;
    }

    tierProbabilities[row.tier] = probability;
    rows.push({
      ...row,
      thresholdWh: threshold.thresholdWh,
      reserveWh: threshold.reserveWh,
      probability,
      target: target.alpha,
      holds: probability <= target.alpha,
      margin: target.alpha - probability,
      // The comparison that identifies the binding tier. Targets span 1e-2 to 1e-7, so
      // an absolute probability margin is not commensurable across them — F34 makes the
      // same choice for the same reason, and the two must agree or the tier recorded on
      // a rejection would not be the tier this module says binds.
      exceedance: target.alpha > 0 ? probability / target.alpha : Number.POSITIVE_INFINITY,
    });
  }

  if (problems.length > 0) {
    return { ok: false, tierProbabilities: null, tiers: rows, bindingTier: null, feasible: null, problems };
  }

  const nested = assertNested(tierProbabilities);
  if (!nested.ok) {
    return { ok: false, tierProbabilities: null, tiers: rows, bindingTier: null, feasible: null, problems: nested.problems };
  }

  const binding = rows.reduce((worst, row) => (row.exceedance > worst.exceedance ? row : worst));

  return {
    ok: true,
    tierProbabilities: Object.freeze(tierProbabilities),
    tiers: Object.freeze(rows.map((row) => Object.freeze({ ...row }))),
    bindingTier: binding.tier,
    feasible: rows.every((row) => row.holds),
    problems: [],
  };
}

/**
 * The `plan.energy` fragment F34 and F35 read, assembled from an `evaluate()` result and
 * a charger-reachability verdict.
 *
 * Assembling it here rather than in the plan builder keeps one module responsible for
 * the shape the two Tier 0 predicates depend on; Phase 8's plan builder attaches the
 * fragment to the plan it constructs.
 *
 * @param {ReturnType<typeof evaluate>} evaluated
 * @param {object|null} chargerReachability an `eReturn.evaluate()` verdict
 * @returns {{ tierProbabilities: object, chargerReachability: object|null }|null}
 */
function planEnergyFragment(evaluated, chargerReachability) {
  if (!evaluated || !evaluated.ok) return null;
  return Object.freeze({
    tierProbabilities: evaluated.tierProbabilities,
    chargerReachability: chargerReachability || null,
    bindingTier: evaluated.bindingTier,
    tiers: evaluated.tiers,
  });
}

module.exports = {
  TIERS,
  TIER_NAMES,
  ALPHA_PARAMETER,
  readParameter,
  alphaFor,
  thresholdWh,
  assertNested,
  evaluate,
  planEnergyFragment,
};

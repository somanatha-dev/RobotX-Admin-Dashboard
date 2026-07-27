"use strict";

/**
 * Derived parameters (§22.1 rule 6).
 *
 * > **Derived parameters are computed by the Config Service, never hand-entered.** A
 * > parameter whose value must satisfy an identity with another parameter is a
 * > derived parameter, and permitting it to be set by hand permits the identity to be
 * > violated silently.
 *
 * Four identities are computed here, each with its own reason for existing:
 *
 *   1. **`α[tier]`** (§14.5) — the per-mission energy shortfall probability targets of
 *      F34, derived from the governed fleet-year event budget. Deriving in this
 *      direction prevents the specific error of choosing a per-mission number that
 *      looks stringent — `1e-3` reads as "wrong less than once in a thousand" — while
 *      authorising roughly a hundred reserve breaches a day once composed over fleet
 *      scale. It also makes the target automatically re-derive when the fleet grows.
 *   2. **`energy.contingency_quantile`** (§14.5) — `1 − α₁`. Configuring the quantile
 *      and the tier-1 probability independently would permit them to contradict each
 *      other — a 0.95 quantile cannot deliver a 1e-2 tier-1 target — and the
 *      contradiction would be invisible because each value looks defensible alone.
 *   3. **`Ω_policy`** (§6.4, §8.6) — the sum of every declared `C_policy` credit
 *      ceiling. Introducing a new policy adjustment updates the candidate-pruning
 *      bound as a mechanical consequence of registering it, which is what prevents
 *      the bound from silently decaying as the policy register grows — the most
 *      likely way an admissible bound becomes inadmissible over a system's life.
 *   4. **Combined energy conservatism, nominal and degraded** (§14.3) — the products
 *      of the energy-domain derating factors. Layered fudge factors compound
 *      invisibly, and a fleet whose effective energy margin is 1.8× because four
 *      people each chose 1.15–1.25 will be quietly uneconomic without anyone having
 *      decided that.
 *
 * `Ω_terminal` (`cost.opportunity.max_terminal_gain`) is also derived, but **per
 * round** from the price snapshot the cost function uses, and it is published by the
 * Capacity Pricing Service alongside the price surface (§6.4). It is registered and
 * protected from hand entry here; its computation arrives with the pricing client.
 */

const ENERGY_SHORTFALL_TIERS = Object.freeze(["T1", "T2", "T3"]);

/**
 * The tier whose target sizes the contingency reserve (§14.5).
 */
const CONTINGENCY_TIER = "T1";

/**
 * Conservatism factors are multiplied together only within a single physical domain,
 * because a product across incommensurable quantities is not a meaningful number
 * (§14.3). Energy-domain factors all multiply the same quantity: a reserve in Wh.
 */
const ENERGY_DOMAIN = "energy";

/**
 * Every parameter this module computes. A binding for any of them is refused
 * (§22.1 rule 6).
 */
const DERIVED_PARAMETERS = Object.freeze([
  "energy.shortfall_probability",
  "energy.contingency_quantile",
  "cost.policy.max_total_credit",
  "energy.combined_nominal_conservatism",
  "energy.combined_degraded_conservatism",
  "cost.opportunity.max_terminal_gain",
]);

/**
 * Parameters derived outside the publish path, and where they are derived instead.
 */
const DERIVED_ELSEWHERE = Object.freeze({
  "cost.opportunity.max_terminal_gain":
    "derived per round by the Capacity Pricing Service from the round's price snapshot and published alongside it (§6.4)",
});

/**
 * Read a parameter's effective value out of a value map, tolerating absence.
 *
 * @param {Map<string, *>|object} values
 * @param {string} name
 * @returns {*}
 */
function readValue(values, name) {
  if (values instanceof Map) return values.get(name);
  return values ? values[name] : undefined;
}

/**
 * Is this a usable finite number?
 *
 * @param {*} value
 * @returns {boolean}
 */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * α[tier] = event_budget_per_fleet_year[tier] / (fleet.agent_count · fleet.missions_per_agent_year)
 *
 * @param {Map<string, *>|object} values effective values before derivation
 * @returns {{ value: Record<string, number>|null, problems: string[], inputs: object }}
 */
function deriveShortfallProbability(values) {
  const problems = [];
  const budgets = readValue(values, "energy.event_budget_per_fleet_year");
  const agents = readValue(values, "fleet.agent_count");
  const missions = readValue(values, "fleet.missions_per_agent_year");

  if (!budgets || typeof budgets !== "object") {
    problems.push(
      "energy.shortfall_probability cannot be derived: energy.event_budget_per_fleet_year is unset. " +
        "The composed fleet-year budget is the governed parameter and α is derived from it (§14.5)",
    );
  }
  if (!isFiniteNumber(agents) || agents <= 0) {
    problems.push("energy.shortfall_probability cannot be derived: fleet.agent_count is unset or not positive (§14.5)");
  }
  if (!isFiniteNumber(missions) || missions <= 0) {
    problems.push(
      "energy.shortfall_probability cannot be derived: fleet.missions_per_agent_year is unset or not positive (§14.5)",
    );
  }
  if (problems.length > 0) return { value: null, problems, inputs: { budgets, agents, missions } };

  const missionsPerFleetYear = agents * missions;
  const value = {};
  for (const tier of ENERGY_SHORTFALL_TIERS) {
    const budget = budgets[tier];
    if (!isFiniteNumber(budget) || budget < 0) {
      problems.push(
        `energy.shortfall_probability[${tier}] cannot be derived: ` +
          `energy.event_budget_per_fleet_year[${tier}] is unset or negative (§14.5)`,
      );
      continue;
    }
    value[tier] = budget / missionsPerFleetYear;
  }

  return {
    value: problems.length === 0 ? value : null,
    problems,
    inputs: { budgets, agents, missions, missionsPerFleetYear },
  };
}

/**
 * energy.contingency_quantile = 1 − α[T1]
 *
 * @param {Record<string, number>|null} alpha
 * @returns {{ value: number|null, problems: string[] }}
 */
function deriveContingencyQuantile(alpha) {
  if (!alpha || !isFiniteNumber(alpha[CONTINGENCY_TIER])) {
    return {
      value: null,
      problems: [
        `energy.contingency_quantile cannot be derived: α[${CONTINGENCY_TIER}] is unavailable. ` +
          "The contingency reserve is sized at the quantile that satisfies T1, so the two cannot " +
          "be configured independently (§14.5)",
      ],
    };
  }
  return { value: 1 - alpha[CONTINGENCY_TIER], problems: [] };
}

/**
 * Ω_policy = Σ (credit ceiling of each C_policy adjustment).
 *
 * @param {Iterable<object>} entries the parameter register
 * @param {Map<string, *>|object} values effective values
 * @returns {{ value: number|null, problems: string[], ceilings: object }}
 */
function derivePolicyTotalCredit(entries, values) {
  const problems = [];
  const ceilings = {};
  let total = 0;

  for (const entry of entries) {
    if (!entry.creditCeiling) continue;
    const value = readValue(values, entry.name);
    if (!isFiniteNumber(value) || value < 0) {
      problems.push(
        `cost.policy.max_total_credit cannot be derived: "${entry.name}" declares no usable credit ` +
          "ceiling. Every C_policy adjustment MUST declare a credit ceiling — those ceilings are " +
          "what make the candidate-pruning lower bound admissible, and an adjustment without one " +
          "is rejected at publish (§8.6, §6.4)",
      );
      continue;
    }
    ceilings[entry.name] = value;
    total += value;
  }

  if (Object.keys(ceilings).length === 0) {
    problems.push(
      "cost.policy.max_total_credit cannot be derived: no C_policy adjustment declares a credit " +
        "ceiling. Ω_policy bounds the negative part of C_policy in the pruning bound (§6.4)",
    );
  }

  return { value: problems.length === 0 ? total : null, problems, ceilings };
}

/**
 * The combined nominal and degraded energy conservatism (§14.3).
 *
 * Every conservatism factor declares, in its register entry, what uncertainty it
 * compensates for. Two factors compensating for the *same* uncertainty is a defect,
 * not extra safety, and the declaration is what makes the duplication visible.
 *
 * @param {Iterable<object>} entries
 * @param {Map<string, *>|object} values
 * @returns {{ nominal: number, degraded: number, problems: string[],
 *             factors: { nominal: object, degraded: object },
 *             duplicateCompensations: string[] }}
 */
function deriveCombinedConservatism(entries, values) {
  const problems = [];
  const nominalFactors = {};
  const degradedOnlyFactors = {};
  const compensations = new Map();

  for (const entry of entries) {
    const declaration = entry.conservatism;
    if (!declaration) continue;
    const domain = declaration.domain || ENERGY_DOMAIN;
    if (domain !== ENERGY_DOMAIN) continue;

    if (!declaration.compensates || String(declaration.compensates).trim() === "") {
      problems.push(
        `"${entry.name}" is a conservatism factor that does not declare what uncertainty it ` +
          "compensates for. That declaration is what makes duplicated conservatism visible (§14.3)",
      );
      continue;
    }

    const value = readValue(values, entry.name);
    if (!isFiniteNumber(value) || value < 1) {
      problems.push(
        `"${entry.name}" is a conservatism factor whose value ${String(value)} is unusable; a ` +
          "derating factor is a finite multiplier of at least 1 (§14.3)",
      );
      continue;
    }

    const seen = compensations.get(declaration.compensates);
    if (seen) compensations.set(declaration.compensates, [...seen, entry.name]);
    else compensations.set(declaration.compensates, [entry.name]);

    if (declaration.activeInNominal) nominalFactors[entry.name] = value;
    else if (declaration.activeInDegraded) degradedOnlyFactors[entry.name] = value;
  }

  const product = (factors) => Object.values(factors).reduce((accumulator, value) => accumulator * value, 1);
  const nominal = product(nominalFactors);
  const degraded = nominal * product(degradedOnlyFactors);

  const duplicateCompensations = [];
  for (const [uncertainty, names] of compensations.entries()) {
    if (names.length > 1) {
      duplicateCompensations.push(
        `${names.join(" and ")} both compensate for "${uncertainty}". Two factors compensating for ` +
          "the same uncertainty is a defect, not extra safety (§14.3)",
      );
    }
  }

  return {
    nominal,
    degraded,
    problems,
    factors: { nominal: nominalFactors, degradedOnly: degradedOnlyFactors },
    duplicateCompensations,
  };
}

/**
 * Compute every publish-time derived parameter.
 *
 * @param {Map<string, object>} entries the parameter register, by name
 * @param {Map<string, *>|object} values effective values with derived entries absent
 * @returns {{ values: Map<string, *>, problems: string[], evidence: object }}
 */
function computeDerived(entries, values) {
  const problems = [];
  const derivedValues = new Map();
  const entryList = [...entries.values()];

  const alpha = deriveShortfallProbability(values);
  problems.push(...alpha.problems);
  if (alpha.value) derivedValues.set("energy.shortfall_probability", alpha.value);

  const quantile = deriveContingencyQuantile(alpha.value);
  problems.push(...quantile.problems);
  if (quantile.value !== null) derivedValues.set("energy.contingency_quantile", quantile.value);

  const omegaPolicy = derivePolicyTotalCredit(entryList, values);
  problems.push(...omegaPolicy.problems);
  if (omegaPolicy.value !== null) derivedValues.set("cost.policy.max_total_credit", omegaPolicy.value);

  const conservatism = deriveCombinedConservatism(entryList, values);
  problems.push(...conservatism.problems);
  derivedValues.set("energy.combined_nominal_conservatism", conservatism.nominal);
  derivedValues.set("energy.combined_degraded_conservatism", conservatism.degraded);

  return {
    values: derivedValues,
    problems,
    evidence: {
      shortfallProbability: alpha,
      contingencyQuantile: quantile,
      policyTotalCredit: omegaPolicy,
      conservatism,
    },
  };
}

/**
 * §22.1 rule 6 enforcement: a derived parameter may not be bound by hand.
 *
 * @param {Array<{ name: string, level?: string, key?: string }>} bindings
 * @returns {string[]} problems
 */
function rejectHandEnteredDerived(bindings) {
  const problems = [];
  for (const binding of bindings || []) {
    if (!DERIVED_PARAMETERS.includes(binding.name)) continue;
    const elsewhere = DERIVED_ELSEWHERE[binding.name];
    problems.push(
      `"${binding.name}" is a derived parameter and was set by hand at scope ` +
        `${binding.level || "global"}${binding.key ? `:${binding.key}` : ""}. Derived parameters are ` +
        `computed by the Config Service, never hand-entered — permitting it to be set by hand permits ` +
        `the identity to be violated silently (§22.1 rule 6)` +
        (elsewhere ? `. This one is ${elsewhere}` : ""),
    );
  }
  return problems;
}

module.exports = {
  ENERGY_SHORTFALL_TIERS,
  CONTINGENCY_TIER,
  ENERGY_DOMAIN,
  DERIVED_PARAMETERS,
  DERIVED_ELSEWHERE,
  deriveShortfallProbability,
  deriveContingencyQuantile,
  derivePolicyTotalCredit,
  deriveCombinedConservatism,
  computeDerived,
  rejectHandEnteredDerived,
};

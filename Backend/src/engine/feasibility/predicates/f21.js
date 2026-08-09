"use strict";

/**
 * **F21 — `RequirementSet(m) ⊆ CapabilityBundle(a)` under the typed algebra of §2.3.**
 * Class I. Indeterminate: `DENY`.
 *
 * > Functional suitability; the baseline treats every robot as interchangeable, which
 * > is safe only in a homogeneous fleet and **silently wrong in any other**.
 *
 * ── The algebra is not reimplemented here ───────────────────────────────────
 * `domain/capability.js` is the typed algebra: five capability kinds, five
 * comparators, certification validity against mission end, and the three-outcome
 * match. Phase 2 built it with this predicate named as its consumer — *"F21 consumes
 * the result shape below and maps `INDETERMINATE` through the policy that predicate
 * declares"* — so this module supplies the mission end, calls `matchRequirements`, and
 * translates the outcome. A second comparison written here would be a second place for
 * the threshold semantics to drift.
 *
 * ── The binding requirement, not "capability mismatch" ──────────────────────
 * §7.7 requires the rejection tuple to name the *binding* requirement with its
 * observed and required values. `matchRequirements` returns exactly that in its
 * `binding` field, which is why the algebra returns structured matches rather than a
 * boolean: "this agent cannot carry this mission" is unactionable, and
 * "`max_payload_mass` is 12 kg and the mission needs 18 kg" is a purchasing decision.
 *
 * ── Cached at §7.6 tier 2 ───────────────────────────────────────────────────
 * §7.6 lists F21 in both the agent-invariant tier ("F1–F12, F21 partially") and the
 * `(agent_class, mission_class, zone)` tier. The register assigns it the **more
 * specific** of the two: the requirement set varies by mission class, so a
 * per-agent-only key would serve one mission class's verdict to another's. Caching at
 * the coarser tier is a correctness hazard; caching at the finer one is only a lower
 * hit rate.
 *
 * Tier 0 (T0-01, T0-04).
 */

const tv = require("../threeValued");
const { MATCH, matchRequirements } = require("../../domain/capability");

const REQUIRED = "every mission requirement satisfied by the agent's attested capability bundle";

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = (context && context.agentSnapshot) || null;
  const mission = (context && context.mission) || null;
  const plan = (context && context.plan) || null;

  if (!agent) return tv.absent("the agent snapshot", { required: REQUIRED });
  if (!mission) return tv.absent("the mission", { required: REQUIRED });

  const requirements = mission.requirements;
  if (requirements === undefined) {
    return tv.absent("the mission's RequirementSet", { required: REQUIRED, inputSource: "CONTROL_PLANE" });
  }
  if (requirements === null || !Array.isArray(requirements)) {
    return tv.indeterminate({
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
      reason: "the mission's RequirementSet is not a list; containment cannot be evaluated (§2.3)",
    });
  }

  if (agent.capabilityBundle === undefined) {
    return tv.absent("the agent's attested CapabilityBundle", {
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
    });
  }

  // §2.3 requires certified capabilities to be checked against **mission end time**.
  // Supplied, never read from a clock: the algebra takes it as an argument precisely
  // so this predicate decides which instant applies (T6, §9.6).
  const missionEndEpochMs = tv.epochMs(plan && plan.projectedEndMs);

  const outcome = matchRequirements(agent.capabilityBundle, requirements, { missionEndEpochMs });
  const binding = outcome.binding;

  if (outcome.outcome === MATCH.VIOLATED) {
    return tv.violated({
      observed: binding ? binding.observed : null,
      required: binding ? { name: binding.name, comparator: binding.comparator, value: binding.required } : REQUIRED,
      inputSource: "CONTROL_PLANE",
      // A numeric threshold miss carries a distance; a set or boolean miss does not,
      // and reporting zero for those would poison the near-miss sketch (§7.7).
      margin:
        binding && tv.isNumber(binding.observed) && tv.isNumber(binding.required)
          ? binding.observed - binding.required
          : null,
      marginUnit: tv.MARGIN_UNIT.RATIO,
      reason: `requirement "${binding ? binding.name : "<unknown>"}" is not satisfied by the agent's bundle (§2.3, §7.5 F21)`,
    });
  }

  if (outcome.outcome === MATCH.INDETERMINATE) {
    return tv.indeterminate({
      observed: binding ? binding.observed : null,
      required: binding ? { name: binding.name, comparator: binding.comparator, value: binding.required } : REQUIRED,
      inputSource: "CONTROL_PLANE",
      reason:
        (binding && binding.reason) ||
        `requirement "${binding ? binding.name : "<unknown>"}" could not be evaluated against the bundle (§2.3)`,
    });
  }

  return tv.satisfied({
    observed: { requirementsMatched: outcome.matches.length },
    required: REQUIRED,
    inputSource: "CONTROL_PLANE",
  });
}

module.exports = { evaluate };

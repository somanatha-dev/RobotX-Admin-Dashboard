"use strict";

/**
 * Observations and freshness (§2.7).
 *
 * > **Every fact about the physical world is an Observation, never a bare value.**
 *
 * > Every consumer of an Observation declares a **staleness budget**. Exceeding it
 * > makes the value `INDETERMINATE`, which is a distinct outcome from "absent" and
 * > from "present". This eliminates by construction the baseline's registry-expiry
 * > cliff, in which several inputs simultaneously degraded to their *most
 * > permissive* defaults precisely when an agent had stopped reporting — that is,
 * > when a negative signal was silently read as positive.
 *
 * The three-outcome return of `assess()` is the whole point of this module. A
 * function that returned a value-or-null would reintroduce the cliff: `null` would
 * be handled by whatever default each call site happened to choose, and the
 * baseline's defect is precisely that those defaults were permissive.
 *
 * ── Determinism ─────────────────────────────────────────────────────────────
 * `assess()` takes the evaluation time as an argument. It never reads a clock. In
 * the decision path that argument is the round's pinned `decision_time` (§9.6
 * requirement 4), which is what makes a freshness verdict replayable; a module that
 * read `Date.now()` would make every replay disagree with the original.
 */

/**
 * §2.7's provenance values. `source` is recorded on every Observation because the
 * trust rules of §23.5 are stated per source, not per field.
 * @structural provenance labels
 */
const OBSERVATION_SOURCE = Object.freeze({
  SENSOR: "SENSOR",
  AGENT_REPORT: "AGENT_REPORT",
  INFERRED: "INFERRED",
  OPERATOR_ENTERED: "OPERATOR_ENTERED",
  FORECAST: "FORECAST",
});

const OBSERVATION_SOURCES = Object.freeze(Object.values(OBSERVATION_SOURCE));

/**
 * The three outcomes of a freshness assessment, matching §7.3's vocabulary so
 * Phase 6's predicates lift them without translation.
 * @structural outcome labels
 */
const FRESHNESS = Object.freeze({
  FRESH: "FRESH",
  ABSENT: "ABSENT",
  INDETERMINATE: "INDETERMINATE",
});

/**
 * Build an Observation record.
 *
 * `observedAt` — when the **agent** measured it — is mandatory and is never
 * defaulted to the receipt time. Defaulting it would silently make every
 * observation maximally fresh at exactly the moment the link degraded, which is the
 * failure this whole section exists to prevent.
 *
 * @param {object} fields
 * @param {string} fields.agentId
 * @param {string} fields.kind position | soc | velocity | localisation_confidence | …
 * @param {*} fields.value
 * @param {Date|string|number} fields.observedAt
 * @param {Date|string|number} [fields.receivedAt]
 * @param {string} fields.source one of OBSERVATION_SOURCE
 * @param {number} [fields.confidence]
 * @param {number} [fields.variance]
 * @param {bigint|number} [fields.sequence] per-agent monotonic
 * @param {boolean} [fields.deadReckoned]
 * @param {number} [fields.uncertaintyRadiusM]
 * @returns {object} a frozen Observation
 * @throws {Error} when a mandatory provenance field is missing
 */
function createObservation(fields) {
  const problems = validateObservation(fields);
  if (problems.length > 0) {
    throw new Error(`invalid Observation (§2.7): ${problems.join("; ")}`);
  }

  return Object.freeze({
    agentId: String(fields.agentId),
    kind: String(fields.kind),
    value: fields.value,
    observedAt: new Date(fields.observedAt),
    receivedAt: fields.receivedAt === undefined || fields.receivedAt === null ? null : new Date(fields.receivedAt),
    source: fields.source,
    confidence: fields.confidence === undefined ? null : fields.confidence,
    variance: fields.variance === undefined ? null : fields.variance,
    sequence: fields.sequence === undefined || fields.sequence === null ? null : BigInt(fields.sequence),
    deadReckoned: Boolean(fields.deadReckoned),
    uncertaintyRadiusM:
      fields.uncertaintyRadiusM === undefined || fields.uncertaintyRadiusM === null
        ? null
        : Number(fields.uncertaintyRadiusM),
  });
}

/**
 * @param {object} fields
 * @returns {string[]} problems, empty when well-formed
 */
function validateObservation(fields) {
  const problems = [];
  if (!fields || typeof fields !== "object") return ["observation is not an object"];

  if (typeof fields.agentId !== "string" || fields.agentId.length === 0) problems.push("no agentId");
  if (typeof fields.kind !== "string" || fields.kind.length === 0) problems.push("no kind");
  if (fields.value === undefined) problems.push("no value");

  const observedAt = fields.observedAt === undefined || fields.observedAt === null ? null : new Date(fields.observedAt);
  if (observedAt === null || Number.isNaN(observedAt.getTime())) {
    problems.push("no valid observedAt — when the agent measured it, not when the server stored it");
  }

  if (!OBSERVATION_SOURCES.includes(fields.source)) {
    problems.push(`source "${String(fields.source)}" is not one of ${OBSERVATION_SOURCES.join(", ")}`);
  }

  if (fields.deadReckoned && (fields.uncertaintyRadiusM === undefined || fields.uncertaintyRadiusM === null)) {
    problems.push(
      "a dead-reckoned position must carry its uncertainty radius: §2.7 requires extrapolation to be marked " +
        "as such, with a growing uncertainty radius",
    );
  }

  return problems;
}

/**
 * Assess an Observation against a consumer's declared staleness budget (§2.7).
 *
 * @param {object|null|undefined} observation
 * @param {object} options
 * @param {number} options.stalenessBudgetMs the consumer's declared budget. Every
 *   consumer declares one; there is no default, because a default budget is a
 *   behavioural constant and §22.1 rule 1 puts those in the register.
 * @param {number} options.atEpochMs the evaluation time — the round's pinned
 *   `decision_time` in the decision path (§9.6), never a clock read
 * @returns {{ freshness: string, ageMs: number|null, value: *, reason: string }}
 */
function assess(observation, options) {
  const budget = options && options.stalenessBudgetMs;
  const at = options && options.atEpochMs;

  if (typeof budget !== "number" || !Number.isFinite(budget)) {
    return {
      freshness: FRESHNESS.INDETERMINATE,
      ageMs: null,
      value: null,
      reason:
        "the consumer declared no staleness budget. §2.7 requires every consumer to declare one; " +
        "evaluating without a budget would be the permissive default this rule exists to remove",
    };
  }

  if (!observation || typeof observation !== "object") {
    return { freshness: FRESHNESS.ABSENT, ageMs: null, value: null, reason: "no observation of this fact exists" };
  }

  if (typeof at !== "number" || !Number.isFinite(at)) {
    return {
      freshness: FRESHNESS.INDETERMINATE,
      ageMs: null,
      value: observation.value,
      reason: "no evaluation time was supplied; freshness cannot be established",
    };
  }

  const observedAtMs = new Date(observation.observedAt).getTime();
  if (!Number.isFinite(observedAtMs)) {
    return {
      freshness: FRESHNESS.INDETERMINATE,
      ageMs: null,
      value: observation.value,
      reason: "the observation carries no readable observedAt",
    };
  }

  const ageMs = at - observedAtMs;

  // A measurement stamped in the future is not fresh; it is a clock disagreement,
  // and §10.6's clock discipline treats that as a fault rather than as freshness.
  if (ageMs < 0) {
    return {
      freshness: FRESHNESS.INDETERMINATE,
      ageMs,
      value: observation.value,
      reason: "observedAt is in the future relative to the evaluation time (clock skew, §10.6)",
    };
  }

  if (ageMs > budget) {
    return {
      freshness: FRESHNESS.INDETERMINATE,
      ageMs,
      value: observation.value,
      reason: `age ${ageMs} ms exceeds the consumer's staleness budget of ${budget} ms (§2.7)`,
    };
  }

  return { freshness: FRESHNESS.FRESH, ageMs, value: observation.value, reason: "within the declared staleness budget" };
}

/**
 * §2.7: "Extrapolation is permitted for cost estimation and **prohibited for safety
 * constraints**."
 *
 * Stated as a function so a safety predicate asks the question rather than
 * remembering the rule.
 *
 * @param {object|null|undefined} observation
 * @param {{ purpose: "COST_ESTIMATION"|"SAFETY_CONSTRAINT" }} use
 * @returns {boolean} whether this observation may be used for this purpose
 */
function isAdmissibleFor(observation, use) {
  if (!observation || typeof observation !== "object") return false;
  if (!use || use.purpose !== "SAFETY_CONSTRAINT") return true;
  return observation.deadReckoned !== true;
}

/**
 * §2.7: the sequence number is per-agent monotonic, for ordering and replay
 * detection. An out-of-order or repeated sequence is a replay, not a fresher fact.
 *
 * @param {object} candidate the newly arrived observation
 * @param {object|null|undefined} highWaterMark the newest already accepted for this
 *   agent, or null when none has been
 * @returns {boolean} whether the candidate advances the agent's sequence
 */
function advancesSequence(candidate, highWaterMark) {
  const next = candidate && candidate.sequence;
  if (next === null || next === undefined) return false;
  const previous = highWaterMark && highWaterMark.sequence;
  if (previous === null || previous === undefined) return true;
  return BigInt(next) > BigInt(previous);
}

module.exports = {
  OBSERVATION_SOURCE,
  OBSERVATION_SOURCES,
  FRESHNESS,
  createObservation,
  validateObservation,
  assess,
  isAdmissibleFor,
  advancesSequence,
};

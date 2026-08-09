"use strict";

/**
 * **F10 — Localisation confidence ≥ threshold for the mission's environment,
 * corroborated independently of the localisation stack itself.** Class I.
 * Indeterminate: `DENY`.
 *
 * > An agent that does not reliably know where it is cannot be safely dispatched into
 * > shared space. **Self-reported pose covariance alone is insufficient: localisation
 * > failures are frequently *confidently wrong*, which is what makes them dangerous
 * > rather than merely inconvenient**, and gating on the failing subsystem's own
 * > opinion of itself contradicts the asymmetric-trust rule of §23.5. The predicate
 * > therefore requires the reported covariance **and** at least one corroborating
 * > signal — agreement with an independent positioning source where one exists,
 * > map-matching residual within bounds, or divergence between odometry and the last
 * > accepted fix within `localisation.max_odometry_divergence`. **Corroboration
 * > unavailable is `INDETERMINATE`, not satisfied.**
 *
 * ── The corroboration requirement is the predicate ──────────────────────────
 * This is the one predicate in the register whose specification spends more words on
 * *how* to establish the fact than on the fact itself, and the reason is stated: a
 * localisation stack that has failed will report high confidence in a wrong pose. Its
 * covariance is therefore evidence about a subsystem produced *by that subsystem*, and
 * §23.5 says such evidence cannot be the sole basis of a safety decision.
 *
 * The execution plan states the requirement as a completion criterion in its own
 * right — *"F10 requires independent corroboration"* — so this module implements the
 * conjunction literally:
 *
 *     SATISFIED  ⟺  confidence ≥ threshold  ∧  at least one corroborator agrees
 *
 * and *no* corroborator available is `INDETERMINATE`, which under class I denies.
 *
 * ── The three corroborators §7.5 enumerates ─────────────────────────────────
 *   1. `INDEPENDENT_FIX`  — agreement with an independent positioning source, where
 *      one exists. Agreement is a distance compared against the same divergence bound.
 *   2. `MAP_MATCH`        — map-matching residual within bounds.
 *   3. `ODOMETRY`         — divergence between odometry and the last accepted fix
 *      within `localisation.max_odometry_divergence`.
 *
 * A corroborator that is *present and disagreeing* is `VIOLATED`, not merely
 * "unavailable": a positioning source that contradicts the reported pose is the
 * strongest evidence this predicate can obtain, and discarding it as unhelpful would
 * invert its meaning.
 *
 * On the volatile subset (§10.3.2 step 3).
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");

/**
 * The three corroborating signals §7.5 F10 enumerates.
 * @structural the specification's own corroborator kinds
 */
const CORROBORATOR = Object.freeze({
  INDEPENDENT_FIX: "INDEPENDENT_FIX",
  MAP_MATCH: "MAP_MATCH",
  ODOMETRY: "ODOMETRY",
});

const CORROBORATORS = Object.freeze(Object.values(CORROBORATOR));

const REQUIRED = "localisation confidence at or above threshold, independently corroborated";

/**
 * Assess one corroborator against the divergence bound.
 *
 * Every corroborator reduces to the same question — *how far apart are two estimates
 * of the same position, and is that within bounds* — which is why one bound governs
 * all three. `divergenceM` is the metric each supplies; `MAP_MATCH` supplies its
 * residual, `INDEPENDENT_FIX` the distance between fixes, `ODOMETRY` the drift since
 * the last accepted fix.
 *
 * @param {object} corroborator
 * @param {number} maxDivergenceM
 * @returns {{ kind: string, verdict: "AGREES"|"DISAGREES"|"UNAVAILABLE", divergenceM: number|null }}
 */
function assessCorroborator(corroborator, maxDivergenceM) {
  const kind = corroborator && corroborator.kind;
  if (!CORROBORATORS.includes(kind)) {
    return { kind: String(kind), verdict: "UNAVAILABLE", divergenceM: null };
  }
  if (corroborator.available === false) {
    return { kind, verdict: "UNAVAILABLE", divergenceM: null };
  }
  const divergenceM = corroborator.divergenceM;
  if (!tv.isNumber(divergenceM)) {
    return { kind, verdict: "UNAVAILABLE", divergenceM: null };
  }
  return {
    kind,
    verdict: divergenceM <= maxDivergenceM ? "AGREES" : "DISAGREES",
    divergenceM,
  };
}

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = (context && context.agentSnapshot) || null;
  const mission = (context && context.mission) || null;
  const config = context && context.config;

  if (!agent) return tv.absent("the agent snapshot", { required: REQUIRED });

  const localisation = agent.localisation;
  if (localisation === undefined || localisation === null) {
    return tv.absent("the agent's localisation state", { required: REQUIRED, inputSource: "SENSOR" });
  }

  const maxDivergenceM = tv.readParameter(config, "localisation.max_odometry_divergence");
  if (!tv.isNumber(maxDivergenceM)) {
    return tv.indeterminate({
      required: REQUIRED,
      inputSource: "CONFIG",
      reason:
        "localisation.max_odometry_divergence is unresolved; the corroboration bound §7.5 F10 " +
        "requires cannot be applied",
    });
  }

  // ── Half one: the reported confidence ─────────────────────────────────────
  const environment = (mission && mission.environment) || null;
  const threshold =
    mission && tv.isNumber(mission.requiredLocalisationConfidence)
      ? mission.requiredLocalisationConfidence
      : tv.readIndexedParameter(config, "localisation.min_confidence", environment);

  if (!tv.isNumber(threshold)) {
    return tv.absent(`the localisation confidence threshold for environment "${String(environment)}"`, {
      observed: { confidence: localisation.confidence === undefined ? null : localisation.confidence },
      required: REQUIRED,
      inputSource: "CONFIG",
    });
  }

  const confidence = localisation.confidence;
  if (!tv.isNumber(confidence)) {
    return tv.absent("the reported localisation confidence", {
      required: { minConfidence: threshold },
      inputSource: "SENSOR",
    });
  }

  // ── Half two: independent corroboration ───────────────────────────────────
  // Evaluated *before* the confidence comparison short-circuits, because a
  // disagreeing corroborator must dominate a high self-reported confidence. That
  // ordering is the whole content of "confidently wrong".
  const declared = Array.isArray(localisation.corroborations) ? localisation.corroborations : null;

  if (declared === null) {
    return tv.indeterminate({
      observed: { confidence },
      required: { minConfidence: threshold, corroboration: "at least one independent signal" },
      inputSource: "SENSOR",
      reason:
        "no corroborating signals were supplied. §7.5 F10: corroboration unavailable is " +
        "INDETERMINATE, not satisfied — self-reported pose covariance alone is insufficient",
    });
  }

  const assessed = declared.map((corroborator) => assessCorroborator(corroborator, maxDivergenceM));
  const disagreeing = assessed.find((entry) => entry.verdict === "DISAGREES") || null;
  const agreeing = assessed.filter((entry) => entry.verdict === "AGREES");

  if (disagreeing) {
    return tv.violated({
      observed: { confidence, corroborator: disagreeing.kind, divergenceM: disagreeing.divergenceM },
      required: { minConfidence: threshold, maxDivergenceM },
      inputSource: "SENSOR",
      margin: maxDivergenceM - disagreeing.divergenceM,
      marginUnit: tv.MARGIN_UNIT.METRES,
      reason:
        `corroborator ${disagreeing.kind} diverges by ${disagreeing.divergenceM} m, beyond the ` +
        `${maxDivergenceM} m bound. An independent source contradicting the reported pose is the ` +
        "strongest evidence available to this predicate, and it outranks the reported confidence (§7.5 F10)",
    });
  }

  if (agreeing.length === 0) {
    return tv.indeterminate({
      observed: { confidence, corroboratorsOffered: assessed.length },
      required: { minConfidence: threshold, corroboration: "at least one independent signal" },
      inputSource: "SENSOR",
      reason:
        "every corroborating signal offered was unavailable or unreadable. §7.5 F10 requires the " +
        "reported covariance **and** at least one corroborating signal; gating on the localisation " +
        "stack's own opinion of itself contradicts §23.5",
    });
  }

  if (confidence < threshold) {
    return tv.violated({
      observed: { confidence, corroboratedBy: agreeing.map((entry) => entry.kind) },
      required: { minConfidence: threshold },
      inputSource: "SENSOR",
      margin: confidence - threshold,
      marginUnit: tv.MARGIN_UNIT.RATIO,
      reason: `localisation confidence ${confidence} is below the ${threshold} required in environment "${String(environment)}" (§7.5 F10)`,
    });
  }

  return tv.satisfied({
    observed: {
      confidence,
      corroboratedBy: agreeing.map((entry) => entry.kind),
      worstDivergenceM: Math.max(...agreeing.map((entry) => entry.divergenceM)),
    },
    required: { minConfidence: threshold, maxDivergenceM },
    inputSource: "SENSOR",
    margin: confidence - threshold,
    marginUnit: tv.MARGIN_UNIT.RATIO,
  });
}

module.exports = { evaluate, CORROBORATOR, CORROBORATORS, assessCorroborator };

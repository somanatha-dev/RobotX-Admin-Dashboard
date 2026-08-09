"use strict";

/**
 * **F31 — Environmental envelope satisfied over the projected mission window using
 * forecast, not current, conditions.** Class I. Indeterminate: `DENY`.
 *
 * > **Dispatching into a forecast storm because it is currently dry is a foreseeable
 * > failure.**
 *
 * ── "Forecast, not current" is the entire predicate ─────────────────────────
 * Current conditions are the wrong input, and this is the one predicate where using
 * the *better-measured* value is the mistake. A rain gauge reading is accurate, fresh,
 * and irrelevant to a mission that finishes in ninety minutes. §7.5 names the input
 * explicitly, so this module refuses an observation whose source is not `FORECAST` —
 * accepting a `SENSOR` reading here would be substituting a precise answer to the
 * wrong question.
 *
 * ── The envelope is checked against the forecast's worst case in the window ─
 * A forecast over a window is a series, not a value. The relevant quantity for a
 * safety envelope is the **worst** value in the window, not the mean or the value at
 * departure: an agent rated to 40 km/h gusts is not made safe by a window whose
 * average gust is 20 km/h.
 *
 * ── Forecast uncertainty is not smoothed away here ──────────────────────────
 * Where the forecast supplies a confidence bound, the bound is what binds — the same
 * discipline §15.1 applies to declared mass, and §14.5 to consumption variance: a
 * safety constraint is evaluated against the pessimistic end of the distribution, and
 * the expectation belongs to cost estimation.
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");
const { OBSERVATION_SOURCE } = require("../../domain/observation");

const REQUIRED = "every environmental variable within the agent's envelope across the projected window";

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = (context && context.agentSnapshot) || null;
  const plan = (context && context.plan) || null;

  if (!agent) return tv.absent("the agent snapshot", { required: REQUIRED });
  if (!plan) return tv.absent("the candidate plan", { required: REQUIRED });

  const envelope = agent.mobilityModel && agent.mobilityModel.envelopeConstraints;
  if (envelope === undefined || envelope === null) {
    return tv.absent("the agent's environmental envelope", {
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
      reason: "§2.2 requires the envelope constraints to be declared; an absent one is a gap, not an unbounded envelope",
    });
  }

  const limits = envelope.environmental;
  if (limits === undefined || limits === null || typeof limits !== "object") {
    return tv.absent("the agent's environmental limits", { required: REQUIRED, inputSource: "CONTROL_PLANE" });
  }

  const forecast = plan.environmentForecast;
  if (forecast === undefined) {
    return tv.absent("the projected-window environmental forecast", {
      required: REQUIRED,
      inputSource: "FORECAST",
      reason:
        "no forecast is pinned for the projected mission window. Current conditions are not a " +
        "substitute: dispatching into a forecast storm because it is currently dry is a foreseeable " +
        "failure (§7.5 F31)",
    });
  }
  if (forecast === null || typeof forecast !== "object") {
    return tv.indeterminate({ required: REQUIRED, inputSource: "FORECAST", reason: "the environmental forecast is unreadable" });
  }

  if (forecast.source !== undefined && forecast.source !== OBSERVATION_SOURCE.FORECAST) {
    return tv.indeterminate({
      observed: { source: forecast.source },
      required: REQUIRED,
      inputSource: String(forecast.source),
      reason:
        `the environmental input carries source "${String(forecast.source)}" rather than FORECAST. ` +
        "§7.5 F31 names the forecast as the input; a current reading is a precise answer to the " +
        "wrong question",
    });
  }

  const variables = forecast.variables;
  if (variables === undefined || variables === null || typeof variables !== "object") {
    return tv.indeterminate({
      required: REQUIRED,
      inputSource: "FORECAST",
      reason: "the forecast states no per-variable values for the projected window",
    });
  }

  let tightestMargin = null;
  let tightestUnit = null;

  // Deterministic order: the limits are iterated by sorted key so that two evaluations
  // of the same candidate report the same binding variable (T6, §9.6).
  for (const name of Object.keys(limits).sort()) {
    const limit = limits[name];
    if (!limit || typeof limit !== "object") continue;

    const projected = variables[name];
    if (projected === undefined || projected === null) {
      return tv.absent(`the forecast for environmental variable "${name}"`, {
        required: REQUIRED,
        inputSource: "FORECAST",
      });
    }

    // The pessimistic end binds: the worst value in the window, and where a confidence
    // bound is published, the bound rather than the expectation.
    const worst = tv.isNumber(projected.worstCase)
      ? projected.worstCase
      : tv.isNumber(projected.upperBound)
        ? projected.upperBound
        : projected.value;

    if (!tv.isNumber(worst)) {
      return tv.indeterminate({
        observed: { variable: name },
        required: REQUIRED,
        inputSource: "FORECAST",
        reason: `the forecast for "${name}" states no readable worst-case value across the window`,
      });
    }

    const unit = limit.unit === undefined ? tv.MARGIN_UNIT.RATIO : limit.unit;

    if (tv.isNumber(limit.max) && worst > limit.max) {
      return tv.violated({
        observed: { variable: name, worstCase: worst },
        required: { max: limit.max },
        inputSource: "FORECAST",
        margin: limit.max - worst,
        marginUnit: unit,
        reason: `forecast ${name} reaches ${worst}, beyond the agent's maximum ${limit.max} (§7.5 F31)`,
      });
    }
    if (tv.isNumber(limit.min) && worst < limit.min) {
      return tv.violated({
        observed: { variable: name, worstCase: worst },
        required: { min: limit.min },
        inputSource: "FORECAST",
        margin: worst - limit.min,
        marginUnit: unit,
        reason: `forecast ${name} falls to ${worst}, below the agent's minimum ${limit.min} (§7.5 F31)`,
      });
    }

    const margins = [];
    if (tv.isNumber(limit.max)) margins.push(limit.max - worst);
    if (tv.isNumber(limit.min)) margins.push(worst - limit.min);
    for (const margin of margins) {
      if (tightestMargin === null || margin < tightestMargin) {
        tightestMargin = margin;
        tightestUnit = unit;
      }
    }
  }

  return tv.satisfied({
    observed: { variablesChecked: Object.keys(limits).length },
    required: REQUIRED,
    inputSource: "FORECAST",
    margin: tightestMargin,
    marginUnit: tightestUnit,
  });
}

module.exports = { evaluate };

"use strict";

/**
 * **F29 — Dimensional passage feasible along the route (widths, heights, kerbs,
 * gradients, lift capacity).** Class I. Indeterminate: `DENY`.
 *
 * > An agent that cannot fit through the route's tightest constriction cannot execute
 * > it.
 *
 * ── Five dimensions, and the tightest of each binds ─────────────────────────
 * §7.5 enumerates them, and they are genuinely independent: a route can be wide
 * enough and too steep, or flat and blocked by a kerb. The predicate therefore checks
 * each against its own limit from the MobilityModel's `envelopeConstraints` and
 * `dimensionalFootprint` (§2.2), and reports the **binding** one — an operator told
 * "route infeasible" learns nothing, and one told "the lift on floor 3 is rated 90 kg
 * and the loaded agent is 104 kg" has an answer.
 *
 * | Constriction | Agent limit | Sense |
 * |---|---|---|
 * | `widthMm`       | footprint width  | constriction must be ≥ agent |
 * | `heightMm`      | footprint height | constriction must be ≥ agent |
 * | `kerbHeightMm`  | max traversable kerb | constriction must be ≤ agent limit |
 * | `gradientPct`   | max traversable gradient | constriction must be ≤ agent limit |
 * | `liftCapacityKg`| loaded mass | capacity must be ≥ loaded mass |
 *
 * ── Loaded mass, not tare ───────────────────────────────────────────────────
 * Lift capacity is checked against the agent's mass *with its payload at the heaviest
 * point of the plan*, which is why the check reads `plan.peakLoadedMassKg` rather than
 * an agent-level constant. A lift check against tare mass is the same class of error
 * as F22 checking only the endpoints.
 *
 * Tier 0 (T0-01, T0-04).
 */

const tv = require("../threeValued");

const REQUIRED = "agent envelope within every constriction along the route";

/**
 * The five constriction dimensions of §7.5 F29, each with the comparison sense that
 * makes it binding. `atLeast` means the route value must be at least the agent's;
 * otherwise the route value must be at most the agent's limit.
 * @structural the specification's own enumerated passage dimensions
 */
const DIMENSIONS = Object.freeze([
  { key: "widthMm", limit: "widthMm", atLeast: true, unit: "m", label: "width" },
  { key: "heightMm", limit: "heightMm", atLeast: true, unit: "m", label: "height" },
  { key: "kerbHeightMm", limit: "maxKerbHeightMm", atLeast: false, unit: "m", label: "kerb height" },
  { key: "gradientPct", limit: "maxGradientPct", atLeast: false, unit: "ratio", label: "gradient" },
  { key: "liftCapacityKg", limit: "loadedMassKg", atLeast: true, unit: "kg", label: "lift capacity" },
]);

const UNIT_OF = Object.freeze({ m: "m", ratio: "ratio", kg: "kg" });

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = (context && context.agentSnapshot) || null;
  const plan = (context && context.plan) || null;

  if (!agent) return tv.absent("the agent snapshot", { required: REQUIRED });
  if (!plan) return tv.absent("the candidate plan", { required: REQUIRED });

  const model = agent.mobilityModel;
  if (!model) return tv.absent("the agent's MobilityModel", { required: REQUIRED, inputSource: "CONTROL_PLANE" });

  const footprint = model.dimensionalFootprint || {};
  const envelope = model.envelopeConstraints || {};

  // Lift capacity binds against the loaded mass at the heaviest point of the plan, not
  // against tare: a lift check against tare mass is the same error as F22 checking
  // only the endpoints.
  const limits = {
    widthMm: footprint.widthMm,
    heightMm: footprint.heightMm,
    maxKerbHeightMm: envelope.maxKerbHeightMm,
    maxGradientPct: envelope.maxGradientPct,
    loadedMassKg: plan.peakLoadedMassKg,
  };

  const constrictions = plan.route && plan.route.constrictions;
  if (constrictions === undefined) {
    return tv.absent("the route's constriction list", {
      required: REQUIRED,
      inputSource: "ROUTING",
      reason:
        "the plan enumerates no constrictions. An absent list is not a clear route: it means the " +
        "routing service did not report the passage profile (§7.5 F29)",
    });
  }
  if (constrictions === null || !Array.isArray(constrictions)) {
    return tv.indeterminate({
      required: REQUIRED,
      inputSource: "ROUTING",
      reason: "the route's constriction list is unreadable",
    });
  }

  let tightest = null;

  for (const constriction of constrictions) {
    if (!constriction) continue;

    for (const dimension of DIMENSIONS) {
      const routeValue = constriction[dimension.key];
      if (routeValue === undefined || routeValue === null) continue; // this constriction does not bind this dimension

      const agentValue = limits[dimension.limit];

      if (!tv.isNumber(routeValue)) {
        return tv.indeterminate({
          observed: { at: constriction.at === undefined ? null : constriction.at, dimension: dimension.label },
          required: REQUIRED,
          inputSource: "ROUTING",
          reason: `a constriction states an unreadable ${dimension.label}`,
        });
      }
      if (!tv.isNumber(agentValue)) {
        return tv.absent(`the agent's ${dimension.label} limit (${dimension.limit})`, {
          observed: { at: constriction.at === undefined ? null : constriction.at, [dimension.key]: routeValue },
          required: REQUIRED,
          inputSource: "CONTROL_PLANE",
        });
      }

      // Positive margin means clearance in both senses.
      const margin = dimension.atLeast ? routeValue - agentValue : agentValue - routeValue;

      if (margin < 0) {
        return tv.violated({
          observed: {
            at: constriction.at === undefined ? null : constriction.at,
            dimension: dimension.label,
            routeValue,
            agentValue,
          },
          required: REQUIRED,
          inputSource: "ROUTING",
          margin,
          marginUnit: UNIT_OF[dimension.unit],
          reason:
            `${dimension.label} at "${String(constriction.at)}" is ${routeValue} against the agent's ` +
            `${agentValue}. An agent that cannot fit through the route's tightest constriction cannot ` +
            "execute it (§7.5 F29)",
        });
      }

      if (tightest === null || margin < tightest.margin) {
        tightest = { margin, unit: UNIT_OF[dimension.unit], dimension: dimension.label };
      }
    }
  }

  return tv.satisfied({
    observed: {
      constrictionsChecked: constrictions.length,
      tightest: tightest ? { dimension: tightest.dimension, margin: tightest.margin } : null,
    },
    required: REQUIRED,
    inputSource: "ROUTING",
    margin: tightest ? tightest.margin : null,
    marginUnit: tightest ? tightest.unit : null,
  });
}

module.exports = { evaluate, DIMENSIONS };

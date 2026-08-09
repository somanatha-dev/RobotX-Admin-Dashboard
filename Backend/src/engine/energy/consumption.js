"use strict";

/**
 * The consumption model (§14.2) — **Tier 0**.
 *
 * > ```
 * > E_leg = κ(a) · [ β_dist · d
 * >                + β_mass · m_payload · d
 * >                + β_climb · Σ max(0, Δh)  · (m_vehicle + m_payload)
 * >                − β_regen · Σ max(0, −Δh) · (m_vehicle + m_payload) · η_regen
 * >                + β_move_time · t_moving
 * >                + β_stop_start · n_stop_start_cycles
 * >                + β_dwell · t_dwell
 * >                + β_aux · t_total
 * >                + β_thermal(T_ambient, T_pack) · t_total
 * >                + Σ  β_payload_thermal( thermal_class(k), T_ambient ) · t_occupied(k) ]
 * >                  k ∈ compartments
 * > ```
 *
 * This module computes that sum and nothing else. It does not decide feasibility (F34
 * does, from the distribution below), does not size a reserve (`reserves.js` does), and
 * does not read a clock or a store.
 *
 * ── Why every input is required, and none is defaulted ──────────────────────
 * A missing coefficient is not a zero. `β_climb` absent does not mean the terrain is
 * flat; it means nobody has fitted the coefficient for this class, and a mission
 * planned as though the climb were free is exactly the mission that strands. So
 * `legEnergyWh()` returns `{ ok: false, missing: [...] }` rather than a number, and its
 * callers surface that as `INDETERMINATE` — which, under F34's class I policy, denies.
 * This is tenet T2 ("unknown is never permission") applied inside the physical model
 * rather than only at the gate.
 *
 * ── β_payload_thermal is charged over `t_occupied(k)`, not over the mission ──
 * > It is charged over `t_occupied(k)` — the interval the compartment actually holds
 * > conditioned goods — because a cold-chain compartment loaded at stop 1 and emptied at
 * > stop 2 draws power over that interval and not over the whole mission.
 *
 * The occupancy intervals come from `payload/loadState.js`, which projects compartment
 * occupancy per stop. This module takes them as an input for the same reason it takes
 * distance as one: computing them here would put a second load model in the energy path.
 *
 * §14.2 also states why the term is separate rather than folded into `β_thermal`:
 * cold-chain and hot-box missions are disproportionately long, so an omitted
 * conditioning load is correlated precisely with the missions where energy feasibility
 * binds hardest — "the error is not random, it is concentrated where it does the most
 * damage" — and folding it in would make `β_thermal` payload-dependent, destroying its
 * calibratability.
 *
 * ── κ(a) is what makes the model self-correcting ────────────────────────────
 * > `κ(a)` is the mechanism that makes the model *self-correcting*: an agent that
 * > consistently consumes 12 % more than predicted has `κ = 1.12` within a few missions
 * > and is planned accordingly. A drifting `κ` is also an early maintenance indicator
 * > and is fed to §16.
 *
 * `updateKappa()` is the EWMA §14.2 describes; it runs at settlement, never inside a
 * round. `kappaDriftSignal()` is the maintenance half, structured for §16 to consume
 * when Phase 16c lands.
 *
 * Tier 0 (T0-03). Decision path (T6): no clock, no randomness, no store.
 */

/**
 * The coefficient names of §14.2, in the order the equation states them. Used to
 * report exactly which coefficient a class is missing rather than "the energy model".
 * @structural the specification's own coefficient names
 */
const COEFFICIENT = Object.freeze({
  DIST: "beta_dist",
  MASS: "beta_mass",
  CLIMB: "beta_climb",
  REGEN: "beta_regen",
  MOVE_TIME: "beta_move_time",
  STOP_START: "beta_stop_start",
  DWELL: "beta_dwell",
  AUX: "beta_aux",
  THERMAL: "beta_thermal",
  PAYLOAD_THERMAL: "beta_payload_thermal",
  REGEN_EFFICIENCY: "eta_regen",
});

/**
 * The scalar coefficients, each a plain number in its own unit. `beta_thermal` and
 * `beta_payload_thermal` are curves and are handled separately.
 * @structural the subset of §14.2's coefficients that are scalars
 */
const SCALAR_COEFFICIENTS = Object.freeze([
  COEFFICIENT.DIST,
  COEFFICIENT.MASS,
  COEFFICIENT.CLIMB,
  COEFFICIENT.REGEN,
  COEFFICIENT.MOVE_TIME,
  COEFFICIENT.STOP_START,
  COEFFICIENT.DWELL,
  COEFFICIENT.AUX,
  COEFFICIENT.REGEN_EFFICIENCY,
]);

/**
 * The three uncertainty sources §14.5 inflates the predictive variance for.
 * @structural the specification's own inflation sources
 */
const VARIANCE_SOURCE = Object.freeze({
  ROUTE_NOVELTY: "route_novelty",
  FORECAST_HORIZON: "forecast_horizon",
  WEATHER: "weather",
});

const VARIANCE_SOURCES = Object.freeze(Object.values(VARIANCE_SOURCE));

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Evaluate a piecewise-linear curve at `x`, clamped at both ends.
 *
 * Curves arrive as ordered `[{ x, y }]` points from `EnergyModelParams`. Linear
 * interpolation between measured points is the representation the vendor data comes in;
 * extrapolating past the ends would invent behaviour outside the measured envelope, so
 * the value is clamped instead and the clamp is reported.
 *
 * @param {Array<{x: number, y: number}>} curve
 * @param {number} x
 * @returns {{ ok: boolean, y: number|null, clamped: boolean }}
 */
function evaluateCurve(curve, x) {
  if (!Array.isArray(curve) || curve.length === 0) return { ok: false, y: null, clamped: false };
  if (!isNumber(x)) return { ok: false, y: null, clamped: false };

  const points = curve.filter((point) => point && isNumber(point.x) && isNumber(point.y));
  if (points.length === 0) return { ok: false, y: null, clamped: false };

  const ordered = [...points].sort((a, b) => a.x - b.x);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];

  if (x <= first.x) return { ok: true, y: first.y, clamped: x < first.x };
  if (x >= last.x) return { ok: true, y: last.y, clamped: x > last.x };

  for (let index = 1; index < ordered.length; index += 1) {
    const lower = ordered[index - 1];
    const upper = ordered[index];
    if (x <= upper.x) {
      const span = upper.x - lower.x;
      if (span === 0) return { ok: true, y: upper.y, clamped: false };
      const fraction = (x - lower.x) / span;
      return { ok: true, y: lower.y + fraction * (upper.y - lower.y), clamped: false };
    }
  }

  return { ok: true, y: last.y, clamped: false };
}

/**
 * `β_thermal(T_ambient, T_pack)` — the vehicle's own thermal draw, in Wh per second.
 *
 * §14.2 states the coefficient as a function of two temperatures and does not fix its
 * functional form. It is represented here as the **sum of two measured curves** — the
 * cabin/vehicle HVAC draw against ambient, and the pack conditioning draw against pack
 * temperature — because those are two physically distinct loads that are measured
 * separately on a dynamometer, and because a two-dimensional surface would need an
 * interpolation scheme nobody has calibrated. Both curves are required: an absent pack
 * curve is not a zero pack-conditioning draw.
 *
 * @param {object} model the class's `EnergyModelParams`
 * @param {number} ambientC
 * @param {number} packC
 * @returns {{ ok: boolean, whPerSecond: number|null, missing: string[] }}
 */
function betaThermal(model, ambientC, packC) {
  const curves = model && model[COEFFICIENT.THERMAL];
  if (!curves || typeof curves !== "object") {
    return { ok: false, whPerSecond: null, missing: [COEFFICIENT.THERMAL] };
  }

  const ambient = evaluateCurve(curves.ambientCurve, ambientC);
  const pack = evaluateCurve(curves.packCurve, packC);
  const missing = [];
  if (!ambient.ok) missing.push(`${COEFFICIENT.THERMAL}.ambientCurve`);
  if (!pack.ok) missing.push(`${COEFFICIENT.THERMAL}.packCurve`);
  if (missing.length > 0) return { ok: false, whPerSecond: null, missing };

  return { ok: true, whPerSecond: ambient.y + pack.y, missing: [] };
}

/**
 * `β_payload_thermal(thermal_class(k), T_ambient)` — the active conditioning draw of one
 * compartment, in Wh per second.
 *
 * A compartment whose thermal class has no curve is **not** free: F25 gates whether a
 * compartment can hold the payload's range, and this term prices what holding it costs.
 * An unpriced conditioning load on a cold-chain mission is the omission §14.2 singles
 * out as the one concentrated where feasibility binds hardest, so an absent curve is
 * reported as missing rather than treated as zero.
 *
 * @param {object} model
 * @param {string} thermalClass
 * @param {number} ambientC
 * @returns {{ ok: boolean, whPerSecond: number|null, missing: string[] }}
 */
function betaPayloadThermal(model, thermalClass, ambientC) {
  const byClass = model && model[COEFFICIENT.PAYLOAD_THERMAL];
  if (!byClass || typeof byClass !== "object") {
    return { ok: false, whPerSecond: null, missing: [COEFFICIENT.PAYLOAD_THERMAL] };
  }
  const curve = byClass[thermalClass];
  const evaluated = evaluateCurve(curve, ambientC);
  if (!evaluated.ok) {
    return { ok: false, whPerSecond: null, missing: [`${COEFFICIENT.PAYLOAD_THERMAL}.${String(thermalClass)}`] };
  }
  return { ok: true, whPerSecond: evaluated.y, missing: [] };
}

/**
 * The inputs `legEnergyWh` requires, each with the term it feeds. Reported by name when
 * absent so a rejection says "no climb profile" rather than "bad input".
 * @structural the required profile fields of §14.2's equation
 */
const REQUIRED_PROFILE_FIELDS = Object.freeze([
  "distanceM",
  "climbM",
  "descentM",
  "movingSeconds",
  "dwellSeconds",
  "totalSeconds",
  "stopStartCycles",
  "payloadMassKg",
  "vehicleMassKg",
  "ambientC",
  "packC",
]);

/**
 * `E_leg` in watt-hours, term by term.
 *
 * `payloadMassKg` is the **expectation**, not the declared upper bound: §15.1 assigns
 * the upper bound to feasibility (F22) and the expectation to energy estimation, and
 * `payload/spec.js` is the module that keeps the two apart.
 *
 * @param {object} model the agent class's fitted `EnergyModelParams`
 * @param {object} profile the leg's physical profile
 * @param {number} kappa the agent's efficiency multiplier κ(a)
 * @returns {{ ok: boolean, wh: number|null, terms: object|null, missing: string[],
 *             kappa: number|null }}
 */
function legEnergyWh(model, profile, kappa) {
  const missing = [];

  if (!model || typeof model !== "object") {
    return { ok: false, wh: null, terms: null, missing: ["energyModelParams"], kappa: null };
  }
  if (!profile || typeof profile !== "object") {
    return { ok: false, wh: null, terms: null, missing: ["legProfile"], kappa: null };
  }
  if (!isNumber(kappa)) missing.push("kappa");

  for (const name of SCALAR_COEFFICIENTS) {
    if (!isNumber(model[name])) missing.push(name);
  }
  for (const field of REQUIRED_PROFILE_FIELDS) {
    if (!isNumber(profile[field])) missing.push(`profile.${field}`);
  }

  const occupancy = profile.compartmentOccupancy;
  if (occupancy !== undefined && occupancy !== null && !Array.isArray(occupancy)) {
    missing.push("profile.compartmentOccupancy");
  }

  const thermal = betaThermal(model, profile.ambientC, profile.packC);
  missing.push(...thermal.missing);

  const occupancyRows = Array.isArray(occupancy) ? occupancy : [];
  const payloadThermalTerms = [];
  for (const row of occupancyRows) {
    if (!row || !isNumber(row.occupiedSeconds)) {
      missing.push("profile.compartmentOccupancy[].occupiedSeconds");
      continue;
    }
    // An unconditioned compartment draws nothing for conditioning. That is a stated
    // absence of a thermal class, not an unfitted curve, and the two must not be
    // conflated: the first is zero, the second is unknown.
    if (row.thermalClass === null || row.thermalClass === undefined) {
      payloadThermalTerms.push({ compartmentId: row.compartmentId ?? null, thermalClass: null, wh: 0 });
      continue;
    }
    const beta = betaPayloadThermal(model, row.thermalClass, profile.ambientC);
    if (!beta.ok) {
      missing.push(...beta.missing);
      continue;
    }
    payloadThermalTerms.push({
      compartmentId: row.compartmentId ?? null,
      thermalClass: row.thermalClass,
      wh: beta.whPerSecond * row.occupiedSeconds,
    });
  }

  if (missing.length > 0) {
    return { ok: false, wh: null, terms: null, missing: [...new Set(missing)], kappa: null };
  }

  const grossMassKg = profile.vehicleMassKg + profile.payloadMassKg;

  const terms = {
    distance: model[COEFFICIENT.DIST] * profile.distanceM,
    mass: model[COEFFICIENT.MASS] * profile.payloadMassKg * profile.distanceM,
    climb: model[COEFFICIENT.CLIMB] * Math.max(0, profile.climbM) * grossMassKg,
    // The one negative term in the equation: recovered potential energy. It is
    // subtracted, and `signDiscipline` in the cost path never sees it — regen reduces
    // the physical energy required, it does not create a credit.
    regen:
      -model[COEFFICIENT.REGEN] *
      Math.max(0, profile.descentM) *
      grossMassKg *
      model[COEFFICIENT.REGEN_EFFICIENCY],
    moveTime: model[COEFFICIENT.MOVE_TIME] * profile.movingSeconds,
    stopStart: model[COEFFICIENT.STOP_START] * profile.stopStartCycles,
    dwell: model[COEFFICIENT.DWELL] * profile.dwellSeconds,
    aux: model[COEFFICIENT.AUX] * profile.totalSeconds,
    thermal: thermal.whPerSecond * profile.totalSeconds,
    payloadThermal: payloadThermalTerms.reduce((sum, row) => sum + row.wh, 0),
  };

  const bracket = Object.values(terms).reduce((sum, value) => sum + value, 0);

  // Regeneration can never make a leg cost less than nothing. A pack does not gain
  // charge over a net-descending route beyond what it recovers, and a negative E_leg
  // would silently *fund* another leg's reserve, which is a reserve trade §14.5
  // forbids outright.
  const wh = kappa * Math.max(0, bracket);

  return {
    ok: true,
    wh,
    terms: Object.freeze({ ...terms, bracket, floored: bracket < 0 }),
    missing: [],
    kappa,
    payloadThermalByCompartment: Object.freeze(payloadThermalTerms),
  };
}

/**
 * `E_mission` — the sum of a plan's legs, reported with the per-leg breakdown so a
 * rejection can name the leg that dominates.
 *
 * @param {object} model
 * @param {Array<object>} legProfiles
 * @param {number} kappa
 * @returns {{ ok: boolean, wh: number|null, legs: object[], missing: string[] }}
 */
function missionEnergyWh(model, legProfiles, kappa) {
  if (!Array.isArray(legProfiles) || legProfiles.length === 0) {
    return { ok: false, wh: null, legs: [], missing: ["legProfiles"] };
  }

  const legs = [];
  const missing = [];
  let total = 0;

  for (const profile of legProfiles) {
    const evaluated = legEnergyWh(model, profile, kappa);
    if (!evaluated.ok) {
      missing.push(...evaluated.missing);
      continue;
    }
    legs.push({ legId: profile.legId ?? null, wh: evaluated.wh, terms: evaluated.terms });
    total += evaluated.wh;
  }

  if (missing.length > 0) return { ok: false, wh: null, legs, missing: [...new Set(missing)] };
  return { ok: true, wh: total, legs, missing: [] };
}

/* ═══════════════════════════════════════════════════════════════════════════
   The predictive distribution F34 is evaluated on (§14.5)
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * > Each is evaluated on the predictive distribution of `E_mission`, whose variance
 * > comes from the model's residual variance, inflated for route novelty, forecast
 * > horizon, and weather uncertainty.
 *
 * The **variance** is inflated, not the standard deviation — that is what §14.5 says,
 * and the two differ by a square root, which at the tail probabilities T3 works at is
 * not a rounding difference.
 *
 * Each source carries a `severity` in `[0, 1]` describing how much of its uncertainty
 * is present — the fraction of the route never previously traversed, the forecast
 * horizon as a fraction of the maximum, the complement of the weather forecast's
 * confidence — and the applied multiplier is `1 + severity · (m − 1)`. A source whose
 * severity is **not stated** is inflated in full, never skipped: an unquantified
 * uncertainty is not an absent one (T2).
 *
 * @param {object} input
 * @param {number} input.meanWh the deterministic `E_mission`
 * @param {number} input.residualCv `energy.model_residual_cv`
 * @param {Record<string, number>} input.inflations `energy.variance_inflation`
 * @param {Record<string, number>} [input.severity] per-source severity in [0, 1]
 * @returns {{ ok: boolean, meanWh: number|null, varianceWh2: number|null,
 *             sdWh: number|null, applied: object|null, missing: string[] }}
 */
function predictiveDistribution(input) {
  const source = input || {};
  const missing = [];

  if (!isNumber(source.meanWh) || source.meanWh < 0) missing.push("meanWh");
  if (!isNumber(source.residualCv) || source.residualCv < 0) missing.push("energy.model_residual_cv");
  if (!source.inflations || typeof source.inflations !== "object") missing.push("energy.variance_inflation");

  if (missing.length > 0) {
    return { ok: false, meanWh: null, varianceWh2: null, sdWh: null, applied: null, missing };
  }

  const baseSd = source.meanWh * source.residualCv;
  const applied = {};
  let product = 1;

  for (const name of VARIANCE_SOURCES) {
    const multiplier = source.inflations[name];
    if (!isNumber(multiplier) || multiplier < 1) {
      missing.push(`energy.variance_inflation.${name}`);
      continue;
    }
    const stated = source.severity ? source.severity[name] : undefined;
    // Absent severity means the uncertainty is unquantified, and the model inflates in
    // full rather than assuming it away.
    const severity = isNumber(stated) ? Math.min(1, Math.max(0, stated)) : 1;
    const effective = 1 + severity * (multiplier - 1);
    applied[name] = { multiplier, severity, effective };
    product *= effective;
  }

  if (missing.length > 0) {
    return { ok: false, meanWh: null, varianceWh2: null, sdWh: null, applied: null, missing };
  }

  const varianceWh2 = baseSd * baseSd * product;

  return {
    ok: true,
    meanWh: source.meanWh,
    varianceWh2,
    sdWh: Math.sqrt(varianceWh2),
    applied: Object.freeze({ ...applied, varianceInflationProduct: product, baseSdWh: baseSd }),
    missing: [],
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   The distribution's own CDF and quantile
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The predictive distribution of `E_mission` is treated as Gaussian in its mean and
 * variance. This is stated as a modelling choice rather than left implicit:
 *
 *   - §14.5 supplies exactly two moments — a mean from the model and a variance from
 *     the residual, inflated. A distribution family that needed a third parameter
 *     would need a calibration nobody has specified.
 *   - The consequential quantities are **tail** probabilities down to 1e-7, where the
 *     Gaussian is the *optimistic* choice against a heavier-tailed truth. That
 *     optimism is exactly what `energy.model_residual_cv`'s calibration must absorb,
 *     and what §21.5's calibration loop measures: a systematically under-predicted
 *     tail shows up as realised T2/T3 rates above their budgeted rates, which is an
 *     alertable SLI rather than a silent error.
 *
 * Both functions below are pure rational approximations with fixed coefficients, which
 * is what makes the tail probabilities bit-identical on replay (§9.6, T6). A library
 * whose implementation could change between versions would not be.
 */

/** @structural 1/√2 — the change of variable from the standard normal to erfc */
const INV_SQRT_2 = 0.7071067811865476;

/** @structural half — erfc's leading factor in Φ(z) = ½·erfc(−z/√2) */
const HALF = 0.5;

/**
 * Coefficients of the Numerical Recipes rational Chebyshev approximation to `erfc`,
 * whose fractional error is everywhere below 1.2e-7. At the tail probabilities T3
 * works at, a *fractional* bound is the one that matters: 1.2e-7 relative to 1e-7 is
 * an absolute error of 1.2e-14.
 * @structural published approximation coefficients, not tunable values
 */
const ERFC_COEFFICIENTS = Object.freeze([-1.26551223, 1.00002368, 0.37409196, 0.09678418, -0.18628806, 0.27886807, -1.13520398, 1.48851587, -0.82215223, 0.17087277]);

/**
 * `erfc(x)` by the Numerical Recipes rational Chebyshev approximation.
 *
 * @param {number} x
 * @returns {number}
 */
function erfc(x) {
  const z = Math.abs(x);
  // @structural the approximation's own change of variable
  const t = 1 / (1 + HALF * z);
  const [c0, c1, c2, c3, c4, c5, c6, c7, c8, c9] = ERFC_COEFFICIENTS;
  const polynomial =
    c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * (c6 + t * (c7 + t * (c8 + t * c9))))))));
  const value = t * Math.exp(-z * z + polynomial);
  // @structural erfc(−x) = 2 − erfc(x)
  return x >= 0 ? value : 2 - value;
}

/**
 * The standard normal CDF, `Φ(z)`.
 *
 * @param {number} z
 * @returns {number}
 */
function normalCdf(z) {
  if (!isNumber(z)) return Number.NaN;
  return HALF * erfc(-z * INV_SQRT_2);
}

/**
 * Coefficients of Acklam's inverse normal CDF approximation, relative error below
 * 1.15e-9 over the whole domain.
 * @structural published approximation coefficients, not tunable values
 */
const PROBIT_A = Object.freeze([-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239]);
/** @structural published approximation coefficients, not tunable values */
const PROBIT_B = Object.freeze([-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]);
/** @structural published approximation coefficients, not tunable values */
const PROBIT_C = Object.freeze([-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]);
/** @structural published approximation coefficients, not tunable values */
const PROBIT_D = Object.freeze([7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]);
/** @structural the break points between Acklam's three regions */
const PROBIT_LOW = 0.02425;

/**
 * The standard normal quantile, `Φ⁻¹(p)`.
 *
 * @param {number} p in (0, 1)
 * @returns {number}
 */
function normalQuantile(p) {
  if (!isNumber(p) || p <= 0 || p >= 1) return Number.NaN;

  const [a0, a1, a2, a3, a4, a5] = PROBIT_A;
  const [b0, b1, b2, b3, b4] = PROBIT_B;
  const [c0, c1, c2, c3, c4, c5] = PROBIT_C;
  const [d0, d1, d2, d3] = PROBIT_D;

  if (p < PROBIT_LOW) {
    // @structural the approximation's own change of variable in the lower tail
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) / ((((d0 * q + d1) * q + d2) * q + d3) * q + 1)
    );
  }
  if (p > 1 - PROBIT_LOW) return -normalQuantile(1 - p);

  const q = p - HALF;
  const r = q * q;
  return (
    ((((((a0 * r + a1) * r + a2) * r + a3) * r + a4) * r + a5) * q) /
    (((((b0 * r + b1) * r + b2) * r + b3) * r + b4) * r + 1)
  );
}

/**
 * `P[ E_mission > thresholdWh ]` under the predictive distribution.
 *
 * A distribution with zero variance is not a modelling convenience here: it means the
 * residual has been calibrated to zero, which no fitted model produces. It is answered
 * as a step function rather than as `NaN`, so a fixture can exercise the deterministic
 * boundary without the caller having to special-case it.
 *
 * @param {{ meanWh: number, sdWh: number }} distribution
 * @param {number} thresholdWh
 * @returns {number|null}
 */
function exceedanceProbability(distribution, thresholdWh) {
  if (!distribution || !isNumber(distribution.meanWh) || !isNumber(distribution.sdWh)) return null;
  if (!isNumber(thresholdWh)) return null;
  if (distribution.sdWh <= 0) return distribution.meanWh > thresholdWh ? 1 : 0;
  return 1 - normalCdf((thresholdWh - distribution.meanWh) / distribution.sdWh);
}

/**
 * The `p`-quantile of `E_mission` in watt-hours.
 *
 * @param {{ meanWh: number, sdWh: number }} distribution
 * @param {number} p
 * @returns {number|null}
 */
function quantileWh(distribution, p) {
  if (!distribution || !isNumber(distribution.meanWh) || !isNumber(distribution.sdWh)) return null;
  const z = normalQuantile(p);
  if (!isNumber(z)) return null;
  return distribution.meanWh + z * distribution.sdWh;
}

/* ═══════════════════════════════════════════════════════════════════════════
   κ(a) — the self-correcting multiplier (§14.2)
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The EWMA update run at settlement.
 *
 * Not run inside a round: κ is an input to the decision path pinned by the round's
 * snapshot, and updating it mid-round would make two candidates for the same agent
 * evaluate against different models.
 *
 * @param {number} previousKappa
 * @param {object} observation
 * @param {number} observation.predictedWh what the model said before the mission
 * @param {number} observation.realisedWh what the pack actually delivered
 * @param {number} observation.alpha `energy.kappa_ewma_alpha`
 * @param {{min: number, max: number}} observation.bounds `energy.kappa_bounds`
 * @param {boolean} [observation.attributable] whether the deviation is attributable to
 *   the agent. §16.3 states the discipline for reliability estimates and it applies
 *   equally here: a mission whose overrun was caused by a road closure is evidence
 *   about the route, not about the drivetrain, and folding it in corrupts the estimate
 *   in the direction that under-predicts every later mission.
 * @returns {{ ok: boolean, kappa: number|null, ratio: number|null, clamped: boolean,
 *             reason: string|null }}
 */
function updateKappa(previousKappa, observation) {
  const source = observation || {};

  if (!isNumber(previousKappa) || previousKappa <= 0) {
    return { ok: false, kappa: null, ratio: null, clamped: false, reason: "no previous kappa" };
  }
  if (!isNumber(source.predictedWh) || source.predictedWh <= 0) {
    return { ok: false, kappa: null, ratio: null, clamped: false, reason: "predicted energy is not positive" };
  }
  if (!isNumber(source.realisedWh) || source.realisedWh < 0) {
    return { ok: false, kappa: null, ratio: null, clamped: false, reason: "realised energy is unreadable" };
  }
  if (!isNumber(source.alpha) || source.alpha <= 0 || source.alpha > 1) {
    return { ok: false, kappa: null, ratio: null, clamped: false, reason: "energy.kappa_ewma_alpha is unresolved" };
  }
  if (source.attributable === false) {
    return { ok: false, kappa: null, ratio: null, clamped: false, reason: "deviation is not agent-attributable" };
  }

  const bounds = source.bounds;
  if (!bounds || !isNumber(bounds.min) || !isNumber(bounds.max) || bounds.min > bounds.max) {
    return { ok: false, kappa: null, ratio: null, clamped: false, reason: "energy.kappa_bounds is unresolved" };
  }

  // The ratio is realised over *model* prediction, which is the prediction already
  // multiplied by the old κ. Dividing it out is what makes the update a correction of
  // the residual error rather than a compounding of the multiplier.
  const ratio = (source.realisedWh / source.predictedWh) * previousKappa;
  const blended = (1 - source.alpha) * previousKappa + source.alpha * ratio;
  const kappa = Math.min(bounds.max, Math.max(bounds.min, blended));

  return { ok: true, kappa, ratio, clamped: kappa !== blended, reason: null };
}

/**
 * The §16 maintenance half of κ: a persistent multiplier well away from 1, or one
 * pinned at a bound, is a condition signal and not merely a planning correction.
 *
 * The signal is structured rather than acted on here; §16.6's maintenance interaction
 * is Phase 16c's, and raising a work order from the energy model would put a
 * maintenance policy inside a physics module.
 *
 * @param {number} kappa
 * @param {{min: number, max: number}} bounds
 * @returns {{ ok: boolean, deviation: number|null, atBound: string|null }}
 */
function kappaDriftSignal(kappa, bounds) {
  if (!isNumber(kappa) || !bounds || !isNumber(bounds.min) || !isNumber(bounds.max)) {
    return { ok: false, deviation: null, atBound: null };
  }
  const atBound = kappa <= bounds.min ? "min" : kappa >= bounds.max ? "max" : null;
  // Deviation from unity: κ = 1 is "consumes exactly what the class model predicts".
  return { ok: true, deviation: kappa - 1, atBound };
}

module.exports = {
  COEFFICIENT,
  SCALAR_COEFFICIENTS,
  VARIANCE_SOURCE,
  VARIANCE_SOURCES,
  REQUIRED_PROFILE_FIELDS,
  evaluateCurve,
  betaThermal,
  betaPayloadThermal,
  legEnergyWh,
  missionEnergyWh,
  predictiveDistribution,
  erfc,
  normalCdf,
  normalQuantile,
  exceedanceProbability,
  quantileWh,
  updateKappa,
  kappaDriftSignal,
};

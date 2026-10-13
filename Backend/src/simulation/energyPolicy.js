"use strict";

/**
 * The supervised-V1 SIMULATION energy policy — defined once, read by the simulated robot
 * (`VirtualRobot`), by commissioning (`simulatedAgentState.simulatedEnergyCoefficients`) and by
 * the V1 demonstration composition the assignment engine prices energy through.
 *
 * ── What it is ──────────────────────────────────────────────────────────────
 * 1. A POWER model: P(v) = P_standby + (P_moving − P_standby) · v / v_ref.
 *    In §14.2's coefficient terms that is exactly
 *        β_aux  = P_standby / 3600               Wh per second, whatever the robot does
 *        β_dist = (P_moving − P_standby) / (3600 · v_ref)   Wh per metre driven
 *    and β_move_time = β_dwell = 0. The linear-in-speed form is an ASSUMPTION stated here: it is
 *    the simplest model that does not claim moving power is the same at every speed, and it
 *    reproduces the owner's figure at the reference speed exactly.
 * 2. The RESERVE formula, used for every feasibility judgement on both sides:
 *        E_reserve = packWh · reservePct / 100  +  fixedReserveWh
 *    counted ONCE, beside (never inside) the delivery energy and the charger-trip energy:
 *        feasible ⇔ E_available − E_delivery − E_charger_trip ≥ E_reserve
 *    (the engine's F34 adds its statistical contingency layer on top, §14.5).
 * 3. The charge TRIGGER: an idle simulated robot seeks a charger at or below `chargeTriggerPct`,
 *    or earlier when it could no longer reach a charger with its reserve intact.
 *
 * ── What it is NOT ──────────────────────────────────────────────────────────
 * Not a measurement. The defaults are the owner's stated ranges for the physical RobotX
 * (standby 7–12 W, 20–40 W moving at 2 m/s), taken at their midpoints as INITIAL SIMULATION
 * ASSUMPTIONS. No coefficient here is calibrated, and nothing computed from it is physical,
 * safety or charger evidence. The fixed reserve defaults to 0 Wh because no value has been
 * supplied; it is a configured input, not a derived one.
 *
 * ── How to replace a value ──────────────────────────────────────────────────
 * Environment variables, read once by `policy()` (invalid values are refused by name and the
 * default kept): `SIM_STANDBY_POWER_W`, `SIM_MOVING_POWER_W`, `SIM_MOVING_POWER_REF_SPEED_MPS`,
 * `SIM_FIXED_RESERVE_WH`, `SIM_CHARGE_TRIGGER_PCT`. The simulator configuration endpoint can
 * also set `chargeTriggerPct` per process (`simulationConfig`).
 *
 * Pure: no clock, no I/O beyond reading the environment it is handed.
 */

const constants = require("./constants");

/** @structural the policy's own field names, defaults and admissible ranges */
const FIELDS = Object.freeze({
  standbyPowerW: { env: "SIM_STANDBY_POWER_W", default: 9.5, min: 0, max: 10_000 },
  movingPowerW: { env: "SIM_MOVING_POWER_W", default: 30, min: 0, max: 100_000 },
  movingPowerReferenceSpeedMps: { env: "SIM_MOVING_POWER_REF_SPEED_MPS", default: 2, min: 0.01, max: 50 },
  fixedReserveWh: { env: "SIM_FIXED_RESERVE_WH", default: 0, min: 0, max: 1_000_000 },
  chargeTriggerPct: { env: "SIM_CHARGE_TRIGGER_PCT", default: 20, min: 1, max: 95 },
});

/**
 * The reserve percentage applied to a robot that declares none: the floor the simulator clamps
 * its pack to (`BATTERY_MIN`), which is what F34's floor was before this policy existed.
 * @structural
 */
const UNDECLARED_RESERVE_PCT = constants.BATTERY_MIN;

/** Where the defaults come from, for every reader that reports them. @structural */
const PROVENANCE = Object.freeze({
  kind: "SIMULATION_ASSUMPTION",
  note:
    "Midpoints of the owner's stated ranges for the physical RobotX (standby 7–12 W; 20–40 W moving at 2 m/s), " +
    "used as initial simulation assumptions. Not measured, not calibrated, not physical evidence.",
});

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * Resolve the policy from an environment. Every field is validated; an invalid value is
 * refused by name and its default kept.
 *
 * @param {object} [env] defaults to `process.env`
 * @returns {{ policy: object, problems: string[] }}
 */
function resolve(env) {
  const source = env || process.env;
  const problems = [];
  const policy = {};
  for (const [name, field] of Object.entries(FIELDS)) {
    const raw = source[field.env];
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      policy[name] = field.default;
      continue;
    }
    const value = Number(raw);
    if (!isNumber(value) || value < field.min || value > field.max) {
      problems.push(`${field.env}=${String(raw)} is not a number in [${field.min}, ${field.max}]; the default ${field.default} is kept`);
      policy[name] = field.default;
      continue;
    }
    policy[name] = value;
  }
  // The trigger must lie below the charge target (`constants.TARGET_SOC_FALLBACK`): at or above it a
  // robot charged to the target re-seeks a plug at once, for ever (`simulationConfig` refuses the same).
  if (policy.chargeTriggerPct >= constants.TARGET_SOC_FALLBACK * 100) {
    problems.push(
      `${FIELDS.chargeTriggerPct.env}=${policy.chargeTriggerPct} is not below the charge target (${constants.TARGET_SOC_FALLBACK * 100} %); ` +
        `the default ${FIELDS.chargeTriggerPct.default} is kept`,
    );
    policy.chargeTriggerPct = FIELDS.chargeTriggerPct.default;
  }
  if (policy.movingPowerW < policy.standbyPowerW) {
    problems.push(
      `moving power ${policy.movingPowerW} W is below standby ${policy.standbyPowerW} W; the defaults are kept for both`,
    );
    policy.movingPowerW = FIELDS.movingPowerW.default;
    policy.standbyPowerW = FIELDS.standbyPowerW.default;
  }
  return { policy: Object.freeze(policy), problems };
}

let cached = null;

/** The policy in force for this process (resolved from `process.env` once). */
function policy() {
  if (!cached) cached = resolve(process.env);
  return cached.policy;
}

/** Problems found resolving the policy in force (empty when every value was valid). */
function policyProblems() {
  if (!cached) cached = resolve(process.env);
  return cached.problems;
}

/** Tests only: drop the cached policy so the next `policy()` re-reads the environment. */
function resetForTests() {
  cached = null;
}

/**
 * The §14.2 coefficient set the power model stands for, in Prisma column spelling (the shape
 * `EnergyModelParams` stores and `simulatedClassDeclaration` writes).
 *
 * @param {object} [given] a policy; the one in force otherwise
 * @returns {{ betaAux: number, betaDist: number, betaMoveTime: number, betaDwell: number }}
 */
function powerCoefficients(given) {
  const p = given || policy();
  // @structural seconds per hour: W → Wh/s
  const SECONDS_PER_HOUR = 3600;
  return {
    betaAux: p.standbyPowerW / SECONDS_PER_HOUR,
    betaDist: (p.movingPowerW - p.standbyPowerW) / (SECONDS_PER_HOUR * p.movingPowerReferenceSpeedMps),
    betaMoveTime: 0,
    betaDwell: 0,
  };
}

/** Read one coefficient in either spelling (Prisma `betaAux`, §14.2 `beta_aux`). */
function coefficient(coefficients, camel, snake) {
  if (!coefficients) return undefined;
  if (isNumber(coefficients[camel])) return coefficients[camel];
  if (isNumber(coefficients[snake])) return coefficients[snake];
  return undefined;
}

/**
 * The coefficients a SIMULATED robot can apply per tick exactly: every term the simulator does
 * not model (mass, climb, regen, stop-start, thermal) is zero or absent, and the four it does
 * (aux, distance, move time, dwell) are numbers. Anything else is not a simulated declaration
 * (a fitted physical row, say) and the caller must not reduce it to these four terms.
 *
 * @param {object|null} coefficients either spelling
 * @returns {{ betaAux: number, betaDist: number, betaMoveTime: number, betaDwell: number }|null}
 */
function simulatedTerms(coefficients) {
  if (!coefficients || typeof coefficients !== "object") return null;
  const aux = coefficient(coefficients, "betaAux", "beta_aux");
  const dist = coefficient(coefficients, "betaDist", "beta_dist");
  const moveTime = coefficient(coefficients, "betaMoveTime", "beta_move_time");
  const dwell = coefficient(coefficients, "betaDwell", "beta_dwell");
  if (![aux, dist, moveTime, dwell].every(isNumber)) return null;
  const unmodelled = [
    ["betaMass", "beta_mass"],
    ["betaClimb", "beta_climb"],
    ["betaRegen", "beta_regen"],
    ["betaStopStart", "beta_stop_start"],
  ];
  for (const [camel, snake] of unmodelled) {
    const value = coefficient(coefficients, camel, snake);
    if (value !== undefined && value !== 0) return null;
  }
  return { betaAux: aux, betaDist: dist, betaMoveTime: moveTime, betaDwell: dwell };
}

/**
 * Energy over one interval of a simulated robot, in Wh.
 *
 * @param {object} terms `simulatedTerms(...)`
 * @param {{ seconds: number, movingSeconds: number, dwellSeconds: number, distanceM: number }} interval
 * @returns {number}
 */
function intervalWh(terms, interval) {
  const source = interval || {};
  return (
    terms.betaAux * (source.seconds || 0) +
    terms.betaMoveTime * (source.movingSeconds || 0) +
    terms.betaDwell * (source.dwellSeconds || 0) +
    terms.betaDist * (source.distanceM || 0)
  );
}

/**
 * Wh per metre driven at `speedMps` — what a charger trip (or the engine's return leg) costs.
 *
 * @param {object} coefficients either spelling
 * @param {number} speedMps
 * @returns {number|null}
 */
function whPerMetre(coefficients, speedMps) {
  const terms = simulatedTerms(coefficients);
  if (!terms || !isNumber(speedMps) || speedMps <= 0) return null;
  return (terms.betaAux + terms.betaMoveTime) / speedMps + terms.betaDist;
}

/**
 * The reserve a robot must keep, in Wh — the commissioned percentage of its own pack plus the
 * fixed reserve. Counted once, beside the delivery and charger-trip energy.
 *
 * @param {{ packWh: number, reservePct?: number|null, fixedReserveWh?: number|null }} input
 * @returns {number|null} null when the pack is unknown
 */
function reserveWh(input) {
  const source = input || {};
  if (!isNumber(source.packWh) || source.packWh <= 0) return null;
  const pct = isNumber(source.reservePct) && source.reservePct >= 0 && source.reservePct <= 100 ? source.reservePct : UNDECLARED_RESERVE_PCT;
  const fixed = isNumber(source.fixedReserveWh) && source.fixedReserveWh >= 0 ? source.fixedReserveWh : policy().fixedReserveWh;
  // @structural percent to fraction
  return (source.packWh * pct) / 100 + fixed;
}

/**
 * The combined feasibility test, stated once: can the robot do `deliveryWh` and then travel
 * `chargerTripWh` to a charger, keeping its reserve?
 *
 * @param {{ availableWh: number, deliveryWh: number, chargerTripWh: number, reserveWh: number }} input
 * @returns {{ feasible: boolean, marginWh: number }}
 */
function feasibility(input) {
  const source = input || {};
  const marginWh = source.availableWh - (source.deliveryWh || 0) - (source.chargerTripWh || 0) - source.reserveWh;
  return { feasible: isNumber(marginWh) && marginWh >= 0, marginWh };
}

module.exports = {
  FIELDS,
  PROVENANCE,
  UNDECLARED_RESERVE_PCT,
  resolve,
  policy,
  policyProblems,
  resetForTests,
  powerCoefficients,
  simulatedTerms,
  intervalWh,
  whPerMetre,
  reserveWh,
  feasibility,
};

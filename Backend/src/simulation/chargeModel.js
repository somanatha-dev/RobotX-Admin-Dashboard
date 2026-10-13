"use strict";

/**
 * Charging lifecycle step E — the SIMULATED charge-rate model, defined once and read by the
 * simulated robot (`VirtualRobot`: the charge gained per tick and the time left to the target),
 * by the development Charging Scheduler (`devChargingScheduler.sessionHorizonSeconds`: the
 * reservable window) and by commissioning (`simulatedAgentState.simulatedPackDeclaration`: the
 * `EnergyModel.chargePowerCurve` the engine plans charging stops with). One curve per pack, so the
 * three cannot disagree.
 *
 * ── SIMULATION ASSUMPTION — not a measurement ───────────────────────────────
 * No charge rate of the physical RobotX has been measured. Both modes below are assumptions of the
 * simulation and are labelled so wherever they are reported (`PROVENANCE`).
 *
 * ── Modes (`SIM_CHARGE_CURVE_MODE`) ─────────────────────────────────────────
 *   · `ABSOLUTE_W` (the DEFAULT — the compatibility path): `constants.CHARGE_POWER_CURVE` exactly as
 *     before, in watts, whatever the pack: constant 2 000 W to 80 % SoC, then the CV taper. A 500 Wh
 *     pack therefore charges at 4 C and a 2 000 Wh pack at 1 C. Every existing simulation keeps
 *     its behaviour unless the owner opts in.
 *   · `PACK_RELATIVE`: the SAME SoC shape and temperature derating, scaled to the pack: power is a
 *     C-rate times the pack's nominal Wh. The constant-current C-rate is `SIM_CHARGE_CC_C_RATE`;
 *     its default is the current curve's own rate at its reference pack (2 000 W / 1 000 Wh =
 *     2 C), so a 1 000 Wh pack charges exactly as before and every other pack takes the same time
 *     to the same SoC. Calibrating it later means setting that one number (and, if measured, the
 *     shape) — nothing else changes.
 *
 * Invalid settings are refused by name and the default kept (as `energyPolicy` does).
 * Pure apart from reading the environment it is handed.
 */

const constants = require("./constants");

/** @structural the mode names */
const MODE = Object.freeze({ ABSOLUTE_W: "ABSOLUTE_W", PACK_RELATIVE: "PACK_RELATIVE" });

/** The pack the absolute curve was written for. @structural `constants.PACK_NOMINAL_WH` */
const REFERENCE_PACK_WH = constants.PACK_NOMINAL_WH;
/** The absolute curve's constant-current power, in W (its largest point). @structural */
const REFERENCE_CC_W = Math.max(...constants.CHARGE_POWER_CURVE.byChargerClass.STANDARD.socCurve.map((point) => point.y));
/** The absolute curve's C-rate at its reference pack — the pack-relative default. @structural derived, not chosen */
const REFERENCE_CC_C_RATE = REFERENCE_CC_W / REFERENCE_PACK_WH;

/** @structural the settings' environment variables, defaults and admissible ranges */
const FIELDS = Object.freeze({
  mode: { env: "SIM_CHARGE_CURVE_MODE", default: MODE.ABSOLUTE_W, values: Object.values(MODE) },
  ccCRate: { env: "SIM_CHARGE_CC_C_RATE", default: REFERENCE_CC_C_RATE, min: 0.05, max: 10 },
});

/** What every charge rate reported from this module is. @structural */
const PROVENANCE = Object.freeze({
  kind: "SIMULATION_ASSUMPTION",
  measured: false,
  note:
    "Simulated charge curve (constant current to 80 % SoC, then a CV taper, with temperature derating). " +
    "No charge rate of the physical RobotX has been measured; this is not charger or battery evidence.",
});

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * @param {object} [env] defaults to `process.env`
 * @returns {{ settings: { mode: string, ccCRate: number }, problems: string[] }}
 */
function resolve(env) {
  const source = env || process.env;
  const problems = [];
  const blank = (raw) => raw === undefined || raw === null || String(raw).trim() === "";

  let mode = FIELDS.mode.default;
  const rawMode = source[FIELDS.mode.env];
  if (!blank(rawMode)) {
    const value = String(rawMode).trim().toUpperCase();
    if (FIELDS.mode.values.includes(value)) mode = value;
    else problems.push(`${FIELDS.mode.env}=${String(rawMode)} is not one of ${FIELDS.mode.values.join(", ")}; ${FIELDS.mode.default} is kept`);
  }

  let ccCRate = FIELDS.ccCRate.default;
  const rawRate = source[FIELDS.ccCRate.env];
  if (!blank(rawRate)) {
    const value = Number(rawRate);
    if (isNumber(value) && value >= FIELDS.ccCRate.min && value <= FIELDS.ccCRate.max) ccCRate = value;
    else problems.push(`${FIELDS.ccCRate.env}=${String(rawRate)} is not a number in [${FIELDS.ccCRate.min}, ${FIELDS.ccCRate.max}]; ${FIELDS.ccCRate.default} C is kept`);
  }
  return { settings: Object.freeze({ mode, ccCRate }), problems };
}

let cached = null;

/** The settings in force for this process (resolved from `process.env` once). */
function settings() {
  if (!cached) cached = resolve(process.env);
  return cached.settings;
}

/** Problems found resolving the settings in force. */
function settingsProblems() {
  if (!cached) cached = resolve(process.env);
  return cached.problems;
}

/** Tests only: drop the cached settings so the next read re-reads the environment. */
function resetForTests() {
  cached = null;
}

/**
 * The charge-power curve for a pack, in the shape `engine/energy/chargeCurve.js` reads (watts).
 *
 * @param {number} packWh the pack's nominal Wh (the simulator's default pack when not a positive number)
 * @param {{ mode: string, ccCRate: number }} [given] settings; those in force otherwise
 * @returns {object} `{ byChargerClass, temperatureDerating }` — `constants.CHARGE_POWER_CURVE` itself in `ABSOLUTE_W`
 */
function curveFor(packWh, given) {
  const s = given || settings();
  if (s.mode !== MODE.PACK_RELATIVE) return constants.CHARGE_POWER_CURVE;
  const pack = isNumber(packWh) && packWh > 0 ? packWh : constants.PACK_NOMINAL_WH;
  // The same SoC shape, as a fraction of the CC power, times the pack's CC power.
  const ccW = s.ccCRate * pack;
  const byChargerClass = {};
  for (const [chargerClass, entry] of Object.entries(constants.CHARGE_POWER_CURVE.byChargerClass)) {
    byChargerClass[chargerClass] = Object.freeze({
      socCurve: Object.freeze(entry.socCurve.map((point) => Object.freeze({ x: point.x, y: (point.y / REFERENCE_CC_W) * ccW }))),
    });
  }
  return Object.freeze({ byChargerClass: Object.freeze(byChargerClass), temperatureDerating: constants.CHARGE_POWER_CURVE.temperatureDerating });
}

/**
 * The model as reported (status, dashboard): mode, constant-current power and C-rate for this
 * pack, and the provenance label.
 *
 * @param {number} packWh
 * @param {{ mode: string, ccCRate: number }} [given]
 * @returns {{ mode: string, packWh: number, ccPowerW: number, ccCRate: number, provenance: object }}
 */
function describe(packWh, given) {
  const s = given || settings();
  const pack = isNumber(packWh) && packWh > 0 ? packWh : constants.PACK_NOMINAL_WH;
  const ccPowerW = s.mode === MODE.PACK_RELATIVE ? s.ccCRate * pack : REFERENCE_CC_W;
  return { mode: s.mode, packWh: pack, ccPowerW, ccCRate: ccPowerW / pack, provenance: PROVENANCE };
}

module.exports = {
  MODE,
  FIELDS,
  PROVENANCE,
  REFERENCE_PACK_WH,
  REFERENCE_CC_W,
  REFERENCE_CC_C_RATE,
  resolve,
  settings,
  settingsProblems,
  resetForTests,
  curveFor,
  describe,
};

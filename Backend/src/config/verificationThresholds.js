"use strict";

/**
 * **Can this engine process grade a completion?** — the six §12.5 thresholds, checked once at
 * boot, before anything connects.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The thresholds are read only at the point of use, and an absent or unusable one is not an
 * error there; it is a quiet stall:
 *   - `dtaro.handler` `readVerificationThresholds` returns null, so every `TASK_COMPLETE` is
 *     held `VERIFICATION_UNAVAILABLE / NOT_CONFIGURED` and no task completes;
 *   - `legProgress.service` `arrivalRadiusM` returns null, so no arrival is ever verified and
 *     every Leg stops at its first stop;
 *   - `task.service` intake falls back to a 0 m radius for its pickup-equals-drop refusal.
 * An engine process in that state should say so once, at boot, naming the variables.
 *
 * ── The rule, and where it comes from ──────────────────────────────────────
 * The consumers' own: each value is a finite number greater than zero (`readVerificationThresholds`,
 * `arrivalRadiusM`, and `verification.requirePositive`). This module adds no range of its own.
 * It is stricter only about the *spelling*: a plain decimal (`25`, `0.8`, `8.33`), because
 * `Number()` also reads `"0x19"`, `"2.5e1"` and `" 25 "` as numbers, and a threshold written
 * that way is a misconfiguration to name rather than a value to coerce.
 *
 * ── When it is required ────────────────────────────────────────────────────
 * When this process runs the engine — the condition `server.js` already applies to the
 * signing key and to the §23.7 secrets. Graded completion and verified arrival run only
 * there. With the engine off nothing is checked and nothing changes.
 *
 * Nothing is defaulted, and a message names the variable and the requirement, never a value.
 */

/**
 * The six variables, in the order `dtaro.handler` reads them.
 * @structural the deployment's names for the §12.5 verification thresholds
 */
const NAMES = Object.freeze([
  "VERIFY_ARRIVAL_RADIUS_M",
  "VERIFY_TRACK_MIN_FIX_RATE",
  "VERIFY_TRACK_MIN_CORRIDOR_FRACTION",
  "VERIFY_TRACK_MAX_GAP_SECONDS",
  "VERIFY_CORRIDOR_HALF_WIDTH_M",
  "VERIFY_MAX_SPEED_MS",
]);

/** @structural a plain non-negative decimal: digits, optionally a point and more digits */
const PLAIN_DECIMAL = /^[0-9]+(\.[0-9]+)?$/;

function problemWith(name, value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return `${name} is unset; it has no default.`;
  }
  const text = String(value);
  if (!PLAIN_DECIMAL.test(text)) {
    return `${name} is not a plain decimal number.`;
  }
  const number = Number(text);
  if (!Number.isFinite(number) || number <= 0) {
    return `${name} must be greater than zero.`;
  }
  return null;
}

/**
 * Every problem with the six thresholds, as messages that name the variable and the
 * requirement and never the value. Empty when the engine is off.
 *
 * @param {object} [env]
 * @param {{ engineEnabled?: boolean }} [options]
 * @returns {string[]}
 */
function problems(env, options) {
  const source = env || process.env;
  if (!(options && options.engineEnabled)) return [];
  return NAMES.map((name) => problemWith(name, source[name])).filter(Boolean);
}

/**
 * @param {object} [env]
 * @param {{ engineEnabled?: boolean }} [options]
 * @throws {Error} listing every problem
 */
function assertValid(env, options) {
  const found = problems(env, options);
  if (found.length > 0) {
    const error = new Error(
      `completion verification thresholds are not usable: ${found.join(" ")} ` +
        "Without all six the engine verifies no arrival and completes no task (§12.5).",
    );
    error.code = "VERIFICATION_THRESHOLDS_INVALID";
    throw error;
  }
}

module.exports = { NAMES, problems, assertValid };

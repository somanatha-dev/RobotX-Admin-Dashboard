"use strict";

/**
 * **How long a paired robot's bearer session stays usable without being used** (H1).
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Pairing mints a bearer token, and its lifetime slides forward whenever it is used:
 * at AUTH, and while the robot stays connected (R2's heartbeat flush). It does **not**
 * slide while the robot is powered off. With the lifetime fixed at 24 h, a Pi switched
 * off over a weekend presented an expired token at its next boot. It was refused
 * (INVALID_CREDENTIAL), discarded the token, and needed a person to issue a new pairing
 * code. "Power on → online" held only for robots that were never off for a day.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 * The default is 30 days. Set `ROBOT_SESSION_TTL_SEC` to change it. The value must be a
 * plain positive integer of seconds, at least `MIN_SEC` (1 h) and at most `MAX_SEC`
 * (90 days). Anything else is refused at boot rather than coerced. There is deliberately no
 * "never expires" value: a token that is never used again must eventually stop working.
 *
 * Revocation does not depend on this lifetime. A new pairing replaces the token (KV and
 * `RobotSession` both), and decommissioning deletes both.
 */

/** @structural the deployment default: a robot may stay powered off for this long and still reconnect */
const DEFAULT_SEC = 30 * 86_400;

/** @structural shortest accepted lifetime: below this a robot re-pairs after any short outage */
const MIN_SEC = 3_600;

/** @structural longest accepted lifetime: an unused credential must lapse eventually */
const MAX_SEC = 90 * 86_400;

/** @structural the variable that may override the default */
const ENV = "ROBOT_SESSION_TTL_SEC";

/** @structural a plain positive integer of seconds */
const PLAIN_INTEGER = /^[0-9]+$/;

/**
 * The effective lifetime, or the problem that makes it unusable.
 *
 * @param {object} [env]
 * @returns {{ ttlSec: number|null, problems: string[] }}
 */
function evaluate(env) {
  const source = env || process.env;
  const raw = source[ENV];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { ttlSec: DEFAULT_SEC, problems: [] };
  }
  const text = String(raw);
  const value = PLAIN_INTEGER.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(value) || value <= 0) {
    return { ttlSec: null, problems: [`${ENV} must be a plain positive integer of seconds.`] };
  }
  if (value < MIN_SEC || value > MAX_SEC) {
    return {
      ttlSec: null,
      problems: [
        `${ENV} must be between ${MIN_SEC} and ${MAX_SEC} seconds (1 hour to 90 days): shorter strands a robot ` +
          "after a brief power-off, and a longer-lived unused credential is not accepted.",
      ],
    };
  }
  return { ttlSec: value, problems: [] };
}

/**
 * @param {object} [env]
 * @returns {number} the session lifetime in seconds
 * @throws {Error} naming the problem (never the value)
 */
function resolve(env) {
  const { ttlSec, problems } = evaluate(env);
  if (ttlSec === null) {
    const error = new Error(`Robot session lifetime is not usable: ${problems.join(" ")}`);
    error.code = "ROBOT_SESSION_TTL_INVALID";
    throw error;
  }
  return ttlSec;
}

module.exports = { DEFAULT_SEC, MIN_SEC, MAX_SEC, ENV, evaluate, resolve };

"use strict";

/**
 * **Are the two signing secrets usable?** — checked once at boot, before anything connects.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Both secrets were read only at the point of use. An absent `JWT_SECRET` surfaced as a 500
 * on every authenticated route. An absent or short `COMMAND_SIGNING_KEY` surfaced as a throw
 * from `commandSigning.requireKey` on the first OFFER. A process that cannot do either should
 * say so once, at boot, naming the variable.
 *
 * ── The rule, and where it comes from ──────────────────────────────────────
 * Both secrets are HMAC-SHA256 keys. `jwt.sign` here passes no algorithm, so it signs HS256,
 * and `commandSigning` signs HMAC-SHA256. The project already states the minimum for such a
 * key: `commandSigning.MINIMUM_KEY_BYTES` (32 bytes, UTF-8, as `requireKey` measures it).
 * It is the same floor RFC 7518 §3.2 sets for HS256. This module adds no threshold of its own.
 *
 * ── When each is required ──────────────────────────────────────────────────
 *   - `JWT_SECRET`: always. Every operator route needs it.
 *   - `COMMAND_SIGNING_KEY`: when this process runs the engine, which is the only path that
 *     signs commands. That is the condition `server.js` already applies to the §23.7
 *     secrets (`privacyKeys`). A key that is set is validated even with the engine off,
 *     because a short key is a misconfiguration whether or not it is used yet.
 *
 * Nothing is defaulted or generated, and no message carries a secret's value.
 */

const { MINIMUM_KEY_BYTES } = require("../engine/security/commandSigning");

/** @structural the deployment's names for the two signing secrets */
const ENV = Object.freeze({
  JWT_SECRET: "JWT_SECRET",
  COMMAND_SIGNING_KEY: "COMMAND_SIGNING_KEY",
});

function problemWith(name, value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return `${name} is unset; it has no default and is not generated.`;
  }
  if (Buffer.byteLength(String(value), "utf8") < MINIMUM_KEY_BYTES) {
    return `${name} is shorter than ${MINIMUM_KEY_BYTES} bytes, the minimum for an HMAC-SHA256 key.`;
  }
  return null;
}

/**
 * Every problem with the configured secrets, as messages that name the variable and the
 * requirement and never the value.
 *
 * @param {object} [env]
 * @param {{ engineEnabled?: boolean }} [options]
 * @returns {string[]}
 */
function problems(env, options) {
  const source = env || process.env;
  const engineEnabled = Boolean(options && options.engineEnabled);
  const found = [];

  const jwt = problemWith(ENV.JWT_SECRET, source[ENV.JWT_SECRET]);
  if (jwt) found.push(jwt);

  const signingKey = source[ENV.COMMAND_SIGNING_KEY];
  if (engineEnabled || (signingKey !== undefined && signingKey !== "")) {
    const signing = problemWith(ENV.COMMAND_SIGNING_KEY, signingKey);
    if (signing) found.push(engineEnabled ? `${signing} The engine signs every command with it.` : signing);
  }
  return found;
}

/**
 * @param {object} [env]
 * @param {{ engineEnabled?: boolean }} [options]
 * @throws {Error} listing every problem, without any secret value
 */
function assertValid(env, options) {
  const found = problems(env, options);
  if (found.length > 0) {
    const error = new Error(`signing secrets are not usable: ${found.join(" ")}`);
    error.code = "BOOT_SECRETS_INVALID";
    throw error;
  }
}

module.exports = { ENV, MINIMUM_KEY_BYTES, problems, assertValid };

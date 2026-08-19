"use strict";

/**
 * The two secrets §23.7's construction requires, read from the environment **here**
 * and nowhere else — PHASE 14.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * `privacy/surrogateKeys.js` and `privacy/identityStore.js` take their key material as
 * arguments and never read `process.env`, for the reason `commandSigning.js` states: a
 * module that reaches for the environment makes key rotation a code change. Something
 * must therefore be the boundary where the environment is read, and before this file
 * there were two candidates and one actual reader — `tools/migrate/backfillIdentities.js`
 * — which is why the identity path worked offline and nowhere else.
 *
 * ── Why an unset secret is refused rather than defaulted ────────────────────
 * §23.7's surrogate key is a *keyed* digest. An unkeyed digest over an address is
 * reversible by enumeration, because the space of real addresses is small; a generated
 * per-process default would be worse still, because the same address would mint a
 * different key in every process and the key would stop being stable — which is the one
 * property the whole construction rests on. Refusing is the only safe behaviour, so
 * `require()` returns a *reader*, not a value, and the reader throws at the point of use
 * rather than at import: a deployment that never touches the identity path must still be
 * able to start.
 */

const identityStore = require("../engine/privacy/identityStore");

/**
 * The environment variables this reads, named once so a runbook and an error message
 * cannot drift apart.
 * @structural the deployment's names for the two §23.7 secrets
 */
const ENV = Object.freeze({
  SURROGATE_SECRET: "PRIVACY_SURROGATE_SECRET",
  IDENTITY_KEY: "PRIVACY_IDENTITY_KEY",
});

/**
 * Is the identity path configured in this process?
 *
 * Callers that must degrade rather than fail — a read surface, a diagnostic — ask this.
 * Callers that write an identity record do not: a write that silently did not happen is
 * how an address ends up with no identity record and no erasure route.
 *
 * @param {object} [env]
 * @returns {boolean}
 */
function configured(env) {
  const source = env || process.env;
  return Boolean(source[ENV.SURROGATE_SECRET]) && Boolean(source[ENV.IDENTITY_KEY]);
}

/**
 * The surrogate-key secret and the identity-store encryption key.
 *
 * @param {object} [env]
 * @returns {{ secret: string, encryptionKey: Buffer }}
 * @throws {Error} naming the unset variable and why it has no safe default
 */
function fromEnvironment(env) {
  const source = env || process.env;
  const secret = source[ENV.SURROGATE_SECRET];
  const keyHex = source[ENV.IDENTITY_KEY];

  if (!secret) {
    throw new Error(
      `${ENV.SURROGATE_SECRET} is unset. The surrogate key is a keyed digest; an unkeyed one over an address is ` +
        "reversible by enumeration, because the space of real addresses is small (§23.7). It has no default: a " +
        "per-process one would make the same address mint a different key in every process, and the key would stop " +
        "being stable — which is the property §23.7 requires of it.",
    );
  }
  if (!keyHex) {
    throw new Error(
      `${ENV.IDENTITY_KEY} is unset. §23.7 requires encryption at rest for the identity store specifically; storing ` +
        "it in plaintext would put every delivery address in the fleet's history into any database backup.",
    );
  }

  return { secret, encryptionKey: identityStore.requireEncryptionKey(Buffer.from(keyHex, "hex")) };
}

module.exports = { ENV, configured, fromEnvironment };

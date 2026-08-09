"use strict";

/**
 * Command integrity (§23.3).
 *
 * > Every command carries: its fence scope (§10.3.1), the corresponding fence value —
 * > a commitment `fence` for a mission command, an `authority_epoch` plus
 * > `fence_floor` for an agent command — a sequence number, `not_valid_after`, and a
 * > signature over the whole payload **including the agent id**.
 *
 * > The agent MUST reject a command that: fails signature verification; is a
 * > **mission** command whose `fence` is at or below the highest seen *for that
 * > commitment id*, or at or below the current `fence_floor`; is an **agent** command
 * > whose `authority_epoch` is below the highest authority epoch seen; duplicates an
 * > already-applied `(commitment_id, sequence)` or `(agent_id, sequence)`; has expired;
 * > or is addressed to a different agent id. Every rejection is reported and counted,
 * > by scope.
 *
 * This module owns the first and the last two of those: the envelope's canonical form,
 * its signature, its expiry, and its addressee. The fence and sequence rules live
 * where they are already stated once — `commitment/fencing.js` and
 * `dispatch/sequence.js` — and this module deliberately does not restate them.
 *
 * ── "including the agent id" is the load-bearing clause ─────────────────────
 * A signature over the payload alone is a signature that can be replayed at a
 * *different* agent: the payload of an `OFFER` says nothing about who was offered it.
 * Binding the agent id into the signed form makes a misaddressed command a signature
 * failure rather than a policy check somebody could forget to write.
 *
 * ── Symmetric at Phase 4, asymmetric at Phase 14 ────────────────────────────
 * Phase 4 signed with HMAC-SHA256 over a canonical serialisation and recorded the
 * promise that Phase 14 "replaces the *key material and algorithm*, not the envelope".
 * **Phase 14 keeps that promise exactly.** `SIGNED_FIELDS`, `canonicalise()` and the
 * separator are byte-for-byte what Phase 4 shipped; what is added is `ALGORITHM.ED25519`
 * beside the existing `HMAC_SHA256`, selected per call, defaulting to HMAC so that every
 * Phase 4 caller and every deployed agent is unaffected.
 *
 * ── Why asymmetric matters, and why HMAC is not simply replaced ─────────────
 * An HMAC key that lets an agent *verify* a command also lets it *forge* one, because
 * the two are the same key. In a fleet that means the compromise of one device yields a
 * key that mints commands for every device — §23.1's "compromised agent" row escalating
 * into its "spoofed agent identity" row. Ed25519 removes that: the fleet holds a public
 * key and can verify, and only the coordinator can sign.
 *
 * HMAC is nonetheless retained rather than deleted, because a signing scheme is a
 * *coordinated firmware rollout* (the plan's own risk note for this phase), and a
 * migration in which the server can only speak the new scheme is one in which every
 * un-updated agent stops accepting commands at the moment of deploy. Both are supported
 * and the envelope records which was used, so a fleet moves device by device.
 *
 * Tier 1 by path (`src/engine/security/`), serving the Tier 0 rejection rules of
 * §10.3.1 by making the fields they compare unforgeable.
 */

const crypto = require("crypto");

const clock = require("../commitment/clock");
const fencing = require("../commitment/fencing");

/** @structural the HMAC digest algorithm; Phase 14 adds a scheme beside it, not in place of it */
const SIGNATURE_ALGORITHM = "sha256";

/**
 * The two signing schemes (§23.2, §23.3).
 *
 * `HMAC_SHA256` is Phase 4's and remains the default, so no existing caller changes
 * behaviour by upgrading. `ED25519` is the per-device, hardware-backed scheme §23.2
 * asks for; it takes a `KeyObject` (or PEM) rather than a shared secret, which is what
 * makes "keys in a secure element where available" expressible at all — a secure element
 * exports a public key and never a secret.
 * @structural the signature scheme labels
 */
const ALGORITHM = Object.freeze({
  HMAC_SHA256: "HMAC_SHA256",
  ED25519: "ED25519",
});

const ALGORITHMS = Object.freeze(Object.values(ALGORITHM));

/**
 * The canonical-form field separator: ASCII **unit separator**. Written as an escape
 * rather than as a literal control byte, because a literal one is invisible in a diff
 * and in review — Phase 3 lost an hour to a NUL that had silently replaced a space in
 * an identically-shaped constant, and the check that depended on it became inert
 * without failing.
 *
 * Chosen over a printable character because a printable one is a character a payload
 * could plausibly contain, which would make the encoding ambiguous. `JSON.stringify`
 * escapes it inside any string it renders, so no component can smuggle one in.
 * @structural the canonical-form field separator; refused inside any component
 */
const FIELD_SEPARATOR = "\u001f";

/** @structural the shortest key admitted; below this the HMAC is not a secret */
const MINIMUM_KEY_BYTES = 32;

/**
 * The fields that enter the signature, in a fixed order.
 *
 * Order is part of the canonical form: two envelopes whose fields differ only in
 * serialisation order must produce the same signed bytes, or verification becomes a
 * property of how the sender happened to build its object.
 */
const SIGNED_FIELDS = Object.freeze([
  "agentId",
  "command",
  "commandClass",
  "fenceScope",
  "commitmentId",
  "fence",
  "authorityEpoch",
  "fenceFloor",
  "sequence",
  "notValidAfter",
  "payload",
]);

/**
 * Reject a key that cannot carry the property a signature is supposed to have.
 *
 * @param {string|Buffer} key
 * @returns {Buffer}
 */
function requireKey(key) {
  if (key === undefined || key === null || key === "") {
    throw new TypeError(
      "command signing requires a key. An unsigned command is one an attacker — or an innocent misrouted queue — " +
        "can synthesise, and §23.3 makes signature verification the agent's first rejection rule.",
    );
  }
  const material = Buffer.isBuffer(key) ? key : Buffer.from(String(key), "utf8");
  if (material.length < MINIMUM_KEY_BYTES) {
    throw new RangeError(
      `the command signing key is ${material.length} bytes; a key shorter than ${MINIMUM_KEY_BYTES} bytes does not ` +
        "carry the secrecy the signature claims (§23.3)",
    );
  }
  return material;
}

/**
 * Serialise a value into the canonical form, deterministically.
 *
 * Objects are serialised with their keys sorted, so an envelope whose payload was
 * built by two different code paths signs identically. `BigInt` is rendered as its
 * decimal string, because the two fence scopes are BigInt on the server and arrive as
 * strings on the wire, and a signature that depended on which one the verifier held
 * would fail for the honest case and pass for nothing.
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonicalValue(value) {
  // Bare `null`, which `JSON.stringify` never produces for a string — the string
  // "null" renders as `"null"`, with quotes — so absence and the literal word are
  // distinguishable in the signed bytes.
  if (value === undefined || value === null) return "null";
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The canonical byte string a signature covers.
 *
 * @param {object} envelope
 * @returns {string}
 */
function canonicalise(envelope) {
  const source = envelope || {};

  if (typeof source.agentId !== "string" || source.agentId === "") {
    throw new TypeError("the signature covers the agent id; an envelope without one cannot be bound to its addressee (§23.3)");
  }
  // Validates the command against §10.3.1's table and throws on an unknown one, so a
  // command nobody assigned a scope cannot be signed into existence.
  fencing.fenceScopeOf(source.command);

  const parts = SIGNED_FIELDS.map((field) => {
    const rendered = canonicalValue(source[field]);
    if (rendered.includes(FIELD_SEPARATOR)) {
      throw new TypeError(`field "${field}" contains the canonical-form separator; the encoding would be ambiguous`);
    }
    return `${field}=${rendered}`;
  });

  return parts.join(FIELD_SEPARATOR);
}

/**
 * Which scheme does this call use?
 *
 * Defaulting rather than requiring: every Phase 4 call site passes two arguments, and
 * an unrecognised label is refused rather than silently treated as HMAC — a typo that
 * downgraded the scheme would be invisible and would produce a signature that verifies.
 *
 * @param {object|string|undefined} options
 * @returns {string}
 */
function algorithmOf(options) {
  const requested = typeof options === "string" ? options : options && options.algorithm;
  if (requested === undefined || requested === null) return ALGORITHM.HMAC_SHA256;
  if (!ALGORITHMS.includes(requested)) {
    throw new TypeError(
      `"${String(requested)}" is not one of ${ALGORITHMS.join(", ")}. An unrecognised label is refused rather than ` +
        "defaulted: a typo that silently downgraded the scheme would still produce a signature that verifies (§23.3).",
    );
  }
  return requested;
}

/**
 * Sign an envelope.
 *
 * @param {object} envelope
 * @param {string|Buffer|import("crypto").KeyObject} key an HMAC secret, or an Ed25519
 *   private key when `options.algorithm` is `ED25519`
 * @param {{ algorithm?: string }|string} [options]
 * @returns {string} the hex signature
 */
function sign(envelope, key, options) {
  const algorithm = algorithmOf(options);
  const bytes = canonicalise(envelope);

  if (algorithm === ALGORITHM.ED25519) {
    // No `requireKey` length check: an Ed25519 key is a `KeyObject` or PEM, and applying
    // a shared-secret minimum to it would reject a valid key for the wrong reason. Node
    // refuses a key of the wrong type here, which is the check that actually applies.
    return crypto.sign(null, Buffer.from(bytes, "utf8"), key).toString("hex");
  }

  return crypto.createHmac(SIGNATURE_ALGORITHM, requireKey(key)).update(bytes, "utf8").digest("hex");
}

/**
 * Verify a signature in constant time.
 *
 * `timingSafeEqual` rather than `===`: a comparison that returns early on the first
 * differing byte leaks the prefix of a valid signature to anyone who can measure it,
 * which turns forgery from infeasible into a few thousand requests. Ed25519 verification
 * is constant-time inside OpenSSL, so the same property holds on that branch without a
 * comparison here.
 *
 * @param {object} envelope
 * @param {string} signature
 * @param {string|Buffer|import("crypto").KeyObject} key the HMAC secret, or the
 *   **public** key for `ED25519`
 * @param {{ algorithm?: string }|string} [options]
 * @returns {boolean}
 */
function verify(envelope, signature, key, options) {
  if (typeof signature !== "string" || signature === "") return false;

  let algorithm;
  try {
    algorithm = algorithmOf(options);
  } catch {
    return false;
  }

  if (algorithm === ALGORITHM.ED25519) {
    try {
      return crypto.verify(null, Buffer.from(canonicalise(envelope), "utf8"), key, Buffer.from(signature, "hex"));
    } catch {
      return false;
    }
  }

  let expected;
  try {
    expected = sign(envelope, key);
  } catch {
    return false;
  }
  const given = Buffer.from(signature, "hex");
  const want = Buffer.from(expected, "hex");
  if (given.length !== want.length || want.length === 0) return false;
  return crypto.timingSafeEqual(given, want);
}

/**
 * §23.3 — the two envelope-level rejection rules an agent applies before it looks at
 * a fence at all: has it expired, and is it addressed to me?
 *
 * > A mission offer that surfaces twenty minutes late must not be executed, because
 * > the world has moved on; an expiring offer makes that safe by default rather than
 * > by hoping the delay never happens.
 *
 * @param {object} envelope
 * @param {object} context
 * @param {string} context.agentId the receiving agent's own id
 * @param {Date} context.now the receiver's clock
 * @param {string|Buffer|import("crypto").KeyObject} context.key
 * @param {string} [context.algorithm]
 * @returns {{ accepted: boolean, reason: string|null, scope: string|null }}
 */
function admitEnvelope(envelope, context) {
  const settings = context || {};
  const source = envelope || {};

  // §23.3 — "Every rejection is reported and counted, by scope." The scope travels with
  // the reason so the counter is dimensioned at the point of refusal; deriving it later
  // from the command name would fail for exactly the envelopes whose command field is
  // the thing that was tampered with.
  const scope = scopeOfEnvelope(source);

  if (!verify(source, source.signature, settings.key, { algorithm: settings.algorithm })) {
    return { accepted: false, reason: "SIGNATURE_INVALID", scope };
  }
  if (source.agentId !== settings.agentId) {
    return { accepted: false, reason: "ADDRESSED_TO_ANOTHER_AGENT", scope };
  }
  if (clock.hasPassed(source.notValidAfter, settings.now)) {
    return { accepted: false, reason: "NOT_VALID_AFTER_PASSED", scope };
  }
  return { accepted: true, reason: null, scope };
}

/**
 * The fence scope a rejection is counted under, tolerating an envelope whose `command`
 * is unrecognised — which is itself a countable outcome rather than a throw, because a
 * receiver must be able to count what it refused.
 *
 * @param {object} envelope
 * @returns {string|null}
 */
function scopeOfEnvelope(envelope) {
  try {
    return fencing.fenceScopeOf(envelope && envelope.command);
  } catch {
    return "UNKNOWN_COMMAND";
  }
}

module.exports = {
  SIGNATURE_ALGORITHM,
  ALGORITHM,
  ALGORITHMS,
  SIGNED_FIELDS,
  MINIMUM_KEY_BYTES,
  algorithmOf,
  canonicalValue,
  canonicalise,
  sign,
  verify,
  scopeOfEnvelope,
  admitEnvelope,
};

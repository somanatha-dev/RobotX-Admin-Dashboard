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
 * ── Symmetric now, asymmetric at Phase 14 ───────────────────────────────────
 * Phase 4 signs with HMAC-SHA256 over a canonical serialisation. Phase 14 owns mTLS,
 * per-device certificates, and hardware-backed keys (§23.2); it replaces the *key
 * material and algorithm*, not the envelope, which is why the canonical form and the
 * field set are fixed here and the key is an injected parameter rather than an
 * environment read. A module that reached for `process.env` would make key rotation a
 * code change.
 *
 * Tier 1 by path (`src/engine/security/`), serving the Tier 0 rejection rules of
 * §10.3.1 by making the fields they compare unforgeable.
 */

const crypto = require("crypto");

const clock = require("../commitment/clock");
const fencing = require("../commitment/fencing");

/** @structural the HMAC digest algorithm; Phase 14 replaces the scheme, not the envelope */
const SIGNATURE_ALGORITHM = "sha256";

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
 * Sign an envelope.
 *
 * @param {object} envelope
 * @param {string|Buffer} key
 * @returns {string} the hex signature
 */
function sign(envelope, key) {
  const material = requireKey(key);
  return crypto.createHmac(SIGNATURE_ALGORITHM, material).update(canonicalise(envelope), "utf8").digest("hex");
}

/**
 * Verify a signature in constant time.
 *
 * `timingSafeEqual` rather than `===`: a comparison that returns early on the first
 * differing byte leaks the prefix of a valid signature to anyone who can measure it,
 * which turns forgery from infeasible into a few thousand requests.
 *
 * @param {object} envelope
 * @param {string} signature
 * @param {string|Buffer} key
 * @returns {boolean}
 */
function verify(envelope, signature, key) {
  if (typeof signature !== "string" || signature === "") return false;
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
 * @param {string|Buffer} context.key
 * @returns {{ accepted: boolean, reason: string|null }}
 */
function admitEnvelope(envelope, context) {
  const settings = context || {};
  const source = envelope || {};

  if (!verify(source, source.signature, settings.key)) {
    return { accepted: false, reason: "SIGNATURE_INVALID" };
  }
  if (source.agentId !== settings.agentId) {
    return { accepted: false, reason: "ADDRESSED_TO_ANOTHER_AGENT" };
  }
  if (clock.hasPassed(source.notValidAfter, settings.now)) {
    return { accepted: false, reason: "NOT_VALID_AFTER_PASSED" };
  }
  return { accepted: true, reason: null };
}

module.exports = {
  SIGNATURE_ALGORITHM,
  SIGNED_FIELDS,
  MINIMUM_KEY_BYTES,
  canonicalValue,
  canonicalise,
  sign,
  verify,
  admitEnvelope,
};

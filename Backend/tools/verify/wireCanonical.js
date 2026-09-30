"use strict";

/**
 * P2B-2 — an **independent** implementation of the §23.3 command-signature canonical form,
 * written from the definition in `docs/contracts/ROBOTX_PI_P2B1_HANDOFF.md` §6.1 and fed
 * only what an agent receives: the envelope **as parsed from the wire JSON**.
 *
 * It deliberately does not import `engine/security/commandSigning`. The point is to show
 * that an agent which has never seen the server's in-memory objects (BigInt fences, Date
 * instants, a payload that has not yet been through JSON) can reproduce the signed bytes
 * from the wire alone — which is what the Raspberry Pi has to do. If this and the server
 * ever disagree, the agent rejects every command as SIGNATURE_INVALID.
 *
 * The definition, restated:
 *
 *   canonical = SIGNED_FIELDS.map(f => `${f}=${render(f, envelope[f])}`).join("\u001f")
 *   SIGNED_FIELDS (this order, never sorted):
 *     agentId, command, commandClass, fenceScope, commitmentId, fence, authorityEpoch,
 *     fenceFloor, sequence, notValidAfter, payload
 *   render:
 *     absent / null                      → null
 *     fence, authorityEpoch, fenceFloor  → the integer's decimal digits, UNQUOTED
 *                                          (the wire carries them as strings)
 *     notValidAfter                      → the ISO-8601 instant, UNQUOTED
 *                                          (YYYY-MM-DDTHH:mm:ss.sssZ, as on the wire)
 *     every other value, recursively     → JSON (ECMAScript JSON.stringify rules), except
 *                                          that object keys are sorted (UTF-16 code-unit
 *                                          order) at EVERY depth, arrays keep their order,
 *                                          and a null member renders `null`
 *   signature = lower-case hex HMAC-SHA256(key = UTF-8 bytes of COMMAND_SIGNING_KEY,
 *                                          message = UTF-8 bytes of canonical)
 */

const crypto = require("crypto");

const SEPARATOR = "\u001f";
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
const INTEGER_FIELDS = new Set(["fence", "authorityEpoch", "fenceFloor"]);
const INSTANT_FIELDS = new Set(["notValidAfter"]);

function renderJson(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(renderJson).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${renderJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function renderField(field, value) {
  if (value === null || value === undefined) return "null";
  if (INTEGER_FIELDS.has(field)) {
    const text = String(value).trim();
    if (!/^-?\d+$/.test(text)) throw new TypeError(`${field} is not an integer on the wire: ${JSON.stringify(value)}`);
    return BigInt(text).toString();
  }
  if (INSTANT_FIELDS.has(field)) {
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) throw new TypeError(`${field} is not an instant: ${JSON.stringify(value)}`);
    return at.toISOString();
  }
  return renderJson(value);
}

/** @param {object} wireEnvelope the envelope as `JSON.parse` returned it */
function canonicalFromWire(wireEnvelope) {
  return SIGNED_FIELDS.map((field) => `${field}=${renderField(field, wireEnvelope[field])}`).join(SEPARATOR);
}

function hmacHex(canonical, key) {
  return crypto.createHmac("sha256", Buffer.from(String(key), "utf8")).update(canonical, "utf8").digest("hex");
}

/**
 * @param {object} wireEnvelope
 * @param {string} key
 * @returns {{ ok: boolean, canonical: string, expected: string, given: string|null }}
 */
function verifyFromWire(wireEnvelope, key) {
  const canonical = canonicalFromWire(wireEnvelope);
  const expected = hmacHex(canonical, key);
  const given = typeof wireEnvelope.signature === "string" ? wireEnvelope.signature : null;
  return { ok: given !== null && given === expected, canonical, expected, given };
}

module.exports = { SEPARATOR, SIGNED_FIELDS, canonicalFromWire, hmacHex, verifyFromWire };

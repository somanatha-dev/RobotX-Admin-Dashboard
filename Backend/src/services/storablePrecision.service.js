"use strict";

/**
 * P2B-2 — numbers in a signed payload must survive the store unchanged.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 * An OFFER is signed over its payload **in memory**, then written to `Outbox.payload`
 * (a `Json` column) and delivered by reading the row back (`outbox.worker.envelopeOf`).
 * The Prisma → PostgreSQL `jsonb` write path shortens doubles to about 16 significant
 * digits: `1790219666136.0542` is stored as `1790219666136.054`, `0.1 + 0.2` as `0.3`.
 * Measured on PG 18.3 through the real client, 2 273 of 5 000 random doubles changed.
 * The agent verifies the bytes it receives, so every OFFER carrying such a number — fractional
 * millisecond ETAs, haversine path lengths, reserve watt-hours — failed signature
 * verification at the agent (`SIGNATURE_INVALID`). `VirtualRobot` is never given a signing
 * key, which is why the V1 runs never saw it; the physical Pi, which verifies, would have
 * rejected every real OFFER.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 * Every non-integer finite number in the payload is quantised to
 * `STORABLE_SIGNIFICANT_DIGITS` (15) significant digits **before** it is signed, so the
 * value signed, the value stored and the value delivered are one value. Measured through the
 * same path: 0 of 5 000 quantised values changed. Integers are left alone (every integer the
 * payload carries is below 2^53 and is stored exactly). 15 significant digits is a
 * sub-micrometre position, a hundredth of a millisecond on an epoch timestamp and a
 * femto-watt-hour on a reserve — nothing any reader of the offer can observe.
 *
 * It changes no decision: the plan, its costs and its commitment are computed before this
 * and are not re-read from here. It shapes only the *content of the message* the agent is
 * sent.
 */

/** @structural the precision a stored `jsonb` number keeps exactly (measured, see header) */
const STORABLE_SIGNIFICANT_DIGITS = 15;

/**
 * Deep-copy `value`, quantising every non-integer finite number.
 *
 * @param {*} value
 * @returns {*}
 */
function toStorablePrecision(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && !Number.isInteger(value) ? Number(value.toPrecision(STORABLE_SIGNIFICANT_DIGITS)) : value;
  }
  if (Array.isArray(value)) return value.map(toStorablePrecision);
  if (value && typeof value === "object" && !(value instanceof Date) && typeof value !== "bigint") {
    const out = {};
    for (const [key, member] of Object.entries(value)) out[key] = toStorablePrecision(member);
    return out;
  }
  return value;
}

module.exports = { STORABLE_SIGNIFICANT_DIGITS, toStorablePrecision };

"use strict";

/**
 * Clock discipline (§10.6).
 *
 * > Leases and offer TTLs depend on time, so clock behaviour is specified rather than
 * > assumed:
 * >
 * > - All deadlines are stored as absolute timestamps from the Commitment Store's
 * >   clock, which is the single authority for lease validity.
 * > - Comparisons for safety decisions use a monotonic source plus the store's
 * >   timestamp; wall clocks on workers are never trusted for lease validity.
 * > - Maximum tolerated skew is `time.max_clock_skew` (default 500 ms), monitored;
 * >   leases embed that margin. A node exceeding the skew bound removes itself from
 * >   leadership eligibility.
 * > - **Correctness does not depend on synchronised clocks** — that is the point of
 * >   the two fences (§10.3.1) and of the transactional leadership guard G1. Clocks
 * >   affect *liveness* (how quickly a lost lease is detected), not *safety*.
 *
 * The last bullet is why this module is small and why nothing in `commit.js` branches
 * on a clock: a commit that would be correct at one skew and incorrect at another
 * would be a safety property resting on time synchronisation, which the architecture
 * explicitly refuses. What the clock decides here is *eligibility to lead* and *when
 * a lease expires* — both liveness concerns.
 *
 * ── Why the store's clock, specifically ─────────────────────────────────────
 * A lease expiry written from a worker's wall clock is a deadline in a coordinate
 * system no other participant shares. Two workers whose clocks differ by a second
 * would write leases that disagree by a second about when supervision lapses, and the
 * disagreement would be invisible. Reading `NOW()` from the store inside the same
 * transaction that writes the lease removes the coordinate system entirely.
 *
 * Tier 0 (T0-05).
 */

/**
 * Read the Commitment Store's clock inside a transaction.
 *
 * The SQL is `SELECT NOW()`, not `CURRENT_TIMESTAMP` at statement level, because
 * within a transaction PostgreSQL's `NOW()` is the transaction start time — which is
 * the property we want: every deadline written by one commit shares one origin, so a
 * commit that takes 40 ms under lock contention does not produce a lease 40 ms shorter
 * than one that took none.
 *
 * @param {{ $queryRawUnsafe?: Function, $queryRaw?: Function }} tx a transaction client
 * @returns {Promise<Date>} the store's transaction timestamp
 */
async function readStoreTime(tx) {
  if (!tx || typeof tx.$queryRawUnsafe !== "function") {
    throw new TypeError(
      "the store clock is read through the transaction client; a lease timed from a worker's wall clock is a " +
        "deadline in a coordinate system no other participant shares (§10.6)",
    );
  }
  const rows = await tx.$queryRawUnsafe('SELECT NOW() AS "now"');
  const value = Array.isArray(rows) && rows.length > 0 ? rows[0].now : null;
  const stamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(stamp.getTime())) {
    throw new Error("the Commitment Store returned no readable transaction timestamp (§10.6)");
  }
  return stamp;
}

/**
 * A monotonic reading, for pairing with the store's timestamp in safety comparisons.
 *
 * > Comparisons for safety decisions use a monotonic source plus the store's
 * > timestamp; wall clocks on workers are never trusted.
 *
 * `process.hrtime.bigint()` is unaffected by NTP steps and by the operator setting the
 * system clock, which is exactly the difference that matters: it can measure *elapsed*
 * time honestly even while the wall clock is wrong.
 *
 * @returns {bigint} nanoseconds from an arbitrary origin
 */
function monotonicNanos() {
  return process.hrtime.bigint();
}

/** @structural nanoseconds per millisecond — a unit conversion, not a threshold */
const NANOS_PER_MILLISECOND = 1000000n;

/**
 * Elapsed milliseconds between two monotonic readings.
 *
 * @param {bigint} startNanos
 * @param {bigint} endNanos
 * @returns {number}
 */
function elapsedMillis(startNanos, endNanos) {
  return Number((endNanos - startNanos) / NANOS_PER_MILLISECOND);
}

/**
 * Measure this node's skew against the store's clock.
 *
 * Positive means the node is *ahead* of the store. The sign is preserved rather than
 * taking an absolute value at the measurement site, because the two directions have
 * different operational meanings and both are monitored.
 *
 * @param {Date} storeTime the store's transaction timestamp
 * @param {number} localEpochMillis the node's own wall clock at the same moment
 * @returns {number} skew in milliseconds
 */
function measureSkew(storeTime, localEpochMillis) {
  return localEpochMillis - storeTime.getTime();
}

/**
 * Is this node within the skew budget?
 *
 * @param {number} skewMillis signed, from `measureSkew`
 * @param {number} maxClockSkewMillis `time.max_clock_skew`
 * @returns {boolean}
 */
function isWithinSkewBound(skewMillis, maxClockSkewMillis) {
  if (!Number.isFinite(skewMillis) || !Number.isFinite(maxClockSkewMillis)) return false;
  return Math.abs(skewMillis) <= maxClockSkewMillis;
}

/**
 * §10.6: "A node exceeding the skew bound removes itself from leadership eligibility."
 *
 * Self-removal rather than external eviction, because a node that cannot trust its own
 * clock is precisely the node that should not be waiting for someone else's timeout to
 * notice.
 *
 * @param {number} skewMillis
 * @param {number} maxClockSkewMillis `time.max_clock_skew`
 * @returns {{ eligible: boolean, reason: string|null, skewMillis: number }}
 */
function assessLeadershipEligibility(skewMillis, maxClockSkewMillis) {
  if (isWithinSkewBound(skewMillis, maxClockSkewMillis)) {
    return { eligible: true, reason: null, skewMillis };
  }
  return {
    eligible: false,
    reason:
      `this node's clock differs from the Commitment Store's by ${skewMillis} ms, beyond the ` +
      `time.max_clock_skew budget of ${maxClockSkewMillis} ms; it removes itself from leadership eligibility (§10.6)`,
    skewMillis,
  };
}

/** @structural milliseconds per second — a unit conversion, not a threshold */
const MILLIS_PER_SECOND = 1000;

/**
 * An absolute deadline, `seconds` after the store's timestamp.
 *
 * @param {Date} storeTime
 * @param {number} seconds
 * @returns {Date}
 */
function deadlineFrom(storeTime, seconds) {
  if (!(storeTime instanceof Date) || Number.isNaN(storeTime.getTime())) {
    throw new TypeError("a deadline is computed from the store's timestamp, never from a worker's clock (§10.6)");
  }
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new RangeError(`a deadline needs a positive duration in seconds; received ${String(seconds)}`);
  }
  return new Date(storeTime.getTime() + seconds * MILLIS_PER_SECOND);
}

/**
 * Has an absolute deadline passed, as judged against the store's clock?
 *
 * @param {Date|string|null} deadline
 * @param {Date} storeTime
 * @returns {boolean} true also when the deadline is absent — an unknown deadline is
 *   not a valid one (T2: unknown is never permission)
 */
function hasPassed(deadline, storeTime) {
  if (deadline === undefined || deadline === null) return true;
  const at = deadline instanceof Date ? deadline : new Date(deadline);
  if (Number.isNaN(at.getTime())) return true;
  return at.getTime() <= storeTime.getTime();
}

module.exports = {
  readStoreTime,
  monotonicNanos,
  elapsedMillis,
  measureSkew,
  isWithinSkewBound,
  assessLeadershipEligibility,
  deadlineFrom,
  hasPassed,
};

"use strict";

/**
 * Fixed-point cost arithmetic (§9.6 requirement 1).
 *
 * > **Integer arithmetic in the objective.** All costs are int64 milli-CU.
 * > Floating-point summation over a set is order-dependent at the bit level;
 * > integers are not. Conversions from float estimates to milli-CU use a single
 * > specified rounding mode.
 *
 * Every quantity here is a `BigInt` count of milli-CU. Three consequences that are
 * the whole point of the module:
 *
 *   - **Summation is exact and order-independent.** `BigInt` addition is associative
 *     and commutative without rounding, so a round's total cost does not depend on
 *     the order in which candidates happened to be enumerated. This is what makes
 *     bit-identical replay achievable at all (§24.3).
 *   - **The conversion boundary is one function.** Float estimates enter through
 *     `toMilliCU()` and nowhere else, so "which rounding did this use?" has one
 *     answer for the whole engine.
 *   - **Overflow is an error, not a wrap.** Every operation range-checks against
 *     int64, because a silently wrapped cost is a decision made on a number nobody
 *     computed.
 *
 * ── The specified rounding mode ─────────────────────────────────────────────
 * **Round half away from zero.** Chosen, and stated once, for one property the
 * engine depends on: it is symmetric under negation, so `toMilliCU(−x)` is exactly
 * `−toMilliCU(x)`. `C_opportunity` and `C_policy` are the two terms that may be
 * negative (§6.4), and a rounding mode that treated their sign asymmetrically would
 * make the sign of a near-zero cost an artefact of the rounding rather than of the
 * model.
 */

/** @structural the milli- prefix: 1 CU is 1 000 milli-CU by definition of the unit */
const MILLI_PER_CU = 1000;

/** @structural the milli- prefix, as the BigInt the arithmetic uses */
const MILLI_PER_CU_BIG = 1000n;

/** @structural the half-way point of the stated rounding mode */
const ROUNDING_HALF = 0.5;

/** @structural int64 lower bound — the width §9.6 requirement 1 specifies */
const INT64_MIN = -9223372036854775808n;

/** @structural int64 upper bound — the width §9.6 requirement 1 specifies */
const INT64_MAX = 9223372036854775807n;

/**
 * The single rounding mode, named so a decision record can cite it.
 */
const ROUNDING_MODE = "ROUND_HALF_AWAY_FROM_ZERO";

/**
 * Guard an intermediate against the int64 width the specification requires.
 *
 * @param {bigint} value
 * @param {string} [operation]
 * @returns {bigint}
 * @throws {RangeError}
 */
function assertInt64(value, operation) {
  if (typeof value !== "bigint") {
    throw new TypeError(
      `milli-CU arithmetic${operation ? ` (${operation})` : ""} received ${typeof value}; ` +
        "costs are int64 milli-CU BigInts (§9.6)",
    );
  }
  if (value < INT64_MIN || value > INT64_MAX) {
    throw new RangeError(
      `milli-CU overflow${operation ? ` in ${operation}` : ""}: ${value} is outside int64. ` +
        "A silently wrapped cost is a decision made on a number nobody computed (§9.6).",
    );
  }
  return value;
}

/**
 * Convert a float CU estimate into int64 milli-CU under the single specified
 * rounding mode.
 *
 * @param {number} cu cost in CU
 * @returns {bigint} milli-CU
 * @throws {TypeError} on a non-finite input — a cost that is NaN or infinite is a
 *   modelling error, and rounding it would hide that
 */
function toMilliCU(cu) {
  if (typeof cu !== "number" || !Number.isFinite(cu)) {
    throw new TypeError(
      `toMilliCU received ${JSON.stringify(cu)}; a cost must be a finite number of CU (§1.3, §9.6)`,
    );
  }
  const scaled = cu * MILLI_PER_CU;
  const rounded = scaled >= 0 ? Math.floor(scaled + ROUNDING_HALF) : Math.ceil(scaled - ROUNDING_HALF);
  if (!Number.isSafeInteger(rounded)) {
    throw new RangeError(
      `toMilliCU(${cu}) rounds to ${rounded}, which is outside the safe integer range; ` +
        "the conversion boundary cannot represent it exactly (§9.6)",
    );
  }
  return assertInt64(BigInt(rounded), "toMilliCU");
}

/**
 * Convert milli-CU back to CU. **For display, currency views, and reporting only.**
 * No decision is taken on the result: the objective is compared in milli-CU.
 *
 * @param {bigint} milliCU
 * @returns {number}
 */
function toCU(milliCU) {
  assertInt64(milliCU, "toCU");
  return Number(milliCU) / MILLI_PER_CU;
}

/**
 * Exact CU → milli-CU for a value already known to be an integer number of CU.
 *
 * @param {number|bigint} cu
 * @returns {bigint}
 */
function fromWholeCU(cu) {
  const asBig = typeof cu === "bigint" ? cu : BigInt(cu);
  return assertInt64(asBig * MILLI_PER_CU_BIG, "fromWholeCU");
}

/**
 * @param {bigint} a
 * @param {bigint} b
 * @returns {bigint}
 */
function add(a, b) {
  assertInt64(a, "add");
  assertInt64(b, "add");
  return assertInt64(a + b, "add");
}

/**
 * @param {bigint} a
 * @param {bigint} b
 * @returns {bigint}
 */
function subtract(a, b) {
  assertInt64(a, "subtract");
  assertInt64(b, "subtract");
  return assertInt64(a - b, "subtract");
}

/**
 * @param {bigint} value
 * @returns {bigint}
 */
function negate(value) {
  assertInt64(value, "negate");
  return assertInt64(-value, "negate");
}

/**
 * Sum a collection of milli-CU quantities.
 *
 * The result does not depend on the iteration order. That is not an optimisation —
 * it is the property §9.6 requirement 1 exists to obtain, and the one a float
 * accumulator cannot provide.
 *
 * @param {Iterable<bigint>} values
 * @returns {bigint}
 */
function sum(values) {
  let total = 0n;
  for (const value of values) {
    assertInt64(value, "sum");
    total += value;
  }
  return assertInt64(total, "sum");
}

/**
 * Multiply a milli-CU quantity by an integer count (e.g. a number of Legs).
 *
 * @param {bigint} milliCU
 * @param {bigint|number} count
 * @returns {bigint}
 */
function multiplyByCount(milliCU, count) {
  assertInt64(milliCU, "multiplyByCount");
  const asBig = typeof count === "bigint" ? count : BigInt(count);
  return assertInt64(milliCU * asBig, "multiplyByCount");
}

/**
 * Apply a real-valued rate to a milli-CU quantity, rounding once under the single
 * specified mode.
 *
 * Used where an exchange rate or a dimensionless shaping factor multiplies an
 * already-priced quantity. The rounding happens exactly once, here, rather than
 * accumulating through a chain of float operations.
 *
 * @param {bigint} milliCU
 * @param {number} rate
 * @returns {bigint}
 */
function scaleByRate(milliCU, rate) {
  assertInt64(milliCU, "scaleByRate");
  if (typeof rate !== "number" || !Number.isFinite(rate)) {
    throw new TypeError(`scaleByRate received rate ${JSON.stringify(rate)}; a rate must be finite (§1.3)`);
  }
  const product = Number(milliCU) * rate;
  const rounded = product >= 0 ? Math.floor(product + ROUNDING_HALF) : Math.ceil(product - ROUNDING_HALF);
  if (!Number.isSafeInteger(rounded)) {
    throw new RangeError(`scaleByRate(${milliCU}, ${rate}) is outside the safe integer range (§9.6)`);
  }
  return assertInt64(BigInt(rounded), "scaleByRate");
}

/**
 * Total order on milli-CU quantities, for use inside canonical comparators.
 *
 * @param {bigint} a
 * @param {bigint} b
 * @returns {number} −1, 0 or 1
 */
function compare(a, b) {
  assertInt64(a, "compare");
  assertInt64(b, "compare");
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Render milli-CU for a decision record: exact, lossless, and stable across hosts.
 *
 * @param {bigint} milliCU
 * @returns {string}
 */
function format(milliCU) {
  assertInt64(milliCU, "format");
  return `${milliCU.toString()}mCU`;
}

module.exports = {
  MILLI_PER_CU,
  MILLI_PER_CU_BIG,
  INT64_MIN,
  INT64_MAX,
  ROUNDING_MODE,
  assertInt64,
  toMilliCU,
  toCU,
  fromWholeCU,
  add,
  subtract,
  negate,
  sum,
  multiplyByCount,
  scaleByRate,
  compare,
  format,
};

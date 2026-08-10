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
 *
 * ── The supported input representation, and why the scaling is not a multiply ──
 * The conversion boundary accepts a JavaScript `number`. Every such value is a
 * float64, and the values that actually reach it are of two kinds:
 *
 *   - **decimal quantities** — exchange rates and cost figures, which §1.3 requires
 *     to be "traceable to an accounting figure", and which are written and reviewed
 *     as decimals (`0.0035` CU·Wh⁻¹, a `-32.7615` CU credit); and
 *   - **float estimates** produced by continuous arithmetic upstream, which §9.6
 *     requirement 1 names explicitly.
 *
 * A float64 cannot hold most decimal fractions exactly, so `cu * 1000` is not the
 * mathematical product: `-32.7615 * 1000` evaluates to `-32761.499999999996`, which
 * sits *below* the half boundary the decimal quantity lands exactly on. Scaling by
 * multiplication and then comparing against `0.5` therefore rounds a measurable
 * fraction of exact half-boundary quantities **toward** zero — the opposite of the
 * stated mode — and no epsilon fixes that without breaking a neighbouring case.
 *
 * The scaling is therefore performed **exactly, in base ten, with no float
 * arithmetic at all.** `Number.prototype.toString` is specified by ECMA-262 to
 * produce the shortest decimal that round-trips to the same float64 — a total,
 * host-independent, deterministic function of the input. That decimal is parsed
 * into an exact `(digits, exponent)` pair, the exponent is shifted by three (the
 * milli- prefix is a *decimal* prefix), and the half-boundary test is the exact
 * integer comparison `2·remainder ≥ denominator`. Every intermediate is a `BigInt`,
 * so the mode holds for the whole supported domain rather than almost all of it.
 *
 * Two consequences worth stating, because they are behaviour and not detail:
 *
 *   - **Determinism is strengthened, not traded away.** The conversion has no
 *     float intermediate left to vary, and `toString` is exactly specified, so two
 *     conforming hosts agree by construction rather than by observation.
 *   - **The representable range widens to the one §9.6 actually states.** The
 *     previous implementation refused any result outside the float64 *safe integer*
 *     range, because past that point the float intermediate could not represent the
 *     result exactly. There is no float intermediate now, so the only bound left is
 *     `int64` itself, enforced — as everywhere else in this module — by
 *     `assertInt64`. Overflow remains an error and never a wrap.
 */

/** @structural the milli- prefix: 1 CU is 1 000 milli-CU by definition of the unit */
const MILLI_PER_CU = 1000;

/** @structural the milli- prefix, as the BigInt the arithmetic uses */
const MILLI_PER_CU_BIG = 1000n;

/** @structural base ten: the radix a decimal literal and the milli- prefix are both written in */
const DECIMAL_RADIX = 10;

/** @structural base ten, as the BigInt the exact scaling uses */
const DECIMAL_RADIX_BIG = 10n;

/** @structural 10³ — the milli- prefix expressed as a shift of the decimal exponent */
const MILLI_DECIMAL_EXPONENT = 3;

/** @structural the numerator of ½, for the exact half-boundary test `2·remainder ≥ denominator` */
const HALF_NUMERATOR_BIG = 2n;

const DECIMAL_EXPONENT_SEPARATOR = /[eE]/;

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
 * Decompose a finite `number` into the exact decimal triple
 * `(negative, digits, exponent)` such that the value is
 * `(negative ? −1 : 1) × digits × 10^exponent`, with no float arithmetic.
 *
 * The decimal read is `String(value)`, which ECMA-262 specifies as the shortest
 * decimal that round-trips to the same float64. It is a total function with one
 * answer per input on every conforming host, which is what makes the conversion
 * above it replayable.
 *
 * @param {number} value finite
 * @returns {{ negative: boolean, digits: bigint, exponent: number }}
 */
function decimalParts(value) {
  let text = String(value);
  let negative = false;
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1);
  }

  let exponent = 0;
  const exponentAt = text.search(DECIMAL_EXPONENT_SEPARATOR);
  if (exponentAt >= 0) {
    exponent = Number.parseInt(text.slice(exponentAt + 1), DECIMAL_RADIX);
    text = text.slice(0, exponentAt);
  }

  const pointAt = text.indexOf(".");
  if (pointAt >= 0) {
    exponent -= text.length - pointAt - 1;
    text = text.slice(0, pointAt) + text.slice(pointAt + 1);
  }

  return { negative, digits: BigInt(text), exponent };
}

/**
 * The module's **single rounding site**: scale a finite `number` by `10^shift` and
 * round the result to a `BigInt` under `ROUND_HALF_AWAY_FROM_ZERO`, exactly.
 *
 * Both conversions in this module funnel through here, so the answer to "which
 * rounding did this use?" is one function rather than one function per call site.
 *
 * @param {number} value finite
 * @param {number} shift decimal exponent shift applied before rounding
 * @returns {bigint}
 */
function roundScaledHalfAwayFromZero(value, shift) {
  const { negative, digits, exponent } = decimalParts(value);
  const shifted = exponent + shift;

  let magnitude;
  if (shifted >= 0) {
    // The scaled value is already a whole number: there is nothing to round.
    magnitude = digits * DECIMAL_RADIX_BIG ** BigInt(shifted);
  } else {
    const denominator = DECIMAL_RADIX_BIG ** BigInt(-shifted);
    const quotient = digits / denominator;
    const remainder = digits % denominator;
    // Round half away from zero on the magnitude, by exact integer comparison.
    // Deciding on the magnitude — with the sign reattached afterwards, never
    // participating — is what makes the mode symmetric under negation by
    // construction rather than by coincidence.
    magnitude = HALF_NUMERATOR_BIG * remainder >= denominator ? quotient + 1n : quotient;
  }

  return negative ? -magnitude : magnitude;
}

/**
 * Convert a CU quantity into int64 milli-CU under the single specified rounding
 * mode, exactly.
 *
 * The conversion is the whole engine's one float→integer boundary, so it is the one
 * place where "which rounding did this use?" is answered. See the module header for
 * why the scaling is a decimal exponent shift rather than a multiplication by 1000.
 *
 * @param {number} cu cost in CU
 * @returns {bigint} milli-CU
 * @throws {TypeError} on a non-finite input — a cost that is NaN or infinite is a
 *   modelling error, and rounding it would hide that
 * @throws {RangeError} on a quantity whose milli-CU value is outside int64
 */
function toMilliCU(cu) {
  if (typeof cu !== "number" || !Number.isFinite(cu)) {
    throw new TypeError(
      `toMilliCU received ${JSON.stringify(cu)}; a cost must be a finite number of CU (§1.3, §9.6)`,
    );
  }
  return assertInt64(roundScaledHalfAwayFromZero(cu, MILLI_DECIMAL_EXPONENT), "toMilliCU");
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
 * accumulating through a chain of float operations, and it happens through the same
 * single rounding site `toMilliCU` uses — so the module has one rounding mode in
 * implementation as well as in name.
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
  if (!Number.isFinite(product)) {
    throw new RangeError(`scaleByRate(${milliCU}, ${rate}) overflows the float64 product (§9.6)`);
  }
  return assertInt64(roundScaledHalfAwayFromZero(product, 0), "scaleByRate");
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

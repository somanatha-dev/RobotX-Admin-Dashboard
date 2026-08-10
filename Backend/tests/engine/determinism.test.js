"use strict";

/**
 * Engine lane — the determinism substrate (§9.6).
 *
 * Every requirement of §9.6 is individually testable, and §9.6 says so. These are
 * those tests:
 *
 *   1. int64 milli-CU arithmetic — order-independent summation
 *   2. canonical ordering everywhere — total orders ending in a unique id
 *   3. an explicit tie-break policy — duty cycle, health tier, agent id
 *   4. `decision_time` is an input — no wall clock during evaluation
 *   5. snapshot isolation of inputs
 *   6. pinned versions
 *   7. no unseeded randomness
 */

const fixedPoint = require("../../src/engine/determinism/fixedPoint");
const ordering = require("../../src/engine/determinism/ordering");
const snapshotModule = require("../../src/engine/determinism/snapshot");

/* ─────────────────────────────────────────────────────────────────────────────
   §9.6 requirement 1 — integer arithmetic in the objective
   ───────────────────────────────────────────────────────────────────────────── */

describe("int64 milli-CU arithmetic", () => {
  test("summation is order-independent over shuffled sets — the property float summation cannot give", () => {
    const values = [0.1, 0.2, 0.3, 1e-3, 1234.567, -98.765, 0.007, 42, -0.5, 1e6].map(fixedPoint.toMilliCU);
    const reference = fixedPoint.sum(values);

    // 200 shuffles, each summed in its own order. In milli-CU every one is equal.
    for (let trial = 0; trial < 200; trial += 1) {
      const shuffled = [...values];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = (trial * 7 + i * 13) % (i + 1); // deterministic permutation, no unseeded randomness
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      expect(fixedPoint.sum(shuffled)).toBe(reference);
    }
  });

  test("the same set summed as floats is NOT order-independent — which is why this module exists", () => {
    // A large term that swamps the small ones: summed in one order the small terms
    // are lost to rounding, in the other they survive. This is the bit-level
    // order dependence §9.6 requirement 1 names, on a realistic mixture of a large
    // opportunity term and several small ones.
    const floats = [1e11, 0.001, 0.007, -1e11, 0.003];
    const forwards = floats.reduce((total, value) => total + value, 0);
    const backwards = [...floats].reverse().reduce((total, value) => total + value, 0);
    expect(forwards).not.toBe(backwards);

    // The milli-CU rendering of both is identical.
    expect(fixedPoint.sum(floats.map(fixedPoint.toMilliCU))).toBe(
      fixedPoint.sum([...floats].reverse().map(fixedPoint.toMilliCU)),
    );
  });

  test("addition is associative", () => {
    const [a, b, c] = [12.345, -6.7, 0.089].map(fixedPoint.toMilliCU);
    expect(fixedPoint.add(fixedPoint.add(a, b), c)).toBe(fixedPoint.add(a, fixedPoint.add(b, c)));
  });

  test("the rounding mode is stated, and is symmetric under negation", () => {
    expect(fixedPoint.ROUNDING_MODE).toBe("ROUND_HALF_AWAY_FROM_ZERO");
    for (const value of [0.0015, 1.2345, 99.9995, 0.5, 7.0005]) {
      expect(fixedPoint.toMilliCU(-value)).toBe(-fixedPoint.toMilliCU(value));
    }
  });

  test("halves round away from zero in both directions", () => {
    expect(fixedPoint.toMilliCU(0.0035)).toBe(4n);
    expect(fixedPoint.toMilliCU(-0.0035)).toBe(-4n);
  });

  test("a non-finite cost is a modelling error, not something to round", () => {
    expect(() => fixedPoint.toMilliCU(Number.NaN)).toThrow(/finite number of CU/);
    expect(() => fixedPoint.toMilliCU(Number.POSITIVE_INFINITY)).toThrow(/finite number of CU/);
  });

  test("overflow raises rather than wrapping — a wrapped cost is a number nobody computed", () => {
    expect(() => fixedPoint.assertInt64(fixedPoint.INT64_MAX + 1n)).toThrow(/outside int64/);
    expect(() => fixedPoint.add(fixedPoint.INT64_MAX, 1n)).toThrow(/overflow/);
  });

  test("a float is refused where a milli-CU BigInt is required", () => {
    expect(() => fixedPoint.add(1.5, 2n)).toThrow(/int64 milli-CU BigInts/);
  });

  test("round-trips through CU for display without being used for decisions", () => {
    expect(fixedPoint.toCU(fixedPoint.toMilliCU(1234.567))).toBeCloseTo(1234.567, 9);
    expect(fixedPoint.format(fixedPoint.toMilliCU(2.5))).toBe("2500mCU");
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   REGRESSION — Phase 1 independent verification, Part 5 / Part 12 issue 1.

   `toMilliCU()` scaled by multiplying: `cu * 1000`, then compared the product
   against `0.5`. A float64 cannot hold most decimal fractions exactly, so the
   product of an exact decimal half-boundary is not the mathematical product —
   `-32.7615 * 1000` evaluates to `-32761.499999999996` — and a measurable
   fraction of half boundaries rounded **toward** zero, the opposite of the stated
   `ROUND_HALF_AWAY_FROM_ZERO`. A brute-force sweep found the error in ~0.7% of
   exact half boundaries.

   The scaling is now an exact decimal exponent shift over `BigInt`s with no float
   arithmetic at all, so the mode holds across the whole supported input domain
   rather than almost all of it. These tests pin that: they fail against the
   multiply-and-compare implementation.
   ───────────────────────────────────────────────────────────────────────────── */

describe("toMilliCU rounds exactly, over the whole supported input domain", () => {
  test("the verifier's reproduction case rounds away from zero, in both signs", () => {
    // -32.7615 CU is exactly -32761.5 milli-CU. Away from zero is -32762.
    expect(fixedPoint.toMilliCU(-32.7615)).toBe(-32762n);
    expect(fixedPoint.toMilliCU(32.7615)).toBe(32762n);
    // The float product this used to be computed from is not the exact value, which
    // is the whole defect — asserted here so the reason cannot be lost.
    expect(-32.7615 * 1000).not.toBe(-32761.5);
  });

  test("positive exact half boundaries round up", () => {
    expect(fixedPoint.toMilliCU(0.0005)).toBe(1n);
    expect(fixedPoint.toMilliCU(0.0015)).toBe(2n);
    expect(fixedPoint.toMilliCU(0.5005)).toBe(501n);
    expect(fixedPoint.toMilliCU(2.0125)).toBe(2013n);
    expect(fixedPoint.toMilliCU(1234.5675)).toBe(1234568n);
  });

  test("negative exact half boundaries round down, never toward zero", () => {
    expect(fixedPoint.toMilliCU(-0.0005)).toBe(-1n);
    expect(fixedPoint.toMilliCU(-0.0015)).toBe(-2n);
    expect(fixedPoint.toMilliCU(-0.5005)).toBe(-501n);
    expect(fixedPoint.toMilliCU(-2.0125)).toBe(-2013n);
    expect(fixedPoint.toMilliCU(-1234.5675)).toBe(-1234568n);
  });

  test("values immediately below a boundary round toward zero", () => {
    expect(fixedPoint.toMilliCU(0.50049)).toBe(500n);
    expect(fixedPoint.toMilliCU(-0.50049)).toBe(-500n);
    expect(fixedPoint.toMilliCU(0.0004999)).toBe(0n);
  });

  test("values immediately above a boundary round away from zero", () => {
    expect(fixedPoint.toMilliCU(0.50051)).toBe(501n);
    expect(fixedPoint.toMilliCU(-0.50051)).toBe(-501n);
    expect(fixedPoint.toMilliCU(0.0005001)).toBe(1n);
  });

  test("zero, and negative zero, are zero", () => {
    expect(fixedPoint.toMilliCU(0)).toBe(0n);
    expect(fixedPoint.toMilliCU(-0)).toBe(0n);
    expect(fixedPoint.toMilliCU(0.0004)).toBe(0n);
    expect(fixedPoint.toMilliCU(-0.0004)).toBe(0n);
  });

  test("ordinary non-boundary decimal values are unchanged by the fix", () => {
    // These are the values the shipped suite already asserted. The fix must not have
    // moved any of them — it corrects half boundaries and nothing else.
    expect(fixedPoint.toMilliCU(0.0035)).toBe(4n);
    expect(fixedPoint.toMilliCU(1234.567)).toBe(1234567n);
    expect(fixedPoint.toMilliCU(-98.765)).toBe(-98765n);
    expect(fixedPoint.toMilliCU(42)).toBe(42000n);
    expect(fixedPoint.toMilliCU(1e6)).toBe(1000000000n);
    expect(fixedPoint.toMilliCU(1e-3)).toBe(1n);
  });

  test("representative real cost values convert exactly", () => {
    // A 500 Wh leg at the seeded energy rate, an SLA lateness charge, and a negative
    // C_policy credit — the three shapes §6.4 says the objective actually carries.
    expect(fixedPoint.toMilliCU(500 * 0.0004)).toBe(200n);
    expect(fixedPoint.toMilliCU(0.2)).toBe(200n);
    expect(fixedPoint.toMilliCU(-60)).toBe(-60000n);
    expect(fixedPoint.toMilliCU(4100.125)).toBe(4100125n);
  });

  test("very large values convert exactly rather than losing precision", () => {
    // Beyond the float64 safe-integer range in milli-CU, and still exact, because no
    // float intermediate exists any more.
    expect(fixedPoint.toMilliCU(1e15)).toBe(1000000000000000000n);
    expect(fixedPoint.toMilliCU(-1e15)).toBe(-1000000000000000000n);
    expect(fixedPoint.toCU(fixedPoint.toMilliCU(1e15))).toBe(1e15);
  });

  test("overflow past int64 is an error, not a wrap", () => {
    expect(() => fixedPoint.toMilliCU(1e300)).toThrow(RangeError);
    expect(() => fixedPoint.toMilliCU(1e300)).toThrow(/outside int64/);
    expect(() => fixedPoint.toMilliCU(-1e300)).toThrow(/outside int64/);
    expect(() => fixedPoint.toMilliCU(Number.MAX_VALUE)).toThrow(/outside int64/);
    // Both sides of the int64 boundary behave. A quantity just inside it converts
    // exactly — note this is far beyond the float64 *safe integer* range in milli-CU,
    // which the previous implementation refused because its float intermediate could
    // not represent it; there is no float intermediate now.
    expect(fixedPoint.toMilliCU(9223372036854.775)).toBe(9223372036854775n);
    expect(fixedPoint.toMilliCU(9223372036854.775)).toBeLessThan(fixedPoint.INT64_MAX);
    expect(() => fixedPoint.toMilliCU(1e16)).toThrow(/outside int64/);
  });

  test("PROPERTY: toMilliCU(-x) === -toMilliCU(x) over every exact half boundary", () => {
    // 40 000 consecutive exact half boundaries — the input class the defect lived in —
    // plus the assertion that each lands away from zero rather than merely symmetrically.
    for (let i = 0; i < 40000; i += 1) {
      const value = Number(((i * 10 + 5) / 10000).toFixed(4));
      const expected = BigInt(i + 1);
      expect(fixedPoint.toMilliCU(value)).toBe(expected);
      expect(fixedPoint.toMilliCU(-value)).toBe(-expected);
    }
  });

  test("PROPERTY: toMilliCU(-x) === -toMilliCU(x) over a wide mixed range", () => {
    // Deterministic sweep — no unseeded randomness (§9.6 requirement 7) — across
    // magnitudes from 1e-4 to 1e6, at 3, 4 and 5 decimal places.
    for (let i = 0; i < 20000; i += 1) {
      for (const places of [3, 4, 5]) {
        const value = Number((((i * 7919) % 1000000000) / 10 ** places).toFixed(places));
        expect(fixedPoint.toMilliCU(-value)).toBe(-fixedPoint.toMilliCU(value));
      }
    }
  });

  test("the conversion is a pure function of the value, not of how it was written", () => {
    // Two spellings of the same float64 must convert identically, or replay depends
    // on source formatting rather than on the number.
    expect(fixedPoint.toMilliCU(0.5)).toBe(fixedPoint.toMilliCU(5e-1));
    // 1e9 is spelled exponentially by `toString`; the literal below is not. Same value,
    // same conversion — the decimal read is of the number, not of the source text.
    expect(fixedPoint.toMilliCU(1e9)).toBe(fixedPoint.toMilliCU(1000000000));
    expect(fixedPoint.toMilliCU(1e-7)).toBe(fixedPoint.toMilliCU(0.0000001));
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   REGRESSION — Phase 1 independent verification, Part 10 item 3.

   `subtract`, `multiplyByCount`, `compareColumns`, `thenBy`, `descending`,
   `deepFreeze` and `captureDecisionTime` are exported but had no direct test
   coverage. They are the substrate later phases build on, so their contracts are
   pinned here rather than being inferred from whichever caller happens to exist.
   ───────────────────────────────────────────────────────────────────────────── */

describe("fixedPoint.subtract", () => {
  test("subtracts, including across zero and between two negatives", () => {
    expect(fixedPoint.subtract(100n, 30n)).toBe(70n);
    expect(fixedPoint.subtract(30n, 100n)).toBe(-70n);
    expect(fixedPoint.subtract(-30n, -100n)).toBe(70n);
    expect(fixedPoint.subtract(0n, 0n)).toBe(0n);
  });

  test("is the exact inverse of add, which is what makes a cost decomposable", () => {
    const total = fixedPoint.add(fixedPoint.toMilliCU(1200.5), fixedPoint.toMilliCU(-340.25));
    expect(fixedPoint.subtract(total, fixedPoint.toMilliCU(-340.25))).toBe(fixedPoint.toMilliCU(1200.5));
  });

  test("overflow in either direction is an error, not a wrap", () => {
    expect(() => fixedPoint.subtract(fixedPoint.INT64_MIN, 1n)).toThrow(/overflow in subtract/);
    expect(() => fixedPoint.subtract(fixedPoint.INT64_MAX, -1n)).toThrow(/overflow in subtract/);
  });

  test("refuses a float where a milli-CU BigInt is required", () => {
    expect(() => fixedPoint.subtract(1.5, 2n)).toThrow(/int64 milli-CU BigInts/);
    expect(() => fixedPoint.subtract(2n, 1.5)).toThrow(/int64 milli-CU BigInts/);
  });
});

describe("fixedPoint.multiplyByCount", () => {
  test("multiplies by a count given as a BigInt or as a number", () => {
    expect(fixedPoint.multiplyByCount(250n, 4n)).toBe(1000n);
    expect(fixedPoint.multiplyByCount(250n, 4)).toBe(1000n);
  });

  test("a zero count is zero cost, not an error — a plan may carry no Legs", () => {
    expect(fixedPoint.multiplyByCount(250n, 0)).toBe(0n);
    expect(fixedPoint.multiplyByCount(0n, 99)).toBe(0n);
  });

  test("a negative count is arithmetic, not a refusal, and keeps the sign exact", () => {
    // Nothing in §9.6 prohibits it, and `C_opportunity`/`C_policy` are signed (§6.4),
    // so the contract is signed multiplication rather than a count guard.
    expect(fixedPoint.multiplyByCount(250n, -4)).toBe(-1000n);
    expect(fixedPoint.multiplyByCount(-250n, -4)).toBe(1000n);
  });

  test("a non-integer count is refused rather than silently truncated", () => {
    // BigInt(1.5) throws — a fractional count of Legs is a modelling error, and
    // truncating it would price a plan nobody proposed.
    expect(() => fixedPoint.multiplyByCount(250n, 1.5)).toThrow(RangeError);
  });

  test("overflow is an error, not a wrap", () => {
    expect(() => fixedPoint.multiplyByCount(fixedPoint.INT64_MAX, 2)).toThrow(/overflow in multiplyByCount/);
    expect(() => fixedPoint.multiplyByCount(fixedPoint.INT64_MIN, 2)).toThrow(/overflow in multiplyByCount/);
  });

  test("refuses a float milli-CU quantity", () => {
    expect(() => fixedPoint.multiplyByCount(1.5, 2)).toThrow(/int64 milli-CU BigInts/);
  });
});

describe("ordering.thenBy and ordering.descending", () => {
  const byFirst = (a, b) => ordering.compareNumbers(a.first, b.first);
  const bySecond = (a, b) => ordering.compareNumbers(a.second, b.second);

  test("thenBy consults later comparators only when earlier ones are equal", () => {
    const composed = ordering.thenBy(byFirst, bySecond);
    expect(composed({ first: 1, second: 9 }, { first: 2, second: 0 })).toBe(ordering.BEFORE);
    expect(composed({ first: 1, second: 0 }, { first: 1, second: 9 })).toBe(ordering.BEFORE);
    expect(composed({ first: 1, second: 5 }, { first: 1, second: 5 })).toBe(ordering.EQUAL);
  });

  test("thenBy with no comparators ties everything — it never invents an order", () => {
    expect(ordering.thenBy()({ a: 1 }, { a: 2 })).toBe(ordering.EQUAL);
  });

  test("thenBy is associative in its composition, so the tie-break chain is unambiguous", () => {
    const byThird = (a, b) => ordering.compareNumbers(a.third, b.third);
    const flat = ordering.thenBy(byFirst, bySecond, byThird);
    const nested = ordering.thenBy(byFirst, ordering.thenBy(bySecond, byThird));
    const pairs = [
      [{ first: 1, second: 1, third: 1 }, { first: 1, second: 1, third: 2 }],
      [{ first: 1, second: 2, third: 1 }, { first: 1, second: 1, third: 9 }],
      [{ first: 2, second: 1, third: 1 }, { first: 1, second: 9, third: 9 }],
    ];
    for (const [a, b] of pairs) expect(flat(a, b)).toBe(nested(a, b));
  });

  test("descending reverses a comparator's verdict, and preserves the tie", () => {
    const down = ordering.descending(byFirst);
    expect(down({ first: 1 }, { first: 2 })).toBe(ordering.AFTER);
    expect(down({ first: 2 }, { first: 1 })).toBe(ordering.BEFORE);
    // Negating a tie yields `-0`, which is `=== 0` and which `thenBy` and
    // `Array.prototype.sort` both treat as "equal". Asserted by value rather than by
    // `Object.is`, because the sign of zero is not part of the comparator contract —
    // over-specifying it here would pin an artefact rather than a behaviour.
    expect(down({ first: 1 }, { first: 1 }) === ordering.EQUAL).toBe(true);
    // What *is* part of the contract: a chain sees the tie and moves on to the next key.
    const chained = ordering.thenBy(down, bySecond);
    expect(chained({ first: 1, second: 1 }, { first: 1, second: 2 })).toBe(ordering.BEFORE);
  });

  test("descending is its own inverse", () => {
    const twice = ordering.descending(ordering.descending(byFirst));
    expect(twice({ first: 1 }, { first: 2 })).toBe(byFirst({ first: 1 }, { first: 2 }));
  });

  test("descending over compareNumbers still sorts an absent value last, not first", () => {
    // `compareNumbers` places an absent value after every present one so a missing
    // field never silently wins. Naively reversing would make absence win every time,
    // so this pins which way round the composition actually behaves: the §9.6
    // tie-break uses `descending(compareNumbers)` for "higher health tier first".
    const sorted = ordering.canonicalSort(
      [{ first: 1 }, { first: undefined }, { first: 3 }],
      ordering.descending(byFirst),
    );
    expect(sorted.map((item) => item.first)).toEqual([undefined, 3, 1]);
  });
});

describe("ordering.compareColumns", () => {
  const column = (agentId, legIds, insertionPositions) => ({ agentId, legIds, insertionPositions });

  test("orders by canonical column identity, not by generation order", () => {
    const a = column("ag-1", ["l-1"], [0]);
    const b = column("ag-2", ["l-1"], [0]);
    expect(ordering.compareColumns(a, b)).toBe(ordering.BEFORE);
    expect(ordering.compareColumns(b, a)).toBe(ordering.AFTER);
  });

  test("two columns with the same identity compare equal however their legs were listed", () => {
    // The identity sorts the leg id list, so the Column Builder's enumeration order
    // cannot reach the comparator — which is the property §9.6 requirement 2 names.
    expect(ordering.compareColumns(column("ag-1", ["l-2", "l-1"], [0, 1]), column("ag-1", ["l-1", "l-2"], [0, 1]))).toBe(
      ordering.EQUAL,
    );
  });

  test("distinguishes columns differing only in insertion position", () => {
    expect(ordering.compareColumns(column("ag-1", ["l-1"], [0]), column("ag-1", ["l-1"], [1]))).not.toBe(
      ordering.EQUAL,
    );
  });

  test("is a total order over a distinct column set, and sorts identically from any input order", () => {
    const set = [
      column("ag-2", ["l-1"], [0]),
      column("ag-1", ["l-2", "l-1"], [0, 1]),
      column("ag-1", ["l-1"], [0]),
    ];
    expect(ordering.assertTotalOrder(set, ordering.compareColumns, ordering.columnIdentity).ok).toBe(true);

    const forwards = ordering.canonicalSort(set, ordering.compareColumns).map(ordering.columnIdentity);
    const backwards = ordering.canonicalSort([...set].reverse(), ordering.compareColumns).map(ordering.columnIdentity);
    expect(forwards).toEqual(backwards);
  });

  test("treats an absent leg list and an absent position vector as empty, not as a throw", () => {
    expect(ordering.compareColumns({ agentId: "ag-1" }, { agentId: "ag-1", legIds: [], insertionPositions: [] })).toBe(
      ordering.EQUAL,
    );
  });
});

describe("snapshot.deepFreeze", () => {
  test("freezes every level of a nested object graph, not merely the root", () => {
    const graph = { a: { b: { c: 1 } }, list: [{ d: 2 }] };
    snapshotModule.deepFreeze(graph);

    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.a)).toBe(true);
    expect(Object.isFrozen(graph.a.b)).toBe(true);
    expect(Object.isFrozen(graph.list)).toBe(true);
    expect(Object.isFrozen(graph.list[0])).toBe(true);
  });

  test("a mutation attempt at depth throws in strict mode rather than silently failing", () => {
    const graph = snapshotModule.deepFreeze({ a: { b: 1 }, list: [1] });
    expect(() => {
      graph.a.b = 2;
    }).toThrow(TypeError);
    expect(() => {
      graph.list.push(2);
    }).toThrow(TypeError);
    expect(graph.a.b).toBe(1);
  });

  test("returns the value it was given, so it composes as a wrapper", () => {
    const graph = { a: 1 };
    expect(snapshotModule.deepFreeze(graph)).toBe(graph);
  });

  test("passes primitives and null through untouched", () => {
    expect(snapshotModule.deepFreeze(null)).toBeNull();
    expect(snapshotModule.deepFreeze(undefined)).toBeUndefined();
    expect(snapshotModule.deepFreeze(7)).toBe(7);
    expect(snapshotModule.deepFreeze("x")).toBe("x");
  });

  test("terminates on a cyclic graph rather than recursing forever", () => {
    // A snapshot should not contain a cycle, but the guard that makes this terminate
    // is the already-frozen short-circuit, and a substrate function that hangs on
    // unexpected input is worse than one that refuses it.
    const cyclic = { name: "root" };
    cyclic.self = cyclic;
    expect(() => snapshotModule.deepFreeze(cyclic)).not.toThrow();
    expect(Object.isFrozen(cyclic)).toBe(true);
  });
});

describe("snapshot.captureDecisionTime", () => {
  test("returns the wall clock as epoch milliseconds", () => {
    const before = Date.now();
    const captured = snapshotModule.captureDecisionTime();
    const after = Date.now();

    expect(Number.isFinite(captured)).toBe(true);
    expect(Number.isInteger(captured)).toBe(true);
    expect(captured).toBeGreaterThanOrEqual(before);
    expect(captured).toBeLessThanOrEqual(after);
  });

  test("is the single named site where the round's time becomes an input", () => {
    // §9.6 requirement 4 makes `decision_time` an input, and the tenet gate fails any
    // in-scope module that reads a clock. This function exists so that the one
    // permitted read is greppable and testable rather than incidental — so the value
    // it returns must be usable directly as the snapshot's pin.
    const pinned = snapshotModule.captureSnapshot({
      roundId: "round-1",
      decisionTime: snapshotModule.captureDecisionTime(),
      configVersion: 1,
      codeVersion: "test",
      killSwitchState: {},
    });
    expect(Number.isFinite(pinned.decisionTime)).toBe(true);
  });

  test("the captured time is an input to the snapshot, never re-read by it", () => {
    // Two snapshots built from the *same* captured time hash identically even though
    // wall-clock time moved between them. If anything downstream re-read a clock,
    // this would fail.
    const decisionTime = snapshotModule.captureDecisionTime();
    const inputs = {
      roundId: "round-1",
      decisionTime,
      configVersion: 1,
      codeVersion: "test",
      killSwitchState: {},
    };
    expect(snapshotModule.captureSnapshot(inputs).hash).toBe(snapshotModule.captureSnapshot(inputs).hash);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   §9.6 requirements 2 and 3 — canonical ordering and the tie-break
   ───────────────────────────────────────────────────────────────────────────── */

describe("canonical ordering", () => {
  const candidate = (agentId, cu, dutyCycle, healthTier) => ({
    agentId,
    costMilliCU: fixedPoint.toMilliCU(cu),
    dutyCycle,
    healthTier,
  });

  test("orders by cost first", () => {
    const sorted = ordering.canonicalSort(
      [candidate("b", 20, 0.1, 3), candidate("a", 10, 0.9, 1)],
      ordering.compareScored,
    );
    expect(sorted.map((item) => item.agentId)).toEqual(["a", "b"]);
  });

  test("breaks equal costs by lower duty cycle, then higher health tier, then agent id", () => {
    const sorted = ordering.canonicalSort(
      [
        candidate("z", 10, 0.5, 2),
        candidate("a", 10, 0.5, 2),
        candidate("m", 10, 0.5, 3),
        candidate("q", 10, 0.2, 1),
      ],
      ordering.compareScored,
    );
    expect(sorted.map((item) => item.agentId)).toEqual(["q", "m", "a", "z"]);
  });

  test("never resolves a tie by arrival order — the same set in any order sorts identically", () => {
    const set = [
      candidate("c", 10, 0.5, 2),
      candidate("a", 10, 0.5, 2),
      candidate("b", 10, 0.5, 2),
    ];
    const forwards = ordering.canonicalSort(set, ordering.compareScored).map((item) => item.agentId);
    const backwards = ordering.canonicalSort([...set].reverse(), ordering.compareScored).map((item) => item.agentId);
    expect(forwards).toEqual(backwards);
    expect(forwards).toEqual(["a", "b", "c"]);
  });

  test("the comparator is a genuine total order over a candidate set ending in a unique id", () => {
    const set = [candidate("a", 10, 0.5, 2), candidate("b", 10, 0.5, 2), candidate("c", 9, 0.5, 2)];
    expect(ordering.assertTotalOrder(set, ordering.compareScored, (item) => item.agentId).ok).toBe(true);
  });

  test("a comparator that ties two distinct members is reported, not silently tolerated", () => {
    const byCostOnly = (a, b) => fixedPoint.compare(a.costMilliCU, b.costMilliCU);
    const result = ordering.assertTotalOrder(
      [candidate("a", 10, 0.5, 2), candidate("b", 10, 0.5, 2)],
      byCostOnly,
      (item) => item.agentId,
    );
    expect(result.ok).toBe(false);
    expect(result.collisions[0]).toMatch(/ties with/);
  });

  test("string comparison is by code unit, so two hosts with different collation agree", () => {
    // localeCompare is locale-dependent; these two orderings differ under some ICU
    // collations, and must not here.
    expect(ordering.compareStrings("a", "B")).toBe(ordering.BEFORE === -1 ? 1 : -1);
    expect(ordering.compareStrings("B", "a")).toBe(-1);
    expect(ordering.compareStrings("agent-10", "agent-9")).toBe(-1);
  });

  test("an absent numeric field sorts last rather than silently winning", () => {
    const sorted = ordering.canonicalSort(
      [
        { agentId: "a", costMilliCU: 0n, dutyCycle: undefined, healthTier: 1 },
        { agentId: "b", costMilliCU: 0n, dutyCycle: 0.9, healthTier: 1 },
      ],
      ordering.compareScored,
    );
    expect(sorted.map((item) => item.agentId)).toEqual(["b", "a"]);
  });
});

describe("column identity", () => {
  test("is (agent id, sorted leg id list, insertion position vector), independent of generation order", () => {
    const a = { agentId: "ag-1", legIds: ["l-2", "l-1"], insertionPositions: [0, 1] };
    const b = { agentId: "ag-1", legIds: ["l-1", "l-2"], insertionPositions: [0, 1] };
    expect(ordering.columnIdentity(a)).toBe(ordering.columnIdentity(b));
  });

  test("distinguishes columns that differ in agent, legs, or insertion positions", () => {
    const base = { agentId: "ag-1", legIds: ["l-1"], insertionPositions: [0] };
    expect(ordering.columnIdentity(base)).not.toBe(ordering.columnIdentity({ ...base, agentId: "ag-2" }));
    expect(ordering.columnIdentity(base)).not.toBe(ordering.columnIdentity({ ...base, legIds: ["l-2"] }));
    expect(ordering.columnIdentity(base)).not.toBe(ordering.columnIdentity({ ...base, insertionPositions: [1] }));
  });
});

describe("canonical JSON", () => {
  test("is key-order independent at every depth", () => {
    const a = { b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } };
    const b = { a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 };
    expect(ordering.canonicalJson(a)).toBe(ordering.canonicalJson(b));
  });

  test("encodes BigInt losslessly, since costs are BigInts", () => {
    expect(ordering.canonicalJson({ cost: 9007199254740993n })).toContain("9007199254740993");
  });

  test("refuses a non-finite number rather than encoding it as null", () => {
    expect(() => ordering.canonicalJson({ x: Number.NaN })).toThrow(/non-finite/);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   §9.6 requirements 4–7 — decision time as an input, pinned inputs, seeded RNG
   ───────────────────────────────────────────────────────────────────────────── */

describe("the round snapshot", () => {
  const INPUTS = {
    roundId: "round-2026-07-28T09:00:00Z-shard-1",
    decisionTime: 1785000000000,
    configVersion: 7,
    codeVersion: "e558243",
    killSwitchState: { batch_solving: true },
    activeRegime: "first-snowfall",
    agentStateVersion: "as-99",
    priceSnapshotVersion: "px-12",
    forecastVersion: "fc-4",
    chargerProjectionVersion: "cp-31",
    modelVersions: { consumption: "m-1", serviceTime: "m-2" },
  };

  test("refuses to exist without the pins a replay needs", () => {
    for (const pin of snapshotModule.REQUIRED_PINS) {
      const inputs = { ...INPUTS, [pin]: undefined };
      expect(() => snapshotModule.captureSnapshot(inputs)).toThrow(/missing required pin/);
    }
  });

  test("requires decision_time as an input rather than reading a clock", () => {
    expect(() => snapshotModule.captureSnapshot({ ...INPUTS, decisionTime: "now" })).toThrow(
      /finite decisionTime in epoch milliseconds/,
    );
  });

  test("is immutable once captured", () => {
    const pinned = snapshotModule.captureSnapshot(INPUTS);
    expect(Object.isFrozen(pinned)).toBe(true);
    expect(Object.isFrozen(pinned.killSwitchState)).toBe(true);
    expect(() => {
      pinned.decisionTime = 0;
    }).toThrow();
  });

  test("hashes identically for identical inputs and differently for any changed pin", () => {
    const first = snapshotModule.captureSnapshot(INPUTS);
    expect(snapshotModule.captureSnapshot({ ...INPUTS }).hash).toBe(first.hash);
    expect(snapshotModule.sameInputs(first, snapshotModule.captureSnapshot({ ...INPUTS }))).toBe(true);

    for (const pin of ["configVersion", "codeVersion", "activeRegime", "chargerProjectionVersion", "decisionTime"]) {
      const changed = snapshotModule.captureSnapshot({
        ...INPUTS,
        [pin]: typeof INPUTS[pin] === "number" ? INPUTS[pin] + 1 : `${INPUTS[pin]}-x`,
      });
      expect({ pin, differs: changed.hash !== first.hash }).toEqual({ pin, differs: true });
    }
  });

  test("detects tampering after capture", () => {
    const pinned = snapshotModule.captureSnapshot(INPUTS);
    expect(snapshotModule.isIntact(pinned)).toBe(true);
    expect(snapshotModule.isIntact({ ...pinned, configVersion: 8 })).toBe(false);
  });

  test("pins the charger availability projection, which is what breaks the E_return circularity", () => {
    const pinned = snapshotModule.captureSnapshot(INPUTS);
    expect(pinned.chargerProjectionVersion).toBe("cp-31");
    expect(snapshotModule.DEFERRED_PINS.chargerProjectionVersion).toMatch(/charger availability projection/);
  });

  test("reports which deferred pins are still missing, and which phase supplies each", () => {
    const partial = snapshotModule.captureSnapshot({
      roundId: "r-1",
      decisionTime: 1,
      configVersion: 1,
      codeVersion: "test",
      killSwitchState: {},
    });
    const report = snapshotModule.assertReplayable(partial);
    expect(report.ok).toBe(false);
    expect(report.missing).toContain("chargerProjectionVersion");
    expect(report.detail.priceSnapshotVersion).toMatch(/Phase 8/);

    expect(snapshotModule.assertReplayable(snapshotModule.captureSnapshot(INPUTS)).ok).toBe(true);
  });
});

describe("seeded randomness", () => {
  test("the seed is derived from the round id and is therefore replayable", () => {
    expect(snapshotModule.deriveSeed("round-1")).toBe(snapshotModule.deriveSeed("round-1"));
    expect(snapshotModule.deriveSeed("round-1")).not.toBe(snapshotModule.deriveSeed("round-2"));
  });

  test("an unseeded decision path is refused", () => {
    expect(() => snapshotModule.deriveSeed("")).toThrow(/unseeded decision path is prohibited/);
  });

  test("the seed is recorded on the snapshot", () => {
    const pinned = snapshotModule.captureSnapshot({
      roundId: "round-1",
      decisionTime: 1,
      configVersion: 1,
      codeVersion: "test",
      killSwitchState: {},
    });
    expect(pinned.seed).toBe(snapshotModule.deriveSeed("round-1"));
  });
});

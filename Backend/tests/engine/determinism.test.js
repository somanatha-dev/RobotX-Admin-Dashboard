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

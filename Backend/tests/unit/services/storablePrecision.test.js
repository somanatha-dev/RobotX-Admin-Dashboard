/**
 * P2B-2 — the numbers signed into an OFFER are the numbers the agent receives.
 *
 * The Prisma → PostgreSQL `jsonb` path shortens doubles (measured: `1790219666136.0542` is
 * stored as `1790219666136.054`), and the agent verifies the delivered bytes, so an unquantised
 * payload failed signature verification. The live proof is
 * `tools/verify/p2bOfferSignature.js --live` over a V1 run's Outbox; this pins the rule.
 */

const { STORABLE_SIGNIFICANT_DIGITS, toStorablePrecision } = require("../../../src/services/storablePrecision.service");

const significantDigits = (x) => {
  const [mantissa] = Math.abs(x).toExponential().split("e");
  return mantissa.replace(".", "").replace(/0+$/, "").length;
};

describe("toStorablePrecision", () => {
  test("a 17-significant-digit double is quantised to 15", () => {
    expect(toStorablePrecision(1790219666136.0542)).toBe(1790219666136.05);
    expect(toStorablePrecision(0.1 + 0.2)).toBe(0.3);
  });

  test("integers, including large epoch-ms values, are untouched", () => {
    for (const n of [0, 1, -7, 1790219666136, 2 ** 53 - 1]) expect(toStorablePrecision(n)).toBe(n);
  });

  test("no quantised value has more than 15 significant digits, and quantising again changes nothing", () => {
    for (let i = 0; i < 2000; i += 1) {
      const x = (Math.random() - 0.5) * 10 ** (Math.floor(Math.random() * 16) - 6);
      const q = toStorablePrecision(x);
      expect(significantDigits(q)).toBeLessThanOrEqual(STORABLE_SIGNIFICANT_DIGITS);
      expect(toStorablePrecision(q)).toBe(q);
    }
  });

  test("deep: objects and arrays are copied, strings/booleans/null kept, input not mutated", () => {
    const input = {
      fence: "42",
      stopSequence: [{ projectedArrivalMs: 1790219118850.3333, path: [{ lat: 12.900729, lon: 77.517603 }], siteId: null }],
      energyReserveParams: { returnWh: 134.17957116411243, floorWh: 50 },
      flag: true,
    };
    const out = toStorablePrecision(input);
    expect(out).toEqual({
      fence: "42",
      stopSequence: [{ projectedArrivalMs: 1790219118850.33, path: [{ lat: 12.900729, lon: 77.517603 }], siteId: null }],
      energyReserveParams: { returnWh: 134.179571164112, floorWh: 50 },
      flag: true,
    });
    expect(input.stopSequence[0].projectedArrivalMs).toBe(1790219118850.3333);
  });

  test("non-finite numbers are left for JSON to render as null, exactly as the store does", () => {
    expect(toStorablePrecision(NaN)).toBeNaN();
    expect(toStorablePrecision(Infinity)).toBe(Infinity);
  });
});

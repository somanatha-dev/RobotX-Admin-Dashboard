"use strict";

/**
 * Phase 8 — §8.3's pricing primitives and §20.3 item 2's cell-pair cache.
 *
 * The build gate this file carries: **`V_terminal` has no weighting coefficients**
 * (§8.3.2, §8.10). It is asserted three ways — by signature, by source, and by behaviour —
 * because it is the one property §8.10 singles out as having no register entries at all,
 * and a property with no register entry has nothing else to notice its loss.
 */

const fs = require("fs");
const path = require("path");

const vTerminal = require("../../src/engine/pricing/vTerminal");
const capacityPricing = require("../../src/engine/pricing/capacityPricingClient");
const forecastClient = require("../../src/engine/pricing/forecastClient");
const cellPairCache = require("../../src/engine/routing/cellPairCache");
const costFixture = require("./helpers/costFixture");

const PRICING_DIR = path.resolve(__dirname, "..", "..", "src", "engine", "pricing");
const DECISION_TIME_MS = costFixture.DECISION_TIME_MS;
const MINUTE_MS = 60_000;

describe("BUILD GATE — V_terminal carries no weighting coefficients (§8.3.2, §8.10)", () => {
  test("the signature admits three CU quantities and nothing else", () => {
    const source = fs.readFileSync(path.join(PRICING_DIR, "vTerminal.js"), "utf8");
    const body = /function vTerminal\(input\)[\s\S]*?\n}\n/.exec(source)[0];

    // The value expression is a plain difference of the three CU quantities. No
    // multiplication appears anywhere in the function, so a weight has nowhere to live.
    expect(body).toMatch(/cu:\s*source\.vAvailCu - source\.chargeAccessCu - source\.socDeficitCu,/);
    expect(body.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/[^*]\*[^*/]/);

    // And the parameter list is exactly the three components §8.3.2 sums.
    const parameters = /@param \{\{([^}]*)\}\} input/.exec(source);
    expect(parameters[1]).toMatch(/vAvailCu: number, chargeAccessCu: number, socDeficitCu: number/);
  });

  test("the module reads no register entry — §8.10 gives V_terminal none", () => {
    const source = fs.readFileSync(path.join(PRICING_DIR, "vTerminal.js"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/resolve\s*\(|explain\s*\(|readParameter/);
    // The two rates it does apply are the ones C_direct already uses, passed in as
    // constructed rates rather than resolved here.
    expect(code).toMatch(/lambdaTime\.value/);
    expect(code).toMatch(/cuPerWh\.value/);
  });

  test("the three components are summed directly, and each is already CU", () => {
    const result = vTerminal.vTerminal({ vAvailCu: 100, chargeAccessCu: 30, socDeficitCu: 5 });
    expect(result.cu).toBe(65);
    expect(result.components).toEqual({ vAvailCu: 100, chargeAccessCu: 30, socDeficitCu: 5 });
  });

  test("an absent component is refused rather than treated as zero", () => {
    expect(vTerminal.vTerminal({ vAvailCu: 100, chargeAccessCu: 30 }).ok).toBe(false);
    expect(vTerminal.vTerminal({ vAvailCu: 100, chargeAccessCu: 30 }).missing).toEqual(["socDeficitCu"]);
  });
});

describe("§8.3.2 — V_avail", () => {
  const snapshot = costFixture.priceSnapshot();

  test("the integral is an exact finite sum over the surface's own buckets", () => {
    const result = vTerminal.vAvail({
      snapshot,
      zoneId: "zone-rich",
      fromMs: DECISION_TIME_MS,
      horizonEndMs: snapshot.horizonEndMs,
    });
    // 0.04 CU·s⁻¹ over 30 minutes.
    expect(result.cu).toBeCloseTo(0.04 * 1800, 9);
    expect(result.bucketsUsed).toBe(1);
  });

  test("it is zero at or beyond the horizon — the boundary condition §8.3.2 states", () => {
    const at = vTerminal.vAvail({
      snapshot,
      zoneId: "zone-rich",
      fromMs: snapshot.horizonEndMs,
      horizonEndMs: snapshot.horizonEndMs,
    });
    expect(at.cu).toBe(0);
    expect(at.truncatedByHorizon).toBe(true);
  });

  test("it is additive over disjoint intervals, which is what makes the telescoping exact", () => {
    const whole = vTerminal.vAvail({
      snapshot,
      zoneId: "zone-rich",
      fromMs: DECISION_TIME_MS,
      horizonEndMs: snapshot.horizonEndMs,
    });
    const tail = vTerminal.vAvail({
      snapshot,
      zoneId: "zone-rich",
      fromMs: DECISION_TIME_MS + 10 * MINUTE_MS,
      horizonEndMs: snapshot.horizonEndMs,
    });
    expect(whole.cu - tail.cu).toBeCloseTo(0.04 * 600, 9);
  });

  test("a zone with no published price is refused, never valued at zero", () => {
    const result = vTerminal.vAvail({
      snapshot,
      zoneId: "zone-unknown",
      fromMs: DECISION_TIME_MS,
      horizonEndMs: snapshot.horizonEndMs,
    });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/not a zone worth zero/);
  });

  test("a surface that stops short of the horizon is refused, not silently truncated", () => {
    const short = costFixture.priceSnapshot({
      zones: {
        "zone-rich": [
          { startMs: DECISION_TIME_MS - 1000, endMs: DECISION_TIME_MS + 5 * MINUTE_MS, lambdaCuPerSecond: 0.04 },
        ],
      },
    });
    const result = vTerminal.vAvail({
      snapshot: short,
      zoneId: "zone-rich",
      fromMs: DECISION_TIME_MS,
      horizonEndMs: short.horizonEndMs,
    });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/short of the valuation horizon/);
  });
});

describe("§8.3.2 — the two subtracted costs, from already-registered rates", () => {
  const rates = costFixture.rates();

  test("charge access prices travel and queue at λ_time and the approach at cu_per_wh", () => {
    const result = vTerminal.chargeAccessCost({
      travelSeconds: 300,
      queueWaitSeconds: 120,
      approachEnergyWh: 40,
      lambdaTime: rates.lambdaTime,
      cuPerWh: rates.cuPerWh,
    });
    expect(result.cu).toBe(420 * 1 + 40 * 1);
  });

  test("the SoC deficit prices the energy bought back and the time it takes", () => {
    const result = vTerminal.socDeficitCost({
      deficitWh: 200,
      chargeSeconds: 600,
      lambdaTime: rates.lambdaTime,
      cuPerWh: rates.cuPerWh,
    });
    expect(result.cu).toBe(200 + 600);
  });

  test("a state at or above the reserve costs nothing", () => {
    const result = vTerminal.socDeficitCost({
      deficitWh: 0,
      chargeSeconds: 0,
      lambdaTime: rates.lambdaTime,
      cuPerWh: rates.cuPerWh,
    });
    expect(result.cu).toBe(0);
  });
});

describe("§6.4 — Ω_terminal is derived from the surface in use", () => {
  test("it is the λ spread over the horizon plus the two state-gain ceilings", () => {
    const snapshot = costFixture.priceSnapshot();
    const result = vTerminal.omegaTerminal({
      snapshot,
      valueHorizonSeconds: 1800,
      maxChargeAccessGainCu: 50,
      maxSocDeficitGainCu: 20,
    });
    expect(result.cu).toBeCloseTo((0.04 - 0.01) * 1800 + 50 + 20, 9);
    expect(result.breakdown.priceSnapshotVersion).toBe(7);
  });

  test("a surface with no prices cannot produce a bound", () => {
    const result = vTerminal.omegaTerminal({
      snapshot: { version: 1, zones: {} },
      valueHorizonSeconds: 1800,
      maxChargeAccessGainCu: 0,
      maxSocDeficitGainCu: 0,
    });
    expect(result.ok).toBe(false);
  });

  test("publishing derives the bound from the surface it publishes, not from an argument", () => {
    const published = capacityPricing.publish({
      version: 12,
      publishedAtMs: DECISION_TIME_MS,
      zones: {
        "zone-a": [{ startMs: DECISION_TIME_MS, endMs: DECISION_TIME_MS + 1800_000, lambdaCuPerSecond: 0.05 }],
      },
      requiredZoneIds: ["zone-a", "zone-b"],
      fromMs: DECISION_TIME_MS,
      horizonEndMs: DECISION_TIME_MS + 1800_000,
      valueHorizonSeconds: 1800,
      config: { "cost.opportunity.lambda_zone_prior": 0.01 },
      estimator: capacityPricing.ESTIMATOR.FORECAST_QUEUEING,
      maxChargeAccessGainCu: 0,
      maxSocDeficitGainCu: 0,
    });

    expect(published.ok).toBe(true);
    // zone-b was padded with the prior, and the bound reflects the padded surface.
    expect(published.snapshot.paddedZones.map((row) => row.zoneId)).toEqual(["zone-b"]);
    expect(published.omegaTerminal.cu).toBeCloseTo((0.05 - 0.01) * 1800, 9);
    expect(published.degradation.envelopeReduction).toMatch(/Ω_terminal is recomputed from the same prices/);
  });
});

describe("§8.3.1 — the three estimators, in order of preference", () => {
  test("the queueing estimate is Λ · |∂(delay cost)/∂S| and is non-negative", () => {
    const result = capacityPricing.queueingEstimate({
      arrivalRate: 10,
      projectedSupply: 5,
      responseCurve: [
        { supply: 0, delayCostCu: 100 },
        { supply: 10, delayCostCu: 0 },
      ],
    });
    // slope −10 CU per agent, arrival rate 10 → λ = 100.
    expect(result.lambdaCuPerSecond).toBe(100);
    expect(result.ok).toBe(true);
  });

  test("scarcity raises λ and ample supply lowers it — the desired behaviour §8.3.1 names", () => {
    const curve = [
      { supply: 0, delayCostCu: 200 },
      { supply: 5, delayCostCu: 40 },
      { supply: 10, delayCostCu: 20 },
    ];
    const scarce = capacityPricing.queueingEstimate({ arrivalRate: 1, projectedSupply: 2, responseCurve: curve });
    const ample = capacityPricing.queueingEstimate({ arrivalRate: 1, projectedSupply: 8, responseCurve: curve });
    expect(scarce.lambdaCuPerSecond).toBeGreaterThan(ample.lambdaCuPerSecond);
    expect(scarce.convexDecreasing).toBe(true);
  });

  test("a non-convex fit is reported rather than silently used", () => {
    const result = capacityPricing.queueingEstimate({
      arrivalRate: 1,
      projectedSupply: 5,
      responseCurve: [
        { supply: 0, delayCostCu: 10 },
        { supply: 5, delayCostCu: 8 },
        { supply: 10, delayCostCu: 0 },
      ],
    });
    expect(result.reason).toMatch(/not convex decreasing/);
  });

  test("a singleton-regime dual is an exact marginal price and may calibrate", () => {
    const accepted = capacityPricing.acceptDual({
      zoneId: "z",
      valueCuPerSecond: 0.05,
      regime: capacityPricing.REGIME.SINGLETON,
      roundId: "r1",
    });
    expect(accepted.ok).toBe(true);
    expect(accepted.dual.exactMarginalPrice).toBe(true);
    expect(accepted.dual.usage).toBe("CALIBRATION_ONLY");
  });

  test("a column-regime dual without a recorded LP–IP gap is refused outright", () => {
    const refused = capacityPricing.acceptDual({
      zoneId: "z",
      valueCuPerSecond: 0.05,
      regime: capacityPricing.REGIME.COLUMN,
    });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/declines to make silently/);
  });

  test("a column-regime dual with its gap recorded is accepted, as an approximation", () => {
    const accepted = capacityPricing.acceptDual({
      zoneId: "z",
      valueCuPerSecond: 0.05,
      regime: capacityPricing.REGIME.COLUMN,
      lpIpGapCu: 12,
    });
    expect(accepted.ok).toBe(true);
    expect(accepted.dual.exactMarginalPrice).toBe(false);
    expect(accepted.dual.lpIpGapCu).toBe(12);
  });

  test("a dual that does not name its regime is refused", () => {
    expect(capacityPricing.acceptDual({ valueCuPerSecond: 1 }).reason).toMatch(/does not name the solve regime/);
  });

  test("padding uses the configured prior and records every padded interval", () => {
    const padded = capacityPricing.padToHorizon({
      buckets: [{ startMs: 100, endMs: 200, lambdaCuPerSecond: 0.5 }],
      fromMs: 0,
      horizonEndMs: 400,
      priorCuPerSecond: 0.01,
    });
    expect(padded.buckets.map((row) => [row.startMs, row.endMs, row.padded])).toEqual([
      [0, 100, true],
      [100, 200, false],
      [200, 400, true],
    ]);
    expect(padded.padded).toHaveLength(2);
  });

  test("with no prior there is nothing declared to fall back to, and padding refuses", () => {
    const padded = capacityPricing.padToHorizon({ buckets: [], fromMs: 0, horizonEndMs: 100 });
    expect(padded.ok).toBe(false);
    expect(padded.reason).toMatch(/inventing a zero would understate/);
  });

  test("a surface with no version has no key — §9.6 pins by version", () => {
    expect(() => capacityPricing.key(null)).toThrow(/pins the round's price snapshot by version/);
    expect(capacityPricing.key(7)).toBe("engine:price:7");
  });
});

describe("§5.2 — the Forecast Service ladder", () => {
  const forecast = (version, publishedAtMs) => ({
    version,
    publishedAtMs,
    zones: {
      "zone-a": {
        arrivalRate: 5,
        projectedSupply: 3,
        responseCurve: [
          { supply: 0, delayCostCu: 100 },
          { supply: 10, delayCostCu: 0 },
        ],
      },
    },
  });

  test("the ladder is exactly §5.2's four rungs", () => {
    expect(forecastClient.LADDER).toEqual([
      "LIVE_FORECAST",
      "LAST_GOOD_FORECAST",
      "SEASONAL_BASELINE_PRIOR",
      "FLAT",
    ]);
  });

  test("a fresh live forecast is used with no degradation flag", () => {
    const resolved = forecastClient.resolve({
      live: forecast(3, DECISION_TIME_MS - 1000),
      decisionTimeMs: DECISION_TIME_MS,
      maxAgeSeconds: 300,
    });
    expect(resolved.source).toBe(forecastClient.SOURCE.LIVE);
    expect(resolved.degradation).toBeNull();
  });

  test("a stale live forecast is demoted rather than discarded, and the flag says so", () => {
    const resolved = forecastClient.resolve({
      live: forecast(3, DECISION_TIME_MS - 3_600_000),
      decisionTimeMs: DECISION_TIME_MS,
      maxAgeSeconds: 300,
    });
    expect(resolved.source).toBe(forecastClient.SOURCE.LAST_GOOD);
    expect(resolved.degradation.envelopeReduction).toMatch(/shrinks toward its configured prior/);
  });

  test("with nothing at any rung the result is FLAT, with its envelope reduction stated", () => {
    const resolved = forecastClient.resolve({ decisionTimeMs: DECISION_TIME_MS, maxAgeSeconds: 300 });
    expect(resolved.source).toBe(forecastClient.SOURCE.FLAT);
    expect(resolved.forecast).toBeNull();
    expect(resolved.degradation.envelopeReduction).toMatch(/stops discriminating between zones/);
  });

  test("a forecast dated after the round is refused, not treated as fresh", () => {
    const age = forecastClient.staleness(
      { publishedAtMs: DECISION_TIME_MS + 1000 },
      DECISION_TIME_MS,
      300,
    );
    expect(age.ok).toBe(false);
    expect(age.reason).toMatch(/clock discipline/);
  });

  test("an unversioned forecast is refused — a round pins its inputs by version", () => {
    const consumed = forecastClient.consume({ publishedAtMs: DECISION_TIME_MS, zones: {} });
    expect(consumed.ok).toBe(false);
    expect(consumed.problems[0]).toMatch(/carries no version/);
  });

  test("a zone missing any of the three series is refused", () => {
    const consumed = forecastClient.consume({
      version: 1,
      publishedAtMs: DECISION_TIME_MS,
      zones: { "zone-a": { arrivalRate: 5 } },
    });
    expect(consumed.ok).toBe(false);
    expect(consumed.problems[0]).toMatch(/projectedSupply, responseCurve/);
  });
});

describe("§20.3 item 2 — the cell-pair travel-time cache", () => {
  const parts = { originCell: "cell-a", destCell: "cell-b", profileKey: "sidewalk-v2", timeBucket: "T12" };

  const makeKv = () => {
    const store = new Map();
    return {
      store,
      get: async (key) => store.get(key) ?? null,
      set: async (key, value) => store.set(key, value),
    };
  };

  test("the key carries all four components §20.3 names", () => {
    expect(cellPairCache.key(parts).key).toBe("engine:route:cell:cell-a:cell-b:sidewalk-v2:T12");
  });

  test("a key missing any component is refused, not defaulted", () => {
    for (const field of cellPairCache.KEY_FIELDS) {
      const partial = { ...parts, [field]: undefined };
      const built = cellPairCache.key(partial);
      expect({ field, ok: built.ok }).toEqual({ field, ok: false });
      expect(built.reason).toContain(field);
    }
  });

  test("the intra-cell offset is added at both ends, never subtracted", () => {
    const entry = cellPairCache.buildEntry({ distanceM: 1000, travelSeconds: 500, travelSdSeconds: 25 }).entry;
    const corrected = cellPairCache.applyIntraCellOffset(entry, {
      intraCellOffsetM: 250,
      speedMetresPerSecond: 2,
    });
    expect(corrected.corrected.distanceM).toBe(1500);
    expect(corrected.corrected.travelSeconds).toBe(500 + 500 / 2);
    expect(corrected.corrected.correctionDirection).toBe("ADDED");
  });

  test("the entry carries a travel-time distribution, not only a mean", () => {
    const entry = cellPairCache.buildEntry({ distanceM: 100, travelSeconds: 50, travelSdSeconds: 5 });
    expect(entry.entry.travelSdSeconds).toBe(5);
    expect(cellPairCache.buildEntry({ distanceM: 100, travelSeconds: 50 }).missing).toEqual(["travelSdSeconds"]);
  });

  test("a miss falls through to the router and the result is cached", async () => {
    const kv = makeKv();
    const counters = new cellPairCache.Counters();
    const route = jest.fn(async () => ({ distanceM: 800, travelSeconds: 400, travelSdSeconds: 20 }));

    const first = await cellPairCache.read({ kv, route, counters }, parts, {
      intraCellOffsetM: 0,
      speedMetresPerSecond: 2,
      ttlSeconds: 60,
    });
    expect(first.hit).toBe(false);
    expect(route).toHaveBeenCalledTimes(1);

    const second = await cellPairCache.read({ kv, route, counters }, parts, {
      intraCellOffsetM: 0,
      speedMetresPerSecond: 2,
      ttlSeconds: 60,
    });
    expect(second.hit).toBe(true);
    expect(route).toHaveBeenCalledTimes(1);
    expect(counters.report(0.95)).toEqual({ hits: 1, misses: 1, hitRate: 0.5, belowTarget: true });
  });

  test("a cache error is a miss, never a verdict", async () => {
    const failing = { get: async () => { throw new Error("redis down"); }, set: async () => {} };
    const route = jest.fn(async () => ({ distanceM: 100, travelSeconds: 50, travelSdSeconds: 5 }));
    const result = await cellPairCache.read({ kv: failing, route }, parts, {
      intraCellOffsetM: 0,
      speedMetresPerSecond: 1,
    });
    expect(result.ok).toBe(true);
    expect(route).toHaveBeenCalled();
  });

  test("a router failure is reported with §5.2's declared degradation, never guessed around", async () => {
    const route = async () => {
      throw new Error("timeout");
    };
    const result = await cellPairCache.read({ kv: makeKv(), route }, parts, {});
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/route\.degraded_max_radius/);
  });

  test("hops resolve in stop order, chaining origin to destination", async () => {
    const kv = makeKv();
    const route = async ({ originCell, destCell }) => ({
      distanceM: `${originCell}->${destCell}`.length * 10,
      travelSeconds: 60,
      travelSdSeconds: 5,
    });
    const result = await cellPairCache.hopsFor(
      { kv, route, counters: new cellPairCache.Counters() },
      {
        originCell: "cell-origin",
        stops: [{ sequence: 1, cellId: "cell-a" }, { sequence: 2, cellId: "cell-b" }],
        profileKey: "p",
        timeBucket: "T1",
        options: { intraCellOffsetM: 0, speedMetresPerSecond: 1 },
      },
    );
    expect(result.ok).toBe(true);
    expect(result.hops).toHaveLength(2);
    expect(result.misses).toBe(2);
  });
});

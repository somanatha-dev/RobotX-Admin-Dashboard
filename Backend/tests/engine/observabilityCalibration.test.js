"use strict";

/**
 * Engine lane — Phase 11: prediction calibration as a first-class loop (§21.5).
 *
 * The property that gets the most attention here is the one §21.5 is emphatic about and
 * that an implementation is most likely to get wrong: **T3 is not validated by counting
 * events**. "Validating a 1e-7 target by counting its occurrences is a category error",
 * and a report of "0 observed, 0 expected" would read as confirmation when it is the
 * absence of a test.
 */

const calibration = require("../../src/engine/observability/calibration");
const fixture = require("./helpers/roundFixture");

const observation = (overrides) =>
  calibration.observationFrom({
    predictor: calibration.PREDICTOR.TRAVEL_TIME,
    unit: "s",
    predicted: 300,
    realised: 300,
    predictedAtMs: 0,
    observedAtMs: 1000,
    slice: { zoneId: "Z1", missionClass: "STANDARD", agentClassId: "AC1", timeBucket: 9 },
    subject: { decisionId: "d1" },
    ...(overrides || {}),
  });

describe("§21.5 — the observation", () => {
  test("computes the signed error as realised minus predicted", () => {
    expect(observation({ predicted: 300, realised: 360 }).signedError).toBe(60);
    expect(observation({ predicted: 300, realised: 240 }).signedError).toBe(-60);
  });

  test("records the band and whether reality landed inside it", () => {
    expect(observation({ realised: 310, bandLower: 280, bandUpper: 340 }).withinBand).toBe(true);
    expect(observation({ realised: 400, bandLower: 280, bandUpper: 340 }).withinBand).toBe(false);
    expect(observation({ realised: 310 }).withinBand).toBeNull();
  });

  test("keeps the predictor's own unit — never normalised (§1.3)", () => {
    // A bias of "0.2" is uninterpretable without knowing whether it is seconds or Wh.
    expect(observation({ predictor: calibration.PREDICTOR.ENERGY, unit: "Wh" }).unit).toBe("Wh");
  });

  test("carries the four §21.5 slices as columns", () => {
    const row = observation();
    for (const dimension of calibration.SLICE_DIMENSIONS) expect(row[dimension]).not.toBeUndefined();
  });
});

describe("§21.5 — bias drives refitting", () => {
  test("mean signed error, absolute and relative", () => {
    const rows = [observation({ realised: 360 }), observation({ realised: 300 }), observation({ realised: 300 })];
    const scored = calibration.bias(rows);
    expect(scored.n).toBe(3);
    expect(scored.meanSignedError).toBe(20);
    // §21.5's own worked example is relative: "drifted 20 % above prediction".
    expect(scored.relativeBias).toBeCloseTo(20 / 300);
    expect(scored.unit).toBe("s");
  });

  test("a zero mean prediction yields no relative bias rather than infinity", () => {
    const scored = calibration.bias([observation({ predicted: 0, realised: 5 })]);
    expect(scored.relativeBias).toBeNull();
  });

  test("an empty slice says nothing rather than zero", () => {
    expect(calibration.bias([])).toEqual({ n: 0, meanSignedError: null, meanPredicted: null, relativeBias: null, unit: null });
  });
});

describe("§21.5 — dispersion drives uncertainty band width, reserves, and p_late", () => {
  test("reports the spread AND the band coverage it is supposed to produce", () => {
    const rows = [
      observation({ realised: 300, bandLower: 280, bandUpper: 320 }),
      observation({ realised: 340, bandLower: 280, bandUpper: 320 }),
      observation({ realised: 260, bandLower: 280, bandUpper: 320 }),
      observation({ realised: 310, bandLower: 280, bandUpper: 320 }),
    ];
    const spread = calibration.dispersion(rows);
    expect(spread.standardDeviation).toBeGreaterThan(0);
    // A predictor whose band contains half of what it claims is feeding an energy
    // reserve a confidence it does not have — and the spread alone would not say so.
    expect(spread.bandCoverage).toBe(0.5);
    expect(spread.drives).toMatch(/reserves and p_late/);
  });
});

describe("§21.5 / I17 — each tier by its own instrument, at its own timescale", () => {
  test("T1 and T2 are scored by event count; T3 is NOT", () => {
    expect(calibration.INSTRUMENT_BY_TIER.T1.instrument).toBe(calibration.INSTRUMENT.EVENT_COUNT);
    expect(calibration.INSTRUMENT_BY_TIER.T2.instrument).toBe(calibration.INSTRUMENT.EVENT_COUNT);
    expect(calibration.INSTRUMENT_BY_TIER.T3.instrument).toBe(calibration.INSTRUMENT.TAIL_CALIBRATION);
    expect(calibration.INSTRUMENT_BY_TIER.T1.timescale).toBe("days");
    expect(calibration.INSTRUMENT_BY_TIER.T2.timescale).toBe("quarters");
    expect(calibration.INSTRUMENT_BY_TIER.T3.why).toMatch(/category error/);
  });

  test("T1 compares the observed frequency against the claimed probability", () => {
    const rows = Array.from({ length: 100 }, (unused, index) =>
      observation({
        predictor: calibration.PREDICTOR.ENERGY_SHORTFALL,
        unit: "prob",
        tier: "T1",
        claimedProbability: 0.01,
        eventOccurred: index < 3,
      }),
    );
    const scored = calibration.probabilisticCalibration({ tier: "T1", observations: rows, minSamples: 30 });
    expect(scored.instrument).toBe(calibration.INSTRUMENT.EVENT_COUNT);
    expect(scored.observedFrequency).toBe(0.03);
    expect(scored.claimedProbability).toBeCloseTo(0.01);
    // Positive excess means reality produced the event MORE often than claimed: either
    // the model is miscalibrated or F34 is misimplemented, and both are serious.
    expect(scored.excess).toBeCloseTo(0.02);
    expect(scored.sufficientSample).toBe(true);
  });

  test("T3 refuses to compute an event frequency, and says why", () => {
    const rows = Array.from({ length: 500 }, (unused, index) =>
      observation({
        predictor: calibration.PREDICTOR.ENERGY_SHORTFALL,
        unit: "prob",
        tier: "T3",
        claimedProbability: 1e-7,
        eventOccurred: false,
        tailQuantile: index / 500,
      }),
    );
    const scored = calibration.probabilisticCalibration({ tier: "T3", observations: rows });

    expect(scored.instrument).toBe(calibration.INSTRUMENT.TAIL_CALIBRATION);
    expect(scored.observedFrequency).toBeUndefined();
    expect(scored.observedFrequencyDeliberatelyNotComputed).toBe(true);
    // A well-shaped predictive distribution is uniform in its quantiles.
    expect(scored.ksDistanceFromUniform).toBeLessThan(0.05);
    expect(scored.observedTailFraction).toBeCloseTo(0.1, 2);
  });

  test("T3 with no tail quantiles reports the absence of a test, not a passing one", () => {
    const rows = [observation({ predictor: calibration.PREDICTOR.ENERGY_SHORTFALL, unit: "prob", tier: "T3", eventOccurred: false })];
    const scored = calibration.probabilisticCalibration({ tier: "T3", observations: rows });
    expect(scored.ok).toBe(false);
    expect(scored.reason).toMatch(/deliberately NOT scored by counting events/);
    expect(scored.observedFrequencyDeliberatelyNotComputed).toBe(true);
  });

  test("a skewed tail is detected — the whole point of the T3 instrument", () => {
    // Every realised value in the far tail: a distribution that is confidently wrong
    // about exactly the region F34's T3 target lives in.
    const rows = Array.from({ length: 200 }, () =>
      observation({ predictor: calibration.PREDICTOR.ENERGY_SHORTFALL, unit: "prob", tier: "T3", tailQuantile: 0.99 }),
    );
    const scored = calibration.probabilisticCalibration({ tier: "T3", observations: rows });
    expect(scored.ksDistanceFromUniform).toBeGreaterThan(0.5);
    expect(scored.tailExcess).toBeCloseTo(0.9);
  });

  test("an unknown tier is refused rather than scored", () => {
    expect(calibration.probabilisticCalibration({ tier: "T9", observations: [] }).ok).toBe(false);
  });
});

describe("§21.5 — drift alarms per slice", () => {
  test("an alarm fires past the threshold and names the operational reading", () => {
    const rows = Array.from({ length: 40 }, () => observation({ realised: 400 }));
    const alarm = calibration.driftAlarm({ observations: rows, slice: { zoneId: "Z1" }, biasAlarm: 0.2, minSamples: 30 });
    expect(alarm.alarm).toBe(true);
    expect(alarm.relativeBias).toBeCloseTo(100 / 300);
    // §21.5: "a route whose realised travel time has drifted 20 % above prediction
    // indicates roadworks, a new signal, or seasonal congestion".
    expect(alarm.interpretation).toMatch(/slower\/heavier than predicted/);
  });

  test("a slice below the sample floor says so rather than alarming on noise", () => {
    const alarm = calibration.driftAlarm({ observations: [observation({ realised: 900 })], slice: {}, biasAlarm: 0.2, minSamples: 30 });
    expect(alarm.alarm).toBe(false);
    expect(alarm.sufficientSample).toBe(false);
    expect(alarm.interpretation).toMatch(/not enough observations/);
  });

  test("a conservative predictor is named as such rather than merely 'drifting'", () => {
    const rows = Array.from({ length: 40 }, () => observation({ realised: 200 }));
    const alarm = calibration.driftAlarm({ observations: rows, slice: {}, biasAlarm: 0.2, minSamples: 30 });
    expect(alarm.interpretation).toMatch(/conservative/);
  });

  test("slices are grouped on §21.5's four dimensions", () => {
    const groups = calibration.bySlice([
      observation({ slice: { zoneId: "Z1", missionClass: "A", agentClassId: "AC1", timeBucket: 1 } }),
      observation({ slice: { zoneId: "Z2", missionClass: "A", agentClassId: "AC1", timeBucket: 1 } }),
      observation({ slice: { zoneId: "Z1", missionClass: "A", agentClassId: "AC1", timeBucket: 1 } }),
    ]);
    expect(groups.size).toBe(2);
  });
});

describe("§21.5 — the scoring pass", () => {
  test("scores every predictor, slices it, and applies each tier's own window", async () => {
    const prisma = fixture.memoryPrisma();
    const toMs = 10_000_000_000;

    for (let index = 0; index < 40; index += 1) {
      prisma.__tables.calibrationObservations.push(
        observation({ realised: 400, observedAtMs: toMs - 1000, slice: { zoneId: "Z1", missionClass: "A", agentClassId: "AC1", timeBucket: 1 } }),
      );
    }
    // A T3 observation far outside T1's window, so the per-tier windows are seen to bite.
    prisma.__tables.calibrationObservations.push(
      observation({ predictor: calibration.PREDICTOR.ENERGY_SHORTFALL, unit: "prob", tier: "T3", tailQuantile: 0.4, observedAtMs: toMs - 30 * 86_400_000 }),
    );

    const config = {
      get: (name) =>
        ({
          "observability.calibration_bias_alarm": 0.2,
          "observability.calibration_min_samples": 30,
          "observability.calibration_tier_window": { T1: 604800, T2: 7862400, T3: 31557600 },
        })[name],
    };

    const report = await calibration.score({ prisma }, { fromMs: toMs - 31557600000, toMs, config });

    const travel = report.predictors.find((row) => row.predictor === calibration.PREDICTOR.TRAVEL_TIME);
    expect(travel.n).toBe(40);
    expect(travel.alarms).toBe(1);
    expect(report.totalAlarms).toBe(1);

    const tiers = Object.fromEntries(report.energyShortfallTiers.map((row) => [row.tier, row]));
    // The observation is 30 days old: inside T3's fleet-year window, outside T1's week.
    expect(tiers.T3.n).toBe(1);
    expect(tiers.T1.n).toBe(0);
    expect(tiers.T3.instrument).toBe(calibration.INSTRUMENT.TAIL_CALIBRATION);
  });
});

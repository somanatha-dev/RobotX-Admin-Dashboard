"use strict";

/**
 * E-8 — **an absent physical input is not a benign one.**
 *
 * Two coercions on the V1 plan path turned silence into a number, and both did it in the
 * optimistic direction:
 *
 * 1. `planBuilder.legProfiles` read `isNumber(terrain.climbM) ? terrain.climbM : 0` (and
 *    `: 1` for `stopStartCycles`). A stop with no terrain produced a profile asserting flat
 *    ground. `energy/consumption.legEnergyWh` already listed those fields in
 *    `REQUIRED_PROFILE_FIELDS` and would have refused — but the coercion meant it always
 *    received a number, so the guard one layer down was **unreachable**.
 * 2. `timeline.project` read `isNumber(hop.travelSdSeconds) ? hop.travelSdSeconds : 0`. A
 *    hop with no spread contributed no variance, so §8.4's `p_late` priced the plan as
 *    arriving on a certain schedule. This is N29's coalesce, one layer on from the one
 *    `tools/routing/b1Benchmark.js` was already corrected for.
 *
 * Fixing (1) exposed a third defect it had been hiding. Terrain arrived as `terrainByStop`,
 * keyed by the **sequenced** stop number, and `insertChargingStop` re-sequences every stop
 * when it evaluates an insertion position — so under §13.4 each stop after the inserted
 * charge read its neighbour's elevation profile. That was never a refusal; it was a wrong
 * number. §14.2 states climb, regeneration and stop-start over the *traversal*, so terrain
 * now rides on the hop, `hopsForSequence` re-resolves it per variant, and the misalignment
 * cannot be expressed.
 *
 * The distinction most tests here turn on is **declared zero versus absent**. A router that
 * says "this hop climbs 0 m" has measured something; a router that says nothing has not. The
 * fix must keep the first working and refuse the second — a test that only checked "absent
 * is refused" would pass against a change that refused both.
 */

const planBuilder = require("../../src/engine/plan/planBuilder");
const timeline = require("../../src/engine/plan/timeline");
const cellPairCache = require("../../src/engine/routing/cellPairCache");
const consumption = require("../../src/engine/energy/consumption");
const fixture = require("./helpers/planFixture");

/** A projected stop as `timeline.project()` emits it, with the hop's terrain carried. */
function projectedStop(overrides) {
  return {
    sequence: 1,
    distanceM: 1000,
    travelSeconds: 600,
    serviceSeconds: 60,
    waitSeconds: 0,
    climbM: 40,
    descentM: 12,
    stopStartCycles: 3,
    ...(overrides || {}),
  };
}

/** The smallest input `legProfiles` accepts: one projected stop on one Leg. */
function profileInput(overrides) {
  return {
    projectedStops: [projectedStop()],
    stops: [{ sequence: 1, legId: "leg-1" }],
    occupancy: [],
    environment: { ambientC: 18, packC: 22 },
    masses: { vehicleMassKg: 60, payloadMassExpectedKg: 8 },
    ...(overrides || {}),
  };
}

function projectInput(overrides) {
  return {
    startMs: 0,
    decisionTimeMs: 0,
    stops: [{ sequence: 1, serviceSeconds: 60, serviceSdSeconds: 5 }],
    hops: [{ distanceM: 1000, travelSeconds: 600, travelSdSeconds: 20, climbM: 40, descentM: 12, stopStartCycles: 3 }],
    ...(overrides || {}),
  };
}

describe("E-8 — terrain provenance in legProfiles", () => {
  test("a stop whose hop carries no terrain is refused, not treated as flat ground", () => {
    const result = planBuilder.legProfiles(
      profileInput({
        projectedStops: [projectedStop({ climbM: undefined, descentM: undefined, stopStartCycles: undefined })],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.problems[0]).toBe(planBuilder.FAILURE.MISSING_TERRAIN);
    expect(result.problems.join(" ")).toMatch(/climbM, descentM, stopStartCycles/u);
  });

  test("a partially resolved hop is refused, and names only the absent field", () => {
    const result = planBuilder.legProfiles(
      profileInput({ projectedStops: [projectedStop({ stopStartCycles: undefined })] }),
    );

    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/\(stopStartCycles\)/u);
    expect(result.problems.join(" ")).not.toMatch(/climbM/u);
  });

  test("a DECLARED flat hop is accepted — the fix refuses silence, not zero", () => {
    const result = planBuilder.legProfiles(
      profileInput({ projectedStops: [projectedStop({ climbM: 0, descentM: 0, stopStartCycles: 0 })] }),
    );

    expect(result.ok).toBe(true);
    expect(result.profiles[0].climbM).toBe(0);
    expect(result.profiles[0].descentM).toBe(0);
    expect(result.profiles[0].stopStartCycles).toBe(0);
  });

  test("hop terrain is carried through unchanged and summed across a Leg's stops", () => {
    const result = planBuilder.legProfiles(
      profileInput({
        projectedStops: [
          projectedStop({ sequence: 1, climbM: 40, descentM: 12, stopStartCycles: 3 }),
          projectedStop({ sequence: 2, distanceM: 500, climbM: 5, descentM: 30, stopStartCycles: 2 }),
        ],
        stops: [
          { sequence: 1, legId: "leg-1" },
          { sequence: 2, legId: "leg-1" },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.profiles[0].climbM).toBe(45);
    expect(result.profiles[0].descentM).toBe(42);
    expect(result.profiles[0].stopStartCycles).toBe(5);
  });

  /**
   * The reason the coercion mattered, stated as a test rather than as a comment: the
   * downstream guard exists and is correct, and the only thing that ever stopped it firing
   * was this function handing it a fabricated number.
   */
  test("consumption's own guard is now reachable — it lists the fields legProfiles used to invent", () => {
    expect(consumption.REQUIRED_PROFILE_FIELDS).toEqual(
      expect.arrayContaining(["climbM", "descentM", "stopStartCycles"]),
    );

    const withoutTerrain = consumption.legEnergyWh(
      { climb: 1, descent: 1, distance: 1, time: 1, mass: 1 },
      { distanceM: 1000, movingSeconds: 600, dwellSeconds: 60, totalSeconds: 660 },
      1,
    );
    expect(withoutTerrain.ok).toBe(false);
    expect(withoutTerrain.missing).toEqual(
      expect.arrayContaining(["profile.climbM", "profile.descentM", "profile.stopStartCycles"]),
    );
  });

  /**
   * The permissive direction, measured. Zeroed climb does not merely change the estimate —
   * it changes it downward, which is the direction that lets a mission the agent cannot
   * physically complete price as though it can.
   */
  test("zeroing climb understates mission energy, which is why the direction matters", () => {
    const model = fixture.buildInput().energy.model;
    const base = {
      legId: "leg-1",
      distanceM: 1000,
      descentM: 0,
      movingSeconds: 600,
      dwellSeconds: 60,
      totalSeconds: 660,
      stopStartCycles: 3,
      payloadMassKg: 8,
      vehicleMassKg: 60,
      ambientC: 18,
      packC: 22,
      compartmentOccupancy: [],
    };

    const flat = consumption.legEnergyWh(model, { ...base, climbM: 0 }, 1);
    const climbed = consumption.legEnergyWh(model, { ...base, climbM: 80 }, 1);

    expect(flat.ok).toBe(true);
    expect(climbed.ok).toBe(true);
    expect(climbed.wh).toBeGreaterThan(flat.wh);
  });
});

describe("E-8 — travel-time spread provenance in timeline.project", () => {
  test("a hop with no travelSdSeconds is refused rather than read as a certain arrival", () => {
    const result = timeline.project(
      projectInput({ hops: [{ distanceM: 1000, travelSeconds: 600, climbM: 40, descentM: 12, stopStartCycles: 3 }] }),
    );

    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/travel-time spread is unresolved/u);
    expect(result.problems.join(" ")).toMatch(/p_late/u);
  });

  test("a negative spread is refused — a standard deviation below zero is not a measurement", () => {
    const result = timeline.project(
      projectInput({
        hops: [
          { distanceM: 1000, travelSeconds: 600, travelSdSeconds: -1, climbM: 40, descentM: 12, stopStartCycles: 3 },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/travel-time spread is unresolved/u);
  });

  test("a DECLARED zero spread still projects, and contributes no variance", () => {
    const result = timeline.project(
      projectInput({
        stops: [{ sequence: 1, serviceSeconds: 60, serviceSdSeconds: 0 }],
        hops: [
          { distanceM: 1000, travelSeconds: 600, travelSdSeconds: 0, climbM: 40, descentM: 12, stopStartCycles: 3 },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.totals.endSdSeconds).toBe(0);
  });

  test("a stop with no serviceSdSeconds is refused — §13.2's ladder always returns one", () => {
    const result = timeline.project(projectInput({ stops: [{ sequence: 1, serviceSeconds: 60 }] }));

    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/service-time spread is unresolved/u);
  });

  test("a hop with no terrain is refused at the decision path", () => {
    const result = timeline.project(
      projectInput({ hops: [{ distanceM: 1000, travelSeconds: 600, travelSdSeconds: 20 }] }),
    );

    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/terrain is unresolved \(climbM, descentM, stopStartCycles\)/u);
  });

  test("a negative climb is refused — an elevation gain below zero is not a measurement", () => {
    const result = timeline.project(
      projectInput({
        hops: [
          { distanceM: 1000, travelSeconds: 600, travelSdSeconds: 20, climbM: -5, descentM: 12, stopStartCycles: 3 },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/terrain is unresolved \(climbM\)/u);
  });

  test("the hop's terrain reaches the projected stop, which is what legProfiles reads", () => {
    const result = timeline.project(projectInput());

    expect(result.ok).toBe(true);
    expect(result.stops[0].climbM).toBe(40);
    expect(result.stops[0].descentM).toBe(12);
    expect(result.stops[0].stopStartCycles).toBe(3);
  });

  /**
   * The band is what `p_late` reads. Before the fix, an absent spread and a declared zero
   * produced the *same* band, so the plan whose ETA nobody had characterised was priced
   * identically to the one measured as perfectly punctual.
   */
  test("the spread reaches the band, so an absent one would have understated p_late", () => {
    const hop = (travelSdSeconds) => [
      { distanceM: 1000, travelSeconds: 600, travelSdSeconds, climbM: 40, descentM: 12, stopStartCycles: 3 },
    ];
    const stops = [{ sequence: 1, serviceSeconds: 60, serviceSdSeconds: 0 }];

    const certain = timeline.project(projectInput({ stops, hops: hop(0) }));
    const uncertain = timeline.project(projectInput({ stops, hops: hop(45) }));

    const deadlineMs = 700_000;
    const punctual = timeline.lateProbability(certain.stops, deadlineMs);
    const erratic = timeline.lateProbability(uncertain.stops, deadlineMs);

    expect(erratic.lateProbability).toBeGreaterThan(punctual.lateProbability);
  });
});

describe("E-8 — the routing seam carries terrain without requiring it", () => {
  test("cellPairCache and timeline agree on which fields terrain is", () => {
    expect([...cellPairCache.TERRAIN_FIELDS]).toEqual([...timeline.TERRAIN_FIELDS]);
  });

  test("a router result with terrain carries it onto the entry", () => {
    const built = cellPairCache.buildEntry({
      distanceM: 1000,
      travelSeconds: 500,
      travelSdSeconds: 25,
      climbM: 40,
      descentM: 12,
      stopStartCycles: 3,
    });

    expect(built.ok).toBe(true);
    expect(built.entry.climbM).toBe(40);
    expect(built.entry.descentM).toBe(12);
    expect(built.entry.stopStartCycles).toBe(3);
  });

  /**
   * The seam is also what `tools/routing/b1Benchmark.js` measures engine latency and cache
   * hit rate through, and that harness builds no plan. Requiring terrain here would make it
   * cache nothing and report a hit rate of zero as though it were an engine result — so the
   * requirement lives at the decision path instead, and the absence is carried as `null`.
   */
  test("a router result without terrain still builds an entry, carrying null", () => {
    const built = cellPairCache.buildEntry({ distanceM: 1000, travelSeconds: 500, travelSdSeconds: 25 });

    expect(built.ok).toBe(true);
    expect(built.entry.climbM).toBeNull();
    expect(built.entry.descentM).toBeNull();
    expect(built.entry.stopStartCycles).toBeNull();
  });

  test("present-but-invalid terrain is refused here, so it is never cached", () => {
    const built = cellPairCache.buildEntry({
      distanceM: 1000,
      travelSeconds: 500,
      travelSdSeconds: 25,
      climbM: -1,
      descentM: Number.NaN,
      stopStartCycles: 3,
    });

    expect(built.ok).toBe(false);
    expect(built.missing).toEqual(["climbM", "descentM"]);
  });

  test("the intra-cell offset does not invent elevation for the metres it adds", () => {
    const entry = cellPairCache.buildEntry({
      distanceM: 1000,
      travelSeconds: 500,
      travelSdSeconds: 25,
      climbM: 40,
      descentM: 12,
      stopStartCycles: 3,
    }).entry;

    const corrected = cellPairCache.applyIntraCellOffset(entry, {
      intraCellOffsetM: 50,
      speedMetresPerSecond: 2,
    });

    expect(corrected.ok).toBe(true);
    expect(corrected.corrected.distanceM).toBeGreaterThan(entry.distanceM);
    expect(corrected.corrected.climbM).toBe(40);
    expect(corrected.corrected.descentM).toBe(12);
  });
});

describe("E-8 — the fix holds through the whole plan builder", () => {
  test("build() refuses a plan whose hops carry no terrain", () => {
    const bare = fixture
      .buildInput()
      .hops.map(({ distanceM, travelSeconds, travelSdSeconds }) => ({ distanceM, travelSeconds, travelSdSeconds }));

    const built = planBuilder.build(
      fixture.buildInput({ hops: bare, hopsForSequence: (stops) => stops.map(() => bare[0]) }),
    );

    expect(built.ok).toBe(false);
    expect(built.problems.join(" ")).toMatch(/terrain is unresolved/u);
  });

  test("build() still succeeds on the fixture, whose hops declare their terrain", () => {
    const built = planBuilder.build(fixture.buildInput());

    expect(built.ok).toBe(true);
  });

  /**
   * The defect the terrain fix exposed, pinned so it cannot come back. Under the old
   * sequence-keyed map, inserting a charging stop shifted every subsequent stop's key by
   * one and each read its neighbour's elevation profile — silently, because the missing
   * tail entry coerced to flat. Terrain on the hop makes that unrepresentable:
   * `hopsForSequence` is re-run over the re-sequenced list, so each stop's terrain follows
   * its own approach hop.
   */
  test("a charging insertion re-resolves terrain with the hops, so no stop reads its neighbour's", () => {
    const seen = [];
    const input = fixture.buildInput({
      hopsForSequence: (stops) => {
        seen.push(stops.length);
        return stops.map((stop, index) => ({
          distanceM: 600,
          travelSeconds: 600,
          travelSdSeconds: 30,
          climbM: 5 + index,
          descentM: 2 + index,
          stopStartCycles: 6 + index,
        }));
      },
    });

    const stops = [
      { sequence: 1, legId: "leg-1", stopType: "PICKUP", cellId: "cell-1" },
      { sequence: 2, legId: "leg-1", stopType: "DROP", cellId: "cell-2" },
    ];
    const result = planBuilder.insertChargingStop(input, stops);

    // Three stops are hopped for every insertion position, and the terrain came with them:
    // the charge stop has a real approach profile rather than the absent tail entry the
    // sequence-keyed map produced.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((count) => count === stops.length + 1)).toBe(true);
    expect(result.variant).not.toBeNull();
  });
});

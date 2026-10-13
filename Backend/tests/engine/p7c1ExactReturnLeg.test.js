"use strict";

/**
 * P7-C1 Step 3 — the return-to-charger leg is priced between EXACT coordinates.
 *
 * Before: `chargerCandidatesFor` asked `forPairing(originCell, [{ cellId }], profileKey)` — a
 * cell-pair question — although both ends are known exactly (the mission's last stop has a
 * lat/lon, and `Charger.latitude/longitude` are columns). The cache then added §20.3's
 * quantisation correction at both ends, `2 × route.intra_cell_offset_m` (2 × 250 m), to a
 * distance between points that need no correction. For TSK-816 that made a 65.55 m routed
 * return 565.55 m (P7-C1 Step 2, `p7c1ReturnEnergyLedger.test.js`).
 *
 * After: when the mission end and the charger both carry valid coordinates, the return hop is
 * asked between those exact points through the SAME seam the approach and linehaul already use
 * (`forPairing`'s `originPoint` + the stop's `lat`/`lon`). Whether a request is exact is still
 * the composition's decision (`routeEndpointBasis`): a composition whose router answers between
 * cell representatives keeps the cell-pair request and its correction, unchanged.
 *
 * Safe existing behaviour, kept and pinned here:
 *   · charger or mission end without valid coordinates → the old cell-pair request (offset kept);
 *   · an exact request the router refuses → the old cell-pair request, and the fallback is named;
 *   · both refused → the charger is omitted and named (never priced at a guessed or zero distance);
 *   · a charger with no cell → omitted, as before.
 * Untouched: E_return's formula and its 1.15 / 1.25 inflation, the DEPOT_ONLY fallback, charger
 * admissibility, projection freshness, the approach/linehaul hops, ranking and the gate.
 *
 * MOCKED BOUNDARY: a stub routing seam for the unit cases; `phase7World` (real LOCAL rows, real
 * V1 composition, real campus network) for TSK-816.
 */

const coordinatorSolvePath = require("../../src/workers/coordinatorSolvePath");
const cellPairCache = require("../../src/engine/routing/cellPairCache");
const eReturn = require("../../src/engine/energy/eReturn");
const configService = require("../../src/engine/config/service");
const w = require("./helpers/phase7World");

jest.setTimeout(60_000);

/* ═══════════════════════════════════════════════════════════════════════════
   1. chargerCandidatesFor — which question the routing seam is asked
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-C1 Step 3 — chargerCandidatesFor asks the routing seam for the exact return when it can", () => {
  const DROP_CELL = "8b6014510499fff";
  const DROP = { lat: 12.9023, lon: 77.5185 };
  const WH_PER_METRE = 0.05;
  const snapshot = configService.defaultSnapshot();

  const charger = (overrides) => ({
    chargerId: "CHG-1", cellId: "8b6014510498fff", isDepot: true, chargerClass: "STANDARD", latitude: 12.900729, longitude: 77.517603, ...overrides,
  });

  /** A stub seam: answers 66 m between exact points and 65 m + 500 m between cells, recording each call. */
  function seam({ exactRefused = false, cellRefused = false } = {}) {
    const calls = [];
    return {
      calls,
      forPairing: async (originCell, stops, profileKey, originPoint) => {
        calls.push({ originCell, stops, profileKey, originPoint });
        const exact = originPoint !== undefined;
        if ((exact && exactRefused) || (!exact && cellRefused)) {
          return { ok: false, hops: [null], problems: [`stop 1: refused (${exact ? "exact" : "cell"})`] };
        }
        return {
          ok: true,
          hops: [exact ? { distanceM: 66, travelSeconds: 47, intraCellOffsetM: 0 } : { distanceM: 565, travelSeconds: 404, intraCellOffsetM: 500 }],
          problems: [],
        };
      },
    };
  }

  async function candidatesWith(rows, routing, originPoint) {
    return coordinatorSolvePath.chargerCandidatesFor({
      context: { prisma: { charger: { findMany: async () => rows } }, returnLegEnergyWhPerMetre: WH_PER_METRE },
      routing,
      originCell: DROP_CELL,
      ...(originPoint === undefined ? {} : { originPoint }),
      profileKey: "GROUND",
      snapshot,
      scope: {},
    });
  }

  test("both ends known: one exact request, origin = the mission end, destination = the charger's own coordinates", async () => {
    const routing = seam();
    const estate = await candidatesWith([charger()], routing, DROP);
    expect(routing.calls).toEqual([
      { originCell: DROP_CELL, stops: [{ sequence: 1, cellId: "8b6014510498fff", lat: 12.900729, lon: 77.517603 }], profileKey: "GROUND", originPoint: DROP },
    ]);
    expect(estate.candidates).toEqual([
      expect.objectContaining({ chargerId: "CHG-1", distanceM: 66, travelSeconds: 47, energyWh: 66 * WH_PER_METRE }),
    ]);
    expect(estate.problems).toEqual([]);
  });

  test.each([
    ["no latitude", { latitude: null }],
    ["no longitude", { longitude: undefined }],
    ["a non-finite latitude", { latitude: Number.NaN }],
    ["a latitude out of range", { latitude: 91 }],
    ["a longitude out of range", { longitude: -181 }],
    ["a coordinate given as text", { latitude: "12.9" }],
  ])("a charger with %s: the old cell-pair request, offset kept — no coordinate is invented", async (_label, overrides) => {
    const routing = seam();
    const estate = await candidatesWith([charger(overrides)], routing, DROP);
    expect(routing.calls).toEqual([{ originCell: DROP_CELL, stops: [{ sequence: 1, cellId: "8b6014510498fff" }], profileKey: "GROUND", originPoint: undefined }]);
    expect(estate.candidates[0]).toMatchObject({ distanceM: 565, energyWh: 565 * WH_PER_METRE });
  });

  test.each([
    ["absent", undefined],
    ["null", null],
    ["without a longitude", { lat: 12.9 }],
    ["out of range", { lat: 12.9, lon: 200 }],
  ])("a mission end %s: the old cell-pair request for every charger", async (_label, originPoint) => {
    const routing = seam();
    const estate = await candidatesWith([charger(), charger({ chargerId: "CHG-2" })], routing, originPoint);
    expect(routing.calls.every((call) => call.originPoint === undefined && call.stops[0].lat === undefined)).toBe(true);
    expect(estate.candidates.map((row) => row.distanceM)).toEqual([565, 565]);
  });

  test("an exact request the router refuses falls back to the old cell-pair request, and says so", async () => {
    const routing = seam({ exactRefused: true });
    const estate = await candidatesWith([charger()], routing, DROP);
    expect(routing.calls.map((call) => call.originPoint)).toEqual([DROP, undefined]);
    expect(estate.candidates).toEqual([expect.objectContaining({ chargerId: "CHG-1", distanceM: 565 })]);
    expect(estate.problems).toEqual([
      "charger CHG-1: the exact return route was refused (stop 1: refused (exact)); priced as a cell pair with the §20.3 correction instead",
    ]);
  });

  test("both requests refused: the charger is omitted and named — never priced at a guessed or zero distance", async () => {
    const routing = seam({ exactRefused: true, cellRefused: true });
    const estate = await candidatesWith([charger()], routing, DROP);
    expect(estate.candidates).toEqual([]);
    expect(estate.problems.join(" ")).toMatch(/charger CHG-1: stop 1: refused \(cell\)/);
  });

  test("a charger with no cell is still omitted, whatever its coordinates", async () => {
    const routing = seam();
    const estate = await candidatesWith([charger({ cellId: null })], routing, DROP);
    expect(routing.calls).toEqual([]);
    expect(estate.candidates).toEqual([]);
    expect(estate.problems.join(" ")).toMatch(/states no cell/);
  });

  test("ordering and the nearest-k cut are unchanged: exact and cell-priced chargers sort by priced distance", async () => {
    const routing = seam();
    const estate = await candidatesWith([charger({ chargerId: "CELL-ONLY", latitude: null }), charger({ chargerId: "EXACT" })], routing, DROP);
    expect(estate.candidates.map((row) => row.chargerId)).toEqual(["EXACT", "CELL-ONLY"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. The cache contract the change relies on — unchanged
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-C1 Step 3 — the offset is still the composition's decision (cellPairCache, unchanged)", () => {
  const route = async (parts) => ({
    distanceM: 66,
    travelSeconds: 47,
    travelSdSeconds: 5,
    climbM: 0,
    descentM: 0,
    stopStartCycles: 0,
    // As the simulation router answers: exact points only when the request names them.
    ...(parts.originPoint ? { endpointBasis: cellPairCache.ENDPOINT_BASIS.EXACT_POINTS, path: [parts.originPoint, parts.destPoint] } : {}),
  });
  const input = (exactEndpoints) => ({
    originCell: "8b6014510499fff",
    originPoint: { lat: 12.9023, lon: 77.5185 },
    exactEndpoints,
    stops: [{ sequence: 1, cellId: "8b6014510498fff", lat: 12.900729, lon: 77.517603 }],
    profileKey: "GROUND",
    timeBucket: "tb",
    options: { ttlSeconds: 60, intraCellOffsetM: 250, speedMetresPerSecond: 1.5 },
  });

  test("a composition that routes exact points: no correction on an exact hop", async () => {
    const out = await cellPairCache.hopsFor({ route }, input(true));
    expect(out.hops[0]).toMatchObject({ distanceM: 66, intraCellOffsetM: 0 });
  });

  test("a composition that does not: the same coordinates are ignored and the 2 × 250 m correction stays", async () => {
    const out = await cellPairCache.hopsFor({ route }, input(false));
    expect(out.hops[0]).toMatchObject({ distanceM: 66 + 500, intraCellOffsetM: 500 });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. TSK-816 through the real path — before and after
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-C1 Step 3 — TSK-816: the return leg priced between the drop stop and the depot", () => {
  const DT = w.TSK816.assignRoundMs;
  const AGENT = "SIM-0A8C043FFE67";
  const DEPOT = { chargerId: "V1DEMO-DEPOT-01", cellId: "8b6014510498fff", lat: 12.900729, lon: 77.517603 };
  // Replayed AS RECORDED (2026-10-09): F34's floor was then the simulator's 5 %, because the commissioned
  // `batteryReservePct` did not reach the engine. Since the owner's decision of 2026-10-12 it does (15 % on
  // every LOCAL unit); `chargingAssignmentIntegration.test.js` pins the decision under it.
  const fleet = () => w.asRecorded(fleetCurrent());
  const fleetCurrent = () => [
    { robotId: AGENT, at: { lat: 12.901151, lon: 77.517575 }, socFraction: 0.29, status: "IDLE", positionAgeMs: 351 },
    {
      robotId: "SIM-1ABF21512BE5", at: { lat: 12.900817, lon: 77.518043 }, socFraction: 0.362, status: "PAUSED", positionAgeMs: 350,
      openCommitments: [{ legId: "leg-of-TSK-1790958521622-254", leaseExpiry: new Date("2026-10-02T16:53:35.042Z") }],
    },
    {
      robotId: "SIM-CFE1E46B2002", at: { lat: 12.900411, lon: 77.518715 }, socFraction: 0.62, status: "PAUSED", positionAgeMs: 349,
      openCommitments: [{ legId: "leg-of-TSK-1790960698218-551", leaseExpiry: new Date("2026-10-02T17:29:19.351Z") }],
    },
    { robotId: "SIM-9F6F88D84EBD", at: { lat: 12.90032004, lon: 77.51870238 }, socFraction: 0.95, status: "IDLE", positionAgeMs: 1360 },
  ];

  let out;
  let calls;
  beforeAll(async () => {
    calls = [];
    const original = eReturn.evaluate;
    const spy = jest.spyOn(eReturn, "evaluate").mockImplementation((input) => {
      const result = original(input);
      calls.push({ input, result });
      return result;
    });
    try {
      out = await w.decide({ decisionTimeMs: DT, robots: fleet() });
    } finally {
      spy.mockRestore();
    }
  });

  /** The return-leg calls: one stop, a charger's cell. */
  const returnCalls = () => out.routeCalls.filter((call) => call.stops.length === 1 && ["8b6014510498fff", "8b6014510496fff"].includes(call.stops[0].cellId));

  test("every return request names the drop stop and the charger's exact coordinates, and is answered without the offset", () => {
    const depotCalls = returnCalls().filter((call) => call.stops[0].cellId === DEPOT.cellId);
    expect(depotCalls.length).toBeGreaterThan(0);
    for (const call of depotCalls) {
      expect(call.stops[0]).toEqual({ cellId: DEPOT.cellId, lat: DEPOT.lat, lon: DEPOT.lon });
      expect(call.originPoint).toEqual(expect.objectContaining({ lat: expect.any(Number), lon: expect.any(Number) }));
      expect(call.ok).toBe(true);
      expect(call.hops[0].intraCellOffsetM).toBe(0);
      expect(call.hops[0].exact).toBe(true);
    }
  });

  test("the approach and linehaul requests are unchanged: exact, from the agent's own position, offset 0", () => {
    const approach = out.routeCalls.filter((call) => call.stops.length > 1);
    expect(approach.length).toBeGreaterThan(0);
    for (const call of approach) {
      expect(call.originPoint).not.toBeNull();
      for (const hop of call.hops) expect(hop.intraCellOffsetM).toBe(0);
    }
  });

  test("SIM-0A8C: the exact return, the unchanged 1.4375 on the unchanged DEPOT_ONLY basis, and the resulting surplus", () => {
    const mine = calls.filter((entry) => Math.abs(entry.input.usableWh - 500 * 0.29) < 1e-9);
    expect(mine).toHaveLength(1);
    const { input, result } = mine[0];
    const depot = input.candidates.find((row) => row.chargerId === DEPOT.chargerId);
    expect(result.basis).toBe("DEPOT_ONLY");
    expect(result.verdict.eReturnWh / depot.energyWh).toBeCloseTo(1.15 * 1.25, 12);
    expect(depot.distanceM).toBeLessThan(565.5545 - 400); // the 500 m correction is gone
    expect(result.verdict.surplusWh).toBeCloseTo(input.usableWh - input.missionWh - input.floorWh - result.verdict.eReturnWh, 12);

    // BEFORE (Step 2, cell pair): 565.55 m → 44.84 Wh → E_return 64.46 Wh → surplus −13.95 Wh.
    // AFTER (exact points):         65.71 m →  5.21 Wh → E_return  7.49 Wh → surplus +43.02 Wh.
    expect(depot.distanceM).toBeCloseTo(65.7059, 3);
    expect(depot.energyWh).toBeCloseTo(5.2095, 3);
    expect(result.verdict.eReturnWh).toBeCloseTo(7.4887, 3);
    expect(result.verdict.surplusWh).toBeCloseTo(43.0168, 3);
    expect(result.verdict.reachable).toBe(true);
    // Unchanged inputs: the same mission energy, the same depot-only target set.
    expect(input.missionWh).toBeCloseTo(69.4945, 3);
    expect(result.verdict.considered.map((row) => row.chargerId)).toEqual([DEPOT.chargerId]);
    // The development charger is also priced exactly now (862.03 m before), and still not a depot.
    expect(input.candidates.find((row) => row.chargerId === "DEV-SIM-RNSIT-MBA-01")).toMatchObject({ isDepot: false });
    expect(input.candidates.find((row) => row.chargerId === "DEV-SIM-RNSIT-MBA-01").distanceM).toBeCloseTo(359.5362, 3);
  });

  test("F34 for SIM-0A8C: no longer INDETERMINATE — the reserve stack composes and every tier holds (T1 p 0.0047 < 0.01)", () => {
    const evidence = out.tierBInput.candidates.find((row) => row.agentId === AGENT);
    const f34Row = evidence.predicateResults.find((row) => row.predicateId === "F34");
    expect(f34Row.outcome).toBe("SATISFIED");
    expect(f34Row.observed.bindingTier).toBe("T1");
    const t1 = f34Row.observed.tiers.find((row) => row.tier === "T1");
    expect(t1.probability).toBeCloseTo(0.0047135, 6);
    expect(t1.target).toBe(0.01);
    // Every predicate the gate ran admitted it.
    expect(evidence.rejected).toBe(false);
    expect(evidence.predicateResults.some((row) => row.outcome === "VIOLATED")).toBe(false);
    expect(out.denials[AGENT]).toBeUndefined();
  });

  test("the winner changes, by the documented ranking: SIM-0A8C is now feasible and its γ is lower", () => {
    // BEFORE: SIM-9F6F won as the only feasible candidate (γ 748 531); SIM-0A8C bound by F34.
    // AFTER: both are feasible; γ — which does not include E_return — is unchanged for SIM-9F6F,
    // and SIM-0A8C (nearer by route) prices lower, so the minimum-γ rule picks it.
    const byAgent = Object.fromEntries(out.candidates.map((row) => [row.agentId, row]));
    expect(String(byAgent["SIM-9F6F88D84EBD"].gammaMilliCU)).toBe("748531");
    expect(String(byAgent[AGENT].gammaMilliCU)).toBe("742773");
    expect(byAgent[AGENT].rejected).toBe(false);
    expect(out.outcome).toBe("ASSIGNED");
    expect(out.winner).toBe(AGENT);
  });
});

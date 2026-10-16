"use strict";
/**
 * Exact-point campus containment in simulated routing.
 *
 * Incident (LOCAL, 2026-10-13 16:19–16:28 UTC): SIM-C1E3C3312B23 stood at
 * (12.90241739, 77.51785585) — inside the RNSIT boundary — and was refused with MISSING_HOP
 * on every round, before pricing. Its FINE (H3 res-11) cell `8b601451284cfff` straddles the
 * boundary and its centre is outside it, and `simulationRouter.route` tested the cell CENTRE
 * even for a request routed between the EXACT coordinates.
 *
 * Fixed: an exact-endpoint request is checked on the points it routes
 * (`cellProjection.projectExactPoint`); a cell-only request keeps the cell-centre check.
 *
 *   1. false rejection   — inside point, outside cell centre → routed (the incident)
 *   2. false acceptance  — outside point, inside cell centre → refused
 *   3. cell consistency  — a point not in its declared cell → refused
 *   4. cell-only request — outside cell centre → still refused, unchanged
 *   5. coordinator       — the incident replayed: the nearby robot is gated, priced, and wins
 *                          on its real cost
 *   6. feasibility       — the nearby robot made ineligible by an existing gate still loses
 *
 * Coordinates are the recorded ones (Observation / Task rows, LOCAL DB, read-only), not
 * estimates. No score from the incident report is asserted as a recorded value.
 */
const fs = require("fs");
const path = require("path");

const cells = require("../../src/engine/spatial/cells");
const serviceability = require("../../src/engine/routing/campusServiceability");
const cellProjection = require("../../src/engine/routing/cellProjection");
const configService = require("../../src/engine/config/service");
const travelModel = require("../../src/engine/routing/campusTravelModel");
const { ROUTER_MODE, ROUTE_REFUSAL } = require("../../src/engine/routing/productionRouter");
const simulationPolicy = require("../../src/simulation/simulationPolicy");
const simulationRouter = require("../../src/simulation/simulationRouter");
const campusTraversalNetwork = require("../../src/simulation/campusTraversalNetwork");
const { haversineMeters } = require("../../src/utils/distance");
const w = require("./helpers/phase7World");

jest.setTimeout(120_000);

/* ── The campus, from the repository's own data (as v1CampusRouteConsistency) ── */

const REPO = path.resolve(__dirname, "..", "..", "..");
const BOUNDARY_WAY = "way/1120154292";
const EXTRACT = JSON.parse(fs.readFileSync(path.join(REPO, "rnsit-campus-osm.geojson"), "utf8"));
const DECLARATION = Object.freeze({
  regionId: "rnsit-campus",
  name: "RNSIT Campus",
  kind: "CAMPUS",
  crs: "EPSG:4326",
  version: BOUNDARY_WAY,
  versionDate: "2026-08-30",
  boundary: EXTRACT.features.find((feature) => feature.id === BOUNDARY_WAY).geometry,
});
const ORACLE = serviceability.createServiceabilityOracle(DECLARATION);
const SIDEWALK = campusTraversalNetwork.permittedClasses({ roadClasses: ["footway", "path", "service"], stairCapable: false });
const NETWORK = campusTraversalNetwork.createCampusTraversalNetwork({ features: EXTRACT.features, roadClasses: SIDEWALK, source: "rnsit-campus-osm.geojson" });
const SPEED_MPS = 1.4; // the incident robots' commissioned nominal speed (MobilityModel.speedModel)

/* ── Recorded coordinates (LOCAL DB, read-only) ─────────────────────────── */

/** SIM-C1E3C3312B23's position at every incident decision (Observation, 0.1–1.8 s old). */
const ECE_ROBOT = Object.freeze({ lat: 12.90241739, lon: 77.51785585 });
/** SIM-FB88751BAD78's position at the TSK-1791908571101-879 decision (Observation, 1.6 s old). */
const FAR_ROBOT = Object.freeze({ lat: 12.90098435, lon: 77.5187759 });
/** TSK-1791908571101-879's pickup and drop (Task row). */
const CYBER_SECURITY = Object.freeze({ lat: 12.901389, lon: 77.517667, label: "RNSIT Cyber Security Department" });
const CANARA_BANK = Object.freeze({ lat: 12.9022871, lon: 77.5185188, label: "Canara Bank" });
/** A point just OUTSIDE the boundary whose fine cell's centre is INSIDE (found by sampling the boundary). */
const OUTSIDE_POINT = Object.freeze({ lat: 12.90037095, lon: 77.51908061 });

const fine = (p) => cells.cellForPoint(p.lat, p.lon, cells.RESOLUTION.FINE);
const status = (p) => ORACLE.assess(p.lat, p.lon).status;
const centreStatus = (p) => status(cells.centreOfCell(fine(p)));

function router(projection) {
  return simulationRouter.createSimulationRouter({
    projection: projection || cellProjection.createCellProjection({ serviceability: ORACLE }),
    travelModel: travelModel.resolveModelParameters(configService.defaultSnapshot(), {}),
    agents: [{ robotId: "SIM-EXACT-POINT", simulated: true }],
    mode: ROUTER_MODE.DEVELOPMENT,
    env: { [simulationPolicy.SIMULATOR_ENV_VAR]: "true" },
    speedFor: () => SPEED_MPS,
    traversalNetworkFor: () => NETWORK,
  });
}

function exactParts(from, to, overrides) {
  return {
    originCell: fine(from),
    destCell: fine(to),
    profileKey: "SIMULATED:test",
    timeBucket: 10,
    originPoint: { lat: from.lat, lon: from.lon },
    destPoint: { lat: to.lat, lon: to.lon },
    ...(overrides || {}),
  };
}

describe("preconditions — the geometry the tests rely on is what the recorded data says", () => {
  test("the ECE robot is INSIDE the campus, in a cell whose centre is OUTSIDE", () => {
    expect(fine(ECE_ROBOT)).toBe("8b601451284cfff");
    expect(status(ECE_ROBOT)).toBe(serviceability.SERVICEABILITY.INSIDE);
    expect(centreStatus(ECE_ROBOT)).toBe(serviceability.SERVICEABILITY.OUTSIDE);
  });

  test("the outside point is OUTSIDE the campus, in a cell whose centre is INSIDE", () => {
    expect(status(OUTSIDE_POINT)).toBe(serviceability.SERVICEABILITY.OUTSIDE);
    expect(centreStatus(OUTSIDE_POINT)).toBe(serviceability.SERVICEABILITY.INSIDE);
  });

  test("the pickup, the drop and the farther robot are inside, in cells whose centres are inside", () => {
    for (const p of [CYBER_SECURITY, CANARA_BANK, FAR_ROBOT]) {
      expect(status(p)).toBe(serviceability.SERVICEABILITY.INSIDE);
      expect(centreStatus(p)).toBe(serviceability.SERVICEABILITY.INSIDE);
    }
  });
});

describe("router — containment is checked on the points routed", () => {
  test("1. false rejection: an exact point inside the campus in a boundary cell is routed over the sidewalk network", async () => {
    const routed = await router().route(exactParts(ECE_ROBOT, CYBER_SECURITY));
    const expected = NETWORK.route(ECE_ROBOT, CYBER_SECURITY);
    expect(expected.ok).toBe(true);

    // The route is the network's own, by the existing calculation, and is a route — not a straight line.
    expect(routed.distanceM).toBeCloseTo(expected.distanceM, 6);
    expect(routed.path).toEqual(expected.points);
    const straight = haversineMeters(ECE_ROBOT.lat, ECE_ROBOT.lon, CYBER_SECURITY.lat, CYBER_SECURITY.lon);
    expect(routed.distanceM).toBeGreaterThan(straight);
    expect(routed.distanceM).toBeLessThan(3 * straight);
    // The endpoints reported are the exact points, labelled as such.
    expect(routed.endpoints.origin).toMatchObject({ ...ECE_ROBOT, source: cellProjection.PROJECTION_SOURCE.EXACT_POINT });
  });

  test("2. false acceptance prevented: an exact point outside the campus is refused although its cell centre is inside", async () => {
    await expect(router().route(exactParts(OUTSIDE_POINT, CYBER_SECURITY))).rejects.toMatchObject({
      name: "RouteRefusedError",
      refusal: ROUTE_REFUSAL.OUTSIDE_SERVICEABLE_REGION,
    });
    // The same on the destination side.
    await expect(router().route(exactParts(CYBER_SECURITY, OUTSIDE_POINT))).rejects.toMatchObject({
      refusal: ROUTE_REFUSAL.OUTSIDE_SERVICEABLE_REGION,
    });
  });

  test("3. cell consistency: an exact point that does not lie in its declared cell is refused, and says why", async () => {
    const mismatched = exactParts(ECE_ROBOT, CYBER_SECURITY, { originCell: fine(FAR_ROBOT) });
    expect(mismatched.originCell).not.toBe(fine(ECE_ROBOT));
    const refused = router().route(mismatched);
    await expect(refused).rejects.toMatchObject({ name: "RouteRefusedError", refusal: ROUTE_REFUSAL.MALFORMED_REQUEST });
    await expect(router().route(mismatched)).rejects.toMatchObject({
      detail: { refusal: cellProjection.PROJECTION_REFUSAL.EXACT_POINT_NOT_IN_CELL },
    });
  });

  test("4. cell-only compatibility: a cell-only request for a cell whose centre is outside is still refused", async () => {
    const { originPoint, destPoint, ...cellOnly } = exactParts(ECE_ROBOT, CYBER_SECURITY);
    expect(originPoint && destPoint).toBeTruthy();
    await expect(router().route(cellOnly)).rejects.toMatchObject({
      name: "RouteRefusedError",
      refusal: ROUTE_REFUSAL.OUTSIDE_SERVICEABLE_REGION,
    });
    // …and a cell-only request between interior cells is still routed between cell centres.
    const { originPoint: o, destPoint: d, ...interior } = exactParts(FAR_ROBOT, CYBER_SECURITY);
    expect(o && d).toBeTruthy();
    const routed = await router().route(interior);
    expect(routed.endpoints.origin.source).toBe(cellProjection.PROJECTION_SOURCE.CELL_CENTRE);
    expect(routed.path).toBeUndefined();
  });

  test("a projection that cannot check an exact point refuses an exact request instead of checking the cell centre", async () => {
    const real = cellProjection.createCellProjection({ serviceability: ORACLE });
    const legacy = { project: real.project, projectCell: real.projectCell, describe: real.describe };
    await expect(router(legacy).route(exactParts(FAR_ROBOT, CYBER_SECURITY))).rejects.toMatchObject({
      refusal: ROUTE_REFUSAL.MALFORMED_REQUEST,
    });
  });

  test("projectExactPoint refuses malformed points and non-fine cells by name", () => {
    const projection = cellProjection.createCellProjection({ serviceability: ORACLE });
    expect(() => projection.projectExactPoint(fine(ECE_ROBOT), { lat: NaN, lon: 77.5 })).toThrow(
      expect.objectContaining({ refusal: cellProjection.PROJECTION_REFUSAL.MALFORMED_EXACT_POINT }),
    );
    // Out of WGS-84 range: refused by the one range check (`spatial/cells`), not a restated one.
    expect(() => projection.projectExactPoint(fine(ECE_ROBOT), { lat: 95, lon: 77.5 })).toThrow(
      expect.objectContaining({ refusal: cellProjection.PROJECTION_REFUSAL.MALFORMED_EXACT_POINT }),
    );
    expect(() => projection.projectExactPoint(fine(ECE_ROBOT), null)).toThrow(
      expect.objectContaining({ refusal: cellProjection.PROJECTION_REFUSAL.MALFORMED_EXACT_POINT }),
    );
    expect(() => projection.projectExactPoint(cells.coarseParentOf(fine(ECE_ROBOT)), ECE_ROBOT)).toThrow(
      expect.objectContaining({ refusal: cellProjection.PROJECTION_REFUSAL.NOT_A_CELL }),
    );
    expect(() => cellProjection.createCellProjection({}).projectExactPoint(fine(ECE_ROBOT), ECE_ROBOT)).toThrow(
      expect.objectContaining({ refusal: cellProjection.PROJECTION_REFUSAL.NO_REGION }),
    );
  });
});

/* ── 5 and 6: the incident through the real decision path ─────────────────── */

const DT = w.TSK816.assignRoundMs;
const INCIDENT_LEG = Object.freeze({ legKey: "ECE-879", pickup: CYBER_SECURITY, drop: CANARA_BANK });
const NEAR = "SIM-C1E3C3312B23";
const FAR = "SIM-FB88751BAD78";

const byAgent = (out) => Object.fromEntries(out.candidates.map((row) => [row.agentId, row]));
const binding = (out, agentId) => (byAgent(out)[agentId] || {}).bindingPredicateId || null;
const gamma = (out, agentId) => {
  const row = byAgent(out)[agentId];
  return row && row.gammaMilliCU !== null && row.gammaMilliCU !== undefined ? BigInt(row.gammaMilliCU) : null;
};
/** The approach hop the router priced from an agent's exact position. */
function approachMetres(out, at) {
  const call = out.routeCalls.find(
    (row) => row.ok && row.originPoint && row.originPoint.lat === at.lat && row.originPoint.lon === at.lon && row.hops[0],
  );
  return call ? call.hops[0].distanceM : null;
}

describe("coordinator — the incident replayed through the real assignment path", () => {
  // Equivalent inputs: both robots are clones of the same fixture robot (same class, pack, speed,
  // reserve), equally charged and equally fresh. Only their recorded positions differ.
  const fleet = (nearOverrides) => [
    w.sim(NEAR, ECE_ROBOT, { socFraction: 0.98, ...(nearOverrides || {}) }),
    w.sim(FAR, FAR_ROBOT, { socFraction: 0.98 }),
  ];

  test("5. the nearby robot is no longer MISSING_HOP: it is gated, priced, and selected on its lower real cost", async () => {
    const out = await w.decide({ decisionTimeMs: DT, robots: fleet(), leg: INCIDENT_LEG });

    expect(out.candidates.map((row) => row.agentId).sort()).toEqual([FAR, NEAR].sort());
    // A real feasibility result: no binding predicate, no denial.
    expect(binding(out, NEAR)).toBeNull();
    expect(out.denials[NEAR]).toBeUndefined();
    // Priced.
    expect(gamma(out, NEAR)).not.toBeNull();
    expect(gamma(out, FAR)).not.toBeNull();

    // The approach each was priced on is the sidewalk route from its exact position.
    const nearApproach = approachMetres(out, ECE_ROBOT);
    const farApproach = approachMetres(out, FAR_ROBOT);
    expect(nearApproach).toBeCloseTo(NETWORK.route(ECE_ROBOT, CYBER_SECURITY).distanceM, 6);
    expect(farApproach).toBeCloseTo(NETWORK.route(FAR_ROBOT, CYBER_SECURITY).distanceM, 6);

    // Selected because its feasible cost is lower — not because it is nearer.
    expect(nearApproach).toBeLessThan(farApproach);
    expect(gamma(out, NEAR) < gamma(out, FAR)).toBe(true);
    expect(out.outcome).toBe("ASSIGNED");
    expect(out.winner).toBe(NEAR);
  });

  test("6. an independent gate still rules: the nearby robot made ineligible by F34 (energy) loses to the farther eligible one", async () => {
    // An existing supported fixture input: a nearly empty pack. No gate is relaxed.
    const out = await w.decide({ decisionTimeMs: DT, robots: fleet({ socFraction: 0.04 }), leg: INCIDENT_LEG });

    const nearBinding = binding(out, NEAR);
    expect(nearBinding).not.toBeNull();
    expect(nearBinding).not.toBe("MISSING_HOP");
    expect(out.denials[NEAR]).toEqual(expect.arrayContaining([expect.objectContaining({ predicateId: nearBinding })]));
    expect(gamma(out, NEAR)).toBeNull();

    expect(binding(out, FAR)).toBeNull();
    expect(out.outcome).toBe("ASSIGNED");
    expect(out.winner).toBe(FAR);
  });

  test("6b. a nearby robot standing just OUTSIDE the campus is never priced, and the farther eligible one wins", async () => {
    const out = await w.decide({
      decisionTimeMs: DT,
      robots: [w.sim(NEAR, OUTSIDE_POINT, { socFraction: 0.98 }), w.sim(FAR, FAR_ROBOT, { socFraction: 0.98 })],
      leg: INCIDENT_LEG,
    });
    expect(gamma(out, NEAR)).toBeNull();
    expect(out.outcome).toBe("ASSIGNED");
    expect(out.winner).toBe(FAR);
  });
});

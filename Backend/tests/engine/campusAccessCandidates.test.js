"use strict";

/**
 * Access-point CANDIDATES for footprint-only campus destinations
 * (`tools/campus/accessCandidates.js`, register `<campus>-campus-access-candidates.geojson`).
 *
 * What this pins:
 *   1. the committed registers are exactly what the generator produces from the committed
 *      campus data — so a data change cannot leave a stale register behind;
 *   2. every candidate the generator did not reject is, re-checked here independently, inside
 *      the delivery domain, ON the boundary-contained SIDEWALK_GRAPH, routable by the engine's
 *      simulation router, and faces its building without crossing another one;
 *   3. the register's physical verdict is what the real `physicalRouter` does — including for a
 *      candidate in a boundary cell, which both routers check on the exact point (2026-10-21);
 *   4. the generator never emits `verified`, refuses one without a review, and keeps reviews;
 *   5. RNSIT and JSSATE stay apart;
 *   6. invalid buildings, boundary violations, missing sidewalks and blocked connectors are
 *      named, not silently turned into points.
 */

const fs = require("fs");
const path = require("path");

const accessCandidates = require("../../tools/campus/accessCandidates");
const { CAMPUSES } = require("../../tools/campus/generateAccessCandidates");
const deliveryDomain = require("../../src/engine/spatial/deliveryDomain");
const cells = require("../../src/engine/spatial/cells");
const campusServiceability = require("../../src/engine/routing/campusServiceability");
const routeContainment = require("../../src/services/fleetProviders/routeContainment");
const physicalRouter = require("../../src/services/fleetProviders/physicalRouter");
const physicalPolicy = require("../../src/services/fleetProviders/physicalPolicy");
const { RouteRefusedError, ROUTE_REFUSAL } = require("../../src/engine/routing/productionRouter");
const service = require("../../src/engine/config/service");
const demonstration = require("../../tools/config/v1DemonstrationConfig");

const { STATUS, DISCARD, REJECTION } = accessCandidates;

const REPO = path.resolve(__dirname, "..", "..", "..");
const readText = (file) => ({ file, text: fs.readFileSync(path.join(REPO, file), "utf8") });
const committed = (campus) => JSON.parse(fs.readFileSync(path.join(REPO, campus.register), "utf8"));
const RNSIT = CAMPUSES.find((c) => c.campusId === "RNSIT");
const JSSATE = CAMPUSES.find((c) => c.campusId === "jssate-bengaluru");

function instrumentsFor(campus) {
  const extract = JSON.parse(readText(campus.extract).text);
  const declaration = accessCandidates.campusDeclaration(extract, campus.declaration);
  return { extract, declaration, instruments: accessCandidates.createInstruments({ extract, declaration }) };
}

/** The targets a register records it was generated for. */
const targetsOf = (register) =>
  register.buildings.map((b) => ({
    sourceId: b.buildingSourceId,
    featureId: b.buildingFeatureId,
    name: b.name,
    operationalRole: b.operationalRole,
    related: b.related,
  }));

const polygonsOf = (geometry) => (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates);
const insideFootprint = (pair, geometry) =>
  polygonsOf(geometry).some((polygon) => campusServiceability.pointInPolygon(pair, polygon).inside);
const crosses = (a, b, geometry) =>
  polygonsOf(geometry).some((polygon) =>
    polygon.some((ring) => ring.slice(1).some((v, i) => routeContainment.segmentsMeet(a, b, ring[i], v))),
  );

describe("1 — the committed registers are what the generator produces", () => {
  for (const campus of CAMPUSES) {
    test(`${campus.campusId}: regenerated from the committed data, byte for byte`, async () => {
      const onDisk = committed(campus);
      const regenerated = await accessCandidates.generateRegister({
        campusId: campus.campusId,
        extract: readText(campus.extract),
        supplemental: campus.supplemental ? readText(campus.supplemental) : null,
        declarationSettings: campus.declaration,
        targets: targetsOf(onDisk),
        existing: onDisk,
      });
      expect(JSON.parse(JSON.stringify(regenerated))).toEqual(onDisk);
      // The sources it records are the files on disk now.
      const crypto = require("crypto");
      const digest = (file) => crypto.createHash("sha256").update(readText(file).text).digest("hex");
      expect(onDisk.generator.sources.extract.sha256).toBe(digest(campus.extract));
    });
  }
});

describe("2 — every candidate, re-checked independently of the generator", () => {
  for (const campus of CAMPUSES) {
    test(`${campus.campusId}: inside, on the sidewalk graph, routable, and facing only its own building`, async () => {
      const register = committed(campus);
      const { extract, instruments } = instrumentsFor(campus);
      const footprints = new Map(extract.features.map((f) => [f.id, f]));
      const buildings = extract.features.filter((f) => f.properties && f.properties.building && /Polygon/.test(f.geometry.type));
      expect(register.features.length).toBeGreaterThan(0);

      for (const feature of register.features) {
        const p = feature.properties;
        const [lon, lat] = feature.geometry.coordinates;
        const self = { lat, lon };
        const supplied = p.derivation && p.derivation.method === accessCandidates.DERIVATION.REVIEWER_SUPPLIED;
        expect(p.campusId).toBe(campus.campusId);
        expect(p.id.startsWith(`${campus.campusId}:`)).toBe(true);
        if (!supplied) expect(p.id.startsWith(`${campus.campusId}:${p.buildingSourceId}@`)).toBe(true);
        expect(footprints.has(p.buildingSourceId)).toBe(true);
        expect(p.buildingFeatureId).toBe(`osm-${p.buildingSourceId.replace("/", "-")}`);
        // A person's decision, when there is one, must be a valid review; otherwise the status
        // is the generator's own: needs_review exactly when something is flagged.
        if (p.review) {
          expect([p.id, accessCandidates.reviewProblems(feature)]).toEqual([p.id, []]);
        } else if (p.status !== STATUS.REJECTED) {
          expect([STATUS.CANDIDATE, STATUS.NEEDS_REVIEW]).toContain(p.status);
          expect(p.status === STATUS.NEEDS_REVIEW).toBe(p.flags.length > 0);
        }
        if (p.status === STATUS.REJECTED) {
          if (!p.review) expect(p.rejections.length).toBeGreaterThan(0);
          continue;
        }
        expect(deliveryDomain.evaluatePoint(instruments.domain, lat, lon).verdict).toBe("INSIDE");
        if (supplied) {
          // A reviewer's own entrance has no generated façade: it must be inside and reach the network.
          expect(instruments.simulation.route(self, self).ok).toBe(true);
          continue;
        }
        // ON the contained (physical) sidewalk graph, and so on the simulation one too.
        expect(instruments.physical.route(self, self).accessM.origin).toBeLessThan(0.01);
        expect(instruments.simulation.route(self, self).accessM.origin).toBeLessThan(0.01);
        // The façade connector neither enters its own footprint nor crosses another building.
        const facade = p.derivation.facade;
        const start = [facade[0] + (lon - facade[0]) * 0.001, facade[1] + (lat - facade[1]) * 0.001];
        const own = footprints.get(p.buildingSourceId).geometry;
        if (p.measurements.frontageGapM > 0) {
          expect(insideFootprint(start, own)).toBe(false);
          for (const other of buildings.filter((b) => b.id !== p.buildingSourceId)) {
            expect([other.id, crosses(start, [lon, lat], other.geometry)]).toEqual([other.id, false]);
          }
        }
        // The engine's simulation router reaches at least one reference endpoint.
        expect(p.validation.routes.simulation.reached).toBeGreaterThan(0);
      }
    });
  }

  test("RNSIT: every one of the eleven footprints has a candidate that was not rejected", () => {
    const register = committed(RNSIT);
    expect(register.buildings).toHaveLength(11);
    for (const building of register.buildings) expect([building.name, building.reliableCandidates > 0]).toEqual([building.name, true]);
  });

  test("JSSATE: the one rejection is a candidate on a part of the network the others cannot reach", () => {
    const register = committed(JSSATE);
    const rejected = register.features.filter((f) => f.properties.status === STATUS.REJECTED);
    expect(rejected.map((f) => f.properties.buildingSourceId)).toEqual(["way/1307891565"]);
    expect(rejected[0].properties.rejections).toEqual([REJECTION.UNREACHABLE_IN_SIMULATION, REJECTION.UNREACHABLE_PHYSICALLY]);
    expect(rejected[0].properties.validation.routes.simulation.refused.every((r) => r.refusal === "NOT_CONNECTED")).toBe(true);
  });
});

describe("3 — the register's physical verdict is what the real router does", () => {
  test("physicalRouter routes every candidate the register did not reject, inside the campus, boundary cells included", async () => {
    const { declaration } = instrumentsFor(RNSIT);
    const real = service.defaultSnapshot();
    const bound = Object.fromEntries([...demonstration.bindings(), ...demonstration.executionBindings()].map((r) => [r.name, r.value]));
    const snapshot = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      deliveryDomain: declaration,
      resolve: (name, c, o) => (Object.prototype.hasOwnProperty.call(bound, name) ? bound[name] : real.resolve(name, c, o)),
    });
    // TEST DOUBLE for R13: a wide bound, so the snap radius is not what this test measures.
    const policy = physicalPolicy.fromDeclaration({
      charging: { policy: "MANUAL_OUT_OF_SERVICE" },
      stateOfCharge: { policy: "OPERATOR_DECLARED", maxAgeSeconds: 7200 },
      emergencyStop: { mechanism: "SOFTWARE_STOP_LATCH" },
      site: { ambientC: { min: 18, max: 38 }, terrain: "FLAT_DECLARED", connectivityDeadZones: "NONE_DECLARED", constrictions: "NONE_DECLARED", stopStartCyclesPerHop: 1, snapRadiusM: 120 },
      localisation: { referenceRadiusM: 25, acceptedFixTypes: ["3D"] },
      risk: { failureProbabilityPrior: 0.05, routeHazardCu: 0 },
      robots: [],
    });
    const router = physicalRouter.createPhysicalRouter({ snapshot: () => snapshot, policy });
    const key = `PHYSICAL:v=1:wh=86:net=footway+path+service`;
    const parts = (from, to) => ({
      originCell: cells.cellForPoint(from.lat, from.lon, cells.RESOLUTION.FINE),
      destCell: cells.cellForPoint(to.lat, to.lon, cells.RESOLUTION.FINE),
      originPoint: from,
      destPoint: to,
      profileKey: key,
      timeBucket: 10,
    });
    const supplemental = JSON.parse(readText(RNSIT.supplemental).text);
    const foodCourt = supplemental.features.find((f) => f.properties.id === "rnsit-food-court").geometry.coordinates;
    const to = { lon: foodCourt[0], lat: foodCourt[1] };
    const point = (f) => ({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] });

    const { instruments } = instrumentsFor(RNSIT);
    const features = committed(RNSIT).features.filter((f) => f.properties.status !== STATUS.REJECTED);
    // The ECE candidate in cell 8b601451284cfff (the 2026-10-13 incident cell): its centre is off
    // campus, the point is not — the case the physical router used to refuse on the centre.
    const boundaryCell = features.filter((f) => f.properties.validation.fineCell === "8b601451284cfff");
    expect(boundaryCell.map((f) => f.properties.buildingSourceId)).toEqual(["way/204638932"]);
    expect(instruments.containment.containsPoint(cells.centreOfCell("8b601451284cfff"))).toBe(false);
    for (const f of features) {
      expect([f.properties.id, f.properties.validation.exactPointGate]).toEqual([f.properties.id, "PASS"]);
      const routed = await router.route(parts(point(f), to));
      expect(routed.path.every((p) => instruments.containment.containsPoint(p))).toBe(true);
      expect(f.properties.validation.routes.physical.refused.map((r) => r.to)).not.toContain("rnsit-food-court");
    }
    // …and a point off campus is still refused on the point itself.
    const gate = supplemental.features.find((f) => f.properties.id === "rnsit-main-gate");
    const error = await router.route(parts(point(gate), to)).catch((e) => e);
    expect(error).toBeInstanceOf(RouteRefusedError);
    expect(error.refusal).toBe(ROUTE_REFUSAL.OUTSIDE_SERVICEABLE_REGION);
  });
});

describe("4 — the generator never verifies anything, and keeps what a person did", () => {
  async function regenerate(existing) {
    const register = committed(RNSIT);
    return accessCandidates.generateRegister({
      campusId: "RNSIT",
      extract: readText(RNSIT.extract),
      supplemental: readText(RNSIT.supplemental),
      declarationSettings: RNSIT.declaration,
      targets: targetsOf(register),
      existing,
    });
  }

  // What the generator alone produces — no review carried in. The scenarios below start from it,
  // so a review an owner has genuinely recorded in the committed register cannot leak into them.
  let BASE;
  beforeAll(async () => {
    BASE = await regenerate(null);
  });

  test("the generator alone never emits `verified`; every verified or reviewed entry on disk carries a valid review", () => {
    expect(BASE.features.filter((f) => f.properties.status === STATUS.VERIFIED)).toEqual([]);
    expect(BASE.features.filter((f) => f.properties.review !== null)).toEqual([]);
    for (const campus of CAMPUSES) {
      for (const f of committed(campus).features) {
        if (f.properties.status === STATUS.VERIFIED || f.properties.review) {
          expect([f.properties.id, accessCandidates.reviewProblems(f)]).toEqual([f.properties.id, []]);
        }
      }
    }
  });

  test("a `verified` entry without a review stops regeneration", async () => {
    const register = BASE;
    const forged = JSON.parse(JSON.stringify(register));
    forged.features[0].properties.status = STATUS.VERIFIED;
    await expect(regenerate(forged)).rejects.toThrow(/review/);
    const badDate = JSON.parse(JSON.stringify(register));
    Object.assign(badDate.features[0].properties, { status: STATUS.VERIFIED, review: { by: "Owner", on: "yesterday", method: "OWNER_SITE_CHECK" } });
    await expect(regenerate(badDate)).rejects.toThrow(/YYYY-MM-DD/);
  });

  test("a reviewed entry keeps its status and review; one the data no longer produces is kept and marked stale", async () => {
    const register = BASE;
    const reviewed = JSON.parse(JSON.stringify(register));
    const review = { by: "Project owner", on: "2026-10-22", method: "OWNER_SITE_CHECK" };
    Object.assign(reviewed.features[0].properties, { status: STATUS.VERIFIED, review });
    const gone = JSON.parse(JSON.stringify(reviewed.features[1]));
    gone.properties.id = "RNSIT:way/204638927@0.0000000,0.0000000";
    gone.properties.review = { ...review };
    gone.properties.status = STATUS.REJECTED;
    const supplied = JSON.parse(JSON.stringify(reviewed.features[2]));
    Object.assign(supplied.properties, { id: "RNSIT:reviewer-supplied-1", status: STATUS.VERIFIED, review, derivation: { method: "REVIEWER_SUPPLIED" } });
    reviewed.features.push(gone, supplied);

    const out = await regenerate(reviewed);
    const byId = new Map(out.features.map((f) => [f.properties.id, f.properties]));
    expect(byId.get(register.features[0].properties.id)).toMatchObject({ status: STATUS.VERIFIED, review });
    expect(byId.get(gone.properties.id)).toMatchObject({ status: STATUS.REJECTED, stale: true });
    expect(byId.get("RNSIT:reviewer-supplied-1").stale).toBeUndefined();
    // Every other entry is still generated, and still unverified.
    expect(out.features.filter((f) => f.properties.status === STATUS.VERIFIED)).toHaveLength(2);
  });
});

describe("5 — RNSIT and JSSATE stay apart", () => {
  test("no candidate of one campus is inside the other's delivery domain", () => {
    const rnsit = instrumentsFor(RNSIT).instruments;
    const jssate = instrumentsFor(JSSATE).instruments;
    for (const [campus, other] of [[RNSIT, jssate], [JSSATE, rnsit]]) {
      for (const f of committed(campus).features) {
        const [lon, lat] = f.geometry.coordinates;
        expect(deliveryDomain.evaluatePoint(other.domain, lat, lon).verdict).toBe("OUTSIDE");
      }
    }
    const rnsitBuildings = new Set(committed(RNSIT).buildings.map((b) => b.buildingSourceId));
    for (const b of committed(JSSATE).buildings) expect(rnsitBuildings.has(b.buildingSourceId)).toBe(false);
  });
});

describe("6 — what is NOT turned into a candidate, by name", () => {
  // A synthetic site in 0.001° units (~110 m), counter-clockwise exterior (RFC 7946).
  const LON0 = 77.5;
  const LAT0 = 12.9;
  const at = (x, y) => [LON0 + x * 0.001, LAT0 + y * 0.001];
  const rect = (x0, y0, x1, y1) => [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]];
  const building = (id, coordinates) => ({ type: "Feature", id, properties: { building: "yes", name: id }, geometry: { type: "Polygon", coordinates } });
  const footway = { type: "Feature", id: "way/10", properties: { highway: "footway" }, geometry: { type: "LineString", coordinates: [at(0.5, 2), at(3.5, 2)] } };
  const boundary = { type: "Feature", id: "way/1", properties: { amenity: "college" }, geometry: { type: "Polygon", coordinates: rect(0, 0, 4, 4) } };
  const FEATURES = [
    boundary,
    building("way/20", rect(1.0, 2.05, 1.4, 2.3)), // a building beside the footway
    building("way/21", rect(2.5, 2.05, 2.9, 2.3)), // another, for a reference endpoint
    building("way/22", rect(1.55, 1.88, 2.05, 1.95)), // stands between way/23 and the footway
    building("way/23", rect(1.6, 1.7, 2.0, 1.85)), // every connector crosses way/22 or itself
    building("way/24", rect(5.0, 2.05, 5.3, 2.3)), // outside the boundary
  ];
  const target = (sourceId) => ({ sourceId, featureId: `osm-${sourceId.replace("/", "-")}`, name: sourceId, operationalRole: "DEPARTMENT" });
  const generate = (features, targets) =>
    accessCandidates.generateRegister({
      campusId: "SYNTHETIC",
      extract: { file: "synthetic-campus-osm.geojson", text: JSON.stringify({ type: "FeatureCollection", features }) },
      supplemental: null,
      declarationSettings: { regionId: "synthetic-site", name: "Synthetic", boundaryWay: "way/1", versionDate: "2026-10-21" },
      targets,
    });
  const buildingRow = (register, id) => register.buildings.find((b) => b.buildingSourceId === id);

  test("a building beside the sidewalk gets candidates on it, routed to the other building's", async () => {
    const register = await generate([...FEATURES, footway], [target("way/20"), target("way/21")]);
    for (const id of ["way/20", "way/21"]) expect(buildingRow(register, id).reliableCandidates).toBeGreaterThan(0);
    for (const f of register.features) {
      expect(f.geometry.coordinates[1]).toBeCloseTo(LAT0 + 0.002, 9); // on the footway
      expect(f.properties.validation.routes.simulation.reached).toBe(1);
      expect(f.properties.status).not.toBe(STATUS.VERIFIED);
    }
  });

  test("a building whose every connector crosses another building gets none", async () => {
    const register = await generate([...FEATURES, footway], [target("way/23"), target("way/20")]);
    const row = buildingRow(register, "way/23");
    expect(row.candidates).toEqual([]);
    expect(row.reliableCandidates).toBe(0);
    expect(row.discardedSamples[DISCARD.CONNECTOR_CROSSES_BUILDING]).toBeGreaterThan(0);
    expect(row.discardedSamples[DISCARD.CONNECTOR_THROUGH_OWN_FOOTPRINT]).toBeGreaterThan(0);
  });

  test("a building outside the boundary gets none; an unknown building is reported, not invented", async () => {
    const register = await generate([...FEATURES, footway], [target("way/24"), target("way/99")]);
    expect(buildingRow(register, "way/24").candidates).toEqual([]);
    expect(buildingRow(register, "way/24").discardedSamples).toEqual({ [DISCARD.FACADE_OUTSIDE_BOUNDARY]: 8 });
    expect(buildingRow(register, "way/99").problem).toMatch(/no footprint/);
    expect(register.features).toEqual([]);
  });

  test("a footway on the boundary edge is not a frontage: the candidate is on the contained network", async () => {
    // way/11 runs along the boundary itself, 16 m from way/25 — the physical router excludes it.
    const edgeWay = { type: "Feature", id: "way/11", properties: { highway: "footway" }, geometry: { type: "LineString", coordinates: [at(0.5, 0), at(3.5, 0)] } };
    const register = await generate(
      [...FEATURES, footway, edgeWay, building("way/25", rect(1.0, 0.15, 1.4, 0.4))],
      [target("way/25"), target("way/21")],
    );
    const mine = register.features.filter((f) => f.properties.buildingSourceId === "way/25");
    expect(mine.length).toBeGreaterThan(0);
    for (const f of mine) {
      expect(f.geometry.coordinates[1]).toBeCloseTo(LAT0 + 0.002, 9); // the contained footway, not the edge
      expect(f.properties.status).not.toBe(STATUS.REJECTED);
      expect(f.properties.measurements.physicalAccessM).toBe(0);
    }
  });

  test("with no permitted way on the site, nothing is projected anywhere", async () => {
    const register = await generate(FEATURES, [target("way/20")]);
    expect(register.features).toEqual([]);
    expect(buildingRow(register, "way/20").discardedSamples).toEqual({ [DISCARD.NO_CONTAINED_ACCESS]: 8 });
  });
});

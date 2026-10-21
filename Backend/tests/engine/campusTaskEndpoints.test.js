"use strict";

/**
 * The Create Task form's RNSIT locations, as the backend sees them — the reconciliation audit
 * of 2026-10-21.
 *
 * The dashboard offers every declared Point inside the adopted boundary
 * (`Frontend/src/features/tasks/campusLocations.js`, pinned by
 * `Frontend/src/__architecture__/campusTaskLocations.test.mjs`). The backend has no location
 * catalogue: intake geofences the exact coordinate (`deliveryDomain.evaluatePoint`) and the
 * engine routes it over the campus SIDEWALK_GRAPH afterwards. This pins that the two agree —
 * every offered location is INSIDE and routable to every other, on both the simulation network
 * and the boundary-contained physical one, and every point the form refuses is OUTSIDE — so an
 * offered location is never one the engine cannot serve for a reason the form could have known.
 *
 * Every coordinate is read from the repository's own campus files, never typed in.
 */

const fs = require("fs");
const path = require("path");

const campusTraversalNetwork = require("../../src/simulation/campusTraversalNetwork");
const deliveryDomain = require("../../src/engine/spatial/deliveryDomain");
const routeContainment = require("../../src/services/fleetProviders/routeContainment");
const robotSpecification = require("../../src/services/robotSpecification");

const REPO = path.resolve(__dirname, "..", "..", "..");
const BOUNDARY_WAY = "way/1120154292";
const EXTRACT = JSON.parse(fs.readFileSync(path.join(REPO, "rnsit-campus-osm.geojson"), "utf8"));
const SUPPLEMENTAL = JSON.parse(fs.readFileSync(path.join(REPO, "rnsit-campus-supplemental.geojson"), "utf8"));
const DECLARATION = Object.freeze({
  regionId: "rnsit-campus",
  name: "RNSIT Campus",
  kind: "CAMPUS",
  crs: "EPSG:4326",
  version: BOUNDARY_WAY,
  versionDate: "2026-08-30",
  boundary: EXTRACT.features.find((feature) => feature.id === BOUNDARY_WAY).geometry,
});
const DOMAIN = deliveryDomain.validateDomainDeclaration(DECLARATION);

/** Every declared Point on the campus, from both files, by the id the dashboard uses. */
const POINTS = Object.fromEntries([
  ...EXTRACT.features
    .filter((feature) => feature.geometry.type === "Point")
    .map((feature) => [`osm-${feature.id.replace("/", "-")}`, feature.geometry.coordinates]),
  ...SUPPLEMENTAL.features.map((feature) => [feature.properties.id, feature.geometry.coordinates]),
].map(([id, [lon, lat]]) => [id, { lat, lon }]));

/** What the dashboard offers (pinned in campusTaskLocations.test.mjs). */
const OFFERED = [
  "osm-node-2146315474",
  "rns-evening-college",
  "rns-first-grade-college",
  "rnsit-cyber-security-department",
  "rnsit-food-court",
  "rnsit-innovation-center",
  "rnsit-playground-2",
  "rnsit-pre-university-college",
];
/** Inside, but not offered: import duplicates of an offered or boundary record. */
const INSIDE_DUPLICATES = ["osm-node-1644443078", "rnsit-canara-bank"];
/** Refused by the form as outside the adopted boundary (RD-2026-08-30-01). */
const OUTSIDE = ["rnsit-main-gate", "rnsit-parking-lot", "rnsit-playground-1"];

const ROVER = robotSpecification.CHASSIS_TEMPLATE[robotSpecification.CHASSIS_TYPE.ROVER];
const CLASSES = campusTraversalNetwork.permittedClasses(ROVER.permissionSet);
const SIMULATION = campusTraversalNetwork.createCampusTraversalNetwork({
  features: EXTRACT.features,
  roadClasses: CLASSES,
  source: "rnsit-campus-osm.geojson",
});
const PHYSICAL = campusTraversalNetwork.createCampusTraversalNetwork({
  features: EXTRACT.features,
  roadClasses: CLASSES,
  source: "rnsit-campus-osm.geojson",
  containment: routeContainment.createRouteContainment(DECLARATION),
});

describe("the dashboard's RNSIT task locations are the backend's serviceable endpoints", () => {
  test("every declared point is accounted for, and only the offered ones and their duplicates are inside", () => {
    expect(Object.keys(POINTS).sort()).toEqual([...OFFERED, ...INSIDE_DUPLICATES, ...OUTSIDE].sort());
    for (const id of [...OFFERED, ...INSIDE_DUPLICATES]) {
      expect([id, deliveryDomain.evaluatePoint(DOMAIN, POINTS[id].lat, POINTS[id].lon).verdict]).toEqual([id, "INSIDE"]);
    }
    for (const id of OUTSIDE) {
      expect([id, deliveryDomain.evaluatePoint(DOMAIN, POINTS[id].lat, POINTS[id].lon).verdict]).toEqual([id, "OUTSIDE"]);
    }
  });

  test("the traversal domain is the ROVER's SIDEWALK_GRAPH, one connected piece — not the road graph", () => {
    expect(ROVER.traversalDomain).toBe("SIDEWALK_GRAPH");
    expect(CLASSES).toEqual(["footway", "path", "service"]);
    expect(SIMULATION.componentCount).toBe(1);
    expect(PHYSICAL.componentCount).toBe(1);
  });

  test("every ordered pair of offered locations routes, on the simulation and the contained physical network", () => {
    const refused = [];
    for (const from of OFFERED) {
      for (const to of OFFERED) {
        if (from === to) continue;
        for (const [name, network] of [["simulation", SIMULATION], ["physical", PHYSICAL]]) {
          const routed = network.route(POINTS[from], POINTS[to]);
          if (!routed.ok) refused.push(`${name} ${from} → ${to}: ${routed.refusal}`);
        }
      }
    }
    expect(refused).toEqual([]);
  });

  test("Playground 2 is offered and routable, but its access connector exceeds 50 m — a physical snap radius below it refuses by name", () => {
    // The one offered location a declared physical `site.snapRadiusM` (R13) could refuse. The form
    // offers it, because the engine owns feasibility; the engine then refuses it explicitly.
    const target = POINTS["rnsit-food-court"];
    const access = (network) => network.route(POINTS["rnsit-playground-2"], target).accessM.origin;
    expect(access(SIMULATION)).toBeGreaterThan(45);
    expect(access(PHYSICAL)).toBeGreaterThan(50);
    for (const id of OFFERED.filter((id) => id !== "rnsit-playground-2")) {
      const other = id === "rnsit-food-court" ? POINTS["rnsit-innovation-center"] : target;
      expect([id, PHYSICAL.route(POINTS[id], other).accessM.origin < 15]).toEqual([id, true]);
    }
    const bounded = PHYSICAL.route(POINTS["rnsit-playground-2"], target, { maxAccessM: 50 });
    expect(bounded.ok).toBe(false);
    expect(bounded.refusal).toBe(campusTraversalNetwork.NETWORK_REFUSAL.ACCESS_TOO_LONG);
  });
});

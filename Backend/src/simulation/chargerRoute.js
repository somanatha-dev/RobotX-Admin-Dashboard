"use strict";

/**
 * P7-D3 Step 1 — the route a simulated robot drives to its reserved charger, and the test for
 * having arrived there. DEVELOPMENT_SIMULATION, and nothing else.
 *
 * ── Why it exists ───────────────────────────────────────────────────────────
 * `VirtualRobot._enterCharging` used to dock where the robot stood: measured on LOCAL, a robot
 * charged 10 → 79 % at speed 0, 159 m from the charger whose plug it held, while the engine
 * priced a return-to-charger leg into every F34 decision that the simulated robot never drove.
 * A robot now reserves the depot (P7-D3 Step 0), asks this module for the route, drives it,
 * and may charge only inside `DOCKING_RADIUS_M` of the charger.
 *
 * ── The route is the engine's route ─────────────────────────────────────────
 * `campusTraversalNetwork.route(from, to)` over the network built from the pinned
 * delivery-domain declaration's campus extract (`extractForDeclaration`) and the robot class's
 * permitted ways (`permittedClasses(MobilityModel.permissionSet)`) — exactly what the V1
 * composition's `simulationRouter` uses to price the return leg between exact points (P7-C1
 * Step 3). So the distance the robot drives to the charger is, by construction, the distance
 * the engine priced from the same point. Coordinates are WGS-84 latitude/longitude on both
 * sides: the robot's own position and the depot row's own `latitude`/`longitude`.
 *
 * ── What it never does ──────────────────────────────────────────────────────
 * It never invents a straight line, a coordinate or a charger. No declaration, no extract on
 * file, a class with no permitted ways, an unusable charger row or a malformed position is a
 * refusal **by name**, and a refused route is a robot that does not charge (`VirtualRobot`
 * releases the plug and asks again later). The charger row is validated by the same
 * `devChargingScheduler.depotProblems` the scheduler provisions with, so the robot is never
 * routed to a row the scheduler would not grant a plug at.
 *
 * Pure apart from reading the campus extract (once per declaration, through
 * `campusTraversalNetwork.extractForDeclaration`): no clock, no randomness, no database.
 */

const campusTraversalNetwork = require("./campusTraversalNetwork");
const devChargingScheduler = require("./devChargingScheduler");
// RD-2026-10-12-02 — the ONE simulator use of the routing-local containment guard: simulated charger
// routes stay inside the operating boundary. `routeContainment` exposes booleans about route
// geometry only (no verdict, no oracle); see that RD and `routingSpatialAuthorityBoundary.test.js`.
const routeContainment = require("../services/fleetProviders/routeContainment");
const { haversineMeters } = require("../utils/distance");

/**
 * How close to the reserved charger's declared coordinate counts as docked.
 *
 * The simulator's own arrival tolerance (`VirtualRobot`'s `ARRIVAL_EPSILON_M`, 0.01 m): a campus
 * route ends exactly at its destination's coordinate (`campusTraversalNetwork.route` appends the
 * exact point), and the stepper arrives at a path's final point within this tolerance and then
 * stands on it. Docked therefore means *at* the charger's declared coordinate — anything looser
 * would be a radius nobody declared. A physical docking tolerance (contact, current sensing) is
 * hardware's to state, and this constant says nothing about it.
 * @structural a numerical tolerance, the simulator's own
 */
const DOCKING_RADIUS_M = 0.01;

/** Why no route to the charger could be produced. @structural */
const ROUTE_REFUSAL = Object.freeze({
  CHARGER_UNUSABLE: "CHARGER_UNUSABLE",
  NO_DELIVERY_DOMAIN: "NO_DELIVERY_DOMAIN",
  NO_CAMPUS_EXTRACT: "NO_CAMPUS_EXTRACT",
  NO_PERMITTED_WAYS: "NO_PERMITTED_WAYS",
  MALFORMED_POSITION: "MALFORMED_POSITION",
  NOT_ROUTABLE: "NOT_ROUTABLE",
  /** RD-2026-10-12-02 — the declaration's operating boundary cannot contain a route. */
  NO_OPERATING_BOUNDARY: "NO_OPERATING_BOUNDARY",
  /** RD-2026-10-12-02 — the robot or the charger is not strictly inside the operating boundary. */
  OUTSIDE_OPERATING_BOUNDARY: "OUTSIDE_OPERATING_BOUNDARY",
  /** RD-2026-10-12-02 — no access connector or path between them stays inside the boundary. */
  ROUTE_LEAVES_BOUNDARY: "ROUTE_LEAVES_BOUNDARY",
});

/** The network's containment refusals, as this module names them. @structural */
const CONTAINMENT_REFUSALS = Object.freeze({
  ENDPOINT_OUTSIDE_BOUNDARY: ROUTE_REFUSAL.OUTSIDE_OPERATING_BOUNDARY,
  ACCESS_LEAVES_BOUNDARY: ROUTE_REFUSAL.ROUTE_LEAVES_BOUNDARY,
  ROUTE_LEAVES_BOUNDARY: ROUTE_REFUSAL.ROUTE_LEAVES_BOUNDARY,
});

/** One cache per extract reader, so an injected reader is never answered from another's networks. */
const containedNetworks = new WeakMap();
/**
 * RD-2026-10-12-02 — the CONTAINED campus network of a declaration for a road-class set: built from
 * the declaration's own extract with `routeContainment`'s guard, so no edge, access connector or
 * path leaves the operating boundary. One per declaration and class set. Shared with station
 * validation (`chargingStations`), which must not build its own guard.
 *
 * @param {object} declaration the pinned delivery-domain declaration
 * @param {string[]} roadClasses
 * @param {(declaration: object) => object} [extractFor]
 * @returns {{ ok: true, network: object } | { ok: false, refusal: string, problems: string[] }}
 */
function containedNetworkFor(declaration, roadClasses, extractFor = campusTraversalNetwork.extractForDeclaration) {
  const key = `${String(declaration.version)}|${String(declaration.versionDate ?? "")}|${roadClasses.join("+")}`;
  if (!containedNetworks.has(extractFor)) containedNetworks.set(extractFor, new Map());
  const networks = containedNetworks.get(extractFor);
  const cached = networks.get(key);
  if (cached) return cached;
  const extract = extractFor(declaration);
  // A failed read is not cached: the next request reads again, as `lazyRouter` does.
  if (!extract || !extract.ok) return { ok: false, refusal: "NO_CAMPUS_EXTRACT", problems: (extract && extract.problems) || ["no extract"] };
  const containment = routeContainment.createRouteContainment(declaration);
  const built = containment.usable
    ? {
      ok: true,
      network: campusTraversalNetwork.createCampusTraversalNetwork({ features: extract.features, roadClasses, source: extract.file, containment }),
    }
    : { ok: false, refusal: ROUTE_REFUSAL.NO_OPERATING_BOUNDARY, problems: containment.problems };
  networks.set(key, built);
  return built;
}

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * A WGS-84 point, or `null`: finite numbers, in range.
 *
 * @param {*} value
 * @returns {{ lat: number, lon: number }|null}
 */
function pointOf(value) {
  if (!value || !isNumber(value.lat) || !isNumber(value.lon)) return null;
  // @structural the WGS-84 latitude and longitude ranges
  if (value.lat < -90 || value.lat > 90 || value.lon < -180 || value.lon > 180) return null;
  return { lat: value.lat, lon: value.lon };
}

/**
 * Is `position` within the docking radius of `charger`? `false` whenever either is not a point:
 * an unverifiable position is not a docked one.
 *
 * @param {{ lat: number, lon: number }} position
 * @param {{ lat: number, lon: number }} charger
 * @returns {boolean}
 */
function withinDockingRadius(position, charger) {
  const at = pointOf(position);
  const target = pointOf(charger);
  if (!at || !target) return false;
  return haversineMeters(at.lat, at.lon, target.lat, target.lon) <= DOCKING_RADIUS_M;
}

const refused = (refusal, reason) => Object.freeze({ ok: false, refusal, reason });

/**
 * Build the route provider.
 *
 * @param {object} settings
 * @param {() => object|null} settings.deliveryDomainFor the pinned delivery-domain declaration,
 *   read on every request (the configuration in force), as the V1 composition reads it
 * @param {(declaration: object) => object} [settings.extractFor] injected for tests;
 *   `campusTraversalNetwork.extractForDeclaration` otherwise
 * @returns {{ routeToCharger: (input: object) => object }}
 */
function createChargerRouter(settings) {
  const source = settings || {};
  const extractFor = typeof source.extractFor === "function" ? source.extractFor : campusTraversalNetwork.extractForDeclaration;

  /**
   * The campus route from `from` to the charger row's own coordinate.
   *
   * @param {object} input
   * @param {object|null} input.chargerRow the `Charger` row (the depot)
   * @param {{ lat: number, lon: number }} input.from the robot's position
   * @param {object|null} input.permissionSet the class's `MobilityModel.permissionSet`
   * @returns {{ ok: true, points: object[], distanceM: number, accessM: object,
   *             charger: { chargerId: string, lat: number, lon: number } }
   *          | { ok: false, refusal: string, reason: string }}
   */
  function routeToCharger(input) {
    const request = input || {};
    const row = request.chargerRow || null;

    // Phase B — the depot's own test for the depot, a station's for any other charger of the estate.
    const unusable = row ? devChargingScheduler.chargerProblems(row, row.chargerId) : devChargingScheduler.depotProblems(row);
    if (unusable.length > 0) return refused(ROUTE_REFUSAL.CHARGER_UNUSABLE, unusable.join("; "));
    const charger = pointOf({ lat: row.latitude, lon: row.longitude });
    if (!charger) return refused(ROUTE_REFUSAL.CHARGER_UNUSABLE, `charger "${row.chargerId}" states no usable WGS-84 coordinate`);

    const from = pointOf(request.from);
    if (!from) return refused(ROUTE_REFUSAL.MALFORMED_POSITION, "the robot's position is not a WGS-84 { lat, lon } pair");

    let declaration = null;
    try {
      declaration = typeof source.deliveryDomainFor === "function" ? source.deliveryDomainFor() : null;
    } catch {
      declaration = null;
    }
    if (!declaration) {
      return refused(
        ROUTE_REFUSAL.NO_DELIVERY_DOMAIN,
        "the pinned configuration carries no delivery-domain declaration, so no campus network can be built to route on",
      );
    }

    const roadClasses = campusTraversalNetwork.permittedClasses(request.permissionSet);
    if (roadClasses.length === 0) {
      return refused(ROUTE_REFUSAL.NO_PERMITTED_WAYS, "the robot's class declares no permitted ground ways (MobilityModel.permissionSet)");
    }

    const built = containedNetworkFor(declaration, roadClasses, extractFor);
    if (!built.ok) {
      const refusal = built.refusal === ROUTE_REFUSAL.NO_OPERATING_BOUNDARY ? ROUTE_REFUSAL.NO_OPERATING_BOUNDARY : ROUTE_REFUSAL.NO_CAMPUS_EXTRACT;
      return refused(refusal, `the contained campus traversal network cannot be built: ${built.problems.join("; ")}`);
    }

    // RD-2026-10-12-02 — CONTAINED. The robot, the charger, both access connectors and the whole path
    // must lie strictly inside the pinned operating boundary. A robot off this campus (another
    // campus such as JSSATE, a bad fix) is refused by name; it is never joined to the network by
    // a straight line across the ground the boundary excludes (3,250 m measured before).
    const routed = built.network.route(from, charger);
    if (!routed.ok) {
      return refused(CONTAINMENT_REFUSALS[routed.refusal] || ROUTE_REFUSAL.NOT_ROUTABLE, `${routed.refusal}: ${routed.reason}`);
    }

    return Object.freeze({
      ok: true,
      points: routed.points,
      distanceM: routed.distanceM,
      accessM: routed.accessM,
      charger: Object.freeze({ chargerId: row.chargerId, lat: charger.lat, lon: charger.lon }),
    });
  }

  return Object.freeze({ routeToCharger });
}

module.exports = { DOCKING_RADIUS_M, ROUTE_REFUSAL, pointOf, withinDockingRadius, createChargerRouter, containedNetworkFor };

"use strict";

/**
 * Phase B (charging lifecycle) — the simulated fleet's charging STATIONS: which chargers exist
 * for the Charging Scheduler, where they are, how many plugs each has, and whether each one is
 * usable. DEVELOPMENT_SIMULATION.
 *
 * ── The estate ──────────────────────────────────────────────────────────────
 *   · The V1 demonstration depot (`devChargingScheduler.DEVELOPMENT_CHARGER`) — the charger the
 *     simulator has used since P7-D3, read from its seeded row. Included unless the owner's
 *     declaration says `"includeDepot": false`.
 *   · Owner-declared stations, from the file named by `SIMULATED_CHARGING_STATIONS_FILE`
 *     (`docs/runbooks/simulated-charging-stations.example.json`). The two intended RNSIT stations —
 *     near the PU College building and near Canara Bank — are declared there with NO coordinate
 *     and `approved: false`. A station is USABLE only when the owner has approved it AND its
 *     coordinate passes `validateStation`. Nothing here invents, snaps or defaults a coordinate.
 *
 * ── What a station coordinate must be ───────────────────────────────────────
 *   · WGS-84 decimal degrees, `lat` and `lon` as JSON numbers (not strings), latitude first;
 *   · reachable from the depot over the CONTAINED campus sidewalk network of the pinned
 *     declaration (`chargerRoute.containedNetworkFor`, RD-2026-10-12-02): the station must be
 *     strictly inside the operating boundary, and so must its access connector and the whole
 *     route. The access connector's length is reported. `tools/charging/validateStationCoordinates.js`
 *     runs the same checks for the owner before approval.
 *
 * Charger capacity is per station (`plugCount`). The depot keeps the 3 plugs the owner chose for
 * development (P7-D3); a new station defaults to ONE plug — the conservative reading of a single
 * physical charging point — unless the declaration states otherwise.
 *
 * Pure apart from reading the declaration file and the campus extract.
 */

const fs = require("fs");

const chargerRoute = require("./chargerRoute");
const cells = require("../engine/spatial/cells");

/** The environment variable naming the owner's station declaration. @structural */
const FILE_VAR = "SIMULATED_CHARGING_STATIONS_FILE";

/** Plugs at a newly declared station when the declaration states none. @structural V1 default */
const DEFAULT_STATION_PLUGS = 1;
/** The largest plug count a declaration may state. @structural a sanity bound */
const MAX_STATION_PLUGS = 16;
/** The road classes a station's reachability is checked with: the rover template's. @structural */
const ROVER_ROAD_CLASSES = Object.freeze(["footway", "path", "service"]);

/** Why a station is not usable. @structural */
const STATION_PROBLEM = Object.freeze({
  NOT_APPROVED: "NOT_APPROVED",
  NO_COORDINATE: "NO_COORDINATE",
  MALFORMED_COORDINATE: "MALFORMED_COORDINATE",
  NO_DELIVERY_DOMAIN: "NO_DELIVERY_DOMAIN",
  NOT_REACHABLE: "NOT_REACHABLE",
  /** RD-2026-10-12-02 — the coordinate is not strictly inside the operating boundary. */
  OUTSIDE_OPERATING_BOUNDARY: "OUTSIDE_OPERATING_BOUNDARY",
  /** RD-2026-10-12-02 — no contained route reaches it (it would leave the boundary). */
  ROUTE_LEAVES_BOUNDARY: "ROUTE_LEAVES_BOUNDARY",
});

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isString = (value) => typeof value === "string" && value.trim() !== "";

/**
 * The two intended RNSIT stations, at the coordinates the owner supplied on 2026-10-13 (WGS-84),
 * and NOT approved: approval is the owner's `approved: true` in the declaration file, after
 * `tools/charging/validateStationCoordinates.js`. Used when no declaration file is configured, so
 * the dashboard and status say exactly what is missing (the approval). Unapproved, neither is ever
 * in the estate, given a Charger row, or published.
 * @structural the owner's intended stations: names 2026-10-12, coordinates 2026-10-13
 */
const INTENDED_RNSIT_STATIONS = Object.freeze([
  Object.freeze({ chargerId: "RNSIT-CHG-PU-COLLEGE", name: "Near RNSIT PU College building", regionId: "rnsit", approved: false, lat: 12.900742024769887, lon: 77.51884060360668, plugCount: DEFAULT_STATION_PLUGS }),
  Object.freeze({ chargerId: "RNSIT-CHG-CANARA-BANK", name: "Near RNSIT Canara Bank", regionId: "rnsit", approved: false, lat: 12.902396962367357, lon: 77.51862316497345, plugCount: DEFAULT_STATION_PLUGS }),
]);

/**
 * Normalise an owner declaration (the parsed JSON). Never throws.
 *
 * @param {object|null} raw
 * @returns {{ includeDepot: boolean, stations: object[], problems: string[], source: string }}
 */
function normaliseDeclaration(raw, source = "declaration") {
  const problems = [];
  if (raw === null || raw === undefined) {
    return { includeDepot: true, stations: INTENDED_RNSIT_STATIONS.map((s) => ({ ...s })), problems, source: "built-in (no declaration file)" };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { includeDepot: true, stations: [], problems: ["the station declaration must be a JSON object"], source };
  }
  const includeDepot = raw.includeDepot !== false;
  const list = Array.isArray(raw.stations) ? raw.stations : [];
  if (!Array.isArray(raw.stations)) problems.push("stations must be a list");
  const seen = new Set();
  const stations = [];
  for (const [index, entry] of list.entries()) {
    const e = entry || {};
    if (!isString(e.chargerId)) {
      problems.push(`stations[${index}].chargerId is required`);
      continue;
    }
    if (seen.has(e.chargerId)) {
      problems.push(`stations[${index}].chargerId "${e.chargerId}" is declared twice`);
      continue;
    }
    seen.add(e.chargerId);
    const plugCount = e.plugCount === undefined || e.plugCount === null ? DEFAULT_STATION_PLUGS : e.plugCount;
    const plugsOk = Number.isInteger(plugCount) && plugCount >= 1 && plugCount <= MAX_STATION_PLUGS;
    if (!plugsOk) problems.push(`stations[${index}].plugCount must be an integer in [1, ${MAX_STATION_PLUGS}]`);
    stations.push({
      chargerId: e.chargerId.trim(),
      name: isString(e.name) ? e.name.trim() : e.chargerId.trim(),
      regionId: isString(e.regionId) ? e.regionId.trim() : null,
      approved: e.approved === true,
      lat: e.lat === undefined ? null : e.lat,
      lon: e.lon === undefined ? null : e.lon,
      plugCount: plugsOk ? plugCount : DEFAULT_STATION_PLUGS,
    });
  }
  return { includeDepot, stations, problems, source };
}

/**
 * Read the owner's declaration file, if one is configured.
 *
 * @param {object} [env]
 * @returns {{ includeDepot: boolean, stations: object[], problems: string[], source: string }}
 */
function loadDeclaration(env) {
  const file = (env || process.env)[FILE_VAR];
  if (!isString(file)) return normaliseDeclaration(null);
  try {
    return normaliseDeclaration(JSON.parse(fs.readFileSync(file, "utf8")), file);
  } catch (error) {
    return { includeDepot: true, stations: INTENDED_RNSIT_STATIONS.map((s) => ({ ...s })), problems: [`${FILE_VAR} (${file}) could not be read: ${error && error.message}`], source: file };
  }
}

/**
 * Validate one station's coordinate: its format, and its reachability from the depot over the
 * campus sidewalk network of the pinned declaration.
 *
 * @param {object} input
 * @param {object} input.station a normalised station
 * @param {object|null} input.declaration the pinned delivery-domain declaration (raw)
 * @param {object} [input.network] a network to route on (built from the extract otherwise)
 * @param {{ lat: number, lon: number }|null} [input.reference] the point it must be reachable from (the depot)
 * @returns {{ usable: boolean, problems: { code: string, detail: string }[], accessM: number|null, routeM: number|null, cellId: string|null }}
 */
function validateStation(input) {
  const { station, declaration, reference } = input;
  const problems = [];
  const add = (code, detail) => problems.push({ code, detail });
  const none = { accessM: null, routeM: null, cellId: null };
  if (!station.approved) add(STATION_PROBLEM.NOT_APPROVED, "the owner has not approved this station");
  if (station.lat === null || station.lon === null) {
    add(STATION_PROBLEM.NO_COORDINATE, "no coordinate has been supplied — expected { \"lat\": <decimal degrees>, \"lon\": <decimal degrees> } in WGS-84");
    return { usable: false, problems, ...none };
  }
  if (!isNumber(station.lat) || !isNumber(station.lon) || Math.abs(station.lat) > 90 || Math.abs(station.lon) > 180) {
    add(STATION_PROBLEM.MALFORMED_COORDINATE, `lat/lon must be JSON numbers in WGS-84 decimal degrees (got ${JSON.stringify(station.lat)}, ${JSON.stringify(station.lon)})`);
    return { usable: false, problems, ...none };
  }
  let accessM = null;
  let routeM = null;
  const network = input.network || networkFor(declaration, ROVER_ROAD_CLASSES);
  if (!declaration || !network) {
    add(STATION_PROBLEM.NO_DELIVERY_DOMAIN, "no delivery-domain declaration (and so no campus network) is pinned");
  } else if (!reference) {
    add(STATION_PROBLEM.NOT_REACHABLE, "no depot coordinate to test reachability from");
  } else {
    const routed = network.route(reference, { lat: station.lat, lon: station.lon });
    if (!routed.ok) {
      const code = routed.refusal === "ENDPOINT_OUTSIDE_BOUNDARY"
        ? STATION_PROBLEM.OUTSIDE_OPERATING_BOUNDARY
        : routed.refusal === "ACCESS_LEAVES_BOUNDARY" || routed.refusal === "ROUTE_LEAVES_BOUNDARY"
          ? STATION_PROBLEM.ROUTE_LEAVES_BOUNDARY
          : STATION_PROBLEM.NOT_REACHABLE;
      add(code, `${routed.refusal}: ${routed.reason}`);
    }
    else {
      accessM = routed.accessM ? routed.accessM.destination : null;
      routeM = routed.distanceM;
    }
  }
  const cellId = problems.length === 0 ? cells.cellForPoint(station.lat, station.lon, cells.RESOLUTION.FINE) : null;
  return { usable: problems.length === 0, problems, accessM, routeM, cellId };
}

/** The CONTAINED campus network for a declaration and a road-class set (RD-2026-10-12-02), or null. */
function networkFor(declaration, roadClasses) {
  if (!declaration) return null;
  const built = chargerRoute.containedNetworkFor(declaration, roadClasses);
  return built.ok ? built.network : null;
}

module.exports = {
  FILE_VAR,
  DEFAULT_STATION_PLUGS,
  MAX_STATION_PLUGS,
  ROVER_ROAD_CLASSES,
  STATION_PROBLEM,
  INTENDED_RNSIT_STATIONS,
  normaliseDeclaration,
  loadDeclaration,
  validateStation,
  networkFor,
};

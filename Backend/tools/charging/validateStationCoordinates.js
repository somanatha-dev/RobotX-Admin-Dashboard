#!/usr/bin/env node
"use strict";

/**
 * Validate proposed charging-station coordinates BEFORE the owner approves them.
 * Read-only: it touches no database and writes nothing.
 *
 *   node tools/charging/validateStationCoordinates.js \
 *     --stations <station declaration JSON, e.g. docs/runbooks/simulated-charging-stations.example.json> \
 *     --domain   <the pinned delivery-domain declaration JSON, or a ConfigVersion payload holding .deliveryDomain> \
 *     --from     <lat,lon of the depot the stations must be reachable from>
 *
 * For every station that has a coordinate (approved or not) it reports:
 *   1. FORMAT       — WGS-84 decimal degrees as JSON numbers, in range;
 *   2. REGION       — strictly INSIDE the operating region (`campusServiceability`, the routing
 *                     layer's own containment test; a point ON the boundary is not inside);
 *   3. REACHABLE    — a sidewalk route from `--from` over the campus network of the declaration,
 *                     with the route length and the access-connector length (how far the point is
 *                     from the nearest permitted way), and whether every sampled point of that
 *                     route stays inside the region.
 * A station without a coordinate is reported as needing one. Exit code 0 only when every
 * station WITH a coordinate passes 1–3.
 *
 * The runtime applies the same containment when it provisions an approved station (the contained
 * network of `chargerRoute.containedNetworkFor`, RD-2026-10-12-02); this tool states every check by
 * name, for the owner, BEFORE `approved: true` is written.
 */

const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "../../src");
const campusTraversalNetwork = require(`${SRC}/simulation/campusTraversalNetwork`);
const campusServiceability = require(`${SRC}/engine/routing/campusServiceability`);
const chargingStations = require(`${SRC}/simulation/chargingStations`);
const { haversineMeters } = require(`${SRC}/utils/distance`);

/** Sampling interval along each route segment for the region check. @structural */
const SAMPLE_M = 2;

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

function routeStaysInside(oracle, points) {
  const inside = (p) => oracle.assess(p.lat, p.lon).status === campusServiceability.SERVICEABILITY.INSIDE;
  for (let i = 0; i < points.length; i += 1) {
    if (!inside(points[i])) return { inside: false, at: points[i] };
    if (i === 0) continue;
    const a = points[i - 1];
    const b = points[i];
    const samples = Math.floor(haversineMeters(a.lat, a.lon, b.lat, b.lon) / SAMPLE_M);
    for (let k = 1; k <= samples; k += 1) {
      const t = k / (samples + 1);
      const p = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
      if (!inside(p)) return { inside: false, at: p };
    }
  }
  return { inside: true, at: null };
}

/**
 * @param {{ declaration: object, stations: object[], from: { lat: number, lon: number } }} input
 * @returns {{ ok: boolean, results: object[] }}
 */
function validate(input) {
  const oracle = campusServiceability.createServiceabilityOracle(input.declaration);
  const network = chargingStations.networkFor(input.declaration, chargingStations.ROVER_ROAD_CLASSES);
  const results = [];
  for (const station of input.stations) {
    const result = { chargerId: station.chargerId, name: station.name, checks: {} };
    if (station.lat === null || station.lon === null) {
      result.checks.format = "NEEDS COORDINATE — supply { \"lat\": <decimal degrees>, \"lon\": <decimal degrees> } (WGS-84, numbers)";
      result.pass = null;
      results.push(result);
      continue;
    }
    const formatOk = typeof station.lat === "number" && typeof station.lon === "number" &&
      Number.isFinite(station.lat) && Number.isFinite(station.lon) && Math.abs(station.lat) <= 90 && Math.abs(station.lon) <= 180;
    result.checks.format = formatOk ? "PASS" : `FAIL — lat/lon must be JSON numbers in range (got ${JSON.stringify(station.lat)}, ${JSON.stringify(station.lon)})`;
    if (!formatOk) {
      result.pass = false;
      results.push(result);
      continue;
    }
    const region = oracle.usable ? oracle.assess(station.lat, station.lon) : { status: "NO_REGION", reason: oracle.problems.join("; ") };
    result.checks.region = region.status === campusServiceability.SERVICEABILITY.INSIDE ? "PASS (INSIDE)" : `FAIL — ${region.status}${region.reason ? `: ${region.reason}` : ""}`;
    const routed = network ? network.route(input.from, { lat: station.lat, lon: station.lon }) : { ok: false, refusal: "NO_NETWORK", reason: "the declaration's campus extract could not be read" };
    if (routed.ok) {
      const stays = oracle.usable ? routeStaysInside(oracle, routed.points) : { inside: false, at: null };
      result.checks.reachable = `PASS — ${Math.round(routed.distanceM)} m by sidewalk; access connector ${routed.accessM.destination.toFixed(1)} m`;
      result.checks.routeInsideRegion = stays.inside ? "PASS" : `FAIL — leaves the region near (${stays.at ? `${stays.at.lat.toFixed(6)}, ${stays.at.lon.toFixed(6)}` : "?"})`;
      result.accessM = routed.accessM.destination;
      result.routeM = routed.distanceM;
    } else {
      result.checks.reachable = `FAIL — ${routed.refusal}: ${routed.reason}`;
      result.checks.routeInsideRegion = "NOT CHECKED";
    }
    result.pass = Object.values(result.checks).every((value) => typeof value === "string" && value.startsWith("PASS"));
    results.push(result);
  }
  return { ok: results.every((r) => r.pass !== false), results };
}

function main() {
  const stationsFile = argValue("--stations");
  const domainFile = argValue("--domain");
  const from = String(argValue("--from") || "").split(",").map(Number);
  if (!stationsFile || !domainFile || from.length !== 2 || !from.every(Number.isFinite)) {
    process.stderr.write("usage: --stations <file> --domain <file> --from <lat,lon>\n");
    process.exit(2);
  }
  const rawDomain = readJson(domainFile);
  const declaration = rawDomain.deliveryDomain || rawDomain;
  const declared = chargingStations.normaliseDeclaration(readJson(stationsFile), stationsFile);
  const out = validate({ declaration, stations: declared.stations, from: { lat: from[0], lon: from[1] } });
  process.stdout.write(`${JSON.stringify({ declarationProblems: declared.problems, ...out }, null, 2)}\n`);
  process.exit(out.ok && declared.problems.length === 0 ? 0 : 1);
}

if (require.main === module) main();

module.exports = { validate };

"use strict";

/**
 * A SYNTHETIC world for the DTARO operator-decision tests: a published map, a small walkway
 * network, and a fleet with commanded routes (OFFER fixtures). Not RNSIT, not G4; nothing is
 * published anywhere. Distances are in metres from the obstacle cell's centre O (x east, y north).
 *
 *   region rA: zones zW / zE, split at MID's longitude by cell centre (O is ~130 m east of MID)
 *   region rB: 1.5 km west, whose zone is ALSO named "zE" (a zone-id collision across regions)
 *
 *   network (footway):  main  y=0    x −260 … 150, with a vertex at the obstacle (x=0)
 *                       bypass y=+80  x −260 … 120
 *                       rungs  x=−120 and x=+120, y 0 → 80
 *   The obstacle's cell (~25 m radius) cuts the main walk between x −30 and +30; the bypass is
 *   the only way around.
 */

const h3 = require("h3-js");
const campusTraversalNetwork = require("../../src/simulation/campusTraversalNetwork");

const RES = 11;
const MID = { lat: 12.9023, lon: 77.5186 };
const P_B = { lat: 12.9027, lon: 77.505 };
const shift = (base, dLat, dLon) => ({ lat: base.lat + dLat, lon: base.lon + dLon });
const centreOf = (point) => {
  const [lat, lon] = h3.cellToLatLng(h3.latLngToCell(point.lat, point.lon, RES));
  return { lat, lon };
};

const O = centreOf(shift(MID, 0, 0.0012));
const KX = 111320 * Math.cos((O.lat * Math.PI) / 180);
const KY = 110574;
/** The point `x` m east and `y` m north of the obstacle cell's centre. */
const xy = (x, y) => ({ lat: O.lat + y / KY, lon: O.lon + x / KX });
const OB_CELL = h3.latLngToCell(O.lat, O.lon, RES);
const FOOTPRINT = h3.cellToBoundary(OB_CELL).map(([lat, lon]) => ({ lat, lon }));

function buildMap() {
  const cells = [];
  for (const cellId of h3.gridDisk(h3.latLngToCell(MID.lat, MID.lon, RES), 14)) {
    const [, lon] = h3.cellToLatLng(cellId);
    cells.push({ cellId, resolution: "FINE", regionId: "rA", zoneId: lon < MID.lon ? "zW" : "zE", siteId: null });
  }
  for (const cellId of h3.gridDisk(h3.latLngToCell(P_B.lat, P_B.lon, RES), 6)) {
    // The same zone label as rA's east zone: only the region tells them apart.
    cells.push({ cellId, resolution: "FINE", regionId: "rB", zoneId: "zE", siteId: null });
  }
  return {
    regions: [{ id: "rA" }, { id: "rB" }],
    // As in the region-isolation fixture of `dtaroZoneAlertSockets.test.js`: rB's cells carry their
    // own regionId, which is what resolution reads, so the shared label is two rooms.
    zones: [{ id: "zW", regionId: "rA" }, { id: "zE", regionId: "rA" }],
    sites: [],
    cells,
  };
}

const line = (...points) => ({ type: "Feature", properties: { highway: "footway" }, geometry: { type: "LineString", coordinates: points.map((p) => [p.lon, p.lat]) } });

function buildNetwork() {
  const features = [
    line(...[-260, -220, -150, -120, -60, -30, 0, 30, 60, 90, 120, 150].map((x) => xy(x, 0))),
    line(...[-260, -120, -60, 0, 60, 120].map((x) => xy(x, 80))),
    line(xy(-120, 0), xy(-120, 80)),
    line(xy(120, 0), xy(120, 80)),
  ];
  return campusTraversalNetwork.createCampusTraversalNetwork({ features, roadClasses: ["footway"], source: "synthetic decision world" });
}

const route = (...points) => points.map(([x, y]) => xy(x, y));

/**
 * The fleet. `stops` is the OFFER's stop sequence (the commanded route) and the robot's own
 * TASK_ASSIGN; `offer: "NO_GEOMETRY"` is a live commitment whose OFFER has no path.
 */
const FLEET = {
  // Inside the obstacle's cell, driving east through it: it senses and reports the obstacle.
  REP: { zone: "zE", stops: [route([-12, 0], [30, 0], [60, 0]), route([60, 0], [90, 0])] },
  // Same zone; its remaining route crosses the obstacle; the bypass gives a detour.
  "SAME-CROSS": { zone: "zE", stops: [route([60, 0], [30, 0], [0, 0], [-30, 0], [-60, 0], [-120, 0]), route([-120, 0], [-150, 0])] },
  // Same zone, idle.
  "SAME-IDLE": { zone: "zE", position: xy(40, -70) },
  // Same zone; its first leg ENDS inside the obstacle's cell: no safe alternate route exists.
  DEAD: { zone: "zE", stops: [route([90, 0], [60, 0], [30, 0], [10, 0]), route([10, 0], [0, 0], [-30, 0])] },
  // West zone; its remaining route crosses the obstacle (cross-zone).
  "X-CROSS": { zone: "zW", stops: [route([-220, 0], [-150, 0], [-120, 0], [-60, 0], [-30, 0], [0, 0], [30, 0], [60, 0]), route([60, 0], [90, 0])] },
  // West zone; its route stays on the bypass, clear of the obstacle.
  "X-CLEAR": { zone: "zW", stops: [route([-250, 80], [-120, 80]), route([-120, 80], [-60, 80])] },
  // West zone, idle.
  "X-IDLE": { zone: "zW", position: xy(-200, -60) },
  // West zone; a live commitment whose OFFER carries no geometry (route unknown).
  "X-NOGEOM": { zone: "zW", offer: "NO_GEOMETRY", ownStops: [route([-220, 40], [-200, 40]), route([-200, 40], [-190, 40])] },
  // Region rB, zone "zE" (the same label as rA's); its synthetic corridor is drawn through O.
  "B-ROUTE": { zone: "zE", region: "rB", position: shift(P_B, 0.0002, 0), stops: [[shift(P_B, 0.0002, 0), O], [O, xy(30, 0)]] },
};

function positionOf(robotId) {
  const spec = FLEET[robotId];
  return spec.position || (spec.stops ? spec.stops[0][0] : spec.ownStops[0][0]);
}

/** The engine rows the server's route reads see: Agent, live Commitment, OFFER Outbox. */
function offerRows() {
  const agents = [];
  const commitments = [];
  const outbox = [];
  for (const [robotId, spec] of Object.entries(FLEET)) {
    agents.push({ id: `ag-${robotId}`, agentId: robotId, agentClass: { mobilityModel: { permissionSet: { roadClasses: ["footway"] } } } });
    if (!spec.stops && !spec.offer) continue;
    commitments.push({ commitmentId: `cm-${robotId}`, agentId: `ag-${robotId}`, grantedAt: new Date("2026-10-24T09:00:00Z"), leaseExpiry: new Date(Date.now() + 3_600_000) });
    const stopSequence = spec.offer === "NO_GEOMETRY"
      ? [{ stopId: "s1", sequence: 1, stopType: "PICKUP" }, { stopId: "s2", sequence: 2, stopType: "DROP" }]
      : spec.stops.map((path, i) => ({ stopId: `s${i + 1}`, sequence: i + 1, stopType: i === 0 ? "PICKUP" : "DROP", path }));
    outbox.push({ commitmentId: `cm-${robotId}`, command: "OFFER", createdAt: new Date("2026-10-24T09:00:01Z"), payload: { taskId: `TSK-${robotId}`, stopSequence } });
  }
  return { agents, commitments, outbox };
}

/** Task rows (origin and destination names) for the robots with a commanded route. */
function taskRows() {
  return Object.entries(FLEET)
    .filter(([, spec]) => spec.stops)
    .map(([robotId, spec]) => {
      const first = spec.stops[0][spec.stops[0].length - 1];
      const last = spec.stops[1][spec.stops[1].length - 1];
      return { taskId: `TSK-${robotId}`, pickup: `Pickup of ${robotId}`, pickupLat: first.lat, pickupLon: first.lon, drop: `Drop of ${robotId}`, dropLat: last.lat, dropLon: last.lon };
    });
}

module.exports = { RES, MID, P_B, O, OB_CELL, FOOTPRINT, xy, buildMap, buildNetwork, FLEET, positionOf, offerRows, taskRows };

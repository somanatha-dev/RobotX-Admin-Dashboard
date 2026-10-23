#!/usr/bin/env node
"use strict";

/**
 * **Simulated-route containment probe — read-only.** Measures how far the routes simulated
 * robots are commanded along leave the RNSIT operating boundary, and what the smallest correction
 * would change. It changes nothing.
 *
 *   node tools/campus/simRouteContainmentProbe.js          # summary JSON
 *
 * ── The issue ───────────────────────────────────────────────────────────────
 * `v1DemonstrationComposition.networksFrom` builds the simulator's traversal network WITHOUT
 * `containment`, so only a route's endpoints are checked against the boundary; the ways and the
 * straight access connectors in between may cross ground the boundary excludes. The physical
 * router (`fleetProviders/physicalRouter`) and the charger router (`simulation/chargerRoute`)
 * already build the same network WITH `routeContainment.createRouteContainment(declaration)`.
 *
 * ── The candidate correction (NOT applied) ──────────────────────────────────
 * Pass that same `containment` in `networksFrom`. One argument, an existing module, an
 * existing pattern. It changes the commanded OFFER path, its priced length and the corridor
 * completion is graded against, so it is a change to authoritative routes under the V1 freeze
 * and needs owner approval before it is made. This probe and its test show what it would do.
 *
 * Deterministic; no database; no network.
 */

const h3 = require("h3-js");

const campusTraversalNetwork = require("../../src/simulation/campusTraversalNetwork");
const { createRouteContainment } = require("../../src/services/fleetProviders/routeContainment");
const cells = require("../../src/engine/spatial/cells");
const bootstrap = require("../deploy/bootstrapV1Environment");
const zoneMap = require("./rnsitZoneMap");

/** @structural sampling step along a route for the outside measurement, metres */
const SAMPLE_M = 0.5;

/** Distance (m) from a point to the boundary's exterior ring, in a local metric frame. */
function distanceToRing(point, ring) {
  const kx = (Math.PI / 180) * 6371000 * Math.cos((point.lat * Math.PI) / 180);
  const ky = (Math.PI / 180) * 6371000;
  let best = Infinity;
  for (let i = 1; i < ring.length; i += 1) {
    const ax = (ring[i - 1][0] - point.lon) * kx;
    const ay = (ring[i - 1][1] - point.lat) * ky;
    const bx = (ring[i][0] - point.lon) * kx;
    const by = (ring[i][1] - point.lat) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/** How much of a route lies outside the boundary, and how far out it reaches. */
function outsideOf(points, containment, ring) {
  let outsideM = 0;
  let maxOutsideM = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const length = cells.greatCircleMetres(a.lat, a.lon, b.lat, b.lon);
    const steps = Math.max(1, Math.ceil(length / SAMPLE_M));
    for (let k = 0; k < steps; k += 1) {
      const t = (k + 0.5) / steps;
      const p = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
      if (containment.containsPoint(p)) continue;
      outsideM += length / steps;
      maxOutsideM = Math.max(maxOutsideM, distanceToRing(p, ring));
    }
  }
  return { outsideM, maxOutsideM };
}

/**
 * Every ordered pair of in-campus task endpoints (the 18 site-verified access points and every
 * user-supplied reference point strictly inside the boundary), routed on the live uncontained
 * network and on the contained candidate.
 */
function probe() {
  const world = bootstrap.intendedWorld();
  const inputs = zoneMap.loadInputs();
  const containment = createRouteContainment(world.declaration);
  const ring = world.declaration.boundary.coordinates[0];
  const extract = campusTraversalNetwork.extractForDeclaration(world.declaration);
  if (!extract.ok) throw new Error(extract.problems.join("; "));
  const roadClasses = campusTraversalNetwork.permittedClasses({ roadClasses: ["footway", "path", "service"], stairCapable: false });
  const live = campusTraversalNetwork.createCampusTraversalNetwork({ features: extract.features, roadClasses, source: extract.file });
  const contained = campusTraversalNetwork.createCampusTraversalNetwork({ features: extract.features, roadClasses, source: extract.file, containment });

  const endpoints = [
    ...inputs.access.features
      .filter((f) => f.properties.status === "verified")
      .map((f) => ({ id: f.properties.id, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] })),
    ...inputs.supplemental.features
      .map((f) => ({ id: `supplemental:${f.properties.id}`, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }))
      .filter((p) => containment.containsPoint(p)),
  ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const pairs = [];
  for (const a of endpoints) {
    for (const b of endpoints) {
      if (a === b) continue;
      const l = live.route(a, b);
      const c = contained.route(a, b);
      const lo = l.ok ? outsideOf(l.points, containment, ring) : null;
      const co = c.ok ? outsideOf(c.points, containment, ring) : null;
      pairs.push({
        from: a.id,
        to: b.id,
        live: l.ok ? { distanceM: l.distanceM, outsideM: lo.outsideM, maxOutsideM: lo.maxOutsideM } : { refusal: l.refusal },
        contained: c.ok ? { distanceM: c.distanceM, outsideM: co.outsideM, maxOutsideM: co.maxOutsideM } : { refusal: c.refusal },
      });
    }
  }
  const leaving = pairs.filter((p) => p.live.outsideM > 0);
  const maxLive = leaving.reduce((m, p) => (p.live.maxOutsideM > m.live.maxOutsideM ? p : m), leaving[0] || null);
  const endpointsInLeaving = new Map();
  for (const p of leaving) for (const id of [p.from, p.to]) endpointsInLeaving.set(id, (endpointsInLeaving.get(id) || 0) + 1);
  return {
    endpoints: endpoints.length,
    pairs: pairs.length,
    live: {
      network: live.describe(),
      pairsLeavingBoundary: leaving.length,
      maxOutsideM: maxLive ? Math.round(maxLive.live.maxOutsideM * 10) / 10 : 0,
      worstPair: maxLive ? `${maxLive.from} → ${maxLive.to}` : null,
      endpointsInvolved: [...endpointsInLeaving.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, pairs: n })),
    },
    contained: {
      network: contained.describe(),
      refused: pairs.filter((p) => p.contained.refusal).map((p) => ({ from: p.from, to: p.to, refusal: p.contained.refusal })),
      pairsLeavingBoundary: pairs.filter((p) => p.contained.outsideM > 0).length,
      maxOutsideM: Math.round(Math.max(0, ...pairs.filter((p) => p.contained.maxOutsideM !== undefined).map((p) => p.contained.maxOutsideM)) * 10) / 10,
      lengthChange: leaving
        .filter((p) => p.contained.distanceM !== undefined)
        .map((p) => ({ from: p.from, to: p.to, liveM: Math.round(p.live.distanceM), containedM: Math.round(p.contained.distanceM) })),
      unchangedPairs: pairs.filter((p) => p.live.outsideM === 0 && p.contained.distanceM !== undefined && Math.abs(p.contained.distanceM - p.live.distanceM) < 1e-6).length,
    },
    pairsDetail: pairs,
  };
}

module.exports = { probe, outsideOf, distanceToRing };

if (require.main === module) {
  const { pairsDetail, ...summary } = probe();
  void pairsDetail;
  void h3;
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

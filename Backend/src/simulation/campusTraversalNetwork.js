"use strict";

/**
 * The **campus traversal network** of the simulated world — the graph a simulated agent's
 * route is computed over and then driven along. DEVELOPMENT_SIMULATION, and nothing else.
 *
 * ── Why it exists ───────────────────────────────────────────────────────────
 * The V1 demonstration priced every hop as the great circle between two H3 cell centres
 * plus a fixed intra-cell offset, and then handed the agent a *different* line — a
 * two-point chord between the exact coordinates — to drive. Neither was a campus route,
 * and the two disagreed by 2–11× on RNSIT. This module is the one geometry both sides now
 * read: the route is computed here once, priced on its own length, and the same points are
 * carried to the agent and to the dashboard.
 *
 * ── Where the network comes from ───────────────────────────────────────────
 * From the campus OSM extract the region's delivery domain was published from — the
 * repository's `*-campus-osm.geojson` files, which the seed already reads its boundary out
 * of. `extractForDeclaration` finds that file by the pinned declaration's own identity
 * (its `version` is the boundary way's OSM id, and its `boundary` must equal that way's
 * geometry exactly), so no campus is named in code and a second campus is a second file.
 *
 * Only the `highway` ways the agent class is permitted to use become edges
 * (`MobilityModel.permissionSet.roadClasses`, plus `steps` only for a stair-capable class).
 * Nothing is interpolated, smoothed or invented: every interior point of a route is an OSM
 * vertex of a permitted way.
 *
 * ── Exact endpoints ─────────────────────────────────────────────────────────
 * A pickup or a robot is not on a way. Each endpoint is projected onto the nearest
 * permitted segment, and the route runs exact point → its projection → the network →
 * the destination's projection → exact point. The two access connectors are part of the
 * route and of its length; their lengths are reported (`accessM`) so a reader can see
 * them. **No maximum access distance is applied**: that bound is the owner's
 * (`snapRadiusM`, R13) and is not declared, so this module reports the distance rather
 * than inventing a radius. Endpoints are already confined to the campus by the delivery
 * domain and the cell projection's serviceability check.
 *
 * ── What it is NOT ──────────────────────────────────────────────────────────
 * Not B1, not a production router, not an adapter. `routing/productionRouter.js` and the
 * ADR-11/ADR-33 procurement are untouched; this module is reachable only through
 * `simulationRouter`, which refuses to exist outside a simulated deployment.
 *
 * ── Determinism (§9.6) ──────────────────────────────────────────────────────
 * No clock, no randomness. Vertices are numbered in file order, ties are broken by the
 * lower index, and the same request always returns the same points.
 */

const fs = require("fs");
const path = require("path");

const { haversineMeters } = require("../utils/distance");

/** The stair class, admitted only for a stair-capable agent. @structural an OSM tag value */
const STAIRS_CLASS = "steps";

/** Where the campus extracts live: the repository root. @structural */
const DEFAULT_EXTRACT_DIRECTORY = path.resolve(__dirname, "..", "..", "..");

/** The extract file naming convention the repository already uses. @structural */
const EXTRACT_FILE_PATTERN = /-campus-osm\.geojson$/u;

/** Metres per radian of latitude on the mean sphere `haversineMeters` uses. @structural */
const METRES_PER_RADIAN = 6371000;

/** Why a route could not be produced. @structural */
const NETWORK_REFUSAL = Object.freeze({
  NO_PERMITTED_WAYS: "NO_PERMITTED_WAYS",
  NOT_CONNECTED: "NOT_CONNECTED",
  MALFORMED_ENDPOINT: "MALFORMED_ENDPOINT",
});

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isPoint = (value) => Boolean(value) && isFiniteNumber(value.lat) && isFiniteNumber(value.lon);

/**
 * The road classes an agent may use, from its declared permission set. A class that is not
 * a ground class declares none, and an empty set is a network with no edges — which
 * refuses, rather than routing the agent somewhere it was never permitted to go.
 *
 * @param {{ roadClasses?: string[], stairCapable?: boolean }|null|undefined} permissionSet
 * @returns {string[]} sorted, de-duplicated
 */
function permittedClasses(permissionSet) {
  const declared = permissionSet && Array.isArray(permissionSet.roadClasses) ? permissionSet.roadClasses : [];
  const classes = new Set(declared.filter((c) => typeof c === "string" && c.length > 0 && c !== STAIRS_CLASS));
  if (permissionSet && permissionSet.stairCapable === true) classes.add(STAIRS_CLASS);
  return [...classes].sort();
}

/**
 * Find the campus extract a pinned delivery-domain declaration was published from.
 *
 * @param {object} declaration the pinned `deliveryDomain` (`{ version, boundary, … }`)
 * @param {{ directory?: string }} [options]
 * @returns {{ ok: boolean, file: string|null, features: object[]|null, problems: string[] }}
 */
function extractForDeclaration(declaration, options) {
  const directory = (options && options.directory) || DEFAULT_EXTRACT_DIRECTORY;
  const wayId = declaration && typeof declaration.version === "string" ? declaration.version : null;
  const boundary = declaration && declaration.boundary && declaration.boundary.coordinates;
  if (!wayId || !Array.isArray(boundary)) {
    return {
      ok: false,
      file: null,
      features: null,
      problems: ["the delivery-domain declaration names no boundary way (version) and geometry to find its campus extract by"],
    };
  }

  let names;
  try {
    names = fs.readdirSync(directory).filter((name) => EXTRACT_FILE_PATTERN.test(name)).sort();
  } catch (error) {
    return { ok: false, file: null, features: null, problems: [`the campus extract directory is unreadable: ${error.message}`] };
  }

  const wanted = JSON.stringify(boundary);
  for (const name of names) {
    let collection;
    try {
      collection = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
    } catch {
      continue;
    }
    const features = Array.isArray(collection && collection.features) ? collection.features : [];
    const way = features.find((feature) => feature && feature.id === wayId);
    if (way && way.geometry && JSON.stringify(way.geometry.coordinates) === wanted) {
      return { ok: true, file: name, features, problems: [] };
    }
  }

  return {
    ok: false,
    file: null,
    features: null,
    problems: [
      `no *-campus-osm.geojson extract in ${directory} carries boundary way "${wayId}" with the published geometry; ` +
        "the campus network is taken only from the extract the delivery domain was published from",
    ],
  };
}

/**
 * Build the network from an extract's features.
 *
 * @param {object} input
 * @param {object[]} input.features GeoJSON features (`[lon, lat]`)
 * @param {string[]} input.roadClasses permitted `highway` values (`permittedClasses`)
 * @param {string} [input.source] a label for `describe()`
 * @returns {object}
 */
function createCampusTraversalNetwork(input) {
  const settings = input || {};
  const features = Array.isArray(settings.features) ? settings.features : [];
  const roadClasses = Array.isArray(settings.roadClasses) ? [...settings.roadClasses].sort() : [];
  const source = settings.source || "unnamed extract";

  /** @type {Array<{ lat: number, lon: number }>} */
  const vertices = [];
  const indexOf = new Map();
  /** @type {Array<Map<number, number>>} */
  const adjacency = [];
  /** @type {Array<{ a: number, b: number }>} */
  const segments = [];

  const vertex = (coordinate) => {
    const key = `${coordinate[0]},${coordinate[1]}`;
    let index = indexOf.get(key);
    if (index === undefined) {
      index = vertices.length;
      indexOf.set(key, index);
      vertices.push(Object.freeze({ lat: Number(coordinate[1]), lon: Number(coordinate[0]) }));
      adjacency.push(new Map());
    }
    return index;
  };

  for (const feature of features) {
    const geometry = feature && feature.geometry;
    const highway = feature && feature.properties && feature.properties.highway;
    if (!geometry || geometry.type !== "LineString" || !roadClasses.includes(highway)) continue;
    const coordinates = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
    for (let i = 1; i < coordinates.length; i += 1) {
      const a = vertex(coordinates[i - 1]);
      const b = vertex(coordinates[i]);
      if (a === b) continue;
      const weight = haversineMeters(vertices[a].lat, vertices[a].lon, vertices[b].lat, vertices[b].lon);
      if (!adjacency[a].has(b) || adjacency[a].get(b) > weight) {
        adjacency[a].set(b, weight);
        adjacency[b].set(a, weight);
      }
      segments.push({ a, b });
    }
  }

  const n = vertices.length;
  const trees = new Map();

  /** Single-source shortest paths from one vertex, memoised: the reusable middle portion. */
  function treeFrom(sourceIndex) {
    let tree = trees.get(sourceIndex);
    if (tree) return tree;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    dist[sourceIndex] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < n; i += 1) {
        if (!done[i] && dist[i] < Infinity && (u === -1 || dist[i] < dist[u])) u = i;
      }
      if (u === -1) break;
      done[u] = 1;
      for (const [v, w] of adjacency[u]) {
        const candidate = dist[u] + w;
        if (candidate < dist[v] || (candidate === dist[v] && prev[v] > u)) {
          dist[v] = candidate;
          prev[v] = u;
        }
      }
    }
    tree = { dist, prev };
    trees.set(sourceIndex, tree);
    return tree;
  }

  function vertexPath(tree, target) {
    const out = [];
    for (let v = target; v !== -1; v = tree.prev[v]) out.push(v);
    return out.reverse();
  }

  /**
   * The nearest point on any permitted segment, in a local equirectangular frame centred on
   * the query point (exact enough at campus scale; the route's length is then measured by
   * haversine over the resulting points, never in this frame).
   */
  function snap(point) {
    const lat0 = (point.lat * Math.PI) / 180;
    const kx = Math.cos(lat0) * (Math.PI / 180) * METRES_PER_RADIAN;
    const ky = (Math.PI / 180) * METRES_PER_RADIAN;
    let best = null;
    segments.forEach((segment, index) => {
      const A = vertices[segment.a];
      const B = vertices[segment.b];
      const ax = (A.lon - point.lon) * kx;
      const ay = (A.lat - point.lat) * ky;
      const dx = (B.lon - A.lon) * kx;
      const dy = (B.lat - A.lat) * ky;
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
      const offset = Math.hypot(ax + t * dx, ay + t * dy);
      if (best === null || offset < best.offset) best = { index, segment, t, offset };
    });
    if (best === null) return null;
    const A = vertices[best.segment.a];
    const B = vertices[best.segment.b];
    const at =
      best.t === 0 ? A : best.t === 1 ? B : { lat: A.lat + (B.lat - A.lat) * best.t, lon: A.lon + (B.lon - A.lon) * best.t };
    return { a: best.segment.a, b: best.segment.b, point: { lat: at.lat, lon: at.lon } };
  }

  const metres = (p, q) => haversineMeters(p.lat, p.lon, q.lat, q.lon);

  /**
   * The route between two exact points over the permitted network.
   *
   * @param {{ lat: number, lon: number }} from
   * @param {{ lat: number, lon: number }} to
   * @returns {{ ok: true, points: object[], distanceM: number, accessM: object, vertexCount: number }
   *          | { ok: false, refusal: string, reason: string }}
   */
  function route(from, to) {
    if (!isPoint(from) || !isPoint(to)) {
      return { ok: false, refusal: NETWORK_REFUSAL.MALFORMED_ENDPOINT, reason: "an endpoint is not a { lat, lon } pair of finite numbers" };
    }
    if (segments.length === 0) {
      return {
        ok: false,
        refusal: NETWORK_REFUSAL.NO_PERMITTED_WAYS,
        reason: `the ${source} network has no ways of the permitted classes [${roadClasses.join(", ")}]`,
      };
    }

    const start = snap(from);
    const end = snap(to);

    // Every way through the network: leave the start segment by either end, arrive at the
    // end segment by either end. Plus, when both endpoints project onto the same segment,
    // the stretch of that segment between them.
    let best = null;
    const sameSegment =
      (start.a === end.a && start.b === end.b) || (start.a === end.b && start.b === end.a);
    if (sameSegment) best = { cost: metres(start.point, end.point), via: [] };

    for (const exit of [start.a, start.b]) {
      const tree = treeFrom(exit);
      for (const entry of [end.a, end.b]) {
        if (!(tree.dist[entry] < Infinity)) continue;
        const cost = metres(start.point, vertices[exit]) + tree.dist[entry] + metres(vertices[entry], end.point);
        if (best === null || cost < best.cost) best = { cost, via: vertexPath(tree, entry) };
      }
    }

    if (best === null) {
      return {
        ok: false,
        refusal: NETWORK_REFUSAL.NOT_CONNECTED,
        reason: `the two endpoints project onto parts of the ${source} network that no permitted way connects`,
      };
    }

    const chain = [from, start.point, ...best.via.map((index) => vertices[index]), end.point, to];
    // Coincident consecutive points (an endpoint already on a way, a projection onto a
    // vertex) carry no distance and are dropped; the first and last are always kept, so a
    // zero-length route is still the two-point shape the agent's executability check reads.
    const points = [{ lat: chain[0].lat, lon: chain[0].lon }];
    for (let i = 1; i < chain.length - 1; i += 1) {
      const last = points[points.length - 1];
      if (chain[i].lat !== last.lat || chain[i].lon !== last.lon) points.push({ lat: chain[i].lat, lon: chain[i].lon });
    }
    const final = chain[chain.length - 1];
    const tail = points[points.length - 1];
    if (points.length > 1 && tail.lat === final.lat && tail.lon === final.lon) points.pop();
    points.push({ lat: final.lat, lon: final.lon });

    // The route's length is the length of the points — the same haversine the agent advances
    // on — so the distance priced is, by construction, the distance driven.
    let distanceM = 0;
    for (let i = 1; i < points.length; i += 1) distanceM += metres(points[i - 1], points[i]);

    return {
      ok: true,
      points,
      distanceM,
      accessM: { origin: metres(from, start.point), destination: metres(end.point, to) },
      vertexCount: best.via.length,
    };
  }

  function components() {
    const seen = new Int32Array(n).fill(-1);
    let count = 0;
    for (let i = 0; i < n; i += 1) {
      if (seen[i] !== -1) continue;
      const stack = [i];
      seen[i] = count;
      while (stack.length > 0) {
        const u = stack.pop();
        for (const v of adjacency[u].keys()) {
          if (seen[v] === -1) {
            seen[v] = count;
            stack.push(v);
          }
        }
      }
      count += 1;
    }
    return count;
  }

  const componentCount = components();

  return Object.freeze({
    source,
    roadClasses: Object.freeze(roadClasses),
    vertexCount: n,
    segmentCount: segments.length,
    componentCount,
    route,
    describe() {
      return (
        `DEVELOPMENT_SIMULATION campus traversal network from ${source}: ${n} OSM vertices, ${segments.length} ` +
        `segments, ${componentCount} connected component(s), ways of class [${roadClasses.join(", ")}]`
      );
    },
  });
}

module.exports = {
  STAIRS_CLASS,
  DEFAULT_EXTRACT_DIRECTORY,
  NETWORK_REFUSAL,
  permittedClasses,
  extractForDeclaration,
  createCampusTraversalNetwork,
};

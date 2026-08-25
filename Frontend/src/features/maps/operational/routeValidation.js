/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ROUTE VALIDATION — checking a route against the campus, and REPORTING it
 *
 * §"ROUTE VISUAL REQUIREMENTS": *If a route crosses a building because the
 * underlying route data is incorrect, DO NOT hide the problem with rendering.
 * Report it.*
 *
 * That sentence rules out the two comfortable options. Nudging the line off the
 * footprint is falsifying the route. Drawing it under the extrusion so nobody
 * notices is falsifying it more quietly. The only honest response is to draw
 * exactly what the route data says and tell the operator that what it says is
 * questionable — which is what this module produces the input for.
 *
 * ── What it does NOT do ───────────────────────────────────────────────────
 * It does not reroute, repair, snap, smooth or suppress anything. It takes a
 * route and the campus geometry, and returns findings. Every consumer of a
 * finding renders it as text; none of them changes a coordinate. Candidate
 * generation, feasibility, cost, the solver and the navigation semantics are
 * untouched and unconsulted — this is a read-only observation made in the
 * browser, downstream of every decision the backend already made.
 *
 * ── Why a crossing is a FINDING and not an ERROR ──────────────────────────
 * The campus geometry is itself imported, and a route may legitimately clip a
 * footprint whose OSM outline is a few metres generous. So findings carry a
 * severity and an explanation, and the highest severity available is "this
 * looks wrong, someone should look at it". Nothing here fails a route.
 *
 * Pure module: no React, no Mapbox — loadable under plain Node.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { CAMPUS_FEATURE_KIND, PATH_CLASS } from '../campus/campusSchema.js';
import { MAX_ROUTE_OFFSET_M, metresBetween, pathToCoordinates } from './routeGeometry.js';

export const ROUTE_FINDING = Object.freeze({
  /** The drawn route passes through a building footprint. */
  CROSSES_BUILDING: 'CROSSES_BUILDING',
  /** The drawn route crosses a flight of steps a ground robot cannot drive. */
  CROSSES_STEPS: 'CROSSES_STEPS',
  /** Part of the route lies outside the campus boundary. Often correct. */
  LEAVES_CAMPUS: 'LEAVES_CAMPUS',
  /** The robot is further from its own route than a projection can explain. */
  ROBOT_OFF_ROUTE: 'ROBOT_OFF_ROUTE',
  /** The route has fewer than two usable points — nothing to draw. */
  DEGENERATE: 'DEGENERATE',
});

export const FINDING_SEVERITY = Object.freeze({
  /** Contradicts the campus geometry. Someone should look at the route data. */
  SUSPECT: 'SUSPECT',
  /** Worth knowing, not necessarily wrong. */
  NOTE: 'NOTE',
});

const SEVERITY_RANK = Object.freeze({ SUSPECT: 0, NOTE: 1 });

// ── Geometry primitives ──────────────────────────────────────────────────────
//
// All of these run in raw lon/lat degrees. Intersection and containment are
// invariant under the affine scaling that converts degrees to metres, so
// projecting first would cost arithmetic and buy nothing. Only DISTANCES are
// measured in metres, and those go through `metresBetween`.

function outerRings(geometry) {
  if (geometry?.type === 'Polygon') return [geometry.coordinates?.[0]].filter(Array.isArray);
  if (geometry?.type === 'MultiPolygon') {
    return (geometry.coordinates || []).map((poly) => poly?.[0]).filter(Array.isArray);
  }
  return [];
}

function lineStrings(geometry) {
  if (geometry?.type === 'LineString') return [geometry.coordinates].filter(Array.isArray);
  if (geometry?.type === 'MultiLineString') return (geometry.coordinates || []).filter(Array.isArray);
  return [];
}

function pointInRing(point, ring) {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function orientation(a, b, c) {
  const v = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
  if (v > 0) return 1;
  if (v < 0) return -1;
  return 0;
}

function onSegment(a, b, c) {
  return (
    Math.min(a[0], b[0]) <= c[0] &&
    c[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= c[1] &&
    c[1] <= Math.max(a[1], b[1])
  );
}

/** Do segments `a1a2` and `b1b2` intersect (touching counts)? */
export function segmentsIntersect(a1, a2, b1, b2) {
  const o1 = orientation(a1, a2, b1);
  const o2 = orientation(a1, a2, b2);
  const o3 = orientation(b1, b2, a1);
  const o4 = orientation(b1, b2, a2);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a1, a2, b1)) return true;
  if (o2 === 0 && onSegment(a1, a2, b2)) return true;
  if (o3 === 0 && onSegment(b1, b2, a1)) return true;
  if (o4 === 0 && onSegment(b1, b2, a2)) return true;
  return false;
}

/** Where a route enters a ring, if it does. Returns the first crossing point. */
function routeRingCrossing(coords, ring) {
  for (let i = 0; i < coords.length - 1; i += 1) {
    for (let j = 0; j < ring.length - 1; j += 1) {
      if (segmentsIntersect(coords[i], coords[i + 1], ring[j], ring[j + 1])) {
        return coords[i];
      }
    }
  }
  // No edge crossing — but the whole route may lie inside the ring.
  return coords.some((c) => pointInRing(c, ring)) ? coords[0] : null;
}

/**
 * How deep into a footprint the route goes, in metres.
 *
 * A route grazing a corner of a generously-drawn OSM footprint is not the same
 * finding as one running the length of a lecture block, and an operator reading
 * "crosses CSE" deserves to know which. Measured as the longest run of
 * consecutive route vertices that fall inside the ring, plus the segment that
 * carried it in — approximate on purpose, and only ever used to describe a
 * finding, never to decide whether to report one.
 */
function penetrationMetres(coords, ring) {
  let deepest = 0;
  let run = 0;
  let previousInside = null;
  for (let i = 0; i < coords.length; i += 1) {
    if (pointInRing(coords[i], ring)) {
      if (previousInside !== null) run += metresBetween(coords[previousInside], coords[i]);
      previousInside = i;
      deepest = Math.max(deepest, run);
    } else {
      previousInside = null;
      run = 0;
    }
  }
  return deepest;
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Check one route against the campus.
 *
 * @param {object} params
 * @param {Array} params.path            the route, `{lat,lon}[]` or `[lon,lat][]`
 * @param {object[]} [params.features]   validated campus features
 * @param {string} [params.label]        what to call this route in a finding
 * @param {number|null} [params.robotOffsetM] the robot's distance from this route
 * @returns {{ findings: object[], checked: boolean }}
 */
export function validateRoute({ path, features = [], label = 'route', robotOffsetM = null } = {}) {
  const coords = pathToCoordinates(path);
  const findings = [];

  if (coords.length < 2) {
    findings.push({
      type: ROUTE_FINDING.DEGENERATE,
      severity: FINDING_SEVERITY.NOTE,
      label,
      message: `${label}: fewer than two usable coordinates — nothing to draw.`,
    });
    return { findings, checked: false };
  }

  const list = Array.isArray(features) ? features : [];

  // ── Buildings ────────────────────────────────────────────────────────────
  for (const f of list) {
    if (f?.kind !== CAMPUS_FEATURE_KIND.BUILDING) continue;
    for (const ring of outerRings(f.geometry)) {
      if (ring.length < 4) continue;
      const at = routeRingCrossing(coords, ring);
      if (!at) continue;
      const depth = Math.round(penetrationMetres(coords, ring));
      findings.push({
        type: ROUTE_FINDING.CROSSES_BUILDING,
        severity: FINDING_SEVERITY.SUSPECT,
        label,
        featureId: f.id,
        featureName: f.name,
        metres: depth,
        at,
        message:
          `${label} passes through "${f.name}"` +
          (depth > 0 ? ` for about ${depth} m` : ' at its edge') +
          '. The route is drawn exactly where the route data puts it — the line has not been ' +
          'moved to avoid the building.',
      });
      break; // one finding per building is enough
    }
  }

  // ── Steps ────────────────────────────────────────────────────────────────
  // A flight of steps is not a surface a ground robot drives. A route that
  // crosses one is either wrong or is telling the operator something important.
  for (const f of list) {
    if (f?.kind !== CAMPUS_FEATURE_KIND.PATH || f?.pathClass !== PATH_CLASS.STEPS) continue;
    let crossed = false;
    for (const line of lineStrings(f.geometry)) {
      for (let i = 0; i < coords.length - 1 && !crossed; i += 1) {
        for (let j = 0; j < line.length - 1; j += 1) {
          if (segmentsIntersect(coords[i], coords[i + 1], line[j], line[j + 1])) {
            crossed = true;
            break;
          }
        }
      }
    }
    if (crossed) {
      findings.push({
        type: ROUTE_FINDING.CROSSES_STEPS,
        severity: FINDING_SEVERITY.SUSPECT,
        label,
        featureId: f.id,
        featureName: f.name,
        message: `${label} crosses "${f.name}", which the campus data records as steps — not a driveable surface.`,
      });
    }
  }

  // ── Campus boundary ──────────────────────────────────────────────────────
  // Informational, deliberately. A pickup outside the perimeter is an ordinary
  // task, and the main gate is outside the boundary almost by definition.
  const boundary = list.find((f) => f?.kind === CAMPUS_FEATURE_KIND.BOUNDARY) || null;
  const boundaryRing = boundary ? outerRings(boundary.geometry)[0] : null;
  if (boundaryRing && boundaryRing.length >= 4) {
    const outside = coords.filter((c) => !pointInRing(c, boundaryRing)).length;
    if (outside > 0) {
      findings.push({
        type: ROUTE_FINDING.LEAVES_CAMPUS,
        severity: FINDING_SEVERITY.NOTE,
        label,
        count: outside,
        message: `${label}: ${outside} of ${coords.length} route points lie outside the campus boundary.`,
      });
    }
  }

  // ── The robot against its own route ──────────────────────────────────────
  if (typeof robotOffsetM === 'number' && Number.isFinite(robotOffsetM) && robotOffsetM > MAX_ROUTE_OFFSET_M) {
    findings.push({
      type: ROUTE_FINDING.ROBOT_OFF_ROUTE,
      severity: FINDING_SEVERITY.SUSPECT,
      label,
      metres: Math.round(robotOffsetM),
      message:
        `The unit is about ${Math.round(robotOffsetM)} m from ${label}. Progress along the route ` +
        'is not being derived from its position while it is this far off.',
    });
  }

  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return { findings, checked: true };
}

/**
 * Fold many routes' findings into one list an operator can read at a glance.
 *
 * De-duplicated by `type + featureId`, because the pickup leg and the drop leg
 * of the same task usually clip the same building and reporting it twice makes
 * one problem look like two.
 */
export function summariseRouteFindings(entries) {
  const seen = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    for (const finding of entry?.findings || []) {
      const key = `${finding.type}:${finding.featureId || finding.label || ''}`;
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, { ...finding, robotIds: entry.robotId ? [entry.robotId] : [] });
      } else if (entry.robotId && !existing.robotIds.includes(entry.robotId)) {
        existing.robotIds.push(entry.robotId);
      }
    }
  }
  const findings = [...seen.values()].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return {
    findings,
    suspect: findings.filter((f) => f.severity === FINDING_SEVERITY.SUSPECT).length,
    notes: findings.filter((f) => f.severity === FINDING_SEVERITY.NOTE).length,
  };
}

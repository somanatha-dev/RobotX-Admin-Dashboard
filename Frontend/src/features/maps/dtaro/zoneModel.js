/**
 * DTARO zones — what the map draws, derived only from the backend's published zone map
 * (`GET /api/dtaro/zones`) or, behind an explicit toggle, the PROPOSAL preview snapshot.
 *
 * Pure: no React, no Mapbox. The rules this module holds:
 *
 *   · A zone is identified by REGION and zone id (`key = <regionId>/<zoneId>`). A zone label is
 *     never treated as unique on its own, because two regions may reuse one.
 *   · A campus shows only its own region's zones: the campus's operating region (the registry's
 *     `regionId` business key) must match the zone's `regionKey`. A campus with no operating
 *     region, or a zone whose region cannot be named, shows nothing — never a guess from
 *     geometry, so RNSIT and JSSATE cannot mix.
 *   · Live and preview are different kinds of data and say so (`kind`); the preview is a
 *     proposal, is never the source of any membership or alert, and its unresolved cells carry
 *     no zone.
 */

export const ZONE_KIND = Object.freeze({ LIVE: 'LIVE', PREVIEW: 'PREVIEW', UNRESOLVED: 'UNRESOLVED' });

/**
 * Which zones the map draws — a rendering preference, nothing else. Alert delivery uses the
 * published map on the server whatever is drawn here, and no view fetches, publishes or pins.
 *
 *   · NORMAL    — no zone overlay at all: the clean campus view (the default).
 *   · PROPOSAL  — the four-zone G4 proposal preview (unapproved, unpublished).
 *   · PUBLISHED — the published alert map, for diagnostics.
 */
export const ZONE_VIEW = Object.freeze({ NORMAL: 'NORMAL', PROPOSAL: 'PROPOSAL', PUBLISHED: 'PUBLISHED' });

/**
 * The zones the layer draws in `view`: none in NORMAL; the preview's zones (and its unresolved
 * cells, if any) in PROPOSAL; the published zones in PUBLISHED. A view with nothing to show (no
 * preview for this campus) draws nothing rather than falling back to another kind.
 */
export function zonesForView(view, { liveZones = [], preview = null } = {}) {
  if (view === ZONE_VIEW.PROPOSAL) return preview ? [...preview.zones, ...(preview.unresolved ? [preview.unresolved] : [])] : [];
  if (view === ZONE_VIEW.PUBLISHED) return Array.isArray(liveZones) ? liveZones : [];
  return [];
}

/** Why the zone layer is empty, when it is. */
export const ZONE_STATUS = Object.freeze({
  LOADING: 'LOADING',
  LOAD_FAILED: 'LOAD_FAILED',
  UNAVAILABLE: 'UNAVAILABLE',
  NO_CAMPUS: 'NO_CAMPUS',
  NO_REGION: 'NO_REGION',
  NO_ZONES: 'NO_ZONES',
  READY: 'READY',
});

/**
 * Zone colours: the Okabe–Ito colour-blind-safe set, reddish purple first. Campus roads and task
 * routes are navy and blue and the grounds green, so a blue first zone read as one more road (seen
 * in the real app, 2026-10-22); a purple boundary does not.
 */
export const ZONE_PALETTE = Object.freeze(['#CC79A7', '#0072B2', '#E69F00', '#009E73', '#56B4E9', '#D55E00']);
/**
 * The proposal preview's own colours, one per proposed zone in proposal order (West, East, South,
 * South-west for G4). Fixed and mutually distinct — the shared palette offset by one put two blues
 * side by side (West #0072B2 next to South-west #56B4E9, 2026-10-23) — and none is the published
 * zone's reddish purple, which the legend header uses for the published map.
 */
export const PREVIEW_PALETTE = Object.freeze(['#0072B2', '#E69F00', '#009E73', '#D55E00']);
/** Unresolved proposal cells: neutral grey, so they read as "no zone" rather than as a fifth zone. */
export const UNRESOLVED_COLOR = '#64748b';

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * A zone's text colour: its own colour darkened until it reads on a white halo (every palette
 * entry reaches at least 4.5:1 against white — the architecture test checks it).
 */
export function zoneTextColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '#1e293b';
  const n = parseInt(m[1], 16);
  const dark = (shift) => Math.round(((n >> shift) & 0xff) * 0.55);
  return `#${[16, 8, 0].map((s) => dark(s).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The live zones of one campus, from the backend's answer.
 *
 * @param {object|null} view the `/api/dtaro/zones` answer (null while loading)
 * @param {string|null} campusRegionKey the selected campus's operating region (`Region.regionId`)
 * @param {{ campusSelected: boolean }} opts
 * @returns {{ status: string, zones: object[], regionIds: string[] }}
 */
export function liveZonesForCampus(view, campusRegionKey, { campusSelected = true } = {}) {
  if (view === null || view === undefined) return { status: ZONE_STATUS.LOADING, zones: [], regionIds: [] };
  if (view.error) return { status: ZONE_STATUS.LOAD_FAILED, zones: [], regionIds: [] };
  if (view.available !== true) return { status: ZONE_STATUS.UNAVAILABLE, zones: [], regionIds: [] };
  if (!campusSelected) return { status: ZONE_STATUS.NO_CAMPUS, zones: [], regionIds: [] };
  const key = text(campusRegionKey);
  if (!key) return { status: ZONE_STATUS.NO_REGION, zones: [], regionIds: [] };

  const regionIds = (Array.isArray(view.regions) ? view.regions : []).filter((r) => r && r.regionKey === key).map((r) => String(r.id));
  const zones = (Array.isArray(view.zones) ? view.zones : [])
    .filter((z) => z && z.regionKey === key && z.geometry && text(z.zoneId) && text(z.regionId))
    .map((z, index) => ({
      key: `${z.regionId}/${z.zoneId}`,
      kind: ZONE_KIND.LIVE,
      regionId: String(z.regionId),
      regionKey: key,
      zoneId: String(z.zoneId),
      name: text(z.name) || String(z.zoneId),
      cellCount: Number.isFinite(z.cellCount) ? z.cellCount : null,
      color: ZONE_PALETTE[index % ZONE_PALETTE.length],
      textColor: zoneTextColor(ZONE_PALETTE[index % ZONE_PALETTE.length]),
      geometry: z.geometry,
    }));
  return { status: zones.length > 0 ? ZONE_STATUS.READY : ZONE_STATUS.NO_ZONES, zones, regionIds };
}

/**
 * The proposal preview for a campus, or null when the preview is not for this campus.
 *
 * @param {object|null} preview `RNSIT_ZONE_PROPOSAL_PREVIEW`
 * @param {string|null} campusCode
 */
/**
 * Is the proposal already the published map? True when every proposal zone is a published zone
 * of the campus's region with the same cell count. Once it is, the proposal must not be shown as
 * "not approved, not published": the operational map is drawn instead (2026-10-23, G4 release).
 *
 * @param {object|null} preview from `previewZonesForCampus`
 * @param {Array<{ zoneId: string, cellCount?: number }>} liveZones from `liveZonesForCampus`
 */
export function previewIsPublished(preview, liveZones) {
  if (!preview || !Array.isArray(preview.zones) || preview.zones.length === 0) return false;
  if (!Array.isArray(liveZones) || liveZones.length === 0) return false;
  const live = new Map(liveZones.map((z) => [z.zoneId, z]));
  return preview.zones.every((z) => live.has(z.zoneId) && live.get(z.zoneId).cellCount === z.cellCount);
}

export function previewZonesForCampus(preview, campusCode) {
  // A snapshot claiming approval or publication is not a preview: an approved map reaches the
  // dashboard through the published map (`/api/dtaro/zones`), never through this file.
  if (!preview || preview.kind !== 'PROPOSAL_PREVIEW' || preview.approved === true || preview.published === true) return null;
  if (!text(campusCode) || preview.campusCode !== campusCode) return null;
  const zones = (preview.zones || [])
    .filter((z) => z && z.cellCount > 0)
    .map((z, index) => {
      const color = PREVIEW_PALETTE[index % PREVIEW_PALETTE.length];
      return {
        key: `preview/${z.zoneId}`,
        kind: ZONE_KIND.PREVIEW,
        regionId: null,
        regionKey: preview.regionKey,
        zoneId: z.zoneId,
        name: z.name,
        contents: text(z.contents),
        cellCount: z.cellCount,
        color,
        textColor: zoneTextColor(color),
        geometry: z.geometry,
        // Inside the zone, not on its edge: two zones' northern vertices sat side by side and
        // their labels collided (2026-10-23).
        labelAt: medoidCellCentre(preview.cells, z.zoneId),
        layout: text(preview.layout),
      };
    });
  const unresolved =
    preview.unresolved && preview.unresolved.cellCount > 0
      ? {
          key: 'preview/unresolved',
          kind: ZONE_KIND.UNRESOLVED,
          regionId: null,
          regionKey: preview.regionKey,
          zoneId: null,
          name: `Unresolved — ${preview.unresolved.cellCount} tied cells, no zone`,
          cellCount: preview.unresolved.cellCount,
          color: UNRESOLVED_COLOR,
          textColor: zoneTextColor(UNRESOLVED_COLOR),
          geometry: preview.unresolved.geometry,
        }
      : null;
  return {
    status: preview.status,
    layout: text(preview.layout),
    validated: preview.validated === true,
    assignmentDigest: text(preview.assignmentDigest),
    zones,
    unresolved,
    cells: Array.isArray(preview.cells) ? preview.cells : [],
  };
}

/**
 * The preview's assigned cells as thin outlines, each in its zone's colour. Cells of a zone the
 * operator hid are left out; a cell with no zone is never drawn here (no colour is invented).
 *
 * @param {object|null} preview `previewZonesForCampus(...)`
 * @param {Set<string>} hidden zone keys switched off
 */
export function previewCellCollection(preview, hidden = new Set()) {
  if (!preview) return { type: 'FeatureCollection', features: [] };
  const colourOf = new Map(preview.zones.filter((z) => !hidden.has(z.key)).map((z) => [z.zoneId, z.color]));
  return {
    type: 'FeatureCollection',
    features: preview.cells
      .filter((c) => c && colourOf.has(c.zoneId) && Array.isArray(c.ring) && c.ring.length >= 4)
      .map((c) => ({
        type: 'Feature',
        properties: { cellId: c.cellId, zoneId: c.zoneId, color: colourOf.get(c.zoneId), decided: c.decided === true },
        geometry: { type: 'Polygon', coordinates: [c.ring] },
      })),
  };
}

/**
 * The centre of the zone's medoid cell — the assigned cell nearest the mean of the zone's cell
 * centres. Always inside the zone (it is one of its cells), even for an L-shaped zone whose
 * centroid falls outside it. Null when the zone has no cell.
 */
function cellCentres(cells, zoneId) {
  return (Array.isArray(cells) ? cells : [])
    .filter((c) => c && c.zoneId === zoneId && Array.isArray(c.ring) && c.ring.length >= 4)
    .map((c) => {
      const pts = c.ring.slice(0, -1);
      return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
    });
}

function medoidCellCentre(cells, zoneId) {
  const centres = cellCentres(cells, zoneId);
  if (centres.length === 0) return null;
  const mean = [centres.reduce((a, p) => a + p[0], 0) / centres.length, centres.reduce((a, p) => a + p[1], 0) / centres.length];
  let best = centres[0];
  let bestD = Infinity;
  for (const p of centres) {
    const d = (p[0] - mean[0]) ** 2 + (p[1] - mean[1]) ** 2;
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/**
 * How much room a proposal label and a robot marker take on the ground, in metres at the
 * preview's framing (whole campus, ~0.9 m/px). The label is two short lines ("G4 PROPOSAL" over
 * the zone name) centred on its point; a robot marker is its name pill above the robot's point.
 */
export const PREVIEW_LABEL_CLEARANCE = Object.freeze({
  labelHalfWidthM: 50,
  labelHalfHeightM: 18,
  markerHalfWidthM: 55,
  markerAboveM: 45,
  markerBelowM: 12,
});

/**
 * The preview with each zone's label moved, if it must be, off the robots. Robot markers are
 * HTML above every map layer, and robots park near zone centres: at the medoid, three of the
 * four G4 labels sat under a marker (2026-10-23). Each label keeps its medoid cell when nothing
 * covers it there, else takes the zone cell nearest the medoid that no marker — and no label
 * already placed — covers; with no such cell it stays at the medoid. Robot positions are a
 * sample taken by the caller (when the preview is switched on), so labels do not chase
 * telemetry.
 *
 * @param {object|null} preview from `previewZonesForCampus`
 * @param {Array<{lat: number, lon: number}>} robots
 */
export function previewLabelsClearOf(preview, robots, clearance = PREVIEW_LABEL_CLEARANCE) {
  if (!preview || !Array.isArray(preview.zones)) return preview;
  const points = (Array.isArray(robots) ? robots : []).filter((r) => Number.isFinite(r?.lat) && Number.isFinite(r?.lon));
  if (points.length === 0) return preview;
  const { labelHalfWidthM: lw, labelHalfHeightM: lh, markerHalfWidthM: mw, markerAboveM: ma, markerBelowM: mb } = clearance;
  const kx = 111320 * Math.cos((points[0].lat * Math.PI) / 180);
  const ky = 110574;
  const underMarker = ([lon, lat]) =>
    points.some((r) => {
      const dx = (lon - r.lon) * kx;
      const dy = (lat - r.lat) * ky;
      return Math.abs(dx) < lw + mw && dy - lh < ma && dy + lh > -mb;
    });
  const placed = [];
  const onLabel = ([lon, lat]) => placed.some(([x, y]) => Math.abs((lon - x) * kx) < 2 * lw && Math.abs((lat - y) * ky) < 2 * lh);
  const zones = preview.zones.map((z) => {
    const medoid = z.labelAt;
    if (!Array.isArray(medoid)) return z;
    const candidates = cellCentres(preview.cells, z.zoneId).sort(
      (a, b) => (a[0] - medoid[0]) ** 2 * kx * kx + (a[1] - medoid[1]) ** 2 * ky * ky - ((b[0] - medoid[0]) ** 2 * kx * kx + (b[1] - medoid[1]) ** 2 * ky * ky)
    );
    const clear = [medoid, ...candidates].find((c) => !underMarker(c) && !onLabel(c)) || medoid;
    placed.push(clear);
    return clear === medoid ? z : { ...z, labelAt: clear };
  });
  return { ...preview, zones };
}

/** The label for a zone on the map: its name, prefixed for a preview so it cannot pass as live. */
export function zoneLabel(zone) {
  // "Alert zone": the published map's zone is what alert delivery uses — the one kind of area
  // on this map that is operational, which is why its label says so.
  if (zone.kind === ZONE_KIND.LIVE) return `Alert zone · ${zone.name}`;
  if (zone.kind === ZONE_KIND.UNRESOLVED) return 'Unresolved (no zone)';
  return `PROPOSAL · ${zone.name} · ${zone.zoneId}`;
}

/** The name repeated along a live zone's boundary (`dtaroLayers` ZONE_EDGE_LABEL). */
export function zoneEdgeLabel(zone) {
  return zone.kind === ZONE_KIND.LIVE ? `${zone.name} · alert zone` : zoneLabel(zone);
}

/**
 * GeoJSON for the zone sources. `hidden` is a Set of zone keys the operator switched off.
 *
 * @param {object[]} zones
 * @param {Set<string>} hidden
 */
export function zoneFeatureCollection(zones, hidden = new Set()) {
  return {
    type: 'FeatureCollection',
    features: zones
      .filter((z) => !hidden.has(z.key))
      .map((z) => ({
        type: 'Feature',
        id: z.key,
        properties: {
          key: z.key,
          kind: z.kind,
          color: z.color,
          textColor: z.textColor || zoneTextColor(z.color),
          label: zoneLabel(z),
          edgeLabel: zoneEdgeLabel(z),
          zoneId: z.zoneId,
          regionId: z.regionId,
        },
        geometry: z.geometry,
      })),
  };
}

/**
 * One label point per zone, on the northernmost vertex of its largest ring (the layer sets the
 * text just above it). Not the centre: a zone covering a whole campus has its centre where
 * robots park and stations stand, and a label there was hidden under the robot markers and
 * lost every label collision (seen in the browser, 2026-10-22). Labels are on their own source
 * so a zone made of several polygons is named once, not once per piece.
 */
export function zoneLabelCollection(zones, hidden = new Set()) {
  const features = [];
  for (const z of zones) {
    if (hidden.has(z.key)) continue;
    const anchor = Array.isArray(z.labelAt) ? z.labelAt : largestRingTop(z.geometry);
    if (!anchor) continue;
    features.push({
      type: 'Feature',
      id: z.key,
      properties: {
        key: z.key,
        kind: z.kind,
        label: zoneLabel(z),
        // A proposal's label is drawn as two short lines (dtaroLayers): kicker over name.
        ...(z.kind === ZONE_KIND.PREVIEW ? { labelKicker: `${z.layout ? `${z.layout} ` : ''}PROPOSAL`, labelName: z.name } : {}),
        color: z.color,
        textColor: z.textColor || zoneTextColor(z.color),
      },
      geometry: { type: 'Point', coordinates: anchor },
    });
  }
  return { type: 'FeatureCollection', features };
}

/**
 * The lines the boundary label runs along: each live zone's outer rings, simplified. H3 cell
 * outlines zig-zag at 60° every ~25 m, and Mapbox will not set text along that (and should not:
 * the text would bend at every cell), so the label follows a Douglas–Peucker simplification of
 * the ring instead. For label placement only — the drawn boundary is the exact published cells.
 *
 * @param {object[]} zones
 * @param {Set<string>} [hidden]
 * @param {number} [tolerance] degrees (~0.00025 ≈ 27 m at this latitude)
 */
export function zoneEdgeCollection(zones, hidden = new Set(), tolerance = 0.00025) {
  const features = [];
  for (const z of zones) {
    if (z.kind !== ZONE_KIND.LIVE || hidden.has(z.key)) continue;
    const g = z.geometry;
    const polygons = g?.type === 'MultiPolygon' ? g.coordinates : g?.type === 'Polygon' ? [g.coordinates] : [];
    for (const polygon of polygons) {
      const ring = polygon?.[0];
      if (!Array.isArray(ring) || ring.length < 4) continue;
      const line = simplifyLine(ring, tolerance);
      if (line.length < 2) continue;
      features.push({
        type: 'Feature',
        properties: { key: z.key, edgeLabel: zoneEdgeLabel(z), textColor: z.textColor || zoneTextColor(z.color) },
        geometry: { type: 'LineString', coordinates: line },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

/** Douglas–Peucker, iterative; keeps the first and last points (a closed ring stays closed). */
function simplifyLine(points, tolerance) {
  const pts = points.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length <= 2) return pts.map((p) => p.slice(0, 2));
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  // A closed ring's two ends coincide, so split it at its farthest point from the start first.
  let far = 0;
  let farD = -1;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  keep[far] = 1;
  const stack = [
    [0, far],
    [far, pts.length - 1],
  ];
  while (stack.length) {
    const [a, b] = stack.pop();
    let index = -1;
    let max = tolerance;
    for (let i = a + 1; i < b; i += 1) {
      const d = segmentDistance(pts[i], pts[a], pts[b]);
      if (d > max) {
        max = d;
        index = i;
      }
    }
    if (index !== -1) {
      keep[index] = 1;
      stack.push([a, index], [index, b]);
    }
  }
  return pts.filter((_, i) => keep[i]).map((p) => p.slice(0, 2));
}

function segmentDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function largestRingTop(geometry) {
  const polygons =
    geometry?.type === 'MultiPolygon' ? geometry.coordinates : geometry?.type === 'Polygon' ? [geometry.coordinates] : [];
  let best = null;
  for (const polygon of polygons) {
    const ring = polygon?.[0];
    if (!Array.isArray(ring) || ring.length < 4) continue;
    const pts = ring.slice(0, -1);
    if (!best || pts.length > best.length) best = pts;
  }
  if (!best) return null;
  return best.reduce((top, p) => (p[1] > top[1] ? p : top), best[0]).slice(0, 2);
}

/**
 * The zone that contains a point, or null. Names the zone at the map centre, so the name stays
 * on screen when no boundary is (a campus-wide zone seen from inside). Holes are honoured;
 * hidden zones are skipped.
 *
 * @param {object[]} zones
 * @param {number} lon
 * @param {number} lat
 * @param {Set<string>} [hidden]
 */
export function zoneAtPoint(zones, lon, lat, hidden = new Set()) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  for (const z of zones || []) {
    if (!z || hidden.has(z.key)) continue;
    const g = z.geometry;
    const polygons = g?.type === 'MultiPolygon' ? g.coordinates : g?.type === 'Polygon' ? [g.coordinates] : [];
    if (polygons.some((polygon) => inPolygon(polygon, lon, lat))) return z;
  }
  return null;
}

function inRing(ring, x, y) {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(polygon, x, y) {
  if (!Array.isArray(polygon) || !inRing(polygon[0], x, y)) return false;
  return !polygon.slice(1).some((hole) => inRing(hole, x, y));
}

/** A sentence for an empty zone layer, or null when zones are drawn. */
export function zoneStatusSentence(status) {
  switch (status) {
    case ZONE_STATUS.LOADING:
      return 'Loading the published zone map…';
    case ZONE_STATUS.LOAD_FAILED:
      return 'The zone map could not be loaded from the server.';
    case ZONE_STATUS.UNAVAILABLE:
      return 'No published zone map is pinned on the server.';
    case ZONE_STATUS.NO_CAMPUS:
      return 'Select a campus to show its zones.';
    case ZONE_STATUS.NO_REGION:
      return 'This campus has no operating region, so it has no zones.';
    case ZONE_STATUS.NO_ZONES:
      return "The published map assigns no zones in this campus's region.";
    default:
      return null;
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CAMPUS CAMERA — framings for a place, and the rule that only one wins
 *
 * Two things live here, and they are related:
 *
 *   1. CAMERA MODES (§28) — Overview / Operations / Follow / Reset. Framings,
 *      not effects; each one is chosen for what an operator can DO from it.
 *   2. THE SEQUENCER (§51) — the single mechanism that guarantees rapid filter
 *      changes converge on the LATEST target instead of leaving two flights
 *      fighting over the camera.
 *
 * ── Why bearing stays at 0 ────────────────────────────────────────────────
 * A rotated campus view photographs better. It also means north is no longer
 * screen-up, so an operator matching the map against the physical site has to
 * do the rotation in their head, and every robot heading has to be re-read
 * against a moved reference. §27 settles it: operational usefulness wins. Tilt
 * buys real depth information; a default bearing buys a nicer screenshot. The
 * operator can still rotate freely — this is only where the camera lands.
 *
 * Pure module: no React, no Mapbox.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const CAMPUS_CAMERA_MODE = Object.freeze({
  /** The whole campus in frame — the default arrival framing. */
  OVERVIEW: 'OVERVIEW',
  /** Closer and more tilted: the active operational area, buildings resolvable. */
  OPERATIONS: 'OPERATIONS',
  /** Track the selected robot, keeping the 3D environment around it. */
  FOLLOW: 'FOLLOW',
});

export const CAMPUS_CAMERA_MODE_ORDER = Object.freeze([
  CAMPUS_CAMERA_MODE.OVERVIEW,
  CAMPUS_CAMERA_MODE.OPERATIONS,
  CAMPUS_CAMERA_MODE.FOLLOW,
]);

export const CAMPUS_CAMERA_MODE_LABEL = Object.freeze({
  OVERVIEW: 'Overview',
  OPERATIONS: 'Operations',
  FOLLOW: 'Follow',
});

/**
 * Framings. `zoom` is where the camera settles; `pitch` is applied on arrival,
 * never during a long flight (see ARCHITECTURE.md — a pitched flight across
 * many zoom levels with terrain enabled ends pointing at atmosphere).
 */
export const CAMPUS_CAMERA_PRESETS = Object.freeze({
  OVERVIEW: Object.freeze({ zoom: 16.6, pitch: 48, bearing: 0 }),
  OPERATIONS: Object.freeze({ zoom: 17.8, pitch: 58, bearing: 0 }),
  FOLLOW: Object.freeze({ zoom: 18.2, pitch: 55, bearing: 0 }),
});

export function campusCameraFor(mode) {
  return CAMPUS_CAMERA_PRESETS[mode] || CAMPUS_CAMERA_PRESETS.OVERVIEW;
}

/**
 * The camera the map is CREATED with when it opens on a campus: the Overview zoom over the
 * middle of the campus boundary box, looking straight down. Opening there (instead of on the
 * globe, then flying in once the style and terrain have loaded) is what removes the
 * world-to-campus transition — the page used to spend ~6.5 s on the globe and ~3 s more flying
 * and tilting (measured 2026-10-23).
 *
 * Why flat (pitch 0), not the Overview tilt: the map exists before any elevation data does, so
 * Mapbox places the centre at sea level. Tilted, the camera stands ~600 m south of the centre,
 * often over another elevation tile; when that tile arrives first, Mapbox finds the camera
 * under the ~900 m Bengaluru ground and lifts it (`_constrainCamera`), and the view jumped to
 * z15.87 with no camera call at all — at a random moment, 23–47 s in headless runs. Looking
 * straight down, camera and centre share one tile, rise together, and nothing jumps. The 3D
 * tilt is one click away (Overview / Operations).
 *
 * @param {[[number, number], [number, number]] | null} bounds `[[west, south], [east, north]]`
 * @returns {{lon: number, lat: number, zoom: number, pitch: number, bearing: number} | null}
 */
export function campusStartCamera(bounds) {
  const [[west, south] = [], [east, north] = []] = Array.isArray(bounds) ? bounds : [];
  if (![west, south, east, north].every(Number.isFinite)) return null;
  const { zoom, bearing } = CAMPUS_CAMERA_PRESETS.OVERVIEW;
  return { lon: (west + east) / 2, lat: (south + north) / 2, zoom, pitch: 0, bearing };
}

/**
 * Is the camera already showing `target` — centre within `metres`, zoom within `zoomDelta`?
 * A focus that is already on screen is not re-flown: the map opens at the campus, and the
 * campus record (whose centre differs by ~150 m from the boundary's middle) arriving a moment
 * later must not start a flight to a place the operator is already looking at.
 */
export function isCameraNear(current, target, { metres = 250, zoomDelta = 0.75 } = {}) {
  const values = [current?.lon, current?.lat, current?.zoom, target?.lon, target?.lat, target?.zoom];
  if (!values.every(Number.isFinite)) return false;
  const kx = 111320 * Math.cos((target.lat * Math.PI) / 180);
  const distance = Math.hypot((current.lon - target.lon) * kx, (current.lat - target.lat) * 110574);
  return distance <= metres && Math.abs(current.zoom - target.zoom) <= zoomDelta;
}

const mercatorX = (lon) => (lon + 180) / 360;
const mercatorY = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
const mercatorLon = (x) => x * 360 - 180;
const mercatorLat = (y) => (360 / Math.PI) * Math.atan(Math.exp(Math.PI * (1 - 2 * y))) - 90;

/**
 * The flat, north-up camera that frames `[[minLon, minLat], [maxLon, maxLat]]` inside a
 * `width` × `height` viewport, keeping `padding` px clear on each side.
 *
 * Why not `map.fitBounds`: on the 3D campus map (globe + terrain, pitched) Mapbox fits against
 * the terrain, and its answer moves by about a zoom level once the elevation tiles arrive — the
 * same bounds framed at z16.4 before them and z15.2–15.4 after (measured 2026-10-23), leaving
 * the RNSIT zones a thumbnail. And a `padding` passed to a camera call is kept by the map as
 * its standing padding, shifting every later Overview / Follow / Recenter. This is plain Web
 * Mercator arithmetic (512 px tiles, as Mapbox), returned as a centre + zoom the caller eases
 * to with no `padding`: the off-centre padding is folded into the centre instead.
 *
 * @returns {{center: [number, number], zoom: number} | null} null for empty bounds or a viewport
 *   with no room left inside its padding.
 */
export function topDownCameraForBounds(bounds, { width, height, padding = {}, maxZoom = 19 } = {}) {
  const [[minLon, minLat] = [], [maxLon, maxLat] = []] = Array.isArray(bounds) ? bounds : [];
  if (![minLon, minLat, maxLon, maxLat, width, height].every(Number.isFinite)) return null;
  const { top = 0, bottom = 0, left = 0, right = 0 } = padding;
  const roomX = width - left - right;
  const roomY = height - top - bottom;
  if (roomX <= 0 || roomY <= 0) return null;

  const x0 = mercatorX(minLon);
  const x1 = mercatorX(maxLon);
  const y0 = mercatorY(maxLat); // north is the smaller y
  const y1 = mercatorY(minLat);
  // Pixels per world unit that fit both spans (a degenerate span — a single point — fits any).
  const fit = Math.min(x1 > x0 ? roomX / (x1 - x0) : Infinity, y1 > y0 ? roomY / (y1 - y0) : Infinity);
  const zoom = Math.min(maxZoom, Number.isFinite(fit) ? Math.log2(fit / 512) : maxZoom);
  const scale = 512 * 2 ** zoom;
  // Put the bounds' centre at the centre of the padded area, not of the viewport.
  const cx = (x0 + x1) / 2 - (left - right) / 2 / scale;
  const cy = (y0 + y1) / 2 - (top - bottom) / 2 / scale;
  return { center: [mercatorLon(cx), mercatorLat(cy)], zoom };
}

/**
 * The camera-command sequencer.
 *
 * Every camera command takes a token. A command may only touch the map while
 * its token is still the newest one issued. Selecting India → Karnataka →
 * Bengaluru → RNSIT in under a second issues four commands; the first three
 * are superseded before their deferred stages (the tilt, the campus reveal)
 * ever run, so the camera converges on RNSIT rather than tilting toward
 * Karnataka after arriving at the campus.
 *
 * Deterministic and side-effect free, so the convergence rule is a unit test
 * rather than something judged by watching a map.
 */
export function createCameraSequencer() {
  let issued = 0;
  // Set by `cancel`, cleared by the next `begin`. Without it, cancelling would
  // leave the newly-incremented number looking like a live token, so a reset
  // that is meant to stop all camera work would hand one out.
  let revoked = false;

  return {
    /** Claim the camera. Every earlier token is superseded from this moment. */
    begin() {
      issued += 1;
      revoked = false;
      return issued;
    },
    /** May a deferred stage of `token` still act? */
    isCurrent(token) {
      return !revoked && token === issued && token > 0;
    },
    /** Supersede everything outstanding without issuing a usable token. */
    cancel() {
      issued += 1;
      revoked = true;
    },
    get current() {
      return issued;
    },
  };
}

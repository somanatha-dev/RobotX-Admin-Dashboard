/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CANONICAL ROBOT → WORLD TRANSFORM
 *
 * This module is THE ONLY place in the frontend where robot state becomes a
 * world position. Nothing else may recompute it.
 *
 *      Robot state (telemetry / REST)
 *                  │
 *                  ▼
 *        toRobotWorldAnchor()          ← here, once
 *                  │
 *         ┌────────┴────────┐
 *         ▼                 ▼
 *   2D marker renderer   future 3D robot renderer
 *
 * Why this exists as its own module:
 *   • A second, slightly-different position formula for a future 3D renderer
 *     is the single most likely way this migration goes wrong. There is one
 *     formula, here, and both representations consume its output.
 *   • It is deliberately PURE — no `mapbox-gl`, no React, no `@/` alias — so
 *     the architectural seam test can load it under plain Node, and so a
 *     future renderer built on a different stack can reuse it verbatim.
 *
 * ── Coordinate model ──────────────────────────────────────────────────────
 * RobotX has exactly one world coordinate system and this does not introduce
 * a second one: WGS84 lng/lat degrees, which is what the backend stores
 * (`Robot.lat` / `Robot.lon`), what telemetry emits, and what Mapbox consumes.
 * The only thing added is an explicit third axis.
 *
 *   position : { lng, lat, altitude }   altitude = metres above ground
 *   rotation : { yaw, pitch, roll }     degrees; yaw = heading, cw from north
 *   scale    : number                   uniform; 1 = nominal
 *
 * ── On the third axis ─────────────────────────────────────────────────────
 * Telemetry carries no altitude channel today — see
 * `Backend/src/sockets/handlers/telemetry.handler.js`, which persists
 * lat/lon/heading and no elevation. That is a fact about the current data
 * contract, NOT a licence to hard-code `z = 0` through the whole renderer
 * stack. So the anchor always carries an `altitude` and an `altitudeSource`
 * saying where it came from. The 2D renderer ignores altitude (a DOM marker
 * has nowhere to put it); a future 3D renderer reads the same field and gets
 * real elevation for free the day telemetry starts sending it, with no change
 * to state, transport, or this module's callers.
 *
 * Likewise `rotation` carries pitch and roll. Both are 0 today because no
 * robot reports them. They are named here so a future 3D chassis does not
 * need a new transform to express attitude.
 *
 * ── What this module must NEVER do ────────────────────────────────────────
 * Write. It reads robot state and returns a value. The map is a visualization
 * of state, never a source of it.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const FULL_TURN_DEG = 360;

function finiteNumberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Normalize any degree value into [0, 360). */
export function normalizeDegrees(deg) {
  const n = finiteNumberOrNull(deg);
  if (n === null) return null;
  const m = n % FULL_TURN_DEG;
  return m < 0 ? m + FULL_TURN_DEG : m;
}

/**
 * Altitude provenance. Kept explicit so a consumer can tell "the robot is at
 * ground level" apart from "we do not know its elevation and assumed ground".
 */
export const ALTITUDE_SOURCE = Object.freeze({
  TELEMETRY: 'telemetry',
  GROUND_ASSUMED: 'ground-assumed',
});

/**
 * Read an altitude off robot state if the contract ever grows one.
 * Returns `{ altitude, altitudeSource }` — never null, never throws.
 */
function readAltitude(robotState) {
  const altitude =
    finiteNumberOrNull(robotState?.altitude) ??
    finiteNumberOrNull(robotState?.alt) ??
    finiteNumberOrNull(robotState?.elevation);

  if (altitude === null) {
    return { altitude: 0, altitudeSource: ALTITUDE_SOURCE.GROUND_ASSUMED };
  }
  return { altitude, altitudeSource: ALTITUDE_SOURCE.TELEMETRY };
}

/**
 * Robot state → RobotWorldAnchor.
 *
 * Accepts the shapes the app actually produces: a REST robot row, a
 * `robot:update` telemetry payload, or the merged `{ ...robot, ...robot.live }`
 * form `syncMarkersToRobots` builds. `lat`/`lon` are the authoritative
 * position fields in every one of them.
 *
 * @returns {null | {
 *   robotId: string,
 *   position: { lng: number, lat: number, altitude: number },
 *   rotation: { yaw: number, pitch: number, roll: number },
 *   scale: number,
 *   hasHeading: boolean,
 *   altitudeSource: string,
 *   timestamp: number | null,
 * }}
 * `null` when the robot has no usable position — callers must treat that as
 * "not placeable", never as origin (0, 0).
 */
export function toRobotWorldAnchor(robotState) {
  const robotId = String(robotState?.robotId || '').trim();
  if (!robotId) return null;

  const lat = finiteNumberOrNull(robotState?.lat);
  const lng = finiteNumberOrNull(robotState?.lon);
  if (lat === null || lng === null) return null;

  const { altitude, altitudeSource } = readAltitude(robotState);

  const yaw = normalizeDegrees(robotState?.heading);
  const timestamp =
    finiteNumberOrNull(robotState?.timestamp) ??
    finiteNumberOrNull(robotState?.updatedAtMs) ??
    (typeof robotState?.updatedAt === 'string' ? Date.parse(robotState.updatedAt) || null : null);

  return {
    robotId,
    position: { lng, lat, altitude },
    // pitch/roll are structurally present and always 0 — no robot reports
    // attitude. A future 3D chassis fills them without a transform change.
    rotation: { yaw: yaw ?? 0, pitch: 0, roll: 0 },
    scale: 1,
    hasHeading: yaw !== null,
    altitudeSource,
    timestamp,
  };
}

/** Anchor → the `[lng, lat]` pair Mapbox's 2D APIs take. Drops altitude. */
export function anchorToLngLat(anchor) {
  const lng = finiteNumberOrNull(anchor?.position?.lng);
  const lat = finiteNumberOrNull(anchor?.position?.lat);
  if (lng === null || lat === null) return null;
  return [lng, lat];
}

/** Structural equality on the parts that affect what gets drawn. */
export function anchorsAreEqual(a, b) {
  if (!a || !b) return a === b;
  return (
    a.position.lng === b.position.lng &&
    a.position.lat === b.position.lat &&
    a.position.altitude === b.position.altitude &&
    a.rotation.yaw === b.rotation.yaw &&
    a.rotation.pitch === b.rotation.pitch &&
    a.rotation.roll === b.rotation.roll &&
    a.scale === b.scale
  );
}

/**
 * WORLD yaw → SCREEN yaw.
 *
 * A robot's heading is a world fact: degrees clockwise from true north. How
 * many degrees its *icon* must be rotated on screen is a view fact, and the
 * two stop agreeing the moment the camera can rotate — which it now can, so
 * this correction is required, not cosmetic.
 *
 * This lives in the world module rather than in the map or the marker code so
 * the rotation mathematics is not baked into the map engine (and so the 2D
 * and any future renderer cannot drift apart on it).
 *
 * A future 3D robot renderer will NOT call this. A mesh placed in the scene
 * is rotated by its world yaw and the 3D camera applies the bearing itself;
 * pre-compensating would double-count it. Screen-space billboards — which is
 * exactly what the current 2D marker is — are the only consumers.
 */
export function worldYawToScreenYaw(worldYawDeg, cameraBearingDeg) {
  const yaw = normalizeDegrees(worldYawDeg);
  if (yaw === null) return null;
  const bearing = normalizeDegrees(cameraBearingDeg) ?? 0;
  return normalizeDegrees(yaw - bearing);
}

/**
 * Linear interpolation between two anchor positions, used by renderers to
 * animate between telemetry ticks. Shared so a future 3D renderer moves along
 * the same path the 2D marker does instead of inventing its own easing over a
 * different formula.
 */
export function interpolateAnchorPosition(from, to, t) {
  const clamped = Math.max(0, Math.min(1, finiteNumberOrNull(t) ?? 1));
  if (!from) return to ? { ...to.position } : null;
  if (!to) return { ...from.position };
  return {
    lng: from.position.lng + (to.position.lng - from.position.lng) * clamped,
    lat: from.position.lat + (to.position.lat - from.position.lat) * clamped,
    altitude: from.position.altitude + (to.position.altitude - from.position.altitude) * clamped,
  };
}

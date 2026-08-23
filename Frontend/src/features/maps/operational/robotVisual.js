/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RobotVisual — the semantic state a robot representation needs
 *
 * The stable contract between RobotX state and whatever draws a robot. Both
 * the current 2D marker and a future 3D robot consume THIS, not raw telemetry
 * and not each other's internals.
 *
 *   RobotVisual
 *       ├── id
 *       ├── anchor          ← RobotWorldAnchor (position / rotation / scale)
 *       ├── status
 *       ├── availability
 *       ├── battery
 *       ├── health
 *       ├── selected
 *       ├── timestamp
 *       └── representation  ← which renderer draws it ('2d' today)
 *
 * ── Deliberately NOT here ─────────────────────────────────────────────────
 * `wheelRotation`, `suspensionHeight`, `bodyMesh`, `lidarMesh`, `cameraBone`
 * and friends. Speculative 3D-only properties are not modelled before a 3D
 * robot exists; a renderer that needs them later owns them, and adding them
 * then does not disturb this contract or anything upstream of it.
 *
 * ── Honesty about `availability` and `health` ─────────────────────────────
 * These are *derived visual classifications* of the status vocabulary the
 * backend already emits. They are not new business facts, they do not feed
 * anything but pixels, and nothing here invents a status the backend did not
 * send. `status` is passed through verbatim so an operator always sees the
 * real value.
 *
 * Pure module: no `mapbox-gl`, no React, no `@/` alias — loadable by the
 * architectural seam test under plain Node.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { normalizeStatus } from '../../../lib/robotStatus.js';
import { toRobotWorldAnchor } from '../world/robotWorldAnchor.js';

/** Renderer names. The registry resolves these; see robotRendererRegistry.js. */
export const ROBOT_REPRESENTATION = Object.freeze({
  /** CURRENT — a flat, screen-facing operational marker. */
  TWO_D: '2d',
  /** FUTURE — a real 3D robot mesh. No renderer is registered for this yet. */
  THREE_D: '3d',
});

export const ROBOT_AVAILABILITY = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  BUSY: 'BUSY',
  UNAVAILABLE: 'UNAVAILABLE',
  UNKNOWN: 'UNKNOWN',
});

export const ROBOT_HEALTH = Object.freeze({
  OK: 'OK',
  DEGRADED: 'DEGRADED',
  FAULT: 'FAULT',
  UNKNOWN: 'UNKNOWN',
});

const BUSY_STATUSES = new Set(['ACTIVE', 'BUSY', 'ASSIGNED', 'DELIVERING', 'RETURNING']);
const FAULT_STATUSES = new Set(['ERROR', 'FAILED']);
const DEGRADED_STATUSES = new Set(['ISSUES', 'PAUSED']);
const UNAVAILABLE_STATUSES = new Set(['OFFLINE', 'CHARGING', 'PAUSED', 'ERROR', 'ISSUES', 'RETIRED']);

function deriveAvailability(status, isOnline) {
  if (isOnline === false) return ROBOT_AVAILABILITY.UNAVAILABLE;
  const s = normalizeStatus(status);
  if (!s) return ROBOT_AVAILABILITY.UNKNOWN;
  if (UNAVAILABLE_STATUSES.has(s)) return ROBOT_AVAILABILITY.UNAVAILABLE;
  if (BUSY_STATUSES.has(s)) return ROBOT_AVAILABILITY.BUSY;
  if (s === 'IDLE') return ROBOT_AVAILABILITY.AVAILABLE;
  return ROBOT_AVAILABILITY.UNKNOWN;
}

function deriveHealth(robotState) {
  if (robotState?.fault || normalizeStatus(robotState?.healthStatus) === 'FAULT') {
    return ROBOT_HEALTH.FAULT;
  }
  const s = normalizeStatus(robotState?.status);
  if (FAULT_STATUSES.has(s)) return ROBOT_HEALTH.FAULT;
  if (DEGRADED_STATUSES.has(s)) return ROBOT_HEALTH.DEGRADED;
  if (!s) return ROBOT_HEALTH.UNKNOWN;
  return ROBOT_HEALTH.OK;
}

// ── Robot identity colour ───────────────────────────────────────────────────
// One deterministic id → colour function for the whole operational layer, so a
// robot's marker, its route lines and any future 3D livery agree. Previously
// this lived inside useRobotStream; it is identity, not marker chrome, so it
// belongs with the semantic model.

function hashStringToInt(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hslToHex(h, s, l) {
  const _s = s / 100;
  const _l = l / 100;
  const c = (1 - Math.abs(2 * _l - 1)) * _s;
  const hp = (h % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp >= 0 && hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp >= 1 && hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp >= 2 && hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp >= 3 && hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp >= 4 && hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = _l - c / 2;
  const toHex = (n) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
}

/** Deterministic identity colour for a robot id. */
export function colorForRobot(robotId) {
  const id = String(robotId || 'robot');
  return hslToHex(hashStringToInt(id) % 360, 78, 55);
}

/**
 * Robot state → RobotVisual.
 *
 * @param {object} robotState  a REST robot row, a `robot:update` payload, or
 *                             the merged `{ ...robot, ...robot.live }` shape.
 * @param {object} [options]
 * @param {string|null} [options.selectedRobotId]  from application state —
 *        never from a DOM element or a scene object (see §19 of the seam doc).
 * @param {string} [options.representation]        which renderer should draw it.
 * @returns {null | object}  `null` when the robot has no usable world position.
 */
export function toRobotVisual(robotState, options = {}) {
  const anchor = toRobotWorldAnchor(robotState);
  if (!anchor) return null;

  const { selectedRobotId = null, representation = ROBOT_REPRESENTATION.TWO_D } = options;

  const id = anchor.robotId;
  const status = typeof robotState?.status === 'string' ? robotState.status : null;
  const isOnline = typeof robotState?.isOnline === 'boolean' ? robotState.isOnline : null;
  const battery =
    typeof robotState?.battery === 'number' && Number.isFinite(robotState.battery)
      ? Math.max(0, Math.min(100, robotState.battery))
      : null;

  return {
    id,
    anchor,
    // Passed through verbatim — the operator sees the backend's own value.
    status,
    availability: deriveAvailability(status, isOnline),
    health: deriveHealth(robotState),
    battery,
    isOnline,
    selected: Boolean(selectedRobotId) && selectedRobotId === id,
    timestamp: anchor.timestamp,
    taskId: robotState?.task?.taskId || robotState?.currentTask?.taskId || robotState?.currentTaskId || null,
    label: id,
    color: colorForRobot(id),
    representation,
  };
}

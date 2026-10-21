/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ROBOT IDENTITY COLOURS — no two robots on the map share a colour
 *
 * A robot's colour is what an operator follows across the map: its marker, its
 * route and its Pickup / Drop pins. It used to be `hash(robotId) % 360` as a
 * hue, which put different robots on near-identical hues: in production on
 * 2026-10-21, SIM-7B7FA70643A6 (#7de633) and SIM-B577AD16BCE6 (#5de633) were
 * both the same green, and locally three robots were the same blue.
 *
 * Now each robot on the map takes a colour from a curated palette of distinct
 * colours. Its preferred slot comes from its id (so a robot keeps its colour
 * while the fleet is unchanged, on every screen); a robot whose slot is taken
 * moves to the next free one, processed in id order, so the result does not
 * depend on the order the fleet arrived in. Up to `ROBOT_PALETTE.length` robots
 * are guaranteed distinct; beyond that the old hue formula is the fallback.
 *
 * The palette avoids the colours this map already uses to mean something —
 * error red, charging / warning amber, battery green — and every colour carries
 * white text (contrast ≥ 4.5:1).
 *
 * Pure apart from the one assignment held for the map (`setFleetRobotIds`).
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const ROBOT_PALETTE = Object.freeze([
  '#2563eb', // blue
  '#c2410c', // orange
  '#7c3aed', // violet
  '#0f766e', // teal
  '#be185d', // raspberry
  '#4d7c0f', // olive
  '#a16207', // ochre
  '#0369a1', // ocean
  '#475569', // slate
  '#86198f', // plum
]);

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

/** The colour of a robot with no assignment, or beyond the palette: the original hue formula. */
export function fallbackRobotColor(robotId) {
  return hslToHex(hashStringToInt(String(robotId || 'robot')) % 360, 78, 55);
}

/**
 * Distinct colours for a fleet: robot id → palette colour.
 *
 * @param {string[]} robotIds
 * @param {readonly string[]} [palette]
 * @returns {Map<string, string>}
 */
export function assignRobotColors(robotIds, palette = ROBOT_PALETTE) {
  const ids = [...new Set((Array.isArray(robotIds) ? robotIds : []).map((id) => String(id || '').trim()).filter(Boolean))].sort();
  const taken = new Set();
  const colors = new Map();
  for (const id of ids) {
    if (taken.size >= palette.length) {
      colors.set(id, fallbackRobotColor(id));
      continue;
    }
    let slot = hashStringToInt(id) % palette.length;
    while (taken.has(slot)) slot = (slot + 1) % palette.length;
    taken.add(slot);
    colors.set(id, palette[slot]);
  }
  return colors;
}

// ── The assignment held for the map ─────────────────────────────────────────
// Set from the robots the map shows (`useRobotStream`), read by `colorForRobot`
// (robotVisual.js) for the marker, the route and the mission pins alike.

let fleetColors = new Map();

/**
 * Replace the fleet the colours are assigned over.
 *
 * @param {string[]} robotIds
 * @returns {string[]} the ids whose colour changed (or that are new), so their visuals can be redrawn
 */
export function setFleetRobotIds(robotIds) {
  const next = assignRobotColors(robotIds);
  const changed = [];
  for (const [id, color] of next) if (fleetColors.get(id) !== color) changed.push(id);
  fleetColors = next;
  return changed;
}

/** The robot's colour: its fleet assignment, or the fallback when it has none. */
export function robotColorFor(robotId) {
  const id = String(robotId || '').trim();
  return fleetColors.get(id) || fallbackRobotColor(id || 'robot');
}

/** Test seam: forget the fleet assignment. */
export function resetFleetColors() {
  fleetColors = new Map();
}

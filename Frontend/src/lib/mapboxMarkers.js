/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 2D ROBOT MARKER — a flat operational marker on a 3D map
 *
 * This is the ONLY robot representation in the product today, and it is
 * deliberately, permanently 2D. There is no mesh here, no extruded arrow, no
 * placeholder body, no primitive standing in for a chassis. A future 3D robot
 * is a *different renderer* registered against the same RobotVisual — see
 * `features/maps/ARCHITECTURE.md`. Nothing in this file is a step toward one.
 *
 * ── The depth decision (§25), stated once, here ───────────────────────────
 * The environment now has real depth: pitch, bearing and terrain. A flat icon
 * has to decide how it relates to that, and the two honest options are
 * "painted on the ground" or "screen-space badge floating above the point".
 * Picking one loses something either way — a ground decal becomes unreadable
 * at a steep tilt; a pure screen badge stops telling you *where on the ground*
 * the robot is once buildings and terrain get between you and it.
 *
 * So the marker is split, and each half makes its own choice:
 *
 *   GROUND PLANE HALF   contact shadow, selection ring, and the vehicle icon.
 *                       Vertically compressed by cos(pitch) so it reads as
 *                       lying on the ground, and rotated by (heading − camera
 *                       bearing) so the direction it points is the direction
 *                       the robot is actually travelling, at any camera angle.
 *
 *   SCREEN-FACING HALF  id chip, battery bar, status glyph, leader line.
 *                       Always upright, always legible, never squashed.
 *
 * Both halves hang off ONE element anchored at the robot's exact coordinate,
 * so there is a single position to be right about. Mapbox projects that
 * element every frame, including onto terrain — the marker's world position
 * stays synchronised with the robot's real position while everything drawn
 * remains two-dimensional.
 *
 * DOM markers also draw above the WebGL canvas, so 3D buildings never swallow
 * a robot (§9). That is a property of this choice, not an accident.
 *
 * ── Anchor geometry (unchanged, and load-bearing) ─────────────────────────
 * `root` is exactly 26×36 px and `anchor: 'center'`, so the map coordinate
 * lands at pixel (13, 18) — the centre of the vehicle body. Mapbox GL owns
 * `root.style.transform` (it writes its own translate onto the element passed
 * to `new mapboxgl.Marker({element})` every frame), so OUR transforms go on
 * `scaleWrap`, a same-size child, and never on `root`. `root`'s DOM box stays
 * 26×36 at every zoom, so the anchor calculation stays exact regardless of
 * scale. All chrome is positioned outside that box so it cannot perturb it.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const STATUS_ICONS = {
  CHARGING: '⚡',
  ISSUES: '⚠',
  ERROR: '✕',
  OFFLINE: '○',
  PAUSED: '‖',
};

function batteryColor(pct) {
  if (pct >= 50) return '#22c55e';
  if (pct >= 20) return '#f59e0b';
  return '#ef4444';
}

export function injectPulseCSS() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('robotx-pulse-css')) return;
  const s = document.createElement('style');
  s.id = 'robotx-pulse-css';
  s.textContent = `
    @keyframes rx-pulse-a {
      0%   { transform: scale(1);   opacity: 0.70; }
      70%  { transform: scale(2.6); opacity: 0; }
      100% { transform: scale(2.6); opacity: 0; }
    }
    @keyframes rx-pulse-b {
      0%   { transform: scale(1);   opacity: 0.50; }
      70%  { transform: scale(1.9); opacity: 0; }
      100% { transform: scale(1.9); opacity: 0; }
    }
    @keyframes rx-select-ring {
      0%   { transform: translate(-50%,-50%) scale(0.85); opacity: 0.85; }
      70%  { transform: translate(-50%,-50%) scale(1.75); opacity: 0; }
      100% { transform: translate(-50%,-50%) scale(1.75); opacity: 0; }
    }
  `;
  document.head.appendChild(s);
}

/**
 * Top-down compact delivery vehicle. ViewBox 26×36; body y=8→32, nose arrow
 * y=0→10. Unrotated, the arrow points to the top of the SVG.
 *
 * Rotation is applied by `applyMarkerHeading` using a SCREEN yaw computed in
 * `world/robotWorldAnchor.js` — this file does not know how heading relates to
 * camera bearing, on purpose (§17: the rotation mathematics does not live in
 * the map or the marker).
 */
function carSvg(color) {
  return `<svg width="26" height="36" viewBox="0 0 26 36" fill="none" xmlns="http://www.w3.org/2000/svg">
    <!-- Direction arrow — large white triangle, impossible to miss -->
    <polygon points="13,0 20,10 6,10" fill="white" opacity="0.95"/>
    <polygon points="13,2 18,9 8,9"   fill="${color}"/>

    <!-- Car body -->
    <rect x="3" y="8" width="20" height="24" rx="5" fill="${color}"/>
    <!-- White border for contrast on dark map -->
    <rect x="3" y="8" width="20" height="24" rx="5" stroke="white" stroke-width="1.5" fill="none"/>

    <!-- Windshield (front) -->
    <rect x="6" y="10" width="14" height="7" rx="2.5" fill="rgba(255,255,255,0.28)"/>
    <!-- Windshield highlight -->
    <rect x="7" y="11" width="12" height="2" rx="1" fill="rgba(255,255,255,0.40)"/>

    <!-- Cargo bay (rear) -->
    <rect x="6" y="20" width="14" height="9" rx="2" fill="rgba(0,0,0,0.12)"/>

    <!-- Tail lights -->
    <rect x="5"  y="29" width="4" height="2" rx="1" fill="rgba(255,60,60,0.85)"/>
    <rect x="17" y="29" width="4" height="2" rx="1" fill="rgba(255,60,60,0.85)"/>
  </svg>`;
}

export function createRobotMarkerElement(color, labelText) {
  injectPulseCSS();

  const root = document.createElement('div');
  root.className = 'robot-marker-root';
  root.style.cssText = [
    // Mapbox's own stylesheet sets `.mapboxgl-marker { position:absolute }` on
    // this exact element. An inline `position:relative` would win over that
    // (inline beats class specificity) and pull `root` into normal document
    // flow, stacking every marker under the ones created before it. Matching
    // `absolute` keeps the two in agreement; it still works as the containing
    // block for the absolutely-positioned children below.
    'position:absolute',
    'width:26px',
    'height:36px',
    // The root itself is inert — only the explicit hit target below and the id
    // chip accept pointer events, so map panning still works everywhere else.
    'pointer-events:none',
    'z-index:10',
  ].join(';');

  // ── Zoom scale wrapper — our transform, never Mapbox's ────────────────────
  const scaleWrap = document.createElement('div');
  scaleWrap.className = 'robot-marker-scale';
  scaleWrap.style.cssText = [
    'position:absolute',
    'inset:0',
    'transform-origin:50% 50%',
    'will-change:transform',
  ].join(';');

  // ══ GROUND PLANE HALF ═════════════════════════════════════════════════════
  // Compressed by cos(pitch) so everything inside reads as lying on the map's
  // ground plane rather than standing up out of it.
  const ground = document.createElement('div');
  ground.className = 'robot-marker-ground';
  ground.style.cssText = [
    'position:absolute',
    'inset:0',
    'transform-origin:50% 50%',
    'will-change:transform',
  ].join(';');

  // Selection ring — on the ground, so selecting a robot reads as a spotlight
  // cast at its position rather than a sticker floating over the city.
  const selectRing = document.createElement('div');
  selectRing.className = 'robot-marker-select-ring';
  selectRing.style.cssText = [
    'position:absolute',
    'top:50%',
    'left:50%',
    'transform:translate(-50%,-50%)',
    'width:34px',
    'height:34px',
    'border-radius:50%',
    `border:2px solid ${color}`,
    `box-shadow:0 0 0 3px ${color}22, 0 0 14px ${color}66`,
    'opacity:0',
    'transition:opacity 0.18s ease',
    'pointer-events:none',
    'z-index:0',
  ].join(';');

  // Selection echo — the pulse that makes a newly selected robot findable in a
  // busy fleet. Animation is only attached while selected (see setMarkerSelected).
  const selectPulse = document.createElement('div');
  selectPulse.className = 'robot-marker-select-pulse';
  selectPulse.style.cssText = [
    'position:absolute',
    'top:50%',
    'left:50%',
    'transform:translate(-50%,-50%)',
    'width:30px',
    'height:30px',
    'border-radius:50%',
    `border:2px solid ${color}`,
    'opacity:0',
    'pointer-events:none',
    'z-index:0',
  ].join(';');

  // Contact shadow — the exact world point, always readable even when the
  // vehicle icon is heavily foreshortened at a steep tilt.
  const contact = document.createElement('div');
  contact.className = 'robot-marker-contact';
  contact.style.cssText = [
    'position:absolute',
    'top:50%',
    'left:50%',
    'transform:translate(-50%,-50%)',
    'width:22px',
    'height:22px',
    'border-radius:50%',
    'background:radial-gradient(circle, rgba(2,6,23,0.55) 0%, rgba(2,6,23,0.28) 55%, rgba(2,6,23,0) 72%)',
    'pointer-events:none',
    'z-index:1',
  ].join(';');

  // Vehicle icon — rotates with heading, inside the flattened ground layer so
  // the rotation happens in the ground plane and the projection is applied
  // after it. (Doing both on one element would compose in the wrong order and
  // skew the icon instead of laying it down.)
  const car = document.createElement('div');
  car.className = 'robot-car';
  car.style.cssText = [
    'position:absolute',
    'inset:0',
    'transform-origin:50% 50%',
    'will-change:transform',
    'z-index:2',
    // No drop-shadow filter — it blurs during CSS rotation and smears the icon.
  ].join(';');
  car.innerHTML = carSvg(color);

  ground.appendChild(selectPulse);
  ground.appendChild(selectRing);
  ground.appendChild(contact);
  ground.appendChild(car);

  // ══ SCREEN-FACING HALF ════════════════════════════════════════════════════

  // Leader line from the ground point up to the id chip. Without it, a tilted
  // camera leaves the chip visually adrift from the point it describes.
  const leader = document.createElement('div');
  leader.className = 'robot-marker-leader';
  leader.style.cssText = [
    'position:absolute',
    'left:50%',
    'bottom:50%',
    'width:0',
    'height:24px',
    'border-left:1.5px solid rgba(255,255,255,0.45)',
    'transform:translateX(-50%)',
    'pointer-events:none',
    'z-index:3',
  ].join(';');

  // Robot ID chip — outside the 26×36 anchor box so it cannot affect geometry.
  const label = document.createElement('div');
  label.className = 'robot-label';
  label.textContent = labelText;
  label.style.cssText = [
    'position:absolute',
    'left:50%',
    'bottom:100%',
    'transform:translate(-50%,-6px)',
    `background:${color}`,
    'color:#fff',
    'padding:2px 8px',
    'border-radius:999px',
    'font-size:10px',
    'font-weight:800',
    'letter-spacing:0.05em',
    'white-space:nowrap',
    'z-index:20',
    'box-shadow:0 2px 6px rgba(0,0,0,0.55)',
    'border:1.5px solid rgba(255,255,255,0.7)',
    'pointer-events:auto',
    'cursor:pointer',
    'transition:box-shadow 0.18s ease, border-color 0.18s ease',
  ].join(';');

  // Battery bar — outside the anchor box, screen-facing.
  const batteryWrap = document.createElement('div');
  batteryWrap.style.cssText = [
    'position:absolute',
    'left:50%',
    'top:100%',
    'transform:translateX(-50%)',
    'margin-top:3px',
    'width:26px',
    'height:4px',
    'background:rgba(15,23,42,0.55)',
    'border-radius:2px',
    'overflow:hidden',
    'box-shadow:0 0 0 1px rgba(255,255,255,0.18)',
    'z-index:20',
  ].join(';');

  const batteryFill = document.createElement('div');
  batteryFill.className = 'robot-battery-fill';
  batteryFill.style.cssText = [
    'height:100%',
    'width:100%',
    'background:#22c55e',
    'border-radius:2px',
    'transition:width 0.6s ease, background 0.6s ease',
  ].join(';');
  batteryWrap.appendChild(batteryFill);

  // Status glyph — screen-facing, top-right, outside the anchor box.
  const statusEl = document.createElement('div');
  statusEl.className = 'robot-status-icon';
  statusEl.style.cssText = [
    'position:absolute',
    'top:-2px',
    'right:-8px',
    'font-size:10px',
    'line-height:14px',
    'width:14px',
    'height:14px',
    'text-align:center',
    'border-radius:50%',
    'background:rgba(0,0,0,0.8)',
    'display:none',
    'pointer-events:none',
    'z-index:20',
  ].join(';');

  // Hit target — screen-facing and fixed size, so click/hover accuracy does
  // NOT degrade as the ground layer foreshortens at steep pitch.
  const hit = document.createElement('div');
  hit.className = 'robot-marker-hit';
  hit.setAttribute('role', 'button');
  hit.setAttribute('tabindex', '0');
  hit.setAttribute('aria-label', `Robot ${labelText}`);
  hit.style.cssText = [
    'position:absolute',
    'top:50%',
    'left:50%',
    'transform:translate(-50%,-50%)',
    'width:34px',
    'height:34px',
    'border-radius:50%',
    'background:transparent',
    'pointer-events:auto',
    'cursor:pointer',
    'z-index:15',
  ].join(';');

  scaleWrap.appendChild(ground);
  scaleWrap.appendChild(leader);
  scaleWrap.appendChild(label);
  scaleWrap.appendChild(batteryWrap);
  scaleWrap.appendChild(statusEl);
  scaleWrap.appendChild(hit);
  root.appendChild(scaleWrap);

  root._batteryFill = batteryFill;
  root._statusEl = statusEl;
  root._scaleWrap = scaleWrap;
  root._groundEl = ground;
  root._carEl = car;
  root._labelEl = label;
  root._selectRing = selectRing;
  root._selectPulse = selectPulse;
  root._hitEl = hit;
  root._zoomScale = 1;

  return {
    root,
    car,
    label,
    batteryEl: batteryFill,
    statusEl,
    scaleWrap,
    groundEl: ground,
    hitEl: hit,
    selectRingEl: selectRing,
  };
}

// ── Zoom-based scaling ───────────────────────────────────────────────────────
//
// Plain pixel-sized markers stay a fixed SCREEN size at every zoom, so at low
// zoom a 26×36px marker can represent hundreds of metres of ground — making an
// exact, correctly-placed coordinate look like it's floating far from the road
// purely due to disproportionate icon size, not any positioning error.
// Shrinking the marker as you zoom out (like Uber/Swiggy's vehicle icon
// collapsing to a small dot at city zoom) keeps it visually anchored to the
// road at every zoom level.
const MARKER_ZOOM_MIN = 12; // at/below this zoom, marker is at MARKER_MIN_SCALE
const MARKER_ZOOM_MAX = 17; // at/above this zoom, marker is full size
const MARKER_MIN_SCALE = 0.45;

export function markerScaleForZoom(zoom) {
  if (typeof zoom !== 'number' || !Number.isFinite(zoom)) return 1;
  if (zoom <= MARKER_ZOOM_MIN) return MARKER_MIN_SCALE;
  if (zoom >= MARKER_ZOOM_MAX) return 1;
  const t = (zoom - MARKER_ZOOM_MIN) / (MARKER_ZOOM_MAX - MARKER_ZOOM_MIN);
  return MARKER_MIN_SCALE + (1 - MARKER_MIN_SCALE) * t;
}

/** Apply zoom-based scale to a marker's inner scale wrapper (never to the
 *  Mapbox-owned root/anchor element — see createRobotMarkerElement doc).
 *  Still used by the mission (pickup/drop) markers, which have no ground half. */
export function applyMarkerZoomScale(scaleEl, zoom) {
  if (!scaleEl) return;
  scaleEl.style.transform = `scale(${markerScaleForZoom(zoom)})`;
}

// ── Ground-plane projection ──────────────────────────────────────────────────
//
// cos(pitch) is the exact vertical foreshortening of a horizontal plane, so it
// is what makes the icon look painted on the ground rather than pasted over it.
// It is floored: at 70° pitch cos is 0.34, and below roughly a third the
// vehicle collapses into an unreadable sliver. Legibility wins over the last
// few degrees of geometric purity — the contact shadow and the screen-facing
// chip carry the position and identity at extreme tilt regardless.
const GROUND_FLATTEN_MIN = 0.42;

export function groundFlattenForPitch(pitchDeg) {
  const p = typeof pitchDeg === 'number' && Number.isFinite(pitchDeg) ? pitchDeg : 0;
  const clamped = Math.max(0, Math.min(85, p));
  return Math.max(GROUND_FLATTEN_MIN, Math.cos((clamped * Math.PI) / 180));
}

/**
 * Apply the current CAMERA to a marker: zoom scale on the screen-facing half,
 * ground-plane foreshortening on the ground half.
 *
 * Camera-driven, not telemetry-driven — this runs on map move/zoom/pitch, and
 * touches only transforms on already-mounted elements. No geometry is rebuilt.
 */
export function applyMarkerCamera(root, { zoom, pitch } = {}) {
  if (!root) return;
  const scaleEl = root._scaleWrap;
  if (scaleEl) {
    const scale = markerScaleForZoom(zoom);
    root._zoomScale = scale;
    scaleEl.style.transform = `scale(${scale})`;
  }
  const groundEl = root._groundEl;
  if (groundEl) {
    groundEl.style.transform = `scaleY(${groundFlattenForPitch(pitch)})`;
  }
}

/**
 * Rotate the vehicle icon to a SCREEN yaw (degrees clockwise from screen-up).
 *
 * The caller supplies an already-corrected screen yaw from
 * `world/robotWorldAnchor.js#worldYawToScreenYaw`. Passing a raw compass
 * heading here would be wrong the moment the camera is rotated.
 */
export function applyMarkerHeading(root, screenYawDeg) {
  const carEl = root?._carEl;
  if (!carEl) return;
  if (typeof screenYawDeg !== 'number' || !Number.isFinite(screenYawDeg)) return;
  carEl.style.transform = `rotate(${screenYawDeg}deg)`;
}

/**
 * Selection is application state (a `selectedRobotId`), and this only reflects
 * it. Nothing here stores which robot is selected — so the same selection
 * survives a renderer swap (§19).
 */
export function setMarkerSelected(root, selected) {
  if (!root) return;
  const ring = root._selectRing;
  const pulse = root._selectPulse;
  const label = root._labelEl;

  if (ring) ring.style.opacity = selected ? '1' : '0';
  if (pulse) {
    pulse.style.animation = selected ? 'rx-select-ring 2.2s ease-out infinite' : 'none';
    pulse.style.opacity = selected ? '' : '0';
  }
  if (label) {
    label.style.boxShadow = selected
      ? '0 0 0 2px rgba(255,255,255,0.95), 0 4px 12px rgba(0,0,0,0.6)'
      : '0 2px 6px rgba(0,0,0,0.55)';
  }
  root.style.zIndex = selected ? '40' : '10';
}

export function setMarkerHovered(root, hovered) {
  if (!root) return;
  const ring = root._selectRing;
  if (ring && ring.style.opacity !== '1') {
    ring.style.opacity = hovered ? '0.55' : '0';
  }
  root.style.zIndex = root.style.zIndex === '40' ? '40' : hovered ? '30' : '10';
}

export function updateMarkerInfo(root, { battery, status } = {}) {
  if (!root) return;

  const fill = root._batteryFill;
  if (fill && typeof battery === 'number' && Number.isFinite(battery)) {
    const pct = Math.max(0, Math.min(100, battery));
    fill.style.width = `${pct}%`;
    fill.style.background = batteryColor(pct);
  }

  const icon = root._statusEl;
  if (icon) {
    const s = typeof status === 'string' ? status.toUpperCase() : '';
    const glyph = STATUS_ICONS[s] || '';
    if (glyph) {
      icon.textContent = glyph;
      icon.style.display = 'flex';
      icon.style.color = s === 'CHARGING' ? '#facc15' : s === 'ERROR' ? '#ef4444' : '#f59e0b';
    } else {
      icon.style.display = 'none';
    }
  }
}

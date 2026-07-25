/**
 * Mapbox robot marker — compact top-down delivery car.
 *
 * Design goals:
 *   • Fits within a single road lane at zoom 15+
 *   • Large obvious direction arrow at the front (top of SVG = north when unrotated)
 *   • The whole car element rotates with heading — no separate arrow element
 *   • No drop-shadow filter (blurs during CSS rotation, making marker look smeared)
 *   • White stroke on body so marker is readable on both dark and light map styles
 *   • anchor='center' → map coordinate lands at center of car body (13, 18) in a 26×36 SVG
 *
 * createRobotMarkerElement(color, labelText) → { root, car, label, batteryEl, statusEl }
 * updateMarkerInfo(root, { battery, status })
 * injectPulseCSS()  — CSS keyframes for mission-marker pulse rings
 */

const STATUS_ICONS = {
  CHARGING: '⚡',
  ISSUES:   '⚠',
  ERROR:    '✕',
  OFFLINE:  '○',
  PAUSED:   '‖',
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
  `;
  document.head.appendChild(s);
}

/**
 * Top-down compact delivery car SVG.
 *
 * ViewBox: 26 × 36
 * The car body spans y=8 → y=32, center at y=20.
 * The direction arrow spans y=0 → y=9, center y=4.5.
 * Total element center: (13, 18) = approximate visual center of car body.
 *
 * With anchor='center', the map coordinate lands at (13,18) = car body center = on the road.
 *
 * Heading rotation: `transform: rotate(${heading}deg)` on this SVG.
 *   heading=0  → arrow points up   (north)  ✓
 *   heading=90 → arrow points right (east)   ✓
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

  /**
   * root is exactly 26×36 px — the same as the SVG viewBox.
   * anchor='center' → Mapbox places the map coordinate at pixel (13, 18),
   * which is the center of the car body.
   *
   * Mapbox GL owns `root.style.transform` directly (it's the element passed
   * to `new mapboxgl.Marker({element})`, and Mapbox writes its own
   * translate/anchor transform onto it every frame). Zoom-based scaling is
   * therefore applied to `scaleWrap`, a same-size child — never to `root`
   * itself — so our scale and Mapbox's positioning don't fight over the same
   * CSS property. Since `root`'s DOM box (used for the anchor calculation)
   * stays at its unscaled 26×36 size, the anchor point still lands exactly
   * on the coordinate regardless of the current zoom scale.
   *
   * All UI chrome (label, battery bar, status icon) is absolutely positioned
   * OUTSIDE the 26×36 box so it doesn't affect the anchor geometry.
   */
  const root = document.createElement('div');
  root.className = 'robot-marker-root';
  root.setAttribute('aria-hidden', 'true');
  root.style.cssText = [
    // Mapbox's own stylesheet sets `.mapboxgl-marker { position:absolute }`
    // on this exact element (it's passed straight into `new mapboxgl.Marker
    // ({element: root})`). An inline `position:relative` here would win over
    // that class (inline beats class specificity) and pull `root` back into
    // normal document flow, stacking it under every marker created before
    // it — each one then carries a fixed pixel offset equal to the combined
    // height of earlier markers, on top of Mapbox's own translate. Matching
    // `absolute` here keeps the two in agreement instead of fighting; it
    // still works as the containing block for the absolutely-positioned
    // children below.
    'position:absolute',
    'width:26px',
    'height:36px',
    'pointer-events:none',
    'z-index:10',
  ].join(';');

  const scaleWrap = document.createElement('div');
  scaleWrap.className = 'robot-marker-scale';
  scaleWrap.style.cssText = [
    'position:absolute',
    'inset:0',
    'transform-origin:50% 50%',
    'will-change:transform',
  ].join(';');

  // ── Robot ID badge (above car, outside anchor box) ─────────────────────────
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
    'box-shadow:0 2px 4px rgba(0,0,0,0.5)',
    'border:1.5px solid rgba(255,255,255,0.7)',
  ].join(';');

  // ── Car SVG (rotates with heading) ─────────────────────────────────────────
  const car = document.createElement('div');
  car.className = 'robot-car';
  car.style.cssText = [
    'width:26px',
    'height:36px',
    'transform-origin:50% 50%',
    'will-change:transform',
    // No drop-shadow — it creates blur artifacts when rotating
  ].join(';');
  car.innerHTML = carSvg(color);

  // ── Battery bar (below car, outside anchor box) ───────────────────────────
  const batteryWrap = document.createElement('div');
  batteryWrap.style.cssText = [
    'position:absolute',
    'left:50%',
    'top:100%',
    'transform:translateX(-50%)',
    'margin-top:3px',
    'width:26px',
    'height:4px',
    'background:rgba(255,255,255,0.15)',
    'border-radius:2px',
    'overflow:hidden',
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

  // ── Status icon (top-right, outside anchor box) ───────────────────────────
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

  scaleWrap.appendChild(label);
  scaleWrap.appendChild(car);
  scaleWrap.appendChild(batteryWrap);
  scaleWrap.appendChild(statusEl);
  root.appendChild(scaleWrap);

  root._batteryFill = batteryFill;
  root._statusEl    = statusEl;
  root._scaleWrap   = scaleWrap;

  return { root, car, label, batteryEl: batteryFill, statusEl, scaleWrap };
}

// ── Zoom-based scaling ───────────────────────────────────────────────────────
//
// Plain pixel-sized markers stay a fixed SCREEN size at every zoom, so at low
// zoom a 26×36px marker can represent hundreds of metres of ground — making
// an exact, correctly-placed coordinate look like it's floating far from the
// road purely due to disproportionate icon size, not any positioning error.
// Shrinking the marker as you zoom out (like Uber/Swiggy's vehicle icon
// collapsing to a small dot at city zoom) keeps it visually anchored to the
// road at every zoom level.
const MARKER_ZOOM_MIN = 12;   // at/below this zoom, marker is at MARKER_MIN_SCALE
const MARKER_ZOOM_MAX = 17;   // at/above this zoom, marker is full size
const MARKER_MIN_SCALE = 0.45;

export function markerScaleForZoom(zoom) {
  if (typeof zoom !== 'number' || !Number.isFinite(zoom)) return 1;
  if (zoom <= MARKER_ZOOM_MIN) return MARKER_MIN_SCALE;
  if (zoom >= MARKER_ZOOM_MAX) return 1;
  const t = (zoom - MARKER_ZOOM_MIN) / (MARKER_ZOOM_MAX - MARKER_ZOOM_MIN);
  return MARKER_MIN_SCALE + (1 - MARKER_MIN_SCALE) * t;
}

/** Apply zoom-based scale to a marker's inner scale wrapper (never to the
 *  Mapbox-owned root/anchor element — see createRobotMarkerElement doc). */
export function applyMarkerZoomScale(scaleEl, zoom) {
  if (!scaleEl) return;
  scaleEl.style.transform = `scale(${markerScaleForZoom(zoom)})`;
}

export function updateMarkerInfo(root, { battery, status } = {}) {
  if (!root) return;

  const fill = root._batteryFill;
  if (fill && typeof battery === 'number' && Number.isFinite(battery)) {
    const pct = Math.max(0, Math.min(100, battery));
    fill.style.width      = `${pct}%`;
    fill.style.background = batteryColor(pct);
  }

  const icon = root._statusEl;
  if (icon) {
    const s = typeof status === 'string' ? status.toUpperCase() : '';
    const glyph = STATUS_ICONS[s] || '';
    if (glyph) {
      icon.textContent   = glyph;
      icon.style.display = 'flex';
      icon.style.color   = s === 'CHARGING' ? '#facc15' : s === 'ERROR' ? '#ef4444' : '#f59e0b';
    } else {
      icon.style.display = 'none';
    }
  }
}

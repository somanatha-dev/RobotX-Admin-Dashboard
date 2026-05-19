/**
 * Mapbox robot marker factory.
 *
 * createRobotMarkerElement(color, labelText)
 *   Returns { root, car, label, batteryEl, statusEl }
 *
 * updateMarkerInfo(root, { battery, status })
 *   Refreshes the battery bar and status icon without re-creating the DOM element.
 *   Call this from live telemetry handlers to avoid destroying and re-attaching markers.
 */

const STATUS_ICONS = {
  CHARGING: '⚡',
  ISSUES:   '⚠',
  ERROR:    '✕',
  OFFLINE:  '○',
  PAUSED:   '‖',
};

function batteryColor(pct) {
  if (pct >= 50) return '#22c55e';  // green
  if (pct >= 20) return '#f59e0b';  // amber
  return '#ef4444';                  // red
}

export function createRobotMarkerElement(color, labelText) {
  const root = document.createElement('div');
  root.className = 'robot-marker-root';
  root.setAttribute('aria-hidden', 'true');
  root.style.cssText = 'position:relative;display:flex;flex-direction:column;align-items:center;gap:0;';

  // ── Robot ID label ──────────────────────────────────────────────────────────
  const label = document.createElement('div');
  label.className = 'robot-label';
  label.textContent = labelText;
  label.style.cssText = [
    'position:absolute',
    'left:50%',
    'bottom:100%',
    'transform:translate(-50%,-6px)',
    'background:#000',
    'color:#fff',
    'padding:2px 6px',
    'border-radius:4px',
    'font-size:10px',
    'font-weight:700',
    'letter-spacing:0.06em',
    'white-space:nowrap',
    'pointer-events:none',
    'z-index:1',
    'opacity:0.95',
  ].join(';');

  // ── Robot SVG icon ──────────────────────────────────────────────────────────
  const car = document.createElement('div');
  car.className = 'robot-car';
  car.style.cssText = 'display:flex;align-items:center;justify-content:center;position:relative;z-index:2;';
  car.innerHTML = `
    <svg width="26" height="26" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M14 36L18 22C19 18 22 16 26 16H38C42 16 45 18 46 22L50 36" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M16 36H48" stroke="${color}" stroke-width="6" stroke-linecap="round"/>
      <path d="M20 44H18C15 44 13 42 13 39V36H21V44Z" fill="${color}"/>
      <path d="M44 44H46C49 44 51 42 51 39V36H43V44Z" fill="${color}"/>
      <circle cx="22" cy="44" r="4" fill="#0f172a"/>
      <circle cx="42" cy="44" r="4" fill="#0f172a"/>
      <path d="M24 26H40" stroke="${color}" stroke-width="5" stroke-linecap="round"/>
    </svg>
  `;

  // ── Battery bar ─────────────────────────────────────────────────────────────
  const batteryWrap = document.createElement('div');
  batteryWrap.style.cssText = [
    'margin-top:2px',
    'width:28px',
    'height:5px',
    'background:rgba(255,255,255,0.15)',
    'border-radius:3px',
    'overflow:hidden',
  ].join(';');

  const batteryFill = document.createElement('div');
  batteryFill.className = 'robot-battery-fill';
  batteryFill.style.cssText = 'height:100%;width:100%;background:#22c55e;border-radius:3px;transition:width 0.4s,background 0.4s;';
  batteryWrap.appendChild(batteryFill);

  // ── Status icon (visible only for non-idle/non-active states) ───────────────
  const statusEl = document.createElement('div');
  statusEl.className = 'robot-status-icon';
  statusEl.style.cssText = [
    'position:absolute',
    'top:-4px',
    'right:-6px',
    'font-size:9px',
    'line-height:1',
    'display:none',
    'pointer-events:none',
    'z-index:3',
  ].join(';');

  root.appendChild(label);
  root.appendChild(car);
  root.appendChild(batteryWrap);
  root.appendChild(statusEl);

  // Store refs for live updates
  root._batteryFill = batteryFill;
  root._statusEl    = statusEl;

  return { root, car, label, batteryEl: batteryFill, statusEl };
}

/**
 * Update the battery bar and status icon on an existing marker element.
 * Call this from the live telemetry handler instead of re-creating the marker.
 *
 * @param {HTMLElement} root - The root element returned by createRobotMarkerElement
 * @param {{ battery?: number|null, status?: string|null }} info
 */
export function updateMarkerInfo(root, { battery, status } = {}) {
  if (!root) return;

  // Battery fill
  const fill = root._batteryFill;
  if (fill && typeof battery === 'number' && Number.isFinite(battery)) {
    const pct = Math.max(0, Math.min(100, battery));
    fill.style.width      = `${pct}%`;
    fill.style.background = batteryColor(pct);
  }

  // Status icon
  const icon = root._statusEl;
  if (icon) {
    const s = typeof status === 'string' ? status.toUpperCase() : '';
    const glyph = STATUS_ICONS[s] || '';
    if (glyph) {
      icon.textContent    = glyph;
      icon.style.display  = 'block';
      icon.style.color    = s === 'CHARGING' ? '#facc15' : s === 'ERROR' ? '#ef4444' : '#f59e0b';
    } else {
      icon.style.display  = 'none';
    }
  }
}

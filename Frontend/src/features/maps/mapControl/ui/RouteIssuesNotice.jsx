import React, { useState } from 'react';

/**
 * UI LAYER — what is wrong with the routes currently on the map (§3D).
 *
 * ── Why this component exists ─────────────────────────────────────────────
 * The brief is explicit: *If a route crosses a building because the underlying
 * route data is incorrect, DO NOT hide the problem with rendering. Report it.*
 *
 * There was no way to report it. The map could draw a route through a lecture
 * block and the only thing an operator could do was notice — or not. Nudging
 * the line off the footprint would have been falsifying the route; drawing it
 * under the extrusion so nobody saw it would have been falsifying it more
 * quietly. So the line is drawn exactly where the route data puts it, and this
 * says what the campus geometry thinks of that.
 *
 * ── Why it is not an error banner ─────────────────────────────────────────
 * The campus geometry is itself imported, and a route may legitimately clip a
 * footprint whose outline is a few metres generous. A finding is an observation
 * for a person who can go and look, so this is a collapsed line by default,
 * amber for something that contradicts the geometry and neutral for something
 * merely worth knowing. It appears only when there is something to say.
 */

const SEVERITY_CLASS = Object.freeze({
  SUSPECT: 'is-suspect',
  NOTE: 'is-note',
});

export function RouteIssuesNotice({ summary }) {
  const [open, setOpen] = useState(false);
  const findings = summary?.findings || [];

  if (findings.length === 0) return null;

  const suspect = summary.suspect || 0;
  const heading =
    suspect > 0
      ? `${suspect} route ${suspect === 1 ? 'issue' : 'issues'} against the campus geometry`
      : `${findings.length} route ${findings.length === 1 ? 'note' : 'notes'}`;

  return (
    <div className={`map-route-notice${open ? ' is-open' : ''}${suspect > 0 ? ' has-suspect' : ''}`}>
      <button
        type="button"
        className="map-route-notice__toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="map-route-notice__dot" aria-hidden="true" />
        <span>{heading}</span>
        <span className="map-route-notice__chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div className="map-route-notice__body">
          <ul>
            {findings.map((f, i) => (
              <li key={`${f.type}-${f.featureId || i}`} className={SEVERITY_CLASS[f.severity] || ''}>
                {f.message}
                {f.robotIds?.length > 0 && (
                  <span className="map-route-notice__units"> — {f.robotIds.join(', ')}</span>
                )}
              </li>
            ))}
          </ul>
          <p className="map-route-notice__foot">
            Routes are drawn exactly where the route data places them. Nothing here has been moved,
            smoothed or hidden to make the map look correct.
          </p>
        </div>
      )}
    </div>
  );
}

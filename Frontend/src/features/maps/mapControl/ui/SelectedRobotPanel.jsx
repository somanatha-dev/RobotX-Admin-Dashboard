import React from 'react';

import { Button } from '@/components/ui/button.jsx';

/**
 * UI LAYER — the selected robot's operational summary (§3F, §3N).
 *
 * Reads a robot out of state by id. It is deliberately not attached to a marker
 * or a scene object, so it is unaffected by which renderer drew the robot (§20)
 * — a future 3D robot raising the same id renders this identical panel.
 *
 * ── The rule this panel enforces ──────────────────────────────────────────
 * §3N: *Do not invent data. Do not add fake metrics.* Every row below is either
 * a field the backend sent or a value derived from two such fields by
 * arithmetic that is named on screen. There is no ETA (nothing reports speed
 * along a route reliably enough), no utilisation, no health score, and no
 * "last seen" dressed up as a connection quality. A row whose value is absent
 * renders an em dash rather than a plausible number.
 *
 * `Nearest` is the one derived row and it is derived from real campus geometry:
 * the closest named campus feature to the unit's reported position, with the
 * distance stated so the operator can judge it. It is a MEASUREMENT of two
 * things the map already holds, not a claim about where the robot is going.
 */

const SEGMENT_LABEL = Object.freeze({
  toPickup: 'To pickup',
  toDrop: 'To drop',
});

function metres(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value >= 1000 ? `${(value / 1000).toFixed(2)} km` : `${Math.round(value)} m`;
}

function coordinate(lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

export function SelectedRobotPanel({ robot, followSelected, onToggleFollow, onClear, routeProgress, nearestFeature }) {
  if (!robot) return null;

  const battery = typeof robot.battery === 'number' ? Math.round(robot.battery) : null;
  const status = String(robot.status || 'UNKNOWN').toUpperCase();
  const position = coordinate(robot.lat, robot.lon);

  // Task identity, from whichever shape this robot arrived in. Never fabricated:
  // telemetry carries no task, so a unit whose task the map has not been told
  // about shows an em dash rather than a guess.
  const taskId = robot.task?.taskId || robot.currentTask?.taskId || robot.currentTaskId || routeProgress?.taskId || null;

  const rows = [
    ['Status', status],
    ['Battery', battery === null ? '—' : `${battery}%`],
    ['Heading', typeof robot.heading === 'number' ? `${Math.round(robot.heading)}°` : '—'],
    ['Speed', typeof robot.speed === 'number' ? `${robot.speed} m/s` : '—'],
  ];

  return (
    <div className="map-selected-panel" role="status" aria-live="polite">
      <div className="map-selected-panel__head">
        <span className="map-selected-panel__id">{robot.robotId}</span>
        <button type="button" onClick={onClear} className="map-selected-panel__close" aria-label="Clear selection">
          ×
        </button>
      </div>

      <dl className="map-selected-panel__grid">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <dl className="map-selected-panel__list">
        <div>
          <dt>Location</dt>
          <dd>{position || '—'}</dd>
        </div>
        {nearestFeature && (
          <div>
            <dt>Nearest</dt>
            <dd>
              {nearestFeature.name}
              <span className="map-selected-panel__muted"> · {metres(nearestFeature.metres)}</span>
            </dd>
          </div>
        )}
        <div>
          <dt>Task</dt>
          <dd>{taskId || '—'}</dd>
        </div>
      </dl>

      {routeProgress && (
        <div className="map-selected-panel__route">
          {routeProgress.onRoute ? (
            <>
              <div className="map-selected-panel__route-head">
                <span>{SEGMENT_LABEL[routeProgress.segment] || 'On route'}</span>
                <span>{metres(routeProgress.remainingM) || '—'} left</span>
              </div>
              {/* Progress along the ACTIVE leg, derived from the unit's own
                  reported position. Not an ETA and not a percentage of the
                  whole task — it is the fraction of this leg's length behind
                  the unit, which is exactly what the two route colours show. */}
              <div className="map-selected-panel__bar" aria-hidden="true">
                <span style={{ width: `${Math.round((routeProgress.fraction || 0) * 100)}%` }} />
              </div>
            </>
          ) : (
            <div className="map-selected-panel__route-warn">
              {typeof routeProgress.offsetM === 'number'
                ? `About ${Math.round(routeProgress.offsetM)} m off its route — progress is not being derived from its position.`
                : 'Not currently on its route.'}
            </div>
          )}
        </div>
      )}

      <Button
        type="button"
        size="sm"
        variant={followSelected ? 'default' : 'secondary'}
        onClick={onToggleFollow}
        className="w-full"
      >
        {followSelected ? 'Following camera' : 'Follow with camera'}
      </Button>
    </div>
  );
}

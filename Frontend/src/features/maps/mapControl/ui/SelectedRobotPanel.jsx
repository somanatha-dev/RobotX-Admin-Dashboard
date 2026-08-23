import React from 'react';

import { Button } from '@/components/ui/button.jsx';

/**
 * UI LAYER — the selected robot's operational summary.
 *
 * Reads a robot out of state by id. It is deliberately not attached to a marker
 * or a scene object, so it is unaffected by which renderer drew the robot (§20)
 * — a future 3D robot raising the same id renders this identical panel.
 */
export function SelectedRobotPanel({ robot, followSelected, onToggleFollow, onClear }) {
  if (!robot) return null;
  const battery = typeof robot.battery === 'number' ? Math.round(robot.battery) : null;
  const status = String(robot.status || 'UNKNOWN').toUpperCase();

  return (
    <div className="map-selected-panel" role="status" aria-live="polite">
      <div className="map-selected-panel__head">
        <span className="map-selected-panel__id">{robot.robotId}</span>
        <button type="button" onClick={onClear} className="map-selected-panel__close" aria-label="Clear selection">
          ×
        </button>
      </div>

      <dl className="map-selected-panel__grid">
        <div>
          <dt>Status</dt>
          <dd>{status}</dd>
        </div>
        <div>
          <dt>Battery</dt>
          <dd>{battery === null ? '—' : `${battery}%`}</dd>
        </div>
        <div>
          <dt>Heading</dt>
          <dd>{typeof robot.heading === 'number' ? `${Math.round(robot.heading)}°` : '—'}</dd>
        </div>
        <div>
          <dt>Speed</dt>
          <dd>{typeof robot.speed === 'number' ? `${robot.speed} m/s` : '—'}</dd>
        </div>
      </dl>

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

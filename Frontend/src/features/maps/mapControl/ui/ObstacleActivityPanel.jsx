import React, { useState } from 'react';

import { CONNECTION } from '@/lib/connectionState.js';
import {
  ACTIVITY_FILTER,
  RECIPIENT_STATUS,
  REFUSAL_TEXT,
  STATUS_TEXT,
  clockOf,
  isExpired,
  recipientStatus,
} from '@/lib/obstacleActivity.js';

/**
 * UI LAYER — DTARO obstacle awareness: reports, deliveries, each recipient's verdict, refusals.
 *
 * Every line is a backend event (see `lib/obstacleActivity.js`); nothing is composed to look
 * complete. A recipient with no verdict yet says so. A verdict is a DECISION: no robot is
 * rerouted in V1, and the panel says that rather than implying a route changed. Reports come
 * from simulated robots only — the server refuses any other — and the panel says that too.
 */

const FILTERS = [
  [ACTIVITY_FILTER.ALL, 'All'],
  [ACTIVITY_FILTER.RELEVANT, 'Relevant'],
  [ACTIVITY_FILTER.REFUSED, 'Refused'],
];

const STATUS_CLASS = Object.freeze({
  [RECIPIENT_STATUS.RELEVANT]: 'is-relevant',
  [RECIPIENT_STATUS.NOT_RELEVANT]: 'is-clear',
  [RECIPIENT_STATUS.NO_ROUTE]: 'is-clear',
  [RECIPIENT_STATUS.PENDING]: 'is-pending',
});

/** Why the server alerted a robot, or did not — its own reason codes, in words. */
const WHY_TEXT = Object.freeze({
  SAME_ZONE: 'same zone',
  ROUTE_CROSSES_OBSTACLE: 'other zone — its remaining route crosses the obstacle',
  ROUTE_CLEAR: 'other zone — remaining route clear of the obstacle',
  NO_REMAINING_ROUTE: 'other zone — no commanded route',
  NO_ZONE: 'no zone — no commanded route',
  OTHER_REGION: 'another region — never alerted',
  REPORTER: 'reported it',
});
const ROUTE_STATUS_TEXT = Object.freeze({
  NO_LIVE_COMMITMENT: 'idle',
  NO_ROUTE_GEOMETRY: 'route has no geometry',
  NO_AGENT: 'not an engine agent',
  LOOKUP_FAILED: 'route could not be read',
});

function whyText(decision) {
  if (!decision) return null;
  const base = WHY_TEXT[decision.reason] || decision.reason;
  const route = decision.routeStatus && ROUTE_STATUS_TEXT[decision.routeStatus];
  return route && decision.reason !== 'OTHER_REGION' && decision.reason !== 'REPORTER' ? `${base} (${route})` : base;
}

function coordinate(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) ? `${lat.toFixed(5)}, ${lon.toFixed(5)}` : null;
}

/** The connection line, or null when live. Transport facts only (lib/connectionState.js). */
function connectionNote(state) {
  if (state === CONNECTION.RECONNECTING) return 'Live updates paused — reconnecting. Entries below may be out of date.';
  if (state === CONNECTION.DISCONNECTED) return 'Live updates stopped. Entries below are not being updated; reload to reconnect.';
  if (state === CONNECTION.CONNECTING) return 'Connecting to live updates…';
  return null;
}

function SummaryChips({ counts }) {
  if (!counts || counts.recipients === 0) return <span className="map-obstacle__chip is-clear">no other robot in the zone</span>;
  return (
    <>
      {counts.relevant > 0 && <span className="map-obstacle__chip is-relevant">{counts.relevant} relevant</span>}
      {counts.notRelevant + counts.noRoute > 0 && (
        <span className="map-obstacle__chip is-clear">{counts.notRelevant + counts.noRoute} not relevant</span>
      )}
      {counts.pending > 0 && <span className="map-obstacle__chip is-pending">{counts.pending} awaiting</span>}
    </>
  );
}

function ObstacleDetail({ obstacle, zoneName, robotsById, onFocus, nowMs }) {
  const expired = isExpired(obstacle, nowMs);
  const location = coordinate(obstacle.lat, obstacle.lon);
  const reporter = obstacle.reportingRobotId ? robotsById.get(obstacle.reportingRobotId) : null;
  return (
    <section className="map-obstacle__detail" aria-label={`Obstacle ${obstacle.obstacleId}`}>
      <dl className="map-obstacle__grid">
        <div>
          <dt>Reporter</dt>
          <dd>
            {obstacle.reportingRobotId || '—'}
            {reporter?.simulated === true && <span className="map-obstacle__sim">SIM</span>}
          </dd>
        </div>
        <div>
          <dt>Zone</dt>
          <dd>{zoneName || obstacle.zoneId || '—'}</dd>
        </div>
        <div>
          <dt>Location</dt>
          <dd>{location || 'not in this page’s record'}</dd>
        </div>
        <div>
          <dt>Cell</dt>
          <dd className="map-obstacle__mono">{obstacle.cellId || '—'}</dd>
        </div>
        <div>
          <dt>Reported</dt>
          <dd>{clockOf(obstacle.reportedAtMs) || '—'}</dd>
        </div>
        <div>
          <dt>{expired ? 'Expired' : 'Expires'}</dt>
          <dd>
            {clockOf(obstacle.expiresAtMs) || '—'}
            {expired && <span className="map-obstacle__muted"> · timed out, not confirmed clear</span>}
          </dd>
        </div>
        {obstacle.corroborations?.length > 0 && (
          <div className="is-wide">
            <dt>Also reported by</dt>
            <dd>{obstacle.corroborations.join(', ')} — same published cell, not re-broadcast</dd>
          </div>
        )}
        {obstacle.severity && (
          <div className="is-wide">
            <dt>Severity</dt>
            <dd>{obstacle.severity.toLowerCase()} — as reported by the robot (advisory)</dd>
          </div>
        )}
      </dl>

      <div className="map-obstacle__subhead">Alert delivered to</div>
      {obstacle.recipients.length === 0 ? (
        <p className="map-obstacle__muted">
          No other simulated robot was in the zone, and none elsewhere had a remaining route through it.
        </p>
      ) : (
        <ul className="map-obstacle__recipients">
          {obstacle.recipients.map((robotId) => {
            const status = recipientStatus(obstacle, robotId);
            const verdict = obstacle.verdicts?.[robotId];
            const decision = (obstacle.decisions || []).find((d) => d.robotId === robotId);
            const crossZone = (obstacle.crossZoneRecipients || []).includes(robotId);
            return (
              <li key={robotId}>
                <span className="map-obstacle__mono">{robotId}</span>
                <span className={`map-obstacle__chip ${STATUS_CLASS[status]}`}>{STATUS_TEXT[status]}</span>
                {crossZone && <span className="map-obstacle__chip is-cross">cross-zone</span>}
                {decision && <span className="map-obstacle__why">{whyText(decision)}</span>}
                {verdict?.taskId && <span className="map-obstacle__muted">{verdict.taskId}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {(obstacle.decisions || []).some((d) => !d.alerted && d.reason !== 'REPORTER') && (
        <details className="map-obstacle__considered">
          <summary>
            Considered, not alerted ({(obstacle.decisions || []).filter((d) => !d.alerted && d.reason !== 'REPORTER').length})
          </summary>
          <ul className="map-obstacle__recipients">
            {(obstacle.decisions || [])
              .filter((d) => !d.alerted && d.reason !== 'REPORTER')
              .map((d) => (
                <li key={d.robotId}>
                  <span className="map-obstacle__mono">{d.robotId}</span>
                  <span className="map-obstacle__why">{whyText(d)}</span>
                </li>
              ))}
          </ul>
        </details>
      )}
      {obstacle.partial && (
        <p className="map-obstacle__muted">This page opened after the report; only the verdicts received since are shown.</p>
      )}
      <p className="map-obstacle__note">
        Decision only: a relevant robot flags the obstacle on its commanded route. Reroute: not available — no robot
        is rerouted and no commanded route changes until an authorised, fenced reroute exists (owner decision OD-3).
      </p>
      {location && (
        <button type="button" className="map-obstacle__focus" onClick={() => onFocus(obstacle)}>
          Show on map
        </button>
      )}
    </section>
  );
}

/**
 * @param {object} props
 * @param {string} props.connectionState     CONNECTION
 * @param {object[]} props.entries           `activityEntries(...).entries`
 * @param {number} props.hiddenCount         entries of other regions, not shown for this campus
 * @param {string|null} props.campusName
 * @param {string} props.filter
 * @param {(filter: string) => void} props.onFilter
 * @param {object|null} props.selectedObstacle
 * @param {(obstacleId: string|null) => void} props.onSelect
 * @param {(obstacle: object) => void} props.onFocus
 * @param {(zoneId: string, regionId: string) => string|null} props.zoneNameOf
 * @param {Map<string, object>} props.robotsById
 * @param {number} props.nowMs
 */
export function ObstacleActivityPanel({
  connectionState,
  entries,
  hiddenCount = 0,
  campusName = null,
  filter,
  onFilter,
  selectedObstacle,
  onSelect,
  onFocus,
  zoneNameOf,
  robotsById,
  nowMs,
  /** Collapsed by default; the map opens it when an obstacle is picked. */
  initiallyOpen = false,
}) {
  const [open, setOpen] = useState(initiallyOpen);
  // An obstacle picked on the map opens the panel on its details. Adjusted during render (the
  // React pattern for "reset state when a prop changes"), so no frame shows it closed.
  const selectedId = selectedObstacle?.obstacleId || null;
  const [openedFor, setOpenedFor] = useState(selectedId);
  if (openedFor !== selectedId) {
    setOpenedFor(selectedId);
    if (selectedId) setOpen(true);
  }
  const reports = entries.filter((e) => e.kind === 'OBSTACLE').length;
  const live = connectionState === CONNECTION.CONNECTED;
  const note = connectionNote(connectionState);

  return (
    <section className={`map-obstacle-panel${open ? ' is-open' : ''}`} aria-label="Obstacle awareness">
      <button type="button" className="map-obstacle-panel__head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`map-obstacle-panel__dot${live ? ' is-live' : ''}`} aria-hidden="true" />
        <span className="map-obstacle-panel__title">Obstacle awareness</span>
        <span className="map-obstacle-panel__count" aria-label={`${reports} reports`}>
          {reports}
        </span>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="map-obstacle-panel__body">
          <p className="map-obstacle__muted">
            Simulated robots only{campusName ? ` · ${campusName}` : ' · all regions'}. Each robot alerted decides for itself
            whether the obstacle is on its commanded route.
          </p>
          {note && (
            <p className="map-obstacle__warn" role="status">
              {note}
            </p>
          )}

          <div className="map-segmented map-obstacle__filters" role="group" aria-label="Filter activity">
            {FILTERS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`map-segmented__item${filter === value ? ' is-active' : ''}`}
                aria-pressed={filter === value}
                onClick={() => onFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>

          {entries.length === 0 ? (
            <p className="map-obstacle__empty">
              {filter === ACTIVITY_FILTER.ALL
                ? 'No obstacle reports yet. Reports from simulated robots appear here as the server receives them.'
                : 'Nothing matches this filter.'}
            </p>
          ) : (
            <ul className="map-obstacle__list" aria-label="Obstacle activity">
              {entries.map((entry) =>
                entry.kind === 'OBSTACLE' ? (
                  <li key={entry.key}>
                    <button
                      type="button"
                      className={`map-obstacle__entry${isExpired(entry.obstacle, nowMs) ? ' is-expired' : ''}`}
                      aria-pressed={selectedObstacle?.obstacleId === entry.obstacle.obstacleId}
                      onClick={() =>
                        onSelect(selectedObstacle?.obstacleId === entry.obstacle.obstacleId ? null : entry.obstacle.obstacleId)
                      }
                    >
                      <span className="map-obstacle__time">{clockOf(entry.atMs) || '--:--:--'}</span>
                      <span className="map-obstacle__line">
                        Obstacle reported by <strong>{entry.obstacle.reportingRobotId || 'unknown'}</strong>
                        {entry.obstacle.zoneId && (
                          <span className="map-obstacle__muted">
                            {' '}
                            · {zoneNameOf(entry.obstacle.zoneId, entry.obstacle.regionId) || entry.obstacle.zoneId}
                          </span>
                        )}
                      </span>
                      <span className="map-obstacle__chips">
                        <SummaryChips counts={entry.counts} />
                        {entry.obstacle.corroborations?.length > 0 && (
                          <span className="map-obstacle__chip is-clear">+{entry.obstacle.corroborations.length} report{entry.obstacle.corroborations.length === 1 ? '' : 's'}</span>
                        )}
                        {isExpired(entry.obstacle, nowMs) && (
                          <span className="map-obstacle__chip is-clear" title="Timed out after the server's obstacle lifetime; not confirmed clear">
                            expired — not confirmed clear
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ) : (
                  <li key={entry.key}>
                    <div className="map-obstacle__entry is-refusal">
                      <span className="map-obstacle__time">{clockOf(entry.atMs) || '--:--:--'}</span>
                      <span className="map-obstacle__line">
                        Report from <strong>{entry.refusal.reportingRobotId || 'unknown'}</strong> refused
                      </span>
                      <span className="map-obstacle__chips">
                        <span className="map-obstacle__chip is-refused">{entry.refusal.reason}</span>
                        <span className="map-obstacle__muted">{REFUSAL_TEXT[entry.refusal.reason] || ''}</span>
                      </span>
                    </div>
                  </li>
                )
              )}
            </ul>
          )}

          {hiddenCount > 0 && (
            <p className="map-obstacle__muted">
              {hiddenCount} entr{hiddenCount === 1 ? 'y' : 'ies'} from other regions not shown for this campus.
            </p>
          )}

          {selectedObstacle && (
            <ObstacleDetail
              obstacle={selectedObstacle}
              zoneName={zoneNameOf(selectedObstacle.zoneId, selectedObstacle.regionId)}
              robotsById={robotsById}
              onFocus={onFocus}
              nowMs={nowMs}
            />
          )}
        </div>
      )}
    </section>
  );
}

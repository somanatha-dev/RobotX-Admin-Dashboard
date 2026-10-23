/**
 * FS-06 — what the dashboard may say about a reported obstacle.
 *
 * ── The backend contract (alertDissemination.service.processObstacleReport) ──
 * `ALERT_CREATED` → `{ obstacleId, lat, lon, zoneId, zoneName, severity, reportingRobotId,
 * timestamp, expiresAt }`. It names no task. Then, for each robot whose planned path
 * crosses the obstacle, `REROUTE_ALERT` → `{ robotId, obstacleId, lat, lon, zoneId,
 * severity, timestamp }` is emitted to the dashboard **before** the legacy
 * `rerouteRobot` runs — and on the engine path that call returns early, because the
 * engine's route cache stores no pickup/drop for it to route between (BG-09).
 *
 * So neither event means a robot was rerouted, and the dashboard's own decision modal
 * used to claim three things that do not happen: "Backend is auto-rerouting", a countdown
 * that ended in a logged "Swarm auto-rerouted X", and a REROUTE button that called the
 * legacy `POST /api/tasks/:id/reroute` (which during the drop leg routes the robot back to
 * the pickup via Mapbox). The alert is now shown as what it is: information.
 */

export const OBSTACLE_NO_ACTION_NOTE =
  'Information only. The dashboard takes no action on obstacle reports, and the assignment ' +
  'engine does not reroute around them in V1: nothing has been rerouted, paused or cancelled ' +
  'because of this alert. Rerouting is not available from the dashboard.';

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function timeOf(value) {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The alert shown to the operator, built only from the event and the robot list.
 *
 * `taskId` is the reporting robot's current task as the robot list last reported it
 * (`Robot.currentTaskId`), or null. It is never filled with another identifier — the
 * obstacle id used to be shown under "Task ID" when the robot had no task.
 *
 * @param {object} data the `ALERT_CREATED` payload
 * @param {object[]} robots the provider's robot list
 */
export function obstacleAlertFrom(data, robots) {
  const robotId = text(data?.reportingRobotId);
  const reporter = robotId && Array.isArray(robots)
    ? robots.find((r) => String(r?.robotId || '').trim() === robotId)
    : null;
  return {
    obstacleId: text(data?.obstacleId),
    robotId,
    taskId: text(reporter?.currentTask?.taskId),
    severity: text(data?.severity),
    zone: text(data?.zoneName) || text(data?.zoneId),
    lat: num(data?.lat),
    lon: num(data?.lon),
    reportedAtMs: timeOf(data?.timestamp),
    expiresAtMs: timeOf(data?.expiresAt),
  };
}

/**
 * DTARO zone alerts — the suffix naming who an obstacle alert was delivered to. Present only
 * when the server delivered through a zone room (`delivery: "ZONE_ROOM"`); the legacy event
 * carries no recipients and gets no suffix.
 */
export function alertRecipientsSuffix(data) {
  if (data?.delivery !== 'ZONE_ROOM' || !Array.isArray(data?.recipients)) return '';
  const zone = [text(data?.regionId), text(data?.zoneId)].filter(Boolean).join('/');
  const who = data.recipients.map(text).filter(Boolean);
  return ` — alerted ${who.length ? who.join(', ') : 'no other robot'}${zone ? ` in zone ${zone}` : ''}`;
}

/** DTARO zone alerts — the event-log line for one robot's relevance verdict. */
export function obstacleRelevanceLogLine(data) {
  const robotId = text(data?.robotId);
  if (!robotId) return null;
  if (data?.routeSource === 'NONE') return `${robotId}: obstacle alert received — no planned route, not relevant`;
  const task = text(data?.taskId);
  return data?.relevant === true
    ? `${robotId}: obstacle is on its commanded route${task ? ` (${task})` : ''} — flagged, no reroute (V1)`
    : `${robotId}: obstacle is not on its commanded route${task ? ` (${task})` : ''} — no change`;
}

/** DTARO zone alerts — the event-log line for a refused obstacle report. */
export function obstacleRejectedLogLine(data) {
  const robotId = text(data?.reportingRobotId);
  const reason = text(data?.reason);
  if (!robotId || !reason) return null;
  return `Obstacle report from ${robotId} refused: ${reason}`;
}

/** The event-log line for `REROUTE_ALERT`: an alert was sent, not a reroute performed. */
export function rerouteAlertLogLine(data) {
  const robotId = text(data?.robotId);
  if (!robotId) return null;
  return `Obstacle alert sent to ${robotId} (its planned path crosses a reported obstacle) — no reroute is confirmed`;
}

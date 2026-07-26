/**
 * Shared liveness/flush timing constants.
 *
 * These four values are coupled — changing one without the others reintroduces
 * one of two failure modes, so they live in one file with the relationship
 * stated explicitly (same rationale as `dtaro.constants.js`, which centralized
 * the battery thresholds after they silently diverged across two files).
 *
 * The invariant that must hold:
 *
 *     DB_FLUSH_INTERVAL_MS  <  OFFLINE_CUTOFF_MS
 *
 * Both `telemetry.handler.js` (TELEMETRY) and `robot.handler.js` (HEARTBEAT)
 * throttle their `Robot.lastSeenAt` writes to DB_FLUSH_INTERVAL_MS. The offline
 * sweep in `socket.server.js` marks a robot OFFLINE once its DB `lastSeenAt`
 * is older than OFFLINE_CUTOFF_MS.
 *
 *   - If the cutoff were <= the flush interval, a perfectly healthy robot
 *     would be marked OFFLINE in the gap between two throttled writes, and
 *     would flap online/offline forever — which is why the pre-throttle
 *     heartbeat path had to write on EVERY beat (30 writes/robot/minute at the
 *     simulator's 2s tick).
 *   - If the flush interval were raised toward the cutoff, the margin for a
 *     slow DB write or a delayed tick disappears.
 *
 * The current 2x margin (15s flush vs 30s cutoff) tolerates one entirely
 * missed flush before a live robot is ever at risk of being marked offline.
 *
 * Note that the sweep is a BACKSTOP, not the primary offline signal: a robot
 * disconnecting normally is marked offline immediately by the socket
 * `disconnect` handler. The sweep only catches cases where that never ran
 * (process kill, half-open connection), so its latency is not user-visible.
 */

/** Max age of a `Robot.lastSeenAt` DB write before the next tick flushes it. */
const DB_FLUSH_INTERVAL_MS = 15_000;

/** How stale `lastSeenAt` must be before the sweep considers a robot offline. */
const OFFLINE_CUTOFF_MS = 30_000;

/** How often the offline sweep runs. */
const OFFLINE_SWEEP_INTERVAL_MS = 10_000;

/** Max robots examined per sweep pass — bounds the blast radius of one tick. */
const OFFLINE_SWEEP_BATCH = 500;

module.exports = {
  DB_FLUSH_INTERVAL_MS,
  OFFLINE_CUTOFF_MS,
  OFFLINE_SWEEP_INTERVAL_MS,
  OFFLINE_SWEEP_BATCH,
};

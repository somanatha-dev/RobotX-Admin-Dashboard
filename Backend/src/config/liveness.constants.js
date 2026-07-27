/**
 * Liveness/flush timing — **compatibility shim, retiring in Phase 5.**
 *
 * These four values used to be declared here as compile-time constants. Phase 1
 * (§22) moves every behavioural constant into the versioned parameter register, so
 * this file resolves them through the Config Service and re-exports them under their
 * existing names. `robot.handler.js`, `telemetry.handler.js`, and `socket.server.js`
 * keep working unchanged until Phase 5 absorbs the offline sweep into the reconciler.
 *
 * The values are unchanged.
 *
 * Register entries:
 *   legacy.liveness.db_flush_interval_ms       (was DB_FLUSH_INTERVAL_MS)
 *   legacy.liveness.offline_cutoff_ms          (was OFFLINE_CUTOFF_MS)
 *   legacy.liveness.offline_sweep_interval_ms  (was OFFLINE_SWEEP_INTERVAL_MS)
 *   legacy.liveness.offline_sweep_batch        (was OFFLINE_SWEEP_BATCH)
 *
 * ── The coupling, now enforced rather than described ────────────────────────
 * The invariant this file used to state in prose:
 *
 *     DB_FLUSH_INTERVAL_MS  <  OFFLINE_CUTOFF_MS
 *
 * is now publish-time validation A3 in `src/engine/config/validators.js`, so a
 * configuration that breaks it is rejected instead of producing robots that flap
 * online/offline forever in the gap between two throttled writes. That is the whole
 * point of §22.1 rule 5: a cross-parameter identity documented in a comment is a
 * comment, and the two values each look perfectly defensible alone.
 *
 * The current 2× margin (15 s flush vs 30 s cutoff) tolerates one entirely missed
 * flush before a live robot is ever at risk of being marked offline. The sweep is a
 * BACKSTOP, not the primary offline signal: a robot disconnecting normally is marked
 * offline immediately by the socket `disconnect` handler, so the sweep's latency is
 * not user-visible.
 */

const { defaultSnapshot } = require("../engine/config/service");

const snapshot = defaultSnapshot();

function required(name) {
  const explanation = snapshot.explain(name);
  if (explanation.value === null || explanation.value === undefined) {
    throw new Error(
      `legacy constant "${name}" did not resolve through the Config Service ` +
        `(source: ${explanation.source}). Every behavioural constant is configuration (§22.1 rule 1).`,
    );
  }
  return explanation.value;
}

/** Max age of a `Robot.lastSeenAt` DB write before the next tick flushes it. */
const DB_FLUSH_INTERVAL_MS = required("legacy.liveness.db_flush_interval_ms");

/** How stale `lastSeenAt` must be before the sweep considers a robot offline. */
const OFFLINE_CUTOFF_MS = required("legacy.liveness.offline_cutoff_ms");

/** How often the offline sweep runs. */
const OFFLINE_SWEEP_INTERVAL_MS = required("legacy.liveness.offline_sweep_interval_ms");

/** Max robots examined per sweep pass — bounds the blast radius of one tick. */
const OFFLINE_SWEEP_BATCH = required("legacy.liveness.offline_sweep_batch");

module.exports = {
  DB_FLUSH_INTERVAL_MS,
  OFFLINE_CUTOFF_MS,
  OFFLINE_SWEEP_INTERVAL_MS,
  OFFLINE_SWEEP_BATCH,
};

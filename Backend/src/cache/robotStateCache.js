"use strict";

/**
 * In-memory per-process cache of each connected robot's last-known DB row
 * fields (id, status, isOnline, lat, lon, battery).
 *
 * Exists so telemetry.handler.js's hot path (every ~2s per robot) can read
 * the robot's internal `id` (needed as the Telemetry FK) and validate status
 * transitions without a `prisma.robot.findUnique` on every single TELEMETRY
 * frame — that unconditional read was the dominant per-tick DB cost
 * (confirmed by the 2026-07-26 scalability benchmark: REST latency jumped
 * 77ms -> 21s between 100 and 500 concurrently-active robots, tracking
 * Postgres connection-pool contention from this exact read).
 *
 * Populated once at AUTH (from the same DB lookup AUTH already performs to
 * verify the robot is commissioned — no new query). Kept in sync by every
 * code path that subsequently writes Robot.status/isOnline/lat/lon/battery,
 * so it never needs a fresh read once seeded. `id` never changes for a
 * robot's lifetime and is safe to cache indefinitely.
 */
const cache = new Map(); // robotId -> { id, status, isOnline, lat, lon, battery }

function set(robotId, partial) {
  if (!robotId) return;
  const prev = cache.get(robotId) || {};
  cache.set(robotId, { ...prev, ...partial });
}

function get(robotId) {
  return cache.get(robotId) || null;
}

function del(robotId) {
  cache.delete(robotId);
  predicateCache.delete(robotId);
}

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 6 — per-agent predicate caching (§7.6 level 1)
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * §7.6 level 1: "**Agent-invariant predicates** (F1–F12, F21 partially) depend only on
 * agent state and are cached per agent, invalidated by any change to lifecycle, health,
 * capability, firmware, or certification. These are the cheapest and most frequently
 * reused."
 *
 * This is the *process-local* half of that cache. `engine/feasibility/cache.js` holds
 * the shared Redis half and owns the keying and stamp rules; this map is the L1 in
 * front of it, on the same argument that justifies the row cache above — the hot path
 * runs per candidate per Leg per round, and a network round trip per agent per round
 * is the cost §7.6 exists to avoid.
 *
 * ── Invalidation is by stamp, and the stamp is the whole mechanism ─────────
 * §7.6 states the invalidation rule as an *event*. Implementing that as delete-on-write
 * from every writer works exactly as long as every writer remembers, and fails silently
 * the first time one does not — producing a stale **positive**, which is the failure
 * that matters. So the entry records the stamps it was computed under and `getVerdicts`
 * returns a miss unless the caller's current stamps match. A writer that forgets to
 * invalidate lands on a miss rather than on a stale admission.
 *
 * That is also why `del()` above clears both maps: an agent whose row cache is being
 * dropped has had something change, and the verdicts computed under the old state must
 * not outlive it.
 */
const predicateCache = new Map(); // robotId -> { stamps, verdicts }

/**
 * Do two stamp sets agree on every governing version?
 *
 * @param {object|null|undefined} a
 * @param {object|null|undefined} b
 * @returns {boolean}
 */
function sameStamps(a, b) {
  if (!a || !b) return false;
  const keys = Object.keys(b);
  if (keys.length !== Object.keys(a).length) return false;
  return keys.every((key) => String(a[key]) === String(b[key]));
}

/**
 * Read cached agent-invariant predicate verdicts.
 *
 * @param {string} robotId
 * @param {object} currentStamps `{ lifecycleVersion, healthVersion, capabilityVersion,
 *   firmwareVersion, certificationVersion }` — §7.6's own invalidation triggers
 * @returns {object|null} predicateId -> result, or null on a miss
 */
function getVerdicts(robotId, currentStamps) {
  const entry = predicateCache.get(robotId);
  if (!entry) return null;
  if (!sameStamps(entry.stamps, currentStamps)) {
    // Not merely a miss: the entry is now known wrong, so it is dropped rather than
    // left to be re-tested on every subsequent candidate this round.
    predicateCache.delete(robotId);
    return null;
  }
  return entry.verdicts;
}

/**
 * Cache agent-invariant predicate verdicts against the stamps they were computed under.
 *
 * An entry with no stamps is **not** written: an entry that cannot state what it was
 * computed under cannot be validated on read, and an unvalidatable positive is exactly
 * what §7.6's invalidation rule exists to prevent.
 *
 * @param {string} robotId
 * @param {object} stamps
 * @param {object} verdicts predicateId -> result
 */
function setVerdicts(robotId, stamps, verdicts) {
  if (!robotId || !stamps || !verdicts) return;
  predicateCache.set(robotId, { stamps, verdicts });
}

/**
 * Drop an agent's cached verdicts. Called by whatever observed the change; the stamp
 * check is what makes a forgotten call safe rather than fatal.
 *
 * @param {string} robotId
 */
function invalidateVerdicts(robotId) {
  predicateCache.delete(robotId);
}

module.exports = { set, get, del, getVerdicts, setVerdicts, invalidateVerdicts };

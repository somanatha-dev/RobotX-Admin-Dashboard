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
}

module.exports = { set, get, del };

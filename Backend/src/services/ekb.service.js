/**
 * Environmental Knowledge Base (EKB) Service — DTARO
 *
 * Stores, retrieves, and auto-expires obstacle events.
 * Primary store: Redis with TTL-based expiry.
 * Secondary store: PostgreSQL ObstacleEvent model for persistence.
 * In-memory fallback: active when Redis is unavailable.
 *
 * Redis keys:
 *   ekb:event:{obstacleId}  — obstacle JSON (TTL = ttlSec)
 *   ekb:obstacles           — Set of active obstacle IDs
 */

const crypto = require("crypto");
const { safeJsonParse } = require("../utils/json");

const EKB_SET_KEY = "ekb:obstacles";
const DEFAULT_TTL_SEC = 300; // 5 minutes

/** In-memory fallback store: Map<obstacleId, { event, _expiresMs }> */
const inMemoryStore = new Map();

function obstacleKey(obstacleId) {
  return `ekb:event:${obstacleId}`;
}


/**
 * Store a new obstacle event in Redis + PostgreSQL.
 *
 * @param {object} kv
 * @param {object} prisma
 * @param {object} params
 * @param {number} params.lat
 * @param {number} params.lon
 * @param {string|null} [params.zoneId]
 * @param {'LOW'|'MEDIUM'|'HIGH'|'CRITICAL'} [params.severity]
 * @param {string|null} [params.reportingRobotId]
 * @param {number} [params.ttlSec]
 * @returns {Promise<object>} The stored obstacle event object
 */
async function storeObstacle(kv, prisma, { lat, lon, zoneId = null, severity = "MEDIUM", reportingRobotId = null, ttlSec = DEFAULT_TTL_SEC }) {
  const obstacleId = `OBS-${Date.now()}-${crypto.randomInt(100, 999)}`;
  const now = Date.now();
  const expiresAt = new Date(now + ttlSec * 1000);

  const event = {
    obstacleId,
    lat,
    lon,
    zoneId,
    severity,
    reportingRobotId,
    timestamp: now,
    expiresAt: expiresAt.toISOString(),
  };

  // Redis primary — auto-expiry via TTL
  let redisOk = false;
  if (kv) {
    try {
      await kv.set(obstacleKey(obstacleId), JSON.stringify(event), { ex: ttlSec });
      if (typeof kv.sadd === "function") await kv.sadd(EKB_SET_KEY, obstacleId);
      redisOk = true;
    } catch {
      redisOk = false;
    }
  }

  // In-memory fallback
  if (!redisOk) {
    inMemoryStore.set(obstacleId, { ...event, _expiresMs: now + ttlSec * 1000 });
  }

  // PostgreSQL secondary — best effort (model may not exist yet)
  if (prisma) {
    try {
      await prisma.obstacleEvent.create({
        data: { obstacleId, lat, lon, zoneId: zoneId || null, severity, reportingRobotId: reportingRobotId || null, expiresAt },
      });
    } catch {
      // Silently skip if model unavailable
    }
  }

  return event;
}

/**
 * Get all currently active (non-expired) obstacle events.
 *
 * @param {object} kv
 * @returns {Promise<object[]>}
 */
async function getActiveObstacles(kv) {
  const now = Date.now();

  if (kv) {
    try {
      const ids = typeof kv.smembers === "function" ? await kv.smembers(EKB_SET_KEY) : [];
      if (!Array.isArray(ids) || ids.length === 0) return [];

      const rawEvents = await Promise.all(
        ids.map(async (id) => {
          try {
            const raw = await kv.get(obstacleKey(id));
            return raw ? { id, event: safeJsonParse(raw) } : { id, event: null };
          } catch {
            return { id, event: null };
          }
        })
      );

      // Prune IDs whose Redis key has expired (TTL hit)
      const expired = rawEvents.filter((r) => !r.event).map((r) => r.id);
      if (expired.length && typeof kv.srem === "function") {
        await kv.srem(EKB_SET_KEY, ...expired);
      }

      return rawEvents
        .filter((r) => r.event)
        .map((r) => r.event)
        .filter((e) => {
          const exp = e.expiresAt ? new Date(e.expiresAt).getTime() : 0;
          return exp > now;
        });
    } catch {
      // fall through to in-memory
    }
  }

  // In-memory fallback — sweep expired while reading
  const active = [];
  for (const [id, entry] of inMemoryStore.entries()) {
    if (entry._expiresMs > now) {
      active.push(entry);
    } else {
      inMemoryStore.delete(id);
    }
  }
  return active;
}

/**
 * Sweep expired obstacle IDs from the Redis tracking set.
 * Call periodically (e.g., every 60s) to keep the set clean.
 *
 * @param {object} kv
 */
async function sweepExpired(kv) {
  if (!kv || typeof kv.smembers !== "function") return;
  try {
    const ids = await kv.smembers(EKB_SET_KEY);
    if (!Array.isArray(ids) || ids.length === 0) return;

    const toRemove = [];
    for (const id of ids) {
      const exists = await kv.get(obstacleKey(id));
      if (!exists) toRemove.push(id); // TTL expired
    }

    if (toRemove.length && typeof kv.srem === "function") {
      await kv.srem(EKB_SET_KEY, ...toRemove);
    }
  } catch {
    // ignore
  }
}

module.exports = {
  storeObstacle,
  getActiveObstacles,
  sweepExpired,
};

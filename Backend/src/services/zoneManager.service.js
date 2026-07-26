/**
 * Zone Manager Service — DTARO
 *
 * Determines zone membership from geographic coordinates and manages
 * Socket.IO room membership so robots receive zone-targeted broadcasts.
 *
 * Zones are rectangular bounding boxes defined in the Zone DB model.
 * Cache hierarchy: in-process (60s) → Redis (5min) → PostgreSQL
 *
 * Socket rooms:
 *   "zone:{zoneId}"   — all robots in that zone
 *   "dashboard"       — dashboard clients (managed elsewhere)
 */

const { safeJsonParse } = require("../utils/json");
const { updateZone } = require("./robotRegistry.service");

const ZONE_CACHE_REDIS_KEY = "zones:all";
const ZONE_CACHE_REDIS_TTL = 300; // seconds
const ZONE_CACHE_LOCAL_TTL = 60_000; // ms

let localZoneCache = null;
let localZoneCacheExpiry = 0;

/**
 * Load all zones with a multi-tier cache.
 * @param {object} prisma
 * @param {object} kv
 * @returns {Promise<object[]>}
 */
async function loadZones(prisma, kv) {
  const now = Date.now();

  // Tier 1: in-process memory
  if (localZoneCache && now < localZoneCacheExpiry) return localZoneCache;

  // Tier 2: Redis
  if (kv) {
    try {
      const raw = await kv.get(ZONE_CACHE_REDIS_KEY);
      const zones = safeJsonParse(raw);
      if (Array.isArray(zones)) {
        localZoneCache = zones;
        localZoneCacheExpiry = now + ZONE_CACHE_LOCAL_TTL;
        return zones;
      }
    } catch {
      // fall through
    }
  }

  // Tier 3: PostgreSQL
  if (!prisma) return [];
  try {
    const zones = await prisma.zone.findMany({ orderBy: { name: "asc" } });
    if (kv) {
      await kv.set(ZONE_CACHE_REDIS_KEY, JSON.stringify(zones), { ex: ZONE_CACHE_REDIS_TTL });
    }
    localZoneCache = zones;
    localZoneCacheExpiry = now + ZONE_CACHE_LOCAL_TTL;
    return zones;
  } catch {
    return [];
  }
}

/**
 * Invalidate all zone caches (call after creating/updating zones).
 * @param {object} kv
 */
async function invalidateZoneCache(kv) {
  localZoneCache = null;
  localZoneCacheExpiry = 0;
  if (kv) {
    try {
      await kv.del(ZONE_CACHE_REDIS_KEY);
    } catch {
      // ignore
    }
  }
}

/**
 * Find the zone that contains the given coordinates.
 * Returns the first matching zone (zones should not overlap).
 *
 * @param {object} prisma
 * @param {object} kv
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<object|null>}
 */
async function getZoneForCoordinates(prisma, kv, lat, lon) {
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  const zones = await loadZones(prisma, kv);
  return (
    zones.find((z) => lat >= z.minLat && lat <= z.maxLat && lon >= z.minLon && lon <= z.maxLon) || null
  );
}

/**
 * Move a robot's socket between zone rooms.
 * Silently skips if socket is null or rooms are identical.
 *
 * @param {object|null} socket
 * @param {string|null} oldZoneId
 * @param {string|null} newZoneId
 */
function updateSocketZoneRoom(socket, oldZoneId, newZoneId) {
  if (!socket) return;
  if (oldZoneId && oldZoneId !== newZoneId) {
    try { socket.leave(`zone:${oldZoneId}`); } catch { /* ignore */ }
  }
  if (newZoneId) {
    try { socket.join(`zone:${newZoneId}`); } catch { /* ignore */ }
  }
}

/**
 * Full zone-assignment pipeline for a robot:
 *   1. Determine zone from coordinates.
 *   2. Persist the zone to the robot registry (and, on change, to Postgres).
 *   3. Update socket room membership.
 *   4. Emit ZONE_UPDATED to dashboard if the zone actually changed.
 *
 * Step 2 is what makes zone locality real. Without it:
 *   - `registry:{robotId}.zoneId` is never written, so the DTARO cost
 *     function's Z term (costEvaluator.service.js) scores every candidate
 *     identically — a constant offset with zero effect on ranking (F6).
 *   - `currentZoneId` is permanently null on the next call, so the
 *     "did the zone change?" check below is true on EVERY telemetry tick,
 *     turning a state-change notification into a per-tick broadcast storm
 *     and a redundant `socket.join()` twice a second per robot.
 *
 * The registry write happens on every call (cheap, merge-semantics, and it
 * refreshes the 30s registry TTL). The Postgres write happens only on an
 * actual change — zone crossings are rare by construction, and `Robot.zoneId`
 * exists solely as the durable fallback `taskAssignment.service.js` reads when
 * the registry entry has expired.
 *
 * @param {object} prisma
 * @param {object} kv
 * @param {object|null} io
 * @param {string} robotId
 * @param {number} lat
 * @param {number} lon
 * @param {object|null} socket - robot's socket (may be null for virtual robots)
 * @param {string|null} currentZoneId - robot's previous zone ID
 * @returns {Promise<string|null>} new zone ID (or null if outside all zones)
 */
async function assignRobotToZone(prisma, kv, io, robotId, lat, lon, socket, currentZoneId) {
  const zone = await getZoneForCoordinates(prisma, kv, lat, lon);
  const newZoneId = zone?.id || null;
  const changed = newZoneId !== currentZoneId;

  // Persist to the live registry first, so a failure further down (socket
  // room, emit, DB) can't leave the zone unrecorded and re-trigger the
  // "changed" branch on the very next tick.
  try {
    await updateZone(kv, robotId, newZoneId);
  } catch {
    // registry write is best-effort — never block telemetry on it
  }

  if (changed) {
    try {
      await prisma?.robot?.update({
        where: { robotId },
        data: { zoneId: newZoneId },
      });
    } catch {
      // Durable mirror only; the registry above is the authoritative live copy.
    }

    updateSocketZoneRoom(socket, currentZoneId, newZoneId);
    if (io) {
      try {
        io.to("dashboard").emit("ZONE_UPDATED", {
          robotId,
          oldZoneId: currentZoneId,
          newZoneId,
          zoneName: zone?.name || null,
          timestamp: Date.now(),
        });
      } catch {
        // ignore emit failure
      }
    }
  }

  return newZoneId;
}

/**
 * Seed 4 quadrant zones for a campus if no zones exist yet.
 * Idempotent — skips if any zones already exist.
 *
 * @param {object} prisma
 * @param {object|null} kv
 * @param {{ centerLat: number, centerLon: number, name: string }} campus
 */
async function seedDefaultZones(prisma, kv, campus) {
  if (!prisma || !campus) return;
  try {
    const existing = await prisma.zone.count();
    if (existing > 0) return;

    const { centerLat, centerLon, name: campusName } = campus;
    const delta = 0.005; // ~550 m from center to edge

    const zoneDefs = [
      {
        name: `${campusName} Zone-NW`,
        minLat: centerLat, maxLat: centerLat + delta * 2,
        minLon: centerLon - delta * 2, maxLon: centerLon,
      },
      {
        name: `${campusName} Zone-NE`,
        minLat: centerLat, maxLat: centerLat + delta * 2,
        minLon: centerLon, maxLon: centerLon + delta * 2,
      },
      {
        name: `${campusName} Zone-SW`,
        minLat: centerLat - delta * 2, maxLat: centerLat,
        minLon: centerLon - delta * 2, maxLon: centerLon,
      },
      {
        name: `${campusName} Zone-SE`,
        minLat: centerLat - delta * 2, maxLat: centerLat,
        minLon: centerLon, maxLon: centerLon + delta * 2,
      },
    ];

    for (const def of zoneDefs) {
      await prisma.zone.upsert({
        where: { name: def.name },
        update: {},
        create: def,
      });
    }

    await invalidateZoneCache(kv);
  } catch {
    // ignore — zones are optional for system operation
  }
}

module.exports = {
  invalidateZoneCache,
  getZoneForCoordinates,
  assignRobotToZone,
  seedDefaultZones,
};

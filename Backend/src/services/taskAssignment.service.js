const { matrixDurationsToDestination } = require("./mapbox.service");

function haversineMeters(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const aa = s1 * s1 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(aa)));
}

function chunk(arr, size) {
  const a = Array.isArray(arr) ? arr : [];
  const out = [];
  for (let i = 0; i < a.length; i += size) out.push(a.slice(i, i + size));
  return out;
}

async function selectNearestRobot({ prisma, kv, pickup, maxRobots = 100 } = {}) {
  if (!prisma) throw new Error("prisma is required");
  if (!kv) {
    const err = new Error("KV store unavailable");
    err.status = 503;
    throw err;
  }

  const pickupLat = pickup?.lat;
  const pickupLon = pickup?.lon;
  if (typeof pickupLat !== "number" || typeof pickupLon !== "number") {
    const err = new Error("pickupLat/pickupLon are required");
    err.status = 400;
    throw err;
  }

  // 1) Get IDLE robots
  const idle = await prisma.robot.findMany({
    where: {
      status: "IDLE",
      isOnline: true,
      currentTaskId: null,
    },
    select: { robotId: true, lat: true, lon: true },
    take: maxRobots,
  });

  const candidates = [];

  // 2) Overlay live positions from Redis (primary)
  for (const r of Array.isArray(idle) ? idle : []) {
    const robotId = r?.robotId;
    if (!robotId) continue;

    let live = null;
    try {
      const raw = await kv.get(`robot:${robotId}`);
      live = raw ? JSON.parse(raw) : null;
    } catch {
      live = null;
    }

    const lat = typeof live?.lat === "number" ? live.lat : typeof r.lat === "number" ? r.lat : null;
    const lon = typeof live?.lon === "number" ? live.lon : typeof r.lon === "number" ? r.lon : null;
    if (typeof lat !== "number" || typeof lon !== "number") continue;

    candidates.push({ robotId, lat, lon });
  }

  if (candidates.length === 0) {
    const err = new Error("No available IDLE robots");
    err.status = 409;
    throw err;
  }

  // Matrix API supports limited coords; batch robots.
  // Keep one slot for pickup destination.
  const batches = chunk(candidates, 24);

  let best = null;

  let matrixFailed = false;
  for (const batch of batches) {
    const origins = batch.map((c) => ({ lon: c.lon, lat: c.lat }));
    let durations = null;
    try {
      durations = await matrixDurationsToDestination({
        origins,
        destination: { lon: pickupLon, lat: pickupLat },
        profile: "driving",
      });
    } catch {
      matrixFailed = true;
      durations = null;
    }

    if (Array.isArray(durations)) {
      for (let i = 0; i < batch.length; i += 1) {
        const d = durations?.[i];
        if (typeof d !== "number" || !Number.isFinite(d)) continue;
        if (!best || d < best.durationSec) {
          best = { robotId: batch[i].robotId, durationSec: d, start: { lat: batch[i].lat, lon: batch[i].lon } };
        }
      }
    }
  }

  // Fallback: straight-line distance
  if (!best || matrixFailed) {
    const dest = { lat: pickupLat, lon: pickupLon };
    let bestDist = null;
    for (const c of candidates) {
      const d = haversineMeters({ lat: c.lat, lon: c.lon }, dest);
      if (!bestDist || d < bestDist.distMeters) {
        bestDist = { robotId: c.robotId, distMeters: d, start: { lat: c.lat, lon: c.lon } };
      }
    }

    if (bestDist && (!best || matrixFailed)) {
      best = { robotId: bestDist.robotId, durationSec: null, start: bestDist.start, usedFallback: true };
    }
  }

  if (!best) {
    const err = new Error("No route durations returned from Mapbox Matrix");
    err.status = 502;
    throw err;
  }

  return best;
}

module.exports = {
  selectNearestRobot,
};

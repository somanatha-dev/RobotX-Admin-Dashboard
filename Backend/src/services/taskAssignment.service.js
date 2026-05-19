/**
 * Task Assignment Service — DTARO Cost-Based Robot Selection
 *
 * Replaces the original distance-only nearest-robot selection with
 * the full DTARO cost function:
 *   C(r) = w1·D + w2·(1−B) + w3·U + w4·T
 *
 * Pipeline:
 *   1. Fetch all IDLE, online, unassigned robots from DB
 *   2. Overlay live positions from Redis registry
 *   3. Validate each candidate (battery, auth, health) via RobotValidator
 *   4. Compute travel distances/durations (Mapbox Matrix → haversine fallback)
 *   5. Evaluate DTARO cost via CostEvaluator
 *   6. Return the minimum-cost robot
 *
 * Exported API is backward-compatible: selectNearestRobot({ prisma, kv, pickup })
 */

const { matrixDurationsToDestination } = require("./mapbox.service");
const { validateRobot } = require("./robotValidator.service");
const { computeCosts } = require("./costEvaluator.service");
const { getRobotState } = require("./robotRegistry.service");
const { haversineMeters } = require("../utils/distance");
const logger = require("../config/logger");

function chunk(arr, size) {
  const a = Array.isArray(arr) ? arr : [];
  const out = [];
  for (let i = 0; i < a.length; i += size) out.push(a.slice(i, i + size));
  return out;
}

/**
 * Select the optimal robot for a task using the DTARO cost function.
 *
 * @param {object} params
 * @param {object} params.prisma
 * @param {object} params.kv
 * @param {{ lat: number, lon: number }} params.pickup
 * @param {number} [params.maxRobots]
 * @param {object} [params.costWeights] - Override DTARO cost weights
 * @returns {Promise<{
 *   robotId: string,
 *   durationSec: number|null,
 *   start: { lat: number, lon: number },
 *   usedFallback?: boolean,
 *   cost?: number,
 *   costComponents?: object
 * }>}
 */
async function selectNearestRobot({ prisma, kv, pickup, maxRobots = 100, costWeights } = {}) {
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

  // 1) Fetch IDLE robots + PAUSED robots (PAUSED covers CHARGING virtual robots)
  const dbCandidates = await prisma.robot.findMany({
    where: {
      status: { in: ["IDLE", "PAUSED"] },
      isOnline: true,
      currentTaskId: null,
    },
    select: { robotId: true, lat: true, lon: true, battery: true, currentTaskId: true, isOnline: true, status: true },
    take: maxRobots,
  });

  if (!dbCandidates || dbCandidates.length === 0) {
    const err = new Error("No available IDLE robots");
    err.status = 409;
    throw err;
  }

  // 2) Validate candidates — collect rejection reasons for the DTARO log.
  const validationResults = await Promise.all(
    dbCandidates.map(async (r) => {
      const result = await validateRobot(kv, r, { allowCharging: true });
      return { robotId: r.robotId, valid: result.valid, reason: result.reason };
    })
  );
  const rejectedValidation = validationResults.filter((r) => !r.valid);
  const eligible = dbCandidates.filter((r) =>
    validationResults.find((v) => v.robotId === r.robotId && v.valid)
  );

  if (eligible.length === 0) {
    const err = new Error("No robots passed eligibility validation");
    err.status = 409;
    throw err;
  }

  // 3) Overlay live positions from Redis registry (primary) or DB (fallback)
  const candidates = [];
  for (const r of eligible) {
    const robotId = r?.robotId;
    if (!robotId) continue;

    const live = await getRobotState(kv, robotId);
    const lat =
      typeof live?.lat === "number" ? live.lat : typeof r.lat === "number" ? r.lat : null;
    const lon =
      typeof live?.lon === "number" ? live.lon : typeof r.lon === "number" ? r.lon : null;
    if (typeof lat !== "number" || typeof lon !== "number") continue;

    candidates.push({
      robotId,
      lat,
      lon,
      battery: typeof live?.battery === "number" ? live.battery : r.battery,
    });
  }

  if (candidates.length === 0) {
    const err = new Error("No robots with known positions available");
    err.status = 409;
    throw err;
  }

  // 4) Compute travel durations via Mapbox Matrix (batch 24 per request)
  const batches = chunk(candidates, 24);
  let usedFallback = false;

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
      durations = null;
      usedFallback = true;
    }

    for (let i = 0; i < batch.length; i++) {
      const d = Array.isArray(durations) ? durations[i] : null;
      batch[i].durationSec = typeof d === "number" && Number.isFinite(d) ? d : null;
      batch[i].distanceM = haversineMeters(batch[i].lat, batch[i].lon, pickupLat, pickupLon);
    }
  }

  // If Matrix entirely failed, mark fallback and use haversine distances for D
  if (usedFallback) {
    for (const c of candidates) {
      if (c.durationSec === null || c.durationSec === undefined) {
        c.durationSec = null; // CostEvaluator normalizes nulls to 0
      }
    }
  }

  // 5) DTARO cost evaluation — select minimum cost robot
  const costResults = await computeCosts(kv, candidates, costWeights);
  const best = costResults.length > 0
    ? costResults.reduce((a, b) => (a.cost <= b.cost ? a : b))
    : null;

  // ── DTARO allocation log ─────────────────────────────────────────────────
  if (typeof logger.dtaro === "function") {
    const positionRejected = dbCandidates
      .filter((r) => eligible.find((e) => e.robotId === r.robotId))
      .filter((r) => !candidates.find((c) => c.robotId === r.robotId))
      .map((r) => ({ robotId: r.robotId, reason: "no known position" }));

    logger.dtaro({
      candidates: dbCandidates,
      results:    costResults,
      rejected:   [...rejectedValidation, ...positionRejected],
      winner:     best,
    });
  }
  // ─────────────────────────────────────────────────────────────────────────

  if (!best) {
    const err = new Error("Cost evaluation returned no result");
    err.status = 502;
    throw err;
  }

  const winner = candidates.find((c) => c.robotId === best.robotId);

  return {
    robotId: best.robotId,
    durationSec: best.durationSec ?? null,
    start: { lat: winner.lat, lon: winner.lon },
    usedFallback,
    cost: best.cost,
    costComponents: best.components,
  };
}

module.exports = {
  selectNearestRobot,
};

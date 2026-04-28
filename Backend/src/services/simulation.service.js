const { toStringOrNull, toNumberOrNull } = require("../utils/parse");
const telemetryService = require("./telemetry.service");
const { getRobotSocket } = require("../sockets/robotSockets");

const ROBOT_STATUS = new Set(["IDLE", "ACTIVE", "PAUSED", "OFFLINE", "ERROR", "ISSUES"]);

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function randFloat(min, max) {
  return min + Math.random() * (max - min);
}

function haversineMeters(aLat, aLon, bLat, bLon) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const aa = s1 * s1 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(aa)));
}

function safeJsonParse(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clamp01(x) {
  if (typeof x !== "number" || !Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function lerp(a, b, t) {
  return a + (b - a) * clamp01(t);
}

function bearingDeg(fromLat, fromLon, toLat, toLon) {
  const toRad = (d) => (d * Math.PI) / 180;
  const lat1 = toRad(fromLat);
  const lat2 = toRad(toLat);
  const dLon = toRad(toLon - fromLon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const brng = (Math.atan2(y, x) * 180) / Math.PI;
  return (brng + 360) % 360;
}

function headingAtan2Deg(currentLat, currentLon, nextLat, nextLon) {
  // Spec: atan2(nextLon - currentLon, nextLat - currentLat)
  const dLon = nextLon - currentLon;
  const dLat = nextLat - currentLat;
  const deg = (Math.atan2(dLon, dLat) * 180) / Math.PI;
  return (deg + 360) % 360;
}

function metersToLatDeg(m) {
  return m / 111320;
}

function metersToLonDeg(m, atLat) {
  const denom = 111320 * Math.cos((atLat * Math.PI) / 180);
  if (!denom || !Number.isFinite(denom)) return 0;
  return m / denom;
}

function chunk(arr, size) {
  const a = Array.isArray(arr) ? arr : [];
  const n = Math.max(1, Math.floor(size || 1));
  const out = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

const lastDbWrite = new Map();

function applyBatteryAndStatus({ battery, status } = {}) {
  const s = typeof status === "string" ? status : "IDLE";
  const b0 = typeof battery === "number" && Number.isFinite(battery) ? battery : 100;

  // Mild drain when active; very mild drain when idle.
  const drain = s === "ACTIVE" ? randFloat(0.08, 0.25) : randFloat(0.01, 0.06);
  const b1 = clamp(b0 - drain, 0, 100);

  if (s === "ERROR" || s === "PAUSED" || s === "OFFLINE") return { battery: b1, status: s };
  if (b1 < 15) return { battery: b1, status: "ISSUES" };
  return { battery: b1, status: s };
}

function applyMovement({ lat, lon, status } = {}) {
  const curLat = typeof lat === "number" ? lat : null;
  const curLon = typeof lon === "number" ? lon : null;
  if (curLat === null || curLon === null) return { lat: null, lon: null, speed: 0, heading: null };

  // If not task-driven, keep the robot steady. (Task motion is handled in computeTaskStep.)
  const s = typeof status === "string" ? status : "IDLE";
  const speed = s === "ACTIVE" ? 0.5 : 0;
  return { lat: curLat, lon: curLon, speed, heading: null };
}

async function shouldStoreSnapshotSmart(kv, robotId, next, { maxSeconds = 15, moveDegreesThreshold = 0.0001, batteryDelta = 2 } = {}) {
  if (!kv) return false;
  const key = `snapshotState:${robotId}`;
  const now = Date.now();
  const raw = await kv.get(key);
  const prev = safeJsonParse(raw);

  if (!prev || typeof prev !== "object") return true;

  const last = typeof prev.t === "number" ? prev.t : 0;
  if (!last || now - last >= maxSeconds * 1000) return true;

  const pLat = typeof prev.lat === "number" ? prev.lat : null;
  const pLon = typeof prev.lon === "number" ? prev.lon : null;
  const nLat = typeof next?.lat === "number" ? next.lat : null;
  const nLon = typeof next?.lon === "number" ? next.lon : null;
  if (pLat !== null && pLon !== null && nLat !== null && nLon !== null) {
    if (Math.abs(nLat - pLat) + Math.abs(nLon - pLon) >= moveDegreesThreshold) return true;
  }

  const pBat = typeof prev.battery === "number" ? prev.battery : null;
  const nBat = typeof next?.battery === "number" ? next.battery : null;
  if (pBat !== null && nBat !== null && Math.abs(nBat - pBat) >= batteryDelta) return true;

  return false;
}

async function updateSnapshotState(kv, robotId, next) {
  if (!kv) return;
  await kv.set(
    `snapshotState:${robotId}`,
    JSON.stringify({
      t: Date.now(),
      lat: typeof next?.lat === "number" ? next.lat : null,
      lon: typeof next?.lon === "number" ? next.lon : null,
      battery: typeof next?.battery === "number" ? next.battery : null,
    }),
    { ex: 3600 }
  );
}

async function loadRobotState({ prisma, kv, robotId } = {}) {
  if (!prisma || !kv || !robotId) return null;

  // 1) Primary: Redis live state
  try {
    const raw = await kv.get(`robot:${robotId}`);
    const live = safeJsonParse(raw);
    if (live && typeof live === "object") {
      const lat = typeof live.lat === "number" ? live.lat : null;
      const lon = typeof live.lon === "number" ? live.lon : null;
      const battery = typeof live.battery === "number" ? live.battery : null;
      const status = typeof live.status === "string" ? live.status : null;
      const speed = typeof live.speed === "number" ? live.speed : 0;
      const lastSeenAt = typeof live.lastSeenAt === "number" ? live.lastSeenAt : null;

      if (lat !== null && lon !== null) {
        return {
          robotId,
          robotRowId: null,
          lat,
          lon,
          battery,
          status: status && ROBOT_STATUS.has(status) ? status : "IDLE",
          speed,
          lastSeenAt,
        };
      }
    }
  } catch {
    // ignore
  }

  // 2) Fallback: DB (freeze protection if Redis key expired)
  const db = await prisma.robot.findUnique({
    where: { robotId },
    select: { id: true, lat: true, lon: true, battery: true, status: true, speed: true, lastSeenAt: true },
  });
  if (!db) return null;

  const seeded = {
    lat: typeof db.lat === "number" ? db.lat : null,
    lon: typeof db.lon === "number" ? db.lon : null,
    battery: typeof db.battery === "number" ? db.battery : null,
    status: typeof db.status === "string" ? db.status : "IDLE",
    speed: typeof db.speed === "number" ? db.speed : 0,
    lastSeenAt: db.lastSeenAt ? db.lastSeenAt.getTime?.() || null : null,
  };

  try {
    await kv.set(
      `robot:${robotId}`,
      JSON.stringify({
        lat: seeded.lat,
        lon: seeded.lon,
        battery: seeded.battery,
        status: seeded.status,
        speed: seeded.speed,
        lastSeenAt: seeded.lastSeenAt,
      }),
      { ex: 15 }
    );
  } catch {
    // ignore
  }

  return {
    robotId,
    robotRowId: db.id,
    ...seeded,
  };
}

async function computeTaskStep({ prisma, kv, robotId, base, nowMs } = {}) {
  if (!kv || !robotId || !base) return null;

  const stateRaw = await kv.get(`robotTaskState:${robotId}`);
  const state = safeJsonParse(stateRaw);
  const taskId = state?.taskId ? String(state.taskId) : null;
  if (!taskId) return null;

  const pathRaw = await kv.get(`taskPath:${taskId}`);
  const path = safeJsonParse(pathRaw);
  const toPickup = Array.isArray(path?.toPickup) ? path.toPickup : null;
  const toDrop = Array.isArray(path?.toDrop) ? path.toDrop : null;
  if (!toPickup || !toDrop || toPickup.length < 2 || toDrop.length < 2) return null;

  const curLat = typeof base.lat === "number" ? base.lat : null;
  const curLon = typeof base.lon === "number" ? base.lon : null;
  if (curLat === null || curLon === null) return null;

  const stateTtl = 86400;
  const WAIT_MS = 120000;
  const ARRIVE_METERS = 2.5;
  const STEP_METERS = 15.0;
  const SMOOTH_ALPHA = 0.2;
  const parkingMeters = 2.0;

  let phase = typeof state.phase === "string" ? state.phase : "TO_PICKUP";
  let pathIndex = typeof state.pathIndex === "number" ? state.pathIndex : 0;
  let waitUntil = typeof state.waitUntil === "number" ? state.waitUntil : null;
  let segment = typeof state.segment === "string" ? state.segment : "toPickup";
  let startedAt = typeof state.startedAt === "number" ? state.startedAt : null;
  let parking = state.parking && typeof state.parking === "object" ? state.parking : null;

  // Mark IN_PROGRESS once per task
  if (!startedAt && prisma) {
    try {
      await prisma.task.update({ where: { taskId }, data: { status: "IN_PROGRESS" } });
    } catch {
      // ignore
    }
    startedAt = nowMs;
  }

  const activePath = segment === "toDrop" ? toDrop : toPickup;
  const dest = activePath[activePath.length - 1];

  // WAIT
  if (phase === "WAIT_PICKUP" || phase === "WAIT_DROP") {
    if (waitUntil && nowMs < waitUntil) {
      const dLat = typeof parking?.dLat === "number" ? parking.dLat : 0;
      const dLon = typeof parking?.dLon === "number" ? parking.dLon : 0;
      const parkedLat = typeof dest?.lat === "number" ? dest.lat + dLat : curLat;
      const parkedLon = typeof dest?.lon === "number" ? dest.lon + dLon : curLon;

      await kv.set(
        `robotTaskState:${robotId}`,
        JSON.stringify({ taskId, phase, pathIndex, waitUntil, segment, startedAt, parking }),
        { ex: stateTtl }
      );

      return {
        taskId,
        phase,
        pathIndex,
        waitUntil,
        segment,
        movement: { lat: parkedLat, lon: parkedLon, speed: 0, heading: headingAtan2Deg(curLat, curLon, parkedLat, parkedLon) },
        completed: false,
      };
    }

    // wait over
    if (phase === "WAIT_PICKUP") {
      phase = "TO_DROP";
      segment = "toDrop";
      pathIndex = 0;
      waitUntil = null;
      parking = null;
      await kv.set(
        `robotTaskState:${robotId}`,
        JSON.stringify({ taskId, phase, pathIndex, waitUntil, segment, startedAt, parking }),
        { ex: stateTtl }
      );
      return {
        taskId,
        phase,
        pathIndex,
        waitUntil,
        segment,
        movement: { lat: curLat, lon: curLon, speed: 0, heading: null },
        completed: false,
      };
    }

    // WAIT_DROP finished => COMPLETE
    await Promise.all([
      kv.del(`robotTaskState:${robotId}`),
      kv.del(`robotTask:${robotId}`),
    ]);

    return {
      taskId,
      phase: "COMPLETE",
      pathIndex: 0,
      waitUntil: null,
      segment,
      movement: { lat: curLat, lon: curLon, speed: 0, heading: null },
      completed: true,
    };
  }

  // MOVE (index-based)
  pathIndex = Math.max(0, Math.min(activePath.length - 1, pathIndex));
  const target = activePath[pathIndex];
  if (typeof target?.lat !== "number" || typeof target?.lon !== "number") return null;

  const dist = haversineMeters(curLat, curLon, target.lat, target.lon);
  const arrived = dist <= ARRIVE_METERS;

  let nextLat = curLat;
  let nextLon = curLon;
  let nextIndex = pathIndex;

  // Guard against end-of-path crashes.
  const nextPoint = activePath[pathIndex + 1] || activePath[pathIndex];

  if (arrived) {
    nextLat = target.lat;
    nextLon = target.lon;
    nextIndex = Math.min(activePath.length - 1, pathIndex + 1);
  } else {
    // Move toward the current index target with a fixed step, then apply micro-smoothing.
    const t = Math.min(1, STEP_METERS / Math.max(dist, 0.001));
    const desiredLat = lerp(curLat, target.lat, t);
    const desiredLon = lerp(curLon, target.lon, t);
    nextLat = lerp(curLat, desiredLat, SMOOTH_ALPHA);
    nextLon = lerp(curLon, desiredLon, SMOOTH_ALPHA);
  }

  const heading = headingAtan2Deg(
    curLat,
    curLon,
    typeof nextPoint?.lat === "number" ? nextPoint.lat : nextLat,
    typeof nextPoint?.lon === "number" ? nextPoint.lon : nextLon
  );

  // If we're at or beyond the final index, transition cleanly.
  const atEnd = pathIndex >= activePath.length - 1 && arrived;
  if (segment === "toPickup" && atEnd) {
    // parking offset perpendicular to final segment
    const prev = activePath[Math.max(0, activePath.length - 2)];
    const h = typeof prev?.lat === "number" && typeof prev?.lon === "number" ? headingAtan2Deg(prev.lat, prev.lon, target.lat, target.lon) : 0;
    const perp = ((h + 90) * Math.PI) / 180;
    const dLat = metersToLatDeg(parkingMeters * Math.cos(perp));
    const dLon = metersToLonDeg(parkingMeters * Math.sin(perp), target.lat);

    phase = "WAIT_PICKUP";
    waitUntil = nowMs + WAIT_MS;
    parking = { dLat, dLon };

    const doneIndex = activePath.length - 1;
    await kv.set(
      `robotTaskState:${robotId}`,
      JSON.stringify({ taskId, phase, pathIndex: doneIndex, waitUntil, segment, startedAt, parking }),
      { ex: stateTtl }
    );

    return {
      taskId,
      phase,
      pathIndex: activePath.length - 1,
      waitUntil,
      segment,
      movement: {
        lat: target.lat + dLat,
        lon: target.lon + dLon,
        speed: 0,
        heading: headingAtan2Deg(curLat, curLon, target.lat + dLat, target.lon + dLon),
      },
      completed: false,
    };
  }

  if (segment === "toDrop" && atEnd) {
    const prev = activePath[Math.max(0, activePath.length - 2)];
    const h = typeof prev?.lat === "number" && typeof prev?.lon === "number" ? headingAtan2Deg(prev.lat, prev.lon, target.lat, target.lon) : 0;
    const perp = ((h + 90) * Math.PI) / 180;
    const dLat = metersToLatDeg(parkingMeters * Math.cos(perp));
    const dLon = metersToLonDeg(parkingMeters * Math.sin(perp), target.lat);

    phase = "WAIT_DROP";
    waitUntil = nowMs + WAIT_MS;
    parking = { dLat, dLon };

    const doneIndex = activePath.length - 1;
    await kv.set(
      `robotTaskState:${robotId}`,
      JSON.stringify({ taskId, phase, pathIndex: doneIndex, waitUntil, segment, startedAt, parking }),
      { ex: stateTtl }
    );

    return {
      taskId,
      phase,
      pathIndex: activePath.length - 1,
      waitUntil,
      segment,
      movement: {
        lat: target.lat + dLat,
        lon: target.lon + dLon,
        speed: 0,
        heading: headingAtan2Deg(curLat, curLon, target.lat + dLat, target.lon + dLon),
      },
      completed: false,
    };
  }

  // continue
  await kv.set(
    `robotTaskState:${robotId}`,
    JSON.stringify({ taskId, phase, pathIndex: nextIndex, waitUntil: null, segment, startedAt, parking: null }),
    { ex: stateTtl }
  );

  return {
    taskId,
    phase,
    pathIndex: nextIndex,
    waitUntil: null,
    segment,
    movement: { lat: nextLat, lon: nextLon, speed: 1.5, heading },
    completed: false,
  };
}

async function shouldWriteDb(kv, robotId, next, { minIntervalMs = 8000, moveMeters = 15, batteryDelta = 2 } = {}) {
  const key = `simdb:${robotId}`;
  const now = Date.now();

  let prev = null;
  try {
    const raw = await kv.get(key);
    prev = raw ? JSON.parse(raw) : null;
  } catch {
    prev = null;
  }

  if (!prev || typeof prev !== "object") {
    return { write: true, prev: null };
  }

  const lastWriteAt = typeof prev.t === "number" ? prev.t : 0;
  if (!lastWriteAt || now - lastWriteAt >= minIntervalMs) {
    return { write: true, prev };
  }

  const pStatus = typeof prev.status === "string" ? prev.status : null;
  if (pStatus && next.status && pStatus !== next.status) return { write: true, prev };

  const pBat = typeof prev.battery === "number" ? prev.battery : null;
  if (pBat !== null && typeof next.battery === "number") {
    if (Math.abs(next.battery - pBat) >= batteryDelta) return { write: true, prev };
  }

  const pLat = typeof prev.lat === "number" ? prev.lat : null;
  const pLon = typeof prev.lon === "number" ? prev.lon : null;
  if (pLat !== null && pLon !== null && typeof next.lat === "number" && typeof next.lon === "number") {
    const moved = haversineMeters(pLat, pLon, next.lat, next.lon);
    if (moved >= moveMeters) return { write: true, prev };
  }

  return { write: false, prev };
}

async function recordDbWrite(kv, robotId, next) {
  const state = {
    t: Date.now(),
    lat: typeof next.lat === "number" ? next.lat : null,
    lon: typeof next.lon === "number" ? next.lon : null,
    battery: typeof next.battery === "number" ? next.battery : null,
    status: typeof next.status === "string" ? next.status : null,
  };
  await kv.set(`simdb:${robotId}`, JSON.stringify(state), { ex: 3600 });
}

function createSimulationEngine({ prisma, kv, io, logger }) {
  const log = logger || console;

  let timer = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;

    try {
      if (!kv || typeof kv.smembers !== "function") return;

      const robotIds = await kv.smembers("robots:all");
      const ids = Array.isArray(robotIds) ? robotIds.map((r) => toStringOrNull(r)).filter(Boolean) : [];
      if (ids.length === 0) return;

      const nowMs = Date.now();
      const now = new Date(nowMs);

      const batches = chunk(ids, 50);
      for (const batch of batches) {
        const redisWrites = [];
        const socketBatch = [];

        await Promise.allSettled(
          batch.map(async (robotId) => {
            try {
              // Never fight with a connected real robot.
              if (getRobotSocket(robotId)) return;

              const base = await loadRobotState({ prisma, kv, robotId });
              if (!base) {
                if (typeof kv.srem === "function") await kv.srem("robots:all", robotId);
                return;
              }

              const taskStep = await computeTaskStep({ prisma, kv, robotId, base, nowMs, now });

              const seededStatus = taskStep ? (taskStep.completed ? "IDLE" : "ACTIVE") : base.status;
              const { battery, status } = applyBatteryAndStatus({ battery: base.battery, status: seededStatus });

              const finalStatus = taskStep
                ? status === "ERROR" || status === "PAUSED" || status === "ISSUES"
                  ? status
                  : taskStep.completed
                    ? "IDLE"
                    : "ACTIVE"
                : status;

              const movement = taskStep
                ? {
                    lat: taskStep?.movement?.lat,
                    lon: taskStep?.movement?.lon,
                    speed: typeof taskStep?.movement?.speed === "number" ? taskStep.movement.speed : 0,
                    heading: typeof taskStep?.movement?.heading === "number" ? taskStep.movement.heading : null,
                  }
                : applyMovement({ lat: base.lat, lon: base.lon, status: finalStatus });

              const next = {
                robotId,
                lat: movement.lat,
                lon: movement.lon,
                battery: clamp(battery, 0, 100),
                status: finalStatus,
                speed: movement.speed,
                isOnline: true,
                lastSeenAt: nowMs,
              };

              // Redis primary live state (minimal schema, overwrite, EX=15)
              redisWrites.push({
                key: `robot:${robotId}`,
                value: JSON.stringify({
                  lat: next.lat,
                  lon: next.lon,
                  battery: next.battery,
                  status: next.status,
                  speed: next.speed,
                  lastSeenAt: next.lastSeenAt,
                }),
                ex: 15,
              });

              // Task completion is event-based (not throttled)
              if (taskStep?.completed && taskStep?.taskId) {
                try {
                  await prisma.$transaction(async (tx) => {
                    await tx.task.update({ where: { taskId: String(taskStep.taskId) }, data: { status: "COMPLETED" } });
                    await tx.robot.update({
                      where: { robotId },
                      data: { currentTaskId: null, status: "IDLE", speed: 0, isOnline: true, lastSeenAt: now },
                    });
                  });
                } catch {
                  // ignore
                }
              }

              // 2) DB secondary update (STRICT throttle: >= 15s)
              const last = lastDbWrite.get(robotId) || 0;
              if (nowMs - last >= 15_000) {
                lastDbWrite.set(robotId, nowMs);

                let robotRowId = base.robotRowId;
                if (!robotRowId) {
                  const db = await prisma.robot.findUnique({ where: { robotId }, select: { id: true } });
                  robotRowId = db?.id || null;
                }

                await prisma.robot.update({
                  where: { robotId },
                  data: {
                    ...(typeof next.lat === "number" ? { lat: next.lat } : {}),
                    ...(typeof next.lon === "number" ? { lon: next.lon } : {}),
                    ...(typeof next.battery === "number" ? { battery: next.battery } : {}),
                    status: next.status,
                    speed: next.speed,
                    isOnline: true,
                    lastSeenAt: now,
                  },
                });

                await recordDbWrite(kv, robotId, next);

                // 3) Telemetry snapshot (event-based thresholds)
                if (robotRowId) {
                  const should = await shouldStoreSnapshotSmart(
                    kv,
                    robotId,
                    { lat: next.lat, lon: next.lon, battery: next.battery },
                    { maxSeconds: 15, moveDegreesThreshold: 0.0001, batteryDelta: 2 }
                  );
                  if (should) {
                    await telemetryService.saveTelemetry(
                      prisma,
                      robotRowId,
                      { lat: next.lat, lon: next.lon, speed: next.speed, battery: next.battery },
                      now
                    );
                    await updateSnapshotState(kv, robotId, { lat: next.lat, lon: next.lon, battery: next.battery });
                  }
                }
              }

              // 4) Socket emit (BATCH, lightweight)
              socketBatch.push({
                robotId,
                lat: next.lat,
                lon: next.lon,
                battery: next.battery,
                status: next.status,
                speed: next.speed,
                isOnline: true,
                lastSeenAt: next.lastSeenAt,
                ...(typeof movement.heading === "number" ? { heading: movement.heading } : {}),
                ...(taskStep?.taskId
                  ? {
                      task: {
                        taskId: String(taskStep.taskId),
                        phase: taskStep.phase,
                        pathIndex: typeof taskStep.pathIndex === "number" ? taskStep.pathIndex : null,
                        segment: typeof taskStep.segment === "string" ? taskStep.segment : null,
                      },
                    }
                  : {}),
              });
            } catch (e) {
              log.error("Simulation tick failed for robot", { robotId, e });
            }
          })
        );

        // Redis pipelining (performance)
        try {
          if (redisWrites.length) await kv.setManyEx(redisWrites);
        } catch {
          // ignore
        }

        // Socket batch emit (scale)
        try {
          if (socketBatch.length) {
            io?.to("dashboard")?.emit("ROBOT_UPDATE_BATCH", socketBatch);
          }
        } catch {
          // ignore
        }
      }
    } catch (e) {
      log.error("Simulation loop failed", e);
    } finally {
      running = false;
    }
  }

  function start({ intervalMs = 2000 } = {}) {
    if (timer) return;

    // Global simulation lock: prevent multiple loops after restarts/hot-reload.
    if (global.simulationRunning) return;
    global.simulationRunning = true;

    timer = setInterval(tick, intervalMs);
    // Don’t keep the process open if this is the only thing left.
    if (typeof timer.unref === "function") timer.unref();
    log.info("Simulation engine started", { intervalMs });
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    if (global.simulationRunning) global.simulationRunning = false;
    log.info("Simulation engine stopped");
  }

  return { start, stop, tick };
}

module.exports = {
  createSimulationEngine,
};

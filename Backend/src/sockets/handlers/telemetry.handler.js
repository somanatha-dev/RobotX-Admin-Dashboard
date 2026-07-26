const { toNumberOrNull, toStringOrNull } = require("../../utils/parse");
const telemetryService = require("../../services/telemetry.service");
const { allow } = require("../rateLimit");
const { z } = require("zod");
const { updateTelemetry, getRobotState, updateUtilization } = require("../../services/robotRegistry.service");
const { assignRobotToZone } = require("../../services/zoneManager.service");
const { haversineMeters } = require("../../utils/distance");

// DB-safe statuses (must map to the RobotStatus Prisma enum)
const ROBOT_STATUS = new Set(["IDLE", "ACTIVE", "PAUSED", "OFFLINE", "ERROR", "ISSUES"]);
// Wider set accepted from robots (RETURNING and CHARGING are virtual-only labels)
const INCOMING_STATUS = new Set(["IDLE", "ACTIVE", "PAUSED", "OFFLINE", "ERROR", "ISSUES", "RETURNING", "CHARGING"]);

const TRANSITIONS = {
  IDLE:     new Set(["ACTIVE", "PAUSED", "ERROR", "ISSUES", "OFFLINE", "CHARGING"]),
  ACTIVE:   new Set(["PAUSED", "IDLE", "ERROR", "ISSUES", "OFFLINE"]),
  PAUSED:   new Set(["ACTIVE", "IDLE", "ERROR", "ISSUES", "OFFLINE", "CHARGING"]),
  CHARGING: new Set(["IDLE", "ACTIVE", "PAUSED", "ERROR", "OFFLINE"]),
  ISSUES:   new Set(["ACTIVE", "PAUSED", "IDLE", "ERROR", "OFFLINE", "CHARGING"]),
  ERROR:    new Set(["IDLE", "ACTIVE", "OFFLINE", "ISSUES"]),
  OFFLINE:  new Set(["IDLE", "ACTIVE", "ERROR", "ISSUES", "PAUSED", "CHARGING"]),
};

// F10: dirty-state/time-based Postgres flush gate for the telemetry pipeline.
// Per-process, in-memory (same pattern as sockets/rateLimit.js) — bounded by
// fleet size (one entry per robotId ever seen live), not per-tick.
//
// The interval is shared with robot.handler.js's HEARTBEAT gate and paired
// with the offline sweep's cutoff — see config/liveness.constants.js for the
// invariant between them.
const { DB_FLUSH_INTERVAL_MS } = require("../../config/liveness.constants");
const lastDbFlushAt = new Map();

function mapIncomingStatusToDb(status) {
  // RETURNING is displayed as ACTIVE in the DB (robot is in transit).
  if (status === "RETURNING") return "ACTIVE";
  // CHARGING is not in the Prisma enum — store as PAUSED (robot is stationary).
  // The raw "CHARGING" value is preserved in Redis and broadcast to the dashboard.
  if (status === "CHARGING") return "PAUSED";
  return status;
}


async function updateSnapshotState(kv, robotId, { lat, lon, battery }) {
  const state = {
    t: Date.now(),
    lat: typeof lat === "number" ? lat : null,
    lon: typeof lon === "number" ? lon : null,
    battery: typeof battery === "number" ? battery : null,
  };
  await kv.set(`snapshotState:${robotId}`, JSON.stringify(state), { ex: 86400 });
}

async function shouldStoreSnapshotSmart(
  kv,
  robotId,
  { lat, lon, battery },
  { maxSeconds = 15, moveDegreesThreshold = 0.0001, batteryDelta = 2 } = {}
) {
  const key = `snapshotState:${robotId}`;
  const now = Date.now();
  const raw = await kv.get(key);
  let prev = null;
  try {
    prev = raw ? JSON.parse(raw) : null;
  } catch {
    prev = null;
  }

  if (!prev || typeof prev !== "object") return true;

  const prevT = typeof prev.t === "number" ? prev.t : 0;
  if (prevT && now - prevT >= maxSeconds * 1000) return true;

  const pLat = typeof prev.lat === "number" ? prev.lat : null;
  const pLon = typeof prev.lon === "number" ? prev.lon : null;
  const pBat = typeof prev.battery === "number" ? prev.battery : null;

  if (
    pLat !== null &&
    pLon !== null &&
    typeof lat === "number" &&
    typeof lon === "number" &&
    (Math.abs(lat - pLat) > moveDegreesThreshold || Math.abs(lon - pLon) > moveDegreesThreshold)
  )
    return true;

  if (pBat !== null && typeof battery === "number") {
    if (Math.abs(battery - pBat) >= batteryDelta) return true;
  }

  return false;
}

function registerTelemetryHandlers(io, socket, { prisma, kv, logger }) {
  const log = logger || console;

  const bufferedLimit = Number(process.env.SOCKET_BUFFER_LIMIT_BYTES || 1_000_000);

  function shouldDropForBackpressure() {
    try {
      const ws = socket?.conn?.transport?.ws;
      const amount = ws && typeof ws.bufferedAmount === "number" ? ws.bufferedAmount : null;
      if (amount !== null && Number.isFinite(bufferedLimit) && bufferedLimit > 0) {
        return amount > bufferedLimit;
      }
    } catch {
      // ignore
    }
    return false;
  }

  const numOpt = z.preprocess((v) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (typeof v === "string") {
      const t = v.trim();
      if (!t) return null;
      const n = Number(t);
      return Number.isFinite(n) ? n : null;
    }
    return v;
  }, z.number().nullable().optional());

  const telemetrySchema = z
    .object({
      robotId: z.union([z.string(), z.number()]).optional().transform((v) => (v === undefined ? v : String(v))),
      lat: numOpt,
      lon: numOpt,
      speed: numOpt,
      battery: numOpt,
      status: z.union([z.string(), z.number()]).optional().nullable().transform((v) => (v === null || v === undefined ? v : String(v))),
      distanceTravelled: numOpt,
    })
    .passthrough();

  async function handleTelemetry(data) {
    try {
      // Drop frames under transport backpressure (flood protection)
      if (shouldDropForBackpressure()) return;

      if (!allow(socket, "TELEMETRY", { limit: 50, windowMs: 5_000, minIntervalMs: 100 })) return;

      const parsed = telemetrySchema.safeParse(data || {});
      if (!parsed.success) return;
      const payload = parsed.data;

      // F26: every TELEMETRY frame requires a successful AUTH first. Only
      // robot.handler.js's AUTH success path may bind socket.data.robotId —
      // no first-telemetry binding, no unauthenticated fallback.
      if (!socket.data.isAuthed || !socket.data.robotId) {
        socket.emit("AUTH_REQUIRED", { robotId: toStringOrNull(payload?.robotId) });
        return;
      }

      const robotId = toStringOrNull(socket.data.robotId);
      if (!robotId) return;

      const nowMs = Date.now();
      const now = new Date(nowMs);
      const lat = toNumberOrNull(payload?.lat);
      const lon = toNumberOrNull(payload?.lon);
      const speed = toNumberOrNull(payload?.speed);
      const battery = toNumberOrNull(payload?.battery);
      const status = toStringOrNull(payload?.status);
      const headingIn = toNumberOrNull(payload?.heading);
      // VirtualRobots send distanceTravelled directly; real robots get it accumulated below.
      const distanceTravelledIn = toNumberOrNull(payload?.distanceTravelled);

      const statusRaw = status && INCOMING_STATUS.has(status) ? status : null;
      const statusDb = statusRaw ? mapIncomingStatusToDb(statusRaw) : null;

      // Reject unknown robotId (must exist in DB).
      const existing = await prisma.robot.findUnique({
        where: { robotId },
        select: { id: true, status: true, lat: true, lon: true, speed: true, battery: true, isOnline: true },
      });
      if (!existing) {
        io.emit("robot_unregistered", { robotId });
        return;
      }

      let statusUpdate = {};
      if (statusDb && ROBOT_STATUS.has(statusDb)) {
        const cur = String(existing.status || "");
        const allowed = TRANSITIONS[cur];
        if (!allowed || allowed.has(statusDb) || cur === statusDb) {
          statusUpdate = { status: statusDb };
        } else {
          log.warn("Invalid robot status transition", { robotId, from: cur, to: statusDb, raw: statusRaw });
        }
      }

      // 1) Build full state (enrich minimal payload)
      let prevState = null;
      try {
        const raw = await kv.get(`robot:${robotId}`);
        if (raw) prevState = JSON.parse(raw);
      } catch {
        prevState = null;
      }

      const fullState = {
        robotId,
        lat:
          typeof lat === "number"
            ? lat
            : typeof prevState?.lat === "number"
              ? prevState.lat
              : typeof existing.lat === "number"
                ? existing.lat
                : null,
        lon:
          typeof lon === "number"
            ? lon
            : typeof prevState?.lon === "number"
              ? prevState.lon
              : typeof existing.lon === "number"
                ? existing.lon
                : null,
        battery:
          typeof battery === "number"
            ? battery
            : typeof prevState?.battery === "number"
              ? prevState.battery
              : typeof existing.battery === "number"
                ? existing.battery
                : null,
        // Use the RAW incoming status (e.g. "CHARGING") for Redis + socket broadcast.
        // statusDb (e.g. "PAUSED") is used only for the DB write below.
        status:
          statusRaw ||
          (typeof prevState?.status === "string" ? prevState.status : null) ||
          (existing.status ? String(existing.status) : "IDLE"),
        speed:
          typeof speed === "number"
            ? speed
            : typeof prevState?.speed === "number"
              ? prevState.speed
              : typeof existing.speed === "number"
                ? existing.speed
                : 0,
        isOnline: true,
        lastSeenAt: nowMs,
        heading: typeof headingIn === "number" && Number.isFinite(headingIn) ? headingIn : null,
      };

      // distanceTravelled: VirtualRobots send it directly; for real robots we
      // accumulate haversine distance from the previous stored position.
      let distanceTravelled = typeof prevState?.distanceTravelled === "number"
        ? prevState.distanceTravelled
        : 0;

      if (typeof distanceTravelledIn === "number") {
        // VirtualRobot — trust the value it sends.
        distanceTravelled = distanceTravelledIn;
      } else if (
        typeof prevState?.lat === "number" && typeof prevState?.lon === "number" &&
        typeof fullState.lat === "number" && typeof fullState.lon === "number"
      ) {
        // Real robot — accumulate from position delta.
        const moved = haversineMeters(prevState.lat, prevState.lon, fullState.lat, fullState.lon);
        if (Number.isFinite(moved) && moved < 500) { // sanity: ignore GPS jumps > 500 m
          distanceTravelled += moved;
        }
      }

      fullState.distanceTravelled = Math.round(distanceTravelled);

      // 2) Store in Redis (final format)
      await kv.set(
        `robot:${robotId}`,
        JSON.stringify({
          lat: fullState.lat,
          lon: fullState.lon,
          battery: fullState.battery,
          status: fullState.status,
          speed: fullState.speed,
          lastSeenAt: fullState.lastSeenAt,
          distanceTravelled: fullState.distanceTravelled,
        }),
        { ex: 15 }
      );

      // 3) F10: Postgres is no longer written on every tick. Redis (steps 2/6/7 below)
      // remains the live source for the dashboard, DTARO, and REST reads — the DB row
      // only needs to be durable enough to survive a restart and to keep the DTARO
      // candidate query (which filters on DB status/isOnline) correct. We flush when:
      //   - status actually transitions (a DB-visible field DTARO's candidate query
      //     filters on), or
      //   - the robot just came back online (isOnline false->true), or
      //   - a dirty-state battery swing (>=2%, matches BATTERY_THRESHOLD-adjacent
      //     eligibility checks) happened since the last flush, or
      //   - DB_FLUSH_INTERVAL_MS has elapsed since the last flush for this robot
      //     (time-based catch-all so the row never goes stale by more than that).
      // Note: movement alone does NOT force a flush — position live-ness is carried
      // by Redis every tick regardless, so gating on distance-since-last-DB-write
      // would defeat the point (a moving robot covers >10m almost every 2s tick).
      // lastSeenAt-based offline detection is unaffected: robot.handler.js's HEARTBEAT
      // path already updates lastSeenAt every ~2s independently of this write.
      const statusChanged =
        Object.prototype.hasOwnProperty.call(statusUpdate, "status") &&
        statusUpdate.status !== String(existing.status || "");
      const reconnected = existing.isOnline === false;
      const batteryChanged =
        typeof fullState.battery === "number" &&
        typeof existing.battery === "number" &&
        Math.abs(fullState.battery - existing.battery) >= 2;
      const lastDbFlush = lastDbFlushAt.get(robotId) || 0;
      const timeDue = nowMs - lastDbFlush >= DB_FLUSH_INTERVAL_MS;

      if (statusChanged || reconnected || batteryChanged || timeDue) {
        await prisma.robot.update({
          where: { robotId },
          data: {
            ...(typeof fullState.lat === "number" ? { lat: fullState.lat } : {}),
            ...(typeof fullState.lon === "number" ? { lon: fullState.lon } : {}),
            ...(typeof fullState.battery === "number" ? { battery: fullState.battery } : {}),
            lastSeenAt: now,
            isOnline: true,
            ...statusUpdate,
          },
        });
        lastDbFlushAt.set(robotId, nowMs);
      }

      // 4) Snapshot (optional: time OR movement OR battery delta) — unchanged, still
      // its own independent throttle for the Telemetry history table.
      if (
        await shouldStoreSnapshotSmart(
          kv,
          robotId,
          { lat: fullState.lat, lon: fullState.lon, battery: fullState.battery },
          { maxSeconds: 15, moveDegreesThreshold: 10 / 111320, batteryDelta: 2 }
        )
      ) {
        await telemetryService.saveTelemetry(prisma, existing.id, { lat: fullState.lat, lon: fullState.lon, speed: fullState.speed, battery: fullState.battery }, now);
        await updateSnapshotState(kv, robotId, { lat: fullState.lat, lon: fullState.lon, battery: fullState.battery });
      }

      // DTARO: update registry with live telemetry
      try {
        await updateTelemetry(kv, robotId, {
          lat: fullState.lat,
          lon: fullState.lon,
          battery: fullState.battery,
          status: fullState.status,
          speed: fullState.speed,
        });
      } catch {
        // registry update is non-critical
      }

      // DTARO: update utilization ratio (EMA, α=0.05 — ACTIVE = busy, else idle).
      // Recovered from the deleted simulation.service.js reference implementation
      // (git show 3cc8e8b:Backend/src/services/simulation.service.js).
      try {
        const prevState = await getRobotState(kv, robotId);
        const prevUtil = typeof prevState?.utilization === "number" ? prevState.utilization : 0;
        const alpha = 0.05;
        const isActive = fullState.status === "ACTIVE" ? 1 : 0;
        const newUtil = prevUtil + alpha * (isActive - prevUtil);
        await updateUtilization(kv, robotId, newUtil);
      } catch {
        // registry update is non-critical
      }

      // DTARO: update zone membership if position changed
      try {
        const registryState = await getRobotState(kv, robotId);
        const currentZoneId = registryState?.zoneId || null;
        if (typeof fullState.lat === "number" && typeof fullState.lon === "number") {
          await assignRobotToZone(prisma, kv, io, robotId, fullState.lat, fullState.lon, socket, currentZoneId);
        }
      } catch {
        // zone assignment is non-critical
      }

      // Persist battery level every ~2 minutes so real robots also survive
      // server restarts with correct battery (mirrors VirtualRobot behaviour).
      // Only write when battery is a valid number and 120-second window elapsed.
      try {
        if (typeof fullState.battery === "number" && Number.isFinite(fullState.battery)) {
          const persistKey = `vr:battery:${robotId}`;
          const lastPersistKey = `vr:batteryPersistAt:${robotId}`;
          const lastPersistRaw = await kv.get(lastPersistKey);
          const lastPersist = lastPersistRaw ? Number(lastPersistRaw) : 0;
          if (nowMs - lastPersist >= 120_000) {
            const snap = Math.round(fullState.battery * 10) / 10;
            await Promise.all([
              kv.set(persistKey,     String(snap), { ex: 48 * 3600 }),
              kv.set(lastPersistKey, String(nowMs), { ex: 48 * 3600 }),
            ]);
          }
        }
      } catch { /* non-critical */ }

      log.info(`[ROBOT ${robotId}] TELEMETRY`, { lat, lon, speed, battery, status });

      // 5) Emit live state to all connected clients.
      // Single canonical event — frontend subscribes only to "robot:update".
      // "ROBOT_UPDATE" and "robot_update" were legacy aliases; removed to
      // eliminate 2 redundant socket emissions and 1 DB query per tick.
      io.emit("robot:update", fullState);
    } catch (e) {
      log.error("TELEMETRY handler failed", e);
    }
  }

  socket.on("TELEMETRY", handleTelemetry);
  // Backward compatible alias.
  socket.on("telemetry", handleTelemetry);
}

module.exports = {
  registerTelemetryHandlers,
};

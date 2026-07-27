const { toNumberOrNull, toStringOrNull } = require("../../utils/parse");
const telemetryService = require("../../services/telemetry.service");
const { allow } = require("../rateLimit");
const { z } = require("zod");
const { registryKey, buildMergedRegistryState, REGISTRY_TTL: REGISTRY_TTL_SEC } = require("../../services/robotRegistry.service");
const { getZoneForCoordinates, applyZoneChangeSideEffects } = require("../../services/zoneManager.service");
const { haversineMeters } = require("../../utils/distance");
const robotStateCache = require("../../cache/robotStateCache");

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

// Per-robot sample throttle for the DEBUG-level telemetry log (same
// per-process, bounded-by-fleet-size pattern as lastDbFlushAt above). Default
// gives a once-per-10s-per-robot heartbeat when LOG_LEVEL=debug — enough to
// eyeball the live stream without reproducing full per-tick log volume.
const TELEMETRY_LOG_SAMPLE_MS = Number(process.env.TELEMETRY_LOG_SAMPLE_MS || 10_000);
const lastTelemetryLogAt = new Map();

function mapIncomingStatusToDb(status) {
  // RETURNING is displayed as ACTIVE in the DB (robot is in transit).
  if (status === "RETURNING") return "ACTIVE";
  // CHARGING is not in the Prisma enum — store as PAUSED (robot is stationary).
  // The raw "CHARGING" value is preserved in Redis and broadcast to the dashboard.
  if (status === "CHARGING") return "PAUSED";
  return status;
}


// Pure — builds the value to SET under snapshotState:{robotId}. Split from
// the write itself so the telemetry hot path can queue it into a batched
// pipeline instead of awaiting its own round trip (see handleTelemetry).
function buildSnapshotStateValue({ lat, lon, battery }) {
  return {
    t: Date.now(),
    lat: typeof lat === "number" ? lat : null,
    lon: typeof lon === "number" ? lon : null,
    battery: typeof battery === "number" ? battery : null,
  };
}

// Pure — same decision logic as before, just fed the already-fetched raw
// snapshotState value (from the batched read) instead of doing its own GET.
function computeSnapshotDecision(
  rawPrev,
  { lat, lon, battery },
  { maxSeconds = 15, moveDegreesThreshold = 0.0001, batteryDelta = 2 } = {}
) {
  const now = Date.now();
  let prev = null;
  try {
    prev = rawPrev ? JSON.parse(rawPrev) : null;
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

      // "existing" used to be a fresh `prisma.robot.findUnique` on every
      // single TELEMETRY frame — the dominant per-tick DB cost (confirmed by
      // benchmark: REST latency jumped 77ms -> 21s between 100 and 500
      // concurrently-active robots, tracking Postgres pool contention from
      // this exact read). It's now served from robotStateCache, seeded once
      // at AUTH and kept in sync by every writer of Robot.status/isOnline
      // (see cache/robotStateCache.js for the full list). Falls back to a
      // one-time DB read only on a cache miss, which should be rare.
      let existing = robotStateCache.get(robotId);
      if (!existing) {
        const row = await prisma.robot.findUnique({
          where: { robotId },
          select: { id: true, status: true, lat: true, lon: true, speed: true, battery: true, isOnline: true },
        });
        if (!row) {
          io.to("dashboard").emit("robot_unregistered", { robotId });
          return;
        }
        existing = row;
        robotStateCache.set(robotId, existing);
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
      //
      // Every Redis read this handler needs — live state, snapshot-throttle
      // state, registry state, battery-persist gate — is keyed only by
      // robotId, with no dependency on each other, so they're fetched in one
      // pipelined round trip instead of 4 sequential ones (was: ~4 GET + ~2
      // SET = ~6 round trips/event; benchmark-profiled as ~17% of all CPU
      // samples going into ioredis's per-command socket write). The writes
      // below are similarly queued into one pipeline and flushed once at the
      // end of the handler instead of individually awaited.
      const robotKey = `robot:${robotId}`;
      const snapshotKey = `snapshotState:${robotId}`;
      const registryKeyStr = registryKey(robotId);
      const batteryPersistKey = `vr:batteryPersistAt:${robotId}`;

      const [rawPrevState, rawSnapshotPrev, rawRegistryExisting, rawLastPersist] = await kv
        .pipeline()
        .get(robotKey)
        .get(snapshotKey)
        .get(registryKeyStr)
        .get(batteryPersistKey)
        .exec();

      const writes = kv.pipeline();

      let prevState = null;
      try {
        if (rawPrevState) prevState = JSON.parse(rawPrevState);
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

      // 2) Store in Redis (final format) — queued, flushed with the rest of
      // this tick's writes at the end of the handler (see `writes.exec()`).
      writes.set(
        robotKey,
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
        try {
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
          robotStateCache.set(robotId, {
            status: statusUpdate.status || existing.status,
            isOnline: true,
            lat: typeof fullState.lat === "number" ? fullState.lat : existing.lat,
            lon: typeof fullState.lon === "number" ? fullState.lon : existing.lon,
            battery: typeof fullState.battery === "number" ? fullState.battery : existing.battery,
          });
        } catch (e) {
          if (e?.code === "P2025") {
            // Robot was deleted from DB while still connected (admin
            // decommission mid-session) — self-heal: same signal the old
            // per-tick findUnique gave every tick, now surfaced on the
            // write that actually discovers it instead.
            robotStateCache.del(robotId);
            io.to("dashboard").emit("robot_unregistered", { robotId });
            return;
          }
          throw e;
        }
      }

      // 4) Snapshot (optional: time OR movement OR battery delta) — unchanged, still
      // its own independent throttle for the Telemetry history table. Decision
      // uses the batched-read snapshotState value; the write (if due) is
      // queued below instead of its own round trip.
      const shouldSnapshot = computeSnapshotDecision(
        rawSnapshotPrev,
        { lat: fullState.lat, lon: fullState.lon, battery: fullState.battery },
        { maxSeconds: 15, moveDegreesThreshold: 10 / 111320, batteryDelta: 2 }
      );
      if (shouldSnapshot) {
        await telemetryService.saveTelemetry(prisma, existing.id, { lat: fullState.lat, lon: fullState.lon, speed: fullState.speed, battery: fullState.battery }, now);
        writes.set(
          snapshotKey,
          JSON.stringify(buildSnapshotStateValue({ lat: fullState.lat, lon: fullState.lon, battery: fullState.battery })),
          { ex: 86400 }
        );
      }

      // DTARO: telemetry fields + utilization EMA + zone membership, merged
      // into a single registry read-modify-write — computed here (pure) from
      // the batched-read registry value and queued into the same write
      // pipeline as everything else this tick, instead of mergeRobotState's
      // own independent GET+SET. Zone lookup itself (getZoneForCoordinates)
      // is a separate, cheap, in-process-cached call — not a per-tick Redis
      // hit (see zoneManager.service.js's 3-tier cache).
      let zoneChangeInfo = null;
      try {
        const zone =
          typeof fullState.lat === "number" && typeof fullState.lon === "number"
            ? await getZoneForCoordinates(prisma, kv, fullState.lat, fullState.lon)
            : null;
        // undefined = "position unknown this tick, don't touch zoneId" —
        // distinct from null, which means "known position, outside all zones".
        const newZoneId = zone?.id ?? (zone === null && typeof fullState.lat === "number" ? null : undefined);

        const mergedRegistry = buildMergedRegistryState(robotId, rawRegistryExisting, (existing) => {
          const prevUtil = typeof existing.utilization === "number" ? existing.utilization : 0;
          const alpha = 0.05;
          const isActive = fullState.status === "ACTIVE" ? 1 : 0;
          const nextUtil = Math.max(0, Math.min(1, prevUtil + alpha * (isActive - prevUtil)));

          const prevZoneId = existing.zoneId ?? null;
          const resolvedZoneId = newZoneId !== undefined ? newZoneId : prevZoneId;
          if (newZoneId !== undefined && newZoneId !== prevZoneId) {
            zoneChangeInfo = { oldZoneId: prevZoneId, newZoneId, zoneName: zone?.name || null };
          }

          return {
            lat: fullState.lat,
            lon: fullState.lon,
            battery: fullState.battery,
            status: fullState.status,
            speed: fullState.speed,
            lastHeartbeat: nowMs,
            utilization: nextUtil,
            zoneId: resolvedZoneId,
          };
        });
        writes.set(registryKeyStr, JSON.stringify(mergedRegistry), { ex: REGISTRY_TTL_SEC });
      } catch {
        // registry update is non-critical
      }

      if (zoneChangeInfo) {
        try {
          await applyZoneChangeSideEffects(
            prisma, io, robotId,
            zoneChangeInfo.oldZoneId, zoneChangeInfo.newZoneId, zoneChangeInfo.zoneName,
            socket
          );
        } catch {
          // zone side-effects are non-critical
        }
      }

      // Persist battery level every ~2 minutes so real robots also survive
      // server restarts with correct battery (mirrors VirtualRobot behaviour).
      // Only write when battery is a valid number and 120-second window
      // elapsed. Gate check uses the batched-read value; writes (if due) are
      // queued below instead of their own Promise.all round trip.
      try {
        if (typeof fullState.battery === "number" && Number.isFinite(fullState.battery)) {
          const persistKey = `vr:battery:${robotId}`;
          const lastPersist = rawLastPersist ? Number(rawLastPersist) : 0;
          if (nowMs - lastPersist >= 120_000) {
            const snap = Math.round(fullState.battery * 10) / 10;
            writes.set(persistKey, String(snap), { ex: 48 * 3600 });
            writes.set(batteryPersistKey, String(nowMs), { ex: 48 * 3600 });
          }
        }
      } catch { /* non-critical */ }

      // Flush this tick's Redis writes — robot:*, registry:*, and whichever
      // of snapshotState:*/vr:battery* were queued above — as one pipelined
      // round trip instead of up to 4 individually-awaited SETs.
      try {
        await writes.exec();
      } catch { /* non-critical — same degrade-gracefully policy as before */ }

      // Sampled DEBUG-level telemetry log. Unconditional INFO-level logging
      // here was measured (2026-07-26 CPU profile) to be a meaningful share
      // of runtime cost for negligible operational value at fleet scale.
      // debug level means it's silent by default in production
      // (LOG_LEVEL=info); the once-per-robot-per-interval sample keeps a live
      // heartbeat available for local debugging (LOG_LEVEL=debug) without
      // reproducing full per-tick volume even then.
      const lastLogAt = lastTelemetryLogAt.get(robotId) || 0;
      if (nowMs - lastLogAt >= TELEMETRY_LOG_SAMPLE_MS) {
        lastTelemetryLogAt.set(robotId, nowMs);
        log.debug(`[ROBOT ${robotId}] TELEMETRY`, { lat, lon, speed, battery, status });
      }

      // 5) Emit live state to dashboard clients.
      // Single canonical event — frontend subscribes only to "robot:update".
      // "ROBOT_UPDATE" and "robot_update" were legacy aliases; removed to
      // eliminate 2 redundant socket emissions and 1 DB query per tick.
      // Was a global io.emit (every connected socket, including every OTHER
      // robot, which have no use for this event) — an O(N²) fan-out pattern
      // at fleet scale, flagged in system.md §16. Scoped to the dashboard
      // room, which only browser dashboard clients join.
      io.to("dashboard").emit("robot:update", fullState);
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

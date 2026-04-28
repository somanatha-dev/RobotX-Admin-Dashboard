const { toNumberOrNull, toStringOrNull } = require("../../utils/parse");
const telemetryService = require("../../services/telemetry.service");
const { allow } = require("../rateLimit");
const { z } = require("zod");

const ROBOT_STATUS = new Set(["IDLE", "ACTIVE", "PAUSED", "OFFLINE", "ERROR", "ISSUES"]);
const INCOMING_STATUS = new Set(["IDLE", "ACTIVE", "PAUSED", "OFFLINE", "ERROR", "ISSUES", "RETURNING"]);

const TRANSITIONS = {
  IDLE: new Set(["ACTIVE", "PAUSED", "ERROR", "ISSUES", "OFFLINE"]),
  ACTIVE: new Set(["PAUSED", "IDLE", "ERROR", "ISSUES", "OFFLINE"]),
  PAUSED: new Set(["ACTIVE", "IDLE", "ERROR", "ISSUES", "OFFLINE"]),
  ISSUES: new Set(["ACTIVE", "PAUSED", "IDLE", "ERROR", "OFFLINE"]),
  ERROR: new Set(["IDLE", "ACTIVE", "OFFLINE", "ISSUES"]),
  OFFLINE: new Set(["IDLE", "ACTIVE", "ERROR", "ISSUES", "PAUSED"]),
};

function mapIncomingStatusToDb(status) {
  if (status === "RETURNING") return "ACTIVE";
  return status;
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

      // Prefer authenticated robotId. Fall back to legacy payload robotId.
      const robotId =
        toStringOrNull(socket.data.robotId) ||
        toStringOrNull(payload?.robotId);
      if (!robotId) return;

      const isAuthed = Boolean(socket.data.isAuthed);

      // If a session exists for this robot, require AUTH to bind the socket.
      if (!isAuthed) {
        const session = await kv.get(`session:${robotId}`);
        if (session) {
          socket.emit("AUTH_REQUIRED", { robotId });
          return;
        }
      }

      // If this is a legacy robot client (no AUTH), bind the socket after first valid telemetry.
      if (!socket.data.robotId) {
        socket.data.robotId = robotId;
        await kv.set(`socket:${socket.id}`, robotId, { ex: 3600 });
      }

      // If a pairing code is currently active for this robot, force AUTH first.
      const pairingActive = await kv.get(`pairing:${robotId}`);
      if (pairingActive && !isAuthed) {
        socket.emit("AUTH_REQUIRED", { robotId });
        return;
      }

      const nowMs = Date.now();
      const now = new Date(nowMs);
      const lat = toNumberOrNull(payload?.lat);
      const lon = toNumberOrNull(payload?.lon);
      const speed = toNumberOrNull(payload?.speed);
      const battery = toNumberOrNull(payload?.battery);
      const status = toStringOrNull(payload?.status);

      const statusRaw = status && INCOMING_STATUS.has(status) ? status : null;
      const statusDb = statusRaw ? mapIncomingStatusToDb(statusRaw) : null;

      // Reject unknown robotId (must exist in DB).
      const existing = await prisma.robot.findUnique({
        where: { robotId },
        select: { id: true, status: true, lat: true, lon: true, speed: true, battery: true },
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
        status:
          statusDb ||
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
      };

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
        }),
        { ex: 15 }
      );

      // 3) Update DB (light)
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

      // 4) Snapshot (optional: time OR movement OR battery delta)
      if (
        await shouldStoreSnapshotSmart(
          kv,
          robotId,
          { lat: fullState.lat, lon: fullState.lon, battery: fullState.battery },
          { maxSeconds: 15, moveMeters: 10, batteryDelta: 2 }
        )
      ) {
        await telemetryService.saveTelemetry(prisma, existing.id, { lat: fullState.lat, lon: fullState.lon, speed: fullState.speed, battery: fullState.battery }, now);
        await updateSnapshotState(kv, robotId, { lat: fullState.lat, lon: fullState.lon, battery: fullState.battery });
      }

      log.info(`[ROBOT ${robotId}] TELEMETRY`, {
        lat,
        lon,
        speed,
        battery,
        status,
      });

      // 5) Emit to frontend (new contract)
      io.emit("robot:update", fullState);

      // Backward compatible emits
      io.to("dashboard").emit("ROBOT_UPDATE", { robotId, ...payload });

      // Preserve existing frontend contract (robot_update includes enriched robot row)
      const robot = await prisma.robot.findUnique({
        where: { robotId },
        include: { currentTask: true, campus: true, location: true },
      });

      io.emit("robot_update", {
        ...payload,
        robotId,
        robot,
      });
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

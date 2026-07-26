const { toStringOrNull } = require("../../utils/parse");
const { allow } = require("../rateLimit");
const {
  getRobotSocket,
  setRobotSocket,
  deleteRobotSocket,
  disconnectSocket,
} = require("../robotSockets");
const crypto = require("crypto");
const { z } = require("zod");
const { markOnline, markOffline, getRobotState, setRobotState } = require("../../services/robotRegistry.service");
const { assignRobotToZone } = require("../../services/zoneManager.service");
const { DB_FLUSH_INTERVAL_MS } = require("../../config/liveness.constants");

// Per-robot throttle for the HEARTBEAT path's Postgres write, mirroring the
// same gate in telemetry.handler.js. Per-process and in-memory (same pattern
// as sockets/rateLimit.js), bounded by fleet size rather than by tick rate.
//
// Without this gate, HEARTBEAT issued an unconditional `prisma.robot.update`
// on every beat. Since VirtualRobot._tick() emits HEARTBEAT and TELEMETRY on
// the SAME 2-second tick, that meant 30 full-row writes per robot per minute —
// completely defeating the telemetry handler's flush gate, which had reduced
// its own writes to ~4/min. Aggregate write volume to `Robot` was unchanged;
// it had only moved handlers.
const lastHeartbeatDbFlushAt = new Map();

async function markRobotOnline(prisma, robotId, socketId) {
  return prisma.robot.update({
    where: { robotId },
    data: {
      isOnline: true,
      socketId,
      lastSeenAt: new Date(),
    },
  });
}

async function markRobotOffline(prisma, robotId) {
  return prisma.robot.update({
    where: { robotId },
    data: {
      isOnline: false,
      status: "OFFLINE",
    },
  });
}

// Brute-force lockout thresholds (F32): after this many failed pairing-code
// attempts for a robotId (tracked across reconnects/sockets, since the
// counter key is keyed by robotId not socket.id), reject all further pairing
// attempts for that robotId until the lockout TTL elapses or an operator
// clears it via the admin unlock endpoint.
const PAIRING_LOCKOUT_THRESHOLD = 5;
const PAIRING_LOCKOUT_TTL_SEC = 3600;

function registerRobotHandlers(io, socket, { prisma, kv, logger }) {
  const log = logger || console;

  async function isPairingLocked(robotId) {
    try {
      return Boolean(await kv.get(`pairingLocked:${robotId}`));
    } catch {
      return false;
    }
  }

  async function lockPairing(robotId) {
    try {
      await kv.set(`pairingLocked:${robotId}`, "1", { ex: PAIRING_LOCKOUT_TTL_SEC });
    } catch {
      // ignore
    }
  }

  async function recordPairingAttempt(robotId) {
    try {
      // kv.incr is atomic (Redis INCR) — safe under concurrent AUTH attempts.
      const attempts = await kv.incr(`pairingAttempts:${robotId}`, { ex: 300 });
      if (attempts >= PAIRING_LOCKOUT_THRESHOLD) {
        await lockPairing(robotId);
      }
      return attempts;
    } catch {
      return 0;
    }
  }

  async function clearPairingAttempts(robotId) {
    try {
      await kv.del(`pairingAttempts:${robotId}`);
    } catch {
      // ignore
    }
  }

  const authSchema = z
    .object({
      robotId: z.string().min(1),
      token: z.union([z.string(), z.number()]).optional().nullable().transform((v) => (v === null || v === undefined ? v : String(v))),
      pairingCode: z.union([z.string(), z.number()]).optional().nullable().transform((v) => (v === null || v === undefined ? v : String(v))),
    })
    .passthrough();

  socket.on("AUTH", async (payload) => {
    try {
      if (!allow(socket, "AUTH", { limit: 5, windowMs: 60_000, minIntervalMs: 100 })) return;

      const parsed = authSchema.safeParse(payload || {});
      if (!parsed.success) return socket.disconnect(true);
      const auth = parsed.data;

      const robotId = toStringOrNull(auth?.robotId);
      const pairingCode = toStringOrNull(auth?.pairingCode);
      const token = toStringOrNull(auth?.token);
      if (!robotId) return socket.disconnect(true);

      // Reject unknown robots (must be commissioned in DB).
      const robot = await prisma.robot.findUnique({ where: { robotId }, select: { id: true } });
      if (!robot) return socket.disconnect(true);

      const [sessionToken, storedCode] = await Promise.all([
        kv.get(`session:${robotId}`),
        kv.get(`pairing:${robotId}`),
      ]);

      let nextToken = null;

      // Reconnect path: valid existing session token.
      if (sessionToken && token && token === sessionToken) {
        nextToken = sessionToken;
        // Refresh TTL on successful reconnect
        await kv.set(`session:${robotId}`, nextToken, { ex: 86400 });
      } else {
        // Brute-force lockout (F32): reject immediately, before comparing codes,
        // regardless of which socket is attempting.
        if (await isPairingLocked(robotId)) {
          log.warn("Pairing rejected — robot locked out after repeated failed attempts", {
            robotId,
            socketId: socket.id,
          });
          return socket.disconnect(true);
        }

        // Fallback: pairing check
        if (!storedCode || !pairingCode || storedCode !== pairingCode) {
          const attempts = await recordPairingAttempt(robotId);
          if (attempts >= PAIRING_LOCKOUT_THRESHOLD) {
            log.warn("Pairing brute-force limit hit — robot locked out", { robotId, socketId: socket.id, attempts });
          }
          return socket.disconnect(true);
        }
        // After first successful pairing, mint a session token.
        nextToken = crypto.randomUUID();
        await kv.set(`session:${robotId}`, nextToken, { ex: 86400 });
      }

      // Replace old connection (auto-reconnect safe).
      const previous = getRobotSocket(robotId);
      setRobotSocket(robotId, socket);
      socket.data.robotId = robotId;
      socket.data.isAuthed = true;

      // Bind socket -> robot mapping for best-effort cleanup.
      await kv.set(`socket:${socket.id}`, robotId, { ex: 3600 });

      await markRobotOnline(prisma, robotId, socket.id);

      // After DB state is updated to the new socketId, it's safe to disconnect the previous socket.
      if (previous && previous.id !== socket.id) {
        disconnectSocket(previous);
      }

      // delete pairing after success (if any)
      if (storedCode) {
        await kv.del(`pairing:${robotId}`);
        await clearPairingAttempts(robotId);
      }

      socket.emit("AUTH_SUCCESS", { robotId, token: nextToken });
      // Backward compatible alias
      socket.emit("AUTH_OK", { robotId, token: nextToken });
      io.emit("robot_online", { robotId });

      // DTARO: join dedicated robot room for targeted commands
      socket.join(`robot:${robotId}`);

      // DTARO: update registry with online + auth state
      await markOnline(kv, robotId, socket);

      // DTARO: assign robot to zone based on last known position
      try {
        const liveState = await getRobotState(kv, robotId);
        const lat = typeof liveState?.lat === "number" ? liveState.lat : null;
        const lon = typeof liveState?.lon === "number" ? liveState.lon : null;
        if (lat !== null && lon !== null) {
          await assignRobotToZone(prisma, kv, io, robotId, lat, lon, socket, liveState?.zoneId || null);
        }
      } catch {
        // zone assignment is non-critical — never block auth
      }

      log.info("Robot AUTH success", {
        robotId,
        socketId: socket.id,
        mode: sessionToken && token === sessionToken ? "session" : "pairing",
      });
    } catch (e) {
      log.error("AUTH handler failed", e);
      try {
        socket.disconnect(true);
      } catch {
        // ignore
      }
    }
  });

  // Heartbeat is lightweight: the live liveness signal goes to Redis on every
  // beat, while the durable `Robot.lastSeenAt` mirror is throttled to
  // DB_FLUSH_INTERVAL_MS. The offline sweep (socket.server.js) reads the Redis
  // signal first and only falls back to the throttled DB column, so detection
  // stays accurate without a write per beat — see config/liveness.constants.js
  // for the flush-interval/cutoff invariant this relies on.
  async function handleHeartbeat(eventName) {
    try {
      if (!allow(socket, eventName, { limit: 10, windowMs: 5_000, minIntervalMs: 100 })) return;
      const robotId = toStringOrNull(socket.data.robotId);
      if (!robotId) return;

      const nowMs = Date.now();

      // Live signal — every beat, Redis only.
      try {
        await setRobotState(kv, robotId, { lastHeartbeat: nowMs, connected: true });
      } catch {
        // non-critical — the throttled DB write below is the durable fallback
      }

      const lastFlush = lastHeartbeatDbFlushAt.get(robotId) || 0;
      if (nowMs - lastFlush < DB_FLUSH_INTERVAL_MS) return;

      // Record the flush time before awaiting so concurrent beats for the same
      // robot can't both slip past the gate while the write is in flight.
      lastHeartbeatDbFlushAt.set(robotId, nowMs);

      // Opportunistic cleanup so decommissioned robots don't accumulate
      // forever (same pattern as sockets/rateLimit.js).
      if (lastHeartbeatDbFlushAt.size > 50_000) {
        for (const [id, ts] of lastHeartbeatDbFlushAt) {
          if (nowMs - ts > DB_FLUSH_INTERVAL_MS * 10) lastHeartbeatDbFlushAt.delete(id);
        }
      }

      await prisma.robot.update({ where: { robotId }, data: { lastSeenAt: new Date(nowMs) } });
    } catch {
      // ignore
    }
  }

  socket.on("HEARTBEAT", () => handleHeartbeat("HEARTBEAT"));
  // Backward compatible alias.
  socket.on("heartbeat", () => handleHeartbeat("heartbeat"));

  socket.on("disconnect", () => {
    // Best-effort: mark offline only if this socket is still the active one.
    (async () => {
      try {
        const boundRobotId = toStringOrNull(socket.data.robotId) || (await kv.get(`socket:${socket.id}`));
        if (!boundRobotId) return;

        await kv.del(`socket:${socket.id}`);

        // If DB already points to a different socket, a newer connection replaced this one.
        const dbRow = await prisma.robot.findUnique({
          where: { robotId: boundRobotId },
          select: { socketId: true },
        });
        if (dbRow && dbRow.socketId && dbRow.socketId !== socket.id) return;

        // Extra safety: ignore stale sockets that are no longer current.
        const current = getRobotSocket(boundRobotId);
        if (current && current.id !== socket.id) return;

        deleteRobotSocket(boundRobotId, socket);

        await markRobotOffline(prisma, boundRobotId);
        // DTARO: update registry offline state
        await markOffline(kv, boundRobotId);
        io.emit("robot_offline", { robotId: boundRobotId });
      } catch {
        // ignore
      }
    })();

    log.info("Socket disconnected", { socketId: socket.id });
  });
}

module.exports = {
  registerRobotHandlers,
};

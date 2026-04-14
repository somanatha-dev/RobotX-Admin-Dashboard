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

function registerRobotHandlers(io, socket, { prisma, kv, logger }) {
  const log = logger || console;

  async function recordPairingAttempt(robotId) {
    try {
      const key = `pairingAttempts:${robotId}`;
      const raw = await kv.get(key);
      const n = raw ? Number.parseInt(String(raw), 10) : 0;
      const next = (Number.isFinite(n) ? n : 0) + 1;
      // 5 minute rolling window
      await kv.set(key, String(next), { ex: 300 });
      return next;
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
        // Fallback: pairing check
        if (!storedCode || !pairingCode || storedCode !== pairingCode) {
          const attempts = await recordPairingAttempt(robotId);
          if (attempts >= 5) {
            log.warn("Pairing brute-force limit hit", { robotId, socketId: socket.id, attempts });
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

  // Heartbeat is lightweight; updates lastSeenAt for offline detection.
  socket.on("HEARTBEAT", async () => {
    try {
      if (!allow(socket, "HEARTBEAT", { limit: 10, windowMs: 5_000, minIntervalMs: 100 })) return;
      const robotId = toStringOrNull(socket.data.robotId);
      if (!robotId) return;
      await prisma.robot.update({ where: { robotId }, data: { lastSeenAt: new Date() } });
    } catch {
      // ignore
    }
  });

  // Backward compatible alias.
  socket.on("heartbeat", async () => {
    try {
      if (!allow(socket, "heartbeat", { limit: 10, windowMs: 5_000, minIntervalMs: 100 })) return;
      const robotId = toStringOrNull(socket.data.robotId);
      if (!robotId) return;
      await prisma.robot.update({ where: { robotId }, data: { lastSeenAt: new Date() } });
    } catch {
      // ignore
    }
  });

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

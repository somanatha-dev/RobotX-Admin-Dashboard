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
const robotStateCache = require("../../cache/robotStateCache");

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
  const row = await prisma.robot.update({
    where: { robotId },
    data: {
      isOnline: true,
      socketId,
      lastSeenAt: new Date(),
    },
  });
  robotStateCache.set(robotId, { isOnline: true });
  return row;
}

async function markRobotOffline(prisma, robotId) {
  const row = await prisma.robot.update({
    where: { robotId },
    data: {
      isOnline: false,
      status: "OFFLINE",
      // Clear the socket binding too — leaving a dead socket id on the row
      // makes it look like a live handle to anything reading the column.
      socketId: null,
    },
  });
  robotStateCache.set(robotId, { isOnline: false, status: "OFFLINE" });
  return row;
}

// Brute-force lockout thresholds (F32): after this many failed pairing-code
// attempts for a robotId (tracked across reconnects/sockets, since the
// counter key is keyed by robotId not socket.id), reject all further pairing
// attempts for that robotId until the lockout TTL elapses or an operator
// clears it via the admin unlock endpoint.
const PAIRING_LOCKOUT_THRESHOLD = 5;
const PAIRING_LOCKOUT_TTL_SEC = 3600;

// PHASE 4 — §11.5's session-establishment handshake.
//
//   > On every session establishment the agent reports its **deduplication high-water
//   > mark**: `dedup_state_generation`, `authority_epoch`, `fence_floor`, and the
//   > per-commitment high-water pairs for every commitment it believes it holds. The
//   > server compares this against the Commitment Store and takes one of three paths.
//
// Two conditions gate it, and both are deliberate:
//
//   1. `ENGINE_ENABLED`. The handshake's third path *writes* — it suppresses outbox
//      rows and advances an agent's `authority_epoch` — and the Phase 0 master switch
//      exists so that no engine write path is reachable before the Phase 15 cutover.
//   2. The agent actually reporting a dedup state. Its absence means "this agent does
//      not speak the protocol", which is the legacy fleet, and legacy AUTH must remain
//      byte-for-byte what it was. A *malformed* report is different and is logged: an
//      agent that speaks the protocol and got it wrong is a defect to surface.
//
// A robot with no projected `Agent` row is also a no-op: Phase 2's backfill is what
// creates the projection, and inventing one here would be a second backfill.
const clockModule = require("../../engine/commitment/clock");
const dedupHandshake = require("../../engine/dispatch/dedupHandshake");

async function runDedupHandshake(prisma, robotId, reportedDedupState, log) {
  if (process.env.ENGINE_ENABLED !== "true") return null;
  if (reportedDedupState === undefined || reportedDedupState === null) return null;

  const parsed = dedupHandshake.parseReport(reportedDedupState);
  if (!parsed.ok) {
    log.warn("AUTH dedup report rejected", { robotId, reason: parsed.reason });
    return { path: null, error: parsed.reason };
  }

  try {
    const agent = await prisma.agent.findUnique({ where: { agentId: robotId } });
    if (!agent) return null;

    const applied = await prisma.$transaction(async (tx) => {
      const storeTime = await clockModule.readStoreTime(tx);
      const stored = await tx.agentDedupState.findUnique({ where: { agentId: agent.id } });
      const activeCommitments = await tx.commitment.findMany({
        where: { agentId: agent.id, releasedAt: null },
      });

      const classification = dedupHandshake.classify({
        reported: parsed.value,
        stored,
        activeCommitments,
      });

      const result = await dedupHandshake.apply(tx, {
        agent,
        reported: parsed.value,
        classification,
        storeTime,
      });

      return { result, classification };
    });

    if (dedupHandshake.isGenerationAdvance(applied.classification)) {
      // §11.5's monitoring requirement: "a rising rate across a class indicates
      // non-volatile storage that is not actually durable — a defect that is invisible
      // in every other signal."
      log.warn("agent dedup_state_generation advanced", {
        robotId,
        path: applied.classification.path,
        suppressedRows: applied.result.suppressedRows,
      });
    }

    return dedupHandshake.acknowledgement(applied.result);
  } catch (e) {
    log.error("AUTH dedup handshake failed", { robotId, message: e?.message });
    return { path: null, error: "HANDSHAKE_FAILED" };
  }
}

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
      // PHASE 4 — §11.5's session-establishment handshake. Optional, and its absence
      // is the legacy path: an agent that does not speak the protocol authenticates
      // exactly as before. `passthrough()` already admitted unknown keys, so declaring
      // it here narrows nothing; it documents the field and keeps the shape in one
      // place.
      dedupState: z.unknown().optional().nullable(),
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

      // Reject unknown robots (must be commissioned in DB). This is the one
      // DB read AUTH needs — its result seeds robotStateCache so the
      // TELEMETRY hot path never needs its own per-tick read (see
      // cache/robotStateCache.js for why).
      const robot = await prisma.robot.findUnique({
        where: { robotId },
        select: { id: true, status: true, isOnline: true, lat: true, lon: true, battery: true },
      });
      if (!robot) return socket.disconnect(true);
      robotStateCache.set(robotId, {
        id: robot.id,
        status: robot.status,
        isOnline: robot.isOnline,
        lat: robot.lat,
        lon: robot.lon,
        battery: robot.battery,
      });

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

      // PHASE 4 — §11.5's deduplication handshake, before AUTH_SUCCESS.
      //
      // Before, because §11.5's third path *suppresses redelivery* and advances the
      // agent's authority epoch, and an agent told "you are authenticated" before that
      // has landed could begin acting on state the server is about to invalidate. The
      // handshake result rides on AUTH_SUCCESS so the agent adopts the new epoch and
      // fence floor in the same message that admits it.
      const dedupOutcome = await runDedupHandshake(prisma, robotId, auth.dedupState, log);

      socket.emit("AUTH_SUCCESS", { robotId, token: nextToken, dedup: dedupOutcome });
      // Backward compatible alias
      socket.emit("AUTH_OK", { robotId, token: nextToken, dedup: dedupOutcome });
      // Dashboard-only UI event — scoped to the room instead of every socket.
      io.to("dashboard").emit("robot_online", { robotId });

      // DTARO: join dedicated robot room for targeted commands
      socket.join(`robot:${robotId}`);

      // DTARO: update registry with online + auth state
      await markOnline(kv, robotId, socket);

      // Join the live-robot index. This is the ONLY place a robot enters it as
      // a consequence of actually being connected — commissioning and task
      // recovery also add members, but a robot that authenticates by any other
      // route (a real unit reconnecting, a fleet re-added after a Redis flush)
      // was previously absent from the set for its entire session. That made
      // /health's online count wrong and, more seriously, made
      // alertDissemination's obstacle fan-out skip the robot entirely — so a
      // robot driving straight at an obstacle was never rerouted.
      try {
        if (typeof kv.sadd === "function") await kv.sadd("robots:all", robotId);
      } catch { /* index membership is best-effort */ }

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

        // Leave the live-robot index. Previously members were only ever
        // removed on decommission, so the set monotonically over-counted and
        // obstacle dissemination kept fanning out to long-gone robots.
        try {
          if (typeof kv.srem === "function") await kv.srem("robots:all", boundRobotId);
        } catch { /* index membership is best-effort */ }
        // Dashboard-only UI event — scoped to the room instead of every socket.
        io.to("dashboard").emit("robot_offline", { robotId: boundRobotId });
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

const asyncHandler = require("../utils/asyncHandler");
const { getPrisma } = require("../db/prisma");
const robotService = require("../services/robot.service");
const { toStringOrNull } = require("../utils/parse");
const crypto = require("crypto");
const { getRobotSocket } = require("../sockets/robotSockets");
const { z } = require("zod");

async function writeRobotLiveState(kv, robot, { exSeconds = 15 } = {}) {
  if (!kv || !robot) return;
  const robotId = toStringOrNull(robot.robotId);
  if (!robotId) return;

  const lat = typeof robot.lat === "number" ? robot.lat : null;
  const lon = typeof robot.lon === "number" ? robot.lon : null;
  const battery = typeof robot.battery === "number" ? robot.battery : null;
  const speed = typeof robot.speed === "number" ? robot.speed : 0;
  const status = typeof robot.status === "string" && robot.status ? robot.status : "IDLE";

  const lastSeenAtMs = robot.lastSeenAt ? new Date(robot.lastSeenAt).getTime() : Date.now();
  const lastSeenAt = Number.isFinite(lastSeenAtMs) ? lastSeenAtMs : Date.now();

  // Contract: minimal live state only (no history).
  const live = { lat, lon, battery, status, speed, lastSeenAt };

  await Promise.all([
    kv.set(`robot:${robotId}`, JSON.stringify(live), { ex: exSeconds }),
    typeof kv.sadd === "function" ? kv.sadd("robots:all", robotId) : Promise.resolve(),
  ]);
}

function emitRobotUpdate(req, payload) {
  const io = req.app?.locals?.io;
  if (!io) return;
  try {
    io.to("dashboard").emit("ROBOT_UPDATE", payload);
  } catch {
    // ignore
  }
}

const commissionRobot = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const kv  = req.app?.locals?.kv;
  const io  = req.app?.locals?.io;
  const robot = await robotService.commissionRobot(prisma, req.body);

  // Make the commissioned robot instantly visible via Redis + dashboard socket.
  try {
    await writeRobotLiveState(kv, robot, { exSeconds: 15 });
  } catch {
    // ignore KV failures
  }

  const livePayload = {
    robotId: robot.robotId,
    lat:     robot.lat,
    lon:     robot.lon,
    battery: robot.battery,
    status:  robot.status || "IDLE",
    speed:   robot.speed || 0,
    isOnline: true,
  };

  emitRobotUpdate(req, livePayload);

  // Notify dashboard that a new robot has been commissioned (triggers map marker creation
  // regardless of the current location filter).
  try {
    io?.to("dashboard")?.emit("ROBOT_COMMISSIONED", {
      ...livePayload,
      locationId: robot.locationId || null,
      campusId:   robot.campusId   || null,
      name:       robot.name       || null,
    });
  } catch {
    // ignore
  }

  // Auto-start a VirtualRobot for this unit so it appears alive on the map immediately.
  // If a physical robot later connects via AUTH, it seamlessly replaces the virtual one.
  const virtualSimulator = req.app?.locals?.virtualSimulator;
  if (virtualSimulator && typeof virtualSimulator.addRobot === "function") {
    try {
      await virtualSimulator.addRobot({
        robotId: robot.robotId,
        lat:     typeof robot.lat === "number" ? robot.lat : null,
        lon:     typeof robot.lon === "number" ? robot.lon : null,
      });
    } catch (e) {
      // Non-fatal — simulator may not be running yet or DB not ready
      (req.app?.locals?.logger || console).warn(
        `[commission] VirtualRobot addRobot failed for ${robot.robotId}: ${e?.message}`
      );
    }
  }

  res.json({ ok: true, robot });
});

const listRobots = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const kv = req.app?.locals?.kv;
  const robots = await robotService.listRobots(prisma, req.query);

  // Main API behavior: DB robots + Redis live overlay (when available).
  // This keeps robot ownership/metadata in DB, and live state in Redis.
  if (!kv) {
    res.json({ ok: true, robots });
    return;
  }

  const merged = await Promise.all(
    robots.map(async (r) => {
      let live = null;
      try {
        const raw = await kv.get(`robot:${r.robotId}`);
        if (raw) live = JSON.parse(raw);
      } catch {
        live = null;
      }

      if (!live || typeof live !== "object") return r;

      return {
        ...r,
        ...(typeof live.lat === "number" ? { lat: live.lat } : {}),
        ...(typeof live.lon === "number" ? { lon: live.lon } : {}),
        ...(typeof live.speed === "number" ? { speed: live.speed } : {}),
        ...(typeof live.battery === "number" ? { battery: live.battery } : {}),
        ...(typeof live.status === "string" ? { status: live.status } : {}),
        live,
      };
    })
  );

  res.json({ ok: true, robots: merged });
});

// GET /api/robots/state
// Dashboard initial load: DB source of truth + Redis live overlay.
const getRobotsState = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const kv = req.app?.locals?.kv;

  const robots = await prisma.robot.findMany({
    include: { campus: true, location: true, currentTask: true },
    orderBy: [{ isOnline: "desc" }, { lastSeenAt: "desc" }],
  });

  if (!kv) {
    res.json({ ok: true, robots });
    return;
  }

  const merged = await Promise.all(
    robots.map(async (r) => {
      let live = null;
      try {
        const raw = await kv.get(`robot:${r.robotId}`);
        if (raw) live = JSON.parse(raw);
      } catch {
        live = null;
      }

      if (!live || typeof live !== "object") return r;

      // Overlay common live fields when available.
      const next = {
        ...r,
        ...(typeof live.lat === "number" ? { lat: live.lat } : {}),
        ...(typeof live.lon === "number" ? { lon: live.lon } : {}),
        ...(typeof live.speed === "number" ? { speed: live.speed } : {}),
        ...(typeof live.battery === "number" ? { battery: live.battery } : {}),
        ...(typeof live.status === "string" ? { status: live.status } : {}),
        // keep lastSeenAt as DB value; live.lastSeenAt is informational
        live,
      };

      return next;
    })
  );

  res.json({ ok: true, robots: merged });
});

// GET /api/robots/:robotId/history
// Returns last 50 telemetry snapshots (most recent first).
const getRobotHistory = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const robotCode = toStringOrNull(req.params?.robotId);
  if (!robotCode) {
    const err = new Error("robotId is required");
    err.status = 400;
    throw err;
  }

  const robot = await prisma.robot.findUnique({ where: { robotId: robotCode }, select: { id: true } });
  if (!robot) {
    const err = new Error("Unknown robotId");
    err.status = 404;
    throw err;
  }

  const telemetry = await prisma.telemetry.findMany({
    where: { robotId: robot.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  res.json({ ok: true, robotId: robotCode, telemetry });
});

// POST /api/robots/commission
// Generates a short-lived pairing code stored in Redis, used by the robot to AUTH over Socket.io.
// Backward compatible: does not replace the existing POST /api/robots commissioning endpoint.
const commissionRobotWithPairing = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const kv = req.app?.locals?.kv;

  if (!kv) {
    const err = new Error("KV store unavailable");
    err.status = 503;
    throw err;
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

  const parsed = z
    .object({
      robotId: z.string().min(1),
      locationId: z.string().optional(),
      campusId: z.string().optional().nullable(),
      lat: numOpt,
      lon: numOpt,
    })
    .passthrough()
    .safeParse(req.body || {});

  if (!parsed.success) {
    const err = new Error("Invalid commission payload");
    err.status = 400;
    throw err;
  }

  const robotId = toStringOrNull(parsed.data.robotId);
  if (!robotId) {
    const err = new Error("robotId is required");
    err.status = 400;
    throw err;
  }

  // Ensure robot exists. If it doesn't exist yet, require full commission payload (locationId, etc.).
  const existing = await prisma.robot.findUnique({ where: { robotId }, select: { id: true } });
  let robot = null;
  if (existing) {
    // Optional: allow updating commissioning fields using the existing commissioning service.
    // If the caller provides a locationId, keep behavior consistent with the legacy endpoint.
    const hasLocation = toStringOrNull(parsed.data?.locationId);
    if (hasLocation) {
      robot = await robotService.commissionRobot(prisma, parsed.data);
    } else {
      robot = await prisma.robot.findUnique({
        where: { robotId },
        include: { location: true, campus: true, currentTask: true },
      });
    }
  } else {
    robot = await robotService.commissionRobot(prisma, parsed.data);
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  await kv.set(`pairing:${robotId}`, code, { ex: 300 });

  // Ensure Redis live state exists for immediate UI visibility.
  try {
    await writeRobotLiveState(kv, robot, { exSeconds: 15 });
  } catch {
    // ignore
  }

  emitRobotUpdate(req, {
    robotId: robot.robotId,
    lat: robot.lat,
    lon: robot.lon,
    battery: robot.battery,
    status: robot.status || "IDLE",
    speed: robot.speed || 0,
  });

  res.json({ ok: true, robot, pairingCode: code, expiresIn: 300 });
});

// DELETE /api/robots/:robotId
const deleteRobot = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const kv = req.app?.locals?.kv;
  const robotCode = toStringOrNull(req.params?.robotId);

  if (!robotCode) {
    const err = new Error("robotId is required");
    err.status = 400;
    throw err;
  }

  const robot = await prisma.robot.findUnique({ where: { robotId: robotCode }, select: { id: true } });
  if (!robot) {
    const err = new Error("Unknown robotId");
    err.status = 404;
    throw err;
  }

  await prisma.robot.delete({ where: { robotId: robotCode } });

  if (kv) {
    try {
      await kv.del(`robot:${robotCode}`);
      if (typeof kv.srem === "function") await kv.srem("robots:all", robotCode);
    } catch {
      // ignore
    }
  }

  res.json({ ok: true, robotId: robotCode });
});

// POST /api/robots/:robotId/command
// Creates a persisted command row and (if online) emits it to the robot socket.
const sendRobotCommand = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const kv = req.app?.locals?.kv;
  const robotCode = toStringOrNull(req.params?.robotId);

  const bodyParsed = z
    .object({
      type: z.string().min(1),
    })
    .passthrough()
    .safeParse(req.body || {});

  if (!bodyParsed.success) {
    const err = new Error("Invalid command payload");
    err.status = 400;
    throw err;
  }

  const typeRaw = toStringOrNull(bodyParsed.data?.type);
  const type = typeRaw ? typeRaw.toUpperCase() : null;

  if (!robotCode) {
    const err = new Error("robotId is required");
    err.status = 400;
    throw err;
  }
  if (!type) {
    const err = new Error("type is required");
    err.status = 400;
    throw err;
  }

  // Validate command type against the Prisma enum.
  const allowed = new Set(["STOP", "PAUSE", "RETURN", "RESUME"]);
  if (!allowed.has(type)) {
    const err = new Error("Invalid command type");
    err.status = 400;
    throw err;
  }

  const robot = await prisma.robot.findUnique({ where: { robotId: robotCode }, select: { id: true } });
  if (!robot) {
    const err = new Error("Unknown robotId");
    err.status = 404;
    throw err;
  }

  const command = await prisma.command.create({
    data: {
      robotId: robot.id,
      type,
    },
  });

  async function getRetryCount(commandId) {
    if (!kv) return 0;
    try {
      const raw = await kv.get(`cmdretry:${commandId}`);
      const n = raw ? Number.parseInt(String(raw), 10) : 0;
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  async function setRetryCount(commandId, n) {
    if (!kv) return;
    try {
      await kv.set(`cmdretry:${commandId}`, String(n), { ex: 3600 });
    } catch {
      // ignore
    }
  }

  async function scheduleReliabilityCheck({ attempt }) {
    setTimeout(async () => {
      try {
        const cmd = await prisma.command.findUnique({ where: { id: command.id }, select: { status: true } });
        if (!cmd || cmd.status !== "SENT") return;

        const retries = kv ? await getRetryCount(command.id) : attempt;
        if (retries < 2) {
          const next = retries + 1;
          await setRetryCount(command.id, next);

          const s = getRobotSocket(robotCode);
          if (s) {
            s.emit("COMMAND", { commandId: command.id, type });
          }

          await scheduleReliabilityCheck({ attempt: next });
          return;
        }

        await prisma.command.update({ where: { id: command.id }, data: { status: "FAILED" } });
      } catch {
        // ignore
      }
    }, 5000);
  }

  const socket = getRobotSocket(robotCode);
  if (socket) {
    socket.emit("COMMAND", { commandId: command.id, type });
  }

  // Reliability: retry up to 2 times before FAILED.
  if (kv) await setRetryCount(command.id, 0);
  scheduleReliabilityCheck({ attempt: 0 });

  res.json({ ok: true, command, delivered: Boolean(socket) });
});

module.exports = {
  commissionRobot,
  listRobots,
  getRobotsState,
  getRobotHistory,
  commissionRobotWithPairing,
  sendRobotCommand,
  deleteRobot,
};

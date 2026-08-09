const asyncHandler = require("../utils/asyncHandler");
const { getPrisma } = require("../db/prisma");
const robotService = require("../services/robot.service");
const { toStringOrNull } = require("../utils/parse");
const crypto = require("crypto");
const { dispatchCommand } = require("../services/commandDispatcher.service");
const { getRobotState, updateHealthStatus } = require("../services/robotRegistry.service");
const { z } = require("zod");
const robotStateCache = require("../cache/robotStateCache");
// PHASE 14 — §23.6's override discipline. The rules live in the engine module; this
// controller applies them at the one operator surface that returns a withdrawn agent to
// service.
const override = require("../engine/security/override");

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

  let rawStates = [];
  try {
    rawStates = await kv.mget(robots.map((r) => `robot:${r.robotId}`));
  } catch {
    rawStates = robots.map(() => null);
  }

  const merged = robots.map((r, i) => {
    let live = null;
    try {
      const raw = rawStates[i];
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
  });

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

  let rawStates = [];
  try {
    rawStates = await kv.mget(robots.map((r) => `robot:${r.robotId}`));
  } catch {
    rawStates = robots.map(() => null);
  }

  const merged = robots.map((r, i) => {
    let live = null;
    try {
      const raw = rawStates[i];
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
  });

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
    // Allow updating commissioning fields directly (robotService.commissionRobot() always
    // rejects an existing robotId, so it can't be reused here for an in-place update).
    const hasLocation = toStringOrNull(parsed.data?.locationId);
    if (hasLocation) {
      robot = await prisma.robot.update({
        where: { robotId },
        data: {
          locationId: hasLocation,
          ...(parsed.data.campusId !== undefined ? { campusId: parsed.data.campusId || null } : {}),
          ...(typeof parsed.data.lat === "number" ? { lat: parsed.data.lat } : {}),
          ...(typeof parsed.data.lon === "number" ? { lon: parsed.data.lon } : {}),
          ...(toStringOrNull(parsed.data.name) ? { name: toStringOrNull(parsed.data.name) } : {}),
        },
        include: { location: true, campus: true, currentTask: true },
      });
    } else {
      robot = await prisma.robot.findUnique({
        where: { robotId },
        include: { location: true, campus: true, currentTask: true },
      });
    }
  } else {
    robot = await robotService.commissionRobot(prisma, parsed.data);
  }

  // Phase 2 (§2.1): both branches above obtain a Robot row *without* going through
  // `robotService.commissionRobot`, which is the only other place the domain Agent
  // is created. Without this call a robot commissioned through the pairing flow —
  // or one commissioned before Phase 2 and re-paired afterwards — would carry no
  // Agent, which is exactly the orphan the phase's completion criterion forbids.
  //
  // Idempotent, and it changes no part of the response: `robot` is returned
  // untouched below.
  //
  // Best-effort here, transactional in `commissionRobot`. The asymmetry is
  // deliberate: there both writes are new, so atomicity costs nothing; here the
  // Robot row is already committed, and failing an existing pairing endpoint over a
  // projection write would be the behaviour change this phase is required not to
  // make. The backfill is re-runnable, which is what makes best-effort recoverable
  // rather than a silent loss.
  try {
    await robotService.ensureAgentForRobot(prisma, robot);
  } catch (e) {
    (req.app?.locals?.logger || console).warn(
      `[commission] Agent projection failed for ${robot?.robotId}: ${e?.message}. ` +
        "Re-runnable via tools/migrate/backfillDomain.js"
    );
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

// POST /api/robots/:robotId/pairing/unlock
// Admin override for the F32 brute-force lockout: clears both the failed-attempt
// counter and the lockout flag so a robot can be re-paired before the 1h TTL elapses.
const unlockPairing = asyncHandler(async (req, res) => {
  const kv = req.app?.locals?.kv;
  const robotId = toStringOrNull(req.params?.robotId);
  if (!robotId) {
    const err = new Error("robotId is required");
    err.status = 400;
    throw err;
  }
  if (!kv) {
    const err = new Error("KV store unavailable");
    err.status = 503;
    throw err;
  }

  await Promise.all([kv.del(`pairingLocked:${robotId}`), kv.del(`pairingAttempts:${robotId}`)]);

  res.json({ ok: true, robotId });
});

// POST /api/robots/:robotId/clear-fault
// F33: deliberate fault-recovery workflow. ROBOT_FAULT (dtaro.handler.js) sets
// Robot.status = ERROR and registry.healthStatus = FAULT with no path back —
// this is the only way either is cleared. Only allowed out of an actual fault
// state (status ERROR or live healthStatus FAULT); anything else is rejected
// as an invalid transition rather than silently no-op'd.
//
// ── PHASE 14 — §23.6's override discipline ───────────────────────────────────
// The route is gated as a QUARANTINE_OVERRIDE (§23.4): elevated role, recorded reason,
// second approver, and both audit records. Three things this endpoint deliberately does
// **not** become as a result:
//
//   1. **It is not a predicate waiver.** Clearing a fault changes the agent's *observed
//      state*; the feasibility gate then re-evaluates F3 and F8 against the new state and
//      reaches its own conclusion. That distinction is what keeps class I absolute: an
//      operator asserting "this fault is resolved" is a claim about the world, which is
//      legitimate and auditable, while "assign it anyway" is a waiver of a class I
//      predicate, which §7.2 forbids to everyone. A request that tries to be the second
//      is refused below, by name.
//   2. **It does not skip the state check.** The 409 on a robot that is not in a fault
//      state stays exactly as it was.
//   3. **It records the reason on the Event row.** The audit stream has it, but an
//      operator reading `Event` during an incident should not have to join two tables to
//      find out why a fault was cleared.
const clearRobotFault = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const kv = req.app?.locals?.kv;
  const io = req.app?.locals?.io;
  const robotCode = toStringOrNull(req.params?.robotId);

  if (!robotCode) {
    const err = new Error("robotId is required");
    err.status = 400;
    throw err;
  }

  // §23.6 / §7.2 — a request that asks to waive a predicate is refused here, before
  // anything else happens, and the refusal names the class. `override.authoriseWaiver`
  // issues it without consulting the requester's role, which is how "never overridable
  // by **anyone**" is implemented: the absoluteness of the class must not be one
  // privilege escalation away from being negotiable.
  const waiveRequest = toStringOrNull(req.body?.waivePredicate);
  if (waiveRequest) {
    const decision = override.authoriseWaiver(
      {
        predicateId: waiveRequest,
        // Both predicates this endpoint's state touches are class I (§7.5: F3 is the
        // operator-hold/quarantine check, F8 the blocking-fault check).
        constraintClass: "I",
        actorId: req.user?.id ?? null,
        actorRole: req.user?.role ?? null,
        reason: toStringOrNull(req.body?.reason),
      },
      { elevatedRoles: [] },
      {},
    );
    res.status(403).json({
      ok: false,
      error: "Forbidden",
      refusal: decision.refusal,
      detail: decision.detail,
      note:
        "clearing a fault is permitted and is what this endpoint does: it changes the agent's observed state, and " +
        "the feasibility gate then re-evaluates against the new state. Waiving the predicate is a different act and " +
        "is not permitted to anyone (§7.2, §23.6).",
    });
    return;
  }

  const robot = await prisma.robot.findUnique({
    where: { robotId: robotCode },
    select: { id: true, status: true, currentTaskId: true },
  });
  if (!robot) {
    const err = new Error("Unknown robotId");
    err.status = 404;
    throw err;
  }

  const live = await getRobotState(kv, robotCode);
  const dbStatus = String(robot.status || "");
  const inFault = dbStatus === "ERROR" || live?.healthStatus === "FAULT";

  if (!inFault) {
    const err = new Error(`Robot is not in a fault state (status=${dbStatus || "unknown"})`);
    err.status = 409;
    throw err;
  }

  // Recover to ACTIVE if the robot still has a task in flight, otherwise IDLE —
  // avoids silently orphaning an in-progress task on recovery.
  const nextStatus = robot.currentTaskId ? "ACTIVE" : "IDLE";

  await prisma.robot.update({
    where: { robotId: robotCode },
    data: { status: nextStatus },
  });
  robotStateCache.set(robotCode, { status: nextStatus });

  await updateHealthStatus(kv, robotCode, "OK");

  try {
    // §23.6 — identity and reason on the Event row too. The hash-chained stream is the
    // non-repudiable record; this is the one an operator already has open.
    const reason = req.override?.request?.reason || null;
    const actor = req.override?.request?.actorId || req.user?.id || null;
    await prisma.event.create({
      data: {
        robotId: robot.id,
        type: "INFO",
        message:
          `Fault cleared via recovery workflow (status ${dbStatus} -> ${nextStatus})` +
          (actor ? ` by ${actor}` : "") +
          (reason ? `: ${reason}` : ""),
      },
    });
  } catch {
    // ignore event log failure
  }

  io?.to("dashboard")?.emit("ROBOT_UPDATED", {
    robotId: robotCode,
    status: nextStatus,
    healthStatus: "OK",
    timestamp: Date.now(),
  });

  res.json({ ok: true, robotId: robotCode, status: nextStatus, healthStatus: "OK" });
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
  robotStateCache.del(robotCode);

  if (kv) {
    try {
      await kv.del(`robot:${robotCode}`);
      if (typeof kv.srem === "function") await kv.srem("robots:all", robotCode);
    } catch {
      // ignore
    }
  }

  // Stop the running VirtualRobot instance so it doesn't keep emitting
  // telemetry for a robot that no longer exists in the DB.
  const virtualSimulator = req.app?.locals?.virtualSimulator;
  if (virtualSimulator && typeof virtualSimulator.removeRobot === "function") {
    try {
      virtualSimulator.removeRobot(robotCode);
    } catch {
      // non-fatal
    }
  }

  res.json({ ok: true, robotId: robotCode });
});

// POST /api/robots/:robotId/command
// Creates a persisted command row and (if online) emits it to the robot socket.
const sendRobotCommand = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const kv = req.app?.locals?.kv;
  const io = req.app?.locals?.io;
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

          await dispatchCommand(io, robotCode, { commandId: command.id, type });

          await scheduleReliabilityCheck({ attempt: next });
          return;
        }

        await prisma.command.update({ where: { id: command.id }, data: { status: "FAILED" } });
      } catch {
        // ignore
      }
    }, 5000);
  }

  // Dispatched through the robot's Socket.IO room rather than this process's
  // local socket Map, so a command still reaches a robot whose connection is
  // owned by a different worker. `delivered` now reflects adapter-wide
  // presence rather than local presence.
  const delivery = await dispatchCommand(io, robotCode, { commandId: command.id, type });

  // Reliability: retry up to 2 times before FAILED.
  if (kv) await setRetryCount(command.id, 0);
  scheduleReliabilityCheck({ attempt: 0 });

  res.json({ ok: true, command, delivered: Boolean(delivery?.dispatched) });
});

module.exports = {
  commissionRobot,
  listRobots,
  getRobotsState,
  getRobotHistory,
  commissionRobotWithPairing,
  unlockPairing,
  sendRobotCommand,
  clearRobotFault,
  deleteRobot,
};

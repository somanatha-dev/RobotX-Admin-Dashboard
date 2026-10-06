"use strict";

/**
 * **The legacy TASK_ASSIGN restart sweep** — moved here from `server.js` unchanged, and
 * engine-gated (C3).
 *
 * Five seconds after boot, it re-sends `TASK_ASSIGN` (and the dashboard's `TASK_ASSIGNED`)
 * for every Task in ASSIGNED / IN_PROGRESS whose route is still cached under
 * `taskPath:{taskId}`. It was written for the legacy dispatcher, which held assignments
 * nowhere but there.
 *
 * ── Why it must not run with the engine on ─────────────────────────────────
 * The engine's OFFER_ACCEPT projection (`assignmentProjection`) writes exactly what this
 * sweep reads: Task → ASSIGNED and `taskPath:{taskId}`. With the KV in process memory the
 * route keys die with the process and the sweep finds nothing. With Redis they survive,
 * and the sweep would re-send an **unsigned, unfenced** `TASK_ASSIGN` for a mission the
 * engine already committed and offered. A VirtualRobot accepts that and restarts the
 * mission from its first stop, outside the commitment. The engine already owns this
 * recovery: OFFER redelivery from the outbox, the dedup handshake at AUTH, and the
 * reconciler's orphan scan.
 *
 * So with the engine on the timer is **never registered**. With it off, the behaviour is
 * the one `server.js` had, byte for byte.
 */

const { dispatchTaskAssign } = require("./commandDispatcher.service");
const { safeJsonParse } = require("../utils/json");

/** @structural the window agents get to connect and authenticate before the re-send */
const REDISPATCH_DELAY_MS = 5000;

/**
 * The sweep body: one pass over the active Tasks.
 *
 * @param {{ prisma: object, kv: object, io: object, logger: object }} deps
 */
async function redispatchActiveTasks({ prisma, kv, io, logger }) {
  try {
    const activeTasks = await prisma.task.findMany({
      where: { status: { in: ["ASSIGNED", "IN_PROGRESS"] } },
      include: { robot: { select: { robotId: true } } },
    });

    for (const task of activeTasks) {
      const robotId = task.robot?.robotId;
      if (!robotId) continue;

      const pathRaw = await kv.get(`taskPath:${task.taskId}`);
      const path = safeJsonParse(pathRaw);
      if (!path?.toPickup || !path?.toDrop) continue;

      // NOTE: `io` is required — dispatchTaskAssign routes through the
      // Socket.IO adapter (io.in(room)/io.to(room)) rather than a
      // process-local socket map, so it works across worker processes.
      // Omitting it silently bound the robotId to `io` and made every
      // re-dispatch a no-op that still reported itself as attempted.
      const result = await dispatchTaskAssign(io, robotId, {
        taskId: task.taskId,
        pickup: { lat: task.pickupLat, lon: task.pickupLon },
        drop:   { lat: task.dropLat,   lon: task.dropLon   },
        pathToPickup: path.toPickup,
        pathToDrop:   path.toDrop,
      });

      logger.info(`[VR] Re-dispatched task ${task.taskId} → ${robotId}`, {
        dispatched: result.dispatched,
        attempts: result.attempts,
      });

      // Also re-emit TASK_ASSIGNED so connected dashboards can draw the route.
      try {
        io.to("dashboard").emit("TASK_ASSIGNED", {
          taskId:        task.taskId,
          robotId,
          pickup:        { lat: task.pickupLat, lon: task.pickupLon },
          drop:          { lat: task.dropLat,   lon: task.dropLon   },
          pathToPickup:  path.toPickup,
          pathToDrop:    path.toDrop,
          usedFallback:  false,
        });
      } catch { /* ignore */ }
    }
  } catch (e) {
    logger.warn("[VR] Active task re-dispatch error", { message: e?.message });
  }
}

/**
 * Register the sweep, unless the engine owns assignment in this process.
 *
 * @param {{ engineEnabled: boolean, prisma: object, kv: object, io: object, logger: object,
 *           setTimer?: Function }} input `setTimer` defaults to `setTimeout`
 * @returns {*} the timer handle, or `null` when the sweep was not registered
 */
function scheduleRestartRedispatch(input) {
  const { engineEnabled, prisma, kv, io, logger } = input;
  const setTimer = input.setTimer || setTimeout;
  if (engineEnabled !== false) {
    // Anything but an explicit `false` is treated as "engine on": a sweep that runs
    // because a caller forgot to say is the defect this gate exists to prevent.
    logger.info("Legacy TASK_ASSIGN restart sweep not started — the assignment engine owns recovery", {
      engineEnabled,
    });
    return null;
  }
  return setTimer(() => redispatchActiveTasks({ prisma, kv, io, logger }), REDISPATCH_DELAY_MS);
}

module.exports = { REDISPATCH_DELAY_MS, redispatchActiveTasks, scheduleRestartRedispatch };

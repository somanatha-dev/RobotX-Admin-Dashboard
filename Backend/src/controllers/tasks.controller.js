const asyncHandler = require("../utils/asyncHandler");
const { getPrisma } = require("../db/prisma");
const taskService = require("../services/task.service");
const { toStringOrNull } = require("../utils/parse");
const { dispatchStop } = require("../services/commandDispatcher.service");
const { updateAssignedTask, updatePlannedPath } = require("../services/robotRegistry.service");

// GET /api/tasks
const listTasks = asyncHandler(async (req, res) => {
  const prisma = getPrisma();

  const { status, robotId } = req.query || {};

  const where = {};
  if (typeof status === "string" && status.trim()) where.status = status.trim();

  if (typeof robotId === "string" && robotId.trim()) {
    const robot = await prisma.robot.findUnique({
      where: { robotId: robotId.trim() },
      select: { id: true },
    });
    where.robotId = robot?.id || "__none__";
  }

  const tasks = await prisma.task.findMany({
    where,
    include: {
      robot: { select: { robotId: true } },
    },
    orderBy: [{ createdAt: "desc" }],
    take: 250,
  });

  res.json({ ok: true, tasks });
});

// POST /api/tasks/assign
const assignTask = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const kv = req.app?.locals?.kv;
  const io = req.app?.locals?.io;
  const created = await taskService.assignTask(prisma, req.body, { kv, io });
  res.json({ ok: true, task: created });
});

// POST /api/tasks/:taskId/cancel
const cancelTask = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const kv = req.app?.locals?.kv;
  const io = req.app?.locals?.io;
  const taskId = toStringOrNull(req.params?.taskId);
  if (!taskId) {
    const err = new Error("taskId is required");
    err.status = 400;
    throw err;
  }

  const task = await prisma.task.findUnique({
    where: { taskId },
    select: { id: true, status: true, robotId: true },
  });

  if (!task) {
    const err = new Error("Unknown taskId");
    err.status = 404;
    throw err;
  }

  const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
  if (terminal.has(task.status)) {
    res.json({ ok: true, task: await prisma.task.findUnique({ where: { taskId }, include: { robot: { select: { robotId: true } } } }) });
    return;
  }

  // Populated only if this task's robot was actually released (i.e. the robot's
  // currentTaskId still pointed at this task at cancel time) — everything below
  // that stops/cleans up the robot is gated on this, mirroring the same
  // condition the DB release itself uses.
  let releasedRobotCode = null;

  const updated = await prisma.$transaction(async (tx) => {
    const t = await tx.task.update({
      where: { taskId },
      data: { status: "CANCELLED" },
      include: { robot: { select: { robotId: true } } },
    });

    if (task.robotId) {
      const robot = await tx.robot.findUnique({
        where: { id: task.robotId },
        select: { id: true, robotId: true, currentTaskId: true },
      });

      if (robot?.currentTaskId === task.id) {
        await tx.robot.update({
          where: { id: robot.id },
          data: { currentTaskId: null, status: "IDLE" },
        });
        releasedRobotCode = robot.robotId;
      }
    }

    return t;
  });

  if (releasedRobotCode) {
    // Stop the robot from continuing to execute the now-cancelled task.
    // Room-based so it reaches the robot regardless of which worker owns its
    // connection; a local socket-map lookup would silently no-op under
    // clustering and leave a cancelled task's robot still driving.
    try {
      await dispatchStop(io, releasedRobotCode, { taskId, reason: "TASK_CANCELLED" });
    } catch {
      // non-critical — restart/reconnect recovery never re-dispatches a
      // cancelled task (recovery only queries ASSIGNED/IN_PROGRESS tasks)
    }

    // Clear all runtime Redis state tied to this task/robot so nothing stale
    // survives for the recovery path, the reroute path, or the next assignment.
    if (kv) {
      try {
        await Promise.allSettled([
          kv.del(`taskPath:${taskId}`),
          kv.del(`task:${taskId}`),
          kv.del(`robotTaskState:${releasedRobotCode}`),
          kv.del(`robotTask:${releasedRobotCode}`),
        ]);
        await updateAssignedTask(kv, releasedRobotCode, null);
        await updatePlannedPath(kv, releasedRobotCode, null);
      } catch {
        // non-critical — Redis state degrades gracefully, TTLs still expire it
      }
    }

    try {
      io?.to("dashboard")?.emit("TASK_UPDATED", {
        taskId,
        status: "CANCELLED",
        robotId: releasedRobotCode,
        timestamp: Date.now(),
      });
    } catch {
      // ignore
    }
  }

  res.json({ ok: true, task: updated });
});

// POST /api/tasks/:taskId/reroute
const rerouteTask = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const kv = req.app?.locals?.kv;
  const io = req.app?.locals?.io;
  const taskId = toStringOrNull(req.params?.taskId);
  if (!taskId) {
    const err = new Error("taskId is required");
    err.status = 400;
    throw err;
  }
  const result = await taskService.rerouteTask(prisma, taskId, { kv, io });
  res.json({ ok: true, ...result });
});

module.exports = {
  listTasks,
  assignTask,
  cancelTask,
  rerouteTask,
};

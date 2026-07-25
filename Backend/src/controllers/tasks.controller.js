const asyncHandler = require("../utils/asyncHandler");
const { getPrisma } = require("../db/prisma");
const taskService = require("../services/task.service");
const { toStringOrNull } = require("../utils/parse");

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

  const updated = await prisma.$transaction(async (tx) => {
    const t = await tx.task.update({
      where: { taskId },
      data: { status: "CANCELLED" },
      include: { robot: { select: { robotId: true } } },
    });

    if (task.robotId) {
      const robot = await tx.robot.findUnique({
        where: { id: task.robotId },
        select: { id: true, currentTaskId: true },
      });

      if (robot?.currentTaskId === task.id) {
        await tx.robot.update({
          where: { id: robot.id },
          data: { currentTaskId: null, status: "IDLE" },
        });
      }
    }

    return t;
  });

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

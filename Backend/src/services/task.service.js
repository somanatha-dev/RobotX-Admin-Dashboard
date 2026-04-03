const { toStringOrNull, toNumberOrNull } = require("../utils/parse");

async function assignTask(prisma, task) {
  const taskId = toStringOrNull(task?.taskId || task?.id);
  const robotCode = toStringOrNull(task?.robotId);
  const pickup = toStringOrNull(task?.pickup);
  const drop = toStringOrNull(task?.drop);

  if (!taskId || !robotCode || !pickup || !drop) {
    const err = new Error("taskId, robotId, pickup, drop are required");
    err.status = 400;
    throw err;
  }

  const pickupLat = toNumberOrNull(task?.pickupLat);
  const pickupLon = toNumberOrNull(task?.pickupLon);
  const dropLat = toNumberOrNull(task?.dropLat);
  const dropLon = toNumberOrNull(task?.dropLon);

  if (pickupLat === null || pickupLon === null || dropLat === null || dropLon === null) {
    const err = new Error("pickupLat/pickupLon/dropLat/dropLon are required");
    err.status = 400;
    throw err;
  }

  const robotRow = await prisma.robot.findUnique({ where: { robotId: robotCode }, select: { id: true } });
  if (!robotRow) {
    const err = new Error("Robot not commissioned");
    err.status = 400;
    throw err;
  }

  const created = await prisma.task.create({
    data: {
      taskId,
      robotId: robotRow.id,
      pickup,
      pickupLat,
      pickupLon,
      drop,
      dropLat,
      dropLon,
      status: "ASSIGNED",
    },
    include: { robot: true },
  });

  await prisma.robot.update({
    where: { id: robotRow.id },
    data: {
      currentTaskId: created.id,
      status: "ACTIVE",
    },
  });

  return created;
}

module.exports = {
  assignTask,
};

const { toStringOrNull, toNumberOrNull } = require("../utils/parse");
const { collectDescendantLocationIds } = require("./location.service");

async function commissionRobot(prisma, body) {
  const robotCode = toStringOrNull(body?.robotId);
  const locationId = toStringOrNull(body?.locationId);
  const campusId = toStringOrNull(body?.campusId);
  const lat = toNumberOrNull(body?.lat);
  const lon = toNumberOrNull(body?.lon);

  if (!robotCode || !locationId) {
    const err = new Error("robotId and locationId are required");
    err.status = 400;
    throw err;
  }

  const location = await prisma.location.findUnique({ where: { id: locationId }, select: { id: true } });
  if (!location) {
    const err = new Error("Invalid locationId");
    err.status = 400;
    throw err;
  }

  if (campusId) {
    const campus = await prisma.campus.findUnique({ where: { id: campusId }, select: { id: true } });
    if (!campus) {
      const err = new Error("Invalid campusId");
      err.status = 400;
      throw err;
    }
  }

  return prisma.robot.upsert({
    where: { robotId: robotCode },
    create: {
      robotId: robotCode,
      locationId,
      campusId,
      lat,
      lon,
      isOnline: false,
    },
    update: {
      locationId,
      campusId,
      ...(lat === null ? {} : { lat }),
      ...(lon === null ? {} : { lon }),
    },
    include: { location: true, campus: true, currentTask: true },
  });
}

async function listRobots(prisma, query) {
  const { locationId, includeDescendants, campusId, isOnline, status } = query || {};

  const where = {};

  if (campusId) {
    where.campusId = String(campusId);
  } else if (locationId) {
    const rootId = String(locationId);
    const wantDesc = String(includeDescendants || "true") === "true";
    if (wantDesc) {
      const ids = await collectDescendantLocationIds(prisma, rootId);
      where.locationId = { in: ids };
    } else {
      where.locationId = rootId;
    }
  }

  if (typeof isOnline === "string") where.isOnline = isOnline === "true";
  if (status) where.status = String(status);

  return prisma.robot.findMany({
    where,
    include: {
      campus: true,
      location: true,
      currentTask: true,
    },
    orderBy: [{ isOnline: "desc" }, { lastSeenAt: "desc" }],
  });
}

async function markRobotOffline(prisma, robotCode) {
  return prisma.robot.update({
    where: { robotId: robotCode },
    data: { isOnline: false },
  });
}

module.exports = {
  commissionRobot,
  listRobots,
  markRobotOffline,
};

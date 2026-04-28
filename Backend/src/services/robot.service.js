const { toStringOrNull, toNumberOrNull } = require("../utils/parse");
const { collectDescendantLocationIds } = require("./location.service");

function randFloat(min, max) {
  return min + Math.random() * (max - min);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

async function commissionRobot(prisma, body) {
  const robotCode = toStringOrNull(body?.robotId);
  const locationId = toStringOrNull(body?.locationId);
  const campusId = toStringOrNull(body?.campusId);
  const latIn = toNumberOrNull(body?.lat);
  const lonIn = toNumberOrNull(body?.lon);

  if (!robotCode || !locationId) {
    const err = new Error("robotId and locationId are required");
    err.status = 400;
    throw err;
  }

  const location = await prisma.location.findUnique({ where: { id: locationId }, select: { id: true, lat: true, lon: true } });
  if (!location) {
    const err = new Error("Invalid locationId");
    err.status = 400;
    throw err;
  }

  const lat = latIn === null ? toNumberOrNull(location.lat) : latIn;
  const lon = lonIn === null ? toNumberOrNull(location.lon) : lonIn;

  if (campusId) {
    const campus = await prisma.campus.findUnique({ where: { id: campusId }, select: { id: true } });
    if (!campus) {
      const err = new Error("Invalid campusId");
      err.status = 400;
      throw err;
    }
  }

  const now = new Date();
  const battery = clamp(Math.round(randFloat(70, 100)), 0, 100);

  return prisma.robot.upsert({
    where: { robotId: robotCode },
    create: {
      robotId: robotCode,
      locationId,
      campusId,
      status: "IDLE",
      battery,
      lat,
      lon,
      speed: 0,
      isOnline: true,
      lastSeenAt: now,
    },
    update: {
      locationId,
      campusId,
      ...(lat === null ? {} : { lat }),
      ...(lon === null ? {} : { lon }),
      // Do not clobber existing operational state; just ensure it's visible immediately.
      isOnline: true,
      lastSeenAt: now,
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

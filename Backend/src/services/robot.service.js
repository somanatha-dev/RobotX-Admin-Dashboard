const { toStringOrNull, toNumberOrNull } = require("../utils/parse");
const { collectDescendantLocationIds } = require("./location.service");
const legacyRobotMapper = require("../engine/domain/mappers/legacyRobot");

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
  const name = toStringOrNull(body?.name) || null;

  if (!robotCode || !locationId) {
    const err = new Error("robotId and locationId are required");
    err.status = 400;
    throw err;
  }

  // Reject duplicate robot IDs — each unit must have a unique identifier.
  const duplicate = await prisma.robot.findUnique({ where: { robotId: robotCode }, select: { id: true } });
  if (duplicate) {
    const err = new Error(`A robot with ID "${robotCode}" is already commissioned. Choose a different identifier.`);
    err.status = 409;
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

  // Phase 2 (§2.1): a commissioned Robot and its domain Agent are created together.
  //
  // The alternative — create the Robot and project it later — reintroduces the
  // orphan the Phase 2 completion criterion forbids ("100 % of legacy rows
  // converted with zero orphans") the moment a robot is commissioned after the
  // backfill has run. Both writes are in one transaction because a Robot with no
  // Agent is not a state this schema admits.
  //
  // The returned shape is unchanged: the caller receives the same Robot row with
  // the same includes it received before Phase 2, so no HTTP response moves.
  const created = await prisma.$transaction(async (tx) => {
    const robot = await tx.robot.create({
      data: {
        robotId: robotCode,
        name,
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
      include: { location: true, campus: true, currentTask: true },
    });

    await ensureAgentForRobot(tx, robot);
    return robot;
  });

  return created;
}

/**
 * Ensure the domain `Agent` (§2.1) exists for a legacy `Robot` row. Idempotent.
 *
 * The Agent's primary key is derived deterministically from the robot's own code
 * (`engine/domain/mappers/legacyRobot.deterministicId`), so this is the same upsert
 * `tools/migrate/backfillDomain.js` performs — calling both is safe and converges
 * on identical state.
 *
 * `authorityEpoch` and `fenceCounter` are deliberately absent from the update
 * branch: both are monotone counters (§2.6, invariant I6), and a re-commission that
 * reset one would invalidate a fencing decision already taken against it.
 *
 * @param {object} prisma a client or a transaction client
 * @param {{ id: string, robotId: string }} robot
 * @returns {Promise<object|null>} the Agent row, or null when the robot is unusable
 */
async function ensureAgentForRobot(prisma, robot) {
  if (!prisma || !prisma.agent || !robot || !robot.robotId) return null;

  const agent = legacyRobotMapper.robotToAgent(robot);
  return prisma.agent.upsert({
    where: { id: agent.id },
    create: agent,
    update: { agentId: agent.agentId, robotDbId: agent.robotDbId },
  });
}

/**
 * The domain-side read model for a robot: the legacy row joined to its Agent, in
 * the projection shape `mappers/legacyRobot.toAgentProjection` defines.
 *
 * This is the "internal read models updated to join new tables" the Phase 2 plan
 * asks for. It is not wired into any HTTP response — every legacy endpoint returns
 * exactly what it returned before Phase 2 — and exists so that a Phase 3+ consumer
 * reads the domain model through one place rather than joining ad hoc.
 *
 * @param {object} prisma
 * @param {string} robotCode the legacy `Robot.robotId`
 * @returns {Promise<object|null>}
 */
async function readAgentProjection(prisma, robotCode) {
  const code = toStringOrNull(robotCode);
  if (!code) return null;

  const robot = await prisma.robot.findUnique({
    where: { robotId: code },
    include: { agent: true },
  });

  return legacyRobotMapper.toAgentProjection(robot);
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

module.exports = {
  commissionRobot,
  listRobots,
  ensureAgentForRobot,
  readAgentProjection,
};

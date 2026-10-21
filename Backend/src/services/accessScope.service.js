"use strict";

/**
 * RBAC — what a verified human operator may see and act on, decided in one place.
 *
 *   SUPER_ADMIN  every campus (`kind: "ALL"`). Every other control still applies: the §23.4
 *                action classes, reasons, second approvers and Safety-class rules.
 *   ADMIN        exactly one campus (`kind: "CAMPUS"`), from the account's own row — never
 *                from a request. An ADMIN whose campus is missing or does not resolve is
 *                `kind: "INVALID"` and sees nothing: a missing campus is never "unrestricted".
 *   anything else `kind: "INVALID"`.
 *
 * Ownership, as the schema records it:
 *
 *   Robot  `Robot.campusId`. When the robot's Agent names a region, it must be the campus's
 *          region (`Campus.regionId`); a robot whose two records disagree belongs to neither
 *          campus — it is denied rather than shown to whichever one a query happens to hit.
 *   Task   its Missions' region — every Mission in that campus's region. A task with no
 *          Mission (a legacy task) belongs to its robot's campus. A task neither resolves is
 *          denied. `Task` has no campus column; this is the relationship the engine wrote.
 *
 * Out-of-scope resources are answered exactly like unknown ones (the caller's 404), so an
 * identifier from another campus cannot be used to learn that the resource exists.
 */

const ROLE = Object.freeze({ SUPER_ADMIN: "SUPER_ADMIN", ADMIN: "ADMIN" });

const SCOPE = Object.freeze({ ALL: "ALL", CAMPUS: "CAMPUS", INVALID: "INVALID" });

/** The `User` fields `verifyUserToken` selects, so the scope is computed from one read. */
const USER_SCOPE_SELECT = Object.freeze({
  id: true,
  email: true,
  role: true,
  campusId: true,
  disabledAt: true,
  campus: { select: { id: true, code: true, name: true, regionId: true, region: { select: { regionId: true } } } },
});

/** Matches no row: the filter an INVALID scope gets, so a list is empty rather than global. */
const NOTHING = Object.freeze({ id: { in: [] } });

/**
 * @param {object|null|undefined} user the row `verifyUserToken` resolved
 * @returns {{ kind: string, campusId?: string, campusCode?: string, campusName?: string,
 *   regionRowId?: string|null, regionKey?: string|null, reason?: string }}
 */
function accessScopeFor(user) {
  if (!user) return { kind: SCOPE.INVALID, reason: "no authenticated account" };
  if (user.role === ROLE.SUPER_ADMIN) return { kind: SCOPE.ALL };
  if (user.role !== ROLE.ADMIN) return { kind: SCOPE.INVALID, reason: `unknown role "${String(user.role)}"` };

  const campus = user.campus;
  if (!user.campusId || !campus || campus.id !== user.campusId) {
    return { kind: SCOPE.INVALID, reason: "this administrator account has no valid campus assignment" };
  }
  return {
    kind: SCOPE.CAMPUS,
    campusId: campus.id,
    campusCode: campus.code,
    campusName: campus.name,
    regionRowId: campus.regionId || null,
    regionKey: (campus.region && campus.region.regionId) || null,
  };
}

function isSuperAdmin(scope) {
  return Boolean(scope) && scope.kind === SCOPE.ALL;
}

/**
 * The Prisma `Robot` filter for a scope.
 *
 * @param {object} scope
 * @returns {object}
 */
function robotWhere(scope) {
  if (isSuperAdmin(scope)) return {};
  if (!scope || scope.kind !== SCOPE.CAMPUS) return NOTHING;
  return {
    campusId: scope.campusId,
    OR: [
      { agent: { is: null } },
      { agent: { is: { regionId: null } } },
      ...(scope.regionRowId ? [{ agent: { is: { regionId: scope.regionRowId } } }] : []),
    ],
  };
}

/**
 * The Prisma `Task` filter for a scope.
 *
 * @param {object} scope
 * @returns {object}
 */
function taskWhere(scope) {
  if (isSuperAdmin(scope)) return {};
  if (!scope || scope.kind !== SCOPE.CAMPUS) return NOTHING;
  const legacy = { missions: { none: {} }, robot: { is: robotWhere(scope) } };
  if (!scope.regionRowId) return legacy;
  return {
    OR: [{ missions: { some: { regionId: scope.regionRowId }, every: { regionId: scope.regionRowId } } }, legacy],
  };
}

/**
 * Merge a scope filter into an existing `where`. `AND` keeps the caller's own filters — a
 * `campusId` query parameter still narrows — while never widening past the scope.
 *
 * @param {object} where
 * @param {object} scoped
 * @returns {object}
 */
function within(where, scoped) {
  if (!scoped || Object.keys(scoped).length === 0) return where || {};
  return { AND: [where || {}, scoped] };
}

function notFound(message) {
  const err = new Error(message);
  err.status = 404;
  return err;
}

/**
 * The robot, if the scope may see it; otherwise the same 404 an unknown robot gets.
 *
 * @param {object} prisma
 * @param {object} scope
 * @param {string} robotCode the business id (`Robot.robotId`)
 * @param {object} [select]
 * @returns {Promise<object>}
 */
async function robotInScopeOrThrow(prisma, scope, robotCode, select) {
  const robot = robotCode
    ? await prisma.robot.findFirst({ where: within({ robotId: robotCode }, robotWhere(scope)), select: select || { id: true, robotId: true } })
    : null;
  if (!robot) throw notFound("Unknown robotId");
  return robot;
}

/**
 * The task, if the scope may see it; otherwise the same 404 an unknown task gets.
 *
 * @param {object} prisma
 * @param {object} scope
 * @param {string} taskId the business id (`Task.taskId`)
 * @returns {Promise<{ id: string, taskId: string }>}
 */
async function taskInScopeOrThrow(prisma, scope, taskId) {
  const task = taskId
    ? await prisma.task.findFirst({ where: within({ taskId }, taskWhere(scope)), select: { id: true, taskId: true } })
    : null;
  if (!task) throw notFound("Unknown taskId");
  return task;
}

/**
 * The campus an existing robot belongs to under the same rule `robotWhere` applies, or null
 * when it belongs to none (no campus, or its Agent's region contradicts its campus).
 *
 * @param {object} prisma
 * @param {string} robotKey the business id, or the row id
 * @returns {Promise<string|null>}
 */
async function campusIdForRobot(prisma, robotKey) {
  if (!robotKey) return null;
  const robot = await prisma.robot.findFirst({
    where: { OR: [{ robotId: String(robotKey) }, ...(isUuid(robotKey) ? [{ id: String(robotKey) }] : [])] },
    select: { campusId: true, campus: { select: { regionId: true } }, agent: { select: { regionId: true } } },
  });
  if (!robot || !robot.campusId) return null;
  const agentRegion = robot.agent ? robot.agent.regionId : null;
  if (agentRegion && agentRegion !== (robot.campus ? robot.campus.regionId : null)) return null;
  return robot.campusId;
}

/**
 * The campus a task belongs to under the same rule `taskWhere` applies, or null.
 *
 * @param {object} prisma
 * @param {string} taskId the business id
 * @returns {Promise<string|null>}
 */
async function campusIdForTask(prisma, taskId) {
  if (!taskId) return null;
  const task = await prisma.task.findUnique({
    where: { taskId: String(taskId) },
    select: { robotId: true, missions: { select: { regionId: true } } },
  });
  if (!task) return null;
  if (task.missions.length > 0) {
    const regions = new Set(task.missions.map((m) => m.regionId));
    if (regions.size !== 1) return null;
    const [regionRowId] = regions;
    if (!regionRowId) return null;
    const campus = await prisma.campus.findUnique({ where: { regionId: regionRowId }, select: { id: true } });
    return campus ? campus.id : null;
  }
  return task.robotId ? campusIdForRobot(prisma, task.robotId) : null;
}

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * What the dashboard may show about the caller's own scope — the campus is the account's,
 * never an echo of anything the request said.
 *
 * @param {object} scope
 * @returns {object|null}
 */
function publicCampus(scope) {
  if (!scope || scope.kind !== SCOPE.CAMPUS) return null;
  return { id: scope.campusId, code: scope.campusCode, name: scope.campusName, regionId: scope.regionKey };
}

module.exports = {
  ROLE,
  SCOPE,
  USER_SCOPE_SELECT,
  accessScopeFor,
  isSuperAdmin,
  robotWhere,
  taskWhere,
  within,
  robotInScopeOrThrow,
  taskInScopeOrThrow,
  campusIdForRobot,
  campusIdForTask,
  publicCampus,
};

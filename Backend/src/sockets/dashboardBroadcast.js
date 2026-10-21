"use strict";

/**
 * RBAC — every dashboard broadcast goes through `emit()`.
 *
 * Two kinds of room:
 *
 *   `dashboard`                  SUPER_ADMIN sockets. Receives every event, exactly as the
 *                                single `dashboard` room always did.
 *   `dashboard:campus:<campusId>` a campus ADMIN's sockets. Never joins `dashboard`. Receives
 *                                only the events listed below, and only for a robot or task
 *                                that belongs to that campus under `accessScope`'s rules.
 *
 * Default deny: an event that is not listed, or whose robot or task resolves to no campus,
 * reaches SUPER_ADMIN sockets only. Security events, pairing rejections, obstacle alerts,
 * zone changes, command acknowledgements (they carry only a command id) and the engine's
 * invariant events are in that set.
 *
 * Relaying is ordered (one chain, so a campus room sees events in the order they were
 * broadcast) and bounded (a backlog beyond `MAX_PENDING` drops relays — an ADMIN misses an
 * update and resynchronises on its next refresh, which is the safe direction). The campus
 * of a robot or task is cached for `CACHE_TTL_MS`; reassigning a robot's campus clears its
 * entry at once (`forgetRobot`).
 */

const { getPrisma } = require("../db/prisma");
const accessScope = require("../services/accessScope.service");

const ROOM = "dashboard";
const CAMPUS_ROOM_PREFIX = "dashboard:campus:";

/** Events an ADMIN may receive, by the payload field that names their subject. */
const ROBOT_EVENTS = new Set([
  "robot:update",
  "robot_online",
  "robot_offline",
  "robot_retired",
  "robot_recommissioned",
  "ROBOT_UPDATE",
  "ROBOT_UPDATED",
  "ROBOT_COMMISSIONED",
  "ROBOT_SPECIFICATION_UPDATED",
  "OFFER_RESPONSE",
  "SUPERVISION_SIGNAL",
]);
const TASK_EVENTS = new Set(["TASK_CREATED", "TASK_UPDATED", "TASK_ASSIGNED"]);

const CACHE_TTL_MS = 15_000;
const CACHE_MAX = 5_000;
const MAX_PENDING = 1_000;

const robotCampus = new Map();
const taskCampus = new Map();
/** campusId → number of ADMIN sockets in its room on this process. */
const members = new Map();
/** True when a cross-process adapter is attached: other processes may hold campus members. */
let crossProcess = false;
let chain = Promise.resolve();
let pending = 0;

function campusRoom(campusId) {
  return `${CAMPUS_ROOM_PREFIX}${campusId}`;
}

function userRoom(userId) {
  return `user:${userId}`;
}

function cacheGet(cache, key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.campusId;
}

function cacheSet(cache, key, campusId) {
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, { campusId, at: Date.now() });
}

async function campusFor(event, payload) {
  const prisma = getPrisma();
  if (TASK_EVENTS.has(event)) {
    const taskId = payload && payload.taskId ? String(payload.taskId) : null;
    if (!taskId) return null;
    let campusId = cacheGet(taskCampus, taskId);
    if (campusId === undefined) {
      campusId = await accessScope.campusIdForTask(prisma, taskId);
      cacheSet(taskCampus, taskId, campusId);
    }
    return campusId;
  }
  if (ROBOT_EVENTS.has(event)) {
    const robotId = payload && payload.robotId ? String(payload.robotId) : null;
    if (!robotId) return null;
    let campusId = cacheGet(robotCampus, robotId);
    if (campusId === undefined) {
      campusId = await accessScope.campusIdForRobot(prisma, robotId);
      cacheSet(robotCampus, robotId, campusId);
    }
    return campusId;
  }
  return null;
}

function relay(io, event, payload) {
  if (!ROBOT_EVENTS.has(event) && !TASK_EVENTS.has(event)) return;
  if (!crossProcess && members.size === 0) return;
  if (pending >= MAX_PENDING) return;
  pending += 1;
  chain = chain
    .then(async () => {
      const campusId = await campusFor(event, payload);
      if (campusId) io.to(campusRoom(campusId)).emit(event, payload);
    })
    .catch(() => {
      // A relay that fails costs an ADMIN one update, never anyone else's.
    })
    .finally(() => {
      pending -= 1;
    });
}

/**
 * Broadcast a dashboard event. The SUPER_ADMIN room is emitted synchronously, exactly as
 * `io.to("dashboard").emit(event, payload)` did, so a caller's own error handling and the
 * event order SUPER_ADMIN sockets see are unchanged.
 *
 * @param {object|null|undefined} io
 * @param {string} event
 * @param {*} payload
 */
function emit(io, event, payload) {
  const room = io && typeof io.to === "function" ? io.to(ROOM) : null;
  if (!room || typeof room.emit !== "function") return;
  room.emit(event, payload);
  relay(io, event, payload);
}

/** An ADMIN socket joined (or left) its campus room on this process. */
function memberJoined(campusId) {
  members.set(campusId, (members.get(campusId) || 0) + 1);
}

function memberLeft(campusId) {
  const next = (members.get(campusId) || 0) - 1;
  if (next > 0) members.set(campusId, next);
  else members.delete(campusId);
}

function setCrossProcess(value) {
  crossProcess = Boolean(value);
}

function forgetRobot(robotId) {
  if (robotId) robotCampus.delete(String(robotId));
}

/** Resolves once every relay queued so far has been attempted. For tests and shutdown. */
function drain() {
  return chain;
}

/** Test seam: forget every cached campus and member. */
function reset() {
  robotCampus.clear();
  taskCampus.clear();
  members.clear();
  crossProcess = false;
}

module.exports = {
  ROOM,
  ROBOT_EVENTS,
  TASK_EVENTS,
  campusRoom,
  userRoom,
  emit,
  memberJoined,
  memberLeft,
  setCrossProcess,
  forgetRobot,
  drain,
  reset,
};

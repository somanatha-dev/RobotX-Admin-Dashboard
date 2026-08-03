"use strict";

/**
 * Legacy `Task` ⟷ domain `Task` + `Mission` + `Leg` + `Stop` mapping.
 *
 * The terminology map records what this module undoes:
 *
 * > `Task` (pickup→drop, one robot) → `Task` + `Mission` + one `Leg` + two `Stop`s
 * > (§2.4). **Today's Task collapses four architectural entities.**
 *
 * §2.4 states the collapsed case explicitly, and it is exactly the legacy row:
 *
 * > For the common single-agent point-to-point delivery, Mission = one Leg = two
 * > Stops, and the model collapses to the simple case with no overhead.
 *
 * So the mapping is not lossy in either direction, and the property the plan states
 * as this phase's test — "every legacy Task maps to exactly one Mission with exactly
 * one `PRIMARY` Leg and two Stops" — is a structural consequence rather than a
 * coincidence to be checked case by case.
 *
 * ── The status bridge ───────────────────────────────────────────────────────
 * `TaskStatus` now carries both vocabularies: the six legacy values and the eleven
 * §4.2 states. The two are **not** interchangeable, and no engine module may read a
 * legacy value as a §4.2 state. `legacyStatusToTaskState()` is the only sanctioned
 * translation, and it is one-directional: the legacy dispatcher keeps writing legacy
 * values until the Phase 15 cutover, and nothing writes §4.2 values yet.
 *
 * The bridge is deliberately partial. `ASSIGNED` has no §4.2 Task state, because
 * §4.2's states are deliberately coarse and "assigned" is *Leg* detail — it is the
 * `OFFERED`/`ACCEPTED`/`EN_ROUTE_PICKUP` distinction of §4.3, whose absence from the
 * baseline is the defect §4.3 exists to fix. Collapsing it back to a single Task
 * state here would re-create the conflation.
 */

const { deterministicId, ID_NAMESPACE } = require("./legacyRobot");
const { LEG_STATES, TASK_STATES } = require("../work");
const { CUSTODY_STATES } = require("../custody");
const { PURPOSES } = require("../purpose");

/**
 * Legacy `TaskStatus` → §4.2 Task state, where §4.2 has a corresponding state.
 *
 * `ASSIGNED` maps to `null`: see the module note. A caller that needs to know what
 * an assigned Task is doing must read its Leg, which is the point of the split.
 */
const LEGACY_STATUS_TO_TASK_STATE = Object.freeze({
  PENDING: TASK_STATES.WAITING.name,
  ASSIGNED: null,
  IN_PROGRESS: TASK_STATES.IN_EXECUTION.name,
  COMPLETED: TASK_STATES.COMPLETED.name,
  FAILED: TASK_STATES.FAILED.name,
  CANCELLED: TASK_STATES.CANCELLED.name,
});

/**
 * Legacy `TaskStatus` → the §4.3 Leg state a backfilled `PRIMARY` Leg starts in.
 *
 * A backfilled Leg records where the legacy Task *was*, as closely as the legacy
 * vocabulary permits, and never more precisely than that. `ASSIGNED` becomes
 * `ACCEPTED` rather than `OFFERED` or `EN_ROUTE_PICKUP` because the legacy row
 * carries no evidence of dispatch acknowledgement or of motion, and `ACCEPTED` is
 * the state that claims least: it asserts a binding exists and asserts nothing about
 * movement. `IN_PROGRESS` becomes `EN_ROUTE_PICKUP` for the same reason — it is the
 * earliest moving state, and claiming a later one would fabricate progress.
 *
 * Nothing maps to `LOADED`, because custody is a fact the legacy schema never
 * recorded and inventing it would violate §4.1 rule 3.
 */
const LEGACY_STATUS_TO_LEG_STATE = Object.freeze({
  PENDING: LEG_STATES.QUEUED.name,
  ASSIGNED: LEG_STATES.ACCEPTED.name,
  IN_PROGRESS: LEG_STATES.EN_ROUTE_PICKUP.name,
  COMPLETED: LEG_STATES.SETTLED.name,
  FAILED: LEG_STATES.FAILED.name,
  CANCELLED: LEG_STATES.CANCELLED.name,
});

/**
 * @param {string} status a legacy `TaskStatus` value
 * @returns {string|null} the §4.2 state, or null where §4.2 has none
 */
function legacyStatusToTaskState(status) {
  const mapped = LEGACY_STATUS_TO_TASK_STATE[status];
  return mapped === undefined ? null : mapped;
}

/**
 * @param {string} status a legacy `TaskStatus` value
 * @returns {string} the §4.3 Leg state a backfilled Leg starts in
 */
function legacyStatusToLegState(status) {
  const mapped = LEGACY_STATUS_TO_LEG_STATE[status];
  // An unrecognised legacy status yields QUEUED — the state that asserts least and
  // that supervision will pick up — rather than a terminal state that would silently
  // close work nobody closed.
  return mapped === undefined ? LEG_STATES.QUEUED.name : mapped;
}

/**
 * Decompose one legacy Task row into the four §2.4 entities.
 *
 * Every id is derived deterministically from the legacy `taskId`, so the backfill
 * is idempotent by construction: re-running it upserts the same rows rather than
 * creating a second Mission for the same Task.
 *
 * @param {object} task a `Task` row
 * @param {{ regionId?: string|null }} [context]
 * @returns {{ mission: object, leg: object, stops: object[] }}
 */
function taskToWork(task, context) {
  if (!task || typeof task !== "object") throw new Error("taskToWork requires a Task row");
  if (typeof task.taskId !== "string" || task.taskId.length === 0) {
    throw new Error("taskToWork requires Task.taskId — every derived id is a function of it");
  }

  const settings = context || {};
  const key = task.taskId;

  const mission = {
    id: deterministicId(ID_NAMESPACE.MISSION, key),
    missionId: `MSN-${key}`,
    regionId: settings.regionId === undefined ? null : settings.regionId,
  };

  const leg = {
    id: deterministicId(ID_NAMESPACE.LEG, key),
    legId: `LEG-${key}`,
    missionId: mission.id,
    // A legacy Task is one Leg, so it is the first and only one.
    sequence: 0,
    // §2.4: the ordinary case, created by intake from a customer Task.
    purpose: PURPOSES.PRIMARY.name,
    state: legacyStatusToLegState(task.status),
    // §2.5: the legacy schema records no custody, and custody is never inferred
    // from the absence of data (§4.1 rule 3). NONE is what the plan specifies for
    // the backfill and is the only honest value.
    custodyState: CUSTODY_STATES.NONE.name,
    version: 0,
    cancelRequestedAt: null,
    cancelReason: null,
    obstructionClass: null,
    startNotBefore: null,
    slaDeadline: null,
  };

  const stops = [
    {
      id: deterministicId(ID_NAMESPACE.STOP, `${key}#pickup`),
      stopId: `STP-${key}-P`,
      legId: leg.id,
      sequence: 0,
      stopType: "PICKUP",
      label: task.pickup === undefined ? null : task.pickup,
      lat: typeof task.pickupLat === "number" ? task.pickupLat : null,
      lon: typeof task.pickupLon === "number" ? task.pickupLon : null,
      windowStart: task.windowStart || null,
      windowEnd: task.windowEnd || null,
    },
    {
      id: deterministicId(ID_NAMESPACE.STOP, `${key}#drop`),
      stopId: `STP-${key}-D`,
      legId: leg.id,
      sequence: 1,
      stopType: "DROP",
      label: task.drop === undefined ? null : task.drop,
      lat: typeof task.dropLat === "number" ? task.dropLat : null,
      lon: typeof task.dropLon === "number" ? task.dropLon : null,
      windowStart: task.windowStart || null,
      windowEnd: task.windowEnd || null,
    },
  ];

  return { mission, leg, stops };
}

/**
 * Reconstruct the legacy Task shape from the domain entities.
 *
 * The round trip is what makes the mapping checkable: a test that decomposes a Task
 * and recomposes it, and asserts the pickup/drop fields survive, proves the split is
 * lossless for the fields the legacy path reads.
 *
 * @param {{ mission: object, leg: object, stops: object[] }} work
 * @returns {object} the legacy-shaped fields
 */
function workToLegacyTask(work) {
  const stops = (work && work.stops) || [];
  const pickup = stops.find((stop) => stop && stop.stopType === "PICKUP") || null;
  const drop = stops.find((stop) => stop && stop.stopType === "DROP") || null;

  return {
    pickup: pickup ? pickup.label : null,
    pickupLat: pickup ? pickup.lat : null,
    pickupLon: pickup ? pickup.lon : null,
    drop: drop ? drop.label : null,
    dropLat: drop ? drop.lat : null,
    dropLon: drop ? drop.lon : null,
  };
}

/**
 * The domain-side projection of a Task row joined to its Missions.
 *
 * As with `legacyRobot.toAgentProjection`, this changes no HTTP response: it is the
 * internal read model the plan asks Phase 2 to update to join the new tables.
 *
 * @param {object} task a `Task` row, optionally with `missions` included
 * @returns {object|null}
 */
function toWorkProjection(task) {
  if (!task || typeof task !== "object") return null;
  const missions = Array.isArray(task.missions) ? task.missions : [];

  return Object.freeze({
    taskId: task.taskId,
    // The §4.2 state this Task's legacy status corresponds to, or null where §4.2
    // has none — never a guess.
    taskState: legacyStatusToTaskState(task.status),
    tenantId: task.tenantId === undefined ? null : task.tenantId,
    slaClass: task.slaClass === undefined ? null : task.slaClass,
    businessPriority: task.businessPriority === undefined ? null : task.businessPriority,
    missionIds: Object.freeze(missions.map((mission) => mission.missionId)),
    legacy: Object.freeze({
      id: task.id || null,
      status: task.status === undefined ? null : task.status,
      robotId: task.robotId === undefined ? null : task.robotId,
      distanceMeters: task.distanceMeters === undefined ? null : task.distanceMeters,
    }),
    undecomposed: missions.length === 0,
  });
}

module.exports = {
  LEGACY_STATUS_TO_TASK_STATE,
  LEGACY_STATUS_TO_LEG_STATE,
  legacyStatusToTaskState,
  legacyStatusToLegState,
  taskToWork,
  workToLegacyTask,
  toWorkProjection,
};

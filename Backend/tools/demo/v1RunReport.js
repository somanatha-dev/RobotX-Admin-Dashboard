"use strict";

/**
 * **V1 demonstration run report** — the invariants a V1 run must hold, and the counts it
 * reports, computed from rows read back after the run. V1_DEMONSTRATION tooling.
 *
 * Pure: no I/O, no clock. `tools/demo/runV1Assignment.js` reads the rows and hands them
 * here, and `tests/engine/v1RunReport.test.js` plants each violation to prove every check
 * can fail.
 *
 * A run is allowed to leave tasks unserved (a task nobody can feasibly do is a correct
 * outcome). It is **not** allowed to:
 *   I1  hold two live commitments on one Leg              (duplicate assignment)
 *   I2  hold more live commitments on an agent than its capacity
 *   I3  commit an (agent, Leg) pair the feasibility gate never passed  (impossible assignment)
 *   I4  lose a task — every task is COMPLETED, in flight, waiting in a live queue row, in a
 *       named §4.7 recovery state, or terminally failed
 *   I5  mark a task COMPLETED without a SETTLED Leg and a SUFFICIENT verification
 *   I6  leave a live commitment on a Leg that is settled, queued or terminal (orphan)
 *   I7  settle a Leg for a robot other than the one the Task names
 *   I8  ever hold two overlapping commitments on one Leg (a duplicate later released)
 */

/** Leg states in which a live commitment is expected (the agent holds the work). */
const EXECUTING_STATES = Object.freeze([
  "OFFERED",
  "ACCEPTED",
  "EN_ROUTE_PICKUP",
  "AT_PICKUP",
  "LOADED",
  "EN_ROUTE_DROP",
  "AT_DROP",
  "RELEASED",
  "ABORTING",
  "STRANDED_SAFE",
  "STRANDED_OBSTRUCTING",
]);

/** Leg states in which the work is waiting in the queue for (another) assignment. */
const WAITING_STATES = Object.freeze(["QUEUED", "DEFERRED", "PLANNED"]);

/** §4.7 recovery states: named, supervised by a deadline, not waiting in the queue. */
const RECOVERY_STATES = Object.freeze(["REASSIGNING", "ABORTING", "STRANDED_SAFE", "STRANDED_OBSTRUCTING"]);

/** Queue states in which a coordinator will still pick the row up. */
const LIVE_QUEUE_STATES = Object.freeze(["QUEUED", "CLAIMED"]);

/** Terminal states other than SETTLED: the work ended without delivery, by name. */
const TERMINAL_FAILED_STATES = Object.freeze(["WITHDRAWN", "CANCELLED", "FAILED"]);

/**
 * Where one task ended up.
 *
 * @param {object} input `{ task, leg, liveCommitments, queueRow }`
 * @returns {"COMPLETED"|"IN_FLIGHT"|"WAITING"|"RECOVERING"|"FAILED"|"LOST"}
 */
function classifyTask(input) {
  const { task, leg, liveCommitments, queueRow } = input || {};
  if (!task) return "LOST";
  if (task.status === "COMPLETED") return "COMPLETED";
  if (!leg) return "LOST";
  if (EXECUTING_STATES.includes(leg.state) && (liveCommitments || []).length > 0) return "IN_FLIGHT";
  if (WAITING_STATES.includes(leg.state) && queueRow && LIVE_QUEUE_STATES.includes(queueRow.state)) return "WAITING";
  if (RECOVERY_STATES.includes(leg.state)) return "RECOVERING";
  if (TERMINAL_FAILED_STATES.includes(leg.state)) return "FAILED";
  return "LOST";
}

/**
 * @param {object} input
 * @param {object[]} input.tasks `{ taskId, status, robotId (business), legId (business) }`
 * @param {object[]} input.legs `{ legId, state }`
 * @param {object[]} input.commitments `{ commitmentId, agentId, legId, releasedAt }` (business ids)
 * @param {object[]} input.queueRows `{ legId, state }`
 * @param {object[]} input.verifications `{ legId, outcome }`
 * @param {object[]} input.gateVerdicts `{ agentId, legId, feasible }` from the gate observer
 * @param {number} [input.capacity] per-agent live commitment capacity (V1: 1)
 * @returns {{ ok: boolean, violations: object[], outcomes: Record<string, string> }}
 */
function checkInvariants(input) {
  const source = input || {};
  const tasks = source.tasks || [];
  const legs = new Map((source.legs || []).map((row) => [row.legId, row]));
  const commitments = source.commitments || [];
  const live = commitments.filter((row) => !row.releasedAt);
  const queueByLeg = new Map((source.queueRows || []).map((row) => [row.legId, row]));
  const capacity = Number.isFinite(source.capacity) ? source.capacity : 1;
  const violations = [];

  const group = (rows, key) => {
    const out = new Map();
    for (const row of rows) out.set(row[key], [...(out.get(row[key]) || []), row]);
    return out;
  };

  // I1 / I2
  for (const [legId, rows] of group(live, "legId")) {
    if (rows.length > 1) violations.push({ id: "I1", legId, detail: `${rows.length} live commitments on one Leg` });
  }
  for (const [agentId, rows] of group(live, "agentId")) {
    if (rows.length > capacity) violations.push({ id: "I2", agentId, detail: `${rows.length} live commitments > capacity ${capacity}` });
  }

  // I3 — every commitment the engine made was preceded by a feasible gate verdict.
  const passed = new Set((source.gateVerdicts || []).filter((row) => row.feasible).map((row) => `${row.agentId}|${row.legId}`));
  for (const row of commitments) {
    if (!passed.has(`${row.agentId}|${row.legId}`)) {
      violations.push({ id: "I3", agentId: row.agentId, legId: row.legId, detail: "committed without a feasible gate verdict" });
    }
  }

  // I4 / I5 / I7
  const outcomes = {};
  const settledVerification = new Set(
    (source.verifications || []).filter((row) => row.outcome === "SUFFICIENT").map((row) => row.legId),
  );
  for (const task of tasks) {
    const leg = legs.get(task.legId) || null;
    const outcome = classifyTask({
      task,
      leg,
      liveCommitments: live.filter((row) => row.legId === task.legId),
      queueRow: queueByLeg.get(task.legId) || null,
    });
    outcomes[task.taskId] = outcome;
    if (outcome === "LOST") {
      violations.push({ id: "I4", taskId: task.taskId, detail: `task ${task.status}, leg ${leg ? leg.state : "missing"}, no live commitment or queue row` });
    }
    if (outcome === "COMPLETED") {
      if (!leg || leg.state !== "SETTLED") violations.push({ id: "I5", taskId: task.taskId, detail: `COMPLETED but Leg is ${leg ? leg.state : "missing"}` });
      if (!settledVerification.has(task.legId)) violations.push({ id: "I5", taskId: task.taskId, detail: "COMPLETED without a SUFFICIENT verification" });
      const settling = commitments.filter((row) => row.legId === task.legId && row.releasedAt);
      const last = settling[settling.length - 1];
      if (last && task.robotId && last.agentId !== task.robotId) {
        violations.push({ id: "I7", taskId: task.taskId, detail: `Task names ${task.robotId}, Leg was settled by ${last.agentId}` });
      }
    }
  }

  // I8 — over the whole run, no two commitments on one Leg were ever live at the same time.
  // I1 sees only the end state; this sees a duplicate that was later released.
  for (const [legId, rows] of group(commitments.filter((row) => row.grantedAt), "legId")) {
    const ordered = [...rows].sort((a, b) => new Date(a.grantedAt) - new Date(b.grantedAt));
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const releasedAtMs = previous.releasedAt ? new Date(previous.releasedAt).getTime() : Infinity;
      if (new Date(ordered[index].grantedAt).getTime() < releasedAtMs) {
        violations.push({
          id: "I8",
          legId,
          detail: `${ordered[index].agentId} was committed while ${previous.agentId} still held the Leg`,
        });
      }
    }
  }

  // I6 — a live commitment must sit on a Leg that is actually being executed.
  for (const row of live) {
    const leg = legs.get(row.legId);
    if (!leg || !EXECUTING_STATES.includes(leg.state)) {
      violations.push({ id: "I6", commitmentId: row.commitmentId, legId: row.legId, detail: `live commitment on a ${leg ? leg.state : "missing"} Leg` });
    }
  }

  return { ok: violations.length === 0, violations, outcomes };
}

/**
 * Counts for the report: reasons, per agent × Leg, from the observers.
 *
 * @param {object} input `{ gateVerdicts, expansionRefusals, events, commitments, outcomes }`
 * @returns {object}
 */
function summarise(input) {
  const source = input || {};
  const verdicts = source.gateVerdicts || [];
  const pairs = new Map();
  for (const row of verdicts) pairs.set(`${row.agentId}|${row.legId}`, row);
  const rejectedByPredicate = {};
  for (const row of pairs.values()) {
    if (row.feasible) continue;
    for (const denial of row.denials || []) rejectedByPredicate[denial.id] = (rejectedByPredicate[denial.id] || 0) + 1;
  }
  const refusedBeforeGate = {};
  const refusalPairs = new Map();
  for (const row of source.expansionRefusals || []) refusalPairs.set(`${row.agentId}|${row.legId}`, row);
  for (const row of refusalPairs.values()) refusedBeforeGate[row.refusal] = (refusedBeforeGate[row.refusal] || 0) + 1;

  const events = source.events || {};
  const outcomes = Object.values(source.outcomes || {});
  const count = (value) => outcomes.filter((row) => row === value).length;
  const agentsUsed = new Set((source.commitments || []).map((row) => row.agentId));

  return {
    tasks: outcomes.length,
    completed: count("COMPLETED"),
    inFlight: count("IN_FLIGHT"),
    waiting: count("WAITING"),
    recovering: count("RECOVERING"),
    failed: count("FAILED"),
    lost: count("LOST"),
    gateEvaluations: verdicts.length,
    candidatePairs: pairs.size,
    feasiblePairs: [...pairs.values()].filter((row) => row.feasible).length,
    rejectedPairs: [...pairs.values()].filter((row) => !row.feasible).length,
    rejectedByPredicate,
    refusedBeforeGate,
    commitments: (source.commitments || []).length,
    agentsUsed: agentsUsed.size,
    offersDelivered: events.OFFER || 0,
    accepts: events.OFFER_ACCEPT || 0,
    rejects: events.OFFER_REJECT || 0,
    defers: events.OFFER_DEFER || 0,
    withdraws: events.WITHDRAW || 0,
    custodyEvents: events.CUSTODY_EVENT || 0,
    completionsReported: events.TASK_COMPLETE || 0,
  };
}

module.exports = {
  EXECUTING_STATES,
  WAITING_STATES,
  RECOVERY_STATES,
  LIVE_QUEUE_STATES,
  TERMINAL_FAILED_STATES,
  classifyTask,
  checkInvariants,
  summarise,
};

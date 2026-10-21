const asyncHandler = require("../utils/asyncHandler");
const { getPrisma } = require("../db/prisma");
const taskService = require("../services/task.service");
const { toStringOrNull } = require("../utils/parse");
const { dispatchStop } = require("../services/commandDispatcher.service");
const { updateAssignedTask, updatePlannedPath } = require("../services/robotRegistry.service");
// PHASE 14 — §23.6. The waiver decision and the register that supplies each predicate's
// §7.2 class. Imported here rather than duplicated: the class of a predicate is the
// feasibility register's fact, and a second copy of it in a controller is a second copy
// that can disagree about whether something is class I.
const override = require("../engine/security/override");
const feasibilityRegister = require("../engine/feasibility/register");
// PHASE 14 remediation (P14-R3 / P14-R5) — the same policy and the same audit writer the
// action-class middleware uses. Two policies, or two audit shapes, is how a route gate and
// a controller come to disagree about who may waive what.
const { policyFor, recordAuthorisation, configValue, verifySecondApprover } = require("../middlewares/auth_middleware");
const taskCancellation = require("../services/taskCancellation.service");
const { RELEASABLE_STATUSES } = require("../services/taskCompletion.service");
// RBAC — the caller's campus scope.
const accessScope = require("../services/accessScope.service");
// RBAC — dashboard broadcasts go through one place, which scopes them by campus.
const dashboardBroadcast = require("../sockets/dashboardBroadcast");

function scopeOf(req) {
  return req.access ?? accessScope.accessScopeFor(req.user);
}

/**
 * The operating region a submission goes to. A SUPER_ADMIN names it (body, then query), as
 * before. An ADMIN's is its campus's region, read from its own account: a body or query that
 * names another region or a shard is refused rather than quietly rewritten, and a campus with
 * no operating region cannot submit at all.
 *
 * @returns {{ regionId: string|null, shardId: string|null }}
 */
function submissionTargetFor(req) {
  const scope = scopeOf(req);
  const requestedRegion = toStringOrNull(req.body?.regionId) || toStringOrNull(req.query?.regionId);
  const requestedShard = toStringOrNull(req.body?.shardId);
  if (accessScope.isSuperAdmin(scope)) return { regionId: requestedRegion, shardId: requestedShard };

  const refuse = (status, code, message) => {
    const err = new Error(message);
    err.status = status;
    err.code = code;
    return err;
  };
  if (!scope.regionKey) {
    throw refuse(409, "CAMPUS_HAS_NO_REGION", `Campus ${scope.campusCode} has no operating region linked, so it cannot accept tasks yet.`);
  }
  if (requestedRegion && requestedRegion !== scope.regionKey) {
    throw refuse(403, "OUT_OF_SCOPE", "A campus administrator submits tasks only to its own campus's operating region.");
  }
  if (requestedShard) {
    throw refuse(403, "OUT_OF_SCOPE", "A campus administrator may not choose a shard; its campus's region decides it.");
  }
  return { regionId: scope.regionKey, shardId: null };
}

/**
 * PHASE 15 — the API version this controller answers under.
 *
 * The plan requires an "API version note published to consumers"; a version that only
 * exists in a document is one a consumer never sees. It travels on the response.
 */
const API_VERSION = "2026-08-15";

/** What the note says, in one sentence, wherever it is surfaced. */
const SUPERSESSION_NOTE =
  "POST /api/tasks/assign now acknowledges rather than decides (§3.4). The assignment is made by the " +
  "next round, so the response carries a queue position and a predicted window under `intake`; " +
  "`task.status` is PENDING and `task.robotId` is null on every successful call. The legacy fields are " +
  "retained for the Phase 15 retention window and then removed.";

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
    // RBAC — only the caller's campus for an ADMIN (`accessScope.taskWhere`).
    where: accessScope.within(where, accessScope.taskWhere(scopeOf(req))),
    include: {
      robot: { select: { robotId: true } },
    },
    orderBy: [{ createdAt: "desc" }],
    take: 250,
  });

  res.json({ ok: true, tasks });
});

// POST /api/tasks/assign
//
// ── PHASE 10 — §3.4's response contract ─────────────────────────────────────
//
// > `Intake API` validates, checks admission and quota, resolves the shard, writes the
// > Leg into the durable work queue, and returns an accepted response carrying the task
// > id, an idempotency echo, the queue position, and an **honest predicted assignment
// > window**. **The response MUST NOT imply an assignment has occurred.**
//
// The change is **additive**. `{ ok, task }` is unchanged for every existing consumer;
// `intake` arrives beside it when the engine's request path ran, carrying the four §3.4
// fields plus the `accepted`/`assigned` pair that makes the distinction unmissable. Phase
// 15 is where the plan formally supersedes the legacy contract and publishes the API
// version note to consumers — doing it here would break the Frontend five phases before
// the window in which the plan schedules its update.
//
// An intake **decline** (§20.5) is a real outcome, not an error: the caller is told
// immediately, with a reason it can act on, rather than being handed a PENDING row that
// will never be served. It is surfaced as HTTP 429 for a quota or shed decision — the
// status whose semantics are "retry later", which is exactly true — and the honest
// sentence travels in the body.
const assignTask = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const kv = req.app?.locals?.kv;
  const io = req.app?.locals?.io;

  // ── PHASE 14 — §23.6 / §7.2, the waiver decision ───────────────────────────
  //
  // The route gate (`tasks.routes.js`) authorises the *action class*; this authorises
  // the *specific predicate*, which is the part §23.6 requires to name a predicate and
  // §7.2 makes absolute for classes I, R and F. The predicate's class comes from the
  // feasibility register, so a caller cannot obtain a waiver by declaring a class of
  // their own.
  //
  // §7.2's own sentence for why this exists: "The operator's power is to choose *which*
  // agent, never to make an infeasible agent feasible."
  const waived = toStringOrNull(req.body?.waivePredicate);
  if (waived) {
    const entry = feasibilityRegister.predicate(waived.toUpperCase());
    const waiverRequest = {
      predicateId: waived.toUpperCase(),
      // An unknown predicate id resolves to no class, and `authoriseWaiver` refuses an
      // unknown class outright: unknown is never permission (T2).
      constraintClass: entry ? entry.constraintClass : null,
      actorId: req.user?.id ?? null,
      actorRole: req.user?.role ?? null,
      reason: toStringOrNull(req.body?.reason),
      secondApproverId: toStringOrNull(req.body?.secondApproverId),
    };
    const waiverSubject = { subjectType: "TASK", subjectId: toStringOrNull(req.body?.taskId) };

    // PHASE 14 remediation (P14-R3) — the **real** policy, not `{ elevatedRoles: [] }`.
    //
    // The literal empty list was a deliberate "the route gate already checked the role",
    // which was true only while the route gate always fired. It did not (P14-R4), and an
    // empty list meant "every role is elevated" rather than "none is" (P14-R3), so the two
    // defects composed into a class-P waiver granted to any authenticated caller. Reading
    // the same `policyFor(req)` the middleware reads means the two can never disagree.
    const policy = policyFor(req);
    let decision = override.authoriseWaiver(waiverRequest, policy, waiverSubject);

    // A class C waiver's second approver is an account, not a string: `authoriseWaiver` sees only
    // the identity (present, distinct from the caller), and the route gate's action class requires
    // no second approver by default, so this is the one place it is resolved — by the gate's own
    // check (`verifySecondApprover`). It establishes that the account exists and holds an admitted
    // role; it does not, and cannot, establish that its holder consented. Fails closed when the
    // account cannot be read.
    if (decision.granted && override.waiverRequiresSecondApprover(waiverRequest.constraintClass)) {
      const approval = await verifySecondApprover(waiverRequest, policy);
      if (!approval.granted) decision = { ...approval, waivedPredicate: null };
    }

    // PHASE 14 remediation (P14-R5) — §23.6: "Every override is audited and counted."
    //
    // Granted **and** refused, and with the predicate and its class on the row: this is
    // the only writer that populates `OverrideAudit.predicateId` / `constraintClass`, and
    // without it §23.6's per-predicate override rate had no data source at all — the
    // monitoring half of the rule was reading an empty table by construction.
    await recordAuthorisation(req, decision, waiverRequest, waiverSubject);

    if (!decision.granted) {
      // 503 only when the approver could not be verified (an outage, not a decision); every
      // decided refusal stays 403, as before.
      res.status(decision.refusal === override.REFUSAL.SECOND_APPROVER_UNVERIFIABLE ? 503 : 403).json({
        ok: false,
        error: "Forbidden",
        refusal: decision.refusal,
        detail: decision.detail,
        predicateId: waived.toUpperCase(),
        constraintClass: entry ? entry.constraintClass : null,
        note:
          "manual assignment sets the candidate set to a single agent and runs the identical feasibility gate. " +
          "The operator's power is to choose which agent, never to make an infeasible agent feasible (§7.2).",
      });
      return;
    }
  }
  // ── PHASE 15 — the §3.4 contract formally supersedes the legacy response ──
  //
  // > **REST API changes** — Legacy `POST /api/tasks/assign` response contract formally
  // > superseded by the §3.4 contract; API version note published to consumers.
  //
  // The supersession is announced on the wire rather than only in a document. Every
  // response now carries `X-RobotX-API-Version` and, while the legacy fields are still
  // present, a `Deprecation`/`Sunset` pair naming what replaces them. A consumer that
  // never reads the runbook still finds out, in the response, that `task.robotId` is not
  // going to be populated by this endpoint any more — because the assignment happens in a
  // round after the request returns, which is §3.4's whole point:
  //
  // > The request path acknowledges; it does not decide. … an honest predicted assignment
  // > window that does not imply an assignment has occurred.
  res.set("X-RobotX-API-Version", API_VERSION);
  res.set("Deprecation", "true");
  res.set("Link", `<${SUPERSESSION_NOTE}>; rel="deprecation"`);

  const target = submissionTargetFor(req);
  const created = await taskService.assignTask(prisma, req.body, {
    kv,
    io,
    config: req.app?.locals?.config || null,
    regionId: target.regionId,
    shardId: target.shardId,
    idempotencyKey: toStringOrNull(req.get?.("Idempotency-Key")),
  });

  // RBAC — an Idempotency-Key is global (`intake.idempotencyKeyFor`), so a repeated key answers
  // with the task first accepted under it, whichever campus submitted that. An ADMIN is shown
  // it only when it is in its own scope; otherwise the key is refused and no task is named.
  if (!accessScope.isSuperAdmin(scopeOf(req)) && created?.taskId && created.persisted !== false) {
    try {
      await accessScope.taskInScopeOrThrow(prisma, scopeOf(req), String(created.taskId));
    } catch (error) {
      if (error.status !== 404) throw error;
      res.status(409).json({ ok: false, code: "IDEMPOTENCY_KEY_CONFLICT", error: "This Idempotency-Key has already been used. Submit again with a new key." });
      return;
    }
  }

  const admitted = created?.intake;
  if (admitted && admitted.accepted === false) {
    res.status(admitted.outcome === "INVALID" ? 400 : 429).json({
      ok: false,
      task: created,
      intake: admitted,
      error: admitted.sentence || admitted.reason,
    });
    return;
  }

  res.json({
    ok: true,
    // The §3.4 contract, first, because it is now the contract.
    intake: admitted,
    apiVersion: API_VERSION,
    // Retained through the retention window so an unmigrated consumer reads a task row
    // rather than a 500. `status` is `PENDING` and `robotId` is null by construction: the
    // decision has not been taken yet, and a response that implied otherwise would be the
    // §3.4 dishonesty the contract exists to remove.
    task: created,
    ...(created?.ignoredFields?.length ? { ignoredFields: created.ignoredFields } : {}),
    supersededContract: {
      note: SUPERSESSION_NOTE,
      removedAfter: "the Phase 15 retention window; see docs/runbooks/cutover.md",
      replacement: "the `intake` object — §3.4's task id, idempotency echo, queue position, and predicted window",
    },
  });
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

  // Read-compatibility with the §4.2 Task state machine (Phase 2).
  //
  // `TaskStatus` now carries both vocabularies: the six legacy values and the
  // eleven §4.2 states. §4.2 names four terminal states — REJECTED, COMPLETED,
  // CANCELLED, FAILED — and REJECTED ("failed validation or admission") is the one
  // with no legacy equivalent. Without it here, a cancel request against a REJECTED
  // task would write CANCELLED over a terminal state, which is precisely the
  // unconditional write §4.1 rule 2 exists to prohibit.
  //
  // Behaviour for every value this controller could previously see is unchanged.
  const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED", "REJECTED"]);
  if (terminal.has(task.status)) {
    res.json({ ok: true, task: await prisma.task.findUnique({ where: { taskId }, include: { robot: { select: { robotId: true } } } }) });
    return;
  }

  // P1.4 — a task the assignment engine manages (it has a Leg) is not cancelled by writing
  // `Task.status`. The engine never reads that column: measured live, two tasks cancelled
  // here were still committed, delivered, verified SUFFICIENT and SETTLED while the
  // dashboard showed them CANCELLED. §4.6's cancellation (`lifecycle/cancellation.js`) is
  // the only lawful path. Phase 6 gives it its one immediate case — every open Leg QUEUED,
  // custody NONE, no HARD commitment: `CANCELLED` immediately — run by
  // `taskCancellation.service` in one transaction. Every other Leg state is still refused
  // with nothing written, as before.
  const engineLeg = await prisma.leg.findFirst({
    where: { mission: { tasks: { some: { id: task.id } } } },
    select: { state: true },
  });
  if (engineLeg) {
    const missions = await prisma.mission.findMany({
      where: { tasks: { some: { id: task.id } } },
      select: { id: true },
    });
    const elevatedRoles = configValue(req, "security.elevated_roles", ["SUPER_ADMIN"]);
    try {
      const outcome = await taskCancellation.cancelQueuedTask(prisma, {
        taskRowId: task.id,
        taskId,
        missionIds: missions.map((m) => m.id),
        actor: { id: req.user?.id ?? null, role: req.user?.role ?? null },
        // §4.6 step 5 — authority against the requester's scope. The route is authenticated;
        // the role must be one the register names as elevated (the same list §23.4 uses).
        authorised: Array.isArray(elevatedRoles) && elevatedRoles.includes(req.user?.role),
        storeTime: new Date(),
        reason: toStringOrNull(req.body?.reason) || "OPERATOR_CANCELLATION",
        // P7-D4 Part 3 — the bound an exhausted REASSIGNING Leg is proven against; unresolved
        // here, the exit refuses (503 CHAIN_BOUND_UNRESOLVED) rather than guessing one.
        maxReassignmentsPerLeg: configValue(req, "recover.max_reassignments_per_leg", null),
      });
      const releasedRobotId = outcome.outcome === "CANCELLED" && outcome.robotUnbound ? outcome.releasedRobotId : null;
      if (releasedRobotId) {
        try {
          // The route caches the stood-down unit's map drew from — as `publishStandDown` clears them.
          await Promise.all([kv?.del?.(`taskPath:${taskId}`), kv?.del?.(`robotTaskState:${releasedRobotId}`)]);
        } catch {
          // best effort, as when they are written
        }
      }
      if (outcome.outcome === "CANCELLED") {
        try {
          dashboardBroadcast.emit(io, "TASK_UPDATED", {
            taskId,
            status: "CANCELLED",
            robotId: null,
            ...(releasedRobotId ? { releasedRobotId } : {}),
            timestamp: Date.now(),
          });
        } catch {
          // visibility only; the cancellation is committed
        }
      }
      res.json({
        ok: true,
        task: await prisma.task.findUnique({ where: { taskId }, include: { robot: { select: { robotId: true } } } }),
        ...(outcome.outcome === "CANCELLED"
          ? {
              cancellation: {
                resolution: "CANCELLED_IMMEDIATELY",
                legs: outcome.legs,
                ...(outcome.operatorExit
                  ? { operatorExit: outcome.operatorExit, releasedRobotId: outcome.releasedRobotId, robotUnbound: outcome.robotUnbound }
                  : {}),
              },
            }
          : {}),
      });
    } catch (error) {
      if (!(error instanceof taskCancellation.CancellationRefused)) throw error;
      // A concurrent duplicate request that won: the task is cancelled, which is what this one
      // asked for — answered like the terminal case above (idempotent).
      if (error.code === "LEG_MOVED" || error.code === "TASK_MOVED") {
        const now = await prisma.task.findUnique({ where: { taskId }, include: { robot: { select: { robotId: true } } } });
        if (now && now.status === "CANCELLED") {
          res.json({ ok: true, task: now });
          return;
        }
      }
      // `message` is what the dashboard's request client shows the operator.
      res.status(error.status).json({ ok: false, code: error.code, error: error.message, message: error.message });
    }
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
          data: { currentTaskId: null },
        });
        // P7 A3 — back to IDLE only from a status already at IDLE's health tier, as a completion
        // releases (F1, `RELEASABLE_STATUSES`). An IDLE written over PAUSED (an operator hold),
        // ERROR, ISSUES or OFFLINE would make a unit the server holds out of service assignable
        // again (§23.5). Conditional in the database, so a fault committed after the read above
        // is kept.
        await tx.robot.updateMany({
          where: { id: robot.id, status: { in: RELEASABLE_STATUSES } },
          data: { status: "IDLE" },
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
      dashboardBroadcast.emit(io, "TASK_UPDATED", {
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

  // F3 — a task the assignment engine manages (it has a Leg) is not rerouted here. This
  // service writes a fresh Mapbox (or straight-line) path over `taskPath:*`, resets
  // `robotTaskState:*`, redraws the dashboard route and sends the robot `REROUTE_ALERT`, while
  // the engine's PRICED_ROUTE and the OFFER it signed are unchanged — so the priced, driven and
  // drawn routes part, and completion is graded against a corridor the robot was moved off.
  // Refused and nothing written, as P1.4 refuses the legacy cancel. An unknown task falls
  // through to the service's own 404, as before.
  const task = await prisma.task.findUnique({ where: { taskId }, select: { id: true } });
  const engineLeg = task
    ? await prisma.leg.findFirst({ where: { mission: { tasks: { some: { id: task.id } } } }, select: { state: true } })
    : null;
  if (engineLeg) {
    const message =
      `Task ${taskId} is managed by the assignment engine (Leg ${engineLeg.state}); rerouting it is not ` +
      "available in V1, and nothing was changed.";
    // `message` is what the dashboard's request client shows the operator.
    res.status(409).json({ ok: false, code: "ENGINE_REROUTE_UNAVAILABLE", error: message, message });
    return;
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

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
const { policyFor, recordAuthorisation } = require("../middlewares/auth_middleware");

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
    const decision = override.authoriseWaiver(waiverRequest, policyFor(req), waiverSubject);

    // PHASE 14 remediation (P14-R5) — §23.6: "Every override is audited and counted."
    //
    // Granted **and** refused, and with the predicate and its class on the row: this is
    // the only writer that populates `OverrideAudit.predicateId` / `constraintClass`, and
    // without it §23.6's per-predicate override rate had no data source at all — the
    // monitoring half of the rule was reading an empty table by construction.
    await recordAuthorisation(req, decision, waiverRequest, waiverSubject);

    if (!decision.granted) {
      res.status(403).json({
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

  const created = await taskService.assignTask(prisma, req.body, {
    kv,
    io,
    config: req.app?.locals?.config || null,
    regionId: toStringOrNull(req.body?.regionId) || toStringOrNull(req.query?.regionId),
    shardId: toStringOrNull(req.body?.shardId),
    idempotencyKey: toStringOrNull(req.get?.("Idempotency-Key")),
  });

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
  // the only lawful path and has no resolution for any Leg state yet, so this refuses and
  // writes nothing rather than report a cancellation that did not happen.
  const engineLeg = await prisma.leg.findFirst({
    where: { mission: { tasks: { some: { id: task.id } } } },
    select: { state: true },
  });
  if (engineLeg) {
    const message =
      `Task ${taskId} is managed by the assignment engine (Leg ${engineLeg.state}); cancelling it is not ` +
      "available in V1, and nothing was changed.";
    // `message` is what the dashboard's request client shows the operator.
    res.status(409).json({ ok: false, code: "ENGINE_CANCELLATION_UNAVAILABLE", error: message, message });
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
          data: { currentTaskId: null, status: "IDLE" },
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
      io?.to("dashboard")?.emit("TASK_UPDATED", {
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

/**
 * DTARO Socket Handler
 *
 * Handles robot-initiated DTARO events that are not part of the
 * core telemetry or auth pipeline:
 *
 *   OBSTACLE_REPORT  — robot detected an obstacle; triggers EKB + dissemination
 *   TASK_COMPLETE    — real robot signals task completion
 *   ROBOT_FAULT      — robot reports a hardware fault
 *
 * Each handler rate-limits, validates, and delegates to the appropriate service.
 */

const { toStringOrNull } = require("../../utils/parse");
const { allow } = require("../rateLimit");
// PHASE 15 remediation (D-6) — both halves of the cutover switch, from the module that
// owns the question. Grading a completion claim writes a durable evidence row and can
// divert a Task to VERIFYING, so it is a per-shard decision like every other engine path.
const agentGate = require("../../engine/cutover/agentGate");
const { processObstacleReport } = require("../../services/alertDissemination.service");
const { updateHealthStatus, updateAssignedTask } = require("../../services/robotRegistry.service");
const { z } = require("zod");
const robotStateCache = require("../../cache/robotStateCache");
// PHASE 5 (§12.5) — graded completion verification.
const verification = require("../../engine/supervision/verification");
// PHASE 14 remediation (P14-R14) — §23.5 row 3, the completion trust boundary.
const trustBoundaries = require("../../engine/security/trustBoundaries");
// PHASE 12 (§18.2) — the agent failure catalogue. A fault report becomes a *classified*
// failure with a defined response and escalation, rather than a status change and a log line.
const agentFailures = require("../../engine/failure/agentFailures");
const catalogue = require("../../engine/failure/catalogue");

/**
 * Resolve the identifier an agent reported completion under to a `Task.taskId`.
 *
 * ── Why this exists at all ──────────────────────────────────────────────────
 * A `Leg` is the unit of assignment and a `Task` is the unit of customer-visible work
 * (§2.4); the two have different identifiers and this handler matches on the second. The
 * offer now carries `taskId` for exactly that reason, so an agent on the current contract
 * reports a Task id and this function returns it unchanged on the first branch.
 *
 * The second branch is for an agent that predates that field, or firmware built against an
 * older envelope: it reported the `Leg` it was offered, which matches no Task row, and the
 * completion silently did nothing — `updateMany` matched zero rows, the Task stayed
 * `ASSIGNED` forever and the robot stayed bound to it. Resolving through the Mission is the
 * relationship §2.8 already draws (`Task >──< Mission >──< Leg`); no parallel completion
 * path and no new column.
 *
 * Ambiguity is refused rather than guessed. A Leg discharging two Tasks has no single Task
 * this completion is about, and closing an arbitrary one would report a delivery that did
 * not happen.
 *
 * @param {object} prisma
 * @param {string|null} reported
 * @returns {Promise<{ taskId: string|null, resolvedFrom: string }>}
 */
async function resolveCompletedTaskId(prisma, reported) {
  if (!reported) return { taskId: null, resolvedFrom: "ABSENT" };

  const direct = await prisma.task.findUnique({ where: { taskId: reported }, select: { taskId: true } });
  if (direct) return { taskId: direct.taskId, resolvedFrom: "TASK_ID" };

  // Not a Task. It may be the Leg the agent was offered, under either of its identifiers —
  // `Leg.legId` is the business key and `Leg.id` is what the commitment row points at.
  const leg = await prisma.leg.findFirst({
    where: { OR: [{ legId: reported }, { id: reported }] },
    select: { mission: { select: { tasks: { select: { taskId: true } } } } },
  });

  const tasks = (leg && leg.mission && leg.mission.tasks) || [];
  if (tasks.length === 1) return { taskId: tasks[0].taskId, resolvedFrom: "LEG_VIA_MISSION" };
  if (tasks.length > 1) return { taskId: null, resolvedFrom: "LEG_DISCHARGES_SEVERAL_TASKS" };

  return { taskId: null, resolvedFrom: "UNRESOLVED" };
}

const obstacleSchema = z.object({
  lat: z.number(),
  lon: z.number(),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional().default("MEDIUM"),
});

const faultSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
  sensor: z.string().optional(),
  // PHASE 12 (§18.2) — the one bit that separates A5 from A6. Optional, and its *absence*
  // classifies as blocking: §18.2's two rows differ in whether the mission continues, and
  // an agent that does not say resolves to the row that stops it (§7.3's DENY reading).
  blocking: z.boolean().optional(),
});

/**
 * Register DTARO-specific socket event handlers.
 *
 * @param {object} io
 * @param {object} socket
 * @param {{ prisma: object, kv: object, logger: object }} deps
 */
function registerDtaroHandlers(io, socket, { prisma, kv, logger, appLocals }) {
  const log = logger || console;

  // PHASE 14 remediation (P14-R1 / P14-R14) — the pinned configuration snapshot, for
  // §23.5's completion row. See `robot.handler.js` for why `socket.request.app` is not a
  // route to it.
  const configOf = () => appLocals?.config ?? socket?.request?.app?.locals?.config ?? null;

  // ─── OBSTACLE_REPORT ────────────────────────────────────────────────────────
  socket.on("OBSTACLE_REPORT", async (payload) => {
    try {
      if (!allow(socket, "OBSTACLE_REPORT", { limit: 10, windowMs: 60_000, minIntervalMs: 500 })) return;

      const robotId = toStringOrNull(socket.data.robotId);
      if (!robotId) {
        socket.emit("ERROR", { event: "OBSTACLE_REPORT", reason: "Not authenticated" });
        return;
      }

      const parsed = obstacleSchema.safeParse(payload || {});
      if (!parsed.success) {
        socket.emit("ERROR", { event: "OBSTACLE_REPORT", reason: "Invalid payload", details: parsed.error.issues });
        return;
      }

      const { lat, lon, severity } = parsed.data;

      log.info("OBSTACLE_REPORT received", { robotId, lat, lon, severity });

      const result = await processObstacleReport(prisma, kv, io, {
        lat,
        lon,
        severity,
        reportingRobotId: robotId,
      });

      socket.emit("OBSTACLE_REPORT_ACK", {
        obstacleId: result.obstacle.obstacleId,
        affectedRobots: result.affectedRobotIds.length,
        timestamp: result.obstacle.timestamp,
      });
    } catch (e) {
      log.error("OBSTACLE_REPORT handler failed", e);
    }
  });

  // ─── TASK_COMPLETE ───────────────────────────────────────────────────────────
  socket.on("TASK_COMPLETE", async (payload) => {
    try {
      if (!allow(socket, "TASK_COMPLETE", { limit: 5, windowMs: 30_000, minIntervalMs: 1000 })) return;

      const robotId = toStringOrNull(socket.data.robotId);
      if (!robotId) return;

      const reportedId = toStringOrNull(payload?.taskId);
      // §2.4 — the agent may report the Leg it was offered rather than the Task the work
      // belongs to. Resolved here, through the relationship §2.8 already draws, so a
      // completion is never silently applied to zero rows.
      const resolved = await resolveCompletedTaskId(prisma, reportedId);
      const taskId = resolved.taskId;

      log.info("TASK_COMPLETE received", { robotId, reportedId, taskId, resolvedFrom: resolved.resolvedFrom });

      if (reportedId && taskId === null) {
        // Named and unresolvable. Reported rather than swallowed: before this, the
        // `updateMany` below matched nothing and the handler went on to release the robot,
        // leaving a Task that no component would ever close and no record of why.
        log.error("TASK_COMPLETE names an identifier that resolves to no single Task", {
          robotId,
          reportedId,
          resolvedFrom: resolved.resolvedFrom,
        });
      }

      // PHASE 5 (§12.5) — the verification pipeline.
      //
      // > The audit notes the baseline accepts completion purely on the agent's
      // > assertion, with no geometric or evidentiary check.
      //
      // The legacy path below **is** that assertion, and it stays exactly as it was
      // until the Phase 15 cutover — a legacy Task completed by a legacy robot must
      // still complete. What is added is the graded check running alongside it: with
      // `ENGINE_ENABLED` false it does nothing, and with it true a completion claim is
      // graded, its evidence archived, and an insufficient one sends the Task to
      // `VERIFYING` rather than to `COMPLETED`.
      const verdict = await verifyCompletionClaim({ prisma, log, robotId, taskId, payload, config: configOf(), socket });

      // ── PHASE 14 remediation (P14-R14) — §23.5 row 3, composed ──────────────
      //
      // The plan's Phase 14 testing requirements name this outcome directly: *"a
      // completion claim from a kinematically unreachable position is rejected and
      // **raises a security event**"*. `trustBoundaries.validateCompletion()` implements
      // it and was unit-tested; until this remediation it had **no production caller**, so
      // no completion claim the fleet ever made could raise that event.
      //
      // §23.5's own argument for why this is a security control and not a data-quality
      // one: a completion claim from a place the agent could not have reached is not a
      // failed verification, it is evidence of a compromised or spoofing device.
      if (verdict && verdict.security && verdict.security.securityEvent) {
        log.error?.("SECURITY: completion claimed from an unreachable position (§23.5)", {
          robotId,
          taskId,
          reasons: verdict.security.reasons,
        });
        io.to("dashboard").emit("SECURITY_EVENT", {
          kind: "UNREACHABLE_COMPLETION_CLAIM",
          robotId,
          taskId,
          reasons: verdict.security.reasons,
          timestamp: Date.now(),
        });
      }

      if (verdict && verdict.outcome === verification.OUTCOME.INSUFFICIENT) {
        // "Insufficient evidence sends the Task to `VERIFYING` with an operator queue —
        // not to `COMPLETED`, and not to `FAILED`. Both of those are lies about the
        // physical state." So the legacy completion below is *not* performed.
        io.to("dashboard").emit("TASK_UPDATED", {
          robotId,
          taskId,
          status: "VERIFYING",
          verification: { failures: verdict.failures, achievedLevel: verdict.achievedLevel },
          timestamp: Date.now(),
        });
        socket.emit("TASK_COMPLETE_ACK", { taskId, verifying: true, timestamp: Date.now() });
        return;
      }

      await prisma.$transaction(async (tx) => {
        // Mark task COMPLETED if it belongs to this robot and isn't already done
        if (taskId) {
          await tx.task.updateMany({
            where: {
              taskId,
              robot: { robotId },
              status: { in: ["ASSIGNED", "IN_PROGRESS"] },
            },
            data: { status: "COMPLETED", completedAt: new Date() },
          });
        }

        // Release robot back to IDLE
        await tx.robot.update({
          where: { robotId },
          data: { currentTaskId: null, status: "IDLE", speed: 0 },
        });
      });

      robotStateCache.set(robotId, { status: "IDLE" });

      // Clear Redis task state
      if (kv && taskId) {
        await Promise.allSettled([
          kv.del(`robotTaskState:${robotId}`),
          kv.del(`robotTask:${robotId}`),
        ]);
      }

      // Update registry
      await updateAssignedTask(kv, robotId, null);

      // Notify dashboard
      io.to("dashboard").emit("TASK_UPDATED", {
        robotId,
        taskId,
        status: "COMPLETED",
        timestamp: Date.now(),
      });

      socket.emit("TASK_COMPLETE_ACK", { taskId, timestamp: Date.now() });
    } catch (e) {
      log.error("TASK_COMPLETE handler failed", e);
    }
  });

  // ─── ROBOT_FAULT ─────────────────────────────────────────────────────────────
  socket.on("ROBOT_FAULT", async (payload) => {
    try {
      if (!allow(socket, "ROBOT_FAULT", { limit: 5, windowMs: 60_000, minIntervalMs: 1000 })) return;

      const robotId = toStringOrNull(socket.data.robotId);
      if (!robotId) return;

      const parsed = faultSchema.safeParse(payload || {});
      const faultData = parsed.success ? parsed.data : {};
      const { code = "UNKNOWN", message = "Unspecified fault", sensor = null } = faultData;

      // PHASE 12 (§18.2) — classify the fault against the catalogue before anything else.
      //
      // > 2. **Every failure has a defined automatic response and a defined escalation.**
      // >    Undefined behaviour under failure is a design defect, not an operational
      // >    surprise.
      //
      // The legacy handling below is unchanged and still runs: a real robot reporting a
      // fault must still reach ERROR, still raise its Event row, and still reach the
      // dashboard, exactly as it did before, until the Phase 15 cutover. What is added is
      // the classification alongside it — the fault is placed on an A-row, and that row's
      // response, escalation, and custody-awareness are carried in the log and out to the
      // dashboard rather than being re-derived by whoever reads the alert.
      //
      // Blocking versus non-blocking is the one distinction the catalogue makes that the
      // payload can carry: §18.2 A5 is a fault that stops the mission and A6 is a
      // degradation that does not. An unspecified fault classifies as **A5**, the blocking
      // one, under the same DENY reading §7.3 gives an unknown: the cost of treating a
      // degradation as blocking is an unnecessary maintenance ticket, and the cost of the
      // reverse is a mission continued on a robot that cannot finish it.
      const faultRowId = faultData.blocking === false ? "A6" : "A5";
      const faultRow = catalogue.lookup(faultRowId);
      const classification = {
        failureId: faultRowId,
        failure: faultRow.failure,
        detection: faultRow.detection,
        // Custody is a Leg-level fact the legacy path does not carry, so the response is
        // reported for both sides rather than guessed. §18.1 principle 3 splits A5's
        // response exactly there, and picking the wrong half is what §2.5 exists to prevent.
        response: {
          preCustody: agentFailures.responseFor(faultRowId, agentFailures.CUSTODY_PHASE.PRE_CUSTODY).response,
          postCustody: agentFailures.responseFor(faultRowId, agentFailures.CUSTODY_PHASE.POST_CUSTODY).response,
        },
        escalation: catalogue.alertingFor(faultRowId),
        autoQuarantine: faultRow.autoQuarantine === true,
      };

      log.warn("ROBOT_FAULT received", { robotId, code, message, sensor, classification });

      // Update robot status to ERROR in DB
      await prisma.robot.update({
        where: { robotId },
        data: { status: "ERROR" },
      });
      robotStateCache.set(robotId, { status: "ERROR" });

      // Update health status in registry
      await updateHealthStatus(kv, robotId, "FAULT");

      // Log fault as an Event
      try {
        const robotRow = await prisma.robot.findUnique({ where: { robotId }, select: { id: true } });
        if (robotRow) {
          await prisma.event.create({
            data: {
              robotId: robotRow.id,
              type: "CRITICAL",
              message: `Fault reported: [${code}] ${message}${sensor ? ` (sensor: ${sensor})` : ""}`,
            },
          });
        }
      } catch {
        // ignore event log failure
      }

      // Notify dashboard
      io.to("dashboard").emit("ROBOT_UPDATED", {
        robotId,
        status: "ERROR",
        healthStatus: "FAULT",
        fault: { code, message, sensor },
        // Additive: every field the pre-Phase-12 payload carried is unchanged, and the
        // classification sits beside them. An operator seeing "ERROR" learns that
        // something is wrong; one seeing "A5, blocking hardware fault, pre-custody abort
        // and reassign, maintenance ticket and auto-quarantine" learns what happens next.
        classification,
        timestamp: Date.now(),
      });

      socket.emit("ROBOT_FAULT_ACK", { timestamp: Date.now() });
    } catch (e) {
      log.error("ROBOT_FAULT handler failed", e);
    }
  });
}

/**
 * PHASE 5 (§12.5) — grade one completion claim and archive its evidence.
 *
 * ── Why the claim is graded even when the evidence is thin ──────────────────
 * §12.5 grades verification *per mission class*, and L1 — "Default for all customer
 * work" — needs a position, a stop, and a telemetry track. A real agent reporting
 * `TASK_COMPLETE` supplies the first; the second comes from the Leg's Stop; the third
 * from the Observation stream. Where the engine has no Leg for this Task — every legacy
 * Task, until Phase 15 — there is nothing to verify **against**, and the honest answer is
 * to verify nothing rather than to grade a claim against a plan that does not exist.
 * That case returns null and the legacy path proceeds unchanged.
 *
 * ── The evidence row is written whatever the outcome ────────────────────────
 * Both outcomes are archived. A `SUFFICIENT` verification with no record would leave the
 * L2 and L3 audit trail — "goods of material value", "regulated, contested" — as an
 * assertion that a check happened, which is the thing §12.5 exists to replace.
 *
 * @param {object} input
 * @returns {Promise<object|null>}
 */
async function verifyCompletionClaim({ prisma, log, robotId, taskId, payload, config, socket }) {
  // D-6: the process half alone used to gate this. During a staged rollout that graded
  // claims on every shard, including ones the staging order had not reached.
  if (!agentGate.mayAct({ socket, snapshot: config, nowMs: Date.now() })) return null;

  try {
    const agent = await prisma.agent.findUnique({ where: { agentId: robotId } });
    if (!agent) return null;

    // The Leg this claim discharges: the one this agent holds an active commitment for.
    const commitment = await prisma.commitment.findFirst({
      where: { agentId: agent.id, releasedAt: null },
      orderBy: { grantedAt: "desc" },
    });
    if (!commitment) return null;

    const leg = await prisma.leg.findUnique({ where: { id: commitment.legId } });
    if (!leg) return null;

    const stops = await prisma.stop.findMany({ where: { legId: leg.id }, orderBy: { sequence: "desc" }, take: 1 });
    const finalStop = stops[0] || null;

    // §12.5's inputs. Thresholds are the caller's to resolve from the register (§22.1);
    // absent them the graded check cannot run, and running it against invented numbers
    // would be exactly the reactive tuning §12.5 warns about.
    const thresholds = readVerificationThresholds();
    if (!thresholds) return null;

    const track = await readAcceptedTrack(prisma, agent.id, commitment.grantedAt);

    const result = verification.verify({
      requiredLevel: verification.requiredLevelFor(leg.purpose, thresholds.levelsByMissionClass),
      completionClaimed: true,
      claimedPosition:
        typeof payload?.lat === "number" && typeof payload?.lon === "number"
          ? { lat: payload.lat, lon: payload.lon }
          : track.length > 0
            ? { lat: track[track.length - 1].lat, lon: track[track.length - 1].lon }
            : null,
      stopPosition: finalStop && finalStop.lat !== null ? { lat: finalStop.lat, lon: finalStop.lon } : null,
      arrivalRadiusM: thresholds.arrivalRadiusM,
      physicalEvidence: payload?.physicalEvidence || null,
      attestation: payload?.attestation || null,
      track: {
        track,
        legDurationSeconds: (Date.now() - new Date(commitment.grantedAt).getTime()) / 1000,
        minFixRatePerMinute: thresholds.minFixRatePerMinute,
        corridor: Array.isArray(payload?.plannedCorridor) ? payload.plannedCorridor : [],
        reportedCorridors: Array.isArray(payload?.reportedCorridors) ? payload.reportedCorridors : [],
        corridorHalfWidthM: thresholds.corridorHalfWidthM,
        minCorridorFraction: thresholds.minCorridorFraction,
        maxGapSeconds: thresholds.maxGapSeconds,
        maxSpeedMs: thresholds.maxSpeedMs,
        mappedDeadZoneWindows: Array.isArray(payload?.deadZoneWindows) ? payload.deadZoneWindows : [],
      },
    });

    await prisma.verificationEvidence.create({
      data: {
        evidenceId: `${leg.legId}-${commitment.commitmentId}-${Date.now()}`,
        legId: leg.id,
        taskId: taskId || null,
        requiredLevel: result.requiredLevel,
        achievedLevel: result.achievedLevel,
        outcome: result.outcome,
        failures: [...result.failures],
        arrivalDistanceM: result.measured.arrivalDistanceM ?? null,
        trackFixCount: result.measured.fixCount ?? null,
        legDurationSeconds: result.measured.legDurationSeconds ?? null,
        fixRatePerMinute: result.measured.fixRatePerMinute ?? null,
        corridorFraction: result.measured.corridorFraction ?? null,
        maxGapSeconds: result.measured.maxGapSeconds ?? null,
        maxImpliedSpeedMs: result.measured.maxImpliedSpeedMs ?? null,
        physicalEvidence: payload?.physicalEvidence || null,
        attestation: payload?.attestation || null,
        securityEvent: result.securityEvent === true,
        observedAt: new Date(),
      },
    });

    if (result.securityEvent) {
      // §12.5 / §23.5 — a claim from a position the agent could not physically have
      // reached is not a telemetry problem. Repetition on one agent is a security signal.
      log.error("completion claim is kinematically impossible", {
        robotId,
        legId: leg.legId,
        measured: result.measured,
      });
    }

    // ── PHASE 14 remediation (P14-R14) — §23.5 row 3, decided by §23.5's own module ──
    //
    // Phase 5's `verification.verify()` already sets `securityEvent` and this function
    // already logged and persisted it. What was missing is the *§23.5* decision:
    // `trustBoundaries.validateCompletion()` combines the graded verification outcome
    // with an explicit kinematic check of the **claimed** position against the last
    // accepted fix, and it is the module the trust-boundary table binds. It had no
    // production caller at all, so §23.5's row 3 was enforced by Phase 5's rule alone and
    // the row's own module was inert.
    //
    // The ceiling comes from `thresholds.maxSpeedMs`, which this function already reads
    // for the track check, and the tolerance from `security.position_plausibility_tolerance`.
    // No number is invented here.
    const lastFix = track.length > 0 ? track[track.length - 1] : null;
    const claimed =
      typeof payload?.lat === "number" && typeof payload?.lon === "number" ? { lat: payload.lat, lon: payload.lon } : null;

    const positionCheck =
      claimed && lastFix
        ? trustBoundaries.validatePosition({
            last: { lat: lastFix.lat, lon: lastFix.lon, atMs: new Date(lastFix.at).getTime() },
            reported: { lat: claimed.lat, lon: claimed.lon, atMs: Date.now() },
            maxSpeedMps: thresholds.maxSpeedMs,
            tolerance: configValue(config, "security.position_plausibility_tolerance", undefined),
          })
        : null;

    const security = trustBoundaries.validateCompletion({ verification: result, positionCheck });

    return { ...result, security };
  } catch (e) {
    // A defect in verification must not make a completion unreportable. It must,
    // however, be loud: a silent verification failure is indistinguishable from a pass,
    // which is the property §12.5 exists to remove.
    log.error("completion verification failed", { robotId, taskId, message: e?.message });
    return null;
  }
}

/**
 * §12.5's thresholds, resolved from the environment the Phase 15 bootstrap will populate
 * from the Config Service.
 *
 * All-or-nothing on purpose. A partially resolved threshold set would grade a claim
 * against some real thresholds and some invented ones, and the resulting verdict would
 * be neither.
 *
 * @returns {object|null}
 */
function readVerificationThresholds() {
  const numbers = {
    arrivalRadiusM: Number(process.env.VERIFY_ARRIVAL_RADIUS_M),
    minFixRatePerMinute: Number(process.env.VERIFY_TRACK_MIN_FIX_RATE),
    minCorridorFraction: Number(process.env.VERIFY_TRACK_MIN_CORRIDOR_FRACTION),
    maxGapSeconds: Number(process.env.VERIFY_TRACK_MAX_GAP_SECONDS),
    corridorHalfWidthM: Number(process.env.VERIFY_CORRIDOR_HALF_WIDTH_M),
    maxSpeedMs: Number(process.env.VERIFY_MAX_SPEED_MS),
  };

  for (const value of Object.values(numbers)) {
    if (!Number.isFinite(value) || value <= 0) return null;
  }

  return { ...numbers, levelsByMissionClass: {} };
}

/**
 * The accepted position fixes for this mission, from §2.7's append-only Observation
 * record.
 *
 * "Accepted" is the operative word in §12.5's coverage test: a fix the server rejected —
 * stale, dead-reckoned beyond its budget, or failing its own plausibility — is not
 * evidence of travel, so dead-reckoned observations are excluded here rather than
 * counted and then discounted.
 */
/**
 * Read a configuration value from the process's pinned snapshot — PHASE 14 remediation
 * (P14-R14). Same shape as `robot.handler.js` and `telemetry.handler.js`, so all three
 * agent handlers resolve a registered parameter the same way.
 *
 * @param {object} config
 * @param {string} name
 * @param {*} fallback
 * @returns {*}
 */
function configValue(config, name, fallback) {
  const values = config?.values;
  const value = values instanceof Map ? values.get(name) : values?.[name];
  return value === undefined || value === null ? fallback : value;
}

async function readAcceptedTrack(prisma, agentRowId, since) {
  const observations = await prisma.observation.findMany({
    where: { agentId: agentRowId, kind: "position", observedAt: { gte: since }, deadReckoned: false },
    orderBy: { observedAt: "asc" },
  });

  return observations
    .map((observation) => ({
      at: observation.observedAt,
      lat: observation.value?.lat,
      lon: observation.value?.lon,
    }))
    .filter((fix) => typeof fix.lat === "number" && typeof fix.lon === "number");
}

module.exports = { registerDtaroHandlers, verifyCompletionClaim, resolveCompletedTaskId };

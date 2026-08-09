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
const { processObstacleReport } = require("../../services/alertDissemination.service");
const { updateHealthStatus, updateAssignedTask } = require("../../services/robotRegistry.service");
const { z } = require("zod");
const robotStateCache = require("../../cache/robotStateCache");
// PHASE 5 (§12.5) — graded completion verification.
const verification = require("../../engine/supervision/verification");
// PHASE 12 (§18.2) — the agent failure catalogue. A fault report becomes a *classified*
// failure with a defined response and escalation, rather than a status change and a log line.
const agentFailures = require("../../engine/failure/agentFailures");
const catalogue = require("../../engine/failure/catalogue");

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
function registerDtaroHandlers(io, socket, { prisma, kv, logger }) {
  const log = logger || console;

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

      const taskId = toStringOrNull(payload?.taskId);
      log.info("TASK_COMPLETE received", { robotId, taskId });

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
      const verdict = await verifyCompletionClaim({ prisma, log, robotId, taskId, payload });
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
async function verifyCompletionClaim({ prisma, log, robotId, taskId, payload }) {
  if (process.env.ENGINE_ENABLED !== "true") return null;

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

    return result;
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

module.exports = { registerDtaroHandlers, verifyCompletionClaim };

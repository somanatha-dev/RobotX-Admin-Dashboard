"use strict";

/**
 * **Leg execution progress** — the producer of §4.4's execution-phase events, which had
 * none.
 *
 * ── The gap ────────────────────────────────────────────────────────────────
 * `lifecycle/transitions` defines the whole chain after ACCEPTED, each step guarded by
 * evidence the *caller* must establish:
 *
 *   ACCEPTED        —DEPARTURE_DETECTED [motionCorroborated]→ EN_ROUTE_PICKUP
 *   EN_ROUTE_PICKUP —ARRIVAL_VERIFIED   [arrivalVerified]   → AT_PICKUP
 *   AT_PICKUP       —CUSTODY_ACQUIRED   [payloadEvidence]   → LOADED
 *   LOADED          —DEPARTURE                              → EN_ROUTE_DROP
 *   EN_ROUTE_DROP   —ARRIVAL_VERIFIED   [arrivalVerified]   → AT_DROP
 *   AT_DROP         —CUSTODY_RELEASED   [releaseEvidence]   → RELEASED
 *
 * Nothing ever raised one of those events, so an accepted Leg sat in ACCEPTED until
 * `execute.start_grace` expired and it was reassigned **while the agent was driving it**
 * (measured on the V1 demonstration path, 2026-09-23).
 *
 * ── Where each piece of evidence comes from ────────────────────────────────
 *   · **Motion and arrival: the server's own evidence.** The agent's accepted position
 *     Observations (§2.7) — the same append-only record completion verification grades.
 *     Departure is ≥ `MIN_DEPARTURE_M` of displacement since the commitment was granted;
 *     arrival is a fix within the arrival radius of the stop. Never the agent's claim.
 *   · **Custody: the agent's report, and only the agent's.** Custody is a physical handover
 *     no position can prove, so it is taken from a commitment-scoped `CUSTODY_EVENT`
 *     (commitment id + fence) and admitted only once the server has itself verified
 *     arrival at that stop. The simulator sends it when its pickup/drop dwell completes;
 *     the physical RobotX must send the same on its compartment/handover event.
 *
 * `transitions.apply` does the guarded conditional write and the §4.5 timer bookkeeping;
 * this module only establishes the evidence and names the event.
 */

const transitions = require("../engine/lifecycle/transitions");
const legMachine = require("../engine/lifecycle/legMachine");
const legEntryDeadline = require("../engine/cutover/legEntryDeadline");
const clock = require("../engine/commitment/clock");
const settlement = require("../engine/lifecycle/settlement");
// C5 — the Task's completion, reached only once the Leg is settled.
const taskCompletion = require("./taskCompletion.service");
const { haversineMeters } = require("../utils/distance");

const STATE = legMachine.LEG_STATE;
const EVENT = transitions.EVENT;

/**
 * Displacement from the position at grant that counts as a departure. Above GPS jitter
 * for a physical unit, and a simulated one moves 3 m per tick. @structural V1 declaration
 */
const MIN_DEPARTURE_M = 5;

/** The stop an arrival is judged against, per en-route state. */
const STOP_FOR_STATE = Object.freeze({
  [STATE.EN_ROUTE_PICKUP]: "PICKUP",
  [STATE.EN_ROUTE_DROP]: "DROP",
});

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * A custody report that arrived **before** the server had verified the agent at that stop,
 * held until it has — then applied, never earlier. Keyed by commitment.
 *
 * Why: an agent that starts at (or within the arrival radius of) its pickup finishes the
 * pickup dwell before the server has seen the departure and arrival the §4.4 chain requires,
 * so its one ACQUIRED report was refused as NOT_AT_THE_STOP and never repeated; the Leg then
 * sat in AT_PICKUP for the rest of the mission (measured on the V1 10-robot run, 2026-09-23).
 * Holding the report changes nothing about *when* custody is admitted — only that a report
 * the agent already sent is not lost. In-process, like the socket it arrived on: the same
 * process receives that agent's telemetry. A restart loses a held report; the mission still
 * settles on verified completion.
 */
const heldCustody = new Map();
const HOLDABLE = Object.freeze({
  ACQUIRED: Object.freeze([STATE.ACCEPTED, STATE.EN_ROUTE_PICKUP]),
  RELEASED: Object.freeze([STATE.LOADED, STATE.EN_ROUTE_DROP]),
});

/** The arrival radius: §12.5's verification radius, the one completion is graded against. */
function arrivalRadiusM() {
  const value = Number(process.env.VERIFY_ARRIVAL_RADIUS_M);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** The Leg's stop of a type, as persisted. */
function stopOfType(stops, stopType) {
  const ordered = [...(stops || [])].sort((a, b) => a.sequence - b.sequence);
  if (stopType === "PICKUP") return ordered.find((stop) => stop.stopType === "PICKUP") || ordered[0] || null;
  return [...ordered].reverse().find((stop) => stop.stopType === "DROP") || ordered[ordered.length - 1] || null;
}

function resolveParameter(snapshot, name) {
  if (!snapshot || typeof snapshot.resolve !== "function") return undefined;
  try {
    return snapshot.resolve(name, {});
  } catch {
    return undefined;
  }
}

/**
 * §4.3's **projected** deadline for an en-route state: the committed plan's ETA to that
 * stop × `execute.eta_tolerance`. The ETA is read from the OFFER this commitment signed —
 * the durable record of what the plan projected (`supervision/timers`). An agent already
 * past its ETA gets `execute.start_grace` before it is probed, never a zero deadline.
 */
async function projectedDeadlineSeconds(tx, { commitmentId, stopType, snapshot, storeTime }) {
  const tolerance = resolveParameter(snapshot, "execute.eta_tolerance");
  const floor = resolveParameter(snapshot, "execute.start_grace");
  if (!isNumber(tolerance) || tolerance <= 0 || !isNumber(floor) || floor <= 0) return undefined;
  const offer = await tx.outbox.findFirst({
    where: { commitmentId, command: "OFFER" },
    orderBy: { createdAt: "desc" },
    select: { payload: true },
  });
  const stops = offer && offer.payload && Array.isArray(offer.payload.stopSequence) ? offer.payload.stopSequence : [];
  const stop = stopOfType(stops, stopType);
  if (!stop || !isNumber(stop.projectedArrivalMs)) return undefined;
  const remainingSeconds = (stop.projectedArrivalMs - storeTime.getTime()) / 1000;
  return Math.max(remainingSeconds * tolerance, floor);
}

async function applyEvent(tx, { leg, event, context, data, snapshot, storeTime, shardId, commitmentId }) {
  const row = transitions.TRANSITIONS.find(
    (candidate) => (Array.isArray(candidate.from) ? candidate.from.includes(leg.state) : candidate.from === leg.state) && candidate.event === event,
  );
  const target = row && typeof row.to === "string" ? row.to : null;
  const spec = target ? legMachine.deadlineFor(target) : null;
  const values = snapshot && snapshot.values ? snapshot.values : null;
  const deadlineSeconds =
    spec && spec.projected === true
      ? await projectedDeadlineSeconds(tx, {
          commitmentId,
          stopType: target === STATE.EN_ROUTE_PICKUP ? "PICKUP" : "DROP",
          snapshot,
          storeTime,
        })
      : target
        ? legEntryDeadline.deadlineSecondsFrom(values, target)
        : undefined;
  return transitions.apply(tx, { leg, event, context, data, storeTime, shardId, deadlineSeconds });
}

/**
 * Advance an agent's live Leg on a new accepted position fix, where the fix is evidence.
 *
 * @param {object} input
 * @param {object} input.prisma
 * @param {string} input.agentRowId `Agent.id`
 * @param {object} input.snapshot the pinned configuration (§4.5 deadlines)
 * @param {string} [input.shardId]
 * @returns {Promise<object|null>} the transition outcome, or null when nothing applied
 */
async function onPositionFix(input) {
  const { prisma, agentRowId, snapshot, shardId, io, kv } = input || {};
  if (!prisma || !agentRowId) return null;

  const commitment = await prisma.commitment.findFirst({
    where: { agentId: agentRowId, releasedAt: null },
    orderBy: { grantedAt: "desc" },
  });
  if (!commitment) return null;

  const advanced = await advanceOnFix({ prisma, agentRowId, snapshot, shardId, commitment });
  // An arrival the server just verified admits the custody report the agent already sent.
  if (advanced && advanced.outcome === transitions.OUTCOME.APPLIED && (advanced.to === STATE.AT_PICKUP || advanced.to === STATE.AT_DROP)) {
    const custody = await applyHeldCustody({ prisma, commitmentId: commitment.commitmentId, snapshot, shardId, io, kv });
    if (custody) return { ...advanced, custody };
  }
  return advanced;
}

async function advanceOnFix({ prisma, agentRowId, snapshot, shardId, commitment }) {
  return prisma.$transaction(async (tx) => {
    const leg = await tx.leg.findUnique({ where: { id: commitment.legId }, include: { stops: true } });
    if (!leg) return null;

    const fixes = await tx.observation.findMany({
      where: { agentId: agentRowId, kind: "position", observedAt: { gte: commitment.grantedAt }, deadReckoned: false },
      orderBy: { observedAt: "asc" },
      select: { value: true },
    });
    const points = fixes.map((row) => row.value).filter((value) => value && isNumber(value.lat) && isNumber(value.lon));
    if (points.length === 0) return null;
    const latest = points[points.length - 1];
    const storeTime = await clock.readStoreTime(tx);

    if (leg.state === STATE.ACCEPTED || leg.state === STATE.LOADED) {
      // Departure: displacement since the first fix of this commitment (ACCEPTED), or from
      // the pickup stop (LOADED).
      const anchor =
        leg.state === STATE.ACCEPTED ? points[0] : (() => {
          const pickup = stopOfType(leg.stops, "PICKUP");
          return pickup && isNumber(pickup.lat) ? pickup : null;
        })();
      if (!anchor) return null;
      const moved = haversineMeters(anchor.lat, anchor.lon, latest.lat, latest.lon);
      if (leg.state === STATE.ACCEPTED && moved >= MIN_DEPARTURE_M) {
        return applyEvent(tx, { leg, event: EVENT.DEPARTURE_DETECTED, context: { motionCorroborated: true }, snapshot, storeTime, shardId, commitmentId: commitment.commitmentId });
      }
      const radius = arrivalRadiusM();
      if (leg.state === STATE.LOADED && radius !== null && moved > radius) {
        return applyEvent(tx, { leg, event: EVENT.DEPARTURE, context: {}, snapshot, storeTime, shardId, commitmentId: commitment.commitmentId });
      }
      return null;
    }

    const stopType = STOP_FOR_STATE[leg.state];
    if (stopType) {
      const stop = stopOfType(leg.stops, stopType);
      const radius = arrivalRadiusM();
      if (!stop || !isNumber(stop.lat) || !isNumber(stop.lon) || radius === null) return null;
      if (haversineMeters(stop.lat, stop.lon, latest.lat, latest.lon) <= radius) {
        return applyEvent(tx, { leg, event: EVENT.ARRIVAL_VERIFIED, context: { arrivalVerified: true }, snapshot, storeTime, shardId, commitmentId: commitment.commitmentId });
      }
    }
    return null;
  });
}

/**
 * Apply an agent's commitment-scoped custody report — admitted only at the stop the server
 * has already verified the agent reached.
 *
 * @param {object} input
 * @param {object} input.prisma
 * @param {string} input.robotId the authenticated socket's robot code
 * @param {{ commitmentId: string, fence: string|number, kind: "ACQUIRED"|"RELEASED" }} input.report
 * @param {object} input.snapshot
 * @param {string} [input.shardId]
 * @returns {Promise<object>}
 */
async function onCustodyReport(input) {
  const { prisma, robotId, report, snapshot, shardId, io, kv } = input || {};
  if (!report || typeof report.commitmentId !== "string") return { outcome: "IGNORED", reason: "UNSCOPED_REPORT" };

  const agent = await prisma.agent.findUnique({ where: { agentId: String(robotId) }, select: { id: true } });
  if (!agent) return { outcome: "IGNORED", reason: "NO_AGENT" };

  const outcome = await applyCustodyReport({ prisma, agent, robotId, report, snapshot, shardId });

  // Custody released: if the completion was already verified, settle now. The agent's
  // TASK_COMPLETE can land before its RELEASED report is admitted (it is held until the
  // server verifies the drop arrival), and settlement refuses while custody is held — so the
  // one settlement attempt was refused and the Leg sat in RELEASED with its commitment live
  // (measured on the V1 10-robot run, 2026-09-23). Same evidence, same `settlement.settle`.
  if (outcome && outcome.outcome === transitions.OUTCOME.APPLIED && outcome.to === STATE.RELEASED) {
    const settled = await settleIfVerified({ prisma, commitmentId: report.commitmentId, robotId });
    if (settled) {
      // C5 — the held TASK_COMPLETE completes here, once, after the commit.
      await taskCompletion.publish({ io, kv, completion: settled.completion });
      return { ...outcome, settlement: settled.settlement, ...(settled.completion ? { completion: settled.completion } : {}) };
    }
  }
  return outcome;
}

/**
 * Settle a Leg whose completion was already verified SUFFICIENT for this commitment — and, in
 * the same transaction, complete the Task that claim named (C5).
 *
 * The evidence row is the durable record of the verified `TASK_COMPLETE`: `dtaro.handler`
 * writes it with the claim's `taskId` whatever settlement then answers. A claim held because
 * custody was still HELD therefore completes here, at the release — through the same
 * `taskCompletion` path `TASK_COMPLETE` itself uses. Without a verified claim naming a Task
 * nothing is completed: a release is not a completion.
 *
 * @param {object} input `{ prisma, commitmentId, robotId }`
 * @returns {Promise<{ settlement: object, completion: object|null }|null>} null when there is
 *   no evidence
 */
async function settleIfVerified(input) {
  const { prisma, commitmentId, robotId } = input || {};
  const commitment = await prisma.commitment.findUnique({ where: { commitmentId } });
  if (!commitment || commitment.releasedAt) return null;
  // The evidence row names the commitment it graded (`dtaro.handler.verifyCompletionClaim`).
  const evidence = await prisma.verificationEvidence.findFirst({
    where: { legId: commitment.legId, outcome: "SUFFICIENT", evidenceId: { contains: commitmentId } },
    orderBy: { observedAt: "desc" },
  });
  if (!evidence) return null;
  return prisma.$transaction(async (tx) => {
    // F2 — the evidence must name this Leg's own Task (`taskCompletion.bindClaim`), checked
    // before settling: evidence naming another Task, or none, would otherwise release this
    // commitment and complete the wrong Task or leave the right one open. Not usable evidence,
    // so the release stays a release and a correctly named TASK_COMPLETE settles the Leg.
    const binding = await taskCompletion.bindClaim(tx, { legId: commitment.legId, claimedTaskId: evidence.taskId });
    if (!binding.ok) return null;
    const leg = await tx.leg.findUnique({ where: { id: commitment.legId } });
    const live = await tx.commitment.findUnique({ where: { commitmentId } });
    const manifests = leg ? await tx.payloadManifest.findMany({ where: { legId: leg.id } }) : [];
    const settled = await settlement.settle(tx, {
      leg,
      commitment: live,
      verification: { ...evidence, outcome: evidence.outcome },
      manifests,
      storeTime: await clock.readStoreTime(tx),
    });
    const completion =
      taskCompletion.isSettled(settled) && robotId
        ? await taskCompletion.recordInTx(tx, {
            robotId: String(robotId),
            taskId: binding.task.taskId,
            settledNow: settled.outcome === settlement.OUTCOME.SETTLED,
          })
        : null;
    return { settlement: settled, completion };
  });
}

async function applyCustodyReport({ prisma, agent, robotId, report, snapshot, shardId }) {
  return prisma.$transaction(async (tx) => {
    const commitment = await tx.commitment.findUnique({ where: { commitmentId: report.commitmentId } });
    if (!commitment || commitment.agentId !== agent.id || commitment.releasedAt) {
      return { outcome: "IGNORED", reason: "NOT_THIS_AGENTS_LIVE_COMMITMENT" };
    }
    if (report.fence === undefined || report.fence === null || BigInt(report.fence) !== BigInt(commitment.fence)) {
      return { outcome: "IGNORED", reason: "STALE_OR_MISSING_FENCE" };
    }
    const leg = await tx.leg.findUnique({ where: { id: commitment.legId } });
    if (!leg) return { outcome: "IGNORED", reason: "LEG_NOT_FOUND" };
    const storeTime = await clock.readStoreTime(tx);
    const evidence = { source: "AGENT_REPORT", commitmentId: commitment.commitmentId, reportedAt: storeTime.toISOString() };

    if (report.kind === "ACQUIRED" && leg.state === STATE.AT_PICKUP) {
      return applyEvent(tx, {
        leg,
        event: EVENT.CUSTODY_ACQUIRED,
        context: { payloadEvidence: true, payloadEvidenceRecord: evidence },
        data: { custodyState: "HELD" },
        snapshot,
        storeTime,
        shardId,
        commitmentId: commitment.commitmentId,
      });
    }
    if (report.kind === "RELEASED" && leg.state === STATE.AT_DROP) {
      return applyEvent(tx, {
        leg,
        event: EVENT.CUSTODY_RELEASED,
        context: { releaseEvidence: true, releaseEvidenceRecord: evidence },
        data: { custodyState: "RELEASED" },
        snapshot,
        storeTime,
        shardId,
      });
    }
    if ((HOLDABLE[report.kind] || []).includes(leg.state)) {
      heldCustody.set(commitment.commitmentId, { robotId: String(robotId), report: { ...report } });
      return { outcome: "HELD_UNTIL_ARRIVAL", reason: `NOT_AT_THE_STOP_YET (${leg.state})` };
    }
    return { outcome: "IGNORED", reason: `NOT_AT_THE_STOP (${leg.state})` };
  });
}

/**
 * After the server has verified an arrival, apply the custody report the agent already sent
 * for that stop, if one is held. Same admission rules as a fresh report.
 *
 * @param {object} input `{ prisma, commitmentId, snapshot, shardId }`
 * @returns {Promise<object|null>}
 */
async function applyHeldCustody(input) {
  const { prisma, commitmentId, snapshot, shardId, io, kv } = input || {};
  const held = heldCustody.get(commitmentId);
  if (!held) return null;
  const outcome = await onCustodyReport({ prisma, robotId: held.robotId, report: held.report, snapshot, shardId, io, kv });
  // Applied, or refused for a reason that waiting will not change: either way, not held again.
  if (!outcome || outcome.outcome !== "HELD_UNTIL_ARRIVAL") heldCustody.delete(commitmentId);
  return outcome;
}

module.exports = { MIN_DEPARTURE_M, arrivalRadiusM, onPositionFix, onCustodyReport };

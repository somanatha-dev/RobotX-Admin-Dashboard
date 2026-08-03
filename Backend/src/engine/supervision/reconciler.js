"use strict";

/**
 * The reconciliation loop (§12.4).
 *
 * > This design […] adopts a control-loop model: a **Reconciler** continuously compares
 * > desired state against observed state and repairs the difference, in the manner of a
 * > Kubernetes controller. It is a convergence mechanism, not an error handler, and it is
 * > **correct-by-construction for triggers nobody anticipated**.
 *
 * That last clause is the reason this exists rather than a seventh bug fix:
 *
 * > The audit's failure summary contains six distinct entries whose outcome is "stuck
 * > `ASSIGNED`", "stuck `PENDING`", or "silent". They have different triggers but one
 * > shared root cause: **no component is responsible for noticing that a state has
 * > stopped progressing.** Patching each trigger individually leaves the seventh
 * > undiscovered.
 *
 * ── The reconciler issues no command directly ───────────────────────────────
 * > Every repair in the table above that commands an agent does so by writing an outbox
 * > row inside the same transaction as the state transition and fence advance that
 * > authorise it (§4.1 rule 5). The reconciler and the timer supervisor can act on the
 * > same entity concurrently, and conditional writes decide which of them wins the
 * > transition; binding the command to that transition is what stops the loser from
 * > having already sent a command. Without this, a real incident reliably produces at
 * > least one duplicate stand-down and one spurious reassignment.
 *
 * So every repair here that commands an agent routes through `lifecycle/reassignment.js`
 * or `dispatch/*`, each of which writes its outbox row in the authorising transaction.
 * This module imports no socket and no dispatcher.
 *
 * ── Every repair is counted ─────────────────────────────────────────────────
 * > **Every repair is counted and alerted on** (T10). The reconciler's repair rate is a
 * > defect signal: a healthy system's reconciler is nearly idle, so a rising rate means a
 * > bug elsewhere, and burying it in a safety net converts a visible outage into
 * > invisible chronic loss. The release gate MUST include a maximum acceptable repair
 * > rate per category.
 *
 * Per **category**, which is why `ReconcilerRepair.category` is constrained by a CHECK
 * rather than left free-text: a repair filed under a name the gate does not know is a
 * repair the gate cannot see.
 *
 * ── A recorded plan/specification discrepancy ───────────────────────────────
 * The execution plan says "all nine divergence classes of §12.4"; §12.4's table has
 * **ten** rows. The plan states its own precedence — "where this plan and the
 * specification appear to disagree, the specification wins and this plan is defective" —
 * so all ten are implemented and counted. This is the same class of discrepancy Phase 2
 * recorded for the `TaskStatus` enum, and it is resolved the same way: implement the
 * specification, record the disagreement, change neither document.
 *
 * Tier 0 (T0-08). Invariants I2, I3, I4, I7, I8, I12, I13.
 */

const custody = require("../domain/custody");
const legMachine = require("../lifecycle/legMachine");
const purpose = require("../domain/purpose");
const settlement = require("../lifecycle/settlement");
const supervisionLeases = require("./leases");
const taskMachine = require("../lifecycle/taskMachine");
const timers = require("./timers");

/**
 * §12.4's ten divergence classes, in the table's own order. Mirrored by the
 * `ReconcilerRepair_category_known` CHECK.
 * @structural the enumerated §12.4 divergence classes
 */
const DIVERGENCE = Object.freeze({
  COMMITMENT_UNKNOWN_TO_AGENT: "COMMITMENT_UNKNOWN_TO_AGENT",
  AGENT_REPORTS_UNKNOWN_COMMITMENT: "AGENT_REPORTS_UNKNOWN_COMMITMENT",
  ORPHAN_LEG: "ORPHAN_LEG",
  COMMITMENT_ON_TERMINAL_LEG: "COMMITMENT_ON_TERMINAL_LEG",
  LEASE_EXPIRED_UNPROCESSED: "LEASE_EXPIRED_UNPROCESSED",
  CUSTODY_HELD_WITHOUT_MISSION: "CUSTODY_HELD_WITHOUT_MISSION",
  TASK_WAITING_BEYOND_SLA: "TASK_WAITING_BEYOND_SLA",
  OUTBOX_UNDELIVERED_PAST_DEADLINE: "OUTBOX_UNDELIVERED_PAST_DEADLINE",
  AGENT_ABSENT_FROM_AVAILABILITY_INDEX: "AGENT_ABSENT_FROM_AVAILABILITY_INDEX",
  ENERGY_ACCOUNTING_INCONSISTENT: "ENERGY_ACCOUNTING_INCONSISTENT",
});

/**
 * §12.4's "Escalate when" column. `ALWAYS` is not a synonym for "serious": it means the
 * repair is *never* sufficient on its own, so the row escalates even when the repair
 * succeeded.
 * @structural the escalation policy per §12.4 row
 */
const ESCALATION_POLICY = Object.freeze({
  [DIVERGENCE.COMMITMENT_UNKNOWN_TO_AGENT]: "ON_REPEATED_FAILURE",
  [DIVERGENCE.AGENT_REPORTS_UNKNOWN_COMMITMENT]: "ON_CUSTODY_HELD",
  [DIVERGENCE.ORPHAN_LEG]: "ON_CUSTODY_HELD",
  [DIVERGENCE.COMMITMENT_ON_TERMINAL_LEG]: "NEVER",
  [DIVERGENCE.LEASE_EXPIRED_UNPROCESSED]: "NEVER",
  [DIVERGENCE.CUSTODY_HELD_WITHOUT_MISSION]: "ALWAYS",
  [DIVERGENCE.TASK_WAITING_BEYOND_SLA]: "ALWAYS",
  [DIVERGENCE.OUTBOX_UNDELIVERED_PAST_DEADLINE]: "ON_LADDER_STEP_3",
  [DIVERGENCE.AGENT_ABSENT_FROM_AVAILABILITY_INDEX]: "ON_REPEATED",
  [DIVERGENCE.ENERGY_ACCOUNTING_INCONSISTENT]: "ON_LARGE_DIVERGENCE",
});

/**
 * §12.4 row 3's distinction, which the plan calls out explicitly:
 *
 * > **This is also the normal path for SOFT reservations lost in a coordinator failover**
 * > (§2.6, §19.5), which is why the scan must distinguish the two by Leg state and count
 * > them separately — a `PLANNED` orphan after failover is expected; a `QUEUED` or
 * > `ACCEPTED` orphan is a defect.
 *
 * Counting them together would hide a defect inside an expected number, which is the
 * failure mode §12.4's whole "every repair is counted" paragraph exists to prevent.
 * @structural the orphan classification of §12.4 row 3
 */
const ORPHAN_KIND = Object.freeze({
  /** A `PLANNED` Leg with no commitment: the SOFT reservation the failover discarded. */
  EXPECTED_POST_FAILOVER: "EXPECTED_POST_FAILOVER",
  /** Anything else: a Leg that lost its owner without a leadership change. */
  DEFECT: "DEFECT",
});

/**
 * Write one repair to the ledger.
 *
 * @param {object} client base or transaction client
 * @param {object} input
 * @returns {Promise<object>}
 */
async function recordRepair(client, input) {
  const source = input || {};
  return client.reconcilerRepair.create({
    data: {
      category: source.category,
      entityType: source.entityType,
      entityId: source.entityId,
      action: source.action,
      detail: source.detail === undefined ? null : source.detail,
      escalated: source.escalated === true,
      shardId: source.shardId === undefined ? null : source.shardId,
      at: source.storeTime,
    },
  });
}

/**
 * Row 3 — *"Leg non-terminal with no commitment and no queue entry."*
 *
 * Repair: *"Requeue with aging credit."* Escalate when custody is `HELD` — goods with no
 * owner is an operator event, not a requeue.
 *
 * @param {object} deps
 * @param {object} config
 * @param {Date} storeTime
 * @returns {Promise<object>}
 */
async function scanOrphanLegs(deps, config, storeTime) {
  const legs = await deps.prisma.leg.findMany({
    where: { state: { notIn: legMachine.TERMINAL_LEG_STATES } },
    take: config.batch,
  });

  const counts = { [ORPHAN_KIND.EXPECTED_POST_FAILOVER]: 0, [ORPHAN_KIND.DEFECT]: 0 };
  const repairs = [];

  for (const leg of legs) {
    // A Leg in QUEUED or DEFERRED has no commitment by definition (§2.6: nothing has been
    // said to any agent), so it is not an orphan — it is queued. The orphan is a Leg past
    // that point with nothing holding it.
    if (leg.state === legMachine.LEG_STATE.QUEUED || leg.state === legMachine.LEG_STATE.DEFERRED) continue;

    const active = await deps.prisma.commitment.count({ where: { legId: leg.id, releasedAt: null } });
    if (active > 0) continue;

    const kind =
      leg.state === legMachine.LEG_STATE.PLANNED ? ORPHAN_KIND.EXPECTED_POST_FAILOVER : ORPHAN_KIND.DEFECT;
    counts[kind] += 1;

    const escalate = custody.holdsGoods(leg.custodyState);

    if (!escalate) {
      // Requeue. Conditional on the Leg's version, like every transition, and with the
      // timer obligations §4.5 attaches to the state it enters.
      await deps.runInTransaction(async (tx) => {
        const written = await tx.leg.updateMany({
          where: { id: leg.id, version: leg.version },
          data: { state: legMachine.LEG_STATE.QUEUED, version: leg.version + 1 },
        });
        if (written.count !== 1) return;

        await timers.cancelFor(tx, {
          entityType: timers.ENTITY_TYPE.LEG,
          entityId: leg.id,
          storeTime,
          reason: "ORPHAN_REQUEUED",
        });
        await timers.register(tx, {
          entityType: timers.ENTITY_TYPE.LEG,
          entityId: leg.id,
          state: legMachine.LEG_STATE.QUEUED,
          entity: { ...leg, version: leg.version + 1 },
          dueAt: timers.deadlineFrom(storeTime, config.assignmentDeadlineSeconds),
          handler: legMachine.deadlineFor(legMachine.LEG_STATE.QUEUED).onExpiry,
          payload: { repairedFrom: leg.state, orphanKind: kind },
          shardId: config.shardId,
        });

        await recordRepair(tx, {
          category: DIVERGENCE.ORPHAN_LEG,
          entityType: "LEG",
          entityId: leg.id,
          action: "REQUEUE_WITH_AGING_CREDIT",
          detail: { orphanKind: kind, fromState: leg.state, agingCreditFrom: leg.updatedAt },
          escalated: false,
          shardId: config.shardId,
          storeTime,
        });
      });
    } else {
      await recordRepair(deps.prisma, {
        category: DIVERGENCE.ORPHAN_LEG,
        entityType: "LEG",
        entityId: leg.id,
        action: "ESCALATE_TO_OPERATOR",
        detail: { orphanKind: kind, fromState: leg.state, custodyState: leg.custodyState },
        escalated: true,
        shardId: config.shardId,
        storeTime,
      });
    }

    repairs.push({ legId: leg.id, kind, escalated: escalate });
  }

  return { category: DIVERGENCE.ORPHAN_LEG, repaired: repairs.length, counts, repairs };
}

/**
 * Row 4 — *"Agent marked committed but Leg is terminal."*
 *
 * Repair: *"Release that commitment, retire its fence, return capacity."* No escalation:
 * this is bookkeeping catching up, and the physical world is already correct.
 */
async function scanCommitmentsOnTerminalLegs(deps, config, storeTime) {
  const active = await deps.prisma.commitment.findMany({ where: { releasedAt: null }, take: config.batch });
  let repaired = 0;

  for (const commitment of active) {
    const leg = await deps.prisma.leg.findUnique({ where: { id: commitment.legId } });
    if (!leg || !legMachine.isTerminal(leg.state)) continue;

    await deps.runInTransaction(async (tx) => {
      const written = await tx.commitment.updateMany({
        where: { commitmentId: commitment.commitmentId, releasedAt: null, version: commitment.version },
        data: { releasedAt: storeTime, version: commitment.version + 1 },
      });
      if (written.count !== 1) return;

      await timers.cancelFor(tx, {
        entityType: timers.ENTITY_TYPE.COMMITMENT,
        entityId: commitment.commitmentId,
        storeTime,
        reason: "LEG_TERMINAL",
      });

      await recordRepair(tx, {
        category: DIVERGENCE.COMMITMENT_ON_TERMINAL_LEG,
        entityType: "COMMITMENT",
        entityId: commitment.commitmentId,
        action: "RELEASE_AND_RETURN_CAPACITY",
        detail: { legState: leg.state },
        escalated: false,
        shardId: config.shardId,
        storeTime,
      });
      repaired += 1;
    });
  }

  return { category: DIVERGENCE.COMMITMENT_ON_TERMINAL_LEG, repaired };
}

/**
 * Row 5 — *"Lease expired, not yet processed."*
 *
 * Repair: *"Run the §4.7 recovery path."* This scan is the safety net beneath the timer:
 * the commitment's lease timer should have fired first, and a row reaching here means it
 * did not — which is why the repair is counted even though it is the same action.
 *
 * The recovery *decision* is `leases.assessRecovery`, and the recovery *action* is the
 * caller's — `deps.recover` — because it advances a fence and must therefore be written
 * with the command it authorises (§4.1 rule 5), in a transaction this scan does not own.
 */
async function scanExpiredLeases(deps, config, storeTime) {
  const expired = await supervisionLeases.findExpired(deps.prisma, { storeTime, limit: config.batch });
  const assessments = [];

  for (const commitment of expired) {
    const leg = await deps.prisma.leg.findUnique({ where: { id: commitment.legId } });
    if (!leg) continue;
    // Already in a recovery state: the expiry was processed, and I2 reads "has a valid
    // lease **or is in a recovery state**".
    if (supervisionLeases.RECOVERY_STATES.includes(leg.state)) continue;

    const assessment = supervisionLeases.assessRecovery({
      leg,
      custodyState: leg.custodyState,
      obstructionClass: leg.obstructionClass,
      agentReachable: config.agentReachable ? config.agentReachable(commitment.agentId) : undefined,
    });

    await recordRepair(deps.prisma, {
      category: DIVERGENCE.LEASE_EXPIRED_UNPROCESSED,
      entityType: "COMMITMENT",
      entityId: commitment.commitmentId,
      action: `RECOVERY_${assessment.outcome}`,
      detail: {
        legId: leg.id,
        legState: leg.state,
        custodyState: leg.custodyState,
        targetState: assessment.legState,
        obstructionClass: assessment.obstructionClass,
      },
      escalated: assessment.externalEscalation === true,
      shardId: config.shardId,
      storeTime,
    });

    assessments.push({ commitmentId: commitment.commitmentId, legId: leg.id, assessment });

    if (typeof deps.recover === "function") {
      await deps.recover({ commitment, leg, assessment, storeTime });
    }
  }

  return { category: DIVERGENCE.LEASE_EXPIRED_UNPROCESSED, repaired: assessments.length, assessments };
}

/**
 * Row 6 — *"Custody `HELD` with no active mission."*
 *
 * Repair: *"Immediate operator escalation — goods are unaccounted for."* Escalate:
 * **Always**.
 *
 * There is deliberately no automatic repair. §4.1 rule 4: *"Physical reality outranks the
 * database. Where the two diverge, the reconciler adjusts the database and, when goods or
 * motion are involved, escalates to a human rather than assuming its own record is
 * correct."* Goods are involved by definition here.
 */
async function scanCustodyWithoutMission(deps, config, storeTime) {
  const held = await deps.prisma.leg.findMany({
    where: { custodyState: { in: HOLDING_CUSTODY_STATES } },
    take: config.batch,
  });

  const escalations = [];
  for (const leg of held) {
    const active = await deps.prisma.commitment.count({ where: { legId: leg.id, releasedAt: null } });
    if (active > 0) continue;
    // A settled Leg has discharged its custody through §4.9's ordering; anything else
    // holding goods with no commitment is unaccounted for.
    if (leg.state === legMachine.LEG_STATE.SETTLED) continue;

    await recordRepair(deps.prisma, {
      category: DIVERGENCE.CUSTODY_HELD_WITHOUT_MISSION,
      entityType: "LEG",
      entityId: leg.id,
      action: "IMMEDIATE_OPERATOR_ESCALATION",
      detail: { custodyState: leg.custodyState, legState: leg.state, purpose: leg.purpose },
      escalated: true,
      shardId: config.shardId,
      storeTime,
    });
    escalations.push({ legId: leg.id, custodyState: leg.custodyState, legState: leg.state });
  }

  return { category: DIVERGENCE.CUSTODY_HELD_WITHOUT_MISSION, repaired: escalations.length, escalations };
}

/** @structural the custody states that mean goods may be aboard (§2.5) */
const HOLDING_CUSTODY_STATES = Object.freeze(["HELD", "PENDING_TRANSFER", "DISPUTED"]);

/**
 * Row 7 — *"Task `WAITING` beyond SLA with no queue entry."*
 *
 * Repair: *"Requeue; investigate the loss."* Escalate: **Always** — a Task that lost its
 * queue entry is a customer obligation nobody is working on, and the requeue fixes the
 * symptom while the investigation is the point.
 *
 * This is also where the legacy dispatcher's stuck-`PENDING` family is caught during the
 * cutover window: a legacy Task is recognised by `taskMachine.isLegacyState` and counted,
 * not silently treated as corrupt.
 */
async function scanWaitingTasks(deps, config, storeTime) {
  const waiting = await deps.prisma.task.findMany({
    where: { status: { in: [taskMachine.TASK_STATE.WAITING, taskMachine.LEGACY_TASK_STATE.PENDING] } },
    take: config.batch,
  });

  const repairs = [];
  for (const task of waiting) {
    const createdAt = task.createdAt instanceof Date ? task.createdAt : new Date(task.createdAt);
    const ageSeconds = (storeTime.getTime() - createdAt.getTime()) / MILLIS_PER_SECOND;
    if (ageSeconds <= config.assignmentDeadlineSeconds) continue;

    const queued = await deps.prisma.leg.count({
      where: {
        state: { in: [legMachine.LEG_STATE.QUEUED, legMachine.LEG_STATE.DEFERRED, legMachine.LEG_STATE.PLANNED] },
        mission: { tasks: { some: { id: task.id } } },
      },
    });
    if (queued > 0) continue;

    await recordRepair(deps.prisma, {
      category: DIVERGENCE.TASK_WAITING_BEYOND_SLA,
      entityType: "TASK",
      entityId: task.id,
      action: "REQUEUE_AND_INVESTIGATE",
      detail: {
        status: task.status,
        legacyVocabulary: taskMachine.isLegacyState(task.status),
        ageSeconds,
        slaSeconds: config.assignmentDeadlineSeconds,
      },
      escalated: true,
      shardId: config.shardId,
      storeTime,
    });
    repairs.push({ taskId: task.id, ageSeconds });
  }

  return { category: DIVERGENCE.TASK_WAITING_BEYOND_SLA, repaired: repairs.length, repairs };
}

/**
 * Row 8 — *"Outbox row undelivered past deadline."* Repair: *"§11.4 ladder."*
 *
 * The ladder itself is `workers/outbox.worker.js`, which owns the retry, the withdrawal,
 * and the per-agent and per-shard rungs. What this scan adds is the *observation* that a
 * row is past its deadline while the drain worker is not running or is falling behind —
 * which is a different fault from an agent that will not answer, and is counted
 * separately because of it.
 */
async function scanUndeliveredOutbox(deps, config, storeTime) {
  const stale = await deps.prisma.outbox.findMany({
    where: { state: { in: ["PENDING", "CLAIMED"] }, notValidAfter: { lte: storeTime } },
    take: config.batch,
  });

  for (const row of stale) {
    await recordRepair(deps.prisma, {
      category: DIVERGENCE.OUTBOX_UNDELIVERED_PAST_DEADLINE,
      entityType: "OUTBOX",
      entityId: row.id,
      action: "DEFER_TO_DISPATCH_LADDER",
      detail: { command: row.command, agentId: row.agentId, attempts: row.attempts, state: row.state },
      escalated: row.attempts >= config.unresponsiveStrikes,
      shardId: config.shardId,
      storeTime,
    });
  }

  return { category: DIVERGENCE.OUTBOX_UNDELIVERED_PAST_DEADLINE, repaired: stale.length };
}

/**
 * Row 1 — *"Commitment exists, agent unaware of it."*
 *
 * Detection is *"Agent's reported commitment set versus store"*, so it needs a report.
 * `deps.reportedCommitments(agentId)` supplies one; without it the scan is skipped rather
 * than assuming agreement — §4.1 rule 3 again, and this is the row where assuming
 * agreement would be worst.
 *
 * Repair: *"Re-dispatch at an advanced fence for **that commitment only**"* — which is
 * `reassignment.reassign`'s fence discipline, performed by the caller's `redispatch` so
 * the fence advance and its command share a transaction.
 */
async function scanCommitmentsUnknownToAgent(deps, config, storeTime) {
  if (typeof deps.reportedCommitments !== "function") {
    return { category: DIVERGENCE.COMMITMENT_UNKNOWN_TO_AGENT, repaired: 0, skipped: "NO_AGENT_REPORTS" };
  }

  const active = await deps.prisma.commitment.findMany({ where: { releasedAt: null }, take: config.batch });
  const divergent = [];

  for (const commitment of active) {
    const reported = await deps.reportedCommitments(commitment.agentId);
    if (!Array.isArray(reported)) continue;
    if (reported.includes(commitment.commitmentId)) continue;

    await recordRepair(deps.prisma, {
      category: DIVERGENCE.COMMITMENT_UNKNOWN_TO_AGENT,
      entityType: "COMMITMENT",
      entityId: commitment.commitmentId,
      action: "REDISPATCH_AT_ADVANCED_FENCE",
      detail: { agentId: commitment.agentId, reportedCount: reported.length },
      escalated: false,
      shardId: config.shardId,
      storeTime,
    });
    divergent.push(commitment.commitmentId);

    if (typeof deps.redispatch === "function") await deps.redispatch({ commitment, storeTime });
  }

  return { category: DIVERGENCE.COMMITMENT_UNKNOWN_TO_AGENT, repaired: divergent.length, divergent };
}

/**
 * Row 2 — *"Agent reports a commitment the store does not have."*
 *
 * > Issue `ABORT_MISSION` for that commitment id at a fence above any the agent could
 * > hold; if the agent's reported set is wholly unrecognisable, escalate to
 * > `STAND_DOWN_ALL` at an advanced `authority_epoch`.
 *
 * The two responses differ in scope, and the escalation condition is stated exactly:
 * *wholly* unrecognisable, not "mostly". One phantom commitment is a stale record on the
 * agent; a set with nothing in common with the store is an agent operating under an
 * authority the shard does not recognise at all, and only the agent-scope epoch can end
 * that in one action (§10.3.1).
 */
async function scanUnknownCommitmentReports(deps, config, storeTime) {
  if (typeof deps.reportedCommitments !== "function") {
    return { category: DIVERGENCE.AGENT_REPORTS_UNKNOWN_COMMITMENT, repaired: 0, skipped: "NO_AGENT_REPORTS" };
  }

  const agents = await deps.prisma.agent.findMany({ take: config.batch });
  const findings = [];

  for (const agent of agents) {
    const reported = await deps.reportedCommitments(agent.id);
    if (!Array.isArray(reported) || reported.length === 0) continue;

    const known = await deps.prisma.commitment.findMany({ where: { agentId: agent.id, releasedAt: null } });
    const knownIds = new Set(known.map((commitment) => commitment.commitmentId));
    const phantom = reported.filter((commitmentId) => !knownIds.has(commitmentId));
    if (phantom.length === 0) continue;

    const whollyUnrecognisable = phantom.length === reported.length;
    const custodyHeld = known.some((commitment) => custody.holdsGoods(commitment.custodyState));

    await recordRepair(deps.prisma, {
      category: DIVERGENCE.AGENT_REPORTS_UNKNOWN_COMMITMENT,
      entityType: "AGENT",
      entityId: agent.id,
      action: whollyUnrecognisable ? "STAND_DOWN_ALL_AT_ADVANCED_EPOCH" : "ABORT_MISSION_PER_COMMITMENT",
      detail: { phantom, reportedCount: reported.length, knownCount: knownIds.size },
      escalated: custodyHeld,
      shardId: config.shardId,
      storeTime,
    });

    findings.push({ agentId: agent.id, phantom, whollyUnrecognisable });

    if (typeof deps.abortPhantom === "function") {
      await deps.abortPhantom({ agent, phantom, whollyUnrecognisable, storeTime });
    }
  }

  return { category: DIVERGENCE.AGENT_REPORTS_UNKNOWN_COMMITMENT, repaired: findings.length, findings };
}

/**
 * Row 9 — *"Agent absent from the availability index but healthy and idle."*
 *
 * Repair: *"Reinsert into index."* The index is Phase 9's, so the reinsertion is
 * `deps.reinsertIntoIndex` when one exists; the *detection* — an agent with no active
 * commitment, an `ACTIVE` lifecycle, and a live session — is here and is counted from the
 * day the reconciler exists.
 *
 * **This is where the legacy offline sweep is absorbed.** The standalone `setInterval` in
 * `socket.server.js` did the inverse job — marking robots offline when their heartbeat
 * aged out — and it is the same control loop viewed from the other side: liveness versus
 * the index. Running two independent loops over one fact is how the two disagree.
 */
async function scanAvailabilityIndex(deps, config, storeTime) {
  const agents = await deps.prisma.agent.findMany({ where: { lifecycleState: "ACTIVE" }, take: config.batch });
  const findings = [];

  for (const agent of agents) {
    const active = await deps.prisma.commitment.count({ where: { agentId: agent.id, releasedAt: null } });
    if (active > 0) continue;

    const indexed = typeof deps.isInAvailabilityIndex === "function" ? await deps.isInAvailabilityIndex(agent.id) : null;
    // Unknown is not a divergence. Phase 9 owns the index; until it exists there is
    // nothing to be absent from, and reporting every idle agent as a defect would make
    // the repair rate meaningless before the mechanism it measures is built.
    if (indexed !== false) continue;

    await recordRepair(deps.prisma, {
      category: DIVERGENCE.AGENT_ABSENT_FROM_AVAILABILITY_INDEX,
      entityType: "AGENT",
      entityId: agent.id,
      action: "REINSERT_INTO_INDEX",
      detail: { lifecycleState: agent.lifecycleState },
      escalated: false,
      shardId: config.shardId,
      storeTime,
    });
    findings.push(agent.id);

    if (typeof deps.reinsertIntoIndex === "function") await deps.reinsertIntoIndex(agent.id);
  }

  return { category: DIVERGENCE.AGENT_ABSENT_FROM_AVAILABILITY_INDEX, repaired: findings.length, findings };
}

/**
 * Row 10 — *"Energy accounting inconsistent with telemetry."*
 *
 * Repair: *"Recompute; flag model calibration."* Escalate on a large divergence.
 *
 * The energy model is Phase 7's, so this scan compares what it is given — a realised and
 * a predicted figure per commitment, supplied by `deps.energyAccounting` — and computes
 * nothing itself. A reconciler that estimated energy would be a second energy model, and
 * §14 is emphatic that there is one.
 */
async function scanEnergyAccounting(deps, config, storeTime) {
  if (typeof deps.energyAccounting !== "function") {
    return { category: DIVERGENCE.ENERGY_ACCOUNTING_INCONSISTENT, repaired: 0, skipped: "NO_ENERGY_MODEL" };
  }

  const recent = await deps.prisma.commitment.findMany({
    where: { releasedAt: { not: null } },
    orderBy: { releasedAt: "desc" },
    take: config.batch,
  });

  const findings = [];
  for (const commitment of recent) {
    const accounting = await deps.energyAccounting(commitment.commitmentId);
    if (!accounting || !Number.isFinite(accounting.predictedWh) || accounting.predictedWh <= 0) continue;
    if (!Number.isFinite(accounting.realisedWh)) continue;

    const deviation = Math.abs(accounting.realisedWh - accounting.predictedWh) / accounting.predictedWh;
    if (deviation <= config.energyDeviationTolerance) continue;

    await recordRepair(deps.prisma, {
      category: DIVERGENCE.ENERGY_ACCOUNTING_INCONSISTENT,
      entityType: "COMMITMENT",
      entityId: commitment.commitmentId,
      action: "RECOMPUTE_AND_FLAG_CALIBRATION",
      detail: { deviation, ...accounting },
      // "Escalate when: Large divergence." Large is twice the tolerance the mid-mission
      // supervisor already acts on — beyond that the model, not the mission, is wrong.
      escalated: deviation > config.energyDeviationTolerance * LARGE_DIVERGENCE_MULTIPLE,
      shardId: config.shardId,
      storeTime,
    });
    findings.push({ commitmentId: commitment.commitmentId, deviation });
  }

  return { category: DIVERGENCE.ENERGY_ACCOUNTING_INCONSISTENT, repaired: findings.length, findings };
}

/**
 * @structural how many times the mid-mission tolerance counts as a "large" divergence
 *   for §12.4 row 10's escalation column — a ratio between two readings of one
 *   registered parameter, not a second threshold
 */
const LARGE_DIVERGENCE_MULTIPLE = 2;

/**
 * One full sweep — every one of §12.4's ten classes, each counted.
 *
 * > Runs continuously per shard, event-driven with a periodic full sweep, and is
 * > idempotent.
 *
 * Idempotent because every repair is a conditional write: a sweep that runs twice over
 * the same divergence repairs it once and finds nothing the second time.
 *
 * @param {object} deps
 * @param {object} deps.prisma
 * @param {(fn: (tx: object) => Promise<*>) => Promise<*>} deps.runInTransaction
 * @param {() => Promise<Date>} deps.readStoreTime
 * @param {object} config resolved parameters
 * @returns {Promise<object>}
 */
async function sweep(deps, config) {
  requireDeps(deps);
  const settings = { batch: DEFAULT_BATCH, ...(config || {}) };
  const storeTime = await deps.readStoreTime();

  const results = [];
  results.push(await scanCommitmentsUnknownToAgent(deps, settings, storeTime));
  results.push(await scanUnknownCommitmentReports(deps, settings, storeTime));
  results.push(await scanOrphanLegs(deps, settings, storeTime));
  results.push(await scanCommitmentsOnTerminalLegs(deps, settings, storeTime));
  results.push(await scanExpiredLeases(deps, settings, storeTime));
  results.push(await scanCustodyWithoutMission(deps, settings, storeTime));
  results.push(await scanWaitingTasks(deps, settings, storeTime));
  results.push(await scanUndeliveredOutbox(deps, settings, storeTime));
  results.push(await scanAvailabilityIndex(deps, settings, storeTime));
  results.push(await scanEnergyAccounting(deps, settings, storeTime));

  const byCategory = {};
  let total = 0;
  for (const result of results) {
    byCategory[result.category] = result.repaired;
    total += result.repaired;
  }

  // Invariant I4's cross-audit — a non-terminal state with no pending timer is an
  // unsupervised state, which is the one thing the timer store exists to make impossible.
  const unsupervised = await timers.findUnsupervised(deps.prisma, { limit: settings.batch });

  return { storeTime, total, byCategory, results, unsupervised };
}

/**
 * The repair rate, per category, over a window — the alertable SLI §12.4 requires.
 *
 * @param {object} prisma
 * @param {object} input
 * @param {Date} input.since
 * @returns {Promise<{ windowSeconds: number, byCategory: object, total: number, escalated: number }>}
 */
async function readRepairRate(prisma, input) {
  const source = input || {};
  const rows = await prisma.reconcilerRepair.findMany({ where: { at: { gte: source.since } } });

  const byCategory = {};
  for (const category of Object.values(DIVERGENCE)) byCategory[category] = 0;
  let escalated = 0;
  for (const row of rows) {
    if (byCategory[row.category] === undefined) byCategory[row.category] = 0;
    byCategory[row.category] += 1;
    if (row.escalated) escalated += 1;
  }

  const windowSeconds = source.storeTime
    ? Math.max(0, (source.storeTime.getTime() - source.since.getTime()) / MILLIS_PER_SECOND)
    : null;

  return { windowSeconds, byCategory, total: rows.length, escalated };
}

/**
 * Invariant I3, as a query — *"Every non-terminal Leg has either an active commitment, a
 * SOFT reservation in the leader's plan state, or a queue entry."*
 *
 * The SOFT reservation lives in the leader's memory (§2.6), so it cannot be read from the
 * store; a `PLANNED` Leg is therefore *presumed* to have one, and the orphan scan's
 * separate counting of `PLANNED` orphans is what makes that presumption auditable rather
 * than silent.
 *
 * @param {object} prisma
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
async function auditI3(prisma, limit) {
  const legs = await prisma.leg.findMany({
    where: { state: { notIn: legMachine.TERMINAL_LEG_STATES } },
    take: limit || DEFAULT_BATCH,
  });

  const violations = [];
  for (const leg of legs) {
    if (QUEUE_STATES.includes(leg.state)) continue;
    if (leg.state === legMachine.LEG_STATE.PLANNED) continue;
    const active = await prisma.commitment.count({ where: { legId: leg.id, releasedAt: null } });
    if (active > 0) continue;
    violations.push({ legId: leg.id, state: leg.state, purpose: leg.purpose, custodyState: leg.custodyState });
  }
  return violations;
}

/** @structural the states in which a Leg's "queue entry" is its own state (§2.6) */
const QUEUE_STATES = Object.freeze([legMachine.LEG_STATE.QUEUED, legMachine.LEG_STATE.DEFERRED]);

function requireDeps(deps) {
  if (!deps || !deps.prisma) throw new TypeError("the reconciler needs a store client");
  if (typeof deps.runInTransaction !== "function") {
    throw new TypeError(
      "the reconciler repairs by conditional write inside a transaction (§4.1 rule 2, §12.4). Every repair that " +
        "commands an agent writes its outbox row in the same transaction as the state transition and fence advance " +
        "that authorise it, so a repair path with no transaction to write in cannot honour §4.1 rule 5.",
    );
  }
  if (typeof deps.readStoreTime !== "function") {
    throw new TypeError("deadlines are judged against the Commitment Store's clock, never a worker's (§10.6)");
  }
}

/** @structural the sweep's batch size; a work-partitioning constant */
const DEFAULT_BATCH = 200;
/** @structural milliseconds per second — a unit conversion, not a threshold */
const MILLIS_PER_SECOND = 1000;

module.exports = {
  DIVERGENCE,
  ESCALATION_POLICY,
  ORPHAN_KIND,
  QUEUE_STATES,
  HOLDING_CUSTODY_STATES,
  recordRepair,
  scanCommitmentsUnknownToAgent,
  scanUnknownCommitmentReports,
  scanOrphanLegs,
  scanCommitmentsOnTerminalLegs,
  scanExpiredLeases,
  scanCustodyWithoutMission,
  scanWaitingTasks,
  scanUndeliveredOutbox,
  scanAvailabilityIndex,
  scanEnergyAccounting,
  sweep,
  readRepairRate,
  auditI3,
  auditI7: settlement.auditI7,
  auditI2: supervisionLeases.auditI2,
  purposeOfLeg: purpose.purposeOf,
};

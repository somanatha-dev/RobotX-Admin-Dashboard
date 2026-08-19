"use strict";

/**
 * `GET /api/shards` and `POST /api/shards/:id/rebalance` (§3.5, §19.2, §19.3).
 *
 * ── What the read surface is for ────────────────────────────────────────────
 * §3.5 requires **both** sizing bounds to be continuously monitored and **the binding one**
 * to be reported, "so that a shard split is triggered by whichever resource is actually
 * exhausted". That requirement is only discharged if an operator can see both numbers and
 * which of them is currently the constraint — which is what this route renders, per shard,
 * beside its membership count, its leadership record, and its last failover.
 *
 * Both bounds are returned, always. Returning only the binding one would make the other
 * unmonitorable through the only surface that shows it, which is how a shard comes to be
 * sized against one resource again.
 *
 * ── Read-only, and reading rather than recomputing ─────────────────────────
 * The sizing verdict is the one the **leader** last recorded on the `Shard` row, not one
 * computed per request. Two reasons, and the second matters more than the first: a
 * per-request evaluation puts a table scan on the availability path, and — because bound 1
 * is a *measured* quantity — two operators refreshing during an incident would see two
 * different verdicts derived from two different measurement windows. The response states
 * `sizingCheckedAt` so a stale verdict is visible as stale rather than presented as
 * current.
 *
 * ── Why rebalance plans rather than executes ────────────────────────────────
 * §19.2: rebalancing "migrates agents **one at a time**, advancing each migrated agent's
 * `authority_epoch` […] **never a bulk reassignment**". An HTTP request that synchronously
 * moved four hundred agents would be a bulk reassignment reached through a different door:
 * it would advance four hundred `authority_epoch`s inside one request, abort every round
 * holding any of those agents through guard G3, and produce a fence-rejection burst that
 * invariant I5's verification reads as a rising baseline.
 *
 * So this endpoint does the two things a control-plane operation legitimately does
 * synchronously — it **records the intent** by moving the shard's state, and it **returns
 * the ordered plan** — and the `shardSupervisor` worker performs the moves, one per tick,
 * paced by `shard.migration_min_interval`. The response says so explicitly, so no caller
 * mistakes a 200 for "the agents have moved".
 *
 * ── Where the intent is recorded, and what changed ──────────────────────────
 * "Records the intent" used to mean *only* `Shard.state`. The plan itself was returned in
 * the response body and stored nowhere, so the supervisor had nothing to execute and
 * nothing restored the shard: one elevated-role POST moved a shard to DRAINING, `intake.js`
 * stopped routing Legs to it, and the only remedy was database surgery
 * (`PHASE_13_REMEDIATION_AND_CLOSURE.md`, P13-R4).
 *
 * The intent is now a durable `ShardRebalance` row written in the **same transaction** as
 * the state change, and the two properties that follow from that are the point:
 *
 *   - the supervisor executes it, one agent per tick, across restarts and leadership
 *     handoffs, because it reads the row rather than a value from this request; and
 *   - **it terminates.** When the last planned move is resolved the supervisor closes the
 *     intent and restores the shard to the state recorded at creation. An operator can end
 *     it early by POSTing `{ "cancel": true }` to this same route, which does the same
 *     restoration. There is no durable state this endpoint can produce from which a shard
 *     has no route back to serving.
 *
 * Cancellation shares this route rather than adding one: the plan's REST row names exactly
 * two Phase 13 endpoints, and withdrawing a rebalance is the same control-plane operation
 * on the same resource under the same elevated role.
 */

const asyncHandler = require("../utils/asyncHandler");
const { getPrisma } = require("../db/prisma");
const leadership = require("../engine/shard/leadership");
const membership = require("../engine/shard/membership");
const shardModel = require("../engine/shard/shardModel");
const sizing = require("../engine/shard/sizing");

/** @structural HTTP status: the request names something that does not exist */
const HTTP_NOT_FOUND = 404;

/** @structural HTTP status: the request is well formed but cannot be carried out */
const HTTP_UNPROCESSABLE = 422;

/** @structural the largest rebalance plan this endpoint will render in one response */
const MAX_PLAN_MOVES = 500;

/**
 * Read a parameter from the request's pinned configuration snapshot, at region scope.
 *
 * Returns `undefined` rather than a default when no snapshot is available: `sizing.js`
 * reports an unevaluated bound as unevaluated, and feeding it a fabricated input would
 * turn "we could not evaluate this" into a confident wrong answer.
 *
 * @param {object} req
 * @param {string} name
 * @param {string|null} regionId
 * @returns {*}
 */
function resolveParam(req, name, regionId) {
  const config = req.app && req.app.locals ? req.app.locals.config : null;
  if (!config || typeof config.resolve !== "function") return undefined;
  try {
    return config.resolve(name, regionId ? { region: regionId } : undefined);
  } catch {
    return undefined;
  }
}

/**
 * The leadership record for a shard, read through the same module guard G1 reads through.
 *
 * A surface that derived "is this shard led" from its own reading of the lease would be a
 * second implementation of leadership, and the two would disagree during exactly the
 * incident the surface exists for.
 *
 * @param {object} prisma
 * @param {string} shardId
 * @returns {Promise<object|null>}
 */
async function readLeadershipRow(prisma, shardId) {
  return prisma.shardLeadership.findUnique({ where: { shardId } });
}

/**
 * Recompute the sizing report for the response.
 *
 * The **serial-commit** half is arithmetic over configuration and the observed membership
 * count, so it is cheap and exact and is computed here. The **round wall-clock** half is a
 * measurement the leader took, so it is read from the stored verdict and never invented.
 * Mixing the two would produce a report whose halves came from different instants without
 * saying so.
 *
 * @param {object} req
 * @param {object} shard the `Shard` row
 * @returns {object}
 */
function sizingReport(req, shard) {
  const stored = shard.sizingDetail && shard.sizingDetail.bounds ? shard.sizingDetail.bounds : {};
  const storedRound = stored[sizing.BOUND.ROUND_WALL_CLOCK] || null;

  const evaluation = sizing.evaluate({
    serialCommit: {
      agents: shard.agentCount,
      missionRatePerAgentHour: resolveParam(req, "shard.mission_rate_per_agent_hour", shard.regionId),
      txnPerMissionLifecycle: resolveParam(req, "shard.txn_per_mission_lifecycle", shard.regionId),
      commitTxnServiceTimeMs: resolveParam(req, "shard.commit_txn_service_time", shard.regionId),
      maxSerialUtilisation: resolveParam(req, "commit.max_serial_utilisation", shard.regionId),
    },
    roundWallClock: {
      observedRoundWallClockP99Ms: storedRound && storedRound.evaluated ? storedRound.observedMs : undefined,
      roundWallClockBudgetMs: resolveParam(req, "perf.round_wall_clock_p99", shard.regionId),
      samples: storedRound ? storedRound.samples : undefined,
    },
  });

  const minAgents = resolveParam(req, "shard.min_agents", shard.regionId);
  const maxAgents = resolveParam(req, "shard.max_agents", shard.regionId);

  return {
    ...evaluation,
    // §3.5's stated operating range, reported beside the derived bound so the two are
    // distinguishable: the upper bound is arithmetic, the lower is an operating-cost
    // judgement, and only the first invalidates anything if crossed.
    configuredRange: { minAgents: minAgents ?? null, maxAgents: maxAgents ?? null },
    belowOperatingFloor: Number.isFinite(minAgents) ? shard.agentCount < minAgents : null,
    // What the leader itself last recorded, so a disagreement between the live arithmetic
    // and the stored verdict is visible rather than silently resolved in favour of one.
    asRecordedByLeader: {
      bindingBound: shard.bindingBound,
      checkedAt: shard.sizingCheckedAt,
      detail: shard.sizingDetail,
    },
  };
}

/**
 * GET /api/shards
 *
 * Every shard: membership, leader, both sizing bounds with the binding one reported.
 */
const list = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const shards = await shardModel.readShards({ prisma });

  const rows = [];
  for (const shard of shards) {
    // eslint-disable-next-line no-await-in-loop
    const record = await readLeadershipRow(prisma, shard.shardId);
    // eslint-disable-next-line no-await-in-loop
    const currentMembers = await prisma.shardMembership.count({
      where: { shardId: shard.shardId, supersededAt: null },
    });
    // §19.2's open intent, so a shard reading DRAINING or REBALANCING says *why*. A state
    // with no visible cause is the state P13-R4 left behind.
    // eslint-disable-next-line no-await-in-loop
    const openRebalance = await shardModel.readOpenRebalance(prisma, shard.shardId);

    const described = shardModel.describe({
      shard,
      leadership: record,
      sizing: sizingReport(req, shard),
      rebalance: openRebalance,
    });

    rows.push({
      ...described,
      membership: {
        // Both, because they can disagree and the disagreement is a defect worth seeing:
        // the denormalised count is what §3.5's bound is evaluated against, and the row
        // count is the truth. A drift means a handoff wrote one and not the other.
        countedOnShardRow: shard.agentCount,
        currentMembershipRows: currentMembers,
        consistent: shard.agentCount === currentMembers,
      },
    });
  }

  return res.json({
    section: "§3.5 · §19",
    shardCount: rows.length,
    // The honest answer for a deployment that has published no shard definitions: there is
    // one shard, it is `leadership.DEFAULT_SHARD_ID`, and intake routes every Leg to it.
    // Reporting an empty list without saying so would read as "this fleet has no shards".
    singleShardDeployment: rows.length === 0,
    defaultShardId: leadership.DEFAULT_SHARD_ID,
    shards: rows,
    note:
      "both §3.5 bounds are reported for every shard and the binding one is named. The round wall-clock bound is " +
      "measured, so it reads as unevaluated until the shard's leader has recorded a measurement; an unevaluated " +
      "bound is never reported as satisfied.",
  });
});

/**
 * Does this deployment hold the §23.3 key the supervisor will need to sign the
 * `SHARD_MIGRATE` commands this plan implies?
 *
 * Checked **here**, before anything durable is written, rather than discovered by the
 * supervisor one tick later. An intent recorded against a deployment that cannot execute it
 * is a shard taken out of service for a plan nothing will carry out — the precise shape of
 * P13-R4, reached through a missing secret instead of through a missing table.
 *
 * @returns {boolean}
 */
function commandSigningKeyPresent() {
  const key = process.env.COMMAND_SIGNING_KEY;
  return typeof key === "string" && key.trim().length > 0;
}

/**
 * POST /api/shards/:id/rebalance
 *
 * Records a durable intent and returns the ordered plan. **Moves nothing.** See the module
 * header for why an HTTP request is the wrong place to perform a migration, and for why
 * the intent is a row rather than a response body.
 *
 * `{ "cancel": true }` withdraws the open intent and restores the shard.
 */
const rebalance = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const shardId = String(req.params.id);
  const body = req.body || {};
  const at = new Date();

  const shard = await shardModel.readShard({ prisma }, shardId);
  if (!shard) {
    return res.status(HTTP_NOT_FOUND).json({ ok: false, message: `no shard "${shardId}"` });
  }

  // ── The withdrawal form ───────────────────────────────────────────────────
  // The route back. Restores the shard to the state recorded when the intent was opened,
  // and leaves every agent already migrated where it now is — a rebalance is a sequence of
  // independently committed handoffs, not a transaction to roll back (§19.2).
  if (body.cancel === true) {
    const open = await shardModel.readOpenRebalance(prisma, shardId);
    if (!open) {
      return res.status(HTTP_UNPROCESSABLE).json({
        ok: false,
        refusal: shardModel.REBALANCE_REFUSAL.NOT_OPEN,
        state: shard.state,
        message:
          `shard "${shardId}" has no open rebalance to cancel. Its state is ${shard.state}; if that is not a serving ` +
          "state, it was not this mechanism that put it there.",
      });
    }
    const closed = await shardModel.closeRebalance({ prisma }, {
      rebalance: open,
      state: shardModel.REBALANCE_STATE.CANCELLED,
      at,
      closedReason: `cancelled by ${req.user && req.user.id ? String(req.user.id) : "an operator"}${body.reason ? `: ${String(body.reason)}` : ""}`,
    });
    return res.status(200).json({
      ok: true,
      section: "§19.2",
      shardId,
      cancelled: closed.closed,
      shardRestoredTo: closed.shardRestoredTo,
      completedMoves: open.completedMoves,
      plannedMoves: open.plannedMoves,
      note:
        "the intent is withdrawn and the shard is serving again. Agents already migrated stay in the target shard: " +
        "each handoff was its own committed transaction with its own authority_epoch advance, and there is no " +
        "operation that un-advances one (§19.2, §10.3.1).",
    });
  }

  const targetShardId = String(body.targetShardId || "");
  const target = targetShardId ? await shardModel.readShard({ prisma }, targetShardId) : null;
  if (!target) {
    return res.status(HTTP_UNPROCESSABLE).json({
      ok: false,
      message:
        "a rebalance names the shard the agents move to. §19.2 makes rebalancing a transactional handoff between " +
        "two shards; there is no operation that removes an agent from a shard without placing it in another, " +
        "because §3.5 requires every agent to belong to exactly one shard at a time.",
    });
  }
  if (!shardModel.admitsNewWork(target.state)) {
    return res.status(HTTP_UNPROCESSABLE).json({
      ok: false,
      message: `the target shard is ${target.state} and does not admit members (§3.5).`,
    });
  }
  if (target.shardId === shard.shardId) {
    return res.status(HTTP_UNPROCESSABLE).json({
      ok: false,
      message:
        "the source and target shards are the same. Every migration advances an authority_epoch, invalidating " +
        "every mission authority the agent holds; performing that for a handoff that changes nothing is a cost " +
        "with no purpose (§19.2).",
    });
  }

  // §23.3 — refused before anything durable happens. See `commandSigningKeyPresent`.
  if (!commandSigningKeyPresent()) {
    return res.status(HTTP_UNPROCESSABLE).json({
      ok: false,
      message:
        "this deployment declares no COMMAND_SIGNING_KEY, so the shardSupervisor cannot sign the SHARD_MIGRATE " +
        "commands this plan implies (§23.3, §11.1). Recording an intent that nothing can execute would take the " +
        "shard out of service for a plan nobody can carry out, so it is refused here rather than discovered a tick " +
        "later.",
    });
  }

  const members = await membership.membersOf(prisma, { shardId, take: MAX_PLAN_MOVES });

  // How many live commitments each candidate holds, so the plan can move idle agents first.
  const liveCommitmentCountByAgentId = {};
  for (const member of members) {
    // eslint-disable-next-line no-await-in-loop
    liveCommitmentCountByAgentId[member.agentId] = await prisma.commitment.count({
      where: { agentId: member.agentId, releasedAt: null },
    });
  }

  const surplus = Number.isInteger(body.moveCount)
    ? Math.min(body.moveCount, MAX_PLAN_MOVES)
    : Math.min(members.length, MAX_PLAN_MOVES);

  const plan = membership.planRebalance({
    members,
    liveCommitmentCountByAgentId,
    surplus,
    targetShardId: target.shardId,
    reason: body.reason || shardModel.MEMBERSHIP_REASON.REBALANCE_MERGE,
    // §2.5's accountable transfer, asked for explicitly or not at all. Carried onto every
    // move so the supervisor does not have to re-derive an operator's consent.
    allowCustodyTransfer: body.allowCustodyTransfer === true,
  });

  // A plan with no move in it changes nothing — and must therefore change nothing durably
  // either. Moving the shard out of a serving state for an empty plan is the stranding this
  // endpoint used to produce whenever the source shard had no members.
  if (plan.moves.length === 0) {
    return res.status(HTTP_UNPROCESSABLE).json({
      ok: false,
      refusal: shardModel.REBALANCE_REFUSAL.EMPTY_PLAN,
      shardId,
      targetShardId: target.shardId,
      state: shard.state,
      plan,
      memberCount: members.length,
      message:
        `shard "${shardId}" has ${members.length} current member(s) and the request plans ${surplus} move(s), so ` +
        "there is nothing to migrate. The shard's state is unchanged: taking it out of service for an empty plan " +
        "would be a drain with nothing draining it.",
    });
  }

  // Recording the intent is the one durable act this endpoint performs, and it is now two
  // writes in one transaction: the `ShardRebalance` row the supervisor executes, and the
  // shard state that stops intake routing new Legs to a shard giving its agents away.
  const opened = await shardModel.openRebalance({ prisma }, {
    shard,
    targetShardId: target.shardId,
    plan,
    memberCount: members.length,
    reason: plan.moves[0].reason,
    requestedBy: req.user && req.user.id ? String(req.user.id) : "control-plane",
    at,
    detail: { requestedMoveCount: surplus, memberCount: members.length },
  });

  if (!opened.ok) {
    return res.status(HTTP_UNPROCESSABLE).json({
      ok: false,
      refusal: opened.refusal,
      shardId,
      open: shardModel.describeRebalance(opened.rebalance),
      message:
        "a rebalance is already open for this shard. Two concurrent plans over one membership set would order the " +
        "second against agents the first is already moving, and their union is the bulk reassignment §19.2 forbids " +
        'reached by issuing two requests. Cancel the open one with { "cancel": true } first.',
    });
  }

  return res.status(202).json({
    ok: true,
    section: "§19.2",
    shardId,
    targetShardId: target.shardId,
    state: opened.shard.state,
    rebalance: shardModel.describeRebalance(opened.rebalance),
    plan,
    executed: false,
    // Stated rather than implied. A 202 that a caller read as "done" would be a caller
    // that believed four hundred agents had moved inside one request.
    note:
      "the intent is recorded **durably** and the plan is returned; **no agent has moved**. §19.2 requires migration " +
      "one agent at a time, and the shardSupervisor worker performs the moves at the pace " +
      "`shard.migration_min_interval` sets, resuming across restarts and leadership changes. When the last move is " +
      `resolved the shard is restored to ${opened.rebalance.restoreState}. Poll GET /api/shards to watch the ` +
      'membership counts change, or POST { "cancel": true } here to withdraw it.',
  });
});

module.exports = {
  list,
  rebalance,
  sizingReport,
  MAX_PLAN_MOVES,
};

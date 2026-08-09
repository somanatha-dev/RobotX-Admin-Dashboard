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

    const described = shardModel.describe({ shard, leadership: record, sizing: sizingReport(req, shard) });

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
 * POST /api/shards/:id/rebalance
 *
 * Records the intent and returns the ordered plan. **Moves nothing.** See the module
 * header for why an HTTP request is the wrong place to perform a migration.
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
  });

  // Recording the intent is the one durable act this endpoint performs. A source shard
  // that is giving away every agent is DRAINING and must stop accepting new Legs at
  // intake; one giving away some is REBALANCING and still serves.
  const nextState =
    surplus >= members.length && members.length > 0
      ? shardModel.SHARD_STATE.DRAINING
      : shardModel.SHARD_STATE.REBALANCING;
  const updated = await shardModel.setState({ prisma }, { shardId, state: nextState, at });

  return res.status(202).json({
    ok: true,
    section: "§19.2",
    shardId,
    targetShardId: target.shardId,
    state: updated.state,
    plan,
    executed: false,
    // Stated rather than implied. A 202 that a caller read as "done" would be a caller
    // that believed four hundred agents had moved inside one request.
    note:
      "the intent is recorded and the plan is returned; **no agent has moved**. §19.2 requires migration one " +
      "agent at a time, and the shardSupervisor worker performs the moves at the pace " +
      "`shard.migration_min_interval` sets. Poll GET /api/shards to watch the membership counts change.",
  });
});

module.exports = {
  list,
  rebalance,
  sizingReport,
  MAX_PLAN_MOVES,
};

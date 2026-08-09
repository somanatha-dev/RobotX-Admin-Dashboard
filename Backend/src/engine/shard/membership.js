"use strict";

/**
 * Shard membership — the transactional handoff (§3.5, §19.2) — **Tier 1**.
 *
 * > Every Agent belongs to exactly one shard at a time. Shard membership changes are
 * > explicit, transactional handoffs, **never inferred from position drift**.
 *
 * > Shard rebalancing (splitting a hot shard, merging quiet ones) is an explicit,
 * > transactional control-plane operation that migrates agents **one at a time**,
 * > advancing each migrated agent's **`authority_epoch`** — the agent-scope fence
 * > (§10.3.1) — never a bulk reassignment. Migration is precisely the case the agent-scope
 * > fence exists for: it changes who may command the agent at all, so it must invalidate
 * > every mission authority the agent holds, which advancing `authority_epoch` does in one
 * > action. Migration correctness then follows from guard G3 (§10.3.2): an agent migrated
 * > mid-round has a changed `authority_epoch`, so the old shard's pending commitment fails
 * > its guard.
 *
 * ── "One at a time" is a signature, not a comment ───────────────────────────
 * `migrate()` takes **one** agent id. There is no batch form and no array parameter,
 * because a bulk reassignment is not a slower version of the right thing — it is the
 * thing §19.2 names and forbids. A caller that wants to move a hundred agents calls this a
 * hundred times, paced by the supervisor, and each call is its own transaction that either
 * fully happened or did not. `assertNotBulk()` exists so a future edit that adds a batch
 * parameter fails a test rather than shipping.
 *
 * ── Everything in one transaction, and what "everything" is ─────────────────
 * A migration is five writes and they are indivisible:
 *
 *   1. Advance the agent's `authority_epoch` (§10.3.1, §19.2).
 *   2. Supersede the current `ShardMembership` row.
 *   3. Insert the new one, recording both epochs.
 *   4. **Suppress the agent's outstanding outbox rows.** They were authorised under the
 *      superseded authority; delivering them would send commands the agent is now
 *      required to reject, which shows up as a rising fence-rejection baseline — the
 *      thing invariant I5's verification is watching for.
 *   5. Enqueue the `SHARD_MIGRATE` command, carrying the new `authority_epoch` and the
 *      `fence_floor` §10.3.1's interaction rule requires beside it.
 *
 * Splitting any of these would leave a window: an epoch advanced without a command is an
 * agent nobody told; a command enqueued without the advance is a command carrying an
 * authority that does not exist (§4.1 rule 5 — "no external side effect precedes the
 * guarded write that authorises it").
 *
 * ── What this module never does ─────────────────────────────────────────────
 * It never infers membership from an agent's position, never moves an agent whose
 * commitments it has not accounted for without saying so, and never touches
 * `fence_counter`. §10.3.1 keeps the two scopes orthogonal, and a migration that bumped
 * the commitment-scope counter would invalidate commitments *within* the new shard as
 * well as the old one's authority.
 */

const fencing = require("../commitment/fencing");
const clock = require("../commitment/clock");
const commandSigning = require("../security/commandSigning");
const outbox = require("../dispatch/outbox");
const sequence = require("../dispatch/sequence");
const shardModel = require("./shardModel");

/** §10.3.1 row 2 — the agent-scope command a migration issues. @structural the command name */
const MIGRATE_COMMAND = "SHARD_MIGRATE";

/** Why a migration was refused. @structural refusal labels */
const REFUSAL = Object.freeze({
  NO_AGENT: "AGENT_NOT_FOUND",
  NO_SOURCE_MEMBERSHIP: "AGENT_HAS_NO_CURRENT_MEMBERSHIP",
  ALREADY_THERE: "AGENT_IS_ALREADY_IN_THIS_SHARD",
  TARGET_UNKNOWN: "TARGET_SHARD_DOES_NOT_EXIST",
  TARGET_NOT_ACCEPTING: "TARGET_SHARD_DOES_NOT_ADMIT_MEMBERS",
  HOLDS_CUSTODY: "AGENT_HOLDS_CUSTODY",
  CONCURRENT_MIGRATION: "MEMBERSHIP_CHANGED_CONCURRENTLY",
});

/**
 * The custody states that make a migration an operator decision rather than a control-plane
 * one, mirroring §2.5's `holdsGoods` partition.
 *
 * A migrating agent's `authority_epoch` advance invalidates every mission authority it
 * holds. For an agent carrying goods that is a custody event: the new shard's coordinator
 * inherits a physical obligation it did not create, and §2.5 is explicit that custody
 * transfers are accountable rather than implicit. The migration is not *forbidden* — a
 * region can be redistricted around a loaded agent — but it must be asked for explicitly,
 * which `allowCustodyTransfer` is.
 * @structural the custody states that hold goods (§2.5)
 */
const HOLDING_CUSTODY_STATES = Object.freeze(["DISPUTED", "HELD"]);

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * The agent's current membership row, or null if it has never been placed.
 *
 * @param {object} client a Prisma client or transaction client
 * @param {string} agentId the `Agent.id`
 * @returns {Promise<object|null>}
 */
async function currentMembership(client, agentId) {
  return client.shardMembership.findFirst({
    where: { agentId: String(agentId), supersededAt: null },
    orderBy: { movedAt: "desc" },
  });
}

/**
 * Which shard owns this agent right now?
 *
 * Returns null rather than a default. §3.5 makes membership an explicit fact, and an
 * agent with no membership row belongs to no shard — which is a real state (an agent
 * commissioned but not yet placed) and a different one from "the default shard".
 *
 * @param {object} client
 * @param {string} agentId
 * @returns {Promise<string|null>}
 */
async function shardOf(client, agentId) {
  const row = await currentMembership(client, agentId);
  return row ? row.shardId : null;
}

/**
 * The agents currently in a shard.
 *
 * @param {object} client
 * @param {object} input `{ shardId, take? }`
 * @returns {Promise<object[]>}
 */
async function membersOf(client, input) {
  const settings = input || {};
  return client.shardMembership.findMany({
    where: { shardId: String(settings.shardId), supersededAt: null },
    orderBy: { movedAt: "asc" },
    ...(Number.isInteger(settings.take) ? { take: settings.take } : {}),
  });
}

/**
 * Place an agent in a shard for the first time (§3.5).
 *
 * Distinct from `migrate()` and deliberately weaker: an initial placement supersedes no
 * authority, so it advances no `authority_epoch` and issues no command. There is nothing
 * to tell the agent — no coordinator was previously entitled to command it, so no
 * previously-issued authority needs invalidating. The migration's CHECK constraint encodes
 * exactly this exemption (`fromShardId IS NULL OR authorityEpochAfter > authorityEpochBefore`).
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ agentId, shardId, at, movedBy }`
 * @returns {Promise<{ ok: boolean, refusal: string|null, membership: object|null }>}
 */
async function place(deps, input) {
  const settings = input || {};
  const agentId = String(settings.agentId);

  const agent = await deps.prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) return { ok: false, refusal: REFUSAL.NO_AGENT, membership: null };

  const existing = await currentMembership(deps.prisma, agentId);
  if (existing) {
    return existing.shardId === String(settings.shardId)
      ? { ok: true, refusal: null, membership: existing }
      : { ok: false, refusal: REFUSAL.ALREADY_THERE, membership: existing };
  }

  const membership = await deps.prisma.shardMembership.create({
    data: {
      agentId,
      shardId: String(settings.shardId),
      fromShardId: null,
      movedAt: settings.at,
      supersededAt: null,
      authorityEpochBefore: BigInt(agent.authorityEpoch),
      authorityEpochAfter: BigInt(agent.authorityEpoch),
      reason: shardModel.MEMBERSHIP_REASON.COMMISSIONING,
      movedBy: String(settings.movedBy || "commissioning"),
      outboxIdempotencyKey: null,
      detail: {
        note:
          "initial placement: no previous coordinator held authority over this agent, so there is no authority to " +
          "supersede and no command to issue (§19.2)",
      },
    },
  });

  return { ok: true, refusal: null, membership };
}

/**
 * Assess a migration without performing it — the checks that do not need the row lock.
 *
 * Separated so the supervisor can decide *which* agent to move next without opening a
 * transaction per candidate, and so a refusal is a value the caller can report rather than
 * an exception it has to catch.
 *
 * @param {object} input `{ agent, membership, targetShard, allowCustodyTransfer, legCustodyStates }`
 * @returns {{ ok: boolean, refusal: string|null, detail: string|null }}
 */
function assessMigration(input) {
  const source = input || {};

  if (!source.agent) return { ok: false, refusal: REFUSAL.NO_AGENT, detail: "no such agent" };
  if (!source.membership) {
    return {
      ok: false,
      refusal: REFUSAL.NO_SOURCE_MEMBERSHIP,
      detail:
        "the agent has no current membership, so this is a placement rather than a migration. place() is the " +
        "operation for that, and it deliberately advances no authority_epoch.",
    };
  }
  if (!source.targetShard) {
    return { ok: false, refusal: REFUSAL.TARGET_UNKNOWN, detail: "the target shard has no row" };
  }
  if (source.membership.shardId === source.targetShard.shardId) {
    return {
      ok: false,
      refusal: REFUSAL.ALREADY_THERE,
      detail:
        "the agent is already in this shard. Admitting the move would burn an authority_epoch — invalidating every " +
        "mission authority the agent holds — for a handoff that changed nothing (§19.2).",
    };
  }
  if (!shardModel.admitsNewWork(source.targetShard.state)) {
    return {
      ok: false,
      refusal: REFUSAL.TARGET_NOT_ACCEPTING,
      detail:
        `the target shard is ${source.targetShard.state}. Moving an agent into a shard that is draining or retired ` +
        "would place supply under a coordinator that is giving its agents away.",
    };
  }

  const holding = (source.legCustodyStates || []).filter((state) => HOLDING_CUSTODY_STATES.includes(state));
  if (holding.length > 0 && source.allowCustodyTransfer !== true) {
    return {
      ok: false,
      refusal: REFUSAL.HOLDS_CUSTODY,
      detail:
        `the agent holds custody (${[...new Set(holding)].sort().join(", ")}). Migrating it hands a physical ` +
        "obligation to a coordinator that did not create it, which §2.5 makes an accountable transfer rather than " +
        "an implicit one. Pass allowCustodyTransfer to ask for it explicitly; the migration is not forbidden, only " +
        "not automatic.",
    };
  }

  return { ok: true, refusal: null, detail: null };
}

/**
 * Migrate **one** agent to another shard.
 *
 * @param {object} deps
 * @param {object} deps.prisma
 * @param {(client: object, fn: Function, options?: object) => Promise<*>} deps.runSerializable
 * @param {(tx: object, table: string, column: string, value: string) => Promise<object|null>} deps.selectForUpdate
 * @param {object} input
 * @param {string} input.agentId the `Agent.id`. **Singular. See the module header.**
 * @param {string} input.targetShardId
 * @param {string} input.reason a `shardModel.MEMBERSHIP_REASON`
 * @param {string} input.movedBy
 * @param {Date} input.storeTime
 * @param {number} input.commandTtlSeconds `dispatch.offer_ttl` or the agent-command equivalent
 * @param {string|Buffer} input.signingKey §23.3
 * @param {boolean} [input.allowCustodyTransfer]
 * @returns {Promise<object>} the outcome
 */
async function migrate(deps, input) {
  const settings = input || {};
  assertNotBulk(settings);

  if (!isNonEmptyString(settings.reason) || !Object.values(shardModel.MEMBERSHIP_REASON).includes(settings.reason)) {
    throw new TypeError(
      `"${String(settings.reason)}" is not a membership reason (§22.3 makes shard definition a STRUCTURAL change, ` +
        `and a structural change with no recorded cause is one nobody can audit). One of: ` +
        `${Object.values(shardModel.MEMBERSHIP_REASON).join(", ")}.`,
    );
  }
  if (settings.reason === shardModel.PLACEMENT_REASON) {
    throw new TypeError(
      "COMMISSIONING is the reason for an initial placement, not for a migration. place() is that operation, and " +
        "the distinction is load-bearing: a placement advances no authority_epoch because it supersedes no " +
        "authority, and the migration CHECK constraint encodes exactly that exemption.",
    );
  }

  const agentId = String(settings.agentId);
  const targetShardId = String(settings.targetShardId);

  return deps.runSerializable(deps.prisma, async (tx) => {
    // The agent row under a write lock, exactly as the commit transaction takes it
    // (§10.3.2 step 1). Without it, two control-plane operations could each read the same
    // `authority_epoch` and each advance it to the same value — producing two migrations
    // one of which is invisible, and an epoch that did not advance monotonically (I6).
    const agent = await deps.selectForUpdate(tx, "Agent", "id", agentId);

    const membership = agent ? await currentMembership(tx, agentId) : null;
    const targetShard = await tx.shard.findUnique({ where: { shardId: targetShardId } });

    // The Legs this agent currently holds a live commitment on, so custody is assessed
    // against what it is actually carrying rather than against a flag.
    const activeCommitments = agent
      ? await tx.commitment.findMany({ where: { agentId, releasedAt: null }, select: { legId: true } })
      : [];
    const legs = activeCommitments.length
      ? await tx.leg.findMany({
          where: { id: { in: activeCommitments.map((row) => row.legId) } },
          select: { id: true, custodyState: true },
        })
      : [];

    const assessment = assessMigration({
      agent,
      membership,
      targetShard,
      allowCustodyTransfer: settings.allowCustodyTransfer,
      legCustodyStates: legs.map((leg) => leg.custodyState),
    });
    if (!assessment.ok) {
      return Object.freeze({ ok: false, ...assessment, membership: null, command: null });
    }

    // §10.3.1 / §19.2 — the agent-scope fence advances. `fence_counter` is deliberately
    // untouched: the two scopes are orthogonal, and bumping the commitment counter here
    // would invalidate commitments in the *new* shard as well as authority in the old one.
    const epochBefore = BigInt(agent.authorityEpoch);
    const epochAfter = epochBefore + BigInt(1);
    const fenceFloor = BigInt(agent.fenceCounter);

    await tx.agent.update({ where: { id: agentId }, data: { authorityEpoch: epochAfter } });

    // Invariant I6's persisted high-water mark, written in the same transaction as the
    // counter it records — the arrangement Phase 3 established and every later fence
    // writer preserves.
    await tx.agentFenceAudit.upsert({
      where: { agentId },
      create: {
        agentId,
        fenceHighWater: fenceFloor,
        epochHighWater: epochAfter,
        lastFenceSource: `${MIGRATE_COMMAND}:${targetShardId}`,
        observedAt: settings.storeTime,
      },
      update: {
        epochHighWater: epochAfter,
        lastFenceSource: `${MIGRATE_COMMAND}:${targetShardId}`,
        observedAt: settings.storeTime,
      },
    });

    // Supersede the current membership **conditionally on it still being current**. The
    // partial unique index would reject a second current row anyway; this makes the loser
    // of a race a reported refusal rather than a constraint violation the caller has to
    // decode.
    const superseded = await tx.shardMembership.updateMany({
      where: { id: membership.id, supersededAt: null },
      data: { supersededAt: settings.storeTime },
    });
    if (superseded.count !== 1) {
      return Object.freeze({
        ok: false,
        refusal: REFUSAL.CONCURRENT_MIGRATION,
        detail:
          "the agent's membership changed between the assessment and the write. One migration at a time per agent " +
          "is what the partial unique index enforces; this is that enforcement reported as an outcome.",
        membership: null,
        command: null,
      });
    }

    // §11.5 — the outstanding commands were authorised under the superseded authority.
    // Delivering them would send the agent commands it is now required to reject, which
    // is a fence-rejection *baseline* rather than a spike, and I5's verification is
    // watching exactly that.
    const suppressed = await outbox.suppressOutstandingForAgent(tx, {
      agentId,
      reason: `SHARD_MIGRATE:${membership.shardId}->${targetShardId}`,
    });

    const allocated = await sequence.allocate(tx, { command: MIGRATE_COMMAND, agentId });
    const notValidAfter = clock.deadlineFrom(settings.storeTime, settings.commandTtlSeconds);

    const payload = {
      command: MIGRATE_COMMAND,
      fromShardId: membership.shardId,
      toShardId: targetShardId,
      reason: settings.reason,
      // §10.3.1 — "On accepting an agent-scope command the agent (a) records the new
      // `authority_epoch`, (b) sets its local `fence_floor` to the value carried, and
      // (c) discards its per-commitment authority table."
      authorityEpoch: epochAfter.toString(),
      fenceFloor: fenceFloor.toString(),
      issuedAt: settings.storeTime.toISOString(),
    };

    const envelope = {
      agentId,
      command: MIGRATE_COMMAND,
      commandClass: fencing.commandClassOf(MIGRATE_COMMAND),
      fenceScope: fencing.fenceScopeOf(MIGRATE_COMMAND),
      commitmentId: null,
      fence: null,
      authorityEpoch: epochAfter,
      fenceFloor,
      sequence: allocated,
      notValidAfter,
      payload,
    };
    const signature = commandSigning.sign(envelope, settings.signingKey);

    const row = await outbox.enqueue(
      tx,
      outbox.buildRow({
        command: MIGRATE_COMMAND,
        agentId,
        authorityEpoch: epochAfter,
        fenceFloor,
        sequence: allocated,
        payload,
        notValidAfter,
        signature,
      }),
    );

    const created = await tx.shardMembership.create({
      data: {
        agentId,
        shardId: targetShardId,
        fromShardId: membership.shardId,
        movedAt: settings.storeTime,
        supersededAt: null,
        authorityEpochBefore: epochBefore,
        authorityEpochAfter: epochAfter,
        reason: settings.reason,
        movedBy: String(settings.movedBy || "control-plane"),
        outboxIdempotencyKey: row.idempotencyKey,
        detail: {
          suppressedOutboxRows: suppressed,
          liveCommitments: activeCommitments.length,
          custodyStates: [...new Set(legs.map((leg) => leg.custodyState))].sort(),
          note:
            "migration correctness follows from guard G3 (§10.3.2): the old shard's pending commitment for this " +
            "agent now carries a superseded authority_epoch and fails its guard.",
        },
      },
    });

    // Membership counts, maintained here so "how big is this shard" is not a table scan
    // on the availability path. Both are conditional writes on the row, and both are in
    // this transaction: a count that drifted from the membership rows would be a second
    // answer to a question §3.5 sizes shards against.
    await tx.shard.update({ where: { shardId: membership.shardId }, data: { agentCount: { decrement: 1 } } });
    await tx.shard.update({ where: { shardId: targetShardId }, data: { agentCount: { increment: 1 } } });

    return Object.freeze({
      ok: true,
      refusal: null,
      detail: null,
      agentId,
      fromShardId: membership.shardId,
      toShardId: targetShardId,
      authorityEpochBefore: epochBefore,
      authorityEpochAfter: epochAfter,
      fenceFloor,
      suppressedOutboxRows: suppressed,
      membership: created,
      command: row,
      sentence:
        `agent ${agentId} moved ${membership.shardId} → ${targetShardId}; authority_epoch ${epochBefore} → ` +
        `${epochAfter}, fence_floor ${fenceFloor}, ${suppressed} outstanding command(s) suppressed. Every mission ` +
        "authority issued under the old shard's coordinator is now superseded (§10.3.1, §19.2).",
    });
  });
}

/**
 * Refuse a request shaped like a bulk reassignment.
 *
 * §19.2 forbids one by name. The refusal is by *signature* rather than by convention:
 * `agentId` must be a single string, and an array — however it arrives — is rejected
 * before any write. A future edit that added a batch parameter would have to remove this
 * function, which a test asserts is still called.
 *
 * @param {object} request
 * @returns {void}
 * @throws {TypeError} on anything that is not exactly one agent
 */
function assertNotBulk(request) {
  const source = request || {};
  if (Array.isArray(source.agentId) || Array.isArray(source.agentIds) || source.agentIds !== undefined) {
    throw new TypeError(
      "migration takes one agent. §19.2: rebalancing \"migrates agents one at a time, advancing each migrated " +
        'agent\'s `authority_epoch` — the agent-scope fence (§10.3.1) — **never a bulk reassignment**." A batch ' +
        "form is not a faster version of this operation; it is the operation the specification forbids. Call this " +
        "once per agent, paced by the supervisor.",
    );
  }
  if (!isNonEmptyString(source.agentId)) {
    throw new TypeError("migration takes one Agent.id");
  }
}

/**
 * Rebalance planning: which agents should move, in what order, to bring a shard back
 * inside its binding bound.
 *
 * Returns an **ordered list of single migrations**, not a batch. The distinction is the
 * one the module header makes: the plan is a sequence of operations the supervisor
 * performs one at a time, each its own transaction, each individually abandonable. A plan
 * that returned "move these 400" would be a bulk reassignment with a planning step in
 * front of it.
 *
 * Ordering: agents with no live commitment first, then the rest. Moving an idle agent
 * costs nothing beyond the epoch advance; moving a committed one invalidates a mission
 * authority that a round is currently relying on, and G3 will abort that round's commit.
 * Both are correct; only one is free.
 *
 * @param {object} input `{ members, liveCommitmentCountByAgentId, surplus, targetShardId, reason }`
 * @returns {{ moves: object[], surplus: number, note: string }}
 */
function planRebalance(input) {
  const source = input || {};
  const counts = source.liveCommitmentCountByAgentId || {};
  const surplus = Number.isInteger(source.surplus) ? Math.max(0, source.surplus) : 0;

  const ordered = [...(source.members || [])].sort((a, b) => {
    const left = Number(counts[a.agentId] || 0);
    const right = Number(counts[b.agentId] || 0);
    if (left !== right) return left - right;
    // Deterministic tie-break, so a rebalance plan replays identically (T6).
    return String(a.agentId).localeCompare(String(b.agentId));
  });

  const moves = ordered.slice(0, surplus).map((member, index) => ({
    order: index,
    agentId: member.agentId,
    fromShardId: member.shardId,
    targetShardId: String(source.targetShardId),
    reason: source.reason || shardModel.MEMBERSHIP_REASON.REBALANCE_SPLIT,
    liveCommitments: Number(counts[member.agentId] || 0),
  }));

  return {
    moves,
    surplus,
    note:
      "an ordered list of single migrations, performed one at a time and each in its own transaction (§19.2). " +
      "Idle agents move first: moving a committed agent invalidates a mission authority a round is relying on, " +
      "which guard G3 then aborts — correct, but not free.",
  };
}

module.exports = {
  MIGRATE_COMMAND,
  REFUSAL,
  HOLDING_CUSTODY_STATES,
  currentMembership,
  shardOf,
  membersOf,
  place,
  assessMigration,
  migrate,
  assertNotBulk,
  planRebalance,
};

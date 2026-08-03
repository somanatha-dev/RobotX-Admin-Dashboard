"use strict";

/**
 * Shard leadership — the minimal Phase 3 form (§19.3, §19.5).
 *
 * > **Near-circular dependency — resolved.** Guard G1 requires
 * > `shard.leadership_fence`, which belongs to the shard model (Phase 13). Resolution:
 * > Phase 3 creates the `ShardLeadership` table with a **single static shard row and a
 * > manually-advanced fence**, and implements G1 against it. Phase 13 replaces the
 * > static row with real leader election. **G1's code does not change.**
 *
 * That last sentence is the design constraint on this module. Everything G1 needs is
 * `readLeadershipFence`, which returns a number from a row; nothing about *how* the row
 * came to hold that number is visible to the guard. Phase 13 replaces `acquire` and
 * `advanceFence` with consensus-backed election and G1 is untouched.
 *
 * ── What this module is not ─────────────────────────────────────────────────
 * It is not leader election. There is no consensus store here, no lease renewal loop,
 * no failover detection, and no split-brain protection beyond what G1 gives at the
 * database — which is, notably, the protection that actually matters:
 *
 * > Leadership itself is not left to the coordinator's own belief: guard G1 of the
 * > commit transaction re-reads the shard's leadership fence inside the transaction and
 * > aborts if it has advanced, so exclusivity of the writer is enforced by the database
 * > rather than inferred from a lease the writer thinks it still holds.
 *
 * Blocking decision B3 — which consensus store — is Phase 13's, and this module does
 * not pre-empt it.
 *
 * Tier 1 by path (`src/engine/`), serving a Tier 0 guarantee through G1.
 */

const clock = require("../commitment/clock");

/**
 * The single static shard the Phase 3 form operates. Phase 13 replaces this with real
 * membership (`ShardMembership`, `Shard`).
 * @structural the identifier of the single pre-sharding shard
 */
const DEFAULT_SHARD_ID = "default";

/**
 * Read the shard's leadership fence **inside a transaction**, for guard G1.
 *
 * The read is `FOR SHARE`, not a plain read and not `FOR UPDATE`: G1 needs the fence
 * to be stable for the remainder of the transaction — otherwise a leadership change
 * committing between the guard and the insert would slip through the exact window G1
 * exists to close — but it does not need to *block* other commits on the same shard,
 * which `FOR UPDATE` would serialise fleet-wide rather than per agent.
 *
 * @param {object} tx a transaction client
 * @param {string} [shardId]
 * @returns {Promise<{ shardId: string, leadershipFence: bigint, holder: string|null, leaseExpiry: Date|null }|null>}
 */
async function readLeadership(tx, shardId) {
  const id = shardId || DEFAULT_SHARD_ID;
  const rows = await tx.$queryRawUnsafe(
    'SELECT "shardId", "leadershipFence", "holder", "leaseExpiry" FROM "ShardLeadership" WHERE "shardId" = $1 FOR SHARE',
    id,
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0];
  return {
    shardId: row.shardId,
    leadershipFence: BigInt(row.leadershipFence),
    holder: row.holder === undefined ? null : row.holder,
    leaseExpiry: row.leaseExpiry === undefined || row.leaseExpiry === null ? null : new Date(row.leaseExpiry),
  };
}

/**
 * The fence alone, for a round that is pinning its snapshot.
 *
 * @param {object} tx
 * @param {string} [shardId]
 * @returns {Promise<bigint|null>}
 */
async function readLeadershipFence(tx, shardId) {
  const record = await readLeadership(tx, shardId);
  return record ? record.leadershipFence : null;
}

/**
 * Ensure the static shard row exists. Idempotent; the migration already inserts it,
 * and this exists so a database seeded before Phase 3, or a test store, converges to
 * the same state.
 *
 * @param {object} prisma
 * @param {{ shardId?: string }} [options]
 * @returns {Promise<object>}
 */
async function ensureShard(prisma, options) {
  const shardId = (options && options.shardId) || DEFAULT_SHARD_ID;
  return prisma.shardLeadership.upsert({
    where: { shardId },
    // §19.5 — the fence starts above zero so that "has not moved" is distinguishable
    // from "there is no leadership record".
    // @structural the initial leadership fence; see the migration's own note
    create: { shardId, leadershipFence: 1, lastAdvancedBy: "ensureShard", lastAdvancedAt: new Date() },
    update: {},
  });
}

/**
 * Advance the shard's leadership fence — the manual operation the Phase 3 form
 * provides in place of election.
 *
 * > Every shard has a monotonic `shard.leadership_fence`, advanced on each leadership
 * > change. […] Advancing the shard leadership fence does **not** advance any agent's
 * > `authority_epoch`. Leadership change concerns which coordinator may write, not
 * > which authority the agents are operating under, and per-agent bumps on failover
 * > would impose an O(agents) write burst on the failover path for no correctness gain
 * > — guard G1 already fences the outgoing leader's writes at the store.
 *
 * The two scopes are kept orthogonal on purpose, so this function touches no `Agent`
 * row. That is asserted by a test, because it is the kind of "helpful" addition a
 * later change might make.
 *
 * @param {object} prisma
 * @param {object} input
 * @param {string} [input.shardId]
 * @param {string} input.holder the coordinator taking the shard, or null to release
 * @param {string} input.advancedBy who or what advanced it, for the audit
 * @param {number} [input.leaseDurationSeconds] `shard.lease_duration`
 * @param {Date} [input.storeTime] the store's clock; required when a lease is granted
 * @returns {Promise<{ shardId: string, leadershipFence: bigint }>}
 */
async function advanceFence(prisma, input) {
  const settings = input || {};
  const shardId = settings.shardId || DEFAULT_SHARD_ID;

  const existing = await prisma.shardLeadership.findUnique({ where: { shardId } });
  if (!existing) {
    throw new Error(
      `shard "${shardId}" has no leadership record. G1 compares against a row; a missing row is not an ` +
        "advanced fence and must not be created implicitly by an advance (§19.5).",
    );
  }

  const next = BigInt(existing.leadershipFence) + BigInt(1);

  const leaseExpiry =
    settings.leaseDurationSeconds && settings.storeTime
      ? clock.deadlineFrom(settings.storeTime, settings.leaseDurationSeconds)
      : null;

  const updated = await prisma.shardLeadership.update({
    where: { shardId },
    data: {
      leadershipFence: next,
      holder: settings.holder === undefined ? existing.holder : settings.holder,
      leaseExpiry,
      lastAdvancedBy: settings.advancedBy || null,
      lastAdvancedAt: settings.storeTime || null,
    },
  });

  return { shardId, leadershipFence: BigInt(updated.leadershipFence) };
}

/**
 * §19.5 — a coordinator MUST stop committing *before* its lease expires, leaving a
 * margin of `time.max_clock_skew` plus the store's round-trip budget.
 *
 * > Stopping early narrows the window; **guard G1 closes it.** A liveness-based rule
 * > alone cannot establish a safety property.
 *
 * This function is therefore advisory by design: it is the liveness half. A caller
 * that ignored it entirely would still be fenced at the store by G1.
 *
 * @param {object} input
 * @param {Date|null} input.leaseExpiry
 * @param {Date} input.storeTime
 * @param {number} input.maxClockSkewMillis `time.max_clock_skew`
 * @param {number} [input.storeRoundTripMillis] measured budget; defaults to the skew allowance
 * @returns {{ shouldStop: boolean, reason: string|null, marginMillis: number }}
 */
function shouldStopCommitting(input) {
  const settings = input || {};
  const { leaseExpiry, storeTime, maxClockSkewMillis } = settings;
  const roundTrip =
    settings.storeRoundTripMillis === undefined || settings.storeRoundTripMillis === null
      ? maxClockSkewMillis
      : settings.storeRoundTripMillis;

  if (!leaseExpiry) {
    return { shouldStop: true, reason: "NO_LEADERSHIP_LEASE", marginMillis: 0 };
  }

  const margin = new Date(leaseExpiry).getTime() - storeTime.getTime() - maxClockSkewMillis - roundTrip;
  if (margin <= 0) {
    return {
      shouldStop: true,
      reason: "LEASE_MARGIN_EXHAUSTED",
      marginMillis: margin,
    };
  }
  return { shouldStop: false, reason: null, marginMillis: margin };
}

module.exports = {
  DEFAULT_SHARD_ID,
  readLeadership,
  readLeadershipFence,
  ensureShard,
  advanceFence,
  shouldStopCommitting,
};

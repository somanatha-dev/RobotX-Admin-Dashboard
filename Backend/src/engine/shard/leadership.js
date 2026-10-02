"use strict";

/**
 * Shard leadership — the durable leadership record and the compare-and-set primitives
 * an election is built from (§19.3, §19.5).
 *
 * > **Near-circular dependency — resolved.** Guard G1 requires
 * > `shard.leadership_fence`, which belongs to the shard model (Phase 13). Resolution:
 * > Phase 3 creates the `ShardLeadership` table with a **single static shard row and a
 * > manually-advanced fence**, and implements G1 against it. Phase 13 replaces the
 * > static row with real leader election. **G1's code does not change.**
 *
 * That last sentence is the design constraint on this module, and Phase 13 discharges it
 * rather than relaxing it. `readLeadership` and `readLeadershipFence` — the only two
 * functions guard G1 calls — are **unchanged, character for character**, and so is the
 * `ShardLeadership` table they read. What Phase 13 adds is below them: three conditional
 * writes that let a leader be *elected* instead of appointed. Everything G1 needs is
 * still a number in a row, and nothing about how the row came to hold that number is
 * visible to the guard.
 *
 * ── What Phase 13 adds, and the shape it adds it in ─────────────────────────
 * `tryAcquire`, `renewLease` and `releaseLease` are **compare-and-set operations on the
 * leadership row**, each conditional on the fence value the caller last observed. They
 * are the store-side half of leader election; the protocol — the renewal loop, the
 * margin discipline, the refusal to run against a store that cannot provide the
 * guarantee — is `election.js`'s, because that is where the reasoning about partitions
 * belongs and this is where the reasoning about rows belongs.
 *
 * ── The fence advances on acquisition and release, never on renewal ─────────
 * §19.5: "Every shard has a monotonic `shard.leadership_fence`, advanced on each
 * leadership change." A renewal is not a leadership change — it is the same leader
 * saying so again — and advancing on renewal would be catastrophic rather than merely
 * wasteful: G1 aborts a commit whose pinned fence has been superseded, so a leader that
 * advanced its own fence every few seconds would abort its own in-flight commits at
 * whatever rate it renewed. Acquisition and release *are* leadership changes and both
 * advance, which is what fences an outgoing leader at the instant it stands down rather
 * than at the instant its lease would have lapsed.
 *
 * ── The protection that actually matters is still G1's ──────────────────────
 * > Leadership itself is not left to the coordinator's own belief: guard G1 of the
 * > commit transaction re-reads the shard's leadership fence inside the transaction and
 * > aborts if it has advanced, so exclusivity of the writer is enforced by the database
 * > rather than inferred from a lease the writer thinks it still holds.
 *
 * Nothing here weakens that, and nothing here is trusted in its place. A successful
 * `tryAcquire` is a *belief* about leadership held by one process; the commit
 * transaction re-derives the fact from the row, inside the transaction, every time.
 *
 * Tier 1 by path (`src/engine/`), serving a Tier 0 guarantee through G1.
 */

const clock = require("../commitment/clock");

/**
 * The shard a deployment that has defined none operates under.
 *
 * Phase 3 introduced it as "the single static shard"; Phase 13 keeps the identifier and
 * changes what it means. It is now the shard id a **single-shard deployment** uses — the
 * one `intake.resolveShard` routes to when no region → shard map has been published —
 * and every other table's plain `shardId` column has carried it since Phase 3. Renaming
 * it would have rewritten the shard identity on every existing row for a cosmetic gain.
 * @structural the identifier of the single-shard deployment's shard
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

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 13 — the compare-and-set primitives an election is built from (§19.5)

   Each is a transaction that takes an **explicit `FOR UPDATE` lock on the leadership
   row** and then performs a conditional write whose `where` clause carries every
   precondition. Both halves are load-bearing and neither is sufficient alone:

     - The conditional write is why a precondition cannot be checked in application code
       and enforced nowhere. `updateMany().count` is the store's answer to "was I the one
       who won", and it is the only answer any of these three trusts.
     - The explicit lock is why that answer is correct **under every isolation level**.
       A bare conditional `UPDATE … WHERE fence = 3` is safe under PostgreSQL's READ
       COMMITTED, where the second updater blocks and re-evaluates its predicate against
       the committed row — but the commit path requests SERIALIZABLE/REPEATABLE READ, and
       under those a concurrent updater raises a serialisation failure rather than
       re-checking. Relying on the isolation level would make leadership safe only for
       the isolation level the caller happened to open the transaction with, which is
       exactly the kind of implicit dependency §10.2 rejects for the cache lock and §19.5
       rejects for the lease.

   This is the same discipline §10.3.2 step 1 applies to the commit itself: take the lock
   you depend on, rather than inferring it from the isolation level. The cost is that a
   leadership change briefly blocks guard G1's `FOR SHARE` read on the same row — which is
   correct, and is the point: a commit must not read a fence that is mid-change.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Take the leadership row under an exclusive lock, inside a transaction.
 *
 * `FOR UPDATE`, not `FOR SHARE` — the opposite of `readLeadership`, and deliberately so.
 * G1 reads the fence and needs it stable; these three *change* it and need every other
 * reader and writer excluded while they do.
 *
 * @param {object} tx a transaction client
 * @param {string} shardId
 * @returns {Promise<object|null>}
 */
async function lockLeadershipRow(tx, shardId) {
  const rows = await tx.$queryRawUnsafe(
    'SELECT "shardId", "leadershipFence", "holder", "leaseExpiry" FROM "ShardLeadership" WHERE "shardId" = $1 FOR UPDATE',
    shardId,
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0];
}

/** Why a compare-and-set on the leadership row did not take effect. @structural refusal labels */
const CAS_REFUSAL = Object.freeze({
  /** No row for this shard. G1 compares against a row; a missing row is not an advanced fence. */
  NO_LEADERSHIP_ROW: "NO_LEADERSHIP_ROW",
  /** The fence moved since the caller read it: somebody else won an election in between. */
  FENCE_SUPERSEDED: "FENCE_SUPERSEDED",
  /** Another coordinator holds an unexpired lease. */
  HELD_BY_ANOTHER: "HELD_BY_ANOTHER",
  /** The renewing coordinator's lease has already lapsed; it must re-acquire, not renew. */
  LEASE_LAPSED: "LEASE_LAPSED",
  /** The releasing coordinator is not the holder. */
  NOT_THE_HOLDER: "NOT_THE_HOLDER",
});

/**
 * Attempt to acquire the shard's leadership lease, advancing the fence.
 *
 * The conditional write succeeds only if, **at the instant the store evaluates it**, the
 * fence is still the value the caller observed *and* the shard is either unheld or held
 * on a lease that has expired by the store's own clock (§10.6 — the store's clock is
 * authoritative, never the coordinator's).
 *
 * ── Why the fence is part of the condition ──────────────────────────────────
 * Expiry alone would be enough for mutual exclusion between two acquirers only if their
 * writes were ordered by expiry, which they are not. Two coordinators observing the same
 * expired lease would both find the expiry condition true, and the second write would
 * silently overwrite the first — producing two processes each holding a successful
 * acquisition, one of them at a fence the row no longer carries. Conditioning on the
 * observed fence makes the second write match zero rows, so exactly one acquirer can
 * believe it won. G1 then makes the loser's commits abort even if it believed otherwise.
 *
 * ── Why acquisition advances the fence ──────────────────────────────────────
 * §19.5 — "advanced on each leadership change". Acquisition is the leadership change.
 * The advance is what fences the previous holder at the store, and it is the reason a
 * partitioned former leader "cannot corrupt state even if it believes it is still
 * leading". Re-acquisition by the *same* coordinator after its own lease lapsed also
 * advances, and must: between the lapse and the re-acquisition another coordinator could
 * have held the shard, so the returning process is a new leader whatever its name is.
 *
 * @param {object} prisma
 * @param {object} input
 * @param {string} [input.shardId]
 * @param {string} input.holder the coordinator's identity
 * @param {bigint|number|string} input.expectedFence the fence the caller last observed
 * @param {Date} input.storeTime the store's clock (§10.6)
 * @param {number} input.leaseDurationSeconds `shard.lease_duration`
 * @returns {Promise<{ acquired: boolean, refusal: string|null, leadershipFence: bigint|null,
 *                     leaseExpiry: Date|null, holder: string|null, previousHolder: string|null }>}
 */
async function tryAcquire(prisma, input) {
  const settings = input || {};
  const shardId = settings.shardId || DEFAULT_SHARD_ID;

  return prisma.$transaction(async (tx) => {
    const before = await lockLeadershipRow(tx, shardId);
    if (!before) {
      return {
        acquired: false,
        refusal: CAS_REFUSAL.NO_LEADERSHIP_ROW,
        leadershipFence: null,
        leaseExpiry: null,
        holder: null,
        previousHolder: null,
      };
    }

    const observed = BigInt(before.leadershipFence);
    const expected = BigInt(settings.expectedFence === undefined ? before.leadershipFence : settings.expectedFence);
    const next = observed + BigInt(1);
    const leaseExpiry = clock.deadlineFrom(settings.storeTime, settings.leaseDurationSeconds);

    // The caller's read is stale: somebody won an election between it and this lock. The
    // caller must re-read and stand again, because its next fence would collide with the
    // one already granted.
    if (observed !== expected) {
      return {
        acquired: false,
        refusal: CAS_REFUSAL.FENCE_SUPERSEDED,
        leadershipFence: observed,
        leaseExpiry: before.leaseExpiry,
        holder: before.holder,
        previousHolder: before.holder,
      };
    }

    // Unheld, never-leased, or lapsed. `lte` rather than `lt`: a lease expiring at exactly
    // this instant has expired, and the alternative reading would leave a one-tick window
    // in which nobody may acquire and the previous holder may not renew either.
    const held =
      before.holder !== null &&
      before.leaseExpiry !== null &&
      before.leaseExpiry !== undefined &&
      new Date(before.leaseExpiry).getTime() > settings.storeTime.getTime();

    if (held) {
      return {
        acquired: false,
        refusal: CAS_REFUSAL.HELD_BY_ANOTHER,
        leadershipFence: observed,
        leaseExpiry: before.leaseExpiry,
        holder: before.holder,
        previousHolder: before.holder,
      };
    }

    // The conditional write, retained beside the lock rather than replaced by it. The lock
    // establishes exclusion; this establishes that the row is still the one that was
    // examined — the belt to the lock's braces, and the half that survives a future edit
    // that loses the lock.
    const result = await tx.shardLeadership.updateMany({
      where: { shardId, leadershipFence: expected },
      data: {
        leadershipFence: next,
        holder: settings.holder === undefined ? null : settings.holder,
        leaseExpiry,
        lastAdvancedBy: settings.holder === undefined ? null : settings.holder,
        lastAdvancedAt: settings.storeTime,
      },
    });

    if (result.count !== 1) {
      return {
        acquired: false,
        refusal: CAS_REFUSAL.FENCE_SUPERSEDED,
        leadershipFence: observed,
        leaseExpiry: before.leaseExpiry,
        holder: before.holder,
        previousHolder: before.holder,
      };
    }

    return {
      acquired: true,
      refusal: null,
      leadershipFence: next,
      leaseExpiry,
      holder: settings.holder === undefined ? null : settings.holder,
      previousHolder: before.holder,
    };
  });
}

/**
 * Extend the current holder's lease **without** advancing the fence.
 *
 * Conditional on the holder still being this coordinator, the fence still being the one
 * it acquired at, and the lease **not having lapsed**. That last condition is the one
 * worth defending: a coordinator whose lease has already expired has, from the store's
 * point of view, stopped being the leader, and permitting it to renew would let it
 * resume leadership without advancing the fence — leaving any coordinator that acquired
 * in the gap holding a *higher* fence while the returning process continued to commit
 * under the old one. G1 would abort the returning process's commits, so nothing unsafe
 * would be written, but the shard would have two processes each believing they lead and
 * one of them silently unable to make progress. Refusing the renewal turns that into an
 * explicit re-acquisition, which is a leadership change, which advances the fence.
 *
 * ── The expiry never moves backwards ────────────────────────────────────────
 * The new expiry is `storeTime + lease`, and `storeTime` is when the caller *started*, not
 * when the row lock was granted. Two renewals by the same leader can therefore land out of
 * order — one slow behind a lock, one fast — and the later-landing one carries the earlier
 * expiry. Writing it would shorten a lease the store had already granted (measured in Step 1:
 * T0+8,000 then T0+6,500, both reporting success). So the write is conditional on the stored
 * expiry being earlier than the proposed one, and a renewal that would not extend the lease
 * leaves the row alone and reports the stored expiry. It is still a successful renewal: the
 * holder, the fence and an unexpired lease were all confirmed under the lock.
 *
 * @param {object} prisma
 * @param {object} input `{ shardId?, holder, expectedFence, storeTime, leaseDurationSeconds }`
 * @returns {Promise<{ renewed: boolean, refusal: string|null, leadershipFence: bigint|null,
 *                     leaseExpiry: Date|null, extended?: boolean }>}
 */
async function renewLease(prisma, input) {
  const settings = input || {};
  const shardId = settings.shardId || DEFAULT_SHARD_ID;
  const expected = BigInt(settings.expectedFence);
  const leaseExpiry = clock.deadlineFrom(settings.storeTime, settings.leaseDurationSeconds);

  return prisma.$transaction(async (tx) => {
    const before = await lockLeadershipRow(tx, shardId);
    if (!before) {
      return { renewed: false, refusal: CAS_REFUSAL.NO_LEADERSHIP_ROW, leadershipFence: null, leaseExpiry: null };
    }

    const observed = BigInt(before.leadershipFence);
    const lapsed =
      before.leaseExpiry === null ||
      before.leaseExpiry === undefined ||
      new Date(before.leaseExpiry).getTime() <= settings.storeTime.getTime();

    // The three refusals are distinguished because they mean different things to an
    // operator: a superseded fence is an election this coordinator lost, a wrong holder is
    // a session that was released, and a lapse is this coordinator having been too slow.
    let refusal = null;
    if (observed !== expected) refusal = CAS_REFUSAL.FENCE_SUPERSEDED;
    else if (before.holder !== settings.holder) refusal = CAS_REFUSAL.NOT_THE_HOLDER;
    else if (lapsed) refusal = CAS_REFUSAL.LEASE_LAPSED;

    if (refusal) {
      return { renewed: false, refusal, leadershipFence: observed, leaseExpiry: before.leaseExpiry };
    }

    // Not lapsed, so the stored expiry is a Date. A renewal that would not extend it is a
    // late one (see above): confirmed, and not written.
    const stored = new Date(before.leaseExpiry);
    if (stored.getTime() >= leaseExpiry.getTime()) {
      return { renewed: true, refusal: null, leadershipFence: expected, leaseExpiry: stored, extended: false };
    }

    const result = await tx.shardLeadership.updateMany({
      // `leaseExpiry < proposed` beside the lock for the same reason `tryAcquire` keeps its
      // fence condition: it is the half of the monotonic rule that survives losing the lock.
      where: { shardId, holder: settings.holder, leadershipFence: expected, leaseExpiry: { lt: leaseExpiry } },
      // The fence is deliberately absent from this `data`. See the module header: a
      // renewal that advanced it would abort the renewing leader's own in-flight commits
      // through G1, at exactly the renewal cadence.
      data: { leaseExpiry },
    });

    if (result.count !== 1) {
      return { renewed: false, refusal: CAS_REFUSAL.FENCE_SUPERSEDED, leadershipFence: observed, leaseExpiry: before.leaseExpiry };
    }

    return { renewed: true, refusal: null, leadershipFence: expected, leaseExpiry, extended: true };
  });
}

/**
 * Stand down, advancing the fence.
 *
 * The graceful half of failover, and the reason a rolling deploy does not cost a shard a
 * full lease duration of unavailability: a leader that releases on shutdown lets the next
 * acquirer take the shard immediately instead of waiting for a lease nobody is renewing
 * to lapse. Advancing the fence here is what makes it safe to do so — the outgoing
 * process is fenced at the store the moment it stands down, so a command still in flight
 * inside it aborts at G1 rather than racing the new leader.
 *
 * @param {object} prisma
 * @param {object} input `{ shardId?, holder, expectedFence, storeTime }`
 * @returns {Promise<{ released: boolean, refusal: string|null, leadershipFence: bigint|null }>}
 */
async function releaseLease(prisma, input) {
  const settings = input || {};
  const shardId = settings.shardId || DEFAULT_SHARD_ID;
  const expected = BigInt(settings.expectedFence);
  const next = expected + BigInt(1);

  return prisma.$transaction(async (tx) => {
    const before = await lockLeadershipRow(tx, shardId);
    if (!before) return { released: false, refusal: CAS_REFUSAL.NO_LEADERSHIP_ROW, leadershipFence: null };

    const observed = BigInt(before.leadershipFence);
    if (observed !== expected) {
      return { released: false, refusal: CAS_REFUSAL.FENCE_SUPERSEDED, leadershipFence: observed };
    }
    if (before.holder !== settings.holder) {
      return { released: false, refusal: CAS_REFUSAL.NOT_THE_HOLDER, leadershipFence: observed };
    }

    const result = await tx.shardLeadership.updateMany({
      where: { shardId, holder: settings.holder, leadershipFence: expected },
      data: {
        leadershipFence: next,
        holder: null,
        leaseExpiry: null,
        lastAdvancedBy: `${String(settings.holder)}:release`,
        lastAdvancedAt: settings.storeTime,
      },
    });

    if (result.count !== 1) {
      return { released: false, refusal: CAS_REFUSAL.FENCE_SUPERSEDED, leadershipFence: observed };
    }

    return { released: true, refusal: null, leadershipFence: next };
  });
}

module.exports = {
  DEFAULT_SHARD_ID,
  CAS_REFUSAL,
  readLeadership,
  readLeadershipFence,
  ensureShard,
  advanceFence,
  shouldStopCommitting,
  lockLeadershipRow,
  tryAcquire,
  renewLease,
  releaseLease,
};

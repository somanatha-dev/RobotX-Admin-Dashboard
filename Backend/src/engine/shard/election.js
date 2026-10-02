"use strict";

/**
 * Leader election for a shard (§19.3, §19.5) — **Tier 1**.
 *
 * > Exactly one **active Coordinator** per shard, chosen by leader election with a fenced
 * > lease from a consensus-backed store.
 *
 * > Leases come from a consensus-backed store (Raft/Paxos class). No leader election over
 * > a non-consensus store, which cannot provide the required guarantee under partition.
 *
 * ── The two enforcement points, and why there must be two ───────────────────
 * §19.3 is explicit that leadership is enforced twice and that the second is the one that
 * matters:
 *
 * > Leadership itself is not left to the coordinator's own belief: guard G1 of the commit
 * > transaction re-reads the shard's leadership fence inside the transaction and aborts if
 * > it has advanced, so exclusivity of the writer is enforced by the database rather than
 * > inferred from a lease the writer thinks it still holds.
 *
 * This module is the *first* point — the consensus lease, which decides who should be
 * leading. G1 is the second — the database, which decides whose writes land. The
 * completion criterion of this phase names both: "exactly one active coordinator per
 * shard, enforced by consensus **and** by G1". This module is therefore written on the
 * assumption that it will sometimes be wrong, and every one of its results is a belief
 * rather than a fact:
 *
 *   - `acquire()` returns a *session*, and a session is a claim this process holds about
 *     itself. Nothing downstream may treat it as authority.
 *   - `shouldStopCommitting()` is the liveness half of §19.5's margin rule and says so.
 *     A caller that ignored it entirely would still be fenced at the store.
 *   - The session carries its fence so that the round pins it and G1 re-derives it. A
 *     session whose fence was not carried into the commit would have made this module's
 *     belief load-bearing, which is the arrangement §19.3 rejects.
 *
 * ── B3, the consensus store, and what this module does about it ─────────────
 * `IMPLEMENTATION_EXECUTION_PLAN.md` §6.1 records B3 — "**Consensus store** for shard
 * leadership leases (etcd / Consul / ZooKeeper / **DB primitives**)" — as a blocking
 * *integration* decision, "not an architecture change", and names DB primitives among the
 * admissible options.
 *
 * This module does not choose. It defines a **port** with one declared guarantee, refuses
 * any store that does not declare it, and ships one adapter — `postgresLeadershipStore`,
 * over the `ShardLeadership` row Phase 3 already created and guard G1 already reads. An
 * etcd or Consul adapter satisfying the same port is a drop-in, and the port is what makes
 * that true rather than a hope.
 *
 * ── Why a conditional write on PostgreSQL can be the consensus primitive ────
 * The guarantee §19.5 requires is *linearisable compare-and-set on the leadership record
 * under partition*. A single-primary PostgreSQL provides exactly that for writes it
 * acknowledges — a conditional `UPDATE … WHERE fence = expected` either matches one row
 * or none, and two concurrent attempts cannot both match. What it does **not** provide is
 * safety across an *unsafe failover*: promoting an asynchronously-replicated standby can
 * lose acknowledged writes, and a lost fence advance is precisely a lost leadership
 * change.
 *
 * The adapter therefore requires the deployment to **declare its replication posture**,
 * and declares the guarantee only for the postures that actually have it. An undeclared
 * or asynchronous posture is refused outright rather than warned about, because §19.5's
 * sentence is a prohibition and a warning is not a prohibition. That refusal is the
 * honest form of B3 in code: the decision is still the operator's, and the code will not
 * pretend it has been made.
 *
 * ── No clock ────────────────────────────────────────────────────────────────
 * Every instant is supplied, and the instant that matters is the **store's** (§10.6:
 * "Store clock is authoritative; skew budget embedded; fencing makes safety
 * clock-independent"). A coordinator that timed its own lease against its own clock would
 * have made lease validity depend on the one clock §10.6 says is not authoritative.
 */

const leadership = require("./leadership");

/**
 * The single guarantee this module's port requires of a store.
 *
 * Named rather than described so an adapter declares it by exact string. A store that
 * "probably" provides it declares nothing, and is refused.
 * @structural the required consensus-store guarantee
 */
const CONSENSUS_GUARANTEE = "LINEARISABLE_COMPARE_AND_SET";

/** @structural milliseconds per second — a unit conversion, not a threshold */
const MILLIS_PER_SECOND = 1000;

/**
 * Replication postures a PostgreSQL deployment can declare, and whether each actually
 * provides `CONSENSUS_GUARANTEE`.
 *
 * `SINGLE_PRIMARY_NO_AUTOMATIC_FAILOVER` is safe because a promotion is then a human act
 * that can be sequenced against stopping the coordinators — the losing writes cannot be
 * lost *silently*. `SYNCHRONOUS_QUORUM` is safe because an acknowledged write is on a
 * quorum before it is acknowledged, which is the Raft/Paxos-class property §19.5 names.
 * @structural the declared-posture vocabulary and its verdicts
 */
const REPLICATION_POSTURE = Object.freeze({
  SYNCHRONOUS_QUORUM: { safe: true, why: "an acknowledged write is on a quorum before acknowledgement — the Raft/Paxos-class property §19.5 requires" },
  SINGLE_PRIMARY_NO_AUTOMATIC_FAILOVER: { safe: true, why: "no standby can be promoted without a human act, so an acknowledged write cannot be silently lost" },
  ASYNCHRONOUS_FAILOVER: { safe: false, why: "promoting an asynchronously-replicated standby can lose acknowledged writes, and a lost fence advance is a lost leadership change — two coordinators would then hold the same fence" },
  UNDECLARED: { safe: false, why: "the posture has not been declared, and §19.5's prohibition on electing over a non-consensus store cannot be discharged by assumption" },
});

/**
 * What a coordinator believes about its own leadership.
 * @structural the session-state vocabulary
 */
const LEADERSHIP_STATE = Object.freeze({
  /** Not leading. The steady state of every warm standby (§19.3). */
  FOLLOWER: "FOLLOWER",
  /** Holding a lease whose margin has not run out. */
  LEADER: "LEADER",
  /**
   * Holding a lease whose margin *has* run out, or that failed to renew. §19.5 — "A
   * coordinator MUST stop committing the moment it cannot renew its lease, *before* the
   * lease actually expires". This state is that moment, and it is distinct from FOLLOWER
   * because the process still has in-flight work to abandon.
   */
  STEPPING_DOWN: "STEPPING_DOWN",
});

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * Refuse a store that does not declare the guarantee §19.5 requires.
 *
 * Throws rather than returning a verdict. §19.5's sentence — "No leader election over a
 * non-consensus store, which cannot provide the required guarantee under partition" — is
 * a prohibition, and a prohibition that returns `false` is a prohibition somebody
 * ignores. The one place it can be enforced structurally is the moment the store is
 * handed over, which is here.
 *
 * @param {object} store
 * @returns {object} the store, so the assertion can wrap a construction expression
 * @throws {Error} when the store declares anything else
 */
function assertConsensusStore(store) {
  const source = store || {};
  if (source.guarantee !== CONSENSUS_GUARANTEE) {
    throw new Error(
      `refusing to elect a leader over a store declaring "${String(source.guarantee)}" rather than ` +
        `"${CONSENSUS_GUARANTEE}"${isNonEmptyString(source.why) ? `: ${source.why}` : ""}. §19.5: "Leases come from ` +
        'a consensus-backed store (Raft/Paxos class). No leader election over a non-consensus store, which cannot ' +
        'provide the required guarantee under partition." Guard G1 would still fence an unsafe leader\'s commits at ' +
        "the database, so nothing incorrect would be written — but the shard would spend its life with two " +
        "coordinators, one of them unable to make progress and neither able to say why.",
    );
  }
  for (const method of ["read", "tryAcquire", "renew", "release"]) {
    if (typeof source[method] !== "function") {
      throw new TypeError(`a leadership store must implement ${method}(); this one does not`);
    }
  }
  return source;
}

/**
 * The shipped adapter: the `ShardLeadership` row, driven by the three compare-and-set
 * primitives in `leadership.js`.
 *
 * @param {object} prisma
 * @param {object} options
 * @param {string} options.replicationPosture one of `REPLICATION_POSTURE`'s keys
 * @returns {object} a leadership store
 */
function postgresLeadershipStore(prisma, options) {
  const settings = options || {};
  const declared = isNonEmptyString(settings.replicationPosture) ? settings.replicationPosture : "UNDECLARED";
  const posture = REPLICATION_POSTURE[declared] || REPLICATION_POSTURE.UNDECLARED;

  return Object.freeze({
    kind: "POSTGRES_CONDITIONAL_WRITE",
    replicationPosture: declared,
    // The declaration is *derived from the posture*, never asserted independently. An
    // adapter that could declare the guarantee while declaring an unsafe posture would be
    // an adapter whose two statements could disagree, and the disagreement would be
    // invisible until a failover.
    guarantee: posture.safe ? CONSENSUS_GUARANTEE : `NOT_${CONSENSUS_GUARANTEE}`,
    why: posture.why,

    async read(shardId) {
      const row = await prisma.shardLeadership.findUnique({ where: { shardId } });
      if (!row) return null;
      return {
        shardId: row.shardId,
        leadershipFence: BigInt(row.leadershipFence),
        holder: row.holder,
        leaseExpiry: row.leaseExpiry,
      };
    },

    async tryAcquire(request) {
      return leadership.tryAcquire(prisma, request);
    },

    async renew(request) {
      return leadership.renewLease(prisma, request);
    },

    async release(request) {
      return leadership.releaseLease(prisma, request);
    },
  });
}

/**
 * A follower session — what a coordinator holds before it has won anything, and what it
 * returns to when it stands down.
 *
 * @param {object} input `{ shardId, candidateId }`
 * @returns {object}
 */
function followerSession(input) {
  const source = input || {};
  return Object.freeze({
    shardId: String(source.shardId || leadership.DEFAULT_SHARD_ID),
    candidateId: String(source.candidateId),
    state: LEADERSHIP_STATE.FOLLOWER,
    leadershipFence: null,
    leaseExpiry: null,
    acquiredAtMs: null,
    lastRenewedAtMs: null,
    // Carried so a coordinator that lost an election can report *why* rather than
    // reporting only that it is not the leader.
    lastRefusal: source.lastRefusal === undefined ? null : source.lastRefusal,
    observedHolder: source.observedHolder === undefined ? null : source.observedHolder,
    mayCommit: false,
  });
}

/**
 * Stand for election.
 *
 * Reads the current record, then attempts the conditional acquisition against the fence
 * it just read. The read is not a check — the acquisition's `where` clause is the check —
 * it is how the caller learns which fence to compare against.
 *
 * @param {object} store a consensus store, already asserted
 * @param {object} input
 * @param {string} [input.shardId]
 * @param {string} input.candidateId
 * @param {Date} input.storeTime
 * @param {number} input.leaseDurationSeconds `shard.lease_duration`
 * @returns {Promise<object>} a session
 */
async function acquire(store, input) {
  const settings = input || {};
  const shardId = String(settings.shardId || leadership.DEFAULT_SHARD_ID);
  const candidateId = String(settings.candidateId);

  const current = await store.read(shardId);
  if (!current) {
    return followerSession({ shardId, candidateId, lastRefusal: leadership.CAS_REFUSAL.NO_LEADERSHIP_ROW });
  }

  const outcome = await store.tryAcquire({
    shardId,
    holder: candidateId,
    expectedFence: current.leadershipFence,
    storeTime: settings.storeTime,
    leaseDurationSeconds: settings.leaseDurationSeconds,
  });

  if (!outcome.acquired) {
    return followerSession({
      shardId,
      candidateId,
      lastRefusal: outcome.refusal,
      observedHolder: outcome.holder,
    });
  }

  return Object.freeze({
    shardId,
    candidateId,
    state: LEADERSHIP_STATE.LEADER,
    leadershipFence: outcome.leadershipFence,
    leaseExpiry: outcome.leaseExpiry,
    acquiredAtMs: settings.storeTime.getTime(),
    lastRenewedAtMs: settings.storeTime.getTime(),
    lastRefusal: null,
    observedHolder: candidateId,
    previousHolder: outcome.previousHolder,
    // Deliberately false on a fresh acquisition. §19.5 — "On leadership acquisition, the
    // new leader runs a full reconciliation of the shard before resuming rounds." The
    // session is not permitted to commit until `failover.js` has completed; `promote()`
    // is the only thing that sets this true, and it demands the reconciliation's result.
    mayCommit: false,
    reconciled: false,
  });
}

/**
 * Mark a session as reconciled and clear to run rounds.
 *
 * §19.5's "before resuming rounds" is enforced here as a *state transition that requires
 * evidence*, rather than as an ordering somebody remembers to observe. The evidence is
 * the failover result, and a result that did not complete is refused: "Resuming first and
 * reconciling later invites acting on state the previous leader left half-written."
 *
 * @param {object} session a LEADER session from `acquire`
 * @param {object} reconciliation a `failover.run()` result
 * @returns {object} the promoted session
 */
function promote(session, reconciliation) {
  if (!session || session.state !== LEADERSHIP_STATE.LEADER) {
    throw new Error(
      "only a session that won an election can be promoted; a follower has nothing to reconcile and nothing to " +
        "resume (§19.5)",
    );
  }
  if (!reconciliation || reconciliation.complete !== true) {
    throw new Error(
      "refusing to resume rounds on an incomplete reconciliation (§19.5). \"On leadership acquisition, the new " +
        'leader runs a full reconciliation of the shard before resuming rounds. Resuming first and reconciling ' +
        'later invites acting on state the previous leader left half-written." A reconciliation that did not ' +
        "finish leaves exactly that state in place, and the round would be the thing that discovered it.",
    );
  }

  return Object.freeze({ ...session, mayCommit: true, reconciled: true, reconciliation });
}

/**
 * Renew, and re-evaluate whether this coordinator may still commit.
 *
 * The two are one operation because they are one decision. §19.5's rule is that a leader
 * stops committing when it *cannot renew*, before the lease expires — so a renewal
 * attempt that fails must change the session's commit permission in the same step, or
 * there is a window in which the process knows it failed and has not yet acted on it.
 *
 * @param {object} store
 * @param {object} session
 * @param {object} input `{ storeTime, leaseDurationSeconds, maxClockSkewMillis, storeRoundTripMillis }`
 * @returns {Promise<object>} the session, renewed or stepping down
 */
async function renew(store, session, input) {
  const settings = input || {};

  if (!session || session.state === LEADERSHIP_STATE.FOLLOWER) {
    throw new Error("a follower has no lease to renew; stand for election with acquire() instead");
  }

  const outcome = await store.renew({
    shardId: session.shardId,
    holder: session.candidateId,
    expectedFence: session.leadershipFence,
    storeTime: settings.storeTime,
    leaseDurationSeconds: settings.leaseDurationSeconds,
  });

  if (!outcome.renewed) {
    // §19.5's "the moment it cannot renew". Not on the next tick, not when the lease
    // lapses: now. The session keeps its fence so the caller can still identify the
    // in-flight work that is about to abort at G1, and `mayCommit` is false so nothing
    // new starts.
    return Object.freeze({
      ...session,
      state: LEADERSHIP_STATE.STEPPING_DOWN,
      mayCommit: false,
      lastRefusal: outcome.refusal,
      observedFence: outcome.leadershipFence === null ? null : outcome.leadershipFence,
    });
  }

  // Never earlier than the lease this session already holds. The store keeps the later of the
  // two as well (`leadership.renewLease`); the session must not regress on its own either.
  const leaseExpiry = laterExpiry(session.leaseExpiry, outcome.leaseExpiry);
  const margin = leadership.shouldStopCommitting({
    leaseExpiry,
    storeTime: settings.storeTime,
    maxClockSkewMillis: settings.maxClockSkewMillis,
    storeRoundTripMillis: settings.storeRoundTripMillis,
  });

  return Object.freeze({
    ...session,
    state: margin.shouldStop ? LEADERSHIP_STATE.STEPPING_DOWN : LEADERSHIP_STATE.LEADER,
    leaseExpiry,
    lastRenewedAtMs: Math.max(session.lastRenewedAtMs ?? Number.NEGATIVE_INFINITY, settings.storeTime.getTime()),
    lastRefusal: null,
    // A session that has not reconciled never gains commit permission from a renewal:
    // renewal extends a lease, it does not discharge §19.5's reconciliation obligation.
    mayCommit: session.reconciled === true && !margin.shouldStop,
    marginMillis: margin.marginMillis,
  });
}

/**
 * The later of two lease expiries; either may be absent.
 *
 * @param {Date|string|null|undefined} a
 * @param {Date|string|null|undefined} b
 * @returns {Date|string|null}
 */
function laterExpiry(a, b) {
  if (a === null || a === undefined) return b === undefined ? null : b;
  if (b === null || b === undefined) return a;
  return new Date(b).getTime() > new Date(a).getTime() ? b : a;
}

/**
 * Whether two sessions describe the same leadership term: the same coordinator holding the
 * same shard at the same fence. The fence is advanced on every acquisition, so it names the
 * term; a FOLLOWER holds no term at all.
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function sameTerm(a, b) {
  if (!a || !b) return false;
  if (a.state === LEADERSHIP_STATE.FOLLOWER || b.state === LEADERSHIP_STATE.FOLLOWER) return false;
  if (a.leadershipFence === null || a.leadershipFence === undefined) return false;
  if (b.leadershipFence === null || b.leadershipFence === undefined) return false;
  return (
    a.shardId === b.shardId && a.candidateId === b.candidateId && BigInt(a.leadershipFence) === BigInt(b.leadershipFence)
  );
}

/**
 * Fold the result of a renewal into the session that is current **now**.
 *
 * A renewal is computed from the session as it was when the renewal started. By the time it
 * returns, the supervisor's session may have moved on — promoted by a reconciliation that
 * finished meanwhile, stepped down, released, or replaced by a later term. So the result is
 * not adopted wholesale. Three rules:
 *
 *   - A result for another term (or for none) is stale and changes nothing.
 *   - A failed renewal for the current term withdraws authority: the session steps down. A
 *     refusal for a term is permanent for that term (the fence moved, the holder changed, or
 *     the lease lapsed), so a late one is still true.
 *   - A successful renewal never restores authority. It extends the lease of a session that
 *     is still LEADER, never earlier than the lease it already holds, and leaves `reconciled`
 *     and the commit permission it implies to the current session.
 *
 * @param {object} current the session the supervisor holds now
 * @param {object} renewed an `election.renew()` result
 * @returns {object} the session to hold next
 */
function foldRenewal(current, renewed) {
  if (!sameTerm(current, renewed)) return current;

  if (renewed.state !== LEADERSHIP_STATE.LEADER) {
    return Object.freeze({
      ...current,
      state: LEADERSHIP_STATE.STEPPING_DOWN,
      mayCommit: false,
      leaseExpiry: laterExpiry(current.leaseExpiry, renewed.leaseExpiry),
      lastRefusal: renewed.lastRefusal ?? null,
      observedFence: renewed.observedFence ?? current.observedFence ?? null,
      marginMillis: renewed.marginMillis ?? current.marginMillis,
    });
  }

  if (current.state !== LEADERSHIP_STATE.LEADER) return current;

  return Object.freeze({
    ...current,
    leaseExpiry: laterExpiry(current.leaseExpiry, renewed.leaseExpiry),
    lastRenewedAtMs: Math.max(current.lastRenewedAtMs ?? Number.NEGATIVE_INFINITY, renewed.lastRenewedAtMs),
    lastRefusal: null,
    marginMillis: renewed.marginMillis,
    mayCommit: current.reconciled === true,
  });
}

/**
 * Promote the current session, but only if it is still the term the reconciliation ran for.
 *
 * The reconciliation is evidence about the shard as the leader of one term found it. Applied
 * to a session that has since stepped down, been released, or been replaced by another term,
 * it would grant commit permission nobody earned — so it is applied to nothing. The current
 * session is promoted rather than the one the reconciliation started from, so a lease renewed
 * meanwhile is kept.
 *
 * @param {object} current the session the supervisor holds now
 * @param {object} basis the LEADER session the reconciliation ran for
 * @param {object} reconciliation a completed `failover.run()` result
 * @returns {object} the session to hold next
 */
function promoteIfCurrent(current, basis, reconciliation) {
  if (!sameTerm(current, basis)) return current;
  if (current.state !== LEADERSHIP_STATE.LEADER || current.reconciled === true) return current;
  return promote(current, reconciliation);
}

/**
 * Ask, without writing anything, whether this session may still commit.
 *
 * The query a coordinator asks immediately before it opens a commit transaction. It is
 * *advisory*, and the module header says why: the transaction takes row locks that may
 * block for an unbounded duration, so a transaction beginning inside a valid leadership
 * window can commit outside it. §19.5 states the same thing and draws the same
 * conclusion — "Stopping early narrows the window; **guard G1 closes it.**"
 *
 * @param {object} session
 * @param {object} input `{ storeTime, maxClockSkewMillis, storeRoundTripMillis }`
 * @returns {{ mayCommit: boolean, reason: string|null, marginMillis: number }}
 */
function assessCommitPermission(session, input) {
  const settings = input || {};

  if (!session || session.state !== LEADERSHIP_STATE.LEADER) {
    return {
      mayCommit: false,
      reason: session && session.state === LEADERSHIP_STATE.STEPPING_DOWN ? "STEPPING_DOWN" : "NOT_LEADER",
      marginMillis: 0,
    };
  }
  if (session.reconciled !== true) {
    return { mayCommit: false, reason: "RECONCILIATION_INCOMPLETE", marginMillis: 0 };
  }

  const margin = leadership.shouldStopCommitting({
    leaseExpiry: session.leaseExpiry,
    storeTime: settings.storeTime,
    maxClockSkewMillis: settings.maxClockSkewMillis,
    storeRoundTripMillis: settings.storeRoundTripMillis,
  });

  return {
    mayCommit: !margin.shouldStop,
    reason: margin.reason,
    marginMillis: margin.marginMillis,
  };
}

/**
 * Stand down deliberately — the shutdown drain's last act on the leadership record.
 *
 * Releasing advances the fence (see `leadership.releaseLease`), so the standby that takes
 * over does so immediately rather than after the lease lapses, and this process is fenced
 * at the store the moment it lets go.
 *
 * A release that fails is **not** an error the caller must handle: the lease will lapse on
 * its own, and the outgoing process is fenced either way. The refusal is reported so a
 * shutdown that could not release is visible, not so it can be retried into a hang.
 *
 * @param {object} store
 * @param {object} session
 * @param {object} input `{ storeTime }`
 * @returns {Promise<{ session: object, released: boolean, refusal: string|null }>}
 */
async function release(store, session, input) {
  const settings = input || {};

  if (!session || session.state === LEADERSHIP_STATE.FOLLOWER) {
    return { session: followerSession(session || {}), released: false, refusal: "NOT_LEADER" };
  }

  const outcome = await store.release({
    shardId: session.shardId,
    holder: session.candidateId,
    expectedFence: session.leadershipFence,
    storeTime: settings.storeTime,
  });

  return {
    session: followerSession({
      shardId: session.shardId,
      candidateId: session.candidateId,
      lastRefusal: outcome.released ? null : outcome.refusal,
    }),
    released: outcome.released,
    refusal: outcome.refusal,
  };
}

/**
 * The renewal cadence a lease duration and its margin imply.
 *
 * Derived rather than configured *against* the lease, so the two cannot drift into a
 * configuration where the leader's first renewal is already too late. `shard.renewal_interval`
 * is the configured value; this function is what the publish-time check A4 and the
 * supervisor compare it against.
 *
 * @param {object} input `{ leaseDurationSeconds, maxClockSkewMillis, storeRoundTripMillis }`
 * @returns {{ latestRenewalMillis: number, marginMillis: number, sentence: string }}
 */
function renewalBudget(input) {
  const settings = input || {};
  const leaseMillis = settings.leaseDurationSeconds * MILLIS_PER_SECOND;
  const marginMillis = settings.maxClockSkewMillis + (settings.storeRoundTripMillis ?? settings.maxClockSkewMillis);
  const latest = leaseMillis - marginMillis;

  return {
    latestRenewalMillis: latest,
    marginMillis,
    sentence:
      `a lease of ${settings.leaseDurationSeconds} s must be renewed within ${latest} ms of its grant: §19.5 ` +
      `requires the leader to stop committing ${marginMillis} ms before expiry (time.max_clock_skew plus the ` +
      "store's round-trip budget), and a renewal interval at or beyond that leaves the shard uncommittable " +
      "between every renewal.",
  };
}

module.exports = {
  CONSENSUS_GUARANTEE,
  REPLICATION_POSTURE,
  LEADERSHIP_STATE,
  CAS_REFUSAL: leadership.CAS_REFUSAL,
  assertConsensusStore,
  postgresLeadershipStore,
  followerSession,
  acquire,
  promote,
  renew,
  release,
  sameTerm,
  foldRenewal,
  promoteIfCurrent,
  assessCommitPermission,
  renewalBudget,
};

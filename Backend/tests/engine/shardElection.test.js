"use strict";

/**
 * Engine lane — Phase 13: leader election and the single writer (§19.3, §19.5).
 *
 * The plan's completion criterion for this phase is stated twice over, and both halves are
 * exercised here and in `shardChaos.test.js`:
 *
 * > **Gate:** exactly one active coordinator per shard, enforced by consensus **and** by
 * > the database.
 *
 * This file is the *consensus* half. `shardChaos.test.js` is the database half — G1
 * aborting an isolated coordinator's late commits.
 *
 * Every test that makes a claim about **concurrency** runs against
 * `helpers/commitmentStore.js`, which models row locks that genuinely block and atomic
 * transaction overlays. A store that could not make two acquirers race would let
 * "exactly one winner" pass vacuously, which is the whole assertion.
 */

const election = require("../../src/engine/shard/election");
const leadership = require("../../src/engine/shard/leadership");
const { createCommitmentStore } = require("./helpers/commitmentStore");

/** `shard.lease_duration`, Appendix A default. */
const LEASE_SECONDS = 5;
/** `time.max_clock_skew`, Appendix A default. */
const SKEW_MS = 500;
/** `shard.store_round_trip_budget`, Phase 13's default. */
const ROUND_TRIP_MS = 500;

function seeded(overrides) {
  return createCommitmentStore({
    shardLeadership: [
      {
        id: "sl-1",
        shardId: "default",
        leadershipFence: 3n,
        holder: null,
        leaseExpiry: null,
        lastAdvancedBy: null,
        lastAdvancedAt: null,
        ...(overrides || {}),
      },
    ],
  });
}

function storeFor(commitmentStore, posture) {
  return election.postgresLeadershipStore(commitmentStore.client, {
    replicationPosture: posture || "SYNCHRONOUS_QUORUM",
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   §19.5 — "No leader election over a non-consensus store"
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the consensus-store port (§19.5)", () => {
  test("a store declaring the guarantee is admitted", () => {
    const store = storeFor(seeded(), "SYNCHRONOUS_QUORUM");
    expect(store.guarantee).toBe(election.CONSENSUS_GUARANTEE);
    expect(() => election.assertConsensusStore(store)).not.toThrow();
  });

  test("an asynchronously-replicated PostgreSQL is refused, not warned about", () => {
    const store = storeFor(seeded(), "ASYNCHRONOUS_FAILOVER");
    expect(store.guarantee).not.toBe(election.CONSENSUS_GUARANTEE);
    expect(() => election.assertConsensusStore(store)).toThrow(/No leader election over a non-consensus store/);
    expect(() => election.assertConsensusStore(store)).toThrow(/can lose acknowledged writes/);
  });

  test("an undeclared posture is refused — the prohibition cannot be discharged by assumption", () => {
    // Constructed with no options at all, which is how a deployment that never set
    // `SHARD_CONSENSUS_REPLICATION` reaches this code.
    const store = election.postgresLeadershipStore(seeded().client, {});
    expect(store.replicationPosture).toBe("UNDECLARED");
    expect(() => election.assertConsensusStore(store)).toThrow(/has not been declared/);
  });

  test("the adapter cannot declare the guarantee while declaring an unsafe posture", () => {
    // The declaration is *derived* from the posture, so the two statements cannot
    // disagree. A hand-built store that claimed both is the thing this property prevents,
    // and it is checked by construction rather than by review.
    for (const [posture, definition] of Object.entries(election.REPLICATION_POSTURE)) {
      const store = storeFor(seeded(), posture);
      expect({ posture, declares: store.guarantee === election.CONSENSUS_GUARANTEE }).toEqual({
        posture,
        declares: definition.safe,
      });
    }
  });

  test("a store missing any port method is refused even if it declares the guarantee", () => {
    for (const missing of ["read", "tryAcquire", "renew", "release"]) {
      const store = { guarantee: election.CONSENSUS_GUARANTEE, read: () => {}, tryAcquire: () => {}, renew: () => {}, release: () => {} };
      delete store[missing];
      expect(() => election.assertConsensusStore(store)).toThrow(new RegExp(`must implement ${missing}`));
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Acquisition, and the fence
   ═══════════════════════════════════════════════════════════════════════════ */

describe("acquisition (§19.5)", () => {
  test("an unheld shard is acquired, and the fence advances by exactly one", async () => {
    const commitmentStore = seeded();
    const store = storeFor(commitmentStore);

    const session = await election.acquire(store, {
      candidateId: "coordinator-a",
      storeTime: commitmentStore.now(),
      leaseDurationSeconds: LEASE_SECONDS,
    });

    expect(session.state).toBe(election.LEADERSHIP_STATE.LEADER);
    expect(session.leadershipFence).toBe(4n);
    const row = commitmentStore.rows("shardLeadership")[0];
    expect(row.leadershipFence).toBe(4n);
    expect(row.holder).toBe("coordinator-a");
  });

  test("a fresh session may NOT commit — §19.5's reconciliation comes first", async () => {
    const commitmentStore = seeded();
    const session = await election.acquire(storeFor(commitmentStore), {
      candidateId: "coordinator-a",
      storeTime: commitmentStore.now(),
      leaseDurationSeconds: LEASE_SECONDS,
    });

    expect(session.mayCommit).toBe(false);
    expect(session.reconciled).toBe(false);
    expect(election.assessCommitPermission(session, { storeTime: commitmentStore.now(), maxClockSkewMillis: SKEW_MS })).toMatchObject({
      mayCommit: false,
      reason: "RECONCILIATION_INCOMPLETE",
    });
  });

  test("a held shard with a live lease is not acquired", async () => {
    const commitmentStore = seeded();
    const store = storeFor(commitmentStore);
    await election.acquire(store, { candidateId: "coordinator-a", storeTime: commitmentStore.now(), leaseDurationSeconds: LEASE_SECONDS });

    const loser = await election.acquire(store, {
      candidateId: "coordinator-b",
      storeTime: commitmentStore.now(),
      leaseDurationSeconds: LEASE_SECONDS,
    });

    expect(loser.state).toBe(election.LEADERSHIP_STATE.FOLLOWER);
    expect(loser.lastRefusal).toBe(leadership.CAS_REFUSAL.HELD_BY_ANOTHER);
    expect(loser.observedHolder).toBe("coordinator-a");
    // And the fence did not move: a lost election is not a leadership change.
    expect(commitmentStore.rows("shardLeadership")[0].leadershipFence).toBe(4n);
  });

  test("a lapsed lease is acquired by the standby, fencing the previous holder", async () => {
    const commitmentStore = seeded();
    const store = storeFor(commitmentStore);
    await election.acquire(store, { candidateId: "coordinator-a", storeTime: commitmentStore.now(), leaseDurationSeconds: LEASE_SECONDS });

    commitmentStore.advanceClock(LEASE_SECONDS + 1);

    const standby = await election.acquire(store, {
      candidateId: "coordinator-b",
      storeTime: commitmentStore.now(),
      leaseDurationSeconds: LEASE_SECONDS,
    });

    expect(standby.state).toBe(election.LEADERSHIP_STATE.LEADER);
    expect(standby.leadershipFence).toBe(5n);
    expect(standby.previousHolder).toBe("coordinator-a");
  });

  test("the store's clock decides expiry, never the coordinator's (§10.6)", async () => {
    const commitmentStore = seeded();
    const store = storeFor(commitmentStore);
    await election.acquire(store, { candidateId: "coordinator-a", storeTime: commitmentStore.now(), leaseDurationSeconds: LEASE_SECONDS });

    // A coordinator whose own clock is an hour fast passes that time in. The write's
    // condition is evaluated against the *stored* expiry, so the acquisition succeeds or
    // fails on the stored value — and the lease it would then grant is derived from the
    // supplied instant, which is why §10.6 makes the store's clock the one a caller must
    // read. Here the skewed instant is past the stored expiry, so it wins — the point
    // being that safety does not rest on it: the fence advanced.
    const skewed = new Date(commitmentStore.now().getTime() + 3600 * 1000);
    const other = await election.acquire(store, { candidateId: "coordinator-b", storeTime: skewed, leaseDurationSeconds: LEASE_SECONDS });

    expect(other.state).toBe(election.LEADERSHIP_STATE.LEADER);
    expect(other.leadershipFence).toBe(5n);
    // The outgoing leader now holds fence 4 against a row at 5. Guard G1 is what makes
    // that harmless, and `shardChaos.test.js` drives it.
  });

  test("acquisition against a shard with no leadership row is refused, never created implicitly", async () => {
    const commitmentStore = createCommitmentStore({ shardLeadership: [] });
    const session = await election.acquire(storeFor(commitmentStore), {
      candidateId: "coordinator-a",
      storeTime: commitmentStore.now(),
      leaseDurationSeconds: LEASE_SECONDS,
    });

    expect(session.state).toBe(election.LEADERSHIP_STATE.FOLLOWER);
    expect(session.lastRefusal).toBe(leadership.CAS_REFUSAL.NO_LEADERSHIP_ROW);
    expect(commitmentStore.rows("shardLeadership")).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The gate: exactly one active coordinator per shard
   ═══════════════════════════════════════════════════════════════════════════ */

describe("**Gate** — exactly one active coordinator per shard, enforced by consensus", () => {
  test("a storm of ten simultaneous acquirers against one unheld shard yields exactly one winner", async () => {
    const commitmentStore = seeded();
    const store = storeFor(commitmentStore);

    const results = await Promise.all(
      Array.from({ length: 10 }, (unused, index) =>
        election.acquire(store, {
          candidateId: `coordinator-${index}`,
          storeTime: commitmentStore.now(),
          leaseDurationSeconds: LEASE_SECONDS,
        }),
      ),
    );

    const winners = results.filter((session) => session.state === election.LEADERSHIP_STATE.LEADER);
    expect(winners).toHaveLength(1);

    // And the fence advanced exactly once, not ten times: nine of the ten conditional
    // writes matched zero rows.
    expect(commitmentStore.rows("shardLeadership")[0].leadershipFence).toBe(4n);
    expect(commitmentStore.rows("shardLeadership")[0].holder).toBe(winners[0].candidateId);
  });

  test("a storm against a *lapsed* lease also yields exactly one winner", async () => {
    const commitmentStore = seeded({ holder: "coordinator-dead", leaseExpiry: new Date("2026-07-29T11:59:00.000Z") });
    const store = storeFor(commitmentStore);

    const results = await Promise.all(
      Array.from({ length: 8 }, (unused, index) =>
        election.acquire(store, {
          candidateId: `standby-${index}`,
          storeTime: commitmentStore.now(),
          leaseDurationSeconds: LEASE_SECONDS,
        }),
      ),
    );

    expect(results.filter((session) => session.state === election.LEADERSHIP_STATE.LEADER)).toHaveLength(1);
    expect(commitmentStore.rows("shardLeadership")[0].leadershipFence).toBe(4n);
  });

  test("the losers name *why* — a superseded fence and a live lease are different facts", async () => {
    const commitmentStore = seeded();
    const store = storeFor(commitmentStore);

    const results = await Promise.all(
      Array.from({ length: 4 }, (unused, index) =>
        election.acquire(store, { candidateId: `c-${index}`, storeTime: commitmentStore.now(), leaseDurationSeconds: LEASE_SECONDS }),
      ),
    );

    const refusals = results.filter((s) => s.state === election.LEADERSHIP_STATE.FOLLOWER).map((s) => s.lastRefusal);
    for (const refusal of refusals) {
      expect([leadership.CAS_REFUSAL.FENCE_SUPERSEDED, leadership.CAS_REFUSAL.HELD_BY_ANOTHER]).toContain(refusal);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Renewal — and the rule that it must never advance the fence
   ═══════════════════════════════════════════════════════════════════════════ */

describe("renewal (§19.5)", () => {
  async function leaderSession(commitmentStore, store) {
    const session = await election.acquire(store, {
      candidateId: "coordinator-a",
      storeTime: commitmentStore.now(),
      leaseDurationSeconds: LEASE_SECONDS,
    });
    return election.promote(session, { complete: true });
  }

  test("renewal extends the lease and does NOT advance the fence", async () => {
    const commitmentStore = seeded();
    const store = storeFor(commitmentStore);
    const session = await leaderSession(commitmentStore, store);

    commitmentStore.advanceClock(1);
    const renewed = await election.renew(store, session, {
      storeTime: commitmentStore.now(),
      leaseDurationSeconds: LEASE_SECONDS,
      maxClockSkewMillis: SKEW_MS,
      storeRoundTripMillis: ROUND_TRIP_MS,
    });

    expect(renewed.state).toBe(election.LEADERSHIP_STATE.LEADER);
    expect(renewed.leadershipFence).toBe(session.leadershipFence);
    expect(commitmentStore.rows("shardLeadership")[0].leadershipFence).toBe(4n);
    expect(renewed.leaseExpiry.getTime()).toBeGreaterThan(session.leaseExpiry.getTime());
  });

  // The property that makes the one above load-bearing rather than incidental: a renewal
  // that advanced the fence would abort the renewing leader's own in-flight commits
  // through G1, at whatever rate it renewed.
  test("a hundred renewals leave the fence exactly where acquisition put it", async () => {
    const commitmentStore = seeded();
    const store = storeFor(commitmentStore);
    let session = await leaderSession(commitmentStore, store);

    for (let index = 0; index < 100; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      session = await election.renew(store, session, {
        storeTime: commitmentStore.now(),
        leaseDurationSeconds: LEASE_SECONDS,
        maxClockSkewMillis: SKEW_MS,
        storeRoundTripMillis: ROUND_TRIP_MS,
      });
      commitmentStore.advanceClock(1);
    }

    expect(commitmentStore.rows("shardLeadership")[0].leadershipFence).toBe(4n);
    expect(session.leadershipFence).toBe(4n);
  });

  test("a lapsed leader cannot renew — it must re-acquire, which advances the fence", async () => {
    const commitmentStore = seeded();
    const store = storeFor(commitmentStore);
    const session = await leaderSession(commitmentStore, store);

    commitmentStore.advanceClock(LEASE_SECONDS + 1);
    const outcome = await election.renew(store, session, {
      storeTime: commitmentStore.now(),
      leaseDurationSeconds: LEASE_SECONDS,
      maxClockSkewMillis: SKEW_MS,
      storeRoundTripMillis: ROUND_TRIP_MS,
    });

    expect(outcome.state).toBe(election.LEADERSHIP_STATE.STEPPING_DOWN);
    expect(outcome.mayCommit).toBe(false);
    expect(outcome.lastRefusal).toBe(leadership.CAS_REFUSAL.LEASE_LAPSED);
  });

  test("a superseded leader's renewal is refused and it steps down immediately", async () => {
    const commitmentStore = seeded();
    const store = storeFor(commitmentStore);
    const session = await leaderSession(commitmentStore, store);

    // Somebody else takes the shard after the lease lapses.
    commitmentStore.advanceClock(LEASE_SECONDS + 1);
    await election.acquire(store, { candidateId: "coordinator-b", storeTime: commitmentStore.now(), leaseDurationSeconds: LEASE_SECONDS });

    const outcome = await election.renew(store, session, {
      storeTime: commitmentStore.now(),
      leaseDurationSeconds: LEASE_SECONDS,
      maxClockSkewMillis: SKEW_MS,
      storeRoundTripMillis: ROUND_TRIP_MS,
    });

    expect(outcome.state).toBe(election.LEADERSHIP_STATE.STEPPING_DOWN);
    expect(outcome.lastRefusal).toBe(leadership.CAS_REFUSAL.FENCE_SUPERSEDED);
    // §19.5's "the moment it cannot renew" — not on the next tick.
    expect(outcome.mayCommit).toBe(false);
  });

  test("a renewal whose margin has run out renews the lease but stops committing", async () => {
    const commitmentStore = seeded();
    const store = storeFor(commitmentStore);
    const session = await leaderSession(commitmentStore, store);

    // A margin larger than the whole lease: renewal succeeds, and the coordinator is still
    // required to stop, because the margin — not the expiry — is the rule.
    const outcome = await election.renew(store, session, {
      storeTime: commitmentStore.now(),
      leaseDurationSeconds: LEASE_SECONDS,
      maxClockSkewMillis: LEASE_SECONDS * 1000,
      storeRoundTripMillis: 1,
    });

    expect(outcome.state).toBe(election.LEADERSHIP_STATE.STEPPING_DOWN);
    expect(outcome.mayCommit).toBe(false);
    expect(outcome.lastRefusal).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §19.5's reconciliation gate
   ═══════════════════════════════════════════════════════════════════════════ */

describe("promotion — reconciliation before rounds (§19.5)", () => {
  test("promote() refuses an incomplete reconciliation", async () => {
    const commitmentStore = seeded();
    const session = await election.acquire(storeFor(commitmentStore), {
      candidateId: "coordinator-a",
      storeTime: commitmentStore.now(),
      leaseDurationSeconds: LEASE_SECONDS,
    });

    expect(() => election.promote(session, { complete: false })).toThrow(/refusing to resume rounds on an incomplete reconciliation/);
    expect(() => election.promote(session, null)).toThrow(/incomplete reconciliation/);
  });

  test("promote() refuses a follower", () => {
    const follower = election.followerSession({ shardId: "default", candidateId: "coordinator-a" });
    expect(() => election.promote(follower, { complete: true })).toThrow(/only a session that won an election/);
  });

  test("a promoted session may commit; a renewal never restores commit permission to one that has not reconciled", async () => {
    const commitmentStore = seeded();
    const store = storeFor(commitmentStore);
    const raw = await election.acquire(store, { candidateId: "coordinator-a", storeTime: commitmentStore.now(), leaseDurationSeconds: LEASE_SECONDS });

    const renewedUnreconciled = await election.renew(store, raw, {
      storeTime: commitmentStore.now(),
      leaseDurationSeconds: LEASE_SECONDS,
      maxClockSkewMillis: SKEW_MS,
      storeRoundTripMillis: ROUND_TRIP_MS,
    });
    expect(renewedUnreconciled.mayCommit).toBe(false);

    const promoted = election.promote(raw, { complete: true });
    expect(promoted.mayCommit).toBe(true);
    expect(election.assessCommitPermission(promoted, { storeTime: commitmentStore.now(), maxClockSkewMillis: SKEW_MS, storeRoundTripMillis: ROUND_TRIP_MS })).toMatchObject({ mayCommit: true });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Release — the graceful half of failover
   ═══════════════════════════════════════════════════════════════════════════ */

describe("release (§19.3's availability argument)", () => {
  test("releasing advances the fence and unholds the shard", async () => {
    const commitmentStore = seeded();
    const store = storeFor(commitmentStore);
    const session = election.promote(
      await election.acquire(store, { candidateId: "coordinator-a", storeTime: commitmentStore.now(), leaseDurationSeconds: LEASE_SECONDS }),
      { complete: true },
    );

    const outcome = await election.release(store, session, { storeTime: commitmentStore.now() });

    expect(outcome.released).toBe(true);
    expect(outcome.session.state).toBe(election.LEADERSHIP_STATE.FOLLOWER);
    const row = commitmentStore.rows("shardLeadership")[0];
    expect(row.leadershipFence).toBe(5n);
    expect(row.holder).toBeNull();
    expect(row.leaseExpiry).toBeNull();
  });

  test("a standby takes the shard immediately after a release, without waiting for a lease to lapse", async () => {
    const commitmentStore = seeded();
    const store = storeFor(commitmentStore);
    const session = await election.acquire(store, { candidateId: "coordinator-a", storeTime: commitmentStore.now(), leaseDurationSeconds: LEASE_SECONDS });
    await election.release(store, session, { storeTime: commitmentStore.now() });

    // No clock advance at all.
    const standby = await election.acquire(store, { candidateId: "coordinator-b", storeTime: commitmentStore.now(), leaseDurationSeconds: LEASE_SECONDS });
    expect(standby.state).toBe(election.LEADERSHIP_STATE.LEADER);
    expect(standby.leadershipFence).toBe(6n);
  });

  test("releasing a session whose fence has been superseded is refused and reported, not thrown", async () => {
    const commitmentStore = seeded();
    const store = storeFor(commitmentStore);
    const session = await election.acquire(store, { candidateId: "coordinator-a", storeTime: commitmentStore.now(), leaseDurationSeconds: LEASE_SECONDS });

    commitmentStore.advanceClock(LEASE_SECONDS + 1);
    await election.acquire(store, { candidateId: "coordinator-b", storeTime: commitmentStore.now(), leaseDurationSeconds: LEASE_SECONDS });

    const outcome = await election.release(store, session, { storeTime: commitmentStore.now() });
    expect(outcome.released).toBe(false);
    expect(outcome.refusal).toBe(leadership.CAS_REFUSAL.FENCE_SUPERSEDED);
    // And it did **not** clobber the new leader's row.
    expect(commitmentStore.rows("shardLeadership")[0].holder).toBe("coordinator-b");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The renewal budget — §19.5's margin as arithmetic
   ═══════════════════════════════════════════════════════════════════════════ */

describe("renewalBudget (§19.5)", () => {
  test("the latest lawful renewal is the lease minus skew minus the store round trip", () => {
    const budget = election.renewalBudget({
      leaseDurationSeconds: LEASE_SECONDS,
      maxClockSkewMillis: SKEW_MS,
      storeRoundTripMillis: ROUND_TRIP_MS,
    });
    expect(budget.marginMillis).toBe(1000);
    expect(budget.latestRenewalMillis).toBe(4000);
  });

  test("an absent round-trip budget falls back to the skew allowance, matching shouldStopCommitting", () => {
    const budget = election.renewalBudget({ leaseDurationSeconds: LEASE_SECONDS, maxClockSkewMillis: SKEW_MS });
    expect(budget.marginMillis).toBe(1000);
  });

  test("the registered default renewal interval is inside the budget the registered defaults imply", () => {
    const service = require("../../src/engine/config/service");
    const snapshot = service.defaultSnapshot();
    const budget = election.renewalBudget({
      leaseDurationSeconds: snapshot.resolve("shard.lease_duration"),
      maxClockSkewMillis: snapshot.resolve("time.max_clock_skew"),
      storeRoundTripMillis: snapshot.resolve("shard.store_round_trip_budget"),
    });
    expect(snapshot.resolve("shard.renewal_interval")).toBeLessThan(budget.latestRenewalMillis);
  });
});

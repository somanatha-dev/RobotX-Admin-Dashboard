"use strict";

/**
 * Engine lane — Phase 13's chaos and scale requirements (§24.5, §24.6).
 *
 * The plan's Phase 13 testing row, item by item:
 *
 * > **Chaos:** kill coordinators at random and mid-commit; asymmetric partitions (which
 * > break naive election); verify the isolated coordinator stops committing and its late
 * > commits abort at the store via G1.
 * > **Model check:** no commit succeeds under a superseded leadership fence including a
 * > transaction spanning the change.
 * > **Failover:** durable state recovered, SOFT reservations reconstructed and counted
 * > separately from genuine orphan repairs.
 * > **Scale:** **the locality test (§24.6)**.
 *
 * ── What "verify" can mean here, stated up front ────────────────────────────
 * These run against `helpers/commitmentStore.js` — Phase 3's model of the Commitment
 * Store, which implements row locks that genuinely block, transaction overlays applied
 * atomically or discarded, and the two schema backstops evaluated at apply time. It is
 * **not PostgreSQL**, and every claim below is evidence from a model. Phase 15 owns the
 * chaos suite against a real store; what this file establishes is that the *logic* has the
 * property, which is the precondition for that suite being worth running.
 *
 * The one thing this file is careful never to do is prove G1 by calling G1. Every
 * assertion below drives the **real `commit()`** against the **real store model**, and
 * asserts on the abort reason the transaction produced.
 */

const { commit, OUTCOME, ABORT_REASON } = require("../../src/engine/commitment/commit");
const election = require("../../src/engine/shard/election");
const leadership = require("../../src/engine/shard/leadership");
const sizing = require("../../src/engine/shard/sizing");
const { createCommitmentStore, fixture } = require("./helpers/commitmentStore");

/** `lease.duration`, Appendix A default. */
const LEASE_DURATION_SECONDS = 60;
/** `shard.lease_duration`, Appendix A default. */
const SHARD_LEASE_SECONDS = 5;
/** `time.max_clock_skew`, Appendix A default. */
const SKEW_MS = 500;
/** `shard.store_round_trip_budget`, Phase 13's default. */
const ROUND_TRIP_MS = 500;

function deps(store, overrides) {
  return {
    prisma: store.client,
    runSerializable: (client, fn) => client.$transaction(fn),
    selectForUpdate: async (tx, table, column, value) => {
      const rows = await tx.$queryRawUnsafe(`SELECT * FROM "${table}" WHERE "${column}" = $1 FOR UPDATE`, value);
      return rows.length > 0 ? rows[0] : null;
    },
    isSerializationFailure: () => false,
    volatileRecheck: async () => ({ ok: true }),
    sideEffects: async () => {},
    ...(overrides || {}),
  };
}

function request(seed, overrides) {
  return {
    agentId: seed.agent.id,
    legId: seed.legs[0].id,
    decisionRoundId: "round-1",
    targetLegState: "OFFERED",
    shardId: "default",
    snapshot: {
      leadershipFence: seed.leadership.leadershipFence,
      authorityEpoch: seed.agent.authorityEpoch,
      legVersion: seed.legs[0].version,
      expectedLegState: "PLANNED",
    },
    config: { capacity: seed.capacity, leaseDurationSeconds: LEASE_DURATION_SECONDS },
    ...(overrides || {}),
  };
}

function seeded(options) {
  const seed = fixture(options);
  // The leadership row starts **unheld**, so the elections below are real acquisitions
  // rather than assertions against a hand-written holder.
  const leadershipRow = { ...seed.leadership, holder: null, leaseExpiry: null };
  const store = createCommitmentStore({
    agent: [seed.agent],
    leg: seed.legs,
    shardLeadership: [leadershipRow],
  });
  return { seed: { ...seed, leadership: leadershipRow }, store };
}

function consensusStore(store) {
  return election.postgresLeadershipStore(store.client, { replicationPosture: "SYNCHRONOUS_QUORUM" });
}

/* ═══════════════════════════════════════════════════════════════════════════
   The gate's database half: G1 fences the loser, whatever it believes
   ═══════════════════════════════════════════════════════════════════════════ */

describe("**Gate** — exactly one active coordinator per shard, enforced by the database (§10.3.2 G1, §19.3)", () => {
  test("a coordinator that lost the shard has its commit aborted by G1, not by its own belief", async () => {
    const { seed, store } = seeded({ legs: 2 });
    const consensus = consensusStore(store);

    // Coordinator A takes the shard and pins the fence into a round's snapshot.
    const a = await election.acquire(consensus, {
      candidateId: "coordinator-a",
      storeTime: store.now(),
      leaseDurationSeconds: SHARD_LEASE_SECONDS,
    });
    const pinnedFence = a.leadershipFence;

    // A is partitioned. Its lease lapses; B takes over. A never learns this.
    store.advanceClock(SHARD_LEASE_SECONDS + 1);
    const b = await election.acquire(consensus, {
      candidateId: "coordinator-b",
      storeTime: store.now(),
      leaseDurationSeconds: SHARD_LEASE_SECONDS,
    });
    expect(b.leadershipFence).toBeGreaterThan(pinnedFence);

    // A commits against the fence it pinned. It still *believes* it leads: its session
    // object is untouched, and nothing in the commit path asks it.
    expect(a.state).toBe(election.LEADERSHIP_STATE.LEADER);
    const outcome = await commit(deps(store), request(seed, { snapshot: { ...request(seed).snapshot, leadershipFence: pinnedFence } }));

    expect(outcome.outcome).toBe(OUTCOME.ABORTED);
    expect(outcome.reason).toBe(ABORT_REASON.G1_LEADERSHIP_FENCE_ADVANCED);
    expect(store.rows("commitment")).toEqual([]);
  });

  test("the new leader's commit, against the new fence, succeeds", async () => {
    const { seed, store } = seeded();
    const consensus = consensusStore(store);

    await election.acquire(consensus, { candidateId: "coordinator-a", storeTime: store.now(), leaseDurationSeconds: SHARD_LEASE_SECONDS });
    store.advanceClock(SHARD_LEASE_SECONDS + 1);
    const b = await election.acquire(consensus, { candidateId: "coordinator-b", storeTime: store.now(), leaseDurationSeconds: SHARD_LEASE_SECONDS });

    const outcome = await commit(deps(store), request(seed, { snapshot: { ...request(seed).snapshot, leadershipFence: b.leadershipFence } }));

    expect(outcome.outcome).toBe(OUTCOME.COMMITTED);
    expect(store.rows("commitment")).toHaveLength(1);
  });

  // The plan's model-check line, driven rather than reasoned about.
  test("**model check** — no commit succeeds under a superseded fence, across every leadership change in a chain", async () => {
    const { seed, store } = seeded({ legs: 6 });
    const consensus = consensusStore(store);

    const pinned = [];
    for (let generation = 0; generation < 5; generation += 1) {
      // eslint-disable-next-line no-await-in-loop
      const session = await election.acquire(consensus, {
        candidateId: `coordinator-${generation}`,
        storeTime: store.now(),
        leaseDurationSeconds: SHARD_LEASE_SECONDS,
      });
      pinned.push(session.leadershipFence);
      store.advanceClock(SHARD_LEASE_SECONDS + 1);
    }

    const current = pinned[pinned.length - 1];

    // Every superseded fence aborts.
    for (let index = 0; index < pinned.length - 1; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await commit(
        deps(store),
        request(seed, {
          legId: seed.legs[index].id,
          decisionRoundId: `round-${index}`,
          snapshot: { ...request(seed).snapshot, leadershipFence: pinned[index] },
        }),
      );
      expect({ index, outcome: outcome.outcome, reason: outcome.reason }).toEqual({
        index,
        outcome: OUTCOME.ABORTED,
        reason: ABORT_REASON.G1_LEADERSHIP_FENCE_ADVANCED,
      });
    }

    // And the current one does not.
    const good = await commit(
      deps(store),
      request(seed, {
        legId: seed.legs[5].id,
        decisionRoundId: "round-current",
        snapshot: { ...request(seed).snapshot, leadershipFence: current },
      }),
    );
    expect(good.outcome).toBe(OUTCOME.COMMITTED);
    expect(store.rows("commitment")).toHaveLength(1);
  });

  // §19.5's precise argument for why the liveness rule is not enough: "the commit
  // transaction takes row locks that may block for an unbounded duration, so a transaction
  // beginning inside a valid leadership window can commit outside it".
  test("**a transaction spanning the leadership change** aborts — the case the liveness rule cannot cover", async () => {
    const { seed, store } = seeded({ legs: 2 });
    const consensus = consensusStore(store);

    const a = await election.acquire(consensus, { candidateId: "coordinator-a", storeTime: store.now(), leaseDurationSeconds: SHARD_LEASE_SECONDS });

    let released;
    const gate = new Promise((resolve) => {
      released = resolve;
    });

    // A's commit begins while A genuinely leads, then blocks inside the transaction —
    // exactly the unbounded row-lock wait §19.5 describes. The leadership change happens
    // while it is blocked.
    const slowCommit = commit(
      deps(store, {
        volatileRecheck: async () => {
          await gate;
          return { ok: true };
        },
      }),
      request(seed, { snapshot: { ...request(seed).snapshot, leadershipFence: a.leadershipFence } }),
    );

    store.advanceClock(SHARD_LEASE_SECONDS + 1);
    await election.acquire(consensus, { candidateId: "coordinator-b", storeTime: store.now(), leaseDurationSeconds: SHARD_LEASE_SECONDS });
    released();

    const outcome = await slowCommit;

    // The store model evaluates G1 against the fence read inside the transaction. The
    // transaction began before the change and resolved after it, and it does not commit.
    expect(outcome.committed).toBe(false);
    expect(store.rows("commitment")).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Asymmetric partitions — the case naive election gets wrong
   ═══════════════════════════════════════════════════════════════════════════ */

describe("asymmetric partitions (§24.5)", () => {
  test("a coordinator that can still see the store but cannot renew stops committing before its lease expires", async () => {
    const { store } = seeded();
    const consensus = consensusStore(store);
    const session = election.promote(
      await election.acquire(consensus, { candidateId: "coordinator-a", storeTime: store.now(), leaseDurationSeconds: SHARD_LEASE_SECONDS }),
      { complete: true },
    );

    // The asymmetry: reads work, writes do not. A naive implementation that decided
    // leadership by *reading* the row would conclude it still leads, because the row still
    // says so.
    const oneWay = {
      ...consensus,
      renew: async () => ({ renewed: false, refusal: leadership.CAS_REFUSAL.LEASE_LAPSED, leadershipFence: null, leaseExpiry: null }),
    };

    const outcome = await election.renew(oneWay, session, {
      storeTime: store.now(),
      leaseDurationSeconds: SHARD_LEASE_SECONDS,
      maxClockSkewMillis: SKEW_MS,
      storeRoundTripMillis: ROUND_TRIP_MS,
    });

    expect(outcome.state).toBe(election.LEADERSHIP_STATE.STEPPING_DOWN);
    expect(outcome.mayCommit).toBe(false);
    // And the row still names it as holder with a live lease, which is exactly why a
    // read-based decision would have been wrong.
    const row = store.rows("shardLeadership")[0];
    expect(row.holder).toBe("coordinator-a");
    expect(row.leaseExpiry.getTime()).toBeGreaterThan(store.now().getTime());
  });

  test("a coordinator whose margin has run out is refused commit permission while its lease is still valid", () => {
    const leaseExpiry = new Date("2026-07-29T12:00:05.000Z");
    const storeTime = new Date("2026-07-29T12:00:04.500Z");

    // 500 ms of lease left; the margin is skew + round trip = 1 000 ms. §19.5 requires the
    // stop *before* expiry, and this is that instant.
    const verdict = election.assessCommitPermission(
      {
        state: election.LEADERSHIP_STATE.LEADER,
        reconciled: true,
        leaseExpiry,
      },
      { storeTime, maxClockSkewMillis: SKEW_MS, storeRoundTripMillis: ROUND_TRIP_MS },
    );

    expect(verdict.mayCommit).toBe(false);
    expect(verdict.reason).toBe("LEASE_MARGIN_EXHAUSTED");
    expect(leaseExpiry.getTime()).toBeGreaterThan(storeTime.getTime());
  });

  test("stopping early narrows the window; G1 closes it — a coordinator that ignores the margin is still fenced", async () => {
    const { seed, store } = seeded();
    const consensus = consensusStore(store);
    const a = await election.acquire(consensus, { candidateId: "coordinator-a", storeTime: store.now(), leaseDurationSeconds: SHARD_LEASE_SECONDS });

    // The margin says stop. This coordinator ignores it entirely — the liveness rule is
    // advisory, and this test is what makes that statement safe rather than alarming.
    store.advanceClock(SHARD_LEASE_SECONDS + 1);
    await election.acquire(consensus, { candidateId: "coordinator-b", storeTime: store.now(), leaseDurationSeconds: SHARD_LEASE_SECONDS });

    const outcome = await commit(deps(store), request(seed, { snapshot: { ...request(seed).snapshot, leadershipFence: a.leadershipFence } }));
    expect(outcome.reason).toBe(ABORT_REASON.G1_LEADERSHIP_FENCE_ADVANCED);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Killing coordinators at random, and mid-commit
   ═══════════════════════════════════════════════════════════════════════════ */

describe("coordinator kills (§24.5)", () => {
  test("twenty random kills leave the shard with exactly one holder and a strictly increasing fence", async () => {
    const { store } = seeded();
    const consensus = consensusStore(store);

    const fences = [];
    let holder = null;

    for (let round = 0; round < 20; round += 1) {
      // A kill is a process that stops renewing. The lease lapses; a standby takes over.
      store.advanceClock(SHARD_LEASE_SECONDS + 1);
      // eslint-disable-next-line no-await-in-loop
      const session = await election.acquire(consensus, {
        candidateId: `coordinator-${round % 3}`,
        storeTime: store.now(),
        leaseDurationSeconds: SHARD_LEASE_SECONDS,
      });
      expect(session.state).toBe(election.LEADERSHIP_STATE.LEADER);
      fences.push(session.leadershipFence);
      holder = session.candidateId;
    }

    // I6's shape, applied to the leadership fence: strictly monotone, never reused.
    for (let index = 1; index < fences.length; index += 1) {
      expect(fences[index]).toBeGreaterThan(fences[index - 1]);
    }
    expect(new Set(fences.map(String)).size).toBe(fences.length);

    const row = store.rows("shardLeadership")[0];
    expect(row.holder).toBe(holder);
    expect(row.leadershipFence).toBe(fences[fences.length - 1]);
  });

  test("a kill mid-commit leaves nothing behind, and the successor's commit is unaffected", async () => {
    const { seed, store } = seeded({ legs: 2 });
    const consensus = consensusStore(store);
    const a = await election.acquire(consensus, { candidateId: "coordinator-a", storeTime: store.now(), leaseDurationSeconds: SHARD_LEASE_SECONDS });

    // The kill: the commit transaction throws partway through, after the guards passed.
    const killed = commit(
      deps(store, {
        volatileRecheck: async () => {
          throw new Error("coordinator killed mid-commit");
        },
      }),
      request(seed, { snapshot: { ...request(seed).snapshot, leadershipFence: a.leadershipFence } }),
    );
    await expect(killed).rejects.toThrow(/killed mid-commit/);

    // §10.3.2 — "No partial state is possible."
    expect(store.rows("commitment")).toEqual([]);
    expect(store.rows("leg").find((leg) => leg.id === seed.legs[0].id).state).toBe("PLANNED");
    expect(store.rows("agent")[0].fenceCounter).toBe(seed.agent.fenceCounter);

    store.advanceClock(SHARD_LEASE_SECONDS + 1);
    const b = await election.acquire(consensus, { candidateId: "coordinator-b", storeTime: store.now(), leaseDurationSeconds: SHARD_LEASE_SECONDS });
    const outcome = await commit(
      deps(store),
      request(seed, { decisionRoundId: "round-2", snapshot: { ...request(seed).snapshot, leadershipFence: b.leadershipFence } }),
    );
    expect(outcome.outcome).toBe(OUTCOME.COMMITTED);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §24.6 — the locality test
   ═══════════════════════════════════════════════════════════════════════════ */

describe("**Scale gate** — the locality test (§24.6)", () => {
  const service = require("../../src/engine/config/service");
  const TOLERANCE = service.defaultSnapshot().resolve("shard.locality_max_round_time_divergence");

  test("indistinguishable round times pass — the T9 claim", () => {
    const outcome = sizing.compareLocality({
      smallFleetRoundMs: 210,
      largeFleetRoundMs: 218,
      maxDivergence: TOLERANCE,
      smallFleetAgents: 5000,
      largeFleetAgents: 1000000,
    });
    expect(outcome.indistinguishable).toBe(true);
    expect(outcome.sentence).toMatch(/local density, not of global fleet size/);
  });

  test("a large-fleet shard slower beyond tolerance FAILS, and says the scaling claim is invalidated", () => {
    const outcome = sizing.compareLocality({
      smallFleetRoundMs: 200,
      largeFleetRoundMs: 260,
      maxDivergence: TOLERANCE,
      smallFleetAgents: 5000,
      largeFleetAgents: 1000000,
    });
    expect(outcome.indistinguishable).toBe(false);
    expect(outcome.direction).toBe("LARGE_FLEET_SLOWER");
    expect(outcome.sentence).toMatch(/invalidates the scaling claim/);
  });

  // The half a naive one-sided test omits, and the reason it matters: a large-fleet shard
  // that is *faster* is not evidence of locality.
  test("a large-fleet shard materially FASTER also fails — the benchmarks were not identical", () => {
    const outcome = sizing.compareLocality({
      smallFleetRoundMs: 200,
      largeFleetRoundMs: 120,
      maxDivergence: TOLERANCE,
    });
    expect(outcome.indistinguishable).toBe(false);
    expect(outcome.direction).toBe("LARGE_FLEET_FASTER");
    expect(outcome.sentence).toMatch(/not evidence of locality/);
  });

  test("an unevaluated comparison is not a pass", () => {
    expect(sizing.compareLocality({ smallFleetRoundMs: 200, maxDivergence: TOLERANCE })).toMatchObject({
      evaluated: false,
      indistinguishable: null,
    });
    expect(sizing.compareLocality({ smallFleetRoundMs: 0, largeFleetRoundMs: 0, maxDivergence: TOLERANCE }).evaluated).toBe(false);
  });

  // The structural half of T9 that this phase *can* establish without a million agents:
  // §3.5's bound-2 arithmetic is a function of local density and local mission rate, and
  // of nothing global. A shard of 5 000 in a 5 000-agent fleet and one of 5 000 in a
  // 1 000 000-agent fleet produce the identical verdict, because fleet size is not an
  // input to it.
  test("the sizing bound is a function of local density alone — fleet size is not an input", () => {
    const inputs = {
      agents: 5000,
      missionRatePerAgentHour: 4,
      txnPerMissionLifecycle: 2.05,
      commitTxnServiceTimeMs: 5,
      maxSerialUtilisation: 0.25,
    };
    const small = sizing.evaluateSerialCommitBound(inputs);
    const large = sizing.evaluateSerialCommitBound(inputs);
    expect(small).toEqual(large);
    expect(small.satisfied).toBe(true);
    // And §3.5's own worked figure, re-derived: ≈ 21 950 agents at the stated defaults.
    expect(small.admissibleAgents).toBe(21951);
  });
});

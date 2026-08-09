"use strict";

/**
 * Phase 3 — the commit transaction (§10.3.2) end to end.
 *
 * The plan's testing requirements this suite discharges:
 *
 * > Integration: **concurrent commit storm against one agent yields exactly one
 * > winner.**
 * > Chaos: **pause a worker mid-finalisation beyond lease duration, resume, assert
 * > abort.**
 * > **Gate:** schema constraints reject violations **independently of application
 * > logic**.
 *
 * The store these run against models row locks that genuinely block, atomic overlay
 * application, and the two schema backstops evaluated at apply time against globally
 * committed state — see `helpers/commitmentStore.js` for what it does and does not
 * model. It is not PostgreSQL, and the report says so.
 */

const { commit, OUTCOME, ABORT_REASON } = require("../../src/engine/commitment/commit");
const idempotency = require("../../src/engine/commitment/idempotency");
const leadership = require("../../src/engine/shard/leadership");
const model = require("../../src/engine/commitment/model");
const { createCommitmentStore, fixture } = require("./helpers/commitmentStore");

/** `lease.duration`, Appendix A default. */
const LEASE_DURATION_SECONDS = 60;
/** `shard.lease_duration`, Appendix A default. */
const SHARD_LEASE_DURATION_SECONDS = 5;
/** `time.max_clock_skew`, Appendix A default. */
const MAX_CLOCK_SKEW_MS = 500;

/**
 * Build the dependency set. `volatileRecheck` and `sideEffects` are supplied
 * explicitly by every caller — the commit path refuses to run without either, which is
 * asserted below.
 *
 * `sideEffects` became required in Phase 4: §10.3.2 step 5 is unconditional, and it is
 * the only place the Phase 4 gate ("no command reaches an agent except via an outbox
 * row written in the authorising transaction") can be enforced rather than reviewed.
 * Phase 3 admitted its absence because no dispatcher existed to write a row.
 */
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
    planSnapshotRef: "plan-1",
    decisionRef: "decision-1",
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
  const store = createCommitmentStore({
    agent: [seed.agent],
    leg: seed.legs,
    shardLeadership: [seed.leadership],
  });
  return { seed, store };
}

/* ═══════════════════════════════════════════════════════════════════════════
   The nominal commit — §10.3.2 steps 1 through 7
   ═══════════════════════════════════════════════════════════════════════════ */

describe("a nominal commit", () => {
  test("writes one commitment, advances fence_counter, and moves the Leg", async () => {
    const { seed, store } = seeded();
    const result = await commit(deps(store), request(seed));

    expect(result.outcome).toBe(OUTCOME.COMMITTED);
    expect(store.rows("commitment")).toHaveLength(1);

    const commitment = store.rows("commitment")[0];
    expect(commitment.fence).toBe(42n);
    expect(commitment.kind).toBe("HARD");
    expect(commitment.capacitySlot).toBe(0);
    expect(commitment.releasedAt).toBeNull();

    expect(store.rows("agent")[0].fenceCounter).toBe(42n);
    expect(store.rows("leg")[0]).toMatchObject({ state: "OFFERED", version: 1 });
  });

  test("does NOT advance authority_epoch (§10.3.2 step 4, invariant I19)", async () => {
    const { seed, store } = seeded();
    await commit(deps(store), request(seed));
    expect(store.rows("agent")[0].authorityEpoch).toBe(seed.agent.authorityEpoch);
  });

  test("grants a lease from the store's clock, never a worker's", async () => {
    const { seed, store } = seeded();
    await commit(deps(store), request(seed));
    const commitment = store.rows("commitment")[0];
    expect(commitment.leaseExpiry.getTime()).toBe(store.now().getTime() + LEASE_DURATION_SECONDS * 1000);
  });

  test("carries the plan snapshot and the decision reference (§10.3.2 step 6)", async () => {
    const { seed, store } = seeded();
    await commit(deps(store), request(seed));
    expect(store.rows("commitment")[0]).toMatchObject({ planSnapshotRef: "plan-1", decisionRef: "decision-1" });
  });

  test("writes the I6 high-water mark in the same transaction", async () => {
    const { seed, store } = seeded();
    await commit(deps(store), request(seed));
    const audit = store.rows("agentFenceAudit")[0];
    expect(audit).toMatchObject({ agentId: seed.agent.id, fenceHighWater: 42n, epochHighWater: 7n });
    expect(audit.lastFenceSource).toBe(store.rows("commitment")[0].commitmentId);
  });

  test("takes the agent lock before the Leg lock, always", async () => {
    const { seed, store } = seeded();
    const order = [];
    const dependencies = deps(store, {
      selectForUpdate: async (tx, table, column, value) => {
        order.push(table);
        const rows = await tx.$queryRawUnsafe(`SELECT * FROM "${table}" WHERE "${column}" = $1 FOR UPDATE`, value);
        return rows.length > 0 ? rows[0] : null;
      },
    });
    await commit(dependencies, request(seed));
    expect(order).toEqual(["Agent", "Leg"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §10.5 — idempotency
   ═══════════════════════════════════════════════════════════════════════════ */

describe("idempotency (§10.5)", () => {
  test("a retried commit observes its own prior commitment and never double-commits", async () => {
    const { seed, store } = seeded();
    const first = await commit(deps(store), request(seed));
    const second = await commit(deps(store), request(seed));

    expect(first.outcome).toBe(OUTCOME.COMMITTED);
    expect(second.outcome).toBe(OUTCOME.ALREADY_COMMITTED);
    expect(second.committed).toBe(true);
    expect(store.rows("commitment")).toHaveLength(1);
  });

  test("the retry allocates no second fence", async () => {
    const { seed, store } = seeded();
    await commit(deps(store), request(seed));
    await commit(deps(store), request(seed));
    expect(store.rows("agent")[0].fenceCounter).toBe(42n);
  });

  test("the commitment id is the deterministic §10.5 derivation", async () => {
    const { seed, store } = seeded();
    await commit(deps(store), request(seed));
    expect(store.rows("commitment")[0].commitmentId).toBe(
      idempotency.commitmentIdFor({ legId: seed.legs[0].id, agentId: seed.agent.id, decisionRoundId: "round-1" }),
    );
  });

  test("a different round is a different commit, and the guards decide it", async () => {
    const { seed, store } = seeded();
    await commit(deps(store), request(seed));
    // Same Leg, same agent, new round: G2 (agent at capacity) and G4 (Leg version
    // moved) both refuse it. Nothing is written.
    const second = await commit(deps(store), request(seed, { decisionRoundId: "round-2" }));
    expect(second.outcome).toBe(OUTCOME.ABORTED);
    expect(store.rows("commitment")).toHaveLength(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The concurrent commit storm
   ═══════════════════════════════════════════════════════════════════════════ */

describe("a concurrent commit storm against one agent", () => {
  test("yields exactly one winner at capacity 1", async () => {
    const { seed, store } = seeded({ legs: 8 });
    const dependencies = deps(store);

    const attempts = seed.legs.map((leg, index) =>
      commit(
        dependencies,
        request(seed, {
          legId: leg.id,
          decisionRoundId: `round-${index}`,
          snapshot: {
            leadershipFence: seed.leadership.leadershipFence,
            authorityEpoch: seed.agent.authorityEpoch,
            legVersion: leg.version,
            expectedLegState: "PLANNED",
          },
        }),
      ),
    );

    const results = await Promise.all(attempts);
    const winners = results.filter((result) => result.outcome === OUTCOME.COMMITTED);

    expect(winners).toHaveLength(1);
    expect(store.rows("commitment")).toHaveLength(1);
    expect(store.rows("commitment").filter(model.isActive)).toHaveLength(1);
  });

  test("every loser aborts on G2 with nothing written", async () => {
    const { seed, store } = seeded({ legs: 6 });
    const dependencies = deps(store);

    const results = await Promise.all(
      seed.legs.map((leg, index) =>
        commit(
          dependencies,
          request(seed, {
            legId: leg.id,
            decisionRoundId: `round-${index}`,
            snapshot: {
              leadershipFence: seed.leadership.leadershipFence,
              authorityEpoch: seed.agent.authorityEpoch,
              legVersion: leg.version,
              expectedLegState: "PLANNED",
            },
          }),
        ),
      ),
    );

    const losers = results.filter((result) => result.outcome === OUTCOME.ABORTED);
    expect(losers).toHaveLength(seed.legs.length - 1);
    for (const loser of losers) {
      expect(loser.reason).toBe(ABORT_REASON.G2_AGENT_AT_CAPACITY);
    }
    // A loser's Leg is untouched: no partial state is possible.
    const movedLegs = store.rows("leg").filter((leg) => leg.state !== "PLANNED");
    expect(movedLegs).toHaveLength(1);
  });

  test("the fence counter advanced exactly once — one winner, one fence", async () => {
    const { seed, store } = seeded({ legs: 5 });
    const dependencies = deps(store);
    await Promise.all(
      seed.legs.map((leg, index) =>
        commit(
          dependencies,
          request(seed, {
            legId: leg.id,
            decisionRoundId: `round-${index}`,
            snapshot: {
              leadershipFence: seed.leadership.leadershipFence,
              authorityEpoch: seed.agent.authorityEpoch,
              legVersion: leg.version,
              expectedLegState: "PLANNED",
            },
          }),
        ),
      ),
    );
    expect(store.rows("agent")[0].fenceCounter).toBe(42n);
  });

  test("at capacity 2, exactly two win and each holds its own slot and fence (I19)", async () => {
    const { seed, store } = seeded({ legs: 6, capacity: 2 });
    const dependencies = deps(store);

    const results = await Promise.all(
      seed.legs.map((leg, index) =>
        commit(
          dependencies,
          request(seed, {
            legId: leg.id,
            decisionRoundId: `round-${index}`,
            snapshot: {
              leadershipFence: seed.leadership.leadershipFence,
              authorityEpoch: seed.agent.authorityEpoch,
              legVersion: leg.version,
              expectedLegState: "PLANNED",
            },
          }),
        ),
      ),
    );

    expect(results.filter((result) => result.outcome === OUTCOME.COMMITTED)).toHaveLength(2);

    const commitments = store.rows("commitment");
    expect(commitments).toHaveLength(2);
    expect(commitments.map((entry) => entry.capacitySlot).sort()).toEqual([0, 1]);
    expect(new Set(commitments.map((entry) => String(entry.fence))).size).toBe(2);

    // I19: neither commit disturbed the other's authority.
    expect(store.rows("agent")[0].authorityEpoch).toBe(seed.agent.authorityEpoch);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Chaos — a paused worker
   ═══════════════════════════════════════════════════════════════════════════ */

describe("chaos: a worker paused mid-finalisation beyond the lease duration", () => {
  /**
   * The scenario §10.3.3 describes: a coordinator's transaction begins inside a valid
   * leadership window, the worker pauses, its leadership lapses and another
   * coordinator takes the shard — advancing the fence — and then the paused worker
   * resumes and tries to finalise.
   */
  async function pausedCommit(options) {
    const { seed, store } = seeded();
    let releasePause;
    const paused = new Promise((resolve) => {
      releasePause = resolve;
    });
    let reachedPause;
    const atPause = new Promise((resolve) => {
      reachedPause = resolve;
    });

    // The pause happens *before* the named row is locked, which is what makes it a
    // pause the outside world can act through: a lock the paused worker already
    // holds would block the very change the scenario needs, exactly as it would in
    // PostgreSQL.
    const pauseBefore = options.pauseBeforeLockOn || "Leg";

    const dependencies = deps(store, {
      selectForUpdate: async (tx, table, column, value) => {
        if (table === pauseBefore) {
          reachedPause();
          await paused;
        }
        const rows = await tx.$queryRawUnsafe(`SELECT * FROM "${table}" WHERE "${column}" = $1 FOR UPDATE`, value);
        return rows.length > 0 ? rows[0] : null;
      },
    });

    const attempt = commit(dependencies, request(seed));
    await atPause;

    // ── The world moves on while the worker is paused ──
    store.advanceClock(LEASE_DURATION_SECONDS + SHARD_LEASE_DURATION_SECONDS + 1);
    await options.duringPause(store, seed);

    releasePause();
    return { result: await attempt, store, seed };
  }

  test("resumes to an abort on G1 when the shard's leadership changed", async () => {
    const { result, store } = await pausedCommit({
      duringPause: async (store_) => {
        await leadership.advanceFence(store_.client, {
          holder: "coordinator-b",
          advancedBy: "chaos-test",
          storeTime: store_.now(),
          leaseDurationSeconds: SHARD_LEASE_DURATION_SECONDS,
        });
      },
    });

    expect(result.outcome).toBe(OUTCOME.ABORTED);
    expect(result.reason).toBe(ABORT_REASON.G1_LEADERSHIP_FENCE_ADVANCED);
    expect(store.rows("commitment")).toHaveLength(0);
    expect(store.rows("agent")[0].fenceCounter).toBe(41n);
    expect(store.rows("leg")[0]).toMatchObject({ state: "PLANNED", version: 0 });
  });

  test("resumes to an abort on G3 when the agent was quarantined during the pause", async () => {
    const { result, store } = await pausedCommit({
      pauseBeforeLockOn: "Agent",
      duringPause: async (store_, seed) => {
        await store_.client.agent.update({ where: { id: seed.agent.id }, data: { authorityEpoch: 8n } });
      },
    });

    expect(result.outcome).toBe(OUTCOME.ABORTED);
    expect(result.reason).toBe(ABORT_REASON.G3_AUTHORITY_EPOCH_CHANGED);
    expect(store.rows("commitment")).toHaveLength(0);
  });

  test("the coordinator's own liveness rule tells it to stop *before* the lease expires", async () => {
    // §19.5: "A coordinator MUST stop committing the moment it cannot renew its
    // lease, *before* the lease actually expires, leaving a margin of
    // `time.max_clock_skew` plus the store's round-trip budget. Stopping early
    // narrows the window; **guard G1 closes it.**"
    //
    // Both halves are asserted here so it is clear which one is load-bearing: this
    // rule fires while the lease is still technically valid, and the chaos cases
    // above show that ignoring it entirely still ends in an abort at the store.
    const { store, seed } = seeded();
    store.advanceClock(29);

    expect(seed.leadership.leaseExpiry.getTime()).toBeGreaterThan(store.now().getTime());

    const verdict = leadership.shouldStopCommitting({
      leaseExpiry: seed.leadership.leaseExpiry,
      storeTime: store.now(),
      maxClockSkewMillis: MAX_CLOCK_SKEW_MS,
    });
    expect(verdict.shouldStop).toBe(true);
    expect(verdict.reason).toBe("LEASE_MARGIN_EXHAUSTED");
  });

  test("with margin remaining, the coordinator keeps committing", () => {
    const { store, seed } = seeded();
    store.advanceClock(SHARD_LEASE_DURATION_SECONDS);
    expect(
      leadership.shouldStopCommitting({
        leaseExpiry: seed.leadership.leaseExpiry,
        storeTime: store.now(),
        maxClockSkewMillis: MAX_CLOCK_SKEW_MS,
      }).shouldStop,
    ).toBe(false);
  });

  test("a coordinator with no leadership lease is told to stop", () => {
    const { store } = seeded();
    expect(
      leadership.shouldStopCommitting({
        leaseExpiry: null,
        storeTime: store.now(),
        maxClockSkewMillis: MAX_CLOCK_SKEW_MS,
      }),
    ).toMatchObject({ shouldStop: true, reason: "NO_LEADERSHIP_LEASE" });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The schema backstops, exercised WITHOUT the commit path
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the schema backstops reject violations independently of application logic", () => {
  /**
   * These write straight to the store, bypassing every guard — the "defective code
   * path" §10.3.2 requires the schema to catch:
   *
   * > Application logic and schema constraints are independent lines of defence, and
   * > the schema one is the one that cannot be bypassed by a new call site.
   */
  function directCommitment(seed, overrides) {
    return {
      id: `direct-${(overrides && overrides.commitmentId) || "x"}`,
      commitmentId: (overrides && overrides.commitmentId) || "direct-1",
      agentId: seed.agent.id,
      legId: seed.legs[0].id,
      kind: "HARD",
      fence: 99n,
      leaseExpiry: new Date("2026-07-29T12:01:00.000Z"),
      custodyState: "NONE",
      version: 0,
      releasedAt: null,
      capacitySlot: 0,
      ...(overrides || {}),
    };
  }

  test("the partial unique index refuses a second active commitment in the same slot (I1)", async () => {
    const { seed, store } = seeded();
    await store.insertCommitmentDirectly(directCommitment(seed, { commitmentId: "direct-1" }));
    await expect(
      store.insertCommitmentDirectly(directCommitment(seed, { commitmentId: "direct-2" })),
    ).rejects.toThrow(/Commitment_agent_capacity_slot_active_key/);
    expect(store.rows("commitment")).toHaveLength(1);
  });

  test("a released commitment frees its slot, because the index is partial", async () => {
    const { seed, store } = seeded();
    await store.insertCommitmentDirectly(
      directCommitment(seed, { commitmentId: "direct-1", releasedAt: new Date("2026-07-29T11:00:00.000Z") }),
    );
    await expect(
      store.insertCommitmentDirectly(directCommitment(seed, { commitmentId: "direct-2" })),
    ).resolves.toBeDefined();
  });

  test("the slot-bound trigger refuses a slot at or beyond the agent's durable capacity (I1)", async () => {
    const { seed, store } = seeded();
    await expect(
      store.insertCommitmentDirectly(directCommitment(seed, { commitmentId: "direct-1", capacitySlot: 1 })),
    ).rejects.toThrow(/durable capacity is 1/);
  });

  test("at capacity 2 the trigger admits slot 1 and still refuses slot 2", async () => {
    const { seed, store } = seeded({ capacity: 2 });
    await expect(
      store.insertCommitmentDirectly(directCommitment(seed, { commitmentId: "direct-1", capacitySlot: 1 })),
    ).resolves.toBeDefined();
    await expect(
      store.insertCommitmentDirectly(directCommitment(seed, { commitmentId: "direct-2", capacitySlot: 2 })),
    ).rejects.toThrow(/durable capacity is 2/);
  });

  test("the HARD-only CHECK refuses a SOFT reservation (I18)", async () => {
    const { seed, store } = seeded();
    await expect(
      store.insertCommitmentDirectly(directCommitment(seed, { commitmentId: "direct-1", kind: "SOFT" })),
    ).rejects.toThrow(/Commitment_kind_hard_only/);
    expect(store.rows("commitment")).toHaveLength(0);
  });

  test("the commit path reports a backstop rejection rather than throwing it at the round", async () => {
    const { seed, store } = seeded();
    // A defective slot allocator: hand every commit slot 5 regardless of capacity.
    const dependencies = deps(store, {
      selectForUpdate: async (tx, table, column, value) => {
        const rows = await tx.$queryRawUnsafe(`SELECT * FROM "${table}" WHERE "${column}" = $1 FOR UPDATE`, value);
        return rows.length > 0 ? rows[0] : null;
      },
    });
    const originalLowestFreeSlot = model.lowestFreeSlot;
    model.lowestFreeSlot = () => 5;
    try {
      const result = await commit(dependencies, request(seed));
      expect(result.outcome).toBe(OUTCOME.ABORTED);
      expect(result.reason).toBe(ABORT_REASON.CAPACITY_CONSTRAINT_VIOLATED);
      expect(store.rows("commitment")).toHaveLength(0);
    } finally {
      model.lowestFreeSlot = originalLowestFreeSlot;
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The two seams, and what the commit path refuses to do without them
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the volatile re-check seam (§10.3.2 step 3)", () => {
  test("commit refuses to run at all when no re-check is registered", async () => {
    const { seed, store } = seeded();
    await expect(commit(deps(store, { volatileRecheck: undefined }), request(seed))).rejects.toThrow(
      /requires a volatile-subset re-check/,
    );
    expect(store.rows("commitment")).toHaveLength(0);
  });

  test("a lost volatile predicate aborts the commit with nothing written", async () => {
    const { seed, store } = seeded();
    const result = await commit(
      deps(store, {
        volatileRecheck: async () => ({ ok: false, reason: "F34_ENERGY_INFEASIBLE", detail: "battery drained" }),
      }),
      request(seed),
    );
    expect(result.outcome).toBe(OUTCOME.ABORTED);
    expect(result.reason).toBe("F34_ENERGY_INFEASIBLE");
    expect(store.rows("commitment")).toHaveLength(0);
    expect(store.rows("agent")[0].fenceCounter).toBe(41n);
  });

  test("the re-check runs under the row locks and after the guards", async () => {
    const { seed, store } = seeded();
    const seen = [];
    await commit(
      deps(store, {
        volatileRecheck: async (context) => {
          seen.push({ hasAgent: Boolean(context.agent), hasLeg: Boolean(context.leg), hasStoreTime: Boolean(context.storeTime) });
          return { ok: true };
        },
      }),
      request(seed),
    );
    expect(seen).toEqual([{ hasAgent: true, hasLeg: true, hasStoreTime: true }]);
  });

  test("a re-check returning anything other than ok:true is treated as a failure", async () => {
    const { seed, store } = seeded();
    for (const verdict of [null, undefined, {}, { ok: "yes" }]) {
      const result = await commit(deps(store, { volatileRecheck: async () => verdict }), request(seed));
      expect(result.outcome).toBe(OUTCOME.ABORTED);
    }
    expect(store.rows("commitment")).toHaveLength(0);
  });
});

describe("the side-effect seam (§4.1 rule 5, §11.1)", () => {
  test("runs inside the same transaction as the commit it is authorised by", async () => {
    const { seed, store } = seeded();
    let sawUncommittedState = null;
    await commit(
      deps(store, {
        sideEffects: async (tx, context) => {
          // The commitment is visible to this callback because it is the same
          // transaction; it is not visible outside until the transaction lands.
          sawUncommittedState = {
            inside: (await tx.commitment.findMany({ where: {} })).length,
            outside: store.rows("commitment").length,
            fence: context.fence,
          };
        },
      }),
      request(seed),
    );
    expect(sawUncommittedState).toEqual({ inside: 1, outside: 0, fence: 42n });
    expect(store.rows("commitment")).toHaveLength(1);
  });

  test("a failing side effect rolls the whole commit back — no partial state", async () => {
    const { seed, store } = seeded();
    await expect(
      commit(
        deps(store, {
          sideEffects: async () => {
            throw new Error("outbox write failed");
          },
        }),
        request(seed),
      ),
    ).rejects.toThrow(/outbox write failed/);

    expect(store.rows("commitment")).toHaveLength(0);
    expect(store.rows("agent")[0].fenceCounter).toBe(41n);
    expect(store.rows("leg")[0]).toMatchObject({ state: "PLANNED", version: 0 });
    expect(store.rows("agentFenceAudit")).toHaveLength(0);
  });
});

describe("failure paths preserve consistency", () => {
  test("a serialisation failure returns the pairing to the round, writing nothing", async () => {
    const { seed, store } = seeded();
    const result = await commit(
      deps(store, {
        runSerializable: async () => {
          const error = new Error("could not serialize access due to concurrent update");
          error.code = "40001";
          throw error;
        },
        isSerializationFailure: (error) => error.code === "40001",
      }),
      request(seed),
    );
    expect(result.outcome).toBe(OUTCOME.ABORTED);
    expect(result.reason).toBe(ABORT_REASON.SERIALIZATION_FAILURE);
    expect(store.rows("commitment")).toHaveLength(0);
  });

  test("commit does not retry a serialisation failure itself", async () => {
    const { seed, store } = seeded();
    let attempts = 0;
    await commit(
      deps(store, {
        runSerializable: async () => {
          attempts += 1;
          const error = new Error("40001");
          throw error;
        },
        isSerializationFailure: () => true,
      }),
      request(seed),
    );
    expect(attempts).toBe(1);
  });

  test("a missing agent or Leg aborts rather than creating one", async () => {
    const { seed, store } = seeded();
    const missingAgent = await commit(deps(store), request(seed, { agentId: "agent-none" }));
    expect(missingAgent.reason).toBe(ABORT_REASON.AGENT_NOT_FOUND);
    const missingLeg = await commit(deps(store), request(seed, { legId: "leg-none" }));
    expect(missingLeg.reason).toBe(ABORT_REASON.LEG_NOT_FOUND);
    expect(store.rows("commitment")).toHaveLength(0);
  });

  test("an unexpected error is not swallowed", async () => {
    const { seed, store } = seeded();
    await expect(
      commit(
        deps(store, {
          runSerializable: async () => {
            throw new Error("connection reset");
          },
        }),
        request(seed),
      ),
    ).rejects.toThrow(/connection reset/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The advisory cache lock (§10.4)
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the commit path takes no cache dependency (§10.4, invariant I16)", () => {
  test("commit.js imports no cache module", () => {
    const source = require("fs").readFileSync(
      require("path").join(__dirname, "..", "..", "src", "engine", "commitment", "commit.js"),
      "utf8",
    );
    expect(source).not.toMatch(/require\(["'].*cache\//);
    expect(source).not.toMatch(/\bkv\./);
  });

  test("no module in the commitment core reaches for Redis", () => {
    const fs = require("fs");
    const path = require("path");
    const directory = path.join(__dirname, "..", "..", "src", "engine", "commitment");
    for (const file of fs.readdirSync(directory)) {
      const source = fs.readFileSync(path.join(directory, file), "utf8");
      expect({ file, reachesForRedis: /ioredis|cache\/kv/.test(source) }).toEqual({ file, reachesForRedis: false });
    }
  });

  test("an advisory reserveRobot grants the lock when Redis is unreachable, rather than halting", async () => {
    const { initKv } = require("../../src/cache/kv");
    const previous = { url: process.env.REDIS_URL, enabled: process.env.REDIS_ENABLED };
    process.env.REDIS_URL = "redis://127.0.0.1:6399";
    process.env.REDIS_ENABLED = "true";
    const { kv, close } = await initKv({ logger: { info() {}, warn() {}, error() {} } });
    try {
      // §10.4 — "cache unavailability MUST NOT halt commitment".
      await expect(kv.reserveRobot("robotReserve:a", "task", 30, { advisory: true })).resolves.toBe(true);
      // PHASE 15 — the default flipped. The plan's Redis row retires "robotReserve:*
      // reliance for correctness (it remains advisory)", and the condition it waited on —
      // the durable path being live — is met, so an unqualified caller is advisory too.
      await expect(kv.reserveRobot("robotReserve:a", "task", 30)).resolves.toBe(true);
      // The fail-closed behaviour is retained and reachable, for a caller that declares it
      // has no other exclusivity mechanism. No caller in this repository does.
      await expect(kv.reserveRobot("robotReserve:a", "task", 30, { advisory: false })).rejects.toThrow(
        /LOCK_UNAVAILABLE|unreachable/,
      );
    } finally {
      await close();
      process.env.REDIS_URL = previous.url === undefined ? "" : previous.url;
      if (previous.enabled === undefined) delete process.env.REDIS_ENABLED;
      else process.env.REDIS_ENABLED = previous.enabled;
    }
  });
});

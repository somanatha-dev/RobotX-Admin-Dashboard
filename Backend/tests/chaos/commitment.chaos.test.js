"use strict";

/**
 * §24.5 — chaos and fault injection against the commitment core, at capacity 1 **and 2**.
 *
 * Each `describe` below is one line of §24.5, quoted where it is discharged. Every one runs
 * at both capacities, because §24.5 says so and gives the reason:
 *
 * > **Run the whole suite at `capacity[agent_class] = 2` as well as at 1.** Concurrent
 * > commitments on one agent are the configuration in which a fencing error is
 * > expressible, and a chaos suite that only ever exercises one commitment per agent
 * > cannot detect it.
 *
 * The suite drives the real `commit()`, the real guards, and the real fencing predicates
 * against Phase 3's Commitment Store model. What that model is and is not is stated in
 * `helpers/chaosHarness.js`; the short version is that a red result here is a bug in the
 * logic, and a green result is not a substitute for the staging suite §24.5 describes.
 */

const { commit, OUTCOME, ABORT_REASON } = require("../../src/engine/commitment/commit");
const fencing = require("../../src/engine/commitment/fencing");
const model = require("../../src/engine/commitment/model");
const leadership = require("../../src/engine/shard/leadership");
const harness = require("./helpers/chaosHarness");

describe.each(harness.eachCapacity())("capacity $capacity — coordinator kills (§24.5)", ({ capacity }) => {
  test("thirty kills at random moments leave one holder, a strictly increasing fence, and no over-capacity agent", async () => {
    const { seed, store } = harness.seeded({ capacity });
    const random = harness.rng(0xC0FFEE + capacity);

    let fence = seed.leadership.leadershipFence;
    const holders = [];

    // @structural how many kills the scenario performs; a count, not a threshold
    const KILLS = 30;
    for (let round = 0; round < KILLS; round += 1) {
      const candidate = `coordinator-${random.int(4)}`;
      // A kill is a leadership change: §19.5 advances the fence on *each* change, and the
      // successor commits under the new one. Advancing it is the kill.
      fence += 1n;
      await store.client.shardLeadership.update({
        where: { shardId: "default" },
        data: { leadershipFence: fence, holder: candidate, leaseExpiry: new Date("2026-07-29T12:00:30.000Z") },
      });
      holders.push(candidate);

      // The killed coordinator's in-flight commit lands late, against its stale fence.
      const stale = harness.request({ ...seed, leadership: { leadershipFence: fence - 1n } }, random.int(seed.legs.length));
      const outcome = await commit(harness.deps(store), stale);
      expect(outcome.outcome).toBe(OUTCOME.ABORTED);
      expect(outcome.reason).toBe(ABORT_REASON.G1_LEADERSHIP_FENCE_ADVANCED);
    }

    const row = await store.client.shardLeadership.findUnique({ where: { shardId: "default" } });
    expect(row.holder).toBe(holders[holders.length - 1]);
    expect(row.leadershipFence).toBe(seed.leadership.leadershipFence + BigInt(KILLS));

    // The property the whole scenario exists for: after thirty kills, no commitment landed
    // at all, so the agent cannot be over capacity — and it is asserted rather than
    // inferred, because "nothing landed" is exactly the belief a fencing bug falsifies.
    //
    // "Active" is `releasedAt IS NULL`, read through the shipped `model.isActive` rather
    // than restated here: the partial unique index that backs the capacity bound keys on
    // the same predicate, and a test with its own definition of active would be testing
    // its own definition.
    const active = store.rows("commitment").filter(model.isActive);
    expect(active.length).toBeLessThanOrEqual(capacity);
    expect(active).toHaveLength(0);
  });

  test("a kill mid-commit leaves nothing behind, and the successor's commit is unaffected", async () => {
    // §24.5's "at the worst moment (mid-commit)": a commit that is **in flight** when the
    // shard changes hands, and that resolves afterwards believing it still leads.
    //
    // ── Why the successor's election is not awaited after a yield ────────────
    // This is the one place where the store model's fidelity has to be stated rather than
    // assumed. If the victim's transaction is allowed to open — one `setImmediate` is
    // enough — it holds the `FOR UPDATE` lock on the leadership row, and the successor's
    // election *blocks* until the victim finishes. That is a real database doing exactly
    // what it should, and it is not a scenario: nothing is racing. The window G1 exists to
    // close is the other one — the victim resolving after a change that has **already**
    // completed — so the kill is landed before the transaction opens and the victim is
    // then released into a world it has not noticed changing.
    const { seed, store } = harness.seeded({ capacity });

    let release;
    const blocked = new Promise((settle) => {
      release = settle;
    });

    const killed = commit(
      harness.deps(store, { volatileRecheck: async () => { await blocked; return { ok: true }; } }),
      harness.request(seed, 0),
    );

    store.advanceClock(harness.SHARD_LEASE_SECONDS + 1);
    await store.client.shardLeadership.update({
      where: { shardId: "default" },
      data: { leadershipFence: seed.leadership.leadershipFence + 1n, holder: "coordinator-b" },
    });
    release();

    const outcome = await killed;
    // It does not commit, and — the part that matters — it does not commit because the
    // *store* refused it, not because the victim noticed. §10.3.2: "Stopping early narrows
    // the window; guard G1 closes it."
    expect(outcome.committed).toBe(false);
    expect(outcome.reason).toBe(ABORT_REASON.G1_LEADERSHIP_FENCE_ADVANCED);
    // Nothing behind: the overlay was discarded, so neither a commitment nor a Leg
    // transition survives the aborted transaction.
    expect(store.rows("commitment")).toEqual([]);

    const leg = await store.client.leg.findUnique({ where: { id: seed.legs[0].id } });
    expect(leg.state).toBe("PLANNED");
    expect(leg.version).toBe(seed.legs[0].version);

    // The successor, under the advanced fence, commits normally.
    const successor = harness.request({ ...seed, leadership: { leadershipFence: seed.leadership.leadershipFence + 1n } }, 0);
    const landed = await commit(harness.deps(store), successor);
    expect(landed.outcome).toBe(OUTCOME.COMMITTED);
  });
});

describe.each(harness.eachCapacity())("capacity $capacity — worker paused mid-finalisation (§24.5)", ({ capacity }) => {
  test("a worker paused past its lease, then resumed, is fenced rather than believed", async () => {
    // > Pause a worker mid-finalisation for longer than the lease duration, then resume it
    // > — the precise scenario the fencing mechanism exists to defeat, and therefore the
    // > test that proves it works.
    const { seed, store } = harness.seeded({ capacity });

    // The gate is created before the commit rather than inside `volatileRecheck`, because
    // the kill below lands *before* the transaction opens — see the note in the
    // coordinator-kill scenario for why that is the window and the other one is not.
    let resume;
    const blocked = new Promise((settle) => {
      resume = settle;
    });
    const paused = commit(
      harness.deps(store, { volatileRecheck: async () => { await blocked; return { ok: true }; } }),
      harness.request(seed, 0),
    );

    // While it is paused: the lease lapses and a new leader is elected. This is the state
    // the paused worker will wake into, and it is the state it cannot detect for itself —
    // "a paused holder cannot know it was preempted".
    store.advanceClock(harness.LEASE_DURATION_SECONDS + 1);
    await store.client.shardLeadership.update({
      where: { shardId: "default" },
      data: { leadershipFence: seed.leadership.leadershipFence + 1n, holder: "coordinator-b" },
    });

    resume();
    const outcome = await paused;

    // It does not get to finish. §10.2's argument in one assertion: "a lock with a timeout
    // cannot provide mutual exclusion across a process pause, because a paused holder
    // cannot know it was preempted. The remedy is a fencing token, not a longer TTL."
    expect(outcome.committed).toBe(false);
    expect(outcome.reason).toBe(ABORT_REASON.G1_LEADERSHIP_FENCE_ADVANCED);
    expect(store.rows("commitment")).toEqual([]);
  });
});

describe.each(harness.eachCapacity())("capacity $capacity — clock skew beyond the budget (§24.5)", ({ capacity }) => {
  test("a coordinator whose clock has drifted past the skew budget stops committing before its lease expires", () => {
    // §10.6 makes the *store's* clock the sole authority. A coordinator that trusted its
    // own would keep committing past a lease the store has already let lapse, which is
    // exactly the window an asymmetric partition opens.
    const storeNow = new Date("2026-07-29T12:00:00.000Z");
    const leaseExpiry = new Date(storeNow.getTime() + harness.SHARD_LEASE_SECONDS * 1000);

    const permitted = leadership.shouldStopCommitting({
      leaseExpiry,
      storeTime: storeNow,
      maxClockSkewMillis: harness.MAX_CLOCK_SKEW_MS,
      storeRoundTripMillis: harness.STORE_ROUND_TRIP_MS,
    });
    expect(permitted.shouldStop).toBe(false);

    // The same lease, read at an instant inside the margin. Stopping early only narrows
    // the window — G1 is what closes it — but a coordinator that ignored the margin would
    // be relying on G1 alone, and §10.3.2 treats the margin as the first of two guards.
    const insideMargin = new Date(leaseExpiry.getTime() - harness.MAX_CLOCK_SKEW_MS);
    const refused = leadership.shouldStopCommitting({
      leaseExpiry,
      storeTime: insideMargin,
      maxClockSkewMillis: harness.MAX_CLOCK_SKEW_MS,
      storeRoundTripMillis: harness.STORE_ROUND_TRIP_MS,
    });
    expect(refused.shouldStop).toBe(true);
    expect(refused.reason).toBe("LEASE_MARGIN_EXHAUSTED");

    // And a coordinator with no lease at all stops — the direction that matters, because
    // "I could not read my lease" and "my lease is valid" must never be the same answer.
    expect(leadership.shouldStopCommitting({ leaseExpiry: null, storeTime: storeNow, maxClockSkewMillis: harness.MAX_CLOCK_SKEW_MS }).shouldStop).toBe(true);
  });

  test("skew does not change what the store enforces — a skewed coordinator's late commit still aborts at G1", async () => {
    const { seed, store } = harness.seeded({ capacity });
    await store.client.shardLeadership.update({
      where: { shardId: "default" },
      data: { leadershipFence: seed.leadership.leadershipFence + 1n },
    });

    const outcome = await commit(harness.deps(store), harness.request(seed, 0));
    expect(outcome.outcome).toBe(OUTCOME.ABORTED);
    expect(outcome.reason).toBe(ABORT_REASON.G1_LEADERSHIP_FENCE_ADVANCED);
  });
});

describe.each(harness.eachCapacity())("capacity $capacity — duplicate, reordered and expired commands (§24.5)", ({ capacity }) => {
  test("a mission command is compared per commitment id, never against a maximum across the agent's commitments", () => {
    // > deliver duplicate, reordered, and expired commands to simulated agents, including
    // > a command for one commitment interleaved with the settlement of a *different*
    // > commitment on the same agent — the interleaving that a single per-agent epoch
    // > handles incorrectly.
    const seen = new Map([
      ["commitment-a", 10n],
      ["commitment-b", 3n],
    ]);
    const floor = 0n;

    // B's next command carries fence 4 — lower than A's high-water mark of 10. A server
    // that compared against a per-agent maximum would reject it, stranding commitment B.
    const forB = fencing.acceptsMissionCommand({ commitmentId: "commitment-b", fence: 4n }, seen, floor);
    expect(forB.accepted).toBe(true);

    // A duplicate of B's own last command is rejected, because *that* comparison is the
    // per-commitment one and it is `<=`.
    const duplicate = fencing.acceptsMissionCommand({ commitmentId: "commitment-b", fence: 3n }, seen, floor);
    expect(duplicate.accepted).toBe(false);

    // Reordering: A's older command arriving after its newer one is rejected.
    const reordered = fencing.acceptsMissionCommand({ commitmentId: "commitment-a", fence: 9n }, seen, floor);
    expect(reordered.accepted).toBe(false);
  });

  test("settling one commitment leaves every other commitment on the same agent commandable (I19)", async () => {
    const { seed, store } = harness.seeded({ capacity, legs: capacity + 1 });

    const landed = [];
    for (let index = 0; index < capacity; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await commit(harness.deps(store), harness.request(seed, index));
      expect(outcome.outcome).toBe(OUTCOME.COMMITTED);
      landed.push(outcome);
    }
    expect(landed).toHaveLength(capacity);

    // Settle the first. At capacity 1 this is the only one; at capacity 2 there is a
    // sibling, and the sibling is what the property is about. Settlement is
    // `releasedAt`, which is also what frees the capacity slot at the partial unique index.
    await store.client.commitment.update({
      where: { id: landed[0].commitment.id },
      data: { releasedAt: store.now() },
    });

    const survivors = store.rows("commitment").filter(model.isActive);
    expect(survivors).toHaveLength(capacity - 1);

    // Every survivor is still commandable: the next fence the server would issue is one
    // the agent would accept. A per-agent epoch advanced by the settlement would have
    // fenced the sibling, which is the defect this assertion exists to catch.
    const agent = await store.client.agent.findUnique({ where: { id: seed.agent.id } });
    const seen = new Map(survivors.map((row) => [row.id, BigInt(row.fence)]));
    for (const survivor of survivors) {
      const verdict = fencing.acceptsMissionCommand(
        { commitmentId: survivor.id, fence: BigInt(agent.fenceCounter) + 1n },
        seen,
        0n,
      );
      expect({ commitment: survivor.id, accepted: verdict.accepted }).toEqual({ commitment: survivor.id, accepted: true });
    }
  });

  test("a STAND_DOWN_ALL at an advanced authority epoch fences every commitment the agent holds", () => {
    // §23.3 and §24.2. Including one whose offer is redelivered afterwards, which is the
    // case a floor-less implementation gets wrong.
    const seen = new Map([["commitment-a", 5n], ["commitment-b", 6n]]);
    const floorAfterStandDown = 100n;

    for (const [commitmentId, fence] of [["commitment-a", 7n], ["commitment-b", 8n], ["commitment-c", 99n]]) {
      const verdict = fencing.acceptsMissionCommand({ commitmentId, fence }, seen, floorAfterStandDown);
      expect({ commitmentId, accepted: verdict.accepted }).toEqual({ commitmentId, accepted: false });
    }

    // And a command issued *after* the stand-down, above the floor, is accepted — a floor
    // that fenced everything for ever would be a stand-down nobody could recover from.
    const afterwards = fencing.acceptsMissionCommand(
      { commitmentId: "commitment-d", fence: floorAfterStandDown + 1n },
      seen,
      floorAfterStandDown,
    );
    expect(afterwards.accepted).toBe(true);
  });
});

describe.each(harness.eachCapacity())("capacity $capacity — dependency latency and error injection (§24.5, §5.2)", ({ capacity }) => {
  test("a dependency injected to the point of timeout aborts the commit rather than committing on absent evidence", async () => {
    const { seed, store } = harness.seeded({ capacity });
    const dependency = harness.injectableDependency({ mode: "TIMEOUT" });

    const outcome = await commit(
      harness.deps(store, {
        // §7.6's volatile re-check is the commit path's one dependency read. §7.3's
        // three-valued discipline says an indeterminate answer is not a pass, and the
        // failure direction matters more here than anywhere else in the system.
        volatileRecheck: async () => {
          try {
            await dependency.call();
            return { ok: true };
          } catch (error) {
            return { ok: false, reason: "VOLATILE_RECHECK_UNAVAILABLE", detail: error.message };
          }
        },
      }),
      harness.request(seed, 0),
    );

    expect(outcome.outcome).toBe(OUTCOME.ABORTED);
    expect(dependency.calls).toBe(1);
    expect(await store.client.commitment.findMany({ where: { agentId: seed.agent.id } })).toHaveLength(0);
  });

  test("an injected error does not leave a partial write behind", async () => {
    const { seed, store } = harness.seeded({ capacity });

    const outcome = await commit(
      harness.deps(store, {
        sideEffects: async () => {
          throw new Error("injected outbox failure");
        },
      }),
      harness.request(seed, 0),
    ).catch((error) => ({ outcome: "THREW", message: error.message }));

    // Either the transaction aborted cleanly or it threw — what must never happen is a
    // commitment without its outbox row, because §11.1's whole argument is that the two
    // are written in one transaction.
    const commitments = await store.client.commitment.findMany({ where: { agentId: seed.agent.id } });
    const outbox = await store.client.outbox.findMany({});
    expect({ commitments: commitments.length, outbox: outbox.length }).toEqual(
      commitments.length === 0 ? { commitments: 0, outbox: 0 } : { commitments: 1, outbox: 1 },
    );
    expect(outcome).toBeTruthy();
  });
});

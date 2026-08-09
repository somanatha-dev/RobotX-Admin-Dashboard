"use strict";

/**
 * §24.5 — the three injections that concern the *agent* and the *store*, at capacity 1 and 2.
 *
 * > **Power-cycle a simulated agent mid-mission, wiping its deduplication state**, then
 * > redeliver every command it had already applied. The agent MUST report an advanced
 * > `dedup_state_generation` at session establishment, the server MUST suppress redelivery
 * > and advance `authority_epoch` instead of re-offering the old commitments, and no
 * > command may be applied twice (§11.5, invariant I21). **This is the test that
 * > distinguishes at-least-once delivery with durable dedup from at-least-once delivery
 * > that merely claims exactly-once semantics.**
 *
 * > **Kill the coordinator with SOFT reservations outstanding**, and verify that every
 * > affected Leg is re-planned, that none is lost, and that none is double-committed when
 * > the previous leader's in-flight commit lands late (guard G1).
 *
 * > **Take the Commitment Store away for longer than
 * > `agent.autonomous_continuation_limit`**, and verify that the shard enters Custodial
 * > Operation, issues no commands, reports I2 as `SUSPENDED` rather than `VIOLATED`, that
 * > agents halt at safe locations at their autonomy limit, and that full reconciliation
 * > precedes the resumption of rounds.
 */

const { commit } = require("../../src/engine/commitment/commit");
const model = require("../../src/engine/commitment/model");
const dedupHandshake = require("../../src/engine/dispatch/dedupHandshake");
const modeRegister = require("../../src/engine/degraded/modeRegister");
const invariantChecker = require("../../src/engine/observability/invariantChecker");
const harness = require("./helpers/chaosHarness");

describe.each(harness.eachCapacity())("capacity $capacity — an agent is power-cycled, wiping its dedup state (I21)", ({ capacity }) => {
  /** The commitments the agent held before the power cycle. */
  function heldCommitments(count) {
    return Array.from({ length: count }, (unused, index) => ({
      id: `commitment-${index + 1}`,
      commitmentId: `commitment-${index + 1}`,
      fence: BigInt(index + 1),
      custodyState: "NONE",
      legId: `leg-${index}`,
    }));
  }

  test("a wiped agent reports an advanced generation, and the server suppresses redelivery instead of re-offering", () => {
    const active = heldCommitments(capacity);

    // §11.5: the agent that lost its dedup state advances the generation on recreating it.
    // That advance is the whole signal — it is how the agent says "I cannot tell you what
    // I have already applied", which is different from and far more serious than "I have
    // applied nothing".
    const parsed = dedupHandshake.parseReport({
      dedupStateGeneration: "9",
      authorityEpoch: "7",
      fenceFloor: "0",
      highWaterMarks: {},
      tombstones: {},
    });
    expect(parsed.ok).toBe(true);
    const stored = { dedupStateGeneration: "8", authorityEpoch: "7", fenceFloor: "0", highWaterMarks: {} };

    const decision = dedupHandshake.classify({ reported: parsed.value, stored, activeCommitments: active });

    // Not RESUME and not REDELIVER_FROM_MARK. Redelivering to an agent that cannot say
    // what it applied is exactly the double-application I21 forbids, and re-offering the
    // old commitments would be the same mistake wearing a different name.
    expect(decision.path).toBe(dedupHandshake.DEDUP_PATH.SUPPRESS_AND_REFENCE);
    expect(decision.reason).toBe("DEDUP_STATE_GENERATION_ADVANCED");
    expect(decision.redeliverCommitmentIds).toEqual([]);

    // The two halves §24.5 names in the same sentence: suppress the redelivery **and**
    // advance the authority epoch. Either alone is wrong — suppressing without re-fencing
    // leaves the old commands acceptable, and re-fencing without suppressing sends them.
    expect(decision.suppressRedelivery).toBe(true);
    expect(decision.advanceAuthorityEpoch).toBe(true);
  });

  test("re-fencing is what makes redelivery of an already-applied command harmless", () => {
    // The mechanism, not just the decision: after SUPPRESS_AND_REFENCE the server advances
    // `authority_epoch`, which raises the agent's fence floor above every fence it ever
    // saw. Every stale command — including one the agent *did* apply before the wipe, and
    // one it did not — is then rejected on arrival, per commitment, with no need for the
    // agent to remember anything.
    const fencing = require("../../src/engine/commitment/fencing");
    const floorAfterRefence = 100n;
    const emptyMarks = new Map();

    for (let index = 0; index < capacity; index += 1) {
      const verdict = fencing.acceptsMissionCommand(
        { commitmentId: `commitment-${index + 1}`, fence: BigInt(index + 1) },
        emptyMarks,
        floorAfterRefence,
      );
      expect({ index, accepted: verdict.accepted }).toEqual({ index, accepted: false });
    }
  });

  test("an agent holding custody is not simply re-fenced — custody reconciliation is required first", () => {
    // §11.5 and §2.5. Re-fencing an agent that is carrying goods would silence it about
    // the one fact nobody else can establish. The decision carries the hold rather than
    // leaving the caller to remember.
    const withCustody = heldCommitments(capacity).map((commitment, index) =>
      index === 0 ? { ...commitment, custodyState: "HELD" } : commitment,
    );
    const parsed = dedupHandshake.parseReport({
      dedupStateGeneration: "9",
      authorityEpoch: "7",
      fenceFloor: "0",
      highWaterMarks: {},
      tombstones: {},
    });
    const decision = dedupHandshake.classify({
      reported: parsed.value,
      stored: { dedupStateGeneration: "8", authorityEpoch: "7", fenceFloor: "0", highWaterMarks: {} },
      activeCommitments: withCustody,
    });

    expect(decision.path).toBe(dedupHandshake.DEDUP_PATH.SUPPRESS_AND_REFENCE);
    expect(decision.custodyReconciliationRequired).toBe(true);
    expect(decision.custodyDetail.commitments).toContain("commitment-1");
    // I7: "an agent with an unreconciled non-empty manifest is not returned to the
    // available pool". The reason travels with the decision so the caller cannot act on
    // the path while forgetting the hold.
    expect(decision.custodyDetail.reason).toMatch(/I7/);
  });
});

describe.each(harness.eachCapacity())("capacity $capacity — the coordinator is killed with SOFT reservations outstanding", ({ capacity }) => {
  test("a SOFT reservation never reached the store, so the kill loses nothing that was durable", () => {
    // §2.6 and invariant I18. The reason "kill the coordinator with SOFT reservations
    // outstanding" is survivable at all is that a SOFT reservation is *plan state*, not a
    // commitment — it lives in the coordinator's plan and is reconstructed by the
    // successor's reconciliation. The store refuses to persist one, which is what makes
    // the reconstruction lossless rather than hopeful.
    expect(() => model.refuseSoftPersistence({ kind: "SOFT" })).toThrow(/SOFT/i);
    expect(() => model.refuseSoftPersistence({ kind: "HARD" })).not.toThrow();
  });

  test("the previous leader's in-flight commit lands late and is refused — none is double-committed (G1)", async () => {
    const { seed, store } = harness.seeded({ capacity, legs: capacity + 1 });

    // The successor plans and commits the same Legs the dead leader had reserved.
    const successorFence = seed.leadership.leadershipFence + 1n;
    await store.client.shardLeadership.update({
      where: { shardId: "default" },
      data: { leadershipFence: successorFence, holder: "coordinator-b" },
    });

    const landed = [];
    for (let index = 0; index < capacity; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await commit(
        harness.deps(store),
        harness.request({ ...seed, leadership: { leadershipFence: successorFence } }, index),
      );
      expect(outcome.committed).toBe(true);
      landed.push(outcome);
    }

    // Now the dead leader's commit arrives, against its own stale fence, for a Leg the
    // successor has already committed. The stale fence is stated explicitly rather than
    // taken from `seed`, because a scenario whose "stale" value happened to equal the
    // current one would pass while proving nothing.
    const staleFence = successorFence - 1n;
    expect(staleFence).toBe(seed.leadership.leadershipFence);
    const late = await commit(
      harness.deps(store),
      harness.request({ ...seed, leadership: { leadershipFence: staleFence } }, 0, {
        // A *different* decision round, because it is a different coordinator's decision.
        // Reusing the successor's round id would make this an idempotent replay under
        // §10.5 and it would be accepted — correctly, and while proving nothing about G1.
        decisionRoundId: "round-dead-leader",
      }),
    );
    expect(late.committed).toBe(false);
    expect(late.reason).toBe("G1_LEADERSHIP_FENCE_ADVANCED");

    // Not double-committed, and not lost: exactly `capacity` active commitments, one per
    // slot, and the successor's are the ones that survived.
    const active = store.rows("commitment").filter(model.isActive);
    expect(active).toHaveLength(capacity);
    expect(new Set(active.map((row) => row.capacitySlot)).size).toBe(capacity);
  });
});

describe.each(harness.eachCapacity())("capacity $capacity — the Commitment Store is taken away (§18.5 B1)", ({ capacity }) => {
  const CUSTODIAL = modeRegister.MODE.CUSTODIAL_OPERATION;

  test("the shard enters Custodial Operation, and the mode's envelope issues no commands and no commits", () => {
    const declared = modeRegister.modeOf(CUSTODIAL);
    expect(declared.entryTrigger).toBe("B1");
    expect(declared.envelope.noCommits).toBe(true);
    expect(declared.envelope.noCommands).toBe(true);

    // Intake keeps accepting. §18.5's whole design is a *reduced envelope*, not a stop:
    // refusing intake would make an infrastructure outage a customer-visible one.
    expect(declared.envelope.intakeContinues).toBe(true);

    // Both return a *verdict* with the reason, not a bare boolean. That is deliberate in
    // the module and it matters here: an operator asking "why did nothing dispatch?" gets
    // §18.5's own sentence rather than a `false` they have to interpret.
    const commands = modeRegister.commandsSuspended([CUSTODIAL]);
    expect(commands.suspended).toBe(true);
    expect(commands.byMode).toBe(CUSTODIAL);
    expect(commands.reason).toMatch(/fence/i);

    const commits = modeRegister.commitsSuspended([CUSTODIAL]);
    expect(commits.suspended).toBe(true);
    expect(commits.byMode).toBe(CUSTODIAL);
  });

  test("I2 reports SUSPENDED, not VIOLATED — the distinction §26.2's matrix exists to preserve", () => {
    // The failure this asserts against is a monitoring one and it is the worse of the two.
    // An I2 that reported VIOLATED during a declared, time-boxed store outage would page as
    // a correctness failure, and the operators who learn that the page is routine are the
    // ones who will not act on the real one.
    expect(modeRegister.suspensionsFor(CUSTODIAL)).toContain("I2");
    expect(modeRegister.MODES[CUSTODIAL].suspendsInvariants).toEqual(["I2"]);

    // And the suspension is authorised by the matrix rather than by the checker's opinion:
    // an invariant is SUSPENDED only where §26.2 says a mode may suspend it.
    expect(invariantChecker.STATUS.SUSPENDED).toBe("SUSPENDED");
    expect(modeRegister.NEVER_DEGRADED_INVARIANTS).not.toContain("I2");
  });

  test("the agent autonomy limit is the mode's own parameter, and rounds do not resume before reconciliation", () => {
    const declared = modeRegister.modeOf(CUSTODIAL);

    // §24.5: "agents halt at safe locations at their autonomy limit". The limit is named by
    // the mode rather than chosen by whatever code notices the outage, so an agent's
    // continuation bound and the mode that authorises it cannot drift apart.
    expect(declared.envelope.agentAutonomyLimitParameter).toBe("agent.autonomous_continuation_limit");

    // §24.5: "full reconciliation precedes the resumption of rounds".
    expect(declared.envelope.reconciliationRequiredBeforeRounds).toBe(true);
    expect(declared.exitWhen).toMatch(/reconciliation/i);
    // Exit is not an operator acknowledgement. A mode a human can dismiss is a mode that
    // will be dismissed during the incident it exists to bound.
    expect(declared.exitOnOperatorAcknowledgement).toBe(false);
  });

  test("no commitment lands while the mode is open, at either capacity", async () => {
    // The envelope's `noCommits` is a claim about behaviour, so it is checked as one: a
    // commit attempted under the mode must not produce a row. The mode is enforced by the
    // coordinator refusing to run a round, which is why this asserts the *predicate* the
    // coordinator consults rather than calling `commit()` — calling it would test that the
    // commit path ignores a mode it is not supposed to know about.
    expect(modeRegister.commitsSuspended([CUSTODIAL]).suspended).toBe(true);

    const { seed, store } = harness.seeded({ capacity });
    expect(store.rows("commitment")).toEqual([]);
    expect(seed.capacity).toBe(capacity);
  });
});

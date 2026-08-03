"use strict";

/**
 * Engine lane — Phase 4: offer semantics (§11.2) and the withdrawal of §11.4 step 2.
 *
 * §11.2's table is four rows, and each is tested for what it *does to state*, not for
 * what it returns: ACCEPT renews a lease, REJECT and DEFER release a commitment (which
 * is what frees the capacity slot at the database), and a TTL expiry withdraws at an
 * **advanced** fence.
 */

const commandSigning = require("../../src/engine/security/commandSigning");
const fencing = require("../../src/engine/commitment/fencing");
const offers = require("../../src/engine/dispatch/offers");
const outbox = require("../../src/engine/dispatch/outbox");
const { commit } = require("../../src/engine/commitment/commit");

const fixtures = require("./helpers/dispatchFixture");

const OFFER_TTL_SECONDS = 20;
const LEASE_DURATION_SECONDS = 60;
const NACK_COOLOFF_SECONDS = 120;
const MAX_DELIVERY_DELAY_SECONDS = 300;

/* ═══════════════════════════════════════════════════════════════════════════
   §11.2 — the offer's content
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the offer carries everything §11.2 lists", () => {
  const fixture = fixtures.seed();
  const expiry = new Date(fixture.now.getTime() + OFFER_TTL_SECONDS * 1000);

  test("every named field is present", () => {
    const payload = offers.buildOfferPayload({
      commitmentId: "commitment-c1",
      fence: 42n,
      legId: fixtures.LEG_ROW_ID,
      missionPlan: { id: "plan-1" },
      stopSequence: [{ stopId: "s1", window: ["09:00", "09:30"] }],
      routeReference: "route-1",
      payloadManifest: { manifestId: "m1" },
      requirementAcknowledgements: ["COLD_CHAIN"],
      offerExpiry: expiry,
    });

    for (const field of [
      "commitmentId",
      "fence",
      "legId",
      "missionPlan",
      "stopSequence",
      "routeReference",
      "payloadManifest",
      "requirementAcknowledgements",
      "energyReserveParams",
      "targetSoc",
      "offerExpiry",
    ]) {
      expect({ field, present: Object.prototype.hasOwnProperty.call(payload, field) }).toEqual({
        field,
        present: true,
      });
    }
  });

  test("the two §14.6 fields are declared and empty — Phase 7 fills them, the engine never computes them", () => {
    const payload = offers.buildOfferPayload({ commitmentId: "c", fence: 1n, offerExpiry: expiry });
    expect({ energyReserveParams: payload.energyReserveParams, targetSoc: payload.targetSoc }).toEqual({
      energyReserveParams: null,
      targetSoc: null,
    });
  });

  test("an offer without an expiry is refused — that absence is the defect §11.2 names", () => {
    expect(() => offers.buildOfferPayload({ commitmentId: "c", fence: 1n })).toThrow(/an offer carries an expiry/);
  });

  test("the fence is rendered as a decimal string, so a BigInt survives the wire", () => {
    const payload = offers.buildOfferPayload({
      commitmentId: "c",
      fence: 9007199254740993n,
      offerExpiry: expiry,
    });
    expect(payload.fence).toBe("9007199254740993");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §10.3.2 step 5 — the offer is enqueued inside the commit transaction
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the offer is written by the commit that authorises it", () => {
  const fixture = fixtures.seed();

  async function commitWithOffer(store, overrides) {
    return commit(
      fixtures.commitDeps(store, {
        sideEffects: async (tx, context) =>
          offers.enqueueOffer(tx, {
            commitment: context.commitment,
            storeTime: context.storeTime,
            offerTtlSeconds: OFFER_TTL_SECONDS,
            signingKey: fixtures.TEST_SIGNING_KEY,
            offer: { missionPlan: { id: "plan-1" }, stopSequence: [{ stopId: "s1" }] },
          }),
        ...(overrides || {}),
      }),
      fixtures.commitRequest(fixture),
    );
  }

  test("a commit produces exactly one PENDING OFFER row carrying the fence it just allocated", async () => {
    const store = fixtures.storeFor(fixture);
    const result = await commitWithOffer(store);

    expect(result.committed).toBe(true);

    const rows = store.rows("outbox");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      command: "OFFER",
      commandClass: fencing.COMMAND_CLASS.MISSION,
      fenceScope: fencing.FENCE_SCOPE.COMMITMENT,
      state: outbox.OUTBOX_STATE.PENDING,
      sequence: 0,
      commitmentId: result.commitment.commitmentId,
    });
    expect(rows[0].fence).toBe(result.commitment.fence);
    // §10.3.2 step 4 — the fence advanced; the agent-scope epoch did not.
    expect(store.rows("agent")[0].fenceCounter).toBe(42n);
    expect(store.rows("agent")[0].authorityEpoch).toBe(7n);
  });

  test("the offer's envelope validates against §23.3, including the agent id", async () => {
    const store = fixtures.storeFor(fixture);
    await commitWithOffer(store);
    const row = store.rows("outbox")[0];

    const envelope = {
      agentId: row.agentId,
      command: row.command,
      commandClass: row.commandClass,
      fenceScope: row.fenceScope,
      commitmentId: row.commitmentId,
      fence: row.fence,
      authorityEpoch: null,
      fenceFloor: null,
      sequence: row.sequence,
      notValidAfter: row.notValidAfter,
      payload: row.payload,
    };

    expect(commandSigning.verify(envelope, row.signature, fixtures.TEST_SIGNING_KEY)).toBe(true);
    // Re-addressed to another agent: the same payload, a different addressee, and the
    // signature no longer verifies. This is the clause §23.3 makes load-bearing.
    expect(
      commandSigning.verify({ ...envelope, agentId: "another-agent" }, row.signature, fixtures.TEST_SIGNING_KEY),
    ).toBe(false);
  });

  test("the offer's not_valid_after is its own TTL — a late offer is not executed", async () => {
    const store = fixtures.storeFor(fixture);
    await commitWithOffer(store);
    const row = store.rows("outbox")[0];
    expect(row.notValidAfter.getTime()).toBe(fixture.now.getTime() + OFFER_TTL_SECONDS * 1000);
    expect(row.payload.offerExpiry).toBe(row.notValidAfter.toISOString());
  });

  test("an aborted commit leaves no offer — the two are atomic in both directions", async () => {
    const store = fixtures.storeFor(fixture);
    const result = await commit(
      fixtures.commitDeps(store, {
        volatileRecheck: async () => ({ ok: false, reason: "VOLATILE_FEASIBILITY_LOST" }),
        sideEffects: async () => {
          throw new Error("should not be reached — step 5 follows step 3");
        },
      }),
      fixtures.commitRequest(fixture),
    );
    expect(result.committed).toBe(false);
    expect(store.rows("outbox")).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §11.2 — the three responses
   ═══════════════════════════════════════════════════════════════════════════ */

describe("matching a response to the offer the engine actually made", () => {
  const fixture = fixtures.seed();

  function storeWithCommitment(commitmentOverrides) {
    return fixtures.storeFor(fixture, { commitments: [fixtures.commitmentRow(fixture, commitmentOverrides)] });
  }

  test("a response carrying a superseded fence is refused, not applied", async () => {
    const store = storeWithCommitment();
    const matched = await store.client.$transaction((tx) =>
      offers.matchResponse(tx, { commitmentId: "commitment-c1", fence: 41n, agentId: fixture.agent.id }),
    );
    expect(matched).toMatchObject({ ok: false, reason: "RESPONSE_CARRIES_A_SUPERSEDED_FENCE" });
  });

  test("a response from a different agent is refused", async () => {
    const store = storeWithCommitment();
    const matched = await store.client.$transaction((tx) =>
      offers.matchResponse(tx, { commitmentId: "commitment-c1", fence: 42n, agentId: "someone-else" }),
    );
    expect(matched).toMatchObject({ ok: false, reason: "RESPONSE_FROM_ANOTHER_AGENT" });
  });

  test("a response to a released commitment is refused", async () => {
    const store = storeWithCommitment();
    await store.client.commitment.update({
      where: { commitmentId: "commitment-c1" },
      data: { releasedAt: store.now() },
    });
    const matched = await store.client.$transaction((tx) =>
      offers.matchResponse(tx, { commitmentId: "commitment-c1", fence: 42n, agentId: fixture.agent.id }),
    );
    expect(matched).toMatchObject({ ok: false, reason: "COMMITMENT_ALREADY_RELEASED" });
  });

  test("a matching response is admitted", async () => {
    const store = storeWithCommitment();
    const matched = await store.client.$transaction((tx) =>
      offers.matchResponse(tx, { commitmentId: "commitment-c1", fence: 42n, agentId: fixture.agent.id }),
    );
    expect(matched.ok).toBe(true);
    expect(matched.commitment.commitmentId).toBe("commitment-c1");
  });
});

describe("ACCEPT (§11.2 row 1)", () => {
  const fixture = fixtures.seed();

  async function accept(store, evidence) {
    return store.client.$transaction(async (tx) => {
      const commitment = await tx.commitment.findUnique({ where: { commitmentId: "commitment-c1" } });
      const leg = await tx.leg.findUnique({ where: { id: fixture.legs[0].id } });
      return offers.applyAccept(tx, {
        commitment,
        leg,
        storeTime: store.now(),
        leaseDurationSeconds: LEASE_DURATION_SECONDS,
        evidence,
      });
    });
  }

  test("Leg → ACCEPTED and the lease is renewed from the store's clock", async () => {
    const store = fixtures.storeFor(fixture, {
      commitments: [{ ...fixtures.commitmentRow(fixture), leaseExpiry: new Date(fixture.now.getTime() + 1_000) }],
    });
    store.advanceClock(5);

    const result = await accept(store, { commitmentId: "commitment-c1", fence: 42n });

    expect(result.outcome).toBe(offers.OUTCOME.APPLIED);
    expect(store.rows("leg")[0]).toMatchObject({ state: "ACCEPTED", version: 1 });
    expect(store.rows("commitment")[0].leaseExpiry.getTime()).toBe(
      store.now().getTime() + LEASE_DURATION_SECONDS * 1000,
    );
  });

  test("§12.2 — evidence naming another commitment renews nothing", async () => {
    const store = fixtures.storeFor(fixture, { commitments: [fixtures.commitmentRow(fixture)] });
    const result = await accept(store, { commitmentId: "commitment-other", fence: 42n });
    expect(result).toMatchObject({ outcome: offers.OUTCOME.REFUSED, reason: "EVIDENCE_NAMES_ANOTHER_COMMITMENT" });
    expect(store.rows("leg")[0].state).toBe("PLANNED");
  });

  test("§12.2 — evidence carrying a different fence renews nothing", async () => {
    const store = fixtures.storeFor(fixture, { commitments: [fixtures.commitmentRow(fixture)] });
    const result = await accept(store, { commitmentId: "commitment-c1", fence: 41n });
    expect(result).toMatchObject({ outcome: offers.OUTCOME.REFUSED, reason: "EVIDENCE_CARRIES_A_DIFFERENT_FENCE" });
  });

  test("a Leg whose version moved on is not overwritten (§4.1 rule 2)", async () => {
    const store = fixtures.storeFor(fixture, { commitments: [fixtures.commitmentRow(fixture)] });
    const result = await store.client.$transaction(async (tx) => {
      const commitment = await tx.commitment.findUnique({ where: { commitmentId: "commitment-c1" } });
      const leg = await tx.leg.findUnique({ where: { id: fixture.legs[0].id } });
      return offers.applyAccept(tx, {
        commitment,
        // A snapshot one version behind the row.
        leg: { ...leg, version: leg.version - 1 },
        storeTime: store.now(),
        leaseDurationSeconds: LEASE_DURATION_SECONDS,
        evidence: { commitmentId: "commitment-c1", fence: 42n },
      });
    });
    expect(result).toMatchObject({ outcome: offers.OUTCOME.IGNORED, reason: "LEG_VERSION_MOVED" });
  });
});

describe("REJECT (§11.2 row 2)", () => {
  const fixture = fixtures.seed();

  test("the commitment is released, the Leg returns to QUEUED, and the agent is excluded", async () => {
    const store = fixtures.storeFor(fixture, { commitments: [fixtures.commitmentRow(fixture)] });

    const result = await store.client.$transaction(async (tx) => {
      const commitment = await tx.commitment.findUnique({ where: { commitmentId: "commitment-c1" } });
      const leg = await tx.leg.findUnique({ where: { id: fixture.legs[0].id } });
      return offers.applyReject(tx, {
        commitment,
        leg,
        storeTime: store.now(),
        reason: "BATTERY_CRITICAL:8.0%",
        nackCooloffSeconds: NACK_COOLOFF_SECONDS,
      });
    });

    expect(result.outcome).toBe(offers.OUTCOME.APPLIED);
    expect(store.rows("leg")[0].state).toBe("QUEUED");
    // The release is what frees the capacity slot at the database — the partial unique
    // index is predicated on `releasedAt IS NULL` (§10.3.2).
    expect(store.rows("commitment")[0].releasedAt).toEqual(store.now());
    expect(result.excludeAgentUntil.getTime()).toBe(store.now().getTime() + NACK_COOLOFF_SECONDS * 1000);
  });

  test("the rejection is returned as a feasibility observation to be reconciled, not a log line", async () => {
    const store = fixtures.storeFor(fixture, { commitments: [fixtures.commitmentRow(fixture)] });
    const result = await store.client.$transaction(async (tx) => {
      const commitment = await tx.commitment.findUnique({ where: { commitmentId: "commitment-c1" } });
      const leg = await tx.leg.findUnique({ where: { id: fixture.legs[0].id } });
      return offers.applyReject(tx, {
        commitment,
        leg,
        storeTime: store.now(),
        reason: "LOW_ENERGY",
        nackCooloffSeconds: NACK_COOLOFF_SECONDS,
      });
    });

    expect(result.feasibilityObservation).toMatchObject({
      kind: "offer_rejection",
      agentId: fixture.agent.id,
      commitmentId: "commitment-c1",
      reason: "LOW_ENERGY",
    });
  });
});

describe("DEFER (§11.2 row 3)", () => {
  const fixture = fixtures.seed();

  async function defer(store, until) {
    return store.client.$transaction(async (tx) => {
      const commitment = await tx.commitment.findUnique({ where: { commitmentId: "commitment-c1" } });
      const leg = await tx.leg.findUnique({ where: { id: fixture.legs[0].id } });
      return offers.applyDefer(tx, { commitment, leg, storeTime: store.now(), until, reason: "CHARGING" });
    });
  }

  test("the HARD commitment is released and the Leg returns to PLANNED with start-not-before", async () => {
    const store = fixtures.storeFor(fixture, { commitments: [fixtures.commitmentRow(fixture)] });
    const until = new Date(store.now().getTime() + 600_000);

    const result = await defer(store, until);

    expect(result.outcome).toBe(offers.OUTCOME.APPLIED);
    expect(store.rows("leg")[0]).toMatchObject({ state: "PLANNED", version: 1 });
    expect(store.rows("leg")[0].startNotBefore).toEqual(until);
    // Releasing rather than holding is what keeps the agent's capacity accounted
    // correctly while it is not actually working (§2.6).
    expect(store.rows("commitment")[0].releasedAt).toEqual(store.now());
  });

  test("no SOFT reservation is persisted — invariant I18 holds through the deferral path", async () => {
    const store = fixtures.storeFor(fixture, { commitments: [fixtures.commitmentRow(fixture)] });
    await defer(store, new Date(store.now().getTime() + 600_000));
    for (const row of store.rows("commitment")) {
      expect(row.kind).toBe("HARD");
    }
  });

  test("a deferral to the past is refused — it is a rejection wearing a deferral's name", async () => {
    const store = fixtures.storeFor(fixture, { commitments: [fixtures.commitmentRow(fixture)] });
    const result = await defer(store, new Date(store.now().getTime() - 1_000));
    expect(result).toMatchObject({ outcome: offers.OUTCOME.REFUSED, reason: "DEFER_UNTIL_IS_NOT_IN_THE_FUTURE" });
    expect(store.rows("commitment")[0].releasedAt).toBeNull();
  });

  test("a deferral with no instant at all is refused", async () => {
    const store = fixtures.storeFor(fixture, { commitments: [fixtures.commitmentRow(fixture)] });
    const result = await defer(store, "not-a-date");
    expect(result).toMatchObject({ outcome: offers.OUTCOME.REFUSED, reason: "DEFER_WITHOUT_START_NOT_BEFORE" });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §11.4 step 2 — withdrawal at an ADVANCED fence
   ═══════════════════════════════════════════════════════════════════════════ */

describe("withdrawing an unanswered offer (§11.4 step 2)", () => {
  const fixture = fixtures.seed();

  async function withdraw(store) {
    return store.client.$transaction(async (tx) => {
      const commitment = await tx.commitment.findUnique({ where: { commitmentId: "commitment-c1" } });
      const agent = await tx.agent.findUnique({ where: { id: fixture.agent.id } });
      const leg = await tx.leg.findUnique({ where: { id: fixture.legs[0].id } });
      return offers.withdrawExpiredOffer(tx, {
        commitment,
        agent,
        leg,
        storeTime: store.now(),
        nackCooloffSeconds: NACK_COOLOFF_SECONDS,
        maxDeliveryDelaySeconds: MAX_DELIVERY_DELAY_SECONDS,
        signingKey: fixtures.TEST_SIGNING_KEY,
      });
    });
  }

  function storeWithCommitment() {
    return fixtures.storeFor(fixture, {
      commitments: [fixtures.commitmentRow(fixture, { fence: 42n })],
    });
  }

  test("the WITHDRAW carries a fence strictly above the offer's — otherwise the agent would reject it", async () => {
    const store = storeWithCommitment();
    // The agent's counter is 41 in the fixture; the commitment took 42. Bring the
    // counter up to the commitment's fence, as the commit would have.
    await store.client.agent.update({ where: { id: fixture.agent.id }, data: { fenceCounter: 42n } });

    const result = await withdraw(store);

    expect(result.withdrawalFence).toBe(43n);
    const withdrawal = store.rows("outbox").find((r) => r.command === "WITHDRAW");
    expect(withdrawal.fence).toBe(43n);

    // The property that makes it work: at the offer's own fence the agent's mission
    // rule (reject at `≤ highest_seen`) would have refused the withdrawal.
    const seen = new Map([["commitment-c1", 42n]]);
    expect(fencing.acceptsMissionCommand({ commitmentId: "commitment-c1", fence: 42n }, seen).accepted).toBe(false);
    expect(fencing.acceptsMissionCommand({ commitmentId: "commitment-c1", fence: 43n }, seen).accepted).toBe(true);
  });

  test("the fence advance, the WITHDRAW, the Leg move and the release are one transaction (§4.1 rule 5)", async () => {
    const store = storeWithCommitment();
    await store.client.agent.update({ where: { id: fixture.agent.id }, data: { fenceCounter: 42n } });

    await withdraw(store);

    expect(store.rows("agent")[0].fenceCounter).toBe(43n);
    expect(store.rows("leg")[0].state).toBe("QUEUED");
    expect(store.rows("commitment")[0].releasedAt).toEqual(store.now());
    expect(store.rows("outbox").filter((r) => r.command === "WITHDRAW")).toHaveLength(1);
    // Invariant I6's persisted high-water mark moved with the counter.
    expect(store.rows("agentFenceAudit")[0].fenceHighWater).toBe(43n);
  });

  test("the agent-scope epoch is untouched — one unanswered offer is not a fleet event (I19)", async () => {
    const store = storeWithCommitment();
    await store.client.agent.update({ where: { id: fixture.agent.id }, data: { fenceCounter: 42n } });
    await withdraw(store);
    expect(store.rows("agent")[0].authorityEpoch).toBe(7n);
  });

  test("a Leg that moved under the withdrawal aborts the whole transaction, leaving no orphan WITHDRAW", async () => {
    const store = storeWithCommitment();
    await store.client.agent.update({ where: { id: fixture.agent.id }, data: { fenceCounter: 42n } });

    await expect(
      store.client.$transaction(async (tx) => {
        const commitment = await tx.commitment.findUnique({ where: { commitmentId: "commitment-c1" } });
        const agent = await tx.agent.findUnique({ where: { id: fixture.agent.id } });
        const leg = await tx.leg.findUnique({ where: { id: fixture.legs[0].id } });
        return offers.withdrawExpiredOffer(tx, {
          commitment,
          agent,
          // A stale snapshot: the conditional write will match nothing.
          leg: { ...leg, version: leg.version + 5 },
          storeTime: store.now(),
          nackCooloffSeconds: NACK_COOLOFF_SECONDS,
          maxDeliveryDelaySeconds: MAX_DELIVERY_DELAY_SECONDS,
          signingKey: fixtures.TEST_SIGNING_KEY,
        });
      }),
    ).rejects.toThrow(/must roll back together/);

    expect(store.rows("outbox")).toHaveLength(0);
    expect(store.rows("agent")[0].fenceCounter).toBe(42n);
    expect(store.rows("commitment")[0].releasedAt).toBeNull();
  });
});

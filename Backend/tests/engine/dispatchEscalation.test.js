"use strict";

/**
 * Engine lane — Phase 4: the §11.4 escalation ladder and the drain worker.
 *
 * §11.4's four rungs, and the sentence that explains why the fourth exists:
 *
 * > Step 4 matters because the difference between one broken agent and a broken message
 * > bus is a count, and a system that only knows how to handle the former will respond
 * > to the latter by quietly grounding the fleet one agent at a time.
 */

const escalation = require("../../src/engine/dispatch/escalation");
const outbox = require("../../src/engine/dispatch/outbox");
const worker = require("../../src/workers/outbox.worker");

const fixtures = require("./helpers/dispatchFixture");

const RETRY_WINDOW_SECONDS = 10;
const OFFER_TTL_SECONDS = 20;
const UNRESPONSIVE_STRIKES = 3;
const SYSTEMIC_THRESHOLD = 0.2;
const HOUR_MS = 3600_000;

const STORE_NOW = fixtures.seed().now;

function row(overrides) {
  return {
    id: "outbox-1",
    agentId: fixtures.AGENT_ROW_ID,
    commitmentId: "commitment-c1",
    command: "OFFER",
    state: outbox.OUTBOX_STATE.PENDING,
    createdAt: STORE_NOW,
    deliveredAt: null,
    attempts: 0,
    ...(overrides || {}),
  };
}

const settings = {
  retryWindowSeconds: RETRY_WINDOW_SECONDS,
  offerTtlSeconds: OFFER_TTL_SECONDS,
  unresponsiveStrikes: UNRESPONSIVE_STRIKES,
  systemicThreshold: SYSTEMIC_THRESHOLD,
};

function at(seconds) {
  return new Date(STORE_NOW.getTime() + seconds * 1000);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Steps 1 and 2 — per row
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§11.4 steps 1 and 2", () => {
  test("inside both windows, nothing escalates", () => {
    expect(escalation.assessRow({ row: row(), storeTime: at(5), ...settings }).step).toBe(
      escalation.ESCALATION_STEP.NONE,
    );
  });

  test("step 1 — no delivery confirmation within dispatch.retry_window", () => {
    const verdict = escalation.assessRow({ row: row(), storeTime: at(11), ...settings });
    expect(verdict).toMatchObject({
      step: escalation.ESCALATION_STEP.RETRY,
      action: escalation.ESCALATION_ACTION.RETRY_WITH_BACKOFF,
      reason: "NO_DELIVERY_WITHIN_RETRY_WINDOW",
    });
  });

  test("a delivered row does not reach step 1 — delivery is what step 1 waits for", () => {
    const verdict = escalation.assessRow({ row: row({ deliveredAt: at(2) }), storeTime: at(11), ...settings });
    expect(verdict.step).toBe(escalation.ESCALATION_STEP.NONE);
  });

  test("step 2 — no ACK within dispatch.offer_ttl, whether or not it was delivered", () => {
    for (const deliveredAt of [null, at(2)]) {
      const verdict = escalation.assessRow({ row: row({ deliveredAt }), storeTime: at(21), ...settings });
      expect({ deliveredAt: Boolean(deliveredAt), step: verdict.step, action: verdict.action }).toEqual({
        deliveredAt: Boolean(deliveredAt),
        step: escalation.ESCALATION_STEP.WITHDRAW,
        action: escalation.ESCALATION_ACTION.WITHDRAW_AND_REPLAN,
      });
    }
  });

  test("step 2 supersedes step 1 — the ladder does not retry a row it is about to withdraw", () => {
    const verdict = escalation.assessRow({ row: row(), storeTime: at(100), ...settings });
    expect(verdict.step).toBe(escalation.ESCALATION_STEP.WITHDRAW);
  });

  test("a terminal row never escalates", () => {
    for (const state of outbox.TERMINAL_STATES) {
      const verdict = escalation.assessRow({ row: row({ state }), storeTime: at(1000), ...settings });
      expect({ state, step: verdict.step }).toEqual({ state, step: escalation.ESCALATION_STEP.NONE });
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §11.3 — bounded backoff with caller-supplied jitter
   ═══════════════════════════════════════════════════════════════════════════ */

describe("bounded exponential backoff (§11.3)", () => {
  test("it grows, and it is capped at the retry window", () => {
    const values = [0, 1, 2, 3, 8].map((attempts) =>
      escalation.backoffSeconds({ attempts, retryWindowSeconds: RETRY_WINDOW_SECONDS }),
    );
    expect(values).toEqual([1, 2, 4, 8, RETRY_WINDOW_SECONDS]);
  });

  test("jitter is supplied, never drawn — a dispatch trace replays identically (T6)", () => {
    const a = escalation.backoffSeconds({ attempts: 1, retryWindowSeconds: 60, jitterFraction: 0.5 });
    const b = escalation.backoffSeconds({ attempts: 1, retryWindowSeconds: 60, jitterFraction: 0.5 });
    expect(a).toBe(b);
    expect(a).toBe(3);
  });

  test("jitter cannot push an attempt past the window it is bounded by", () => {
    expect(escalation.backoffSeconds({ attempts: 3, retryWindowSeconds: 10, jitterFraction: 1 })).toBe(10);
  });

  test("a non-positive retry window is refused rather than silently defaulted", () => {
    expect(() => escalation.backoffSeconds({ attempts: 1, retryWindowSeconds: 0 })).toThrow(/must be positive/);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   The Phase 4 independent verification's issue 3. `backoffSeconds` was computed
   and logged, and nothing consulted it: `claim` re-took every PENDING row on
   every pass, so the real cadence was the tick interval — constant, unjittered,
   fleet-wide identical. These assert the schedule is now enforced, not reported.
   ───────────────────────────────────────────────────────────────────────────── */

describe("the backoff actually paces retries (§11.3)", () => {
  test("a row that has never been attempted is due immediately — backoff paces retries, not first delivery", () => {
    expect(escalation.retryDueAt({ row: row({ attempts: 0 }), retryWindowSeconds: RETRY_WINDOW_SECONDS })).toBeNull();
    expect(escalation.isRetryDue({ row: row({ attempts: 0 }), storeTime: STORE_NOW, retryWindowSeconds: RETRY_WINDOW_SECONDS })).toBe(true);
  });

  test("an attempted row is not due until its backoff has elapsed, and is due after", () => {
    const attempted = row({ attempts: 3, updatedAt: STORE_NOW });
    const dueAt = escalation.retryDueAt({ row: attempted, retryWindowSeconds: RETRY_WINDOW_SECONDS });

    expect(dueAt).toBeInstanceOf(Date);
    expect(dueAt.getTime()).toBeGreaterThan(STORE_NOW.getTime());

    const justBefore = new Date(dueAt.getTime() - 1);
    expect(escalation.isRetryDue({ row: attempted, storeTime: justBefore, retryWindowSeconds: RETRY_WINDOW_SECONDS })).toBe(false);
    expect(escalation.isRetryDue({ row: attempted, storeTime: dueAt, retryWindowSeconds: RETRY_WINDOW_SECONDS })).toBe(true);
  });

  test("the wait grows with the attempt count and never exceeds the retry window", () => {
    const waits = [1, 2, 3, 9].map((attempts) => {
      const dueAt = escalation.retryDueAt({
        row: row({ id: "outbox-fixed", attempts, updatedAt: STORE_NOW }),
        retryWindowSeconds: RETRY_WINDOW_SECONDS,
      });
      return (dueAt.getTime() - STORE_NOW.getTime()) / 1000;
    });

    expect(waits[0]).toBeLessThan(waits[1]);
    expect(waits[1]).toBeLessThan(waits[2]);
    for (const wait of waits) expect(wait).toBeLessThanOrEqual(RETRY_WINDOW_SECONDS);
  });

  test("jitter is drawn from the row id, so two rows decorrelate and one row replays identically (T6)", () => {
    const fractions = ["outbox-1", "outbox-2", "outbox-3", "outbox-4"].map((id) => escalation.jitterFractionFor(id));
    for (const fraction of fractions) {
      expect(fraction).toBeGreaterThanOrEqual(0);
      expect(fraction).toBeLessThan(1);
    }
    // Decorrelated: the whole point of jitter is that a fleet's retries do not arrive
    // as one herd.
    expect(new Set(fractions).size).toBe(fractions.length);
    // And stable: the same row yields the same fraction on every pass, in every worker,
    // after every restart. A redrawn fraction would make `retryDueAt` non-monotonic.
    expect(escalation.jitterFractionFor("outbox-1")).toBe(fractions[0]);
  });

  test("a row with no recorded last attempt is due rather than deferred forever", () => {
    expect(escalation.retryDueAt({ row: row({ attempts: 2, updatedAt: null }), retryWindowSeconds: RETRY_WINDOW_SECONDS })).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Step 3 — consecutive, not a rate
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§11.4 step 3 — consecutive unresponsive offers", () => {
  const unacked = { state: outbox.OUTBOX_STATE.UNACKNOWLEDGED };
  const acked = { state: outbox.OUTBOX_STATE.ACKED };

  test("three in a row trips it", () => {
    const verdict = escalation.assessAgent({
      recentOffers: [unacked, unacked, unacked],
      strikes: UNRESPONSIVE_STRIKES,
    });
    expect(verdict).toMatchObject({
      step: escalation.ESCALATION_STEP.AGENT_HEALTH,
      action: escalation.ESCALATION_ACTION.REMOVE_FROM_AVAILABILITY_INDEX,
      consecutive: 3,
    });
  });

  test("three out of five, broken by an ACK, does not — 'consecutive' is load-bearing", () => {
    const verdict = escalation.assessAgent({
      recentOffers: [unacked, unacked, acked, unacked, unacked],
      strikes: UNRESPONSIVE_STRIKES,
    });
    expect(verdict.step).toBe(escalation.ESCALATION_STEP.NONE);
    expect(verdict.consecutive).toBe(2);
  });

  test("an agent with no history does not trip it", () => {
    expect(escalation.assessAgent({ recentOffers: [], strikes: UNRESPONSIVE_STRIKES }).step).toBe(
      escalation.ESCALATION_STEP.NONE,
    );
  });

  test("a non-positive strike count is refused", () => {
    expect(() => escalation.assessAgent({ recentOffers: [], strikes: 0 })).toThrow(/positive integer/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Step 4 — the count that tells a broken agent from a broken bus
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§11.4 step 4 — the systemic threshold", () => {
  test("above the threshold, the fault is systemic", () => {
    const verdict = escalation.assessShard({
      unresponsiveAgents: 3,
      totalAgents: 10,
      systemicThreshold: SYSTEMIC_THRESHOLD,
    });
    expect(verdict).toMatchObject({
      step: escalation.ESCALATION_STEP.SYSTEMIC,
      action: escalation.ESCALATION_ACTION.DECLARE_SYSTEMIC_DISPATCH_FAULT,
      fraction: 0.3,
    });
  });

  test("at the threshold exactly, it is not — the specification says 'exceeds'", () => {
    expect(
      escalation.assessShard({ unresponsiveAgents: 2, totalAgents: 10, systemicThreshold: SYSTEMIC_THRESHOLD }).step,
    ).toBe(escalation.ESCALATION_STEP.NONE);
  });

  test("an empty shard is not systemically faulty", () => {
    const verdict = escalation.assessShard({
      unresponsiveAgents: 0,
      totalAgents: 0,
      systemicThreshold: SYSTEMIC_THRESHOLD,
    });
    expect(verdict).toMatchObject({ step: escalation.ESCALATION_STEP.NONE, reason: "EMPTY_SHARD" });
  });

  test("a threshold outside (0, 1] is refused", () => {
    for (const bad of [0, -0.1, 1.5, NaN]) {
      expect(() => escalation.assessShard({ unresponsiveAgents: 1, totalAgents: 2, systemicThreshold: bad })).toThrow(
        /fraction in \(0, 1\]/,
      );
    }
  });

  test("the directive stops new hardening and names the mode rather than entering it", () => {
    const directive = escalation.systemicDirective({ fraction: 0.4, threshold: 0.2, shardId: "default" });
    expect(directive).toMatchObject({
      alert: "SYSTEMIC_DISPATCH_FAULT",
      stopNewHardening: true,
      enterDegradedMode: "SHED_LOAD",
    });
    expect(directive.ownedBy).toMatch(/Phase 12/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The drain worker
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the outbox drain worker", () => {
  const fixture = fixtures.seed();

  function buildStore() {
    return fixtures.storeFor(fixture, { commitments: [fixtures.commitmentRow(fixture, { fence: 42n })] });
  }

  async function enqueueOffer(store, overrides) {
    return store.client.$transaction((tx) =>
      outbox.enqueue(
        tx,
        outbox.buildRow({
          command: "OFFER",
          agentId: fixture.agent.id,
          commitmentId: "commitment-c1",
          fence: 42n,
          sequence: 0,
          payload: { legId: fixture.legs[0].id },
          notValidAfter: new Date(STORE_NOW.getTime() + HOUR_MS),
          signature: "sig",
          ...(overrides || {}),
        }),
      ),
    );
  }

  function deps(store, deliver, record) {
    return {
      prisma: store.client,
      deliver,
      readStoreTime: async () => store.now(),
      record: record || (() => {}),
    };
  }

  test("it refuses to run without a delivery arm — it never reaches for a socket itself", async () => {
    const store = buildStore();
    await expect(worker.drainOnce({ prisma: store.client }, settings, "w1")).rejects.toThrow(/needs a delivery arm/);
    // `start` refuses synchronously, before any timer is armed, so a misconfigured
    // worker fails at wiring time rather than once per interval forever.
    expect(() => worker.start({ prisma: store.client }, settings, "w1")).toThrow(/needs a delivery arm/);
  });

  test("it refuses to judge a deadline against a worker's own clock (§10.6)", async () => {
    const store = buildStore();
    await expect(
      worker.drainOnce({ prisma: store.client, deliver: async () => ({ delivered: true }) }, settings, "w1"),
    ).rejects.toThrow(/Commitment Store's clock/);
  });

  test("a successful pass claims, delivers, and marks", async () => {
    const store = buildStore();
    await enqueueOffer(store);

    const delivered = [];
    const summary = await worker.drainOnce(
      deps(store, async (agentId, envelope) => {
        delivered.push({ agentId, command: envelope.command });
        return { delivered: true };
      }),
      settings,
      "w1",
    );

    expect(summary).toMatchObject({ claimed: 1, delivered: 1, undelivered: 0 });
    expect(delivered).toEqual([{ agentId: fixture.agent.id, command: "OFFER" }]);
    expect(store.rows("outbox")[0].state).toBe(outbox.OUTBOX_STATE.DELIVERED);
  });

  test("a thrown transport error is an undelivered attempt with a recorded cause, never swallowed", async () => {
    const store = buildStore();
    await enqueueOffer(store);

    const summary = await worker.drainOnce(
      deps(store, async () => {
        throw new Error("socket exploded");
      }),
      settings,
      "w1",
    );

    expect(summary).toMatchObject({ delivered: 0, undelivered: 1 });
    expect(store.rows("outbox")[0]).toMatchObject({
      state: outbox.OUTBOX_STATE.PENDING,
      attempts: 1,
      lastError: "socket exploded",
    });
  });

  test("an offline agent leaves the row PENDING for the next pass — a state, not a discard", async () => {
    const store = buildStore();
    await enqueueOffer(store);

    await worker.drainOnce(deps(store, async () => ({ delivered: false, detail: "AGENT_NOT_CONNECTED" })), settings, "w1");
    expect(store.rows("outbox")[0].state).toBe(outbox.OUTBOX_STATE.PENDING);

    // §11.3 — the row is retried, but not instantly. The pass that follows the failure
    // too closely takes nothing; the pass after the backoff has elapsed delivers. Before
    // the backoff was enforced this second `drainOnce` delivered immediately, which is
    // what made the retry cadence the tick interval rather than the schedule.
    let attemptedInsideBackoff = false;
    await worker.drainOnce(
      deps(store, async () => {
        attemptedInsideBackoff = true;
        return { delivered: true };
      }),
      settings,
      "w1",
    );
    expect(attemptedInsideBackoff).toBe(false);
    expect(store.rows("outbox")[0].state).toBe(outbox.OUTBOX_STATE.PENDING);

    store.advanceClock(RETRY_WINDOW_SECONDS);
    await worker.drainOnce(deps(store, async () => ({ delivered: true })), settings, "w1");
    expect(store.rows("outbox")[0].state).toBe(outbox.OUTBOX_STATE.DELIVERED);
  });

  test("a backlog of backing-off rows does not starve a fresh command behind it (§11.3)", async () => {
    const store = buildStore();

    // Fill the head of the queue with rows that have already failed an attempt, so they
    // are the oldest *and* deferred. A claim window equal to the batch size would stop
    // at them and take nothing.
    for (let index = 0; index < 5; index += 1) {
      await enqueueOffer(store, { command: "RECALL", sequence: index + 1 });
    }
    await worker.drainOnce(deps(store, async () => ({ delivered: false, detail: "AGENT_NOT_CONNECTED" })), settings, "w1");
    expect(store.rows("outbox").every((r) => r.state === outbox.OUTBOX_STATE.PENDING)).toBe(true);

    // A brand-new command arrives behind them. It has never been attempted, so §11.3
    // defers nothing about it.
    store.advanceClock(1);
    await enqueueOffer(store, { sequence: 99 });

    const delivered = [];
    await worker.drainOnce(
      deps(store, async (_agentId, envelope) => {
        delivered.push(envelope.sequence);
        return { delivered: true };
      }),
      settings,
      "w1",
    );

    expect(delivered).toEqual([99]);
  });

  test("a row past its validity is expired before it is ever offered to the transport (§23.3)", async () => {
    const store = buildStore();
    await enqueueOffer(store, { notValidAfter: new Date(STORE_NOW.getTime() + 5_000) });
    store.advanceClock(6);

    let attempted = false;
    const summary = await worker.drainOnce(
      deps(store, async () => {
        attempted = true;
        return { delivered: true };
      }),
      settings,
      "w1",
    );

    expect(attempted).toBe(false);
    expect(summary.expired).toBe(1);
    expect(store.rows("outbox")[0].state).toBe(outbox.OUTBOX_STATE.EXPIRED);
  });

  test("step 2 marks the row UNACKNOWLEDGED and records the directive", async () => {
    const store = buildStore();
    await enqueueOffer(store);
    await worker.drainOnce(deps(store, async () => ({ delivered: true })), settings, "w1");

    store.advanceClock(OFFER_TTL_SECONDS + 1);

    const events = [];
    await worker.drainOnce(
      deps(store, async () => ({ delivered: true }), (event, detail) => events.push({ event, detail })),
      settings,
      "w1",
    );

    expect(store.rows("outbox")[0].state).toBe(outbox.OUTBOX_STATE.UNACKNOWLEDGED);
    const escalated = events.find((e) => e.event === "dispatch.escalation");
    expect(escalated.detail).toMatchObject({
      step: escalation.ESCALATION_STEP.WITHDRAW,
      action: escalation.ESCALATION_ACTION.WITHDRAW_AND_REPLAN,
    });
  });

  test("without the transaction seam the withdrawal is not attempted, and the row stays outstanding", async () => {
    const store = buildStore();
    await enqueueOffer(store);
    await worker.drainOnce(deps(store, async () => ({ delivered: true })), settings, "w1");
    store.advanceClock(OFFER_TTL_SECONDS + 1);
    const summary = await worker.drainOnce(deps(store, async () => ({ delivered: true })), settings, "w1");

    // §4.1 rule 5: the withdrawal advances a fence and must be written with the WITHDRAW
    // it authorises, so a worker with no transaction to write them in performs neither.
    expect(store.rows("agent")[0].fenceCounter).toBe(41n);
    expect(store.rows("outbox").filter((r) => r.command === "WITHDRAW")).toHaveLength(0);
    expect(summary.withdrawn).toBe(0);

    // But the obligation does not vanish. It stays UNACKNOWLEDGED — an outstanding
    // state — so the depth SLI still counts it and a later pass can still act on it.
    expect(store.rows("outbox")[0].state).toBe(outbox.OUTBOX_STATE.UNACKNOWLEDGED);
    expect(summary.depth).toBe(1);
    expect(summary.unacknowledged).toBe(1);
  });

  /* ─────────────────────────────────────────────────────────────────────────
     §11.4 step 2, performed. These are the regression tests for the Phase 4
     independent verification's blocking finding 2: the ladder's substantive rung
     had no production caller, so an offer that timed out left its commitment held
     forever, and the state it did reach was invisible to every SLI and sweep that
     looks for outstanding work.
     ───────────────────────────────────────────────────────────────────────── */

  function withdrawalSettings() {
    return {
      ...settings,
      maxDeliveryDelaySeconds: 30,
      nackCooloffSeconds: 60,
      signingKey: fixtures.TEST_SIGNING_KEY,
    };
  }

  function withdrawingDeps(store, deliver, record) {
    return {
      ...deps(store, deliver, record),
      runInTransaction: (fn) => store.client.$transaction(fn),
    };
  }

  async function offerThenTimeOut(store, record) {
    // The Leg must be where a delivered offer leaves it (§11.2), because the withdrawal
    // is a conditional write on that state; and the agent's counter must be where the
    // commit that allocated the offer's fence left it, or the withdrawal would draw a
    // fence that ties with the offer instead of superseding it.
    await store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { state: "OFFERED" } });
    await store.client.agent.update({ where: { id: fixtures.AGENT_ROW_ID }, data: { fenceCounter: 42n } });
    await enqueueOffer(store);
    await worker.drainOnce(withdrawingDeps(store, async () => ({ delivered: true })), withdrawalSettings(), "w1");
    store.advanceClock(OFFER_TTL_SECONDS + 1);
    return worker.drainOnce(
      withdrawingDeps(store, async () => ({ delivered: true }), record),
      withdrawalSettings(),
      "w1",
    );
  }

  test("an offer that times out is actually withdrawn: fence advanced, commitment released, Leg requeued", async () => {
    const store = buildStore();
    const summary = await offerThenTimeOut(store);

    expect(summary.withdrawn).toBe(1);

    // §11.4 step 2 — "withdraw offer at an **advanced commitment fence**". 41 → 42 was
    // the offer's own fence; the withdrawal takes 43, so it supersedes rather than ties.
    expect(store.rows("agent")[0].fenceCounter).toBe(43n);

    const withdrawRow = store.rows("outbox").find((r) => r.command === "WITHDRAW");
    expect(withdrawRow).toBeDefined();
    expect(withdrawRow.fence).toBe(43n);
    expect(withdrawRow.commitmentId).toBe("commitment-c1");

    // "release the commitment … re-plan the Leg excluding it".
    expect(store.rows("commitment")[0].releasedAt).not.toBeNull();
    expect(store.rows("leg").find((l) => l.id === fixtures.LEG_ROW_ID).state).toBe("QUEUED");

    // The offer row reaches a true terminal state — the one §11.3 reserves for an
    // obligation that was escalated rather than discarded.
    const offerRow = store.rows("outbox").find((r) => r.command === "OFFER");
    expect(offerRow.state).toBe(outbox.OUTBOX_STATE.FAILED);
    expect(offerRow.lastError).toBe(escalation.WITHDRAWN_MARK);
  });

  test("the SLI reflects the unanswered offer while it is outstanding and stops counting it once withdrawn", async () => {
    const store = buildStore();

    const events = [];
    const summary = await offerThenTimeOut(store, (event, detail) => events.push({ event, detail }));

    // The unanswered offer is discharged: nothing is left `UNACKNOWLEDGED`. The depth
    // of 1 is the `WITHDRAW` the engine has just enqueued and not yet delivered, which
    // is exactly what an outbox depth is supposed to mean — an obligation the fleet has
    // not yet been told about.
    expect(summary.unacknowledged).toBe(0);
    expect(summary.depth).toBe(1);
    const pending = store.rows("outbox").filter((r) => r.state === outbox.OUTBOX_STATE.PENDING);
    expect(pending.map((r) => r.command)).toEqual(["WITHDRAW"]);

    const escalated = events.find((e) => e.event === "dispatch.escalation");
    expect(escalated.detail).toMatchObject({
      step: escalation.ESCALATION_STEP.WITHDRAW,
      withdrawal: escalation.WITHDRAWN_MARK,
    });
  });

  test("a withdrawn offer still counts as the agent's step-3 mark — the action does not erase its own evidence", async () => {
    const store = buildStore();
    await offerThenTimeOut(store);

    const rows = store.rows("outbox").filter((r) => r.command === "OFFER");
    expect(rows).toHaveLength(1);
    expect(escalation.isMarkedUnresponsive(rows[0])).toBe(true);
    expect(escalation.assessAgent({ recentOffers: rows, strikes: 1 }).step).toBe(
      escalation.ESCALATION_STEP.AGENT_HEALTH,
    );
  });

  test("an offer whose commitment was released in the meantime is closed, not withdrawn at a fence nobody holds", async () => {
    const store = buildStore();
    await store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { state: "OFFERED" } });
    await enqueueOffer(store);
    await worker.drainOnce(withdrawingDeps(store, async () => ({ delivered: true })), withdrawalSettings(), "w1");

    // The ACCEPT that raced the deadline — or a reconciler repair — got there first.
    await store.client.commitment.update({
      where: { id: store.rows("commitment")[0].id },
      data: { releasedAt: store.now() },
    });

    store.advanceClock(OFFER_TTL_SECONDS + 1);
    const summary = await worker.drainOnce(
      withdrawingDeps(store, async () => ({ delivered: true })),
      withdrawalSettings(),
      "w1",
    );

    expect(summary.withdrawn).toBe(0);
    expect(store.rows("agent")[0].fenceCounter).toBe(41n);
    expect(store.rows("outbox").filter((r) => r.command === "WITHDRAW")).toHaveLength(0);
    expect(store.rows("outbox")[0]).toMatchObject({
      state: outbox.OUTBOX_STATE.FAILED,
      lastError: "COMMITMENT_ALREADY_RELEASED",
    });
  });

  test("an unanswered command that is not an offer goes terminal rather than waiting for a withdrawal that cannot apply", async () => {
    const store = buildStore();
    await store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { state: "OFFERED" } });
    await enqueueOffer(store, { command: "RECALL", sequence: 1 });
    await worker.drainOnce(withdrawingDeps(store, async () => ({ delivered: true })), withdrawalSettings(), "w1");
    store.advanceClock(OFFER_TTL_SECONDS + 1);
    const summary = await worker.drainOnce(
      withdrawingDeps(store, async () => ({ delivered: true })),
      withdrawalSettings(),
      "w1",
    );

    expect(summary.withdrawn).toBe(0);
    expect(store.rows("outbox")[0]).toMatchObject({
      state: outbox.OUTBOX_STATE.FAILED,
      lastError: "UNACKNOWLEDGED_AND_NOT_AN_OFFER",
    });
  });

  test("an unanswered offer is not swept away by its own envelope expiring — the withdrawal is still owed", async () => {
    const store = buildStore();
    await store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { state: "OFFERED" } });
    // In production an OFFER's `not_valid_after` **is** its offer TTL, so the two
    // deadlines fall together. The expiry sweep must not close the row before the ladder
    // has acted on it.
    await enqueueOffer(store, { notValidAfter: new Date(STORE_NOW.getTime() + OFFER_TTL_SECONDS * 1000) });
    await worker.drainOnce(deps(store, async () => ({ delivered: true })), settings, "w1");
    store.advanceClock(OFFER_TTL_SECONDS + 1);

    const summary = await worker.drainOnce(deps(store, async () => ({ delivered: true })), settings, "w1");

    expect(summary.expired).toBe(0);
    expect(store.rows("outbox")[0].state).toBe(outbox.OUTBOX_STATE.UNACKNOWLEDGED);
    expect(summary.depth).toBe(1);
  });

  test("the two SLIs §11.1 names are emitted every pass", async () => {
    const store = buildStore();
    await enqueueOffer(store);

    const events = [];
    await worker.drainOnce(
      deps(store, async () => ({ delivered: false }), (event, detail) => events.push({ event, detail })),
      settings,
      "w1",
    );

    const sli = events.find((e) => e.event === "outbox.sli");
    expect(sli.detail).toMatchObject({ depth: 1 });
    expect(sli.detail.oldestUndeliveredAgeSeconds).toBeGreaterThanOrEqual(0);
  });

  test("the envelope carries §23.3's field set, with BigInt fences rendered as strings", async () => {
    const store = buildStore();
    await enqueueOffer(store);
    let envelope = null;
    await worker.drainOnce(
      deps(store, async (_agentId, e) => {
        envelope = e;
        return { delivered: true };
      }),
      settings,
      "w1",
    );

    expect(envelope).toMatchObject({
      command: "OFFER",
      commandClass: "MISSION",
      fenceScope: "COMMITMENT",
      agentId: fixture.agent.id,
      commitmentId: "commitment-c1",
      fence: "42",
      authorityEpoch: null,
      fenceFloor: null,
      sequence: 0,
      signature: "sig",
    });
    expect(typeof envelope.notValidAfter).toBe("string");
    expect(envelope.outboxId).toBe(store.rows("outbox")[0].id);
  });

  test("the two advisory mirrors are written, and losing them costs nothing (I16)", async () => {
    const store = buildStore();
    await enqueueOffer(store);

    const written = new Map();
    const cache = {
      async set(key, value, options) {
        written.set(key, { value, options });
        return "OK";
      },
    };

    const summary = await worker.drainOnce(
      { ...deps(store, async () => ({ delivered: true })), advisoryCache: cache },
      settings,
      "w1",
    );

    expect(summary.delivered).toBe(1);
    expect(written.has(worker.CLAIM_KEY("w1"))).toBe(true);
    expect(written.has(worker.OFFER_KEY("commitment-c1"))).toBe(true);
    // Both carry a TTL — an advisory key with no expiry becomes a second, stale source
    // of truth the moment anybody reads it.
    for (const entry of written.values()) {
      expect(entry.options.ex).toBeGreaterThan(0);
    }
  });

  test("a cache that throws on every write does not stop a command reaching an agent", async () => {
    const store = buildStore();
    await enqueueOffer(store);

    const hostileCache = {
      async set() {
        throw new Error("redis unavailable");
      },
    };

    const summary = await worker.drainOnce(
      { ...deps(store, async () => ({ delivered: true })), advisoryCache: hostileCache },
      settings,
      "w1",
    );

    expect(summary).toMatchObject({ claimed: 1, delivered: 1 });
    expect(store.rows("outbox")[0].state).toBe(outbox.OUTBOX_STATE.DELIVERED);
  });

  test("no advisory cache at all is the normal case, not a degraded one", async () => {
    const store = buildStore();
    await enqueueOffer(store);
    const summary = await worker.drainOnce(deps(store, async () => ({ delivered: true })), settings, "w1");
    expect(summary).toMatchObject({ claimed: 1, delivered: 1 });
  });

  test("a drain failure is recorded rather than thrown out of the loop", async () => {
    const store = buildStore();
    const events = [];
    const handle = worker.start(
      {
        prisma: store.client,
        deliver: async () => ({ delivered: true }),
        readStoreTime: async () => {
          throw new Error("store unreachable");
        },
        record: (event, detail) => events.push({ event, detail }),
      },
      { ...settings, intervalMs: 1 },
      "w1",
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    handle.stop();

    expect(events.some((e) => e.event === "outbox.drain_failed")).toBe(true);
  });
});

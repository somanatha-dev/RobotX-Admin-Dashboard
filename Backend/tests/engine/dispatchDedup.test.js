"use strict";

/**
 * Engine lane — Phase 4: durable agent-side deduplication and the §11.5 handshake.
 *
 * The plan's Phase 4 testing requirement, in its own words:
 *
 * > Unit: fence rejection **per commitment id** (not per agent max); `fence_floor`
 * > invalidates all mission authorities; unknown-commitment command rejected via
 * > `fence_floor`, not admitted for lack of history.
 *
 * and the gate:
 *
 * > **Chaos (§24.5): power-cycle a simulated agent mid-mission wiping dedup state;
 * > redeliver every applied command; assert advanced `dedup_state_generation` at AUTH,
 * > suppressed redelivery, advanced `authority_epoch`, zero double-application (I21).**
 */

const dedupHandshake = require("../../src/engine/dispatch/dedupHandshake");
const fencing = require("../../src/engine/commitment/fencing");
const outbox = require("../../src/engine/dispatch/outbox");

const fixtures = require("./helpers/dispatchFixture");

const HOUR_MS = 3600_000;
const STORE_NOW = fixtures.seed().now;

function report(overrides) {
  return dedupHandshake.parseReport({
    dedupStateGeneration: "1",
    authorityEpoch: "7",
    fenceFloor: "41",
    highWaterMarks: {},
    ...(overrides || {}),
  }).value;
}

function storedState(overrides) {
  return { agentId: fixtures.AGENT_ROW_ID, dedupStateGeneration: 1n, authorityEpoch: 7n, fenceFloor: 41n, ...(overrides || {}) };
}

/* ═══════════════════════════════════════════════════════════════════════════
   §10.3.1 — the rejection rules, per commitment id
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the agent's rejection rules (§10.3.1, §23.3)", () => {
  test("§10.3.1's own worked example: two concurrent commitments stay commandable", () => {
    // "If commitment C1 is granted epoch 5 and C2 epoch 6 on the same agent, then a
    // reroute or a cancellation for C1 carries epoch 5, is below the highest the agent
    // has seen, and is rejected — C1 becomes uncommandable for the rest of its life."
    const perCommitment = new Map([
      ["C1", 5n],
      ["C2", 6n],
    ]);

    // Under the shipped comparison, a command for C1 at fence 7 is accepted, because
    // C1's own history is 5.
    expect(dedupHandshake.agentAdmits({ command: "REROUTE", commitmentId: "C1", fence: 7n }, {
      highestSeenPerCommitment: perCommitment,
    })).toEqual({ accepted: true, reason: null });

    // Under the defective per-agent-maximum comparison it would be judged against 6.
    const perAgentMaximum = 6n;
    const defective = 7n > perAgentMaximum;
    expect(defective).toBe(true);
    // …and a command for C1 at fence 6 is where the two disagree, which is the defect.
    expect(dedupHandshake.agentAdmits({ command: "REROUTE", commitmentId: "C1", fence: 6n }, {
      highestSeenPerCommitment: perCommitment,
    }).accepted).toBe(true);
    expect(6n > perAgentMaximum).toBe(false);
  });

  test("a mission command at or below this commitment's own high-water mark is rejected", () => {
    const state = { highestSeenPerCommitment: new Map([["C1", 5n]]) };
    expect(dedupHandshake.agentAdmits({ command: "RECALL", commitmentId: "C1", fence: 5n }, state)).toEqual({
      accepted: false,
      reason: "FENCE_SUPERSEDED_FOR_COMMITMENT",
    });
    expect(dedupHandshake.agentAdmits({ command: "RECALL", commitmentId: "C1", fence: 6n }, state).accepted).toBe(true);
  });

  test("fence_floor invalidates every mission authority in one action", () => {
    const state = {
      highestSeenPerCommitment: new Map([
        ["C1", 5n],
        ["C2", 6n],
      ]),
      fenceFloor: 10n,
    };
    for (const commitmentId of ["C1", "C2", "C3"]) {
      expect(dedupHandshake.agentAdmits({ command: "REROUTE", commitmentId, fence: 9n }, state)).toEqual({
        accepted: false,
        reason: "FENCE_AT_OR_BELOW_FLOOR",
      });
    }
  });

  test("an unknown commitment is judged by fence_floor, never admitted for lack of history (§23.3)", () => {
    // "A mission command for an unknown commitment id is **not** admitted on the
    // grounds that no prior fence is recorded for it: the `fence_floor` check governs
    // that case, which is what makes a STAND_DOWN_ALL durable against a subsequently
    // redelivered stale offer."
    const afterStandDown = { highestSeenPerCommitment: new Map(), fenceFloor: 41n };
    expect(dedupHandshake.agentAdmits({ command: "OFFER", commitmentId: "never-seen", fence: 40n }, afterStandDown))
      .toEqual({ accepted: false, reason: "FENCE_AT_OR_BELOW_FLOOR" });
    expect(dedupHandshake.agentAdmits({ command: "OFFER", commitmentId: "never-seen", fence: 42n }, afterStandDown)
      .accepted).toBe(true);
  });

  test("an agent command is rejected at `<`, not `≤` — a redelivered QUARANTINE is harmless", () => {
    const state = { highestSeenAuthority: 8n };
    expect(dedupHandshake.agentAdmits({ command: "QUARANTINE", authorityEpoch: 7n }, state).accepted).toBe(false);
    expect(dedupHandshake.agentAdmits({ command: "QUARANTINE", authorityEpoch: 8n }, state).accepted).toBe(true);
  });

  test("a query is always answered and never fenced (§10.3.1 row 3)", () => {
    const hostile = { highestSeenPerCommitment: new Map(), fenceFloor: 10n ** 9n, highestSeenAuthority: 10n ** 9n };
    for (const command of fencing.QUERY_COMMANDS) {
      expect(dedupHandshake.agentAdmits({ command }, hostile)).toEqual({ accepted: true, reason: null });
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §11.5 — parsing the report
   ═══════════════════════════════════════════════════════════════════════════ */

describe("parsing the AUTH dedup report", () => {
  test("absence is the legacy path, not a malformation", () => {
    expect(dedupHandshake.parseReport(undefined)).toMatchObject({ ok: false, reason: "NO_DEDUP_REPORT" });
    expect(dedupHandshake.parseReport(null)).toMatchObject({ ok: false, reason: "NO_DEDUP_REPORT" });
  });

  test("a report without a generation is rejected — the generation is the whole signal", () => {
    expect(dedupHandshake.parseReport({ authorityEpoch: "7" })).toMatchObject({
      ok: false,
      reason: "DEDUP_REPORT_WITHOUT_GENERATION",
    });
  });

  test("non-integral or negative counters are rejected rather than coerced", () => {
    expect(dedupHandshake.parseReport({ dedupStateGeneration: "banana" })).toMatchObject({
      ok: false,
      reason: "DEDUP_REPORT_COUNTERS_NOT_INTEGRAL",
    });
    expect(dedupHandshake.parseReport({ dedupStateGeneration: "-1" })).toMatchObject({
      ok: false,
      reason: "DEDUP_REPORT_COUNTERS_NEGATIVE",
    });
  });

  test("the marks are a Map keyed by commitment id — never reduced to a maximum", () => {
    const parsed = dedupHandshake.parseReport({
      dedupStateGeneration: "3",
      highWaterMarks: { C1: { fence: "5", sequence: 0 }, C2: { fence: "6", sequence: 1 } },
    });
    expect(parsed.value.marks).toBeInstanceOf(Map);
    expect(parsed.value.marks.get("C1")).toEqual({ fence: 5n, sequence: 0 });
    expect(parsed.value.marks.get("C2")).toEqual({ fence: 6n, sequence: 1 });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §11.5's three paths, plus the case its table does not name
   ═══════════════════════════════════════════════════════════════════════════ */

describe("classifying the handshake (§11.5's table)", () => {
  const fixture = fixtures.seed();
  const active = [fixtures.commitmentRow(fixture, { fence: 5n })];

  test("row 1 — generation unchanged, marks consistent → RESUME", () => {
    const classification = dedupHandshake.classify({
      reported: report({ highWaterMarks: { "commitment-c1": { fence: "5", sequence: 0 } } }),
      stored: storedState(),
      activeCommitments: active,
    });
    expect(classification.path).toBe(dedupHandshake.DEDUP_PATH.RESUME);
    expect(classification.suppressRedelivery).toBe(false);
    expect(classification.advanceAuthorityEpoch).toBe(false);
  });

  test("row 2 — generation unchanged, marks behind → REDELIVER_FROM_MARK", () => {
    const classification = dedupHandshake.classify({
      reported: report({ highWaterMarks: { "commitment-c1": { fence: "4", sequence: 0 } } }),
      stored: storedState(),
      activeCommitments: active,
    });
    expect(classification.path).toBe(dedupHandshake.DEDUP_PATH.REDELIVER_FROM_MARK);
    expect(classification.redeliverCommitmentIds).toEqual(["commitment-c1"]);
    expect(classification.suppressRedelivery).toBe(false);
  });

  test("a commitment the agent does not mention at all counts as behind, not as consistent", () => {
    const classification = dedupHandshake.classify({
      reported: report({ highWaterMarks: {} }),
      stored: storedState(),
      activeCommitments: active,
    });
    expect(classification.path).toBe(dedupHandshake.DEDUP_PATH.REDELIVER_FROM_MARK);
  });

  test("row 3 — generation advanced → SUPPRESS_AND_REFENCE", () => {
    const classification = dedupHandshake.classify({
      reported: report({ dedupStateGeneration: "2" }),
      stored: storedState({ dedupStateGeneration: 1n }),
      activeCommitments: active,
    });
    expect(classification).toMatchObject({
      path: dedupHandshake.DEDUP_PATH.SUPPRESS_AND_REFENCE,
      reason: "DEDUP_STATE_GENERATION_ADVANCED",
      suppressRedelivery: true,
      advanceAuthorityEpoch: true,
    });
    expect(classification.redeliverCommitmentIds).toEqual([]);
  });

  test("a generation that went backwards is treated as a reset, not as an old session", () => {
    const classification = dedupHandshake.classify({
      reported: report({ dedupStateGeneration: "1" }),
      stored: storedState({ dedupStateGeneration: 5n }),
      activeCommitments: active,
    });
    expect(classification).toMatchObject({
      path: dedupHandshake.DEDUP_PATH.SUPPRESS_AND_REFENCE,
      reason: "DEDUP_STATE_GENERATION_WENT_BACKWARDS",
    });
  });

  test("no stored generation with active commitments is treated as a reset (conservative)", () => {
    const classification = dedupHandshake.classify({
      reported: report(),
      stored: null,
      activeCommitments: active,
    });
    expect(classification.path).toBe(dedupHandshake.DEDUP_PATH.SUPPRESS_AND_REFENCE);
  });

  test("no stored generation and nothing held is FIRST_CONTACT — no epoch advanced for nothing", () => {
    const classification = dedupHandshake.classify({ reported: report(), stored: null, activeCommitments: [] });
    expect(classification).toMatchObject({
      path: dedupHandshake.DEDUP_PATH.FIRST_CONTACT,
      suppressRedelivery: false,
      advanceAuthorityEpoch: false,
    });
  });

  test("only the generation-advance case counts towards §11.5's SLI", () => {
    const advanced = dedupHandshake.classify({
      reported: report({ dedupStateGeneration: "2" }),
      stored: storedState(),
      activeCommitments: active,
    });
    const backwards = dedupHandshake.classify({
      reported: report({ dedupStateGeneration: "0" }),
      stored: storedState(),
      activeCommitments: active,
    });
    expect(dedupHandshake.isGenerationAdvance(advanced)).toBe(true);
    expect(dedupHandshake.isGenerationAdvance(backwards)).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Invariant I7 — custody is reconciled before any re-offer
   ═══════════════════════════════════════════════════════════════════════════ */

describe("custody reconciliation precedes any re-offer (§11.5, invariant I7)", () => {
  const fixture = fixtures.seed();

  test("an agent holding goods is flagged, whatever path it took", () => {
    const holding = [fixtures.commitmentRow(fixture, { custodyState: "HELD" })];
    for (const stored of [null, storedState()]) {
      const classification = dedupHandshake.classify({
        reported: report({ dedupStateGeneration: "9" }),
        stored,
        activeCommitments: holding,
      });
      expect(classification.custodyReconciliationRequired).toBe(true);
      expect(classification.custodyDetail.commitments).toEqual(["commitment-c1"]);
    }
  });

  test("an agent holding nothing is not flagged", () => {
    const classification = dedupHandshake.classify({
      reported: report(),
      stored: storedState(),
      activeCommitments: [fixtures.commitmentRow(fixture, { custodyState: "NONE" })],
    });
    expect(classification.custodyReconciliationRequired).toBe(false);
  });

  test("DISPUTED counts as holding — unknown is never permission (T2)", () => {
    // §2.5 gives DISPUTED `holdsGoods: true` precisely because "the engine does not
    // know where the goods are, and 'does not know' resolves to 'may be holding'". The
    // handshake reads that one definition rather than restating a custody test.
    const detail = dedupHandshake.requiresCustodyReconciliation([
      fixtures.commitmentRow(fixture, { custodyState: "DISPUTED" }),
    ]);
    expect(detail.required).toBe(true);
  });

  test("PENDING_TRANSFER does not — §2.5 places the goods with the sender until handover completes", () => {
    const detail = dedupHandshake.requiresCustodyReconciliation([
      fixtures.commitmentRow(fixture, { custodyState: "PENDING_TRANSFER" }),
    ]);
    expect(detail.required).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Applying the handshake — the three writes that must land together
   ═══════════════════════════════════════════════════════════════════════════ */

describe("applying the handshake", () => {
  const fixture = fixtures.seed();

  function storeWithPendingOffer() {
    const store = fixtures.storeFor(fixture, { commitments: [fixtures.commitmentRow(fixture, { fence: 42n })] });
    return store;
  }

  async function seedOutbox(store) {
    await store.client.$transaction((tx) =>
      outbox.enqueue(
        tx,
        outbox.buildRow({
          command: "OFFER",
          agentId: fixture.agent.id,
          commitmentId: "commitment-c1",
          fence: 42n,
          sequence: 0,
          payload: {},
          notValidAfter: new Date(STORE_NOW.getTime() + HOUR_MS),
          signature: "sig",
        }),
      ),
    );
  }

  async function applyPath(store, classification) {
    return store.client.$transaction(async (tx) => {
      const agent = await tx.agent.findUnique({ where: { id: fixture.agent.id } });
      return dedupHandshake.apply(tx, {
        agent,
        reported: report({ dedupStateGeneration: "2" }),
        classification,
        storeTime: store.now(),
      });
    });
  }

  test("the reset path suppresses, advances the epoch, and records the mark — atomically", async () => {
    const store = storeWithPendingOffer();
    await seedOutbox(store);

    const classification = dedupHandshake.classify({
      reported: report({ dedupStateGeneration: "2" }),
      stored: storedState(),
      activeCommitments: [fixtures.commitmentRow(fixture, { fence: 42n })],
    });
    const applied = await applyPath(store, classification);

    expect(applied.suppressedRows).toBe(1);
    expect(store.rows("outbox")[0].state).toBe(outbox.OUTBOX_STATE.SUPPRESSED);
    expect(store.rows("agent")[0].authorityEpoch).toBe(8n);
    // Invariant I6's persisted mark moves with the epoch, as it does with the fence.
    expect(store.rows("agentFenceAudit")[0].epochHighWater).toBe(8n);
    expect(store.rows("agentDedupState")[0]).toMatchObject({ dedupStateGeneration: 2n });
  });

  test("the resume path records the mark and writes nothing else", async () => {
    const store = storeWithPendingOffer();
    await seedOutbox(store);

    const classification = dedupHandshake.classify({
      reported: report({ highWaterMarks: { "commitment-c1": { fence: "42", sequence: 0 } } }),
      stored: storedState(),
      activeCommitments: [fixtures.commitmentRow(fixture, { fence: 42n })],
    });
    const applied = await applyPath(store, classification);

    expect(applied.suppressedRows).toBe(0);
    expect(store.rows("outbox")[0].state).toBe(outbox.OUTBOX_STATE.PENDING);
    expect(store.rows("agent")[0].authorityEpoch).toBe(7n);
    expect(store.rows("agentDedupState")).toHaveLength(1);
  });

  test("even FIRST_CONTACT records the mark — without it, every session looks like first contact", async () => {
    const store = fixtures.storeFor(fixture);
    const classification = dedupHandshake.classify({ reported: report(), stored: null, activeCommitments: [] });
    await applyPath(store, classification);
    expect(store.rows("agentDedupState")).toHaveLength(1);
    expect(store.rows("agent")[0].authorityEpoch).toBe(7n);
  });

  test("apply refuses to run outside a transaction", async () => {
    const store = fixtures.storeFor(fixture);
    await expect(
      dedupHandshake.apply(store.client, {
        agent: fixture.agent,
        reported: report(),
        classification: dedupHandshake.classify({ reported: report(), stored: null, activeCommitments: [] }),
        storeTime: store.now(),
      }),
    ).rejects.toThrow(/MUST share one transaction/);
  });

  test("the acknowledgement carries the new epoch and floor, so the agent adopts both", async () => {
    const store = storeWithPendingOffer();
    await seedOutbox(store);
    const classification = dedupHandshake.classify({
      reported: report({ dedupStateGeneration: "2" }),
      stored: storedState(),
      activeCommitments: [fixtures.commitmentRow(fixture, { fence: 42n })],
    });
    const ack = dedupHandshake.acknowledgement(await applyPath(store, classification));

    expect(ack).toMatchObject({
      path: dedupHandshake.DEDUP_PATH.SUPPRESS_AND_REFENCE,
      authorityEpoch: "8",
      fenceFloor: "41",
      redeliverySuppressed: true,
    });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Invariant I21 — the redelivery that would double-execute is impossible
   ═══════════════════════════════════════════════════════════════════════════ */

describe("I21 — a stale command cannot survive the reset path", () => {
  const fixture = fixtures.seed();

  test("after the reset, the agent's own rules reject every command from the old authority", async () => {
    const store = fixtures.storeFor(fixture, { commitments: [fixtures.commitmentRow(fixture, { fence: 42n })] });
    await store.client.agent.update({ where: { id: fixture.agent.id }, data: { fenceCounter: 42n } });

    await store.client.$transaction((tx) =>
      outbox.enqueue(
        tx,
        outbox.buildRow({
          command: "OFFER",
          agentId: fixture.agent.id,
          commitmentId: "commitment-c1",
          fence: 42n,
          sequence: 0,
          payload: {},
          notValidAfter: new Date(STORE_NOW.getTime() + HOUR_MS),
          signature: "sig",
        }),
      ),
    );

    const classification = dedupHandshake.classify({
      reported: report({ dedupStateGeneration: "2" }),
      stored: storedState(),
      activeCommitments: [fixtures.commitmentRow(fixture, { fence: 42n })],
    });

    const applied = await store.client.$transaction(async (tx) => {
      const agent = await tx.agent.findUnique({ where: { id: fixture.agent.id } });
      return dedupHandshake.apply(tx, {
        agent,
        reported: report({ dedupStateGeneration: "2" }),
        classification,
        storeTime: store.now(),
      });
    });

    // Server side: the row is suppressed and can never be claimed.
    expect(store.rows("outbox")[0].state).toBe(outbox.OUTBOX_STATE.SUPPRESSED);
    const claimed = await outbox.claim(store.client, {
      workerId: "w1",
      storeTime: store.now(),
      limit: 10,
      claimTtlSeconds: 20,
    });
    expect(claimed).toHaveLength(0);

    // Agent side: even if that row escaped and were delivered, the floor the agent
    // adopts at AUTH rejects it. Two independent lines of defence, which is the
    // arrangement §11.5 asks for.
    const ack = dedupHandshake.acknowledgement(applied);
    const agentState = {
      highestSeenPerCommitment: new Map(),
      fenceFloor: BigInt(ack.fenceFloor),
      highestSeenAuthority: BigInt(ack.authorityEpoch),
    };
    expect(dedupHandshake.agentAdmits({ command: "OFFER", commitmentId: "commitment-c1", fence: 42n }, agentState))
      .toEqual({ accepted: false, reason: "FENCE_AT_OR_BELOW_FLOOR" });
  });
});

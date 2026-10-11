"use strict";

/**
 * Phase 6 — §17.4's ladder as PRODUCTION composes it: a Leg no agent can serve reaches a
 * decision instead of being re-priced for ever.
 *
 * Phase 5 measured, on the LOCAL stack, a PENDING task (TSK-1791530708128-820) whose Leg was
 * F19-infeasible for every agent — its SLA deadline had passed — re-priced about 117 times a
 * minute for hours. F19 is class F, which §17.4 never relaxes, so no round could ever serve it.
 * The domain's exit for such a Leg already exists: the QUEUED deadline fires §17.4's ladder,
 * rungs 1–6 widen, rungs 7–8 hand it to a person, and §4.4's `ladder exhausted → FAILED`
 * declines it with a stated reason. But that Leg's ladder timer had fired nine times and
 * answered `UNDETERMINED:LADDER_NOT_PUBLISHED` every time, although the pinned configuration
 * publishes all eight fractions.
 *
 * The cause was the composition, not the ladder: server.js passes the leader workers a GETTER
 * (`values: () => app.locals.config.values`), every read in `leaderWorkers` unwraps it through
 * `valuesOf` — except the one that handed it to `ladder.create`, which reads a Map or an
 * object. `fairnessLadder.test.js` always passed a Map, so no test saw the seam.
 *
 * These tests build the handler map through `COMPOSERS.timer` with server.js's getter shape and
 * fire the real ESCALATION_LADDER handler — real ladder, real §4.4 transition — against the
 * in-memory store. Nothing here relaxes a gate: the only way to FAILED is still rung 8 with a
 * human admitted; with no escalation capacity published the Leg is held, not failed; and a Leg
 * that is merely waiting stays queued and keeps being offered to rounds.
 */

jest.mock("../../src/workers/timer.worker", () => {
  const actual = jest.requireActual("../../src/workers/timer.worker");
  // The composer starts the worker's interval; capture its arguments instead.
  return { ...actual, start: jest.fn(() => ({ stop: () => {} })) };
});

const timerWorker = require("../../src/workers/timer.worker");
const leaderWorkers = require("../../src/workers/leaderWorkers");
const ladder = require("../../src/engine/fairness/ladder");
const legMachine = require("../../src/engine/lifecycle/legMachine");
const { createCommitmentStore } = require("./helpers/commitmentStore");

const STORE_NOW = new Date("2026-10-09T12:00:00.000Z");
const BUDGET_SECONDS = 3600; // `sla.assignment_deadline` as the LOCAL pinned version publishes it
const REGION = "rnsit";
const LEG_ROW_ID = "9625f535-c5c0-52b6-b4cd-27891038eab8";

/** The published values, as `app.locals.config.values` holds them. */
function publishedValues(overrides) {
  const map = new Map([
    // §17.4's defaults, as the pinned version publishes them (supplementary.json).
    ["ladder.step_1_widen_radius_fraction", 0.25],
    ["ladder.step_2_admit_wait_classes_fraction", 0.4],
    ["ladder.step_3_relax_class_p_fraction", 0.55],
    ["ladder.step_4_permit_preemption_fraction", 0.7],
    ["ladder.step_5_cross_region_fraction", 0.8],
    ["ladder.step_6_manufacture_supply_fraction", 0.85],
    ["ladder.step_7_human_dispatcher_fraction", 0.9],
    ["ladder.step_8_alternative_modality_fraction", 1],
    ["sla.assignment_deadline", BUDGET_SECONDS],
    ["ops.escalation_capacity", 2],
    ["ops.escalation_saturation_period", 600],
    ["supervise.max_timer_lag", 5],
  ]);
  for (const [name, value] of Object.entries(overrides || {})) map.set(name, value);
  return map;
}

/** `COMPOSERS.timer` exactly as server.js calls it: `values` is a getter. */
function composeTimer(values) {
  timerWorker.start.mockClear();
  const composed = leaderWorkers.COMPOSERS.timer({
    prisma: {},
    kv: null,
    values: () => values,
    record: () => {},
    runInTransaction: async (fn) => fn({}),
    regionId: REGION,
  });
  expect(composed.ok).toBe(true);
  const [deps, config] = timerWorker.start.mock.calls[0];
  return { handlers: deps.handlers, config };
}

function storeQueuedFor(queueAgeSeconds) {
  return createCommitmentStore({
    leg: [
      {
        id: LEG_ROW_ID,
        legId: "LEG-TSK-1791530708128-820",
        missionId: "mission-820",
        sequence: 0,
        purpose: "PRIMARY",
        state: legMachine.LEG_STATE.QUEUED,
        custodyState: "NONE",
        version: 0,
        cancelRequestedAt: null,
        startNotBefore: null,
        obstructionClass: null,
        slaDeadline: new Date(STORE_NOW.getTime() - 3_600_000),
      },
    ],
    workQueue: [
      {
        id: "wq-820",
        legId: LEG_ROW_ID,
        shardId: "rnsit-shard",
        idempotencyKey: "idem-820",
        purpose: "PRIMARY",
        slaClass: "STANDARD",
        tenantId: null,
        priority: 0,
        state: "QUEUED",
        roundsConsidered: 0,
        consecutiveDeferrals: 0,
        version: 0,
        enqueuedAt: new Date(STORE_NOW.getTime() - queueAgeSeconds * 1000),
        settledAt: null,
      },
    ],
    ladderEscalation: [],
    now: STORE_NOW,
  });
}

/** Fire the QUEUED deadline's handler, as the timer worker does, in one transaction. */
async function fireQueuedDeadline(store, composed) {
  const leg = await store.client.leg.findUnique({ where: { id: LEG_ROW_ID } });
  const spec = legMachine.deadlineFor(leg.state);
  const timer = {
    id: "timer-queued",
    timerKey: `LEG:${leg.id}:${leg.state}:${leg.version}:${spec.onExpiry}`,
    entityType: "LEG",
    entityId: leg.id,
    state: leg.state,
    entityVersion: BigInt(leg.version),
    dueAt: new Date(STORE_NOW.getTime() - 1000),
    createdAt: new Date(STORE_NOW.getTime() - 901_000),
    handler: spec.onExpiry,
    payload: { armedSeconds: 900 },
    timerState: "PENDING",
    attempts: 0,
    shardId: "rnsit-shard",
  };
  expect(timer.handler).toBe("ESCALATION_LADDER");
  const result = await store.client.$transaction((tx) =>
    composed.handlers[timer.handler]({
      tx,
      prisma: store.client,
      timer,
      entity: leg,
      storeTime: store.now(),
      config: composed.config,
      record: () => {},
    }),
  );
  return {
    result,
    after: await store.client.leg.findUnique({ where: { id: LEG_ROW_ID } }),
    rungs: store.rows("ladderEscalation").map((row) => row.step).sort((a, b) => a - b),
  };
}

describe("the defect: the getter server.js passes cannot be read by the ladder directly", () => {
  test("ladder.create given server.js's getter reads every rung as unpublished", async () => {
    const getter = () => publishedValues();
    const built = ladder.create({ prisma: {}, values: getter, budgetSeconds: BUDGET_SECONDS, regionId: REGION, escalationCapacity: 2 });
    const store = storeQueuedFor(BUDGET_SECONDS * 6);
    const leg = await store.client.leg.findUnique({ where: { id: LEG_ROW_ID } });
    const verdict = await store.client.$transaction((tx) =>
      built.nextStep({ tx, entityType: "LEG", entityId: LEG_ROW_ID, leg, storeTime: store.now() }),
    );
    // Exactly the timer's recorded outcome on LOCAL: LADDER_UNDETERMINED:LADDER_NOT_PUBLISHED.
    expect(verdict.verdict).toBe(ladder.VERDICT.UNDETERMINED);
    expect(verdict.reason).toBe("LADDER_NOT_PUBLISHED");
  });
});

describe("the production composition (COMPOSERS.timer, getter values) reaches §17.4's decision", () => {
  test("an expired Leg (6× budget, F19-dead) with a dispatcher admitted is declined: QUEUED → FAILED, every rung recorded", async () => {
    const store = storeQueuedFor(BUDGET_SECONDS * 6);
    const { result, after, rungs } = await fireQueuedDeadline(store, composeTimer(publishedValues()));
    expect(result.outcome).not.toMatch(/LADDER_NOT_PUBLISHED/);
    expect(result.ladderStep).toBe(8);
    expect(after.state).toBe(legMachine.LEG_STATE.FAILED);
    expect(rungs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("an expired Leg with NO escalation capacity published is held at the human rung — still QUEUED, never failed unseen", async () => {
    // The LOCAL pinned version's state today: `ops.escalation_capacity` is null.
    const store = storeQueuedFor(BUDGET_SECONDS * 6);
    const { result, after } = await fireQueuedDeadline(store, composeTimer(publishedValues({ "ops.escalation_capacity": null })));
    expect(result.outcome).not.toMatch(/LADDER_NOT_PUBLISHED/);
    expect(after.state).toBe(legMachine.LEG_STATE.QUEUED);
    expect(after.state).not.toBe(legMachine.LEG_STATE.FAILED);
  });

  test("an active Leg (10 % of budget) stays QUEUED with no rung recorded — it keeps being offered to rounds", async () => {
    const store = storeQueuedFor(BUDGET_SECONDS * 0.1);
    const { result, after, rungs } = await fireQueuedDeadline(store, composeTimer(publishedValues()));
    expect(result.ladderStep).toBe(0);
    expect(after.state).toBe(legMachine.LEG_STATE.QUEUED);
    expect(rungs).toEqual([]);
  });

  test("a Leg rejected for a transient reason (60 % of budget) is widened, not failed, and stays QUEUED for the next round", async () => {
    const store = storeQueuedFor(BUDGET_SECONDS * 0.6);
    const { result, after, rungs } = await fireQueuedDeadline(store, composeTimer(publishedValues()));
    expect(result.ladderStep).toBe(3);
    expect(after.state).toBe(legMachine.LEG_STATE.QUEUED);
    expect(rungs).toEqual([1, 2, 3]);
  });
});

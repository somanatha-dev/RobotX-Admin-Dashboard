"use strict";

/**
 * Engine lane — REMEDIAL PHASE T1-04: §17.4's anti-starvation escalation ladder, its human
 * capacity model, and §17.5's agent-starvation detection.
 *
 * ── The defect these exist for ─────────────────────────────────────────────
 * `src/engine/fairness/` was an empty directory holding a `.gitkeep`. Everything around
 * the ladder had been built and four separate test files asserted the directory stayed
 * empty. §1.8 places the anti-starvation *guarantee* in the ladder — "anti-starvation is
 * guaranteed by the ladder (Tier 1) and not by the aging price (Tier 2), which is why the
 * aging multiplier could be safely capped" — and Phase 8 capped
 * `cost.aging.max_multiplier` on the strength of that sentence. The cap shipped; the
 * guarantee did not.
 *
 * The suite is organised around the properties a future edit can quietly break, and the
 * order is deliberate — the asymmetric one first, because it is the one that costs a
 * customer's Leg:
 *
 *   1. **`EXHAUSTED` is reachable from exactly one state of the world.** Every missing,
 *      malformed, or unreadable input returns `UNDETERMINED`, and `expiryActions` re-arms
 *      on it. §4.4's two rows are not symmetric and the code must not treat them as if
 *      they were.
 *   2. **A rung reached is not a rung escalated.** §17.4: "A Leg that 'reached step 7'
 *      without a human ever seeing it has not been escalated, and recording otherwise
 *      would make the ladder's guarantee false in exactly the conditions it exists for."
 *   3. **The ladder is finite, monotone, and published.** The rung is a pure function of
 *      queue age over the budget; the order is validated before any rung is taken.
 *   4. **Every rung crossed is recorded, and recorded once.** §4.5 fires at least once by
 *      design, so idempotence is a correctness property rather than an optimisation.
 *
 * The store is `helpers/commitmentStore.js`, which evaluates the migration's CHECK
 * constraints at apply time — including `LadderEscalation_admitted_xor_held`. That is why
 * a test can assert the *store* refuses a row that claims a human saw a Leg it did not.
 */

const agentStarvation = require("../../src/engine/fairness/agentStarvation");
const expiryActions = require("../../src/engine/supervision/expiryActions");
const ladder = require("../../src/engine/fairness/ladder");
const legMachine = require("../../src/engine/lifecycle/legMachine");
const operatorCapacity = require("../../src/engine/fairness/operatorCapacity");

const { createCommitmentStore } = require("./helpers/commitmentStore");

const STORE_NOW = new Date("2026-07-29T12:00:00.000Z");
/** `sla.assignment_deadline`'s registered default — the ladder's total budget. */
const BUDGET_SECONDS = 900;
const REGION = "region-north";
const LEG_ROW_ID = "leg-queued";

/** @structural §17.4's own published fractions, as the register's defaults carry them */
const FRACTIONS = [0.25, 0.4, 0.55, 0.7, 0.8, 0.85, 0.9, 1.0];

/** The published `values` map, as the composition root resolves it. */
function values(overrides) {
  const map = new Map(ladder.STEPS.map((rung) => [rung.parameter, FRACTIONS[rung.step - 1]]));
  for (const [name, value] of Object.entries(overrides || {})) {
    if (value === undefined) map.delete(name);
    else map.set(name, value);
  }
  return map;
}

function legRow(overrides) {
  return {
    id: LEG_ROW_ID,
    legId: LEG_ROW_ID,
    missionId: "mission-1",
    sequence: 0,
    purpose: "PRIMARY",
    state: legMachine.LEG_STATE.QUEUED,
    custodyState: "NONE",
    version: 0,
    cancelRequestedAt: null,
    obstructionClass: null,
    slaDeadline: null,
    ...(overrides || {}),
  };
}

/**
 * A store whose Leg has been queued for `queueAgeSeconds`.
 *
 * The queue row is the ladder's clock: §26.1's I13 instrument and this module both
 * measure from `WorkQueue.enqueuedAt`, so a fixture that set the age anywhere else would
 * be testing a second notion of queue age.
 */
function storeQueuedFor(queueAgeSeconds, options) {
  const settings = options || {};
  return createCommitmentStore({
    // Every Leg named by a seeded escalation is seeded too, and seeded **queued**. An
    // escalation whose Leg has left the queue is one `reconcile` closes — that is how an
    // escalation stops being outstanding — so a fixture that seeded the rows without the
    // Legs would free the capacity it was trying to fill, and the test would pass for the
    // wrong reason.
    leg: [legRow(settings.leg), ...(settings.holderLegs || [])],
    workQueue:
      settings.queueRow === null
        ? []
        : [
            {
              id: "wq-1",
              legId: LEG_ROW_ID,
              shardId: "shard-1",
              idempotencyKey: "idem-1",
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
              ...(settings.queueRow || {}),
            },
          ],
    ladderEscalation: settings.escalations || [],
    now: STORE_NOW,
  });
}

/** The ladder as the composition root builds it. */
function ladderFor(store, overrides) {
  const events = [];
  const built = ladder.create({
    prisma: store.client,
    values: values(),
    budgetSeconds: BUDGET_SECONDS,
    regionId: REGION,
    escalationCapacity: 2,
    saturationPeriodSeconds: 600,
    record: (event, detail) => events.push({ event, detail }),
    ...(overrides || {}),
  });
  return { ladder: built, events };
}

/** One `nextStep` call inside a real transaction, as the timer worker issues it. */
async function step(store, built, overrides) {
  const leg = await store.client.leg.findUnique({ where: { id: LEG_ROW_ID } });
  return store.client.$transaction((tx) =>
    built.nextStep({
      tx,
      entityType: "LEG",
      entityId: LEG_ROW_ID,
      leg,
      storeTime: store.now(),
      ...(overrides || {}),
    }),
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. `EXHAUSTED` is reachable from exactly one state of the world
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§4.4's two rows are not symmetric — the ladder never fails a Leg on a missing input", () => {
  // Each row is a way the ladder can be asked a question it cannot answer. Every one of
  // them must return `UNDETERMINED`; `expiryActions` re-arms on that and the Leg stays
  // QUEUED. Reading any of them as "exhausted" is §4.1 rule 3's prohibition in its most
  // expensive form — a customer's Leg terminated because a row was missing.
  const undeterminable = [
    [
      "no work-queue row, so queue age has no origin",
      async () => {
        const store = storeQueuedFor(0, { queueRow: null });
        return step(store, ladderFor(store).ladder);
      },
      "NO_QUEUE_ROW",
    ],
    [
      "sla.assignment_deadline did not resolve",
      async () => {
        const store = storeQueuedFor(BUDGET_SECONDS * 2);
        return step(store, ladderFor(store, { budgetSeconds: undefined }).ladder);
      },
      "BUDGET_UNRESOLVED",
    ],
    [
      "the budget resolved to zero — which would put every Leg at rung 8 on arrival",
      async () => {
        const store = storeQueuedFor(BUDGET_SECONDS * 2);
        return step(store, ladderFor(store, { budgetSeconds: 0 }).ladder);
      },
      "BUDGET_UNRESOLVED",
    ],
    [
      "the budget resolved to a negative number",
      async () => {
        const store = storeQueuedFor(BUDGET_SECONDS * 2);
        return step(store, ladderFor(store, { budgetSeconds: -900 }).ladder);
      },
      "BUDGET_UNRESOLVED",
    ],
    [
      "the budget resolved to NaN",
      async () => {
        const store = storeQueuedFor(BUDGET_SECONDS * 2);
        return step(store, ladderFor(store, { budgetSeconds: Number.NaN }).ladder);
      },
      "BUDGET_UNRESOLVED",
    ],
    [
      "the budget resolved to Infinity",
      async () => {
        const store = storeQueuedFor(BUDGET_SECONDS * 2);
        return step(store, ladderFor(store, { budgetSeconds: Number.POSITIVE_INFINITY }).ladder);
      },
      "BUDGET_UNRESOLVED",
    ],
    [
      "one rung's fraction is missing from the published register",
      async () => {
        const store = storeQueuedFor(BUDGET_SECONDS * 2);
        const map = values({ "ladder.step_5_cross_region_fraction": undefined });
        return step(store, ladderFor(store, { values: map }).ladder);
      },
      "LADDER_NOT_PUBLISHED",
    ],
    [
      "the published order is not increasing",
      async () => {
        const store = storeQueuedFor(BUDGET_SECONDS * 2);
        const map = values({ "ladder.step_5_cross_region_fraction": 0.3 });
        return step(store, ladderFor(store, { values: map }).ladder);
      },
      "LADDER_NOT_PUBLISHED",
    ],
    [
      "a fraction is outside [0, 1] — a rung that fires after the deadline it exists to beat",
      async () => {
        const store = storeQueuedFor(BUDGET_SECONDS * 2);
        const map = values({ "ladder.step_8_alternative_modality_fraction": 1.4 });
        return step(store, ladderFor(store, { values: map }).ladder);
      },
      "LADDER_NOT_PUBLISHED",
    ],
    [
      "the queue row is dated after the store clock",
      async () => {
        const store = storeQueuedFor(-120);
        return step(store, ladderFor(store).ladder);
      },
      "ENQUEUED_IN_THE_FUTURE",
    ],
    [
      "no store time was supplied",
      async () => {
        const store = storeQueuedFor(BUDGET_SECONDS * 2);
        return step(store, ladderFor(store).ladder, { storeTime: undefined });
      },
      "NO_STORE_TIME",
    ],
    [
      "the store time is an invalid Date",
      async () => {
        const store = storeQueuedFor(BUDGET_SECONDS * 2);
        return step(store, ladderFor(store).ladder, { storeTime: new Date("not a date") });
      },
      "NO_STORE_TIME",
    ],
    [
      "no Leg row was supplied",
      async () => {
        const store = storeQueuedFor(BUDGET_SECONDS * 2);
        return step(store, ladderFor(store).ladder, { leg: undefined });
      },
      "NO_LEG",
    ],
  ];

  test.each(undeterminable)("%s → UNDETERMINED, never EXHAUSTED", async (_label, run, reason) => {
    const verdict = await run();
    expect(verdict.verdict).toBe(ladder.VERDICT.UNDETERMINED);
    expect(verdict.reason).toBe(reason);
    // The three assertions that matter downstream, stated separately because
    // `expiryActions` reads each of them and a future edit could break one alone.
    expect(verdict.available).toBeNull();
    expect(verdict.exhausted).toBe(false);
    expect(verdict.undetermined).toBe(true);
  });

  test("a Leg past 100 % of budget with no queue row is still not exhausted", async () => {
    // The composite of the two worst inputs: maximally overdue by every other measure,
    // and unmeasurable by the only one that counts.
    const store = storeQueuedFor(0, { queueRow: null });
    const verdict = await step(store, ladderFor(store).ladder);
    expect(verdict.exhausted).toBe(false);
    expect(store.rows("ladderEscalation")).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. The ladder is finite, monotone, and published
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§17.4's rungs — finite, monotone, and read from the register", () => {
  test("there are exactly eight rungs, numbered by position, and rung 8 is the only terminal one", () => {
    expect(ladder.STEPS).toHaveLength(8);
    expect(ladder.STEPS.map((rung) => rung.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ladder.STEPS.filter((rung) => rung.terminal).map((rung) => rung.step)).toEqual([8]);
    // "Steps 7 and 8 route to people" — exactly those two, which is what keeps the
    // outstanding count a count of human work.
    expect(ladder.STEPS.filter((rung) => rung.humanStep).map((rung) => rung.step)).toEqual([7, 8]);
  });

  test("the published defaults are §17.4's own table", () => {
    const published = ladder.stepTableFrom(values());
    expect(published.ok).toBe(true);
    expect(published.table.map((rung) => rung.fraction)).toEqual(FRACTIONS);
  });

  test("no rung names a Tier 2 mechanism it could call — §1.8 rule 2, as data", () => {
    // The rungs that name preemption, cross-region and repositioning are the three whose
    // mechanisms are Tier 2. The gate proves this module imports none of them; this proves
    // the table *knows* which ones they are, so a future edit that reached for one has to
    // change a declared tier to do it.
    expect(ladder.STEPS.filter((rung) => rung.tier === 2).map((rung) => rung.step)).toEqual([4, 5, 6]);
  });

  test.each([
    ["below rung 1", 0.1, null],
    ["exactly at rung 1's trigger", 0.25, 1],
    ["a hair below rung 1", 0.2499, null],
    ["exactly at rung 3", 0.55, 3],
    ["between rungs 3 and 4", 0.6, 3],
    ["exactly at rung 8", 1.0, 8],
    ["past the whole budget", 4.2, 8],
    ["at zero", 0, null],
  ])("stepAt is monotone: %s", (_label, fraction, expected) => {
    const table = ladder.stepTableFrom(values()).table;
    const reached = ladder.stepAt(fraction, table);
    expect(reached === null ? null : reached.step).toBe(expected);
  });

  test.each([
    ["a negative fraction", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("stepAt refuses %s rather than rounding it to a rung", (_label, fraction) => {
    const table = ladder.stepTableFrom(values()).table;
    expect(ladder.stepAt(fraction, table)).toBeNull();
  });

  test("the next boundary is the next rung's, and a passed boundary re-arms at once", () => {
    const table = ladder.stepTableFrom(values()).table;
    // 30 % elapsed: rung 1 is behind, rung 2 fires at 40 % = 360s, so 360 − 270 = 90s.
    expect(ladder.nextBoundarySeconds(ladder.stepAt(0.3, table), table, BUDGET_SECONDS, 270)).toBe(90);
    // Past rung 8: no rung is left ahead, and the caller falls back to §4.5's own re-arm.
    expect(ladder.nextBoundarySeconds(ladder.stepAt(2, table), table, BUDGET_SECONDS, 1800)).toBeUndefined();
    // A boundary already behind us is taken on the next pass, never scheduled in the past.
    expect(ladder.nextBoundarySeconds(null, table, BUDGET_SECONDS, 500)).toBe(1);
  });

  test("a newly enqueued Leg is armed at rung 1, not at the whole budget", () => {
    // The property that makes §17.4's schedule real. §4.3 arms `QUEUED` for the *total*
    // budget, so a first deadline left at that value fires once, at 100 %, with all eight
    // rungs behind it — every rung between "widen the radius" and "ask a person" would
    // exist and never run.
    expect(ladder.firstBoundarySecondsFrom(values(), BUDGET_SECONDS)).toBe(225);
    // A ladder that is not published costs the *schedule*, never the supervision: the
    // caller falls back to §4.3's register entry.
    expect(ladder.firstBoundarySecondsFrom(new Map(), BUDGET_SECONDS)).toBeUndefined();
  });
});

describe("§17.4's rung-3 relaxation order is published, and class I, R and F are never relaxed", () => {
  test("with nothing published, the order is exactly the two the specification names", () => {
    const resolved = ladder.relaxationOrderFrom(undefined);
    expect(resolved.ok).toBe(true);
    expect(resolved.order).toEqual(["ZONE_AFFINITY", "DEDICATED_FLEET_PREFERENCE"]);
  });

  test("a published sequence may extend the mandated head but not reorder it", () => {
    expect(ladder.relaxationOrderFrom(["ZONE_AFFINITY", "DEDICATED_FLEET_PREFERENCE", "BURN_IN_CREDIT"]).ok).toBe(true);
    // "zone affinity first, dedicated-fleet preference next" — in that order, or not at all.
    const swapped = ladder.relaxationOrderFrom(["DEDICATED_FLEET_PREFERENCE", "ZONE_AFFINITY"]);
    expect(swapped.ok).toBe(false);
    expect(swapped.problem).toMatch(/zone affinity first/);
  });

  test.each([["CLASS_I:F21"], ["CLASS_R_F34"], ["class_f:F9"]])(
    "a published sequence naming %s is refused — class I, R and F are never relaxed",
    (token) => {
      const refused = ladder.relaxationOrderFrom(["ZONE_AFFINITY", "DEDICATED_FLEET_PREFERENCE", token]);
      expect(refused.ok).toBe(false);
      expect(refused.problem).toMatch(/never relaxed/);
    },
  );

  test.each([
    ["not a list", "ZONE_AFFINITY"],
    ["a list with an empty token", ["ZONE_AFFINITY", ""]],
    ["a list with a non-string", ["ZONE_AFFINITY", 3]],
  ])("a malformed published sequence (%s) is refused rather than coerced", (_label, published) => {
    expect(ladder.relaxationOrderFrom(published).ok).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. Recording — every rung crossed, exactly once
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§17.4 — each rung recorded with what was relaxed and why", () => {
  test("a Leg at 60 % of budget has reached rung 3, and rungs 1 to 3 are all recorded", async () => {
    const store = storeQueuedFor(BUDGET_SECONDS * 0.6);
    const { ladder: built, events } = ladderFor(store);
    const verdict = await step(store, built);

    expect(verdict.verdict).toBe(ladder.VERDICT.STEP_AVAILABLE);
    expect(verdict.step).toBe(3);
    expect(verdict.available).toBe(true);

    // Every crossed rung, not just the newest: a coarse timer can cross several boundaries
    // between two fires, and a round that only saw rung 3 would never widen the radius.
    const rows = store.rows("ladderEscalation").sort((a, b) => a.step - b.step);
    expect(rows.map((row) => row.step)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.action)).toEqual([
      "WIDEN_SEARCH_RADIUS",
      "ADMIT_FINISHING_SOON_AND_CHARGING_INTERRUPTIBLE",
      "RELAX_CLASS_P_SOFT_CONSTRAINTS",
    ]);
    // "what was relaxed and why", on the row, in the tokens the round consumes.
    expect(rows[0].relaxations).toEqual(["SEARCH_RADIUS"]);
    expect(rows[2].relaxations).toEqual(["ZONE_AFFINITY", "DEDICATED_FLEET_PREFERENCE"]);
    expect(rows[0].cause).toBe("ELAPSED_FRACTION_0.25");
    // §26.1's I13 instrument is "queue age audit versus ladder step" — both halves, on the
    // row, so the audit never has to re-derive one against a queue that has moved.
    expect(rows[0].queueAgeSeconds).toBe(540);
    expect(rows[0].budgetSeconds).toBe(BUDGET_SECONDS);
    expect(rows[0].regionId).toBe(REGION);
    expect(rows[0].slaClass).toBe("STANDARD");
    // None of rungs 1–3 routes to a person, so none of them may hold a human-queue field.
    expect(rows.every((row) => row.humanStep === false && row.admittedAt == null)).toBe(true);

    expect(events.find((entry) => entry.event === "ladder.steps_recorded").detail.steps).toEqual([1, 2, 3]);
  });

  test("firing the same rung twice records it once — §4.5 fires at least once, by design", async () => {
    const store = storeQueuedFor(BUDGET_SECONDS * 0.6);
    const { ladder: built } = ladderFor(store);

    const first = await step(store, built);
    const second = await step(store, built);

    expect(first.step).toBe(3);
    expect(second.step).toBe(3);
    expect(store.rows("ladderEscalation").map((row) => row.step).sort()).toEqual([1, 2, 3]);
  });

  test("advancing to a later rung records only the newly crossed ones", async () => {
    const store = storeQueuedFor(BUDGET_SECONDS * 0.3);
    const { ladder: built } = ladderFor(store);
    await step(store, built);
    expect(store.rows("ladderEscalation").map((row) => row.step)).toEqual([1]);

    // 30 % + 50 % = 80 %, which is rung 5's trigger exactly.
    store.advanceClock(BUDGET_SECONDS * 0.5);
    const later = await step(store, built);
    expect(later.step).toBe(5);
    expect(store.rows("ladderEscalation").map((row) => row.step).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  test("below rung 1 nothing is recorded and the Leg stays queued", async () => {
    const store = storeQueuedFor(BUDGET_SECONDS * 0.1);
    const { ladder: built } = ladderFor(store);
    const verdict = await step(store, built);

    expect(verdict.verdict).toBe(ladder.VERDICT.STEP_AVAILABLE);
    expect(verdict.step).toBe(0);
    expect(store.rows("ladderEscalation")).toEqual([]);
    // Re-armed at rung 1's boundary, so the ladder is ahead of the clock rather than behind.
    expect(verdict.nextBoundarySeconds).toBe(135);
  });

  test("without a transaction the ladder reports and writes nothing (§21.3's read-only enquiry)", async () => {
    const store = storeQueuedFor(BUDGET_SECONDS * 0.6);
    const { ladder: built } = ladderFor(store);
    const leg = await store.client.leg.findUnique({ where: { id: LEG_ROW_ID } });

    const verdict = await built.nextStep({ entityType: "LEG", entityId: LEG_ROW_ID, leg, storeTime: store.now() });

    expect(verdict.step).toBe(3);
    expect(verdict.recorded).toBe(false);
    expect(store.rows("ladderEscalation")).toEqual([]);
  });

  test("a TASK-scope fire records nothing and does not claim a rung (blocker X3)", async () => {
    // §4.2 has no transition table anywhere in the specification, so a Task has no state
    // for a rung to move it to. The rung is the Leg's and is recorded there.
    const store = storeQueuedFor(BUDGET_SECONDS * 2);
    const { ladder: built } = ladderFor(store);
    const verdict = await store.client.$transaction((tx) =>
      built.nextStep({ tx, entityType: "TASK", entityId: "task-1", storeTime: store.now() }),
    );

    expect(verdict.verdict).toBe(ladder.VERDICT.UNDETERMINED);
    expect(verdict.reason).toBe("TASK_SCOPE_HAS_NO_LADDER_ROW");
    expect(store.rows("ladderEscalation")).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. The human rungs — reaching one is not being escalated
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§17.4's human rungs — capacity, holding, and the decision that needs a person", () => {
  test("rung 7 with capacity free is admitted, and the outstanding count moves", async () => {
    const store = storeQueuedFor(BUDGET_SECONDS * 0.92);
    const { ladder: built } = ladderFor(store);
    const verdict = await step(store, built);

    expect(verdict.verdict).toBe(ladder.VERDICT.STEP_AVAILABLE);
    expect(verdict.step).toBe(7);
    expect(verdict.escalated).toBe(true);
    expect(verdict.outstanding).toBe(1);

    const rung7 = store.rows("ladderEscalation").find((row) => row.step === 7);
    expect(rung7.humanStep).toBe(true);
    expect(rung7.admittedAt).toEqual(STORE_NOW);
    expect(rung7.heldReason).toBeNull();
  });

  test("with capacity full, rung 7 is HELD — the Leg stays on the ladder, unescalated", async () => {
    // §17.4: "Escalation is rate-limited into the human queue, and Legs waiting to enter
    // it remain on the ladder rather than being deemed to have completed step 7."
    const store = storeQueuedFor(BUDGET_SECONDS * 0.92, {
      escalations: [
        holding("leg-other-a", 7, { admittedAt: new Date(STORE_NOW.getTime() - 60_000) }),
        holding("leg-other-b", 7, { admittedAt: new Date(STORE_NOW.getTime() - 30_000) }),
      ],
      holderLegs: [
        legRow({ id: "leg-other-a", legId: "leg-other-a" }),
        legRow({ id: "leg-other-b", legId: "leg-other-b" }),
      ],
    });
    const { ladder: built } = ladderFor(store);
    const verdict = await step(store, built);

    expect(verdict.verdict).toBe(ladder.VERDICT.HELD_FOR_HUMAN_CAPACITY);
    // Still `available` — §4.4's first row, so the Leg self-loops and stays QUEUED. It is
    // emphatically **not** exhausted.
    expect(verdict.available).toBe(true);
    expect(verdict.exhausted).toBe(false);
    expect(verdict.reason).toBe(operatorCapacity.HELD_REASON.CAPACITY_SATURATED);

    const rung7 = store.rows("ladderEscalation").find((row) => row.legId === LEG_ROW_ID && row.step === 7);
    // The row records that the rung was *reached* and that no human has it. The store's
    // `LadderEscalation_admitted_xor_held` CHECK is what makes the other combination
    // unwritable.
    expect(rung7.admittedAt).toBeNull();
    expect(rung7.heldReason).toBe(operatorCapacity.HELD_REASON.CAPACITY_SATURATED);
  });

  test("with no ops.escalation_capacity published, the rung is held rather than admitted", async () => {
    // The register marks `ops.escalation_capacity` **required** with no default: "Without
    // it the ladder's human steps are an unbounded promise." An unresolved capacity must
    // not become an unbounded one.
    const store = storeQueuedFor(BUDGET_SECONDS * 0.92);
    const { ladder: built } = ladderFor(store, { escalationCapacity: undefined });
    const verdict = await step(store, built);

    expect(verdict.verdict).toBe(ladder.VERDICT.HELD_FOR_HUMAN_CAPACITY);
    expect(verdict.reason).toBe(operatorCapacity.HELD_REASON.CAPACITY_UNCONFIGURED);
  });

  test("with no region, the rung is held — a region-scoped capacity cannot bound an unregioned escalation", async () => {
    const store = storeQueuedFor(BUDGET_SECONDS * 0.92);
    const { ladder: built } = ladderFor(store, { regionId: undefined });
    const verdict = await step(store, built);

    expect(verdict.verdict).toBe(ladder.VERDICT.HELD_FOR_HUMAN_CAPACITY);
    expect(verdict.reason).toBe(operatorCapacity.HELD_REASON.REGION_UNRESOLVED);
  });

  test("a held Leg that later finds capacity is admitted, and admittedAt is set once", async () => {
    const store = storeQueuedFor(BUDGET_SECONDS * 0.92, {
      escalations: [
        holding("leg-other-a", 7, { admittedAt: new Date(STORE_NOW.getTime() - 60_000) }),
        holding("leg-other-b", 7, { admittedAt: new Date(STORE_NOW.getTime() - 30_000) }),
      ],
      holderLegs: [
        legRow({ id: "leg-other-a", legId: "leg-other-a" }),
        legRow({ id: "leg-other-b", legId: "leg-other-b" }),
      ],
    });
    const { ladder: built } = ladderFor(store);
    expect((await step(store, built)).verdict).toBe(ladder.VERDICT.HELD_FOR_HUMAN_CAPACITY);

    // A dispatcher finishes one: its Leg leaves the queue, which is what resolves an
    // escalation — §17.4 defines no operator-facing resolution API, so the fact is derived
    // from the Leg rather than reported.
    await store.client.leg.update({
      where: { id: "leg-other-a" },
      data: { state: legMachine.LEG_STATE.SETTLED },
    });

    const admittedAtMs = STORE_NOW.getTime();
    store.advanceClock(60);
    const second = await step(store, built);

    expect(second.verdict).toBe(ladder.VERDICT.STEP_AVAILABLE);
    expect(second.escalated).toBe(true);
    const rung7 = store.rows("ladderEscalation").find((row) => row.legId === LEG_ROW_ID && row.step === 7);
    expect(rung7.admittedAt.getTime()).toBe(admittedAtMs + 60_000);
    expect(rung7.heldReason).toBeNull();

    // The finished one is closed with a stated outcome, which is what the saturation
    // window is reconstructed from.
    const closed = store.rows("ladderEscalation").find((row) => row.legId === "leg-other-a");
    expect(closed.resolvedAt).not.toBeNull();
    expect(closed.outcome).toBe(operatorCapacity.RESOLUTION.TERMINAL);
  });

  test("re-firing an admitted rung does not move admittedAt forward", async () => {
    // Moving it would shorten every saturation window that row is part of — the one
    // direction the reading must never move by itself.
    const store = storeQueuedFor(BUDGET_SECONDS * 0.92);
    const { ladder: built } = ladderFor(store);
    await step(store, built);
    const first = store.rows("ladderEscalation").find((row) => row.step === 7).admittedAt;

    store.advanceClock(30);
    await step(store, built);
    expect(store.rows("ladderEscalation").find((row) => row.step === 7).admittedAt).toEqual(first);
  });

  test("a free slot goes to the Leg §17.4 ranks first, not to the one whose timer fired", async () => {
    // > A dispatcher facing forty escalations needs the order chosen deliberately rather
    // > than by arrival.
    //
    // The planted regression, and it is the one a plausible implementation ships: the
    // arriving Leg is the one being processed, so admitting it is the obvious move. Here a
    // Leg **carrying goods** has been held for want of capacity, one slot is free, and the
    // arriving Leg carries none. Custody is §17.4's first key, so the slot is not the
    // arriving Leg's — and it must not take it merely because its timer fired.
    const store = storeQueuedFor(BUDGET_SECONDS * 0.92, {
      escalations: [holding("leg-holding-goods", 7)],
      holderLegs: [legRow({ id: "leg-holding-goods", legId: "leg-holding-goods", custodyState: "HELD" })],
    });
    const { ladder: built } = ladderFor(store, { escalationCapacity: 1 });
    const verdict = await step(store, built);

    expect(verdict.verdict).toBe(ladder.VERDICT.HELD_FOR_HUMAN_CAPACITY);
    expect(verdict.reason).toBe(operatorCapacity.HELD_REASON.OUTRANKED);
    expect(verdict.admittedInstead).toEqual(["leg-holding-goods"]);

    // The Leg carrying goods got the dispatcher; the arriving one is still on the ladder.
    const goods = store.rows("ladderEscalation").find((row) => row.legId === "leg-holding-goods");
    const arriving = store.rows("ladderEscalation").find((row) => row.legId === LEG_ROW_ID && row.step === 7);
    expect(goods.admittedAt).not.toBeNull();
    expect(arriving.admittedAt).toBeNull();
    expect(arriving.heldReason).toBe(operatorCapacity.HELD_REASON.OUTRANKED);
  });

  test("when the arriving Leg outranks the waiting one, it takes the slot", async () => {
    // The other direction, so the test above is not passing merely because the arriving
    // Leg is always refused. Same shape, custody reversed.
    const store = storeQueuedFor(BUDGET_SECONDS * 0.92, {
      leg: { custodyState: "HELD" },
      escalations: [holding("leg-empty", 7)],
      holderLegs: [legRow({ id: "leg-empty", legId: "leg-empty", custodyState: "NONE" })],
    });
    const { ladder: built } = ladderFor(store, { escalationCapacity: 1 });
    const verdict = await step(store, built);

    expect(verdict.verdict).toBe(ladder.VERDICT.STEP_AVAILABLE);
    expect(verdict.escalated).toBe(true);
    const arriving = store.rows("ladderEscalation").find((row) => row.legId === LEG_ROW_ID && row.step === 7);
    expect(arriving.admittedAt).not.toBeNull();
  });

  test("a slot that opens admits the waiting Legs, not only the one being processed", async () => {
    // Two free slots and two Legs waiting: both are admitted in this pass rather than one
    // per tick. Leaving the second for its own timer would reintroduce arrival order one
    // tick later, which is the same defect with a delay.
    const store = storeQueuedFor(BUDGET_SECONDS * 0.92, {
      escalations: [holding("leg-waiting-a", 7), holding("leg-waiting-b", 7)],
      holderLegs: [
        legRow({ id: "leg-waiting-a", legId: "leg-waiting-a", custodyState: "HELD" }),
        legRow({ id: "leg-waiting-b", legId: "leg-waiting-b", custodyState: "HELD" }),
      ],
    });
    const { ladder: built } = ladderFor(store, { escalationCapacity: 3 });
    const verdict = await step(store, built);

    expect(verdict.verdict).toBe(ladder.VERDICT.STEP_AVAILABLE);
    const admitted = store.rows("ladderEscalation").filter((row) => row.admittedAt !== null);
    expect(admitted.map((row) => row.legId).sort()).toEqual(["leg-queued", "leg-waiting-a", "leg-waiting-b"]);
  });

  test("rung 8 with a human holding it and no alternative modality is the decline", async () => {
    const store = storeQueuedFor(BUDGET_SECONDS * 1.2);
    const { ladder: built, events } = ladderFor(store);
    const verdict = await step(store, built);

    expect(verdict.verdict).toBe(ladder.VERDICT.EXHAUSTED);
    expect(verdict.available).toBe(false);
    expect(verdict.step).toBe(8);
    expect(verdict.decision).toBe("DECLINE_WITH_STATED_REASON");
    // §17.4 requires a *stated reason* and a customer notification. The sentence is
    // assembled from what the ladder did, not from a template.
    expect(verdict.sentence).toMatch(/every rung from 1 to 8 was applied and recorded/);
    expect(store.rows("ladderEscalation").map((row) => row.step).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(events.some((entry) => entry.event === "ladder.exhausted")).toBe(true);
  });

  test("rung 8 held for capacity is NOT exhausted — the ladder cannot decline work nobody saw", async () => {
    // The sharpest property in §17.4, and the one a plausible implementation gets wrong:
    // at 120 % of budget with every rung crossed, the obvious answer is "exhausted". It is
    // wrong, because no dispatcher has seen it, and "recording otherwise would make the
    // ladder's guarantee false in exactly the conditions it exists for."
    const store = storeQueuedFor(BUDGET_SECONDS * 1.2, {
      escalations: [
        holding("leg-other-a", 7, { admittedAt: new Date(STORE_NOW.getTime() - 60_000) }),
        holding("leg-other-b", 7, { admittedAt: new Date(STORE_NOW.getTime() - 30_000) }),
      ],
      holderLegs: [
        legRow({ id: "leg-other-a", legId: "leg-other-a" }),
        legRow({ id: "leg-other-b", legId: "leg-other-b" }),
      ],
    });
    const { ladder: built } = ladderFor(store);
    const verdict = await step(store, built);

    expect(verdict.verdict).toBe(ladder.VERDICT.HELD_FOR_HUMAN_CAPACITY);
    expect(verdict.exhausted).toBe(false);
    expect(verdict.available).toBe(true);
  });

  test("with an alternative modality configured, rung 8 takes it instead of declining", async () => {
    const store = storeQueuedFor(BUDGET_SECONDS * 1.2);
    const { ladder: built } = ladderFor(store, {
      alternativeModality: { available: async () => ({ available: true, modality: "THIRD_PARTY_CARRIER" }) },
    });
    const verdict = await step(store, built);

    expect(verdict.verdict).toBe(ladder.VERDICT.STEP_AVAILABLE);
    expect(verdict.modality).toBe("THIRD_PARTY_CARRIER");
    expect(verdict.exhausted).toBe(false);
  });

  test("an alternative modality that reports itself unavailable falls through to the decline", async () => {
    const store = storeQueuedFor(BUDGET_SECONDS * 1.2);
    const { ladder: built } = ladderFor(store, {
      alternativeModality: { available: async () => ({ available: false }) },
    });
    expect((await step(store, built)).verdict).toBe(ladder.VERDICT.EXHAUSTED);
  });
});

function holding(legId, step, overrides) {
  const settings = overrides || {};
  return {
    id: `esc-${legId}-${step}`,
    legId,
    step,
    action: "ESCALATE_TO_HUMAN_DISPATCHER",
    relaxations: ["HUMAN_DISPATCHER_REVIEW"],
    cause: "ELAPSED_FRACTION_0.9",
    queueAgeSeconds: 810,
    budgetSeconds: BUDGET_SECONDS,
    elapsedFraction: 0.9,
    regionId: REGION,
    shardId: "shard-1",
    slaClass: "STANDARD",
    reachedAt: new Date(STORE_NOW.getTime() - 60_000),
    humanStep: true,
    admittedAt: null,
    // Held, not blank. A human rung with neither `admittedAt` nor `heldReason` is a row
    // `LadderEscalation_admitted_xor_held` refuses, so a fixture that seeded one would be
    // testing the module against a state the database cannot hold. Seeded rows bypass the
    // store double's apply-time checks, which is exactly why the default has to be right
    // here rather than caught there.
    heldReason: operatorCapacity.HELD_REASON.CAPACITY_SATURATED,
    resolvedAt: null,
    outcome: null,
    ...settings,
    // An admitted row is not a held one, and the schema's CHECK says so. Applied after
    // the overrides so a fixture that supplies `admittedAt` cannot silently produce a row
    // carrying both.
    ...(settings.admittedAt ? { heldReason: null } : {}),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   5. Triage and saturation — pure, and therefore testable at the boundaries
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§17.4's triage order — custody, then obstruction, then breach proximity, then queue age", () => {
  const base = { legId: "L", custodyState: "NONE", obstructionClass: null, slaDeadline: null, queueAgeSeconds: 0 };

  test("custody HELD always outranks custody NONE, whatever the other three keys say", () => {
    const held = { ...base, legId: "held", custodyState: "HELD", queueAgeSeconds: 1 };
    const none = { ...base, legId: "none", custodyState: "NONE", obstructionClass: "BLOCKING_CRITICAL", queueAgeSeconds: 99999 };
    expect(operatorCapacity.triage([none, held]).map((row) => row.legId)).toEqual(["held", "none"]);
  });

  test("an unrecognised custody state sorts as held, not as none", () => {
    // `custody.custodyOf` throws on an unknown state by design (§2.7 — a negative signal
    // must never become a permissive default). In a triage order that refusal is expressed
    // as "most urgent", because goods in a hold are what an unattended escalation risks.
    expect(operatorCapacity.holdsGoods("NOT_A_STATE")).toBe(true);
    expect(operatorCapacity.holdsGoods(undefined)).toBe(true);
    expect(operatorCapacity.holdsGoods("NONE")).toBe(false);
    expect(operatorCapacity.holdsGoods("HELD")).toBe(true);
  });

  test("obstruction rank is read off §4.3's own disposition table, not a second one", () => {
    // Escalating classes first; `INDETERMINATE` ranks with `BLOCKING_CRITICAL`, which is
    // §7.3's DENY-on-indeterminate applied consistently.
    expect(operatorCapacity.obstructionRank("BLOCKING_CRITICAL")).toBe(0);
    expect(operatorCapacity.obstructionRank("INDETERMINATE")).toBe(0);
    expect(operatorCapacity.obstructionRank("RESTRICTIVE")).toBe(1);
    expect(operatorCapacity.obstructionRank("CLEAR")).toBe(2);
    expect(operatorCapacity.obstructionRank(null)).toBe(3);
    // A class §4.3 does not define is ranked most urgent, for the same reason.
    expect(operatorCapacity.obstructionRank("SOMETHING_NEW")).toBe(0);
  });

  test("the third key is SLA breach proximity, and an unknown deadline sorts last", () => {
    // `Leg.slaDeadline` is produced by `task.service.superviseQueuedEntry`, in the
    // transaction that creates the Leg, so this key is live. The null case is still
    // asserted: a Leg admitted before that producer existed, or a deployment whose
    // `sla.assignment_deadline` does not resolve, still reaches the comparator.
    const soon = { ...base, legId: "soon", slaDeadline: new Date("2026-07-29T12:05:00Z") };
    const later = { ...base, legId: "later", slaDeadline: new Date("2026-07-29T13:00:00Z") };
    const unknown = { ...base, legId: "unknown", slaDeadline: null };
    expect(operatorCapacity.triage([unknown, later, soon]).map((row) => row.legId)).toEqual([
      "soon",
      "later",
      "unknown",
    ]);
  });

  test("the fourth key is queue age, oldest first", () => {
    const old = { ...base, legId: "old", queueAgeSeconds: 900 };
    const fresh = { ...base, legId: "fresh", queueAgeSeconds: 10 };
    expect(operatorCapacity.triage([fresh, old]).map((row) => row.legId)).toEqual(["old", "fresh"]);
  });

  test("the order is total and stable — two Legs equal on all four keys sort deterministically", () => {
    // §9.6 requires a decision to be replayable. An order that depended on the store's row
    // order would not be, and a dispatcher's queue that reshuffled between two reads is
    // the operational symptom.
    const a = { ...base, legId: "leg-a" };
    const b = { ...base, legId: "leg-b" };
    expect(operatorCapacity.triage([b, a]).map((row) => row.legId)).toEqual(["leg-a", "leg-b"]);
    expect(operatorCapacity.triage([a, b]).map((row) => row.legId)).toEqual(["leg-a", "leg-b"]);
  });

  test("an empty queue triages to an empty queue, and a non-array to one too", () => {
    expect(operatorCapacity.triage([])).toEqual([]);
    expect(operatorCapacity.triage(undefined)).toEqual([]);
  });
});

describe("§17.4's sustained saturation — a question about an interval, not a point", () => {
  const now = STORE_NOW;
  const at = (secondsAgo) => new Date(now.getTime() - secondsAgo * 1000);
  const assess = (intervals, overrides) =>
    operatorCapacity.assessSaturation({ intervals, capacity: 1, saturationPeriodSeconds: 600, now, ...(overrides || {}) });

  test("two escalations open for the whole window, against a capacity of one, is saturation", () => {
    const verdict = assess([
      { admittedAt: at(1200), resolvedAt: null },
      { admittedAt: at(900), resolvedAt: null },
    ]);
    expect(verdict.saturated).toBe(true);
    expect(verdict.minimumOutstanding).toBe(2);
  });

  test("a single dip below capacity is not sustained saturation", () => {
    // "Continuously", not "on average" and not "at the end". §17.4's response is to shed
    // customer work at intake, which is too expensive to trigger on a transient — and this
    // is the case an average or an end-of-window sample would both get wrong.
    const verdict = assess([
      { admittedAt: at(1200), resolvedAt: null },
      { admittedAt: at(900), resolvedAt: at(400) },
      { admittedAt: at(390), resolvedAt: null },
    ]);
    expect(verdict.saturated).toBe(false);
    expect(verdict.minimumOutstanding).toBe(1);
  });

  test("an escalation that closed before the window began does not count toward it", () => {
    const verdict = assess([
      { admittedAt: at(5000), resolvedAt: at(4000) },
      { admittedAt: at(1200), resolvedAt: null },
    ]);
    expect(verdict.saturated).toBe(false);
  });

  test("at exactly capacity the region is busy, not saturated — the test is strictly over", () => {
    expect(assess([{ admittedAt: at(1200), resolvedAt: null }]).saturated).toBe(false);
  });

  test.each([
    ["capacity is unconfigured", { capacity: undefined }, "CAPACITY_UNCONFIGURED"],
    ["capacity is negative", { capacity: -1 }, "CAPACITY_UNCONFIGURED"],
    ["capacity is NaN", { capacity: Number.NaN }, "CAPACITY_UNCONFIGURED"],
    ["the period is unconfigured", { saturationPeriodSeconds: undefined }, "SATURATION_PERIOD_UNCONFIGURED"],
    ["the period is zero", { saturationPeriodSeconds: 0 }, "SATURATION_PERIOD_UNCONFIGURED"],
    ["there is no store clock", { now: null }, "NO_STORE_TIME"],
  ])("%s → not saturated, with the reason named", (_label, overrides, reason) => {
    const verdict = assess([{ admittedAt: at(1200), resolvedAt: null }], overrides);
    expect(verdict.saturated).toBe(false);
    expect(verdict.reason).toBe(reason);
  });

  test("a capacity of zero saturates on a single outstanding escalation", () => {
    expect(assess([{ admittedAt: at(1200), resolvedAt: null }], { capacity: 0 }).saturated).toBe(true);
  });

  test("an empty or malformed interval set is read as zero outstanding, never as saturation", () => {
    expect(assess([]).saturated).toBe(false);
    expect(assess(undefined).saturated).toBe(false);
    // An inverted interval is unwritable at the database
    // (`LadderEscalation_resolution_follows_admission`); the application-side half drops it
    // rather than letting it subtract from a count.
    expect(assess([{ admittedAt: at(100), resolvedAt: at(900) }]).minimumOutstanding).toBe(0);
    expect(assess([{ admittedAt: null, resolvedAt: null }]).minimumOutstanding).toBe(0);
  });

  test("saturation raises §17.4's distinct high-severity alert with the intake directive", async () => {
    const store = storeQueuedFor(BUDGET_SECONDS * 0.92, {
      escalations: [
        holding("leg-other-a", 7, { admittedAt: new Date(STORE_NOW.getTime() - 900_000) }),
        holding("leg-other-b", 7, { admittedAt: new Date(STORE_NOW.getTime() - 900_000) }),
      ],
      holderLegs: [
        // Both holders' Legs are still queued, so neither escalation resolves and the
        // region has been over capacity for the whole window.
        legRow({ id: "leg-other-a", legId: "leg-other-a" }),
        legRow({ id: "leg-other-b", legId: "leg-other-b" }),
      ],
    });

    const { ladder: built, events } = ladderFor(store, { escalationCapacity: 1 });
    await step(store, built);

    const alert = events.find((entry) => entry.event === "ladder.escalation_saturation");
    expect(alert).toBeDefined();
    expect(alert.detail.severity).toBe("HIGH");
    expect(alert.detail.regionId).toBe(REGION);
    // §17.4's second consequence, emitted as a directive: "admission control begins
    // declining new work of the affected classes at intake (§20.5)".
    expect(alert.detail.admissionDirective).toBe("DECLINE_AFFECTED_CLASSES_AT_INTAKE");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. §17.5 — agent starvation
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§17.5 — an agent with zero completed missions while nominally available", () => {
  const WINDOW = 24 * 3600;
  const agent = (id, lifecycleState) => ({ id, agentId: id.toUpperCase(), lifecycleState, regionId: REGION });

  test("the four cases, and exactly one of them is an alert", () => {
    const detection = agentStarvation.detect({
      agents: [
        agent("idle-available", "ACTIVE"),
        agent("busy-available", "ACTIVE"),
        agent("idle-quarantined", "QUARANTINED"),
        agent("busy-maintenance", "MAINTENANCE"),
      ],
      completionsByAgent: new Map([
        ["busy-available", 4],
        ["busy-maintenance", 1],
      ]),
      windowSeconds: WINDOW,
      storeTime: STORE_NOW,
    });

    expect(detection.ok).toBe(true);
    // "While nominally available" is the load-bearing clause: without it this is a report
    // of the fleet's idle agents, which on a quiet night is the whole fleet.
    expect(detection.findings.map((finding) => finding.agentRowId)).toEqual(["idle-available"]);
    expect(detection.considered).toBe(2);
    expect(detection.findings[0].diagnose.section).toBe("§7.7");
  });

  test("the rejection histogram is named as the route, with the limit that makes it a route and not an answer", () => {
    // §17.5 says the cause "is diagnosable directly from the rejection histogram (§7.7),
    // which will show one predicate rejecting this agent repeatedly". `RejectionAggregate`
    // has no agent dimension, so the per-agent form of that query does not exist. Naming
    // the gap on the finding is what stops it being rediscovered at 3 a.m.
    expect(agentStarvation.DIAGNOSTIC_ROUTE.limitation).toMatch(/no agent dimension/);
  });

  test("a duplicated agent row produces one finding, not two", () => {
    const detection = agentStarvation.detect({
      agents: [agent("dup", "ACTIVE"), agent("dup", "ACTIVE")],
      completionsByAgent: new Map(),
      windowSeconds: WINDOW,
      storeTime: STORE_NOW,
    });
    expect(detection.findings).toHaveLength(1);
    expect(detection.considered).toBe(1);
  });

  test("findings are ordered deterministically, whatever order the fleet arrived in", () => {
    const forward = agentStarvation.detect({
      agents: [agent("b", "ACTIVE"), agent("a", "ACTIVE"), agent("c", "ACTIVE")],
      completionsByAgent: new Map(),
      windowSeconds: WINDOW,
      storeTime: STORE_NOW,
    });
    const backward = agentStarvation.detect({
      agents: [agent("c", "ACTIVE"), agent("b", "ACTIVE"), agent("a", "ACTIVE")],
      completionsByAgent: new Map(),
      windowSeconds: WINDOW,
      storeTime: STORE_NOW,
    });
    expect(forward.findings.map((f) => f.agentRowId)).toEqual(["a", "b", "c"]);
    expect(backward.findings.map((f) => f.agentRowId)).toEqual(["a", "b", "c"]);
  });

  test.each([
    ["the period is unresolved", undefined],
    ["the period is zero", 0],
    ["the period is negative", -1],
    ["the period is NaN", Number.NaN],
  ])("%s → the pass reports it and alerts on nobody", (_label, windowSeconds) => {
    // A zero window reports every agent in the fleet as starving — a guaranteed page
    // produced by a missing parameter rather than by the fleet, which is the failure
    // `checkI13` documents for its own budget.
    const detection = agentStarvation.detect({
      agents: [agent("idle", "ACTIVE")],
      completionsByAgent: new Map(),
      windowSeconds,
      storeTime: STORE_NOW,
    });
    expect(detection.ok).toBe(false);
    expect(detection.findings).toEqual([]);
    expect(detection.reason).toMatch(/fairness\.idle_alert_period|no store time/);
  });

  test("a completion count that is not a count fails the pass rather than mis-alerting", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const detection = agentStarvation.detect({
        agents: [agent("idle", "ACTIVE")],
        completionsByAgent: new Map([["idle", bad]]),
        windowSeconds: WINDOW,
        storeTime: STORE_NOW,
      });
      expect({ bad, ok: detection.ok }).toEqual({ bad, ok: false });
    }
  });

  test("an empty fleet is not a starving fleet", () => {
    const detection = agentStarvation.detect({
      agents: [],
      completionsByAgent: new Map(),
      windowSeconds: WINDOW,
      storeTime: STORE_NOW,
    });
    expect(detection).toMatchObject({ ok: true, findings: [], considered: 0 });
  });

  test("the register carries the period in hours and the module uses seconds", () => {
    expect(agentStarvation.windowSecondsFrom(24)).toBe(86400);
    expect(agentStarvation.windowSecondsFrom(0)).toBeNull();
    expect(agentStarvation.windowSecondsFrom(Number.NaN)).toBeNull();
  });

  test("exercise-mission candidates are produced, and each names why it cannot be injected", () => {
    // §17.5's second mechanism. The candidate list exists; the injection does not, and the
    // reason is structural rather than a matter of effort — a short reposition mission
    // needs §17.3's repositioning, which is Tier 2 and which §1.8 rule 2 forbids a Tier 1
    // mechanism from depending on.
    const detection = agentStarvation.detect({
      agents: [agent("idle", "ACTIVE")],
      completionsByAgent: new Map(),
      windowSeconds: WINDOW,
      storeTime: STORE_NOW,
    });
    const candidates = agentStarvation.exerciseCandidates(detection);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].purpose).toBe("EXERCISE");
    // §2.4 makes EXERCISE speculative, and §20.5 sheds speculative work first.
    expect(candidates[0].speculative).toBe(true);
    expect(candidates[0].blockedBy).toMatch(/Tier 2/);
  });

  test("a failed detection produces no exercise candidates", () => {
    expect(agentStarvation.exerciseCandidates({ ok: false, findings: [] })).toEqual([]);
    expect(agentStarvation.exerciseCandidates(undefined)).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   7. Composition — the ladder is reachable from the production timer path
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the ladder is reachable through §4.5's real handler map", () => {
  test("ESCALATION_LADDER is the §4.3 expiry action of QUEUED, derived from the machine", () => {
    // Not asserted as a string: the handler the timer worker selects comes from
    // `legMachine.LEG_DEADLINES`, so this is the same lookup production makes.
    expect(legMachine.deadlineFor(legMachine.LEG_STATE.QUEUED)).toEqual({
      parameter: "sla.assignment_deadline",
      onExpiry: "ESCALATION_LADDER",
    });
  });

  test("a real ladder injected into the real handler map advances a real Leg", async () => {
    // End to end through the production shapes: `expiryActions.handlers` builds the map
    // the timer worker's dependency contract asks for, the `QUEUED` deadline's handler is
    // selected from it, and the ladder recorded here is the one the composition root
    // builds. Nothing in this test is a stand-in for the ladder itself.
    const store = storeQueuedFor(BUDGET_SECONDS * 0.6);
    const { ladder: built } = ladderFor(store);
    const map = expiryActions.handlers({ ladder: built });
    const leg = await store.client.leg.findUnique({ where: { id: LEG_ROW_ID } });

    const result = await store.client.$transaction((tx) =>
      map.ESCALATION_LADDER({
        tx,
        prisma: store.client,
        timer: { entityType: "LEG", entityId: LEG_ROW_ID, state: "QUEUED", shardId: "shard-1", handler: "ESCALATION_LADDER" },
        entity: leg,
        storeTime: store.now(),
        config: { deadlineSecondsFor: () => BUDGET_SECONDS },
        record: () => {},
      }),
    );

    expect(result.disposition).toBe(expiryActions.DISPOSITION.TRANSITIONED);
    expect(result.outcome).toBe("QUEUED→QUEUED");
    expect(result.ladderStep).toBe(3);
    expect(store.rows("ladderEscalation").map((row) => row.step).sort()).toEqual([1, 2, 3]);
    const after = await store.client.leg.findUnique({ where: { id: LEG_ROW_ID } });
    expect(after.state).toBe(legMachine.LEG_STATE.QUEUED);
  });

  test("the composition root injects a ladder, so the handler never sees the refusal path", () => {
    // The seam itself. `leaderWorkers.timer` used to pass `handlers({})` and record that
    // the ladder "is mechanism T1-04, owned by a remedial phase; src/engine/fairness/ is
    // empty". Reading the composer's source is how this stays honest without starting a
    // worker: the assertion is that the injection exists at the one place that builds the
    // production handler map.
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "src", "workers", "leaderWorkers.js"),
      "utf8",
    );
    expect(source).toMatch(/expiryActions\.handlers\(\{\s*ladder:/);
    expect(source).toMatch(/ladder\.create\(/);
    // And it is not `handlers({})` anywhere any more — the empty map was the refusal.
    expect(source).not.toMatch(/expiryActions\.handlers\(\{\}\)/);
  });
});

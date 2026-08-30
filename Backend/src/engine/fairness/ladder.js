"use strict";

/**
 * §17.4's task anti-starvation escalation ladder — **where the anti-starvation guarantee
 * lives**. Mechanism T1-04, Tier 1 (§1.8), invariant I13.
 *
 * REMEDIAL PHASE T1-04. `src/engine/fairness/` was an empty directory holding a
 * `.gitkeep`. `guards/tierAssertions.js` named this file, `TIERS.md` named it,
 * `lifecycle/transitions.js` carried both of §4.4's ladder rows and their
 * `LADDER_STEP_AVAILABLE` guard, and `supervision/expiryActions.js` had a handler that
 * did nothing but refuse by name because the collaborator did not exist. Everything
 * around the ladder had been built. The ladder had not.
 *
 * That absence was not cosmetic. §1.8 is explicit about what it cost:
 *
 * > anti-starvation is guaranteed by the ladder (Tier 1) and not by the aging price
 * > (Tier 2), which is why the aging multiplier could be safely capped (§8.7, §17.4).
 *
 * Phase 8 capped `cost.aging.max_multiplier` **because** the guarantee was said to live
 * here. The cap shipped; the guarantee did not. Until this module existed the engine had
 * neither mechanism: not the unbounded price it had deliberately given up, and not the
 * ladder it gave it up for.
 *
 * ── What makes this a guarantee rather than a hopeful sequence ──────────────
 * §17.4 names two properties, and both are structural here rather than asserted:
 *
 *   1. **It is finite and terminates in a decision.** `STEPS` has exactly eight rungs,
 *      the step reached is a pure, monotone function of elapsed queue age over the
 *      budget, and rung 8 is terminal. A Leg cannot wait forever because there is no
 *      arithmetic that stops the clock.
 *   2. **The relaxation order is published configuration.** All eight trigger fractions
 *      are register entries (`ladder.step_N_*_fraction`, §22.2 classes the relaxation
 *      ladder order as Policy), validated as a strictly increasing sequence before any
 *      step is taken. A ladder whose order cannot be read in advance is a system that
 *      improvises under load.
 *
 * ── Why the ladder *widens* and never *prices* ──────────────────────────────
 * > An unbounded price cannot in any case rescue a Leg that is infeasible for every
 * > agent, which is the case that actually starves.
 *
 * So every rung 1–6 emits a **relaxation directive** — a published token the round
 * consumes — and rungs 7–8 hand the Leg to a person. No rung computes a cost.
 *
 * ── Why no rung *calls* the mechanism it names (§1.8 rule 2) ────────────────
 * Rung 4 names preemption (§4.8), rung 5 cross-region (§19.6), rung 6 repositioning
 * (§17.3). All three are **Tier 2**, and `MODULE_TIERS` places
 * `lifecycle/preemption.js`, `shard/crossRegion.js` and `fairness/repositioning.js`
 * there. §1.8 rule 2 — "No Tier 0 or Tier 1 guarantee may depend on a Tier 2 mechanism"
 * — therefore forbids this module from importing any of them, and
 * `tools/gates/checkTierDependencies.js` enforces it on every build.
 *
 * That is not an inconvenience the rule imposes; it is the rule producing the right
 * design. The ladder's guarantee must hold with every Tier 2 mechanism switched off,
 * which §1.8 rule 3 says is exactly how the engine launches. So a rung records that a
 * relaxation is now permitted, and a round that has the mechanism enabled takes it up. A
 * shard with preemption disabled still advances through rung 4 to rungs 7 and 8, where
 * the guarantee is discharged by people rather than by a Tier 2 solver. `expiryActions`
 * already established this shape for `FORCE_WIDEN_AND_ESCALATE`, which records a
 * `widen` directive rather than performing one.
 *
 * ── Where the elapsed fraction comes from ───────────────────────────────────
 * §17.4 triggers each rung on "an elapsed fraction of the SLA budget", and §26.1's I13
 * instrument is "queue age audit versus ladder step". Both halves already exist in the
 * repository and this module reads the same two:
 *
 *   · **queue age** — `WorkQueue.enqueuedAt`, which is what
 *     `observability/invariantChecker.js:checkI13` and `metrics.js:queue_oldest_age`
 *     already measure it from. It survives a Leg leaving and re-entering `QUEUED` (a
 *     NACK, a failed hardening), which `Leg.createdAt` would too but `Leg.updatedAt`
 *     would not — and a queue age that resets on every requeue is a starvation clock
 *     that starvation resets.
 *   · **the budget** — `sla.assignment_deadline`. `checkI13` calls it "the ladder's
 *     total budget" in those words, and §4.3 makes it the exit deadline of `QUEUED`.
 *
 * Neither is re-derived here and neither is defaulted. A ladder that invents a budget
 * would advance a real Leg on a made-up clock.
 *
 * ── Fail-closed, in the direction that matters ──────────────────────────────
 * The two §4.4 rows this feeds are not symmetric. `ladder step available → QUEUED` costs
 * a re-queue; `ladder exhausted → FAILED` terminates a customer's Leg. So every
 * undetermined input — an absent queue row, an unresolvable budget, a malformed or
 * non-monotone published order, a NaN — returns `UNDETERMINED`, never `EXHAUSTED`.
 * `expiryActions` re-arms the deadline on that verdict. §4.1 rule 3: "State is never
 * inferred from the absence of data."
 *
 * The sharpest case is rung 7. §17.4:
 *
 * > A Leg that "reached step 7" without a human ever seeing it has not been escalated,
 * > and recording otherwise would make the ladder's guarantee false in exactly the
 * > conditions it exists for.
 *
 * So a Leg whose human escalation is **held** for capacity returns `HELD` — it stays on
 * the ladder and stays `QUEUED` — and the ladder refuses to reach `EXHAUSTED` until the
 * `LadderEscalation` row for rung 8 carries an `admittedAt`. The ladder cannot decline
 * work that no person was ever shown.
 */

const legMachine = require("../lifecycle/legMachine");
const operatorCapacity = require("./operatorCapacity");

/** @structural milliseconds per second — a unit conversion, not a threshold */
const MS_PER_SECOND = 1000;

/**
 * §1.8's obligation-tier ordinals, so a rung can record the tier of the mechanism it
 * names. Rungs 4, 5 and 6 name Tier 2 mechanisms, which is exactly why this table carries
 * a token instead of a call: §1.8 rule 2 forbids a Tier 1 guarantee from depending on one.
 * Mirrors `guards/tierAssertions.js` rather than importing it — that module is build-time
 * apparatus and `isBuildTimeModule` excludes it from the runtime tree.
 * @structural §1.8's tier ordinals — the specification's own labels, not tunable values
 */
const TIER = Object.freeze({ OPERATIONAL_INTEGRITY: 1, ALLOCATION_QUALITY: 2 });

/**
 * §17.4's rung 3, named because it is the one rung whose relaxation tokens come from the
 * published class-P sequence rather than from its own row.
 * @structural §17.4's rung ordinal for the class-P relaxation
 */
const CLASS_P_RUNG = 3;

/**
 * The verdicts `nextStep` can return. Four, not two, and the two extra ones are the
 * point: §4.4 offers `available` and `exhausted`, and collapsing everything else into
 * either of them is how a missing input becomes a failed Leg.
 * @structural the enumerated ladder verdicts
 */
const VERDICT = Object.freeze({
  /** A rung is available. §4.4's `assignment deadline → QUEUED` row applies. */
  STEP_AVAILABLE: "STEP_AVAILABLE",
  /** Rung 7 or 8 reached, no human capacity. Still on the ladder; still `QUEUED`. */
  HELD_FOR_HUMAN_CAPACITY: "HELD_FOR_HUMAN_CAPACITY",
  /** Rung 8 taken, a human saw it, no alternative modality. §4.4's `→ FAILED` row. */
  EXHAUSTED: "EXHAUSTED",
  /** An input the ladder needs is absent or malformed. Re-arm; never fail the Leg. */
  UNDETERMINED: "UNDETERMINED",
});

/**
 * §17.4's eight rungs, verbatim from its table, with the register entry that carries
 * each trigger fraction and the relaxation tokens each publishes.
 *
 * `relaxations` are the tokens the **round** consumes. They are named here once, in the
 * ladder's own vocabulary, because `expiryActions.forceWidenAndEscalate` already emits
 * two of them (`SEARCH_RADIUS`, `ADMIT_FINISHING_SOON_AND_CHARGING_INTERRUPTIBLE`) as a
 * directive "named in the ladder's own vocabulary so the module that arrives consumes
 * them rather than reinterpreting them". This is that module, and these are those names.
 *
 * `mechanism` records which section actually performs the widening, and `tier` records
 * that section's obligation tier. Rungs 4, 5 and 6 are Tier 2, which is why this table
 * holds a token and not a function: see the header on §1.8 rule 2.
 *
 * The rung *number* is the position in this array, not a field. §17.4 numbers its rungs
 * by their order and nothing else, so a written-down ordinal is a second copy of the
 * array index — and the failure mode of a second copy is a table that reads 1, 2, 3, 3.
 *
 * @structural §17.4's ladder table — the rungs, their order, and their actions
 */
const STEPS = Object.freeze([
  {
    action: "WIDEN_SEARCH_RADIUS",
    parameter: "ladder.step_1_widen_radius_fraction",
    relaxations: Object.freeze(["SEARCH_RADIUS"]),
    mechanism: "§6.3 candidate radius",
    tier: TIER.OPERATIONAL_INTEGRITY,
    humanStep: false,
    terminal: false,
  },
  {
    action: "ADMIT_FINISHING_SOON_AND_CHARGING_INTERRUPTIBLE",
    parameter: "ladder.step_2_admit_wait_classes_fraction",
    relaxations: Object.freeze(["ADMIT_FINISHING_SOON", "ADMIT_CHARGING_INTERRUPTIBLE", "LONGER_WAIT_HORIZON"]),
    mechanism: "§6.2 availability classes",
    tier: TIER.OPERATIONAL_INTEGRITY,
    humanStep: false,
    terminal: false,
  },
  {
    action: "RELAX_CLASS_P_SOFT_CONSTRAINTS",
    // §17.4 names the first two of the sequence and then writes "and so on". The
    // remainder is deployment configuration, not a gap this module may fill: §22.2
    // classes "relaxation ladder order" as Policy, owned by Ops. `CLASS_P_RELAXATION_ORDER`
    // holds the mandated prefix and `relaxationOrderFrom` validates that any published
    // extension begins with it.
    parameter: "ladder.step_3_relax_class_p_fraction",
    relaxations: Object.freeze(["ZONE_AFFINITY", "DEDICATED_FLEET_PREFERENCE"]),
    mechanism: "§7.2 class P predicates and §8.6 policy credits",
    tier: TIER.OPERATIONAL_INTEGRITY,
    humanStep: false,
    terminal: false,
  },
  {
    action: "PERMIT_PREEMPTION",
    parameter: "ladder.step_4_permit_preemption_fraction",
    relaxations: Object.freeze(["PERMIT_PREEMPTION_OF_LOWER_CLASS"]),
    mechanism: "§4.8 preemption",
    tier: TIER.ALLOCATION_QUALITY,
    humanStep: false,
    terminal: false,
  },
  {
    action: "REQUEST_CROSS_REGION_CANDIDATES",
    parameter: "ladder.step_5_cross_region_fraction",
    relaxations: Object.freeze(["CROSS_REGION_CANDIDATES"]),
    mechanism: "§19.6 cross-region",
    tier: TIER.ALLOCATION_QUALITY,
    humanStep: false,
    terminal: false,
  },
  {
    action: "MANUFACTURE_SUPPLY",
    parameter: "ladder.step_6_manufacture_supply_fraction",
    relaxations: Object.freeze(["TARGETED_REPOSITION", "ACCELERATED_CHARGE"]),
    mechanism: "§17.3 repositioning, §14.6 charging",
    tier: TIER.ALLOCATION_QUALITY,
    humanStep: false,
    terminal: false,
  },
  {
    action: "ESCALATE_TO_HUMAN_DISPATCHER",
    parameter: "ladder.step_7_human_dispatcher_fraction",
    relaxations: Object.freeze(["HUMAN_DISPATCHER_REVIEW"]),
    mechanism: "§17.4 human escalation, with §7.7's rejection analysis",
    tier: TIER.OPERATIONAL_INTEGRITY,
    humanStep: true,
    terminal: false,
  },
  {
    action: "ALTERNATIVE_MODALITY_OR_DECLINE",
    parameter: "ladder.step_8_alternative_modality_fraction",
    relaxations: Object.freeze(["ALTERNATIVE_MODALITY", "DECLINE_WITH_STATED_REASON"]),
    mechanism: "§17.4 terminal decision",
    tier: TIER.OPERATIONAL_INTEGRITY,
    humanStep: true,
    terminal: true,
  },
].map((rung, index) => Object.freeze({ step: index + 1, ...rung })));

/** The rungs, by number, so a lookup is not a linear scan written out four times. */
const STEP_BY_NUMBER = Object.freeze(new Map(STEPS.map((row) => [row.step, row])));

/**
 * The prefix §17.4 mandates for rung 3's relaxation order:
 *
 * > Relax **class P** soft constraints in a defined, ordered, published sequence — zone
 * > affinity first, dedicated-fleet preference next, and so on.
 *
 * "And so on" is a deployment's to publish, not this module's to invent. What is *not*
 * negotiable is the same sentence's other half — "Class I, R, and F are never relaxed" —
 * which `relaxationOrderFrom` enforces against any published extension.
 * @structural §17.4's mandated ordering of the class-P relaxation sequence
 */
const CLASS_P_RELAXATION_ORDER = Object.freeze(["ZONE_AFFINITY", "DEDICATED_FLEET_PREFERENCE"]);

/**
 * The constraint classes §17.4 forbids rung 3 from ever relaxing.
 * @structural §17.4 — "Class I, R, and F are never relaxed"
 */
const NEVER_RELAXED_CLASSES = Object.freeze(["I", "R", "F"]);

/** How an escalation stopped being outstanding. Mirrors the `outcome` CHECK. */
const RESOLUTION = Object.freeze({
  ASSIGNED: "ASSIGNED",
  TERMINAL: "TERMINAL",
  DECLINED: "DECLINED",
});

/**
 * The Leg states that mean "still waiting for an assignment", and therefore still on the
 * ladder. Derived from the machine rather than listed, so a state added to §4.3 does not
 * leave a second copy of §4.3's queue behind.
 *
 * `DEFERRED` counts: §8.8's deferral "can never become indefinite silence (§17.4)", so a
 * deferred Leg is a waiting Leg as far as the ladder's clock is concerned.
 */
const WAITING_STATES = Object.freeze([legMachine.LEG_STATE.QUEUED, legMachine.LEG_STATE.DEFERRED]);

/**
 * Resolve the eight trigger fractions from the published register, and refuse the whole
 * table if it is not a ladder.
 *
 * Three refusals, and each is a way a published order stops being one:
 *
 *   - **a missing fraction** — a rung with no trigger cannot fire, so the ladder is
 *     shorter than eight and nobody said so;
 *   - **a fraction outside [0, 1]** — it is a *fraction of the budget*, and a rung at
 *     1.4 fires after the deadline it exists to beat;
 *   - **a non-increasing sequence** — rung 5 firing before rung 3 is not the published
 *     order, and §17.4's whole claim is that "operations knows in advance exactly what
 *     the system will sacrifice under pressure **and in what order**".
 *
 * Returning `{ ok: false }` rather than throwing is deliberate: the caller's next act is
 * to re-arm a deadline, and a mis-published ladder must not take a Leg down with it.
 *
 * @param {Map<string, *>|object} values the published configuration's `values` map
 * @returns {{ ok: true, table: Array<object> }|{ ok: false, problem: string }}
 */
function stepTableFrom(values) {
  const read = (name) => {
    if (values && typeof values.get === "function") return values.get(name);
    if (values && typeof values === "object") return values[name];
    return undefined;
  };

  const table = [];
  for (const row of STEPS) {
    const fraction = read(row.parameter);
    if (!Number.isFinite(fraction)) {
      return {
        ok: false,
        problem:
          `${row.parameter} did not resolve to a finite number, so §17.4 rung ${row.step} ` +
          `(${row.action}) has no trigger. A rung that cannot fire shortens the ladder without saying so.`,
      };
    }
    if (fraction < 0 || fraction > 1) {
      return {
        ok: false,
        problem:
          `${row.parameter} is ${fraction}, which is not a fraction of the budget. §17.4 triggers every rung on ` +
          "an elapsed fraction of the SLA budget, and a value outside [0, 1] is a rung that fires before the " +
          "clock starts or after the deadline it exists to beat.",
      };
    }
    table.push(Object.freeze({ ...row, fraction }));
  }

  for (let index = 1; index < table.length; index += 1) {
    if (!(table[index].fraction > table[index - 1].fraction)) {
      return {
        ok: false,
        problem:
          `the published ladder is not increasing: rung ${table[index - 1].step} triggers at ` +
          `${table[index - 1].fraction} and rung ${table[index].step} at ${table[index].fraction}. §17.4's ` +
          "guarantee is that operations knows in advance what the system sacrifices under pressure and in what " +
          "order; an order that is not an order is not published configuration.",
      };
    }
  }

  return { ok: true, table: Object.freeze(table) };
}

/**
 * Rung 3's published class-P relaxation sequence, validated against the two rules §17.4
 * states about it.
 *
 * @param {Array<string>|undefined} published the deployment's sequence, if it has one
 * @returns {{ ok: true, order: Array<string> }|{ ok: false, problem: string }}
 */
function relaxationOrderFrom(published) {
  if (published === undefined || published === null) {
    return { ok: true, order: CLASS_P_RELAXATION_ORDER.slice() };
  }
  if (!Array.isArray(published) || published.some((token) => typeof token !== "string" || token === "")) {
    return { ok: false, problem: "the published class-P relaxation sequence is not a list of tokens" };
  }
  for (let index = 0; index < CLASS_P_RELAXATION_ORDER.length; index += 1) {
    if (published[index] !== CLASS_P_RELAXATION_ORDER[index]) {
      return {
        ok: false,
        problem:
          `§17.4 fixes the head of the class-P sequence — "zone affinity first, dedicated-fleet preference next" ` +
          `— so position ${index} must be ${CLASS_P_RELAXATION_ORDER[index]} and the published sequence has ` +
          `${published[index] === undefined ? "nothing" : `"${published[index]}"`}.`,
      };
    }
  }
  // "Class I, R, and F are never relaxed." A published sequence naming one of them is a
  // deployment about to relax a predicate the specification places outside the ladder.
  for (const token of published) {
    const marked = /^CLASS_([IRF])[:_]/.exec(String(token).toUpperCase());
    if (marked && NEVER_RELAXED_CLASSES.includes(marked[1])) {
      return {
        ok: false,
        problem:
          `the published class-P sequence names "${token}", which is a class ${marked[1]} constraint. §17.4: ` +
          `"Class I, R, and F are never relaxed."`,
      };
    }
  }
  return { ok: true, order: published.slice() };
}

/**
 * The rung an elapsed fraction has reached, or `null` below rung 1.
 *
 * Pure, total, and monotone in `fraction` — which is what makes the ladder's advance
 * independent of cost dynamics, and therefore what makes it a guarantee. `>=` rather than
 * `>` because §17.4's table reads "25 % of budget", not "past 25 %".
 *
 * @param {number} fraction elapsed queue age over the ladder's total budget
 * @param {Array<object>} table from `stepTableFrom`
 * @returns {object|null}
 */
function stepAt(fraction, table) {
  if (!Number.isFinite(fraction) || fraction < 0) return null;
  let reached = null;
  for (const row of table) {
    if (fraction >= row.fraction) reached = row;
    else break;
  }
  return reached;
}

/**
 * Seconds from now until the next unreached rung fires, or `undefined` when the ladder
 * has no rung left ahead of it.
 *
 * This is what makes §17.4's schedule real rather than nominal. §4.3 arms `QUEUED` for
 * `sla.assignment_deadline` — the ladder's **whole** budget — so a timer left to that
 * value alone fires once, at 100 %, with all eight rungs behind it. Returning the next
 * boundary lets `expiryActions` re-arm the deadline at the rung rather than at the
 * budget, and §4.5's `rearmInSeconds` hook already exists for exactly this.
 *
 * @param {object|null} reached the rung `stepAt` returned
 * @param {Array<object>} table
 * @param {number} budgetSeconds
 * @param {number} queueAgeSeconds
 * @returns {number|undefined}
 */
function nextBoundarySeconds(reached, table, budgetSeconds, queueAgeSeconds) {
  if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0) return undefined;
  if (!Number.isFinite(queueAgeSeconds) || queueAgeSeconds < 0) return undefined;

  const nextRung = table.find((row) => (reached === null ? true : row.step > reached.step));
  if (!nextRung) return undefined;

  const seconds = nextRung.fraction * budgetSeconds - queueAgeSeconds;
  // A boundary already behind us re-arms at the smallest interval the store can express
  // rather than at zero or a negative: `timers.reschedule` needs a future instant, and a
  // rung whose moment has passed should be taken on the next pass, not never.
  return seconds > 0 ? seconds : 1;
}

/**
 * The interval a *newly enqueued* Leg's `QUEUED` deadline should be armed for: rung 1's
 * boundary.
 *
 * The one piece of §17.4's step timing that the ladder cannot supply from inside its own
 * handler, because the handler does not run until a deadline has already fired. §4.3 arms
 * `QUEUED` for `sla.assignment_deadline` — the ladder's *whole* budget — so a first
 * deadline left at that value fires once, at 100 %, with all eight rungs behind it. The
 * caller is `task.service.superviseQueuedEntry`, which arms the deadline in the
 * transaction that creates the Leg.
 *
 * Returns `undefined` rather than a default when the ladder is not published, so the
 * caller falls back to §4.3's register entry: a mis-published ladder must cost the
 * schedule, never the supervision.
 *
 * @param {Map<string, *>|object} values the published configuration's `values` map
 * @param {number} budgetSeconds `sla.assignment_deadline`
 * @returns {number|undefined}
 */
function firstBoundarySecondsFrom(values, budgetSeconds) {
  const published = stepTableFrom(values);
  if (!published.ok) return undefined;
  return nextBoundarySeconds(null, published.table, budgetSeconds, 0);
}

/**
 * The verdict, for a caller that is not going to read six fields correctly under
 * pressure. Every return from `nextStep` goes through here so `available` is decided in
 * one place rather than at each return site.
 *
 * `available` is deliberately tri-valued. `true` and `false` are §4.4's two rows;
 * `null` is "the ladder does not know", and `expiryActions` re-arms on it. The one
 * outcome this function will not produce is `available: false` from anything other than
 * a genuine, human-seen rung 8.
 *
 * @param {string} verdict one of `VERDICT`
 * @param {object} detail
 * @returns {object}
 */
function verdictOf(verdict, detail) {
  const available =
    verdict === VERDICT.STEP_AVAILABLE || verdict === VERDICT.HELD_FOR_HUMAN_CAPACITY
      ? true
      : verdict === VERDICT.EXHAUSTED
        ? false
        : null;
  return Object.freeze({
    verdict,
    available,
    exhausted: verdict === VERDICT.EXHAUSTED,
    held: verdict === VERDICT.HELD_FOR_HUMAN_CAPACITY,
    undetermined: verdict === VERDICT.UNDETERMINED,
    ...detail,
  });
}

/**
 * Read the work-queue row that carries this Leg's queue age.
 *
 * Absence is not zero. A Leg with no queue row has no `enqueuedAt`, so its elapsed
 * fraction has no origin, and the ladder returns `UNDETERMINED` rather than treating the
 * Leg as freshly queued (which would restart the starvation clock on every fire) or as
 * infinitely old (which would fail it).
 *
 * @param {object} client a transaction client or the base client
 * @param {string} legId the Leg's surrogate id
 * @returns {Promise<object|null>}
 */
async function readQueueRow(client, legId) {
  return client.workQueue.findUnique({
    where: { legId },
    select: {
      legId: true,
      shardId: true,
      slaClass: true,
      enqueuedAt: true,
      state: true,
      roundsConsidered: true,
    },
  });
}

/**
 * Record every rung between the last one already recorded and the one now reached.
 *
 * **Every** rung, not just the newest. §17.4 requires each to be "recorded with what was
 * relaxed and why", and a coarse timer can cross several boundaries between two fires —
 * most obviously on the very first fire, because §4.3 arms `QUEUED` for the whole budget.
 * Writing only the newest would leave the round without the relaxations of the rungs it
 * skipped, and would leave the I13 audit reading a ladder that jumped.
 *
 * Idempotent by construction: `LadderEscalation` is unique on `(legId, step)`, so a
 * re-fired timer — §4.5 fires at least once, by design — converges on the same rows
 * rather than recording a second arrival at the same rung.
 *
 * @param {object} tx the transaction client; the write must commit with the transition
 * @param {object} input
 * @returns {Promise<Array<object>>} the rows for the rungs recorded by this call
 */
async function recordStepsThrough(tx, input) {
  const { leg, queue, table, reached, budgetSeconds, queueAgeSeconds, storeTime, regionId, relaxationOrder } = input;

  const already = await tx.ladderEscalation.findMany({
    where: { legId: leg.id },
    select: { step: true },
  });
  const recorded = new Set(already.map((row) => row.step));

  const written = [];
  for (const rung of table) {
    if (rung.step > reached.step) break;
    if (recorded.has(rung.step)) continue;

    // Rung 3's tokens come from the published sequence; every other rung's are its own.
    const relaxations = rung.step === CLASS_P_RUNG ? relaxationOrder : rung.relaxations.slice();

    const row = await tx.ladderEscalation.create({
      data: {
        legId: leg.id,
        step: rung.step,
        action: rung.action,
        relaxations,
        cause: `ELAPSED_FRACTION_${rung.fraction}`,
        queueAgeSeconds: Math.floor(queueAgeSeconds),
        budgetSeconds: Math.floor(budgetSeconds),
        elapsedFraction: queueAgeSeconds / budgetSeconds,
        regionId: regionId ?? null,
        shardId: queue.shardId ?? null,
        slaClass: queue.slaClass ?? null,
        reachedAt: storeTime,
        humanStep: rung.humanStep,
        // A human rung arrives **held**. It is admitted only by `operatorCapacity`, and
        // only when there is capacity behind it — which is the difference §17.4 draws
        // between reaching rung 7 and being escalated.
        //
        // `admittedAt` is written explicitly rather than left off the `data`: an absent
        // column reads back as `undefined` rather than `null` from an in-transaction read,
        // and a nullish check on it decided whether a human had been given this Leg.
        admittedAt: null,
        heldReason: rung.humanStep ? operatorCapacity.HELD_REASON.NOT_YET_ASSESSED : null,
        resolvedAt: null,
        outcome: null,
      },
    });
    written.push(row);
  }

  return written;
}

/**
 * Build the ladder the composition root injects into `expiryActions.handlers`.
 *
 * @param {object} deps
 * @param {object} deps.prisma the store client, for reads outside the fire transaction
 * @param {Map<string, *>|object} deps.values the published configuration's `values` map
 * @param {number} deps.budgetSeconds `sla.assignment_deadline`, resolved by the composer
 * @param {string} [deps.regionId] this shard's operating region — `ops.escalation_capacity`
 *   is region-scoped, so an escalation with no region cannot be counted against a capacity
 * @param {number} [deps.escalationCapacity] `ops.escalation_capacity`
 * @param {number} [deps.saturationPeriodSeconds] `ops.escalation_saturation_period`
 * @param {Array<string>} [deps.classPRelaxationOrder] the published §17.4 rung-3 sequence
 * @param {object} [deps.alternativeModality] §17.4 rung 8's "where configured" fallback.
 *   Absent means not configured, which is the reading §17.4's own wording gives it.
 * @param {(event: string, detail: object) => void} [deps.record]
 * @returns {{ nextStep: Function, capacity: object }}
 */
function create(deps) {
  const settings = deps || {};
  const record = typeof settings.record === "function" ? settings.record : () => {};

  const capacity = operatorCapacity.create({
    regionId: settings.regionId,
    capacity: settings.escalationCapacity,
    saturationPeriodSeconds: settings.saturationPeriodSeconds,
    record,
  });

  const published = stepTableFrom(settings.values);
  const relaxation = relaxationOrderFrom(settings.classPRelaxationOrder);

  /**
   * The §4.4 guard's evidence: which rung this entity is on, whether another exists, and
   * what it relaxes.
   *
   * @param {object} input
   * @param {object} [input.tx] the fire transaction. Required to *record* a rung; without
   *   it the ladder reports what it would do and writes nothing, because a rung recorded
   *   outside the transition's transaction is a relaxation that survives a rolled-back
   *   transition (§4.1 rule 5).
   * @param {string} input.entityType LEG | TASK
   * @param {string} input.entityId
   * @param {object} [input.leg] the supervised Leg row, when the entity is a Leg
   * @param {Date} input.storeTime
   * @returns {Promise<object>} a `verdictOf` result
   */
  async function nextStep(input) {
    const source = input || {};
    const client = source.tx || settings.prisma;

    if (!client || !client.workQueue || !client.ladderEscalation) {
      return verdictOf(VERDICT.UNDETERMINED, {
        reason: "NO_STORE_CLIENT",
        detail: "the ladder reads queue age from `WorkQueue` and records rungs on `LadderEscalation`; no client was supplied",
      });
    }

    if (!published.ok) {
      return verdictOf(VERDICT.UNDETERMINED, { reason: "LADDER_NOT_PUBLISHED", detail: published.problem });
    }
    if (!relaxation.ok) {
      return verdictOf(VERDICT.UNDETERMINED, { reason: "RELAXATION_ORDER_INVALID", detail: relaxation.problem });
    }

    const budgetSeconds = settings.budgetSeconds;
    if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0) {
      return verdictOf(VERDICT.UNDETERMINED, {
        reason: "BUDGET_UNRESOLVED",
        detail:
          "sla.assignment_deadline did not resolve, and it is the ladder's total budget (§26.1's I13 instrument " +
          "names it in those words). Every rung triggers on a fraction of it, so without it there is no fraction " +
          "— and treating it as zero would put every queued Leg at rung 8 the instant it was enqueued.",
      });
    }

    if (!(source.storeTime instanceof Date) || Number.isNaN(source.storeTime.getTime())) {
      return verdictOf(VERDICT.UNDETERMINED, {
        reason: "NO_STORE_TIME",
        detail: "elapsed queue age is measured against the store's clock (§10.6), and none was supplied",
      });
    }

    // §4.2 has no transition table anywhere in the specification, which is blocker X3.
    // A Task therefore has no state for a rung to move it to — but its rung is still
    // real, because §4.2 gives `WAITING` and `AT_RISK` the ladder as their expiry action.
    // The Task's Legs are what actually carry the ladder, so this reports the rung its
    // queue age has reached and records nothing against a Task row that has no ladder
    // column. `expiryActions` treats the result as `ACTED_WITHOUT_TRANSITION`.
    if (source.entityType === "TASK") {
      return verdictOf(VERDICT.UNDETERMINED, {
        reason: "TASK_SCOPE_HAS_NO_LADDER_ROW",
        detail:
          "§17.4's ladder advances a Leg. A Task is waiting exactly while one of its Legs is queued " +
          "(`sla.assignment_deadline` carries both deadlines for that reason), so the rung is recorded against " +
          "the Leg. §4.2 has no transition table (blocker X3), so there is no Task-scope rung to take.",
      });
    }

    const leg = source.leg;
    if (!leg || typeof leg.id !== "string" || leg.id === "") {
      return verdictOf(VERDICT.UNDETERMINED, {
        reason: "NO_LEG",
        detail: "the ladder was asked for a Leg's rung and given no Leg row",
      });
    }

    const queue = await readQueueRow(client, leg.id);
    if (!queue || !(queue.enqueuedAt instanceof Date) || Number.isNaN(queue.enqueuedAt.getTime())) {
      return verdictOf(VERDICT.UNDETERMINED, {
        reason: "NO_QUEUE_ROW",
        detail:
          "queue age has no origin: this Leg has no `WorkQueue` row, so `enqueuedAt` — the instant §26.1's I13 " +
          "instrument and this ladder both measure from — does not exist. Treating the absence as age zero " +
          "would restart the starvation clock on every fire; treating it as unbounded would fail the Leg. " +
          "Neither is a reading of the data (§4.1 rule 3).",
        legId: leg.id,
      });
    }

    const queueAgeSeconds = (source.storeTime.getTime() - queue.enqueuedAt.getTime()) / MS_PER_SECOND;
    if (!Number.isFinite(queueAgeSeconds)) {
      return verdictOf(VERDICT.UNDETERMINED, { reason: "QUEUE_AGE_NOT_FINITE", legId: leg.id });
    }
    if (queueAgeSeconds < 0) {
      // The row was enqueued after this pass's store time. That is a clock or a
      // replication fact, not a starvation fact, and a negative age is not a fraction.
      return verdictOf(VERDICT.UNDETERMINED, {
        reason: "ENQUEUED_IN_THE_FUTURE",
        detail: `enqueuedAt is ${-queueAgeSeconds}s ahead of the store clock; the ladder does not advance on a negative age`,
        legId: leg.id,
      });
    }

    const elapsedFraction = queueAgeSeconds / budgetSeconds;
    const reached = stepAt(elapsedFraction, published.table);
    const boundary = nextBoundarySeconds(reached, published.table, budgetSeconds, queueAgeSeconds);

    if (reached === null) {
      // The deadline fired before the first rung's fraction. Not an error and not a
      // starvation signal — it is a timer armed shorter than rung 1. Nothing is recorded
      // and the Leg stays queued, re-armed at rung 1's boundary.
      return verdictOf(VERDICT.STEP_AVAILABLE, {
        step: 0,
        action: null,
        relaxations: [],
        queueAgeSeconds,
        budgetSeconds,
        elapsedFraction,
        nextBoundarySeconds: boundary,
        legId: leg.id,
        detail: "no rung has been reached yet; the ladder is ahead of the clock, not behind it",
      });
    }

    if (!source.tx) {
      // A read-only enquiry — the Explanation API's "which rung is this Leg on" (§21.3).
      // Reported, never recorded: see the `tx` parameter's note.
      return verdictOf(VERDICT.STEP_AVAILABLE, {
        step: reached.step,
        action: reached.action,
        relaxations: reached.step === CLASS_P_RUNG ? relaxation.order.slice() : reached.relaxations.slice(),
        queueAgeSeconds,
        budgetSeconds,
        elapsedFraction,
        nextBoundarySeconds: boundary,
        legId: leg.id,
        recorded: false,
      });
    }

    const written = await recordStepsThrough(source.tx, {
      leg,
      queue,
      table: published.table,
      reached,
      budgetSeconds,
      queueAgeSeconds,
      storeTime: source.storeTime,
      regionId: settings.regionId,
      relaxationOrder: relaxation.order,
    });

    if (written.length > 0) {
      record("ladder.steps_recorded", {
        legId: leg.id,
        steps: written.map((row) => row.step),
        reached: reached.step,
        queueAgeSeconds,
        budgetSeconds,
        // Named so an operator reading the log sees what the round is about to be
        // allowed to do, which is §17.4's "published in advance" property at runtime.
        relaxations: written.flatMap((row) => row.relaxations),
      });
    }

    // ── The human rungs ─────────────────────────────────────────────────────
    if (!reached.humanStep) {
      return verdictOf(VERDICT.STEP_AVAILABLE, {
        step: reached.step,
        action: reached.action,
        relaxations: reached.step === CLASS_P_RUNG ? relaxation.order.slice() : reached.relaxations.slice(),
        queueAgeSeconds,
        budgetSeconds,
        elapsedFraction,
        nextBoundarySeconds: boundary,
        legId: leg.id,
        recorded: true,
      });
    }

    const admission = await capacity.admit(source.tx, {
      legId: leg.id,
      leg,
      step: reached.step,
      storeTime: source.storeTime,
      // The raw state, not `custody.custodyOf(...)`: that function throws on an
      // unrecognised state by design (§2.7 — a negative signal must never become a
      // permissive default), and a throw here would take down a timer fire. The triage
      // comparator classifies it and treats anything it does not recognise as the most
      // urgent, which is the same refusal expressed as an ordering.
      custodyState: leg.custodyState,
    });

    if (!admission.admitted) {
      // §17.4: "Legs waiting to enter it remain on the ladder rather than being deemed
      // to have completed step 7." The Leg stays QUEUED, the deadline is re-armed, and
      // the saturation alert — raised by `operatorCapacity` — is what pages.
      return verdictOf(VERDICT.HELD_FOR_HUMAN_CAPACITY, {
        step: reached.step,
        action: reached.action,
        relaxations: reached.relaxations.slice(),
        reason: admission.heldReason,
        outstanding: admission.outstanding,
        capacity: admission.capacity,
        saturated: admission.saturated,
        // Which Legs took the slots instead, when §17.4's triage gave them to someone
        // else. Carried up so the timer's record answers "why is this one still waiting"
        // rather than only "this one is still waiting".
        admittedInstead: admission.admittedInstead,
        queueAgeSeconds,
        budgetSeconds,
        elapsedFraction,
        nextBoundarySeconds: boundary,
        legId: leg.id,
        recorded: true,
      });
    }

    if (!reached.terminal) {
      // Rung 7, admitted: a dispatcher is holding it. It stays queued while they work,
      // and rung 8's boundary is the next thing on its clock.
      return verdictOf(VERDICT.STEP_AVAILABLE, {
        step: reached.step,
        action: reached.action,
        relaxations: reached.relaxations.slice(),
        escalated: true,
        outstanding: admission.outstanding,
        queueAgeSeconds,
        budgetSeconds,
        elapsedFraction,
        nextBoundarySeconds: boundary,
        legId: leg.id,
        recorded: true,
      });
    }

    // ── Rung 8 — the terminal decision ──────────────────────────────────────
    //
    // > Fall back to an alternative modality where configured — human courier,
    // > third-party carrier, scheduled batch — or decline the task with a stated reason
    // > and customer notification.
    //
    // "Where configured" is read literally: no configured modality means the fallback
    // is not available and the decision is the decline. §17.4 registers no parameter for
    // the modality set, so it arrives as an injected collaborator or not at all — and
    // *not at all* is the honest default, because inventing a courier the deployment has
    // not contracted would be a decision this module has no standing to take.
    if (settings.alternativeModality && typeof settings.alternativeModality.available === "function") {
      const fallback = await settings.alternativeModality.available({ leg, queue, storeTime: source.storeTime });
      if (fallback && fallback.available === true) {
        record("ladder.alternative_modality", { legId: leg.id, modality: fallback.modality ?? null });
        return verdictOf(VERDICT.STEP_AVAILABLE, {
          step: reached.step,
          action: reached.action,
          relaxations: ["ALTERNATIVE_MODALITY"],
          modality: fallback.modality ?? null,
          queueAgeSeconds,
          budgetSeconds,
          elapsedFraction,
          nextBoundarySeconds: boundary,
          legId: leg.id,
          recorded: true,
        });
      }
    }

    record("ladder.exhausted", {
      legId: leg.id,
      step: reached.step,
      queueAgeSeconds,
      budgetSeconds,
      outstanding: admission.outstanding,
      reason: "NO_ALTERNATIVE_MODALITY_CONFIGURED",
    });

    return verdictOf(VERDICT.EXHAUSTED, {
      step: reached.step,
      action: reached.action,
      decision: "DECLINE_WITH_STATED_REASON",
      // The stated reason §17.4 requires, assembled from what the ladder actually did
      // rather than from a template — this is the sentence a customer notification and
      // §21.3's "why is this task still waiting?" both need.
      sentence:
        `declined after the §17.4 escalation ladder was exhausted: the Leg was queued for ` +
        `${Math.round(queueAgeSeconds)}s against a ${Math.round(budgetSeconds)}s assignment budget, every rung ` +
        "from 1 to 8 was applied and recorded, a human dispatcher held it at rung 7, and no alternative " +
        "modality is configured for rung 8.",
      queueAgeSeconds,
      budgetSeconds,
      elapsedFraction,
      legId: leg.id,
      recorded: true,
    });
  }

  return Object.freeze({ nextStep, capacity, published, relaxationOrder: relaxation });
}

module.exports = {
  VERDICT,
  STEPS,
  STEP_BY_NUMBER,
  CLASS_P_RELAXATION_ORDER,
  NEVER_RELAXED_CLASSES,
  RESOLUTION,
  WAITING_STATES,
  stepTableFrom,
  relaxationOrderFrom,
  stepAt,
  nextBoundarySeconds,
  firstBoundarySecondsFrom,
  create,
};

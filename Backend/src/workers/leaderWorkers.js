"use strict";

/**
 * The `LEADER_ONLY` worker lifecycle — §19.3's single writer, bound to leadership.
 *
 * ── What this module is, and the defect it half-closes (D-5) ────────────────
 * `src/workers/registry.js` classifies four workers as `LEADER_ONLY`:
 *
 * > **`LEADER_ONLY`** — scheduled, but only while this process holds the shard's leadership
 * > lease (§19.3's single writer). Started and stopped by the shard supervisor rather than
 * > at boot, because a standby that drained an outbox would be a second writer.
 *
 * Until this remediation **nothing started them**. `server.js` said they "belong to the
 * shard supervisor's leadership lifecycle"; `shardSupervisor.worker.js` had no promotion
 * hook and started none of them. Each worker's own `start()` docstring said so, and the
 * whole test suite passed because every test drives `runOnce()` and `drainOnce()` directly
 * with a hand-built dependency object. This module is the missing hook.
 *
 * ── Why two of the four start here and two do not ──────────────────────────
 * This is the honest part, and it is the reason this file composes each worker through a
 * **composer** that may refuse rather than through a list of `start()` calls.
 *
 * A worker is only startable if every collaborator in its dependency contract has a
 * *production producer*. Two do:
 *
 *   - **`outbox`** — `deliver` is `commandDispatcher.outboxDeliveryArm(io)`, which exists
 *     and is production code; `readStoreTime` is `clock.readStoreTime`. Wiring it closes a
 *     live dangling path: `shard/membership.js:migrate()` runs on the supervisor's own
 *     migration pass, enqueues a `SHARD_MIGRATE` outbox row inside the handoff transaction,
 *     and **nothing has ever delivered it**. An agent was migrated, its `authority_epoch`
 *     advanced, and the command telling it so sat in the outbox for ever.
 *   - **`reconciler`** — `sweep()` needs `prisma`, `runInTransaction` and `readStoreTime`,
 *     and `server.js` already builds exactly that trio for the failover path. §12.1's whole
 *     argument is that reconciliation must be *trigger-independent*: "no component is
 *     responsible for noticing that a state has stopped progressing. Patching each trigger
 *     individually leaves the seventh undiscovered." Running it only on failover is one
 *     trigger.
 *
 * A third now does, and it did not when this module was written:
 *
 *   - **`timer`** — its contract needs `handlers`, a map keyed by the §4.3/§4.2 "on expiry"
 *     action. Seventeen actions are declared across `legMachine.js`, `taskMachine.js` and
 *     the commitment lease, and when this module was written **none had an implementation
 *     anywhere in `src/`** — which is why the refusal below said, correctly, that this was
 *     not composition work but the missing implementation of the expiry semantics
 *     themselves. Phase 5's remediation implemented them in
 *     `engine/supervision/expiryActions.js`, and the `timer` row was removed from
 *     `UNCOMPOSABLE` on the rule that table sets for itself: only when the worker
 *     actually starts.
 *
 * One does not, and its blocker is **external to this repository**:
 *
 *   - **`coordinator`** — its contract needs `expandCandidates`, `pricedCandidateFor` and
 *     `commit`. The first two bottom out, through `plan/insertion.js` →
 *     `planBuilder.hopsForSequence` → `routing/cellPairCache.hopsFor`, in an injected
 *     `route` function: **the routing engine**. No engine is selected — that is execution
 *     plan item **B1**, blocked on D1 (operating region), D3 (fleet speed model) and D8
 *     (extract vintage), none of which is an engineering task. `tools/routing/b1Readiness.js`
 *     reports `BLOCKED` and correctly refuses to fabricate one.
 *
 * ── Why a refusal rather than a stub ───────────────────────────────────────
 * The registry already states the rule, for the shadow worker, and it governs here:
 *
 * > A stub would produce a worker that runs, reports success, and computes nothing — the
 * > worst of the three possible states.
 *
 * A coordinator started with a fabricated router would assign real work on invented travel
 * times. A timer worker started with an empty handler map returns `HANDLER_NOT_REGISTERED`
 * for every due timer and leaves each one `PENDING` — a supervisor that supervises nothing
 * while reporting a healthy tick. So each unstartable worker is **refused by name, with its
 * blocker**, the refusal is returned for a health endpoint to publish, and
 * `gate:composition` stays red. The gap is a line in a table rather than an absence, which
 * is the same discipline `blockedBy` imposes on a `DEFERRED` row.
 *
 * ── Duplicate workers, and stopping ────────────────────────────────────────
 * §19.3 admits exactly one active writer per shard. Two things enforce it here: `apply()`
 * is idempotent — a second promotion while already running starts nothing — and every
 * handle is stopped on demotion *and* on shutdown. A worker whose interval outlived a lost
 * lease would be precisely the second writer the readiness state exists to prevent.
 */

const outboxWorker = require("./outbox.worker");
const reconcilerWorker = require("./reconciler.worker");
// Required, deliberately, even though they are not started: the registry declares them
// `LEADER_ONLY`, `gate:composition` checks that a `LEADER_ONLY` worker is reachable from
// production, and this module is where their composition *would* live. Naming them here
// with their blockers is what makes the gap enumerable rather than absent — see
// `COMPOSERS` below, where each returns a refusal instead of a handle.
const coordinatorWorker = require("./coordinator.worker");
const timerWorker = require("./timer.worker");
const registry = require("./registry");
// The coordinator's solve-path contract, enumerated. `COMPOSERS.coordinator` reports what
// this deployment is actually missing instead of restating a fixed paragraph, and
// `UNCOMPOSABLE.coordinator.requires` is derived from the same list.
const coordinatorPipeline = require("./coordinatorPipeline");
// V1 composition — the assembly itself. `COMPOSERS.coordinator` no longer reports that
// nothing constructs the solve path; it *attempts the construction* and reports what the
// construction could not resolve. The distinction is the whole of this change: the refusal
// below is now produced by the code that would run, not by a paragraph describing it.
const coordinatorSolvePath = require("./coordinatorSolvePath");
const clock = require("../engine/commitment/clock");
// §4.5's expiry semantics — the producer of the `handlers` map that this module could
// not build until Phase 5's remediation, and the reason `UNCOMPOSABLE` no longer has a
// `timer` row.
const expiryActions = require("../engine/supervision/expiryActions");
// REMEDIAL PHASE T1-04 — §17.4's escalation ladder. Required *here*, in the composition
// root, and injected into `expiryActions.handlers`: `src/engine/supervision/` is Tier 0
// by path and the ladder is Tier 1, so requiring it there would invert the dependency
// §1.8 rule 2's gate governs.
const ladder = require("../engine/fairness/ladder");
const legMachine = require("../engine/lifecycle/legMachine");
const taskMachine = require("../engine/lifecycle/taskMachine");
// For `ENTITY_TYPE` alone — the ladder's budget is resolved through the same
// `deadlineSecondsFrom` the `QUEUED` timer is armed by, and that function is keyed on it.
const timers = require("../engine/supervision/timers");

/** @structural milliseconds per second — a unit conversion, not a threshold */
const MS_PER_SECOND = 1000;

/**
 * Why a `LEADER_ONLY` worker could not be composed. Named, because "this worker is not
 * running" and "this worker cannot be built from anything in this repository" are different
 * facts and only one of them is a bug someone here can fix.
 *
 * @structural the composition refusal taxonomy
 */
const REFUSAL = Object.freeze({
  /** A collaborator's producer is blocked outside this repository (B1, D1/D3/D8, B8). */
  EXTERNAL_DEPENDENCY_UNAVAILABLE: "EXTERNAL_DEPENDENCY_UNAVAILABLE",
  /** A collaborator has no implementation in this repository yet. */
  COLLABORATOR_NOT_IMPLEMENTED: "COLLABORATOR_NOT_IMPLEMENTED",
  /** A required process-context dependency was not supplied to `create()`. */
  PROCESS_DEPENDENCY_MISSING: "PROCESS_DEPENDENCY_MISSING",
});

/**
 * The `LEADER_ONLY` workers this repository **cannot** compose, and why — declaratively, so
 * that a build gate can read it without constructing a process context.
 *
 * This table is the honest core of D-5. The finding as first reported was "four workers are
 * started by nothing", which reads like a wiring omission; two of them are, and this module
 * wires them. The other two are not, and the difference matters more than the count:
 *
 *   - a **wiring** gap is closed by a commit in this repository;
 *   - a **dependency** gap is not closed by any commit here, and pretending otherwise by
 *     starting the worker against a stub converts a visible red gate into an engine that
 *     runs and decides wrongly.
 *
 * Each row names what the worker requires, what blocks it, and **who owns the blocker** —
 * the same three fields `registry.js` demands of a `DEFERRED` row, for the same reason: an
 * unexplained absence is indistinguishable from an oversight.
 *
 * A row here is not an exemption. `tools/gates/checkCompositionRoot.js` reads this table and
 * reports `LEADER_ONLY_NOT_COMPOSABLE` for every entry, so the build stays **red** and the
 * blocker is named in the failure rather than discovered later. Removing a row is how the
 * gate goes green, and a row may only be removed when the worker actually starts.
 *
 * @structural the composition blockers for LEADER_ONLY workers, with their owners
 */
const UNCOMPOSABLE = Object.freeze({
  coordinator: Object.freeze({
    refusal: "EXTERNAL_DEPENDENCY_UNAVAILABLE",
    // Derived from `coordinatorPipeline.REQUIREMENTS` rather than restated, so the
    // declarative table a build gate reads and the probe a promotion runs cannot disagree
    // about what the coordinator needs. This row used to list three *collaborators*
    // (`expandCandidates`, `pricedCandidateFor`, `commit`), which named the shape of the
    // gap and not its contents — and the contents turned out to matter: two hand-audits of
    // "what does this actually need" each stopped at a different seam and each gave a
    // different, confidently-stated answer.
    requires: coordinatorPipeline.REQUIREMENT_IDS,
    owner: "B1 — Operations + Commercial (D1), Product + Fleet Engineering (D3), Operations (D8)",
    external: true,
    blockedBy:
      "the round loop needs `expandCandidates`, `pricedCandidateFor` and `commit`. " +
      "*(V1 composition, 2026-09-04 — this sentence used to continue \"and **nothing in this repository " +
      "constructs them** — they exist only in test fixtures\". That is no longer true: " +
      "`workers/coordinatorSolvePath.js` constructs all three from the shipped modules, and this refusal is " +
      "now produced by that assembly failing to resolve its inputs rather than by its absence.)* " +
      "They resolve, through " +
      "planBuilder.hopsForSequence → routing/cellPairCache.hopsFor, to an injected `route` " +
      "function — the routing engine. **No routing engine is selected**: that is execution-plan item B1, whose " +
      "Step 5 is blocked on D1 (no authoritative operating region), D3 (no fleet speed model) and D8 (no " +
      "extract vintage), none of which is an engineering task. `npm run routing:readiness` reports BLOCKED and " +
      "refuses to fabricate one. Starting the coordinator against an invented router would assign real work on " +
      "invented travel times, which is worse than not assigning it. " +
      "**And the routing engine is not the whole of it** — `src/workers/coordinatorPipeline.js` enumerates the " +
      "full contract, including **fifteen** register entries that resolve to `null` by declaration and " +
      "**four** input families with **no schema column and no producer anywhere in `src/`** " +
      "(`environment.ambientC/packC`, `masses.vehicleMassKg`, `p_fail`, §14.4's battery wear inputs). Those " +
      "last four are nobody's withheld decision; they are missing code against a data source nobody has named. " +
      "*(E-8 moved terrain out of that group: §14.2 states climb, regeneration and stop-start over " +
      "the traversal, so the router is its producer and the `route` contract is six fields, not three. The V1 " +
      "composition then raised the register count from three to fifteen — not because the register changed, " +
      "but because writing the assembly walked past `planBuilder` into `cost/phi.evaluate`, where every " +
      "`C_direct`, `C_risk`, `C_lifecycle` and `C_delay` rate is its own refusal.)* " +
      "Run the probe for the current list.",
  }),
});

/**
 * The published `values` map, however the composition root chose to supply it.
 *
 * PHASE 15 remediation (P15-R2). `create()` runs once at boot and the composers run on
 * every promotion, so a `values` map captured at `create()` bound each LEADER_ONLY worker
 * to the configuration version the *process* booted on — permanently, and independently of
 * whatever the request path had since adopted. An accessor is resolved at composition time
 * instead, so a promotion composes against the version in force when leadership is
 * acquired. A plain map is still accepted, unchanged, because that is what every test and
 * every other caller passes.
 *
 * @param {object|Function|undefined} values
 * @returns {object|undefined}
 */
function valuesOf(values) {
  return typeof values === "function" ? values() : values;
}

function finite(values, name) {
  const map = valuesOf(values);
  const value = map && typeof map.get === "function" ? map.get(name) : undefined;
  return Number.isFinite(value) ? value : undefined;
}

function parameter(values, name) {
  const map = valuesOf(values);
  return map && typeof map.get === "function" ? map.get(name) : undefined;
}

/**
 * A composer either produces a started handle or refuses with a stated blocker. There is no
 * third outcome, and in particular there is no "started with what we had".
 *
 * Each takes `(context)` and returns `{ ok: true, handle }` or
 * `{ ok: false, refusal, blockedBy }`.
 */
const COMPOSERS = Object.freeze({
  /**
   * §11.1 / §11.3 / §11.4 — claim outbox rows, deliver, record, escalate, expire.
   */
  outbox(context) {
    const { prisma, kv, io, values, record } = context;
    if (!io) {
      return {
        ok: false,
        refusal: REFUSAL.PROCESS_DEPENDENCY_MISSING,
        blockedBy:
          "no Socket.IO server was supplied. §11.3 requires delivery to route by agent identity through a " +
          "session registry that works across workers, and the delivery arm is bound to one `io`.",
      };
    }

    const deps = {
      prisma,
      // The production transport. Never a socket table of the worker's own: §11.3, and the
      // worker's own `requireDeps` refuses one that reaches for a socket itself.
      deliver: context.deliver,
      readStoreTime: outboxWorker.storeTimeReader(prisma),
      record,
      // Advisory only — §3.3. Losing it costs an operator's fast read, never a dispatch.
      advisoryCache: kv,
      // §11.4 step 2's withdrawal is written in a transaction. Its absence is a *reduced*
      // posture the worker states rather than a silent one, so it is supplied here.
      runInTransaction: context.runInTransaction,
      // PHASE 15 remediation (P15-R3) — `activeModes` was passed here and **the outbox
      // worker never read it**: `requireDeps` does not ask for it and `drainOnce` does not
      // use it. It was a dependency with a consumer that did not exist, sitting next to a
      // real §18.5 gap, and its presence is most of why that gap read as wired. The mode
      // set is consulted where the decision is actually taken — inside
      // `commandDispatcher.deliverOutboxCommand`, the single exit every §10.3.1 command
      // passes through — and it reaches there on the `deliver` arm the composition root
      // binds, not through this object.
    };

    const intervalMs = finite(values, "dispatch.max_delivery_delay");
    return {
      ok: true,
      handle: outboxWorker.start(
        deps,
        {
          retryWindowSeconds: finite(values, "dispatch.retry_window"),
          offerTtlSeconds: finite(values, "dispatch.offer_ttl"),
          unresponsiveStrikes: finite(values, "health.unresponsive_strikes"),
          systemicThreshold: finite(values, "dispatch.systemic_threshold"),
          maxDeliveryDelaySeconds: finite(values, "dispatch.max_delivery_delay"),
          nackCooloffSeconds: finite(values, "dispatch.nack_cooloff"),
          // PHASE 15 remediation (X2b) — §11.4 step 2 requeues the Leg, and §4.5 requires
          // the requeued state's deadline to be armed in the same transaction. `QUEUED`'s
          // parameter is `sla.assignment_deadline`, and without it the withdrawal now
          // refuses rather than committing a Leg nothing supervises.
          assignmentDeadlineSeconds: finite(values, "sla.assignment_deadline"),
          shardId: context.shardId,
          // §23.3 — the key the `WITHDRAW` it may have to issue is signed with. An operator
          // -declared deployment secret, read the same way the supervisor reads it; absent,
          // the withdrawal path reports that it cannot sign rather than issuing an unsigned
          // command.
          signingKey: context.signingKey,
          intervalMs: Number.isFinite(intervalMs) ? intervalMs * MS_PER_SECOND : MS_PER_SECOND,
        },
        context.instanceId,
      ),
    };
  },

  /**
   * §12.4 — the full sweep, every divergence category, trigger-independent (§12.1).
   */
  reconciler(context) {
    const { prisma, values, record } = context;
    if (typeof context.runInTransaction !== "function") {
      return {
        ok: false,
        refusal: REFUSAL.PROCESS_DEPENDENCY_MISSING,
        blockedBy: "§12.4's repairs are conditional writes taken inside a transaction; no seam was supplied",
      };
    }

    // The worker refuses a sweep slower than `MAX_SWEEP_INTERVAL_MS`, for the reason its own
    // `start()` gives: "A slower sweep still looks like it is working." Rather than let that
    // throw out of the composer, the bound is applied here and the resulting interval is what
    // the register says or the worker's own ceiling, whichever is smaller.
    const configured = finite(values, "reconciler.sweep_interval");
    const intervalMs = Number.isFinite(configured)
      ? Math.min(configured * MS_PER_SECOND, reconcilerWorker.MAX_SWEEP_INTERVAL_MS - 1)
      : reconcilerWorker.MAX_SWEEP_INTERVAL_MS - 1;

    return {
      ok: true,
      handle: reconcilerWorker.start(
        {
          prisma,
          runInTransaction: context.runInTransaction,
          readStoreTime: () => clock.readStoreTime(prisma),
          record,
        },
        {
          intervalMs,
          assignmentDeadlineSeconds: finite(values, "sla.assignment_deadline"),
          unresponsiveStrikes: finite(values, "health.unresponsive_strikes"),
          energyDeviationTolerance: finite(values, "energy.deviation_tolerance"),
          shardId: context.shardId,
        },
      ),
    };
  },

  /**
   * §9.2 / §19.3 — the round loop. **Assembled, and refused only when an input is absent.**
   *
   * ── The three states this composer has had, and why the third is different ─
   * It began as `return { ok: false, ...UNCOMPOSABLE.coordinator }` — an **unconditional**
   * refusal that inspected nothing. Supplying a routing engine, a region and every
   * calibrated value would not have changed its answer by one character. A refusal that
   * cannot be satisfied is not a dependency check; it is a constant.
   *
   * E-7 made it conditional: it asked `coordinatorPipeline.requirements(context)` and
   * reported **what this deployment is actually missing**, by name, owner and class. That
   * was a real improvement — the classes are the actionable part — but the assembly itself
   * was still unwritten, so the composer's final answer, with every input satisfied, was
   * `COLLABORATOR_NOT_IMPLEMENTED`.
   *
   * **It is now written.** `workers/coordinatorSolvePath.js` builds the real
   * `expandCandidates`, `pricedCandidateFor`, `expansionInputFor` and `commit` from the
   * shipped modules, and this composer calls it. So the refusal below is produced by *the
   * code that would run*, not by a paragraph describing code that does not exist — which
   * is the same move `coordinatorPipeline` made for the requirement list, one layer down.
   *
   * ── This does not move the gate, and must not be read as progress ─────────
   * `tools/gates/checkCompositionRoot.js` reads `UNCOMPOSABLE` **declaratively**, that row
   * is unchanged, and `gate:composition` stays RED. The row is removed only when the
   * coordinator actually starts — the rule that table sets for itself — and it cannot
   * start, because 25 of its 33 declared inputs are unresolved on this register with no
   * routing source. Writing the assembly moved the last *repository-owned* obstacle; it
   * did not supply a router, a calibration, or a region.
   */
  coordinator(context) {
    const assembly = coordinatorSolvePath.create(context);

    if (!assembly.ok) {
      return {
        ok: false,
        ...UNCOMPOSABLE.coordinator,
        // The measured list, alongside the standing declaration. `requires` is the
        // contract; `missing` is this deployment's answer to it.
        missing: assembly.missing,
        missingByClass: assembly.missingByClass,
        satisfied: assembly.satisfied,
        blockedBy:
          `${UNCOMPOSABLE.coordinator.blockedBy} ` +
          `MEASURED against this context — ${assembly.missing.length} of ` +
          `${coordinatorPipeline.REQUIREMENT_IDS.length} inputs unresolved: ` +
          `${coordinatorPipeline.describeMissing(assembly.missing)}.`,
      };
    }

    const enriched = assembly.context;
    const values = context.values;

    return {
      ok: true,
      satisfied: assembly.satisfied,
      handle: coordinatorWorker.start(assembly.deps, {
        shardId: context.shardId,
        instanceId: context.instanceId,
        regionId: context.regionId,
        config: {
          maxEvaluatedPerLeg: finite(values, "candidate.max_evaluated"),
          maxColumnsPerRound: finite(values, "plan.max_columns_per_round"),
          branchNodeBudget: finite(values, "solve.branch_node_budget"),
          timeBudgetMs: enriched.expansionWallClockBudgetMs,
          maxClockSkewMillis: finite(values, "time.max_clock_skew"),
          storeRoundTripMillis: finite(values, "time.store_round_trip"),
          windowMinMs: finite(values, "solve.window_min"),
          windowMaxMs: finite(values, "solve.window_max"),
          saturatedWindowMs: finite(values, "solve.saturated_window"),
          maxLegsPerRound: finite(values, "solve.max_legs_per_round"),
        },
        // §22.5's switches reach the round as data. None is thrown on by this composer:
        // `deferral` and the rest are register state, and the round reads `killSwitches`
        // for what it may do, never for what it must.
        killSwitches: context.killSwitches || {},
        tickMs: finite(values, "solve.window_min"),
        record: context.record,
      }),
    };
  },

  /**
   * §4.5 / §12.2 — durable timers: select due, judge staleness, act, resolve or re-arm.
   *
   * PHASE 5 REMEDIATION. This composer returned `UNCOMPOSABLE.timer` — *"the handler map
   * has no producer because the expiry semantics themselves are unimplemented"* — and
   * that was accurate. `supervision/expiryActions.js` is the producer, and the row was
   * removed from `UNCOMPOSABLE` only because the blocker it named is gone, which is the
   * rule that table states for its own removal: *"a row may only be removed when the
   * worker actually starts."*
   *
   * ── The completeness check is the composition, not a comment ───────────────
   * `assertComplete` compares the map's keys against the actions **derived from
   * `legMachine.LEG_DEADLINES` and `taskMachine.TASK_DEADLINES`**, so a state added to
   * §4.3 later with a new expiry action refuses composition here rather than producing a
   * due timer that returns `HANDLER_NOT_REGISTERED` in production. A refusal is what the
   * registry's rule asks for: a worker that runs and supervises nothing is the worst of
   * the three states.
   *
   * ── The §17.4 ladder, now injected ────────────────────────────────────────
   * REMEDIAL PHASE T1-04. This composer used to pass `handlers({})` and record why:
   * *"`ladder` — §17.4's escalation ladder is mechanism T1-04, owned by a remedial phase;
   * `src/engine/fairness/` is empty."* That was accurate and it is no longer true.
   * `fairness/ladder.js` exists, and **this is the seam that makes it reachable**: the
   * timer worker selects `ESCALATION_LADDER` when a `QUEUED` Leg's `sla.assignment_deadline`
   * comes due, `expiryActions` binds the collaborator supplied here into that handler's
   * context, and the handler consults it. There is no other production caller and there
   * does not need to be — §17.4's ladder advances on a deadline, and §4.5 is what owns
   * deadlines.
   *
   * The ladder is built here rather than inside `expiryActions` for the reason every
   * other collaborator is: `src/engine/supervision/` is **Tier 0** by path and the ladder
   * is Tier 1, so a `require` there would invert the dependency the tier gate governs.
   * Injection keeps the Tier 0 supervisor ignorant of which Tier 1 mechanism owns the
   * relaxation, which is what let this handler ship correctly refusing before the ladder
   * existed at all.
   *
   * Its own configuration comes from the published register, resolved here once, like
   * every other worker parameter:
   *
   *   · `sla.assignment_deadline` — the ladder's total budget. Read through
   *     `deadlineSecondsFrom(values, LEG, QUEUED)` rather than by name, so the budget the
   *     ladder divides into rungs is **the same number the QUEUED timer was armed for**.
   *     Two independent resolutions of one budget would let the ladder's rung 8 and the
   *     deadline that invokes it drift apart.
   *   · `ops.escalation_capacity`, `ops.escalation_saturation_period` — §17.4's human
   *     capacity model, region-scoped, which is why `context.regionId` is passed and why
   *     its absence holds escalations rather than admitting them unbounded.
   *
   * ── What is still *not* injected, and why that is honest rather than lazy ─
   *   - **`probe`** — §10.3.1 row 3 makes `PROBE` a side-effect-free live query that
   *     `outbox.buildRow` refuses to enqueue, so it is a transport call rather than
   *     anything a worker can persist. Its absence costs a diagnostic; the reassignment
   *     §4.4 mandates happens either way.
   *   - **`alternativeModality`** — §17.4 rung 8 falls back to a modality "where
   *     configured"; no register entry names a modality set and no such collaborator
   *     exists. Not configured is therefore the reading, and the rung's other branch —
   *     decline with a stated reason — is what runs.
   *
   * Neither absence is papered over with a stub that returns a plausible answer.
   */
  timer(context) {
    const { prisma, kv, values, record } = context;

    if (typeof context.runInTransaction !== "function") {
      return {
        ok: false,
        refusal: REFUSAL.PROCESS_DEPENDENCY_MISSING,
        blockedBy:
          "§4.5's fire is one transaction — claim the due timer, act, resolve or re-arm — because a deadline " +
          "acted on in one transaction and resolved in another is discharged by nobody across a crash between " +
          "them (§4.1 rule 5). No transaction seam was supplied.",
      };
    }

    // T1-04 — §17.4's ladder, bound to this shard's region and to the same budget the
    // `QUEUED` deadline is armed for.
    const escalationLadder = ladder.create({
      prisma,
      values,
      budgetSeconds: deadlineSecondsFrom(values, timers.ENTITY_TYPE.LEG, legMachine.LEG_STATE.QUEUED),
      regionId: context.regionId,
      escalationCapacity: finite(values, "ops.escalation_capacity"),
      saturationPeriodSeconds: finite(values, "ops.escalation_saturation_period"),
      // `classPRelaxationOrder` is deliberately not passed. §17.4 names the head of rung
      // 3's sequence — "zone affinity first, dedicated-fleet preference next" — and then
      // writes "and so on"; the tail is a deployment's to publish and no register entry
      // carries it. Omitting it makes the ladder relax exactly the two the specification
      // names, which is the only sequence the specification actually states.
      record,
    });

    const map = expiryActions.handlers({ ladder: escalationLadder });
    const completeness = expiryActions.assertComplete(map);
    if (!completeness.ok) {
      return {
        ok: false,
        refusal: REFUSAL.COLLABORATOR_NOT_IMPLEMENTED,
        blockedBy:
          `the handler map does not cover every declared §4.2/§4.3 expiry action. Missing: ` +
          `${completeness.missing.join(", ") || "none"}. Declared but not in either machine: ` +
          `${completeness.unexpected.join(", ") || "none"}. A due timer whose action has no handler stays PENDING ` +
          "for ever, which is a deadline nobody owns (§12.1).",
      };
    }

    const intervalSeconds = finite(values, "supervise.max_timer_lag");

    return {
      ok: true,
      handle: timerWorker.start(
        {
          prisma,
          runInTransaction: context.runInTransaction,
          readStoreTime: timerWorker.storeTimeReader(prisma),
          handlers: map,
          record,
          // Advisory only — §3.3 and §4.5 agree: timers are DB-authoritative and this key
          // is an SLI gauge. Losing it costs an operator a fast read, never a deadline.
          advisoryCache: kv,
        },
        {
          maxTimerLagSeconds: intervalSeconds,
          // Every deadline a handler may need to *enter*, resolved from the published
          // register through the state's own parameter — never a default invented here,
          // which would be a behavioural constant outside the register (§22.1).
          deadlineSecondsFor: (entityType, state) => deadlineSecondsFrom(values, entityType, state),
          maxReassignmentsPerLeg: finite(values, "recover.max_reassignments_per_leg"),
          incumbentCooloffSeconds: finite(values, "recover.incumbent_cooloff"),
          reassignBudgetSeconds: finite(values, "recover.reassign_budget"),
          maxDeliveryDelaySeconds: finite(values, "dispatch.max_delivery_delay"),
          nackCooloffSeconds: finite(values, "dispatch.nack_cooloff"),
          etaTolerance: finite(values, "execute.eta_tolerance"),
          escalationContacts: parameter(values, "ops.external_escalation_contacts"),
          contactReviewPeriodSeconds: finite(values, "ops.escalation_contact_review_period"),
          emergencyServicesThreshold: parameter(values, "ops.emergency_services_hazard_threshold"),
          regionId: context.regionId,
          // §23.3 — the key a `WITHDRAW` or `RECALL` this worker issues is signed with.
          // Its absence makes those two handlers refuse rather than emit an unsigned
          // command the agent is obliged to reject.
          signingKey: context.signingKey,
          shardId: context.shardId,
          // A pass no slower than the lag bound it is measured against: a sweep that runs
          // less often than `supervise.max_timer_lag` guarantees the SLI it reports.
          intervalMs: Number.isFinite(intervalSeconds)
            ? Math.max(MS_PER_SECOND, (intervalSeconds * MS_PER_SECOND) / 2)
            : MS_PER_SECOND,
        },
      ),
    };
  },
});

/**
 * Resolve a state's exit deadline, in seconds, from the published register.
 *
 * The parameter name comes from the state's own machine, so there is no second table of
 * "which parameter supervises which state" to drift from §4.2 and §4.3.
 *
 * Returns `undefined` for the two `projected` deadlines rather than a number:
 * `execute.eta_tolerance` is a **multiplier** on a mission's projected ETA, not a
 * duration, and returning it as seconds would arm an `EN_ROUTE` state with a deadline of
 * "1.3 seconds". The handlers re-arm those from the interval the timer was originally
 * armed for, which is the projection the plan actually supplied.
 *
 * @param {object} values the published configuration's `values` map
 * @param {string} entityType
 * @param {string} state
 * @returns {number|undefined}
 */
function deadlineSecondsFrom(values, entityType, state) {
  const spec = entityType === "TASK" ? taskMachine.deadlineFor(state) : legMachine.deadlineFor(state);
  if (!spec || spec.projected === true) return undefined;
  const seconds = finite(values, spec.parameter);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/**
 * Build the lifecycle.
 *
 * @param {object} context
 * @param {object} context.prisma
 * @param {object} [context.kv]
 * @param {object} [context.io]
 * @param {object} [context.values] the published configuration's `values` map
 * @param {(fn: (tx: object) => Promise<*>) => Promise<*>} [context.runInTransaction]
 * @param {(agentId: string, envelope: object) => Promise<object>} [context.deliver]
 * @param {(event: string, detail: object) => void} [context.record]
 * @param {(error: Error, workerId: string) => void} [context.onError]
 * @param {object} [context.logger]
 * @returns {{ apply: (tick: object) => object, stop: () => void, running: () => string[],
 *   refusals: () => object[], report: () => object }}
 */
function create(context) {
  const settings = context || {};
  const log = settings.logger || null;

  /** Started handles, by worker id. The presence of a key *is* "this worker is running". */
  const handles = new Map();
  /** Composition refusals, by worker id — computed on the first promotion and kept. */
  const refused = new Map();
  /** So a standing refusal is logged once per promotion rather than once per tick. */
  let announced = false;

  const leaderOnly = registry.scheduledOnLeadership();

  function startAll() {
    for (const workerId of leaderOnly) {
      if (handles.has(workerId)) continue; // idempotent: never two of the same writer
      const composer = COMPOSERS[workerId];
      if (typeof composer !== "function") {
        refused.set(workerId, {
          worker: workerId,
          refusal: REFUSAL.COLLABORATOR_NOT_IMPLEMENTED,
          blockedBy: `no composer is declared for the LEADER_ONLY worker \`${workerId}\``,
        });
        continue;
      }

      let outcome;
      try {
        outcome = composer(settings);
      } catch (error) {
        // A composer that throws is a composition defect, not a tick failure. It must not
        // take the promotion down — the workers that *can* run still should — but it must
        // be visible, so it becomes a refusal rather than a silence.
        outcome = {
          ok: false,
          refusal: REFUSAL.PROCESS_DEPENDENCY_MISSING,
          blockedBy: `composing \`${workerId}\` threw: ${error && error.message}`,
        };
      }

      if (outcome && outcome.ok === true && outcome.handle) {
        handles.set(workerId, outcome.handle);
        refused.delete(workerId);
      } else {
        refused.set(workerId, { worker: workerId, ...outcome, ok: undefined });
      }
    }

    if (!announced && log) {
      announced = true;
      log.info?.("Leadership acquired — LEADER_ONLY workers started (§19.3's single writer)", {
        running: [...handles.keys()],
      });
      for (const entry of refused.values()) {
        // `error`, not `warn`: a Tier 0 worker that cannot be composed means this shard has
        // no decision path even though the engine is enabled for it, and that is the state
        // an operator must not discover from a metric.
        log.error?.("LEADER_ONLY worker NOT started — its dependency contract cannot be satisfied", entry);
      }
    }
  }

  function stopAll() {
    for (const [workerId, handle] of handles) {
      try {
        handle.stop();
      } catch (error) {
        if (typeof settings.onError === "function") settings.onError(error, workerId);
      }
    }
    handles.clear();
    announced = false;
  }

  return {
    /**
     * Drive the lifecycle from one supervisor tick.
     *
     * `mayRunRound` is the supervisor's own single answer to "does this process hold a
     * promoted lease for this shard" — `runOnce()` computes it from the session after the
     * failover pass, which is exactly the point at which §19.5 permits rounds to resume. It
     * is read rather than reconstructed from the four passes, so this module and the
     * supervisor cannot disagree about who leads.
     *
     * @param {object} tick a `shardSupervisor.runOnce()` result
     * @returns {{ running: string[], refusals: object[], leading: boolean }}
     */
    apply(tick) {
      const leading = Boolean(tick && tick.mayRunRound === true);
      if (leading) startAll();
      else stopAll();
      return { leading, running: [...handles.keys()], refusals: [...refused.values()] };
    },

    /** Stop everything — demotion, or process shutdown. */
    stop: stopAll,

    running() {
      return [...handles.keys()];
    },

    refusals() {
      return [...refused.values()];
    },

    /**
     * The lifecycle as a health payload: what leadership started, and what it could not.
     *
     * @returns {object}
     */
    report() {
      return {
        leaderOnly: leaderOnly.length,
        running: [...handles.keys()],
        refused: [...refused.values()],
      };
    },
  };
}

module.exports = { REFUSAL, UNCOMPOSABLE, COMPOSERS, create };

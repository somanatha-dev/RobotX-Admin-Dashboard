"use strict";

/**
 * §4.5's expiry semantics — what a deadline *does* when it passes.
 *
 * PHASE 5 REMEDIATION. This module did not exist. `legMachine.js` and `taskMachine.js`
 * declared seventeen "On expiry" actions across §4.3's and §4.2's deadline columns,
 * `supervision/timers.js` registered timers naming them, `workers/timer.worker.js`
 * selected them when they came due — and **not one of the seventeen had an
 * implementation anywhere under `src/`**. The worker's own dependency contract asked for
 * a `handlers` map keyed by the action, and nothing in the repository produced one, so
 * the worker was correctly refused composition and the shard had no supervisor.
 *
 * That is a bigger absence than a missing map, and it is worth naming exactly, because
 * the shape of the gap is the shape of this module:
 *
 * > §4.5: *"This mechanism replaces, and structurally prevents, the entire family of
 * > baseline defects in which a state persisted forever because no component owned its
 * > progression."*
 *
 * Every deadline was registered and none was owned. The store recorded the obligation
 * and no component discharged it — the same defect, one level up, inside the mechanism
 * built to remove it.
 *
 * ── The three rules every handler here obeys ────────────────────────────────
 *
 * **1. A timer attempts; it never forces.**
 *
 * > Timer handlers are subject to the same conditional-write discipline as any other
 * > transition. A timer never forces a state change; it *attempts* one.
 *
 * So every transition goes through `lifecycle/transitions.apply`, which evaluates §4.4's
 * guards and performs the conditional write on `leg.version`. A handler that wrote a Leg
 * directly would be the unconditional write §4.1 rule 2 exists to forbid, and it would be
 * one written by the component least able to know what else is happening to that Leg.
 *
 * **2. Absent evidence refuses; it never assumes.**
 *
 * §4.1 rule 3 — *"State is never inferred from the absence of data. Absence triggers
 * investigation, not assumption."* Several §4.3 actions need a collaborator that belongs
 * to a phase which has not landed: the §17.4 escalation ladder above all. Where one is
 * absent the handler **refuses and says which collaborator was missing**. It does not
 * substitute a default, and in particular it does not read "no ladder implementation" as
 * "ladder exhausted" — that reading would fail a customer's Task because a module is
 * missing, which is inventing a decision out of an absence.
 *
 * **3. A deadline that was not discharged is re-armed, never resolved.**
 *
 * A refusal leaves the entity in the state whose deadline this was, and three §4.3
 * actions (`OPERATOR_ALERT` twice, `PAGE_OPERATIONS`) are not transitions at all and
 * never move it by design. Resolving the timer in either case would leave a non-terminal
 * state with no pending timer — invariant I4's violation, produced by the supervisor,
 * silently and permanently. `timers.reschedule` is the re-arm and `timer.worker` applies
 * it **structurally**, from the entity's own version rather than from what a handler
 * claims, so a handler cannot discharge a deadline it did not act on.
 *
 * ── What is deliberately not here ──────────────────────────────────────────
 * No handler pages, alerts, or escalates by reaching for a transport. `record` is the
 * observability sink every worker already uses, and the one durable escalation the
 * specification gives a schema home — §18.6's chain, on `ExternalEscalation` — is written
 * through `failure/externalEscalation.js`, which is its single implementation. Inventing a
 * second escalation table for "operator alert" would be a migration deciding an operations
 * contract §4.3 does not state.
 *
 * Tier 0 by path (`src/engine/supervision/`). Invariants I4, I12, I22.
 */

const custody = require("../domain/custody");
const externalEscalation = require("../failure/externalEscalation");
const legMachine = require("../lifecycle/legMachine");
const leases = require("./leases");
const offers = require("../dispatch/offers");
const progress = require("./progress");
const reassignment = require("../lifecycle/reassignment");
const taskMachine = require("../lifecycle/taskMachine");
const timers = require("./timers");
const transitions = require("../lifecycle/transitions");

/**
 * How an expiry ended. Not a success/failure pair: §4.5's whole point is that an attempt
 * that was refused is a *correct* outcome of a timer, and it must be distinguishable from
 * an attempt that was never made.
 * @structural the enumerated expiry dispositions
 */
const DISPOSITION = Object.freeze({
  /** The §4.4 transition applied. The entity's version moved. */
  TRANSITIONED: "TRANSITIONED",
  /** A §4.4 guard refused it. The entity did not move; the deadline is re-armed. */
  REFUSED: "REFUSED",
  /** Another writer moved the entity first — §4.1 rule 2 deciding, as it should. */
  LOST_RACE: "LOST_RACE",
  /** §4.3 names an action and no target state; the action was performed. */
  ACTED_WITHOUT_TRANSITION: "ACTED_WITHOUT_TRANSITION",
  /** A collaborator this action needs has no implementation. Named, never defaulted. */
  DEPENDENCY_UNAVAILABLE: "DEPENDENCY_UNAVAILABLE",
  /** The deadline had already been overtaken; nothing was left to do. */
  NOTHING_TO_DO: "NOTHING_TO_DO",
});

/**
 * Every action §4.2's and §4.3's deadline columns declare, **derived** from the two
 * machines and the commitment lease rather than listed again here.
 *
 * Derived, because a second list is a list that drifts: a state added to §4.3 with a new
 * expiry action would leave a hand-written copy silently short by one, and the symptom
 * would be a due timer returning `HANDLER_NOT_REGISTERED` in production. `assertComplete`
 * compares this against a built map, and `checkCompositionRoot` compares it against the
 * composer, so the drift is a red build rather than an unsupervised state.
 *
 * @returns {Array<{ entityType: string, state: string, action: string, parameter: string }>}
 */
function declaredActions() {
  const rows = [];
  for (const [state, deadline] of Object.entries(legMachine.LEG_DEADLINES)) {
    if (!deadline) continue;
    rows.push({ entityType: timers.ENTITY_TYPE.LEG, state, action: deadline.onExpiry, parameter: deadline.parameter });
  }
  for (const [state, deadline] of Object.entries(taskMachine.TASK_DEADLINES)) {
    if (!deadline) continue;
    rows.push({ entityType: timers.ENTITY_TYPE.TASK, state, action: deadline.onExpiry, parameter: deadline.parameter });
  }
  const commitmentDeadline = timers.deadlineFor(timers.ENTITY_TYPE.COMMITMENT, null);
  rows.push({
    entityType: timers.ENTITY_TYPE.COMMITMENT,
    state: "*",
    action: commitmentDeadline.onExpiry,
    parameter: commitmentDeadline.parameter,
  });
  return rows;
}

/**
 * The distinct action names, sorted. What a handler map's keys must cover.
 *
 * @returns {string[]}
 */
function declaredActionNames() {
  return [...new Set(declaredActions().map((row) => row.action))].sort();
}

/**
 * Does this map cover every declared action, and does it declare any the machines do not?
 *
 * Both directions matter. A **missing** key is a deadline nobody owns. An **extra** key is
 * a handler for a state that no longer exists, which is dead code that reads as coverage.
 *
 * @param {object} map
 * @returns {{ ok: boolean, missing: string[], unexpected: string[] }}
 */
function assertComplete(map) {
  const declared = declaredActionNames();
  const provided = map && typeof map === "object" ? Object.keys(map) : [];
  const missing = declared.filter((action) => typeof (map || {})[action] !== "function");
  const unexpected = provided.filter((action) => !declared.includes(action)).sort();
  return { ok: missing.length === 0 && unexpected.length === 0, missing, unexpected };
}

// ── Shared machinery ───────────────────────────────────────────────────────

/**
 * Resolve the deadline of a state the handler is about to enter.
 *
 * `transitions.apply` refuses to enter a timer-requiring state without one, and it is
 * right to: entering a supervised state with no deadline registered is the unsupervised
 * state §4.5 exists to prevent, arriving through the mechanism meant to prevent it. So a
 * handler that cannot resolve the target's deadline refuses the transition rather than
 * letting `apply` throw — a refusal is re-armed and recorded, and a throw is a
 * `HANDLER_THREW` string with the Leg left wherever it was.
 *
 * @param {object} config
 * @param {string} entityType
 * @param {string} state
 * @returns {number|undefined}
 */
function deadlineSecondsFor(config, entityType, state) {
  const resolver = config && config.deadlineSecondsFor;
  if (typeof resolver !== "function") return undefined;
  const value = resolver(entityType, state);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Attempt one §4.4 transition on behalf of an expiry, and translate its outcome into a
 * disposition.
 *
 * @param {object} ctx
 * @param {object} input
 * @param {string} input.event
 * @param {object} [input.context] guard evidence
 * @param {object} [input.data] extra columns
 * @param {number} [input.deadlineSecondsOverride] REMEDIAL PHASE T1-04. The deadline to
 *   arm the *target* state with, when the mechanism that owns the target's timing is not
 *   the register entry §4.3 names. Exactly one action uses it: `ESCALATION_LADDER`.
 *
 *   §4.3 arms `QUEUED` for `sla.assignment_deadline`, which §26.1's I13 instrument calls
 *   "the ladder's **total** budget" — while §17.4 triggers each of its eight rungs on a
 *   *fraction* of that budget. Re-arming the `QUEUED → QUEUED` self-loop at the whole
 *   budget again would put one rung per budget, so the ladder would take eight assignment
 *   deadlines to reach a decision it is specified to reach in one. `taskMachine.js` already
 *   records where this belongs — "supervised by the §17.4 ladder, whose step timing is
 *   (T1-04). Named here, owned there" — so the ladder supplies the next rung's boundary
 *   and this is where it is applied. The override is ignored for every other target,
 *   because no other state has a mechanism that owns its timing.
 * @returns {Promise<object>}
 */
async function attemptTransition(ctx, input) {
  const { tx, entity: leg, storeTime, config, timer } = ctx;
  const source = input || {};

  const row = transitions.find(leg.state, source.event);
  if (!row) {
    return {
      disposition: DISPOSITION.NOTHING_TO_DO,
      outcome: `NO_SUCH_TRANSITION:${leg.state}/${source.event}`,
    };
  }

  // The target may depend on the context (the stranding rows, the lease-expiry row), so
  // it is resolved through the table rather than assumed, and its deadline read from it.
  let target;
  try {
    target = transitions.targetOf(row, { ...(source.context || {}), leg });
  } catch (error) {
    // `leaseExpiryTarget` throws rather than invent a state when Resume has no Leg to
    // continue in (§4.1 rule 3). That is a refusal, not a crash.
    return { disposition: DISPOSITION.REFUSED, outcome: `TARGET_UNRESOLVABLE:${error && error.message}` };
  }

  let deadlineSeconds;
  if (legMachine.requiresTimer(target)) {
    deadlineSeconds = deadlineSecondsFor(config, timers.ENTITY_TYPE.LEG, target);

    // T1-04's override, applied before the `projected` fallback and before the refusal,
    // so a ladder rung is armed at the rung rather than at the budget. Guarded on a
    // positive finite number: an override that did not resolve falls back to §4.3's
    // register entry rather than arming a deadline of NaN.
    if (Number.isFinite(source.deadlineSecondsOverride) && source.deadlineSecondsOverride > 0) {
      deadlineSeconds = source.deadlineSecondsOverride;
    }

    // §4.3 gives `EN_ROUTE_PICKUP` and `EN_ROUTE_DROP` a *projected* deadline — "projected
    // ETA × `execute.eta_tolerance`" — which is not a duration in the register and cannot
    // be resolved from one. The only §4.5 path that re-enters a projected state is the
    // ETA-breach self-transition, and there the projection is already on the row: the
    // interval this timer was armed for *is* the projection the plan supplied when the
    // state was entered. Re-arming at it continues the same horizon rather than inventing
    // a second one, and a timeout is in no position to re-project (that is Phase 8's).
    const spec = legMachine.deadlineFor(target);
    if (deadlineSeconds === undefined && spec && spec.projected === true) {
      const armed = timers.armedSecondsOf(timer);
      if (Number.isFinite(armed) && armed > 0) deadlineSeconds = armed;
    }

    if (deadlineSeconds === undefined) {
      return {
        disposition: DISPOSITION.DEPENDENCY_UNAVAILABLE,
        outcome: `DEADLINE_UNRESOLVED:${spec ? spec.parameter : target}`,
      };
    }
  }

  const result = await transitions.apply(tx, {
    leg,
    event: source.event,
    storeTime,
    deadlineSeconds,
    context: source.context,
    data: source.data,
    shardId: timer.shardId === null ? undefined : timer.shardId,
  });

  if (result.outcome === transitions.OUTCOME.APPLIED) {
    return {
      disposition: DISPOSITION.TRANSITIONED,
      outcome: `${result.from}→${result.to}`,
      transition: result,
    };
  }
  if (result.outcome === transitions.OUTCOME.LOST_RACE) {
    return { disposition: DISPOSITION.LOST_RACE, outcome: result.reason };
  }
  return { disposition: DISPOSITION.REFUSED, outcome: `${result.outcome}:${result.reason}` };
}

/**
 * Read the incumbent commitment and its agent for the recovery actions that need them.
 *
 * @param {object} ctx
 * @param {object} leg
 * @returns {Promise<{ commitment: object|null, agent: object|null, all: object[] }>}
 */
async function readIncumbent(ctx, leg) {
  const all = await ctx.tx.commitment.findMany({ where: { legId: leg.id } });
  const commitment = all.find((row) => row.releasedAt === null) || null;
  const agent = commitment ? await ctx.tx.agent.findUnique({ where: { id: commitment.agentId } }) : null;
  return { commitment, agent, all };
}

// ── §4.3 — the Leg actions ─────────────────────────────────────────────────

/**
 * `QUEUED` / `WAITING` / `AT_RISK` — *"escalation ladder (§17.4)"*.
 *
 * §4.4 gives this two rows: `assignment deadline → QUEUED` guarded on *"ladder step
 * available"*, and `ladder exhausted → FAILED`. The guard's evidence — which step the Leg
 * is on, whether another exists, and what it relaxes — is §17.4's, and it is the ladder's
 * to produce.
 *
 * REMEDIAL PHASE T1-04. This handler previously refused unconditionally, because
 * `src/engine/fairness/` was empty and §17.4's three modules did not exist. They do now,
 * and `workers/leaderWorkers.js` injects the ladder into the timer worker's handler map,
 * so this is where the anti-starvation guarantee actually runs.
 *
 * ── Four verdicts, not two, and the two extra ones are the safety ───────────
 * §4.4's two rows are not symmetric. `→ QUEUED` costs a re-queue; `LADDER_EXHAUSTED →
 * FAILED` terminates a customer's Leg. Any mapping that folds "the ladder could not tell"
 * into the second row fails real work on the strength of a missing input, which is §4.1
 * rule 3's prohibition in its most expensive form. So this reads the ladder's own verdict
 * rather than the truthiness of a field:
 *
 *   · `STEP_AVAILABLE` — a rung applied. §4.4's first row, re-armed at the *next rung's*
 *     boundary rather than at the whole budget (see `deadlineSecondsOverride`).
 *   · `HELD_FOR_HUMAN_CAPACITY` — rung 7 or 8 reached with no dispatcher capacity behind
 *     it. §17.4: "Legs waiting to enter it remain on the ladder rather than being deemed
 *     to have completed step 7." Also §4.4's first row: the Leg stays queued. It is
 *     reported distinctly so an operator can tell a Leg the ladder is working from a Leg
 *     the ladder is waiting on a person for.
 *   · `EXHAUSTED` — rung 8, a human saw it, no alternative modality. §4.4's second row.
 *     This is the only path to `FAILED`, and the ladder will not return it unless the
 *     `LadderEscalation` row for rung 8 carries an `admittedAt`.
 *   · `UNDETERMINED` — no queue row, no budget, a mis-published order, a bad clock. The
 *     deadline is re-armed and the Leg does not move.
 *
 * A ladder that is not injected at all is still `DEPENDENCY_UNAVAILABLE`, and it still
 * re-arms. The refusal has not been softened; it has stopped being the only outcome.
 *
 * @param {object} ctx
 * @returns {Promise<object>}
 */
async function escalationLadder(ctx) {
  const ladder = ctx.deps && ctx.deps.ladder;
  if (!ladder || typeof ladder.nextStep !== "function") {
    return {
      disposition: DISPOSITION.DEPENDENCY_UNAVAILABLE,
      outcome: "LADDER_NOT_IMPLEMENTED",
      detail:
        "§17.4's escalation ladder (mechanism T1-04) was not injected into this handler map. The deadline is " +
        "re-armed rather than read as `ladder exhausted`, because failing a Leg on the strength of a missing " +
        "collaborator would be inferring a decision from an absence (§4.1 rule 3).",
    };
  }

  if (ctx.timer.entityType === timers.ENTITY_TYPE.TASK) {
    // §4.2 has no transition table anywhere in the specification (blocker X3), so a
    // Task's ladder step has no target state to attempt. The step itself — what was
    // relaxed and why — is §17.4's to record, and it is recorded against the Leg by the
    // ladder, not restated here. A Task is waiting exactly while one of its Legs is
    // queued, which is why `sla.assignment_deadline` carries both deadlines.
    const step = await ladder.nextStep({
      tx: ctx.tx,
      entityType: ctx.timer.entityType,
      entityId: ctx.timer.entityId,
      storeTime: ctx.storeTime,
      record: ctx.record,
    });
    return {
      disposition: DISPOSITION.ACTED_WITHOUT_TRANSITION,
      outcome: step && step.available === true ? `LADDER_STEP_${step.step}` : "LADDER_TASK_SCOPE_HAS_NO_STEP",
      detail: step ? step.detail ?? null : null,
    };
  }

  const step = await ladder.nextStep({
    // The fire transaction, so the rung recorded and the transition it justifies commit
    // or roll back together. A relaxation that survives a rolled-back transition is a
    // widening nobody authorised (§4.1 rule 5).
    tx: ctx.tx,
    entityType: ctx.timer.entityType,
    entityId: ctx.timer.entityId,
    leg: ctx.entity,
    storeTime: ctx.storeTime,
    record: ctx.record,
  });

  // A ladder that returned nothing, or something that is not a verdict, is a ladder this
  // handler cannot read. Refuse and re-arm — never fall through to the FAILED row.
  if (!step || typeof step.verdict !== "string") {
    return {
      disposition: DISPOSITION.DEPENDENCY_UNAVAILABLE,
      outcome: "LADDER_VERDICT_UNREADABLE",
      detail: "the injected ladder did not return a §17.4 verdict; the deadline is re-armed and the Leg does not move",
    };
  }

  if (step.verdict === "UNDETERMINED") {
    ctx.record("timer.ladder_undetermined", {
      legId: ctx.entity.id,
      reason: step.reason ?? null,
      detail: step.detail ?? null,
    });
    return {
      disposition: DISPOSITION.DEPENDENCY_UNAVAILABLE,
      outcome: `LADDER_UNDETERMINED:${step.reason ?? "UNSTATED"}`,
      detail: step.detail ?? null,
    };
  }

  const available = step.available === true;

  if (step.verdict === "HELD_FOR_HUMAN_CAPACITY") {
    ctx.record("timer.ladder_held_for_human_capacity", {
      legId: ctx.entity.id,
      step: step.step,
      outstanding: step.outstanding ?? null,
      capacity: step.capacity ?? null,
      saturated: step.saturated === true,
      note:
        "the Leg reached a human rung and has not been escalated: §17.4 keeps it on the ladder rather than " +
        "deeming step 7 complete, because a Leg no dispatcher has seen has not been escalated.",
    });
  }

  const result = await attemptTransition(ctx, {
    event: available ? transitions.EVENT.ASSIGNMENT_DEADLINE : transitions.EVENT.LADDER_EXHAUSTED,
    context: { ladderStepAvailable: available },
    // §17.4's rungs fire at fractions of the budget; §4.3 arms `QUEUED` at the whole of
    // it. Without this the self-loop re-arms at the budget and the ladder advances one
    // rung per assignment deadline.
    deadlineSecondsOverride: available ? step.nextBoundarySeconds : undefined,
  });

  // §4.5's re-arm hook, for the paths that did *not* transition — a guard refused, or
  // another writer moved the Leg first. The next rung's boundary is still the right
  // moment to look again, and without it `timer.worker` re-arms at the interval this
  // timer was originally armed for, which is the whole budget.
  if (
    result.disposition !== DISPOSITION.TRANSITIONED &&
    Number.isFinite(step.nextBoundarySeconds) &&
    step.nextBoundarySeconds > 0
  ) {
    return { ...result, rearmInSeconds: step.nextBoundarySeconds, ladderStep: step.step ?? null };
  }
  return { ...result, ladderStep: step.step ?? null };
}

/**
 * `DEFERRED` — *"force widen + escalate"*.
 *
 * Two halves with two owners, and only one of them is a transition. The **force** is
 * §4.4's `DEFERRED | next round | QUEUED` row: it is unguarded, so a deferral that has
 * outlived `assign.max_deferral_time` ends whether or not anything else is available.
 * That half is performed here and it is the half that matters — §8.8 and §17.4 both turn
 * on deferral never becoming *"indefinite silence"*, and this is what makes it finite.
 *
 * The **widen** is §17.4 ladder steps 1 and 2 (radius, then availability classes), and it
 * is recorded as a directive for the round rather than performed, for the same reason
 * `assessLag` names a degraded mode it does not enter: performing it here would be a
 * second ladder, disagreeing with the first the day it arrives.
 *
 * @param {object} ctx
 * @returns {Promise<object>}
 */
async function forceWidenAndEscalate(ctx) {
  const result = await attemptTransition(ctx, { event: transitions.EVENT.NEXT_ROUND });
  if (result.disposition === DISPOSITION.TRANSITIONED) {
    ctx.record("timer.widen_directive", {
      legId: ctx.entity.id,
      // §17.4 steps 1 and 2, named in the ladder's own vocabulary so the module that
      // arrives consumes them rather than reinterpreting them.
      widen: ["SEARCH_RADIUS", "ADMIT_FINISHING_SOON_AND_CHARGING_INTERRUPTIBLE"],
      cause: "MAX_DEFERRAL_TIME_ELAPSED",
      ownedBy: "§17.4 — REMEDIAL PHASE T1-04, fairness/ladder.js",
    });
  }
  return result;
}

/**
 * `PLANNED` — *"harden or re-plan"*.
 *
 * The disjunction is decided by whether §10.3's commit guards pass, and they can only be
 * evaluated by the component holding the plan: the SOFT reservation lives in the
 * coordinator's **in-memory** plan state (§2.6), and a timer worker cannot see it. So the
 * branch is taken on evidence the caller supplies, and the absence of that evidence is
 * not a coin toss — it is itself the answer.
 *
 * A hardening deadline that passed with no coordinator asserting the guards means no
 * coordinator hardened it, which is exactly the case §4.3 wrote "or re-plan" for. The
 * re-plan branch discards the SOFT reservation and returns the Leg to `QUEUED`; nothing
 * durable is undone, because nothing durable was ever written — §2.6 and §4.4's third
 * scope note both say a `PLANNED` Leg has no commitment and no fence.
 *
 * @param {object} ctx
 * @returns {Promise<object>}
 */
async function hardenOrReplan(ctx) {
  const evidence = ctx.deps && typeof ctx.deps.commitGuardsPassFor === "function"
    ? await ctx.deps.commitGuardsPassFor({ leg: ctx.entity, storeTime: ctx.storeTime })
    : undefined;

  if (evidence === true) {
    const hardened = await attemptTransition(ctx, {
      event: transitions.EVENT.HARDENING_DUE,
      context: { commitGuardsPass: true },
    });
    // A refused hardening still leaves a Leg past its hardening deadline, and §4.3's
    // "or" is what it does next. Falling through rather than re-arming is the difference
    // between "harden or re-plan" and "harden, or wait and try hardening again".
    if (hardened.disposition !== DISPOSITION.REFUSED) return hardened;
  }

  return attemptTransition(ctx, {
    event: transitions.EVENT.HARDENING_DEADLINE_ELAPSED,
    data: undefined,
  });
}

/**
 * `OFFERED` — *"withdraw, exclude agent, re-plan"*.
 *
 * §11.4 step 2's withdrawal is already implemented once, in `dispatch/offers.js`, and it
 * is not a Leg write with a command beside it: it advances the agent's fence counter,
 * signs and enqueues a `WITHDRAW` at the advanced fence, moves the Leg, releases the
 * commitment, and updates the I6 high-water mark — *in one transaction*, because §4.1
 * rule 5 says the fence advance and the command it authorises cannot be separated. So
 * this handler calls that, rather than performing a §4.4 transition and leaving the
 * command to somebody.
 *
 * **It is also not the only caller.** `outbox.worker` reaches the same function through
 * §11.4's escalation ladder, from the *delivery* side, and the two can race — the offer
 * whose TTL expires is often the offer that was never delivered. The race is safe and
 * both orders are correct: `withdrawExpiredOffer` writes the Leg conditionally on its
 * version and aborts the whole transaction when that write matches no row, so the loser
 * rolls back its fence advance and its `WITHDRAW` together and this handler reports
 * `LOST_RACE`. That is §4.1 rule 2 deciding between two supervisors, which §12.4 says is
 * the normal case rather than an error.
 *
 * @param {object} ctx
 * @returns {Promise<object>}
 */
async function withdrawExcludeReplan(ctx) {
  const leg = ctx.entity;
  const { commitment, agent } = await readIncumbent(ctx, leg);

  if (!commitment || !agent) {
    // The offer's commitment is already released — the agent ACKed, NACKed, or another
    // withdrawal won. There is nothing to withdraw, and the Leg's own version is what
    // will discard this timer on its next fire.
    return { disposition: DISPOSITION.NOTHING_TO_DO, outcome: "COMMITMENT_ALREADY_RELEASED" };
  }
  if (ctx.config.signingKey === undefined || ctx.config.signingKey === null || ctx.config.signingKey === "") {
    // §23.3 — every command carries a signature. An unsigned `WITHDRAW` is a command the
    // agent must reject, so issuing one would be a withdrawal that did not withdraw.
    return { disposition: DISPOSITION.DEPENDENCY_UNAVAILABLE, outcome: "NO_SIGNING_KEY" };
  }
  // `withdrawExpiredOffer` needs both durations and throws on either being absent, which
  // would roll the fire back and re-arm it — safe, but reported as `HANDLER_THREW` rather
  // than as the configuration gap it is. Checked here so the outcome names the parameter.
  // Found by running this path against live PostgreSQL: the first version of this handler
  // omitted `nackCooloffSeconds` entirely and every withdrawal threw.
  for (const [name, value] of [
    ["dispatch.max_delivery_delay", ctx.config.maxDeliveryDelaySeconds],
    ["dispatch.nack_cooloff", ctx.config.nackCooloffSeconds],
  ]) {
    if (!Number.isFinite(value) || value <= 0) {
      return { disposition: DISPOSITION.DEPENDENCY_UNAVAILABLE, outcome: `PARAMETER_UNRESOLVED:${name}` };
    }
  }

  const withdrawn = await offers.withdrawExpiredOffer(ctx.tx, {
    commitment,
    agent,
    leg,
    storeTime: ctx.storeTime,
    maxDeliveryDelaySeconds: ctx.config.maxDeliveryDelaySeconds,
    nackCooloffSeconds: ctx.config.nackCooloffSeconds,
    signingKey: ctx.config.signingKey,
    reason: "OFFER_TTL_EXPIRED",
  });

  // §11.2's exclusion window and §4.4's "exclude agent for `dispatch.nack_cooloff`" —
  // reported for the availability index and the round to honour, and taken from
  // `withdrawExpiredOffer`'s own return rather than recomputed here, so there is one
  // implementation of the window and not two that can disagree.
  ctx.record("timer.offer_withdrawn", {
    legId: leg.id,
    agentId: agent.id,
    commitmentId: commitment.commitmentId,
    withdrawalFence: String(withdrawn.withdrawalFence ?? ""),
    excludeAgentUntil: withdrawn.excludeAgentUntil ? withdrawn.excludeAgentUntil.toISOString() : null,
  });

  // `withdrawExpiredOffer` writes the Leg itself and does not run the §4.4 table, so the
  // OFFERED timer must be cancelled and the QUEUED one registered here — inside this same
  // transaction, which is what §4.5 requires and what makes the two writes one.
  await timers.cancelFor(ctx.tx, {
    entityType: timers.ENTITY_TYPE.LEG,
    entityId: leg.id,
    storeTime: ctx.storeTime,
    reason: "EXITED_OFFERED",
  });
  const queuedDeadline = deadlineSecondsFor(ctx.config, timers.ENTITY_TYPE.LEG, legMachine.LEG_STATE.QUEUED);
  if (queuedDeadline === undefined) {
    // Rolling the whole transaction back is the only honest option: committing the
    // withdrawal while failing to arm the requeued Leg's deadline produces exactly the
    // unsupervised state §4.5 exists to prevent, and it would be produced here.
    throw new RangeError(
      "sla.assignment_deadline did not resolve, so the requeued Leg could not be armed. §4.5 registers a state's " +
        "deadline in the transaction that enters it; a withdrawal committed without one leaves a QUEUED Leg no " +
        "component owns.",
    );
  }
  await timers.register(ctx.tx, {
    entityType: timers.ENTITY_TYPE.LEG,
    entityId: leg.id,
    state: legMachine.LEG_STATE.QUEUED,
    entity: { ...leg, version: leg.version + 1 },
    dueAt: timers.deadlineFrom(ctx.storeTime, queuedDeadline),
    armedSeconds: queuedDeadline,
    handler: legMachine.deadlineFor(legMachine.LEG_STATE.QUEUED).onExpiry,
    payload: { from: legMachine.LEG_STATE.OFFERED, event: transitions.EVENT.OFFER_TTL_EXPIRY },
    shardId: ctx.timer.shardId === null ? undefined : ctx.timer.shardId,
  });

  return {
    disposition: DISPOSITION.TRANSITIONED,
    outcome: `OFFERED→QUEUED via WITHDRAWN (fence ${String(withdrawn.withdrawalFence ?? "?")})`,
  };
}

/**
 * `ACCEPTED` — *"probe, then reassign"*.
 *
 * The probe is a **query**: §10.3.1's third row makes `STATUS_REQUEST` and `PROBE`
 * side-effect-free, *"always answered; never fenced"*, and `dispatch/outbox.buildRow`
 * refuses to enqueue one by name — a query given durable fenced delivery would have the
 * authority the table denies it. A probe is therefore a live transport call, not
 * something a timer worker can perform durably, and it is injected.
 *
 * Its absence does not change the outcome, and that is the honest reading of §4.4 rather
 * than a convenience: the row's target is `REASSIGNING` and the probe is listed among its
 * side effects. An agent that answers the probe by departing moves the Leg to
 * `EN_ROUTE_PICKUP` on its own path, and this timer then discards on the version. So the
 * probe informs and the deadline acts; a missing probe costs a diagnostic, not a decision,
 * and is recorded as such.
 *
 * The reassignment itself runs §4.7's custody-`NONE` protocol through
 * `lifecycle/reassignment.js` — the Leg freeze, the fence advance, the `RECALL` at the
 * new fence, and the release, in one transaction — rather than a bare state write, because
 * §4.4 scopes this row's write to the commitment and the recall is what makes it safe when
 * the incumbent is unreachable, which after an elapsed start grace it may well be.
 *
 * @param {object} ctx
 * @returns {Promise<object>}
 */
async function probeThenReassign(ctx) {
  const leg = ctx.entity;

  // §4.4's guard on this row, **evaluated rather than restated**. The first version of this
  // handler restated it as `custody.holdsGoods(...)`, and that is a *different and laxer*
  // predicate: `holdsGoods` answers false for `PENDING_TRANSFER`, which is custody mid-handoff
  // and emphatically not "no custody". §4.4's guard reads `custodyState === "NONE"`, so the
  // restatement admitted a Leg whose goods were being handed between two parties and
  // reassigned it away from both. Caught by a test that asked what the two predicates
  // actually answer instead of assuming they agreed — which is the same drift Phase 5's
  // earlier remediation found between `leaseExpiryTarget` and `assessRecovery`.
  //
  // `reassign` applies §4.7's own custody bar underneath this, which is a different question
  // — "are the goods physically inside the incumbent" — and both are wanted.
  const noCustody = transitions.GUARD_EVALUATORS[transitions.GUARD.NO_CUSTODY]({ leg });
  if (!noCustody.ok) {
    return {
      disposition: DISPOSITION.REFUSED,
      outcome: `CUSTODY_NOT_NONE:${leg.custodyState}`,
      detail:
        "§4.4's start-grace row is guarded on `no custody`, and §4.7 gives a failure with custody three lawful " +
        `outcomes of which reassignment is not one. ${noCustody.detail}`,
    };
  }

  let probed = null;
  if (ctx.deps && typeof ctx.deps.probe === "function") {
    try {
      probed = await ctx.deps.probe({ legId: leg.id, storeTime: ctx.storeTime });
    } catch (error) {
      probed = { answered: false, error: error && error.message };
    }
  }
  ctx.record("timer.start_grace_probe", {
    legId: leg.id,
    probed: probed !== null,
    answered: probed ? probed.answered === true : null,
    detail: probed === null ? "no probe transport injected (§10.3.1 row 3 is a live query, not an outbox command)" : null,
  });

  const { commitment, agent, all } = await readIncumbent(ctx, leg);
  if (!commitment || !agent) {
    return { disposition: DISPOSITION.NOTHING_TO_DO, outcome: "NO_ACTIVE_COMMITMENT" };
  }
  if (ctx.config.signingKey === undefined || ctx.config.signingKey === null || ctx.config.signingKey === "") {
    return { disposition: DISPOSITION.DEPENDENCY_UNAVAILABLE, outcome: "NO_SIGNING_KEY" };
  }

  const result = await reassignment.reassign(ctx.tx, {
    leg,
    agent,
    commitment,
    legCommitments: all,
    storeTime: ctx.storeTime,
    trigger: reassignment.TRIGGER.LEASE_EXPIRY,
    maxReassignmentsPerLeg: ctx.config.maxReassignmentsPerLeg,
    incumbentCooloffSeconds: ctx.config.incumbentCooloffSeconds,
    reassignBudgetSeconds: ctx.config.reassignBudgetSeconds,
    maxDeliveryDelaySeconds: ctx.config.maxDeliveryDelaySeconds,
    signingKey: ctx.config.signingKey,
    shardId: ctx.timer.shardId === null ? undefined : ctx.timer.shardId,
  });

  return translateReassignment(ctx, result);
}

/**
 * `EN_ROUTE_PICKUP` / `EN_ROUTE_DROP` — *"progress probe (§12.3)"*.
 *
 * The deadline these states carry is `projected ETA × execute.eta_tolerance`, so its
 * expiry **is** §12.3's ETA-drift signal: the realised duration has exceeded the projected
 * one by more than the tolerance, which is what `progress.assessEtaDrift` decides and what
 * §4.4's `ETA breach` row responds to — *"re-project, may set task `AT_RISK`"*.
 *
 * The re-projection is the plan's (Phase 8's timeline, Phase 10's round) and the Task
 * write is unavailable — no engine path writes a §4.2 Task state, because the legacy
 * vocabulary is in use until the Phase 15 cutover and `taskMachine.js` declines to invent
 * the mapping. Both are therefore emitted as directives beside a transition that is real:
 * the self-transition bumps the Leg's version, which re-arms supervision at the new
 * version and is what an ETA breach on a still-moving Leg should produce.
 *
 * §12.3's *"consider reassignment if pre-custody"* is consulted rather than performed —
 * the assessor's own `considerReassignment` is true only pre-custody, and choosing to act
 * on it is a re-planning decision priced against `C_churn` (§8.9), not a timeout's.
 *
 * @param {object} ctx
 * @returns {Promise<object>}
 */
async function progressProbe(ctx) {
  const leg = ctx.entity;
  const elapsedSeconds = Math.max(
    0,
    (ctx.storeTime.getTime() - new Date(ctx.timer.createdAt).getTime()) / MS_PER_SECOND,
  );

  let signal = null;
  if (Number.isFinite(ctx.config.etaTolerance) && ctx.config.etaTolerance >= 1) {
    // The projected duration is what this timer was armed for: `dueAt − createdAt` is
    // literally `projected ETA × tolerance` as it was resolved on entry, so dividing it
    // back out recovers the projection without a second, drifting source for it.
    const armedSeconds = Math.max(1, timers.armedSecondsOf(ctx.timer) || 1);
    signal = progress.assessEtaDrift({
      projectedDurationSeconds: armedSeconds / ctx.config.etaTolerance,
      realisedDurationSeconds: elapsedSeconds,
      etaTolerance: ctx.config.etaTolerance,
      custodyState: leg.custodyState,
    });
  }

  const result = await attemptTransition(ctx, { event: transitions.EVENT.ETA_BREACH });

  ctx.record("timer.progress_probe", {
    legId: leg.id,
    state: leg.state,
    elapsedSeconds,
    signal: signal ? signal.reason : "ETA_TOLERANCE_UNRESOLVED",
    considerReassignment: signal ? signal.considerReassignment === true : null,
    // §12.3 row 2's response, named for the owners that perform it rather than performed
    // by a timeout that can see neither the plan nor the Task.
    directives: {
      reproject: "Phase 8 — plan/timeline.js",
      setTaskAtRisk: "Phase 15 — no engine path writes a §4.2 Task state before the cutover",
      notifyCustomer: "Phase 15",
    },
  });

  return result;
}

/**
 * `AT_PICKUP` / `AT_DROP` — *"operator alert"*.
 *
 * §4.3 names an action and **no target state**, and that is not an omission: an agent that
 * has been servicing a Stop beyond `stop.service_time_limit` is doing something a database
 * cannot resolve — a jammed compartment, a customer who has not come to the door, a
 * loading bay in use. §4.4 gives both states only their real exits (`custody acquired` /
 * `pickup impossible`, `custody released`), and moving the Leg on a timeout would either
 * abandon a pickup that is thirty seconds from succeeding or claim a custody event that
 * did not happen.
 *
 * So this alerts and does not transition, and the timer is re-armed — which makes the
 * alert *repeat* at the service-time cadence for as long as the Stop is over its limit,
 * rather than firing once and going quiet, and `attempts` on the timer row is the durable
 * count of how long it has been over.
 *
 * @param {object} ctx
 * @returns {Promise<object>}
 */
async function operatorAlert(ctx) {
  const leg = ctx.entity;
  ctx.record("timer.operator_alert", {
    legId: leg.id,
    state: leg.state,
    custodyState: leg.custodyState,
    parameter: legMachine.deadlineFor(leg.state).parameter,
    // The count is what turns a repeated alert into a severity: the first is a slow
    // service, the twentieth is an agent nobody has been to.
    consecutiveExpiries: ctx.timer.attempts + 1,
    overdueSeconds: Math.max(0, (ctx.storeTime.getTime() - new Date(ctx.timer.dueAt).getTime()) / MS_PER_SECOND),
  });
  return { disposition: DISPOSITION.ACTED_WITHOUT_TRANSITION, outcome: "OPERATOR_ALERTED" };
}

/**
 * `RELEASED` / Task `VERIFYING` — *"verification escalation"*.
 *
 * §4.4's row is `RELEASED | evidence insufficient | task VERIFYING | — | operator queue`,
 * and it is deliberately a self-transition on the Leg: the goods are delivered and the
 * Leg does not move backwards, it waits for evidence. §12.5's graded verification is what
 * decides whether the evidence is sufficient, and the deadline passing is the statement
 * that it did not arrive within `verify.evidence_deadline`.
 *
 * The Leg's self-transition bumps its version, which re-arms the deadline at the new
 * version, so an evidence gap escalates on every cycle rather than once — which is what
 * `RELEASED` needs, because a Leg stuck there is a delivery nobody can account for (I8).
 *
 * @param {object} ctx
 * @returns {Promise<object>}
 */
async function verificationEscalation(ctx) {
  if (ctx.timer.entityType === timers.ENTITY_TYPE.TASK) {
    ctx.record("timer.verification_escalation", {
      taskId: ctx.timer.entityId,
      state: ctx.timer.state,
      consecutiveExpiries: ctx.timer.attempts + 1,
      operatorQueue: true,
    });
    return { disposition: DISPOSITION.ACTED_WITHOUT_TRANSITION, outcome: "TASK_VERIFICATION_ESCALATED" };
  }

  const result = await attemptTransition(ctx, { event: transitions.EVENT.EVIDENCE_INSUFFICIENT });
  ctx.record("timer.verification_escalation", {
    legId: ctx.entity.id,
    consecutiveExpiries: ctx.timer.attempts + 1,
    operatorQueue: true,
    // §4.4's other half of this row. The Leg write is real; the Task write is not
    // available before the cutover, and saying so is better than a silent half-effect.
    taskVerifying: "Phase 15 — no engine path writes a §4.2 Task state before the cutover",
  });
  return result;
}

/**
 * `ABORTING` — *"force to the applicable `STRANDED_*` state"*.
 *
 * §4.3 states the consequence in its own words and §4.4 supplies no row for it, so
 * `transitions.js` carries one marked `SECTION_4_3_SOURCED`. The applicable state is
 * `legMachine.strandingStateFor`, the same derivation the blocking-fault row uses, which
 * is what keeps invariant I22's `INDETERMINATE → STRANDED_OBSTRUCTING` default in one
 * place: an abort whose stopping location cannot be classified is treated as the more
 * serious case, exactly as §4.3 requires and for the reason it gives.
 *
 * The obstruction class is read from the Leg's own column, which the Map service writes
 * and no operator does.
 *
 * @param {object} ctx
 * @returns {Promise<object>}
 */
async function forceStranded(ctx) {
  const leg = ctx.entity;
  const stranding = legMachine.strandingStateFor(leg.obstructionClass);

  const result = await attemptTransition(ctx, {
    event: transitions.EVENT.ABORT_BUDGET_EXPIRY,
    context: { obstructionClass: leg.obstructionClass },
  });

  if (result.disposition === DISPOSITION.TRANSITIONED) {
    ctx.record("timer.force_stranded", {
      legId: leg.id,
      to: stranding.state,
      obstructionClass: stranding.obstructionClass,
      externalEscalation: stranding.externalEscalation,
      responseTargetParameter: stranding.responseTargetParameter,
      cause: "RECOVER_ABORT_BUDGET_ELAPSED",
    });
  }
  return result;
}

/**
 * `STRANDED_SAFE` — *"page operations"*, and `STRANDED_OBSTRUCTING` — *"page operations
 * **and** the external escalation chain (§18.6)"*.
 *
 * Neither transitions: a stranding ends when a responder physically attends, which §4.4
 * expresses as `goods and agent recovered` guarded on custody being accounted for. What
 * the deadline means is that the **response target** was missed — four hours for a
 * `CLEAR` stopping location, forty-five minutes for a `RESTRICTIVE` one, ten minutes for
 * an obstructing one — and a missed response target is exactly the event §4.3 built two
 * states to distinguish.
 *
 * For the obstructing case the chain is §18.6's and it has one implementation,
 * `failure/externalEscalation.js`, with a durable home on `ExternalEscalation`. This
 * writes a further step-1 attempt rather than opening a second chain: §18.6's rows are
 * *"one row per step attempt, so the chain is a history rather than a status field"*, and
 * a responder who has not arrived within the target needs paging again, not a second
 * incident. Step 4 is unreachable from here, as it is from every automatic path — the
 * eligibility is computed and recorded so an operator is *offered* the decision, and
 * `confirmEmergencyServices` remains the only way to take it.
 *
 * @param {object} ctx
 * @returns {Promise<object>}
 */
async function pageOperations(ctx) {
  const leg = ctx.entity;
  const stranding = legMachine.strandingStateFor(leg.obstructionClass);
  const obstructing = leg.state === legMachine.LEG_STATE.STRANDED_OBSTRUCTING;

  ctx.record("timer.stranding_response_target_missed", {
    legId: leg.id,
    state: leg.state,
    obstructionClass: stranding.obstructionClass,
    responseTargetParameter: legMachine.deadlineFor(leg.state).parameter,
    consecutiveExpiries: ctx.timer.attempts + 1,
    overdueSeconds: Math.max(0, (ctx.storeTime.getTime() - new Date(ctx.timer.dueAt).getTime()) / MS_PER_SECOND),
    custodyState: leg.custodyState,
    externalEscalation: obstructing,
  });

  if (!obstructing) {
    return { disposition: DISPOSITION.ACTED_WITHOUT_TRANSITION, outcome: "OPERATIONS_PAGED" };
  }

  const escalationContext =
    ctx.deps && typeof ctx.deps.readEscalationContext === "function"
      ? await ctx.deps.readEscalationContext(leg)
      : {};
  const contactSet = externalEscalation.resolveContactSet({
    contacts: ctx.config.escalationContacts ?? null,
    regionId: escalationContext.regionId ?? ctx.config.regionId ?? null,
    nowMs: ctx.storeTime.getTime(),
    reviewPeriodSeconds: ctx.config.contactReviewPeriodSeconds,
  });

  const chain = externalEscalation.openChain({
    leg: { legId: leg.legId, state: leg.state, obstructionClass: leg.obstructionClass },
    context: escalationContext,
    contactSet,
    atMs: ctx.storeTime.getTime(),
  });
  if (!chain.opened) {
    return { disposition: DISPOSITION.ACTED_WITHOUT_TRANSITION, outcome: `CHAIN_REFUSED:${chain.reason}` };
  }

  const eligibility = externalEscalation.emergencyServicesEligible({
    obstructionClass: leg.obstructionClass,
    hazardState: escalationContext.hazardState ?? externalEscalation.HAZARD_STATE.UNKNOWN,
    threshold: ctx.config.emergencyServicesThreshold ?? null,
  });

  for (const step of chain.steps) {
    // eslint-disable-next-line no-await-in-loop
    await ctx.tx.externalEscalation.create({
      data: {
        legId: leg.id,
        step: step.step,
        obstructionClass: leg.obstructionClass,
        hazardState: escalationContext.hazardState ?? externalEscalation.HAZARD_STATE.UNKNOWN,
        contactSet: step.step === externalEscalation.STEP.NOTIFY_INFRASTRUCTURE_OPERATOR ? contactSet : null,
        disposition: step.disposition,
        detail: {
          payload: step.payload,
          ...(step.missingFields ? { missingFields: step.missingFields } : {}),
          ...(step.detail ? { note: step.detail } : {}),
          // What distinguishes this attempt from the chain's opening: the response target
          // has now been missed, and this is the nth time.
          responseTargetMissed: true,
          consecutiveExpiries: ctx.timer.attempts + 1,
          ...(step.step === externalEscalation.STEP.PAGE_RESPONDER
            ? {
                emergencyServicesEligible: eligibility.eligible,
                emergencyServicesReason: eligibility.reason,
                humanGated: true,
                openedBy: "supervision/expiryActions.js pageOperations (§4.3 response target)",
              }
            : {}),
        },
        occurredAt: ctx.storeTime,
      },
    });
  }

  return {
    disposition: DISPOSITION.ACTED_WITHOUT_TRANSITION,
    outcome: `OPERATIONS_PAGED_AND_EXTERNALLY_ESCALATED:${chain.steps.length}`,
  };
}

/**
 * `REASSIGNING` — *"escalate"*.
 *
 * §4.7 says what that means: *"`recover.max_reassignments_per_leg` (default 3) caps the
 * chain; on exhaustion the Leg goes to `SUSPENDED` for operator decision."* §4.3 has no
 * Leg `SUSPENDED` state — `SUSPENDED` is the Task's, §4.2 — and
 * `lifecycle/reassignment.js` already resolved that inconsistency the only way it can be
 * resolved without inventing a twentieth Leg state: the Leg is **frozen in `REASSIGNING`**
 * and the *Task* is what suspends. This follows that precedent rather than setting a
 * second one.
 *
 * So there is no transition to attempt, and there should not be. A Leg sitting in
 * `REASSIGNING` past `recover.reassign_budget` is one no round has picked up, and the
 * escalation is a person being told. The Task write is unavailable before the cutover and
 * is emitted as a directive, which is the same honest half-effect `progressProbe` reports.
 *
 * @param {object} ctx
 * @returns {Promise<object>}
 */
async function escalate(ctx) {
  const leg = ctx.entity;
  const commitments = await ctx.tx.commitment.findMany({ where: { legId: leg.id } });
  const bound = reassignment.assessChainBound({
    commitments,
    maxReassignmentsPerLeg: Number.isInteger(ctx.config.maxReassignmentsPerLeg) ? ctx.config.maxReassignmentsPerLeg : 0,
  });

  ctx.record("timer.reassignment_escalated", {
    legId: leg.id,
    custodyState: leg.custodyState,
    chainLength: bound.chainLength,
    chainExhausted: !bound.permitted,
    consecutiveExpiries: ctx.timer.attempts + 1,
    // §4.7's own words, and the reason the Leg does not move: there is no Leg SUSPENDED.
    taskState: taskMachine.TASK_STATE.SUSPENDED,
    taskWrite: "Phase 15 — no engine path writes a §4.2 Task state before the cutover",
  });

  return { disposition: DISPOSITION.ACTED_WITHOUT_TRANSITION, outcome: `REASSIGNMENT_ESCALATED:${bound.chainLength}` };
}

// ── §4.2 — the Task actions ────────────────────────────────────────────────

/**
 * The Task-side actions, which share one structural fact: **§4.2 has no transition
 * table**. §4.3's machine has §4.4; §4.2's has a state table with an exit-deadline column
 * and nothing that says what a Task moves to on any event.
 *
 * Writing one here would be inventing the customer-visible contract's semantics, which is
 * the thing this exercise is least entitled to do — and `taskMachine.js` already refuses
 * the adjacent temptation for the same reason: *"No mapping between the two is offered
 * here — inventing one would be deciding the cutover semantics four phases early, and
 * Phase 15 owns that."*
 *
 * So each of these performs the part §4.2 does state — the deadline passed, and here is
 * what it was waiting for — and re-arms. They are **not dead code and not decoration**:
 * a timer that fires with no registered handler stays `PENDING` for ever and reports
 * `HANDLER_NOT_REGISTERED`, which is a deadline nobody owns. These own it.
 *
 * They are, today, **unreachable in production**, and that is a separate fact recorded in
 * the closure document rather than hidden here: no path anywhere registers a
 * `TASK`-entity timer, because no engine path writes a §4.2 Task state at all before the
 * Phase 15 cutover.
 *
 * @param {string} action
 * @param {string} awaiting what the Task is waiting for, in §4.2's own terms
 * @returns {(ctx: object) => Promise<object>}
 */
function taskDeadlinePassed(action, awaiting) {
  return async function handler(ctx) {
    ctx.record("timer.task_deadline_passed", {
      taskId: ctx.timer.entityId,
      state: ctx.timer.state,
      action,
      awaiting,
      parameter: taskMachine.deadlineFor(ctx.timer.state)
        ? taskMachine.deadlineFor(ctx.timer.state).parameter
        : null,
      consecutiveExpiries: ctx.timer.attempts + 1,
      overdueSeconds: Math.max(0, (ctx.storeTime.getTime() - new Date(ctx.timer.dueAt).getTime()) / MS_PER_SECOND),
      operatorQueue: true,
      transitionOwner:
        "§4.2 declares no transition table; the Task write is Phase 15's cutover, which owns the legacy↔engine " +
        "vocabulary mapping (lifecycle/taskMachine.js)",
    });
    return { disposition: DISPOSITION.ACTED_WITHOUT_TRANSITION, outcome: action };
  };
}

// ── §12.2 — the commitment action ──────────────────────────────────────────

/**
 * A commitment's lease deadline — §12.2's expiry, §4.7's custody-aware recovery.
 *
 * The choice between §4.7's outcomes is `supervision/leases.assessRecovery`'s and it is
 * implemented once; this reports what it decides and executes it. Custody `NONE` runs the
 * custody-`NONE` protocol through `reassignment.reassign`. Custody that may hold goods
 * does **not**: §4.7 gives three lawful outcomes for that case and requires the engine to
 * *"choose explicitly rather than defaulting"*, and two of the three — Resume and Transfer
 * — need evidence about the agent that a lease expiry, by construction, does not have. So
 * the assessment is run with what is known, and where it names physical recovery the Leg
 * is stranded at the class the stopping location implies.
 *
 * `DISPUTED` takes the physical-recovery path, not the reassignment one, because
 * `domain/custody.holdsGoods` answers true for it — contested custody resolves to the
 * conservative case (§2.5, T2). That agreement between this path and §4.4's lease-expiry
 * row is the defect Phase 5's earlier remediation fixed, and it is why both read
 * `assessRecovery` rather than restating it.
 *
 * @param {object} ctx
 * @returns {Promise<object>}
 */
async function leaseExpiryRecovery(ctx) {
  const commitment = ctx.entity;
  const leg = await ctx.tx.leg.findUnique({ where: { id: commitment.legId } });
  if (!leg) {
    return { disposition: DISPOSITION.NOTHING_TO_DO, outcome: "LEG_NO_LONGER_EXISTS" };
  }
  if (legMachine.isTerminal(leg.state)) {
    return { disposition: DISPOSITION.NOTHING_TO_DO, outcome: `LEG_TERMINAL:${leg.state}` };
  }
  if (commitment.releasedAt !== null) {
    return { disposition: DISPOSITION.NOTHING_TO_DO, outcome: "COMMITMENT_ALREADY_RELEASED" };
  }

  const assessment = leases.assessRecovery({
    leg,
    custodyState: leg.custodyState,
    obstructionClass: leg.obstructionClass,
    // Resume and Transfer both require positively-supplied evidence about the incumbent.
    // A lease expiry is the *absence* of evidence, so none is asserted here and
    // `assessRecovery` takes its explicit default rather than falling through to one.
    ...(ctx.deps && typeof ctx.deps.recoveryEvidenceFor === "function"
      ? await ctx.deps.recoveryEvidenceFor({ leg, commitment, storeTime: ctx.storeTime })
      : {}),
  });

  ctx.record("timer.lease_expiry_recovery", {
    commitmentId: commitment.commitmentId,
    legId: leg.id,
    custodyState: leg.custodyState,
    outcome: assessment.outcome,
    reason: assessment.reason,
    legState: assessment.legState,
    externalEscalation: assessment.externalEscalation,
  });

  if (assessment.outcome === leases.RECOVERY_OUTCOME.REASSIGN) {
    const agent = await ctx.tx.agent.findUnique({ where: { id: commitment.agentId } });
    const all = await ctx.tx.commitment.findMany({ where: { legId: leg.id } });
    if (!agent) return { disposition: DISPOSITION.NOTHING_TO_DO, outcome: "AGENT_MISSING" };
    if (ctx.config.signingKey === undefined || ctx.config.signingKey === null || ctx.config.signingKey === "") {
      return { disposition: DISPOSITION.DEPENDENCY_UNAVAILABLE, outcome: "NO_SIGNING_KEY" };
    }
    const result = await reassignment.reassign(ctx.tx, {
      leg,
      agent,
      commitment,
      legCommitments: all,
      storeTime: ctx.storeTime,
      trigger: reassignment.TRIGGER.LEASE_EXPIRY,
      maxReassignmentsPerLeg: ctx.config.maxReassignmentsPerLeg,
      incumbentCooloffSeconds: ctx.config.incumbentCooloffSeconds,
      reassignBudgetSeconds: ctx.config.reassignBudgetSeconds,
      maxDeliveryDelaySeconds: ctx.config.maxDeliveryDelaySeconds,
      signingKey: ctx.config.signingKey,
      shardId: ctx.timer.shardId === null ? undefined : ctx.timer.shardId,
    });
    return translateReassignment(ctx, result);
  }

  // Resume, Transfer, and physical recovery all resolve through §4.4's lease-expiry row,
  // whose target *is* `assessRecovery`'s decision — `leaseExpiryTarget` reads it. Running
  // it through `apply` rather than writing the state is what evaluates the row's scope and
  // performs the conditional write and the timer obligations.
  return attemptTransition(
    { ...ctx, entity: leg },
    {
      event: transitions.EVENT.LEASE_EXPIRY,
      context: {
        leg,
        custodyState: leg.custodyState,
        obstructionClass: leg.obstructionClass,
      },
    },
  );
}

/**
 * `reassignment.reassign`'s outcomes, in this module's vocabulary.
 *
 * @param {object} ctx
 * @param {object} result
 * @returns {object}
 */
function translateReassignment(ctx, result) {
  if (result.outcome === reassignment.OUTCOME.REASSIGNED) {
    return { disposition: DISPOSITION.TRANSITIONED, outcome: `REASSIGNED:${result.releasedCommitmentId}` };
  }
  if (result.outcome === reassignment.OUTCOME.LOST_RACE) {
    return { disposition: DISPOSITION.LOST_RACE, outcome: result.reason };
  }
  if (result.outcome === reassignment.OUTCOME.SUSPENDED) {
    // §4.7's chain bound. The Leg stays in `REASSIGNING` and the deadline is re-armed, so
    // `ESCALATE` takes it from here — which is the state machine doing exactly what §4.7
    // describes rather than two mechanisms racing to suspend the same Task.
    ctx.record("timer.reassignment_chain_exhausted", {
      legId: ctx.entity.id,
      chainLength: result.chainLength,
      taskState: result.taskState,
    });
    return { disposition: DISPOSITION.REFUSED, outcome: `MAX_REASSIGNMENTS_EXHAUSTED:${result.chainLength}` };
  }
  return { disposition: DISPOSITION.REFUSED, outcome: `${result.outcome}:${result.reason}` };
}

/**
 * Build the handler map the timer worker's dependency contract asks for.
 *
 * Every key is a §4.2 / §4.3 "On expiry" action, and `assertComplete` — which the composer
 * and the build gate both call — is what stops a state added later from arriving with a
 * deadline and no owner.
 *
 * @param {object} [deps] optional collaborators: `ladder` (§17.4), `probe` (§10.3.1 row 3),
 *   `readEscalationContext` (§18.6), `commitGuardsPassFor` (§10.3), `recoveryEvidenceFor` (§4.7)
 * @returns {Record<string, Function>}
 */
function handlers(deps) {
  const collaborators = deps || {};
  const bind = (handler) => (ctx) => handler({ ...ctx, deps: collaborators });

  return Object.freeze({
    // §4.3
    ESCALATION_LADDER: bind(escalationLadder),
    FORCE_WIDEN_AND_ESCALATE: bind(forceWidenAndEscalate),
    HARDEN_OR_REPLAN: bind(hardenOrReplan),
    WITHDRAW_EXCLUDE_REPLAN: bind(withdrawExcludeReplan),
    PROBE_THEN_REASSIGN: bind(probeThenReassign),
    PROGRESS_PROBE: bind(progressProbe),
    OPERATOR_ALERT: bind(operatorAlert),
    VERIFICATION_ESCALATION: bind(verificationEscalation),
    FORCE_STRANDED: bind(forceStranded),
    PAGE_OPERATIONS: bind(pageOperations),
    PAGE_OPERATIONS_AND_EXTERNAL_ESCALATION: bind(pageOperations),
    ESCALATE: bind(escalate),
    // §4.2 — see `taskDeadlinePassed` for why none of these transitions.
    REJECT_OR_ESCALATE: bind(taskDeadlinePassed("REJECT_OR_ESCALATE", "intake validation")),
    DECOMPOSITION_STALLED: bind(taskDeadlinePassed("DECOMPOSITION_STALLED", "decomposition into Legs")),
    REPROJECT_TIMELINE: bind(taskDeadlinePassed("REPROJECT_TIMELINE", "the mission timeline projection")),
    OPERATOR_REVIEW: bind(taskDeadlinePassed("OPERATOR_REVIEW", "an operator or external resolution")),
    // §12.2
    LEASE_EXPIRY_RECOVERY: bind(leaseExpiryRecovery),
  });
}

/** @structural milliseconds per second — a unit conversion, not a threshold */
const MS_PER_SECOND = 1000;

module.exports = {
  DISPOSITION,
  declaredActions,
  declaredActionNames,
  assertComplete,
  handlers,
};

"use strict";

/**
 * The durable timer store (§4.5) — the mechanism that makes "stuck forever"
 * structurally impossible.
 *
 * > **Every deadline in §4.2 and §4.3 MUST be registered in the durable timer store at
 * > the moment the state is entered, and cancelled atomically with the state exit.**
 *
 * > This mechanism replaces, and structurally prevents, the entire family of baseline
 * > defects in which a state persisted forever because no component owned its
 * > progression.
 *
 * ── The keying rule, which is the whole module ──────────────────────────────
 * > **Timers are keyed on the supervised entity's own version, never on the agent's
 * > authority epoch.** A Leg timer is keyed `(leg, leg_id, state, leg.version)`; a
 * > commitment timer is keyed `(commitment, commitment_id, state, commitment.fence)`. A
 * > timer whose version no longer matches its own entity is discarded on fire, which
 * > makes late-firing timers harmless without requiring reliable cancellation.
 * >
 * > This keying is a correctness requirement, not a convention. Keying timers on the
 * > agent's epoch would mean that committing or releasing *any unrelated Leg on the same
 * > agent* invalidates every timer for every other Leg that agent is carrying — silently
 * > removing supervision from missions that are executing normally, which is exactly the
 * > failure class durable timers exist to make structurally impossible.
 *
 * That failure mode is silent by construction: an over-invalidated timer does not throw,
 * it simply never fires, and the mission it was supervising executes normally right up
 * until the day it does not. `register` therefore refuses an agent-scope version
 * outright rather than trusting the caller to have passed the right counter, and
 * `assessFire` is the discard rule stated once for every handler.
 *
 * ── Timers attempt; they never force ────────────────────────────────────────
 * > Timer handlers are subject to the same conditional-write discipline as any other
 * > transition. A timer never forces a state change; it *attempts* one.
 *
 * Nothing in this module writes an entity. It registers, cancels, selects, and judges
 * staleness; the attempt is the handler's, through `lifecycle/transitions.js`, and it is
 * a conditional write like any other.
 *
 * ── DB-authoritative, with no cache tier at all ─────────────────────────────
 * §3.3's cache-authority rule and the plan's Redis row for this phase agree: *"Timers
 * are **DB-authoritative**; Redis is not used for supervision state"*. The one Redis key
 * the plan names, `engine:timerlag`, is an SLI gauge written by the worker — a number an
 * operator reads, never a fact the engine acts on. This module imports no cache.
 *
 * Tier 0 (T0-08). Invariants I2, I4, I12.
 */

const clock = require("../commitment/clock");
const legMachine = require("../lifecycle/legMachine");
const taskMachine = require("../lifecycle/taskMachine");

/**
 * The three supervised entity kinds. §4.5 names Leg and commitment timers explicitly;
 * §4.2's Task deadlines require the third.
 * @structural the enumerated entity kinds a timer may supervise
 */
const ENTITY_TYPE = Object.freeze({
  LEG: "LEG",
  TASK: "TASK",
  COMMITMENT: "COMMITMENT",
});

/**
 * The timer's own lifecycle, mirrored by the `Timer_state_known` CHECK.
 * @structural the enumerated timer states
 */
const TIMER_STATE = Object.freeze({
  /** Registered on state entry, awaiting its instant. */
  PENDING: "PENDING",
  /** The handler ran and attempted its transition. */
  FIRED: "FIRED",
  /** The supervised state was exited; cancelled atomically with the exit. */
  CANCELLED: "CANCELLED",
  /** Fired late, and its entity's version had moved on (§4.5). */
  DISCARDED: "DISCARDED",
});

/** What `assessFire` decides. @structural the enumerated fire dispositions */
const FIRE_DISPOSITION = Object.freeze({
  APPLY: "APPLY",
  DISCARD_STALE_VERSION: "DISCARD_STALE_VERSION",
  DISCARD_STATE_CHANGED: "DISCARD_STATE_CHANGED",
  DISCARD_ENTITY_GONE: "DISCARD_ENTITY_GONE",
});

/**
 * The version field each entity kind supplies, named so a caller cannot pass the wrong
 * counter by accident and so the rule is documented where it is enforced.
 * @structural the §4.5 keying map
 */
const VERSION_SOURCE = Object.freeze({
  [ENTITY_TYPE.LEG]: "version",
  [ENTITY_TYPE.TASK]: "version",
  [ENTITY_TYPE.COMMITMENT]: "fence",
});

/**
 * Field names that are **never** a timer key's version, because they belong to the
 * agent scope. Passing one is the §4.5 defect, and it is refused by name rather than
 * left to a reviewer to notice.
 * @structural the agent-scope counters §4.5 forbids keying on
 */
const FORBIDDEN_VERSION_SOURCES = Object.freeze(["authorityEpoch", "authority_epoch", "fenceCounter", "fence_counter"]);

/**
 * The §4.5 key, serialised.
 *
 * @param {object} input
 * @param {string} input.entityType
 * @param {string} input.entityId
 * @param {string} input.state
 * @param {bigint|number|string} input.entityVersion
 * @param {string} input.handler
 * @returns {string}
 */
function timerKey(input) {
  const source = input || {};
  return [source.entityType, source.entityId, source.state, String(BigInt(source.entityVersion)), source.handler].join(
    ":",
  );
}

/**
 * Read the supervised entity's own version, refusing anything else.
 *
 * @param {string} entityType
 * @param {object} entity the row
 * @returns {bigint}
 */
function versionOf(entityType, entity) {
  const field = VERSION_SOURCE[entityType];
  if (!field) {
    throw new TypeError(`"${String(entityType)}" is not a supervised entity kind (§4.5)`);
  }
  const value = entity ? entity[field] : undefined;
  if (value === undefined || value === null) {
    throw new TypeError(
      `a ${entityType} timer is keyed on that entity's own "${field}" (§4.5), and the row supplied none. ` +
        "Keying on anything else — most dangerously the agent's authority_epoch — silently removes supervision " +
        "from every other mission the agent is carrying.",
    );
  }
  return BigInt(value);
}

/**
 * Does this state require a timer, per its own machine?
 *
 * @param {string} entityType
 * @param {string} state
 * @returns {boolean}
 */
function requiresTimer(entityType, state) {
  if (entityType === ENTITY_TYPE.LEG) return legMachine.requiresTimer(state);
  if (entityType === ENTITY_TYPE.TASK) return taskMachine.requiresTimer(state);
  // A commitment's supervised deadline is its lease (§12.2), which every active
  // commitment has by construction — `commit.js` refuses to grant one without.
  return true;
}

/**
 * The deadline specification for a state, from its own machine.
 *
 * @param {string} entityType
 * @param {string} state
 * @returns {object|null}
 */
function deadlineFor(entityType, state) {
  if (entityType === ENTITY_TYPE.LEG) return legMachine.deadlineFor(state);
  if (entityType === ENTITY_TYPE.TASK) return taskMachine.deadlineFor(state);
  return { parameter: "lease.duration", onExpiry: "LEASE_EXPIRY_RECOVERY" };
}

/**
 * §4.5 — register the deadline of a state the caller is entering.
 *
 * **Called inside the transition's own transaction.** A timer written afterwards can be
 * lost by a crash between the two writes, which produces exactly the unsupervised state
 * this store exists to prevent; a timer written before can supervise a transition that
 * rolled back. The same reasoning §4.1 rule 5 applies to commands applies here to
 * deadlines, and `requireTransaction` enforces it.
 *
 * Idempotent on the key: a retried transition, or a reconciler repair racing a timer
 * handler, yields one timer rather than two. That matters more than it looks — two
 * timers for one deadline both fire, both attempt the transition, and the second finds
 * the version moved on and discards, which is *correct* but doubles the handler load
 * during exactly the incident that produced the retry.
 *
 * **How that idempotency is delivered, precisely, because the two halves differ.** The
 * read-before-write below returns the existing row for a *sequential* retry. Under two
 * genuinely concurrent transactions that both read the key as absent, the winner creates
 * and the loser's `create` is refused by the `timerKey` unique index — its transaction
 * aborts and its caller sees the violation. Reproduced against live PostgreSQL during
 * Phase 5's remediation, where the review that raised it could only reason about it.
 *
 * That is the correct behaviour and not merely the tolerable one: **one timer exists
 * either way**, which is the property this comment is about, and the guarantee is the
 * database's rather than this function's. Catching the violation and re-reading is not
 * available as an alternative — PostgreSQL aborts the whole transaction on a constraint
 * violation, so there is no "read it again" to perform inside the caller's transaction
 * without a savepoint this module has no business opening. A loser that rolls back its
 * whole transition and retries is exactly §4.1 rule 2's discipline applied to the timer
 * store, and it leaves no partial state behind.
 *
 * @param {object} tx a Prisma transaction client
 * @param {object} input
 * @param {string} input.entityType
 * @param {string} input.entityId
 * @param {string} input.state the state being entered
 * @param {object} input.entity the entity row, read for its own version
 * @param {Date} input.dueAt absolute, from the store's clock (§10.6)
 * @param {string} input.handler
 * @param {object} [input.payload]
 * @param {string} [input.shardId]
 * @returns {Promise<object>} the timer row
 */
async function register(tx, input) {
  requireTransaction(tx, "registering a timer");
  const source = input || {};

  if (!ENTITY_TYPE[source.entityType]) {
    throw new TypeError(`"${String(source.entityType)}" is not a supervised entity kind (§4.5)`);
  }
  if (typeof source.entityId !== "string" || source.entityId === "") {
    throw new TypeError("a timer names the entity it supervises");
  }
  if (typeof source.handler !== "string" || source.handler === "") {
    throw new TypeError(
      "a timer names its handler. A timer with no handler is a deadline nobody owns, which is the defect §12.1 " +
        "opens by naming.",
    );
  }
  if (!(source.dueAt instanceof Date) || Number.isNaN(source.dueAt.getTime())) {
    throw new TypeError("a deadline is an absolute instant from the store's clock (§10.6)");
  }
  // §4.5's defence in depth, over the **entity the caller supplied** — which is the object
  // whose fields could be mistaken for a version, and therefore the only object on which
  // this check means anything. Until Phase 5's remediation it inspected `source` (the call
  // arguments) instead, where none of these names is ever passed, so it could not fire; the
  // supervised entity kinds carry no agent-scope counter, so an entity that has one is an
  // Agent row, or an entity object somebody widened with one, and both are the §4.5 defect.
  //
  // The structural guarantee is still `VERSION_SOURCE`, which reads only `version`/`fence`
  // and nothing else. This catches the case that guarantee cannot: an object that carries a
  // plausible `version` *and* an agent-scope counter, where the caller has conflated the two
  // scopes and the key would be right today by luck rather than by construction.
  for (const forbidden of FORBIDDEN_VERSION_SOURCES) {
    if (source.entity && Object.prototype.hasOwnProperty.call(source.entity, forbidden)) {
      throw new TypeError(
        `a timer may not be keyed on "${forbidden}" (§4.5). Keying on the agent's epoch invalidates every timer ` +
          "for every other Leg that agent is carrying, which removes supervision from missions that are executing " +
          "normally — silently, because an over-invalidated timer does not throw, it simply never fires.",
      );
    }
  }

  const entityVersion = versionOf(source.entityType, source.entity);
  const key = timerKey({
    entityType: source.entityType,
    entityId: source.entityId,
    state: source.state,
    entityVersion,
    handler: source.handler,
  });

  const payload = source.payload === undefined || source.payload === null ? {} : source.payload;
  // The interval this deadline was armed for, recorded rather than inferred. The re-arm
  // needs it, and `dueAt − createdAt` — the obvious inference — is wrong for any row a
  // caller registered with a `dueAt` that was already past, which a reconciler repair and
  // every test harness both do. It matters most for §4.3's two **projected** deadlines
  // (`EN_ROUTE_PICKUP`, `EN_ROUTE_DROP`), whose value is a mission ETA the register cannot
  // supply: this is the only durable record of what the plan projected.
  const withArmed =
    Number.isFinite(source.armedSeconds) && source.armedSeconds > 0
      ? { ...payload, armedSeconds: source.armedSeconds }
      : payload;

  const existing = await tx.timer.findUnique({ where: { timerKey: key } });
  if (existing) {
    if (existing.timerState === TIMER_STATE.PENDING) return existing;

    // PHASE 5 REMEDIATION. Returning the existing row unconditionally was wrong for a
    // **resolved** one, and wrong in the one direction that matters: the caller asked for
    // this state to be supervised, was handed a `FIRED`, `CANCELLED` or `DISCARDED` row,
    // and got no pending timer at all. The entity is then non-terminal and unsupervised —
    // invariant I4's violation, produced by the function whose job is to prevent it.
    //
    // It is reachable, and not only in theory. `transitions.apply` cancels every pending
    // timer for the entity on exit, *including the one currently firing*; a reconciler
    // repairing an unsupervised state finds the same key at the same version; and any
    // handler that acts without moving the entity leaves a resolved row on a live state.
    // Reproduced against live PostgreSQL: re-registering after a fire returned the fired
    // row and `findUnsupervised` went on reporting the Leg.
    //
    // So a resolved row at a live key is **re-armed**, not returned. One row still exists
    // — the key is unique and that is the idempotency this function promises — and it is
    // pending again, with `attempts` preserved so the history of the deadline survives.
    return tx.timer.update({
      where: { id: existing.id },
      data: {
        timerState: TIMER_STATE.PENDING,
        dueAt: source.dueAt,
        payload: withArmed,
        firedAt: null,
        resolvedAt: null,
        lastOutcome: `REARMED_FROM_${existing.timerState}`,
        shardId: source.shardId === undefined ? existing.shardId : source.shardId,
      },
    });
  }

  return tx.timer.create({
    data: {
      timerKey: key,
      entityType: source.entityType,
      entityId: source.entityId,
      state: source.state,
      entityVersion,
      dueAt: source.dueAt,
      handler: source.handler,
      payload: withArmed,
      timerState: TIMER_STATE.PENDING,
      shardId: source.shardId === undefined ? null : source.shardId,
    },
  });
}

/**
 * The interval a timer was armed for, in seconds.
 *
 * Prefers what `register` recorded; falls back to `dueAt − createdAt`, which is right for
 * every row registered with a future deadline and is all that older rows carry.
 *
 * @param {object} timer
 * @returns {number|undefined}
 */
function armedSecondsOf(timer) {
  const recorded = timer && timer.payload && timer.payload.armedSeconds;
  if (Number.isFinite(recorded) && recorded > 0) return recorded;
  if (!timer || !timer.dueAt || !timer.createdAt) return undefined;
  const derived = (new Date(timer.dueAt).getTime() - new Date(timer.createdAt).getTime()) / MILLIS_PER_SECOND;
  return Number.isFinite(derived) && derived > 0 ? derived : undefined;
}

/**
 * §4.5 — *"cancelled atomically with the state exit."*
 *
 * Cancels every pending timer for the entity, not only the one for the state being
 * left. A state exit can be driven by a path that does not know which state it is
 * leaving — a reconciler repair, a cancellation, a lease expiry — and a cancel scoped
 * to one state name would leave the others pending. They would be discarded on fire
 * anyway, because the version moved, so this is a tidiness and load property rather
 * than a correctness one; the correctness comes from the version, which is the point
 * of keying on it.
 *
 * @param {object} tx a transaction client
 * @param {object} input
 * @param {string} input.entityType
 * @param {string} input.entityId
 * @param {Date} input.storeTime
 * @param {string} [input.reason]
 * @returns {Promise<number>} timers cancelled
 */
async function cancelFor(tx, input) {
  requireTransaction(tx, "cancelling a timer");
  const source = input || {};
  const result = await tx.timer.updateMany({
    where: {
      entityType: source.entityType,
      entityId: source.entityId,
      timerState: TIMER_STATE.PENDING,
    },
    data: {
      timerState: TIMER_STATE.CANCELLED,
      resolvedAt: source.storeTime,
      lastOutcome: source.reason || "STATE_EXITED",
    },
  });
  return result.count;
}

/**
 * The timers whose instant has passed and which nobody has resolved.
 *
 * @param {object} prisma
 * @param {object} input
 * @param {Date} input.storeTime
 * @param {number} input.limit
 * @returns {Promise<object[]>}
 */
async function due(prisma, input) {
  const source = input || {};
  if (!Number.isInteger(source.limit) || source.limit <= 0) {
    throw new RangeError(`the due-timer batch size must be a positive integer; received ${String(source.limit)}`);
  }
  return prisma.timer.findMany({
    where: { timerState: TIMER_STATE.PENDING, dueAt: { lte: source.storeTime } },
    orderBy: [{ dueAt: "asc" }, { id: "asc" }],
    take: source.limit,
  });
}

/**
 * §4.5's discard rule — *"A timer whose version no longer matches its own entity is
 * discarded on fire."*
 *
 * Three discard reasons rather than one, because they mean different things to an
 * operator: a stale version is the ordinary case and should be common; an entity that
 * has vanished under a pending timer is a referential defect; and a state that changed
 * without the version moving is impossible under §4.1 rule 2 and therefore evidence of
 * an unconditional write somewhere.
 *
 * @param {object} timer
 * @param {object|null} entity the current row, or null if it is gone
 * @returns {{ disposition: string, reason: string|null }}
 */
function assessFire(timer, entity) {
  if (!entity) {
    return { disposition: FIRE_DISPOSITION.DISCARD_ENTITY_GONE, reason: "ENTITY_NO_LONGER_EXISTS" };
  }

  const currentVersion = versionOf(timer.entityType, entity);
  if (currentVersion !== BigInt(timer.entityVersion)) {
    return { disposition: FIRE_DISPOSITION.DISCARD_STALE_VERSION, reason: "ENTITY_VERSION_MOVED_ON" };
  }

  const currentState = timer.entityType === ENTITY_TYPE.COMMITMENT ? timer.state : entity.state || entity.status;
  if (currentState !== undefined && currentState !== null && currentState !== timer.state) {
    // Under §4.1 rule 2 this cannot happen: a state change is a conditional write that
    // increments the version, so the version check above would already have fired.
    // Reaching here means something wrote a state without its version, which is the
    // baseline's silent cancellation reversion in a new place.
    return { disposition: FIRE_DISPOSITION.DISCARD_STATE_CHANGED, reason: "STATE_CHANGED_WITHOUT_VERSION" };
  }

  return { disposition: FIRE_DISPOSITION.APPLY, reason: null };
}

/**
 * Record what happened to a fired timer. Conditional on it still being pending, so two
 * workers that both selected it produce one resolution and one no-op.
 *
 * @param {object} client base or transaction client
 * @param {object} input
 * @param {string} input.id
 * @param {string} input.timerState
 * @param {Date} input.storeTime
 * @param {string} [input.outcome]
 * @returns {Promise<number>} 1 when this caller owned the resolution
 */
async function resolve(client, input) {
  const source = input || {};
  if (source.timerState === TIMER_STATE.PENDING) {
    throw new RangeError("resolving a timer moves it out of PENDING; PENDING is not a resolution");
  }
  const result = await client.timer.updateMany({
    // `owned: true` drops the `PENDING` condition, and only the firing transaction may
    // pass it. It holds the row's lock from `claim`, so there is no race for the
    // condition to decide — and there is a real writer to overrule: `transitions.apply`
    // cancels **every** pending timer for the entity when the state exits, which includes
    // the timer that is at that moment firing. Conditionally resolving after that finds
    // the row `CANCELLED`, matches nothing, and leaves a fired deadline recorded as a
    // cancelled one: `firedAt` null, `lastOutcome` reading `EXITED_DEFERRED` rather than
    // what the handler did. The deadline is discharged either way; what is lost is the
    // evidence that it was *acted on*, which is the only thing distinguishing a timer
    // that supervised something from one that was tidied away.
    where: source.owned === true ? { id: source.id } : { id: source.id, timerState: TIMER_STATE.PENDING },
    data: {
      timerState: source.timerState,
      firedAt: source.timerState === TIMER_STATE.FIRED ? source.storeTime : undefined,
      resolvedAt: source.storeTime,
      attempts: { increment: 1 },
      lastOutcome: source.outcome === undefined ? null : source.outcome,
    },
  });
  return result.count;
}

/**
 * Take exclusive ownership of a due timer, inside the caller's transaction.
 *
 * PHASE 5 REMEDIATION. Firing used to be: run the handler, then `resolve`. Two things
 * were wrong with that order and both are §4.5 properties rather than tidiness.
 *
 * 1. **The handler's effect and the timer's resolution were in different transactions**
 *    — or, for a handler that took no transaction at all, in none. A crash between them
 *    leaves a deadline that was acted on and never resolved (it fires again, and the
 *    action repeats) or one resolved without its action (the §12.1 defect: a deadline
 *    nobody owns, discharged). `resolve` alone could not fix that, because the effect
 *    was not in its transaction.
 * 2. **Two workers both ran the handler.** `resolve`'s conditional write made only one
 *    of them *record* the fire; both had already acted. §4.5 admits at-least-once
 *    firing and requires idempotent handlers, so that was not unsound — but it is
 *    unsound for the handlers whose action is a *page*, where "idempotent" means one
 *    responder call rather than two, and there is no version to make the second a no-op.
 *
 * `claim` is the first statement of the firing transaction. It locks the row and
 * asserts, in one conditional write, both facts the fire depends on: the timer is still
 * `PENDING`, and it is still due at this pass's store time. The second half is what makes
 * a *rescheduled* timer safe — a re-armed timer stays `PENDING`, so `timerState` alone
 * would let a concurrent worker fire it a second time, while `dueAt` has moved past this
 * pass's clock and the re-check refuses.
 *
 * The whole fire — claim, handler effect, resolution — then commits or rolls back
 * together, which is the same rule §4.1 rule 5 states for a fence and the command it
 * authorises, applied to a deadline and the action it authorises.
 *
 * @param {object} tx a transaction client
 * @param {object} input
 * @param {string} input.id
 * @param {Date} input.storeTime
 * @returns {Promise<boolean>} true when this transaction owns the fire
 */
async function claim(tx, input) {
  requireTransaction(tx, "claiming a due timer");
  const source = input || {};
  const result = await tx.timer.updateMany({
    where: { id: source.id, timerState: TIMER_STATE.PENDING, dueAt: { lte: source.storeTime } },
    // The write is the lock. `attempts` is deliberately **not** incremented here: it
    // counts fires that reached a resolution or a re-arm, and `resolve` and `reschedule`
    // each own their own increment. A claim that later rolls back must leave no trace,
    // and a counter incremented by a rolled-back transaction would be exactly that.
    data: { lastOutcome: FIRING },
  });
  return result.count === 1;
}

/**
 * §4.5 / invariant I4 — re-arm a deadline the fire did not discharge.
 *
 * PHASE 5 REMEDIATION. A handler *attempts* a transition, and §4.5 is explicit that it
 * never forces one: *"A timer never forces a state change; it attempts one."* An attempt
 * can therefore be refused — a guard whose evidence nobody supplied, a collaborator that
 * does not exist yet — and several §4.3 expiry actions (`OPERATOR_ALERT`,
 * `PAGE_OPERATIONS`) are not transitions at all and never move the entity by design.
 *
 * In every one of those cases the entity is still sitting in the state whose deadline
 * this was. Resolving the timer would leave a **non-terminal state with no pending
 * timer**, which is precisely what invariant I4 forbids and what this store exists to
 * make impossible — the failure would be silent, permanent, and produced by the
 * supervisor itself.
 *
 * So the deadline is re-armed rather than discharged: the row stays `PENDING`, `dueAt`
 * moves forward, `attempts` records how many times this deadline has now passed, and
 * `lastOutcome` records what the attempt did. Nothing about the §4.5 key changes, so the
 * discard rule still governs: the moment the entity's own version moves, this timer
 * becomes stale and is discarded on its next fire like any other.
 *
 * **Re-arming through `register` would not work, and the reason is worth stating**:
 * `register` is idempotent on the key and returns the existing row, so re-registering
 * `(entity, id, state, version, handler)` after a fire returns the row that just fired
 * — in whatever state it is now — and creates no pending timer at all. The re-arm has to
 * move the existing row, which is what this does.
 *
 * @param {object} client base or transaction client
 * @param {object} input
 * @param {string} input.id
 * @param {Date} input.dueAt the next instant this deadline passes
 * @param {string} [input.outcome] what the attempt that did not discharge it did
 * @returns {Promise<number>} 1 when this caller owned the re-arm
 */
async function reschedule(client, input) {
  const source = input || {};
  if (!(source.dueAt instanceof Date) || Number.isNaN(source.dueAt.getTime())) {
    throw new TypeError("re-arming a deadline names the absolute instant it next passes (§10.6)");
  }
  const result = await client.timer.updateMany({
    where: { id: source.id, timerState: TIMER_STATE.PENDING },
    data: {
      dueAt: source.dueAt,
      attempts: { increment: 1 },
      // `firedAt` is deliberately untouched. It marks the fire that *discharged* a
      // deadline, and this deadline was not discharged; `attempts` and `lastOutcome`
      // are what record that it passed and what happened.
      lastOutcome: source.outcome === undefined ? null : source.outcome,
    },
  });
  return result.count;
}

/**
 * §4.5 — *"Timer-store lag is a first-class SLI."*
 *
 * > If the timer store falls behind by more than `supervise.max_timer_lag`, the shard
 * > enters degraded mode and stops issuing new HARD commitments, because it can no
 * > longer supervise them. This is a direct application of T3: losing supervision
 * > reduces what the engine will attempt.
 *
 * Lag is the age of the *oldest* overdue pending timer, not the count of them: a
 * thousand timers one second late is a busy shard, and one timer a minute late is a
 * shard that has stopped supervising something.
 *
 * @param {object} prisma
 * @param {Date} storeTime
 * @returns {Promise<{ lagSeconds: number, overdue: number, pending: number }>}
 */
async function readLag(prisma, storeTime) {
  const oldest = await prisma.timer.findMany({
    where: { timerState: TIMER_STATE.PENDING, dueAt: { lte: storeTime } },
    orderBy: { dueAt: "asc" },
    take: 1,
  });
  const overdue = await prisma.timer.count({
    where: { timerState: TIMER_STATE.PENDING, dueAt: { lte: storeTime } },
  });
  const pending = await prisma.timer.count({ where: { timerState: TIMER_STATE.PENDING } });

  const lagSeconds =
    oldest.length > 0
      ? Math.max(0, (storeTime.getTime() - new Date(oldest[0].dueAt).getTime()) / MILLIS_PER_SECOND)
      : 0;

  return { lagSeconds, overdue, pending };
}

/**
 * The §4.5 degraded-mode trigger, as a predicate.
 *
 * The mode it names — Unsupervised Commitment (§18.5) — is Phase 12's register to
 * enter. This returns the directive, in the shape that phase will consume, rather than
 * entering a mode that does not exist yet; naming it without entering it is the same
 * discipline `dispatch/escalation.js` applies to its step 4.
 *
 * @param {{ lagSeconds: number }} lag
 * @param {number} maxTimerLagSeconds `supervise.max_timer_lag`
 * @returns {{ degraded: boolean, directive: object|null }}
 */
function assessLag(lag, maxTimerLagSeconds) {
  if (!Number.isFinite(maxTimerLagSeconds) || maxTimerLagSeconds <= 0) {
    throw new RangeError(
      `supervise.max_timer_lag resolved to ${String(maxTimerLagSeconds)}; a lag bound must be positive (§4.5)`,
    );
  }
  if (!lag || lag.lagSeconds <= maxTimerLagSeconds) {
    return { degraded: false, directive: null };
  }
  return {
    degraded: true,
    directive: Object.freeze({
      alert: "TIMER_STORE_LAGGING",
      lagSeconds: lag.lagSeconds,
      threshold: maxTimerLagSeconds,
      // The load-bearing half: the correct response to "we can no longer supervise" is
      // to stop creating things that need supervising.
      stopNewHardening: true,
      enterDegradedMode: "UNSUPERVISED_COMMITMENT",
      suspendsInvariant: "I4",
      ownedBy: "Phase 12 — degraded/modeRegister.js",
    }),
  };
}

/**
 * §4.5's completeness claim, as a query: which non-terminal entities have no pending
 * timer?
 *
 * This is invariant I4's verification — *"Timer/state cross-audit, including a check
 * that no timer is keyed on an agent-level counter"* — and it is here rather than in the
 * reconciler because the reconciler *repairs* divergences while this *detects* a missing
 * supervisor. The reconciler calls it; so does the Phase 12 invariant checker.
 *
 * @param {object} prisma
 * @param {object} input
 * @param {number} input.limit
 * @returns {Promise<Array<{ entityType: string, entityId: string, state: string }>>}
 */
async function findUnsupervised(prisma, input) {
  const source = input || {};
  const limit = source.limit || DEFAULT_AUDIT_LIMIT;

  const legs = await prisma.leg.findMany({
    where: { state: { notIn: legMachine.TERMINAL_LEG_STATES } },
    take: limit,
  });

  const unsupervised = [];
  for (const leg of legs) {
    if (!legMachine.requiresTimer(leg.state)) continue;
    const pending = await prisma.timer.count({
      where: {
        entityType: ENTITY_TYPE.LEG,
        entityId: leg.id,
        timerState: TIMER_STATE.PENDING,
        entityVersion: BigInt(leg.version),
      },
    });
    if (pending === 0) {
      unsupervised.push({ entityType: ENTITY_TYPE.LEG, entityId: leg.id, state: leg.state });
    }
  }

  return unsupervised;
}

/**
 * @param {unknown} tx
 * @param {string} action
 */
function requireTransaction(tx, action) {
  const looksLikeTransaction =
    Boolean(tx) && typeof tx === "object" && typeof tx.timer === "object" && typeof tx.$transaction !== "function";
  if (!looksLikeTransaction) {
    throw new TypeError(
      `${action} happens in the transaction that enters or exits the supervised state (§4.5). A timer written ` +
        "afterwards is lost by a crash between the two writes — an unsupervised state, which is the whole class " +
        "of defect this store exists to prevent — and one written before can supervise a transition that rolled back.",
    );
  }
}

/**
 * The marker `claim` writes while a fire is in flight. It is never observed by a reader
 * outside the firing transaction — the row is locked for the whole of it — and it is
 * overwritten by the resolution or the re-arm before that transaction commits. Its
 * value matters only if a fire's transaction commits without either, which is a defect
 * `fireOne` makes unrepresentable and which this name would make legible if it ever did.
 * @structural the in-flight marker
 */
const FIRING = "FIRING";

/** @structural milliseconds per second — a unit conversion, not a threshold */
const MILLIS_PER_SECOND = 1000;

/** @structural the cross-audit's batch size; a work-partitioning constant */
const DEFAULT_AUDIT_LIMIT = 500;

module.exports = {
  ENTITY_TYPE,
  TIMER_STATE,
  FIRE_DISPOSITION,
  FIRING,
  VERSION_SOURCE,
  FORBIDDEN_VERSION_SOURCES,
  timerKey,
  versionOf,
  requiresTimer,
  deadlineFor,
  armedSecondsOf,
  register,
  cancelFor,
  due,
  assessFire,
  claim,
  resolve,
  reschedule,
  readLag,
  assessLag,
  findUnsupervised,
  deadlineFrom: clock.deadlineFrom,
};

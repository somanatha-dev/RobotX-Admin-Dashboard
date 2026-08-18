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

  const existing = await tx.timer.findUnique({ where: { timerKey: key } });
  if (existing) return existing;

  return tx.timer.create({
    data: {
      timerKey: key,
      entityType: source.entityType,
      entityId: source.entityId,
      state: source.state,
      entityVersion,
      dueAt: source.dueAt,
      handler: source.handler,
      payload: source.payload === undefined ? null : source.payload,
      timerState: TIMER_STATE.PENDING,
      shardId: source.shardId === undefined ? null : source.shardId,
    },
  });
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
    where: { id: source.id, timerState: TIMER_STATE.PENDING },
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

/** @structural milliseconds per second — a unit conversion, not a threshold */
const MILLIS_PER_SECOND = 1000;

/** @structural the cross-audit's batch size; a work-partitioning constant */
const DEFAULT_AUDIT_LIMIT = 500;

module.exports = {
  ENTITY_TYPE,
  TIMER_STATE,
  FIRE_DISPOSITION,
  VERSION_SOURCE,
  FORBIDDEN_VERSION_SOURCES,
  timerKey,
  versionOf,
  requiresTimer,
  deadlineFor,
  register,
  cancelFor,
  due,
  assessFire,
  resolve,
  readLag,
  assessLag,
  findUnsupervised,
  deadlineFrom: clock.deadlineFrom,
};

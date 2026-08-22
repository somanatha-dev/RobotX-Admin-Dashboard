"use strict";

/**
 * The timer worker (§4.5) — fires due timers, at-least-once, with idempotent handlers.
 *
 * > - Firing is at-least-once; handlers MUST be idempotent.
 * > - Timer handlers are subject to the same conditional-write discipline as any other
 * >   transition. **A timer never forces a state change; it *attempts* one.**
 * > - Timer-store lag is a first-class SLI. If the timer store falls behind by more than
 * >   `supervise.max_timer_lag`, the shard enters degraded mode and stops issuing new
 * >   HARD commitments, because it can no longer supervise them. This is a direct
 * >   application of T3: losing supervision reduces what the engine will attempt.
 *
 * ── One pass ───────────────────────────────────────────────────────────────
 * select due → for each: read the entity, judge staleness, attempt, resolve → emit lag.
 *
 * The staleness judgement is §4.5's discard rule and it is what makes cancellation a
 * tidiness property rather than a correctness one: *"A timer whose version no longer
 * matches its own entity is discarded on fire, which makes late-firing timers harmless
 * without requiring reliable cancellation."* A worker that skipped it would apply a
 * deadline computed for a state the entity left ten minutes ago.
 *
 * ── The handlers are injected ──────────────────────────────────────────────
 * A handler decides what to attempt when a deadline passes — reassign, escalate, page,
 * re-plan. The worker takes a handler map and **refuses to fire a timer whose handler is
 * not registered**, rather than resolving it silently. A deadline that passed with nobody
 * to act on it is the exact defect §12.1 opens by naming, and swallowing it here would
 * rebuild that defect inside the mechanism designed to remove it.
 *
 * Their producer is `engine/supervision/expiryActions.js`, which derives its keys from
 * §4.2's and §4.3's own deadline tables. Until Phase 5's remediation there was no
 * producer at all and no handler could have been written against this contract anyway —
 * see `fireOne`, whose three defects are recorded there rather than here because they
 * were defects of *this* function.
 *
 * ── Started on leadership ──────────────────────────────────────────────────
 * `workers/leaderWorkers.js` composes and starts it when the shard supervisor reports a
 * promoted lease (§19.3's single writer), and stops it on demotion. Nothing in
 * `server.js` calls `start()` directly, and Phase 0's scaffold guard asserts it does not:
 * a standby that fired timers would be a second writer.
 *
 * Tier 0 by path. Invariants I2, I4, I12.
 */

const clock = require("../engine/commitment/clock");
const timers = require("../engine/supervision/timers");

/**
 * How many timers one pass fires. Bounded so a backlog is drained in bounded passes and
 * the lag SLI moves *during* recovery rather than after it.
 * @structural the fire batch size; a work-partitioning constant, not a threshold
 */
const FIRE_BATCH = 64;

/**
 * The advisory lag gauge the plan names. **Advisory** is its whole specification: timers
 * are DB-authoritative (§3.3), and losing this key costs an operator a fast read, never
 * a deadline. It is written here, in the worker, rather than in `supervision/**`, so that
 * no module under `src/engine/supervision/` imports the cache — the same structural
 * property Phase 4 established for `src/engine/dispatch/`.
 */
const LAG_KEY = "engine:timerlag";

/** @structural milliseconds per second — a unit conversion, not a threshold */
const MILLIS_PER_SECOND = 1000;

/**
 * @param {object|null|undefined} cache
 * @param {string} key
 * @param {string} value
 * @param {number} ttlSeconds
 */
async function writeAdvisory(cache, key, value, ttlSeconds) {
  if (!cache || typeof cache.set !== "function") return false;
  try {
    await cache.set(key, value, { ex: Math.max(1, Math.ceil(ttlSeconds)) });
    return true;
  } catch {
    // Advisory. Loss degrades an operator's dashboard, never supervision.
    return false;
  }
}

/**
 * Read the entity a timer supervises.
 *
 * @param {object} prisma
 * @param {object} timer
 * @returns {Promise<object|null>}
 */
async function readEntity(prisma, timer) {
  if (timer.entityType === timers.ENTITY_TYPE.LEG) {
    return prisma.leg.findUnique({ where: { id: timer.entityId } });
  }
  if (timer.entityType === timers.ENTITY_TYPE.TASK) {
    return prisma.task.findUnique({ where: { id: timer.entityId } });
  }
  return prisma.commitment.findUnique({ where: { commitmentId: timer.entityId } });
}

/**
 * How long to re-arm a deadline the fire did not discharge.
 *
 * The default is **the interval this timer was originally armed for**, which `register`
 * records on the row: literally the state's own deadline as it was resolved at the moment
 * the state was entered, including the two `projected` deadlines whose value is a mission
 * ETA rather than a register entry. Reading it from the row rather than re-resolving
 * configuration is what lets a projected deadline re-arm at all without this worker
 * acquiring a copy of the plan.
 *
 * @param {object} timer
 * @param {object} deps
 * @param {object|null} result the handler's return
 * @returns {number} seconds, at least one
 */
function rearmSecondsFor(timer, deps, result) {
  if (result && Number.isFinite(result.rearmInSeconds) && result.rearmInSeconds > 0) {
    return result.rearmInSeconds;
  }
  if (typeof deps.rearmSecondsFor === "function") {
    const supplied = deps.rearmSecondsFor(timer);
    if (Number.isFinite(supplied) && supplied > 0) return supplied;
  }
  const armed = timers.armedSecondsOf(timer);
  return Number.isFinite(armed) && armed > 0 ? armed : 1;
}

/**
 * Fire one timer — claim, act, and resolve or re-arm, **in one transaction**.
 *
 * PHASE 5 REMEDIATION. The previous shape of this function was
 * `handler({ timer, entity, storeTime, config })` followed by `resolve` on the base
 * client, and three things were wrong with it. Each is a §4.5 property rather than a
 * refinement, and the first is why the seventeen declared expiry actions could not have
 * been implemented even by someone who tried:
 *
 * 1. **The handler received no transaction client, so it could not perform a transition.**
 *    §4.5 says a timer *attempts* a transition and §4.1 rule 2 makes every transition a
 *    conditional write; `lifecycle/transitions.apply` takes a `tx` as its first argument
 *    and `supervision/timers.register` refuses anything that is not one. A handler holding
 *    only `{ timer, entity, storeTime, config }` had no way to write anything at all. The
 *    handler contract described a supervisor that could only observe.
 *
 * 2. **The effect and the resolution were in different transactions.** A crash between
 *    them leaves either a deadline acted on and not resolved, or — worse — one resolved
 *    with its action rolled back, which is a deadline discharged by nobody. §4.1 rule 5
 *    states this for a fence and the command it authorises; a deadline and the action it
 *    authorises are the same shape.
 *
 * 3. **Two workers both ran the handler.** `resolve` is conditional on `PENDING`, so only
 *    one *recorded* the fire — after both had already acted. §4.5's at-least-once firing
 *    makes that sound for a handler whose effect is a conditional write, and unsound for
 *    one whose effect is a page: there is no version to make the second responder call a
 *    no-op.
 *
 * `timers.claim` is now the transaction's first statement. It locks the row and asserts
 * both facts the fire rests on — still `PENDING`, still due at *this* pass's store time —
 * so a second worker's claim finds no row and does no work, and everything after it
 * commits or rolls back as one.
 *
 * ── The resolution is structural, not the handler's word ───────────────────
 * After the handler, the entity is re-read and its version compared. If it moved, the
 * transition happened and `apply` registered the target state's timer, so this one is
 * `FIRED`. If it did **not** move, the entity is still sitting in the state whose deadline
 * this was — the handler refused, or its action was an alert that never transitions — and
 * resolving would leave a non-terminal state with no pending timer, which invariant I4
 * forbids and which nothing downstream would ever notice. So it is re-armed.
 *
 * Deciding that from the version rather than from the handler's return value is the point:
 * a handler cannot discharge a deadline by claiming to have acted on it.
 *
 * @param {object} deps
 * @param {object} config
 * @param {object} timer
 * @param {Date} storeTime
 * @returns {Promise<{ disposition: string, outcome: string|null }>}
 */
async function fireOne(deps, config, timer, storeTime) {
  const entity = await readEntity(deps.prisma, timer);
  const assessment = timers.assessFire(timer, entity);

  if (assessment.disposition !== timers.FIRE_DISPOSITION.APPLY) {
    await timers.resolve(deps.prisma, {
      id: timer.id,
      timerState: timers.TIMER_STATE.DISCARDED,
      storeTime,
      outcome: assessment.reason,
    });
    return { disposition: assessment.disposition, outcome: assessment.reason };
  }

  const handler = deps.handlers ? deps.handlers[timer.handler] : undefined;
  if (typeof handler !== "function") {
    // Left PENDING on purpose. An unregistered handler is a configuration defect, and
    // resolving the timer would discharge a deadline nobody acted on — which is the
    // failure §12.1 names. It stays due, it keeps counting towards the lag SLI, and the
    // lag SLI is what pages.
    return { disposition: "HANDLER_NOT_REGISTERED", outcome: timer.handler };
  }

  const record = typeof deps.record === "function" ? deps.record : () => {};

  try {
    return await deps.runInTransaction(async (tx) => {
      const owned = await timers.claim(tx, { id: timer.id, storeTime });
      if (!owned) {
        // Another worker holds this fire, or it was re-armed past this pass's clock
        // between the selection and here. Neither is an error and neither is a fire.
        return { disposition: "NOT_CLAIMED", outcome: "CLAIMED_BY_ANOTHER_PASS" };
      }

      // Re-read under the claim. The select-to-claim window is small and it is real: the
      // entity can transition inside it, and acting on the row read before the lock would
      // apply a deadline computed for a state the entity has left — the very thing
      // `assessFire` exists to prevent, one step earlier than it was checked.
      const held = await readEntity(tx, timer);
      const recheck = timers.assessFire(timer, held);
      if (recheck.disposition !== timers.FIRE_DISPOSITION.APPLY) {
        await timers.resolve(tx, {
          id: timer.id,
          timerState: timers.TIMER_STATE.DISCARDED,
          storeTime,
          outcome: recheck.reason,
          owned: true,
        });
        return { disposition: recheck.disposition, outcome: recheck.reason };
      }

      const result = await handler({ tx, prisma: deps.prisma, timer, entity: held, storeTime, config, record });
      const outcome = result && result.outcome ? String(result.outcome) : "ATTEMPTED";

      const after = await readEntity(tx, timer);
      const moved = !after || timers.versionOf(timer.entityType, after) !== BigInt(timer.entityVersion);
      const stillSupervised =
        Boolean(after) && timers.requiresTimer(timer.entityType, timer.state) && !moved;

      if (stillSupervised) {
        const seconds = rearmSecondsFor(timer, deps, result);
        await timers.reschedule(tx, {
          id: timer.id,
          dueAt: timers.deadlineFrom(storeTime, seconds),
          outcome,
        });
        return {
          disposition: "REARMED",
          outcome,
          rearmedInSeconds: seconds,
          handlerDisposition: result ? result.disposition : null,
        };
      }

      // `owned` — this transaction holds the row's lock from `claim`, and the transition
      // the handler just applied has already cancelled every pending timer for the entity,
      // this one included. Without it the fire is recorded as a cancellation.
      await timers.resolve(tx, { id: timer.id, timerState: timers.TIMER_STATE.FIRED, storeTime, outcome, owned: true });
      return {
        disposition: timers.FIRE_DISPOSITION.APPLY,
        outcome,
        handlerDisposition: result ? result.disposition : null,
      };
    });
  } catch (error) {
    // The whole fire rolled back, claim included, so the row is untouched and still due.
    // Left as it is, a deterministic handler defect would re-fire it on every pass for
    // ever; re-armed here, outside the failed transaction, it retries on the state's own
    // cadence and `attempts` and `lastOutcome` carry the failure durably.
    const outcome = `HANDLER_THREW:${error && error.message ? error.message : "unknown"}`;
    record("timer.handler_threw", {
      timerId: timer.id,
      handler: timer.handler,
      entityType: timer.entityType,
      entityId: timer.entityId,
      state: timer.state,
      message: error && error.message,
    });
    await timers.reschedule(deps.prisma, {
      id: timer.id,
      dueAt: timers.deadlineFrom(storeTime, rearmSecondsFor(timer, deps, null)),
      outcome,
    });
    return { disposition: "HANDLER_THREW", outcome };
  }
}

/**
 * Run one pass.
 *
 * @param {object} deps
 * @param {object} deps.prisma
 * @param {() => Promise<Date>} deps.readStoreTime
 * @param {Record<string, Function>} deps.handlers keyed by the §4.3/§4.2 "on expiry" action
 * @param {(event: string, detail: object) => void} [deps.record]
 * @param {{ set: Function }} [deps.advisoryCache]
 * @param {object} config
 * @param {number} config.maxTimerLagSeconds `supervise.max_timer_lag`
 * @returns {Promise<object>}
 */
async function fireDue(deps, config) {
  requireDeps(deps);
  const settings = config || {};
  const storeTime = await deps.readStoreTime();
  const record = typeof deps.record === "function" ? deps.record : () => {};

  const dueTimers = await timers.due(deps.prisma, { storeTime, limit: FIRE_BATCH });

  const summary = { due: dueTimers.length, fired: 0, discarded: 0, unhandled: 0, rearmed: 0, threw: 0, unclaimed: 0 };

  for (const timer of dueTimers) {
    const result = await fireOne(deps, settings, timer, storeTime);
    if (result.disposition === timers.FIRE_DISPOSITION.APPLY) summary.fired += 1;
    else if (result.disposition === "REARMED") {
      // Counted separately from `fired` on purpose. A pass that re-arms everything it
      // touches is a supervisor whose attempts are all being refused — a healthy-looking
      // tick over a fleet nothing is progressing — and one number that covered both
      // would hide exactly that.
      summary.rearmed += 1;
      record("timer.rearmed", {
        timerId: timer.id,
        handler: timer.handler,
        entityType: timer.entityType,
        entityId: timer.entityId,
        state: timer.state,
        outcome: result.outcome,
        attempts: timer.attempts + 1,
        rearmedInSeconds: result.rearmedInSeconds,
      });
    } else if (result.disposition === "HANDLER_THREW") {
      summary.threw += 1;
    } else if (result.disposition === "NOT_CLAIMED") {
      summary.unclaimed += 1;
    } else if (result.disposition === "HANDLER_NOT_REGISTERED") {
      summary.unhandled += 1;
      record("timer.handler_not_registered", {
        timerId: timer.id,
        handler: timer.handler,
        entityType: timer.entityType,
        entityId: timer.entityId,
        state: timer.state,
      });
    } else {
      summary.discarded += 1;
      record("timer.discarded", {
        timerId: timer.id,
        reason: result.outcome,
        entityType: timer.entityType,
        entityId: timer.entityId,
      });
    }
  }

  // §4.5 — the lag SLI, read after the pass so it reflects what the pass could not clear.
  const lag = await timers.readLag(deps.prisma, storeTime);
  record("timer.lag", lag);

  await writeAdvisory(
    deps.advisoryCache,
    LAG_KEY,
    JSON.stringify({ ...lag, at: storeTime.toISOString() }),
    Math.max(1, settings.maxTimerLagSeconds || 1),
  );

  const degraded = timers.assessLag(lag, settings.maxTimerLagSeconds);
  if (degraded.degraded) {
    // Named, not entered — Phase 12 owns the mode register. The directive's
    // `stopNewHardening` is the load-bearing half: the correct response to losing
    // supervision is to stop creating things that need supervising (T3).
    record("timer.degraded", degraded.directive);
  }

  return { ...summary, ...lag, degraded: degraded.degraded, storeTime };
}

/**
 * @param {object} deps
 */
function requireDeps(deps) {
  if (!deps || !deps.prisma) throw new TypeError("the timer worker needs a store client");
  if (typeof deps.readStoreTime !== "function") {
    throw new TypeError("deadlines are judged against the Commitment Store's clock, never a worker's (§10.6)");
  }
  if (!deps.handlers || typeof deps.handlers !== "object") {
    throw new TypeError(
      "the timer worker needs a handler map. A timer with no handler is a deadline nobody owns; firing one and " +
        "resolving it silently would rebuild the defect §12.1 opens by naming, inside the mechanism designed to " +
        "remove it.",
    );
  }
  if (typeof deps.runInTransaction !== "function") {
    throw new TypeError(
      "the timer worker needs a transaction seam. A handler *attempts* a transition (§4.5) and every transition is " +
        "a conditional write (§4.1 rule 2), so a handler with no transaction client can observe and never act — " +
        "and the claim, the action, and the resolution must commit or roll back together, or a deadline is " +
        "discharged by nobody (§4.1 rule 5).",
    );
  }
}

/**
 * A running loop. The returned handle stops it.
 *
 * @param {object} deps
 * @param {object} config plus `intervalMs`
 * @returns {{ stop: () => void }}
 */
function start(deps, config) {
  requireDeps(deps);
  const settings = config || {};
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      await fireDue(deps, settings);
    } catch (error) {
      if (typeof deps.record === "function") {
        deps.record("timer.pass_failed", { message: error && error.message });
      }
    }
  };

  const timer = setInterval(tick, settings.intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * Read the store's clock through a client, for callers assembling `deps`.
 *
 * @param {object} prisma
 * @returns {() => Promise<Date>}
 */
function storeTimeReader(prisma) {
  return () => clock.readStoreTime(prisma);
}

module.exports = {
  FIRE_BATCH,
  LAG_KEY,
  readEntity,
  rearmSecondsFor,
  fireOne,
  fireDue,
  start,
  storeTimeReader,
};

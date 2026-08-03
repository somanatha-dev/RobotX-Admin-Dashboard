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
 * re-plan — and several of those belong to phases that have not landed. The worker
 * therefore takes a handler map and **refuses to fire a timer whose handler is not
 * registered**, rather than resolving it silently. A deadline that passed with nobody to
 * act on it is the exact defect §12.1 opens by naming, and swallowing it here would
 * rebuild that defect inside the mechanism designed to remove it.
 *
 * ── Built, tested, and not started ─────────────────────────────────────────
 * `ENGINE_ENABLED` is false and Phase 15 owns moving engine workers "from shadow to
 * production scheduling". Nothing in `server.js` calls `start()`.
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
 * Fire one timer.
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

  let outcome;
  try {
    // The handler *attempts* a transition. Its own conditional write decides whether it
    // wins against a concurrent reconciler repair (§12.4).
    const result = await handler({ timer, entity, storeTime, config });
    outcome = result && result.outcome ? result.outcome : "ATTEMPTED";
  } catch (error) {
    outcome = `HANDLER_THREW:${error && error.message ? error.message : "unknown"}`;
  }

  await timers.resolve(deps.prisma, {
    id: timer.id,
    timerState: timers.TIMER_STATE.FIRED,
    storeTime,
    outcome,
  });

  return { disposition: timers.FIRE_DISPOSITION.APPLY, outcome };
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

  const summary = { due: dueTimers.length, fired: 0, discarded: 0, unhandled: 0 };

  for (const timer of dueTimers) {
    const result = await fireOne(deps, settings, timer, storeTime);
    if (result.disposition === timers.FIRE_DISPOSITION.APPLY) summary.fired += 1;
    else if (result.disposition === "HANDLER_NOT_REGISTERED") {
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
  fireOne,
  fireDue,
  start,
  storeTimeReader,
};

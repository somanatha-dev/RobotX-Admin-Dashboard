"use strict";

/**
 * The reconciler worker (§12.4).
 *
 * > Runs continuously per shard, **event-driven with a periodic full sweep**, and is
 * > idempotent.
 *
 * The plan bounds the sweep: *"reconciler.worker.js (event-driven + periodic full sweep
 * < 60 s, all nine divergence classes of §12.4)"*. Both halves are here — `sweepOnce`
 * runs every class, and `nudge` is the event-driven entry a handler calls when it has a
 * reason to believe a specific entity has diverged, so that the common case does not wait
 * for the periodic pass.
 *
 * ── What this worker absorbs ────────────────────────────────────────────────
 * The execution plan retires two standalone loops into this one:
 *
 *   - `socket.server.js`'s offline sweep — the `setInterval` that marked robots offline
 *     when their heartbeat aged out. That is §12.4 row 9 seen from the other side
 *     (liveness versus the availability index), and running two independent loops over
 *     one fact is how the two come to disagree.
 *   - `services/taskRecovery.service.js` — the startup pass that rebuilt Redis state for
 *     active tasks. That is the orphan scan (§12.4 row 3) restricted to one trigger:
 *     process restart. The reconciler's version is trigger-independent, which is the
 *     whole argument of §12.1 — *"correct-by-construction for triggers nobody
 *     anticipated"*.
 *
 * Neither file is deleted in this phase. Both stay callable and both keep their legacy
 * behaviour until the Phase 15 cutover; what changes is that the engine's own supervision
 * no longer depends on either. Deleting them now would break the legacy dispatcher, which
 * is still the production path.
 *
 * ── The repair rate is the point ────────────────────────────────────────────
 * > a healthy system's reconciler is nearly idle, so a rising rate means a bug elsewhere,
 * > and burying it in a safety net converts a visible outage into invisible chronic loss.
 *
 * Every pass emits the per-category rate, so the release gate §12.4 requires has a number
 * to gate on from the day the reconciler exists.
 *
 * ── Built, tested, and not started ─────────────────────────────────────────
 * `ENGINE_ENABLED` is false; Phase 15 owns production scheduling. Nothing in `server.js`
 * calls `start()`.
 *
 * Tier 0 by path. Invariants I2, I3, I4, I7, I8, I12, I13.
 */

const clock = require("../engine/commitment/clock");
const reconciler = require("../engine/supervision/reconciler");

/**
 * The periodic full sweep's interval bound, from the plan: *"periodic full sweep < 60
 * s"*. Asserted rather than assumed, because a sweep that silently ran every five
 * minutes would still look like it was working.
 * @structural the plan's stated upper bound on the full-sweep interval
 */
const MAX_SWEEP_INTERVAL_MS = 60_000;

/**
 * The window the repair rate is reported over. One hour, because the rate is a *defect*
 * signal read by a human against a release gate, and a per-pass count is too noisy to
 * gate on.
 * @structural the SLI reporting window; a reporting choice, not a behavioural threshold
 */
const RATE_WINDOW_SECONDS = 3600;

/**
 * One full sweep — all ten §12.4 divergence classes, each counted.
 *
 * @param {object} deps as `reconciler.sweep`, plus `record`
 * @param {object} config
 * @returns {Promise<object>}
 */
async function sweepOnce(deps, config) {
  const settings = config || {};
  const record = typeof deps.record === "function" ? deps.record : () => {};

  const result = await reconciler.sweep(deps, settings);

  // §12.4 — "Every repair is counted and alerted on" (T10).
  record("reconciler.repairs", { total: result.total, byCategory: result.byCategory });

  const since = new Date(result.storeTime.getTime() - RATE_WINDOW_SECONDS * MILLIS_PER_SECOND);
  const rate = await reconciler.readRepairRate(deps.prisma, { since, storeTime: result.storeTime });
  record("reconciler.repair_rate", rate);

  // Invariant I4's cross-audit result. A non-empty list is not a repair — it is a state
  // that has *no supervisor*, which is more serious than a divergence and is reported as
  // its own signal rather than folded into the repair count.
  if (result.unsupervised.length > 0) {
    record("reconciler.unsupervised_states", {
      count: result.unsupervised.length,
      sample: result.unsupervised.slice(0, UNSUPERVISED_SAMPLE),
      invariant: "I4",
    });
  }

  return { ...result, rate };
}

/**
 * The event-driven half — reconcile one entity now, because something has a reason to
 * think it has diverged.
 *
 * Runs the same scans against a batch of one, so an event-driven repair and a periodic
 * one are the same code and cannot drift. §12.4's idempotence is what makes this safe to
 * call from a handler that may be racing the periodic pass.
 *
 * @param {object} deps
 * @param {object} config
 * @returns {Promise<object>}
 */
async function nudge(deps, config) {
  return sweepOnce(deps, { ...(config || {}), batch: 1 });
}

/**
 * A running loop.
 *
 * @param {object} deps
 * @param {object} config plus `intervalMs`
 * @returns {{ stop: () => void }}
 */
function start(deps, config) {
  const settings = config || {};

  if (!Number.isFinite(settings.intervalMs) || settings.intervalMs <= 0) {
    throw new RangeError("the reconciler's sweep interval must be a positive number of milliseconds");
  }
  if (settings.intervalMs >= MAX_SWEEP_INTERVAL_MS) {
    throw new RangeError(
      `the periodic full sweep must run more often than every ${MAX_SWEEP_INTERVAL_MS} ms. A slower sweep still ` +
        "looks like it is working, which is the property that makes an under-configured reconciler dangerous: the " +
        "divergences it exists to catch simply persist for longer before anyone sees them.",
    );
  }

  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      await sweepOnce(deps, settings);
    } catch (error) {
      if (typeof deps.record === "function") {
        deps.record("reconciler.sweep_failed", { message: error && error.message });
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
 * @param {object} prisma
 * @returns {() => Promise<Date>}
 */
function storeTimeReader(prisma) {
  return () => clock.readStoreTime(prisma);
}

/** @structural how many unsupervised states to name in one alert */
const UNSUPERVISED_SAMPLE = 10;
/** @structural milliseconds per second — a unit conversion, not a threshold */
const MILLIS_PER_SECOND = 1000;

module.exports = {
  MAX_SWEEP_INTERVAL_MS,
  RATE_WINDOW_SECONDS,
  sweepOnce,
  nudge,
  start,
  storeTimeReader,
};

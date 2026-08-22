"use strict";

/**
 * The pull half of §22.1 rule 4's pull-with-pin — **Tier 0 by consequence**.
 *
 * ── The defect this module exists to close (P15-R2) ────────────────────────
 * §22.1 rule 4 describes configuration propagation as pull-with-pin, and
 * `config/service.js` implements both ends of it: `pinVersion()` writes the active-version
 * pointer to the database and mirrors it into `config:active`, and `loadPinnedSnapshot()`
 * reads that pointer back, cache-first and store-authoritative.
 *
 * **Nothing pulled.** `app.locals.config` was assigned exactly once, at
 * `server.js`'s boot, and by nothing else for the life of the process.
 * `loadPinnedSnapshot()`'s only production callers were two read-only endpoints in
 * `controllers/config.controller.js`, neither of which updates the process's own snapshot —
 * so even the endpoint that *publishes and pins* left the publishing process reading the
 * version it booted on.
 *
 * That is a defect anywhere; under Phase 15 it is the phase's own deliverable failing.
 * The per-shard cutover switch **is** a published binding (`cutover.engine_enabled`), and
 * every consumer of it reads the boot snapshot:
 *
 *   - the five agent-facing socket handlers, through `cutover/agentGate.js`;
 *   - the intake path, through `services/task.service.js`;
 *   - the staged-rollout controller's own notion of which shards are live, through
 *     `cutover/store.liveShards()`;
 *   - `GET /api/health`'s per-shard posture.
 *
 * So "staged by shard, with rollback" was, on a running deployment, "staged at boot,
 * permanently": taking a shard live required a restart, rolling one back required a
 * restart, and the automatic rollback of §22.4 item 4 could not take effect at all. The
 * whole cutover mechanism was unactuatable, and every test passed because every test
 * constructs its own snapshot and hands it to the function under test.
 *
 * ── Why a pull and not a push ──────────────────────────────────────────────
 * §22.1 rule 4 is explicit that propagation is *"pull-with-pin, never a push that could
 * land mid-round"*. A push — a Redis pub/sub message swapping the snapshot — could land
 * between two decisions of one round, which is the case the rule forbids. A pull on a
 * cadence, applied to a reference the readers dereference at call time, cannot: a round
 * pins the snapshot it started with, and everything else reads the current one at the
 * moment it asks.
 *
 * ── What "applied" means, and what it deliberately does not ────────────────
 * `apply` receives the new snapshot and the composition root points `app.locals.config` at
 * it. It does **not** restart workers, re-elect, or re-compose anything. A worker that
 * captured a value at composition time keeps it until the next promotion, which is stated
 * rather than fixed here because it is a different question with a different answer:
 * `workers/leaderWorkers.js` now takes its `values` as an accessor for exactly this reason.
 *
 * ── The version is the unit; an unchanged version is not applied ───────────
 * A pass that finds the same version does nothing at all — no swap, no log, no allocation.
 * Swapping in an equal-but-distinct snapshot object on every tick would make a reader's
 * "which version am I on" answer change identity without changing value, and would defeat
 * any caching a reader does on the snapshot reference.
 *
 * ── Failure is reported, never fatal, and never a downgrade ────────────────
 * A pass that cannot read the pin leaves the current snapshot in place. That is the only
 * safe direction: the alternative is a process that loses its configuration because the
 * store blinked, and `config/service.bootstrap()` already refuses to start the engine on
 * register defaults for the same reason. The failure is reported through `onError` so a
 * process that has stopped tracking configuration is visible rather than silent.
 *
 * ── No clock, no store, no cache ───────────────────────────────────────────
 * Everything is injected. `load` is the caller's `loadPinnedSnapshot`, `apply` is the
 * caller's assignment. This module holds a timer and a version number.
 */

/**
 * Default cadence, in milliseconds, when no configuration supplies one.
 *
 * Deliberately the same order as the staged-rollout controller's own pass
 * (`cutover.worker.DEFAULT_INTERVAL_MS`): the two answer the same operational question from
 * opposite ends — one decides that a shard must come out of service, the other is how any
 * process finds out that one has — and a propagation slower than the controller's cadence
 * would mean the controller could roll a shard back twice before any reader noticed once.
 *
 * @structural the fallback cadence; the configured value is `cutover.guardrail_check_interval`
 */
const DEFAULT_INTERVAL_MS = 30000;

/** @structural milliseconds per second — a unit conversion, not a tunable */
const MS_PER_SECOND = 1000;

/**
 * One pull.
 *
 * @param {object} deps
 * @param {() => Promise<object|null>} deps.load resolves the pinned snapshot, or null
 * @param {(snapshot: object) => void} deps.apply install it as the process's snapshot
 * @param {(event: string, detail: object) => void} [deps.record]
 * @param {(error: Error) => void} [deps.onError]
 * @param {{ currentVersion: number|null }} state
 * @returns {Promise<{ changed: boolean, version: number|null, reason: string|null }>}
 */
async function refreshOnce(deps, state) {
  let snapshot;
  try {
    snapshot = await deps.load();
  } catch (error) {
    if (typeof deps.onError === "function") deps.onError(error);
    return { changed: false, version: state.currentVersion, reason: "LOAD_FAILED" };
  }

  if (!snapshot) {
    // Nothing is published. The process keeps whatever it booted with — which, when the
    // engine is enabled, `bootstrap()` guarantees is a real pinned version.
    return { changed: false, version: state.currentVersion, reason: "NOTHING_PUBLISHED" };
  }

  const version = typeof snapshot.version === "number" ? snapshot.version : null;
  if (version !== null && version === state.currentVersion) {
    return { changed: false, version, reason: "UNCHANGED" };
  }

  // A snapshot with no version is not installed. `loadPinnedSnapshot` returns a versioned
  // snapshot or null; anything else is a shape this module cannot age, order or report, and
  // installing it would replace a known configuration with an unidentifiable one.
  if (version === null) {
    if (typeof deps.onError === "function") {
      deps.onError(new Error("the pinned snapshot carries no version and was not installed"));
    }
    return { changed: false, version: state.currentVersion, reason: "UNVERSIONED" };
  }

  const previous = state.currentVersion;
  deps.apply(snapshot);
  state.currentVersion = version;
  if (typeof deps.record === "function") {
    deps.record("config.version_adopted", { from: previous, to: version });
  }
  return { changed: true, version, reason: null };
}

/**
 * Start pulling.
 *
 * @param {object} deps as `refreshOnce`
 * @param {{ intervalMs?: number, checkIntervalSeconds?: number, currentVersion?: number|null }} [context]
 * @returns {{ stop: () => void, version: () => number|null, refreshOnce: () => Promise<object> }}
 */
function start(deps, context) {
  const settings = context || {};
  const intervalMs = Number.isFinite(settings.intervalMs)
    ? settings.intervalMs
    : Number.isFinite(settings.checkIntervalSeconds)
      ? settings.checkIntervalSeconds * MS_PER_SECOND
      : DEFAULT_INTERVAL_MS;

  const state = {
    currentVersion:
      typeof settings.currentVersion === "number" ? settings.currentVersion : null,
  };

  const handle = setInterval(() => {
    refreshOnce(deps, state).catch((error) => {
      // `refreshOnce` already routes a load failure to `onError`; this catches a throw from
      // `apply` itself. It must not take the process down, and it must not be silent.
      if (typeof deps.onError === "function") deps.onError(error);
    });
  }, intervalMs);

  if (typeof handle.unref === "function") handle.unref();

  return {
    stop() {
      clearInterval(handle);
    },
    version() {
      return state.currentVersion;
    },
    refreshOnce() {
      return refreshOnce(deps, state);
    },
  };
}

module.exports = { DEFAULT_INTERVAL_MS, refreshOnce, start };

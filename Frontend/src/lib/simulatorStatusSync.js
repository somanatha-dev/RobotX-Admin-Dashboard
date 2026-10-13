/**
 * Ordering for every asynchronous writer of `simulatorStatus` (`GET /api/simulator/status`).
 *
 * Two writers fetch the report: the full refresh (`refreshDbState`) and the five-second poll.
 * Neither was ordered against the other, so a slow response could land after a newer one and
 * put an older report back on screen — a station's occupancy or a robot's charging stage
 * stepping backwards until the next poll. The poll could also overlap itself on a slow backend.
 *
 * The policy, stated once:
 *   · every request takes a ticket when it STARTS (`begin`);
 *   · a response is applied only if no later-started request has been applied (`settle`) —
 *     the report a later request returns describes a later moment, so it wins;
 *   · `invalidate` makes every request already started stale (sign-out: nothing fetched for
 *     the previous session may repopulate the page);
 *   · the poller runs at most one request at a time, and releases that guard whatever the
 *     request does (resolves, returns nothing, throws) — a failed poll never stops polling.
 *
 * Pure: no React, no network, no timers. The caller supplies `apply` (the state setter) and
 * the fetch, so the ordering is driven deterministically by the tests.
 */

/**
 * @param {(value: object|null) => void} apply  writes the accepted report (the state setter)
 */
export function createSimulatorStatusSync(apply) {
  let issued = 0;
  let applied = 0;
  return {
    /** A ticket for a request that is starting now. */
    begin() {
      issued += 1;
      return issued;
    },
    /**
     * Apply a response, unless a later-started request has already been applied.
     * @returns {boolean} whether it was applied
     */
    settle(ticket, value) {
      if (!(ticket > applied)) return false;
      applied = ticket;
      apply(value);
      return true;
    },
    /** Every request started so far is stale from now on. */
    invalidate() {
      applied = issued;
    },
  };
}

export const POLL_OUTCOME = Object.freeze({
  APPLIED: 'APPLIED',
  /** Answered after a later-started request was applied (or after `invalidate`). */
  DISCARDED_STALE: 'DISCARDED_STALE',
  /** Answered after the poller was stopped. */
  DISCARDED_STOPPED: 'DISCARDED_STOPPED',
  /** The fetch answered nothing (the simulator API resolves `null` on failure): the last report stays. */
  EMPTY: 'EMPTY',
  FAILED: 'FAILED',
  SKIPPED_IN_FLIGHT: 'SKIPPED_IN_FLIGHT',
  SKIPPED_HIDDEN: 'SKIPPED_HIDDEN',
  STOPPED: 'STOPPED',
});

/**
 * The periodic poll, as a tick the caller's timer invokes.
 *
 * @param {object} options
 * @param {ReturnType<typeof createSimulatorStatusSync>} options.sync
 * @param {() => Promise<object|null>} options.fetchStatus
 * @param {() => boolean} [options.isVisible]  false skips the tick (a background tab)
 */
export function createSimulatorStatusPoller({ sync, fetchStatus, isVisible = () => true }) {
  let inFlight = false;
  let stopped = false;

  async function tick() {
    if (stopped) return POLL_OUTCOME.STOPPED;
    if (inFlight) return POLL_OUTCOME.SKIPPED_IN_FLIGHT;
    if (!isVisible()) return POLL_OUTCOME.SKIPPED_HIDDEN;
    inFlight = true;
    const ticket = sync.begin();
    try {
      const next = await fetchStatus();
      if (stopped) return POLL_OUTCOME.DISCARDED_STOPPED;
      // A poll that got nothing keeps the last report rather than blanking it (unchanged).
      if (!next) return POLL_OUTCOME.EMPTY;
      return sync.settle(ticket, next) ? POLL_OUTCOME.APPLIED : POLL_OUTCOME.DISCARDED_STALE;
    } catch {
      return POLL_OUTCOME.FAILED;
    } finally {
      inFlight = false;
    }
  }

  return {
    tick,
    /** No further tick runs, and a response still in flight is not applied. */
    stop() {
      stopped = true;
    },
    isInFlight: () => inFlight,
  };
}

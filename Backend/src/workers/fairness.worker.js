"use strict";

/**
 * §17.5's agent-starvation detector, and §17.4's escalation-capacity reading — **Tier 1**.
 *
 * REMEDIAL PHASE T1-04. `fairness/ladder.js` and `fairness/operatorCapacity.js` are
 * reached by a deadline: §4.3 makes `ESCALATION_LADDER` the expiry action of `QUEUED`, so
 * the timer worker drives them and they need no periodic caller of their own.
 * `fairness/agentStarvation.js` is the one T1-04 module that has no such trigger, and the
 * reason is the shape of what it detects:
 *
 * > **Detection**: an agent with zero completed missions in `fairness.idle_alert_period`
 * > while nominally available raises an alert.
 *
 * That is a statement about an *absence* over a window. No event announces it, no deadline
 * expires on it, and nothing in the round path has a reason to ask. A module built to
 * detect "nothing happened" that is only called when something happens detects nothing.
 * So this worker exists, and it exists for that one reason rather than as a home for
 * anything that might later look like fairness.
 *
 * ── Why the cadence is the alert period itself ─────────────────────────────
 * `fairness.idle_alert_period` (24 h by default, 1–168 h) is both the window and the tick.
 * No second parameter was registered for the interval, deliberately: an alert whose window
 * is a day does not become more informative by being recomputed every minute, and §22.1
 * admits no behavioural constant outside the register — so the alternative to reusing this
 * one is inventing a cadence parameter the specification does not name.
 *
 * ── What this worker deliberately does not do ──────────────────────────────
 * It does not **inject exercise missions**. §17.5's second mechanism — "periodic self-test
 * and short reposition missions, injected as Legs with `purpose = EXERCISE`" — needs a
 * destination, and choosing one is §17.3's repositioning, which `MODULE_TIERS` places at
 * **Tier 2**; §1.8 rule 2 forbids a Tier 1 mechanism from depending on it, and the module
 * does not exist in any case. `agentStarvation.exerciseCandidates` produces the list a
 * producer would consume, and every entry carries the blocker in its own `blockedBy`, so
 * the gap travels with the finding.
 *
 * It also does not **assess escalation saturation on a schedule**. §17.4's saturation
 * assessment runs inside `operatorCapacity.admit`, at the moment a Leg is actually
 * contending for a dispatcher — which is both when the answer matters and when the count
 * is already being read. A second periodic assessment would be a second reader of the same
 * rows arriving at the same answer a few seconds apart, and the first of them to disagree
 * would be a defect nobody could attribute.
 *
 * ── Errors ────────────────────────────────────────────────────────────────
 * A failed pass loses one window's alerting and never a decision: this worker reads and
 * reports, and writes nothing. It is reported through `onError` and the next tick retries.
 */

const agentStarvation = require("../engine/fairness/agentStarvation");
const clock = require("../engine/commitment/clock");

/** @structural milliseconds per second — a unit conversion, not a threshold */
const MS_PER_SECOND = 1000;

/**
 * One §17.5 detection pass.
 *
 * @param {object} deps
 * @param {object} deps.prisma
 * @param {string} [deps.regionId] scope the sweep to this shard's region
 * @param {number} [deps.idleAlertPeriodHours] `fairness.idle_alert_period`
 * @param {(event: string, detail: object) => void} [deps.record]
 * @returns {Promise<object>}
 */
async function runOnce(deps) {
  const settings = deps || {};
  if (!settings.prisma) {
    throw new TypeError("§17.5's detector reads the fleet and its commitments; no store client was supplied");
  }

  const detector = agentStarvation.create({
    prisma: settings.prisma,
    regionId: settings.regionId,
    idleAlertPeriodHours: settings.idleAlertPeriodHours,
    record: settings.record,
  });

  // The store's clock, not the worker's. §10.6: "wall clocks on workers are never
  // trusted" — and a window measured against a skewed worker clock would report a fleet
  // idle for a period it was not.
  const storeTime = await clock.readStoreTime(settings.prisma);
  return detector.assess({ storeTime });
}

/**
 * Schedule the detector.
 *
 * @param {object} deps as `runOnce`, plus `onError`
 * @param {object} [context]
 * @param {number} [context.intervalMs] defaults to `fairness.idle_alert_period`
 * @returns {{ stop: () => void }}
 */
function start(deps, context) {
  const settings = deps || {};
  const options = context || {};
  const intervalMs =
    Number.isFinite(options.intervalMs) && options.intervalMs > 0
      ? options.intervalMs
      : (agentStarvation.windowSecondsFrom(settings.idleAlertPeriodHours) || 0) * MS_PER_SECOND;

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError(
      "fairness.idle_alert_period did not resolve, so §17.5's detector has neither a window nor a cadence. " +
        "Starting on an invented interval would report a fleet against a period nobody published (§22.1).",
    );
  }

  const handle = setInterval(() => {
    runOnce(settings).catch((error) => {
      if (typeof settings.onError === "function") settings.onError(error);
    });
  }, intervalMs);

  if (typeof handle.unref === "function") handle.unref();

  return {
    stop() {
      clearInterval(handle);
    },
  };
}

module.exports = { runOnce, start };

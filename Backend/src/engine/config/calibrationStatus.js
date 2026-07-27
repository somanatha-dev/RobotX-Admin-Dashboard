"use strict";

/**
 * Calibration status and the tiered launch gate (§22.4).
 *
 * Calibration is not a task that follows implementation; for a cost-based allocator
 * it *is* a substantial part of the work. The register holds on the order of eighty
 * values, and a significant number of them require data the fleet does not yet
 * produce and cannot produce before it operates. Left unowned, the predictable
 * outcome is not a missed deadline but a loss of trust — the engine ships with
 * placeholder coefficients, its early decisions are indefensible when questioned,
 * and operators begin overriding it within weeks.
 *
 * The controls §22.4 states, and this module enforces:
 *
 *   - **Every register entry carries a status**, published with the value and
 *     visible in the resolution-explain query (§22.2).
 *   - **The launch gate is stated per tier (§1.8).** No Tier 0 parameter — every
 *     Safety-class entry in Appendix A — may be `PROVISIONAL` or `UNCALIBRATED` at
 *     launch. Tier 1 and Tier 2 parameters may launch `PROVISIONAL`, but each must
 *     name the data it awaits and a date by which it will be re-derived.
 *   - **A named calibration owner** is accountable for the register as a whole.
 *     Every entry names an owner; an entry without one is rejected.
 */

/**
 * The three statuses of §22.4.
 */
const CALIBRATION_STATUS = Object.freeze({
  /** Computed from a stated accounting or measured source, or by the Config Service. */
  DERIVED: "DERIVED",
  /** A defensible placeholder, with the data it awaits named. */
  PROVISIONAL: "PROVISIONAL",
  /** Nobody has looked at this yet. */
  UNCALIBRATED: "UNCALIBRATED",
});

const ALL_STATUSES = Object.freeze(Object.keys(CALIBRATION_STATUS));

/**
 * §22.4 glosses "Tier 0 parameter" as "every Safety-class entry in Appendix A", so
 * the change class is what selects the gate a parameter must pass.
 */
const TIER_ZERO_CHANGE_CLASS = "SAFETY";

/**
 * @param {string} status
 * @returns {boolean}
 */
function isKnownStatus(status) {
  return ALL_STATUSES.includes(status);
}

/**
 * Does this entry sit under the Tier 0 launch gate?
 *
 * @param {object} entry
 * @returns {boolean}
 */
function isTierZeroParameter(entry) {
  return entry.changeClass === TIER_ZERO_CHANGE_CLASS;
}

/**
 * Check one entry's calibration discipline.
 *
 * Two severities, deliberately distinguished:
 *   - `blocking` — the entry is malformed as a register entry, or a Safety-class
 *     entry is uncalibrated at a launch-gated publish. It cannot be published.
 *   - `launchGate` — the entry is publishable now but would fail the §22.4 launch
 *     gate. Phase 15 owns the gate; recording it here is what makes the Phase 15
 *     check a report rather than a discovery.
 *
 * @param {object} entry register entry
 * @param {{ enforceLaunchGate?: boolean }} [options]
 * @returns {{ blocking: string[], launchGate: string[] }}
 */
function checkEntry(entry, options) {
  const enforceLaunchGate = Boolean(options && options.enforceLaunchGate);
  const blocking = [];
  const launchGate = [];

  if (!isKnownStatus(entry.calibrationStatus)) {
    blocking.push(
      `${entry.name}: calibration status "${entry.calibrationStatus}" is not one of ` +
        `${ALL_STATUSES.join(" / ")} (§22.4)`,
    );
  }
  if (!entry.owner || String(entry.owner).trim() === "") {
    blocking.push(`${entry.name}: no owner. Every register entry names an accountable owner (§22.1 rule 2, §22.4)`);
  }

  const uncalibrated =
    entry.calibrationStatus === CALIBRATION_STATUS.PROVISIONAL ||
    entry.calibrationStatus === CALIBRATION_STATUS.UNCALIBRATED;

  if (uncalibrated && (!entry.awaits || String(entry.awaits).trim() === "")) {
    blocking.push(
      `${entry.name} is ${entry.calibrationStatus} but does not name the data it awaits. ` +
        "That naming is what distinguishes \"we chose a starting point deliberately\" from " +
        "\"nobody has looked at this\" (§22.4)",
    );
  }

  if (uncalibrated && isTierZeroParameter(entry)) {
    const message =
      `${entry.name} is a Safety-class (Tier 0) parameter at status ${entry.calibrationStatus}. ` +
      "No Tier 0 parameter may be PROVISIONAL or UNCALIBRATED at launch (§22.4).";
    if (enforceLaunchGate) blocking.push(message);
    else launchGate.push(message);
  }

  if (uncalibrated && !isTierZeroParameter(entry) && !entry.awaitsBy) {
    launchGate.push(
      `${entry.name} is ${entry.calibrationStatus} and names no date by which it will be ` +
        "re-derived (§22.4). Tier 1 and Tier 2 parameters may launch PROVISIONAL, but each " +
        "must name both the data it awaits and that date.",
    );
  }

  return { blocking, launchGate };
}

/**
 * Check calibration discipline across a whole register.
 *
 * @param {Iterable<object>} entries
 * @param {{ enforceLaunchGate?: boolean }} [options]
 * @returns {{ ok: boolean, blocking: string[], launchGate: string[],
 *             counts: Record<string, number> }}
 */
function checkRegister(entries, options) {
  const blocking = [];
  const launchGate = [];
  const counts = { DERIVED: 0, PROVISIONAL: 0, UNCALIBRATED: 0 };

  for (const entry of entries) {
    const result = checkEntry(entry, options);
    blocking.push(...result.blocking);
    launchGate.push(...result.launchGate);
    if (isKnownStatus(entry.calibrationStatus)) counts[entry.calibrationStatus] += 1;
  }

  return { ok: blocking.length === 0, blocking, launchGate, counts };
}

module.exports = {
  CALIBRATION_STATUS,
  ALL_STATUSES,
  TIER_ZERO_CHANGE_CLASS,
  isKnownStatus,
  isTierZeroParameter,
  checkEntry,
  checkRegister,
};

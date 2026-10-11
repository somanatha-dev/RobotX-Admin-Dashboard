/**
 * Which status the dashboard shows when the server's `Robot.status` and the robot's own live
 * report disagree — the read-side half of §23.5's asymmetric health rule.
 *
 *   > Health / self-report | Accepted for **restricting** the agent (an agent may always
 *   > declare itself unfit) but never for **expanding** eligibility.
 *
 * The write side already enforces this: `telemetry.handler` refuses to persist a self-report
 * that raises the health tier (P14-R15), so a PAUSED or ERROR robot stays PAUSED or ERROR in the
 * database until an operator clears it. But the live state in KV (`robot:{id}`) and the
 * `robot:update` broadcast carry the robot's RAW report, and `GET /api/robots/state` overlaid
 * that over the row — so a PAUSED robot still reporting IDLE was shown to operators as IDLE,
 * available, while it held a task (Phase 5).
 *
 * The rule here is the same rule, read from the same tier map (`agentFacts.HEALTH_TIER_BY_STATUS`,
 * ordered by f09's §16.4 order), not a list of special cases:
 *
 *   · the report is at the persisted tier or below it (ACTIVE over IDLE, CHARGING over IDLE,
 *     ERROR over IDLE) — the report is shown: it is fresher, and it restricts or keeps the tier;
 *   · the report is ABOVE the persisted tier (IDLE over PAUSED, ACTIVE over ERROR) — the
 *     persisted status is shown: a self-report never displays a robot as fitter than the
 *     server holds it to be;
 *   · no report, or a report outside the tier map — the persisted status;
 *   · a persisted status outside the tier map (none exists today) — the report.
 *
 * A report is ranked by the status it is PERSISTED as (`toPersistedStatus`), exactly as the
 * write side ranks it, or by its own tier when it has no persisted form.
 *
 * P7-D1 — CHARGING has no persisted form. It used to be stored as PAUSED, which is an operator
 * hold (F3), so every robot that docked once was held for good: its IDLE after the charge was
 * a self-report raising its own tier, and §23.5 refused it. Charging is an occupancy, owned by
 * the Charging Scheduler's reservation (and, while a robot says it is charging, by F18's
 * restriction on that report), not a health statement. It ranks at its own tier,
 * `HEALTH_TIER_BY_STATUS.CHARGING` (NOMINAL): shown over IDLE or ACTIVE, and never shown over
 * a persisted PAUSED or ERROR — a charge does not display a hold or a fault away.
 */

const { HEALTH_TIER_BY_STATUS } = require("./agentFacts.service");
const { HEALTH_TIER_ORDER } = require("../engine/feasibility/predicates/f09");

/**
 * The `RobotStatus` a robot's reported status is stored as, or `null` when the report is not
 * stored at all. RETURNING and CHARGING are labels only robots use; the enum has neither.
 * Shared with `telemetry.handler`, which writes it.
 * @param {string} status
 * @returns {string|null}
 */
function toPersistedStatus(status) {
  // RETURNING is displayed as ACTIVE in the DB (robot is in transit).
  if (status === "RETURNING") return "ACTIVE";
  // P7-D1 — CHARGING is not stored. It used to become PAUSED, an operator hold that the robot
  // could then never clear (see the header). The raw "CHARGING" is still kept in the live
  // registry and broadcast to the dashboard; occupancy is the reservation's.
  if (status === "CHARGING") return null;
  return status;
}

/** @returns {number} the status's tier rank (higher = fitter), or -1 when it has none */
function rankOf(status) {
  if (typeof status !== "string") return -1;
  const normalised = status.trim().toUpperCase();
  const persisted = toPersistedStatus(normalised);
  const tier = HEALTH_TIER_BY_STATUS[persisted === null ? normalised : persisted];
  return tier ? HEALTH_TIER_ORDER.indexOf(tier) : -1;
}

/**
 * @param {string|null|undefined} persisted `Robot.status`
 * @param {string|null|undefined} reported the live report (KV `robot:{id}`.status, a telemetry frame)
 * @returns {string|null|undefined} the status to display
 */
function displayedStatus(persisted, reported) {
  const reportedText = typeof reported === "string" ? reported.trim() : "";
  if (!reportedText) return persisted;
  const reportedRank = rankOf(reportedText);
  if (reportedRank < 0) return persisted ?? reportedText;
  const persistedRank = rankOf(persisted);
  if (persistedRank < 0) return reportedText;
  return reportedRank > persistedRank ? persisted : reportedText;
}

module.exports = { displayedStatus, toPersistedStatus };

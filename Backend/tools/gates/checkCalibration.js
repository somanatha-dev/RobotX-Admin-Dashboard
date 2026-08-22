"use strict";

/**
 * LAUNCH GATE — §22.4: no Safety-class parameter may be `PROVISIONAL` or
 * `UNCALIBRATED` at launch.
 *
 * > **The launch gate is stated per tier (§1.8).** No Tier 0 parameter — every
 * > Safety-class entry in Appendix A — may be `PROVISIONAL` or `UNCALIBRATED` at launch.
 * > Tier 1 and Tier 2 parameters may launch `PROVISIONAL`, but each must name the data
 * > it awaits and a date by which it will be re-derived. This is what distinguishes "we
 * > chose a starting point deliberately" from "nobody has looked at this."
 *
 * > **Configuration updates** — `ENGINE_ENABLED=true` per shard, staged; every
 * > Safety-class parameter must be `DERIVED` (not `PROVISIONAL`) — **this is a hard
 * > launch gate (§22.4)**. (execution plan, Phase 15)
 *
 * ── Why this is a LAUNCH gate and not a BUILD gate ─────────────────────────
 * It is deliberately **not** wired into `npm run gates`, and the distinction matters.
 *
 * The other five gates in this directory assert properties of the *code*: a tier
 * dependency, a bare constant, a tenet violation, an identifying field in a cost term,
 * an erasure that changes a replayed cost. Each is a defect that a commit introduced and
 * a commit can fix, so blocking the build is the right response.
 *
 * This gate asserts a property of the *organisation*. §22.4 names a **calibration
 * owner** — "a standing role, not a project task, and it is a launch prerequisite" — and
 * says of the values themselves that "a significant number of them … require data the
 * fleet does not yet produce and cannot produce before it operates". A red result here
 * is not a commit to revert. It is work that ops, finance and safety have not yet done,
 * and the execution plan lists it as blocking pre-work item B8 for exactly that reason.
 *
 * Blocking every build on it would produce the one outcome §22.4 predicts and warns
 * against — the pressure to make the red go away rather than to do the derivation:
 *
 * > the predictable outcome is not a missed deadline but a loss of trust: the engine
 * > ships with placeholder coefficients, its early decisions are indefensible when
 * > questioned, operators begin overriding it within weeks…
 *
 * So the gate blocks the thing it is a gate on. `src/engine/cutover/stage.js` calls
 * `cutover/gates.blockers()` before it will authorise **any** shard, and
 * `calibration_safety_derived` is one of the blocking rows there. A red gate therefore
 * makes the cutover mechanically impossible while leaving the build green — which is
 * precisely what "hard launch gate" means and what "build gate" does not.
 *
 * ── What counts as derived ──────────────────────────────────────────────────
 * `DERIVED` alone is not accepted for a Safety-class entry. §22.4 defines the status as
 * "`DERIVED` (**from a stated accounting or measured source**)" and item 1 is "derive,
 * don't guess" — and a status field can be edited without the derivation existing. A
 * Safety-class entry claiming `DERIVED` must therefore carry a `derivation`, or a
 * `section`/`requiredBy` pair that traces the number to the text that fixes it and the
 * module that consumes it. One that carries neither is `SAFETY_DERIVATION_NOT_STATED`,
 * and it blocks: it is a *claim* where `PROVISIONAL` would have been an *admission*, and
 * the claim is the more dangerous of the two.
 *
 * The same check runs over non-Safety entries as `DERIVATION_NOT_STATED`, but advisory —
 * §22.4's launch gate is stated per tier, and Tier 1 and Tier 2 values may launch
 * provisional, so a weaker record for them is a quality signal rather than a blocker.
 *
 * Symmetrically, a `PROVISIONAL` entry that names no `awaits` is reported, because §22.4
 * requires each to "name the data it awaits". Advisory, for the same reason.
 *
 * Usage:
 *   node tools/gates/checkCalibration.js [--json] [--all]
 * Exit code 0 when no blocking finding remains, 1 otherwise.
 */

const path = require("path");

const service = require("../../src/engine/config/service");

const SAFETY_CLASS = "SAFETY";

/** @structural the three §22.4 calibration statuses */
const STATUS = Object.freeze({
  DERIVED: "DERIVED",
  PROVISIONAL: "PROVISIONAL",
  UNCALIBRATED: "UNCALIBRATED",
});

/** Finding kinds, in descending severity. */
const FINDING = Object.freeze({
  /** Safety-class and not DERIVED. Blocks the cutover. */
  SAFETY_NOT_DERIVED: "SAFETY_NOT_DERIVED",
  /** Safety-class, claims DERIVED, states no source. Blocks the cutover. */
  SAFETY_DERIVATION_NOT_STATED: "SAFETY_DERIVATION_NOT_STATED",
  /** Non-Safety, claims DERIVED, states no source. Advisory. */
  DERIVATION_NOT_STATED: "DERIVATION_NOT_STATED",
  /** A PROVISIONAL entry naming no data it awaits. Advisory. */
  PROVISIONAL_WITHOUT_AWAITS: "PROVISIONAL_WITHOUT_AWAITS",
  /** An unknown calibration status. Blocks: an unrecognised status is not a status. */
  UNKNOWN_STATUS: "UNKNOWN_STATUS",
});

/**
 * Does an entry record where its value came from?
 *
 * @param {object} entry
 * @returns {boolean}
 */
function hasSubstantiation(entry) {
  if (entry.derivation && String(entry.derivation).trim()) return true;

  /**
   * ── PHASE 15 REMEDIATION — the fallback is not available to a Safety-class entry ──
   *
   * `section` cites the specification text near the value and `requiredBy` names the module
   * that consumes it. The original reading was that together they are "a traceable
   * derivation". They are not, and the register itself is the proof: **both fields are
   * carried by essentially every row**, because they are the register's universal
   * cross-reference convention rather than a claim about where a number came from.
   *
   * That made this check inert for exactly the rows it exists to protect. Flipping all 39
   * non-derived Safety-class entries from `PROVISIONAL`/`UNCALIBRATED` to `DERIVED` — one
   * word each, no other change — left **eleven of them reported clean by this gate**, among
   * them `security.position_plausibility_tolerance` (the kinematic ceiling on position
   * reports), `ops.emergency_services_hazard_threshold`, and `ops.external_escalation_contacts`.
   * A launch gate that a one-word edit can satisfy is a launch gate in name.
   *
   * §22.4 defines the status as "`DERIVED` (**from a stated accounting or measured
   * source**)". A cross-reference is neither. So for a Safety-class entry the `derivation`
   * field is required outright: the row must *state* where the number came from, in the row.
   * The thirteen Safety-class entries that legitimately hold this status today already do —
   * the nine Tier 2 kill switches cite §1.8 rule 3, which fixes their value directly, and
   * `agent.dedup_retention` records a measured span.
   *
   * The fallback remains available to non-Safety entries, where §22.4's launch gate is
   * stated per tier and a weaker record is a quality signal rather than a blocker.
   */
  if (entry.changeClass === SAFETY_CLASS) return false;

  return Boolean(entry.section && String(entry.section).trim() && entry.requiredBy && String(entry.requiredBy).trim());
}

/**
 * Run the gate over the parameter register.
 *
 * @param {{ directory?: string }} [options]
 * @returns {{ ok: boolean, blocking: object[], advisory: object[], counts: object,
 *   safetyTotal: number, total: number }}
 */
function checkCalibration(options) {
  const settings = options || {};
  const register = service.loadRegister({ reload: true, directory: settings.directory });

  const blocking = [];
  const advisory = [];
  const counts = { DERIVED: 0, PROVISIONAL: 0, UNCALIBRATED: 0, UNKNOWN: 0 };
  let safetyTotal = 0;

  for (const [name, entry] of register.entries) {
    const status = entry.calibrationStatus;
    const isSafety = entry.changeClass === SAFETY_CLASS;
    if (isSafety) safetyTotal += 1;

    if (!Object.values(STATUS).includes(status)) {
      counts.UNKNOWN += 1;
      blocking.push({
        kind: FINDING.UNKNOWN_STATUS,
        name,
        changeClass: entry.changeClass || null,
        status: status === undefined ? null : status,
        detail:
          "every register entry carries one of DERIVED / PROVISIONAL / UNCALIBRATED (§22.4). " +
          "An unrecognised status is published with the value and read by the resolution-explain query.",
      });
      continue;
    }

    counts[status] += 1;

    if (isSafety && status !== STATUS.DERIVED) {
      blocking.push({
        kind: FINDING.SAFETY_NOT_DERIVED,
        name,
        changeClass: entry.changeClass,
        status,
        owner: entry.owner || null,
        awaits: entry.awaits || null,
        section: entry.section || null,
        detail:
          `Safety-class and ${status}. §22.4: no Tier 0 parameter may be PROVISIONAL or UNCALIBRATED at ` +
          `launch. ${entry.awaits ? `Awaits: ${entry.awaits}` : "No awaited data is named, which is a second finding."}`,
      });
      continue;
    }

    if (status === STATUS.DERIVED && !hasSubstantiation(entry)) {
      const finding = {
        kind: isSafety ? FINDING.SAFETY_DERIVATION_NOT_STATED : FINDING.DERIVATION_NOT_STATED,
        name,
        changeClass: entry.changeClass || null,
        status,
        owner: entry.owner || null,
        detail:
          "claims DERIVED but records no derivation, and no (section, requiredBy) pair either. §22.4 defines " +
          "DERIVED as 'from a stated accounting or measured source'; a status field can be edited without " +
          `the source existing.${isSafety ? "" : " Advisory: §22.4's launch gate is stated per tier."}`,
      };
      (isSafety ? blocking : advisory).push(finding);
      continue;
    }

    if (status === STATUS.PROVISIONAL && !entry.awaits) {
      advisory.push({
        kind: FINDING.PROVISIONAL_WITHOUT_AWAITS,
        name,
        changeClass: entry.changeClass || null,
        status,
        owner: entry.owner || null,
        detail:
          "PROVISIONAL and names no data it awaits. §22.4: 'Tier 1 and Tier 2 parameters may launch " +
          "PROVISIONAL, but each must name the data it awaits'. Advisory — this does not block the cutover.",
      });
    }
  }

  blocking.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  advisory.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    ok: blocking.length === 0,
    blocking,
    advisory,
    counts,
    safetyTotal,
    total: register.entries.size,
  };
}

/**
 * Render for a terminal.
 *
 * @param {ReturnType<typeof checkCalibration>} result
 * @param {{ all?: boolean }} [options]
 * @returns {string}
 */
function formatReport(result, options) {
  const settings = options || {};
  const header = "launch gate: calibration (§22.4) — NOT wired into `npm run gates`; it blocks the cutover, not the build";
  const tally =
    `  ${result.total} entr(ies): ${result.counts.DERIVED} DERIVED, ${result.counts.PROVISIONAL} PROVISIONAL, ` +
    `${result.counts.UNCALIBRATED} UNCALIBRATED. ${result.safetyTotal} are Safety-class.`;

  if (result.ok) {
    const advisoryNote =
      result.advisory.length > 0 ? `\n  ${result.advisory.length} advisory finding(s) — see --all.` : "";
    return `${header}\n  PASS — every Safety-class parameter is DERIVED and substantiated.\n${tally}${advisoryNote}`;
  }

  const lines = result.blocking.map(
    (finding) => `    ${finding.name}\n        [${finding.kind}] ${finding.detail}`,
  );
  const advisoryLines =
    settings.all && result.advisory.length > 0
      ? `\n  advisory (${result.advisory.length}):\n` +
        result.advisory.map((finding) => `    ${finding.name}  [${finding.kind}]`).join("\n")
      : "";

  return (
    `${header}\n  FAIL — ${result.blocking.length} blocking finding(s). This is execution-plan pre-work item B8: ` +
    "a named calibration owner and derived Safety-class values are launch prerequisites (§22.4), not code changes.\n" +
    `${tally}\n${lines.join("\n")}${advisoryLines}`
  );
}

module.exports = { STATUS, FINDING, hasSubstantiation, checkCalibration, formatReport };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const directoryFlag = argv.indexOf("--directory");
  const options = {};
  if (directoryFlag !== -1 && argv[directoryFlag + 1]) options.directory = path.resolve(argv[directoryFlag + 1]);

  const result = checkCalibration(options);
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(result, { all: argv.includes("--all") })}\n`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

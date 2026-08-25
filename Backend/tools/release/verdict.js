"use strict";

/**
 * The release verdict — the whole §24 gate table, judged, with an exit code that means it.
 *
 * ── The defect this tool exists to close ───────────────────────────────────
 * `npm run release:gates` used to be a shell conjunction of five commands:
 *
 *     npm run gates && npm run gate:calibration && npm run test:chaos && npm run test:scale && npm run safety:case
 *
 * Three things were wrong with reading its exit code as a release decision.
 *
 *   1. **It did not cover the table.** Twenty-three gates are blocking; that chain touched
 *      the evidence for fewer than half of them. `sim:fidelity` was not in it at all.
 *   2. **Two of its members exited 0 while reporting failure.** `simFidelity/validate.js`
 *      exited 0 with every safety-relevant model `NOT_MEASURED`, and
 *      `safetyCase/assemble.js` exits 0 while printing "23 not evaluated" — its `ok` is
 *      about whether references resolve, which is a different question and a fair one.
 *   3. **Nothing aggregated.** `NOT_EVALUATED` blocks a cutover exactly as `RED` does
 *      (`gates.js`), but no command anywhere returned non-zero because of one.
 *
 * The combined effect: discharge the calibration gate and that chain exits 0 with six
 * blocking gates never evaluated. A green release verdict, from a build that had not looked.
 *
 * This tool is the aggregator. It reads the evidence produced by
 * `tools/release/collectEvidence.js` — plus whatever attestations an operator has filed for
 * the gates a build may not close — judges the **whole** table through `gates.evaluate()`,
 * and exits non-zero unless every blocking gate is `GREEN`. `NOT_EVALUATED` is not a pass
 * here, which is the one property the previous chain lacked.
 *
 * ── It judges; it does not produce ─────────────────────────────────────────
 * Nothing in this file can turn a gate green. It reads records and applies
 * `cutover/evidence.js`'s admission rules, the same ones `stage.authoriseEnable()` applies
 * before it will authorise a shard. A verdict this tool reports GREEN and a cutover the
 * stage controller refuses would be two answers to one question, so there is exactly one
 * implementation of the question.
 *
 * Usage:
 *   node tools/release/verdict.js [--evidence <file>] [--attestations <file>] [--json]
 *                                 [--max-age-hours <n>]
 */

const fs = require("fs");
const path = require("path");

const gates = require("../../src/engine/cutover/gates");
const evidenceContract = require("../../src/engine/cutover/evidence");
const service = require("../../src/engine/config/service");
const { sourceDigest } = require("./sourceDigest");

const BACKEND_ROOT = path.join(__dirname, "..", "..");
const DEFAULT_EVIDENCE = path.join(BACKEND_ROOT, "docs", "release-evidence.json");
const DEFAULT_ATTESTATIONS = path.join(BACKEND_ROOT, "docs", "release-attestations.json");

/**
 * How stale a build-gate record may be before it stops describing this tree.
 *
 * Deliberately generous, because the digest — not the clock — is what actually binds a run
 * record to the source it ran against. The age bound exists for the records the digest
 * cannot bind: an attestation about a rollback rehearsal, an observation window from a soak.
 * A day is short enough that nobody re-uses last quarter's evidence and long enough that a
 * legitimate multi-hour suite run is still admissible when the verdict is taken.
 *
 * @structural the default evidence age bound; overridable per run with --max-age-hours
 */
const DEFAULT_MAX_AGE_HOURS = 24;

/** @structural milliseconds per hour — a unit conversion, not a tunable */
const MS_PER_HOUR = 3600000;

function readJson(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not readable JSON: ${error.message}`);
  }
}

/**
 * Judge the table.
 *
 * @param {{ evidenceFile?: string, attestationsFile?: string, nowMs?: number,
 *   maxAgeMs?: number, root?: string }} [options]
 * @returns {{ ok: boolean, evaluation: object, sources: object, blocking: object[] }}
 */
function verdict(options) {
  const settings = options || {};
  const nowMs = typeof settings.nowMs === "number" ? settings.nowMs : Date.now();
  const maxAgeMs =
    typeof settings.maxAgeMs === "number" ? settings.maxAgeMs : DEFAULT_MAX_AGE_HOURS * MS_PER_HOUR;

  const evidenceDocument = readJson(settings.evidenceFile === undefined ? DEFAULT_EVIDENCE : settings.evidenceFile);
  const attestationDocument = readJson(
    settings.attestationsFile === undefined ? DEFAULT_ATTESTATIONS : settings.attestationsFile,
  );

  // Attestations are merged *under* nothing — a build record and an attestation for the same
  // gate is a contradiction, and the later key would silently win. Collect the collision
  // instead and let the gate go RED on it.
  const fromEvidence = (evidenceDocument && evidenceDocument.evidence) || {};
  const fromAttestations = (attestationDocument && attestationDocument.attestations) || {};
  const collisions = Object.keys(fromAttestations).filter((id) => Object.hasOwn(fromEvidence, id));
  const merged = { ...fromEvidence, ...fromAttestations };
  for (const id of collisions) {
    merged[id] = { gateId: id, producer: "collision", producedAtMs: nowMs, pass: false };
  }

  const { digest } = sourceDigest({ root: settings.root });

  // The duration bounds come from the register, not from this file. `resolveMinObservationMs`
  // omits any parameter that does not resolve, and `evidence.js` refuses a gate whose bound
  // is missing — so a register that lost `release.soak_duration` reddens the soak gate rather
  // than un-bounding it.
  const register = service.loadRegister({ reload: true });
  const values = {
    get: (name) => {
      const entry = register.entries.get(name);
      return entry ? entry.default : undefined;
    },
  };

  const evaluation = gates.evaluate(merged, {
    nowMs,
    maxAgeMs,
    sourceDigest: digest,
    minObservationMs: evidenceContract.resolveMinObservationMs(values),
  });

  return {
    ok: evaluation.ok,
    evaluation,
    collisions,
    sources: {
      evidence: evidenceDocument ? path.relative(BACKEND_ROOT, settings.evidenceFile || DEFAULT_EVIDENCE) : null,
      attestations: attestationDocument
        ? path.relative(BACKEND_ROOT, settings.attestationsFile || DEFAULT_ATTESTATIONS)
        : null,
      sourceDigest: digest,
      maxAgeMs,
    },
    blocking: evaluation.results.filter((row) => row.blocking && row.status !== gates.STATUS.GREEN),
  };
}

/**
 * Render for a terminal.
 *
 * @param {ReturnType<typeof verdict>} result
 * @returns {string}
 */
function formatReport(result) {
  const rows = result.evaluation.results.map((row) => {
    const reason = row.inadmissibleCode ? `  [${row.inadmissibleCode}] ${row.detail || ""}` : row.detail ? `  ${row.detail}` : "";
    /**
     * A GREEN whose command does not establish the gate's statement is printed as
     * such (blocker B-M). Without this line the table's most misleading row is also
     * its most reassuring one: `model_check_capacity_1_2_3` reads GREEN while the run
     * that greened it asserts the lifecycle is *not* exhaustively checked at any
     * shipped capacity. A reader of this table must not have to know that already.
     */
    const unproven = row.notEstablished ? `\n${" ".repeat(4)}[NOT PROVEN] ${row.notEstablished}` : "";
    return `  ${row.status.padEnd(13)} ${row.id.padEnd(36)} ${row.evidence.padEnd(15)} ${row.section}${reason ? `\n${" ".repeat(4)}${reason.trim()}` : ""}${unproven}`;
  });

  const counts = result.evaluation.counts;
  const header =
    `RELEASE VERDICT — §24 gate table (${gates.RELEASE_GATES.length} gates, all blocking)\n` +
    `  source digest ${result.sources.sourceDigest.slice(0, 16)}…   evidence: ${result.sources.evidence || "(none)"}` +
    `   attestations: ${result.sources.attestations || "(none)"}\n` +
    `  ${counts.GREEN} green, ${counts.RED} red, ${counts.NOT_EVALUATED} not evaluated`;

  const collision =
    result.collisions.length > 0
      ? `\n  CONTRADICTION — a build record and an attestation were both filed for: ${result.collisions.join(", ")}`
      : "";

  const unknown =
    result.evaluation.unknownEvidence.length > 0
      ? `\n  evidence filed against unknown gate id(s): ${result.evaluation.unknownEvidence.join(", ")}`
      : "";

  const tail = result.ok
    ? "\n  RELEASE: GREEN — every blocking gate is discharged by admissible evidence."
    : `\n  RELEASE: BLOCKED — ${result.blocking.length} blocking gate(s) are not green. NOT_EVALUATED blocks ` +
      "exactly as RED does (§24); it is kept distinct so an incident review can tell 'we ran it and it failed' " +
      "from 'nobody ran it'.";

  return `${header}\n${rows.join("\n")}${collision}${unknown}${tail}`;
}

module.exports = { DEFAULT_EVIDENCE, DEFAULT_ATTESTATIONS, DEFAULT_MAX_AGE_HOURS, verdict, formatReport };

if (require.main === module) {
  const argv = process.argv.slice(2);
  /**
   * A flag that was *given* is read as given, empty or not.
   *
   * PHASE 15, pass 3 verification (P15-F3). This tested `argv[index + 1]` for
   * truthiness, so an **empty** value made the flag read as absent and the run silently
   * took `DEFAULT_MAX_AGE_HOURS` — while every other malformed value (`NaN`,
   * `Infinity`, `banana`, `-1`) was correctly refused with exit 2 by the validator two
   * screens down. The validator was not lenient about the empty string; it never saw it.
   *
   * The realistic way to produce one is not a typo but a shell: `--max-age-hours
   * "$MAX_AGE"` with `MAX_AGE` unset expands to exactly this, and the operator who
   * intended a *stricter* bound than the default gets the default with no message. The
   * distinction that matters is "the flag is absent" versus "the flag was given a value
   * I cannot use", and only the first may fall back to a default.
   */
  const at = (flag) => {
    const index = argv.indexOf(flag);
    return index !== -1 ? argv[index + 1] : undefined;
  };
  const maxAgeHours = at("--max-age-hours");

  if (argv.includes("--max-age-hours") && String(maxAgeHours || "").trim() === "") {
    process.stderr.write(
      "--max-age-hours was given with no value. A bound the operator asked for and did not supply is not the " +
        "default bound; it is an unanswered question, and evidence age is the only binding PRODUCTION and " +
        "ORGANISATIONAL records have.\n",
    );
    process.exitCode = 2;
    return;
  }

  /**
   * P15-C1 — a bound that does not parse must not become no bound.
   *
   * `Number("banana")` is `NaN`, `typeof NaN === "number"`, and every comparison against
   * `NaN` is false. Forwarding it turned `--max-age-hours <typo>` into "no record is ever
   * stale", silently and with no message anywhere. `evidence.admit()` now refuses a
   * non-finite bound, so this would fail closed as `AGE_BOUND_REQUIRED` on every gate; it is
   * still refused here, up front, because the operator's mistake is a typo in an argument
   * and the report they would otherwise read is twenty-four inadmissible records.
   */
  if (maxAgeHours !== undefined) {
    const parsed = Number(maxAgeHours);
    if (!Number.isFinite(parsed) || parsed < 0) {
      process.stderr.write(
        `--max-age-hours must be a non-negative number of hours; got "${maxAgeHours}". ` +
          "A bound that does not parse is not a wider bound, it is no bound, and evidence age is the only " +
          "binding PRODUCTION and ORGANISATIONAL records have.\n",
      );
      process.exitCode = 2;
      return;
    }
  }

  /**
   * `--collect` runs the producer first, in this process's own working tree, and then
   * judges what it produced. It is one flag rather than a shell conjunction because a
   * conjunction short-circuits: `collect && verdict` would skip the verdict on the very runs
   * where a gate failed, which are the runs whose verdict matters most. Here the collector's
   * exit code is deliberately ignored — it is recorded in the evidence it wrote, and the
   * table below is what decides.
   */
  if (argv.includes("--collect")) {
    const collector = require("./collectEvidence");
    const only = at("--only") || "all";
    const out = at("--evidence") || DEFAULT_EVIDENCE;
    const collected = collector.collect({ only });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(
      out,
      `${JSON.stringify(
        {
          schema: "robotx.release-evidence.v1",
          producedAtMs: Date.now(),
          producer: collector.PRODUCER,
          sourceDigest: collected.sourceDigest,
          only,
          evidence: collected.evidence,
          corroboration: collected.corroboration,
        },
        null,
        2,
      )}\n`,
    );
    process.stdout.write(`${collector.formatReport(collected)}\n\n`);
  }

  const result = verdict({
    evidenceFile: at("--evidence"),
    attestationsFile: at("--attestations"),
    maxAgeMs: maxAgeHours ? Number(maxAgeHours) * MS_PER_HOUR : undefined,
  });

  if (argv.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${formatReport(result)}\n`);

  process.exitCode = result.ok ? 0 : 1;
}

"use strict";

/**
 * BATCH 2 — mutation testing for the development Charging Scheduler and the index
 * maintainer's charging classifier.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A passing suite says the code does what the tests describe. It does not say the tests
 * would notice if the code stopped doing it. Every property this batch claims is a
 * *negative* — never four robots on three plugs, never LIFO, never a duplicate
 * reservation, never a widened unknown — and a negative is exactly the kind of claim a
 * test can assert while resting on something else entirely.
 *
 * So each mutant below breaks one property deliberately, the suite is re-run, and the
 * result is recorded as KILLED (at least one test failed) or SURVIVED (the suite stayed
 * green over provably wrong code). A survivor is a gap in the tests, and it is reported as
 * one rather than explained away.
 *
 * ── How it runs ─────────────────────────────────────────────────────────────
 *   node tools/verify/batch2Mutants.js [--json]
 *
 * Each mutant is a literal text substitution applied to a source file on disk, with the
 * original restored afterwards — including on a crash or a Ctrl-C, because a harness that
 * can leave a mutant in the tree is worse than no harness. The substitution is required to
 * match **exactly once**; a mutant whose anchor no longer matches is reported as
 * `NOT_APPLICABLE` rather than silently skipped, so this file cannot rot into a set of
 * no-ops that all "pass".
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const BACKEND_ROOT = path.join(__dirname, "..", "..");

const SCHEDULER = "src/simulation/devChargingScheduler.js";
const STATUS = "src/services/chargingStatus.service.js";
const MAINTAINER = "src/workers/indexMaintainer.worker.js";

/**
 * The ten mutants Batch 2 is required to kill, each named by the property it breaks.
 * @structural the mutant catalogue, not tunable values
 */
const MUTANTS = Object.freeze([
  {
    id: "M1",
    property: "at most three robots charge at once",
    file: SCHEDULER,
    from: "  plugCount: 3,",
    to: "  plugCount: 4,",
  },
  {
    id: "M2",
    property: "the queue is FIFO",
    file: SCHEDULER,
    from: 'orderBy: [{ reservedFrom: "asc" }, { reservationId: "asc" }],\n        take: free,',
    to: 'orderBy: [{ reservedFrom: "desc" }, { reservationId: "desc" }],\n        take: free,',
  },
  {
    id: "M3",
    property: "a retried request creates no second reservation",
    file: SCHEDULER,
    from: "    if (existing) {\n      return { ok: true, created: false, reservation: existing, problems: [] };\n    }",
    to: "    if (false && existing) {\n      return { ok: true, created: false, reservation: existing, problems: [] };\n    }",
  },
  {
    id: "M4",
    property: "an unknown charging state is not 'not charging'",
    file: STATUS,
    from: "      if (covered !== true) {\n        return unknown(",
    to: "      if (false) {\n        return unknown(",
  },
  {
    id: "M5",
    property: "charging is never fabricated as true",
    file: STATUS,
    from: "      if (!reservation) {",
    to: "      if (false) {",
  },
  {
    id: "M6",
    property: "a physical agent is never covered by the simulated scheduler",
    file: STATUS,
    from: "      const covered = await inScope({",
    to: "      const covered = true || await inScope({",
  },
  {
    id: "M7",
    property: "leaving the charger releases the plug",
    file: SCHEDULER,
    from: "    if (live.length === 0) return false;",
    to: "    if (live.length >= 0) return false;",
  },
  {
    id: "M8",
    property: "a new arrival never bypasses the queue",
    file: SCHEDULER,
    from: "          state: RESERVATION_STATE.QUEUED,\n          projectionVersion: capacity.version,",
    to: "          state: RESERVATION_STATE.ACTIVE,\n          projectionVersion: capacity.version,",
  },
  {
    id: "M9",
    property: "the maintainer refuses an agent whose charging state is unknown",
    file: MAINTAINER,
    from: "  if (charging.known !== true) return null;",
    to: "  if (false) return null;",
  },
  {
    id: "M10",
    property: "a stale reservation does not hold a plug indefinitely",
    file: SCHEDULER,
    from: "        reservedUntil: { lt: new Date(nowMs) },",
    to: "        reservedUntil: { lt: new Date(0) },",
  },
]);

/** The suites a mutant is judged against. */
const SUITES = Object.freeze(["devChargingScheduler", "positionObservationPipeline"]);

function read(relative) {
  return fs.readFileSync(path.join(BACKEND_ROOT, relative), "utf8");
}

function write(relative, contents) {
  fs.writeFileSync(path.join(BACKEND_ROOT, relative), contents);
}

/**
 * Run the suites. Exit code 0 means every test passed — i.e. the mutant SURVIVED.
 *
 * @returns {{ passed: boolean, output: string }}
 */
function runSuites() {
  try {
    const output = execFileSync(
      process.execPath,
      [path.join(BACKEND_ROOT, "node_modules", "jest", "bin", "jest.js"), "--runInBand", "--forceExit", ...SUITES],
      { cwd: BACKEND_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 },
    );
    return { passed: true, output };
  } catch (error) {
    return { passed: false, output: `${error.stdout || ""}${error.stderr || ""}` };
  }
}

/** The failing test count jest reported, for the record. */
function failedCount(output) {
  const match = /Tests:\s+(\d+) failed/.exec(output || "");
  return match ? Number(match[1]) : null;
}

function main(argv) {
  const asJson = (argv || []).includes("--json");
  const originals = new Map();
  const results = [];

  // Restore on ANY exit path. A harness that can leave a mutant on disk would turn one bad
  // run into a corrupted tree that the next person debugs as a real defect.
  const restore = () => {
    for (const [relative, contents] of originals) {
      try { write(relative, contents); } catch { /* best effort */ }
    }
  };
  process.on("exit", restore);
  process.on("SIGINT", () => { restore(); process.exit(130); });

  for (const mutant of MUTANTS) {
    const original = read(mutant.file);
    if (!originals.has(mutant.file)) originals.set(mutant.file, original);

    const occurrences = original.split(mutant.from).length - 1;
    if (occurrences !== 1) {
      results.push({
        id: mutant.id,
        property: mutant.property,
        verdict: "NOT_APPLICABLE",
        detail:
          `the anchor matched ${occurrences} time(s) in ${mutant.file}, not exactly once. The mutant was NOT ` +
          "applied and NOTHING is claimed about this property — a mutant whose anchor has drifted is an " +
          "unrun check, not a passing one",
        failedTests: null,
      });
      continue;
    }

    write(mutant.file, original.split(mutant.from).join(mutant.to));
    const run = runSuites();
    write(mutant.file, original);

    results.push({
      id: mutant.id,
      property: mutant.property,
      file: mutant.file,
      verdict: run.passed ? "SURVIVED" : "KILLED",
      failedTests: run.passed ? 0 : failedCount(run.output),
      detail: run.passed
        ? "the suite stayed GREEN over provably wrong code. This is a gap in the tests, not a property that holds"
        : "at least one test failed, so the property is actually asserted",
    });
  }

  const killed = results.filter((entry) => entry.verdict === "KILLED").length;
  const survived = results.filter((entry) => entry.verdict === "SURVIVED").length;
  const notApplicable = results.filter((entry) => entry.verdict === "NOT_APPLICABLE").length;

  const report = { total: results.length, killed, survived, notApplicable, results };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const lines = ["BATCH 2 mutation testing — charging scheduler + charging classifier", ""];
    for (const entry of results) {
      lines.push(`  ${entry.verdict.padEnd(15)} ${entry.id}  ${entry.property}`);
      if (entry.verdict !== "KILLED") lines.push(`                  ${entry.detail}`);
    }
    lines.push("");
    lines.push(`  ${killed} KILLED, ${survived} SURVIVED, ${notApplicable} NOT_APPLICABLE, of ${results.length}.`);
    if (survived > 0) {
      lines.push("  A SURVIVOR IS A REAL GAP. It is reported here rather than described as a pass.");
    }
    process.stdout.write(`${lines.join("\n")}\n`);
  }

  // Non-zero when any mutant survived or could not be applied: both mean a property this
  // batch claims is not actually being checked.
  return survived === 0 && notApplicable === 0 ? 0 : 1;
}

module.exports = { MUTANTS, SUITES, main };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

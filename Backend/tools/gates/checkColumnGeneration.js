"use strict";

/**
 * Gate — the counterfactual evaluator's column-generation release gate (§21.6).
 *
 * §21.6 is unambiguous that this is a gate rather than a report:
 *
 * > **The evaluator is a release gate, not only a periodic report, whenever column generation
 * > changes.** … any change to the column-generation heuristic — its clustering rule, its
 * > bundle-size policy, its enumeration order, its pruning, or any learned proposer admitted
 * > under §25.5 — MUST be gated on an evaluator run over a fixed historical corpus showing that
 * > the column-generation gap has not widened beyond `solve.max_generation_gap_regression`. The
 * > same gate applies to changes in `plan.max_columns_per_round` and `plan.max_bundle_size`,
 * > since a budget change is a heuristic change in effect. Running the evaluator only on a
 * > schedule would mean a generation regression ships, degrades allocation quality silently, and
 * > is discovered weeks later mixed in with every other change made since.
 *
 * `tools/evaluator/counterfactual.js` already implements the *verdict* — `gate()` compares two
 * runs over one corpus and fails closed with `NO_MEASUREMENT` when either side is unmeasured.
 * What was missing, and what `PHASE_11_INDEPENDENT_VERIFICATION.md` Finding 1 recorded, is that
 * nothing ever **invoked** it: no npm script, no CI step, no scheduled caller. A gate that
 * nothing runs is a gate in name only, and §21.6's entire argument is that no other signal
 * exists — an exact solve over a poorer column set is still exact.
 *
 * ── What this file adds, and deliberately does not add ──────────────────────
 * It adds the **trigger**: it answers "does the change under review touch column generation?"
 * and, when the answer is yes, requires the evaluator report and delegates the verdict
 * unchanged to `counterfactual.gate()`. It adds no evaluation logic, changes no threshold, and
 * fabricates no measurement. When column generation is untouched it reports `NOT_REQUIRED` and
 * exits 0, because §21.6 scopes the gate to generation changes and a gate that fires on every
 * commit would be discarded by the first engineer it inconvenienced.
 *
 * It does **not** run the evaluator. `run()` needs a `resolve` bound to `solve/round.js` over a
 * corpus of stored rounds; no round has ever executed and no composition root exists, so any
 * corpus this gate manufactured would be fiction. That is why an unaccompanied gated change
 * FAILS here rather than passing on an empty measurement: it is the honest state, and it is
 * exactly `counterfactual.gate()`'s own `NO_MEASUREMENT` posture applied one step earlier.
 *
 * ── Why these paths ─────────────────────────────────────────────────────────
 * §21.6 names the gated changes in prose; `counterfactual.GATED_CHANGES` encodes them. This file
 * maps them onto the repository the execution plan's §2.6 already fixed — "Column Builder (§9.3)
 * → `src/engine/plan/columnBuilder.js`" — plus `TIERS.md`'s owning modules for T2-02 (multi-Leg
 * columns) and T2-12 (consolidation), plus the two budget parameters §21.6 names literally.
 * Phase 11's Finding 1 asked for exactly this set: "gated on changes to `plan/columnBuilder.js`
 * or the two named budget parameters, at minimum".
 *
 * Usage:
 *   node tools/gates/checkColumnGeneration.js
 *   node tools/gates/checkColumnGeneration.js --base origin/main
 *   node tools/gates/checkColumnGeneration.js --changed Backend/src/engine/plan/columnBuilder.js
 *   node tools/gates/checkColumnGeneration.js --report evaluator-run.json
 */

const { execFileSync } = require("child_process");
const path = require("path");

const { gate, GATED_CHANGES } = require("../evaluator/counterfactual");

const BACKEND_ROOT = path.join(__dirname, "..", "..");
const REPO_ROOT = path.join(BACKEND_ROOT, "..");

/**
 * The column-generation heuristic's own modules, repo-relative.
 *
 * §21.6's four named surfaces — clustering rule, bundle-size policy, enumeration order,
 * pruning — are all properties of the Column Builder and the column types it emits. A learned
 * proposer admitted under §25.5 would land in the same directory and be caught by the same list.
 */
const GATED_SOURCE_PATHS = Object.freeze([
  "Backend/src/engine/plan/columnBuilder.js",
  "Backend/src/engine/plan/column.js",
  "Backend/src/engine/plan/multiLegColumn.js",
  "Backend/src/engine/plan/consolidation.js",
]);

/** The two budget parameters §21.6 names, because "a budget change is a heuristic change in effect". */
const GATED_PARAMETERS = Object.freeze(["plan.max_columns_per_round", "plan.max_bundle_size"]);

/** The register file that declares them. Changing it is what makes a value comparison necessary. */
const REGISTER_PATH = "Backend/src/engine/config/register/appendixA.json";

/**
 * Read the two gated parameter values out of a register document.
 *
 * @param {string} json raw contents of the register file
 * @returns {Record<string, unknown>|null} name → default, or null when unparseable
 */
function budgetValues(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  const entries = Array.isArray(parsed) ? parsed : Object.values(parsed).flat();
  const values = {};
  for (const entry of entries) {
    if (entry && GATED_PARAMETERS.includes(entry.name)) values[entry.name] = entry.default;
  }
  return values;
}

/**
 * Which files does this change touch?
 *
 * @param {object} options
 * @param {string[]} [options.changed] explicit list, bypassing git entirely
 * @param {string} [options.base] git ref to diff against
 * @param {(args: string[]) => string} [options.git] injected git runner, for the self-tests
 * @returns {{ paths: string[]|null, source: string, detail: string|null }}
 */
function changedPaths(options) {
  const source = options || {};
  if (source.changed) return { paths: [...source.changed], source: "--changed", detail: null };

  const git =
    source.git ||
    ((args) => execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

  const lines = (text) =>
    String(text || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

  try {
    // Committed changes against the base, plus anything uncommitted. A gate that read only one
    // of the two would be trivially evaded — by not committing, or by committing.
    const tracked = source.base ? lines(git(["diff", "--name-only", `${source.base}...HEAD`])) : [];
    const working = lines(git(["status", "--porcelain"])).map((line) => line.slice(3).trim());
    // Rename entries read `old -> new`; the destination is the path that now carries the code.
    const normalised = working.map((entry) => (entry.includes(" -> ") ? entry.split(" -> ")[1].trim() : entry));
    return { paths: [...new Set([...tracked, ...normalised])], source: source.base ? `git ${source.base}...HEAD + worktree` : "git worktree", detail: null };
  } catch (error) {
    return { paths: null, source: "git", detail: `git could not resolve the change set: ${error.message}` };
  }
}

/**
 * Does this change require the §21.6 gate?
 *
 * @param {object} options
 * @param {string[]} [options.changed]
 * @param {string} [options.base]
 * @param {(args: string[]) => string} [options.git]
 * @returns {{ required: boolean, indeterminate: boolean, reasons: string[], paths: string[]|null, source: string }}
 */
function gateRequired(options) {
  const source = options || {};
  const { paths, source: origin, detail } = changedPaths(source);

  if (paths === null) {
    // Fail closed. §21.6's own words: an unmeasured change is an ungated one. Not knowing what
    // changed is a strictly weaker position than knowing, so it cannot license a weaker verdict.
    return { required: true, indeterminate: true, reasons: [detail], paths: null, source: origin };
  }

  const reasons = [];
  for (const gated of GATED_SOURCE_PATHS) {
    if (paths.includes(gated)) reasons.push(`${gated} is a column-generation module (§21.6, §9.3)`);
  }

  if (paths.includes(REGISTER_PATH)) {
    const git =
      source.git ||
      ((args) => execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

    let before = null;
    try {
      before = budgetValues(git(["show", `${source.base || "HEAD"}:${REGISTER_PATH}`]));
    } catch {
      before = null;
    }

    const after = budgetValues(require("fs").readFileSync(path.join(REPO_ROOT, REGISTER_PATH), "utf8"));

    if (before === null || after === null) {
      reasons.push(
        `${REGISTER_PATH} changed and its previous ${GATED_PARAMETERS.join(" / ")} values could not be read, ` +
          "so a budget change cannot be ruled out (§21.6: a budget change is a heuristic change in effect)",
      );
    } else {
      for (const parameter of GATED_PARAMETERS) {
        if (String(before[parameter]) !== String(after[parameter])) {
          reasons.push(`${parameter} moved from ${before[parameter]} to ${after[parameter]} (§21.6)`);
        }
      }
    }
  }

  return { required: reasons.length > 0, indeterminate: false, reasons, paths, source: origin };
}

/**
 * The gate.
 *
 * @param {object} options
 * @param {string[]} [options.changed]
 * @param {string} [options.base]
 * @param {object} [options.report] a `counterfactual.run()` pair `{ baseline, candidate, maxRegressionCU }`
 * @param {(args: string[]) => string} [options.git]
 * @returns {{ ok: boolean, status: string, trigger: object, verdict: object|null, detail: string }}
 */
function checkColumnGeneration(options) {
  const source = options || {};
  const trigger = gateRequired(source);

  if (!trigger.required) {
    return {
      ok: true,
      status: "NOT_REQUIRED",
      trigger,
      verdict: null,
      detail:
        "no column-generation module and neither budget parameter changed, so §21.6's gate does not apply to " +
        "this change. It applies to the clustering rule, the bundle-size policy, the enumeration order, the " +
        "pruning rule, a learned proposer, and the two budgets — and to nothing else.",
    };
  }

  if (!source.report) {
    return {
      ok: false,
      status: "REPORT_REQUIRED",
      trigger,
      verdict: null,
      detail:
        "this change touches column generation and no counterfactual evaluator report accompanies it. §21.6: " +
        "\"an exact solve over a poor column set produces an exact but poor result, and no in-round signal " +
        "reveals it\". Produce a `counterfactual.run()` report over the fixed historical corpus for the " +
        "baseline and for this change, then re-run with --report. NOTE: no corpus exists yet — no round has " +
        "ever executed and no composition root is built — so a gated change cannot currently be discharged. " +
        "That is a true statement about the programme, not a defect in this gate.",
    };
  }

  const verdict = gate(source.report);
  return {
    ok: verdict.ok,
    status: verdict.ok ? "PASS" : "REGRESSION",
    trigger,
    verdict,
    detail: verdict.detail,
  };
}

/**
 * @param {ReturnType<typeof checkColumnGeneration>} result
 * @returns {string}
 */
function formatReport(result) {
  const header = "gate: column-generation release gate (§21.6)";
  const reasons = result.trigger.reasons.map((reason) => `    - ${reason}`).join("\n");

  if (result.status === "NOT_REQUIRED") {
    return `${header}\n  PASS — NOT_REQUIRED. ${result.detail}\n  change set from ${result.trigger.source}: ${
      (result.trigger.paths || []).length
    } path(s)`;
  }

  return (
    `${header}\n  ${result.ok ? "PASS" : "FAIL"} — ${result.status}. ${result.detail}\n` +
    `  gate required because:\n${reasons}\n` +
    `  §21.6 gated changes: ${GATED_CHANGES.join(" · ")}`
  );
}

module.exports = {
  GATED_SOURCE_PATHS,
  GATED_PARAMETERS,
  REGISTER_PATH,
  budgetValues,
  changedPaths,
  gateRequired,
  checkColumnGeneration,
  formatReport,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const valueOf = (flag) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };

  const options = { base: valueOf("--base") };

  const changedIndex = argv.indexOf("--changed");
  if (changedIndex !== -1) {
    options.changed = argv.slice(changedIndex + 1).filter((value) => !value.startsWith("--"));
  }

  const reportPath = valueOf("--report");
  if (reportPath) options.report = JSON.parse(require("fs").readFileSync(path.resolve(reportPath), "utf8"));

  const result = checkColumnGeneration(options);
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(result)}\n`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

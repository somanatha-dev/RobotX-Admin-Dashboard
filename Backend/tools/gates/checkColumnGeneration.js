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
 * ── Release-owner classification, and why it is not a bypass ────────────────
 * The trigger above is a **path** proxy for §21.6's four named surfaces — the clustering rule,
 * the bundle-size policy, the enumeration order, the pruning rule. A proxy is deliberately
 * coarser than the thing it stands for, so a change can land in a gated file and touch none of
 * those surfaces. `PHASE_11_REMEDIATION_AND_CLOSURE.md` BLOCKER-1 names exactly that case and
 * says the call "belongs to a human, not to this phase".
 *
 * `docs/release-decisions/*.json` is where such a human decision is recorded, and this file is
 * what reads it. The mechanism is deliberately the narrowest one that can work:
 *
 *   - A record is **pinned to two git blob SHAs** — the content before the change and the
 *     content being classified. Both are resolved from git's own object naming, never from the
 *     record. One byte of drift on either side and the record no longer applies.
 *   - A record whose `surfacesAffected` is non-empty is **invalid**. A classification that
 *     concedes a §21.6 surface is affected is not a classification, it is a waiver, and this
 *     gate does not implement waivers.
 *   - A record can only suppress a **source-path** trigger. It can never suppress a budget
 *     move: `plan.max_columns_per_round` / `plan.max_bundle_size` changing value *is* the
 *     heuristic change, with no proxy in between and so nothing to misclassify.
 *   - A record that is malformed, unreadable, or names a path it does not match suppresses
 *     nothing, and the mismatch is named in the failure output rather than passed over.
 *
 * The verdict logic, the threshold, and `tools/evaluator/counterfactual.js` are untouched. What
 * a record changes is whether the *trigger* fires — one classified blob at a time.
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

/** Where recorded release-owner classifications live. One JSON document per decision. */
const CLASSIFICATION_DIR = "docs/release-decisions";

/** A full git object name: 40 lowercase hex characters. Abbreviations are refused. */
const BLOB_SHA = /^[0-9a-f]{40}$/;

/**
 * Is this document a valid §21.6 release-owner classification?
 *
 * Validation is strict and total: a record that fails any clause suppresses nothing. That
 * direction is the safe one — an over-strict reader leaves the gate red, an under-strict one
 * lets a bad record turn it green.
 *
 * @param {unknown} record parsed JSON document
 * @returns {string|null} the reason it is invalid, or null when it is valid
 */
function classificationProblem(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return "not a JSON object";

  const text = (field) => typeof record[field] === "string" && record[field].trim().length > 0;
  for (const field of ["id", "recorded", "owner", "rationale"]) {
    if (!text(field)) return `\`${field}\` is missing or empty`;
  }

  if (record.section !== "§21.6") return "`section` is not \"§21.6\"; this reader classifies nothing else";
  if (!GATED_SOURCE_PATHS.includes(record.path)) {
    return `\`path\` ${JSON.stringify(record.path)} is not one of this gate's column-generation modules`;
  }
  for (const field of ["baseBlob", "currentBlob"]) {
    if (typeof record[field] !== "string" || !BLOB_SHA.test(record[field])) {
      return `\`${field}\` is not a full 40-character git object name`;
    }
  }
  if (record.baseBlob === record.currentBlob) return "`baseBlob` equals `currentBlob`; there is no change to classify";
  if (!Array.isArray(record.surfacesAffected)) return "`surfacesAffected` is missing or not an array";
  if (record.surfacesAffected.length > 0) {
    // The clause that keeps this a classification rather than a waiver. Conceding a surface
    // means §21.6 applies, and §21.6 is discharged by a corpus, not by a decision record.
    return `\`surfacesAffected\` names ${record.surfacesAffected.length} §21.6 surface(s), so §21.6 applies and only an evaluator run can discharge it`;
  }

  return null;
}

/**
 * Read every recorded classification, separating the usable from the rejected.
 *
 * @param {object} deps
 * @param {() => string[]} [deps.list] injected directory listing, for the self-tests
 * @param {(file: string) => string} [deps.read] injected file reader, for the self-tests
 * @returns {{ records: object[], rejected: Array<{ file: string, reason: string }> }}
 */
function loadClassifications(deps) {
  const source = deps || {};
  const fs = require("fs");
  const directory = path.join(REPO_ROOT, CLASSIFICATION_DIR);

  let files;
  try {
    files = (source.list || (() => fs.readdirSync(directory)))().filter((name) => name.endsWith(".json"));
  } catch {
    // No decisions directory is the ordinary state, and it means no classifications exist.
    return { records: [], rejected: [] };
  }

  const records = [];
  const rejected = [];
  for (const file of files.slice().sort()) {
    let parsed;
    try {
      parsed = JSON.parse((source.read || ((name) => fs.readFileSync(path.join(directory, name), "utf8")))(file));
    } catch (error) {
      rejected.push({ file, reason: `unreadable or not valid JSON: ${error.message}` });
      continue;
    }
    const problem = classificationProblem(parsed);
    if (problem) rejected.push({ file, reason: problem });
    else records.push(parsed);
  }

  return { records, rejected };
}

/**
 * Does a recorded classification apply to this path *as it stands right now*?
 *
 * Both blob names come from git, never from the record: the base from the tree being compared
 * against, the current from hashing the working file. The record only says which two it claims.
 *
 * @param {string} gatedPath repo-relative path that tripped the trigger
 * @param {object[]} records validated classifications
 * @param {(args: string[]) => string} git
 * @param {string} [base] git ref the change is measured against
 * @returns {{ applies: boolean, record: object|null, detail: string|null }}
 */
function classificationFor(gatedPath, records, git, base) {
  const record = records.find((entry) => entry.path === gatedPath) || null;
  if (!record) return { applies: false, record: null, detail: null };

  const resolve = (args) => {
    try {
      return String(git(args)).trim();
    } catch {
      return null;
    }
  };

  // `rev-parse <tree>:<path>` and `hash-object` both name the object git itself would store,
  // so the two sides are computed under identical content filters. Reading `git show` output
  // and hashing it here would not be — that path applies smudge filters on some platforms.
  const actualBase = resolve(["rev-parse", `${base || "HEAD"}:${gatedPath}`]);
  const actualCurrent = resolve(["hash-object", "--", gatedPath]);

  if (!actualBase || !actualCurrent) {
    return { applies: false, record, detail: "the before/after blob names could not be resolved from git" };
  }
  if (actualBase !== record.baseBlob) {
    return { applies: false, record, detail: `it classifies a change from ${record.baseBlob}, but the base is now ${actualBase}` };
  }
  if (actualCurrent !== record.currentBlob) {
    return { applies: false, record, detail: `it classifies content ${record.currentBlob}, but the file is now ${actualCurrent}` };
  }

  return { applies: true, record, detail: `${record.id} — ${record.recorded}, ${record.owner}` };
}

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
 * The width of `git status --porcelain`'s status field: two status characters and the
 * single space that separates them from the path.
 * @structural git's porcelain v1 record layout, not a threshold
 */
const PORCELAIN_STATUS_WIDTH = 3;

/**
 * Parse `git status --porcelain` into the paths it names.
 *
 * ── Why this is its own function, and why it does not trim first ─────────────
 * The porcelain record is `XY<space><path>`, where `X` and `Y` are single characters and
 * an *unset* one is a **space**: an unstaged modification reads `" M Backend/..."`. The
 * first implementation shared a `lines()` helper with `git diff --name-only`, and that
 * helper trimmed. Trimming turns `" M Backend/…"` into `"M Backend/…"`, after which
 * `slice(3)` removes `"M B"` and yields `"ackend/…"` — every worktree path silently lost
 * its first character, so no worktree path could ever equal a gated path.
 *
 * The consequence was not cosmetic. `npm run gates` — and therefore `npm run verify` —
 * invokes this gate with **no** `--base`, which makes the worktree the *only* source of
 * the change set. A gate that could not recognise a worktree path reported `NOT_REQUIRED`
 * on every local run, including a run in which `plan/columnBuilder.js` was open and
 * modified. `PHASE_11_INDEPENDENT_VERIFICATION.md` Finding 1 was that nothing invoked the
 * gate; this was the same defect one layer in — the gate was invoked and could not see.
 *
 * It survived because every self-test passed `changed:` explicitly and so never exercised
 * the parser. `tests/gates/checkColumnGeneration.test.js` now drives it directly.
 *
 * @param {string} text raw `git status --porcelain` output
 * @returns {string[]} repo-relative paths, renames resolved to their destination
 */
function parsePorcelain(text) {
  return String(text || "")
    .split("\n")
    // Only the line *ending* may be trimmed. The leading two characters are data.
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > PORCELAIN_STATUS_WIDTH)
    .map((line) => line.slice(PORCELAIN_STATUS_WIDTH))
    // Rename and copy entries read `old -> new`; the destination is the path that now
    // carries the code, and it is the one a gated-path comparison must see.
    .map((entry) => (entry.includes(" -> ") ? entry.slice(entry.lastIndexOf(" -> ") + " -> ".length) : entry))
    // A path containing a character git considers unusual is emitted C-quoted. Unwrapping
    // the quotes keeps such a path comparable; a path that needed escaping beyond the
    // quotes is left as git wrote it rather than half-decoded.
    .map((entry) => (entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry))
    .map((entry) => entry.trim())
    .filter(Boolean);
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

  // `git diff --name-only` emits one bare path per line and may be trimmed freely.
  // `git status --porcelain` may not — see `parsePorcelain`.
  const nameOnly = (text) =>
    String(text || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

  try {
    // Committed changes against the base, plus anything uncommitted. A gate that read only one
    // of the two would be trivially evaded — by not committing, or by committing.
    const tracked = source.base ? nameOnly(git(["diff", "--name-only", `${source.base}...HEAD`])) : [];
    const working = parsePorcelain(git(["status", "--porcelain"]));
    return { paths: [...new Set([...tracked, ...working])], source: source.base ? `git ${source.base}...HEAD + worktree` : "git worktree", detail: null };
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
 * @param {object[]} [options.classifications] injected records, bypassing the decisions directory
 * @param {(args: string[]) => string} [options.git]
 * @returns {{ required: boolean, indeterminate: boolean, reasons: string[], paths: string[]|null,
 *             source: string, classified: object[], rejected: object[] }}
 */
function gateRequired(options) {
  const source = options || {};
  const { paths, source: origin, detail } = changedPaths(source);

  const git =
    source.git ||
    ((args) => execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

  if (paths === null) {
    // Fail closed. §21.6's own words: an unmeasured change is an ungated one. Not knowing what
    // changed is a strictly weaker position than knowing, so it cannot license a weaker verdict.
    // No classification is consulted: a record pins a path, and there is no known path set.
    return { required: true, indeterminate: true, reasons: [detail], paths: null, source: origin, classified: [], rejected: [] };
  }

  const loaded = Array.isArray(source.classifications)
    ? { records: source.classifications, rejected: [] }
    : loadClassifications();

  const reasons = [];
  const classified = [];
  let touchedGatedSource = false;
  for (const gated of GATED_SOURCE_PATHS) {
    if (!paths.includes(gated)) continue;
    touchedGatedSource = true;

    const decision = classificationFor(gated, loaded.records, git, source.base);
    if (decision.applies) {
      classified.push({ path: gated, id: decision.record.id, recorded: decision.record.recorded, owner: decision.record.owner, detail: decision.detail });
      continue;
    }

    const base = `${gated} is a column-generation module (§21.6, §9.3)`;
    // A record that names the path but does not match must be *louder* than no record at all:
    // silence here is how a stale classification would read as a deliberate non-classification.
    reasons.push(decision.record ? `${base} — release decision ${decision.record.id} names it but does not apply: ${decision.detail}` : base);
  }

  // A rejected decision document is only a *reason* when a gated module actually changed. It is
  // always reported (`rejected`, printed by `formatReport`), because a decision record that
  // silently classifies nothing is the one failure a reader must not have to go looking for —
  // but firing the gate on unrelated commits is the habit that gets a gate routed around.
  if (touchedGatedSource) {
    for (const bad of loaded.rejected) {
      reasons.push(`${CLASSIFICATION_DIR}/${bad.file} is not a usable release decision (${bad.reason}), so it classifies nothing`);
    }
  }

  if (paths.includes(REGISTER_PATH)) {
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

  return { required: reasons.length > 0, indeterminate: false, reasons, paths, source: origin, classified, rejected: loaded.rejected };
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
    const untouched =
      "no column-generation module and neither budget parameter changed, so §21.6's gate does not apply to " +
      "this change. It applies to the clustering rule, the bundle-size policy, the enumeration order, the " +
      "pruning rule, a learned proposer, and the two budgets — and to nothing else.";

    const classifiedDetail =
      `${trigger.classified.length} change(s) in a column-generation module are covered by a recorded ` +
      "release-owner classification pinned to their exact before/after blob names, and no other §21.6 " +
      "surface was touched. The gate is not weakened by this: the classification dies on one byte of " +
      "drift in either blob, and it cannot cover a budget move at all.";

    return {
      ok: true,
      status: "NOT_REQUIRED",
      trigger,
      verdict: null,
      detail: trigger.classified.length > 0 ? classifiedDetail : untouched,
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

  // Every classification is printed on every run, passing or failing. A human decision that
  // suppressed a release gate and left no trace in the gate's own output would be the exact
  // thing this mechanism is supposed not to be.
  const classified = (result.trigger.classified || [])
    .map((entry) => `    - ${entry.path}\n        classified by ${entry.detail}\n        pinned to its exact before/after blob names; any edit re-raises the gate`)
    .join("\n");
  const rejected = (result.trigger.rejected || [])
    .map((entry) => `    - ${CLASSIFICATION_DIR}/${entry.file}: ${entry.reason}`)
    .join("\n");

  const appendix =
    (classified ? `\n  release-owner classification (§21.6 surfaces affected: none):\n${classified}` : "") +
    (rejected ? `\n  release decisions REJECTED, classifying nothing:\n${rejected}` : "");

  if (result.status === "NOT_REQUIRED") {
    return (
      `${header}\n  PASS — NOT_REQUIRED. ${result.detail}\n  change set from ${result.trigger.source}: ${
        (result.trigger.paths || []).length
      } path(s)${appendix}`
    );
  }

  return (
    `${header}\n  ${result.ok ? "PASS" : "FAIL"} — ${result.status}. ${result.detail}\n` +
    `  gate required because:\n${reasons}${appendix}\n` +
    `  §21.6 gated changes: ${GATED_CHANGES.join(" · ")}`
  );
}

module.exports = {
  GATED_SOURCE_PATHS,
  GATED_PARAMETERS,
  REGISTER_PATH,
  CLASSIFICATION_DIR,
  PORCELAIN_STATUS_WIDTH,
  budgetValues,
  parsePorcelain,
  changedPaths,
  classificationProblem,
  loadClassifications,
  classificationFor,
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

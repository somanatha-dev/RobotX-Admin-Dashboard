"use strict";

/**
 * BUILD GATE — the legacy decision path is removed from the build, not merely bypassed.
 *
 * > **Completion criteria** — … **legacy decision path removed from the build, not
 * > merely bypassed**; rollback rehearsed. (execution plan, Phase 15)
 *
 * > **Files to modify** — … **retire** `src/services/taskAssignment.service.js`,
 * > `costEvaluator.service.js`, `robotValidator.service.js`, `taskRecovery.service.js`,
 * > and the legacy assignment path in `task.service.js`. (execution plan, Phase 15)
 *
 * ── Why a gate, when the files are simply deleted ──────────────────────────
 * Because "deleted" is a property of one commit and "absent" is a property of the build.
 * Every phase from 3 to 14 left the legacy path live and untouched by design, and the
 * comments across `src/` still say so in a dozen places. The single most likely way this
 * cutover is undone is not a revert; it is a well-meaning re-addition — a helper copied
 * back "temporarily" during an incident, an import restored to make one test pass, a
 * fallback branch added because the engine was off for a shard and something had to
 * assign. Each of those is locally reasonable and each reinstates the greedy per-arrival
 * dispatcher §1.2 of the plan describes as "precisely the baseline the frozen
 * specification was written against".
 *
 * This gate makes that re-addition fail the build at the moment it is made, which is the
 * only moment at which it is cheap to argue about.
 *
 * ── Three checks ────────────────────────────────────────────────────────────
 *   1. **The retired modules do not exist.** A path check, so a file restored under its
 *      old name fails whether or not anything imports it.
 *   2. **Nothing imports them.** A source scan for `require(...)` of any retired path,
 *      under any spelling. Catches a resurrection under a new filename that keeps the
 *      old module id, and catches a dangling import that would break at boot rather than
 *      at build.
 *   3. **The retired symbols are absent from the surviving files.** `task.service.js`
 *      kept its non-assignment surface (reroute, cancel, completion), so deleting the
 *      file was never the remedy; what had to go were the named functions of the
 *      selection and finalisation path. They are listed by name, per file, and a
 *      definition of any of them fails.
 *
 * Comments are excluded from checks 2 and 3. Every phase report and several module
 * headers discuss these names at length, and a gate that could not tell a historical note
 * from a call site would be a gate that forces the history to be erased.
 *
 * The two checks strip differently, and the difference is load-bearing. Check 2 uses
 * `stripComments()`, which keeps string literals, **because a module specifier *is* a
 * string literal** — `codeOnly()` blanks literal contents, so scanning for
 * `require("…/taskRecovery.service")` with it finds nothing at all, and the gate would
 * pass while the import sat in plain sight. Check 3 uses `codeOnly()`, because a symbol
 * definition is code and a name that appears only inside a string is not a definition.
 *
 * Usage:
 *   node tools/gates/checkLegacyRetirement.js [--json]
 * Exit code 0 on pass, 1 on violation.
 */

const fs = require("fs");
const path = require("path");

const { codeOnly, stripComments, listSourceFiles, lineResolver } = require("../../src/engine/guards/sourceScan");

const BACKEND_ROOT = path.resolve(__dirname, "..", "..");

/** Trees scanned for imports and for resurrected symbols. */
const SCANNED = Object.freeze(["src", "tools"]);

/**
 * The modules Phase 15 retires, with the mechanism that replaced each. The replacement is
 * carried here rather than in a report so that the failure message tells the next
 * engineer what to use instead of what they just tried to restore.
 */
const RETIRED_MODULES = Object.freeze([
  {
    file: "src/services/taskAssignment.service.js",
    replacedBy:
      "src/engine/candidates/** (generation), src/engine/feasibility/** (the gate), " +
      "src/engine/solve/round.js (the choice) — §6, §7, §9",
  },
  {
    file: "src/services/costEvaluator.service.js",
    replacedBy:
      "src/engine/cost/** — absolute CU costs, never min-max normalised (§1.3, §8.1). " +
      "The plan's own note: 'min-max normalisation is prohibited by §1.3'",
  },
  {
    file: "src/services/robotValidator.service.js",
    replacedBy:
      "src/engine/feasibility/predicates/f01..f38 + evaluate.js — pure, three-valued, " +
      "classed predicates (§7)",
  },
  {
    file: "src/services/taskRecovery.service.js",
    replacedBy:
      "src/engine/supervision/reconciler.js scanOrphanLegs, driven continuously by " +
      "workers/reconciler.worker.js — trigger-independent rather than boot-only (§12.1, §12.4)",
  },
]);

/**
 * Symbols of the legacy assignment path that must not be defined in a surviving file.
 * Keyed by the file that used to define them.
 */
const RETIRED_SYMBOLS = Object.freeze([
  {
    file: "src/services/task.service.js",
    symbols: Object.freeze([
      "_processAssignment",
      "_finalizeAssignment",
      "legacyDetachedAssignment",
      "seedTaskKeys",
      "selectNearestRobot",
    ]),
    note:
      "the legacy assignment path: greedy per-arrival selection, the detached setImmediate with no owner " +
      "(§5.2 item C6), and the Redis key seeding that made the cache the source of truth. Replaced by " +
      "src/engine/intake/intake.js (request path) and workers/coordinator.worker.js (round path), §3.4",
  },
]);

/**
 * Detect a `require()` of a retired module, in code rather than in a comment.
 *
 * The pattern matches the module's basename without extension, preceded by a path
 * separator or a quote, so `require("./taskAssignment.service")` and
 * `require("../services/taskAssignment.service.js")` both match and an unrelated
 * identifier does not.
 *
 * @param {string} source already stripped of comments
 * @param {string} moduleFile repo-relative path of the retired module
 * @returns {number[]} character offsets of each match
 */
function findImports(source, moduleFile) {
  const base = path.basename(moduleFile).replace(/\.js$/u, "");
  const pattern = new RegExp(`require\\s*\\(\\s*["'][^"']*${base.replace(/\./gu, "\\.")}(?:\\.js)?["']`, "gu");
  const offsets = [];
  let match = pattern.exec(source);
  while (match) {
    offsets.push(match.index);
    match = pattern.exec(source);
  }
  return offsets;
}

/**
 * Detect a definition of a retired symbol.
 *
 * A *definition*, not a mention: `function name(`, `const name =`, `name(` as an export
 * key. A call to a symbol that no longer exists would be a reference error at runtime and
 * is caught by check 2 when it arrives via an import, so the useful thing to refuse here
 * is the re-introduction of the thing itself.
 *
 * @param {string} source already stripped of comments
 * @param {string} symbol
 * @returns {number[]}
 */
function findDefinitions(source, symbol) {
  const escaped = symbol.replace(/[$]/gu, "\\$");
  const pattern = new RegExp(
    `(?:async\\s+)?function\\s+${escaped}\\s*\\(|(?:const|let|var)\\s+${escaped}\\s*=`,
    "gu",
  );
  const offsets = [];
  let match = pattern.exec(source);
  while (match) {
    offsets.push(match.index);
    match = pattern.exec(source);
  }
  return offsets;
}

/**
 * Run the gate.
 *
 * @param {{ root?: string }} [options]
 * @returns {{ ok: boolean, violations: object[], filesChecked: number, retiredModules: number }}
 */
function checkLegacyRetirement(options) {
  const settings = options || {};
  const root = settings.root || BACKEND_ROOT;
  const violations = [];

  // 1. The retired modules do not exist.
  for (const retired of RETIRED_MODULES) {
    const absolute = path.join(root, retired.file);
    if (fs.existsSync(absolute)) {
      violations.push({
        kind: "module-restored",
        file: retired.file,
        line: null,
        detail:
          `${retired.file} exists. Phase 15 retires it: the legacy decision path must be removed from the ` +
          `build, not merely bypassed. Use ${retired.replacedBy}.`,
      });
    }
  }

  // 2 and 3, over one pass of the source tree. `server.js` is scanned by name because it
  // is the file that used to call the boot-time recovery pass, and it sits outside both
  // trees.
  const files = [
    ...SCANNED.filter((tree) => fs.existsSync(path.join(root, tree))).flatMap((tree) =>
      listSourceFiles(root, { include: [tree] }),
    ),
    ...(fs.existsSync(path.join(root, "server.js")) ? ["server.js"] : []),
  ];

  for (const relative of files) {
    // This gate's own declarations name every retired path and symbol; scanning itself
    // would report each of them as a violation of itself.
    if (relative === "tools/gates/checkLegacyRetirement.js") continue;

    const raw = fs.readFileSync(path.join(root, relative), "utf8");
    // Both forms blank in place rather than delete, so offsets and line numbers stay
    // true to the original file.
    const withLiterals = stripComments(raw);
    const source = codeOnly(raw);
    const lineOf = lineResolver(source);

    for (const retired of RETIRED_MODULES) {
      for (const offset of findImports(withLiterals, retired.file)) {
        violations.push({
          kind: "import-of-retired-module",
          file: relative,
          line: lineOf(offset),
          detail:
            `imports the retired ${retired.file}. Phase 15 removed it from the build. ` +
            `Use ${retired.replacedBy}.`,
        });
      }
    }

    for (const group of RETIRED_SYMBOLS) {
      if (relative !== group.file) continue;
      for (const symbol of group.symbols) {
        for (const offset of findDefinitions(source, symbol)) {
          violations.push({
            kind: "retired-symbol-defined",
            file: relative,
            line: lineOf(offset),
            detail: `defines ${symbol}, part of ${group.note}.`,
          });
        }
      }
    }
  }

  violations.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return (a.line || 0) - (b.line || 0);
  });

  return {
    ok: violations.length === 0,
    violations,
    filesChecked: files.length,
    retiredModules: RETIRED_MODULES.length,
  };
}

/**
 * Render for a terminal.
 *
 * @param {ReturnType<typeof checkLegacyRetirement>} result
 * @returns {string}
 */
function formatReport(result) {
  const header = "gate: legacy-retirement (execution plan, Phase 15)";
  if (result.ok) {
    return (
      `${header}\n  PASS — ${result.retiredModules} retired module(s) absent from the build and unimported; ` +
      `no retired symbol redefined across ${result.filesChecked} file(s).`
    );
  }
  const lines = result.violations.map(
    (violation) =>
      `    ${violation.file}${violation.line ? `:${violation.line}` : ""}  [${violation.kind}]\n        ${violation.detail}`,
  );
  return `${header}\n  FAIL — ${result.violations.length} violation(s):\n${lines.join("\n")}`;
}

module.exports = {
  RETIRED_MODULES,
  RETIRED_SYMBOLS,
  findImports,
  findDefinitions,
  checkLegacyRetirement,
  formatReport,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const rootFlag = argv.indexOf("--root");
  const options = {};
  if (rootFlag !== -1 && argv[rootFlag + 1]) options.root = path.resolve(argv[rootFlag + 1]);

  const result = checkLegacyRetirement(options);
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(result)}\n`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

"use strict";

/**
 * BUILD GATE — §22.1 / §1.3 / Appendix A: no behavioural constant outside the
 * parameter register.
 *
 * The baseline's thirteenth structural limitation is "weights are compile-time
 * constants" (§1.7 item 13). The architecture replaces them with a versioned,
 * scoped, typed, range-validated register (§22), and this gate is what stops a bare
 * constant from being reintroduced — in Phase 1, when the register is seeded, and
 * in every phase after it, when a new module is tempted to hard-code a threshold
 * "just for now". A constant retro-registered later is a constant that shipped
 * uncalibrated, unowned, and unscoped.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * Every numeric literal in an engine runtime module must be one of:
 *
 *   1. `0` or `1` — structurally unavoidable (identity, empty, first, boolean-ish)
 *      and carrying no behavioural choice;
 *   2. annotated `@param <register.name>` — the literal is the seeded default of a
 *      register entry, and that entry MUST resolve in
 *      `src/engine/config/register/*.json`;
 *   3. annotated `@structural <reason>` — the literal encodes structure, not
 *      behaviour (an enum ordinal, an array arity, a protocol constant). The reason
 *      is mandatory: an unexplained exemption is how this gate would rot.
 *
 * An annotation may sit on the literal's own line or in the contiguous comment
 * block directly above it.
 *
 * Build-time modules (`src/engine/guards/**`) and the register data itself are out
 * of scope: neither encodes runtime behaviour.
 *
 * Usage:
 *   node tools/gates/checkParameterRegister.js [--root <dir>] [--json]
 * Exit code 0 on pass, 1 on violation.
 */

const fs = require("fs");
const path = require("path");

const {
  codeOnly,
  stripComments,
  listSourceFiles,
  lineResolver,
  pragmasNear,
} = require("../../src/engine/guards/sourceScan");

const { isBuildTimeModule } = require("../../src/engine/guards/tierAssertions");

const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_INCLUDE = Object.freeze(["src/engine"]);
/**
 * Rule 2's tree: every runtime module that may read the register, which is wider than
 * rule 1's. `src/workers` is here because the composition root is where all three of the
 * misspellings §M.1 found actually were.
 */
const DEFAULT_READ_INCLUDE = Object.freeze(["src"]);
const DEFAULT_REGISTER_DIRECTORY = "src/engine/config/register";

/**
 * Directories inside the scanned tree that hold no runtime behaviour.
 */
const DEFAULT_EXCLUDE = Object.freeze([
  "src/engine/guards",
  DEFAULT_REGISTER_DIRECTORY,
]);

/**
 * Literal values that never encode a behavioural choice. `-1` is covered because it
 * lexes as unary minus applied to `1`.
 */
const STRUCTURALLY_EXEMPT_VALUES = Object.freeze(new Set(["0", "1"]));

const NUMERIC_LITERAL =
  /(?<![\w$.])(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)n?/g;

const PARAM_PRAGMA = /@param\s+([A-Za-z_][\w.[\]]*)/g;
const STRUCTURAL_PRAGMA = /@structural\b:?\s*([^*\n]*)/g;

/**
 * Load every parameter name published by the register.
 *
 * A register file is either an array of entries or an object with a `parameters`
 * array; each entry carries at least a `name`. Phase 1 seeds this directory from
 * Appendix A and §8.10; in Phase 0 it is empty by design.
 *
 * @param {string} root
 * @param {string} [registerDirectory] relative to `root`
 * @returns {{ names: Set<string>, files: string[] }}
 */
function loadRegister(root, registerDirectory) {
  const relative = registerDirectory || DEFAULT_REGISTER_DIRECTORY;
  const absolute = path.join(root, relative);
  const names = new Set();
  const files = [];

  let entries;
  try {
    entries = fs.readdirSync(absolute, { withFileTypes: true });
  } catch {
    return { names, files };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(absolute, entry.name);
    files.push(`${relative}/${entry.name}`);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const list = Array.isArray(parsed) ? parsed : parsed.parameters || [];
    for (const parameter of list) {
      if (parameter && typeof parameter.name === "string") names.add(parameter.name);
    }
  }

  return { names, files };
}

/**
 * Check one module for unregistered behavioural constants.
 *
 * @param {string} modulePath
 * @param {string} source
 * @param {Set<string>} registeredNames
 * @returns {object[]} violations
 */
function checkModule(modulePath, source, registeredNames) {
  const code = codeOnly(source);
  const lines = source.split("\n");
  const lineAt = lineResolver(source);
  const violations = [];

  NUMERIC_LITERAL.lastIndex = 0;
  let match = NUMERIC_LITERAL.exec(code);
  while (match !== null) {
    const literal = match[0];
    const normalised = literal.replace(/_/g, "").replace(/n$/, "");

    if (!STRUCTURALLY_EXEMPT_VALUES.has(normalised)) {
      const line = lineAt(match.index);
      const paramNames = pragmasNear(lines, line, PARAM_PRAGMA);
      const structuralReasons = pragmasNear(lines, line, STRUCTURAL_PRAGMA);

      if (paramNames.length > 0) {
        for (const name of paramNames) {
          if (!registeredNames.has(name)) {
            violations.push({
              file: modulePath,
              line,
              literal,
              kind: "unknown-register-entry",
              detail:
                `literal ${literal} is annotated "@param ${name}", but no entry named "${name}" ` +
                "is published by src/engine/config/register/*.json (§22.1, Appendix A)",
            });
          }
        }
      } else if (structuralReasons.length > 0 && structuralReasons.every((r) => r === "")) {
        violations.push({
          file: modulePath,
          line,
          literal,
          kind: "unexplained-exemption",
          detail:
            `literal ${literal} claims "@structural" without stating why. An unexplained ` +
            "exemption is how this gate rots; state the structure the literal encodes",
        });
      } else if (structuralReasons.length === 0) {
        violations.push({
          file: modulePath,
          line,
          literal,
          kind: "bare-constant",
          detail:
            `bare behavioural constant ${literal} is absent from the parameter register. ` +
            "Register it (§22, Appendix A) and annotate the default \"@param <name>\", or " +
            "annotate \"@structural <reason>\" if it encodes structure rather than behaviour",
        });
      }
    }

    match = NUMERIC_LITERAL.exec(code);
  }

  return violations;
}

/* ═══════════════════════════════════════════════════════════════════════════
   RULE 2 — the converse: a name *asked of* the register must exist in it
   ═══════════════════════════════════════════════════════════════════════════

   The rule above stops a behavioural constant from being written outside the
   register. It says nothing about the other direction, and the other direction
   failed silently for a whole phase.

   `ConfigSnapshot.resolve(name, scope)` answers `undefined` for a name the register
   does not carry — **the same shape it answers for a registered entry whose value is
   `null`**. So a misspelled parameter does not throw, does not warn, and does not
   read as a defect: it reads as "an input the owner has not supplied yet", which is a
   sentence this programme's documents contain hundreds of times. Three of them were
   misspellings (§M.1):

     · `energy.uncertainty_inflation`  → `energy.variance_inflation`
     · `energy.projection_max_age`     → `energy.charger_projection_max_age`
     · `commitment.lease_duration`     → `lease.duration`

   Each named a **published** value. The first meant no plan was ever built, for any
   candidate, with every external input supplied. All three survived 166 green suites,
   because the composition test's own fixture overrode the same misspellings — the
   fixture and the code shared the typo, so the override landed and the test passed.

   That is the defect class, not those three instances, and a test that pinned the
   three names would not have caught the fourth. This rule is lexical for the same
   reason the rest of this gate is: the names are string literals in call positions a
   scanner can identify exactly, and every one of them must name a published entry. */

/**
 * Call shapes whose string argument is a parameter name being asked of the register.
 *
 * Each is anchored so that it cannot match anything else in the tree:
 *   · `.resolve("name"` — `snapshot.resolve(name, scope)`. The literal is the **first**
 *     argument, which is what keeps `path.resolve(__dirname, "..")` out: there the
 *     literal is second.
 *   · `resolve(x, "name"` / `resolved(x, "name"` — the two-argument reader every
 *     composition-root module defines over a snapshot. The lookbehind excludes a
 *     member call, so `path.resolve` is again not matched here.
 *   · `config.get("name")` — the accessor `feasibility/threeValued.readParameter` and
 *     the Plan Builder are handed. A bare `.get("…")` is **not** matched: `Map.get` is
 *     the same syntax and carries no register meaning.
 * @structural the register-read call shapes, anchored to exclude same-named calls
 */
const RESOLUTION_CALLS = Object.freeze([
  { label: "snapshot.resolve", pattern: /\.resolve\(\s*"([^"]+)"/g },
  { label: "resolve(snapshot, name)", pattern: /(?<![.\w$])resolved?\(\s*[A-Za-z_$][\w$.()]*\s*,\s*"([^"]+)"/g },
  { label: "config.get(name)", pattern: /\bconfig\.get\(\s*"([^"]+)"/g },
]);

/**
 * Check one module for register reads naming an entry the register does not publish.
 *
 * @param {string} modulePath
 * @param {string} source
 * @param {Set<string>} registeredNames
 * @returns {object[]} violations
 */
function checkResolvedNames(modulePath, source, registeredNames) {
  // Comments stripped, string literals kept: the names live *inside* the literals, so
  // `codeOnly` — which blanks them — would see nothing at all. A name quoted in a doc
  // comment is not a read and must not be reported, which is what stripping gives.
  const view = stripComments(source);
  const lineAt = lineResolver(source);
  const violations = [];

  for (const { label, pattern } of RESOLUTION_CALLS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(view);
    while (match !== null) {
      const name = match[1];
      if (!registeredNames.has(name)) {
        violations.push({
          file: modulePath,
          line: lineAt(match.index),
          literal: `"${name}"`,
          kind: "unregistered-parameter-read",
          detail:
            `${label} asks the register for "${name}", which no entry in ` +
            "src/engine/config/register/*.json publishes. `resolve()` answers `undefined` for an " +
            "unknown name exactly as it does for a registered-but-null one, so this reads at " +
            "runtime as an unsupplied input rather than as a defect (§22.1, §M.1)",
        });
      }
      match = pattern.exec(view);
    }
  }

  return violations;
}

/**
 * Run the parameter-register gate over a source tree.
 *
 * @param {{ root?: string, include?: string[], exclude?: string[],
 *           registerDirectory?: string }} [options]
 * @returns {{ ok: boolean, violations: object[], filesChecked: number,
 *             registeredCount: number, registerFiles: string[] }}
 */
function checkParameterRegister(options) {
  const root = (options && options.root) || BACKEND_ROOT;
  const include = (options && options.include) || DEFAULT_INCLUDE;
  const exclude = (options && options.exclude) || DEFAULT_EXCLUDE;
  const registerDirectory = (options && options.registerDirectory) || DEFAULT_REGISTER_DIRECTORY;

  const { names, files: registerFiles } = loadRegister(root, registerDirectory);
  const sourceFiles = listSourceFiles(root, { include, exclude });

  const violations = [];
  let filesChecked = 0;

  for (const relative of sourceFiles) {
    if (isBuildTimeModule(relative)) continue;
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    filesChecked += 1;
    violations.push(...checkModule(relative, source, names));
  }

  // Rule 2 runs over a **wider** tree than rule 1, deliberately. Rule 1 is about
  // behavioural constants and is scoped to `src/engine`; rule 2 is about register reads,
  // and the three defects it exists to catch were all in `src/workers` — the composition
  // root, which rule 1 has never scanned. Scoping rule 2 to `src/engine` would have made
  // this gate green on the exact tree that produced the finding.
  const readIncludes = (options && options.readInclude) || DEFAULT_READ_INCLUDE;
  const readFiles = listSourceFiles(root, { include: readIncludes, exclude });
  let readFilesChecked = 0;

  for (const relative of readFiles) {
    if (isBuildTimeModule(relative)) continue;
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    readFilesChecked += 1;
    violations.push(...checkResolvedNames(relative, source, names));
  }

  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  return {
    ok: violations.length === 0,
    violations,
    filesChecked,
    readFilesChecked,
    registeredCount: names.size,
    registerFiles,
  };
}

/**
 * Render a gate result for a terminal.
 *
 * @param {ReturnType<typeof checkParameterRegister>} result
 * @returns {string}
 */
function formatReport(result) {
  const header = "gate: parameter-register (§22, Appendix A)";
  if (result.ok) {
    return (
      `${header}\n  PASS — ${result.filesChecked} engine module(s) checked against ` +
      `${result.registeredCount} registered parameter(s); no bare behavioural constants. ` +
      `${result.readFilesChecked} runtime module(s) checked for register reads; every name resolved.`
    );
  }
  const lines = result.violations.map(
    (violation) =>
      `    ${violation.file}:${violation.line}  [${violation.kind}]\n        ${violation.detail}`,
  );
  return (
    `${header}\n  FAIL — ${result.violations.length} violation(s) across ` +
    `${result.filesChecked} module(s):\n${lines.join("\n")}`
  );
}

module.exports = { checkParameterRegister, checkResolvedNames, loadRegister, formatReport, RESOLUTION_CALLS };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const rootFlag = argv.indexOf("--root");
  const options = {};
  if (rootFlag !== -1 && argv[rootFlag + 1]) options.root = path.resolve(argv[rootFlag + 1]);

  const result = checkParameterRegister(options);
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(result)}\n`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

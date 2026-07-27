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
  listSourceFiles,
  lineResolver,
  pragmasNear,
} = require("../../src/engine/guards/sourceScan");

const { isBuildTimeModule } = require("../../src/engine/guards/tierAssertions");

const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_INCLUDE = Object.freeze(["src/engine"]);
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

  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  return {
    ok: violations.length === 0,
    violations,
    filesChecked,
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
      `${result.registeredCount} registered parameter(s); no bare behavioural constants.`
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

module.exports = { checkParameterRegister, loadRegister, formatReport };

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

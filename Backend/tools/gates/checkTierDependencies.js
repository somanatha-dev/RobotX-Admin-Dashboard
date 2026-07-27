"use strict";

/**
 * BUILD GATE — §1.8 rule 2.
 *
 *   "No Tier 0 or Tier 1 guarantee may depend on a Tier 2 mechanism. Where the
 *    design appeared to violate this, the design was changed rather than the rule.
 *    Any future dependency of this shape is a defect, and the tier assignment is
 *    what makes it visible as one."
 *
 * This gate makes that defect visible mechanically. It walks the static import
 * graph of the engine, resolves each module's tier from `MODULE_TIERS` in
 * `src/engine/guards/tierAssertions.js`, and fails on any edge running from Tier 0
 * or Tier 1 into Tier 2.
 *
 * It additionally checks two coherence properties of the tier registry itself,
 * because a gate reading from an incoherent registry proves nothing:
 *   - the §26.1 invariant partition matches the sets §1.8 states, and
 *   - every Tier 2 mechanism names a §22.5 kill switch and the behaviour it
 *     degrades to (§22.5 rule 1).
 *
 * The compliant pattern for a Tier 1 module that wants an optional Tier 2
 * enhancement is dependency inversion: the Tier 2 module registers itself with, or
 * is injected into, the Tier 1 module. A Tier 2 mechanism statically linked into
 * the Tier 1 path is a kill switch that cannot actually be thrown.
 *
 * Usage:
 *   node tools/gates/checkTierDependencies.js [--root <dir>] [--json]
 * Exit code 0 on pass, 1 on violation.
 */

const fs = require("fs");
const path = require("path");

const {
  extractImports,
  listSourceFiles,
  resolveSpecifier,
} = require("../../src/engine/guards/sourceScan");

const {
  TIER_NAMES,
  MODULE_TIERS,
  tierOf,
  isForbiddenDependency,
  assertInvariantPartition,
  assertTierTwoIsDisableable,
} = require("../../src/engine/guards/tierAssertions");

const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_INCLUDE = Object.freeze(["src"]);

/**
 * Walk the import graph and report every §1.8 rule-2 violation.
 *
 * @param {{ root?: string, include?: string[], tierMap?: Array<[string, number]>,
 *           checkRegistry?: boolean }} [options]
 *   `root` — directory the module paths are relative to (default `Backend/`).
 *   `include` — subdirectories to scan (default `["src"]`).
 *   `tierMap` — override the module tier table; used by the gate's own self-tests
 *     to plant a violation against a fixture tree.
 *   `checkRegistry` — also assert the registry's own coherence (default true, and
 *     false when a `tierMap` override is supplied, since the override is a fixture).
 * @returns {{ ok: boolean, violations: object[], registryProblems: string[],
 *             filesChecked: number, edgesChecked: number }}
 */
function checkTierDependencies(options) {
  const root = (options && options.root) || BACKEND_ROOT;
  const include = (options && options.include) || DEFAULT_INCLUDE;
  const tierMap = (options && options.tierMap) || MODULE_TIERS;
  const checkRegistry =
    options && options.checkRegistry !== undefined
      ? options.checkRegistry
      : !(options && options.tierMap);

  const files = listSourceFiles(root, { include });
  const violations = [];
  let edgesChecked = 0;

  for (const relative of files) {
    const fromTier = tierOf(relative, tierMap);
    if (fromTier === null) continue;

    const source = fs.readFileSync(path.join(root, relative), "utf8");
    for (const { specifier, line } of extractImports(source)) {
      const target = resolveSpecifier(relative, specifier);
      if (target === null) continue; // package import — outside the governed trees

      const toTier = tierOf(target, tierMap);
      if (toTier === null) continue;

      edgesChecked += 1;
      if (isForbiddenDependency(fromTier, toTier)) {
        violations.push({
          from: relative,
          fromTier,
          to: target,
          toTier,
          line,
          detail:
            `${TIER_NAMES[fromTier]} module imports ${TIER_NAMES[toTier]} module. ` +
            "§1.8 rule 2: no Tier 0 or Tier 1 guarantee may depend on a Tier 2 mechanism. " +
            "Invert the dependency — the Tier 2 module registers with, or is injected into, " +
            "the Tier 1 module.",
        });
      }
    }
  }

  const registryProblems = [];
  if (checkRegistry) {
    registryProblems.push(...assertInvariantPartition().problems);
    registryProblems.push(...assertTierTwoIsDisableable().problems);
  }

  violations.sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line);

  return {
    ok: violations.length === 0 && registryProblems.length === 0,
    violations,
    registryProblems,
    filesChecked: files.length,
    edgesChecked,
  };
}

/**
 * Render a gate result for a terminal.
 *
 * @param {ReturnType<typeof checkTierDependencies>} result
 * @returns {string}
 */
function formatReport(result) {
  const header = "gate: tier-dependencies (§1.8 rule 2)";
  if (result.ok) {
    return (
      `${header}\n  PASS — ${result.filesChecked} module(s), ` +
      `${result.edgesChecked} governed import edge(s), no Tier 0/1 → Tier 2 dependency.`
    );
  }

  const parts = [`${header}\n  FAIL`];
  if (result.violations.length > 0) {
    parts.push(`  ${result.violations.length} forbidden dependency edge(s):`);
    for (const violation of result.violations) {
      parts.push(`    ${violation.from}:${violation.line}  →  ${violation.to}`);
      parts.push(`        ${violation.detail}`);
    }
  }
  if (result.registryProblems.length > 0) {
    parts.push(`  ${result.registryProblems.length} tier-registry coherence problem(s):`);
    for (const problem of result.registryProblems) parts.push(`    ${problem}`);
  }
  return parts.join("\n");
}

module.exports = { checkTierDependencies, formatReport };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const rootFlag = argv.indexOf("--root");
  const options = {};
  if (rootFlag !== -1 && argv[rootFlag + 1]) options.root = path.resolve(argv[rootFlag + 1]);

  const result = checkTierDependencies(options);
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(result)}\n`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

"use strict";

/**
 * BUILD GATE — §23.7: no identifying value is an input to any cost term, and no
 * decision record or input snapshot stores one.
 *
 * ── The rule, and the two places it binds ───────────────────────────────────
 * > **No decision record or input snapshot stores an identifying value directly.** Both
 * > store a **stable surrogate key** into a separate, access-controlled identity store,
 * > plus the *derived, non-identifying* quantities the decision actually consumed: the
 * > fine cell, the zone, the geofence result, the access-window class, the service-time
 * > cohort, the coordinates quantised to the routing graph's node. **The engine's
 * > arithmetic uses only these; a street address is never an input to a cost term.**
 *
 * The execution plan turns the last sentence into this phase's completion gate — "no
 * identifying value is an input to any cost term" — and that is exactly what this gate
 * checks, in two scopes:
 *
 *   1. **`COST_SCOPE`** — `src/engine/cost/**`. Every term of Φ. Nothing here may read a
 *      field named in `privacy/surrogateKeys.IDENTIFYING_FIELDS`.
 *   2. **`RECORD_SCOPE`** — the modules that *build* a Tier A record, a Tier B record, or
 *      an input snapshot. Nothing here may write one either.
 *
 * ── What this gate deliberately does not claim ──────────────────────────────
 * It is not a claim that no module in the engine ever touches a coordinate. Candidate
 * generation computes a great-circle lower bound, F33 evaluates a geofence, and the plan
 * builder carries a terminal stop's position; all three consume a coordinate in order to
 * *produce* one of §23.7's admissible derived quantities, which is the construction the
 * section describes rather than a violation of it. Widening the scope to include them
 * would make the gate fail on correct code, and a gate that fails on correct code is one
 * somebody weakens within a week.
 *
 * The property those modules need is a different one — that erasing the identifying
 * value does not change the decision — and it has its own, stronger check: the
 * **erased-corpus reconstruction-equivalence gate** (§24.3, run from
 * `tools/replay/replayDecision.js --erased`), which measures the actual effect on a
 * replayed cost rather than the presence of a name. This gate is the static half; that
 * one is the empirical half, and neither substitutes for the other.
 *
 * ── Escape hatch ────────────────────────────────────────────────────────────
 * A line may declare `@identifying-input <reason>` in its own comment or the contiguous
 * block above it. The reason is mandatory, exactly as `@structural` requires one in the
 * parameter-register gate: an unexplained exemption is how a gate rots. There are none
 * in the tree today, and a reviewer should ask hard questions of the first one.
 *
 * Usage:
 *   node tools/gates/checkIdentityIsolation.js [--root <dir>] [--json]
 * Exit code 0 on pass, 1 on violation.
 */

const fs = require("fs");
const path = require("path");

const { codeOnly, listSourceFiles, lineResolver, pragmasNear } = require("../../src/engine/guards/sourceScan");
const surrogateKeys = require("../../src/engine/privacy/surrogateKeys");

const BACKEND_ROOT = path.resolve(__dirname, "..", "..");

/** Every term of Φ. §23.7: "a street address is never an input to a cost term". */
const COST_SCOPE = Object.freeze(["src/engine/cost/"]);

/**
 * The modules that build the two records §23.7's schema rule binds. Named file by file
 * rather than by directory: `observability/` also holds the invariant checker and the
 * metrics register, which legitimately name a field in a description string.
 */
const RECORD_SCOPE = Object.freeze([
  "src/engine/observability/tierA.js",
  "src/engine/observability/tierB.js",
  "src/engine/observability/decisionRecord.js",
  "src/engine/determinism/snapshot.js",
]);

const SCOPES = Object.freeze([...COST_SCOPE, ...RECORD_SCOPE]);

const EXEMPTION_PRAGMA = /@identifying-input\b:?\s*([^*\n]*)/g;

/**
 * Property reads and object keys, which is how an identifying field would enter either
 * scope: `stop.address`, `stop["address"]`, or `{ address: … }`.
 */
const FIELD_REFERENCE = /(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*["']([^"']+)["']\s*\]|(?:^|[{,]\s*)([A-Za-z_$][\w$]*)\s*:)/g;

/**
 * Check one module.
 *
 * @param {string} modulePath
 * @param {string} source
 * @returns {object[]} violations
 */
function checkModule(modulePath, source) {
  const code = codeOnly(source);
  const lines = source.split("\n");
  const lineAt = lineResolver(source);
  const violations = [];

  FIELD_REFERENCE.lastIndex = 0;
  let match = FIELD_REFERENCE.exec(code);
  while (match !== null) {
    const field = match[1] || match[2] || match[3];
    if (field && surrogateKeys.isIdentifyingField(field)) {
      const line = lineAt(match.index);
      const reasons = pragmasNear(lines, line, EXEMPTION_PRAGMA);

      if (reasons.length === 0) {
        violations.push({
          file: modulePath,
          line,
          field,
          kind: COST_SCOPE.some((prefix) => modulePath.startsWith(prefix)) ? "identifying-input-to-cost" : "identifying-value-in-record",
          detail:
            `"${field}" is an identifying field (privacy/surrogateKeys.IDENTIFYING_FIELDS) and this module is in the ` +
            "§23.7 isolation scope. The engine's arithmetic uses only the derived, non-identifying quantities — the " +
            "fine cell, the zone, the geofence result, the access-window class, the service-time cohort, the " +
            "coordinates quantised to the routing graph's node — and a street address is never an input to a cost term.",
        });
      } else if (reasons.every((reason) => reason === "")) {
        violations.push({
          file: modulePath,
          line,
          field,
          kind: "unexplained-exemption",
          detail:
            `"${field}" claims "@identifying-input" without stating why. An unexplained exemption is how this gate ` +
            "rots; state which §23.7 derived quantity this read exists to produce.",
        });
      }
    }
    match = FIELD_REFERENCE.exec(code);
  }

  return violations;
}

/**
 * Run the gate.
 *
 * @param {{ root?: string, scopes?: readonly string[] }} [options]
 * @returns {{ ok: boolean, violations: object[], filesChecked: number, scopes: readonly string[] }}
 */
function checkIdentityIsolation(options) {
  const root = (options && options.root) || BACKEND_ROOT;
  const scopes = (options && options.scopes) || SCOPES;

  const candidates = listSourceFiles(root, { include: ["src/engine"], exclude: ["src/engine/guards", "src/engine/config/register"] });
  const inScope = candidates.filter((relative) => scopes.some((prefix) => relative === prefix || relative.startsWith(prefix)));

  const violations = [];
  for (const relative of inScope) {
    violations.push(...checkModule(relative, fs.readFileSync(path.join(root, relative), "utf8")));
  }

  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  return { ok: violations.length === 0, violations, filesChecked: inScope.length, scopes };
}

/**
 * @param {ReturnType<typeof checkIdentityIsolation>} result
 * @returns {string}
 */
function formatReport(result) {
  const header = "gate: identity-isolation (§23.7)";
  if (result.ok) {
    return (
      `${header}\n  PASS — ${result.filesChecked} module(s) in the cost and decision-record scopes hold no ` +
      "identifying field; no street address is an input to any cost term."
    );
  }
  const lines = result.violations.map(
    (violation) => `    ${violation.file}:${violation.line}  [${violation.kind}] ${violation.field}\n        ${violation.detail}`,
  );
  return `${header}\n  FAIL — ${result.violations.length} violation(s) across ${result.filesChecked} module(s):\n${lines.join("\n")}`;
}

module.exports = { COST_SCOPE, RECORD_SCOPE, SCOPES, checkModule, checkIdentityIsolation, formatReport };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const rootFlag = argv.indexOf("--root");
  const options = {};
  if (rootFlag !== -1 && argv[rootFlag + 1]) options.root = path.resolve(argv[rootFlag + 1]);

  const result = checkIdentityIsolation(options);
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(result)}\n`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

"use strict";

/**
 * Design tenets T1 and T6 (§1.5) as enforced properties rather than prose.
 *
 * ┌ T1 — Safety constraints are absolute and never priced ──────────────────────┐
 * │ "The cost function MUST be structurally incapable of seeing an infeasible    │
 * │  candidate." (§1.5, §7.1; invariant I14)                                     │
 * └─────────────────────────────────────────────────────────────────────────────┘
 * Enforced in two halves that reinforce each other:
 *   - **Runtime** — a candidate becomes visible to cost evaluation only by passing
 *     through `brandFeasible()`, which the feasibility gate alone is entitled to
 *     call. The brand is a non-enumerable Symbol, so it cannot be forged by object
 *     spread, JSON round-trip, or structured clone: a candidate that was cloned
 *     after branding arrives at the cost evaluator unbranded and is rejected.
 *   - **Build time** — `checkTenets()` fails any module in the cost-evaluation
 *     scope that accepts a candidate-shaped parameter without asserting the brand.
 *
 * ┌ T6 — Determinism and replayability over cleverness ─────────────────────────┐
 * │ "Any technique that cannot be replayed from its decision record — unseeded    │
 * │  randomness, wall-clock reads inside scoring, floating-point summation over   │
 * │  unordered sets, unversioned models — is prohibited in the decision path."    │
 * │  (§1.5, §9.6; invariant I10)                                                 │
 * └─────────────────────────────────────────────────────────────────────────────┘
 * `checkTenets()` fails any module in the decision-path scope that reads a wall
 * clock or an unseeded random source. Time in the decision path comes from the
 * round's pinned snapshot (`src/engine/determinism/snapshot.js`), never from the
 * host clock, because a decision that reads `Date.now()` cannot be replayed.
 *
 * This module is build-time and test-time apparatus plus the runtime brand. It is
 * classified as a build-time module in `tierAssertions.js` and is therefore itself
 * outside the scopes it checks.
 *
 * Run directly as a gate:  `node src/engine/guards/tenets.js`
 */

const fs = require("fs");
const path = require("path");

const { codeOnly, listSourceFiles, lineResolver, pragmasNear } = require("./sourceScan");
const { isBuildTimeModule } = require("./tierAssertions");

const BACKEND_ROOT = path.resolve(__dirname, "..", "..", "..");

/* ═══════════════════════════════════════════════════════════════════════════
   T1 — runtime type separation
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The feasibility brand. A Symbol rather than a string key so that it survives
 * neither `JSON.parse(JSON.stringify(x))` nor `{ ...x }` — both of which are ways a
 * candidate could otherwise smuggle a stale feasibility verdict past the gate.
 */
const FEASIBLE = Symbol("engine.feasibility.verified");

/**
 * Mark a candidate as having passed the feasibility gate. Only the feasibility
 * evaluator (`src/engine/feasibility/evaluate.js`) is entitled to call this; the
 * tier-dependency gate and code review are what enforce that entitlement.
 *
 * @param {object} candidate the candidate or plan the gate admitted
 * @param {object} evidence the verdict record: predicate outcomes, the config
 *   version they were evaluated under, and the snapshot they were evaluated against
 * @returns {object} the same object, branded
 */
function brandFeasible(candidate, evidence) {
  if (candidate === null || typeof candidate !== "object") {
    throw new TypeError("T1: only an object candidate can carry the feasibility brand");
  }
  if (evidence === null || typeof evidence !== "object") {
    throw new TypeError("T1: the feasibility brand requires its verdict evidence");
  }
  Object.defineProperty(candidate, FEASIBLE, {
    value: Object.freeze({ ...evidence }),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return candidate;
}

/**
 * @param {unknown} candidate
 * @returns {boolean} whether the candidate carries the feasibility brand
 */
function isFeasible(candidate) {
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    Object.prototype.hasOwnProperty.call(candidate, FEASIBLE)
  );
}

/**
 * The gate every cost-evaluation entry point must call on its candidate argument.
 *
 * @param {unknown} candidate
 * @param {string} [site] the calling module, for the error message
 * @returns {object} the branded candidate
 * @throws {Error} when the candidate never passed the feasibility gate
 */
function assertFeasible(candidate, site) {
  if (!isFeasible(candidate)) {
    throw new Error(
      `T1 violation${site ? ` in ${site}` : ""}: cost evaluation received a candidate ` +
        "that did not pass the feasibility gate. The cost function is required to be " +
        "structurally incapable of seeing an infeasible candidate (§1.5 T1, §7.1, I14).",
    );
  }
  return candidate;
}

/**
 * Read the verdict evidence a branded candidate carries, for the decision record.
 *
 * @param {object} candidate
 * @returns {object}
 */
function feasibilityEvidence(candidate) {
  assertFeasible(candidate);
  return candidate[FEASIBLE];
}

/* ═══════════════════════════════════════════════════════════════════════════
   Build-time scopes
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Modules in which cost is evaluated. T1 applies here: nothing in this scope may
 * see a candidate it has not asserted the brand on.
 */
const COST_EVALUATION_SCOPE = Object.freeze([
  "src/engine/cost/",
  "src/engine/solve/",
]);

/**
 * The decision path (L4, §3.1): deterministic, side-effect-free, replayable. T6
 * applies here.
 *
 * The energy modules are in scope because their predictions are consumed inside
 * feasibility and cost and must replay identically; `chargingSchedulerClient.js`
 * and `midMission.js` are excluded because they are L1 dependency clients and L2
 * mid-mission supervision respectively, neither of which runs inside a round.
 */
const DECISION_PATH_SCOPE = Object.freeze([
  "src/engine/candidates/",
  "src/engine/feasibility/",
  "src/engine/cost/",
  "src/engine/plan/",
  "src/engine/solve/",
  "src/engine/determinism/",
  "src/engine/energy/",
]);

const DECISION_PATH_EXCLUSIONS = Object.freeze([
  "src/engine/energy/chargingSchedulerClient.js",
  "src/engine/energy/midMission.js",
  "src/engine/determinism/snapshot.js",
]);

/**
 * Parameter names that denote something the feasibility gate must have admitted.
 */
const CANDIDATE_PARAMETER_NAMES = Object.freeze([
  "candidate",
  "candidates",
  "pairing",
  "pairings",
  "column",
  "columns",
  "plan",
  "plans",
]);

/**
 * Non-deterministic sources prohibited in the decision path by T6/§9.6.
 * `Date.UTC` is deliberately absent: it is a pure function of its arguments.
 */
const NONDETERMINISTIC_SOURCES = Object.freeze([
  { name: "Date.now()", pattern: /\bDate\s*\.\s*now\s*\(/g },
  { name: "new Date()", pattern: /\bnew\s+Date\s*\(/g },
  { name: "performance.now()", pattern: /\bperformance\s*\.\s*now\s*\(/g },
  { name: "process.hrtime()", pattern: /\bprocess\s*\.\s*hrtime\b/g },
  { name: "process.uptime()", pattern: /\bprocess\s*\.\s*uptime\s*\(/g },
  { name: "Math.random()", pattern: /\bMath\s*\.\s*random\s*\(/g },
  { name: "crypto.randomUUID()", pattern: /\brandomUUID\s*\(/g },
  { name: "crypto.randomBytes()", pattern: /\brandomBytes\s*\(/g },
]);

const T1_EXEMPT_PRAGMA = /@tenet-T1-exempt:?\s*([^*\n]*)/g;
const T6_EXEMPT_PRAGMA = /@tenet-T6-exempt:?\s*([^*\n]*)/g;

const FUNCTION_PARAMETERS = /\bfunction\s*[\w$]*\s*\(([^)]*)\)/g;
const ARROW_PARAMETERS = /(?:^|[=,(:]\s*)\(([^)]*)\)\s*=>/gm;
const ASSERT_FEASIBLE_CALL = /\bassertFeasible\s*\(/;

/**
 * @param {string} modulePath
 * @param {readonly string[]} scope
 * @returns {boolean}
 */
function inScope(modulePath, scope) {
  return scope.some((prefix) => modulePath.startsWith(prefix));
}

/**
 * Split a parameter list into bare identifier names, ignoring destructuring
 * internals and default values.
 *
 * @param {string} parameterList
 * @returns {string[]}
 */
function parameterNames(parameterList) {
  return parameterList
    .split(",")
    .map((part) => part.trim().split("=")[0].trim())
    .map((part) => part.replace(/^\.\.\./, "").trim())
    .filter((part) => /^[A-Za-z_$][\w$]*$/.test(part));
}

/**
 * Check T1 over one module: a module in the cost-evaluation scope that accepts a
 * candidate-shaped parameter must assert the feasibility brand.
 *
 * @param {string} modulePath
 * @param {string} source
 * @returns {object[]} violations
 */
function checkT1(modulePath, source) {
  if (!inScope(modulePath, COST_EVALUATION_SCOPE)) return [];

  const code = codeOnly(source);
  const lines = source.split("\n");
  const lineAt = lineResolver(source);
  const violations = [];

  if (ASSERT_FEASIBLE_CALL.test(code)) return [];

  for (const pattern of [FUNCTION_PARAMETERS, ARROW_PARAMETERS]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(code);
    while (match !== null) {
      const names = parameterNames(match[1]);
      const offending = names.find((name) =>
        CANDIDATE_PARAMETER_NAMES.includes(name.toLowerCase()),
      );
      if (offending) {
        const line = lineAt(match.index);
        const exemptions = pragmasNear(lines, line, T1_EXEMPT_PRAGMA);
        if (exemptions.length === 0) {
          violations.push({
            tenet: "T1",
            file: modulePath,
            line,
            detail:
              `accepts candidate-shaped parameter "${offending}" but the module never calls ` +
              "assertFeasible(); cost evaluation must be structurally unable to see an " +
              "infeasible candidate (§1.5 T1, §7.1, I14)",
          });
        }
      }
      match = pattern.exec(code);
    }
  }

  return violations;
}

/**
 * Check T6 over one module: no wall-clock read and no unseeded randomness anywhere
 * in the decision path.
 *
 * @param {string} modulePath
 * @param {string} source
 * @returns {object[]} violations
 */
function checkT6(modulePath, source) {
  if (!inScope(modulePath, DECISION_PATH_SCOPE)) return [];
  if (DECISION_PATH_EXCLUSIONS.includes(modulePath)) return [];

  const code = codeOnly(source);
  const lines = source.split("\n");
  const lineAt = lineResolver(source);
  const violations = [];

  for (const source_ of NONDETERMINISTIC_SOURCES) {
    source_.pattern.lastIndex = 0;
    let match = source_.pattern.exec(code);
    while (match !== null) {
      const line = lineAt(match.index);
      const exemptions = pragmasNear(lines, line, T6_EXEMPT_PRAGMA);
      if (exemptions.length === 0) {
        violations.push({
          tenet: "T6",
          file: modulePath,
          line,
          detail:
            `reads ${source_.name} in the decision path; a decision that cannot be replayed ` +
            "from its pinned snapshot is prohibited (§1.5 T6, §9.6, I10)",
        });
      }
      match = source_.pattern.exec(code);
    }
  }

  return violations;
}

/**
 * Run every build-time tenet assertion over a source tree.
 *
 * @param {{ root?: string, include?: string[] }} [options]
 *   `root` — the directory the module paths are relative to (default: `Backend/`).
 *   `include` — subdirectories to scan (default: `src`).
 * @returns {{ ok: boolean, violations: object[], filesChecked: number }}
 */
function checkTenets(options) {
  const root = (options && options.root) || BACKEND_ROOT;
  const include = (options && options.include) || ["src"];

  const files = listSourceFiles(root, { include });
  const violations = [];
  let filesChecked = 0;

  for (const relative of files) {
    if (isBuildTimeModule(relative)) continue;
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    filesChecked += 1;
    violations.push(...checkT1(relative, source));
    violations.push(...checkT6(relative, source));
  }

  violations.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.tenet.localeCompare(b.tenet),
  );

  return { ok: violations.length === 0, violations, filesChecked };
}

/**
 * Render a gate result for a terminal.
 *
 * @param {{ ok: boolean, violations: object[], filesChecked: number }} result
 * @returns {string}
 */
function formatTenetReport(result) {
  const header = `gate: tenets (T1 type separation, T6 decision-path determinism)`;
  if (result.ok) {
    return `${header}\n  PASS — ${result.filesChecked} module(s) checked, no violations.`;
  }
  const lines = result.violations.map(
    (violation) => `  ${violation.tenet}  ${violation.file}:${violation.line}\n      ${violation.detail}`,
  );
  return `${header}\n  FAIL — ${result.violations.length} violation(s) across ${result.filesChecked} module(s):\n${lines.join("\n")}`;
}

module.exports = {
  // Runtime T1 apparatus.
  FEASIBLE,
  brandFeasible,
  isFeasible,
  assertFeasible,
  feasibilityEvidence,
  // Build-time assertions.
  COST_EVALUATION_SCOPE,
  DECISION_PATH_SCOPE,
  DECISION_PATH_EXCLUSIONS,
  NONDETERMINISTIC_SOURCES,
  checkT1,
  checkT6,
  checkTenets,
  formatTenetReport,
};

if (require.main === module) {
  const result = checkTenets();
  process.stdout.write(`${formatTenetReport(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

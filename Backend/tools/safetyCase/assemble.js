"use strict";

/**
 * The safety case (§24.7), **assembled from queries rather than written as prose**.
 *
 * > For deployments requiring it, the design supports a structured safety argument: an
 * > enumerated hazard list, the constraints mitigating each hazard, the verification
 * > evidence for each constraint, and the invariant monitoring proving continued
 * > satisfaction in production (§26). Because constraints are pure functions with explicit
 * > classes, and because every decision records which predicates were evaluated with what
 * > data, **the safety evidence is a query rather than a documentation exercise.**
 * > Designing for that is much cheaper than retrofitting it.
 *
 * > **Completion criteria** — … safety case **assembled from queries rather than prose** …
 * > (execution plan, Phase 15)
 *
 * ── What "from queries" means here, precisely ──────────────────────────────
 * Exactly one file in `docs/safety-case/` is written by a human: `hazards.json`, the
 * enumerated hazard list. It contains **no evidence** — only hazard identifiers, their
 * descriptions, and the ids of the predicates and invariants that bear on each. Everything
 * else in the assembled document is read at assembly time from the shipped code:
 *
 *   - the constraint's **class** and **policy** come from `feasibility/register.js`;
 *   - the constraint's **tier** comes from `guards/tierAssertions.js`;
 *   - the invariant's **checker** and **tier** come from
 *     `observability/invariantChecker.js` and the same tier registry;
 *   - the **verification evidence** comes from `cutover/gates.js`'s release-gate table.
 *
 * The consequence is the one §24.7 is after: a hazard whose mitigating predicate is
 * deleted, or reclassified from I to P, changes the safety case on the next assembly
 * without anyone remembering to edit a document. A safety case that can go stale silently
 * is worse than none, because it is believed.
 *
 * ── The assembler refuses, it does not warn ────────────────────────────────
 * A hazard naming a predicate that does not exist, or an invariant that is not checked, is
 * a **failure**, not a footnote. The whole value of the artefact is that its cross
 * references are live; one that renders a dangling reference as prose has become the
 * documentation exercise §24.7 rejects.
 *
 * Usage:
 *   node tools/safetyCase/assemble.js [--out docs/safety-case/SAFETY_CASE.md] [--json]
 * Exit code 0 when the case assembles, 1 when a reference dangles or a hazard is
 * unmitigated.
 */

const fs = require("fs");
const path = require("path");

const feasibilityRegister = require("../../src/engine/feasibility/register");
const invariantChecker = require("../../src/engine/observability/invariantChecker");
const gates = require("../../src/engine/cutover/gates");
const { INVARIANT_TIERS, TIER_NAMES } = require("../../src/engine/guards/tierAssertions");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const HAZARDS_FILE = path.join(REPO_ROOT, "docs", "safety-case", "hazards.json");
const DEFAULT_OUTPUT = path.join(REPO_ROOT, "docs", "safety-case", "SAFETY_CASE.md");

/**
 * Load the one hand-written input.
 *
 * @param {{ file?: string }} [options]
 * @returns {object}
 */
function loadHazards(options) {
  const file = (options && options.file) || HAZARDS_FILE;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Resolve one hazard's mitigations against the shipped registers.
 *
 * @param {object} hazard
 * @param {object} evidence release-gate evidence, as `gates.evaluate` takes
 * @returns {{ hazard: object, constraints: object[], invariants: object[], problems: string[] }}
 */
function resolveHazard(hazard, evidence) {
  const problems = [];

  const constraints = (hazard.mitigatedByPredicates || []).map((predicateId) => {
    const entry = feasibilityRegister.predicate(predicateId);
    if (!entry) {
      problems.push(
        `hazard ${hazard.id} names predicate ${predicateId}, which is not in the §7.5 constraint register. ` +
          "A safety case whose mitigation does not exist is worse than no safety case, because it is believed.",
      );
      return { id: predicateId, missing: true };
    }
    return {
      id: entry.id,
      name: entry.name,
      // The class is read, never restated. §7.2's classes decide what may be waived
      // (§23.6), so a case that carried its own copy could disagree with the gate.
      constraintClass: entry.constraintClass,
      policy: entry.policy,
      group: entry.group,
      volatile: entry.volatile,
      waivable: !["I", "R", "F"].includes(entry.constraintClass),
    };
  });

  const invariants = (hazard.monitoredByInvariants || []).map((invariantId) => {
    const checked = typeof invariantChecker.CHECKS[invariantId] === "function";
    if (!checked) {
      problems.push(
        `hazard ${hazard.id} names invariant ${invariantId}, for which §26 has no implemented check. ` +
          "An invariant nobody checks is a comment.",
      );
      return { id: invariantId, missing: true };
    }
    const tier = INVARIANT_TIERS[invariantId];
    return { id: invariantId, checked: true, tier, tierName: TIER_NAMES[tier] };
  });

  if (constraints.length === 0 && invariants.length === 0) {
    problems.push(
      `hazard ${hazard.id} names neither a mitigating constraint nor a monitoring invariant. An enumerated ` +
        "hazard with no mitigation is a hazard that has been noticed and not addressed.",
    );
  }

  return { hazard, constraints, invariants, problems };
}

/**
 * Assemble the case.
 *
 * @param {{ hazardsFile?: string, evidence?: object }} [options]
 * @returns {{ ok: boolean, rows: object[], problems: string[], gates: object, generatedFrom: object }}
 */
function assemble(options) {
  const settings = options || {};
  const source = loadHazards({ file: settings.hazardsFile });
  const evidence = settings.evidence || {};

  const rows = (source.hazards || []).map((hazard) => resolveHazard(hazard, evidence));
  const problems = rows.flatMap((row) => row.problems);

  return {
    ok: problems.length === 0,
    rows,
    problems,
    gates: gates.evaluate(evidence),
    generatedFrom: {
      hazards: path.relative(REPO_ROOT, settings.hazardsFile || HAZARDS_FILE).split(path.sep).join("/"),
      constraintRegister: "Backend/src/engine/feasibility/register.js",
      invariantChecker: "Backend/src/engine/observability/invariantChecker.js",
      tierRegistry: "Backend/src/engine/guards/tierAssertions.js",
      releaseGates: "Backend/src/engine/cutover/gates.js",
      predicateCount: feasibilityRegister.PREDICATE_COUNT,
      invariantCount: Object.keys(invariantChecker.CHECKS).length,
    },
  };
}

/**
 * Render the assembled case as Markdown.
 *
 * @param {ReturnType<typeof assemble>} result
 * @returns {string}
 */
function render(result) {
  const lines = [];
  lines.push("# RobotX — Safety Case");
  lines.push("");
  lines.push("> **This file is generated. Do not edit it.**");
  lines.push(">");
  lines.push("> Run `npm run safety:case` to regenerate. The only hand-written input is");
  lines.push("> `docs/safety-case/hazards.json`, which contains the enumerated hazard list and *no evidence*.");
  lines.push("> Every class, policy, tier and gate status below is read from the shipped code at assembly time,");
  lines.push("> which is what §24.7 means by \"the safety evidence is a query rather than a documentation exercise\".");
  lines.push("");
  lines.push("## Provenance");
  lines.push("");
  for (const [key, value] of Object.entries(result.generatedFrom)) {
    lines.push(`- \`${key}\` — ${value}`);
  }
  lines.push("");
  lines.push("## Hazards, their mitigations, and their monitoring");
  lines.push("");

  for (const row of result.rows) {
    lines.push(`### ${row.hazard.id} — ${row.hazard.title}`);
    lines.push("");
    lines.push(row.hazard.description);
    lines.push("");
    if (row.hazard.section) lines.push(`**Specification:** ${row.hazard.section}`);
    lines.push(`**Severity:** ${row.hazard.severity}`);
    lines.push("");

    if (row.constraints.length > 0) {
      lines.push("**Mitigating constraints** (class and policy read from the §7.5 register):");
      lines.push("");
      lines.push("| Predicate | Name | Class | Policy | Waivable (§23.6) |");
      lines.push("|---|---|---|---|---|");
      for (const constraint of row.constraints) {
        if (constraint.missing) {
          lines.push(`| ${constraint.id} | **MISSING FROM THE REGISTER** | — | — | — |`);
          continue;
        }
        lines.push(
          `| ${constraint.id} | ${constraint.name} | ${constraint.constraintClass} | ${constraint.policy} | ` +
            `${constraint.waivable ? "yes" : "**never**"} |`,
        );
      }
      lines.push("");
    }

    if (row.invariants.length > 0) {
      lines.push("**Monitoring invariants** (§26, checked independently of the code that maintains them):");
      lines.push("");
      for (const invariant of row.invariants) {
        lines.push(
          invariant.missing
            ? `- ${invariant.id} — **NO IMPLEMENTED CHECK**`
            : `- ${invariant.id} — checked; ${invariant.tierName}`,
        );
      }
      lines.push("");
    }
  }

  lines.push("## Verification evidence — the §24 release gates");
  lines.push("");
  lines.push("| Status | Gate | Evidence kind | Section |");
  lines.push("|---|---|---|---|");
  for (const gate of result.gates.results) {
    lines.push(`| ${gate.status} | ${gate.id} | ${gate.evidence} | ${gate.section} |`);
  }
  lines.push("");
  lines.push(
    `**${result.gates.counts.GREEN} green, ${result.gates.counts.RED} red, ` +
      `${result.gates.counts.NOT_EVALUATED} not evaluated.** \`NOT_EVALUATED\` blocks the cutover exactly as ` +
      "`RED` does; the two are distinct so that \"we ran it and it failed\" and \"nobody ran it\" cannot be " +
      "confused during an incident review.",
  );
  lines.push("");

  if (!result.ok) {
    lines.push("## Assembly problems");
    lines.push("");
    for (const problem of result.problems) lines.push(`- ${problem}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

module.exports = { HAZARDS_FILE, DEFAULT_OUTPUT, loadHazards, resolveHazard, assemble, render };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const outFlag = argv.indexOf("--out");
  const output = outFlag !== -1 && argv[outFlag + 1] ? path.resolve(argv[outFlag + 1]) : DEFAULT_OUTPUT;

  const result = assemble();

  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    fs.writeFileSync(output, render(result), "utf8");
    process.stdout.write(
      `safety case (§24.7) — ${result.rows.length} hazard(s) assembled from ` +
        `${result.generatedFrom.predicateCount} predicates and ${result.generatedFrom.invariantCount} invariants\n` +
        `  written to ${path.relative(REPO_ROOT, output).split(path.sep).join("/")}\n` +
        `  release gates: ${result.gates.counts.GREEN} green, ${result.gates.counts.RED} red, ` +
        `${result.gates.counts.NOT_EVALUATED} not evaluated\n` +
        (result.ok ? "  PASS — every reference resolves\n" : `  FAIL — ${result.problems.length} problem(s):\n${result.problems.map((p) => `    ${p}`).join("\n")}\n`),
    );
  }
  process.exitCode = result.ok ? 0 : 1;
}

"use strict";

/**
 * The §24 release gates, as data — **Tier 0 by consequence**.
 *
 * > Targets are stated per shard, at the 99th percentile, under nominal (non-degraded)
 * > operation. **They are requirements for the release gate, not aspirations.** (§20.1)
 *
 * > **Completion criteria** — Every §24 gate green; every §26 invariant `ENFORCED` in
 * > nominal operation with a zero-violation SLI; safety case assembled from queries
 * > rather than prose; legacy decision path removed from the build, not merely bypassed;
 * > rollback rehearsed. (execution plan, Phase 15)
 *
 * ── Why the gates are a table and not a checklist in a document ─────────────
 * §24.7 states the design intent for the whole verification surface:
 *
 * > Because constraints are pure functions with explicit classes, and because every
 * > decision records which predicates were evaluated with what data, **the safety
 * > evidence is a query rather than a documentation exercise.**
 *
 * A release gate recorded in prose is a gate that is satisfied by someone writing that
 * it is satisfied. This module makes each gate an object with an id, the section that
 * requires it, the **kind of evidence** that can discharge it, and whether it is
 * *blocking* for the cutover. `evaluate()` takes the evidence and returns a status per
 * gate; `blockers()` returns the ones that refuse. `cutover/stage.js` calls `blockers()`
 * before it will authorise any shard, so "the gates are green" is a fact the code
 * establishes rather than a sentence a human writes.
 *
 * ── Three statuses, and why there is no fourth ──────────────────────────────
 *   - `GREEN` — evidence was supplied and it satisfies the gate.
 *   - `RED` — evidence was supplied and it does **not** satisfy the gate.
 *   - `NOT_EVALUATED` — no evidence was supplied.
 *
 * `NOT_EVALUATED` is treated exactly as `RED` by `blockers()`, and is kept distinct from
 * it for one reason: an incident review must be able to tell "we ran the soak test and
 * it failed" apart from "nobody ran the soak test". Both block. They do not mean the
 * same thing, and a two-valued status would erase the difference at exactly the moment
 * it mattered. There is deliberately no `WAIVED`: §23.6 makes class I, R and F
 * unwaivable, and a gate that could be waived would be a route around the predicates
 * those classes protect.
 *
 * ── Evidence kinds ──────────────────────────────────────────────────────────
 * Each gate declares how it is discharged, so a reader can see at a glance which gates
 * a build can close by itself and which require the fleet to have operated:
 *
 *   - `BUILD` — an `npm run` gate in this repository. Closable by a build.
 *   - `SUITE` — a test lane (`chaos`, `scale`, `engine`). Closable by a build.
 *   - `PRODUCTION` — requires realised production or staging data over wall-clock time
 *     (shadow agreement over ≥ 2 weeks, soak over days, fidelity against realised
 *     distributions). **Not closable by a build**, by construction.
 *   - `ORGANISATIONAL` — requires a named human owner to have done something (§22.4's
 *     calibration owner; a rehearsed rollback). Not closable by a build.
 *
 * The split is not bookkeeping. §22.4 names the organisational failure mode as "the most
 * likely way this design fails in practice", and a gate table that quietly let a build
 * close an `ORGANISATIONAL` gate would be that failure implemented.
 */

/** @structural gate evaluation outcomes; see the header for why there is no fourth */
const STATUS = Object.freeze({
  GREEN: "GREEN",
  RED: "RED",
  NOT_EVALUATED: "NOT_EVALUATED",
});

/** @structural how a gate can be discharged */
const EVIDENCE = Object.freeze({
  BUILD: "BUILD",
  SUITE: "SUITE",
  PRODUCTION: "PRODUCTION",
  ORGANISATIONAL: "ORGANISATIONAL",
});

/**
 * The gates. Order is the order they are reported in, which is roughly the order they
 * become closable: build gates, then suites, then the things that need the fleet to have
 * run, then the things that need a person.
 *
 * `blocking: true` on every row is not an oversight — §1.8's Tier 0 indivisibility means
 * there is no gate here whose failure is survivable at cutover. The field exists so that
 * a future gate which genuinely is advisory can be added without changing `blockers()`,
 * and so that the absence of any advisory gate today is visible rather than implicit.
 */
const RELEASE_GATES = Object.freeze([
  {
    id: "tier_dependencies",
    section: "§1.8",
    evidence: EVIDENCE.BUILD,
    command: "npm run gate:tiers",
    blocking: true,
    statement: "No Tier 0 module depends on a Tier 1 or Tier 2 module.",
  },
  {
    id: "parameter_register",
    section: "§22.1",
    evidence: EVIDENCE.BUILD,
    command: "npm run gate:params",
    blocking: true,
    statement: "No behavioural constant lives outside the parameter register.",
  },
  {
    id: "design_tenets",
    section: "§1.5",
    evidence: EVIDENCE.BUILD,
    command: "npm run gate:tenets",
    blocking: true,
    statement: "No engine module violates a design tenet (T1–T10).",
  },
  {
    id: "identity_isolation",
    section: "§23.7",
    evidence: EVIDENCE.BUILD,
    command: "npm run gate:privacy",
    blocking: true,
    statement: "No identifying value is an input to any cost term.",
  },
  {
    id: "erasure_reconstruction_equivalence",
    section: "§23.7, §24.3",
    evidence: EVIDENCE.BUILD,
    command: "npm run gate:erasure",
    blocking: true,
    statement:
      "Reconstruction from Tier A reproduces Tier B byte for byte, and still does after erasure is applied to the corpus.",
  },
  {
    id: "calibration_safety_derived",
    section: "§22.4",
    evidence: EVIDENCE.ORGANISATIONAL,
    command: "npm run gate:calibration",
    blocking: true,
    statement:
      "Every Safety-class parameter is DERIVED. No Tier 0 parameter may be PROVISIONAL or UNCALIBRATED at launch.",
  },
  {
    id: "legacy_removed_from_build",
    section: "execution plan, Phase 15",
    evidence: EVIDENCE.BUILD,
    command: "npm run gate:legacy",
    blocking: true,
    statement: "The legacy decision path is removed from the build, not merely bypassed.",
  },
  {
    id: "lower_bound_admissibility",
    section: "§6.4, §24.1",
    evidence: EVIDENCE.SUITE,
    command: "npm run test:engine -- candidatesLowerBound",
    blocking: true,
    statement: "LB ≤ γ holds exhaustively over the configured parameter space, not by sampling.",
  },
  {
    id: "model_check_capacity_1_2_3",
    section: "§24.2",
    evidence: EVIDENCE.SUITE,
    command: "npm run test:engine -- ModelCheck",
    blocking: true,
    statement:
      "The commitment protocol and the lifecycle are model-checked exhaustively at capacity 1, 2 and 3 for every §24.2 safety and liveness property.",
  },
  {
    id: "determinism_replay",
    section: "§24.3",
    evidence: EVIDENCE.SUITE,
    command: "npm run test:engine -- determinism",
    blocking: true,
    statement: "The golden replay corpus reproduces every allocation and every cost term exactly.",
  },
  {
    id: "snapshot_retention",
    section: "§24.3",
    evidence: EVIDENCE.SUITE,
    command: "npm run test:engine -- observabilityDecisionRecord",
    blocking: true,
    statement: "No decision retains a Tier A record whose input snapshot has expired.",
  },
  {
    id: "chaos_capacity_1",
    section: "§24.5",
    evidence: EVIDENCE.SUITE,
    command: "npm run test:chaos",
    blocking: true,
    statement: "The whole chaos suite passes at capacity = 1.",
  },
  {
    id: "chaos_capacity_2",
    section: "§24.5",
    evidence: EVIDENCE.SUITE,
    command: "npm run test:chaos",
    blocking: true,
    statement:
      "The whole chaos suite passes at capacity = 2 — the configuration in which a fencing error is expressible.",
  },
  {
    id: "cache_tier_flush",
    section: "§3.3, §24.5, I16",
    evidence: EVIDENCE.SUITE,
    command: "npm run test:chaos -- cacheFlush",
    blocking: true,
    statement: "Flushing the entire cache tier under load loses, duplicates and double-grants no commitment.",
  },
  {
    id: "scale_targets",
    section: "§20.1, §24.6",
    evidence: EVIDENCE.SUITE,
    command: "npm run test:scale",
    blocking: true,
    statement:
      "Every §20.1 target is met, including both p99.9 targets — the ones that bound safety windows rather than describe latency.",
  },
  {
    id: "locality",
    section: "§24.6, T9",
    evidence: EVIDENCE.SUITE,
    command: "npm run test:scale -- locality",
    blocking: true,
    statement:
      "Identical benchmarks against a shard in a small fleet and a shard in a million-agent fleet produce statistically indistinguishable round times.",
  },
  {
    id: "overload_admission_control",
    section: "§20.5, §24.6",
    evidence: EVIDENCE.SUITE,
    command: "npm run test:scale -- overload",
    blocking: true,
    statement: "Load through overload sheds gracefully through admission control rather than collapsing.",
  },
  {
    id: "invariants_enforced",
    section: "§26",
    evidence: EVIDENCE.PRODUCTION,
    command: "invariant worker, zero-violation SLI over the observation window",
    blocking: true,
    statement:
      "Every §26 invariant reports ENFORCED in nominal operation with a zero-violation SLI, and none reports VIOLATED where §26.2's matrix says SUSPENDED.",
  },
  {
    id: "simulator_fidelity",
    section: "§24.4",
    evidence: EVIDENCE.PRODUCTION,
    command: "node tools/simFidelity/validate.js",
    blocking: true,
    statement:
      "Per-model distributions are validated one-sidedly against realised production data; no safety-relevant model exceeds sim.max_optimistic_bias.",
  },
  {
    id: "soak",
    section: "§24.6",
    evidence: EVIDENCE.PRODUCTION,
    command: "npm run test:scale -- soak (long-running profile)",
    blocking: true,
    statement: "A soak over days exposes no leak, unbounded cache, timer accumulation or queue drift.",
  },
  {
    id: "shadow_agreement",
    section: "§21.6",
    evidence: EVIDENCE.PRODUCTION,
    command: "shadow worker, agreement report over ≥ 2 weeks of live traffic",
    blocking: true,
    statement: "Shadow mode has run against live traffic for at least the declared window and its agreement report is published.",
  },
  {
    id: "safety_case_assembled",
    section: "§24.7",
    evidence: EVIDENCE.ORGANISATIONAL,
    command: "node tools/safetyCase/assemble.js",
    blocking: true,
    statement: "The safety case is assembled from queries over decision records, with every hazard carrying its evidence.",
  },
  {
    id: "rollback_rehearsed",
    section: "execution plan, Phase 15",
    evidence: EVIDENCE.ORGANISATIONAL,
    command: "docs/runbooks/rollback.md, rehearsal record",
    blocking: true,
    statement: "The rollback has been rehearsed end to end and the rehearsal is recorded with a date and an operator.",
  },
]);

const GATE_BY_ID = Object.freeze(
  RELEASE_GATES.reduce((index, gate) => {
    index[gate.id] = gate;
    return index;
  }, Object.create(null)),
);

/** Gate ids a build in this repository can legitimately close by itself. */
const BUILD_CLOSABLE = Object.freeze(
  RELEASE_GATES.filter((gate) => gate.evidence === EVIDENCE.BUILD || gate.evidence === EVIDENCE.SUITE).map(
    (gate) => gate.id,
  ),
);

/**
 * Fail the load if a gate row is malformed. A gate whose statement or section is missing
 * is a gate nobody can argue with, which is the same as no gate.
 */
function assertGates() {
  const seen = new Set();
  for (const gate of RELEASE_GATES) {
    if (seen.has(gate.id)) throw new Error(`release gate declared twice: ${gate.id}`);
    seen.add(gate.id);
    if (!gate.section || !gate.statement || !gate.command) {
      throw new Error(
        `release gate ${gate.id} is missing its section, statement or command. A gate that does not say ` +
          "what it asserts or how it is discharged cannot be evidence (§24.7).",
      );
    }
    if (!Object.values(EVIDENCE).includes(gate.evidence)) {
      throw new Error(`release gate ${gate.id} declares an unknown evidence kind: ${gate.evidence}`);
    }
  }
  return true;
}

assertGates();

/**
 * Evaluate the gate table against supplied evidence.
 *
 * Evidence is `{ [gateId]: { pass: boolean, detail?: string, observedAt?: string,
 * source?: string } }`. An id with no entry is `NOT_EVALUATED`; an unknown id is
 * reported as an error rather than ignored, because evidence filed against a gate that
 * does not exist is evidence that was never counted.
 *
 * @param {object} [evidence]
 * @returns {{ ok: boolean, results: object[], unknownEvidence: string[], counts: object }}
 */
function evaluate(evidence) {
  const supplied = evidence && typeof evidence === "object" ? evidence : {};
  const unknownEvidence = Object.keys(supplied).filter((id) => !GATE_BY_ID[id]);

  const results = RELEASE_GATES.map((gate) => {
    const record = supplied[gate.id];
    let status = STATUS.NOT_EVALUATED;
    if (record && typeof record === "object") status = record.pass === true ? STATUS.GREEN : STATUS.RED;
    return {
      id: gate.id,
      section: gate.section,
      evidence: gate.evidence,
      command: gate.command,
      blocking: gate.blocking,
      statement: gate.statement,
      status,
      detail: (record && record.detail) || null,
      observedAt: (record && record.observedAt) || null,
      source: (record && record.source) || null,
    };
  });

  const counts = results.reduce(
    (tally, result) => {
      tally[result.status] += 1;
      return tally;
    },
    { GREEN: 0, RED: 0, NOT_EVALUATED: 0 },
  );

  return {
    ok: unknownEvidence.length === 0 && results.every((r) => !r.blocking || r.status === STATUS.GREEN),
    results,
    unknownEvidence,
    counts,
  };
}

/**
 * The blocking gates that are not green — what refuses a cutover, and why.
 *
 * @param {object} [evidence]
 * @returns {object[]}
 */
function blockers(evidence) {
  return evaluate(evidence).results.filter((result) => result.blocking && result.status !== STATUS.GREEN);
}

/**
 * Render the table for a terminal or a runbook.
 *
 * @param {ReturnType<typeof evaluate>} result
 * @returns {string}
 */
function formatReport(result) {
  const lines = result.results.map(
    (row) => `  ${row.status.padEnd(13)} ${row.id.padEnd(36)} ${row.evidence.padEnd(15)} ${row.section}`,
  );
  const header =
    `release gates (§24) — ${result.counts.GREEN} green, ${result.counts.RED} red, ` +
    `${result.counts.NOT_EVALUATED} not evaluated`;
  const unknown =
    result.unknownEvidence.length > 0
      ? `\n  evidence filed against unknown gate id(s): ${result.unknownEvidence.join(", ")}`
      : "";
  return `${header}\n${lines.join("\n")}${unknown}`;
}

module.exports = {
  STATUS,
  EVIDENCE,
  RELEASE_GATES,
  GATE_BY_ID,
  BUILD_CLOSABLE,
  assertGates,
  evaluate,
  blockers,
  formatReport,
};

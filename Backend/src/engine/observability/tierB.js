"use strict";

/**
 * The Tier B decision record (§21.2) — **Tier 1** (T1-03).
 *
 * > **Tier B — the full-fidelity record. Sampled and budgeted.**
 *
 * | Section | Content |
 * |---|---|
 * | Candidate set | Every agent considered, in canonical order, with the tier at which it was discovered |
 * | Feasibility | Per candidate, per predicate: result, observed value, required value, input source, observation age, indeterminate policy applied |
 * | Costs | Per feasible candidate, every term of §8 itemised, in milli-CU, plus the total |
 * | Column detail | Every generated column with its full price decomposition |
 *
 * ── This module is a pure function, and that is the deliverable ─────────────
 * §24.3's reconstruction-equivalence gate requires that "for every decision in the
 * golden corpus that has a Tier B record, reconstruction from Tier A alone MUST
 * reproduce that Tier B content **byte for byte**". That property is not achieved by
 * the replayer being careful; it is achieved by Tier B being a **deterministic function
 * of the round's result**, so that a replay which reproduces the result reproduces the
 * record by construction.
 *
 * Everything that could break it is therefore excluded here rather than guarded
 * downstream:
 *
 *   - no clock — nothing in this module reads one, so no field can carry a write time;
 *   - no randomness — the ordering is `candidates/ordering.js`'s canonical one;
 *   - no store — the sections are built from the round result the caller passes;
 *   - no floats for costs — every milli-CU crosses the JSON boundary as a decimal
 *     string, because a term that round-tripped through a double would compare equal
 *     on a small corpus and diverge on a large one.
 *
 * `contentHash` is the digest of the four sections under `canonicalJson`, and it is
 * what makes the gate affordable over a whole corpus: comparing two digests is cheap,
 * and a digest that matches for a record whose bytes do not is a collision, not a bug
 * in the comparison.
 *
 * ── Why sampling this away costs nothing ───────────────────────────────────
 * > Tier B contains *derived* outputs: what feasibility concluded and what each
 * > candidate cost. Those are exactly what replay recomputes. A record whose Tier B was
 * > never written is still bit-for-bit replayable.
 *
 * Which is why the aggregate SLIs do not read this table: §7.7's histograms are folded
 * at decision time, before sampling, and are exact over 100 % of decisions. Sampling
 * first would have degraded them to estimates.
 */

const crypto = require("crypto");

const { canonicalJson, canonicalSort, compareStrings, thenBy } = require("../determinism/ordering");
const { compare: compareMilliCU } = require("../determinism/fixedPoint");
const { milli, itemiseTerms } = require("./tierA");

/** The digest the reconstruction-equivalence gate compares. @structural digest algorithm */
const DIGEST_ALGORITHM = "sha256";

/** §21.2's four Tier B sections, in the order the table states them. */
const SECTIONS = Object.freeze(["candidateSet", "feasibility", "costs", "columnDetail"]);

/**
 * Canonical candidate order: agent id. §6.6 makes the *candidate set* canonical by
 * construction upstream; this record restates the order explicitly so that a reader
 * comparing two Tier B records is comparing two lists in the same order rather than two
 * multisets.
 * @structural §9.6 requirement 2's order, specialised to the record
 */
const compareByAgentId = thenBy((a, b) => compareStrings(String(a.agentId), String(b.agentId)));

/**
 * §21.2's Candidate set section: "Every agent considered, in canonical order, with the
 * tier at which it was discovered."
 *
 * @param {Array<object>} candidates
 * @returns {object[]}
 */
function candidateSetOf(candidates) {
  return canonicalSort([...(candidates || [])], compareByAgentId).map((row) => ({
    agentId: String(row.agentId),
    // §6.3's expansion tier. The tier is what distinguishes "the nearest agent was
    // evaluated and lost" from "the nearest agent was never reached", and those two
    // have entirely different operational answers.
    discoveryTier: row.discoveryTier ?? null,
    availabilityClass: row.availabilityClass ?? null,
    lowerBoundMilliCU: milli(row.lowerBoundMilliCU),
    admitted: row.rejected === true ? false : true,
  }));
}

/**
 * §21.2's Feasibility section: per candidate, per predicate, the full evaluation tuple.
 *
 * This is the section whose absence from Tier A is the entire reason the two tiers
 * exist — 200 candidates × 38 predicates is ~7 600 sub-records per decision.
 *
 * @param {Array<object>} candidates each with `predicateResults`
 * @returns {object[]}
 */
function feasibilityOf(candidates) {
  return canonicalSort([...(candidates || [])], compareByAgentId).map((row) => ({
    agentId: String(row.agentId),
    admitted: row.rejected === true ? false : true,
    bindingPredicateId: row.bindingPredicateId ?? null,
    predicates: canonicalSort(
      [...(row.predicateResults || [])],
      thenBy((a, b) => compareStrings(String(a.predicateId), String(b.predicateId))),
    ).map((result) => ({
      predicateId: String(result.predicateId),
      outcome: result.outcome ?? null,
      observed: result.observed === undefined ? null : result.observed,
      required: result.required === undefined ? null : result.required,
      inputSource: result.inputSource ?? null,
      observationAgeMs: result.observationAgeMs ?? null,
      // §7.3 — which policy was applied when the predicate could not decide. Recorded
      // because "DENY on indeterminate" and "ADMIT with an uncertainty penalty" are
      // different decisions and the record must say which one was taken.
      indeterminatePolicy: result.indeterminatePolicy ?? null,
      margin: result.margin === undefined ? null : result.margin,
      marginUnit: result.marginUnit ?? null,
    })),
  }));
}

/**
 * §21.2's Costs section: "Per feasible candidate, every term of §8 itemised, in
 * milli-CU, plus the total."
 *
 * @param {Array<object>} candidates
 * @returns {object[]}
 */
function costsOf(candidates) {
  return canonicalSort(
    (candidates || []).filter((row) => row.rejected !== true && (row.breakdown || typeof row.gammaMilliCU === "bigint")),
    thenBy(
      (a, b) =>
        typeof a.gammaMilliCU === "bigint" && typeof b.gammaMilliCU === "bigint"
          ? compareMilliCU(a.gammaMilliCU, b.gammaMilliCU)
          : 0,
      (a, b) => compareStrings(String(a.agentId), String(b.agentId)),
    ),
  ).map((row) => ({
    agentId: String(row.agentId),
    terms: itemiseTerms(row.breakdown),
    totalMilliCU: milli(row.gammaMilliCU),
    unit: "milli-CU",
  }));
}

/**
 * §21.2's Column detail section: "Every generated column with its full price
 * decomposition."
 *
 * Every *generated* column, including the pruned ones — a column that was generated and
 * discarded is part of what the round considered, and a record that held only the kept
 * ones could not answer why the discarded one was not chosen.
 *
 * @param {object} input `{ columns, pruned }`
 * @returns {object[]}
 */
function columnDetailOf(input) {
  const source = input || {};
  const rows = [
    ...(source.columns || []).map((entry) => ({ ...entry, kept: true })),
    ...(source.pruned || []).map((entry) => ({ ...entry, kept: false })),
  ];

  return canonicalSort(
    rows,
    thenBy((a, b) => compareStrings(String(a.identity), String(b.identity))),
  ).map((entry) => ({
    identity: String(entry.identity),
    agentId: entry.agentId === undefined || entry.agentId === null ? null : String(entry.agentId),
    legIds: [...(entry.legIds || [])].map(String).sort(compareStrings),
    kept: entry.kept === true,
    prunedReason: entry.kept === true ? null : (entry.reason ?? null),
    gammaMilliCU: milli(entry.gammaMilliCU),
    // The full price decomposition — `γ(c) = Φ(plan(c)) − Φ(plan₀) + C_churn`, term by
    // term. §8's consistency requirement is that this recomputes to `gammaMilliCU`
    // exactly, in integer milli-CU, and holding the decomposition is what makes that
    // checkable after the fact rather than only at the moment of the solve.
    priceDecomposition: itemiseTerms(entry.breakdown),
    omittedTerms: entry.omittedTerms ?? null,
  }));
}

/**
 * Build one Tier B record.
 *
 * Pure. Same input, same bytes, in every process and on every replay.
 *
 * @param {object} input
 * @param {string} input.decisionId
 * @param {string} input.roundId
 * @param {string} input.shardId
 * @param {number} input.decisionTimeMs
 * @param {Array<object>} input.candidates every agent considered for this Leg
 * @param {Array<object>} [input.columns] the columns the round kept
 * @param {Array<object>} [input.pruned] the columns the round generated and discarded
 * @returns {object} the frozen record, carrying `contentHash`
 */
function build(input) {
  const source = input || {};

  const sections = {
    candidateSet: candidateSetOf(source.candidates),
    feasibility: feasibilityOf(source.candidates),
    costs: costsOf(source.candidates),
    columnDetail: columnDetailOf({ columns: source.columns, pruned: source.pruned }),
  };

  const contentHash = crypto.createHash(DIGEST_ALGORITHM).update(canonicalJson(sections)).digest("hex");

  return Object.freeze({
    decisionId: String(source.decisionId),
    roundId: source.roundId === undefined ? null : String(source.roundId),
    shardId: source.shardId === undefined ? null : String(source.shardId),
    decisionTimeMs: Number.isFinite(source.decisionTimeMs) ? source.decisionTimeMs : null,
    ...sections,
    contentHash,
  });
}

/**
 * The canonical serialisation of a record's four sections — the byte string the
 * reconstruction-equivalence gate compares, and the one `contentHash` digests.
 *
 * The identity fields are deliberately **excluded**: they come from Tier A, which the
 * reconstruction path already has, and including them would make the comparison partly
 * a comparison of Tier A with itself.
 *
 * @param {object} record
 * @returns {string}
 */
function serialiseSections(record) {
  const sections = {};
  for (const name of SECTIONS) sections[name] = record ? record[name] : null;
  return canonicalJson(sections);
}

/**
 * Compare a stored Tier B record against a reconstruction, byte for byte (§24.3).
 *
 * @param {object} stored
 * @param {object} reconstructed
 * @returns {{ ok: boolean, storedHash: string|null, reconstructedHash: string|null,
 *             differingSections: string[], firstDifference: object|null }}
 */
function equivalent(stored, reconstructed) {
  const storedBytes = serialiseSections(stored);
  const rebuiltBytes = serialiseSections(reconstructed);

  const differingSections = SECTIONS.filter(
    (name) => canonicalJson(stored ? stored[name] : null) !== canonicalJson(reconstructed ? reconstructed[name] : null),
  );

  let firstDifference = null;
  if (storedBytes !== rebuiltBytes) {
    let index = 0;
    while (index < storedBytes.length && index < rebuiltBytes.length && storedBytes[index] === rebuiltBytes[index]) index += 1;
    // @structural the context window either side of a byte difference, for the report
    const CONTEXT = 60;
    firstDifference = {
      offset: index,
      stored: storedBytes.slice(Math.max(0, index - CONTEXT), index + CONTEXT),
      reconstructed: rebuiltBytes.slice(Math.max(0, index - CONTEXT), index + CONTEXT),
    };
  }

  return {
    ok: storedBytes === rebuiltBytes,
    storedHash: stored ? (stored.contentHash ?? null) : null,
    reconstructedHash: reconstructed ? (reconstructed.contentHash ?? null) : null,
    differingSections,
    firstDifference,
  };
}

/**
 * Flatten a record into the `DecisionRecordB` column shape.
 *
 * @param {object} record
 * @param {object} extra `{ writtenBecause, exemptionReason, retainUntil }`
 * @returns {object}
 */
function toRow(record, extra) {
  const more = extra || {};
  return {
    decisionId: record.decisionId,
    roundId: record.roundId,
    shardId: record.shardId,
    decisionTime: new Date(record.decisionTimeMs),
    writtenBecause: more.writtenBecause,
    exemptionReason: more.exemptionReason ?? null,
    candidateSet: record.candidateSet,
    feasibility: record.feasibility,
    costs: record.costs,
    columnDetail: record.columnDetail,
    contentHash: record.contentHash,
    sizeBytes: Buffer.byteLength(serialiseSections(record), "utf8"),
    retainUntil: more.retainUntil ?? null,
  };
}

/**
 * Rebuild the in-memory record from a stored `DecisionRecordB` row.
 *
 * @param {object} row
 * @returns {object}
 */
function fromRow(row) {
  return Object.freeze({
    decisionId: row.decisionId,
    roundId: row.roundId ?? null,
    shardId: row.shardId ?? null,
    decisionTimeMs: row.decisionTime instanceof Date ? row.decisionTime.getTime() : (row.decisionTime ?? null),
    candidateSet: row.candidateSet ?? [],
    feasibility: row.feasibility ?? [],
    costs: row.costs ?? [],
    columnDetail: row.columnDetail ?? [],
    contentHash: row.contentHash ?? null,
  });
}

module.exports = {
  DIGEST_ALGORITHM,
  SECTIONS,
  candidateSetOf,
  feasibilityOf,
  costsOf,
  columnDetailOf,
  build,
  serialiseSections,
  equivalent,
  toRow,
  fromRow,
};

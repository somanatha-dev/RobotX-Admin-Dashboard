"use strict";

/**
 * The Tier A decision record (§21.2) — **Tier 1** (T1-03), invariants I10, I15.
 *
 * > One immutable record per decision round, per Leg. It MUST be sufficient to
 * > reconstruct any question about the decision, and sufficient to replay it
 * > bit-identically (§9.6).
 *
 * > **Tier A — the compact record. Always written, always retained in full.**
 *
 * ── The one property that makes the whole scheme work ───────────────────────
 * > Tier A is bounded by construction — it is `O(1)` in candidate count, not
 * > `O(k · predicates)` — and sizes to roughly 1–2 KB per decision.
 *
 * Two sections could grow with the candidate set, and each is bounded by a different
 * mechanism rather than by hoping:
 *
 *   - **Runner-up and top-N** is bounded by `observability.compact_top_n` (default 5).
 *   - **Rejection summary** is *counts by binding predicate*, not per-candidate rows.
 *     Its size is bounded by the 38-entry predicate register, which is a constant of
 *     the design, not a function of `k`. §21.2 says so explicitly: "the aggregate, not
 *     the per-candidate rows".
 *
 * `assertBoundedInCandidateCount()` proves the property by building the same record
 * twice against candidate sets of very different sizes and comparing the results, so
 * the bound is checked mechanically rather than argued in review. It is the check a
 * future section addition has to pass.
 *
 * ── Sections that are never sampled away, and why they are here ─────────────
 * Three sections are load-bearing for questions the operator asks most, and §21.2 puts
 * each of them in Tier A for that reason rather than in the sampled tier:
 *
 *   - the **deferral reason** — "never sampled away", because a deferral "is exactly
 *     the kind of decision that gets questioned" (§8.8);
 *   - the **rejection histogram** — aggregated at decision time and exact over 100 % of
 *     decisions (§7.7), which is what lets "why is this still waiting" be answered from
 *     Tier A with no reconstruction at all;
 *   - the **kill-switch state** — "a thrown switch that is not recorded would silently
 *     break replay determinism" (§22.5 rule 4).
 *
 * ── Milli-CU crosses the JSON boundary as a string ─────────────────────────
 * Every cost in this record is int64 milli-CU (§9.6 requirement 1) and does not survive
 * a JSON number. It is written as a decimal string, everywhere, without exception —
 * the same discipline `Round.searchGapMilliCU` already uses. A single term that
 * round-tripped through a float would break the byte-for-byte reconstruction gate in a
 * way that is invisible until the corpus happens to contain a large enough value.
 */

const { canonicalJson, canonicalSort, compareStrings, thenBy } = require("../determinism/ordering");
const { compare: compareMilliCU, toCU } = require("../determinism/fixedPoint");

/**
 * §21.2's Trigger row: "New arrival, re-plan, recovery, preemption, escalation step."
 */
const TRIGGER = Object.freeze({
  NEW_ARRIVAL: "NEW_ARRIVAL",
  REPLAN: "REPLAN",
  RECOVERY: "RECOVERY",
  PREEMPTION: "PREEMPTION",
  ESCALATION_STEP: "ESCALATION_STEP",
});

/**
 * The section names of §21.2's Tier A table, in the order the table states them.
 * Exported so `assertComplete()` and the tests check against one list rather than
 * against two that can drift apart.
 */
const SECTIONS = Object.freeze([
  "identity",
  "versions",
  "trigger",
  "inputSnapshotRefs",
  "leg",
  "outcome",
  "runnerUpAndTopN",
  "costTotals",
  "rejectionSummary",
  "searchAndSolveBounds",
  "degradation",
  "deferral",
  "overrides",
  "predictions",
]);

/**
 * The default for `observability.compact_top_n` when the caller resolves nothing —
 * used only so a malformed config cannot make the record *unbounded*. A resolved value
 * always wins.
 * @param observability.compact_top_n
 */
const COMPACT_TOP_N_FALLBACK = 5;

/**
 * Render an int64 milli-CU quantity for JSON.
 *
 * @param {bigint|null|undefined} milliCU
 * @returns {string|null}
 */
function milli(milliCU) {
  if (milliCU === null || milliCU === undefined) return null;
  if (typeof milliCU === "bigint") return milliCU.toString();
  if (typeof milliCU === "string") return milliCU;
  throw new TypeError(
    `Tier A carries costs as int64 milli-CU, received ${typeof milliCU}. A cost that crossed the JSON ` +
      "boundary as a number would break the reconstruction-equivalence gate (§24.3) at whatever magnitude " +
      "first exceeds float precision (§9.6 requirement 1).",
  );
}

/**
 * Itemise a `Φ` breakdown for the record: every term, in milli-CU, as strings.
 *
 * @param {object|null} breakdown a `cost/phi.evaluate()` breakdown or a column price
 * @returns {object|null}
 */
function itemiseTerms(breakdown) {
  if (!breakdown || typeof breakdown !== "object") return null;
  const out = {};
  for (const key of Object.keys(breakdown).sort(compareStrings)) {
    const value = breakdown[key];
    if (typeof value === "bigint") out[key] = value.toString();
    else if (value === null || value === undefined) out[key] = null;
    else if (typeof value === "object") out[key] = itemiseTerms(value);
    else out[key] = value;
  }
  return out;
}

/**
 * Build the compact top-N: the runner-up with its cost delta, then the top
 * `observability.compact_top_n` candidates by total cost.
 *
 * > The runner-up with its cost delta, and the top `observability.compact_top_n`
 * > (default 5) candidates by total cost, each with its cost total and, **if rejected,
 * > its binding predicate only**.
 *
 * "Its binding predicate only" is the O(1) clause: a rejected candidate contributes one
 * predicate id, never the 38-row evaluation that produced it. That belongs in Tier B.
 *
 * @param {object} input
 * @param {Array<object>} [input.candidates] `{ agentId, gammaMilliCU, rejected,
 *   bindingPredicateId, discoveryTier }`
 * @param {string|null} [input.chosenAgentId]
 * @param {number} [input.topN]
 * @returns {{ runnerUp: object|null, topN: object[], truncatedFrom: number }}
 */
function compactTopN(input) {
  const source = input || {};
  const limit = Number.isFinite(source.topN) && source.topN > 0 ? Math.floor(source.topN) : COMPACT_TOP_N_FALLBACK;
  const all = [...(source.candidates || [])];

  const priced = all.filter((row) => typeof row.gammaMilliCU === "bigint");
  const ordered = canonicalSort(
    priced,
    thenBy(
      (a, b) => compareMilliCU(a.gammaMilliCU, b.gammaMilliCU),
      (a, b) => compareStrings(String(a.agentId), String(b.agentId)),
    ),
  );

  const chosen = source.chosenAgentId === undefined || source.chosenAgentId === null ? null : String(source.chosenAgentId);
  const chosenEntry = chosen === null ? null : ordered.find((row) => String(row.agentId) === chosen) || null;
  const runnerUpEntry = chosen === null ? (ordered[1] ?? null) : (ordered.find((row) => String(row.agentId) !== chosen) ?? null);

  // §21.2 asks for "the runner-up **with its cost delta**". The delta is the datum; the
  // runner-up's own total is already in the top-N it necessarily appears in, so it is
  // not repeated here. The margin is computed at write time rather than left to the
  // reader, so no rendering can perform a different subtraction from the one the record
  // means.
  const runnerUp =
    runnerUpEntry === null
      ? null
      : {
          agentId: String(runnerUpEntry.agentId),
          deltaMilliCU:
            chosenEntry && typeof chosenEntry.gammaMilliCU === "bigint" && typeof runnerUpEntry.gammaMilliCU === "bigint"
              ? milli(runnerUpEntry.gammaMilliCU - chosenEntry.gammaMilliCU)
              : null,
          gammaMilliCU: milli(runnerUpEntry.gammaMilliCU),
        };

  // **One** list of `observability.compact_top_n` entries, exactly as §21.2 words it:
  // "the top `observability.compact_top_n` (default 5) candidates by total cost, each
  // with its cost total and, **if rejected, its binding predicate only**". A rejected
  // candidate has no total cost, so it is ranked by the admissible lower bound it does
  // have (§6.4) and ordered after every priced candidate — the list is "by total cost",
  // and something without one cannot outrank something with one.
  //
  // Carrying a second, parallel list of rejected candidates was considered and rejected:
  // it doubles the section for a query §21.3 already permits to fall back
  // (*"why did this task go to a distant agent?" — TIER_A for the top-N; otherwise
  // RECONSTRUCTED*), and the whole reason this section is capped is that Tier A must be
  // `O(1)` in candidate count and inside §20.1's 2 KB.
  const rejectedRows = canonicalSort(
    all.filter((row) => row.rejected === true),
    thenBy(
      (a, b) =>
        typeof a.lowerBoundMilliCU === "bigint" && typeof b.lowerBoundMilliCU === "bigint"
          ? compareMilliCU(a.lowerBoundMilliCU, b.lowerBoundMilliCU)
          : 0,
      (a, b) => compareStrings(String(a.agentId), String(b.agentId)),
    ),
  );

  const topN = [...ordered, ...rejectedRows].slice(0, limit).map((row) => {
    const entry = {
      agentId: String(row.agentId),
      gammaMilliCU: milli(row.gammaMilliCU),
      discoveryTier: row.discoveryTier ?? null,
    };
    // A rejected candidate contributes its binding predicate and nothing else. This is
    // the clause that keeps the section `O(1)` rather than `O(k · predicates)`: the
    // 38-row evaluation behind it belongs in Tier B. Present only when it applies —
    // a `null` on every priced row is four bytes of nothing, repeated per row per
    // decision, against a 2 KB budget (§20.1).
    if (row.rejected === true) entry.bindingPredicateId = row.bindingPredicateId ?? null;
    // Likewise `chosen`: it is `outcome.agentId`, which the same record already carries.
    if (chosen !== null && String(row.agentId) === chosen) entry.chosen = true;
    return entry;
  });

  return { runnerUp, topN, truncatedFrom: all.length };
}

/**
 * The key one rejection dimension tuple folds to. §7.7's aggregation key, minus the
 * dimensions that are constant within a single decision (shard, zone, mission class,
 * Leg purpose — all already elsewhere in the record).
 *
 * @param {string} predicateId
 * @param {string|null} tier
 * @returns {string}
 */
function rejectionKey(predicateId, tier) {
  return tier === null || tier === undefined ? String(predicateId) : `${predicateId}:${tier}`;
}

/**
 * Fold rejection counts into the compact map form.
 *
 * @param {Array<{ predicateId: string, tier?: string|null, count: number }>} rows
 * @returns {Record<string, number>}
 */
function rejectionSummaryOf(rows) {
  const counts = new Map();
  for (const row of rows || []) {
    const key = rejectionKey(row.predicateId, row.tier ?? null);
    counts.set(key, (counts.get(key) || 0) + (Number(row.count) || 0));
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => compareStrings(a[0], b[0])));
}

/**
 * Read the compact map back as the sorted rows an operator surface renders.
 *
 * @param {Record<string, number>} summary
 * @returns {Array<{ predicateId: string, tier: string|null, count: number, share: number }>}
 */
function rejectionRows(summary) {
  const entries = Object.entries(summary || {});
  const total = entries.reduce((sum, [, count]) => sum + Number(count || 0), 0);
  return entries
    .map(([key, count]) => {
      const [predicateId, tier] = key.split(":");
      return {
        predicateId,
        tier: tier === undefined ? null : tier,
        count: Number(count || 0),
        share: total > 0 ? Number(count || 0) / total : 0,
      };
    })
    // Descending by count: the answer to "what is blocking this Leg" is the first row.
    .sort((a, b) => b.count - a.count || compareStrings(a.predicateId, b.predicateId));
}

/**
 * Assemble one Tier A record.
 *
 * Every argument is data the caller already holds; this module reads no store, no
 * clock, and no config service. It is the *shape* of the record, and keeping it pure is
 * what lets the replayer rebuild a record from a stored snapshot and compare it against
 * the original without standing up half the engine.
 *
 * @param {object} input
 * @param {object} input.identity `{ decisionId, roundId, shardId, leadershipFence,
 *   coordinatorInstance, decisionTimeMs }`
 * @param {object} input.versions `{ codeVersion, configVersion, activeRegime,
 *   modelVersions, mapVersion, routingGraphVersion, chargerProjectionVersion }`
 * @param {string} input.trigger one of `TRIGGER`
 * @param {object} input.inputSnapshotRefs `{ snapshotId, hash, seed, ... }`
 * @param {object} input.leg `{ legId, purpose, missionClass, tenantId, sla, queueAgeSeconds, ladderStep }`
 * @param {object} input.outcome `{ outcome, agentId, columnIdentity, columnLegIds,
 *   commitmentId, commitmentFence, agentAuthorityEpoch, detail }`
 * @param {object} [input.candidates] the candidate summaries for the compact top-N
 * @param {object} [input.costTotals] `{ chosen: breakdown, runnerUp: breakdown }`
 * @param {Array<object>} [input.rejectionSummary] `{ predicateId, tier, count }`
 * @param {object} input.searchAndSolveBounds
 * @param {object} [input.degradation]
 * @param {object|null} [input.deferral]
 * @param {Array<object>} [input.overrides]
 * @param {object} [input.predictions]
 * @param {number} [input.compactTopN] `observability.compact_top_n`
 * @returns {object} the frozen Tier A record
 */
function build(input) {
  const source = input || {};
  const identity = source.identity || {};
  const bounds = source.searchAndSolveBounds || {};

  const compact = compactTopN({
    candidates: source.candidates,
    chosenAgentId: source.outcome ? source.outcome.agentId : null,
    topN: source.compactTopN,
  });

  const record = {
    identity: {
      decisionId: String(identity.decisionId),
      roundId: identity.roundId === undefined ? null : String(identity.roundId),
      shardId: identity.shardId === undefined ? null : String(identity.shardId),
      // §10.3.2 guard G1's fence, recorded so a commit that landed late can be
      // attributed to the leader that issued it.
      leadershipFence:
        identity.leadershipFence === undefined || identity.leadershipFence === null
          ? null
          : String(identity.leadershipFence),
      coordinatorInstance: identity.coordinatorInstance ?? null,
      decisionTimeMs: Number.isFinite(identity.decisionTimeMs) ? identity.decisionTimeMs : null,
    },

    versions: {
      codeVersion: (source.versions && source.versions.codeVersion) ?? null,
      configVersion: (source.versions && source.versions.configVersion) ?? null,
      // §22.2's active regime. A decision taken under a winter regime replays under it
      // only if the regime is part of the record.
      activeRegime: (source.versions && source.versions.activeRegime) ?? null,
      modelVersions: (source.versions && source.versions.modelVersions) ?? null,
      mapVersion: (source.versions && source.versions.mapVersion) ?? null,
      routingGraphVersion: (source.versions && source.versions.routingGraphVersion) ?? null,
      chargerProjectionVersion: (source.versions && source.versions.chargerProjectionVersion) ?? null,
    },

    trigger: source.trigger ?? null,

    inputSnapshotRefs: source.inputSnapshotRefs ?? null,

    leg: {
      legId: source.leg ? (source.leg.legId ?? null) : null,
      purpose: source.leg ? (source.leg.purpose ?? null) : null,
      missionClass: source.leg ? (source.leg.missionClass ?? null) : null,
      tenantId: source.leg ? (source.leg.tenantId ?? null) : null,
      sla: source.leg ? (source.leg.sla ?? null) : null,
      queueAgeSeconds: source.leg ? (source.leg.queueAgeSeconds ?? null) : null,
      // §17.4 — how far up the ladder this Leg has got. The queue-age audit of I13
      // reads this against the age above it.
      ladderStep: source.leg ? (source.leg.ladderStep ?? null) : null,
    },

    outcome: {
      outcome: source.outcome ? (source.outcome.outcome ?? null) : null,
      agentId: source.outcome ? (source.outcome.agentId ?? null) : null,
      columnIdentity: source.outcome ? (source.outcome.columnIdentity ?? null) : null,
      // "the selected column and its **full Leg set**" — a multi-Leg column's other
      // Legs are part of what was decided, and a record naming only this Leg would
      // make the decision unexplainable from the other Legs' records.
      columnLegIds: source.outcome && source.outcome.columnLegIds ? [...source.outcome.columnLegIds].map(String).sort(compareStrings) : null,
      commitmentId: source.outcome ? (source.outcome.commitmentId ?? null) : null,
      commitmentFence:
        source.outcome && source.outcome.commitmentFence !== undefined && source.outcome.commitmentFence !== null
          ? String(source.outcome.commitmentFence)
          : null,
      agentAuthorityEpoch:
        source.outcome && source.outcome.agentAuthorityEpoch !== undefined && source.outcome.agentAuthorityEpoch !== null
          ? String(source.outcome.agentAuthorityEpoch)
          : null,
      detail: source.outcome ? (source.outcome.detail ?? null) : null,
      commitAbortReason: source.outcome ? (source.outcome.commitAbortReason ?? null) : null,
    },

    runnerUpAndTopN: {
      runnerUp: compact.runnerUp,
      topN: compact.topN,
      // How many candidates the top-N was drawn from. The record is O(1) in this
      // number, and stating it is what lets a reader see that it is.
      candidatesConsidered: compact.truncatedFrom,
      compactTopN: Number.isFinite(source.compactTopN) ? source.compactTopN : COMPACT_TOP_N_FALLBACK,
    },

    // "Every term of §8 itemised **for the chosen candidate and the runner-up**" — two
    // breakdowns, never k of them.
    costTotals: {
      chosen: itemiseTerms(source.costTotals ? source.costTotals.chosen : null),
      runnerUp: itemiseTerms(source.costTotals ? source.costTotals.runnerUp : null),
      unit: "milli-CU",
    },

    // "Counts by binding predicate across the whole candidate set — **the aggregate, not
    // the per-candidate rows**." Exact over 100 % of decisions (§7.7), never sampled.
    //
    // Encoded as a map from key to count rather than as an array of
    // `{predicateId, tier, count}` objects. The two carry identical information; the map
    // is roughly a quarter the bytes, because an array of objects repeats three field
    // names on every row and this section is the single largest contributor to a Tier A
    // record's size. §20.1 bounds that size at 2 KB, so the encoding is load-bearing
    // rather than cosmetic.
    //
    // §7.7 makes the F34 binding **tier** part of the key — "a fleet blocked on
    // immobilisation risk and one blocked on divert-to-charge risk need different
    // interventions" — so a tiered predicate keys as `F34:T2`, and an untiered one as
    // its bare id. `canonicalJson` sorts keys, so the encoding is deterministic; the
    // descending-by-count ordering an operator wants is applied where it is read
    // (`explanation.whyStillWaiting`), not where it is stored.
    rejectionSummary: rejectionSummaryOf(source.rejectionSummary),

    searchAndSolveBounds: {
      cellsExplored: bounds.cellsExplored ?? null,
      agentsEvaluated: bounds.agentsEvaluated ?? null,
      smallestUnexploredBoundMilliCU: milli(bounds.smallestUnexploredBoundMilliCU),
      // ── Phase 10 handoffs P11-2 and P11-3 ─────────────────────────────────
      // WHICH algorithm decided this Leg, and whether it proved its answer.
      // `PHASE_10_REMEDIATION_AND_CLOSURE.md` P11-2: the round result now carries the
      // partition's `solver` / `optimalityCertified` / `fallbackFrom`, and Tier A should
      // carry them "so an exactness fallback in production is visible in the record, not
      // only in the round object". Without them a round could fall back from cost scaling
      // to the reference solver — a 23-second solve — and every decision record it
      // produced would look identical to one the fast path certified.
      //
      // Read from the partition that actually contained this Leg, never from a label and
      // never from the round as a whole: two partitions of one round can be decided by
      // two different solvers with two different certification states.
      solver: bounds.solver ?? null,
      optimalityCertified: bounds.optimalityCertified === undefined ? null : bounds.optimalityCertified,
      fallbackFrom: bounds.fallbackFrom ?? null,
      objectiveMilliCU: milli(bounds.objectiveMilliCU),
      boundMilliCU: milli(bounds.boundMilliCU),
      // P11-3 — the **truncation gap**: `objective − bound` on the incumbent this Leg's
      // sub-problem returned. A FOURTH quantity, and none of the other three substitutes:
      //
      //   searchGapMilliCU      what candidate-set truncation could have cost (§9.3, §6.4)
      //   lpIpGapMilliCU        integrality — exactly zero in the singleton regime (§9.3)
      //   truncationGapMilliCU  what stopping early cost, on THIS solve (§9.4)
      //   column_generation_gap what a poorer column set cost — offline only (§21.6)
      //
      // Zero for an exact, certified result, by construction: the solver returns
      // `objective === bound` when it proves optimality. Non-zero only when a budget cut
      // the search short, which is the case §9.4 says must "return the incumbent with its
      // bound" rather than nothing. Computed as exact int64 milli-CU by the writer and
      // carried as a decimal string, like every other cost here (§9.6 requirement 1) — a
      // subtraction performed in float would report a gap of zero for two objectives that
      // differ, which is the one answer this field must never give.
      truncationGapMilliCU: milli(bounds.truncationGapMilliCU),
      // ── And the half a milli-CU gap cannot express ─────────────────────────
      // §9.3's objective is **lexicographic**: `(unassigned, milliCU)`, with an unassigned
      // Leg costing `(1, 0)`. `objectiveMilliCU` and `boundMilliCU` are the *money*
      // component alone, so `truncationGapMilliCU` bounds the money component alone — and
      // an incumbent that left every Leg queued scores a money gap of exactly zero while
      // being as far from optimal as the round can get.
      //
      // A reader who saw `truncationGapMilliCU: "0"` and stopped there would read that
      // incumbent as proven optimal. This is the dominant component of the same gap, so
      // the record cannot be read that way: with `optimalityCertified: false` and
      // `budgetLimited: true` beside it, the three together are the state Phase 10's D1
      // made distinguishable, and are why handoff P11-1's `decidedNothingBecause` was
      // withdrawn rather than implemented.
      legsUnassignedByIncumbent: Number.isFinite(bounds.legsUnassignedByIncumbent) ? bounds.legsUnassignedByIncumbent : null,
      // §6.4's two admissibility corrections, recorded because a large realised
      // correction is itself a §21.4 signal: "a large value means policy credit
      // ceilings exceed their realised use and should be tightened".
      omegaTerminalMilliCU: milli(bounds.omegaTerminalMilliCU),
      omegaPolicyMilliCU: milli(bounds.omegaPolicyMilliCU),
      // §9.3: reported **separately**, never summed. Summing them would bound neither.
      searchGapMilliCU: milli(bounds.searchGapMilliCU),
      lpIpGapMilliCU: milli(bounds.lpIpGapMilliCU),
      regime: bounds.regime ?? null,
      guarantees: bounds.guarantees ?? null,
      columnsGenerated: bounds.columnsGenerated ?? null,
      columnsPruned: bounds.columnsPruned ?? null,
      bestPrunedGammaMilliCU: milli(bounds.bestPrunedGammaMilliCU),
      budgetLimited: bounds.budgetLimited === true,
      boundsExceeded: bounds.boundsExceeded ?? null,
      truncatedBy: bounds.truncatedBy ?? null,
    },

    degradation: {
      // Only decision-specific degradations appear here. A shard-wide mode is recorded
      // once at the mode level (§18.5) and is referenced, not repeated — the same bound
      // `sampling.classifyExemption()` applies to the exemption list.
      dependencies: source.degradation ? (source.degradation.dependencies ?? []) : [],
      envelopeReductions: source.degradation ? (source.degradation.envelopeReductions ?? []) : [],
      relaxations: source.degradation ? (source.degradation.relaxations ?? []) : [],
      shardModes: source.degradation ? (source.degradation.shardModes ?? []) : [],
      // §22.5 rule 4 — "a thrown switch that is not recorded would silently break
      // replay determinism".
      killSwitches: source.degradation ? (source.degradation.killSwitches ?? null) : null,
    },

    // §8.8 — never sampled away. Null means no deferral was taken, not a deferral
    // without a reason.
    deferral: source.deferral ?? null,

    overrides: [...(source.overrides || [])],

    // §21.5 reads these back at settlement. Retained unconditionally, because a
    // prediction that is never compared to reality is a reassurance.
    predictions: source.predictions ?? null,
  };

  return Object.freeze(record);
}

/**
 * The canonical serialisation of a record — the byte string every size, digest, and
 * equality claim in this phase is made over.
 *
 * @param {object} record
 * @returns {string}
 */
function serialise(record) {
  return canonicalJson(record);
}

/**
 * The record's size in bytes, against §20.1's `< 2 KB per decision`.
 *
 * @param {object} record
 * @param {number} [limitBytes] `perf.tier_a_record_bytes`
 * @returns {{ bytes: number, limitBytes: number|null, withinLimit: boolean }}
 */
function size(record, limitBytes) {
  const bytes = Buffer.byteLength(serialise(record), "utf8");
  const limit = Number.isFinite(limitBytes) ? limitBytes : null;
  return { bytes, limitBytes: limit, withinLimit: limit === null ? true : bytes <= limit };
}

/**
 * Assert every §21.2 section is present. A section that is absent is not the same as a
 * section that is empty: an empty one says "nothing to record here", an absent one says
 * "this record was written by something that did not know the section existed", and only
 * the first is reconstructible.
 *
 * @param {object} record
 * @returns {{ ok: boolean, missing: string[] }}
 */
function assertComplete(record) {
  const missing = SECTIONS.filter((section) => !Object.prototype.hasOwnProperty.call(record || {}, section));
  return { ok: missing.length === 0, missing };
}

/**
 * Prove the record is `O(1)` in candidate count (§21.2), by construction rather than by
 * assertion: build the same decision against a small and a large candidate set and
 * require the two records to differ only in the fields that are *counts*.
 *
 * @param {object} input the `build()` input, whose `candidates` this replaces
 * @param {{ small?: number, large?: number }} [sizes]
 * @returns {{ ok: boolean, smallBytes: number, largeBytes: number, growthBytes: number,
 *             differingFields: string[] }}
 */
function assertBoundedInCandidateCount(input, sizes) {
  // @structural the small arm of the O(1) proof; two candidates make a runner-up exist
  const SMALL_ARM = 2;
  const smallCount = sizes && Number.isFinite(sizes.small) ? sizes.small : SMALL_ARM;
  // @structural the large arm of the O(1) proof; any k much larger than compact_top_n serves
  const largeCount = sizes && Number.isFinite(sizes.large) ? sizes.large : 500;

  // @structural milli-CU per CU; the fixed-point scale of §9.6 requirement 1
  const MILLI_PER_CU = 1000n;

  const synthetic = (count) =>
    Array.from({ length: count }, (unused, index) => ({
      agentId: `probe-${String(index).padStart(6, "0")}`,
      // Distinct prices, so the ordering is total and the top-N is genuinely a
      // selection rather than a tie broken by identity.
      gammaMilliCU: BigInt(index + 1) * MILLI_PER_CU,
      rejected: false,
      discoveryTier: 0,
    }));

  const small = build({ ...input, candidates: synthetic(smallCount) });
  const large = build({ ...input, candidates: synthetic(largeCount) });

  const smallBytes = Buffer.byteLength(serialise(small), "utf8");
  const largeBytes = Buffer.byteLength(serialise(large), "utf8");

  // The only fields permitted to differ are the top-N's own contents (bounded by
  // `compact_top_n`), the runner-up, and the count of candidates considered.
  const differingFields = [];
  for (const section of SECTIONS) {
    if (canonicalJson(small[section]) !== canonicalJson(large[section])) differingFields.push(section);
  }

  const permitted = differingFields.every((field) => field === "runnerUpAndTopN");

  // Growth is bounded by the width of the candidate-count integer, not by `k`.
  // @structural the byte allowance for a wider decimal count in the same record shape
  const GROWTH_ALLOWANCE_BYTES = 64;

  return {
    ok: permitted && largeBytes - smallBytes <= GROWTH_ALLOWANCE_BYTES,
    smallBytes,
    largeBytes,
    growthBytes: largeBytes - smallBytes,
    differingFields,
    note:
      "the top-N is bounded by observability.compact_top_n and the rejection summary is counts by predicate " +
      "over a 38-entry register, so neither grows with k. §21.2: Tier A is O(1) in candidate count, not " +
      "O(k · predicates).",
  };
}

/**
 * Flatten a record into the `DecisionRecordA` column shape.
 *
 * Kept here, beside `build()`, so that the record's shape and its persistence are one
 * change rather than two: a section added to `build()` and forgotten here would be a
 * section that exists in memory and nowhere else.
 *
 * @param {object} record
 * @param {object} [extra] `{ inputSnapshotId, fullRetentionUntil, tierBWritten,
 *   tierBReason, samplingDraw, samplingRate, sizeBytes }`
 * @returns {object}
 */
function toRow(record, extra) {
  const more = extra || {};
  return {
    decisionId: record.identity.decisionId,
    roundId: record.identity.roundId,
    shardId: record.identity.shardId,
    leadershipFence: record.identity.leadershipFence === null ? null : BigInt(record.identity.leadershipFence),
    coordinatorInstance: record.identity.coordinatorInstance,
    decisionTime: new Date(record.identity.decisionTimeMs),

    versions: record.versions,
    trigger: record.trigger,
    inputSnapshotRefs: record.inputSnapshotRefs,

    legId: record.leg.legId,
    legSummary: record.leg,

    outcome: record.outcome,
    runnerUpAndTopN: record.runnerUpAndTopN,
    costTotals: record.costTotals,
    rejectionSummary: record.rejectionSummary,
    searchAndSolveBounds: record.searchAndSolveBounds,
    degradation: record.degradation,
    deferral: record.deferral,
    overrides: record.overrides,
    predictions: record.predictions,

    // PHASE 14 — §23.7. Carried on the row and **not** inside `record`, so `digest()`
    // and §24.3's reconstruction see exactly the bytes they saw before this column
    // existed. It holds opaque surrogate keys and nothing else; `decisionRecord.js` is
    // the only thing that supplies it.
    surrogateKeys: Array.isArray(more.surrogateKeys) ? more.surrogateKeys : null,

    inputSnapshotId: more.inputSnapshotId ?? null,
    fullRetentionUntil: more.fullRetentionUntil ?? null,
    sizeBytes: Number.isFinite(more.sizeBytes) ? more.sizeBytes : Buffer.byteLength(serialise(record), "utf8"),
    tierBWritten: more.tierBWritten === true,
    tierBReason: more.tierBReason ?? null,
    samplingDraw: Number.isFinite(more.samplingDraw) ? more.samplingDraw : null,
    samplingRate: Number.isFinite(more.samplingRate) ? more.samplingRate : null,
    // §21.6 — null for a production decision. Set only by the shadow runner, whose
    // records must be visible to an analyst and invisible to every production read.
    shadowLabel: more.shadowLabel ?? null,
  };
}

/**
 * Rebuild the in-memory record from a stored `DecisionRecordA` row.
 *
 * The inverse of `toRow()`, and the reason the Explanation API can answer from Tier A
 * without a second shape: read and write agree because they are two functions over one
 * section list.
 *
 * @param {object} row
 * @returns {object}
 */
function fromRow(row) {
  return Object.freeze({
    identity: {
      decisionId: row.decisionId,
      roundId: row.roundId,
      shardId: row.shardId,
      leadershipFence: row.leadershipFence === null || row.leadershipFence === undefined ? null : String(row.leadershipFence),
      coordinatorInstance: row.coordinatorInstance ?? null,
      decisionTimeMs: row.decisionTime instanceof Date ? row.decisionTime.getTime() : row.decisionTime ?? null,
    },
    versions: row.versions ?? null,
    trigger: row.trigger ?? null,
    inputSnapshotRefs: row.inputSnapshotRefs ?? null,
    leg: row.legSummary ?? { legId: row.legId ?? null },
    outcome: row.outcome ?? null,
    runnerUpAndTopN: row.runnerUpAndTopN ?? null,
    costTotals: row.costTotals ?? null,
    rejectionSummary: row.rejectionSummary ?? {},
    searchAndSolveBounds: row.searchAndSolveBounds ?? null,
    degradation: row.degradation ?? null,
    deferral: row.deferral ?? null,
    overrides: row.overrides ?? [],
    predictions: row.predictions ?? null,
  });
}

/**
 * Render a milli-CU string as CU, for a human-facing surface. Never used inside the
 * record itself — §1.3's unit discipline means the stored value is the integer.
 *
 * @param {string|null} milliCUString
 * @returns {number|null}
 */
function asCU(milliCUString) {
  if (milliCUString === null || milliCUString === undefined) return null;
  return toCU(BigInt(milliCUString));
}

module.exports = {
  TRIGGER,
  SECTIONS,
  COMPACT_TOP_N_FALLBACK,
  milli,
  itemiseTerms,
  rejectionKey,
  rejectionSummaryOf,
  rejectionRows,
  compactTopN,
  build,
  serialise,
  size,
  assertComplete,
  assertBoundedInCandidateCount,
  toRow,
  fromRow,
  asCU,
};

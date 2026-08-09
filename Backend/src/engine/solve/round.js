"use strict";

/**
 * The round (§9, §3.4's round path) — **Tier 1**. The convergence point of the engine.
 *
 * > **Round path (asynchronous, sub-second cadence).** The `Assignment Coordinator` for
 * > each shard runs a continuous loop: collect the batch, discover candidates, evaluate
 * > feasibility, evaluate cost, solve, commit, dispatch, and record.
 *
 * ── L4 → L3, and where the line is drawn in this file ───────────────────────
 * §3.1 makes L4 "deterministic, side-effect-free, replayable" and L3 "serialised per
 * shard, durable, fenced". This phase is titled "(L4 → L3)" because a round crosses that
 * line exactly once, and the crossing is visible here:
 *
 *   - `plan()` is **entirely L4**. It reads through injected readers, computes, and
 *     returns an allocation with its decision fragments. It writes nothing, reads no
 *     clock, and can be run twice with identical results — which is what makes replay
 *     (§9.6) and shadow mode (§21.6) possible at all.
 *   - `execute()` takes `plan()`'s allocation across the line by invoking the injected
 *     `commit` — Phase 3's serialised conditional write, which carries dispatch with it
 *     because §10.3.2 step 5 writes the outbox row in the same transaction. This module
 *     performs no store access of its own; every durable effect is a function it was
 *     handed.
 *
 * ── The fast path is this function, at `|L| = 1` ────────────────────────────
 * There is no fast-path branch in this file, and its absence is the deliverable. §9.2:
 *
 * > **The fast path is the batch path invoked with a batch of one Leg** — not a parallel
 * > implementation that shares some code, but literally the same round executed over
 * > `|L| = 1`. … it is the property that is enforceable by a build-time test rather than
 * > by review discipline.
 *
 * `solve/cadence.js` decides the window and the batch cap; a fast-path verdict is a
 * window of zero and a cap of one. Nothing downstream of that reads the regime name.
 *
 * ── Partitioning that cannot sever a column ─────────────────────────────────
 * §9.4 is precise about the second condition, and it is the one an obvious implementation
 * gets wrong:
 *
 * > Partitioning is by connected components of the Leg–agent feasibility graph where
 * > possible, which is *exactly* lossless: two components sharing no feasible agent **and
 * > no common column** cannot influence each other. **The second condition is required by
 * > the column formulation and is not implied by the first** — two Legs may be linked by a
 * > multi-Leg column even when their individual candidate agent sets are disjoint, and
 * > splitting such a pair would discard that column silently. Columns spanning a proposed
 * > partition boundary are therefore either kept whole by merging the components or
 * > dropped with their bound recorded, **never severed**.
 *
 * `partition()` therefore unions **every** Leg a column covers together with its agent,
 * not just the (Leg, agent) pair. In the singleton regime the two conditions coincide, so
 * the extra union is a no-op — which is exactly why it must be written now, while it is
 * provably harmless, rather than discovered missing when multi-Leg columns arrive at
 * Phase 16d.
 *
 * ── Anytime, and what "never nothing" means for a round ─────────────────────
 * Every exit from `plan()` carries an allocation, even if it is the empty one, together
 * with the reason it is what it is. There is no path that returns `null`, throws past the
 * caller, or hangs. §9.4's anytime requirement is the general answer to the audit's
 * finding that the baseline "has no timeout anywhere in its assignment path".
 *
 * ── Every round produces a record ───────────────────────────────────────────
 * `plan()` returns one decision fragment per Leg — assigned, deferred, or unassigned with
 * the reason — and the round's own summary. Phase 11 owns the full §21.2 Tier A shape;
 * what this phase owes is that no Leg passes through a round without a record of what
 * happened to it, which is the completion criterion "every round produces a decision
 * record" read at the granularity the decision is actually taken.
 *
 * T1/I14: the feasibility brand is asserted before anything is priced or selected.
 * T6: no clock, no randomness — `elapsedMs` is injected and `decisionTimeMs` is an input.
 */

const { assertFeasible } = require("../guards/tenets");
const objective = require("./objective");
const minCostFlow = require("./minCostFlow");
const regimeModel = require("./regime");
const budgetModel = require("./budgets");
const columnBuilder = require("../plan/columnBuilder");
const { compareStrings, canonicalSort, thenBy } = require("../determinism/ordering");
const { compare: compareMilliCU, sum: sumMilliCU } = require("../determinism/fixedPoint");

/** What happened to one Leg in this round. @structural per-Leg outcome labels */
const LEG_OUTCOME = Object.freeze({
  ASSIGNED: "ASSIGNED",
  DEFERRED: "DEFERRED",
  NO_FEASIBLE_CANDIDATE: "NO_FEASIBLE_CANDIDATE",
  LOST_TO_ANOTHER_LEG: "LOST_TO_ANOTHER_LEG",
  BUDGET_TRUNCATED: "BUDGET_TRUNCATED",
  REGIME_UNSOLVABLE: "REGIME_UNSOLVABLE",
  COMMIT_ABORTED: "COMMIT_ABORTED",
});

/** How the round itself ended. @structural round outcome labels */
const ROUND_OUTCOME = Object.freeze({
  COMPLETED: "COMPLETED",
  BUDGET_LIMITED: "BUDGET_LIMITED",
  EMPTY: "EMPTY",
  REGIME_UNSOLVABLE: "REGIME_UNSOLVABLE",
});

/**
 * Canonical Leg order for the round: SLA priority, then Leg id (§9.6 requirement 2).
 * @structural §9.6 requirement 2's order, specialised to the batch
 */
const compareLegsForRound = thenBy(
  (a, b) => (a.priority ?? 0) - (b.priority ?? 0),
  (a, b) => compareStrings(a.legId, b.legId),
);

/**
 * A union-find over the Leg and agent identifiers a round touches.
 *
 * @returns {object}
 */
function createDisjointSets() {
  const parent = new Map();

  const find = (key) => {
    if (!parent.has(key)) parent.set(key, key);
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root);
    // Path compression, applied along the walked path.
    let cursor = key;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor);
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };

  return {
    find,
    union(a, b) {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA === rootB) return;
      // Union by the canonical order of the roots, so the resulting forest — and
      // therefore the partition's own identity — does not depend on the order the
      // unions happened to be issued in (§9.6 requirement 2).
      if (compareStrings(rootA, rootB) <= 0) parent.set(rootB, rootA);
      else parent.set(rootA, rootB);
    },
    keys() {
      return [...parent.keys()];
    },
  };
}

/**
 * §9.4's partitioning: connected components of the Leg–agent feasibility graph, with
 * every column kept whole.
 *
 * @param {object} input
 * @param {Array<object>} input.legs `{ legId }`
 * @param {Array<object>} input.pricedColumns from `plan/columnBuilder.build().columns`
 * @returns {{ parts: object[], merges: object[], note: string }}
 */
function partition(input) {
  const source = input || {};
  const sets = createDisjointSets();

  const legKey = (legId) => `leg:${legId}`;
  const agentKey = (agentId) => `agent:${agentId}`;

  for (const leg of source.legs || []) sets.find(legKey(String(leg.legId)));

  const merges = [];
  for (const entry of source.pricedColumns || []) {
    const legIds = [...(entry.legIds || [])].map(String).sort(compareStrings);
    const agentId = String(entry.agentId);

    // Union the agent with the *first* Leg, then every remaining Leg with the first.
    // The second half is what §9.4's "and no common column" condition requires: a column
    // covering two Legs binds them into one sub-problem even when their candidate agent
    // sets are otherwise disjoint. In the singleton regime the loop body never runs,
    // which is why this is provably harmless to write now.
    if (legIds.length === 0) continue;
    sets.union(legKey(legIds[0]), agentKey(agentId));
    for (let index = 1; index < legIds.length; index += 1) {
      const before = sets.find(legKey(legIds[index]));
      const into = sets.find(legKey(legIds[0]));
      if (before !== into) {
        merges.push({
          columnIdentity: String(entry.identity),
          legIds,
          because:
            "a column covers these Legs together, so splitting them would discard the column silently. §9.4: " +
            "columns spanning a proposed partition boundary are kept whole by merging the components, never severed.",
        });
      }
      sets.union(legKey(legIds[index]), legKey(legIds[0]));
    }
  }

  const byRoot = new Map();
  for (const leg of source.legs || []) {
    const root = sets.find(legKey(String(leg.legId)));
    if (!byRoot.has(root)) byRoot.set(root, { root, legs: [], columns: [] });
    byRoot.get(root).legs.push(leg);
  }
  for (const entry of source.pricedColumns || []) {
    const legIds = [...(entry.legIds || [])].map(String);
    if (legIds.length === 0) continue;
    const root = sets.find(legKey(legIds[0]));
    if (!byRoot.has(root)) byRoot.set(root, { root, legs: [], columns: [] });
    byRoot.get(root).columns.push(entry);
  }

  const parts = [...byRoot.values()]
    .map((part) => ({
      root: part.root,
      legs: canonicalSort(part.legs, compareLegsForRound),
      columns: canonicalSort(part.columns, objective.compareColumnsForSolve),
    }))
    .sort((a, b) => compareStrings(a.root, b.root));

  return {
    parts,
    merges,
    note:
      "components sharing no feasible agent and no common column cannot influence each other, so solving them " +
      "separately is provably optimal — exactly lossless, not merely near-lossless (§9.4).",
  };
}

/**
 * Discover, gate, and price the candidates for one Leg.
 *
 * Every exact evaluation is `deps.evaluateExact`, which `candidates/expansion.js` calls:
 * the feasibility gate (Phase 6) followed by the Plan Builder (Phase 8) and `Φ` (Phase 8).
 * This module does not reassemble that pipeline; it supplies the round's pinned inputs to
 * it and consumes what comes back.
 *
 * @param {object} deps
 * @param {object} input
 * @returns {Promise<object>}
 */
async function candidatesFor(deps, input) {
  const expansion = await deps.expandCandidates({
    ...input.expansionInput,
    legId: input.leg.legId,
    decisionTimeMs: input.decisionTimeMs,
  });

  return {
    legId: String(input.leg.legId),
    candidates: expansion.candidates || [],
    searchGapMilliCU: expansion.achievedGapMilliCU ?? 0n,
    truncatedBy: expansion.truncatedBy ?? null,
    cellsExplored: expansion.cellsExplored ?? 0,
    agentsEvaluated: expansion.agentsEvaluated ?? 0,
    problems: expansion.problems || [],
  };
}

/**
 * The L4 half of a round: everything up to, but not including, the durable write.
 *
 * @param {object} deps
 * @param {(input: object) => Promise<object>} deps.expandCandidates §6's expansion
 * @param {(agentId: string, legId: string) => object} deps.pricedCandidateFor builds the
 *   `plan/columnBuilder.build()` candidate entry for a surviving pairing
 * @param {object} deps.planState a `shard/planState.js` instance
 * @param {object} deps.budgets a `solve/budgets.js` tracker
 * @param {(leg: object) => object} [deps.deferPriceFor] Tier 2 (`cost/cDefer.js`),
 *   injected — never statically imported, because this module is Tier 1
 * @param {object} input
 * @param {string} input.roundId
 * @param {string} input.shardId
 * @param {number} input.decisionTimeMs
 * @param {Array<object>} input.legs the claimed batch
 * @param {object} input.config resolved parameters
 * @param {object} input.killSwitches resolved switch states
 * @param {object} [input.snapshot] the round's pinned inputs (§9.6 requirement 5)
 * @returns {Promise<object>}
 */
async function plan(deps, input) {
  const source = input || {};
  const config = source.config || {};
  const switches = source.killSwitches || {};
  const budgets = deps.budgets || budgetModel.create({ config });

  const orderedLegs = canonicalSort([...(source.legs || [])], compareLegsForRound);

  /* ── 1. Candidates, feasibility, and exact price, per Leg (§6, §7, §8) ──── */
  const perLeg = [];
  const searchGaps = [];
  const candidateEntries = [];

  for (const leg of orderedLegs) {
    const admitted = budgets.admitLeg(perLeg.length);
    if (!admitted.ok) {
      // §9.4's remedy for this bound is to partition, not to drop — but a Leg beyond the
      // cap was never collected into the batch in the first place (the coordinator
      // claims at most `maxLegsThisRound`). Reaching here means the caller over-filled
      // the batch, which is recorded rather than silently truncated.
      perLeg.push({ legId: String(leg.legId), outcome: LEG_OUTCOME.BUDGET_TRUNCATED, detail: admitted.verdict });
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const discovered = await candidatesFor(deps, {
      leg,
      decisionTimeMs: source.decisionTimeMs,
      expansionInput: leg.expansionInput || {},
    });

    searchGaps.push(discovered.searchGapMilliCU);

    if (discovered.candidates.length === 0) {
      perLeg.push({
        legId: discovered.legId,
        outcome: LEG_OUTCOME.NO_FEASIBLE_CANDIDATE,
        cellsExplored: discovered.cellsExplored,
        agentsEvaluated: discovered.agentsEvaluated,
        truncatedBy: discovered.truncatedBy,
        detail:
          "the hierarchical expansion found no agent that survived the feasibility gate. This is a priced " +
          "outcome, not an error: the Leg remains queued and the §17.4 ladder widens the option set on its own " +
          "clock, which is where the anti-starvation guarantee lives.",
      });
      continue;
    }

    for (const candidate of discovered.candidates) {
      const entry = deps.pricedCandidateFor(candidate.agentId, discovered.legId, candidate);
      if (!entry) continue;
      // T1/I14 again, at the boundary where a candidate becomes a column: the Plan
      // Builder's artefact must carry the brand the gate applied, or `Φ` refuses it.
      assertFeasible(entry.plan, `solve/round.plan (${discovered.legId} → ${candidate.agentId})`);
      candidateEntries.push(entry);
    }

    perLeg.push({
      legId: discovered.legId,
      outcome: null,
      cellsExplored: discovered.cellsExplored,
      agentsEvaluated: discovered.agentsEvaluated,
      truncatedBy: discovered.truncatedBy,
      searchGapMilliCU: discovered.searchGapMilliCU,
    });
  }

  /* ── 2. Columns and their price (§8.1, §9.3) ────────────────────────────── */
  const built = columnBuilder.build({
    candidates: candidateEntries,
    maxColumnsPerRound: config.maxColumnsPerRound,
  });

  budgets.admitColumns(built.generation.generated, built.generation.kept, built.generation.bestPrunedGammaMilliCU);

  /* ── 3. The regime, determined from the generated set (§9.3) ────────────── */
  const regime = regimeModel.determine(built.columns);
  const solvable = regimeModel.solverAvailable(regime.regime);

  const legsInBatch = perLeg.filter((row) => row.outcome === null || row.outcome === LEG_OUTCOME.NO_FEASIBLE_CANDIDATE);

  if (!solvable.solvable) {
    return finish({
      source,
      regime,
      built,
      budgets,
      perLeg: perLeg.map((row) =>
        row.outcome === null ? { ...row, outcome: LEG_OUTCOME.REGIME_UNSOLVABLE, detail: solvable.reason } : row,
      ),
      partitions: [],
      assignments: [],
      searchGaps,
      roundOutcome: ROUND_OUTCOME.REGIME_UNSOLVABLE,
      note: solvable.reason,
    });
  }

  /* ── 4. Partition, never severing a column (§9.4) ───────────────────────── */
  const partitioned = partition({
    legs: legsInBatch.map((row) => ({ legId: row.legId, priority: 0 })),
    pricedColumns: built.columns,
  });

  /* ── 5. Solve each part independently (§9.3) ────────────────────────────── */
  const assignments = [];
  const deferrals = [];
  const partitionReports = [];

  for (const part of partitioned.parts) {
    const legsForPart = part.legs.map((leg) => {
      const price = typeof deps.deferPriceFor === "function" ? deps.deferPriceFor(leg) : null;
      return {
        legId: leg.legId,
        // Tier 2 reaches this Tier 1 module as data, never as an import (§1.8 rule 2).
        // With the `deferral` switch thrown the injected function is absent and every
        // Leg's arc is simply not created.
        deferralAdmissible: switches.deferral === true && Boolean(price && price.admissible),
        deferPriceMilliCU: price && typeof price.milliCU === "bigint" ? price.milliCU : null,
      };
    });

    const instanceResult = objective.buildInstance({
      legs: legsForPart,
      columns: part.columns,
      deferralEnabled: switches.deferral === true,
    });

    if (!instanceResult.ok) {
      partitionReports.push({ root: part.root, ok: false, problems: instanceResult.problems });
      continue;
    }

    const solved = minCostFlow.solve(instanceResult.instance, { budgets });

    if (!solved.ok) {
      partitionReports.push({ root: part.root, ok: false, problems: solved.problems });
      continue;
    }

    const selection = {
      columnIndices: solved.assignments.map((row) => row.columnIndex),
      deferredLegIds: solved.deferred.map((row) => row.legId),
    };

    const validity = objective.validate(instanceResult.instance, selection);
    const consistency = objective.assertObjectiveIsAllocationCost({
      instance: instanceResult.instance,
      selection,
      solverObjectiveMilliCU: solved.objectiveMilliCU,
    });

    budgets.offer({
      assignments: solved.assignments,
      objectiveMilliCU: solved.objectiveMilliCU,
      boundMilliCU: solved.boundMilliCU,
      source: "MIN_COST_FLOW",
    });

    for (const row of solved.assignments) {
      // §2.6 — the SOFT reservation, in coordinator memory and nowhere else. Its one
      // durable consequence is the Leg's own state, which `durableEffect` describes and
      // the caller performs.
      const reserved = deps.planState ? deps.planState.reserve({ legId: row.legId, agentId: row.agentId, columnIdentity: row.identity }) : { ok: true, reservation: null, durableEffect: null };
      assignments.push({
        legId: row.legId,
        agentId: row.agentId,
        columnIdentity: row.identity,
        reserved: reserved.ok,
        reservationRefusal: reserved.ok ? null : reserved.refusal,
        durableEffect: reserved.durableEffect ?? null,
      });
    }

    for (const row of solved.deferred) deferrals.push({ legId: row.legId });

    partitionReports.push({
      root: part.root,
      ok: true,
      legCount: part.legs.length,
      columnCount: part.columns.length,
      objectiveMilliCU: solved.objectiveMilliCU,
      boundMilliCU: solved.boundMilliCU,
      lpIpGapMilliCU: solved.lpIpGapMilliCU,
      augmentations: solved.augmentations,
      budgetLimited: solved.budgetLimited,
      duals: solved.duals,
      agentDuals: solved.agentDuals,
      constraintsSatisfied: validity.feasible,
      constraintViolations: validity.violations,
      objectiveConsistent: consistency.ok,
      objectiveConsistencyReason: consistency.reason,
      unassigned: solved.unassigned,
    });
  }

  const assignedLegIds = new Set(assignments.map((row) => row.legId));
  const deferredLegIds = new Set(deferrals.map((row) => row.legId));

  const resolved = perLeg.map((row) => {
    if (row.outcome !== null) return row;
    if (assignedLegIds.has(row.legId)) {
      const match = assignments.find((entry) => entry.legId === row.legId);
      return { ...row, outcome: LEG_OUTCOME.ASSIGNED, agentId: match.agentId, columnIdentity: match.columnIdentity };
    }
    if (deferredLegIds.has(row.legId)) return { ...row, outcome: LEG_OUTCOME.DEFERRED };
    return {
      ...row,
      outcome: LEG_OUTCOME.LOST_TO_ANOTHER_LEG,
      detail:
        "feasible candidates existed, but every agent that could serve this Leg was allocated to a Leg the " +
        "objective priced more cheaply. This is the cannibalisation the batch solve exists to resolve, resolved " +
        "in the round's favour rather than by arrival order; the Leg remains queued for the next round.",
    };
  });

  return finish({
    source,
    regime,
    built,
    budgets,
    perLeg: resolved,
    partitions: partitionReports,
    partitionMerges: partitioned.merges,
    assignments,
    deferrals,
    searchGaps,
    roundOutcome: null,
    note: null,
  });
}

/**
 * Assemble the round's result. One exit, so every field is populated on every path and
 * "every round produces a decision record" is a property of the code shape rather than of
 * remembering to build one at each `return`.
 *
 * @param {object} context
 * @returns {object}
 */
function finish(context) {
  const budgetResult = context.budgets.result();
  const anytime = budgetModel.assertAnytime(budgetResult);

  const assignments = context.assignments || [];
  const deferrals = context.deferrals || [];

  const roundOutcome =
    context.roundOutcome ||
    (budgetResult.budgetLimited
      ? ROUND_OUTCOME.BUDGET_LIMITED
      : assignments.length === 0 && deferrals.length === 0
        ? ROUND_OUTCOME.EMPTY
        : ROUND_OUTCOME.COMPLETED);

  // §9.3: the two approximations are reported **separately** and never summed, because
  // they bound different things and summing them would bound neither.
  const searchGapMilliCU = sumMilliCU(context.searchGaps || []);
  const lpIpGapMilliCU = sumMilliCU(
    (context.partitions || []).filter((part) => part.ok).map((part) => part.lpIpGapMilliCU ?? 0n),
  );

  return Object.freeze({
    ok: true,
    roundId: context.source.roundId,
    shardId: context.source.shardId,
    decisionTimeMs: context.source.decisionTimeMs,
    regime: context.regime.regime,
    regimeWhy: context.regime.why,
    guarantees: regimeModel.guaranteesFor(context.regime.regime),
    outcome: roundOutcome,
    note: context.note,

    assignments: Object.freeze(assignments),
    deferrals: Object.freeze(deferrals),
    // One entry per Leg the round touched: assigned, deferred, or not, with the reason.
    decisions: Object.freeze(canonicalSort([...(context.perLeg || [])], thenBy((a, b) => compareStrings(a.legId, b.legId)))),

    columns: Object.freeze({
      generated: context.built.generation.generated,
      kept: context.built.generation.kept,
      pruned: context.built.generation.prunedCount,
      budgetTruncated: context.built.generation.budgetTruncated,
      bestPrunedGammaMilliCU: context.built.generation.bestPrunedGammaMilliCU,
      generationGapMilliCU: context.built.generation.generationGapMilliCU,
      generationGapNote: context.built.generation.generationGapNote,
    }),

    partitions: Object.freeze(context.partitions || []),
    partitionMerges: Object.freeze(context.partitionMerges || []),

    // Never summed. §9.3: "the specification reports them **separately** because they
    // bound different things and summing them would bound neither."
    searchGapMilliCU,
    lpIpGapMilliCU,

    budgets: budgetResult,
    anytime,
  });
}

/**
 * The round, end to end: `plan()`, then the crossing into L3.
 *
 * Commit is injected, not imported, and that is the layering rather than a testing
 * convenience: `src/engine/commitment/commit.js` is Tier 0 and performs the serialised
 * durable write, and a Tier 1 decision module that reached into it directly would give
 * the decision layer an external effect. Dispatch needs no separate step here — §10.3.2
 * step 5 writes the outbox row **inside** the commit transaction, so a committed
 * assignment carries its dispatch obligation by construction (§4.1 rule 5).
 *
 * @param {object} deps as `plan()`, plus:
 * @param {(assignment: object, round: object) => Promise<object>} deps.commit Phase 3's
 *   commit, already bound to its own dependencies by the coordinator
 * @param {(result: object) => Promise<void>} [deps.record] the decision-record writer
 * @param {object} input as `plan()`
 * @returns {Promise<object>}
 */
async function execute(deps, input) {
  const planned = await plan(deps, input);

  const committed = [];
  const aborted = [];

  for (const assignment of planned.assignments) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await deps.commit(assignment, planned);
    if (outcome && outcome.committed) {
      committed.push({ ...assignment, commitmentId: outcome.commitment && outcome.commitment.commitmentId, outcome: outcome.outcome });
    } else {
      aborted.push({
        ...assignment,
        reason: (outcome && outcome.reason) || "COMMIT_RETURNED_NO_OUTCOME",
        detail: (outcome && outcome.detail) || null,
      });
      // §10.3.2 — "Any guard failure aborts the transaction and returns the pairing to
      // the next round with the cause recorded. No partial state is possible." The SOFT
      // reservation is released so the next round does not plan around a binding that
      // never became durable.
      if (deps.planState) deps.planState.release(assignment.legId);
    }
  }

  const decisions = planned.decisions.map((row) => {
    const abort = aborted.find((entry) => entry.legId === row.legId);
    if (!abort) return row;
    return { ...row, outcome: LEG_OUTCOME.COMMIT_ABORTED, commitAbortReason: abort.reason, detail: abort.detail };
  });

  const result = Object.freeze({
    ...planned,
    decisions: Object.freeze(decisions),
    committed: Object.freeze(committed),
    aborted: Object.freeze(aborted),
  });

  if (typeof deps.record === "function") await deps.record(result);

  return result;
}

/**
 * Prove that a round's per-Leg records account for every Leg in the batch — the
 * completion criterion "every round produces a decision record", checked at the
 * granularity the decision is actually taken.
 *
 * @param {object} input `{ legs, result }`
 * @returns {{ ok: boolean, missing: string[], unaccounted: string[] }}
 */
function assertEveryLegRecorded(input) {
  const source = input || {};
  const expected = new Set((source.legs || []).map((leg) => String(leg.legId)));
  const recorded = new Set((source.result && source.result.decisions ? source.result.decisions : []).map((row) => String(row.legId)));

  const missing = [...expected].filter((legId) => !recorded.has(legId)).sort();
  const unaccounted = [...recorded].filter((legId) => !expected.has(legId)).sort();
  const withoutOutcome = (source.result && source.result.decisions ? source.result.decisions : [])
    .filter((row) => !row.outcome)
    .map((row) => String(row.legId))
    .sort();

  return {
    ok: missing.length === 0 && unaccounted.length === 0 && withoutOutcome.length === 0,
    missing,
    unaccounted,
    withoutOutcome,
  };
}

module.exports = {
  LEG_OUTCOME,
  ROUND_OUTCOME,
  compareLegsForRound,
  createDisjointSets,
  partition,
  candidatesFor,
  plan,
  execute,
  assertEveryLegRecorded,
};

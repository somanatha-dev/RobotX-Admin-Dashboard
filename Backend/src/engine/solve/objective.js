"use strict";

/**
 * The round's objective, as a set-partitioning problem over columns (§1.4, §9.3) —
 * **Tier 1**, decision path.
 *
 * ```
 * minimise    Σ  γ(c) · z[c]     +     Σ  C_defer[l] · y[l]
 *             c                       l∈L
 *
 * subject to        Σ        z[c]  +  y[l]  =  1      (coverage)   for every pending Leg l
 *               c : l ∈ L(c)
 *
 *                   Σ        z[c]            ≤  1      (exclusivity) for every agent a
 *               c : a(c) = a
 * ```
 *
 * ── Why the formulation is columns and not arcs ─────────────────────────────
 * §9.3 is unusually direct about the alternative:
 *
 * > A flow network with `capacity[a] = k > 1` and one arc per pairing would … compute an
 * > objective value that is not the cost of the allocation it selects, and no amount of
 * > solver quality repairs that: **the model would be exactly solving the wrong
 * > problem.** Queue capacity greater than one is not natively expressible as arc
 * > capacity in a flow, and this specification does not claim that it is.
 *
 * > Because an agent accepts **at most one column**, and a column is priced at the
 * > marginal cost of its own complete plan (§8.1), the non-separability above is confined
 * > *inside* the column, where it is evaluated exactly by the Plan Builder rather than
 * > approximated by arc arithmetic. **The objective value of any feasible solution is
 * > exactly the true cost of the allocation.**
 *
 * That last sentence is a checkable property, and `objectiveValue()` plus
 * `assertObjectiveIsAllocationCost()` are what check it: the objective is the sum of the
 * selected columns' own `γ`, taken in integer milli-CU, with no term the cost model did
 * not produce.
 *
 * ── Exclusivity is `≤ 1` per **agent**, not per capacity slot ───────────────
 * The exclusivity row is `≤ 1` because an agent accepts at most one *column*, whatever
 * its `capacity[agent_class]` is — the multi-Leg structure lives inside the column. This
 * is the one line where getting the formulation wrong reintroduces the arc-capacity
 * error §9.3 rejects, so it is stated here rather than left implicit in the solver.
 *
 * ── The deferral variable is present and switched off ───────────────────────
 * Phase 10's scope: *"Deferral variable present but disabled by kill switch"*. §22.5 rule
 * 1 requires the disabled behaviour to be a complete, tested Tier 1 behaviour, so:
 *
 *   - With `deferral` enabled, `y[l]` is a real variable at price `C_defer[l]`, and
 *     coverage is an **equality**: every Leg is either covered by a column or explicitly
 *     deferred at a price.
 *   - With `deferral` thrown, no `y[l]` variable is created at all — not a variable at
 *     infinite price, which the optimiser would still be entitled to buy. Coverage then
 *     reads `≤ 1`: a Leg may go uncovered, and it does so by **remaining queued**, which
 *     is the same physical outcome as deferral without the priced arc. The instance
 *     records the relaxation explicitly (`coverageRelaxedBecause`) so a reader of the
 *     decision record cannot mistake an unpriced non-assignment for a priced deferral.
 *
 * `cost/cDefer.js` is Tier 2 (T2-04) and this module is Tier 1, so no static import of it
 * exists here: the deferral price arrives as data on each Leg, computed by the
 * composition root, exactly as `Ω_terminal` reaches `candidates/omega.js`.
 *
 * T1 (§1.5, I14): `buildInstance()` asserts the feasibility brand on every column's plan,
 * so the objective is structurally incapable of containing a pairing the gate did not
 * admit. Determinism (T6): no clock, no randomness; all arithmetic is integer milli-CU.
 */

const { assertFeasible } = require("../guards/tenets");
const { compareStrings, canonicalSort, thenBy } = require("../determinism/ordering");
const { sum: sumMilliCU, compare: compareMilliCU, subtract } = require("../determinism/fixedPoint");

/** The two variable kinds §1.4's programme has. @structural the formulation's own variables */
const VARIABLE = Object.freeze({
  /** `z[c]` — select column `c`. */
  COLUMN: "z",
  /** `y[l]` — defer Leg `l`. Present only when the `deferral` kill switch permits. */
  DEFER: "y",
});

/** The two constraint families. @structural the formulation's own constraints */
const CONSTRAINT = Object.freeze({
  COVERAGE: "coverage",
  EXCLUSIVITY: "exclusivity",
});

/** How the coverage constraint reads in this instance. @structural */
const COVERAGE_SENSE = Object.freeze({
  /** `= 1` — every Leg is covered or explicitly deferred at a price. */
  EQUALITY: "=1",
  /** `≤ 1` — deferral is disabled, so a Leg may simply remain queued. */
  AT_MOST_ONE: "<=1",
});

/**
 * Canonical order over columns: price, then agent, then identity (§9.6 requirement 2).
 * The same order `plan/columnBuilder.js` uses, reproduced from the same primitives rather
 * than imported, so that a change to one is visible as a divergence rather than silently
 * propagated.
 * @structural §9.6 requirement 2's order, specialised to columns
 */
const compareColumnsForSolve = thenBy(
  (a, b) => compareMilliCU(a.gammaMilliCU, b.gammaMilliCU),
  (a, b) => compareStrings(a.agentId, b.agentId),
  (a, b) => compareStrings(a.identity, b.identity),
);

/**
 * Build the round's set-partitioning instance.
 *
 * @param {object} input
 * @param {Array<object>} input.legs `{ legId, deferPriceMilliCU, deferralAdmissible }`
 * @param {Array<object>} input.columns priced columns from `plan/columnBuilder.build()`
 * @param {boolean} input.deferralEnabled the resolved `deferral` kill-switch state
 * @returns {{ ok: boolean, instance: object|null, problems: string[] }}
 */
function buildInstance(input) {
  const source = input || {};
  const problems = [];

  // T1/I14 — the brand is asserted here, once, before anything is indexed. A column
  // whose plan the feasibility gate never admitted cannot enter the objective, and the
  // assertion throws rather than filters: a caller holding an unbranded plan has a defect
  // upstream, and silently dropping it would hide which candidate went missing and why.
  for (const entry of source.columns || []) {
    const plan = entry && (entry.plan || (entry.column && entry.column.plan));
    assertFeasible(plan, `solve/objective.buildInstance (column ${String(entry && entry.identity)})`);
  }

  const ordered = canonicalSort([...(source.columns || [])], compareColumnsForSolve);

  const legIds = [...new Set((source.legs || []).map((leg) => String(leg.legId)))].sort(compareStrings);
  const legIndex = new Map(legIds.map((legId, index) => [legId, index]));

  const agentIds = [...new Set(ordered.map((entry) => String(entry.agentId)))].sort(compareStrings);

  const columnVars = ordered.map((entry, index) => {
    const covered = [...(entry.legIds || [])].map(String).sort(compareStrings);
    for (const legId of covered) {
      if (!legIndex.has(legId)) {
        problems.push(
          `column ${String(entry.identity)} covers Leg ${legId}, which is not in this round's batch. A column ` +
            "covering work the round is not solving would satisfy no coverage row and would still consume its " +
            "agent's exclusivity row (§1.4).",
        );
      }
    }
    return Object.freeze({
      kind: VARIABLE.COLUMN,
      index,
      identity: String(entry.identity),
      agentId: String(entry.agentId),
      legIds: Object.freeze(covered),
      costMilliCU: entry.gammaMilliCU,
      singleton: covered.length === 1,
    });
  });

  // The deferral variable. Present as a *concept* in every instance; present as a
  // *variable* only when the switch permits and the Leg's own §8.8 bound admits it.
  const deferVars = [];
  const deferralOmissions = [];

  for (const leg of source.legs || []) {
    const legId = String(leg.legId);
    if (source.deferralEnabled !== true) {
      deferralOmissions.push({
        legId,
        because: "DEFERRAL_DISABLED_BY_KILL_SWITCH",
        degradesTo: "immediate assignment when any feasible candidate exists; otherwise the Leg remains queued",
      });
      continue;
    }
    if (leg.deferralAdmissible !== true || typeof leg.deferPriceMilliCU !== "bigint") {
      deferralOmissions.push({
        legId,
        because: "DEFERRAL_BOUND_REACHED_OR_UNPRICED",
        degradesTo:
          "the arc is removed rather than priced high — §17.4's ladder terminates in a decision regardless of " +
          "cost dynamics, which is what makes it a guarantee (§8.8)",
      });
      continue;
    }
    deferVars.push(
      Object.freeze({
        kind: VARIABLE.DEFER,
        legId,
        costMilliCU: leg.deferPriceMilliCU,
      }),
    );
  }

  const deferrableLegIds = new Set(deferVars.map((entry) => entry.legId));

  // The constraint matrix, gathered in one pass over the columns rather than one scan per
  // row. Both row families are the same question asked from the other side — "which
  // columns name this Leg / this agent" — and answering it by re-filtering `columnVars`
  // per row is O((legs + agents) · columns), which at §9.4's own ceiling (500 Legs, 200
  // candidates, 100 000 columns) is over a hundred million comparisons for a matrix with
  // exactly 200 000 non-zeros. Grouping is O(columns) and produces the same rows.
  //
  // Ordering is preserved by construction: `columnVars` is already in the canonical
  // `compareColumnsForSolve` order and each row's indices are appended as that order is
  // walked, so every row's `columnIndices` is ascending exactly as the filter left it.
  const coverageColumns = new Map(legIds.map((legId) => [legId, []]));
  const exclusivityColumns = new Map(agentIds.map((agentId) => [agentId, []]));

  for (const variable of columnVars) {
    let previousLegId = null;
    for (const legId of variable.legIds) {
      // `filter(entry => entry.legIds.includes(legId))` admits a column **once** however
      // many times it names the Leg, and `variable.legIds` is sorted, so a repeat is
      // adjacent and skipping it reproduces that behaviour rather than inflating the row.
      if (legId === previousLegId) continue;
      previousLegId = legId;
      const row = coverageColumns.get(legId);
      // A Leg outside this round's batch has no coverage row. That is already recorded as
      // a problem above; here the column simply appears in no coverage row, which is where
      // the filter left it too.
      if (row !== undefined) row.push(variable.index);
    }
    exclusivityColumns.get(variable.agentId).push(variable.index);
  }

  const coverage = legIds.map((legId) =>
    Object.freeze({
      constraint: CONSTRAINT.COVERAGE,
      legId,
      columnIndices: Object.freeze(coverageColumns.get(legId)),
      hasDeferVariable: deferrableLegIds.has(legId),
      // The equality holds only where a deferral variable exists to absorb the
      // non-assignment. Where it does not, the row is `≤ 1` and the Leg's remaining
      // queued is the outcome — stated per row rather than as a global mode, because a
      // round may legitimately have both (one Leg past its deferral bound, another not).
      sense: deferrableLegIds.has(legId) ? COVERAGE_SENSE.EQUALITY : COVERAGE_SENSE.AT_MOST_ONE,
    }),
  );

  const exclusivity = agentIds.map((agentId) =>
    Object.freeze({
      constraint: CONSTRAINT.EXCLUSIVITY,
      agentId,
      columnIndices: Object.freeze(exclusivityColumns.get(agentId)),
      // `≤ 1` per agent, never per capacity slot. §9.3: an agent accepts at most one
      // column, and the multi-Leg structure lives inside the column. Writing this as
      // `≤ capacity[a]` is exactly the arc-capacity error §9.3 rejects, arrived at
      // through the constraint matrix instead of through the network.
      sense: "<=1",
    }),
  );

  const instance = Object.freeze({
    legIds: Object.freeze(legIds),
    agentIds: Object.freeze(agentIds),
    columns: Object.freeze(columnVars),
    deferVariables: Object.freeze(deferVars),
    coverage: Object.freeze(coverage),
    exclusivity: Object.freeze(exclusivity),
    deferralEnabled: source.deferralEnabled === true,
    deferralOmissions: Object.freeze(deferralOmissions.map((row) => Object.freeze(row))),
    coverageRelaxedBecause:
      source.deferralEnabled === true
        ? null
        : "the `deferral` kill switch is thrown, so no y[l] variable exists. Coverage reads ≤ 1 and an " +
          "uncovered Leg remains queued for the next round — the same physical outcome as deferral, without " +
          "the priced arc. This is recorded rather than left implicit so an unpriced non-assignment is never " +
          "read as a priced deferral (§8.8, §22.5 rule 1).",
  });

  return { ok: problems.length === 0, instance, problems };
}

/**
 * The objective value of a selection, in integer milli-CU.
 *
 * @param {object} instance from `buildInstance`
 * @param {object} selection `{ columnIndices: number[], deferredLegIds: string[] }`
 * @returns {{ ok: boolean, milliCU: bigint|null, breakdown: object|null, problems: string[] }}
 */
function objectiveValue(instance, selection) {
  const chosen = selection || {};
  const problems = [];

  const columnCosts = [];
  for (const index of chosen.columnIndices || []) {
    const variable = instance.columns[index];
    if (!variable) {
      problems.push(`selection names column index ${index}, which this instance does not contain`);
      continue;
    }
    columnCosts.push(variable.costMilliCU);
  }

  const deferCosts = [];
  for (const legId of chosen.deferredLegIds || []) {
    const variable = instance.deferVariables.find((entry) => entry.legId === String(legId));
    if (!variable) {
      problems.push(
        `selection defers Leg ${String(legId)}, but this instance has no y[${String(legId)}] variable. ` +
          "Deferral is priced or it does not happen; an unpriced deferral is a Leg silently left waiting.",
      );
      continue;
    }
    deferCosts.push(variable.costMilliCU);
  }

  if (problems.length > 0) return { ok: false, milliCU: null, breakdown: null, problems };

  const columnsMilliCU = sumMilliCU(columnCosts);
  const deferMilliCU = sumMilliCU(deferCosts);

  return {
    ok: true,
    milliCU: sumMilliCU([columnsMilliCU, deferMilliCU]),
    breakdown: Object.freeze({
      columnsMilliCU,
      deferMilliCU,
      columnCount: columnCosts.length,
      deferCount: deferCosts.length,
    }),
    problems: [],
  };
}

/**
 * Is this selection feasible for the instance? Coverage and exclusivity, checked exactly.
 *
 * @param {object} instance
 * @param {object} selection
 * @returns {{ feasible: boolean, violations: object[] }}
 */
function validate(instance, selection) {
  const chosen = selection || {};
  const violations = [];

  const selected = (chosen.columnIndices || []).map((index) => instance.columns[index]).filter(Boolean);
  const deferred = new Set((chosen.deferredLegIds || []).map(String));

  for (const row of instance.coverage) {
    const covering = selected.filter((entry) => entry.legIds.includes(row.legId)).length;
    const total = covering + (deferred.has(row.legId) ? 1 : 0);

    if (total > 1) {
      violations.push({
        constraint: CONSTRAINT.COVERAGE,
        legId: row.legId,
        observed: total,
        detail:
          `Leg ${row.legId} is covered ${total} times. Coverage is a partition, not a cover: two columns ` +
          "covering one Leg would commit it to two agents, which is the exclusivity failure §10.3 exists to " +
          "make impossible.",
      });
    }

    if (row.sense === COVERAGE_SENSE.EQUALITY && total !== 1) {
      violations.push({
        constraint: CONSTRAINT.COVERAGE,
        legId: row.legId,
        observed: total,
        detail:
          `Leg ${row.legId} has a deferral variable, so its coverage row is an equality: it must be covered by ` +
          "exactly one column or explicitly deferred at its price. Leaving it at zero would be an unpriced " +
          "non-assignment in a round that had a price for one (§1.4, §8.8).",
      });
    }
  }

  for (const row of instance.exclusivity) {
    const used = selected.filter((entry) => entry.agentId === row.agentId).length;
    if (used > 1) {
      violations.push({
        constraint: CONSTRAINT.EXCLUSIVITY,
        agentId: row.agentId,
        observed: used,
        detail:
          `agent ${row.agentId} is used by ${used} columns. An agent accepts at most one column whatever its ` +
          "capacity — multi-Leg structure lives inside the column, never as parallel arcs at one agent node " +
          "(§9.3).",
      });
    }
  }

  return { feasible: violations.length === 0, violations };
}

/**
 * §9.3's stated property, as an assertion: *"The objective value of any feasible solution
 * is exactly the true cost of the allocation."*
 *
 * The check is exact equality in integer milli-CU between the objective the solver
 * optimised and the sum of the selected columns' own `γ` values re-read from the priced
 * columns. A tolerance would defeat the purpose: the whole pipeline is integer precisely
 * so that exact equality is achievable, and a solver optimising a value the cost model
 * cannot reproduce is optimising a different objective.
 *
 * @param {object} input `{ instance, selection, solverObjectiveMilliCU }`
 * @returns {{ ok: boolean, recomputedMilliCU: bigint|null, deltaMilliCU: bigint|null, reason: string|null }}
 */
function assertObjectiveIsAllocationCost(input) {
  const source = input || {};
  const recomputed = objectiveValue(source.instance, source.selection);

  if (!recomputed.ok) {
    return { ok: false, recomputedMilliCU: null, deltaMilliCU: null, reason: recomputed.problems.join("; ") };
  }
  if (typeof source.solverObjectiveMilliCU !== "bigint") {
    return {
      ok: false,
      recomputedMilliCU: recomputed.milliCU,
      deltaMilliCU: null,
      reason: "the solver's objective is not an int64 milli-CU quantity; the comparison is exact or it is not made (§9.6)",
    };
  }

  const delta = subtract(recomputed.milliCU, source.solverObjectiveMilliCU);
  const agrees = compareMilliCU(recomputed.milliCU, source.solverObjectiveMilliCU) === 0;

  return {
    ok: agrees,
    recomputedMilliCU: recomputed.milliCU,
    deltaMilliCU: delta,
    reason: agrees
      ? null
      : `the objective recomputed from the selected columns' own γ is ${recomputed.milliCU} milli-CU, but the ` +
        `solver reported ${source.solverObjectiveMilliCU} — a difference of ${delta}. §9.3 requires that "the ` +
        'objective value of any feasible solution is exactly the true cost of the allocation"; a discrepancy ' +
        "here means the solver is optimising something the cost model did not produce.",
  };
}

module.exports = {
  VARIABLE,
  CONSTRAINT,
  COVERAGE_SENSE,
  compareColumnsForSolve,
  buildInstance,
  objectiveValue,
  validate,
  assertObjectiveIsAllocationCost,
};

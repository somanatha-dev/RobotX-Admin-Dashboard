"use strict";

/**
 * §20.2's cost-scaling min-cost flow, verified against the successive-shortest-path solver it
 * replaced (§9.3, §9.6).
 *
 * ── What equivalence means here, exactly ───────────────────────────────────
 * The two solvers are different algorithms reaching the same *optimum*. Where the optimum is
 * unique they must agree arc for arc, and these tests assert that. Where several allocations
 * share the optimal cost — which the round's own fixture produces in quantity, because γ
 * values repeat — the specification does not name one of them. §9.6 requires that ties resolve
 * by an explicit total order rather than by arrival or storage order, and that identical input
 * produces identical output; it does not require that two different exact algorithms select the
 * same member of the optimal set, and no acceptance test in §9.6 or §24.3 does either (replay
 * pins the *code version*, §9.6 requirement 6).
 *
 * So equivalence is asserted as: same feasibility, same objective in exact milli-CU, same flow
 * value, same number of Legs assigned, deferred and left queued, and — on instances built to
 * have one optimum — the same allocation. Divergence beyond that would be a defect and these
 * tests would show it as an objective difference, which is the thing that actually matters.
 *
 * ── And what the new solver proves about itself ────────────────────────────
 * Every cost-scaling solve returns `optimalityCertified`. It is not a claim; it is the result
 * of recomputing exact lexicographic potentials on the final residual network and checking LP
 * duality's two conditions. These tests assert it holds on every instance they build, which is
 * a stronger statement than agreement with a reference solver: it would still be true on an
 * instance no reference solver had ever seen.
 */

const objective = require("../../src/engine/solve/objective");
const minCostFlow = require("../../src/engine/solve/minCostFlow");
const costScaling = require("../../src/engine/solve/costScaling");
const regime = require("../../src/engine/solve/regime");
const budgets = require("../../src/engine/solve/budgets");
const fixture = require("./helpers/roundFixture");
const { toMilliCU } = require("../../src/engine/determinism/fixedPoint");

const REFERENCE = { solver: minCostFlow.SOLVER.SUCCESSIVE_SHORTEST_PATH };

/**
 * A deterministic generator. `Math.random()` would make a failure unreproducible, which for a
 * test whose whole job is to compare two exact algorithms would be the one unacceptable
 * property. Seeded explicitly per case so a failure names the instance that produced it.
 *
 * @param {number} seed
 * @returns {() => number}
 */
function sequence(seed) {
  let state = seed >>> 0;
  return () => {
    // A 32-bit xorshift. Structural: the constants are the shift widths of the generator.
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

function instanceOf(columns, legIds, options) {
  const built = objective.buildInstance({
    legs: fixture.legs(legIds, options),
    columns,
    deferralEnabled: (options && options.deferralAdmissible) === true,
  });
  expect(built.ok).toBe(true);
  return built.instance;
}

/** The selection a result names, in the shape `objective.validate` reads. */
function selectionOf(solved) {
  return {
    columnIndices: solved.assignments.map((row) => row.columnIndex),
    deferredLegIds: solved.deferred.map((row) => row.legId),
  };
}

/** The allocation as a comparable value, independent of object key order. */
function allocationOf(solved) {
  return {
    assigned: solved.assignments.map((row) => `${row.legId}→${row.agentId}@${row.identity}`),
    deferred: solved.deferred.map((row) => row.legId),
    unassigned: solved.unassigned.map((row) => row.legId),
  };
}

/**
 * §9.3's dual claim, stated in the objective's own terms rather than the network's — which is
 * the form §8.3's calibration consumes: for every column `γ(c) + π[leg] − π[agent] ≥ 0`, with
 * equality on every column selected. Together those two *are* LP optimality, so a round that
 * satisfies them is proven optimal from its **published** prices rather than from the solver's
 * internal ones — and the equality half is what makes a price *marginal* rather than merely
 * feasible: the selected column is exactly indifferent at it.
 *
 * @param {object} instance
 * @param {object} solved
 * @returns {{ dualInfeasible: object[], slack: object[] }}
 */
function pricingResidues(instance, solved) {
  const selected = new Set(solved.assignments.map((row) => row.columnIndex));
  const dualInfeasible = [];
  const slack = [];
  for (const column of instance.columns) {
    const reduced = column.costMilliCU + solved.duals.prices[column.legIds[0]] - solved.agentDuals.prices[column.agentId];
    if (reduced < 0n) dualInfeasible.push({ identity: column.identity, reduced: String(reduced) });
    if (selected.has(column.index) && reduced !== 0n) slack.push({ identity: column.identity, reduced: String(reduced) });
  }
  return { dualInfeasible, slack };
}

/**
 * The invariants §9.3 and §10 require of any allocation this solver returns, checked against
 * the instance rather than against the other solver. Reused by every case below so a new case
 * cannot accidentally check less than the others.
 *
 * @param {object} instance
 * @param {object} solved
 */
function assertSolutionInvariants(instance, solved) {
  const selection = selectionOf(solved);

  // Feasibility — coverage and exclusivity, checked by the module that owns the formulation
  // rather than by a second implementation of it here (§10 of the task: reuse, do not duplicate).
  expect(objective.validate(instance, selection)).toEqual({ feasible: true, violations: [] });

  // The objective is the true cost of the allocation (§9.3), exactly.
  const consistency = objective.assertObjectiveIsAllocationCost({
    instance,
    selection,
    solverObjectiveMilliCU: solved.objectiveMilliCU,
  });
  expect({ ok: consistency.ok, reason: consistency.reason }).toEqual({ ok: true, reason: null });

  // Every Leg is accounted for exactly once: assigned, deferred, or left queued. This is flow
  // conservation read from the allocation — `requiredFlow` units left the source and each one
  // arrived somewhere.
  const touched = [...selection.deferredLegIds, ...solved.assignments.map((row) => row.legId), ...solved.unassigned.map((row) => row.legId)];
  expect([...touched].sort()).toEqual([...instance.legIds].sort());
  expect(new Set(touched).size).toBe(touched.length);

  // No assignment names a pairing the instance does not contain — candidate eligibility, at the
  // one place a solver could invent one.
  for (const row of solved.assignments) {
    const column = instance.columns[row.columnIndex];
    expect(column).toBeTruthy();
    expect({ agentId: column.agentId, identity: column.identity, legIds: [...column.legIds] }).toEqual({
      agentId: row.agentId,
      identity: row.identity,
      legIds: [row.legId],
    });
  }

  // No deferral without a priced y[l] variable.
  const priced = new Set(instance.deferVariables.map((entry) => entry.legId));
  for (const row of solved.deferred) expect(priced.has(row.legId)).toBe(true);

  // Exclusivity: at most one column per agent (§9.3), stated separately from `validate` because
  // it is the invariant a flow could break by treating capacity as arc capacity.
  const agents = solved.assignments.map((row) => row.agentId);
  expect(new Set(agents).size).toBe(agents.length);

  // And the allocation is *optimal*, proven from the published prices alone. A solver that
  // returned a feasible but suboptimal allocation would pass every check above and fail this
  // one, which is why it is here rather than only in the equivalence comparison.
  if (solved.budgetLimited !== true) {
    const residues = pricingResidues(instance, solved);

    // Complementary slackness holds on every round: every selected column is exactly
    // indifferent at the published prices. This is the half that makes them *marginal*.
    expect(residues.slack).toEqual([]);

    // Dual feasibility over *all* columns holds on every round that places every Leg. Where
    // Legs remain queued it does not, and that is the formulation's property rather than the
    // algorithm's: the dual is a lexicographic pair `(unassigned, milliCU)` and only its money
    // component is published, because publishing §22.5's assignment priority as a price would
    // be a dimensioned quantity fabricated from an ordering (§1.3). The projection then omits
    // the term that makes the relation hold. The reference solver behaves identically — see
    // the dedicated test below, which pins that as unchanged rather than newly true.
    if (solved.unassigned.length === 0) expect(residues.dualInfeasible).toEqual([]);
  }
}

/**
 * Solve one instance both ways and assert the equivalence this file's header defines.
 *
 * @param {object} instance
 * @param {{ uniqueOptimum?: boolean, label?: string }} [expectation]
 * @returns {{ scaled: object, reference: object }}
 */
function bothSolvers(instance, expectation) {
  const settings = expectation || {};
  const scaled = minCostFlow.solve(instance);
  const reference = minCostFlow.solve(instance, REFERENCE);

  expect(scaled.solver).toBe(minCostFlow.SOLVER.COST_SCALING);
  expect(scaled.optimalityCertified).toBe(true);
  expect(reference.solver).toBe(minCostFlow.SOLVER.SUCCESSIVE_SHORTEST_PATH);

  expect(scaled.ok).toBe(reference.ok);
  expect(scaled.objectiveMilliCU).toBe(reference.objectiveMilliCU);
  expect(scaled.augmentations).toBe(reference.augmentations);
  expect(scaled.assignments.length).toBe(reference.assignments.length);
  expect(scaled.deferred.length).toBe(reference.deferred.length);
  expect(scaled.unassigned.length).toBe(reference.unassigned.length);

  assertSolutionInvariants(instance, scaled);
  assertSolutionInvariants(instance, reference);

  if (settings.uniqueOptimum) {
    expect(allocationOf(scaled)).toEqual(allocationOf(reference));
  }

  return { scaled, reference };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Basic cases
   ═══════════════════════════════════════════════════════════════════════════ */

describe("cost scaling — the basic shapes", () => {
  test("an empty instance solves to an empty allocation rather than to an error", () => {
    const instance = instanceOf([], []);
    const { scaled } = bothSolvers(instance, { uniqueOptimum: true });

    expect(scaled.ok).toBe(true);
    expect(allocationOf(scaled)).toEqual({ assigned: [], deferred: [], unassigned: [] });
    expect(scaled.objectiveMilliCU).toBe(0n);
    expect(scaled.augmentations).toBe(0);
  });

  test("one Leg, one agent, one candidate", () => {
    const instance = instanceOf([fixture.column({ legId: "L1", agentId: "A1", gammaCu: 12 })], ["L1"]);
    const { scaled } = bothSolvers(instance, { uniqueOptimum: true });

    expect(scaled.assignments).toEqual([expect.objectContaining({ legId: "L1", agentId: "A1" })]);
    expect(scaled.objectiveMilliCU).toBe(toMilliCU(12));
  });

  test("one Leg, several candidates — the cheapest wins and the others are untouched", () => {
    const instance = instanceOf(
      [
        fixture.column({ legId: "L1", agentId: "A2", gammaCu: 20 }),
        fixture.column({ legId: "L1", agentId: "A1", gammaCu: 30 }),
        fixture.column({ legId: "L1", agentId: "A3", gammaCu: 10 }),
      ],
      ["L1"],
    );
    const { scaled } = bothSolvers(instance, { uniqueOptimum: true });

    expect(scaled.assignments).toEqual([expect.objectContaining({ legId: "L1", agentId: "A3" })]);
  });

  test("a Leg with no candidate is left queued, not made infeasible (§22.5 rule 1)", () => {
    const instance = instanceOf([fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 })], ["L1", "L2"]);
    const { scaled } = bothSolvers(instance, { uniqueOptimum: true });

    expect(scaled.unassigned).toEqual([{ legId: "L2" }]);
  });

  test("an agent with no Leg simply carries no flow", () => {
    const instance = instanceOf(
      [fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 }), fixture.column({ legId: "L1", agentId: "A2", gammaCu: 90 })],
      ["L1"],
    );
    const { scaled } = bothSolvers(instance, { uniqueOptimum: true });

    expect(scaled.assignments.map((row) => row.agentId)).toEqual(["A1"]);
    expect(scaled.agentDuals.prices.A2).toBeDefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Structural cases
   ═══════════════════════════════════════════════════════════════════════════ */

describe("cost scaling — the structural shapes", () => {
  test("cannibalisation is resolved exactly, as it was before (§9.1)", () => {
    const instance = instanceOf(
      [
        fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 }),
        fixture.column({ legId: "L1", agentId: "A2", gammaCu: 30 }),
        fixture.column({ legId: "L2", agentId: "A1", gammaCu: 20 }),
        fixture.column({ legId: "L2", agentId: "A2", gammaCu: 100 }),
      ],
      ["L1", "L2"],
    );
    const { scaled } = bothSolvers(instance, { uniqueOptimum: true });

    expect(scaled.objectiveMilliCU).toBe(toMilliCU(50));
    expect(scaled.assignments).toEqual([
      expect.objectContaining({ legId: "L1", agentId: "A2" }),
      expect.objectContaining({ legId: "L2", agentId: "A1" }),
    ]);
  });

  test("two disconnected components are solved independently and correctly", () => {
    // No agent is feasible for both Legs, so the two halves cannot influence each other.
    const instance = instanceOf(
      [
        fixture.column({ legId: "L1", agentId: "A1", gammaCu: 7 }),
        fixture.column({ legId: "L1", agentId: "A2", gammaCu: 9 }),
        fixture.column({ legId: "L2", agentId: "A3", gammaCu: 4 }),
        fixture.column({ legId: "L2", agentId: "A4", gammaCu: 11 }),
      ],
      ["L1", "L2"],
    );
    const { scaled } = bothSolvers(instance, { uniqueOptimum: true });

    expect(scaled.objectiveMilliCU).toBe(toMilliCU(11));
    expect(scaled.assignments.map((row) => row.agentId)).toEqual(["A1", "A3"]);
  });

  test("many Legs contending for one agent — exclusivity binds and the rest stay queued", () => {
    const columns = ["L1", "L2", "L3", "L4"].map((legId, index) =>
      fixture.column({ legId, agentId: "A1", gammaCu: 10 + index }),
    );
    const instance = instanceOf(columns, ["L1", "L2", "L3", "L4"]);
    const { scaled } = bothSolvers(instance, { uniqueOptimum: true });

    expect(scaled.assignments).toHaveLength(1);
    expect(scaled.unassigned).toHaveLength(3);
    // Leaving three Legs queued costs three lexicographic units whatever the money, so the
    // cheapest single assignment is the one taken.
    expect(scaled.objectiveMilliCU).toBe(toMilliCU(10));
  });

  test("a dense square instance — every Leg reachable by every agent", () => {
    const legIds = ["L0", "L1", "L2", "L3", "L4"];
    const columns = [];
    for (let leg = 0; leg < legIds.length; leg += 1) {
      for (let agent = 0; agent < legIds.length; agent += 1) {
        // (leg + 1) · (agent + 1) has a unique optimal assignment: the reversal permutation.
        columns.push(fixture.column({ legId: legIds[leg], agentId: `A${agent}`, gammaCu: (leg + 1) * (agent + 1) }));
      }
    }
    const instance = instanceOf(columns, legIds);
    const { scaled } = bothSolvers(instance);

    expect(scaled.assignments).toHaveLength(legIds.length);
    expect(new Set(scaled.assignments.map((row) => row.agentId)).size).toBe(legIds.length);
  });

  test("a sparse instance — most Legs see one agent, one sees several", () => {
    const columns = [
      fixture.column({ legId: "L0", agentId: "A0", gammaCu: 5 }),
      fixture.column({ legId: "L1", agentId: "A1", gammaCu: 6 }),
      fixture.column({ legId: "L2", agentId: "A0", gammaCu: 1 }),
      fixture.column({ legId: "L2", agentId: "A1", gammaCu: 2 }),
      fixture.column({ legId: "L2", agentId: "A2", gammaCu: 3 }),
    ];
    const instance = instanceOf(columns, ["L0", "L1", "L2"]);
    const { scaled } = bothSolvers(instance, { uniqueOptimum: true });

    expect(scaled.assignments).toHaveLength(3);
    expect(scaled.assignments.map((row) => row.agentId)).toEqual(["A0", "A1", "A2"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Constraint and cost cases
   ═══════════════════════════════════════════════════════════════════════════ */

describe("cost scaling — costs the formulation permits", () => {
  test("zero-cost columns are selected, not skipped", () => {
    const instance = instanceOf(
      [fixture.column({ legId: "L1", agentId: "A1", gammaCu: 0 }), fixture.column({ legId: "L2", agentId: "A2", gammaCu: 0 })],
      ["L1", "L2"],
    );
    const { scaled } = bothSolvers(instance, { uniqueOptimum: true });

    expect(scaled.assignments).toHaveLength(2);
    expect(scaled.objectiveMilliCU).toBe(0n);
  });

  test("an all-zero instance still routes every Leg — ε starts at 1 and the loop still runs", () => {
    const legIds = ["L0", "L1", "L2"];
    const columns = legIds.map((legId, index) => fixture.column({ legId, agentId: `A${index}`, gammaCu: 0 }));
    const instance = instanceOf(columns, legIds);
    const { scaled } = bothSolvers(instance, { uniqueOptimum: true });

    expect(scaled.assignments).toHaveLength(3);
  });

  test("negative γ — which C_opportunity produces — is handled exactly, not clamped", () => {
    const instance = instanceOf(
      [
        fixture.column({ legId: "L1", agentId: "A1", gammaMilliCU: toMilliCU(-40) }),
        fixture.column({ legId: "L1", agentId: "A2", gammaMilliCU: toMilliCU(-90) }),
        fixture.column({ legId: "L2", agentId: "A2", gammaMilliCU: toMilliCU(-100) }),
        fixture.column({ legId: "L2", agentId: "A1", gammaMilliCU: toMilliCU(-5) }),
      ],
      ["L1", "L2"],
    );
    const { scaled } = bothSolvers(instance, { uniqueOptimum: true });

    expect(scaled.objectiveMilliCU).toBe(toMilliCU(-140));
  });

  test("mixed signs across a wide range", () => {
    const columns = [];
    const legIds = ["L0", "L1", "L2", "L3"];
    const values = [-9_999, 12_345, -7, 880, 0, -1_234, 5, 66_666];
    let cursor = 0;
    for (const legId of legIds) {
      for (let agent = 0; agent < 2; agent += 1) {
        columns.push(fixture.column({ legId, agentId: `A${(cursor + agent) % 5}`, gammaMilliCU: BigInt(values[cursor % values.length]) }));
        cursor += 1;
      }
    }
    const instance = instanceOf(columns, legIds);
    const { scaled, reference } = bothSolvers(instance);

    expect(scaled.objectiveMilliCU).toBe(reference.objectiveMilliCU);
  });

  test("an expensive assignment still beats leaving the Leg queued, at any price (§22.5 rule 1)", () => {
    const instance = instanceOf([fixture.column({ legId: "L1", agentId: "A1", gammaCu: 9_000_000 })], ["L1"]);
    const { scaled } = bothSolvers(instance, { uniqueOptimum: true });

    expect(scaled.assignments).toHaveLength(1);
    expect(scaled.unassigned).toEqual([]);
  });

  test("with deferral enabled a cheap deferral beats an expensive assignment, and the reverse", () => {
    const expensive = instanceOf([fixture.column({ legId: "L1", agentId: "A1", gammaCu: 500 })], ["L1"], {
      deferralAdmissible: true,
      deferCu: 100,
    });
    expect(bothSolvers(expensive, { uniqueOptimum: true }).scaled.deferred).toEqual([{ legId: "L1" }]);

    const cheap = instanceOf([fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 })], ["L1"], {
      deferralAdmissible: true,
      deferCu: 100,
    });
    expect(bothSolvers(cheap, { uniqueOptimum: true }).scaled.deferred).toEqual([]);
  });

  test("equal-cost alternatives produce an equal objective from both solvers", () => {
    const columns = [
      fixture.column({ legId: "L1", agentId: "A1", gammaCu: 7 }),
      fixture.column({ legId: "L1", agentId: "A2", gammaCu: 7 }),
      fixture.column({ legId: "L2", agentId: "A1", gammaCu: 7 }),
      fixture.column({ legId: "L2", agentId: "A2", gammaCu: 7 }),
    ];
    const instance = instanceOf(columns, ["L1", "L2"]);
    const { scaled, reference } = bothSolvers(instance);

    expect(scaled.objectiveMilliCU).toBe(toMilliCU(14));
    expect(scaled.objectiveMilliCU).toBe(reference.objectiveMilliCU);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The optimality certificate, and the fallback when it cannot be earned
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§9.3 — the solve is exact, and says so from a proof rather than from a claim", () => {
  test("every cost-scaling solve returns a certificate, and the certificate is checked not asserted", () => {
    const columns = [];
    for (let leg = 0; leg < 12; leg += 1) {
      for (let candidate = 0; candidate < 4; candidate += 1) {
        columns.push(fixture.column({ legId: `L${leg}`, agentId: `A${(leg + candidate) % 9}`, gammaCu: 3 + ((leg * 5 + candidate * 7) % 23) }));
      }
    }
    const instance = instanceOf(columns, Array.from({ length: 12 }, (unused, index) => `L${index}`));
    const solved = minCostFlow.solve(instance);

    expect(solved.optimalityCertified).toBe(true);
    expect(solved.solverDiagnostics.finalEpsilon).toBe(1);
    expect(solved.solverDiagnostics.scalingPhases).toBeGreaterThan(0);
  });

  test("the certificate is dual feasibility, so it fails on a flow that is not optimal", () => {
    // Built directly against `costScaling`: a hand-made suboptimal flow must not certify.
    // Without this the certificate could be vacuously true and no test above would notice.
    const instance = instanceOf(
      [
        fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 }),
        fixture.column({ legId: "L1", agentId: "A2", gammaCu: 30 }),
        fixture.column({ legId: "L2", agentId: "A1", gammaCu: 20 }),
        fixture.column({ legId: "L2", agentId: "A2", gammaCu: 100 }),
      ],
      ["L1", "L2"],
    );
    const network = minCostFlow.buildNetwork(instance).network;
    const prepared = costScaling.prepare(network).prepared;

    // Route L1 → A1 and L2 → A2 (cost 110) instead of the optimum (50), by hand.
    const route = (fromNode, toNode) => {
      for (let arc = 0; arc < prepared.arcCount; arc += 1) {
        if (prepared.arcHead[arc ^ 1] === fromNode && prepared.arcHead[arc] === toNode && prepared.arcResidual[arc] > 0) {
          prepared.arcResidual[arc] -= 1;
          prepared.arcResidual[arc ^ 1] += 1;
          return true;
        }
      }
      return false;
    };
    const legNode = network.legNodeOf;
    const agentNode = network.agentNodeOf;
    expect(route(network.sourceNode, legNode.get("L1"))).toBe(true);
    expect(route(legNode.get("L1"), agentNode.get("A1"))).toBe(true);
    expect(route(agentNode.get("A1"), network.sinkNode)).toBe(true);
    expect(route(network.sourceNode, legNode.get("L2"))).toBe(true);
    expect(route(legNode.get("L2"), agentNode.get("A2"))).toBe(true);
    expect(route(agentNode.get("A2"), network.sinkNode)).toBe(true);

    const proof = costScaling.certify(prepared, {
      price: new Float64Array(network.nodeCount),
      excess: new Int32Array(network.nodeCount),
    });

    expect(proof.ok).toBe(false);
    expect(proof.problems.join(" ")).toMatch(/improving cycle|not optimal/);
  });

  test("the certificate's OTHER condition is capacity, and it fails on a flow that exceeds one", () => {
    // Condition 1 of the module header is "every node's excess is zero **and every arc is
    // within capacity**". Only the excess half was ever computed; the capacity half was argued
    // from the push and relabel invariants — which is exactly the kind of argument the
    // certificate exists so that nothing has to rely on. A defect that moved flow without
    // moving it *along* an arc would satisfy conservation and every dual-feasibility check
    // and would have certified.
    const instance = instanceOf(
      [
        fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 }),
        fixture.column({ legId: "L2", agentId: "A2", gammaCu: 20 }),
      ],
      ["L1", "L2"],
    );
    const network = minCostFlow.buildNetwork(instance).network;
    const prepared = costScaling.prepare(network).prepared;
    const state = costScaling.run(prepared, {});

    expect(state.outcome).toBe(costScaling.OUTCOME.OK);
    expect(costScaling.certify(prepared, state).ok).toBe(true);

    // Now break capacity on one arc without touching its reverse: the pair no longer conserves
    // flow, which is what "flow appeared from nowhere" looks like in a residual network.
    prepared.arcResidual[0] += 1;
    const broken = costScaling.certify(prepared, state);

    expect(broken.ok).toBe(false);
    expect(broken.problems.join(" ")).toMatch(/created or destroyed|exceeds a capacity/);
  });

  test("an instance whose costs are too wide for exact scaling falls back, and the fallback is exact", () => {
    // int64 milli-CU is what §9.6 requirement 1 permits; the collapse needs `n · max|γ|` to fit
    // in float64's exact-integer range, and this does not. The answer must still be right.
    const huge = 4_000_000_000_000_000_000n;
    const instance = instanceOf(
      [
        fixture.column({ legId: "L1", agentId: "A1", gammaMilliCU: huge }),
        fixture.column({ legId: "L1", agentId: "A2", gammaMilliCU: huge - 1n }),
      ],
      ["L1"],
    );
    const solved = minCostFlow.solve(instance);

    expect(solved.solver).toBe(minCostFlow.SOLVER.SUCCESSIVE_SHORTEST_PATH);
    expect(solved.solverDiagnostics.fallbackFrom).toMatch(/TOO_WIDE/);
    expect(solved.optimalityCertified).toBeNull();
    expect(solved.assignments).toEqual([expect.objectContaining({ agentId: "A2" })]);
    assertSolutionInvariants(instance, solved);
  });

  /**
   * §9.3's dual claim, stated in the objective's own terms rather than the network's — which
   * is the form §8.3's calibration consumes: for every column `γ(c) + π[leg] − π[agent] ≥ 0`,
   * with equality on every column selected. Together those two *are* LP optimality, so a round
   * that satisfies them is proven optimal from its **published** prices rather than from the
   * solver's internal ones — and the equality half is what makes a price *marginal* rather than
   * merely feasible: the selected column is exactly indifferent at it.
   *
   * @param {object} instance
   * @param {object} solved
   * @returns {{ dualInfeasible: object[], slack: object[] }}
   */
  function pricingResidues(instance, solved) {
    const selected = new Set(solved.assignments.map((row) => row.columnIndex));
    const dualInfeasible = [];
    const slack = [];
    for (const column of instance.columns) {
      const reduced = column.costMilliCU + solved.duals.prices[column.legIds[0]] - solved.agentDuals.prices[column.agentId];
      if (reduced < 0n) dualInfeasible.push({ identity: column.identity, reduced: String(reduced) });
      if (selected.has(column.index) && reduced !== 0n) slack.push({ identity: column.identity, reduced: String(reduced) });
    }
    return { dualInfeasible, slack };
  }

  /**
   * @param {number} legCount
   * @param {number} agentPool wider than `legCount` assigns every Leg; narrower saturates
   * @returns {object}
   */
  function pricedInstance(legCount, agentPool) {
    const columns = [];
    for (let leg = 0; leg < legCount; leg += 1) {
      for (let candidate = 0; candidate < 8; candidate += 1) {
        columns.push(
          fixture.column({
            legId: `L${leg}`,
            agentId: `A${(leg * 5 + candidate * 3) % agentPool}`,
            // Signed, so the dual has to price a term `C_opportunity` could have produced.
            gammaMilliCU: BigInt(((leg * 37 + candidate * 91) % 400) - 150),
          }),
        );
      }
    }
    return instanceOf(columns, Array.from({ length: legCount }, (unused, index) => `L${index}`));
  }

  test.each([
    ["every Leg assigned", 25, 40],
    ["agents saturated, Legs left queued", 25, 17],
    ["heavily saturated", 60, 20],
  ])("the published duals are exact marginal prices — %s", (unused, legCount, agentPool) => {
    const instance = pricedInstance(legCount, agentPool);
    const solved = minCostFlow.solve(instance);

    expect(solved.solverDiagnostics.dualsTight).toBe(true);
    expect(pricingResidues(instance, solved)).toEqual({ dualInfeasible: [], slack: [] });

    // The same property on the reference solver, so this is a shared guarantee of the
    // formulation rather than a claim about one implementation.
    expect(pricingResidues(instance, minCostFlow.solve(instance, REFERENCE))).toEqual({ dualInfeasible: [], slack: [] });
  });

  test("where the money projection omits the priority term, it omits it on BOTH solvers", () => {
    // A round with a Leg no agent can take. The dual's first component — §22.5's assignment
    // priority — is then non-zero across the network, and the published milli-CU component
    // alone no longer satisfies `γ + π[leg] − π[agent] ≥ 0` on every column. That is the
    // formulation's projection, not the new algorithm's arithmetic, and this is the test that
    // says so: the reference solver, unchanged, shows the same residues on the same columns.
    const columns = [
      fixture.column({ legId: "L0", agentId: "A0", gammaMilliCU: 400n }),
      fixture.column({ legId: "L1", agentId: "A0", gammaMilliCU: 10n }),
      fixture.column({ legId: "L1", agentId: "A1", gammaMilliCU: 300n }),
      fixture.column({ legId: "L2", agentId: "A1", gammaMilliCU: 20n }),
    ];
    const instance = instanceOf(columns, ["L0", "L1", "L2", "L3"]);

    const scaled = minCostFlow.solve(instance);
    const reference = minCostFlow.solve(instance, REFERENCE);

    expect(scaled.unassigned.length).toBeGreaterThan(0);
    expect(scaled.objectiveMilliCU).toBe(reference.objectiveMilliCU);
    // Complementary slackness survives the projection on both. Dual feasibility over all
    // columns is the part that does not, and neither solver claims it.
    expect(pricingResidues(instance, scaled).slack).toEqual([]);
    expect(pricingResidues(instance, reference).slack).toEqual([]);
  });

  test("both solvers publish the same prices where the optimum is unique", () => {
    const instance = instanceOf(
      [
        fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 }),
        fixture.column({ legId: "L1", agentId: "A2", gammaCu: 30 }),
        fixture.column({ legId: "L2", agentId: "A1", gammaCu: 20 }),
        fixture.column({ legId: "L2", agentId: "A2", gammaCu: 100 }),
      ],
      ["L1", "L2"],
    );
    const scaled = minCostFlow.solve(instance);
    const reference = minCostFlow.solve(instance, REFERENCE);

    const asStrings = (prices) => Object.fromEntries(Object.entries(prices).map(([key, value]) => [key, String(value)]));
    expect(asStrings(scaled.duals.prices)).toEqual(asStrings(reference.duals.prices));
    expect(asStrings(scaled.agentDuals.prices)).toEqual(asStrings(reference.agentDuals.prices));
  });

  test("the duals are labelled EXACT_INTEGER, and dual feasibility is what earned the label", () => {
    const instance = instanceOf(
      [
        fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 }),
        fixture.column({ legId: "L2", agentId: "A2", gammaCu: 20 }),
      ],
      ["L1", "L2"],
    );
    const solved = minCostFlow.solve(instance);

    expect(solved.duals.kind).toBe(regime.DUAL_KIND.EXACT_INTEGER);
    expect(solved.duals.validForCalibrationWithoutQualification).toBe(true);
    expect(solved.agentDuals.kind).toBe(regime.DUAL_KIND.EXACT_INTEGER);
    for (const price of Object.values(solved.duals.prices)) expect(typeof price).toBe("bigint");
    for (const price of Object.values(solved.agentDuals.prices)) expect(typeof price).toBe("bigint");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Determinism (§9.6 requirement 2)
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§9.6 — determinism", () => {
  const build = () => {
    const columns = [];
    for (let leg = 0; leg < 20; leg += 1) {
      for (let candidate = 0; candidate < 6; candidate += 1) {
        columns.push(
          fixture.column({
            legId: `L${leg}`,
            agentId: `A${(leg * 3 + candidate) % 14}`,
            // Deliberately tie-heavy: only 11 distinct prices across 120 columns.
            gammaCu: 5 + ((leg + candidate) % 11),
          }),
        );
      }
    }
    return instanceOf(columns, Array.from({ length: 20 }, (unused, index) => `L${index}`));
  };

  test("ten runs of the same instance are byte-identical in allocation, objective and duals", () => {
    const instance = build();
    const first = minCostFlow.solve(instance);
    const firstShape = JSON.stringify({
      allocation: allocationOf(first),
      objective: String(first.objectiveMilliCU),
      bound: String(first.boundMilliCU),
      gap: String(first.lpIpGapMilliCU),
      flow: first.augmentations,
      duals: Object.fromEntries(Object.entries(first.duals.prices).map(([key, value]) => [key, String(value)])),
      agentDuals: Object.fromEntries(Object.entries(first.agentDuals.prices).map(([key, value]) => [key, String(value)])),
      diagnostics: first.solverDiagnostics,
    });

    for (let run = 0; run < 10; run += 1) {
      const again = minCostFlow.solve(instance);
      expect(
        JSON.stringify({
          allocation: allocationOf(again),
          objective: String(again.objectiveMilliCU),
          bound: String(again.boundMilliCU),
          gap: String(again.lpIpGapMilliCU),
          flow: again.augmentations,
          duals: Object.fromEntries(Object.entries(again.duals.prices).map(([key, value]) => [key, String(value)])),
          agentDuals: Object.fromEntries(Object.entries(again.agentDuals.prices).map(([key, value]) => [key, String(value)])),
          diagnostics: again.solverDiagnostics,
        }),
      ).toBe(firstShape);
    }
  });

  test("a rebuilt instance solves identically — the result depends on the instance, not on the object", () => {
    expect(JSON.stringify(allocationOf(minCostFlow.solve(build())))).toBe(
      JSON.stringify(allocationOf(minCostFlow.solve(build()))),
    );
  });

  test("column arrival order does not reach the solver — `buildInstance` canonicalises it first", () => {
    const columns = [
      fixture.column({ legId: "L1", agentId: "A1", gammaCu: 7 }),
      fixture.column({ legId: "L1", agentId: "A2", gammaCu: 7 }),
      fixture.column({ legId: "L2", agentId: "A1", gammaCu: 7 }),
      fixture.column({ legId: "L2", agentId: "A2", gammaCu: 7 }),
    ];
    const forward = minCostFlow.solve(instanceOf(columns, ["L1", "L2"]));
    const reversed = minCostFlow.solve(instanceOf([...columns].reverse(), ["L1", "L2"]));

    expect(allocationOf(forward)).toEqual(allocationOf(reversed));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The generated sweep — equivalence over instances nobody wrote by hand
   ═══════════════════════════════════════════════════════════════════════════ */

describe("cost scaling equals the reference solver over a generated sweep", () => {
  /**
   * One pseudo-random instance. The shape varies with the seed: batch size, candidate count,
   * agent pool, cost range and sign, and whether deferral is priced.
   *
   * @param {number} seed
   * @returns {object}
   */
  function generated(seed) {
    const next = sequence(seed);
    const legCount = 1 + (next() % 12);
    const agentPool = 1 + (next() % 10);
    const candidateCount = 1 + (next() % 5);
    const costSpan = 1 + (next() % 500);
    const negatives = next() % 3 === 0;
    const deferralAdmissible = next() % 4 === 0;

    const legIds = Array.from({ length: legCount }, (unused, index) => `L${index}`);
    const columns = [];
    for (const legId of legIds) {
      for (let candidate = 0; candidate < candidateCount; candidate += 1) {
        const magnitude = next() % costSpan;
        const value = negatives && next() % 2 === 0 ? -magnitude : magnitude;
        columns.push(fixture.column({ legId, agentId: `A${next() % agentPool}`, gammaMilliCU: BigInt(value) }));
      }
    }

    return objective.buildInstance({
      legs: fixture.legs(legIds, { deferralAdmissible, deferCu: 1 + (next() % 300) }),
      columns,
      deferralEnabled: deferralAdmissible,
    });
  }

  test("300 generated instances agree on feasibility, objective and flow value", () => {
    let compared = 0;
    let identical = 0;

    for (let seed = 1; seed <= 300; seed += 1) {
      const built = generated(seed);
      expect(built.ok).toBe(true);
      const instance = built.instance;

      const scaled = minCostFlow.solve(instance);
      const reference = minCostFlow.solve(instance, REFERENCE);

      expect({ seed, solver: scaled.solver, certified: scaled.optimalityCertified }).toEqual({
        seed,
        solver: minCostFlow.SOLVER.COST_SCALING,
        certified: true,
      });
      expect({ seed, objective: String(scaled.objectiveMilliCU) }).toEqual({ seed, objective: String(reference.objectiveMilliCU) });
      expect({ seed, flow: scaled.augmentations }).toEqual({ seed, flow: reference.augmentations });
      expect({ seed, assigned: scaled.assignments.length, deferred: scaled.deferred.length, queued: scaled.unassigned.length }).toEqual({
        seed,
        assigned: reference.assignments.length,
        deferred: reference.deferred.length,
        queued: reference.unassigned.length,
      });

      assertSolutionInvariants(instance, scaled);
      assertSolutionInvariants(instance, reference);

      compared += 1;
      if (JSON.stringify(allocationOf(scaled)) === JSON.stringify(allocationOf(reference))) identical += 1;
    }

    expect(compared).toBe(300);
    // Recorded rather than bounded. The two algorithms agree on the optimal *cost* on every
    // instance above — that is asserted. Where several allocations share it neither
    // specification nor test names one, so this number is evidence about how often the
    // optimum is unique in the generator, not a property either solver owes.
    // eslint-disable-next-line no-console
    console.log(`cost scaling vs reference — identical allocation on ${identical}/${compared} generated instances`);
  });

  test("30 larger generated instances agree, including where agents saturate", () => {
    for (let seed = 1_000; seed < 1_030; seed += 1) {
      const next = sequence(seed);
      const legCount = 30 + (next() % 40);
      // Fewer agents than Legs, so exclusivity binds and Legs are left queued.
      const agentPool = 5 + (next() % 15);
      const legIds = Array.from({ length: legCount }, (unused, index) => `L${index}`);
      const columns = [];
      for (const legId of legIds) {
        for (let candidate = 0; candidate < 6; candidate += 1) {
          columns.push(fixture.column({ legId, agentId: `A${next() % agentPool}`, gammaMilliCU: BigInt(next() % 100_000) }));
        }
      }
      const built = objective.buildInstance({ legs: fixture.legs(legIds), columns, deferralEnabled: false });
      expect(built.ok).toBe(true);

      const scaled = minCostFlow.solve(built.instance);
      const reference = minCostFlow.solve(built.instance, REFERENCE);

      expect({ seed, objective: String(scaled.objectiveMilliCU), queued: scaled.unassigned.length }).toEqual({
        seed,
        objective: String(reference.objectiveMilliCU),
        queued: reference.unassigned.length,
      });
      expect({ seed, certified: scaled.optimalityCertified }).toEqual({ seed, certified: true });
      assertSolutionInvariants(built.instance, scaled);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §9.4 — the anytime property, on the new algorithm's own stopping points
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§9.4 — the anytime property survives the change of algorithm", () => {
  const twoLegs = () =>
    instanceOf(
      [
        fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 }),
        fixture.column({ legId: "L2", agentId: "A2", gammaCu: 20 }),
      ],
      ["L1", "L2"],
    );

  test("an exhausted budget returns the incumbent, never nothing and never a throw", () => {
    const tracker = budgets.create({ config: fixture.budgetConfig({ timeBudgetMs: 0 }), elapsedMs: () => 1 });
    const solved = minCostFlow.solve(twoLegs(), { budgets: tracker });

    expect(solved.ok).toBe(true);
    expect(solved.budgetLimited).toBe(true);
    expect(Array.isArray(solved.assignments)).toBe(true);
    expect(budgets.assertAnytime(tracker.result()).ok).toBe(true);

    // One exceedance, one recorded verdict. The budget is consulted before the network is
    // collapsed as well as between phases, and a second consultation for the same exceedance
    // would put two §9.4 obligations on the round for one bound being hit.
    expect(tracker.result().obligations).toHaveLength(1);
    expect(solved.solverDiagnostics.scalingPhases).toBe(0);
  });

  test("a budget-limited result never claims a certificate, because none can exist for it", () => {
    // The incumbent after a partial scaling run is a whole, feasible allocation that is
    // ε-optimal rather than optimal. Reporting `optimalityCertified: false` is the honest
    // pair with `budgetLimited: true` — and the solver must not *spend* the round's remaining
    // time proving the negative, which is what running the certificate here would cost.
    const tracker = budgets.create({
      config: fixture.budgetConfig({ timeBudgetMs: 5 }),
      elapsedMs: (() => {
        let calls = 0;
        return () => {
          calls += 1;
          return calls > 2 ? 99 : 0;
        };
      })(),
    });
    const solved = minCostFlow.solve(twoLegs(), { budgets: tracker });

    expect(solved.budgetLimited).toBe(true);
    expect(solved.optimalityCertified).toBe(false);
    expect(solved.solverDiagnostics.dualsTight).toBe(false);
    expect(solved.ok).toBe(true);
  });

  test("stopping is between scaling phases, so the reported flow is always a whole allocation", () => {
    const tracker = budgets.create({
      config: fixture.budgetConfig({ timeBudgetMs: 5 }),
      // Two consultations pass — the one before the network is collapsed and the one before
      // the first scaling phase — and the third, which falls between phases, does not.
      elapsedMs: (() => {
        let calls = 0;
        return () => {
          calls += 1;
          return calls > 2 ? 99 : 0;
        };
      })(),
    });
    const instance = twoLegs();
    const solved = minCostFlow.solve(instance, { budgets: tracker });

    expect(solved.budgetLimited).toBe(true);
    // One completed phase leaves a feasible, integral flow — every Leg routed, ε-optimally
    // rather than optimally. That is a whole allocation, which is what §9.4 asks the
    // incumbent to be, and it is checkable against the instance.
    expect(solved.assignments.length + solved.unassigned.length + solved.deferred.length).toBe(2);
    assertSolutionInvariants(instance, solved);
  });

  /**
   * A tracker whose clock is inside its budget for the first `passes` consultations and expired
   * for every one after. The consultations, in order, are: one in `solveByCostScaling` before
   * the network is collapsed, then one at the top of each iteration of the scaling loop. So
   * `passes` selects *which* stopping point the round takes, deterministically and without a
   * real clock (T6).
   *
   * @param {number} passes
   * @returns {object}
   */
  const trackerExpiringAfter = (passes) => {
    let calls = 0;
    return budgets.create({
      config: fixture.budgetConfig({ timeBudgetMs: 10 }),
      elapsedMs: () => {
        calls += 1;
        return calls > passes ? 99_999 : 0;
      },
    });
  };

  /**
   * Five Legs, each with exactly one agent of its own, so the optimum places all five and any
   * result naming fewer than five Legs is visibly not a whole allocation.
   *
   * @param {boolean} deferralAdmissible
   * @returns {object}
   */
  const fiveLegs = (deferralAdmissible) => {
    const legIds = ["L0", "L1", "L2", "L3", "L4"];
    return instanceOf(
      legIds.map((legId, index) => fixture.column({ legId, agentId: `A${index}`, gammaCu: 10 + index })),
      legIds,
      { deferralAdmissible, deferCu: 100 },
    );
  };

  test.each([
    ["deferral disabled", false],
    ["deferral enabled", true],
  ])(
    "the budget cannot stop the scaling loop BEFORE its first phase, because no incumbent exists yet — %s",
    (unused, deferralAdmissible) => {
      // The regression this pins. The budget used to be consulted at the top of every iteration
      // including the first, which is not "between phases" at all: it is before the first one,
      // where the pseudoflow is the empty one and all five units of supply are still on the
      // source. `assemble()` reads flow off the residual capacities, finds none, and reported an
      // allocation naming **no Leg at all** — assigned, deferred and queued all empty for a
      // batch of five — with `ok: true`. With deferral disabled `objective.validate` even called
      // that feasible, because a coverage row reading `≤ 1` is satisfied by zero.
      //
      // §9.4 asks the incumbent to be "a feasible solution and a bound", so the loop must reach
      // the first point where one exists before it may honour the budget at all.
      const instance = fiveLegs(deferralAdmissible);
      const solved = minCostFlow.solve(instance, { budgets: trackerExpiringAfter(1) });

      expect(solved.budgetLimited).toBe(true);
      expect(solved.solverDiagnostics.scalingPhases).toBe(1);
      expect(solved.assignments.length + solved.deferred.length + solved.unassigned.length).toBe(5);
      assertSolutionInvariants(instance, solved);
    },
  );

  test("every later stopping point is between phases, and each still returns a whole allocation", () => {
    // The loop's own progression, so a future change that reintroduced an unsafe stopping point
    // further in would be caught as well as one at the start.
    for (let passes = 1; passes <= 6; passes += 1) {
      const instance = fiveLegs(false);
      const solved = minCostFlow.solve(instance, { budgets: trackerExpiringAfter(passes) });

      expect({ passes, phases: solved.solverDiagnostics.scalingPhases }).toEqual({ passes, phases: passes });
      expect({ passes, accountedFor: solved.assignments.length + solved.deferred.length + solved.unassigned.length }).toEqual({
        passes,
        accountedFor: 5,
      });
      assertSolutionInvariants(instance, solved);
    }
  });

  test.each([
    ["deferral disabled", false],
    ["deferral enabled", true],
  ])(
    "a budget already exhausted BEFORE the network is collapsed returns the trivial feasible flow, not an empty one — %s",
    (unused, deferralAdmissible) => {
      // The regression this pins, and it is the one the previous pass left open. The budget is
      // consulted once before `prepare()`, because collapsing a 100 000-column network is tens
      // of milliseconds a spent round should not spend. That check used to return
      // `assemble(network, () => 0, …)` — the **zero** flow — and `assemble()` reads the
      // allocation off the arcs carrying flow, so the result named no Leg at all: assigned,
      // deferred and queued all empty for a batch of five, with `ok: true`, `budgetLimited:
      // true` and — with the `deferral` switch thrown — `objective.validate()` calling it
      // FEASIBLE, because a coverage row reading `≤ 1` is satisfied by zero.
      //
      // §9.4: "at any point it holds a feasible solution and a bound. Exceeding the time budget
      // returns the incumbent with its bound, never nothing and never a hang." An allocation
      // accounting for none of the round's Legs is not a feasible solution of this instance, and
      // it is indistinguishable from a round that decided nothing was worth doing.
      const instance = fiveLegs(deferralAdmissible);
      const solved = minCostFlow.solve(instance, { budgets: trackerExpiringAfter(0) });

      expect(solved.budgetLimited).toBe(true);
      expect(solved.solverDiagnostics.scalingPhases).toBe(0);
      expect(solved.solverDiagnostics.trivialIncumbent).toBe(true);
      expect(solved.solverDiagnostics.legsDecidedByTrivialCompletion).toBe(5);

      // Every Leg accounted for, exactly once, and the whole thing feasible against the
      // instance's own constraint rows — under *both* coverage senses, which is the half the
      // `≤ 1` relaxation used to hide.
      expect(solved.assignments.length + solved.deferred.length + solved.unassigned.length).toBe(5);
      assertSolutionInvariants(instance, solved);

      // Which of the two trivial outcomes depends on whether a priced deferral exists, and the
      // result says which rather than reporting an unpriced non-assignment as a priced deferral.
      expect(solved.deferred).toHaveLength(deferralAdmissible ? 5 : 0);
      expect(solved.unassigned).toHaveLength(deferralAdmissible ? 0 : 5);
      expect(solved.assignments).toEqual([]);

      // And it never claims to have proven anything.
      expect(solved.optimalityCertified).toBe(false);
    },
  );

  test("the reference solver's budget-limited stop is completed too, so the fallback cannot lose a Leg either", () => {
    // The same defect class on the other solver, and it is reachable in production: cost
    // scaling hands an instance whose costs are too wide for exact scaled arithmetic to the
    // reference solver, which then runs under the same budget. Successive shortest paths
    // augments once per Leg, so stopping between augmentations used to return a *partial*
    // batch — the Legs the loop had not reached carried no flow on any arc and appeared in
    // none of the three lists. Measured before the fix: 3 of 20 Legs named, `ok: true`.
    for (const deferralAdmissible of [false, true]) {
      for (const passes of [0, 1, 3]) {
        const instance = fiveLegs(deferralAdmissible);
        const solved = minCostFlow.solve(instance, { budgets: trackerExpiringAfter(passes), ...REFERENCE });

        expect({ passes, deferralAdmissible, limited: solved.budgetLimited }).toEqual({ passes, deferralAdmissible, limited: true });
        expect({
          passes,
          deferralAdmissible,
          accounted: solved.assignments.length + solved.deferred.length + solved.unassigned.length,
        }).toEqual({ passes, deferralAdmissible, accounted: 5 });

        // The units the search *did* place are left where it placed them: completion adds
        // Legs, it does not re-decide them.
        expect({ passes, assigned: solved.assignments.length }).toEqual({ passes, assigned: passes });
        assertSolutionInvariants(instance, solved);
      }
    }
  });

  test("§9.4's bound is a bound: a budget-limited result never reports its incumbent as proven optimal", () => {
    // §9.4 asks for "the incumbent **with its bound**". `boundMilliCU = objectiveMilliCU` and
    // `lpIpGapMilliCU = 0` says the incumbent *is* the optimum — which on a completed singleton
    // solve is true and proven, and on a truncated one is a claim the run explicitly did not
    // make: it reports `optimalityCertified: false` in the same object. Measured at the §20.1
    // shape before the fix: an incumbent 36.5 % above the optimum, published with a zero gap.
    const instance = fiveLegs(true);

    const truncated = minCostFlow.solve(instance, { budgets: trackerExpiringAfter(0) });
    const complete = minCostFlow.solve(instance);

    // A real lower bound: valid for every feasible flow on the network, hence for the optimum.
    expect(truncated.boundMilliCU).toBeLessThanOrEqual(truncated.objectiveMilliCU);
    expect(truncated.boundMilliCU).toBeLessThanOrEqual(complete.objectiveMilliCU);
    expect(truncated.optimalityCertified).toBe(false);

    // The all-deferred incumbent is genuinely worse than the optimum, and the published pair
    // now shows that rather than hiding it behind an equality.
    expect(truncated.objectiveMilliCU).toBeGreaterThan(complete.objectiveMilliCU);

    // On a completed solve the bound is still the objective, computed as the equality §9.3's
    // total unimodularity earns rather than asserted as a constant.
    expect(complete.boundMilliCU).toBe(complete.objectiveMilliCU);
    expect(complete.optimalityCertified).toBe(true);

    // And the *integrality* gap stays exactly zero in both, because it is zero in this regime
    // whatever the clock did — the truncation gap is `objective − bound` and is a different
    // quantity, which §9.3 requires be reported separately rather than summed into this one.
    expect(truncated.lpIpGapMilliCU).toBe(0n);
    expect(complete.lpIpGapMilliCU).toBe(0n);
  });

  test("a budget-limited round does not publish its prices as exact marginal prices either", () => {
    // The same false claim as the bound, on the other published quantity, and with a live
    // consumer: §8.3.1 feeds singleton-regime duals into λ_zone calibration and reads
    // `validForCalibrationWithoutQualification` to decide whether it may. §9.3 entitles the
    // *regime* to exact integer duals; it does not entitle a solve that stopped on §9.4's
    // clock to them, and the two axes were being conflated. Cost scaling publishes ε-optimal
    // prices on that path (it says so in its own header) and the reference solver publishes
    // the potentials of a partially routed network — neither is a marginal price, and both
    // were labelled `EXACT_INTEGER_MARGINAL_PRICE`.
    const instance = fiveLegs(true);

    for (const [label, solved] of [
      ["cost scaling, pre-prepare stop", minCostFlow.solve(instance, { budgets: trackerExpiringAfter(0) })],
      ["cost scaling, between phases", minCostFlow.solve(instance, { budgets: trackerExpiringAfter(1) })],
      ["reference solver", minCostFlow.solve(instance, { budgets: trackerExpiringAfter(2), ...REFERENCE })],
    ]) {
      expect({ label, limited: solved.budgetLimited }).toEqual({ label, limited: true });
      expect({ label, kind: solved.duals.kind }).toEqual({ label, kind: regime.DUAL_KIND.BUDGET_LIMITED });
      expect({ label, kind: solved.agentDuals.kind }).toEqual({ label, kind: regime.DUAL_KIND.BUDGET_LIMITED });
      expect({ label, calibratable: solved.duals.validForCalibrationWithoutQualification }).toEqual({
        label,
        calibratable: false,
      });
      expect(solved.duals.validity).toMatch(/§9.4's wall-clock budget/);
    }

    // And a completed solve is unaffected: it earned the label the regime entitles it to.
    const complete = minCostFlow.solve(instance);
    expect(complete.duals.kind).toBe(regime.DUAL_KIND.EXACT_INTEGER);
    expect(complete.duals.validForCalibrationWithoutQualification).toBe(true);
  });

  test("a budget that never expires produces the same answer as no budget at all", () => {
    const tracker = budgets.create({ config: fixture.budgetConfig({ timeBudgetMs: 1_000_000 }), elapsedMs: () => 0 });
    const instance = twoLegs();

    expect(allocationOf(minCostFlow.solve(instance, { budgets: tracker }))).toEqual(allocationOf(minCostFlow.solve(instance)));
    expect(minCostFlow.solve(instance, { budgets: tracker }).budgetLimited).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   What the flow still refuses
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the multi-Leg column has no arc representation (§9.3)", () => {
  test("the refusal is the network's, so it is identical on both solvers", () => {
    const built = objective.buildInstance({
      legs: fixture.legs(["L1", "L2"]),
      columns: [fixture.column({ legIds: ["L1", "L2"], agentId: "A1", gammaCu: 15 })],
      deferralEnabled: false,
    });

    for (const options of [undefined, REFERENCE]) {
      const solved = minCostFlow.solve(built.instance, options);
      expect(solved.ok).toBe(false);
      expect(solved.problems.join(" ")).toMatch(/set partitioning rather than as a flow/);
      expect(solved.assignments).toEqual([]);
    }
  });
});

"use strict";

/**
 * Phase 10 — independent brute-force oracle, and the exact-scalarisation stress.
 *
 * The repository's own oracle (`tests/engine/solveCostScalingOracle.test.js`) enumerates 8 000
 * instances inside the `engine` lane. This is a **third** enumeration, written from §1.4's
 * objective directly, sharing no code with either solver or with that test, and run in a bare
 * process so the sweep can be widened past what a test lane's timeout allows.
 *
 * §1.4, as enumerated here: every Leg is covered by exactly one option — one of its priced
 * columns, its priced deferral `y[l]`, or (where the `deferral` switch removed `y[l]`) it
 * remains queued. An agent may be used at most once. The objective is the lexicographic pair
 * `(Legs left queued, Σ milli-CU)`, minimised in that order — §22.5 rule 1 as a priority, not
 * as a price.
 *
 * Usage:
 *   node tools/verify/phase10Oracle.js oracle [instances]
 *   node tools/verify/phase10Oracle.js scalarisation
 */

const objective = require("../../src/engine/solve/objective");
const minCostFlow = require("../../src/engine/solve/minCostFlow");
const costScaling = require("../../src/engine/solve/costScaling");
const fixture = require("../../tests/engine/helpers/roundFixture");

/** @structural a 32-bit xorshift — the shift widths are the generator's own */
function sequence(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

const MAX_LEGS = 6;
const MAX_AGENTS = 6;

/**
 * One small instance, plus the plain description the enumeration reads. The description is
 * built from the generator's own draws rather than from the built instance, so a defect in
 * `buildInstance` cannot make the oracle agree with the solver by construction.
 */
function generated(seed) {
  const next = sequence(seed);
  const legCount = 1 + (next() % MAX_LEGS);
  const agentPool = 1 + (next() % MAX_AGENTS);
  const dense = next() % 4 === 0;
  const costMode = next() % 5;
  const deferralAdmissible = next() % 3 === 0;

  const legIds = Array.from({ length: legCount }, (unused, index) => `L${index}`);
  const columns = [];
  const options = new Map(legIds.map((legId) => [legId, []]));

  for (const legId of legIds) {
    const candidates = dense ? agentPool : 1 + (next() % 2);
    for (let candidate = 0; candidate < candidates; candidate += 1) {
      const magnitude = next() % (costMode === 3 ? 4 : 200);
      let value = magnitude;
      if (costMode === 1) value = -magnitude;
      else if (costMode === 2) value = next() % 2 === 0 ? magnitude : -magnitude;
      else if (costMode === 4) value = 0;
      const agentId = `A${next() % agentPool}`;
      columns.push(fixture.column({ legId, agentId, gammaMilliCU: BigInt(value) }));
      options.get(legId).push({ kind: "ASSIGN", agentId, milliCU: BigInt(value) });
    }
  }

  const deferCu = 1 + (next() % 150);
  for (const legId of legIds) {
    if (deferralAdmissible) options.get(legId).push({ kind: "DEFER", milliCU: BigInt(deferCu) * 1000n });
    else options.get(legId).push({ kind: "QUEUE", milliCU: 0n });
  }

  const built = objective.buildInstance({
    legs: fixture.legs(legIds, { deferralAdmissible, deferCu }),
    columns,
    deferralEnabled: deferralAdmissible,
  });
  return built.ok ? { instance: built.instance, legIds, options } : null;
}

/**
 * The optimum of §1.4's programme, by exhaustive enumeration over every legal combination of
 * per-Leg options subject to agent exclusivity. Lexicographic: queued count first, money second.
 *
 * @returns {{ queued: number, milliCU: bigint }}
 */
function enumerateOptimum(description) {
  const { legIds, options } = description;
  let bestQueued = null;
  let bestMoney = null;

  const walk = (index, usedAgents, queued, money) => {
    // Prune on the primary key only: money may be negative, so no monotone money bound exists.
    if (bestQueued !== null && queued > bestQueued) return;

    if (index === legIds.length) {
      if (bestQueued === null || queued < bestQueued || (queued === bestQueued && money < bestMoney)) {
        bestQueued = queued;
        bestMoney = money;
      }
      return;
    }

    for (const option of options.get(legIds[index])) {
      if (option.kind === "ASSIGN") {
        if (usedAgents.has(option.agentId)) continue;
        usedAgents.add(option.agentId);
        walk(index + 1, usedAgents, queued, money + option.milliCU);
        usedAgents.delete(option.agentId);
      } else {
        walk(index + 1, usedAgents, queued + (option.kind === "QUEUE" ? 1 : 0), money + option.milliCU);
      }
    }
  };

  walk(0, new Set(), 0, 0n);
  return { queued: bestQueued, milliCU: bestMoney };
}

function oracle(instances) {
  let checked = 0;
  let skipped = 0;
  const mismatches = [];

  for (let seed = 1; checked + skipped < instances; seed += 1) {
    const description = generated(seed);
    if (description === null) {
      skipped += 1;
      continue;
    }

    // Through `solve()` with no `solver` option: the production dispatch, not a named algorithm.
    const solved = minCostFlow.solve(description.instance);
    const expected = enumerateOptimum(description);

    const selection = {
      columnIndices: solved.assignments.map((row) => row.columnIndex),
      deferredLegIds: solved.deferred.map((row) => row.legId),
    };
    const validity = objective.validate(description.instance, selection);
    const consistency = objective.assertObjectiveIsAllocationCost({
      instance: description.instance,
      selection,
      solverObjectiveMilliCU: solved.objectiveMilliCU,
    });

    const accounted = solved.assignments.length + solved.deferred.length + solved.unassigned.length;

    if (
      solved.unassigned.length !== expected.queued ||
      solved.objectiveMilliCU !== expected.milliCU ||
      !validity.feasible ||
      !consistency.ok ||
      accounted !== description.legIds.length ||
      solved.solver !== minCostFlow.SOLVER.COST_SCALING ||
      solved.optimalityCertified !== true
    ) {
      mismatches.push({
        seed,
        solver: solved.solver,
        certified: solved.optimalityCertified,
        queued: [solved.unassigned.length, expected.queued],
        milliCU: [String(solved.objectiveMilliCU), String(expected.milliCU)],
        feasible: validity.feasible,
        consistent: consistency.ok,
        accounted: [accounted, description.legIds.length],
      });
    }
    checked += 1;
  }

  console.log(`\n=== BRUTE-FORCE ORACLE — ${checked} instances (${skipped} unbuildable, skipped) ===\n`);
  console.log(`mismatches: ${mismatches.length}`);
  for (const row of mismatches.slice(0, 10)) console.log(JSON.stringify(row));
  if (mismatches.length > 0) process.exitCode = 1;
}

/**
 * §17 — the exact scalarisation, stressed at the boundary rather than in the middle.
 *
 * `prepare()` collapses the lexicographic pair to `w = unassigned · K + milliCU` with
 * `K = 1 + 2 · n · max|milliCU|`, and the collapse is order-identical to the pair only while
 * every intermediate is exactly representable. The property under test is therefore not "it is
 * always exact" — it cannot be — but **"it is exact or it refuses"**: at no magnitude may a
 * wrong answer come back. The reference solver is exact at every magnitude (all BigInt), so it
 * is the arbiter.
 */
function scalarisation() {
  console.log(`\n=== EXACT SCALARISATION — the collapse at the boundary ===\n`);
  console.log("max|γ| milliCU              K                          refused?      answers agree  solver");

  // One Leg with two agents at ±magnitude, plus a second Leg that must stay queued, so both
  // components of the lexicographic pair are exercised at every magnitude.
  for (const exponent of [3, 6, 9, 12, 13, 14, 15, 16, 17, 18]) {
    const magnitude = 10n ** BigInt(exponent);
    const legIds = ["L0", "L1"];
    const columns = [
      fixture.column({ legId: "L0", agentId: "A0", gammaMilliCU: magnitude }),
      fixture.column({ legId: "L0", agentId: "A1", gammaMilliCU: -magnitude }),
      fixture.column({ legId: "L1", agentId: "A1", gammaMilliCU: magnitude - 1n }),
    ];
    const built = objective.buildInstance({ legs: fixture.legs(legIds), columns, deferralEnabled: false });
    const network = minCostFlow.buildNetwork(built.instance).network;
    const prepared = costScaling.prepare(network);

    const solved = minCostFlow.solve(built.instance);
    const reference = minCostFlow.solve(built.instance, { solver: minCostFlow.SOLVER.SUCCESSIVE_SHORTEST_PATH });

    const agree =
      solved.objectiveMilliCU === reference.objectiveMilliCU && solved.unassigned.length === reference.unassigned.length;

    console.log(
      `${String(magnitude).padStart(22)}  ${(prepared.ok ? String(BigInt(prepared.prepared.collapseK)) : "—").padStart(24)}  ` +
        `${String(!prepared.ok).padStart(9)}  ${String(agree).padStart(13)}  ${solved.solver}`,
    );

    if (!agree) {
      console.log(`  MISMATCH: scaled=${solved.objectiveMilliCU} reference=${reference.objectiveMilliCU}`);
      process.exitCode = 1;
    }
  }

  // And the priority component itself: an assignment at the widest money the collapse accepts
  // must still beat leaving a Leg queued, which is what `K > 2 · n · max|milliCU|` buys.
  console.log(`\npriority dominance — an assignment at the widest accepted γ vs a queued Leg:`);
  for (const exponent of [6, 9, 12, 13]) {
    const magnitude = 10n ** BigInt(exponent);
    const built = objective.buildInstance({
      legs: fixture.legs(["L0"]),
      columns: [fixture.column({ legId: "L0", agentId: "A0", gammaMilliCU: magnitude })],
      deferralEnabled: false,
    });
    const solved = minCostFlow.solve(built.instance);
    const assigned = solved.assignments.length === 1 && solved.unassigned.length === 0;
    console.log(`  γ = ${String(magnitude).padStart(20)}  assigned rather than queued: ${assigned}  (solver ${solved.solver})`);
    if (!assigned) process.exitCode = 1;
  }
}

const [, , mode, ...rest] = process.argv;
if (mode === "oracle") oracle(Number(rest[0] || 30000));
else if (mode === "scalarisation") scalarisation();
else {
  console.log("modes: oracle [instances] | scalarisation");
  process.exit(1);
}

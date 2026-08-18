"use strict";

/**
 * Phase 10 — bare-process measurement harness for the cost-scaling solver.
 *
 * Not a test and not a gate. Jest is a measurement environment of its own — the Phase 10
 * implementation report records `buildInstance` inflated ~4× and `solve` ~1.4× inside the
 * `scale` lane — so every performance number this closure pass quotes is taken here, in a
 * bare `node` process, with the stages separated rather than reported as one total.
 *
 * Usage:
 *   node tools/verify/phase10Profile.js stages   [legs] [candidates] [reps]
 *   node tools/verify/phase10Profile.js budgets  [legs] [candidates]
 *   node tools/verify/phase10Profile.js tiers    [reps]
 *   node tools/verify/phase10Profile.js memory   [legs] [candidates]
 */

const objective = require("../../src/engine/solve/objective");
const minCostFlow = require("../../src/engine/solve/minCostFlow");
const costScaling = require("../../src/engine/solve/costScaling");
const budgets = require("../../src/engine/solve/budgets");
const fixture = require("../../tests/engine/helpers/roundFixture");

/* ── the instance, generated exactly as tests/scale/round.scale.test.js generates it ──── */

function inputAt(legs, candidates, options) {
  const settings = options || {};
  const plan = fixture.brandedPlan();
  const legIds = Array.from({ length: legs }, (unused, index) => `L${index}`);
  const columns = [];
  for (let leg = 0; leg < legs; leg += 1) {
    for (let candidate = 0; candidate < candidates; candidate += 1) {
      columns.push(
        fixture.column({
          legId: `L${leg}`,
          agentId: `A${(leg + candidate) % (legs + candidates)}`,
          gammaCu: 10 + ((leg * 7 + candidate * 13) % 97),
          plan,
        }),
      );
    }
  }
  return {
    legs: fixture.legs(legIds, settings.deferralAdmissible === true ? { deferralAdmissible: true, deferCu: 100 } : undefined),
    columns,
    deferralEnabled: settings.deferralAdmissible === true,
  };
}

function instanceOf(legs, candidates, options) {
  const built = objective.buildInstance(inputAt(legs, candidates, options));
  if (!built.ok) throw new Error(`instance did not build: ${JSON.stringify(built.problems)}`);
  return built.instance;
}

/* ── statistics ───────────────────────────────────────────────────────────────────────── */

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1) + 0.5))];
  return {
    n: sorted.length,
    min: sorted[0],
    median: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
  };
}

function row(label, samples) {
  const s = stats(samples);
  return `${label.padEnd(38)} n=${String(s.n).padStart(2)}  min ${s.min.toFixed(1).padStart(8)}  med ${s.median
    .toFixed(1)
    .padStart(8)}  p95 ${s.p95.toFixed(1).padStart(8)}  max ${s.max.toFixed(1).padStart(8)}  ms`;
}

function time(fn) {
  const started = process.hrtime.bigint();
  const value = fn();
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  return { elapsed, value };
}

/* ── stages ───────────────────────────────────────────────────────────────────────────── */

function stages(legs, candidates, reps) {
  const input = inputAt(legs, candidates);
  console.log(`\n=== STAGES — ${legs} Legs × ${candidates} candidates, ${reps} reps, bare process, node ${process.version} ===\n`);

  const build = [];
  for (let rep = 0; rep < reps + 1; rep += 1) {
    const measured = time(() => objective.buildInstance(input));
    if (rep > 0) build.push(measured.elapsed);
  }
  console.log(row("objective.buildInstance", build));

  const instance = objective.buildInstance(input).instance;

  const network = [];
  const prepare = [];
  const run = [];
  const certify = [];
  const rest = [];
  const whole = [];

  for (let rep = 0; rep < reps + 1; rep += 1) {
    const built = time(() => minCostFlow.buildNetwork(instance));
    const prepared = time(() => costScaling.prepare(built.value.network));
    if (!prepared.value.ok) throw new Error(`prepare refused: ${prepared.value.refusal}`);
    const state = time(() => costScaling.run(prepared.value.prepared, {}));
    if (state.value.outcome !== costScaling.OUTCOME.OK) throw new Error(`run ended ${state.value.outcome}`);

    const capacity = built.value.network.arcCapacity;
    const residual = prepared.value.prepared.arcResidual;
    const tighten = new Uint8Array(built.value.network.arcTo.length);
    for (let arc = 0; arc < built.value.network.arcTo.length; arc += 2) {
      const role = built.value.network.arcRole[arc];
      if (role !== minCostFlow.ARC.PAIRING && role !== minCostFlow.ARC.DEFER) continue;
      if (capacity[arc] - residual[arc] > 0) tighten[arc] = 1;
    }
    const proof = time(() => costScaling.certify(prepared.value.prepared, state.value, { tighten }));
    if (!proof.value.ok) throw new Error(`certificate failed: ${proof.value.problems.join("; ")}`);

    if (rep > 0) {
      network.push(built.elapsed);
      prepare.push(prepared.elapsed);
      run.push(state.elapsed);
      certify.push(proof.elapsed);
    }
  }

  // The whole solve in its own loop rather than interleaved with the instrumented one: the
  // two allocate very differently and interleaving them makes each measure the other's
  // collector debt. The residual below is therefore a difference of medians, not of pairs.
  for (let rep = 0; rep < reps + 1; rep += 1) {
    const total = time(() => minCostFlow.solve(instance));
    if (total.value.optimalityCertified !== true) throw new Error("whole solve did not certify");
    if (rep > 0) whole.push(total.elapsed);
  }
  rest.push(
    stats(whole).median - stats(network).median - stats(prepare).median - stats(run).median - stats(certify).median,
  );

  console.log(row("  minCostFlow.buildNetwork", network));
  console.log(row("  costScaling.prepare", prepare));
  console.log(row("  costScaling.run (ε-loop)", run));
  console.log(row("  costScaling.certify", certify));
  console.log(row("  assemble + dispatch (residual)", rest));
  console.log(row("minCostFlow.solve (whole)", whole));

  const buildMed = stats(build).median;
  const solveMed = stats(whole).median;
  console.log(
    `\nbuild + solve median: ${(buildMed + solveMed).toFixed(1)} ms   ` +
      `(buildInstance share ${((100 * buildMed) / (buildMed + solveMed)).toFixed(1)} %, ` +
      `ε-loop share of solve ${((100 * stats(run).median) / solveMed).toFixed(1)} %, ` +
      `certify share of solve ${((100 * stats(certify).median) / solveMed).toFixed(1)} %)`,
  );
  console.log(`§20.1 whole-round target: 250 ms — these are TWO stages of the round only.`);
}

/* ── the anytime budget matrix ────────────────────────────────────────────────────────── */

function budgetMatrix(legs, candidates) {
  const grid = [0, 1, 5, 10, 25, 50, 75, 100, 150, 250, 100000];

  for (const deferralAdmissible of [false, true]) {
    const instance = instanceOf(legs, candidates, { deferralAdmissible });
    console.log(
      `\n=== BUDGET MATRIX — ${legs} Legs × ${candidates} candidates, deferral ${deferralAdmissible ? "ENABLED" : "DISABLED"} ===\n`,
    );
    console.log(
      "budget    elapsed  over    phases  assigned deferred queued  TOTAL  ok     feasible objConsistent  objective        bound            certified budgetLtd",
    );

    for (const budgetMs of grid) {
      const started = Date.now();
      const tracker = budgets.create({
        config: { timeBudgetMs: budgetMs, maxLegsPerRound: 500, maxEvaluatedPerLeg: 200, maxColumnsPerRound: 100000 },
        elapsedMs: () => Date.now() - started,
      });
      const measured = time(() => minCostFlow.solve(instance, { budgets: tracker }));
      const solved = measured.value;
      const accounted = solved.assignments.length + solved.deferred.length + solved.unassigned.length;
      const selection = {
        columnIndices: solved.assignments.map((entry) => entry.columnIndex),
        deferredLegIds: solved.deferred.map((entry) => entry.legId),
      };
      const validity = objective.validate(instance, selection);
      const consistency = objective.assertObjectiveIsAllocationCost({
        instance,
        selection,
        solverObjectiveMilliCU: solved.objectiveMilliCU,
      });

      console.log(
        [
          String(budgetMs).padStart(6),
          measured.elapsed.toFixed(0).padStart(9),
          (measured.elapsed - budgetMs).toFixed(0).padStart(6),
          String(solved.solverDiagnostics.scalingPhases ?? "-").padStart(8),
          String(solved.assignments.length).padStart(8),
          String(solved.deferred.length).padStart(8),
          String(solved.unassigned.length).padStart(7),
          `${accounted}/${legs}`.padStart(9),
          String(solved.ok).padStart(6),
          String(validity.feasible).padStart(9),
          String(consistency.ok).padStart(14),
          String(solved.objectiveMilliCU).padStart(17),
          String(solved.boundMilliCU).padStart(17),
          String(solved.optimalityCertified).padStart(10),
          String(solved.budgetLimited).padStart(10),
        ].join(" "),
      );
    }
  }
}

/* ── SSP vs cost scaling across tiers ─────────────────────────────────────────────────── */

function tiers(reps) {
  console.log(`\n=== TIERS — cost scaling vs successive shortest paths, ${reps} reps, bare process ===\n`);
  console.log("shape          columns   cost-scaling(med)   SSP(med)        speed-up  objectives equal");

  for (const [legs, candidates] of [
    [100, 200],
    [250, 200],
    [500, 200],
  ]) {
    const instance = instanceOf(legs, candidates);
    const scaled = [];
    const reference = [];
    let scaledObjective = null;
    let referenceObjective = null;

    for (let rep = 0; rep < reps; rep += 1) {
      const a = time(() => minCostFlow.solve(instance));
      scaled.push(a.elapsed);
      scaledObjective = a.value.objectiveMilliCU;
      if (a.value.solver !== minCostFlow.SOLVER.COST_SCALING) throw new Error("not cost scaling");
      const b = time(() => minCostFlow.solve(instance, { solver: minCostFlow.SOLVER.SUCCESSIVE_SHORTEST_PATH }));
      reference.push(b.elapsed);
      referenceObjective = b.value.objectiveMilliCU;
    }

    const cs = stats(scaled).median;
    const ssp = stats(reference).median;
    console.log(
      `${String(legs).padStart(4)} × ${String(candidates).padEnd(4)} ${String(legs * candidates).padStart(9)}   ` +
        `${cs.toFixed(1).padStart(10)} ms   ${ssp.toFixed(1).padStart(10)} ms   ${(ssp / cs).toFixed(1).padStart(6)}×   ` +
        `${String(scaledObjective === referenceObjective)}`,
    );
  }
}

/* ── memory ───────────────────────────────────────────────────────────────────────────── */

function memory(legs, candidates) {
  if (typeof global.gc !== "function") {
    console.log("run with --expose-gc for retention figures");
  }
  const collect = () => {
    if (typeof global.gc === "function") global.gc();
  };
  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

  const instance = instanceOf(legs, candidates);
  collect();
  const before = process.memoryUsage();
  console.log(`\n=== MEMORY — ${legs} × ${candidates} ===\n`);
  console.log(`instance built:  rss ${mb(before.rss)} MB  heapUsed ${mb(before.heapUsed)} MB`);

  let peak = 0;
  for (let rep = 0; rep < 5; rep += 1) {
    minCostFlow.solve(instance);
    const usage = process.memoryUsage();
    peak = Math.max(peak, usage.rss);
    collect();
    const after = process.memoryUsage();
    console.log(`after solve ${rep + 1}: rss ${mb(after.rss)} MB  heapUsed ${mb(after.heapUsed)} MB  (peak rss ${mb(peak)} MB)`);
  }
}

/* ── determinism at the full shape ────────────────────────────────────────────────────── */

/**
 * §9.6's acceptance property at §20.1's own shape. The suite checks it on small instances; a
 * canonical-ordering defect that only shows up once a sort is long enough to be non-stable, or
 * once a Map has enough keys to rehash, would not appear there.
 */
function determinism(legs, candidates, runs) {
  const { canonicalJson } = require("../../src/engine/determinism/ordering");
  console.log(`\n=== DETERMINISM — ${runs} runs at ${legs} × ${candidates}, rebuilt instance each run ===\n`);

  const digests = [];
  for (let run = 0; run < runs; run += 1) {
    // Rebuilt from the input every run, so the check covers `buildInstance`'s ordering too and
    // not merely the solver's behaviour on one frozen object.
    const instance = instanceOf(legs, candidates);
    const solved = minCostFlow.solve(instance);
    digests.push(
      canonicalJson({
        assignments: solved.assignments.map((row) => `${row.legId}→${row.agentId}@${row.identity}`),
        deferred: solved.deferred.map((row) => row.legId),
        unassigned: solved.unassigned.map((row) => row.legId),
        objectiveMilliCU: solved.objectiveMilliCU,
        boundMilliCU: solved.boundMilliCU,
        lpIpGapMilliCU: solved.lpIpGapMilliCU,
        duals: solved.duals.prices,
        agentDuals: solved.agentDuals.prices,
        diagnostics: solved.solverDiagnostics,
        certified: solved.optimalityCertified,
      }),
    );
  }

  const identical = digests.every((digest) => digest === digests[0]);
  console.log(`byte-identical across ${runs} runs (allocation, objective, bound, duals, diagnostics): ${identical}`);
  console.log(`digest length ${digests[0].length} chars; first 120: ${digests[0].slice(0, 120)}…`);
  if (!identical) {
    for (let run = 1; run < digests.length; run += 1) {
      if (digests[run] !== digests[0]) console.log(`run ${run + 1} diverges`);
    }
    process.exitCode = 1;
  }
}

/* ── entry ────────────────────────────────────────────────────────────────────────────── */

const [, , mode, ...rest] = process.argv;
const number = (index, fallback) => (rest[index] === undefined ? fallback : Number(rest[index]));

if (mode === "stages") stages(number(0, 500), number(1, 200), number(2, 5));
else if (mode === "budgets") budgetMatrix(number(0, 500), number(1, 200));
else if (mode === "tiers") tiers(number(0, 3));
else if (mode === "memory") memory(number(0, 500), number(1, 200));
else if (mode === "determinism") determinism(number(0, 500), number(1, 200), number(2, 10));
else {
  console.log("modes: stages | budgets | tiers | memory | determinism");
  process.exit(1);
}

"use strict";

/**
 * Engine lane — the B1 routing-engine benchmark (`tools/routing/b1Benchmark.js`).
 *
 * B1 is an open execution-plan §6.1 blocking decision and this tool does not close it. What
 * these tests establish is the only thing that can be established here: that the tool is a
 * **measurement** rather than a form to fill in — that it reads §20.1's registered targets
 * rather than restating them, that it refuses to call an unmeasured row a pass, and that its
 * measured half genuinely runs and genuinely fails when an engine misses a target.
 *
 * The last of those is the one that matters. A benchmark whose failing branch is never
 * exercised is a benchmark nobody has seen work, and it would be discovered for the first
 * time on the day a real engine is measured — which is exactly the day it must be trusted.
 */

const benchmark = require("../../tools/routing/b1Benchmark");
const sli = require("../../src/engine/observability/sli");
const service = require("../../src/engine/config/service");

/**
 * An in-process adapter that answers instantly. It is not a routing engine and is not
 * pretending to be one: it exists to drive the harness's measured path, so the reported
 * numbers here are properties of the harness, never of any candidate engine.
 *
 * `latencyLoopIterations` is a deterministic busy-wait, used by the failure test to make a
 * row exceed its target without a timer — a sleep would make the test a measurement of the
 * event loop.
 */
function stubEngine(options) {
  const settings = options || {};
  // A real timer rather than a busy-wait. What the harness measures is the adapter's
  // wall-clock — which for any real engine is dominated by a network round trip — so a sleep
  // is the faithful stand-in and a spin loop would measure whether V8 chose to optimise it.
  const delay = (ms) => (ms ? new Promise((resolve) => setTimeout(resolve, ms)) : null);

  return {
    id: settings.id || "stub",
    description: "in-process stub; not a routing engine and not a candidate",
    profile: { energyWhPerMetre: 0.05, speedMetresPerSecond: 5 },
    async matrix({ destCellIds }) {
      await delay(settings.matrixDelayMs);
      return destCellIds.map((destCellId, index) => ({
        destCellId,
        distanceM: 100 + index,
        travelSeconds: 20 + index,
        travelSdSeconds: 1,
      }));
    },
    async nearestChargers({ k }) {
      await delay(settings.chargerDelayMs);
      return Array.from({ length: k }, (unused, index) => ({
        chargerId: `C${index}`,
        distanceM: 500 + index * 10,
        travelSeconds: 100 + index,
      }));
    },
  };
}

/**
 * A small workload for the harness's own tests.
 *
 * §20.1's shape is 500 × 200 = 100 000 cache reads, which is the right size for the tool and
 * the wrong size for a test lane. `measure()` takes the shape as a parameter for exactly this
 * reason, and a separate test asserts the *default* is §20.1's own — so shrinking it here
 * cannot shrink what the tool measures.
 */
const TEST_WORKLOAD = Object.freeze({
  legs: 20,
  candidatesPerLeg: 10,
  clusterCount: 4,
  profileKey: "ground_default",
  timeBucket: 0,
  projectionVersion: 1,
});

function configFor() {
  const snapshot = service.defaultSnapshot();
  return {
    cellPairTtl: snapshot.resolve("route.cell_pair_cache_ttl"),
    cellPairMinHitRate: snapshot.resolve("route.cell_pair_min_hit_rate"),
    chargerK: snapshot.resolve("route.charger_reachability_k"),
    chargerTtl: snapshot.resolve("route.cell_pair_cache_ttl"),
    intraCellOffsetM: snapshot.resolve("route.intra_cell_offset_m"),
    energyWhPerMetre: 0.05,
    speedMetresPerSecond: 5,
  };
}

describe("the B1 benchmark's targets come from the register, not from this tool", () => {
  test("every latency row resolves a §20.1 SLI row, and every hit-rate row a §20.3 parameter", () => {
    const { rows, problems } = benchmark.resolveTargets();
    expect(problems).toEqual([]);

    for (const row of rows) {
      expect({ id: row.id, hasTarget: row.target !== null && row.target !== undefined }).toEqual({
        id: row.id,
        hasTarget: true,
      });
      if (row.kind === "LATENCY") {
        // The threshold is §20.1's own, reached through `sli.TARGET_BY_ID` — so a target
        // cannot drift from the specification here without `sli.assertTargets()` failing
        // in this same lane first.
        expect(sli.TARGET_BY_ID[row.targetId]).toBeTruthy();
        expect(row.target).toBe(service.defaultSnapshot().resolve(sli.TARGET_BY_ID[row.targetId].parameter));
      }
    }
  });

  test("the four routing rows §20.1 and §20.3 name are all present", () => {
    const ids = benchmark.ROWS.map((row) => row.id);
    for (const required of [
      "approach_routing_matrix",
      "charger_reachability_cached",
      "charger_reachability_miss",
      "cell_pair_hit_rate",
      "charger_reachability_hit_rate",
    ]) {
      expect({ required, present: ids.includes(required) }).toEqual({ required, present: true });
    }
  });

  test("the DEFAULT workload is §20.1's own shape, not a reduced stand-in", () => {
    // §9.4 caps the round at exactly these two numbers, so a benchmark at any other shape
    // measures a round the engine is not sized for — the substitution `round.scale.test.js`
    // used to make for the solve and no longer does.
    //
    // This is also what makes the small `TEST_WORKLOAD` below safe: the tests may measure the
    // harness at a size a lane can afford precisely because this test pins what the *tool*
    // measures, and the CLI never passes a shape override.
    const snapshot = service.defaultSnapshot();
    expect(benchmark.DEFAULT_WORKLOAD.legs).toBe(snapshot.resolve("solve.max_legs_per_round"));
    expect(benchmark.DEFAULT_WORKLOAD.candidatesPerLeg).toBe(snapshot.resolve("candidate.max_evaluated"));
  });
});

describe("with no engine supplied it makes no claim", () => {
  test("every row is NOT_MEASURED, and NOT_MEASURED is not PASS", () => {
    const { rows } = benchmark.resolveTargets();
    const results = benchmark.verdicts(rows, null);

    expect(results).toHaveLength(benchmark.ROWS.length);
    for (const row of results) {
      expect({ id: row.id, verdict: row.verdict }).toEqual({ id: row.id, verdict: benchmark.VERDICT.NOT_MEASURED });
      expect(row.observed).toBeNull();
    }
    // The distinction the tool exists to preserve: no row may be reported as passing on the
    // strength of nobody having measured it.
    expect(results.some((row) => row.verdict === benchmark.VERDICT.PASS)).toBe(false);
  });

  test("`main` exits 0 without an engine — because no claim was made, not because a target was met", async () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    const code = await benchmark.main([]);
    const printed = log.mock.calls.map((call) => String(call[0])).join("\n");
    log.mockRestore();

    expect(code).toBe(0);
    expect(printed).toMatch(/BLOCKING DECISION B1 — self-hosted routing engine — IS OPEN/);
    expect(printed).toMatch(/NOT_MEASURED on every row/);
    // The provenance line is asserted for the same reason `scaleHarness.js`'s is: a number
    // published without it will be read as gate evidence by someone eventually.
    expect(printed).toMatch(/NOT §20\.1 gate evidence/);
  });
});

describe("the measured half genuinely runs", () => {
  test("it drives the two shipped caches and reports a real hit rate for each population", async () => {
    const measured = await benchmark.measure(stubEngine(), configFor(), TEST_WORKLOAD);

    // The approach population: warmed once per cell cluster, then read once per candidate.
    // Every read should hit, because §20.3 item 2's whole claim is that cell quantisation
    // makes it hit — this asserts the harness is exercising that path rather than skipping it.
    expect(measured.approachHitRate.hits + measured.approachHitRate.misses).toBe(
      TEST_WORKLOAD.legs * TEST_WORKLOAD.candidatesPerLeg,
    );
    expect(measured.approachHitRate.hitRate).toBeGreaterThan(0.99);

    // The return-leg population is a second, separate cache, and the harness must not have
    // let it share the first's counters.
    expect(measured.chargerHitRate).toBeGreaterThan(0);
    expect(measured.chargerMissMs.length).toBeGreaterThan(0);
    expect(measured.chargerHitUs.length).toBeGreaterThan(0);
    expect(measured.approachMatrixMs).toHaveLength(TEST_WORKLOAD.clusterCount);
  });

  test("a fast engine passes the rows it answers, and cost_per_candidate stays NOT_MEASURED", async () => {
    const { rows } = benchmark.resolveTargets();
    const results = benchmark.verdicts(rows, await benchmark.measure(stubEngine(), configFor(), TEST_WORKLOAD));
    const byId = Object.fromEntries(results.map((row) => [row.id, row]));

    expect(byId.approach_routing_matrix.verdict).toBe(benchmark.VERDICT.PASS);
    // `cell_pair_hit_rate` was asserted PASS here until the harness-artifact discipline
    // landed. It is now NOT_MEASURED — a strictly stronger claim, since the 1.00 it used to
    // pass on was produced by this harness pre-warming the cache and then reading it, and
    // was identical for every engine. See the dedicated describe block below.
    expect(byId.cell_pair_hit_rate.verdict).toBe(benchmark.VERDICT.NOT_MEASURED);

    // §20.1's cost-per-candidate row covers the whole §8 cost evaluation, of which routing is
    // one input. Reporting a routing measurement under it would attribute a budget this tool
    // did not measure, so it stays NOT_MEASURED even on a fully successful run.
    expect(byId.cost_per_candidate.verdict).toBe(benchmark.VERDICT.NOT_MEASURED);
    expect(byId.cost_per_candidate.note).toMatch(/whole §8 cost evaluation/);
  });

  test("A SLOW ENGINE FAILS — the tool's failing branch, exercised end to end", async () => {
    // The load-bearing test. `approach_routing_matrix`'s target is §20.1's 20 ms; this engine
    // spends four times that per matrix, and the row must come back EXCEEDED. Without this,
    // the failing branch would be run for the first time on the day a real candidate engine is
    // measured — which is the day it has to be trusted.
    const { rows } = benchmark.resolveTargets();
    const slow = stubEngine({ id: "slow-stub", matrixDelayMs: 80 });
    const results = benchmark.verdicts(rows, await benchmark.measure(slow, configFor(), TEST_WORKLOAD));
    const row = results.find((entry) => entry.id === "approach_routing_matrix");

    expect(row.verdict).toBe(benchmark.VERDICT.EXCEEDED);
    expect(row.observed).toBeGreaterThan(row.target);
  }, 30000);

  test("a slow return-leg population fails its own row, independently of the approach one", async () => {
    // §20.3's whole point about the second population is that it is separate: it does not
    // share the first's cache and it gets its own budget line. A tool that could only fail
    // both rows together would not be able to report the distinction §20.1 draws.
    const { rows } = benchmark.resolveTargets();
    const slow = stubEngine({ id: "slow-charger-stub", chargerDelayMs: 20 });
    const results = benchmark.verdicts(rows, await benchmark.measure(slow, configFor(), TEST_WORKLOAD));
    const byId = Object.fromEntries(results.map((row) => [row.id, row]));

    // The miss path exceeds its 2 ms target; the approach matrix, untouched, does not.
    expect(byId.charger_reachability_miss.verdict).toBe(benchmark.VERDICT.EXCEEDED);
    expect(byId.approach_routing_matrix.verdict).toBe(benchmark.VERDICT.PASS);
  }, 30000);
});

describe("the reported statistic is a p99, not a mean and not a maximum", () => {
  test("it is the 99th of 100 samples — so the single worst sample does not define it", () => {
    // §20.1 is stated at p99, and the distinction from both neighbours matters. A mean would
    // hide the tail the target exists to bound; a maximum would make every measurement a
    // report on the one unluckiest garbage collection.
    const fast = Array.from({ length: 99 }, () => 1);
    expect(benchmark.percentile([...fast, 1000], 0.99)).toBe(1);
  });

  test("it IS moved as soon as the tail exceeds 1 % of the samples", () => {
    // Nearest-rank: with 100 samples the reported figure is the 99th, so exactly one slow
    // sample sits above it (the test before) and two cannot. This is the boundary, asserted
    // so that a future change to the rank arithmetic has to move it deliberately.
    const fast = Array.from({ length: 98 }, () => 1);
    expect(benchmark.percentile([...fast, 1000, 1000], 0.99)).toBe(1000);
  });

  test("no samples is null, never zero — an unmeasured row must not read as a fast one", () => {
    expect(benchmark.percentile([], 0.99)).toBeNull();
  });
});

describe("no row rules an engine out on a figure that is not about the engine", () => {
  /**
   * The regression these tests exist for.
   *
   * Both §20.3 hit-rate rows were compared against their registered targets. Neither figure
   * is produced by the engine: the harness warms the approach population once per cluster and
   * then reads it (1.00, always) and walks the return-leg population once cold and once warm
   * (0.50, always). The second was therefore below `route.charger_reachability_min_hit_rate`
   * on every run, came back EXCEEDED, and exited 1 — so **every** candidate engine, at any
   * speed, was reported as failing §20.1's routing budget on this file's loop structure. The
   * first was the same defect with the opposite sign: an unearned PASS.
   */
  test("both hit-rate figures are fixed by the harness, identical across engines and shapes", async () => {
    const shapes = [
      TEST_WORKLOAD,
      { ...TEST_WORKLOAD, legs: 40, candidatesPerLeg: 20, clusterCount: 8 },
    ];
    const engines = [stubEngine({ id: "fast" }), stubEngine({ id: "slower", chargerDelayMs: 1 })];

    for (const shape of shapes) {
      for (const engine of engines) {
        // eslint-disable-next-line no-await-in-loop
        const measured = await benchmark.measure(engine, configFor(), shape);
        // Pinned as the constants they are. If a future harness observes a genuine steady
        // state, these move — and the row's attribution has to be revisited deliberately.
        expect({ shape: shape.legs, engine: engine.id, approach: measured.approachHitRate.hitRate }).toEqual({
          shape: shape.legs,
          engine: engine.id,
          approach: 1,
        });
        expect({ shape: shape.legs, engine: engine.id, returnLeg: measured.chargerHitRate }).toEqual({
          shape: shape.legs,
          engine: engine.id,
          returnLeg: 0.5,
        });
      }
    }
  }, 30000);

  test("so neither is compared against its target — NOT_MEASURED, with the figure still carried", async () => {
    const { rows } = benchmark.resolveTargets();
    const results = benchmark.verdicts(rows, await benchmark.measure(stubEngine(), configFor(), TEST_WORKLOAD));
    const byId = Object.fromEntries(results.map((row) => [row.id, row]));

    for (const id of ["cell_pair_hit_rate", "charger_reachability_hit_rate"]) {
      expect({ id, verdict: byId[id].verdict }).toEqual({ id, verdict: benchmark.VERDICT.NOT_MEASURED });
      expect({ id, attribution: byId[id].attribution }).toEqual({
        id,
        attribution: benchmark.ATTRIBUTION.HARNESS_ARTIFACT,
      });
      // Not discarded — carried under a name that cannot be read as a measurement of the
      // engine, so the reader can still see what the harness did.
      expect(typeof byId[id].harnessObserved).toBe("number");
      expect(byId[id].note).toMatch(/steady-state hit rate cannot be observed by a cold single-process run/);
    }
  });

  test("a fast engine is no longer failed by the CLI — the end-to-end proof of the fix", async () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    // `main` runs the full §20.1 shape, which is the point: the defect was shape-independent
    // and the CLI is where it surfaced as an exit code.
    const code = await benchmark.main(["--engine", require.resolve("./helpers/nullRoutingAdapter.js")]);
    const printed = log.mock.calls.map((call) => String(call[0])).join("\n");
    log.mockRestore();

    // The only rows that may now fail are ones the engine or the cache path actually
    // produced. A zero-latency adapter produces neither an over-budget matrix nor an
    // over-budget miss, so no ENGINE row is exceeded.
    expect(printed).not.toMatch(/ENGINE row\(s\) EXCEEDED/);
    // The exit code is still allowed to be 1, but only ever for a CACHE_PATH row, whose
    // message must say the engine was not called on that path.
    if (code === 1) expect(printed).toMatch(/CACHE_PATH row\(s\) EXCEEDED[\s\S]*engine is NOT called on this path/);
  }, 120000);

  test("the amortisation block reports queries issued against reads served, per population", async () => {
    const measured = await benchmark.measure(stubEngine(), configFor(), TEST_WORKLOAD);

    // §20.3 item 4: one matrix per cell cluster, shared across the cluster's Legs. That is
    // the engine-relevant quantity the hit-rate rows were reaching for, and unlike them it
    // moves with the workload rather than with the loop structure.
    expect(measured.amortisation.approach.engineQueries).toBe(TEST_WORKLOAD.clusterCount);
    expect(measured.amortisation.approach.cacheReads).toBe(TEST_WORKLOAD.legs * TEST_WORKLOAD.candidatesPerLeg);
    expect(measured.amortisation.returnLeg.engineQueries).toBeGreaterThan(0);
    expect(measured.amortisation.returnLeg.cacheReads).toBeGreaterThan(
      measured.amortisation.returnLeg.engineQueries,
    );
  });
});

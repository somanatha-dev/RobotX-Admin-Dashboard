"use strict";

/**
 * Blocking decision **B1** — the routing-engine selection benchmark.
 *
 * > | B1 | **Self-hosted routing engine** selection and deployment (OSRM / Valhalla /
 * > GraphHopper / in-house) with per-profile contraction hierarchies | Phases 7, 8, 9 |
 * > §5.2, §27 item 2 | The current Mapbox dependency is explicitly incompatible with the hot
 * > path. **Longest lead time of any item here** — execution plan §6.1
 *
 * ── Why this tool exists, and what it deliberately does not do ─────────────
 * §20.3 calls routing *"the expensive part of any real allocator"* and the dominant term in
 * the round. B1 is therefore not only a Phase 7/8/9 blocker: it is one of the two independent
 * causes of the `scale_targets` release gate, alongside the solver's algorithm class. A gate
 * with two causes cannot be closed by addressing one.
 *
 * The decision itself cannot be made in this repository. It requires a routing engine
 * deployed against a real region extract, with per-profile contraction hierarchies built,
 * measured on representative hardware. What *can* be prepared here — and is what this file
 * is — is the **measurement that the decision must be made against**, so that the choice is
 * settled by architectural evidence rather than by whichever library benchmarks fastest on a
 * synthetic point-to-point query. §20.3 is explicit that the property which matters is not
 * raw query speed:
 *
 *   > **Precomputed hierarchies.** Contraction hierarchies or equivalent, so a query is
 *   > microseconds rather than milliseconds. **This is the reason routing must be
 *   > self-hosted (§5.2): the precomputation is the optimisation, and a metered
 *   > request-per-query API cannot provide it.**
 *
 * So this tool measures a candidate engine **through the two shipped caches**, at §20.1's own
 * workload shape, against §20.1's own registered targets — because the engine's steady-state
 * contribution is a function of the cache hit rate it sustains, not of its cold query time.
 * An engine that is twice as fast per query and cannot be precomputed is the worse choice,
 * and only a measurement in this shape shows that.
 *
 * **This tool never selects an engine.** It emits one row per §20.1 routing target per
 * candidate, and the selection is a recorded decision with an ADR (execution plan §6.1, §8).
 *
 * ── What it refuses to do, for the same reasons `simFidelity/validate.js` does ──
 *
 * 1. **It never reports an unmeasured row as a pass.** With no `--engine` supplied every row
 *    is `NOT_MEASURED`, which is not `PASS`, and the exit code is 0 because *no claim was
 *    made* — not because the targets were met.
 * 2. **It never presents its own numbers as §20.1 gate evidence.** §20.1 is stated per shard,
 *    at p99, under nominal operation, on representative production hardware, over the *whole*
 *    round. This is a single process on a build machine measuring one stage. Every report it
 *    prints carries that provenance line, for the same reason `scaleHarness.js` attaches one.
 * 3. **It never invents a target.** Every threshold is resolved from the parameter register
 *    through `observability/sli.js`, so a target cannot drift from §20.1 here without
 *    `sli.assertTargets()` failing in the engine lane first.
 * 4. **It never rules an engine out on a figure that is not about the engine.** Every row
 *    declares what it is a property *of* — see the attribution discipline below.
 *
 * ── The attribution discipline, and the defect it exists to prevent ─────────
 * Not every §20.1 routing row is a property of the routing engine, and a benchmark that
 * treats them as though they were will reject candidates for things they did not do.
 *
 * Three of these rows measure three different things:
 *
 *   - `ENGINE` — the timer brackets a call into the adapter (`matrix`, `nearestChargers`).
 *     Only these can rule a candidate engine out, and only these are what B1 chooses on.
 *   - `CACHE_PATH` — the engine is never called; the timer brackets a *cache hit*, which is
 *     `cellPairCache`/`chargerReachabilityCache` code plus the kv client. A row over budget
 *     here is a real §20.1 finding about the deployment and a real reason to exit non-zero,
 *     but it is not evidence against any candidate engine.
 *   - `HARNESS_ARTIFACT` — the figure is fixed by the access pattern *this harness itself
 *     creates* and is identical for every engine and every workload shape. The two §20.3
 *     hit-rate rows are exactly this: the approach population is warmed once per cell
 *     cluster and then read, so its rate is 1.00 by construction; the return-leg population
 *     is walked once cold and once warm, so its rate is 0.50 by construction. Neither is the
 *     *steady-state* rate §20.3 states a target for — a steady state is a property of live
 *     demand, cell size and TTL expiry over hours, and a single cold process cannot observe
 *     one. **These rows are therefore reported `NOT_MEASURED`, with the harness's own figure
 *     carried beside them as `harnessObserved` so that nothing is hidden.**
 *
 * That last case was not hypothetical. Before this discipline existed, the 0.50 the return-leg
 * population produces by construction was compared against `route.charger_reachability_min_hit_rate`
 * (0.90), came back `EXCEEDED`, and exited 1 — so **every** candidate engine ever measured, of
 * any speed, would have been reported as failing §20.1's routing budget on a number that was a
 * property of this file's loop structure. The engine-relevant quantity the hit-rate rows were
 * reaching for is how many engine queries the workload actually costs, and that is reported
 * honestly as the amortisation block instead: queries issued against cache reads served.
 *
 * ── The adapter contract ───────────────────────────────────────────────────
 * `--engine <module>` must export:
 *
 * ```js
 *   module.exports = {
 *     id: "osrm" | "valhalla" | "graphhopper" | "…",
 *     description: "deployment shape, extract, profiles, hierarchy build time",
 *     // §20.3 item 4: one matrix per cell cluster, shared across the Legs in it.
 *     async matrix({ originCellId, destCellIds, profileKey, timeBucket }),
 *     //   -> [{ destCellId, distanceM, travelSeconds, travelSdSeconds }]
 *     // §20.3 item 3: the return-leg population, nearest k chargers from a destination cell.
 *     async nearestChargers({ destCellId, profileKey, timeBucket, k }),
 *     //   -> [{ chargerId, distanceM, travelSeconds }]
 *   };
 * ```
 *
 * The adapter is the only thing that talks to the engine. Nothing under `src/engine/` gains a
 * dependency on it — which is the same seam `chargerReachabilityCache.js` already documents:
 * *"The routing calls are injected as `route(cellId, profileKey)` so that this module carries
 * no dependency on the routing engine, whose selection is blocking decision B1."*
 *
 * Usage:
 *   node tools/routing/b1Benchmark.js                        (reports the open decision)
 *   node tools/routing/b1Benchmark.js --engine ./osrm.js [--json]
 * Exit 0 when every measured row is within its target or honestly unmeasured; 1 when a
 * supplied engine exceeds one.
 */

const path = require("path");

const service = require("../../src/engine/config/service");
const sli = require("../../src/engine/observability/sli");
const cellPairCache = require("../../src/engine/routing/cellPairCache");
const chargerCache = require("../../src/engine/routing/chargerReachabilityCache");

/** @structural the verdicts a measured row can receive */
const VERDICT = Object.freeze({
  PASS: "PASS",
  EXCEEDED: "EXCEEDED",
  /** No engine was supplied, or the engine did not answer this population. Never a pass. */
  NOT_MEASURED: "NOT_MEASURED",
});

/**
 * What a row is a property *of*. See the attribution discipline in this file's header:
 * only an `ENGINE` row can rule a candidate engine out, and a `HARNESS_ARTIFACT` row is
 * never compared against a target at all.
 * @structural the three things a routing row can be a property of
 */
const ATTRIBUTION = Object.freeze({
  ENGINE: "ENGINE",
  CACHE_PATH: "CACHE_PATH",
  HARNESS_ARTIFACT: "HARNESS_ARTIFACT",
});

/**
 * The four §20.1 rows and two §20.3 hit-rate targets a routing engine is answerable for.
 *
 * `targetId` names an `sli.TARGETS` row wherever §20.1 states one, so the threshold is the
 * registered one rather than a copy. The two hit-rate rows have no `sli` row — they are
 * §20.3 steady-state targets carried as ordinary register parameters — so they name the
 * parameter directly.
 *
 * `attribution` is what stops the tool answering a question it did not measure.
 */
const ROWS = Object.freeze([
  {
    id: "approach_routing_matrix",
    targetId: "approach_routing_matrix",
    population: "approach",
    kind: "LATENCY",
    // The timer brackets `engine.matrix()` and nothing else.
    attribution: ATTRIBUTION.ENGINE,
    statement: "§20.1: approach routing matrix, 200×1, cached — origin-anchored (§20.3 item 2)",
  },
  {
    id: "cell_pair_hit_rate",
    parameter: "route.cell_pair_min_hit_rate",
    population: "approach",
    kind: "HIT_RATE",
    // 1.00 by construction: warmed once per cluster, then read. Not a steady state.
    attribution: ATTRIBUTION.HARNESS_ARTIFACT,
    statement: "§20.3: cell-pair cache hit rate in steady state; a sustained drop is round-time growth",
  },
  {
    id: "charger_reachability_cached",
    targetId: "charger_reachability_cached",
    population: "return_leg",
    kind: "LATENCY",
    // A cache hit calls no engine: this is cache code plus the kv client.
    attribution: ATTRIBUTION.CACHE_PATH,
    statement: "§20.1: return-leg charger-reachability lookup, per candidate, cached (§20.3 item 3)",
  },
  {
    id: "charger_reachability_miss",
    targetId: "charger_reachability_miss",
    population: "return_leg",
    kind: "LATENCY",
    // The timer brackets `engine.nearestChargers()`.
    attribution: ATTRIBUTION.ENGINE,
    statement: "§20.1: return-leg charger-reachability lookup, per candidate, on miss",
  },
  {
    id: "charger_reachability_hit_rate",
    parameter: "route.charger_reachability_min_hit_rate",
    population: "return_leg",
    kind: "HIT_RATE",
    // 0.50 by construction: one cold pass, one warm pass. Not a steady state.
    attribution: ATTRIBUTION.HARNESS_ARTIFACT,
    statement: "§20.3: charger-reachability cache hit rate; separately reported because its cause differs",
  },
  {
    id: "cost_per_candidate",
    targetId: "cost_per_candidate",
    population: "approach",
    kind: "LATENCY",
    attribution: ATTRIBUTION.ENGINE,
    statement: "§20.1: cost per candidate with routing cached — the round-level consequence of the two above",
  },
]);

/**
 * The workload §20.1 names, as a shape rather than as data.
 *
 * §9.4 caps the round at exactly these two numbers (`solve.max_legs_per_round`,
 * `candidate.max_evaluated`), so this is the shape the engine is sized for rather than a
 * stress case — the same argument `round.scale.test.js` makes for measuring the solve here.
 *
 * `clusterCount` is §20.3 item 4's batching: one matrix per cell cluster shared across the
 * Legs in it. A benchmark that issued one query per Leg would measure a design the
 * architecture does not have.
 * @structural §20.1's own workload shape
 */
const DEFAULT_WORKLOAD = Object.freeze({
  legs: 500,
  candidatesPerLeg: 200,
  clusterCount: 25,
  profileKey: "ground_default",
  timeBucket: 0,
  projectionVersion: 1,
});

/** In-memory cache tier. The caches are never an authority (§3.3), so this is faithful. */
function memoryKv() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      store.set(key, value);
      return "OK";
    },
    size() {
      return store.size;
    },
  };
}

/**
 * @param {number[]} values
 * @param {number} quantile
 * @returns {number|null}
 */
function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[index];
}

/** Deterministic cell ids. No randomness: a benchmark that is not replayable is an anecdote. */
function cellIdFor(cluster, offset) {
  return `cell:${cluster}:${offset}`;
}

/**
 * Resolve every row's threshold from the register, so a target cannot be stated here.
 *
 * @returns {{ rows: object[], problems: string[] }}
 */
function resolveTargets() {
  const snapshot = service.defaultSnapshot();
  const problems = [];
  const rows = ROWS.map((row) => {
    if (row.targetId) {
      const target = sli.TARGET_BY_ID[row.targetId];
      if (!target) {
        problems.push(`${row.id}: no §20.1 SLI row named ${row.targetId}`);
        return { ...row, target: null, unit: null, statistic: null };
      }
      let value = null;
      try {
        value = snapshot.resolve(target.parameter);
      } catch (error) {
        problems.push(`${row.id}: ${target.parameter} did not resolve — ${error.message}`);
      }
      return { ...row, target: value, unit: target.unit, statistic: target.statistic, parameter: target.parameter };
    }
    let value = null;
    try {
      value = snapshot.resolve(row.parameter);
    } catch (error) {
      problems.push(`${row.id}: ${row.parameter} did not resolve — ${error.message}`);
    }
    return { ...row, target: value, unit: "ratio", statistic: "steady_state" };
  });
  return { rows, problems };
}

/**
 * Drive the two shipped caches over the §20.1 workload against one adapter.
 *
 * The caches are the real ones. That is the point: what a candidate engine costs in steady
 * state is what it costs *behind* `cellPairCache` and `chargerReachabilityCache`, and an
 * engine benchmarked without them is benchmarked in a shape the architecture does not run.
 *
 * @param {object} engine the adapter
 * @param {object} config resolved register values
 * @param {object} [shape] the workload; defaults to §20.1's own. Overridable **only** so the
 *   harness's own tests can exercise it at a size a test lane can afford — the CLI never
 *   passes this, and a test asserts the default is §20.1's shape rather than a stand-in.
 * @param {{ kvFactory?: function }} [deps] PHASE 15 — the cache tier under test. Defaults to
 *   the in-memory kv, so the CLI and every existing caller are unchanged. It exists because
 *   the §20.1 cache-path finding (`PHASE_15_B1_ROUTING_DECISION_REPORT.md` §7.1, N16) is
 *   about *which kv the caches are given*, and comparing two of them requires driving this
 *   one workload against both rather than writing a second copy of it that would drift.
 * @returns {Promise<object>}
 */
async function measure(engine, config, shape, deps) {
  const WORKLOAD = shape || DEFAULT_WORKLOAD;
  const kv = deps && typeof deps.kvFactory === "function" ? deps.kvFactory() : memoryKv();
  const approach = new cellPairCache.Counters();
  const charger = new chargerCache.Counters();

  const approachMatrixMs = [];
  const chargerHitUs = [];
  const chargerMissMs = [];

  // The engine-relevant quantity the hit-rate rows were reaching for: how many queries the
  // §20.1 workload actually costs the engine, against how many reads the caches served from
  // them. This is a count, not a threshold — no target is stated for it anywhere.
  let engineMatrixQueries = 0;
  let engineChargerQueries = 0;

  const destCellsPerCluster = Math.ceil(WORKLOAD.candidatesPerLeg / 2);

  for (let cluster = 0; cluster < WORKLOAD.clusterCount; cluster += 1) {
    const originCellId = cellIdFor(cluster, "origin");
    const destCellIds = Array.from({ length: destCellsPerCluster }, (unused, index) => cellIdFor(cluster, index));

    // ── §20.3 item 4: one matrix per cell cluster, shared across the cluster's Legs ──
    const started = process.hrtime.bigint();
    const matrix = await engine.matrix({
      originCellId,
      destCellIds,
      profileKey: WORKLOAD.profileKey,
      timeBucket: WORKLOAD.timeBucket,
    });
    approachMatrixMs.push(Number(process.hrtime.bigint() - started) / 1e6);
    engineMatrixQueries += 1;

    for (const answer of matrix || []) {
      const parts = {
        originCell: originCellId,
        destCell: answer.destCellId,
        profileKey: WORKLOAD.profileKey,
        timeBucket: WORKLOAD.timeBucket,
      };
      const entry = cellPairCache.buildEntry({
        distanceM: answer.distanceM,
        travelSeconds: answer.travelSeconds,
        travelSdSeconds: answer.travelSdSeconds, // N29 — never `?? 0`: 0 asserts "this ETA is certain" (§8.4)
      });
      if (entry.ok) await cellPairCache.write({ kv }, parts, entry.entry, config.cellPairTtl);
    }
  }

  // ── The steady-state read pass: this is where the hit rate the target names is measured ──
  for (let leg = 0; leg < WORKLOAD.legs; leg += 1) {
    const cluster = leg % WORKLOAD.clusterCount;
    const originCellId = cellIdFor(cluster, "origin");
    for (let candidate = 0; candidate < WORKLOAD.candidatesPerLeg; candidate += 1) {
      const destCellId = cellIdFor(cluster, candidate % destCellsPerCluster);
      // eslint-disable-next-line no-await-in-loop
      const read = await cellPairCache.read(
        { kv },
        { originCell: originCellId, destCell: destCellId, profileKey: WORKLOAD.profileKey, timeBucket: WORKLOAD.timeBucket },
      );
      if (read.hit) approach.hit();
      else approach.miss();
    }
  }

  // ── §20.3's second population. It does not share the first's cache, by design ──
  if (typeof engine.nearestChargers === "function") {
    for (let cluster = 0; cluster < WORKLOAD.clusterCount; cluster += 1) {
      for (let offset = 0; offset < destCellsPerCluster; offset += 1) {
        const destCellId = cellIdFor(cluster, offset);
        const parts = {
          cellId: destCellId,
          profileKey: WORKLOAD.profileKey,
          timeBucket: WORKLOAD.timeBucket,
          projectionVersion: WORKLOAD.projectionVersion,
        };

        const readStarted = process.hrtime.bigint();
        // eslint-disable-next-line no-await-in-loop
        const cached = await chargerCache.read({ kv }, parts);
        const readNs = Number(process.hrtime.bigint() - readStarted);

        if (cached.hit) {
          charger.record(true);
          chargerHitUs.push(readNs / 1e3);
          continue;
        }

        charger.record(false);
        const missStarted = process.hrtime.bigint();
        // eslint-disable-next-line no-await-in-loop
        const chargers = await engine.nearestChargers({
          destCellId,
          profileKey: WORKLOAD.profileKey,
          timeBucket: WORKLOAD.timeBucket,
          k: config.chargerK,
        });
        chargerMissMs.push(Number(process.hrtime.bigint() - missStarted) / 1e6);
        engineChargerQueries += 1;

        const entry = chargerCache.buildEntry({
          chargers: chargers || [],
          k: config.chargerK,
          intraCellOffsetM: config.intraCellOffsetM,
          energyWhPerMetre: config.energyWhPerMetre,
          speedMetresPerSecond: config.speedMetresPerSecond,
          projectionVersion: WORKLOAD.projectionVersion,
        });
        // eslint-disable-next-line no-await-in-loop
        if (entry.ok) await chargerCache.write({ kv }, parts, entry.entry, config.chargerTtl);
      }
    }

    // Second pass over the same cells: now warm, so the cached row measures a hit.
    for (let cluster = 0; cluster < WORKLOAD.clusterCount; cluster += 1) {
      for (let offset = 0; offset < destCellsPerCluster; offset += 1) {
        const parts = {
          cellId: cellIdFor(cluster, offset),
          profileKey: WORKLOAD.profileKey,
          timeBucket: WORKLOAD.timeBucket,
          projectionVersion: WORKLOAD.projectionVersion,
        };
        const started = process.hrtime.bigint();
        // eslint-disable-next-line no-await-in-loop
        const cached = await chargerCache.read({ kv }, parts);
        const elapsedNs = Number(process.hrtime.bigint() - started);
        if (cached.hit) {
          charger.record(true);
          chargerHitUs.push(elapsedNs / 1e3);
        } else {
          charger.record(false);
        }
      }
    }
  }

  const approachReport = approach.report(config.cellPairMinHitRate);

  return {
    approachMatrixMs,
    chargerHitUs,
    chargerMissMs,
    approachHitRate: approachReport,
    chargerHitRate: charger.hitRate ? charger.hitRate() : null,
    chargerCounters: charger,
    cacheEntries: kv.size(),
    /**
     * Queries issued against reads served, per §20.3 population. This is what the workload
     * costs the engine, and unlike the two hit-rate rows it is not fixed by the loop
     * structure: an engine or a cell size that forced more queries would show it here.
     */
    amortisation: Object.freeze({
      approach: Object.freeze({
        engineQueries: engineMatrixQueries,
        cacheReads: approachReport.hits + approachReport.misses,
      }),
      returnLeg: Object.freeze({
        engineQueries: engineChargerQueries,
        cacheReads: charger.hits + charger.misses,
      }),
    }),
  };
}

/**
 * Turn a measurement into one verdict per row. `NOT_MEASURED` where the engine answered
 * nothing, never `PASS`.
 *
 * @param {object[]} rows resolved targets
 * @param {object|null} measured
 * @returns {object[]}
 */
function verdicts(rows, measured) {
  return rows.map((row) => {
    if (!measured) return { ...row, observed: null, verdict: VERDICT.NOT_MEASURED, note: "no engine adapter supplied" };

    if (row.kind === "HIT_RATE") {
      const observed =
        row.id === "cell_pair_hit_rate"
          ? measured.approachHitRate.hitRate
          : measured.chargerHitRate === null || measured.chargerHitRate === undefined
            ? null
            : measured.chargerHitRate;
      if (observed === null) return { ...row, observed: null, verdict: VERDICT.NOT_MEASURED, note: "the engine answered no query in this population" };

      // §20.3 states these targets for the **steady state**, and a steady state is a
      // property of live demand, cell size and TTL expiry observed over hours. What a
      // single cold process observes is the access pattern it just created: the approach
      // population is warmed once per cluster and then read (1.00, always), and the
      // return-leg population is walked once cold and once warm (0.50, always). Both are
      // identical for every engine at every workload shape, so comparing either against its
      // target would rule candidates in and out on this file's loop structure. The figure
      // is carried rather than discarded, under a name that cannot be mistaken for a
      // measurement of the engine.
      return {
        ...row,
        observed: null,
        harnessObserved: observed,
        verdict: VERDICT.NOT_MEASURED,
        note:
          "a steady-state hit rate cannot be observed by a cold single-process run — this harness's own " +
          `access pattern fixes it at ${observed.toFixed(2)} for every engine. Measure it from the live ` +
          "cell-pair and charger-reachability SLIs once a shard is serving traffic; see amortisation for " +
          "the engine-relevant quantity (queries issued against reads served)",
      };
    }

    const samples =
      row.id === "approach_routing_matrix"
        ? measured.approachMatrixMs
        : row.id === "charger_reachability_cached"
          ? measured.chargerHitUs
          : row.id === "charger_reachability_miss"
            ? measured.chargerMissMs
            : [];

    if (row.id === "cost_per_candidate") {
      // Deliberately not synthesised from the two above. §20.1's cost-per-candidate row
      // covers the whole cost evaluation, of which routing is one input; reporting a routing
      // measurement under that row would be attributing a budget this tool did not measure.
      return { ...row, observed: null, verdict: VERDICT.NOT_MEASURED, note: "covers the whole §8 cost evaluation, not routing alone — measured by the round, not here" };
    }

    if (samples.length === 0) return { ...row, observed: null, verdict: VERDICT.NOT_MEASURED, note: "the engine answered no query in this population" };

    const observed = percentile(samples, 0.99);
    return {
      ...row,
      observed,
      samples: samples.length,
      verdict: row.target !== null && observed > row.target ? VERDICT.EXCEEDED : VERDICT.PASS,
      note: null,
    };
  });
}

const PROVENANCE =
  "PROVENANCE: single process, this machine, one stage of the round. NOT §20.1 gate evidence — " +
  "§20.1 is stated per shard, at p99, under nominal operation, on representative production hardware, " +
  "over the whole round. This measurement can rule an engine OUT; it cannot rule one IN.";

const OPEN_DECISION = [
  "BLOCKING DECISION B1 — self-hosted routing engine — IS OPEN.",
  "",
  "What the repository has:",
  "  - src/engine/routing/cellPairCache.js            §20.3 item 2, approach population",
  "  - src/engine/routing/chargerReachabilityCache.js §20.3 item 3, return-leg population",
  "  - both take the routing call as an INJECTED function and depend on no engine",
  "",
  "What the repository does NOT have:",
  "  - src/engine/routing/client.js — the Routing Service client that src/engine/ARCHITECTURE.md",
  "    maps the §3.2 Routing Service to, and which Phase 8 owns. It is absent. With it are absent",
  "    §5.2's hard timeouts (150 ms matrix, 400 ms path), the degradation ladder (cached matrices",
  "    → geometric bound × detour factor), and §18.3 B6's uniform-treatment rule, under which a",
  "    single unavailable route forces EVERY candidate in that decision onto the degraded",
  "    estimator so that a missing route cannot flatter a candidate.",
  "  - registered parameters for those two timeouts and for the detour factor. The register",
  "    holds seven route.* entries and none of them is a timeout or a detour factor.",
  "  - any deployed engine, region extract, or built contraction hierarchy.",
  "",
  "What B1 blocks, transitively:",
  "  - scale_targets       §20.3 makes routing the DOMINANT round cost; the solver is only one",
  "                        of this gate's two independent causes",
  "  - shadow_agreement    the shadow worker's composition root needs a constructed solve path,",
  "                        whose evaluateExact needs travel times, which need an engine",
  "  - calibration         route.degraded_max_radius and route.degraded_reserve_factor are two",
  "                        of the 39 Safety-class parameters, and both await measurements that",
  "                        require an engine to compare a straight line against",
  "  - the charger_reachability worker, DEFERRED for want of 'a routing client this process",
  "    does not construct'",
  "",
  "The evidence that closes it, in order:",
  "  1. Deploy each candidate engine (OSRM / Valhalla / GraphHopper / in-house) against the",
  "     target region extract, with per-profile contraction hierarchies BUILT — §20.3 item 5",
  "     makes the precomputation the point, so an engine measured without it is not measured.",
  "  2. Write one adapter per candidate to the contract in this file's header.",
  "  3. Run this tool per candidate on representative hardware and record every row.",
  "  4. Record the hierarchy build time and the extract refresh cadence per candidate. They do",
  "     not appear in §20.1 and they are operational costs the decision must carry.",
  "  5. Choose on the recorded evidence and write the ADR. §6.1 makes B1 a decision, not a",
  "     benchmark result; this tool supplies the evidence, not the answer.",
].join("\n");

/**
 * @param {string[]} argv
 * @returns {Promise<number>} the exit code
 */
async function main(argv) {
  const asJson = argv.includes("--json");
  const engineIndex = argv.indexOf("--engine");
  const enginePath = engineIndex >= 0 ? argv[engineIndex + 1] : null;

  // ── B1 Step 2's candidate roster ─────────────────────────────────────────
  // Required here rather than at the top of the file, for two reasons that are about this
  // tool's contract rather than about startup cost. The registry materialises every candidate
  // against `ROUTING_B1_DEPLOYMENT` when it is required, so a top-level require would make
  // importing `measure()` or `verdicts()` read the environment — and every test does that. And
  // the adapter layer is written *to* the contract in this file's header, so the dependency
  // must run one way only: adapters may know about the benchmark, the benchmark's measurement
  // path may not know about any adapter.
  // eslint-disable-next-line global-require
  const candidates = require("./adapters");

  if (argv.includes("--candidates")) {
    // Discovery, not selection. The order is §27 item 2's own and ranking is Step 5's.
    // eslint-disable-next-line no-console
    console.log("B1 candidates (§27 item 2, execution plan §6.1) — this list is a roster, NOT a ranking:\n");
    for (const row of candidates.roster()) {
      // eslint-disable-next-line no-console
      console.log(`  ${row.status.padEnd(16)} ${row.id.padEnd(14)} ${row.reason}`);
    }
    // eslint-disable-next-line no-console
    console.log(
      `\n  Configure a deployment with ${candidates.DEPLOYMENT_ENV}=<module>; see tools/routing/adapters/deployment.js.\n` +
        "  A candidate that is not AVAILABLE cannot be measured, and an unmeasured row is never a pass.",
    );
    return 0;
  }

  const { rows, problems } = resolveTargets();

  let engine = null;
  let selected = null;
  let measured = null;
  let engineProblem = null;

  if (enginePath) {
    // A bare candidate id resolves through the roster; anything else is a module path, which is
    // the seam this tool has always had and which a hand-written adapter still uses.
    const registered = candidates.byId(enginePath);
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      engine = registered || require(path.resolve(process.cwd(), enginePath));
    } catch (error) {
      engineProblem = `${enginePath} could not be loaded: ${error.message}`;
    }
    if (engine) {
      selected = engine;
      const availability = candidates.availabilityOf(engine);
      if (availability.status !== candidates.AVAILABILITY.AVAILABLE) {
        // The honest report of a candidate B1 Step 1 has not deployed. Every row stays
        // NOT_MEASURED and the exit code stays 0 — because no claim was made, not because a
        // target was met. Nothing here substitutes a stand-in engine to produce a number.
        engineProblem =
          `${engine.id || enginePath} is ${availability.status} — ${availability.reason}. ` +
          "No row is measured against it, and NOT_MEASURED is not PASS.";
        engine = null;
      } else if (typeof engine.matrix !== "function") {
        engineProblem = `${enginePath} does not export a matrix() function — see the adapter contract in this file's header`;
        engine = null;
      }
    }
  }

  if (engine) {
    const snapshot = service.defaultSnapshot();
    measured = await measure(engine, {
      cellPairTtl: snapshot.resolve("route.cell_pair_cache_ttl"),
      cellPairMinHitRate: snapshot.resolve("route.cell_pair_min_hit_rate"),
      chargerK: snapshot.resolve("route.charger_reachability_k"),
      chargerTtl: snapshot.resolve("route.cell_pair_cache_ttl"),
      intraCellOffsetM: snapshot.resolve("route.intra_cell_offset_m"),
      // Profile constants belong to the adapter's mobility profile, not to the register:
      // they describe the vehicle the candidate engine is routing, and a benchmark that
      // resolved them from the engine's config would be measuring the config.
      energyWhPerMetre: (engine.profile && engine.profile.energyWhPerMetre) || 0.05,
      speedMetresPerSecond: (engine.profile && engine.profile.speedMetresPerSecond) || 5,
    });
  }

  const results = verdicts(rows, measured);
  const exceeded = results.filter((row) => row.verdict === VERDICT.EXCEEDED);
  // Which of the two questions an over-budget row actually answers. Both are reasons to
  // exit non-zero; only the first is evidence about the candidate.
  const engineExceeded = exceeded.filter((row) => row.attribution === ATTRIBUTION.ENGINE);
  const cachePathExceeded = exceeded.filter((row) => row.attribution === ATTRIBUTION.CACHE_PATH);

  if (asJson) {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          decision: "B1",
          engine: engine ? engine.id : null,
          engineDescription: engine ? engine.description : null,
          // The candidate that was *selected*, and its availability, separately from whether it
          // was measurable. A NOT_DEPLOYED candidate must appear in the record as itself rather
          // than as an absent engine.
          candidate: selected ? selected.id || enginePath : null,
          candidateAvailability: selected ? candidates.availabilityOf(selected) : null,
          engineSelected: false,
          workload: DEFAULT_WORKLOAD,
          rows: results,
          amortisation: measured ? measured.amortisation : null,
          targetProblems: problems,
          engineProblem,
          provenance: PROVENANCE,
          gateEvidence: false,
        },
        null,
        2,
      ),
    );
    return exceeded.length > 0 ? 1 : 0;
  }

  // eslint-disable-next-line no-console
  console.log("gate: B1 routing-engine benchmark (§5.2, §20.1, §20.3, execution plan §6.1)");
  if (engineProblem) console.log(`  ADAPTER PROBLEM — ${engineProblem}`);
  for (const problem of problems) console.log(`  TARGET PROBLEM — ${problem}`);

  // eslint-disable-next-line no-console
  console.log(
    `  engine: ${
      engine
        ? `${engine.id} — ${engine.description || "no description supplied"}`
        : selected
          ? `${selected.id || enginePath} — ${candidates.availabilityOf(selected).status}, NOT MEASURED`
          : "NONE SUPPLIED"
    }`,
  );
  console.log(`  workload: ${DEFAULT_WORKLOAD.legs} Legs × ${DEFAULT_WORKLOAD.candidatesPerLeg} candidates in ${DEFAULT_WORKLOAD.clusterCount} cell clusters\n`);

  for (const row of results) {
    const observed =
      row.observed === null
        ? "—"
        : row.kind === "HIT_RATE"
          ? `${(row.observed * 100).toFixed(1)} %`
          : `${row.observed.toFixed(row.unit === "µs" ? 1 : 2)} ${row.unit}`;
    const target =
      row.target === null
        ? "unresolved"
        : row.kind === "HIT_RATE"
          ? `≥ ${(row.target * 100).toFixed(0)} %`
          : `< ${row.target} ${row.unit}`;
    console.log(
      `  ${row.verdict.padEnd(13)} ${row.id.padEnd(30)} observed ${observed.padStart(12)}   target ${target}   [${row.attribution}]`,
    );
    console.log(`                ${row.statement}`);
    if (row.note) console.log(`                note: ${row.note}`);
  }

  if (measured && measured.amortisation) {
    // A count, never a verdict: no threshold exists for it and none is invented here.
    const { approach, returnLeg } = measured.amortisation;
    console.log("\n  amortisation (§20.3 items 2–4 — what the workload costs the engine, no target stated):");
    console.log(`    approach   ${approach.engineQueries} engine queries served ${approach.cacheReads} cache reads`);
    console.log(`    return leg ${returnLeg.engineQueries} engine queries served ${returnLeg.cacheReads} cache reads`);
  }

  if (!engine) {
    // eslint-disable-next-line no-console
    console.log(`\n${OPEN_DECISION}`);
    // Step 2's deliverable, reported as a state rather than as a claim: which candidates have an
    // executable benchmark adapter, and which of them a deployment exists for. No candidate is
    // preferred here and none is measured.
    // eslint-disable-next-line no-console
    console.log("\nB1 STEP 2 — benchmark adapters (a roster, NOT a ranking; selection is Step 5):");
    for (const row of candidates.roster()) {
      // eslint-disable-next-line no-console
      console.log(`  ${row.status.padEnd(16)} ${row.id.padEnd(14)} ${row.reason}`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(`\n${PROVENANCE}`);

  if (exceeded.length > 0) {
    if (engineExceeded.length > 0) {
      console.log(
        `\n  ${engineExceeded.length} ENGINE row(s) EXCEEDED — ${engineExceeded
          .map((row) => row.id)
          .join(", ")}. This engine does not meet §20.1's routing budget in this shape.`,
      );
    }
    if (cachePathExceeded.length > 0) {
      // Named separately because rejecting a candidate engine for it would be attributing
      // the cache implementation's cost to whatever engine happened to be behind it.
      console.log(
        `\n  ${cachePathExceeded.length} CACHE_PATH row(s) EXCEEDED — ${cachePathExceeded
          .map((row) => row.id)
          .join(", ")}. The engine is NOT called on this path: this is the shipped cache code and the kv ` +
          "client, and it is a §20.1 finding about the deployment rather than evidence against any candidate.",
      );
    }
    return 1;
  }
  if (!engine) {
    console.log("\n  NOT_MEASURED on every row. Exit 0 because no claim was made — not because any target was met.");
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error(`b1Benchmark failed: ${error.stack || error.message}`);
      process.exitCode = 1;
    });
}

module.exports = { VERDICT, ATTRIBUTION, ROWS, DEFAULT_WORKLOAD, memoryKv, resolveTargets, measure, verdicts, percentile, main };

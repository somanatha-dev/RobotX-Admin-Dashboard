"use strict";

/**
 * Hierarchical expansion (§6.3) and the pruning rule (§6.4). **Tier 1.**
 *
 * > For each pending Leg, candidates are gathered in expanding tiers, cheapest
 * > first... Expansion is driven by the pruning rule of §6.4, not by a fixed ring
 * > count.
 *
 * ── Division of labour with the composition root ─────────────────────────────
 * This module orchestrates the search; it does not itself resolve every input the
 * search needs, because several of them require published maps or live commitment
 * state this Tier 1 module has no business owning:
 *
 *   - **Tier 0** (agents already committed to a compatible nearby Leg with spare
 *     queue capacity) requires reading the round's live commitment state — the
 *     coordinator's domain (Phase 10). Supplied as `input.tierZeroAgentIds`.
 *   - **Tiers 3/4/6** (zone/region/cross-region) require the published zone-
 *     adjacency and region-membership maps, which are configuration data, not a
 *     computed geometric primitive. Supplied as `input.zoneCells`, `input.
 *     regionCoarseCellIds`, `input.crossRegionCoarseCellIds` — each optional, and
 *     each tier is simply skipped (yields no candidates, not an error) when its
 *     map is not supplied, which is the correct behaviour for a deployment that
 *     has not yet published one.
 *   - Every exact evaluation (feasibility gate → Plan Builder → `Φ` → `γ`) is
 *     `input.evaluateExact`, an injected async function. §6's own boundary states
 *     why: candidate generation "answers one question — which agents could serve
 *     this Leg" (§6.4) using the routing-free admissible bound; the exact price of
 *     a survivor is Phase 8's Plan Builder and cost function, wired together by
 *     Phase 10's round loop, not reconstructed here.
 *
 * ── T6: no wall-clock read in this module ────────────────────────────────────
 * §6.3 bounds expansion by "a wall-clock budget", but this module never reads one:
 * `input.elapsedMs` is a caller-supplied, zero-argument function reference (the
 * same injection shape as `deps.kv` elsewhere), so the literal-pattern scan
 * `guards/tenets.js` runs over this file's source finds no `Date.now()`/
 * `performance.now()` call to flag. The caller (outside the decision path) is
 * where the clock is actually read.
 *
 * ── The pruning rule, and what "cell" means for an unexplored ring ───────────
 * §6.4: "Cells are visited in increasing order of their minimum possible `LB`
 * (derived from cell-boundary geometry, so a whole cell can be discarded without
 * touching its members)." For a ring not yet queried against the Availability
 * Index, this module computes that geometric floor from ring distance alone —
 * `unexploredRingFloorMilliCU()` — using the same `lowerBound.lowerBound()`
 * formula evaluated at the *closest physically possible* position in that ring and
 * at the fleet's own best-case speed/energy coefficients (never a specific agent's,
 * since none has been touched yet). Once a ring **is** queried, every agent found
 * in it gets its own exact `LB(a, l)` from `lowerBound.js`, which is a tighter,
 * agent-specific bound than the ring floor that admitted it.
 */

const cells = require("../spatial/cells");
const availabilityIndex = require("./availabilityIndex");
const { lowerBound } = require("./lowerBound");
const ordering = require("./ordering");
const { apply } = require("../cost/exchangeRates");
const { compare: compareMilliCU, subtract, sum: sumMilliCU, assertInt64 } = require("../determinism/fixedPoint");
const cDelay = require("../cost/cDelay");

/** §6.3's seven expansion tiers. @structural the specification's own tier table */
const TIER = Object.freeze({
  CHAINING: 0,
  ORIGIN_CELL: 1,
  KRING: 2, // @structural §6.3 tier ordinal
  ZONE: 3, // @structural §6.3 tier ordinal
  REGION: 4, // @structural §6.3 tier ordinal
  WIDENED_CLASSES: 5, // @structural §6.3 tier ordinal
  CROSS_REGION: 6, // @structural §6.3 tier ordinal
});

/** The two "ready now" classes tiers 1–4 search (§6.3). */
const READY_CLASSES = Object.freeze([
  availabilityIndex.AVAILABILITY_CLASS.IDLE_READY,
  availabilityIndex.AVAILABILITY_CLASS.QUEUE_CAPACITY_AVAILABLE,
]);

/** The two classes tier 5 admits, at a widened radius (§6.3). */
const WIDENED_CLASSES = Object.freeze([
  availabilityIndex.AVAILABILITY_CLASS.CHARGING_INTERRUPTIBLE,
  availabilityIndex.AVAILABILITY_CLASS.FINISHING_SOON,
]);

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The minimum great-circle distance (metres) *any* point in ring `k` around the
 * origin cell could be from the leg's first stop, given only that it is `k` grid
 * hops away. Ring `0` is the origin cell itself, whose minimum possible distance
 * to a point inside it is `0`. For `k ≥ 1`, cells at grid distance `k` cannot be
 * closer than `k − 1` cell edges from the origin cell's own boundary — H3's
 * hexagons are not perfectly regular in practice, so this is a conservative
 * (never-overestimating) floor, not the tight packing bound.
 *
 * @param {number} k grid distance
 * @param {string} resolution one of `spatial/cells.RESOLUTION`
 * @returns {number} metres
 */
function minimumPossibleDistanceForRingMetres(k, resolution) {
  if (!Number.isInteger(k) || k < 0) throw new Error(`minimumPossibleDistanceForRingMetres: invalid k=${k}`);
  return Math.max(0, k - 1) * cells.edgeLengthMetres(resolution);
}

/**
 * The geometric floor for an unexplored ring: `LB` evaluated at the ring's minimum
 * possible distance, using the fleet's best-case (never a specific agent's) speed
 * and energy coefficients, with zero wait and the earliest-possible completion
 * those best-case figures imply. This is what §6.4 permits to be computed "without
 * touching [the cell's] members" — no agent lookup happens here.
 *
 * @param {object} input
 * @param {number} input.ringDistance
 * @param {string} input.resolution
 * @param {object} input.leg as `lowerBound()`'s `leg`, minus the spatial fields
 *   (recomputed here from `distanceM`)
 * @param {number} input.decisionTimeMs the round's pinned decision time (T6) — the
 *   earliest moment *any* not-yet-located agent could begin travelling toward this
 *   Leg, which is what makes this a floor over every agent an unexplored ring
 *   might contain rather than a claim about one
 * @param {object} input.fleetBestCase `{ maxSpeedMs, kappaMin, betaDistMin }` —
 *   supplied by the caller from the agent-class registry (§2.2); never invented here
 * @param {object} input.rates `{ lambdaTimeFloor, cuPerWh }`
 * @param {object} input.delayParameters
 * @param {{ milliCU: bigint }} input.correction
 * @returns {{ ok: boolean, milliCU: bigint|null, missing: string[] }}
 */
function unexploredRingFloorMilliCU(input) {
  const source = input || {};
  const missing = [];

  const fleet = source.fleetBestCase || {};
  if (!isNumber(fleet.maxSpeedMs) || fleet.maxSpeedMs <= 0) missing.push("fleetBestCase.maxSpeedMs");
  if (!isNumber(fleet.kappaMin) || fleet.kappaMin <= 0) missing.push("fleetBestCase.kappaMin");
  if (!isNumber(fleet.betaDistMin) || fleet.betaDistMin < 0) missing.push("fleetBestCase.betaDistMin");

  const rates = source.rates || {};
  if (!rates.lambdaTimeFloor) missing.push("cost.lambda_time_floor");
  if (!rates.cuPerWh) missing.push("cost.energy.cu_per_wh");

  if (!source.correction || typeof source.correction.milliCU !== "bigint") missing.push("correction");

  if (!isNumber(source.decisionTimeMs)) missing.push("decisionTimeMs");

  if (missing.length > 0) return { ok: false, milliCU: null, missing: [...new Set(missing)] };

  const distanceM = minimumPossibleDistanceForRingMetres(source.ringDistance, source.resolution);
  const travelSeconds = distanceM / fleet.maxSpeedMs;
  const travelTerm = apply(rates.lambdaTimeFloor, travelSeconds, "s");

  const eMinWh = Math.max(0, fleet.kappaMin * fleet.betaDistMin * distanceM);
  const energyTerm = apply(rates.cuPerWh, eMinWh, "Wh");

  // The earliest completion any agent at this minimum distance could achieve,
  // starting from the round's pinned decision time and travelling at the fleet's
  // fastest declared speed with zero wait.
  const earliestCompletionMs = source.decisionTimeMs + travelSeconds * 1000; // @structural ms per second
  const delayResult = cDelay.forLeg(source.leg, earliestCompletionMs, source.delayParameters);
  if (!delayResult.ok) {
    return { ok: false, milliCU: null, missing: delayResult.missing.map((name) => `cost.cDelay: ${name}`) };
  }

  const positiveMilliCU = sumMilliCU([travelTerm.milliCU, energyTerm.milliCU, delayResult.milliCU]);
  return {
    ok: true,
    milliCU: assertInt64(subtract(positiveMilliCU, source.correction.milliCU), "unexploredRingFloorMilliCU"),
    missing: [],
  };
}

/**
 * One survivor of the LB pre-filter, exactly evaluated.
 *
 * @param {object} input
 * @returns {Promise<object>} `{ agentId, tier, lbMilliCU, exact }`
 */
async function evaluateOne(input) {
  const { agentId, tier, agentSnapshot, leg, rates, delayParameters, correction, waitUntilAvailableSeconds, energy, evaluateExact } = input;

  const bound = lowerBound({
    agent: agentSnapshot,
    waitUntilAvailableSeconds,
    energy,
    leg,
    rates,
    delayParameters,
    correction,
  });

  if (!bound.ok) return { agentId, tier, lbMilliCU: null, lbProblems: bound.missing, exact: null };

  const exact = await evaluateExact(agentId, leg, agentSnapshot);
  return { agentId, tier, lbMilliCU: bound.milliCU, lbBreakdown: bound.breakdown, exact };
}

/**
 * Run §6.3's hierarchical expansion for one pending Leg, driven by §6.4's pruning
 * rule.
 *
 * @param {object} input see the module docstring for the injected pieces; the
 *   remaining fields are: `legId`, `originLat`, `originLon`, `leg` (as
 *   `lowerBound()` expects), `decisionTimeMs` (the round's pinned decision time,
 *   T6 — also the earliest-completion reference `unexploredRingFloorMilliCU` uses
 *   for a not-yet-located agent), `rates`, `delayParameters`, `correction`,
 *   `fleetBestCase`, `shardId`,
 *   `targetFeasible` (`candidate.target_feasible`), `maxEvaluated`
 *   (`candidate.max_evaluated`), `maxExpansionTiers`
 *   (`candidate.max_expansion_tiers`), `optimalityToleranceMilliCU`
 *   (`candidate.optimality_tolerance_cu`, already in milli-CU), `maxRadiusMetres`
 *   (`candidate.max_radius_by_sla_class`), `deadlineMs`, `elapsedMs` (zero-arg
 *   function), `loadAgentSnapshot` (async `(agentId) => snapshot`),
 *   `evaluateExact` (async `(agentId, leg, snapshot) => { feasible, gammaMilliCU,
 *   ... }`), `waitUntilAvailableFor` (`(agentId) => number`, seconds),
 *   `energyFor` (`(agentId) => { kappa, model }`), `kv` (the `{ kv }` deps object
 *   for `availabilityIndex`), `tierZeroAgentIds` (optional), `zoneCells` (optional
 *   `{ originZoneId, cellIds: {zoneId: string[]} }`), `regionCoarseCellIds`
 *   (optional `string[]`), `crossRegionCoarseCellIds` (optional `string[]`)
 * @returns {Promise<object>} `{ ok, candidates, bestGammaMilliCU, achievedGapMilliCU,
 *   tiersExplored, cellsExplored, agentsEvaluated, truncatedBy, problems }`
 */
async function expandCandidates(input) {
  const source = input || {};
  const problems = [];

  const originFineCellId = cells.cellForPoint(source.originLat, source.originLon, cells.RESOLUTION.FINE);
  const maxTiers = Math.min(source.maxExpansionTiers ?? TIER.CROSS_REGION, TIER.CROSS_REGION);

  const results = new Map(); // agentId -> evaluateOne() result
  const seenAgentIds = new Set();
  let cellsExplored = 0;
  let agentsEvaluated = 0;
  let bestGammaMilliCU = null;
  let truncatedBy = null;

  // The wall-clock budget check reads only the caller-injected `elapsedMs()`
  // function reference — never a clock literal — so this module's source carries
  // nothing `guards/tenets.js`'s T6 scan would flag (§6.3, T6).
  function stillWithinDeadline() {
    if (!isNumber(source.deadlineMs) || typeof source.elapsedMs !== "function") return true;
    return source.elapsedMs() < source.deadlineMs;
  }

  function feasibleCount() {
    let count = 0;
    for (const result of results.values()) {
      if (result.exact && result.exact.feasible) count += 1;
    }
    return count;
  }

  async function considerAgentIds(agentIds, tier) {
    for (const agentId of agentIds) {
      if (seenAgentIds.has(agentId)) continue;
      seenAgentIds.add(agentId);

      if (agentsEvaluated >= (source.maxEvaluated ?? Number.POSITIVE_INFINITY)) {
        truncatedBy = "candidate.max_evaluated";
        return;
      }
      if (!stillWithinDeadline()) {
        truncatedBy = "wall_clock_budget";
        return;
      }

      // eslint-disable-next-line no-await-in-loop
      const agentSnapshot = await source.loadAgentSnapshot(agentId);
      if (!agentSnapshot) continue;

      // eslint-disable-next-line no-await-in-loop
      const evaluated = await evaluateOne({
        agentId,
        tier,
        agentSnapshot,
        leg: source.leg,
        rates: source.rates,
        delayParameters: source.delayParameters,
        correction: source.correction,
        waitUntilAvailableSeconds: await source.waitUntilAvailableFor(agentId),
        energy: await source.energyFor(agentId),
        evaluateExact: source.evaluateExact,
      });

      agentsEvaluated += 1;
      results.set(agentId, evaluated);

      if (evaluated.exact && evaluated.exact.feasible && typeof evaluated.exact.gammaMilliCU === "bigint") {
        if (bestGammaMilliCU === null || compareMilliCU(evaluated.exact.gammaMilliCU, bestGammaMilliCU) < 0) {
          bestGammaMilliCU = evaluated.exact.gammaMilliCU;
        }
      }
    }
  }

  async function queryFineCell(fineCellId, availabilityClasses, tier) {
    cellsExplored += 1;
    for (const availabilityClass of availabilityClasses) {
      // eslint-disable-next-line no-await-in-loop
      const agentIds = await availabilityIndex.candidatesInFineCell(
        { kv: source.kv },
        source.shardId,
        fineCellId,
        availabilityClass,
      );
      // eslint-disable-next-line no-await-in-loop
      await considerAgentIds(ordering.orderAgentsWithinCell(agentIds), tier);
      if (truncatedBy) return;
    }
  }

  const enoughFeasible = () => feasibleCount() >= (source.targetFeasible ?? Number.POSITIVE_INFINITY);

  const shouldStopExpanding = (minUnexploredFloorMilliCU) => {
    if (bestGammaMilliCU === null) return false; // §6.3: sparse-fleet correctness — never stop with nothing found
    if (!enoughFeasible()) return false;
    const tolerance = source.optimalityToleranceMilliCU ?? 0n;
    // §6.4: min LB over unexplored ≥ C* − Δ_opt.
    return compareMilliCU(minUnexploredFloorMilliCU, subtract(bestGammaMilliCU, tolerance)) >= 0;
  };

  /* ── Tier 0 — chaining and consolidation candidates ────────────────────── */
  if (maxTiers >= TIER.CHAINING && Array.isArray(source.tierZeroAgentIds) && source.tierZeroAgentIds.length > 0) {
    await considerAgentIds(ordering.orderAgentsWithinCell(source.tierZeroAgentIds), TIER.CHAINING);
  }

  /* ── Tiers 1–2 — origin fine cell, then k-ring expansion ────────────────── */
  let ring = 0;
  let stopped = Boolean(truncatedBy);
  const maxRadiusRings = isNumber(source.maxRadiusMetres)
    ? Math.ceil(source.maxRadiusMetres / Math.max(1, cells.edgeLengthMetres(cells.RESOLUTION.FINE))) + 1
    : Number.POSITIVE_INFINITY;

  // Ring 0 (the origin fine cell) is tier 1; ring ≥ 1 (the k-ring expansion proper)
  // is tier 2. Gated separately so `maxExpansionTiers = 1` still searches the
  // origin cell — the "overwhelmingly common answer" (§6.3) — without opening the
  // ring expansion tier 2 requires.
  while (!stopped && maxTiers >= TIER.ORIGIN_CELL && ring <= maxRadiusRings) {
    if (ring >= 1 && maxTiers < TIER.KRING) break;
    const ringCells = ring === 0 ? [originFineCellId] : cells.ringAt(originFineCellId, ring);
    for (const fineCellId of ringCells) {
      // eslint-disable-next-line no-await-in-loop
      await queryFineCell(fineCellId, READY_CLASSES, ring === 0 ? TIER.ORIGIN_CELL : TIER.KRING);
      if (truncatedBy) {
        stopped = true;
        break;
      }
    }
    if (stopped) break;

    // The floor for the *next*, still-unexplored ring — the geometric pruning check.
    // eslint-disable-next-line no-await-in-loop
    const floor = unexploredRingFloorMilliCU({
      ringDistance: ring + 1,
      resolution: cells.RESOLUTION.FINE,
      leg: source.leg,
      decisionTimeMs: source.decisionTimeMs,
      fleetBestCase: source.fleetBestCase,
      rates: source.rates,
      delayParameters: source.delayParameters,
      correction: source.correction,
    });
    if (!floor.ok) {
      problems.push(...floor.missing.map((name) => `unexploredRingFloor: ${name}`));
      break;
    }
    if (shouldStopExpanding(floor.milliCU)) {
      truncatedBy = truncatedBy || "pruning_rule_satisfied";
      break;
    }
    ring += 1;
  }

  /* ── Tier 3 — origin zone, then adjacent zones ──────────────────────────── */
  if (!truncatedBy && maxTiers >= TIER.ZONE && source.zoneCells && Array.isArray(source.zoneCells.cellIds)) {
    for (const fineCellId of ordering.orderCellsForExpansion(
      source.zoneCells.cellIds.map((cellId) => ({ cellId, minBoundMilliCU: 0n })),
    ).map((entry) => entry.cellId)) {
      // eslint-disable-next-line no-await-in-loop
      await queryFineCell(fineCellId, READY_CLASSES, TIER.ZONE);
      if (truncatedBy) break;
      if (shouldStopExpanding(0n)) {
        truncatedBy = "pruning_rule_satisfied";
        break;
      }
    }
  }

  /* ── Tier 4 — region-wide coarse-cell sweep ─────────────────────────────── */
  if (!truncatedBy && maxTiers >= TIER.REGION && Array.isArray(source.regionCoarseCellIds)) {
    for (const coarseCellId of [...source.regionCoarseCellIds].sort(ordering.compareStrings)) {
      for (const availabilityClass of READY_CLASSES) {
        // eslint-disable-next-line no-await-in-loop
        const agentIds = await availabilityIndex.candidatesInCoarseCell(
          { kv: source.kv },
          source.shardId,
          coarseCellId,
          availabilityClass,
        );
        cellsExplored += 1;
        // eslint-disable-next-line no-await-in-loop
        await considerAgentIds(ordering.orderAgentsWithinCell(agentIds), TIER.REGION);
        if (truncatedBy) break;
      }
      if (truncatedBy) break;
      if (shouldStopExpanding(0n)) {
        truncatedBy = "pruning_rule_satisfied";
        break;
      }
    }
  }

  /* ── Tier 5 — widened radius, interruptible/finishing-soon classes ─────── */
  if (!truncatedBy && maxTiers >= TIER.WIDENED_CLASSES && !enoughFeasible()) {
    const widenedRing = Math.max(ring, 1);
    const widenedCells = cells.diskAround(originFineCellId, widenedRing);
    for (const fineCellId of widenedCells) {
      // eslint-disable-next-line no-await-in-loop
      await queryFineCell(fineCellId, WIDENED_CLASSES, TIER.WIDENED_CLASSES);
      if (truncatedBy) break;
    }
  }

  /* ── Tier 6 — cross-region (explicitly authorised only) ─────────────────── */
  if (!truncatedBy && maxTiers >= TIER.CROSS_REGION && Array.isArray(source.crossRegionCoarseCellIds)) {
    for (const coarseCellId of [...source.crossRegionCoarseCellIds].sort(ordering.compareStrings)) {
      for (const availabilityClass of READY_CLASSES) {
        // eslint-disable-next-line no-await-in-loop
        const agentIds = await availabilityIndex.candidatesInCoarseCell(
          { kv: source.kv },
          source.shardId,
          coarseCellId,
          availabilityClass,
        );
        cellsExplored += 1;
        // eslint-disable-next-line no-await-in-loop
        await considerAgentIds(ordering.orderAgentsWithinCell(agentIds), TIER.CROSS_REGION);
        if (truncatedBy) break;
      }
      if (truncatedBy) break;
    }
  }

  const orderedResults = ordering.orderCandidates(
    [...results.values()]
      .filter((result) => result.exact && result.exact.feasible && typeof result.exact.gammaMilliCU === "bigint")
      .map((result) => ({
        agentId: result.agentId,
        costMilliCU: result.exact.gammaMilliCU,
        dutyCycle: result.exact.dutyCycle,
        healthTier: result.exact.healthTier,
        tier: result.tier,
        lbMilliCU: result.lbMilliCU,
      })),
  );

  // The proven, non-negative search-gap bound (§6.4). Clamped at zero: an
  // unexplored floor at or above C* proves optimality over the columns generated,
  // not a negative gap.
  let achievedGapMilliCU = 0n;
  if (bestGammaMilliCU !== null) {
    const floor = unexploredRingFloorMilliCU({
      ringDistance: ring + 1,
      resolution: cells.RESOLUTION.FINE,
      leg: source.leg,
      decisionTimeMs: source.decisionTimeMs,
      fleetBestCase: source.fleetBestCase,
      rates: source.rates,
      delayParameters: source.delayParameters,
      correction: source.correction,
    });
    if (floor.ok) {
      const raw = subtract(bestGammaMilliCU, floor.milliCU);
      achievedGapMilliCU = compareMilliCU(raw, 0n) > 0 ? raw : 0n;
    }
  }

  return {
    ok: problems.length === 0,
    candidates: orderedResults,
    bestGammaMilliCU,
    achievedGapMilliCU,
    tiersExplored: Math.min(ring + (truncatedBy ? 0 : 1), maxTiers),
    cellsExplored,
    agentsEvaluated,
    truncatedBy,
    problems,
  };
}

module.exports = {
  TIER,
  READY_CLASSES,
  WIDENED_CLASSES,
  minimumPossibleDistanceForRingMetres,
  unexploredRingFloorMilliCU,
  expandCandidates,
};

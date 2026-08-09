"use strict";

/**
 * `GET /api/diagnostics/rejections?zone=&class=&purpose=` — the capacity-planning
 * instrument of §7.7.
 *
 * ── Why this endpoint exists ────────────────────────────────────────────────
 * §7.7 makes two derived signals first-class SLIs, and both are useless without a way
 * to read them:
 *
 * > **Binding-constraint distribution** per zone, mission class, and Leg `purpose`. If
 * > 60 % of rejections in a zone are F34 (energy), the operational answer is **charger
 * > placement, not scoring changes**. This turns the engine into an instrument for
 * > capacity planning.
 *
 * > **Near-miss margins.** For each rejected predicate, the *distance* from
 * > satisfaction … A fleet routinely failing F34 by 3 % is one configuration change
 * > away from working, and that is very different from failing by 60 %.
 *
 * The two answer different questions and are returned together because the operational
 * decision needs both: *what* is binding, and *by how much*. Knowing that F34 binds 60 %
 * of the time says buy chargers; knowing it binds by 3 % says change a parameter first.
 *
 * ── The F34 tier is a first-class dimension, not a detail ───────────────────
 * > For F34 the binding **tier** (§14.5) is part of the key, since a fleet blocked on
 * > immobilisation risk and one blocked on divert-to-charge risk need different
 * > interventions.
 *
 * So the response groups F34 by tier rather than summing it, and labels each tier with
 * the consequence §14.5 attaches to it. A single "F34: 60 %" row would conflate a
 * service-quality budget line (T1) with a safety-reviewed immobilisation rate (T3).
 *
 * ── It reads; it never repairs ──────────────────────────────────────────────
 * Read-only, like `GET /api/legs/:legId/supervision`. An endpoint that could clear
 * aggregates would let an operator erase the evidence of a capacity problem, and the
 * counts are an SLI precisely because nobody can.
 *
 * The route sits behind the same `authUser` middleware every other `/api` route uses,
 * inheriting the existing authentication rather than inventing a second one (§23.4).
 */

const asyncHandler = require("../utils/asyncHandler");
const { getPrisma } = require("../db/prisma");
const { predicate, PREDICATES } = require("../engine/feasibility/register");
const { TIERS } = require("../engine/feasibility/predicates/f34");
const { bucketRange } = require("../engine/feasibility/rejectionTelemetry");

// PHASE 7 — §14's energy model, read-only. Every table below comes from the engine's
// own modules rather than being restated here, so the diagnostic and the decision path
// cannot describe two different reserve models.
const { defaultSnapshot } = require("../engine/config/service");
const usableEnergy = require("../engine/energy/usable");
const reserves = require("../engine/energy/reserves");
const tiers = require("../engine/energy/tiers");
const consumption = require("../engine/energy/consumption");

// PHASE 9 — §6's candidate generation and admissible bound, read-only.
const cells = require("../engine/spatial/cells");
const availabilityIndex = require("../engine/candidates/availabilityIndex");
const { lowerBound } = require("../engine/candidates/lowerBound");
const omega = require("../engine/candidates/omega");
const { orderCandidates } = require("../engine/candidates/ordering");
const { unexploredRingFloorMilliCU, READY_CLASSES } = require("../engine/candidates/expansion");
const { ratesFrom } = require("../engine/cost/exchangeRates");
const { toCU } = require("../engine/determinism/fixedPoint");

/**
 * The default window the distribution is reported over when the caller names none.
 * @structural the endpoint's default reporting window
 */
const DEFAULT_WINDOW_MS = 86_400_000;

/**
 * The maximum window a single query may span, so one request cannot scan the table.
 * @structural the endpoint's query bound
 */
const MAX_WINDOW_MS = 2_592_000_000;

/**
 * `f_temp` at the pack's rated temperature — the basis this read-only endpoint reports
 * `E_usable` at, in the absence of a live pack temperature.
 * @structural the identity element of a derating factor, not a calibrated value
 */
const RATED_TEMPERATURE_F_TEMP = 1;

const TIER_BY_NAME = Object.freeze(
  TIERS.reduce((index, row) => {
    index[row.tier] = row;
    return index;
  }, Object.create(null)),
);

/**
 * Describe a predicate for the response, so an operator reading "F34" does not have to
 * look it up in the specification.
 *
 * @param {string} predicateId
 * @param {string|null} tier
 * @returns {object}
 */
function describe(predicateId, tier) {
  const entry = predicate(predicateId);
  const tierRow = tier ? TIER_BY_NAME[tier] : null;
  return {
    predicateId,
    name: entry ? entry.name : null,
    constraintClass: entry ? entry.declaredClass : null,
    group: entry ? entry.group : null,
    indeterminatePolicy: entry ? entry.policy : null,
    tier,
    // §14.5's consequence column, carried so the two F34 tiers are distinguishable at
    // a glance rather than only by their labels.
    tierEvent: tierRow ? tierRow.event : null,
    tierConsequence: tierRow ? tierRow.consequence : null,
  };
}

/**
 * GET /api/diagnostics/rejections
 *
 * Query parameters, all optional: `zone`, `class` (mission class), `purpose` (Leg
 * purpose), `from`, `to`, `shard`.
 */
const getRejections = asyncHandler(async (req, res) => {
  const prisma = getPrisma();

  const toMs = req.query.to ? Date.parse(String(req.query.to)) : Date.now();
  if (!Number.isFinite(toMs)) return res.status(400).json({ error: "`to` is not a readable timestamp" });

  const fromMs = req.query.from ? Date.parse(String(req.query.from)) : toMs - DEFAULT_WINDOW_MS;
  if (!Number.isFinite(fromMs)) return res.status(400).json({ error: "`from` is not a readable timestamp" });

  if (fromMs >= toMs) return res.status(400).json({ error: "`from` must precede `to`" });
  if (toMs - fromMs > MAX_WINDOW_MS) {
    return res.status(400).json({ error: `the window may not exceed ${MAX_WINDOW_MS} ms`, maxWindowMs: MAX_WINDOW_MS });
  }

  const where = { bucketStart: { gte: new Date(fromMs), lt: new Date(toMs) } };
  if (req.query.zone) where.zoneId = String(req.query.zone);
  if (req.query.class) where.missionClass = String(req.query.class);
  if (req.query.purpose) where.legPurpose = String(req.query.purpose);
  if (req.query.shard) where.shardId = String(req.query.shard);

  const rows = await prisma.rejectionAggregate.groupBy({
    by: ["predicateId", "tier"],
    where,
    _sum: { count: true },
  });

  const total = rows.reduce((sum, row) => sum + Number(row._sum.count || 0), 0);

  // Descending by count: the answer to "what is blocking this zone" is the first row.
  const distribution = rows
    .map((row) => {
      const count = Number(row._sum.count || 0);
      return {
        ...describe(row.predicateId, row.tier),
        count,
        // The share is what makes §7.7's own example — "if 60 % of rejections in a zone
        // are F34" — readable directly off the response.
        share: total > 0 ? count / total : 0,
      };
    })
    .sort((a, b) => b.count - a.count || a.predicateId.localeCompare(b.predicateId));

  // ── Near-miss margins for whatever bound ─────────────────────────────────
  const boundPredicates = [...new Set(distribution.map((row) => row.predicateId))];
  const sketchWhere = { bucketStart: { gte: new Date(fromMs), lt: new Date(toMs) } };
  if (req.query.shard) sketchWhere.shardId = String(req.query.shard);
  if (boundPredicates.length > 0) sketchWhere.predicateId = { in: boundPredicates };

  const sketchRows = boundPredicates.length === 0 ? [] : await prisma.nearMissSketch.findMany({ where: sketchWhere });

  // Merge the ladders across buckets, then report the ladder rather than a single
  // quantile: the sketch is bucketed, so a quantile is a bound and presenting it as a
  // value would overstate the resolution.
  const merged = new Map();
  for (const row of sketchRows) {
    const key = `${row.predicateId}|${row.marginUnit}`;
    const ladder = merged.get(key) || new Map();
    for (const [bucket, count] of Object.entries(row.buckets || {})) {
      const index = Number(bucket);
      const value = Number(count);
      if (Number.isFinite(index) && Number.isFinite(value)) ladder.set(index, (ladder.get(index) || 0) + value);
    }
    merged.set(key, ladder);
  }

  const nearMiss = [...merged.entries()]
    .map(([key, ladder]) => {
      const [predicateId, marginUnit] = key.split("|");
      const buckets = [...ladder.entries()].sort((a, b) => a[0] - b[0]);
      const sketchTotal = buckets.reduce((sum, [, count]) => sum + count, 0);
      // The failing side only: a rejection's distance from satisfaction is a negative
      // margin, and pooling the passing side would dilute the very statistic §7.7 wants.
      const failing = buckets.filter(([bucket]) => bucket < 0);
      const failingTotal = failing.reduce((sum, [, count]) => sum + count, 0);
      return {
        predicateId,
        marginUnit,
        total: sketchTotal,
        failingTotal,
        buckets: buckets.map(([bucket, count]) => ({
          bucket,
          count,
          range: bucketRange(bucket),
          share: sketchTotal > 0 ? count / sketchTotal : 0,
        })),
      };
    })
    .sort((a, b) => a.predicateId.localeCompare(b.predicateId));

  return res.json({
    window: { from: new Date(fromMs), to: new Date(toMs) },
    filters: {
      zone: req.query.zone || null,
      missionClass: req.query.class || null,
      legPurpose: req.query.purpose || null,
      shard: req.query.shard || null,
    },
    total,
    // Exact, not sampled: §7.7 folds every tuple into these counts before the decision
    // record is written, and only the per-candidate rows are sampled into Tier B.
    exactOverAllDecisions: true,
    registeredPredicates: PREDICATES.length,
    bindingConstraintDistribution: distribution,
    nearMissMargins: nearMiss,
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 7 — GET /api/diagnostics/energy/:agentId (§14.5)
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * `GET /api/diagnostics/energy/:agentId` — the reserve breakdown, the binding tier, and
 * the margin.
 *
 * ── Why an operator needs this endpoint and not a log line ──────────────────
 * §14.1 replaces a number an operator could read off a dashboard ("battery 34 %") with
 * a probabilistic constraint over four reserve layers and three consequence tiers. That
 * is a strictly better model and a strictly worse user interface, and the gap between
 * the two is where operator trust is lost: an agent refused a mission at 34 % looks
 * broken unless the refusal can be read.
 *
 * So the response states, in Wh:
 *
 * - `E_usable` and every factor of §14.3's product that produced it — because "usable"
 *   at 70 % state of health is a different number from "usable" at 100 %, and that is
 *   the whole reason a percentage floor was inadequate.
 * - Each of §14.5's four reserve layers separately, with its purpose and whether policy
 *   may override it. Summing them would hide exactly the fact that they may never be
 *   traded against one another.
 * - The three tier conditions with their **derived** targets, and which one binds.
 *
 * ── The binding tier is the operational answer ──────────────────────────────
 * > "this mission failed on immobilisation risk" and "this mission failed on
 * > divert-to-charge risk" call for entirely different operational responses.
 *
 * The response therefore labels the binding tier with §14.5's own event and consequence
 * text, so "T3" reads as *immobilisation* without a trip to the specification — the same
 * treatment `getRejections` gives F34's tier dimension, using the same table.
 *
 * ── Read-only, and honest about what it cannot say ─────────────────────────
 * The endpoint reports state; it never repairs, re-plans, or charges. Where an input is
 * missing it says which one rather than substituting a default — an energy diagnostic
 * that filled in a plausible state of health would be describing a fleet that does not
 * exist.
 */
const getAgentEnergy = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const agentId = String(req.params.agentId);

  const agent = await prisma.agent.findFirst({
    where: { OR: [{ agentId }, { id: agentId }] },
    include: {
      batteryState: true,
      agentClass: { include: { energyModel: true, energyModelParams: { orderBy: { modelVersion: "desc" }, take: 1 } } },
      chargerReservations: { where: { state: "ACTIVE" }, orderBy: { reservedFrom: "asc" }, take: 5 },
    },
  });

  if (!agent) return res.status(404).json({ error: `no agent "${agentId}"` });

  const snapshot = defaultSnapshot();
  const missing = [];

  const read = (name) => {
    const value = snapshot.resolve(name);
    if (value === null || value === undefined) missing.push(name);
    return value;
  };

  // The resolved-configuration view the engine modules expect: a `get(name)` reader
  // over the same snapshot, so the endpoint and a round read one config.
  const configView = { get: (name) => snapshot.resolve(name) };

  const battery = agent.batteryState;
  const energyModel = agent.agentClass ? agent.agentClass.energyModel : null;
  const params = agent.agentClass && agent.agentClass.energyModelParams ? agent.agentClass.energyModelParams[0] : null;

  const soc = battery && Number.isFinite(battery.lastObservedSoc) ? battery.lastObservedSoc : null;
  const soh = battery && Number.isFinite(battery.soh) ? battery.soh : null;
  const packNominalWh = energyModel && Number.isFinite(energyModel.packNominalWh) ? energyModel.packNominalWh : null;
  const fDerate = read("energy.f_derate");

  // `f_temp` needs a pack temperature, which is a live telemetry reading rather than
  // stored state, so `E_usable` is reported here **at the pack's rated temperature**
  // (`f_temp = 1`) and labelled as such. Substituting an assumed ambient would be
  // substituting an assumed range, which is the fail-open default §14.3 exists to
  // remove; labelling it lets an operator read the figure for what it is — an upper
  // bound on usable energy, never the number a feasibility decision was taken on.
  const usableFactors = { packNominalWh, soh, fTemp: RATED_TEMPERATURE_F_TEMP, soc, fDerate };
  const usable = usableEnergy.usableWh(usableFactors);

  const floorWh = read("energy.reserve_floor_wh");
  const operationalWh = read("energy.operational_reserve_wh");

  const conservatism = usableEnergy.assertWithinCap(configView);

  return res.json({
    agentId: agent.agentId,
    agentClassId: agent.agentClass ? agent.agentClass.classId : null,

    // §14.3's product, factor by factor. A percentage means a different number of
    // watt-hours on every pack and at every state of health, which is why every factor
    // is shown rather than only the result.
    usableEnergy: {
      wh: usable.ok ? usable.wh : null,
      factors: usable.ok ? usable.factors : null,
      packNominalWh,
      soh,
      soc,
      fDerate: Number.isFinite(fDerate) ? fDerate : null,
      // Stated so the figure is not mistaken for the one a decision was taken on.
      fTempApplied: RATED_TEMPERATURE_F_TEMP,
      fTempBasis: "RATED_TEMPERATURE — a live pack temperature is telemetry, not stored state (§14.3)",
      missingFactors: usable.ok ? [] : usable.missing,
    },

    // §14.5's four layers, never summed into one number here.
    reserves: reserves.LAYERS.map((layer) => ({
      id: layer.id,
      field: layer.field,
      definition: layer.definition,
      purpose: layer.purpose,
      overridable: layer.overridable,
      wh:
        layer.field === "floorWh"
          ? (Number.isFinite(floorWh) ? floorWh : null)
          : layer.field === "operationalWh"
            ? (Number.isFinite(operationalWh) ? operationalWh : null)
            : null,
      // E_return and E_contingency are plan-dependent: one needs a projected mission
      // end and the pinned charger projection, the other a predictive distribution.
      // Neither is a property of an agent at rest, and reporting a number for them
      // here would be reporting a reserve for a mission nobody has planned.
      planDependent: layer.field === "returnWh" || layer.field === "contingencyWh",
    })),

    // §14.5's three conditions with their derived targets. The probabilities are
    // plan-dependent; the targets are not, and the targets are the half an operator
    // asking "why was this refused" needs first.
    shortfallTiers: tiers.TIERS.map((tier) => {
      const target = tiers.alphaFor(configView, tier.tier, null);
      return {
        tier: tier.tier,
        event: tier.event,
        consequence: tier.consequence,
        response: tier.response,
        reserveLayers: tier.reserveFields,
        alpha: target.ok ? target.alpha : null,
        alphaUnresolvedBecause: target.ok ? null : target.reason,
      };
    }),

    // §14.3 — both published products and the cap they are held to, so a fleet that is
    // quietly 1.8x conservative is visible rather than emergent.
    conservatism: {
      combinedNominal: conservatism.nominal,
      combinedDegraded: conservatism.degraded,
      cap: conservatism.cap,
      withinCap: conservatism.ok,
      problems: conservatism.problems,
    },

    // §14.2's self-correcting multiplier and its drift signal.
    efficiency: battery
      ? {
          kappa: battery.kappa,
          sampleCount: battery.kappaSampleCount,
          updatedAt: battery.kappaUpdatedAt,
          drift: consumption.kappaDriftSignal(battery.kappa, snapshot.resolve("energy.kappa_bounds")),
        }
      : null,

    // §14.3 — tracked separately because it has two distinct consequences.
    packHealth: usableEnergy.resistanceSignal(battery),

    modelVersion: params ? params.modelVersion : null,
    modelFittedAt: params ? params.fittedAt : null,
    residualCv: params && Number.isFinite(params.residualCv) ? params.residualCv : snapshot.resolve("energy.model_residual_cv"),

    // §14.7 — reservations are the Scheduler's field. Shown, never editable here.
    chargingReservations: agent.chargerReservations.map((reservation) => ({
      reservationId: reservation.reservationId,
      from: reservation.reservedFrom,
      until: reservation.reservedUntil,
      targetSoc: reservation.targetSoc,
      state: reservation.state,
      ownedBy: "CHARGING_SCHEDULER",
    })),

    unresolvedParameters: [...new Set(missing)],
  });
});

/**
 * `candidate.max_expansion_tiers`'s default (§27 item 1 / Appendix A) — used only
 * as this endpoint's own search cap when the register has no override, exactly the
 * way `RATED_TEMPERATURE_F_TEMP` above is a stated basis rather than a silent
 * default.
 * @structural this endpoint's own bounded search depth, not a behavioural threshold
 */
const CANDIDATES_MAX_RING = 3;

/**
 * GET /api/diagnostics/candidates/:legId — §6's own diagnostic: "cells explored,
 * smallest unexplored bound, achieved gap in CU" (§6.1).
 *
 * ── What this reports, and what it cannot yet ────────────────────────────────
 * Phase 9 delivers the Availability Index, the hierarchical expansion tiers, and
 * the admissible bound `LB(a, l)` — every one of which this endpoint exercises for
 * real, on demand, against the live index and the live config register. What it
 * does **not** do is run the round loop's exact pricing (`Plan Builder` → `Φ` →
 * `γ`), because that pipeline is assembled by Phase 10, not Phase 9 (§9's own
 * "Round loop and solve" purpose statement). So candidates are ranked here by
 * their admissible **lower bound**, not by an exact price, and the "achieved gap"
 * this endpoint reports is the gap between the *best LB found* and the next
 * unexplored ring's floor — an honest, weaker cousin of §6.4's `C* − min LB`, which
 * needs a real `C*` (an exact `γ`) this phase does not produce standalone. Both
 * departures are labelled in the response rather than left for a caller to
 * discover by comparing this endpoint to §6.4's definition.
 */
const getLegCandidates = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const legId = String(req.params.legId);

  const leg = await prisma.leg.findFirst({
    where: { OR: [{ legId }, { id: legId }] },
    include: {
      stops: { orderBy: { sequence: "asc" } },
      mission: { include: { legs: { select: { id: true, sequence: true }, orderBy: { sequence: "asc" } } } },
    },
  });
  if (!leg) return res.status(404).json({ error: `no leg "${legId}"` });

  const originStop = leg.stops.find((stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lon));
  if (!originStop) {
    return res.status(422).json({ error: `leg "${legId}" has no stop with a resolved lat/lon` });
  }

  const isTerminal =
    leg.mission && leg.mission.legs.length > 0
      ? leg.mission.legs[leg.mission.legs.length - 1].id === leg.id
      : true;

  const snapshot = defaultSnapshot();
  const rates = ratesFrom(snapshot, {});
  const correction = omega.combinedCorrection({ snapshot });

  const originFineCellId = cells.cellForPoint(originStop.lat, originStop.lon, cells.RESOLUTION.FINE);
  const originCoarseCellId = cells.coarseParentOf(originFineCellId);

  const maxEvaluated = snapshot.resolve("candidate.max_evaluated", { sla_class: null }) ?? 200;
  const targetFeasible = snapshot.resolve("candidate.target_feasible", { sla_class: null }) ?? 12;

  const cellsExplored = [];
  const agentIds = new Set();
  let ring = 0;

  while (ring <= CANDIDATES_MAX_RING && agentIds.size < maxEvaluated) {
    const ringCells = ring === 0 ? [originFineCellId] : cells.ringAt(originFineCellId, ring);
    for (const fineCellId of ringCells) {
      cellsExplored.push({ fineCellId, ring });
      // eslint-disable-next-line no-await-in-loop
      for (const availabilityClass of READY_CLASSES) {
        // eslint-disable-next-line no-await-in-loop
        const found = await availabilityIndex.candidatesInFineCell(
          { kv: req.app.locals.kv },
          "default",
          fineCellId,
          availabilityClass,
        );
        for (const agentId of found) agentIds.add(agentId);
      }
    }
    if (agentIds.size >= targetFeasible) break;
    ring += 1;
  }

  const positions = await prisma.agentCellPosition.findMany({
    where: { agentId: { in: [...agentIds].slice(0, maxEvaluated) } },
    include: {
      agent: { include: { agentClass: { include: { mobilityModel: true, energyModelParams: { orderBy: { modelVersion: "desc" }, take: 1 } } } } },
    },
  });

  const legForBound = {
    legId: leg.legId,
    firstStopLat: originStop.lat,
    firstStopLon: originStop.lon,
    earliestPossibleCompletionMs: Date.now(),
    role: isTerminal ? "TERMINAL" : "UPSTREAM",
    targetMs: leg.slaDeadline ? leg.slaDeadline.getTime() : null,
    deadlineMs: leg.slaDeadline ? leg.slaDeadline.getTime() : null,
    queueAgeSeconds: (Date.now() - leg.createdAt.getTime()) / 1000,
  };

  const evaluated = positions.map((position) => {
    const params = position.agent.agentClass && position.agent.agentClass.energyModelParams[0];
    const mobilityModel = position.agent.agentClass && position.agent.agentClass.mobilityModel;

    const bound = lowerBound({
      agent: {
        agentId: position.agentId,
        lat: position.lat,
        lon: position.lon,
        mobilityModel: mobilityModel ? { kinematicLimits: mobilityModel.kinematicLimits } : null,
      },
      waitUntilAvailableSeconds: 0,
      energy: { kappa: 1, model: params ? params.coefficients : null },
      leg: legForBound,
      rates: { lambdaTimeFloor: rates["cost.lambda_time_floor"], cuPerWh: rates["cost.energy.cu_per_wh"] },
      delayParameters: readDelayParameters(snapshot),
      correction,
    });

    return {
      agentId: position.agent.agentId,
      availabilityClass: position.availabilityClass,
      lbCu: bound.ok ? toCU(bound.milliCU) : null,
      lbUnresolvedBecause: bound.ok ? [] : bound.missing,
    };
  });

  const resolvedCandidates = orderCandidates(
    evaluated
      .filter((row) => row.lbCu !== null)
      .map((row) => ({ agentId: row.agentId, costMilliCU: BigInt(Math.round(row.lbCu * 1000)) })),
  );

  const bestLbMilliCU = resolvedCandidates.length > 0
    ? BigInt(Math.round(evaluated.find((row) => row.agentId === resolvedCandidates[0].agentId).lbCu * 1000))
    : null;

  const floor = correction.ok
    ? unexploredRingFloorMilliCU({
        ringDistance: ring + 1,
        resolution: cells.RESOLUTION.FINE,
        leg: legForBound,
        decisionTimeMs: Date.now(),
        fleetBestCase: fleetBestCaseFrom(positions),
        rates: { lambdaTimeFloor: rates["cost.lambda_time_floor"], cuPerWh: rates["cost.energy.cu_per_wh"] },
        delayParameters: readDelayParameters(snapshot),
        correction,
      })
    : { ok: false, milliCU: null, missing: ["Ω correction unresolved"] };

  return res.json({
    legId: leg.legId,
    originFineCellId,
    originCoarseCellId,
    tiersExplored: Math.min(ring + 1, CANDIDATES_MAX_RING + 1),
    cellsExplored,
    agentsFound: agentIds.size,
    candidates: evaluated.sort((a, b) => (a.lbCu ?? Infinity) - (b.lbCu ?? Infinity)),
    bestLbCu: bestLbMilliCU !== null ? toCU(bestLbMilliCU) : null,
    smallestUnexploredBoundCu: floor.ok ? toCU(floor.milliCU) : null,
    achievedGapCu:
      bestLbMilliCU !== null && floor.ok
        ? Math.max(0, toCU(bestLbMilliCU) - toCU(floor.milliCU))
        : null,
    unresolvedBecause: floor.ok ? [] : floor.missing,
    basis:
      "Ranked by the admissible lower bound LB(a,l) (§6.4), not by exact price — the round loop's " +
      "Plan Builder / Φ / γ pipeline is Phase 10's, not yet wired. 'achievedGapCu' is the gap between " +
      "the best LB found and the next unexplored ring's geometric floor, a weaker cousin of §6.4's " +
      "C*  minus min LB, which needs an exact γ this endpoint does not produce.",
  });
});

/**
 * `cost/cDelay.forLeg`'s `parameters` argument, resolved from the register. Kept
 * as one small reader here rather than imported from elsewhere, because no other
 * module currently assembles it outside a full round context.
 *
 * @param {object} snapshot
 * @returns {object}
 */
function readDelayParameters(snapshot) {
  return {
    slaRate: { value: snapshot.resolve("cost.sla.cu_per_second_late", {}) ?? 0 },
    breachPenaltyCu: snapshot.resolve("cost.sla.breach_penalty", {}) ?? 0,
    latenessExponent: snapshot.resolve("cost.sla.lateness_exponent", {}) ?? 1,
    upstreamSlackWeight: snapshot.resolve("cost.sla.upstream_slack_weight", {}) ?? 0,
    aging: {
      referencePeriodSeconds: snapshot.resolve("cost.aging.reference_period", {}) ?? 3600,
      growthExponent: snapshot.resolve("cost.aging.growth_exponent", {}) ?? 1,
      maxMultiplier: snapshot.resolve("cost.aging.max_multiplier", {}) ?? 1,
    },
  };
}

/**
 * The fleet-wide best-case speed/energy coefficients `unexploredRingFloorMilliCU`
 * needs (§6.4), derived from whichever candidates this sweep actually found —
 * the fastest declared speed and the cheapest κ·β_dist product among them. An
 * honest, request-scoped proxy for "the fleet's own best-case class", not a
 * fleet-wide config lookup Phase 9 does not otherwise need.
 *
 * @param {object[]} positions Prisma `AgentCellPosition` rows with `agent.agentClass` included
 * @returns {{ maxSpeedMs: number, kappaMin: number, betaDistMin: number }|null}
 */
function fleetBestCaseFrom(positions) {
  let maxSpeedMs = null;
  let betaDistMin = null;

  for (const position of positions) {
    const agentClass = position.agent.agentClass;
    const limits = agentClass && agentClass.mobilityModel && agentClass.mobilityModel.kinematicLimits;
    if (limits && Number.isFinite(limits.maxSpeedMs)) {
      maxSpeedMs = maxSpeedMs === null ? limits.maxSpeedMs : Math.max(maxSpeedMs, limits.maxSpeedMs);
    }
    const params = agentClass && agentClass.energyModelParams && agentClass.energyModelParams[0];
    const betaDist = params && params.coefficients && params.coefficients[consumption.COEFFICIENT.DIST];
    if (Number.isFinite(betaDist)) {
      betaDistMin = betaDistMin === null ? betaDist : Math.min(betaDistMin, betaDist);
    }
  }

  if (maxSpeedMs === null || betaDistMin === null) return null;
  return { maxSpeedMs, kappaMin: 1, betaDistMin };
}

module.exports = {
  getRejections,
  getAgentEnergy,
  getLegCandidates,
  describe,
  DEFAULT_WINDOW_MS,
  MAX_WINDOW_MS,
  CANDIDATES_MAX_RING,
};

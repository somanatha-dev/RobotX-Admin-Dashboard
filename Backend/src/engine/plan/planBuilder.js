"use strict";

/**
 * The Plan Builder (§13.1, §13.4, §13.5) — **Tier 1**, decision path.
 *
 * > For a candidate pairing, the Plan Builder produces a complete, executable, and
 * > *evaluated* plan, and **this artefact is the input to both feasibility and cost**:
 * >
 * > - The ordered stop sequence including any inserted charging or repositioning stops.
 * > - Per-stop projected arrival, service start, service end, and departure times, each
 * >   with an uncertainty band.
 * > - Per-leg route references, distances, and travel-time distributions.
 * > - Per-stop payload state: mass, volume, compartment allocation, centre of gravity,
 * >   custody.
 * > - Per-stop projected energy state with its uncertainty band.
 * > - The terminal state: position, SoC, time — the input to `V_terminal` (§8.3).
 * > - Feasibility results for every stop, since a plan can be infeasible at stop 3 while
 * >   being fine at stops 1 and 2.
 *
 * > **A candidate is feasible if and only if a valid plan exists.** This makes feasibility
 * > and cost consistent by construction: they are both computed from the same artefact, so
 * > **the engine cannot commit a plan that its own cost model never evaluated.** The
 * > baseline computes total mission distance only *after* the robot is chosen and bound,
 * > which is precisely the inconsistency this structure forbids.
 *
 * That sentence is the reason this module exists as a single producer rather than as
 * helpers scattered through the round: one artefact, built once, read by the 38 predicates
 * and by `Φ` alike. `src/services/task.service.js`'s route helpers are superseded by it.
 *
 * ── Charging is a planned stop, not a refusal (§13.4) ──────────────────────
 * > When a plan's projected energy violates a reserve, the planner attempts to insert a
 * > charging stop rather than declaring infeasibility. … The resulting plan is then priced
 * > normally, so "this agent can do it but needs a 12-minute top-up first" competes
 * > honestly against "that agent can do it immediately." **Only if no charging insertion
 * > produces a feasible plan does F34 reject the pairing.**
 *
 * > Inserting a charging stop is a *plan*, not a *booking*: it does not reserve the
 * > charger. … The engine never creates the reservation itself (§14.7).
 *
 * The inserted stop therefore carries a `reservationRequired` flag and the Scheduler's
 * published `targetSoc` with its provenance — never a target this module chose. Positions
 * are enumerated deterministically and the cheapest-in-added-time feasible one wins, with
 * the position index as the canonical tie-break.
 *
 * ── There is no return-to-base rule (§13.5) ────────────────────────────────
 * > There is no return-to-base *rule*. Return is an emergent outcome of `V_terminal`
 * > (§8.3), which prices the value of the state the agent is left in, plus explicit
 * > triggers.
 *
 * So this module inserts **no** return leg of its own. It reports the terminal state
 * honestly — position, SoC, time — and lets the cost function decide whether ending there
 * was worth it. The one exception §8.2 names is `t_terminal`: a *mandatory* charging leg
 * when the mission leaves the agent below its reserve floor, which is a physical
 * obligation rather than a repositioning preference, and which is priced as committed time.
 *
 * ── Determinism (T6, §9.6) ─────────────────────────────────────────────────
 * No clock, no randomness, no store. Every input is pinned: the decision time, the travel
 * times, the service-time model, the energy coefficients, the charger projection, and the
 * target SoC. Two runs over the same inputs produce byte-identical plans, which is what
 * makes a decision replayable and `γ(c)` reproducible in integer milli-CU.
 */

const timeline = require("./timeline");
const consumption = require("../energy/consumption");
const reserves = require("../energy/reserves");
const energyTiers = require("../energy/tiers");
const eReturn = require("../energy/eReturn");
const chargeCurve = require("../energy/chargeCurve");
const usable = require("../energy/usable");
const loadState = require("../payload/loadState");
const packing = require("../payload/packing");
const { compareStrings } = require("../determinism/ordering");

/** @structural milliseconds in one second */
const MS_PER_SECOND = 1000;

/**
 * The stop type an inserted charging stop carries. `domain/work.js` enumerates the
 * permitted set; this is the one §13.4 names.
 * @structural the stop type §13.4 inserts
 */
const CHARGE_STOP_TYPE = "CHARGE";

/** Why a plan could not be built. Distinct from *infeasible*: a plan that cannot be built has no artefact for the gate to evaluate. */
const FAILURE = Object.freeze({
  NO_STOPS: "NO_STOPS",
  PRECEDENCE: "PRECEDENCE_VIOLATED",
  MISSING_HOP: "MISSING_TRAVEL_TIME",
  MISSING_SERVICE_TIME: "MISSING_SERVICE_TIME",
  MISSING_ENERGY_INPUT: "MISSING_ENERGY_INPUT",
  MISSING_PAYLOAD_INPUT: "MISSING_PAYLOAD_INPUT",
  MISSING_TERRAIN: "MISSING_TERRAIN",
});

/** How the plan resolved its energy reserve position. */
const CHARGING = Object.freeze({
  NOT_REQUIRED: "NOT_REQUIRED",
  INSERTED: "CHARGING_STOP_INSERTED",
  NO_FEASIBLE_INSERTION: "NO_FEASIBLE_INSERTION",
});

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Order the plan's stops: the agent's committed work first, then the new Legs.
 *
 * Precedence within a Leg is validated rather than assumed — a pickup must precede its
 * drop. §13.3 lists precedence first among the constraints an insertion is subject to, and
 * a plan that violated it would be an executable-looking artefact describing an impossible
 * journey.
 *
 * Ordering committed work first is the **no-chaining** arrangement: with
 * `capacity[agent_class] = 1` there is exactly one Leg and the question does not arise,
 * and with chaining enabled `plan/insertion.js` (Tier 2) produces the interleavings. This
 * module deliberately offers only the append arrangement, because interleaving is the
 * Tier 2 mechanism and a Tier 1 module that could produce one would be a kill switch that
 * cannot be thrown (§1.8 rule 2).
 *
 * @param {object} input
 * @param {object[]} input.committedLegs
 * @param {object[]} input.newLegs
 * @returns {{ ok: boolean, stops: object[], legs: object[], problems: string[] }}
 */
function sequenceStops(input) {
  const source = input || {};
  const problems = [];
  const stops = [];
  const legs = [];

  const append = (leg, committed) => {
    const legStops = [...(leg.stops || [])].sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
    if (legStops.length === 0) {
      problems.push(`Leg ${String(leg.legId)} carries no stops`);
      return;
    }

    let seenPickup = false;
    for (const stop of legStops) {
      if (stop.stopType === "PICKUP") seenPickup = true;
      if (stop.stopType === "DROP" && !seenPickup && leg.custodyAlreadyHeld !== true) {
        problems.push(
          `Leg ${String(leg.legId)} drops at stop ${String(stop.sequence)} before any pickup. Precedence ` +
            "is the first constraint §13.3 names; a plan violating it is an executable-looking artefact " +
            "describing an impossible journey",
        );
      }
      stops.push({ ...stop, legId: leg.legId, sequence: stops.length + 1, originalSequence: stop.sequence });
    }

    legs.push({
      legId: leg.legId,
      missionId: leg.missionId ?? null,
      role: leg.role ?? null,
      slaClass: leg.slaClass ?? null,
      tenantId: leg.tenantId ?? null,
      targetMs: isNumber(leg.targetMs) ? leg.targetMs : null,
      deadlineMs: isNumber(leg.deadlineMs) ? leg.deadlineMs : null,
      queueAgeSeconds: isNumber(leg.queueAgeSeconds) ? leg.queueAgeSeconds : null,
      committed,
    });
  };

  for (const leg of source.committedLegs || []) append(leg, true);
  for (const leg of source.newLegs || []) append(leg, false);

  if (stops.length === 0) problems.push(FAILURE.NO_STOPS);

  return { ok: problems.length === 0, stops, legs, problems };
}

/**
 * Resolve a service-time distribution for every stop, through §13.2's shrinkage ladder.
 *
 * @param {object[]} stops
 * @param {object} input `{ serviceTimeModels, priorSeconds, priorCv, shrinkageStrength, missionClassByLegId, utcOffsetSecondsBySite, nominalArrivalMsByStop }`
 * @returns {{ ok: boolean, stops: object[], problems: string[] }}
 */
function resolveServiceTimes(stops, input) {
  const source = input || {};
  const problems = [];
  const resolved = [];

  for (const stop of stops || []) {
    // An inserted charging stop's dwell is the charge duration, computed from §14.6's
    // nonlinear curve. It is not a learned service time and must not be shrunk toward one.
    if (stop.stopType === CHARGE_STOP_TYPE && isNumber(stop.chargeSeconds)) {
      resolved.push({ ...stop, serviceSeconds: stop.chargeSeconds, serviceSdSeconds: 0, serviceTimeSource: "CHARGE_CURVE" });
      continue;
    }

    const priors = source.priorSeconds;
    const priorForType =
      priors && typeof priors === "object" && !Array.isArray(priors) ? priors[stop.stopType] : priors;

    const nominalArrivalMs = (source.nominalArrivalMsByStop || {})[String(stop.sequence)];
    const descriptor = {
      siteId: stop.siteId ?? null,
      stopType: stop.stopType ?? null,
      missionClass: (source.missionClassByLegId || {})[String(stop.legId)] ?? null,
      hourOfWeek: timeline.hourOfWeek(
        nominalArrivalMs,
        (source.utcOffsetSecondsBySite || {})[String(stop.siteId)],
      ),
    };

    const serviceTime = timeline.serviceTimeFor({
      models: source.serviceTimeModels,
      descriptor,
      priorSeconds: priorForType,
      priorCv: source.priorCv,
      shrinkageStrength: source.shrinkageStrength,
    });

    if (!serviceTime.ok) {
      problems.push(`stop ${String(stop.sequence)}: ${serviceTime.missing.join(", ")}`);
      continue;
    }

    resolved.push({
      ...stop,
      serviceSeconds: serviceTime.meanSeconds,
      serviceSdSeconds: serviceTime.sdSeconds,
      serviceTimeSource: serviceTime.source,
      serviceTimeCohort: serviceTime.cohortKey,
      serviceTimeShrinkageWeight: serviceTime.shrinkageWeight,
    });
  }

  if (problems.length > 0) return { ok: false, stops: resolved, problems: [FAILURE.MISSING_SERVICE_TIME, ...problems] };
  return { ok: true, stops: resolved, problems: [] };
}

/**
 * Build the per-leg physical profiles `energy/consumption.js` reads, from a projected
 * timeline.
 *
 * One profile per **Leg**, not per stop: §14.2's equation is stated over a leg, and the
 * `t_occupied(k)` term for payload conditioning is an interval that spans stops.
 *
 * **Terrain arrives on the projected hop and is refused when absent** (`MISSING_TERRAIN`).
 * It used to arrive as a separate `terrainByStop` map keyed by the sequenced stop number;
 * E-8 moved it onto the hop, where §14.2 states it — see the block comment at the read.
 *
 * @param {object} input
 * @param {object[]} input.projectedStops from `timeline.project()`, each carrying the hop's
 *   `distanceM`, `climbM`, `descentM` and `stopStartCycles`
 * @param {object[]} input.stops the sequenced stops, carrying `legId`
 * @param {object[]} input.occupancy from `payload/loadState.project()`
 * @param {object} input.environment `{ ambientC, packC }`
 * @param {object} input.masses `{ vehicleMassKg, payloadMassExpectedKgByLegId }`
 * @returns {{ ok: boolean, profiles: object[], problems: string[] }}
 */
function legProfiles(input) {
  const source = input || {};
  const problems = [];
  let terrainRefused = false;

  const bySequence = new Map();
  for (const stop of source.projectedStops || []) bySequence.set(stop.sequence, stop);

  const byLeg = new Map();
  for (const stop of source.stops || []) {
    const projected = bySequence.get(stop.sequence);
    if (!projected) {
      problems.push(`stop ${String(stop.sequence)} has no projection`);
      continue;
    }
    const legId = String(stop.legId);

    // ── E-8: an absent terrain profile is not flat ground ─────────────────────
    // This read `(source.terrainByStop || {})[seq] || {}` and then accumulated
    // `isNumber(t.climbM) ? t.climbM : 0` (and `: 1` for the cycles). A stop with no terrain
    // therefore produced a profile asserting **zero climb, zero descent and one stop-start
    // cycle** — a complete, plausible, entirely invented physical description of ground
    // nobody surveyed.
    //
    // `energy/consumption.legEnergyWh` lists all three in `REQUIRED_PROFILE_FIELDS` and
    // refuses a profile missing any of them. That refusal was **unreachable**: this function
    // always supplied a number, so the fail-closed check one layer down could never fire.
    // The coercion did not degrade the estimate, it defeated the guard — and it defeated it
    // in the permissive direction, since zeroing `β_climb · climbM · grossMassKg` understates
    // mission energy, which overstates the projected charge F34 holds the §14 reserves
    // against.
    //
    // **Terrain now arrives on the hop**, from `timeline.project`, which refuses a hop
    // without it. §14.2 states these terms over the traversal, and the previous
    // `terrainByStop` map was keyed by the *sequenced* stop number — a key
    // `insertChargingStop` rewrites, so every stop after an inserted charge read its
    // neighbour's elevation profile. Reading from the projection removes that failure mode
    // instead of guarding it.
    const terrainFields = timeline.TERRAIN_FIELDS.filter((field) => !isNumber(projected[field]));
    if (terrainFields.length > 0) {
      terrainRefused = true;
      problems.push(
        `stop ${String(stop.sequence)}: the hop into it carries no terrain (${terrainFields.join(", ")})`,
      );
      continue;
    }

    const current = byLeg.get(legId) || {
      legId,
      distanceM: 0,
      climbM: 0,
      descentM: 0,
      movingSeconds: 0,
      dwellSeconds: 0,
      totalSeconds: 0,
      stopStartCycles: 0,
    };

    current.distanceM += projected.distanceM;
    current.climbM += projected.climbM;
    current.descentM += projected.descentM;
    current.movingSeconds += projected.travelSeconds;
    // Waiting is dwell for energy purposes: the agent is stationary and drawing auxiliary
    // and thermal loads. It is priced as committed time by C_direct and as energy here,
    // which are two different consumptions of the same interval, not a double count.
    current.dwellSeconds += projected.serviceSeconds + projected.waitSeconds;
    current.totalSeconds += projected.travelSeconds + projected.serviceSeconds + projected.waitSeconds;
    current.stopStartCycles += projected.stopStartCycles;

    byLeg.set(legId, current);
  }

  const masses = source.masses || {};
  const environment = source.environment || {};
  const occupancyByLeg = new Map();
  for (const row of source.occupancy || []) {
    const legId = String(row.legId ?? "");
    const rows = occupancyByLeg.get(legId) || [];
    rows.push(row);
    occupancyByLeg.set(legId, rows);
  }

  const profiles = [];
  for (const legId of [...byLeg.keys()].sort(compareStrings)) {
    const profile = byLeg.get(legId);
    profiles.push({
      ...profile,
      payloadMassKg: (masses.payloadMassExpectedKgByLegId || {})[legId] ?? masses.payloadMassExpectedKg,
      vehicleMassKg: masses.vehicleMassKg,
      ambientC: environment.ambientC,
      packC: environment.packC,
      compartmentOccupancy: occupancyByLeg.get(legId) || source.occupancy || [],
    });
  }

  if (problems.length > 0) {
    return { ok: false, profiles, problems: terrainRefused ? [FAILURE.MISSING_TERRAIN, ...problems] : problems };
  }
  return { ok: true, profiles, problems: [] };
}

/**
 * Project the energy state at every stop, with its uncertainty band (§13.1).
 *
 * The per-stop band is the mission's predictive standard deviation apportioned by the
 * cumulative share of the mission's energy consumed by that stop. That is a **stated
 * approximation**: it assumes the residual variance accumulates in proportion to
 * consumption, which is what a multiplicative residual model implies and is the same
 * assumption `energy.model_residual_cv` is fitted under. The alternative — reporting the
 * full mission band at every stop — would make the first stop look as uncertain as the
 * last, and F34 evaluates against the mission distribution in any case, so the per-stop
 * band informs explanation rather than the gate.
 *
 * @param {object} input
 * @param {number} input.startUsableWh
 * @param {object[]} input.legEnergies from `consumption.missionEnergyWh().legs`
 * @param {object[]} input.stops sequenced stops carrying `legId`
 * @param {{ meanWh: number, sdWh: number }} input.distribution
 * @returns {{ ok: boolean, perStop: object[], problems: string[] }}
 */
function projectEnergyPerStop(input) {
  const source = input || {};
  if (!isNumber(source.startUsableWh)) return { ok: false, perStop: [], problems: ["startUsableWh"] };

  const whByLeg = new Map();
  for (const leg of source.legEnergies || []) whByLeg.set(String(leg.legId), leg.wh);

  // Stops within a Leg share that Leg's energy equally. The Plan Builder has per-leg
  // energy, not per-stop, because §14.2's equation is stated over a leg; splitting evenly
  // is declared here rather than implied by the shape of the output.
  const stopsPerLeg = new Map();
  for (const stop of source.stops || []) {
    const legId = String(stop.legId);
    stopsPerLeg.set(legId, (stopsPerLeg.get(legId) || 0) + 1);
  }

  const totalWh = source.distribution && isNumber(source.distribution.meanWh) ? source.distribution.meanWh : null;
  const sdWh = source.distribution && isNumber(source.distribution.sdWh) ? source.distribution.sdWh : null;

  let consumed = 0;
  const perStop = [];

  for (const stop of source.stops || []) {
    const legId = String(stop.legId);
    const legWh = whByLeg.get(legId);
    if (!isNumber(legWh)) return { ok: false, perStop, problems: [`no modelled energy for Leg ${legId}`] };
    consumed += legWh / (stopsPerLeg.get(legId) || 1);

    const fraction = totalWh && totalWh > 0 ? Math.min(1, consumed / totalWh) : null;
    perStop.push({
      sequence: stop.sequence,
      legId,
      consumedWh: consumed,
      remainingUsableWh: source.startUsableWh - consumed,
      band: {
        sdWh: sdWh !== null && fraction !== null ? sdWh * fraction : null,
        basis: "cumulative consumption share of the mission's predictive standard deviation",
      },
    });
  }

  return { ok: true, perStop, problems: [] };
}

/**
 * Build one plan variant over an already-sequenced stop list.
 *
 * Separated from `build()` so that the charging-insertion search can evaluate several
 * variants without re-running the parts that do not change, and so that each variant is
 * produced by exactly the same code as the plan finally returned.
 *
 * @param {object} input see `build`
 * @param {object[]} stops
 * @returns {{ ok: boolean, variant: object|null, problems: string[] }}
 */
function buildVariant(input, stops) {
  const source = input || {};
  const agent = source.agent || {};
  const problems = [];

  const withServiceTimes = resolveServiceTimes(stops, source.serviceTime);
  if (!withServiceTimes.ok) return { ok: false, variant: null, problems: withServiceTimes.problems };

  const projected = timeline.project({
    stops: withServiceTimes.stops,
    startMs: agent.releaseAtMs,
    decisionTimeMs: source.decisionTimeMs,
    hops: source.hops,
  });
  if (!projected.ok) return { ok: false, variant: null, problems: [FAILURE.MISSING_HOP, ...projected.problems] };

  // ── Payload (§15.3, §15.4) ────────────────────────────────────────────────
  const packed = packing.evaluate(source.payload);
  const load = loadState.project({
    stops: withServiceTimes.stops,
    container: source.payload && source.payload.container,
    compartmentLoads: packed.compartmentLoads || [],
    itemsByStop: source.payload && source.payload.itemsByStop,
  });
  if (!load.ok) return { ok: false, variant: null, problems: [FAILURE.MISSING_PAYLOAD_INPUT, ...load.problems] };

  // ── Energy (§14.2, §14.5) ─────────────────────────────────────────────────
  const profiles = legProfiles({
    projectedStops: projected.stops,
    stops: withServiceTimes.stops,
    occupancy: load.occupancy,
    environment: source.environment,
    masses: source.masses,
  });
  if (!profiles.ok) return { ok: false, variant: null, problems: profiles.problems };

  const mission = consumption.missionEnergyWh(
    source.energy && source.energy.model,
    profiles.profiles,
    source.energy && source.energy.kappa,
  );
  if (!mission.ok) {
    return { ok: false, variant: null, problems: [FAILURE.MISSING_ENERGY_INPUT, ...mission.missing] };
  }

  const distribution = consumption.predictiveDistribution({
    meanWh: mission.wh,
    residualCv: source.energy && source.energy.residualCv,
    inflations: source.energy && source.energy.inflations,
    severity: source.energy && source.energy.severity,
  });
  if (!distribution.ok) {
    return { ok: false, variant: null, problems: [FAILURE.MISSING_ENERGY_INPUT, ...(distribution.problems || distribution.missing || [])] };
  }

  const perStopEnergy = projectEnergyPerStop({
    startUsableWh: source.energy && source.energy.usableWh,
    legEnergies: mission.legs,
    stops: withServiceTimes.stops,
    distribution,
  });
  if (!perStopEnergy.ok) return { ok: false, variant: null, problems: perStopEnergy.problems };

  const lastStop = projected.stops[projected.stops.length - 1];
  const terminalStopInput = withServiceTimes.stops[withServiceTimes.stops.length - 1];

  // ── E_return against the pinned projection (§14.5) ─────────────────────────
  const returnLeg = eReturn.evaluate({
    candidates: (source.charging && source.charging.chargerCandidates) || [],
    projection: (source.charging && source.charging.projection) || null,
    decisionTimeMs: source.decisionTimeMs,
    projectedEndMs: lastStop.departureMs,
    usableWh: source.energy && source.energy.usableWh,
    missionWh: mission.wh,
    floorWh: source.energy && source.energy.floorWh,
    availabilityMargin: source.energy && source.energy.availabilityMargin,
    projectionMaxAgeSeconds: source.energy && source.energy.projectionMaxAgeSeconds,
    uncalibratedReserveFactor: source.energy && source.energy.uncalibratedReserveFactor,
  });

  const returnLayer = returnLeg.ok ? eReturn.returnLayerWh(returnLeg.verdict) : { ok: false, returnWh: null };
  const contingency = reserves.contingencyWh(distribution, source.energy && source.energy.contingencyQuantile);
  const composed = reserves.compose({
    floorWh: source.energy && source.energy.floorWh,
    // An absent `E_return` is deliberately left absent rather than defaulted to zero:
    // §14.5 calls a zero return reserve "a reachability question nobody answered", and
    // `compose()` refuses it. The plan is still produced, with the shortfall visible, and
    // F34 decides — which is §13.4's own division of labour.
    returnWh: returnLayer.ok ? returnLayer.returnWh : undefined,
    contingencyWh: contingency.ok ? contingency.wh : undefined,
    operationalWh: source.energy && source.energy.operationalWh,
  });

  const tiersEvaluated = composed.ok
    ? energyTiers.evaluate({
        usableWh: source.energy.usableWh,
        distribution,
        layers: composed.layers,
        config: source.config,
        slaClass: source.slaClass ?? null,
      })
    : { ok: false, tierProbabilities: null, tiers: [], missing: composed.missing };

  const energyFragment = tiersEvaluated.ok
    ? energyTiers.planEnergyFragment(tiersEvaluated, returnLeg.ok ? returnLeg.verdict : null)
    : null;

  const terminalUsableWh = source.energy.usableWh - mission.wh;
  const reserveFloorWh = composed.ok ? composed.totalWh : null;

  return {
    ok: true,
    variant: {
      stops: withServiceTimes.stops,
      projectedStops: projected.stops,
      totals: projected.totals,
      packing: packed,
      loadState: load.loadState,
      peakLoadedMassKg: load.peakLoadedMassKg,
      occupancy: load.occupancy,
      legProfiles: profiles.profiles,
      mission,
      distribution,
      perStopEnergy: perStopEnergy.perStop,
      returnLeg,
      contingency,
      reserves: composed,
      tiers: tiersEvaluated,
      energyFragment,
      terminalUsableWh,
      reserveFloorWh,
      terminal: {
        lat: terminalStopInput.lat ?? null,
        lon: terminalStopInput.lon ?? null,
        cellId: terminalStopInput.cellId ?? null,
        zoneId: terminalStopInput.zoneId ?? null,
        usableWh: terminalUsableWh,
        soc: isNumber(agent.packNominalWh) && agent.packNominalWh > 0 ? terminalUsableWh / agent.packNominalWh : null,
        releaseMs: lastStop.departureMs,
      },
      // §13.1's last bullet. A plan can be infeasible at stop 3 while being fine at 1 and
      // 2, so the record is per stop rather than a single verdict.
      stopFeasibility: projected.stops.map((stop) => ({
        sequence: stop.sequence,
        windowMissedMs: stop.windowMissed,
        waitSeconds: stop.waitSeconds,
        energyRemainingWh:
          (perStopEnergy.perStop.find((row) => row.sequence === stop.sequence) || {}).remainingUsableWh ?? null,
      })),
    },
    problems,
  };
}

/**
 * Does this variant hold its reserves? The question §13.4 asks before inserting a
 * charging stop, and the one F34 asks at the gate.
 *
 * @param {object} variant
 * @returns {boolean}
 */
function reservesHold(variant) {
  if (!variant || !variant.reserves || !variant.reserves.ok) return false;
  if (!variant.tiers || !variant.tiers.ok) return false;
  return variant.terminalUsableWh >= variant.reserveFloorWh;
}

/**
 * §13.4 — attempt to insert a charging stop, at each admissible position, and keep the
 * feasible one that adds the least time.
 *
 * The inserted stop carries the charger's reservation *requirement*, the projected queue
 * wait from the pinned projection, the Scheduler's published target SoC, and the charge
 * duration from §14.6's nonlinear curve. It does **not** carry a reservation: inserting a
 * charging stop is a plan, not a booking (§13.4, §14.7).
 *
 * @param {object} input see `build`
 * @param {object[]} stops the sequence without a charging stop
 * @returns {{ ok: boolean, variant: object|null, insertion: object|null, attempts: object[] }}
 */
function insertChargingStop(input, stops) {
  const source = input || {};
  const charging = source.charging || {};
  const attempts = [];

  const targetSoc = charging.targetSoc;
  if (!isNumber(targetSoc)) {
    return {
      ok: false,
      variant: null,
      insertion: null,
      attempts: [
        {
          position: null,
          reason:
            "no target SoC is available. §14.6 gives the Charging Scheduler ownership of the target and " +
            "forbids the engine to compute one; with neither a published target nor the class fallback " +
            "resolved, there is no target to charge to and no charging stop can be planned",
        },
      ],
    };
  }

  const startSoc = isNumber(charging.currentSoc) ? charging.currentSoc : null;
  if (startSoc === null) {
    return { ok: false, variant: null, insertion: null, attempts: [{ position: null, reason: "the agent's current SoC is unresolved" }] };
  }

  const charge = chargeCurve.timeToChargeSeconds({
    curve: charging.curve,
    fromSoc: startSoc,
    toSoc: targetSoc,
    tempC: charging.tempC,
    chargerClass: charging.chargerClass,
    packUsableWh: charging.packUsableWh,
    steps: charging.integrationSteps,
  });
  if (!charge.ok) {
    return { ok: false, variant: null, insertion: null, attempts: [{ position: null, reason: charge.reason || charge.missing.join(", ") }] };
  }

  const queueWaitSeconds = isNumber(charging.queueWaitSeconds) ? charging.queueWaitSeconds : 0;

  let best = null;
  // Positions 0..n: before every stop, and after the last. Enumerated in index order so
  // the search and its tie-break are canonical (§9.6 requirement 2).
  for (let position = 0; position <= stops.length; position += 1) {
    const chargeStop = {
      sequence: 0,
      stopType: CHARGE_STOP_TYPE,
      legId: stops.length > 0 ? stops[Math.min(position, stops.length - 1)].legId : null,
      lat: charging.chargerLat ?? null,
      lon: charging.chargerLon ?? null,
      cellId: charging.chargerCellId ?? null,
      zoneId: charging.chargerZoneId ?? null,
      siteId: charging.chargerSiteId ?? null,
      chargeSeconds: charge.seconds + queueWaitSeconds,
      chargeEnergyWh: charge.energyWh,
      chargerId: charging.chargerId ?? null,
      targetSoc,
      targetSocSource: charging.targetSocSource ?? null,
      queueWaitSeconds,
      // §14.7: the engine never creates the reservation. It records that one is needed.
      reservationRequired: charging.reservationRequired === true,
      reservationHeld: false,
      waitPermitted: true,
    };

    const candidateStops = [...stops.slice(0, position), chargeStop, ...stops.slice(position)].map(
      (stop, index) => ({ ...stop, sequence: index + 1 }),
    );

    const hops = typeof source.hopsForSequence === "function" ? source.hopsForSequence(candidateStops) : null;
    if (!hops) {
      attempts.push({ position, reason: "no travel times are available for this insertion position" });
      continue;
    }

    const built = buildVariant(
      {
        ...source,
        hops,
        energy: {
          ...source.energy,
          // The charge restores energy at the inserted stop. Modelled as a larger usable
          // budget over the whole plan rather than as a negative consumption term:
          // §14.5's layers are additive and a negative leg energy would fund another
          // leg's reserve, which is the trade the module refuses outright.
          usableWh: source.energy.usableWh + charge.energyWh,
        },
      },
      candidateStops,
    );

    if (!built.ok) {
      attempts.push({ position, reason: built.problems.join("; ") });
      continue;
    }
    if (!reservesHold(built.variant)) {
      attempts.push({ position, reason: "the plan still violates a reserve after charging at this position" });
      continue;
    }

    const addedSeconds = built.variant.totals.durationSeconds;
    if (best === null || addedSeconds < best.addedSeconds) {
      best = { position, addedSeconds, variant: built.variant, chargeStop };
    }
  }

  if (best === null) return { ok: false, variant: null, insertion: null, attempts };

  return {
    ok: true,
    variant: best.variant,
    insertion: Object.freeze({
      position: best.position,
      chargeSeconds: charge.seconds,
      queueWaitSeconds,
      chargeEnergyWh: charge.energyWh,
      fromSoc: startSoc,
      targetSoc,
      targetSocSource: charging.targetSocSource ?? null,
      chargerId: charging.chargerId ?? null,
      reservationRequired: charging.reservationRequired === true,
      note: "a plan, not a booking: the reservation is requested at commit and the Scheduler may refuse (§13.4, §14.7)",
    }),
    attempts,
  };
}

/**
 * Build a plan for one candidate pairing.
 *
 * @param {object} input
 * @param {object} input.agent `{ agentId, agentClassId, releaseAtMs, packNominalWh, … }`
 * @param {object[]} input.committedLegs the Legs the agent already holds
 * @param {object[]} input.newLegs the Legs this candidate would add
 * @param {object[]} input.hops travel into each stop, from the cell-pair cache, each carrying
 *   `{ distanceM, travelSeconds, travelSdSeconds, climbM, descentM, stopStartCycles }`
 * @param {(stops: object[]) => object[]} [input.hopsForSequence] re-resolves hops for a
 *   re-sequenced stop list; required for charging insertion, and the reason an inserted
 *   charging stop gets its own terrain rather than none
 * @param {object} input.serviceTime §13.2's inputs
 * @param {object} input.payload §15's inputs
 * @param {object} input.energy §14's inputs
 * @param {object} input.charging §13.4/§14.6's inputs
 * @param {object} input.environment `{ ambientC, packC }`
 * @param {object} input.masses
 * @param {object|Map} input.config
 * @param {number} input.decisionTimeMs
 * @param {number} input.commitmentHorizonSeconds `plan.commitment_horizon`
 * @returns {{ ok: boolean, plan: object|null, charging: string, problems: string[],
 *             degradations: object[] }}
 */
function build(input) {
  const source = input || {};
  const sequenced = sequenceStops(source);
  if (!sequenced.ok) {
    return { ok: false, plan: null, charging: CHARGING.NOT_REQUIRED, problems: sequenced.problems, degradations: [] };
  }

  const first = buildVariant(source, sequenced.stops);
  if (!first.ok) {
    return { ok: false, plan: null, charging: CHARGING.NOT_REQUIRED, problems: first.problems, degradations: [] };
  }

  let variant = first.variant;
  let chargingOutcome = CHARGING.NOT_REQUIRED;
  let insertion = null;
  let attempts = [];

  if (!reservesHold(variant)) {
    // §13.4: attempt a charging stop before declaring the pairing infeasible. The plan is
    // then priced normally, so "can do it after a 12-minute top-up" competes honestly
    // against "can do it immediately" rather than being excluded from the comparison.
    const charged = insertChargingStop(source, sequenced.stops);
    attempts = charged.attempts;
    if (charged.ok) {
      variant = charged.variant;
      insertion = charged.insertion;
      chargingOutcome = CHARGING.INSERTED;
    } else {
      chargingOutcome = CHARGING.NO_FEASIBLE_INSERTION;
    }
  }

  const lastProjected = variant.projectedStops[variant.projectedStops.length - 1];
  const firstProjected = variant.projectedStops[0];

  // `t_terminal` (§8.2): the mandatory post-mission activity this mission causes. It is
  // the inserted charge when one was needed, and zero otherwise. There is no
  // return-to-base leg here: §13.5 makes return an emergent outcome of V_terminal, not a
  // rule the planner applies.
  const terminalSeconds = insertion ? insertion.chargeSeconds + insertion.queueWaitSeconds : 0;

  const plan = {
    planId: source.planId ?? null,
    agentId: (source.agent || {}).agentId ?? null,
    agentClassId: (source.agent || {}).agentClassId ?? null,

    legs: sequenced.legs,
    stops: variant.stops.map((stop, index) => ({
      ...stop,
      ...variant.projectedStops[index],
      load: (variant.loadState || [])[index] ?? null,
      energy: (variant.perStopEnergy || [])[index] ?? null,
    })),

    // ── The fields the 38 predicates read (§7.5) ────────────────────────────
    projectedStartMs: firstProjected.projectedArrivalMs,
    projectedEndMs: lastProjected.departureMs,
    horizonEndMs: lastProjected.departureMs,
    earliestFeasibleCompletionMs: lastProjected.departureMs,
    latestFeasibleStartMs: source.latestFeasibleStartMs ?? null,
    concurrentCommitments: sequenced.legs.length,
    peakLoadedMassKg: variant.peakLoadedMassKg,
    distanceM: variant.totals.distanceM,
    durationSeconds: variant.totals.durationSeconds,
    loadState: variant.loadState,
    packing: variant.packing,
    energy: variant.energyFragment,
    route: source.route ?? null,
    environmentForecast: source.environmentForecast ?? null,

    // ── The fields Φ reads (§8) ──────────────────────────────────────────────
    components: {
      waitSeconds: variant.totals.waitSeconds,
      approachSeconds: variant.totals.approachSeconds,
      serviceFirstSeconds: variant.totals.serviceFirstSeconds,
      linehaulSeconds: variant.totals.linehaulSeconds,
      serviceLastSeconds: variant.totals.serviceLastSeconds,
      terminalSeconds,
    },
    energyWh: variant.mission.wh,
    energyDistribution: { meanWh: variant.distribution.meanWh, sdWh: variant.distribution.sdWh },
    actuatorCycles: source.actuatorCycles ?? {},
    brakingEvents: source.brakingEvents ?? 0,
    gradientExposureM: source.gradientExposureM ?? 0,
    thermalExposedSeconds: variant.totals.durationSeconds,
    thermalStressMultiplier: source.thermalStressMultiplier,

    // ── The terminal state V_terminal reads (§8.3.2) ─────────────────────────
    origin: {
      lat: (source.agent || {}).lat ?? null,
      lon: (source.agent || {}).lon ?? null,
      cellId: (source.agent || {}).cellId ?? null,
      zoneId: (source.agent || {}).zoneId ?? null,
      startMs: (source.agent || {}).releaseAtMs ?? null,
    },
    terminal: variant.terminal,

    // ── Provenance, so a decision can name what it was built from ────────────
    provenance: {
      decisionTimeMs: source.decisionTimeMs ?? null,
      chargerProjectionVersion:
        (source.charging && source.charging.projection && source.charging.projection.version) ?? null,
      energyModelVersion: (source.energy && source.energy.model && source.energy.model.version) ?? null,
      serviceTimeSources: variant.stops.map((stop) => stop.serviceTimeSource ?? null),
    },

    // ── §13.1's remaining bullets ────────────────────────────────────────────
    stopFeasibility: variant.stopFeasibility,
    reserves: variant.reserves.ok ? variant.reserves.layers : null,
    reserveFloorWh: variant.reserveFloorWh,
    charging: insertion,
    legProfiles: variant.legProfiles,
  };

  const problems = [];
  if (chargingOutcome === CHARGING.NO_FEASIBLE_INSERTION) {
    problems.push(
      "no charging insertion produces a plan that holds its reserves; §13.4 leaves the rejection to " +
        "F34 rather than refusing to produce the artefact, so the plan is returned with its reserve " +
        "shortfall visible and the gate decides",
    );
  }

  const degradations = [];
  if (variant.returnLeg && variant.returnLeg.degradation) degradations.push(variant.returnLeg.degradation);

  return {
    ok: true,
    plan,
    charging: chargingOutcome,
    chargingAttempts: attempts,
    problems,
    degradations,
  };
}

/**
 * `E_usable(a)` for the plan's start, from §14.3's five-factor product.
 *
 * Offered here so a caller building a plan does not reach into `energy/usable.js` with a
 * partial factor set and quietly get a different number from the one the gate will use.
 *
 * @param {object} input as `energy/usable.usableWh`
 * @returns {ReturnType<typeof usable.usableWh>}
 */
function startingUsableWh(input) {
  return usable.usableWh(input);
}

module.exports = {
  MS_PER_SECOND,
  CHARGE_STOP_TYPE,
  FAILURE,
  CHARGING,
  sequenceStops,
  resolveServiceTimes,
  legProfiles,
  projectEnergyPerStop,
  buildVariant,
  reservesHold,
  insertChargingStop,
  build,
  startingUsableWh,
};

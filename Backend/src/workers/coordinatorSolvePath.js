"use strict";

/**
 * The Assignment Coordinator's solve path, **assembled** — V1's composition root.
 *
 * ── What this closes ───────────────────────────────────────────────────────
 * `workers/coordinator.worker.js` takes `expandCandidates`, `pricedCandidateFor`,
 * `expansionInputFor`, `planState` and `commit` injected. Every one of those existed only
 * inside test fixtures, and `tools/verify/phase9ProductionPath.js` said so in its own
 * header — *"nothing in this process constructs its solve path"*. `coordinatorPipeline.js`
 * measured what the assembly would need; **this module is the assembly.**
 *
 * ── What it is, and what it deliberately is not ────────────────────────────
 * It is **dependency assembly and nothing else.** There is no candidate generation here,
 * no feasibility rule, no cost term, no plan construction and no durable write: every one
 * of those is an existing module, called with the round's pinned inputs and its own
 * declared contract. The functions below are wiring plus the two adapters the wired
 * modules explicitly ask their caller for —
 *
 *   · `buildContext`, which `feasibility/volatileSubset.createVolatileRecheck` requires
 *     and whose header names its owner: *"assembling an agent snapshot from a transaction
 *     is the round's work (Phase 9/10) and not this module's."* This **is** the round's
 *     composition root, so it is written here.
 *   · the `sideEffects` writer §10.3.2 step 5 requires, which is one call to
 *     `dispatch/offers.enqueueOffer` inside the commit transaction.
 *
 * ── Fail closed, everywhere, by name ───────────────────────────────────────
 * **Nothing here defaults, infers, coerces or substitutes.** That is not a stylistic
 * preference; it is the standing finding of this programme, most recently E-8, where
 * `legProfiles` turned an absent terrain profile into flat ground and thereby made
 * `consumption.REQUIRED_PROFILE_FIELDS`' refusal *unreachable*. The rules this module
 * holds itself to:
 *
 *   1. Every input is either taken from a real source — the pinned snapshot, a persisted
 *      row, or an injected seam — or it is **absent**, and the module that needs it
 *      refuses and names it. This module never fills a gap.
 *   2. `create()` refuses before building anything when
 *      `coordinatorPipeline.requirements()` reports an unresolved input, so a missing
 *      routing source produces **no assembly at all** rather than an assembly that
 *      silently prices nothing.
 *   3. Every per-candidate refusal carries the refusing module's own `problems`/`missing`
 *      list, unedited, so a decision record can name the input rather than the layer.
 *   4. A candidate that cannot be priced is **not a candidate**. `evaluateExact` returns
 *      `feasible: false` with `gammaMilliCU: null`, which `expansion.js` already excludes
 *      from the ordered set, rather than a plausible price.
 *
 * ── Why the round's own price is memoised ──────────────────────────────────
 * `expansion.expandCandidates` calls `evaluateExact` (async) and `solve/round.plan` then
 * calls `pricedCandidateFor` (**synchronous**) for each survivor. The plan, its base plan
 * and its pricing arguments are produced by the first and consumed by the second, so the
 * assembly holds them in a per-round map keyed by `(legId, agentId)`. The map is round-
 * scoped and cleared at `beginRound`, because a plan pinned to one round's decision time
 * and configuration version must never be priced into another (§9.6 requirements 4–5).
 *
 * ── Tiers ──────────────────────────────────────────────────────────────────
 * Tier 1 by path (`src/workers/`). It therefore may not import a Tier 2 mechanism (§1.8
 * rule 2), and does not: `plan/insertion.js` (chaining), `cost/cDefer.js`,
 * `cost/cChurn.js` and `cost/cOpportunity.js` are absent from the requires below. Their
 * absence is the shipped behaviour — `phi.evaluate` records `C_opportunity` as an omitted
 * term rather than summing a zero, `column.price` does the same for `C_churn`, and
 * `round.plan` creates no deferral arc when `deferPriceFor` is not injected.
 */

const coordinatorPipeline = require("./coordinatorPipeline");
const coordinatorWorker = require("./coordinator.worker");

const cells = require("../engine/spatial/cells");
const expansion = require("../engine/candidates/expansion");
const omega = require("../engine/candidates/omega");
const cellPairCache = require("../engine/routing/cellPairCache");
const planBuilder = require("../engine/plan/planBuilder");
const timeline = require("../engine/plan/timeline");
const columnModel = require("../engine/plan/column");
const feasibility = require("../engine/feasibility/evaluate");
const volatileSubset = require("../engine/feasibility/volatileSubset");
const consumption = require("../engine/energy/consumption");
const usable = require("../engine/energy/usable");
const cDelay = require("../engine/cost/cDelay");
const { ratesFrom } = require("../engine/cost/exchangeRates");
const commitment = require("../engine/commitment/commit");
const offers = require("../engine/dispatch/offers");
const planStateModel = require("../engine/shard/planState");
const legMachine = require("../engine/lifecycle/legMachine");
const { energyCoefficientsFrom, fleetBestCaseFrom } = require("../engine/domain/mappers/decisionInputs");

/** @structural milliseconds per second — a unit conversion, not a threshold */
const MS_PER_SECOND = 1000;

/**
 * The §4.3 state a Leg enters when its commitment is written.
 *
 * `OFFERED`, not `PLANNED`: §10.3.2 step 5 writes the `OFFER` in the same transaction, so
 * by the time the transaction commits the agent has been told. Read from `legMachine`
 * rather than written as a literal, so a §4.3 rename cannot leave this composer naming a
 * state that no longer exists.
 * @structural §11.2's post-commit Leg state, resolved from the state machine
 */
const COMMITTED_LEG_STATE = legMachine.LEG_STATE.OFFERED;

/** Why an assembled collaborator refused. @structural the assembly's refusal taxonomy */
const REFUSAL = Object.freeze({
  /** A declared input from `coordinatorPipeline` did not resolve in this context. */
  REQUIREMENTS_UNRESOLVED: "REQUIREMENTS_UNRESOLVED",
  /** The routing seam could not answer for this pairing's stops. */
  MISSING_HOP: "MISSING_HOP",
  /** The Plan Builder refused; its own `problems` say which input. */
  PLAN_REFUSED: "PLAN_REFUSED",
  /** The §7.1 gate denied the pairing. Not an error — a priced-out candidate. */
  INFEASIBLE: "INFEASIBLE",
  /** `Φ`/`γ` could not be computed; the missing rates are named. */
  UNPRICEABLE: "UNPRICEABLE",
  /** The Leg or its stops are not resolvable from the store. */
  LEG_UNRESOLVED: "LEG_UNRESOLVED",
});

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isFunction = (value) => typeof value === "function";

/**
 * The key a priced candidate is memoised under.
 *
 * `|` rather than a space, because a Leg or agent identifier containing a space would
 * otherwise let two different pairings collide on one key — and a collision here does not
 * fail, it silently commits one pairing's plan under another's name. The separator is a
 * character neither identifier admits, and it is a named function so there is one
 * definition rather than four call sites that must be spelled identically.
 *
 * @param {string} legId
 * @param {string} agentId
 * @returns {string}
 * @structural the memo key's separator
 */
function pricedKey(legId, agentId) {
  return `${String(legId)}|${String(agentId)}`;
}

/**
 * Read a value from the pinned snapshot, scoped, without throwing.
 *
 * @param {object} snapshot
 * @param {string} name
 * @param {object} [scope]
 * @returns {*}
 */
function resolve(snapshot, name, scope) {
  if (!snapshot || !isFunction(snapshot.resolve)) return undefined;
  try {
    return snapshot.resolve(name, scope || {});
  } catch {
    return undefined;
  }
}

/**
 * `cost/cDelay.forLeg`'s `parameters`, resolved from the pinned snapshot — **strictly.**
 *
 * `diagnostics.controller.readDelayParameters` reads the same six names and coalesces each
 * absent one to a neutral value. That is admissible *there*: the endpoint publishes
 * `LB(a, l)`, and understating a lower bound leaves it a lower bound. It is **not**
 * admissible here, where the same numbers price the exact `γ` a commitment is taken on:
 * a zeroed `cost.sla.cu_per_second_late` prices a late completion identically to a
 * punctual one, which is E-8's defect wearing a different parameter's name.
 *
 * So this reader substitutes nothing and reports what did not resolve. `cDelay.forLeg`
 * refuses on the same names, and the two agree because neither invents.
 *
 * @param {object} snapshot
 * @param {object} [scope]
 * @returns {{ ok: boolean, parameters: object|null, missing: string[] }}
 */
function delayParametersFrom(snapshot, scope) {
  const names = [
    "cost.sla.cu_per_second_late",
    "cost.sla.breach_penalty",
    "cost.sla.lateness_exponent",
    "cost.sla.upstream_slack_weight",
    "cost.aging.reference_period",
    "cost.aging.growth_exponent",
    "cost.aging.max_multiplier",
  ];
  const values = Object.create(null);
  const missing = [];
  for (const name of names) {
    const value = resolve(snapshot, name, scope);
    if (!isNumber(value)) missing.push(name);
    else values[name] = value;
  }
  if (missing.length > 0) return { ok: false, parameters: null, missing };

  return {
    ok: true,
    parameters: {
      slaRate: { value: values["cost.sla.cu_per_second_late"] },
      breachPenaltyCu: values["cost.sla.breach_penalty"],
      latenessExponent: values["cost.sla.lateness_exponent"],
      upstreamSlackWeight: values["cost.sla.upstream_slack_weight"],
      aging: {
        referencePeriodSeconds: values["cost.aging.reference_period"],
        growthExponent: values["cost.aging.growth_exponent"],
        maxMultiplier: values["cost.aging.max_multiplier"],
      },
    },
    missing: [],
  };
}

/**
 * The composition context, with the values the composition root resolves for itself.
 *
 * Only one thing is added, and it is the reason it exists: §6.3 bounds the expansion by a
 * radius **or** a wall-clock budget, and the wall-clock half is a *composition* input —
 * `solve.time_budget` is registered, resolves, and is what `solve/budgets.js` already
 * enforces the round against. The probe cannot see it on the raw context because nothing
 * had ever resolved it, which is why the requirement read as blocked on a parameter §6.3
 * does not require on its own.
 *
 * @param {object} context the `leaderWorkers.create()` settings
 * @returns {object} the same context plus `expansionWallClockBudgetMs`
 */
function contextFor(context) {
  const source = context || {};
  const snapshot = coordinatorPipeline.snapshotFrom(source);
  // Already milliseconds: the register declares `"unit": "ms"` for this entry, so there is
  // no conversion to get wrong here — and getting it wrong by a factor of 1 000 would give
  // the expansion a four-minute budget inside a 250 ms round, which is a bound that exists
  // and never binds.
  const budgetMs = resolve(snapshot, "solve.time_budget", {});
  return {
    ...source,
    expansionWallClockBudgetMs: isNumber(budgetMs) && budgetMs > 0 ? budgetMs : undefined,
  };
}

/**
 * The routing seam: `routing/cellPairCache` bound to the injected router and cache.
 *
 * The composition root never calls a routing engine; it hands `cellPairCache` the `route`
 * function it was given and lets the cache decide when to fall through. With no router the
 * cache answers *"no router is available and the entry is not cached"* and `hopsFor`
 * reports it per stop — which is the refusal `create()` has already prevented anyone from
 * reaching, and which stays correct if a router is later withdrawn at runtime.
 *
 * @param {object} context
 * @returns {{ deps: object, optionsFor: (profileKey: string) => object, counters: object }}
 */
function routingSeamFor(context) {
  const snapshot = coordinatorPipeline.snapshotFrom(context);
  const counters = new cellPairCache.Counters();

  return {
    counters,
    deps: { kv: context.kv, route: context.route, counters },
    optionsFor(profileKey) {
      const speed = isFunction(context.speedMetresPerSecondFor)
        ? context.speedMetresPerSecondFor(profileKey)
        : context.speedMetresPerSecond;
      return {
        ttlSeconds: resolve(snapshot, "route.cell_pair_cache_ttl", {}),
        intraCellOffsetM: resolve(snapshot, "route.intra_cell_offset_m", {}),
        // Passed through exactly as the seam supplied it. `applyIntraCellOffset` refuses a
        // non-positive speed and the uncorrected entry is then *not* used as if corrected:
        // §20.3's quantisation is a real inflation and omitting it understates travel.
        speedMetresPerSecond: speed,
      };
    },
  };
}

/**
 * Load one agent as the decision path reads it: position, class, mobility and energy
 * models, battery state, and its live HARD commitments.
 *
 * Every field comes from a column. **Nothing is derived to fill a gap** — an agent with no
 * `BatteryState` row carries `soc: null`, and F7/F34 refuse it, which is the fail-closed
 * answer §14.3 asks for rather than an assumed state of charge.
 *
 * @param {object} context
 * @returns {(agentId: string) => Promise<object|null>}
 */
function agentSnapshotLoaderFor(context) {
  const prisma = context.prisma;

  return async function loadAgentSnapshot(agentId) {
    const position = await prisma.agentCellPosition.findFirst({
      where: { agentId },
      include: {
        agent: {
          include: {
            batteryState: true,
            commitments: { where: { releasedAt: null } },
            agentClass: {
              include: {
                mobilityModel: true,
                energyModel: true,
                containerModel: true,
                capabilityBundle: true,
                energyModelParams: { orderBy: { modelVersion: "desc" }, take: 1 },
              },
            },
          },
        },
      },
    });
    if (!position || !position.agent) return null;

    const agent = position.agent;
    const agentClass = agent.agentClass || null;
    const params = agentClass && agentClass.energyModelParams ? agentClass.energyModelParams[0] : null;
    const battery = agent.batteryState || null;
    const environment = isFunction(context.environmentFor) ? context.environmentFor(agent.agentId) : null;

    return {
      // Identity. Both, deliberately: `commit.js` locks on `Agent.id` and every engine
      // module reads the business identifier, and conflating them is a defect
      // `diagnoseMissingRow` exists to name.
      agentId: agent.agentId,
      agentRowId: agent.id,
      agentClassId: agentClass ? agentClass.classId : null,

      lifecycleState: agent.lifecycleState,
      authorityEpoch: agent.authorityEpoch,
      fenceCounter: agent.fenceCounter,
      capacityOverride: agent.capacityOverride,
      tenantId: agent.tenantId,
      fleetId: agent.fleetId,
      regionId: agent.regionId,
      homeDepotId: agent.homeDepotId,

      lat: position.lat,
      lon: position.lon,
      cellId: position.fineCellId,
      coarseCellId: position.coarseCellId,
      availabilityClass: position.availabilityClass,
      capabilityClasses: position.capabilityClasses,
      containerClasses: position.containerClasses,
      observedAtMs: Number(position.observedAtMs),

      mobilityModel: agentClass && agentClass.mobilityModel
        ? { kinematicLimits: agentClass.mobilityModel.kinematicLimits, traversalDomain: agentClass.mobilityModel.traversalDomain }
        : null,
      containerModel: agentClass ? agentClass.containerModel : null,
      capabilityBundle: agentClass ? agentClass.capabilityBundle : null,

      energyModel: agentClass ? agentClass.energyModel : null,
      energyModelParams: params,
      energyCoefficients: energyCoefficientsFrom(params),
      battery,
      // §14.2's self-correcting multiplier, from the row that carries it. Absent, it stays
      // absent: `consumption.missionEnergyWh` refuses a non-numeric κ rather than reading
      // one as neutral, and a κ silently read as 1 is an uncalibrated fleet reported as a
      // calibrated one.
      kappa: battery && isNumber(battery.kappa) ? battery.kappa : null,
      soc: battery && isNumber(battery.lastObservedSoc) ? battery.lastObservedSoc : null,
      soh: battery && isNumber(battery.soh) ? battery.soh : null,

      commitments: agent.commitments || [],
      hardCommitmentCount: (agent.commitments || []).length,

      // §14.2's thermal term. No column and no producer: supplied by the injected seam or
      // not at all — never an assumed ambient, which is the assumed range §14.3 removes.
      ambientC: environment && isNumber(environment.ambientC) ? environment.ambientC : null,
      packC: environment && isNumber(environment.packC) ? environment.packC : null,

      _position: position,
    };
  };
}

/**
 * The Leg and its stops, as `planBuilder` and the feasibility gate read them.
 *
 * @param {object} context
 * @returns {(legId: string) => Promise<object|null>}
 */
function legLoaderFor(context) {
  const prisma = context.prisma;

  return async function loadLeg(legId) {
    const leg = await prisma.leg.findFirst({
      where: { OR: [{ legId }, { id: legId }] },
      include: {
        stops: { orderBy: { sequence: "asc" } },
        manifests: true,
        mission: { include: { legs: { select: { id: true, sequence: true }, orderBy: { sequence: "asc" } } } },
      },
    });
    if (!leg) return null;

    const isTerminal =
      leg.mission && leg.mission.legs.length > 0
        ? leg.mission.legs[leg.mission.legs.length - 1].id === leg.id
        : true;

    return {
      legRowId: leg.id,
      legId: leg.legId,
      missionId: leg.mission ? leg.mission.missionId : null,
      missionRowId: leg.missionId,
      purpose: leg.purpose,
      state: leg.state,
      custodyState: leg.custodyState,
      version: leg.version,
      cancelRequestedAt: leg.cancelRequestedAt,
      obstructionClass: leg.obstructionClass,
      role: isTerminal ? cDelay.LEG_ROLE.TERMINAL : cDelay.LEG_ROLE.UPSTREAM,
      // §8.7 prices lateness against the Leg's own target and deadline. `Leg.slaDeadline`
      // is the only one the schema carries, so target and deadline are the same instant
      // here — stated rather than silently split into two different numbers.
      targetMs: leg.slaDeadline ? leg.slaDeadline.getTime() : null,
      deadlineMs: leg.slaDeadline ? leg.slaDeadline.getTime() : null,
      startNotBeforeMs: leg.startNotBefore ? leg.startNotBefore.getTime() : null,
      createdAtMs: leg.createdAt ? leg.createdAt.getTime() : null,
      manifests: leg.manifests || [],
      stops: leg.stops.map((stop) => ({
        stopId: stop.stopId,
        sequence: stop.sequence,
        stopType: stop.stopType,
        siteId: stop.siteId,
        lat: stop.lat,
        lon: stop.lon,
      })),
    };
  };
}

/**
 * §15's payload inputs for one Leg, from its `PayloadManifest` rows.
 *
 * ── Schema-backed, and therefore this repository's to assemble ─────────────
 * §F.0 classed payload as *"schema-backed (`PayloadSpec`, `massKg`, `massToleranceKg`) —
 * **assembly code absent**"*, which is to say: not an external input, and not a decision
 * anyone is withholding. It is this function.
 *
 * ── The precedence, and why it is a precedence rather than a sum ───────────
 * A manifest may carry an **observed** mass (weighed), a **declared** mass (stated by the
 * consignor), or neither, in which case its `PayloadSpec` states the item's nominal mass.
 * The observed value is preferred where it exists because §15.4's mass budget is a physical
 * constraint and a weighed mass is a measurement where a declared one is a claim. The order
 * is stated here rather than left to whichever field happened to be non-null.
 *
 * **A manifest resolving to no mass at all makes the whole Leg's mass absent**, not a
 * partial sum: summing the manifests that *did* resolve would understate the load, and
 * understating mass understates consumption — the permissive direction, and E-8's exact
 * failure mode one model along. `legProfiles` then refuses with `profile.payloadMassKg`.
 *
 * @param {object} leg from `legLoaderFor`
 * @returns {{ massKg: number|undefined, items: object[], unresolved: string[] }}
 */
function payloadFor(leg) {
  const manifests = (leg && leg.manifests) || [];
  const unresolved = [];
  const items = [];
  let massKg = 0;

  for (const manifest of manifests) {
    const spec = manifest.payloadSpec || null;
    const resolvedMass = [manifest.observedMassKg, manifest.declaredMassKg, spec && spec.massKg].find((value) =>
      isNumber(value),
    );
    if (!isNumber(resolvedMass)) {
      unresolved.push(`manifest ${String(manifest.manifestId ?? manifest.id)} states no mass`);
      continue;
    }
    massKg += resolvedMass;
    if (Array.isArray(manifest.items)) items.push(...manifest.items);
  }

  // No manifest at all is a *stated* empty load — a Leg carrying nothing weighs nothing —
  // and is distinct from a manifest that exists and cannot say what it weighs. The two must
  // not produce the same number, which is the same distinction §F.2 draws for a declared
  // zero climb against a silent one.
  return {
    massKg: unresolved.length > 0 ? undefined : massKg,
    items,
    unresolved,
  };
}

/**
 * `Φ`'s per-plan argument set, assembled from the pinned snapshot, the plan, and the
 * injected seams.
 *
 * Every rate comes from `cost/exchangeRates.ratesFrom`, which reads the register through
 * `snapshot.explain` and **omits** a name that does not resolve. The omission is the point:
 * `cDirect`, `cRisk` and `cLifecycle` each check their own rates and name the missing ones,
 * so an unresolved `cost.wear.cu_per_metre` surfaces as that parameter's name in the
 * decision record rather than as an unexplained unpriceable column.
 *
 * @param {object} input
 * @returns {{ ok: boolean, phiInput: object|null, missing: string[] }}
 */
function phiInputFor(input) {
  const { plan, snapshot, scope, agentSnapshot, leg, decisionTimeMs, seams, correction } = input;
  const missing = [];

  const rates = ratesFrom(snapshot, scope || {});
  const delay = delayParametersFrom(snapshot, scope);
  if (!delay.ok) missing.push(...delay.missing);

  // §8.4 — `p_late` from the ETA predictive distribution, computed by the module that owns
  // the projection rather than re-derived here.
  const eta = timeline.lateProbability(plan.stops, leg.deadlineMs);
  if (!eta.ok) missing.push("plan.stops[].band.departureSdSeconds (p_late, §8.4)");

  // §8.3.1's `E[C_delay overrun | late]`, priced by `cDelay` itself at the completion time
  // lateness implies — never a second delay model.
  let overrunMilliCU = null;
  if (delay.ok && eta.ok && isNumber(eta.meanMs) && isNumber(eta.sdSeconds)) {
    const overrun = cDelay.overrunGivenLate(
      { legId: leg.legId, role: leg.role, targetMs: leg.targetMs, deadlineMs: leg.deadlineMs, queueAgeSeconds: input.queueAgeSeconds },
      eta.meanMs + eta.sdSeconds * MS_PER_SECOND,
      delay.parameters,
    );
    if (overrun.ok) overrunMilliCU = overrun.milliCU;
    else missing.push(...overrun.missing.map((name) => `C_risk overrun: ${name}`));
  }

  const failure = isFunction(seams.failureProbabilityFor) ? seams.failureProbabilityFor(agentSnapshot) : null;
  const routeHazardCu = isFunction(seams.routeHazardCuFor) ? seams.routeHazardCuFor(plan) : null;

  const phiInput = {
    direct: {
      lambdaTime: rates["cost.lambda_time"],
      cuPerWh: rates["cost.energy.cu_per_wh"],
      cuPerMetreWear: rates["cost.wear.cu_per_metre"],
    },
    risk: {
      failure,
      failureConsequenceCu: resolve(snapshot, "cost.failure.cu", scope),
      // §14.5's three tier probabilities, taken from the plan the Plan Builder produced.
      tierProbabilities: (plan.energy && plan.energy.tierProbabilities) || null,
      energyConsequenceCu: resolve(snapshot, "cost.energy_consequence", scope),
      lateProbability: eta.ok ? eta.lateProbability : null,
      overrunMilliCU,
      staleness: {
        // §8.3's staleness is measured on the *oldest* safety-relevant observation. The
        // agent snapshot carries whatever the store recorded; when it carries none,
        // `stalenessPenalty` names `agentSnapshot.safetyRelevantObservations` and the
        // candidate is unpriceable — which is the correct answer for an agent whose
        // freshness nothing can establish.
        safetyRelevantObservations: agentSnapshot.safetyRelevantObservations,
        decisionTimeMs,
        stalenessRate: rates["cost.staleness.cu_per_second_age"],
      },
      routeHazardCu,
    },
    lifecycle: {
      cuPerMetreWear: rates["cost.wear.cu_per_metre"],
      // §14.4's DoD-weighted battery cost. `energy/wear.batteryWear` needs the pack's
      // stress curves and the mission's `{ dod, socMid, tempC, cRate }`, and **no schema
      // column carries either**: `EnergyModel` holds `chargePowerCurve` and
      // `thermalDeratingCurve` and no wear curve at all. Supplied by the injected seam or
      // not at all — `batteryWear` then names `curves`/`conditions` and `cLifecycle`
      // carries the refusal up as `battery.*`.
      battery: isFunction(seams.batteryWearInputsFor)
        ? {
            ...seams.batteryWearInputsFor(agentSnapshot, plan),
            cuPerEquivalentCycle: resolve(snapshot, "cost.battery.cu_per_equivalent_cycle", scope),
          }
        : { cuPerEquivalentCycle: resolve(snapshot, "cost.battery.cu_per_equivalent_cycle", scope) },
      cuPerActuatorCycle: resolve(snapshot, "lifecycle.cu_per_actuator_cycle", scope),
      cuPerBrakingEvent: resolve(snapshot, "lifecycle.cu_per_braking_event", scope),
      gradientRate: rates["lifecycle.cu_per_gradient_metre"],
      thermalRate: rates["lifecycle.cu_per_thermal_stress_second"],
    },
    policy: {
      // §8.6's adjustments are operator acts recorded against a decision, and none is
      // offered by a round of its own accord. An empty list is the honest content of "no
      // operator has adjusted this pairing", not a placeholder.
      adjustments: [],
      config: { get: (name) => resolve(snapshot, name, scope) },
      decisionTimeMs,
      omegaPolicyCu: correction.policy && correction.policy.cu,
    },
    completionByLegId: timeline.legCompletions(plan.stops, plan.stops),
    delayParametersFor: () => (delay.ok ? delay.parameters : null),
    // §6.4's two negative-term bounds, taken from the same `omega` result the search's
    // admissible bound subtracted. One resolution, so `Φ`'s sign discipline and `LB`'s
    // correction cannot disagree about how negative a term is permitted to be.
    bounds: correction.ok
      ? {
          omegaTerminalMilliCU: correction.breakdown.omegaTerminalMilliCU,
          omegaPolicyMilliCU: correction.breakdown.omegaPolicyMilliCU,
        }
      : {},
  };

  return { ok: missing.length === 0, phiInput, missing };
}

/**
 * Build the `plan/planBuilder.build()` input for one (agent, Leg) pairing.
 *
 * Every field is read from a real source or left absent. The four families this repository
 * has no producer for — hop terrain, ambient/pack temperature, vehicle mass, and the
 * energy residual CV — arrive through injected seams or the register, and where they do
 * not arrive, `buildVariant` returns `{ ok: false, problems }` naming them. That refusal
 * is the deliverable, not a fault to be worked around.
 *
 * @param {object} input
 * @returns {object} the `planBuilder.build` input
 */
function planInputFor(input) {
  const { agentSnapshot, leg, hops, hopsForSequence, snapshot, scope, decisionTimeMs, seams } = input;
  const payload = payloadFor(leg);

  const vehicleMassKg = isFunction(seams.vehicleMassKgFor)
    ? seams.vehicleMassKgFor(agentSnapshot.agentClassId, agentSnapshot)
    : seams.vehicleMassKg;

  const packNominalWh = agentSnapshot.energyModel && isNumber(agentSnapshot.energyModel.packNominalWh)
    ? agentSnapshot.energyModel.packNominalWh
    : null;

  // §14.3's five-factor product, through the module that owns it.
  //
  // `f_temp` is **derived, not assumed**: `energy/usable.fTemp(model, packC)` evaluates the
  // pack's own `thermalDeratingCurve` at the pack temperature, and both halves come from
  // real sources — the curve is an `EnergyModel` column and the temperature is the injected
  // environment seam. `diagnostics.controller` reports `E_usable` at `f_temp = 1` and says
  // so, which is admissible for a read-only figure and is not admissible here: a pack
  // reported at its rated temperature when the real one is −5 °C overstates usable energy,
  // which is the permissive direction on a feasibility gate. Absent either half, `fTemp`
  // does not resolve, `usableWh` refuses, and the plan is refused with it.
  const derating = usable.fTemp(agentSnapshot.energyModel, agentSnapshot.packC);
  const usableEnergy = planBuilder.startingUsableWh({
    packNominalWh,
    soh: agentSnapshot.soh,
    fTemp: derating.ok ? derating.fTemp : undefined,
    soc: agentSnapshot.soc,
    fDerate: resolve(snapshot, "energy.f_derate", scope),
  });

  return {
    planId: `${leg.legId}:${agentSnapshot.agentId}:${decisionTimeMs}`,
    agent: {
      agentId: agentSnapshot.agentId,
      agentClassId: agentSnapshot.agentClassId,
      // The earliest instant the agent can start. An idle agent is released at the round's
      // pinned decision time; anything else is a chaining question, and chaining is Tier 2.
      releaseAtMs: decisionTimeMs,
      packNominalWh,
      lat: agentSnapshot.lat,
      lon: agentSnapshot.lon,
      cellId: agentSnapshot.cellId,
      zoneId: agentSnapshot.zoneId ?? null,
    },
    // Empty by construction, and not an omission: `capacity` resolves to 1 on this
    // register, so a candidate agent holds no other Leg. `plan₀` is then the empty plan and
    // `Φ(∅) = 0` exactly, which is §8.1's own degenerate case — the arrangement
    // `column.price` handles without a branch.
    committedLegs: [],
    newLegs: [
      {
        legId: leg.legId,
        missionId: leg.missionId,
        role: leg.role,
        slaClass: input.slaClass ?? null,
        tenantId: agentSnapshot.tenantId,
        targetMs: leg.targetMs,
        deadlineMs: leg.deadlineMs,
        queueAgeSeconds: input.queueAgeSeconds,
        custodyAlreadyHeld: leg.custodyState === "HELD",
        stops: leg.stops,
      },
    ],
    hops,
    hopsForSequence,
    serviceTime: {
      // §13.2's shrinkage ladder. No fitted models exist — `service_time_model` is a
      // DEFERRED worker — so the ladder falls to its prior, which is the register entry
      // that does not resolve. `resolveServiceTimes` names it.
      serviceTimeModels: null,
      priorSeconds: resolve(snapshot, "plan.service_time_prior", scope),
      priorCv: resolve(snapshot, "plan.service_time_prior_cv", scope),
      shrinkageStrength: resolve(snapshot, "plan.service_time_shrinkage_strength", scope),
      missionClassByLegId: { [leg.legId]: input.slaClass ?? null },
      utcOffsetSecondsBySite: input.utcOffsetSecondsBySite || {},
      nominalArrivalMsByStop: {},
    },
    payload: {
      container: agentSnapshot.containerModel,
      // §15's consignment, from the Leg's own manifests. `packing.evaluate` normalises it.
      consignment: payload.items.length > 0 ? { items: payload.items } : null,
      packingEfficiency: resolve(snapshot, "payload.packing_efficiency", scope),
      nodeBudget: resolve(snapshot, "payload.packing_node_budget", scope),
      // §15.6's per-stop load/unload plan. No column carries it, and inventing one would
      // assert a custody sequence nobody planned; `loadState.project` treats its absence as
      // "the manifest is loaded at the first stop", which is what a single-Leg plan means.
      itemsByStop: null,
    },
    energy: {
      model: agentSnapshot.energyCoefficients,
      kappa: agentSnapshot.kappa,
      usableWh: usableEnergy.ok ? usableEnergy.wh : undefined,
      residualCv: resolve(snapshot, "energy.model_residual_cv", scope),
      inflations: resolve(snapshot, "energy.uncertainty_inflation", scope),
      severity: input.uncertaintySeverity,
      floorWh: resolve(snapshot, "energy.reserve_floor_wh", scope),
      operationalWh: resolve(snapshot, "energy.operational_reserve_wh", scope),
      contingencyQuantile: resolve(snapshot, "energy.contingency_quantile", scope),
      availabilityMargin: resolve(snapshot, "energy.charger_availability_margin", scope),
      projectionMaxAgeSeconds: resolve(snapshot, "energy.projection_max_age", scope),
      uncalibratedReserveFactor: resolve(snapshot, "energy.uncalibrated_reserve_factor", scope),
    },
    charging: {
      // §14.5's `E_return` layer. The owner has declared that no production chargers exist
      // at either campus (`RD-2026-08-30-01`), so the candidate set is empty and
      // `eReturn.evaluate` reports the shortfall rather than crashing — a priced outcome,
      // which is what §13.4 asks for.
      chargerCandidates: input.chargerCandidates || [],
      projection: input.chargerProjection || null,
      // §14.6 gives the Charging Scheduler ownership of the target SoC and forbids the
      // engine to compute one. Absent, `insertChargingStop` refuses by name.
      targetSoc: input.targetSoc,
      targetSocSource: input.targetSocSource,
      currentSoc: agentSnapshot.soc,
      packUsableWh: usableEnergy.ok ? usableEnergy.wh : undefined,
      tempC: agentSnapshot.packC,
      curve: agentSnapshot.energyModel ? agentSnapshot.energyModel.chargePowerCurve : null,
    },
    environment: { ambientC: agentSnapshot.ambientC, packC: agentSnapshot.packC },
    masses: {
      vehicleMassKg: isNumber(vehicleMassKg) ? vehicleMassKg : undefined,
      // Keyed by Leg, because §14.2's mass term is per leg and a plan may cover several.
      // Absent when any of the Leg's manifests cannot state a mass — see `payloadFor`.
      payloadMassExpectedKgByLegId: payload.massKg === undefined ? {} : { [leg.legId]: payload.massKg },
    },
    config: { get: (name) => resolve(snapshot, name, scope) },
    slaClass: input.slaClass ?? null,
    decisionTimeMs,
    commitmentHorizonSeconds: resolve(snapshot, "plan.commitment_horizon", scope),
  };
}

/**
 * Build `evaluateExact` — the exact evaluation `candidates/expansion.js` calls per
 * surviving agent: §7's gate, then §13's Plan Builder, then §8's `Φ` and `γ`.
 *
 * This is where the four modules the audit called *"implemented but unreachable"* are
 * actually called in sequence, in production code, for the first time.
 *
 * @param {object} context
 * @param {object} round the per-round state (`priced` map, snapshot, correction, …)
 * @returns {(agentId: string, leg: object, agentSnapshot: object) => Promise<object>}
 */
function evaluateExactFor(context, round) {
  const routing = round.routing;

  return async function evaluateExact(agentId, legForBound, agentSnapshot) {
    const refuse = (refusal, problems) =>
      Object.freeze({ feasible: false, gammaMilliCU: null, refusal, problems: Object.freeze([...problems]) });

    // Resolved **by Leg**, not from a single slot. A round claims a batch and
    // `solve/round.plan` walks it Leg by Leg, so one slot holds only whichever Leg was
    // expanded last — and `commit` runs after the whole batch is planned, which is where
    // that would have surfaced: as a commitment written against the wrong Leg's row.
    const state = round.legs.get(String(legForBound.legId));
    if (!state) return refuse(REFUSAL.LEG_UNRESOLVED, [`no round state for Leg ${String(legForBound.legId)}`]);

    const { leg, snapshot, scope } = state;

    /* ── 1. The traversal, through the cell-pair cache ─────────────────────── */
    if (!agentSnapshot.cellId) return refuse(REFUSAL.MISSING_HOP, ["the agent has no resolved origin cell"]);

    const profileKey = round.profileKeyFor(agentSnapshot);
    const traversal = await routing.forPairing(agentSnapshot.cellId, leg.stops, profileKey);
    if (!traversal.ok) return refuse(REFUSAL.MISSING_HOP, traversal.problems);

    /* ── 2. The plan (§13) ────────────────────────────────────────────────── */
    const built = planBuilder.build(
      planInputFor({
        agentSnapshot,
        leg,
        hops: traversal.hops,
        hopsForSequence: traversal.hopsForSequence,
        snapshot,
        scope,
        decisionTimeMs: state.decisionTimeMs,
        seams: context,
        slaClass: state.slaClass,
        queueAgeSeconds: state.queueAgeSeconds,
      }),
    );
    if (!built.ok) return refuse(REFUSAL.PLAN_REFUSED, built.problems);

    /* ── 3. The feasibility gate (§7.1) — the only thing that may brand ────── */
    const gated = feasibility.gate(built.plan, {
      agentSnapshot,
      mission: round.missionFor(state),
      plan: built.plan,
      config: { get: (name) => resolve(snapshot, name, scope) },
      decisionTimeMs: state.decisionTimeMs,
      snapshotId: state.snapshotId,
    });
    if (!gated.feasible) {
      return Object.freeze({
        feasible: false,
        gammaMilliCU: null,
        refusal: REFUSAL.INFEASIBLE,
        denials: Object.freeze(gated.outcome.denials.map((row) => row.predicateId)),
        deniedForIndeterminacyOnly: gated.outcome.deniedForIndeterminacyOnly,
      });
    }

    /* ── 4. `γ(c) = Φ(plan(c)) − Φ(plan₀) + C_churn` (§8.1) ────────────────── */
    const phi = phiInputFor({
      plan: gated.candidate,
      snapshot,
      scope,
      agentSnapshot,
      leg,
      decisionTimeMs: state.decisionTimeMs,
      queueAgeSeconds: state.queueAgeSeconds,
      seams: context,
      correction: state.correction,
    });

    const entry = {
      agentId: agentSnapshot.agentId,
      legId: leg.legId,
      plan: gated.candidate,
      // `plan₀` for an idle agent is the empty plan, so `column.price` uses `Φ(∅) = 0`
      // exactly rather than evaluating a second plan (§8.1's degenerate case).
      basePlan: null,
      insertionPositions: [],
      pricing: { candidatePhi: phi.phiInput, basePhi: null, churn: null },
      limits: {
        capacity: round.capacityFor(agentSnapshot),
        commitmentHorizonSeconds: resolve(snapshot, "plan.commitment_horizon", scope),
        decisionTimeMs: state.decisionTimeMs,
      },
    };

    const priced = columnModel.price(
      columnModel.make({ agentId: entry.agentId, legIds: [entry.legId], plan: entry.plan, basePlan: entry.basePlan }),
      { candidatePhi: entry.pricing.candidatePhi, basePhi: entry.pricing.basePhi, churn: entry.pricing.churn, limits: entry.limits },
    );

    if (!priced.ok) {
      // The rates and inputs `Φ` could not resolve, carried verbatim. `phi.missing` is
      // folded in beside them because a name this composer could not read and a name `Φ`
      // could not read are the same finding reported from two distances.
      return refuse(REFUSAL.UNPRICEABLE, [...phi.missing, ...priced.missing, ...priced.problems]);
    }

    // Memoised for `pricedCandidateFor`, which `solve/round.plan` calls **synchronously**
    // on each survivor. Round-scoped: `beginRound` clears it, because a plan pinned to one
    // decision time and configuration version must never be priced into another round
    // (§9.6 requirements 4–5).
    round.priced.set(pricedKey(entry.legId, entry.agentId), entry);

    return Object.freeze({
      feasible: true,
      gammaMilliCU: priced.gammaMilliCU,
      // §6.6's tie-breaks, read from the state the gate admitted rather than recomputed.
      dutyCycle: agentSnapshot.dutyCycle ?? null,
      healthTier: agentSnapshot.healthTier ?? null,
    });
  };
}

/**
 * Build `expandCandidates` — §6.3's hierarchical expansion, supplied with the round's
 * pinned inputs.
 *
 * The tier maps §6.3 makes optional (`zoneCells`, `regionCoarseCellIds`,
 * `crossRegionCoarseCellIds`) are **not** supplied, and that is a decision with a reason:
 * they are published configuration this deployment does not have, each tier is skipped
 * rather than failed when its map is absent, and §D.3 establishes that a k-ring-bounded
 * expansion needs none of them. Supplying an empty array instead of nothing would say
 * "this zone contains no cells", which is a different and false claim.
 *
 * @param {object} context
 * @param {object} round
 * @returns {(input: object) => Promise<object>}
 */
function expandCandidatesFor(context, round) {
  const loadAgentSnapshot = agentSnapshotLoaderFor(context);
  const loadLeg = legLoaderFor(context);

  return async function expandCandidates(input) {
    const snapshot = round.snapshotFor(input);
    const scope = { sla_class: input.slaClass ?? null };

    const leg = await loadLeg(String(input.legId));
    if (!leg) {
      return round.refusedExpansion([`no Leg "${String(input.legId)}" is resolvable from the store`]);
    }
    const originStop = leg.stops.find((stop) => isNumber(stop.lat) && isNumber(stop.lon));
    if (!originStop) {
      return round.refusedExpansion([`Leg "${leg.legId}" has no stop with a resolved lat/lon`]);
    }

    const correction = omega.combinedCorrection({ snapshot, context: scope, omegaTerminalCu: input.omegaTerminalCu });
    if (!correction.ok) {
      // §6.4: a bound that omits its negative-term correction is not a lower bound. Refused
      // rather than expanded without it — the same answer `phase9ProductionPath.js` proves
      // the diagnostics endpoint gives, at the same seam.
      return round.refusedExpansion(correction.problems.map((problem) => `Ω correction: ${problem}`));
    }

    const rates = ratesFrom(snapshot, scope);
    const delay = delayParametersFrom(snapshot, scope);

    const legForBound = {
      legId: leg.legId,
      firstStopLat: originStop.lat,
      firstStopLon: originStop.lon,
      earliestPossibleCompletionMs: input.decisionTimeMs,
      role: leg.role,
      targetMs: leg.targetMs,
      deadlineMs: leg.deadlineMs,
      queueAgeSeconds: input.queueAgeSeconds ?? null,
    };

    // The fleet's best case, over the agents this expansion can actually reach. Read from
    // the same rows `loadAgentSnapshot` reads, so the ring floor and the per-agent bound
    // describe one fleet.
    const positions = await context.prisma.agentCellPosition.findMany({
      where: { shardId: input.shardId ?? context.shardId },
      include: {
        agent: {
          include: {
            agentClass: {
              include: { mobilityModel: true, energyModelParams: { orderBy: { modelVersion: "desc" }, take: 1 } },
            },
          },
        },
      },
    });

    round.rememberLeg({
      leg,
      legForBound,
      snapshot,
      scope,
      correction,
      decisionTimeMs: input.decisionTimeMs,
      slaClass: input.slaClass ?? null,
      queueAgeSeconds: input.queueAgeSeconds ?? null,
      snapshotId: input.snapshotId ?? null,
    });

    // §6.3's wall-clock bound, measured from the moment this expansion begins. The clock is
    // read **here**, in the composition root outside the decision path, and reaches
    // `expansion.js` as the zero-argument function reference its own T6 contract names.
    const startedAtMs = Date.now();
    const budgetMs = round.expansionWallClockBudgetMs;

    return expansion.expandCandidates({
      legId: leg.legId,
      shardId: input.shardId ?? context.shardId,
      originLat: originStop.lat,
      originLon: originStop.lon,
      leg: legForBound,
      decisionTimeMs: input.decisionTimeMs,
      rates: { lambdaTimeFloor: rates["cost.lambda_time_floor"], cuPerWh: rates["cost.energy.cu_per_wh"] },
      delayParameters: delay.ok ? delay.parameters : null,
      correction,
      fleetBestCase: fleetBestCaseFrom(positions),
      targetFeasible: resolve(snapshot, "candidate.target_feasible", scope),
      maxEvaluated: resolve(snapshot, "candidate.max_evaluated", scope),
      maxExpansionTiers: resolve(snapshot, "candidate.max_expansion_tiers", scope),
      optimalityToleranceMilliCU: round.optimalityToleranceMilliCU(snapshot, scope),
      maxRadiusMetres: resolve(snapshot, "candidate.max_radius_by_sla_class", scope),
      deadlineMs: budgetMs,
      elapsedMs: () => Date.now() - startedAtMs,
      kv: context.kv,
      loadAgentSnapshot,
      waitUntilAvailableFor: round.waitUntilAvailableFor,
      energyFor: round.energyFor,
      evaluateExact: round.evaluateExact,
      // `tierZeroAgentIds` is not supplied: §6.3's tier 0 is chaining and consolidation,
      // which is Tier 2 behind the `chaining` kill switch. Passing an empty array would be
      // indistinguishable from "chaining found nothing"; passing nothing skips the tier,
      // which is what a thrown kill switch means.
    });
  };
}

/**
 * Build `commit` — §10.3.2's serialised conditional write, with the two adapters
 * `commitment/commit.js` and `feasibility/volatileSubset.js` require of their caller.
 *
 * @param {object} context
 * @param {object} round
 * @returns {(assignment: object, roundResult: object) => Promise<object>}
 */
function commitFor(context, round) {
  const snapshot = () => coordinatorPipeline.snapshotFrom(context);

  /**
   * §10.3.2 step 3's adapter: the locked rows → the evaluation context the volatile
   * predicates read.
   *
   * `volatileSubset.js`'s own header asks the round to write this, and this is the round's
   * composition root. The plan is the **memoised one for this exact pairing**, never a
   * re-planned one: §10.3.2 step 3 re-checks the volatile subset against *the plan being
   * committed*, and re-planning inside the serialised section would check a different
   * decision from the one about to become binding.
   *
   * A pairing whose plan is not in the map is refused rather than re-planned, because the
   * only way to reach the commit without one is a defect, and a defect that re-plans is a
   * defect that commits something nobody priced.
   */
  const buildContext = async (commitContext) => {
    const key = pricedKey(commitContext.leg.legId, commitContext.agent.agentId);
    const entry = round.priced.get(key);
    const state = round.legs.get(String(commitContext.leg.legId));
    if (!entry || !state) {
      // The context is returned deliberately incomplete: `recheck` evaluates each volatile
      // predicate against it and every one of them refuses a context with no plan, so the
      // commit aborts with `VOLATILE_FEASIBILITY_LOST` and the pairing returns to the next
      // round — §10.3.2's own disposition, reached without this adapter deciding anything.
      return { agentSnapshot: null, mission: null, plan: null, config: null, decisionTimeMs: null };
    }
    const agentSnapshot = await round.loadAgentSnapshot(commitContext.agent.agentId);
    return {
      agentSnapshot,
      mission: round.missionFor(state),
      plan: entry.plan,
      config: { get: (name) => resolve(snapshot(), name, state.scope) },
      // The **store's** time, read under the row locks and handed in by `commit.js` — not
      // the round's pinned decision time, which is what the *plan* was built against. A
      // volatile predicate asks "does this still hold now", and "now" at step 3 is the
      // store's clock (§10.6).
      decisionTimeMs: commitContext.storeTime instanceof Date ? commitContext.storeTime.getTime() : state.decisionTimeMs,
    };
  };

  const volatileRecheck = volatileSubset.createVolatileRecheck({ buildContext });

  return async function commit(assignment, roundResult) {
    const entry = round.priced.get(pricedKey(assignment.legId, assignment.agentId));
    const state = round.legs.get(String(assignment.legId));
    const current = snapshot();
    const scope = (state && state.scope) || {};

    if (!state) {
      // A pairing the round planned but this assembly has no state for. Refused rather than
      // reconstructed: the only way here is a defect, and a defect that re-reads the Leg
      // would commit against a version no guard was fenced on.
      return Object.freeze({
        committed: false,
        outcome: "ABORTED",
        reason: "ROUND_STATE_MISSING",
        detail: `no round state for Leg "${assignment.legId}"; nothing was written`,
      });
    }

    const agentSnapshot = await round.loadAgentSnapshot(String(assignment.agentId));
    if (!agentSnapshot) {
      return Object.freeze({ committed: false, outcome: "ABORTED", reason: "AGENT_NOT_FOUND", detail: `no agent "${assignment.agentId}"` });
    }

    return commitment.commit(
      {
        prisma: context.prisma,
        runSerializable: context.runSerializable,
        selectForUpdate: context.selectForUpdate,
        // Optional by `commit.js`'s own contract, and supplied where the composition root
        // has it: without it a serialisation failure throws instead of aborting, and
        // `coordinator.worker.runRound` already returns the whole batch to the queue on a
        // throw. Passing it turns a batch-wide requeue into the single-pairing abort
        // §10.3.2 describes.
        isSerializationFailure: context.isSerializationFailure,
        volatileRecheck,
        // §10.3.2 step 5 — the outbox row, inside this transaction. `dispatch/offers.js`
        // owns the §11.2 payload and the §23.3 signature; this composer supplies the
        // transaction, the key, and the plan the offer describes.
        sideEffects: (tx, effectContext) =>
          offers.enqueueOffer(tx, {
            commitment: effectContext.commitment,
            storeTime: effectContext.storeTime,
            offerTtlSeconds: resolve(current, "dispatch.offer_ttl", scope),
            signingKey: context.signingKey,
            offer: {
              missionPlan: entry ? entry.plan.planId : null,
              stopSequence: entry
                ? entry.plan.stops.map((stop) => ({
                    sequence: stop.sequence,
                    stopType: stop.stopType,
                    siteId: stop.siteId ?? null,
                    lat: stop.lat ?? null,
                    lon: stop.lon ?? null,
                    projectedArrivalMs: stop.projectedArrivalMs ?? null,
                    departureMs: stop.departureMs ?? null,
                  }))
                : [],
              // Absent rather than invented. §5.2's route reference belongs to the routing
              // engine that produced the traversal, and the cell-pair seam carries hops
              // rather than a route identity.
              routeReference: null,
              payloadManifest: (state.leg.manifests || []).map((manifest) => manifest.manifestId ?? manifest.id),
              // §14.6 — the Charging Scheduler's, consumed and never computed here.
              energyReserveParams: entry ? entry.plan.reserves : null,
              targetSoc: entry && entry.plan.charging ? entry.plan.charging.targetSoc : null,
            },
          }),
      },
      {
        agentId: agentSnapshot.agentRowId,
        legId: state.leg.legRowId,
        decisionRoundId: roundResult.roundId,
        targetLegState: COMMITTED_LEG_STATE,
        planSnapshotRef: entry ? entry.plan.planId : null,
        decisionRef: roundResult.roundId,
        shardId: context.shardId,
        // §9.6 requirement 5 — the round's pinned view of the two rows the guards fence
        // against. Read from the snapshot the plan was built on, never re-read here: a
        // guard comparing a freshly-read value against itself would always pass.
        snapshot: {
          leadershipFence: roundResult.leadershipFence ?? null,
          authorityEpoch: agentSnapshot.authorityEpoch,
          legVersion: state.leg.version,
          expectedLegState: state.leg.state,
        },
        config: {
          capacity: round.capacityFor(agentSnapshot),
          leaseDurationSeconds: resolve(current, "commitment.lease_duration", scope),
        },
      },
    );
  };
}

/**
 * Assemble the coordinator's solve path, or refuse and say what is missing.
 *
 * @param {object} context the `leaderWorkers.create()` settings, plus the injected seams
 * @returns {{ ok: boolean, deps?: object, refusal?: string, missing?: object[],
 *             satisfied?: string[], blockedBy?: string }}
 */
function create(context) {
  const enriched = contextFor(context);
  const contract = coordinatorPipeline.requirements(enriched);

  if (!contract.ok) {
    // **Nothing is built.** Not a partially-assembled pipeline that prices nothing, not a
    // coordinator started against a stub router: the assembly does not exist unless every
    // declared input does, so a missing routing source produces no assignment and no
    // commitment by construction rather than by a check somewhere downstream.
    return {
      ok: false,
      refusal: REFUSAL.REQUIREMENTS_UNRESOLVED,
      missing: contract.missing,
      missingByClass: contract.byClass,
      satisfied: contract.satisfied,
      blockedBy:
        `the solve path cannot be assembled: ${contract.missing.length} of ` +
        `${coordinatorPipeline.REQUIREMENT_IDS.length} declared inputs are unresolved — ` +
        `${coordinatorPipeline.describeMissing(contract.missing)}.`,
    };
  }

  const snapshot = coordinatorPipeline.snapshotFrom(enriched);
  const routingSeam = routingSeamFor(enriched);
  const loadAgentSnapshot = agentSnapshotLoaderFor(enriched);
  const planState = planStateModel.create({ shardId: enriched.shardId });

  /**
   * The per-round state the three halves of the assembly share.
   *
   * ── Keyed by Leg, and cleared at the round boundary ────────────────────────
   * Both properties are load-bearing and neither is obvious from a single-Leg test.
   *
   * **Keyed by Leg**, because a round claims a *batch*: `solve/round.plan` expands and
   * prices Leg by Leg, and `round.execute` then commits every assignment **after** the
   * whole batch is planned. A single slot holding "the current Leg" is correct for as long
   * as the batch has one Leg in it and silently wrong the moment it has two — the commit
   * would name the last-expanded Leg's row, version and manifests for every pairing. That
   * is a wrong durable write that looks entirely successful, which is the defect class this
   * programme exists to prevent, so it is structured out rather than tested for.
   *
   * **Cleared at the round boundary**, because §9.6 requirements 4–5 pin a plan to one
   * decision time and one configuration version, and pricing a carried-over plan into a
   * fresh round would decide on inputs the round did not pin. The boundary is
   * `planState.beginRound`, which `coordinator.worker.runRound` already calls once per
   * round — the real signal, rather than a second notion of "new round" that could drift
   * from it.
   */
  const round = {
    /** `pricedKey(legId, agentId)` → the priced candidate entry `columnBuilder` consumes. */
    priced: new Map(),
    /** `legId` → this round's pinned state for that Leg. */
    legs: new Map(),
    snapshot,
    expansionWallClockBudgetMs: enriched.expansionWallClockBudgetMs,
    loadAgentSnapshot,
    // §20.3 item 2 keys a cell-pair entry on the congestion bucket, so *"an entry computed
    // under one mobility profile or one congestion bucket is never silently applied under
    // another"*. Supplied by the routing seam; absent, `cellPairCache.key` refuses and
    // every hop is reported unresolved — which is `create()`'s refusal reached at runtime
    // rather than a pair cached under the wrong conditions.
    timeBucket: enriched.timeBucket,

    snapshotFor: () => coordinatorPipeline.snapshotFrom(enriched),

    /** Pin one Leg's round state. Called once per Leg, by `expandCandidates`. */
    rememberLeg(state) {
      round.legs.set(String(state.leg.legId), state);
    },

    /** Discard every Leg's state and every priced plan. Called at the round boundary. */
    clear() {
      round.legs.clear();
      round.priced.clear();
    },

    routing: {
      /**
       * Every hop this pairing needs, plus the synchronous re-resolver §13.4 requires.
       *
       * ── Why `hopsForSequence` reads a memo rather than the cache ───────────
       * `planBuilder.insertChargingStop` re-sequences the stop list at each candidate
       * insertion position and calls `hopsForSequence(stops)` — **synchronously**, by
       * `planBuilder`'s own contract. `cellPairCache.hopsFor` is async because a miss
       * consults the router, so a synchronous re-resolver can only answer from pairs
       * already resolved. This builds that memo from the pairs this pairing resolved, keys
       * it by (from, to) rather than by stop number, and answers `null` for any sequence
       * containing a pair it has not seen.
       *
       * `null` is the honest answer and it is one `insertChargingStop` already handles:
       * it records *"no travel times are available for this insertion position"* and tries
       * the next. It never produces a plan on invented hops. Keying by the cell pair —
       * rather than by the sequence number the old `terrainByStop` used — is E-8's fix
       * carried into the composition: a re-sequenced list looks its hops up by *where the
       * agent actually travels*, so a shifted index cannot silently return a neighbour's.
       */
      async forPairing(originCell, stops, profileKey) {
        const resolvedStops = stops.map((stop) => ({
          ...stop,
          cellId: stop.cellId || cellIdFor(stop),
        }));

        const result = await cellPairCache.hopsFor(routingSeam.deps, {
          originCell,
          stops: resolvedStops,
          profileKey,
          timeBucket: round.timeBucket,
          options: routingSeam.optionsFor(profileKey),
        });
        if (!result.ok) return { ok: false, hops: [], hopsForSequence: null, problems: result.problems };

        const memo = new Map();
        let from = originCell;
        resolvedStops.forEach((stop, index) => {
          memo.set(`${from}>${stop.cellId}`, result.hops[index]);
          from = stop.cellId;
        });

        return {
          ok: true,
          hops: result.hops,
          hopsForSequence(sequenced) {
            const hops = [];
            let cursor = originCell;
            for (const stop of sequenced || []) {
              const destination = stop.cellId || cellIdFor(stop);
              const hop = memo.get(`${cursor}>${destination}`);
              if (!hop) return null;
              hops.push(hop);
              cursor = destination;
            }
            return hops;
          },
          problems: [],
        };
      },
    },

    profileKeyFor: (agentSnapshot) =>
      (agentSnapshot.mobilityModel && agentSnapshot.mobilityModel.traversalDomain) || agentSnapshot.agentClassId,

    /**
     * §14.2's `κ` and coefficient set for one agent, as `lowerBound` reads them. Absent
     * values stay absent; the bound then does not resolve and the agent is reported in
     * `unresolvedBoundAgentIds` rather than silently dropped (§6.1, §6.4).
     */
    async energyFor(agentId) {
      const agentSnapshot = await loadAgentSnapshot(agentId);
      if (!agentSnapshot) return { kappa: null, model: null };
      return { kappa: agentSnapshot.kappa, model: agentSnapshot.energyCoefficients };
    },

    /**
     * §6.4's `wait_until_available(a)`. An agent in the Availability Index's ready classes
     * is ready now, which is what those classes mean; anything else is a chaining question
     * and chaining is Tier 2.
     */
    async waitUntilAvailableFor() {
      return 0;
    },

    /**
     * The §7.5 mission the feasibility predicates read, from this Leg's own pinned state.
     *
     * @param {object} state a `rememberLeg` entry
     */
    missionFor: (state) => ({
      legId: state.leg.legId,
      missionId: state.leg.missionId,
      purpose: state.leg.purpose,
      custodyState: state.leg.custodyState,
      slaClass: state.slaClass,
      targetMs: state.leg.targetMs,
      deadlineMs: state.leg.deadlineMs,
      manifests: state.leg.manifests,
      stops: state.leg.stops,
    }),

    capacityFor: (agentSnapshot) => {
      const override = agentSnapshot.capacityOverride;
      if (Number.isInteger(override)) return override;
      const resolved = resolve(round.snapshotFor(), "capacity", { agent_class: agentSnapshot.agentClassId });
      return Number.isInteger(resolved) ? resolved : undefined;
    },

    /**
     * `candidate.optimality_tolerance_cu` in milli-CU, which is the unit
     * `expansion.shouldStopExpanding` compares in. Absent, it stays absent and the
     * expansion's own `?? 0n` applies — a zero *tolerance*, which is the strict reading
     * and prunes less, not more.
     */
    optimalityToleranceMilliCU(current, scope) {
      const cu = resolve(current, "candidate.optimality_tolerance_cu", scope);
      return isNumber(cu) ? BigInt(Math.round(cu * MS_PER_SECOND)) : undefined;
    },

    refusedExpansion: (problems) =>
      Object.freeze({
        ok: false,
        candidates: [],
        bestGammaMilliCU: null,
        achievedGapMilliCU: null,
        achievedGapProven: false,
        unexploredRingDistance: 0,
        unresolvedBoundAgentIds: [],
        tiersExplored: 0,
        cellsExplored: 0,
        agentsEvaluated: 0,
        truncatedBy: REFUSAL.LEG_UNRESOLVED,
        problems: Object.freeze([...problems]),
      }),
  };

  round.evaluateExact = evaluateExactFor(enriched, round);

  // The round boundary, taken from the signal that already marks one.
  //
  // `runRound` calls `planState.beginRound(roundId)` once per round, before anything is
  // expanded, so that call *is* "the previous round's plans are now stale". This assembly
  // needs to hear it, and `planState.create()` returns a **frozen** object — deliberately,
  // since §2.6's ledger is not something a caller may reach into — so the boundary is
  // observed by delegation rather than by decorating a method in place.
  //
  // Every other method passes through untouched, so the object the round receives behaves
  // exactly as `shard/planState.js` defines it, including the refusal to be serialised.
  const roundScopedPlanState = Object.freeze({
    ...Object.fromEntries(
      Object.entries(planState).map(([name, value]) => [
        name,
        isFunction(value) ? (...args) => value.apply(planState, args) : value,
      ]),
    ),
    beginRound(roundId) {
      round.clear();
      return planState.beginRound(roundId);
    },
  });

  const deps = {
    prisma: enriched.prisma,
    kv: enriched.kv,
    planState: roundScopedPlanState,
    expandCandidates: expandCandidatesFor(enriched, round),
    pricedCandidateFor: (agentId, legId, candidate) =>
      round.priced.get(pricedKey(legId, agentId)) || null,
    // The queue row's own fields, synchronously — the Leg and its stops are loaded inside
    // `expandCandidates`, which is async, because `coordinator.worker` calls this one
    // synchronously while building the batch.
    expansionInputFor: (row) => ({
      legId: row.legId,
      slaClass: row.slaClass,
      purpose: row.purpose,
      shardId: row.shardId,
      queueAgeSeconds: row.enqueuedAt ? (Date.now() - new Date(row.enqueuedAt).getTime()) / MS_PER_SECOND : null,
    }),
    commit: commitFor(enriched, round),
    record: enriched.record,
    // `deferPriceFor` is deliberately absent. `cost/cDefer.js` is Tier 2 behind the
    // `deferral` kill switch, and `round.plan` creates no deferral arc without it — which
    // is what a thrown kill switch means. A Tier 1 composition root that imported it would
    // be a kill switch that cannot be thrown (§1.8 rule 2).
  };

  return { ok: true, deps, planState: roundScopedPlanState, round, context: enriched, satisfied: contract.satisfied };
}

/**
 * The fine cell a stop sits in, from its own coordinates. Pure H3 — no published cover, no
 * declaration (§D.3).
 *
 * @param {object} stop
 * @returns {string|null}
 */
function cellIdFor(stop) {
  if (!isNumber(stop.lat) || !isNumber(stop.lon)) return null;
  return cells.cellForPoint(stop.lat, stop.lon, cells.RESOLUTION.FINE);
}

module.exports = {
  REFUSAL,
  COMMITTED_LEG_STATE,
  contextFor,
  delayParametersFrom,
  routingSeamFor,
  agentSnapshotLoaderFor,
  legLoaderFor,
  planInputFor,
  phiInputFor,
  cellIdFor,
  payloadFor,
  create,
  // Re-exported so a caller that has an assembly can start the worker it was built for
  // without a second require, and so the composition test can assert the two are the same
  // function rather than two things with the same name.
  worker: coordinatorWorker,
};

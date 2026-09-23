"use strict";

/**
 * What the Assignment Coordinator's solve path needs, and which of it this deployment has
 * — **the requirements probe**. Composition-root code, beside `leaderWorkers.js`.
 *
 * ── The finding this module exists to close ────────────────────────────────
 * `workers/coordinator.worker.js` is complete. `solve/round.js` is complete. So are
 * `candidates/expansion.js`, `feasibility/evaluate.js`, `plan/planBuilder.js`, `cost/phi.js`
 * and `commitment/commit.js`. What has never existed is the code that **assembles** them:
 * `expandCandidates`, `pricedCandidateFor`, `expansionInputFor` and the `evaluateExact` they
 * bottom out in are constructed **only in tests**. `tools/verify/phase9ProductionPath.js`
 * says so in its own header — *"nothing in this process constructs its solve path"*.
 *
 * Until now `leaderWorkers.COMPOSERS.coordinator()` reported that as a single fixed
 * paragraph: *"no routing engine is selected"*. That is **true and incomplete**, and the
 * incompleteness was doing real damage — two successive hand-audits of "what does V1 need"
 * each stopped at a different seam and each produced a different, confidently-stated answer.
 * The first said four values. The second found three more `UNCALIBRATED` register entries
 * and three input families with no producer at all. Neither was measured; both were read.
 *
 * **So this module measures it.** `requirements(context)` attempts to resolve every input
 * the coordinator's solve path needs and returns, by name, owner and class, the ones it
 * cannot. The composer reports that list instead of a paragraph. The answer to *"what
 * exactly is missing"* becomes something the code computes rather than something a reader
 * infers — which is the same move `registry.js` made for `blockedBy` and
 * `leaderWorkers.js` made for `UNCOMPOSABLE`.
 *
 * ── What this module deliberately does NOT do ──────────────────────────────
 * **It does not assemble anything.** There is no `expandCandidates` body here, no
 * `evaluateExact`, no `pricedCandidateFor`. Writing those now would produce several hundred
 * lines exercised only by an injected complete context, because the real inputs do not
 * exist — *written, tested, and never called*, which is the failure this programme has hit
 * at least four times and which `registry.js`'s own header names.
 *
 * **It fabricates nothing.** No default is invented for an unresolved register entry, no
 * router is stubbed, no terrain or ambient temperature is guessed. Every probe answers
 * *"is this present"* and never *"here is a plausible value"*.
 *
 * **It does not make `gate:composition` pass.** The gate reads `leaderWorkers.UNCOMPOSABLE`
 * declaratively, that row is unchanged, and it is removed — per the rule that table sets
 * for itself — only when the coordinator actually starts.
 *
 * ── Why the classes matter more than the count ─────────────────────────────
 * "Eight things are missing" is not actionable. **Who can supply each, and whether it is a
 * decision or an absence, is.** A `REGISTER_UNRESOLVED` entry is `null` *by declaration* —
 * §22.4's calibration owner's to derive, and §22.3 forbids any automated process from
 * choosing it. A `NO_PRODUCER` family is not waiting on anybody's decision: it is code
 * nobody has written plus a data source nobody has named. Reporting both as "missing" is
 * what let one be mistaken for the other.
 *
 * Tier 1 by path (`src/workers/`). No clock, no randomness, no I/O: every probe is a pure
 * function of the supplied context and the supplied snapshot.
 */

const omega = require("../engine/candidates/omega");

/**
 * Why an input is absent — and therefore who, if anyone, can supply it.
 *
 * @structural the requirement taxonomy; each class has a different owner and a different
 *   closure act
 */
const REQUIREMENT_CLASS = Object.freeze({
  /**
   * An external decision about the traversal source. Not derivable here, and explicitly
   * forbidden to fabricate: *"starting the coordinator against an invented router assigns
   * real work on invented travel times"*.
   */
  EXTERNAL_ROUTING: "EXTERNAL_ROUTING",
  /**
   * A register entry that exists but resolves to nothing. **`null` by declaration, not by
   * omission** — the register carries the entry precisely so that its absence is visible,
   * and §22.3 forbids an automated process from choosing the value.
   */
  REGISTER_UNRESOLVED: "REGISTER_UNRESOLVED",
  /**
   * An input family with **no schema column and no producer anywhere in `src/`**. Nobody is
   * deciding this and no calibration closes it: it is missing code plus a missing data
   * source, and it is the class both prior hand-audits missed entirely.
   */
  NO_PRODUCER: "NO_PRODUCER",
  /** A collaborator the composition root builds, but did not supply to this call. */
  PROCESS_DEPENDENCY: "PROCESS_DEPENDENCY",
  /**
   * A §6.4 admissibility precondition that resolves or does not. An `LB` missing its
   * negative-term correction **is not a lower bound**, so this is checked rather than
   * assumed — `tools/verify/phase9ProductionPath.js` exists because it once silently was
   * not.
   */
  ADMISSIBILITY: "ADMISSIBILITY",
});

/**
 * The pinned configuration snapshot this context carries, accepting the accessor form.
 *
 * P15-R2 established the rule for `values` and the same reasoning governs the snapshot:
 * `leaderWorkers.create()` runs once at boot and the composers run on every promotion, so a
 * snapshot captured at `create()` would bind the coordinator to the configuration version
 * the *process* booted on, permanently, while the request path moved on. The composition
 * root therefore passes `() => app.locals.config`, and a promotion composes against the
 * version in force at the moment leadership is acquired.
 *
 * A plain snapshot is still accepted unchanged, because that is what every test passes.
 *
 * @param {object} context
 * @returns {object|undefined}
 */
function snapshotFrom(context) {
  const carried = (context || {}).snapshot;
  if (typeof carried !== "function") return carried;
  try {
    return carried();
  } catch {
    return undefined;
  }
}

/** Read a value from the round's configuration snapshot without throwing. */
function resolved(snapshot, name, context) {
  if (!snapshot || typeof snapshot.resolve !== "function") return undefined;
  try {
    return snapshot.resolve(name, context || {});
  } catch {
    return undefined;
  }
}

const isFunction = (value) => typeof value === "function";
const isPositive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
const present = (value) => value !== null && value !== undefined;

/**
 * A register entry that must resolve to something before the solve path can run.
 *
 * @param {string} name
 * @param {string} why what breaks without it, named at the function that breaks
 * @param {string} owner
 * @returns {object}
 */
function registerRequirement(name, why, owner) {
  const perAgent = PER_AGENT_DECLARABLE.has(name);
  return {
    id: name,
    class: REQUIREMENT_CLASS.REGISTER_UNRESOLVED,
    owner,
    why,
    probe: (context) =>
      present(resolved(snapshotFrom(context), name, { sla_class: context.slaClass ?? null })) ||
      (perAgent && isFunction(context.agentEnergyDeclarationsFor)),
  };
}

/**
 * The two §14.5 Safety rows an agent's **own energy model** may declare, read ahead of the
 * register by `coordinatorSolvePath.planInputFor`.
 *
 * V1 demonstration (2026-09-23). A simulated pack's floor is the simulator's own clamp
 * (`BATTERY_MIN`) and its dispersion is the simulator's own speed jitter, so for a
 * simulated agent these are facts of the simulated world rather than Safety calibrations.
 * The probe is satisfied by the *seam* being composed, exactly as `failureProbabilityFor`
 * and `environmentFor` are; the per-agent check stays where it was — an agent the seam does
 * not answer for (every physical agent) falls back to the register, and with the register
 * unresolved its plan refuses by name. **No Safety value is supplied for a physical agent.**
 * @structural
 */
const PER_AGENT_DECLARABLE = new Set(["energy.model_residual_cv", "energy.reserve_floor_wh"]);

/**
 * Every register parameter the **composed** solve path reads, with the function that
 * refuses without it.
 *
 * ── V1 composition, 2026-09-04: this table is the finding ───────────────────
 * Before the assembly existed, this module declared **three** unresolved register
 * entries — `candidate.max_radius_by_sla_class`, `plan.service_time_prior` and
 * `energy.model_residual_cv`. They were derived by reading `plan/planBuilder.buildVariant`
 * and stopping there, which is one seam further than §F's hand-audit reached and still
 * short of `cost/phi.evaluate`.
 *
 * Writing the assembly walked the rest of the path — `column.price` → `phi.evaluate` →
 * `cDirect` / `cRisk` / `cLifecycle` / `cPolicy` / `cDelay` — and each of those refuses on
 * a rate of its own. Measured live against `service.defaultSnapshot()`, **thirteen further
 * parameters resolve to `null`**, every one of them `required: true` with no default and
 * `UNCALIBRATED`. They are not a discovery about the register; they are a discovery about
 * *this list*, which named three of sixteen.
 *
 * This is the third time the remaining-work estimate has been corrected in the same
 * direction, for the same reason, and it is the reason the estimate is now taken from a
 * table a build can walk rather than from a reader's trace. **Nothing here is a proposal
 * for a value**: §22.3 reserves every one of them for §22.4's calibration owner, and two
 * (`energy.reserve_floor_wh`, `energy.model_residual_cv`) are Safety-class, for which the
 * frozen documents offer no provisional route at all.
 *
 * @structural the register parameters the composed solve path reads, each named at its
 *   refusing function
 */
const SOLVE_PATH_REGISTER_INPUTS = Object.freeze([
  {
    name: "plan.service_time_prior",
    why:
      "`plan/planBuilder.resolveServiceTimes` fails closed without it, and `buildVariant` returns before " +
      "projecting a timeline. §22.4 names per-site service-time models among the values that \"require data the " +
      "fleet does not yet produce\" — which is also why `service_time_model` is a DEFERRED worker.",
    owner: "§22.4's calibration owner",
  },
  {
    name: "energy.model_residual_cv",
    why:
      "`energy/consumption.predictiveDistribution` needs it to turn a mean consumption into the distribution " +
      "§14's reserves are held against; without it `buildVariant` returns `MISSING_ENERGY_INPUT`. **Safety class.**",
    owner: "§22.4's calibration owner — Safety class (§22.3)",
  },
  {
    name: "cost.energy.cu_per_wh",
    why:
      "the CU/Wh exchange rate. `cost/cDirect.evaluate` refuses without it, and so do " +
      "`candidates/lowerBound` and `candidates/expansion.unexploredRingFloorMilliCU` — so its absence " +
      "removes both the exact price and the admissible bound the search prunes on.",
    owner: "§22.4's calibration owner",
  },
  {
    name: "cost.wear.cu_per_metre",
    why:
      "§8.2's and §8.5's distance-wear rate. `cDirect.evaluate` and `cLifecycle.evaluate` both refuse " +
      "without it, and `phi.assertWearChargedOnce` is what keeps it charged exactly once.",
    owner: "§22.4's calibration owner",
  },
  {
    name: "cost.failure.cu",
    why: "`cost/cRisk.evaluate`'s `p_fail · consequence` term refuses without a consequence price (§8.3.1).",
    owner: "§22.4's calibration owner — POLICY class",
  },
  {
    name: "cost.staleness.cu_per_second_age",
    why:
      "`cRisk.stalenessPenalty` refuses without it. §8.3 prices decision-time uncertainty on the *oldest* " +
      "safety-relevant observation, and an unpriced staleness makes a stale agent look as good as a fresh one.",
    owner: "§22.4's calibration owner — POLICY class",
  },
  {
    name: "cost.energy_consequence",
    why:
      "`cRisk.energyShortfall` prices §14.5's three tier probabilities against a consequence each, and names " +
      "`cost.energy_consequence.<tier>` for each one it cannot resolve.",
    owner: "§22.4's calibration owner — POLICY class",
  },
  {
    name: "cost.sla.cu_per_second_late",
    why:
      "`cost/cDelay.forLeg` prices lateness at this rate, and `LB(a, l)`'s delay term reads the same " +
      "parameters. Absent, a late completion is priced identically to a punctual one.",
    owner: "§22.4's calibration owner — CONTRACTUAL class",
  },
  {
    name: "cost.sla.breach_penalty",
    why: "`cDelay.forLeg`'s step penalty at the deadline — the discontinuity §8.7 puts *at* the SLA boundary.",
    owner: "§22.4's calibration owner — CONTRACTUAL class",
  },
  {
    name: "lifecycle.cu_per_actuator_cycle",
    why: "`cLifecycle.actuatorCycleCost` refuses without a price per declared actuator cycle (§8.5).",
    owner: "§22.4's calibration owner",
  },
  {
    name: "lifecycle.cu_per_braking_event",
    why: "`cLifecycle.tyreAndBrakeCost` refuses without it (§8.5).",
    owner: "§22.4's calibration owner",
  },
  {
    name: "lifecycle.cu_per_gradient_metre",
    why: "`cLifecycle.tyreAndBrakeCost`'s gradient-exposure addend refuses without it (§8.5).",
    owner: "§22.4's calibration owner",
  },
  {
    name: "lifecycle.cu_per_thermal_stress_second",
    why: "`cLifecycle.thermalStressCost` refuses without it (§8.5).",
    owner: "§22.4's calibration owner",
  },
  {
    name: "cost.battery.cu_per_equivalent_cycle",
    why:
      "§14.4's DoD-weighted battery cost. `energy/wear.batteryWear` refuses without it, and `cLifecycle` " +
      "carries that refusal up as `battery.*`.",
    owner: "§22.4's calibration owner",
  },
  {
    name: "energy.reserve_floor_wh",
    why:
      "§14.5's first reserve layer. `energy/reserves.compose` refuses without it, so no plan resolves a " +
      "reserve floor and `reservesHold` is false for every variant — which sends every candidate down " +
      "§13.4's charging-insertion path and then refuses that too. **Safety class.**",
    owner: "§22.4's calibration owner — Safety class (§22.3)",
  },
]);

/**
 * Every input the coordinator's solve path needs that this repository cannot supply on its
 * own, in the order a reader should meet them: routing first, then the register, then the
 * families with no producer, then the process context, then admissibility.
 *
 * **This list is the contract.** `leaderWorkers.UNCOMPOSABLE.coordinator.requires` is
 * derived from it rather than restated, so the declarative table a build gate reads and the
 * probe a promotion runs cannot disagree about what the coordinator needs.
 */
const REQUIREMENTS = Object.freeze([
  /* ── Routing: the injected `route` seam and the values it cannot supply ── */
  {
    id: "route",
    class: REQUIREMENT_CLASS.EXTERNAL_ROUTING,
    owner: "B1 — the project owner, on D1/D3/D8",
    why:
      "`routing/cellPairCache.read` falls through to `deps.route(parts)` on a cache miss and returns " +
      "`no router is available and the entry is not cached` without it. Contract: " +
      "`async ({originCell, destCell, profileKey, timeBucket}) => {distanceM, travelSeconds, travelSdSeconds, " +
      "climbM, descentM, stopStartCycles}`, every one finite and non-negative. The first three are refused by " +
      "`buildEntry` and never cached; the terrain three are carried by `buildEntry` and refused by " +
      "`plan/timeline.project` at the decision path (E-8).",
    probe: (context) => isFunction(context.route),
  },
  {
    id: "travelSdSeconds source (N29)",
    class: REQUIREMENT_CLASS.EXTERNAL_ROUTING,
    owner: "the project owner",
    why:
      "`cellPairCache.buildEntry` requires a finite non-negative `travelSdSeconds`, and §8.4 prices `p_late` " +
      "\"from the ETA predictive distribution, not the point estimate\". **No shortlisted engine returns a " +
      "spread** — OSRM's `table`, Valhalla's `sources_to_targets` and GraphHopper's `route` are all point " +
      "estimates — so turning that silence into `0` asserts \"this ETA is certain\", in the optimistic " +
      "direction. The spread needs a declared source, and selecting an engine does not close it.",
    probe: (context) => present(context.travelTimeSpread),
  },
  {
    id: "speedMetresPerSecond (per routing profile)",
    class: REQUIREMENT_CLASS.EXTERNAL_ROUTING,
    owner: "D3 — Product + Fleet Engineering",
    why:
      "`cellPairCache.applyIntraCellOffset` inflates a cached pair by §20.3's intra-cell quantisation at the " +
      "profile's own speed, and refuses without it. It is a real fleet measurement, not a plausible number: " +
      "the only `MobilityModel` in this repository is a seed whose `speedModel` is a note deferring to D3.",
    probe: (context) => isFunction(context.speedMetresPerSecondFor) || isPositive(context.speedMetresPerSecond),
  },
  {
    id: "hop terrain (climbM / descentM / stopStartCycles)",
    class: REQUIREMENT_CLASS.EXTERNAL_ROUTING,
    owner: "the project owner — the same traversal source as `route`",
    why:
      "§14.2 evaluates `β_climb · Σ max(0, Δh)`, its regeneration counterpart and `β_stop_start · " +
      "n_stop_start_cycles` **over the traversal**, so these are properties of the hop the router answers with. " +
      "`plan/timeline.project` refuses a hop without them and `planBuilder.legProfiles` then refuses the plan " +
      "with `MISSING_TERRAIN`. Elevation is not uniformly available: Valhalla and GraphHopper can return it, " +
      "OSRM cannot, and **no shortlisted engine returns stop-start cycles** — so like `travelSdSeconds` this " +
      "needs a declared source, and selecting an engine does not by itself close it.\n" +
      "*(E-8, 2026-09-04. This was a `NO_PRODUCER` row named `terrainByStop`, and it carried two false claims. " +
      "It said `legProfiles` \"fails closed\" when `legProfiles` coerced absent terrain to zero climb, zero " +
      "descent and one stop-start cycle — which made `consumption.REQUIRED_PROFILE_FIELDS`'s refusal " +
      "unreachable. And it classed terrain as a family with no producer, when §14.2 states it over the " +
      "traversal and the routing seam is its producer. The old stop-keyed map was additionally misaligned by " +
      "§13.4: `insertChargingStop` re-sequences, so every stop after an inserted charge read its neighbour's " +
      "elevation profile. The class moved from `NO_PRODUCER` to `EXTERNAL_ROUTING`; the requirement count is " +
      "unchanged at 14.)*",
    probe: (context) => present(context.hopTerrainSource),
  },
  {
    id: "timeBucket (§20.3 congestion bucket)",
    class: REQUIREMENT_CLASS.EXTERNAL_ROUTING,
    owner: "the project owner — part of declaring the traversal source",
    why:
      "§20.3 item 2 keys a cell-pair entry on `(origin_cell, destination_cell, mobility_profile, " +
      "time_bucket)` so that *\"an entry computed under one mobility profile or one congestion bucket is " +
      "never silently applied under another\"*, and `cellPairCache.key` refuses an entry without it. " +
      "**Nothing in `src/` produces one.** It is not derivable here either: bucketing the pinned decision " +
      "time would be this repository choosing a congestion model, and the bucket has to be the one the " +
      "traversal source was queried under or the key describes conditions the router never saw.\n" +
      "*(New at the V1 composition, 2026-09-04 — surfaced by wiring `cellPairCache` rather than by reading " +
      "it. Classed with routing rather than as `NO_PRODUCER` because it is a property of the declared " +
      "source, and F-1 answers it.)*",
    probe: (context) => present(context.timeBucket),
  },

  /* ── §6.3's containment bound: a radius **or** a wall clock ────────────────── */
  {
    id: "candidate.max_radius_by_sla_class",
    class: REQUIREMENT_CLASS.REGISTER_UNRESOLVED,
    owner: "§22.4's calibration owner / Operations",
    why:
      "§6.3 requires the k-ring expansion to be bounded by `candidate.max_radius_by_sla_class` **or** a " +
      "wall-clock budget; `expandCandidates` refuses outright with `unbounded_search_refused` when it has " +
      "**neither**, because a Leg with no feasible agent would otherwise expand without limit (§6.1's " +
      "bounded-work property, T9). `required: true` with no default, on purpose: the containment limit is " +
      "Operations' to set.\n" +
      "*(V1 composition, 2026-09-04 — the disjunction. This probe asked for the radius alone, which asserted a " +
      "conjunct §6.3 does not state and `expandCandidates` does not implement: its guard is " +
      "`!hasRadiusBound && !hasClockBound`. Two readings of this row were in circulation — E-8 classified the " +
      "parameter non-blocking because the wall-clock bound is implemented, and §K.1 row 8 listed it as blocking " +
      "E2E — and the disagreement was real, because the probe and the code disagreed. The composed path " +
      "supplies `deadlineMs` and `elapsedMs` from `solve.time_budget`, which is registered and resolves, so " +
      "**the search terminates without this parameter and E-8's classification is preserved**. What the " +
      "wall clock does not supply is §6.3's *containment* limit: a clock-bounded search is bounded in work and " +
      "unbounded in distance, so a deployment that publishes no radius is one that has declined to say how far " +
      "it will send an agent. That is a policy statement, and it belongs to Operations either way.)*",
    probe: (context) =>
      present(resolved(snapshotFrom(context), "candidate.max_radius_by_sla_class", { sla_class: context.slaClass ?? null })) ||
      isPositive(context.expansionWallClockBudgetMs),
  },

  /* ── Register entries the composed solve path reads, each named at its refusing
       function. Derived from `SOLVE_PATH_REGISTER_INPUTS` rather than restated, for the
       same reason `UNCOMPOSABLE.requires` is derived from this list. ──────────── */
  ...SOLVE_PATH_REGISTER_INPUTS.map((entry) => registerRequirement(entry.name, entry.why, entry.owner)),

  /* ── Input families with no schema column and no producer ─────────────────── */
  {
    id: "environment.ambientC / packC",
    class: REQUIREMENT_CLASS.NO_PRODUCER,
    owner: "Engineering + a telemetry or forecast source",
    why:
      "`energy/consumption.betaThermal` evaluates the model's ambient and pack curves at these two " +
      "temperatures, and `legProfiles` fails closed without them. **No Prisma column and no producer anywhere " +
      "in `src/`.** The thermal coefficient is a real term in §14.2's consumption model, so omitting it is not " +
      "a degradation this path is permitted to take silently.",
    probe: (context) => isFunction(context.environmentFor),
  },
  {
    id: "masses.vehicleMassKg",
    class: REQUIREMENT_CLASS.NO_PRODUCER,
    owner: "Engineering + the fleet's own specifications",
    why:
      "`legProfiles` needs the vehicle's own mass to project consumption. `AgentClass.totalMassLimitKg` is a " +
      "**limit**, not a mass, and reading a limit as a mass would overstate consumption on every candidate " +
      "equally — which is the kind of error that looks conservative and is simply wrong. " +
      "~~No mass column exists.~~\n" +
      "*(CORRECTED 2026-09-12. **A mass column exists.** `Robot.massKg` was added by migration " +
      "`20260906120000_robot_specification_and_chassis_class`, is documented on the schema as being there " +
      "\"because §14.2's consumption equation has a `β_mass` term that needs one\", and " +
      "`services/robotSpecification.js` is its declared sole writer — the operator supplies it at " +
      "commissioning. So the sentence this row carried was true when written and has been false since that " +
      "migration landed.*\n" +
      "*What is still absent is the **producer**: nothing builds the `vehicleMassKgFor` accessor this row's " +
      "probe asks for, so the column is written and never read on the decision path — the E-8b family, at " +
      "another place. **The class is deliberately left `NO_PRODUCER` and the probe is unchanged**: the input " +
      "is still unresolved, the requirement still fails, and every published class count " +
      "(`EXTERNAL_ROUTING` 5 · `REGISTER_UNRESOLVED` 15 · `NO_PRODUCER` 6) is unmoved. What the class name " +
      "now understates is that the data source is named and populated, which is a smaller gap than \"nobody " +
      "has named a source\" — and a reader acting on the old sentence would have gone looking for a fleet " +
      "specification exercise instead of writing an accessor. `owner` is likewise left as written rather " +
      "than re-attributed to the commissioning operator, because these strings are quoted in the frozen " +
      "boundary documents.)*",
    probe: (context) => isFunction(context.vehicleMassKgFor) || isPositive(context.vehicleMassKg),
  },
  {
    id: "p_fail (per-agent failure probability)",
    class: REQUIREMENT_CLASS.NO_PRODUCER,
    owner: "Engineering — §8.3.1's reliability model, plus realised failure data",
    why:
      "`cost/cRisk.evaluate` refuses without `failure.probability`, so **no candidate can be priced at all** " +
      "without it. §8.3.1 makes it a per-agent posterior, and the Tier 2 module that would produce one lives " +
      "at `src/engine/reliability/`, which holds a single `.gitkeep` and has since 2026-07-28. There is no " +
      "Tier 1 cohort prior either: nothing anywhere in `src/` computes a failure probability.\n" +
      "*(New at the V1 composition, 2026-09-04. Invisible to every earlier audit because they stopped at " +
      "`planBuilder`, and `cRisk` is one seam past it. Injected rather than imported: the producer is Tier 2 " +
      "and §1.8 rule 2 forbids a Tier 1 composition root from linking it statically.)*",
    probe: (context) => isFunction(context.failureProbabilityFor),
  },
  {
    id: "route_hazard_cost (Map service)",
    class: REQUIREMENT_CLASS.NO_PRODUCER,
    owner: "Engineering + the Map service (§5.2)",
    why:
      "`cRisk.evaluate` refuses without a non-negative `routeHazardCu`. §5.2 makes the Map service its " +
      "producer; `engine/map/obstructionClass.js` **consumes** `hazardData` and no client anywhere in `src/` " +
      "fetches any, so the input has a declared owner and no code path that reaches it.",
    probe: (context) => isFunction(context.routeHazardCuFor),
  },
  {
    id: "return-leg Wh per metre (per routing profile)",
    class: REQUIREMENT_CLASS.NO_PRODUCER,
    owner: "Engineering + Fleet — declared alongside the profile's `speedMetresPerSecond` (D3)",
    why:
      "§14.5's `E_return` is a per-candidate energy, and `routing/chargerReachabilityCache.buildEntry` " +
      "computes it as `distance × the profile's marginal return-leg Wh per metre` — an input it asks its " +
      "**caller** for. No register entry and no schema column carries it, and nothing in `src/` produces " +
      "one. It is not derivable here either: `β_dist` is the distance term alone, so using it would omit " +
      "the mass, gradient, auxiliary and time terms, understate `E_return`, overstate the surplus, and " +
      "admit exactly the missions §14.5's reserve exists to refuse — the permissive direction on a " +
      "feasibility gate.\n" +
      "*(New at the F35 seam, 2026-09-05. §M.3 measured the minimum charger input as \"one declared " +
      "depot-class charger\" by supplying a candidate **whole**; building the candidate from the " +
      "`Charger` row showed that its `energyWh` field is a second declaration. The estate and this rate " +
      "are supplied together or F35 stays INDETERMINATE.)*",
    probe: (context) =>
      isFunction(context.returnLegEnergyWhPerMetreFor) || isPositive(context.returnLegEnergyWhPerMetre),
  },
  {
    id: "battery wear inputs (§14.4)",
    class: REQUIREMENT_CLASS.NO_PRODUCER,
    owner: "Engineering + the pack manufacturer's characterisation",
    why:
      "§14.4's DoD-weighted battery cost. `energy/wear.batteryWear` refuses without the pack's stress " +
      "`curves`, the mission's `conditions` (`dod`, `socMid`, `tempC`, `cRate`) and its `socThroughput`, and " +
      "`cost/cLifecycle` carries that refusal up as `battery.*` — so **no candidate is priceable** without " +
      "them. **The `curves` half has a column and is no longer part of this shortfall**: " +
      "`EnergyModelParams.stressCurves` is declared as *\"the vendor cycle-life-versus-DoD curves §14.4 " +
      "prices wear from\"*, `agentSnapshotLoaderFor` loads that row, and `coordinatorSolvePath` reads it. " +
      "What has no column and no producer is the **mission** half: nothing in `src/` computes a mission's " +
      "SoC throughput, DoD, mid-SoC or C-rate, and `tempC` is the `environment.ambientC / packC` family " +
      "above. So a deployment supplies vendor characterisation *into a column*, and the mission quantities " +
      "still have nowhere to come from.\n" +
      "*(New at the V1 composition, 2026-09-04. `cLifecycle` is one seam past `planBuilder`, which is where " +
      "every earlier audit of this contract stopped. **Corrected 2026-09-05**: this row said `EnergyModel` " +
      "carries \"no wear curve at all\", which is true of `EnergyModel` and was the wrong row — the curves " +
      "were loaded onto the agent snapshot and then not read, which is the E-8b defect family. The row " +
      "stays declared and unsatisfied because its mission half is genuinely absent, not because the whole " +
      "of it is.)*",
    probe: (context) => isFunction(context.batteryWearInputsFor),
  },

  /* ── Process context the composition root supplies ─────────────────────────── */
  {
    id: "prisma",
    class: REQUIREMENT_CLASS.PROCESS_DEPENDENCY,
    owner: "the composition root",
    why: "agent snapshots, the claimed batch and the durable write all read through it",
    probe: (context) => present(context.prisma),
  },
  {
    id: "kv",
    class: REQUIREMENT_CLASS.PROCESS_DEPENDENCY,
    owner: "the composition root",
    why:
      "`candidates/availabilityIndex` reads the cell-partitioned index through it, and " +
      "`routing/cellPairCache` caches through it. Advisory for correctness (§3.3), required to expand at all",
    probe: (context) => present(context.kv),
  },
  // ── `commit` is no longer an injected requirement: the assembly builds it ────
  //
  // V1 composition, 2026-09-04. This row read *"§10.3.2's serialised conditional write,
  // already bound to its own dependencies"* — and E-8b then measured it as the one
  // remaining `PROCESS_DEPENDENCY`, correctly noting that nothing could supply it because
  // `commitment/commit.js` refuses without `volatileRecheck`, `volatileSubset
  // .createVolatileRecheck` refuses without a `buildContext` adapter, and that adapter's
  // own header says *"assembling an agent snapshot from a transaction is the round's work
  // (Phase 9/10) and not this module's."*
  //
  // **That adapter is now written**, in `workers/coordinatorSolvePath.js`, which is the
  // round's own composition root and therefore exactly where its header asked for it. So
  // `commit` is *composed* rather than *required*, and this row is replaced by the three
  // process dependencies the composition genuinely cannot build for itself. That is a
  // smaller ask, not a waived one: two of the three are already supplied by `server.js`.
  {
    id: "runSerializable",
    class: REQUIREMENT_CLASS.PROCESS_DEPENDENCY,
    owner: "the composition root",
    why:
      "§10.3.2's seven steps are one SERIALIZABLE transaction. `commitment/commit.js` opens it through this " +
      "seam rather than through a Prisma call of its own, and the composition root is the only place that " +
      "knows this deployment's isolation level and timeouts",
    probe: (context) => isFunction(context.runSerializable),
  },
  {
    id: "selectForUpdate",
    class: REQUIREMENT_CLASS.PROCESS_DEPENDENCY,
    owner: "the composition root",
    why:
      "§10.3.2 step 1's two explicit row locks, agent then Leg. `db/prisma.js` exports it and refuses " +
      "identifiers that did not come from engine code",
    probe: (context) => isFunction(context.selectForUpdate),
  },
  {
    id: "signingKey",
    class: REQUIREMENT_CLASS.PROCESS_DEPENDENCY,
    owner: "the operator — a declared deployment secret",
    why:
      "§23.3 — §10.3.2 step 5 writes the `OFFER` in the commit transaction and every command carries a " +
      "signature over its whole payload including the agent id. Without the key the commit would either " +
      "abort or write an unsigned command the agent is obliged to reject, so it is required here rather " +
      "than discovered at the first assignment",
    probe: (context) => present(context.signingKey),
  },
  {
    id: "snapshot",
    class: REQUIREMENT_CLASS.PROCESS_DEPENDENCY,
    owner: "the composition root",
    why:
      "§9.6 requirement 5 — the round's pinned configuration version. Every register probe above reads it. " +
      "Accepted as an accessor (`() => app.locals.config`) as well as a snapshot: P15-R2's rule, because " +
      "`create()` runs at boot and the composers run on every promotion.",
    probe: (context) => {
      const snapshot = snapshotFrom(context);
      return present(snapshot) && isFunction(snapshot.resolve);
    },
  },

  /* ── §6.4 admissibility, checked rather than assumed ───────────────────────── */
  {
    id: "Ω correction (candidates/omega.combinedCorrection)",
    class: REQUIREMENT_CLASS.ADMISSIBILITY,
    owner: "resolves from the pinned snapshot; see `problems` on the failure",
    why:
      "§6.4's bound subtracts `Ω_terminal` and `Ω_policy` because three cost terms can be negative, and **a " +
      "bound that omits a negative term is larger than the true cost, not smaller** — pruning would then " +
      "discard cells containing the true optimum while the decision record advertised a proven guarantee. " +
      "`lowerBound()` refuses a non-bigint correction, so this fails closed; it is probed here so the refusal " +
      "names §6.4 rather than surfacing as an unexplained empty candidate set.",
    probe: (context) => {
      const snapshot = snapshotFrom(context);
      if (!present(snapshot)) return false;
      try {
        return omega.combinedCorrection({ snapshot, omegaTerminalCu: context.omegaTerminalCu }).ok;
      } catch {
        return false;
      }
    },
  },
]);

/** Every requirement id, in declaration order. Used by `leaderWorkers.UNCOMPOSABLE`. */
const REQUIREMENT_IDS = Object.freeze(REQUIREMENTS.map((entry) => entry.id));

/**
 * Which of the coordinator's solve-path inputs this context can supply, and which it cannot.
 *
 * A probe that throws counts as **not satisfied**, never as satisfied: an input whose own
 * resolution raises is exactly the case where assuming presence is worst.
 *
 * @param {object} [context] the composition context; omit it for the standing contract
 * @returns {{ ok: boolean, missing: object[], satisfied: string[], byClass: object }}
 */
function requirements(context) {
  const source = context || {};
  const missing = [];
  const satisfied = [];

  for (const entry of REQUIREMENTS) {
    let ok = false;
    try {
      ok = entry.probe(source) === true;
    } catch {
      ok = false;
    }
    if (ok) satisfied.push(entry.id);
    else missing.push({ input: entry.id, class: entry.class, owner: entry.owner, why: entry.why });
  }

  const byClass = Object.create(null);
  for (const row of missing) byClass[row.class] = (byClass[row.class] || 0) + 1;

  return { ok: missing.length === 0, missing, satisfied, byClass };
}

/**
 * The refusal sentence, built from the measured list rather than restated.
 *
 * Grouped by class, because *who can supply this* is the actionable part and a flat list of
 * eight names hides that three of them are nobody's decision.
 *
 * @param {object[]} missing from `requirements()`
 * @returns {string}
 */
function describeMissing(missing) {
  const grouped = new Map();
  for (const row of missing) {
    if (!grouped.has(row.class)) grouped.set(row.class, []);
    grouped.get(row.class).push(row.input);
  }
  return [...grouped.entries()].map(([className, inputs]) => `${className}: ${inputs.join(", ")}`).join(" | ");
}

module.exports = {
  REQUIREMENT_CLASS,
  SOLVE_PATH_REGISTER_INPUTS,
  snapshotFrom,
  REQUIREMENTS,
  REQUIREMENT_IDS,
  requirements,
  describeMissing,
};

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

const logger = require("../config/logger");
// The drivable route an offer's stops carry. An **execution-path** producer, resolved
// outside the commit transaction and read by no cost term — see the module header for why
// it is not, and must not be presented as, the §5 routing source the composition declares.
const executionGeometry = require("../services/executionGeometry.service");

const cells = require("../engine/spatial/cells");
const hierarchy = require("../engine/spatial/hierarchy");
// **Read for `pinnedMembership` ONLY.** This module interprets a verdict that intake
// computed; it does not compute one. `evaluatePoint`, `validateDomainDeclaration` and
// `isInPolygon` must never be called from the decision path — ADR-28 forbids query-time
// geometry, and `spatialDeliveryDomain.test.js` asserts the prohibition mechanically
// rather than trusting this comment.
const deliveryDomain = require("../engine/spatial/deliveryDomain");
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
const schedulerClient = require("../engine/energy/chargingSchedulerClient");
const { compareStrings } = require("../engine/determinism/ordering");
const commitment = require("../engine/commitment/commit");
const offers = require("../engine/dispatch/offers");
const storablePrecision = require("../services/storablePrecision.service");
const legEntryDeadline = require("../engine/cutover/legEntryDeadline");
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

/**
 * The states a queue-driven commit may move a Leg *from*: waiting for an agent. G6
 * (`commitment/guards`) checks the Leg against the state the decision expected, and this
 * composer used to pass the state it happened to load — so a Leg already OFFERED, ACCEPTED
 * or AT_PICKUP satisfied G6 and was committed to a second agent (measured on the V1
 * demonstration path, 2026-09-23). A Leg outside this set is now expected to be in it, and
 * G6 refuses it by name.
 * @structural §4.3's pre-assignment states, resolved from the state machine
 */
const ASSIGNABLE_LEG_STATES = Object.freeze([
  legMachine.LEG_STATE.QUEUED,
  legMachine.LEG_STATE.PLANNED,
  legMachine.LEG_STATE.DEFERRED,
  legMachine.LEG_STATE.REASSIGNING,
]);

/**
 * The Availability Index classes that mean *"free now"* — read from `expansion.js` rather
 * than restated, so a §6.3 change cannot leave this composer with a second, drifting
 * notion of readiness.
 * @structural §6.3's ready classes, resolved from the module that searches them
 */
const READY_AVAILABILITY_CLASSES = expansion.READY_CLASSES;

/**
 * The reservation subsystem that owns a target state of charge (§14.6).
 *
 * Written as a literal rather than imported: `feasibility/predicates/f18.js` exports
 * `RESERVING_SUBSYSTEM` and `energy/chargingSchedulerClient.consumeReservations` stamps
 * the same label at `:213`, but no worker in this repository requires a predicate module
 * and adding the first such edge to satisfy one string would change the module graph
 * `gate:tiers` measures. The two producers are named here so a rename is greppable.
 * @structural §7.5 F18's own subsystem label, as `consumeReservations` writes it
 */
const CHARGING_SUBSYSTEM = "CHARGING";

/**
 * The §7.5 agent-snapshot fields an injected `agentFactsFor` provider may supply — each one
 * a field a predicate reads and no column carries. A whitelist, so a provider can never
 * replace a column-derived field (position, lifecycle, energy, identity).
 * @structural the predicates' own field names
 */
const AGENT_FACT_FIELDS = Object.freeze([
  "commissioning", // F1
  "operatorHold", // F3
  "quarantined", // F3
  "permittedTenants", // F4
  "firmwareVersion", // F5
  "firmwareVersionSource", // F5
  "calibrations", // F6
  "emergencyStop", // F7
  "faults", // F8
  "healthTier", // F9
  "localisation", // F10
  "reliability", // F11
  "advisories", // F12
  "session", // F13, F14, F15
  "autonomousDeadZoneCertified", // F15
  "safetyRelevantObservations", // F16, C_risk staleness
  "reservations", // F18
  "authorisedZoneIds", // F27
  "maintenance", // F36
  "provenance",
]);

/**
 * §7.5 F19's `latestFeasibleStartMs` for one plan — **derived, not declared**.
 *
 * The latest instant this plan can start and still finish by the Leg's deadline is the
 * deadline less the plan's own duration. A Leg with no deadline has no such bound beyond
 * the commitment horizon the plan is committed over (§13), so that horizon is the bound.
 * Nothing is invented: both branches are arithmetic on values the round already pinned.
 *
 * @param {object} leg
 * @param {object} plan
 * @param {number} decisionTimeMs
 * @param {*} horizonSeconds `plan.commitment_horizon`
 * @returns {number|undefined}
 */
function latestFeasibleStartFor(leg, plan, decisionTimeMs, horizonSeconds) {
  const start = plan && plan.projectedStartMs;
  const end = plan && plan.projectedEndMs;
  if (isNumber(leg && leg.deadlineMs) && isNumber(start) && isNumber(end)) return leg.deadlineMs - (end - start);
  if (isNumber(decisionTimeMs) && isNumber(horizonSeconds)) return decisionTimeMs + horizonSeconds * MS_PER_SECOND;
  return undefined;
}

/**
 * §7.5 F20's per-pairing exclusion set, derived from this Leg's durable Commitment history.
 *
 * `Commitment` records no release reason, so the NACK cooloff is taken **conservatively**:
 * any released commitment of *this* agent on *this* Leg is treated as a refusal, and the
 * pairing is excluded until `dispatch.nack_cooloff` after its release. That can exclude a
 * pairing a reason column would admit; it can never admit one it would exclude.
 *
 * @param {object[]} commitments every Commitment row for the Leg
 * @param {string} agentRowId
 * @param {*} nackCooloffSeconds
 * @returns {object}
 */
function legExclusionsFor(commitments, agentRowId, nackCooloffSeconds) {
  const rows = Array.isArray(commitments) ? commitments : [];
  const released = rows.filter((row) => row.releasedAt);
  const live = rows.filter((row) => !row.releasedAt);
  const mineReleased = released
    .filter((row) => row.agentId === agentRowId)
    .map((row) => new Date(row.releasedAt).getTime())
    .sort((a, b) => b - a);
  // A prior release with no resolvable cooloff cannot be bounded; `null` is read by F20 as
  // an unreadable set and denies, rather than as "no cooloff".
  if (mineReleased.length > 0 && !isNumber(nackCooloffSeconds)) return null;
  return {
    isIncumbent: live.some((row) => row.agentId === agentRowId),
    reassignmentsSoFar: released.length,
    cooloffUntil: null,
    nackCooloffUntil:
      mineReleased.length > 0 && isNumber(nackCooloffSeconds)
        ? mineReleased[0] + nackCooloffSeconds * MS_PER_SECOND
        : null,
  };
}

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
 * The round's agent-identity register — **the memo's single answer to "which agent".**
 *
 * ── The defect this closes ─────────────────────────────────────────────────
 * Three producers name an agent three ways, and the memo sat in the middle of all of them:
 *
 *   · `candidates/availabilityIndex` is keyed on `Agent.id` (the **row** id), because
 *     `indexMaintainer.assembleRecord` writes `agentId: agent.id`. So the `agentId`
 *     `expansion.evaluateOne` hands to `evaluateExact`, and the `candidate.agentId`
 *     `solve/round.plan` later passes to `pricedCandidateFor`, are row ids.
 *   · `agentSnapshotLoaderFor` returns **both** (`agentId` business, `agentRowId` row),
 *     and the memo was written under the business one.
 *   · `commitment/commit.js` locks the `Agent` row and hands `volatileRecheck` that row,
 *     whose `.agentId` is the **business** id.
 *
 * So `pricedCandidateFor(rowId, legId)` looked up a memo written under the business id,
 * missed, and `round.plan` did `if (!entry) continue` — **silently**. Every surviving,
 * feasible, priced candidate was dropped before it became a column: zero columns, zero
 * assignments, no error anywhere. Measured directly: a commit driven with row ids aborts
 * `ROUND_STATE_MISSING` and one driven with business ids aborts `AGENT_NOT_FOUND`, so the
 * pairing succeeded under *neither* convention.
 *
 * ── Why a register rather than picking one identifier ──────────────────────
 * Because all three producers are correct about their own layer, and the engine reads the
 * business identifier by design while `commit.js` locks on the row id by design. Forcing
 * one of them to change would push the mismatch somewhere else — into the decision record,
 * or into the offer the agent receives. This records what the round has *already
 * established*: `loadAgentSnapshot` resolved one identifier to a row carrying both, so the
 * two names are known to be the same agent, and the memo is keyed on the canonical one.
 *
 * Nothing is inferred. An identifier this round has not resolved maps to itself, so an
 * unknown agent still misses the memo exactly as before.
 *
 * @param {Map<string, string>} register
 * @param {object} agentSnapshot
 */
function rememberAgentIdentity(register, agentSnapshot) {
  if (!agentSnapshot) return;
  const canonical = agentSnapshot.agentRowId;
  if (typeof canonical !== "string" || canonical === "") return;
  register.set(canonical, canonical);
  if (typeof agentSnapshot.agentId === "string" && agentSnapshot.agentId !== "") {
    register.set(agentSnapshot.agentId, canonical);
  }
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

  /**
   * @param {string} agentId
   * @param {{ asOfMs?: number }} [options] the decision time the facts are for. A fact
   *   observed after it was not known when the decision was taken (T6), and a predicate
   *   measuring its age would read it as negative — stale — so the provider reads as of it.
   */
  return async function loadAgentSnapshot(agentId, options) {
    const asOfMs = options && isNumber(options.asOfMs) ? options.asOfMs : undefined;
    const position = await prisma.agentCellPosition.findFirst({
      // Either identifier, exactly as `legLoaderFor` already accepts either for a Leg.
      // `AgentCellPosition.agentId` is the FK to `Agent.id`, so the availability index's
      // row id matches directly; `commit.js` and the column carry the **business**
      // identifier, and resolving it here is what stops a correct pairing aborting
      // `AGENT_NOT_FOUND` at §10.3.2 step 1.
      where: { OR: [{ agentId }, { agent: { agentId } }] },
      include: {
        agent: {
          include: {
            // The Robot row carries the live session (`isOnline`, `lastSeenAt`), the
            // legacy status the health tier derives from, and `massKg` — read by the
            // agent-facts seam below and by §14.2's mass term. Never branched on here.
            robot: true,
            batteryState: true,
            commitments: { where: { releasedAt: null } },
            agentClass: {
              include: {
                mobilityModel: true,
                energyModel: true,
                // §15.2's compartments are the container: without them `container.normalise`
                // reports "declares no compartments" for every agent, however it was
                // commissioned.
                containerModel: { include: { compartments: { orderBy: { ordinal: "asc" } } } },
                // The bundle's `capabilities` rows, not just the bundle row: F21 matches the
                // mission's requirements against them (`domain/capability.indexBundle` reads
                // `bundle.capabilities`). `capabilityBundle: true` loaded the row alone, so
                // every stated requirement was INDETERMINATE and denied.
                capabilityBundle: { include: { capabilities: true } },
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
    const environment = isFunction(context.environmentFor) ? context.environmentFor(agent.agentId, agent) : null;

    // The §7.5 agent facts no column carries (commissioning, e-stop, faults, session, …),
    // from the injected provider or not at all. Absent, each stays `undefined` and its
    // predicate denies by name — which is exactly what happened before this seam existed.
    // Only the named fields are taken, so a provider cannot overwrite a column-derived one.
    const facts = isFunction(context.agentFactsFor)
      ? await context.agentFactsFor({
          agent,
          asOfMs,
          config: (name) => resolve(coordinatorPipeline.snapshotFrom(context), name, {}),
        })
      : null;
    const supplied = {};
    if (facts && typeof facts === "object") {
      for (const field of AGENT_FACT_FIELDS) {
        if (facts[field] !== undefined) supplied[field] = facts[field];
      }
    }

    return {
      ...supplied,
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
      // The column wins; a provider's tenant fills only a null column (F4).
      tenantId: agent.tenantId ?? (facts && facts.tenantId !== undefined ? facts.tenantId : agent.tenantId),
      fleetId: agent.fleetId,
      // `Robot.massKg` — the commissioning column `robotSpecification` writes and §14.2's
      // β_mass term needs. E-8b recorded it as "written and never read on the decision
      // path"; `vehicleMassKgFor` reads it from here.
      vehicleMassKg: agent.robot && isNumber(agent.robot.massKg) ? agent.robot.massKg : null,
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

      // The whole declared model, not the two fields the expansion happens to read.
      //
      // E-10 (§M.4) measured F28 and F29 denying on *"the agent's MobilityModel"* while
      // the row was loaded and four of its columns were dropped on the way through this
      // mapper — `permissionSet` (F28's enumerated surface classes), `envelopeConstraints`
      // and `dimensionalFootprint` (F29's passage limits) and `speedModel`. A mapper that
      // narrows a row is a mapper that makes a predicate report an absent record when the
      // record exists, which is the E-8 family of defect at the schema boundary. Each
      // column is passed through exactly as declared: absent columns stay `undefined` and
      // the predicates name them.
      mobilityModel: agentClass && agentClass.mobilityModel
        ? {
            traversalDomain: agentClass.mobilityModel.traversalDomain,
            kinematicLimits: agentClass.mobilityModel.kinematicLimits,
            permissionSet: agentClass.mobilityModel.permissionSet,
            envelopeConstraints: agentClass.mobilityModel.envelopeConstraints,
            dimensionalFootprint: agentClass.mobilityModel.dimensionalFootprint,
            speedModel: agentClass.mobilityModel.speedModel,
          }
        : null,
      containerModel: agentClass ? agentClass.containerModel : null,
      capabilityBundle: agentClass ? agentClass.capabilityBundle : null,

      // ── Two AgentClass columns the mapper dropped (N-2) ────────────────────
      //
      // The same defect §M.4 found on `MobilityModel` and W-A5 found on
      // `EnergyModelParams.stressCurves`, at a third row: the loader already fetches
      // `AgentClass` and two of its declared columns never reached the snapshot.
      //
      // `AgentClass.firmwareVersionSet` (`prisma/schema.prisma:1121`) is what F5 reads.
      // The predicate names the column in its own refusal — *"the agent class's
      // firmwareVersionSet"* (`predicates/f05.js:73-79`) — and validates the shape itself:
      // a non-object is `absent`, a non-array member is `indeterminate`, and an unlisted
      // mission type is *"not an unrestricted one"*. So the column is passed through
      // exactly as declared and no shape is asserted here.
      //
      // `AgentClass.hardwareRevision` (`:1120`) is what F12 matches a hardware-scoped
      // advisory against (`predicates/f12.js:53`). Absent, an advisory keyed by hardware
      // revision matches nothing and does so **silently**, which is the permissive
      // direction for a predicate whose whole purpose is to withhold an agent.
      //
      // **A divergence recorded rather than resolved.** `security/attestation.js:95-112`
      // signs a manifest carrying a *per-device* `hardwareRevision`, so a device's attested
      // revision and its class's declared one are two different facts. The class column is
      // the control plane's own statement and is the only one on a row this loader reads;
      // reconciling the two is the attestation read path N-2 records and does not build.
      supportedFirmwareByMissionType: agentClass ? agentClass.firmwareVersionSet : null,
      hardwareRevision: agentClass ? agentClass.hardwareRevision : null,

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
        mission: {
          include: {
            legs: { select: { id: true, sequence: true }, orderBy: { sequence: "asc" } },
            // §2.8 — `Task >──< Mission`. §2.4 puts the RequirementSet, the payload
            // specification, the SLA class and the tenant on the **Task**, and the Mission
            // is what discharges Tasks; the decision path reads them through this relation
            // or not at all. F4, F21 and F25 denied on `mission.tenantId`,
            // `mission.requirements` and `mission.payload` while every one of those was a
            // column on a row this query did not join (§M.4).
            tasks: { include: { payloadSpec: true } },
          },
        },
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
      // §2.4's Task attributes, resolved across the Mission's Tasks. Absent rather than
      // guessed when the Tasks disagree — see `agreedTaskAttribute`.
      tasks: taskAttributesFor(leg.mission),
      stops: leg.stops.map((stop) => ({
        stopId: stop.stopId,
        sequence: stop.sequence,
        stopType: stop.stopType,
        siteId: stop.siteId,
        lat: stop.lat,
        lon: stop.lon,
        // **The pinned geofence verdict (D1).** This projection is a whitelist, and until
        // RD-2026-09-14-01 it silently dropped this column — so a verdict written at
        // intake could never reach the round that needed it, and the layer that produced
        // it and the layer that consumed it were each individually correct.
        //
        // Carried raw, as the string the column holds, and interpreted by
        // `deliveryDomain.pinnedMembership` at the one place that reads it. Coercing it to
        // a boolean here would collapse INDETERMINATE and OUTSIDE into one value, and
        // those are the two answers D1 most needs kept apart.
        geofenceResult: stop.geofenceResult ?? null,
        // §2.4's per-Stop access constraints, for F32. **Only a stated list is carried.**
        // F32 reads `undefined` as *"nobody established what this site requires"* and
        // `null`/`[]` as *"none required"*, and those are different facts: a `Json?`
        // column nobody has populated is the first, not the second. So an array is passed
        // through and anything else — including a `null` column — leaves the field absent
        // and F32 denies. Populating the column with `[]` is how an operator declares a
        // kerbside stop, which is a statement someone makes rather than one this mapper
        // makes for them.
        accessPrerequisites: Array.isArray(stop.accessConstraints) ? stop.accessConstraints : undefined,
      })),
    };
  };
}

/**
 * One attribute, agreed across every Task the Mission discharges — or absent.
 *
 * §2.8 makes `Task >──< Mission` many-to-many, so a Mission may discharge several Tasks
 * and they may disagree about the tenant, the RequirementSet or the payload. **A
 * disagreement is not a tie to be broken here.** Picking the first Task's tenant would let
 * F4 certify multi-tenant isolation against one of two customers, which is the permissive
 * direction on an isolation predicate; unioning two RequirementSets would assert a
 * requirement nobody declared. Both are answered by leaving the attribute absent, which is
 * what the predicates read as *"nobody established this"*.
 *
 * @param {object[]} tasks
 * @param {(task: object) => *} read
 * @returns {*} the agreed value, or `undefined`
 */
function agreedTaskAttribute(tasks, read) {
  const stated = [];
  for (const task of tasks || []) {
    const value = read(task);
    if (value !== undefined && value !== null) stated.push(value);
  }
  if (stated.length === 0) return undefined;
  const first = stated[0];
  for (const value of stated) {
    if (value !== first) return undefined;
  }
  return first;
}

/**
 * §2.4's Task-carried mission attributes: tenant, RequirementSet, payload specification.
 *
 * @param {object|null} mission a `Mission` row with `tasks.payloadSpec` included
 * @returns {{ tenantId: *, requirements: *, payload: *, taskCount: number }}
 */
function taskAttributesFor(mission) {
  const tasks = (mission && mission.tasks) || [];
  return {
    taskCount: tasks.length,
    // ── The customer-visible identifiers this Leg discharges ────────────────
    //
    // Carried because the *agent* needs one. A `Leg` is the unit of assignment and a
    // `Task` is the unit of customer-visible work (§2.4), and completion is reported
    // against the second: `sockets/handlers/dtaro.handler.js` matches `TASK_COMPLETE` on
    // `Task.taskId`. Without an identifier on the offer the agent has only the Leg's
    // primary key to report, which matches no Task row, so the mission completes on the
    // agent and the Task stays open forever.
    //
    // Ordered, so an offer built twice from the same Mission names its Tasks in the same
    // order — §9.6's determinism applied to a field that reaches a durable outbox row.
    taskIds: tasks
      .map((task) => task.taskId)
      .filter((taskId) => typeof taskId === "string" && taskId !== "")
      .sort(),
    tenantId: agreedTaskAttribute(tasks, (task) => task.tenantId),
    // The RequirementSet is a JSON document on the Task (§2.3). Carried only when it is
    // the list `domain/capability.matchRequirements` reads; anything else is left absent
    // so F21 reports "unreadable" rather than matching against a shape it did not expect.
    requirements: agreedTaskAttribute(tasks, (task) => (Array.isArray(task.requirements) ? task.requirements : undefined)),
    payload: agreedTaskAttribute(tasks, (task) => task.payloadSpec),
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
 * §14.4's vendor stress curves, **from the column that declares them**.
 *
 * `energy/wear.js` names its own source in its parameter documentation — *"the pack's
 * `stressCurves` from `EnergyModelParams`"* — and `prisma/schema.prisma` declares
 * `EnergyModelParams.stressCurves` as *"the vendor cycle-life-versus-DoD curves §14.4
 * prices wear from"*. `agentSnapshotLoaderFor` already loads that row whole and puts it on
 * the snapshot as `energyModelParams`, so the value was **loaded and then not read**.
 *
 * That is the E-8b family of defect — a producer exists and the composition root does not
 * use it — and it survived because the two places that state why this family has no
 * producer both name the **wrong row**: `EnergyModel` carries `chargePowerCurve` and
 * `thermalDeratingCurve` and indeed no wear curve, which is true and is not the question.
 *
 * **Nothing is derived, defaulted, or inferred here.** An absent or non-object column stays
 * absent, `wear.batteryWear` then names `stressCurves`, and `cLifecycle` carries the
 * refusal up as `battery.*` exactly as before. A deployment that has not characterised its
 * pack gets the same answer it gets today; one that has, is no longer told the value has
 * nowhere to live.
 *
 * @param {object} agentSnapshot
 * @returns {object|null}
 */
function packStressCurvesFrom(agentSnapshot) {
  const params = agentSnapshot && agentSnapshot.energyModelParams;
  const curves = params && params.stressCurves;
  return curves && typeof curves === "object" ? curves : null;
}

/**
 * §14.4's battery-wear argument set: what the seam supplies, plus what a column carries.
 *
 * Precedence is **seam over column**, not the reverse, and that direction is deliberate:
 * an explicitly injected `curves` is a caller stating what this evaluation is to be done
 * against, and silently overriding it with a row would make an injected value untestable.
 * The column fills only the gap — the case where nothing supplies curves at all, which is
 * every production call today.
 *
 * The mission's `conditions` (`dod`, `socMid`, `tempC`, `cRate`) and its `socThroughput`
 * are **not** filled from anywhere. No column carries them, `tempC` needs the environment
 * family this contract also lists as absent, and deriving them here would be inventing the
 * mission physics §14.4 prices. So this narrows the external requirement; it does not
 * close it, and `battery wear inputs (§14.4)` remains a declared, unsatisfied input.
 *
 * @param {object} seams
 * @param {object} agentSnapshot
 * @param {object} plan
 * @param {*} cuPerEquivalentCycle
 * @returns {object}
 */
function batteryWearInputFor(seams, agentSnapshot, plan, cuPerEquivalentCycle) {
  const supplied = isFunction(seams.batteryWearInputsFor) ? seams.batteryWearInputsFor(agentSnapshot, plan) : null;
  const input = { ...(supplied || {}), cuPerEquivalentCycle };
  if (input.curves === undefined || input.curves === null) {
    const declared = packStressCurvesFrom(agentSnapshot);
    if (declared) input.curves = declared;
  }
  return input;
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
      // stress curves, the mission's `{ dod, socMid, tempC, cRate }` and its SoC
      // throughput.
      //
      // **Corrected 2026-09-05.** This block asserted that *"no schema column carries
      // either"*, naming `EnergyModel`. That row does hold `chargePowerCurve` and
      // `thermalDeratingCurve` and no wear curve — and it is the wrong row.
      // `EnergyModelParams.stressCurves` is declared in the schema for exactly this
      // purpose, `wear.js` names it as its own source, and `agentSnapshotLoaderFor` loads
      // it. The curves were **loaded and not read**; they are read now
      // (`batteryWearInputFor`). The `conditions` and `socThroughput` halves still have no
      // column and no producer, so this family is narrowed and stays unsatisfied:
      // `batteryWear` names what is missing and `cLifecycle` carries it up as `battery.*`.
      battery: batteryWearInputFor(
        seams,
        agentSnapshot,
        plan,
        resolve(snapshot, "cost.battery.cu_per_equivalent_cycle", scope),
      ),
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
 * The pinned charger-availability projection, from the durable row §14.5 calls immutable.
 *
 * `ChargerAvailabilityProjection` is *the* authority (§3.3): the KV mirror
 * `chargerReachability.worker.mirrorProjection` writes is a cache, and this deployment
 * starts that worker nowhere, so a mirror read would be a lookup that always misses.
 *
 * The latest version is read, then validated by the module that owns the shape —
 * `chargingSchedulerClient.consumeProjection`, which refuses a projection with no version
 * or no publication time. **A projection that does not validate is not pinned**: `null`
 * travels on, `eReturn` measures staleness as *"no charger availability projection is
 * pinned into this round"*, and §14.5's defined degradation to `DEPOT_ONLY` applies. That
 * is a stated fallback, not a silent one.
 *
 * @param {object} context
 * @returns {Promise<{ projection: object|null, problems: string[] }>}
 */
async function pinnedChargerProjection(context) {
  const table = context.prisma && context.prisma.chargerAvailabilityProjection;
  if (!table || !isFunction(table.findFirst)) {
    return { projection: null, problems: ["the store exposes no ChargerAvailabilityProjection table"] };
  }

  const row = await table.findFirst({ orderBy: { version: "desc" } });
  if (!row) return { projection: null, problems: ["no charger availability projection has been published"] };

  const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
  const consumed = schedulerClient.consumeProjection({
    version: row.version,
    publishedAt: row.publishedAt,
    horizonEnd: row.horizonEnd,
    chargers: payload.chargers,
  });
  if (!consumed.ok) {
    return { projection: null, problems: consumed.problems.map((problem) => `projection ${String(row.version)}: ${problem}`) };
  }
  return { projection: consumed.projection, problems: [] };
}

/**
 * The Charging Scheduler's published target for this agent, as the agent snapshot carries
 * it — **read, never chosen.**
 *
 * `feasibility/predicates/f18.js:80` reads reservations off the agent snapshot as
 * `agent.reservations`, and `chargingSchedulerClient.consumeReservations` is what shapes
 * them; each carries the Scheduler's `targetSoc` "carried through untouched"
 * (`chargingSchedulerClient.js:218-219`).
 *
 * **Two things this deliberately does not do.**
 *
 *  1. It does not pick between disagreeing targets. `assertNotEngineComputed`'s own
 *     docstring names the failure it exists to prevent — *"both implement it and the
 *     fleet receives two different target values for the same agent"* — so a reservation
 *     set stating more than one distinct target is refused by name rather than resolved
 *     by taking the first.
 *  2. It does not synthesise a publication time. §14.6's `energy.target_soc_max_age` test
 *     is a test on the target's **age**, and the round holds no publication time for a
 *     reservation: the shape `consumeReservations` produces carries `from`, `until` and
 *     `targetSoc` and no `publishedAtMs`. Attributing the pinned projection's publication
 *     time to a reservation would be asserting a freshness nobody measured, and in the
 *     permissive direction. Absent, `resolveTargetSoc` correctly finds nothing fresh.
 *
 * @param {object} agentSnapshot
 * @returns {{ targetSoc: number|null, publishedAtMs: number|null, problems: string[] }}
 */
function publishedTargetSocFrom(agentSnapshot) {
  const reservations = agentSnapshot && agentSnapshot.reservations;
  if (!Array.isArray(reservations)) return { targetSoc: null, publishedAtMs: null, problems: [] };

  const targets = [];
  let publishedAtMs = null;
  for (const reservation of reservations) {
    if (!reservation || reservation.subsystem !== CHARGING_SUBSYSTEM) continue;
    if (!isNumber(reservation.targetSoc)) continue;
    if (!targets.includes(reservation.targetSoc)) targets.push(reservation.targetSoc);
    if (publishedAtMs === null && isNumber(reservation.publishedAtMs)) publishedAtMs = reservation.publishedAtMs;
  }

  if (targets.length > 1) {
    return {
      targetSoc: null,
      publishedAtMs: null,
      problems: [
        `the agent's charging reservations state ${targets.length} different target states of charge ` +
          `(${targets.join(", ")}). §14.6 gives one owner to the target; two published values for one ` +
          "agent are the conflict that ownership exists to prevent, and the engine does not choose between them",
      ],
    };
  }

  return { targetSoc: targets.length === 1 ? targets[0] : null, publishedAtMs, problems: [] };
}

/**
 * §14.6's target state of charge, resolved by **the Charging Scheduler's own client** and
 * never by this composition root.
 *
 * ── What was missing ───────────────────────────────────────────────────────
 * `chargingSchedulerClient.resolveTargetSoc()` is the shipped resolver for this question.
 * It was exported and unit-tested and **called from nowhere in `src/`**: `planInputFor`
 * read `input.targetSoc` and `input.targetSocSource`, and no caller set either. So
 * `plan/planBuilder.insertChargingStop` refused every insertion at `planBuilder.js:619-635`
 * with a sentence reading *"with neither a published target nor the class fallback
 * resolved"* — while on the published register `energy.target_soc_fallback` resolves to
 * `0.8` and `energy.target_soc_max_age` to `300`. The refusal was true about the outcome
 * and **false about the attempt**, because no attempt was made. This is the E-8b family
 * for the fifth time: *a producer exists and the composition root does not use it*.
 *
 * ── Two lawful outcomes, and why only one is taken here ────────────────────
 * §14.6 admits exactly two: the Scheduler's published target, and §14.7's pre-declared
 * `TARGET_SOC_CLASS_DEFAULT` substitution. The substitution is lawful **only** on the
 * condition the resolver states with it — *"records the substitution as a degradation flag
 * on every affected decision"* — and it returns the flag, in its own words, *"so the
 * caller attaches it, rather than logged here where a decision record would never see
 * it."*
 *
 * **This composition root has nowhere to attach it, and that was measured rather than
 * assumed.** The channel a decision record reads is
 * `decisionRecord.writeRound`'s `context.perLeg[legId].degradations`
 * (`observability/decisionRecord.js:574`, consumed by `sampling.classifyExemption`);
 * `coordinator.worker.recordRound` passes `input.perLeg` straight through
 * (`coordinator.worker.js:396`) and **nothing in this repository supplies it**. Tier A's
 * `degradation` section carries dependencies, envelope reductions, relaxations, shard
 * modes and kill switches (`observability/tierA.js:485-495`) — not a per-decision flag
 * list.
 *
 * So the substitution is **declined by name** rather than taken unrecorded. That keeps
 * today's behaviour exactly — no charging stop is planned — and replaces a refusal that
 * misdescribed the register with one that names what is actually absent. Taking it would
 * be a permissive change that dropped a flag §14.6 requires, which is E-1's
 * `achievedGapProven` defect in a new place.
 *
 * @param {object} input
 * @param {object} input.agentSnapshot
 * @param {object} input.snapshot the round's pinned configuration snapshot
 * @param {object} input.scope **must carry `agent_class`** — see below
 * @param {number} input.decisionTimeMs the round's pinned time, never a clock read
 * @returns {{ targetSoc: number|undefined, targetSocSource: string|undefined, problems: string[] }}
 */
function targetSocFor({ agentSnapshot, snapshot, scope, decisionTimeMs }) {
  const absent = (problems) => ({ targetSoc: undefined, targetSocSource: undefined, problems });

  const published = publishedTargetSocFrom(agentSnapshot);
  if (published.problems.length > 0) return absent(published.problems);

  const resolved = schedulerClient.resolveTargetSoc({
    publishedTargetSoc: published.targetSoc,
    publishedAtMs: published.publishedAtMs,
    decisionTimeMs,
    maxAgeSeconds: resolve(snapshot, "energy.target_soc_max_age", scope),
    // Indexed by `agent_class`, so the scope must carry one. This is §M.4's lesson about
    // `capacity` at a second parameter: a scope without `agent_class` cannot index an
    // indexed row, and the miss reads exactly like an unresolved parameter.
    classFallback: resolve(snapshot, "energy.target_soc_fallback", scope),
  });

  if (!resolved.ok) return absent([resolved.reason]);

  if (resolved.degradationFlag) {
    return absent([
      `§14.7's ${resolved.degradationFlag.flag} substitution is available — ` +
        `energy.target_soc_fallback resolves to ${String(resolved.degradationFlag.substituted)} for this agent ` +
        "class — and is not taken. §14.6 admits it only where the substitution is recorded as a degradation " +
        "flag on every affected decision, and this composition root supplies no per-Leg degradation context to " +
        "observability/decisionRecord.writeRound, so the flag would be recorded nowhere. The engine declines a " +
        "degradation it cannot record rather than taking it silently",
    ]);
  }

  // The shipped provenance guard, on the path it was written for. It refuses any source
  // that is not one of §14.6's two owners, so a future producer cannot quietly widen the
  // set by returning a third.
  const provenance = schedulerClient.assertNotEngineComputed(resolved.source);
  if (!provenance.ok) return absent([provenance.reason]);

  return { targetSoc: resolved.targetSoc, targetSocSource: resolved.source, problems: [] };
}

/**
 * The declared charger estate, as the nearest-k return-leg candidates `eReturn` reads —
 * **the F35 seam.**
 *
 * ── What was missing ───────────────────────────────────────────────────────
 * `planInputFor` has always read `input.chargerCandidates` and **no caller supplied it**
 * (§M.3). The consequence was not a missing charging stop: `eReturn` resolved no return
 * leg, `reserves.compose` refused — §14.5 calls a zero return reserve *"a reachability
 * question nobody answered"* — `plan.energy` came out `null`, and **F34 and F35 both
 * denied for every agent at every state of charge.** So this seam is not a charging
 * feature; it is what makes a plan have an energy projection at all.
 *
 * ── The contract, and where each field comes from ──────────────────────────
 * `eReturn.evaluate` reads `{ chargerId, energyWh, travelSeconds, isDepot }`:
 *
 *   · `chargerId` / `isDepot` — the `Charger` row. Schema-backed and therefore this
 *     repository's to assemble, on §F.0's own rule for payload mass. `isDepot` decides
 *     admissibility under the `DEPOT_ONLY` basis, so it is read and never assumed.
 *   · `travelSeconds` — the **same** cell-pair seam every other traversal goes through,
 *     so §20.3's intra-cell offset is applied by the module that owns it and the return
 *     leg is priced under the same profile and congestion bucket as the mission.
 *   · `energyWh` — `distanceM × the profile's return-leg Wh per metre`, which is exactly
 *     what `routing/chargerReachabilityCache.buildEntry` computes and exactly the input it
 *     asks its own caller for. **No register entry and no column carries it**, and it is
 *     not derivable here: `β_dist` alone omits mass, gradient, auxiliary and time terms,
 *     so using it would understate `E_return`, overstate the surplus, and admit missions
 *     the reserve exists to refuse. It arrives through a declared seam or the candidate
 *     is not built — see `coordinatorPipeline`'s `returnLegEnergyWhPerMetre` requirement.
 *
 * ── Fail-closed, per charger, by name ──────────────────────────────────────
 * A charger with no `cellId`, or one the routing seam cannot answer for, is **omitted and
 * reported** rather than admitted at a guessed distance. Omission shrinks the admissible
 * set, which is the conservative direction: it can only make `E_return` unreachable, never
 * reachable.
 *
 * @param {object} input
 * @returns {Promise<{ candidates: object[], truncated: boolean, problems: string[] }>}
 */
async function chargerCandidatesFor(input) {
  const { context, routing, originCell, profileKey, snapshot, scope } = input;
  const problems = [];

  const table = context.prisma && context.prisma.charger;
  if (!table || !isFunction(table.findMany)) {
    return { candidates: [], truncated: false, problems: ["the store exposes no Charger table"] };
  }
  if (!originCell) {
    return { candidates: [], truncated: false, problems: ["the plan's mission-end cell is unresolved"] };
  }

  const whPerMetre = isFunction(context.returnLegEnergyWhPerMetreFor)
    ? context.returnLegEnergyWhPerMetreFor(profileKey)
    : context.returnLegEnergyWhPerMetre;
  if (!isNumber(whPerMetre) || whPerMetre <= 0) {
    return {
      candidates: [],
      truncated: false,
      problems: [`the return-leg Wh per metre for profile "${String(profileKey)}" is unresolved`],
    };
  }

  // Ordered by identifier so the read itself is deterministic before the distance sort
  // ranks it — two hosts must not disagree about which chargers were even considered.
  const rows = await table.findMany({ orderBy: { chargerId: "asc" } });
  if (rows.length === 0) {
    return { candidates: [], truncated: false, problems: ["no Charger rows are declared in this deployment"] };
  }

  const routed = [];
  for (const row of rows) {
    if (!row.cellId) {
      problems.push(`charger ${String(row.chargerId)} states no cell and cannot be routed to (§20.3 item 3)`);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const traversal = await routing.forPairing(originCell, [{ sequence: 1, cellId: row.cellId }], profileKey);
    if (!traversal.ok || !traversal.hops[0]) {
      problems.push(`charger ${String(row.chargerId)}: ${traversal.problems.join("; ")}`);
      continue;
    }
    const hop = traversal.hops[0];
    if (!isNumber(hop.distanceM) || !isNumber(hop.travelSeconds)) {
      problems.push(`charger ${String(row.chargerId)}: the traversal states no distance or travel time`);
      continue;
    }
    routed.push({
      chargerId: row.chargerId,
      chargerClass: row.chargerClass ?? null,
      isDepot: row.isDepot === true,
      distanceM: hop.distanceM,
      travelSeconds: hop.travelSeconds,
      energyWh: hop.distanceM * whPerMetre,
    });
  }

  // Nearest first, with `compareStrings` rather than `localeCompare` breaking the tie:
  // this sort decides which chargers survive the `slice(0, k)`, so two hosts with
  // different collation could otherwise truncate a tie differently and one round could
  // find a destination another could not (§9.6 replay). Same rule, and the same reason,
  // as `chargerReachabilityCache.buildEntry`.
  routed.sort((a, b) => a.distanceM - b.distanceM || compareStrings(a.chargerId, b.chargerId));

  const k = resolve(snapshot, "route.charger_reachability_k", scope);
  if (!Number.isInteger(k) || k < 1) {
    return { candidates: [], truncated: false, problems: [...problems, "route.charger_reachability_k is unresolved"] };
  }

  return {
    candidates: routed.slice(0, k).map((entry) => Object.freeze(entry)),
    // What tells `eReturn` that "no admissible charger" may mean "none within k" rather
    // than "none at all" (§20.3 item 3): k bounds the entry, not the constraint.
    truncated: routed.length > k,
    problems,
  };
}

/**
 * Serviceability for a Leg's stops — **the F33 seam**, and since RD-2026-09-14-01 a
 * **three-part conjunction** rather than a single lookup.
 *
 *     serviceable = assigned ∧ inDeliveryDomain ∧ routable
 *
 * ── Why it is three things and not one ─────────────────────────────────────
 * Until D1 this function answered `serviceable: true` on `assignment.assigned` alone,
 * which silently asserted two further facts nobody had established: that the indexed
 * cell's ground is inside the delivery domain, and that the point can be reached by the
 * road network. D1 separates the layers:
 *
 *   · **assigned** — `spatial/hierarchy.indexMap().resolve()`, §3.6's
 *     containment-by-assignment. This is an **index** question. An H3 cell may be in the
 *     published index and straddle the campus boundary (D6): that makes it an index
 *     bucket, not a claim about the ground it covers.
 *   · **inDeliveryDomain** — the **pinned** verdict on `Stop.geofenceResult`, taken at
 *     intake on the exact coordinate against the published domain geometry.
 *   · **routable** — whether the point reaches the routing graph. Depends on
 *     `snapRadiusM`, which is **R13**, an unresolved external input.
 *
 * ── This function evaluates NO geometry, and that is load-bearing ──────────
 * It reads a verdict someone else computed at a lifecycle boundary. It does not call
 * `deliveryDomain.evaluatePoint`, does not touch a polygon, does not import a geometry
 * library, and must never begin to: ADR-28's decision text is *"containment by published
 * assignment, **not by query-time geometry**"* and §3.6 gives the reason — *"floating-point
 * geometry evaluated per round … is both slow and non-deterministic (T6)"*. Pinning at
 * intake and consuming the pin here is precisely what makes D1 compatible with the frozen
 * architecture; evaluating the polygon here would not be, and a test asserts that this
 * module cannot reach the geometry.
 *
 * ── The three answers, and why "absent" is not "false" ─────────────────────
 * Each conjunct is three-valued, and the conjunction follows §4.1's discipline:
 *
 *   · **any conjunct definitely false** → `serviceable: false` → F33 **VIOLATED**, DENY.
 *     Today only the domain conjunct can be definitely false: an outside coordinate is a
 *     definite geographic fact about the request.
 *   · **every conjunct true** → `serviceable: true` → F33 SATISFIED.
 *   · **any conjunct absent, none false** → `serviceable` stays **absent** → F33
 *     INDETERMINATE, DENY. *"An unassigned cell is not an out-of-area one"* (§M.2), an
 *     undeclared domain is not a universal one, and an unmeasured snap radius is not a
 *     reachable road. All three deny; only the absent answer tells the truth about why.
 *
 * **Nothing here defaults an absent conjunct to true.** That is the single mutation this
 * seam most needs to be unable to survive, and `spatialMutants.js` asserts it.
 *
 * ── The standing consequence: F33 cannot be SATISFIED today ────────────────
 * `routable` has **no producer in `src/`**. `snapRadiusM` exists only in
 * `tools/routing/adapters/`, in a deployment module that is an external input B1 has not
 * supplied. So with a perfect index and a perfect delivery-domain declaration, this
 * function still returns an absent verdict and F33 still denies — **fail-closed, and
 * correct**. That is a real tightening in the conservative direction relative to the
 * previous behaviour, it is reported rather than hidden, and it is not to be relieved by
 * choosing a snap radius that looks reasonable. R13 is an owner input.
 *
 * @param {object|null} snapshot the round's pinned configuration snapshot
 * @returns {(stops: object[]) => object[]}
 */
function serviceabilityFor(snapshot) {
  const map = snapshot && snapshot.spatial;
  let index = null;
  if (map && typeof map === "object") {
    try {
      index = hierarchy.indexMap(map);
    } catch {
      // An unreadable published map is not an empty one and is not a permissive one: the
      // stops keep their absent assignment and F33 denies, naming the assignment.
      index = null;
    }
  }

  return function withServiceability(stops) {
    return (stops || []).map((stop) => {
      const cellId = stop.cellId || cellIdFor(stop);
      const projected = cellId ? { ...stop, cellId } : { ...stop };

      // ── Conjunct 1 — assigned (the index) ──────────────────────────────────
      // `undefined` where no map is published or no cell could be derived: absent, not
      // false. A deployment that has declared no region has not declared the world
      // serviceable.
      const assigned = index === null || !cellId ? undefined : index.resolve(cellId).assigned === true ? true : undefined;

      // ── Conjunct 2 — inDeliveryDomain (the pinned exact-coordinate verdict) ─
      const inDeliveryDomain = deliveryDomain.pinnedMembership(stop.geofenceResult);

      // ── Conjunct 3 — routable (R13) ────────────────────────────────────────
      // Read, never assumed. Nothing on the decision path produces it, so it is
      // `undefined` and the conjunction is absent. Deleting this line, or reading its
      // absence as `true`, would restore exactly the silent assertion D1 removed.
      const routable = stop.routable === true ? true : stop.routable === false ? false : undefined;

      const conjuncts = [assigned, inDeliveryDomain, routable];
      if (conjuncts.some((value) => value === false)) return { ...projected, serviceable: false };
      if (conjuncts.every((value) => value === true)) return { ...projected, serviceable: true };
      return projected;
    });
  };
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
  const itemised = payloadFor(leg);
  // A Leg whose manifests itemise nothing takes the deployment's declared consignment, if
  // it composed one (`v1DemonstrationProfile.consignmentFor`); otherwise it stays empty and
  // §15's packing refuses by name, as before.
  const declaredConsignment =
    itemised.items.length === 0 && itemised.unresolved.length === 0 && isFunction(seams.defaultConsignmentFor)
      ? seams.defaultConsignmentFor(leg)
      : null;
  const payload =
    declaredConsignment && Array.isArray(declaredConsignment.items) && declaredConsignment.items.length > 0
      ? { items: declaredConsignment.items, massKg: declaredConsignment.massKg, unresolved: [] }
      : itemised;

  // §14.5's two Safety rows, per agent where the agent's own model declares them.
  //
  // `agentEnergyDeclarationsFor` answers only for an agent whose energy model is a
  // declaration rather than a fit — today, a simulated pack, whose floor is the simulator's
  // own clamp and whose dispersion is its own speed jitter. For every other agent it
  // answers nothing and the **register stays the authority**: unresolved there, the plan
  // refuses by name, exactly as before. `diagnostics.controller` already reads the model's
  // own `residualCv` ahead of the register; this is the same precedence on the decision path.
  const declared = isFunction(seams.agentEnergyDeclarationsFor) ? seams.agentEnergyDeclarationsFor(agentSnapshot) : null;
  const declaredResidualCv = declared && isNumber(declared.residualCv) ? declared.residualCv : undefined;
  const declaredFloorWh = declared && isNumber(declared.reserveFloorWh) ? declared.reserveFloorWh : undefined;

  // The stops as the gate reads them. `routable` is set only from the traversal this
  // pairing actually resolved (F33's third conjunct), and a Stop whose access column nobody
  // populated takes the deployment's declared prerequisites, if it declared any (F32).
  const defaultAccess = Array.isArray(seams.defaultStopAccessPrerequisites) ? seams.defaultStopAccessPrerequisites : undefined;
  const stopsForPlan = leg.stops.map((stop) => ({
    ...stop,
    routable: input.routable === true ? true : stop.routable,
    accessPrerequisites: stop.accessPrerequisites !== undefined ? stop.accessPrerequisites : defaultAccess,
  }));
  const servicedStops = serviceabilityFor(snapshot)(stopsForPlan);

  // §7.5 F27–F31's route facts and forecast, from the routing producer that planned this
  // traversal. Absent for an agent no producer describes, and those predicates then deny.
  const route = isFunction(seams.routeDescriptorFor)
    ? seams.routeDescriptorFor({
        agentSnapshot,
        stops: servicedStops,
        decisionTimeMs,
        horizonSeconds: resolve(snapshot, "plan.commitment_horizon", scope),
      })
    : undefined;
  const environmentForecast = isFunction(seams.environmentForecastFor) ? seams.environmentForecastFor(agentSnapshot) : undefined;
  const thermalStressMultiplier = isFunction(seams.thermalStressMultiplierFor)
    ? seams.thermalStressMultiplierFor(agentSnapshot)
    : undefined;

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
        // §3.6's assignment, resolved from the pinned map. Absent where the map is
        // absent — F33 then denies, which is the whole point of the seam.
        stops: servicedStops,
      },
    ],
    ...(route === undefined ? {} : { route }),
    ...(environmentForecast === undefined ? {} : { environmentForecast }),
    ...(thermalStressMultiplier === undefined ? {} : { thermalStressMultiplier }),
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
      residualCv: declaredResidualCv ?? resolve(snapshot, "energy.model_residual_cv", scope),
      // `energy.variance_inflation` — the register's own name (§14.5's three inflation
      // factors, which `consumption.predictiveDistribution` names one by one when they do
      // not resolve). E-10 found this asked for `energy.uncertainty_inflation`, which the
      // register does not carry: `snapshot.resolve()` answers `undefined` for an unknown
      // name, exactly as it does for a registered-but-null entry, so a **published**
      // PROVISIONAL value read as an input the owner had not supplied — and no plan was
      // built for any candidate. The composition test's own fixture overrode the same
      // misspelling, which is why 42 green tests said nothing about it (§M.1, M-1).
      inflations: resolve(snapshot, "energy.variance_inflation", scope),
      severity: input.uncertaintySeverity,
      floorWh: declaredFloorWh ?? resolve(snapshot, "energy.reserve_floor_wh", scope),
      operationalWh: resolve(snapshot, "energy.operational_reserve_wh", scope),
      contingencyQuantile: resolve(snapshot, "energy.contingency_quantile", scope),
      availabilityMargin: resolve(snapshot, "energy.charger_availability_margin", scope),
      // `energy.charger_projection_max_age` — the register's name, and `eReturn.staleness`
      // names it verbatim in its own refusal. Under the old spelling that refusal fired on
      // every round, so §14.5's `PINNED_PROJECTION` basis was unreachable and F35 would
      // have reported `DEPOT_ONLY` as a *choice* the engine never made (§M.1, M-2).
      projectionMaxAgeSeconds: resolve(snapshot, "energy.charger_projection_max_age", scope),
      uncalibratedReserveFactor: resolve(snapshot, "energy.uncalibrated_reserve_factor", scope),
    },
    charging: {
      // §14.5's `E_return` layer, from the declared estate — `chargerCandidatesFor` above.
      //
      // The previous note here said an empty set was survivable because
      // `NO_FEASIBLE_INSERTION` is a priced outcome. E-10 measured the rest of that chain
      // (§M.3): with no candidates, `reserves.compose` refuses, `plan.energy` is `null`,
      // and **F34 and F35 deny for every agent** — so an empty estate is survivable in the
      // sense that the engine keeps saying why, and not in the sense of producing an
      // assignment. `RD-2026-08-30-01` records that no production chargers exist at either
      // campus; that is a statement about production, and it is the decision this row needs
      // re-taken for a V1 environment. Nothing is invented here in the meantime.
      chargerCandidates: input.chargerCandidates || [],
      projection: input.chargerProjection || null,
      // §14.6 gives the Charging Scheduler ownership of the target SoC and forbids the
      // engine to compute one. Absent, `insertChargingStop` refuses by name.
      //
      // Supplied by `targetSocFor()` at the call site, through the Scheduler's own
      // resolver. Until N-1 these two fields were read here and set by **no caller**, so
      // the refusal `insertChargingStop` printed described an attempt nobody had made.
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
 * The agent snapshot as §7.5 reads it: the loaded row plus §6.4's `wait_until_available`,
 * written onto the field F19 actually reads.
 *
 * ── One field, from a value the assembly already computes ──────────────────
 * `waitUntilAvailableFor()` returns `0` for an agent the Availability Index files in a
 * ready class, and its own note says why: *"an agent in the Index's ready classes is ready
 * now, which is what those classes mean"*. The expansion's lower bound consumed that and
 * F19 never saw it, so F19 denied on *"the agent's projected availability time"* for an
 * agent this round had already established was free (§M.4).
 *
 * **Only for the ready classes.** `CHARGING_INTERRUPTIBLE` and `FINISHING_SOON` become
 * free at a time only a chaining projection can state, and chaining is Tier 2 — so those
 * keep the field absent and F19 denies, which is the honest answer rather than a
 * projected availability nobody projected.
 *
 * @param {object} agentSnapshot
 * @param {number} decisionTimeMs the round's pinned time — never a clock read
 * @returns {object}
 */
function gatedAgentSnapshot(agentSnapshot, decisionTimeMs) {
  if (!READY_AVAILABILITY_CLASSES.includes(agentSnapshot.availabilityClass)) return agentSnapshot;
  if (!isNumber(decisionTimeMs)) return agentSnapshot;
  return { ...agentSnapshot, projectedAvailableAtMs: decisionTimeMs };
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

  const evaluatePairing = async function evaluatePairing(agentId, legForBound, agentSnapshot) {
    const refuse = (refusal, problems) =>
      Object.freeze({ feasible: false, gammaMilliCU: null, refusal, problems: Object.freeze([...problems]) });

    // Resolved **by Leg**, not from a single slot. A round claims a batch and
    // `solve/round.plan` walks it Leg by Leg, so one slot holds only whichever Leg was
    // expanded last — and `commit` runs after the whole batch is planned, which is where
    // that would have surfaced: as a commitment written against the wrong Leg's row.
    const state = round.legs.get(String(legForBound.legId));
    if (!state) return refuse(REFUSAL.LEG_UNRESOLVED, [`no round state for Leg ${String(legForBound.legId)}`]);

    const { leg, snapshot, scope } = state;

    // The round has now resolved this agent's identifiers to one row — record it before
    // anything keys the memo on either of them.
    rememberAgentIdentity(round.agentIdentity, agentSnapshot);

    /* ── 1. The traversal, through the cell-pair cache ─────────────────────── */
    if (!agentSnapshot.cellId) return refuse(REFUSAL.MISSING_HOP, ["the agent has no resolved origin cell"]);

    const profileKey = round.profileKeyFor(agentSnapshot);
    const traversal = await routing.forPairing(agentSnapshot.cellId, leg.stops, profileKey);
    if (!traversal.ok) return refuse(REFUSAL.MISSING_HOP, traversal.problems);

    /* ── 2. §14.5's return-leg destinations, from the declared estate ──────── */
    //
    // Resolved here rather than inside `planInputFor` because both halves are I/O — a
    // store read and a routing call — and `planBuilder`'s input is built synchronously.
    // The return leg starts where the mission ends, which for this plan is the last stop.
    const lastStop = leg.stops.length > 0 ? leg.stops[leg.stops.length - 1] : null;
    const estate = await chargerCandidatesFor({
      context,
      routing,
      originCell: lastStop ? lastStop.cellId || cellIdFor(lastStop) : null,
      profileKey,
      snapshot,
      scope,
    });
    const pinned = await pinnedChargerProjection(context);

    /* ── 2b. §14.6's target state of charge, from its owner ────────────────── */
    //
    // `energy.target_soc_fallback` is indexed by `agent_class`, so the scope handed to the
    // resolver carries one — the same scoping dimension F17's `capacity` needed (§M.4).
    // The gate builds its own copy of this scope below; both are built from `scope` plus
    // the agent's class rather than one being derived from the other.
    const target = targetSocFor({
      agentSnapshot,
      snapshot,
      scope: { ...scope, agent_class: agentSnapshot.agentClassId ?? null },
      decisionTimeMs: state.decisionTimeMs,
    });

    /* ── 3. The plan (§13) ────────────────────────────────────────────────── */
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
        chargerCandidates: estate.candidates,
        chargerProjection: pinned.projection,
        targetSoc: target.targetSoc,
        targetSocSource: target.targetSocSource,
        // Every hop of this pairing resolved (`traversal.ok`), so every stop is reachable
        // by the routing producer that priced it — F33's `routable` conjunct, observed.
        routable: true,
      }),
    );
    if (!built.ok) {
      // The estate's own refusals travel with the plan's, because *"no plan holds its
      // reserves"* and *"no charger states a cell"* are the same finding at two distances,
      // and a decision record that carried only the first would send a reader to §14.5
      // when the answer is a row nobody has declared.
      return refuse(REFUSAL.PLAN_REFUSED, [...built.problems, ...estate.problems, ...pinned.problems, ...target.problems]);
    }

    /* ── 4. The feasibility gate (§7.1) — the only thing that may brand ────── */
    //
    // The scope carries the agent class as well as the SLA class. `capacity` is an
    // **indexed** parameter — `tv.readIndexedParameter(config, "capacity", classId)` — and
    // a scope without `agent_class` cannot index it, so F17 denied on a parameter that
    // resolves (§M.4). The two scoping dimensions are the ones §22.2 declares; neither is
    // inferred from the other.
    const gateScope = { ...scope, agent_class: agentSnapshot.agentClassId ?? null };
    const legExclusions = legExclusionsFor(
      state.commitments,
      agentSnapshot.agentRowId,
      resolve(snapshot, "dispatch.nack_cooloff", gateScope),
    );
    const mission = round.missionForPlan(state, built.plan);
    const gated = feasibility.gate(built.plan, {
      agentSnapshot: { ...gatedAgentSnapshot(agentSnapshot, state.decisionTimeMs), legExclusions: legExclusions ?? null },
      mission,
      plan: built.plan,
      config: { get: (name) => resolve(snapshot, name, gateScope) },
      decisionTimeMs: state.decisionTimeMs,
      snapshotId: state.snapshotId,
    }, {
      // §7.7's fold at decision time, into the process's aggregator — the one the
      // rejection-aggregation flusher drains to `RejectionAggregate`. Telemetry only:
      // `evaluateCandidate` reads neither field, so the verdict is the same without them.
      aggregator: context.rejectionAggregator || undefined,
      dimensions: {
        shardId: context.shardId ?? null,
        missionClass: mission && mission.missionClass !== undefined ? mission.missionClass : null,
        legPurpose: leg.purpose ?? null,
      },
    });
    if (!gated.feasible) {
      noteRejectionTuples(round, legForBound, gated.tuples);
      return Object.freeze({
        feasible: false,
        gammaMilliCU: null,
        refusal: REFUSAL.INFEASIBLE,
        denials: Object.freeze(gated.outcome.denials.map((row) => row.predicateId)),
        deniedForIndeterminacyOnly: gated.outcome.deniedForIndeterminacyOnly,
      });
    }

    /* ── 5. `γ(c) = Φ(plan(c)) − Φ(plan₀) + C_churn` (§8.1) ────────────────── */
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
      // The Leg as the **solver** names it. `solve/round.plan` partitions and solves over
      // `WorkQueue.legId` — the `Leg.id` row id — and `columnBuilder` builds each column's
      // `legIds` from this field. Under the business `Leg.legId` the one column covered a
      // Leg the partition did not contain, the real Leg was left uncovered, and a round
      // with one Leg and one feasible agent reported LOST_TO_ANOTHER_LEG (measured). The
      // memo stays keyed on the canonical business id; see `round.canonicalLegId`.
      legId: leg.legRowId ?? leg.legId,
      // Carried to §10.3.2 step 3 so the volatile recheck (F20 is volatile) evaluates the
      // same exclusion set and mission this pairing was admitted on.
      legExclusions: legExclusions ?? null,
      mission,
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
    // Keyed on the canonical `Agent.id`, never on whichever name this layer happens to
    // use — `entry.agentId` stays the business identifier because that is what the column,
    // the decision record and the offer read.
    round.priced.set(pricedKey(round.canonicalLegId(entry.legId), round.canonicalAgentId(entry.agentId)), entry);

    return Object.freeze({
      feasible: true,
      gammaMilliCU: priced.gammaMilliCU,
      // §6.6's tie-breaks, read from the state the gate admitted rather than recomputed.
      dutyCycle: agentSnapshot.dutyCycle ?? null,
      healthTier: agentSnapshot.healthTier ?? null,
    });
  };

  // The evaluation above, unchanged, with its outcome noted for the round's decision record.
  // The result is returned as is; the note is observation only.
  return async function evaluateExact(agentId, legForBound, agentSnapshot) {
    const out = await evaluatePairing(agentId, legForBound, agentSnapshot);
    noteCandidateOutcome(round, legForBound, agentId, agentSnapshot, out);
    return out;
  };
}

/**
 * The round's per-Leg outcome entry, created on first use.
 *
 * @param {object} round
 * @param {object} legForBound
 * @returns {object}
 */
function outcomeEntryFor(round, legForBound) {
  const key = String(legForBound.legId);
  let entry = round.outcomes.get(key);
  if (!entry) {
    const state = round.legs.get(key);
    entry = {
      legId: key,
      legRowId: state && state.leg && state.leg.legRowId !== undefined ? String(state.leg.legRowId) : null,
      candidates: new Map(),
      counts: new Map(),
    };
    round.outcomes.set(key, entry);
  }
  return entry;
}

/**
 * Note one candidate's outcome for §21.2's compact top-N: a priced candidate with its γ,
 * a rejected one with **its binding predicate only** — the first gate denial, or, when the
 * pairing never reached the gate, the refusal `evaluateExact` returned (`MISSING_HOP`,
 * `PLAN_REFUSED`, `UNPRICEABLE`, `LEG_UNRESOLVED`). The 38-row evaluation stays in Tier B.
 *
 * @param {object} round
 * @param {object} legForBound
 * @param {string} agentId
 * @param {object} agentSnapshot
 * @param {object} out `evaluateExact`'s result
 */
function noteCandidateOutcome(round, legForBound, agentId, agentSnapshot, out) {
  if (!legForBound || legForBound.legId === undefined || legForBound.legId === null || !out) return;
  const entry = outcomeEntryFor(round, legForBound);
  const id = String((agentSnapshot && agentSnapshot.agentId) || agentId);
  if (out.feasible === true) {
    entry.candidates.set(id, { agentId: id, rejected: false, gammaMilliCU: out.gammaMilliCU ?? null });
    return;
  }
  const binding =
    out.refusal === REFUSAL.INFEASIBLE && Array.isArray(out.denials) && out.denials.length > 0 ? out.denials[0] : out.refusal;
  entry.candidates.set(id, { agentId: id, rejected: true, bindingPredicateId: binding ?? null, gammaMilliCU: null });
}

/**
 * Fold one gate denial's §7.7 tuples into the Leg's per-predicate counts (Tier A's
 * `rejectionSummary`), keyed exactly as the shard aggregate keys them: predicate and tier.
 *
 * @param {object} round
 * @param {object} legForBound
 * @param {object[]} tuples `feasibility.gate`'s tuples
 */
function noteRejectionTuples(round, legForBound, tuples) {
  if (!legForBound || !Array.isArray(tuples)) return;
  const entry = outcomeEntryFor(round, legForBound);
  for (const tuple of tuples) {
    const tier = tuple.tier ?? null;
    const key = `${tuple.predicateId}|${tier === null ? "-" : tier}`;
    const row = entry.counts.get(key) || { predicateId: tuple.predicateId, tier, count: 0 };
    row.count += 1;
    entry.counts.set(key, row);
  }
}

/**
 * The round's `perLeg` context for `decisionRecord.writeRound`: per Leg, the candidate
 * summaries (`candidates`) and the per-predicate rejection counts (`rejectionSummary`).
 * Keyed by both of the Leg's identifiers, because the round's decisions name a Leg by
 * `Leg.id` (the `WorkQueue.legId` row id) while this round state keys the business id.
 *
 * @param {object} round
 * @returns {Record<string, { candidates: object[], rejectionSummary: object[] }>}
 */
function perLegFor(round) {
  const perLeg = {};
  for (const entry of round.outcomes.values()) {
    const context = {
      candidates: [...entry.candidates.values()],
      rejectionSummary: [...entry.counts.values()].map((row) => ({ ...row })),
    };
    perLeg[entry.legId] = context;
    if (entry.legRowId !== null) perLeg[entry.legRowId] = context;
  }
  return perLeg;
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

    // §7.5 F20's input: this Leg's Commitment history, read once per Leg per round.
    const commitments = leg.legRowId
      ? await context.prisma.commitment.findMany({
          where: { legId: leg.legRowId },
          select: { agentId: true, releasedAt: true },
        })
      : [];

    round.rememberLeg({
      leg,
      legForBound,
      commitments,
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
      // As of the round's pinned decision time, so no fact postdates the decision.
      loadAgentSnapshot: (agentId) => loadAgentSnapshot(agentId, { asOfMs: input.decisionTimeMs }),
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
    // `commit.js` hands this the **locked `Agent` row**, whose `.agentId` is the business
    // identifier; the memo is keyed on `Agent.id`. Resolved rather than assumed.
    const legKey = round.canonicalLegId(commitContext.leg.legId);
    const key = pricedKey(legKey, round.canonicalAgentId(commitContext.agent.agentId));
    const entry = round.priced.get(key);
    const state = round.legs.get(legKey);
    if (!entry || !state) {
      // The context is returned deliberately incomplete: `recheck` evaluates each volatile
      // predicate against it and every one of them refuses a context with no plan, so the
      // commit aborts with `VOLATILE_FEASIBILITY_LOST` and the pairing returns to the next
      // round — §10.3.2's own disposition, reached without this adapter deciding anything.
      return { agentSnapshot: null, mission: null, plan: null, config: null, decisionTimeMs: null };
    }
    const agentSnapshot = await round.loadAgentSnapshot(commitContext.agent.agentId, {
      asOfMs: commitContext.storeTime instanceof Date ? commitContext.storeTime.getTime() : state.decisionTimeMs,
    });
    return {
      agentSnapshot: agentSnapshot ? { ...agentSnapshot, legExclusions: entry.legExclusions ?? null } : agentSnapshot,
      mission: entry.mission || round.missionFor(state),
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
    // `assignment.legId` is the solver's — the WorkQueue row's `Leg.id` — so it is resolved
    // to the business id both memos are keyed on (see `round.legIdentity`).
    const legKey = round.canonicalLegId(assignment.legId);
    const entry = round.priced.get(pricedKey(legKey, round.canonicalAgentId(assignment.agentId)));
    const state = round.legs.get(legKey);
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

    // ── The executable geometry, resolved BEFORE the transaction opens ───────
    //
    // §10.3.2's commit is a SERIALIZABLE transaction over rows it has locked. A provider
    // call inside it would hold those locks across an external round trip, so a slow
    // Mapbox response would become a store-wide stall on the decision path. The route is
    // therefore fetched here, in the composition root, and the `sideEffects` writer below
    // closes over the resolved points: the transaction sees data, never a socket.
    //
    // **This changes no assignment.** The agent has already been chosen — by candidate
    // generation, the feasibility gate and the solve — and the geometry describes the
    // journey that choice implies. Nothing here is read by a cost term, and
    // `coordinatorPipeline.requirements()` is untouched: the §5 `route` contract the
    // composition declares is six fields and remains unresolved, so a polyline here is
    // not, and must never be presented as, the missing traversal source.
    //
    // A failure to route attaches nothing. The agent's own `assessExecutability` then
    // refuses the offer by name (`NO_EXECUTABLE_PATH`), which returns the Leg to `QUEUED`
    // and records the reason as a feasibility observation — the correct disposition, and
    // one a fabricated straight line would silently defeat.
    const plannedStops = entry
      ? entry.plan.stops.map((stop) => ({
          sequence: stop.sequence,
          stopType: stop.stopType,
          siteId: stop.siteId ?? null,
          lat: stop.lat ?? null,
          lon: stop.lon ?? null,
          projectedArrivalMs: stop.projectedArrivalMs ?? null,
          departureMs: stop.departureMs ?? null,
        }))
      : [];

    const geometry = await executionGeometry.attachStopPaths({
      from: { lat: agentSnapshot.lat, lon: agentSnapshot.lon },
      stops: plannedStops,
      // Per agent where the composition distinguishes producers: a simulated agent drives
      // the simulator's own geometry, the one its route was priced on.
      directions: isFunction(context.directionsFor) ? context.directionsFor(agentSnapshot) : context.directions,
    });

    if (geometry.unroutable.length > 0) {
      logger.warn(
        `[coordinator] no execution geometry for stop(s) ${geometry.unroutable.join(", ")} of Leg ` +
          `${assignment.legId}; the offer carries none for them and the agent will refuse it by name`,
      );
    }

    // §2.4's customer-visible identifier for the work this Leg discharges. Exactly one, or
    // none: a Leg discharging two Tasks has no single Task to report completion against,
    // and naming an arbitrary one of them would be worse than naming none.
    const taskIds = (state.leg.tasks && state.leg.tasks.taskIds) || [];
    const taskId = taskIds.length === 1 ? taskIds[0] : null;

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
        sideEffects: async (tx, effectContext) => {
          const offerTtlSeconds = resolve(current, "dispatch.offer_ttl", scope);
          const enqueued = await offers.enqueueOffer(tx, {
            commitment: effectContext.commitment,
            // §23.3's addressee: the agent's own identity, not its row id.
            addressee: agentSnapshot.agentId,
            storeTime: effectContext.storeTime,
            offerTtlSeconds,
            signingKey: context.signingKey,
            // P2B-2 — quantised so the numbers signed are the numbers stored and delivered;
            // the Json column shortens doubles and the agent verifies what it receives
            // (`services/storablePrecision.service.js`). Message content only — no decision
            // is re-read from it.
            offer: storablePrecision.toStorablePrecision({
              missionPlan: entry ? entry.plan.planId : null,
              // The plan's stops, each carrying the drivable geometry resolved above.
              // Built outside this closure: `sideEffects` runs inside the SERIALIZABLE
              // transaction and must do no I/O of its own.
              stopSequence: geometry.stops,
              // §2.4's Task, so the agent reports completion against the row that
              // represents the customer's work rather than against a Leg key no legacy
              // consumer can resolve.
              taskId,
              // Absent rather than invented. §5.2's route reference belongs to the routing
              // engine that produced the traversal, and the cell-pair seam carries hops
              // rather than a route identity.
              routeReference: null,
              payloadManifest: (state.leg.manifests || []).map((manifest) => manifest.manifestId ?? manifest.id),
              // §14.6 — the Charging Scheduler's, consumed and never computed here.
              energyReserveParams: entry ? entry.plan.reserves : null,
              targetSoc: entry && entry.plan.charging ? entry.plan.charging.targetSoc : null,
            }),
          });
          // §4.5 — the OFFERED state's deadline, armed in the transaction that enters it.
          // Without it an OFFER that was delivered and never answered held the Leg and the
          // agent's capacity for ever: the outbox expires only *undelivered* rows (measured
          // on the V1 failure run, 2026-09-23 — a silent robot's OFFER was still live ten
          // minutes later). On expiry the timer worker withdraws it (`WITHDRAW_EXCLUDE_REPLAN`).
          await legEntryDeadline.superviseEntry(tx, {
            leg: effectContext.leg,
            state: COMMITTED_LEG_STATE,
            storeTime: effectContext.storeTime,
            deadlineSeconds: offerTtlSeconds,
            event: "ROUND_COMMIT",
            shardId: context.shardId ?? null,
          });
          return enqueued;
        },
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
          expectedLegState: ASSIGNABLE_LEG_STATES.includes(state.leg.state) ? state.leg.state : ASSIGNABLE_LEG_STATES,
        },
        config: {
          capacity: round.capacityFor(agentSnapshot),
          // `lease.duration` (§12.2) — the register's name, and the one
          // `commitment/leases.grant` quotes in its own `RangeError`. Under the old
          // spelling this resolved to `undefined` and `grant()` threw **inside** the
          // serialisable transaction, after step 1's row locks, so the commit failed at
          // its last step rather than being refused at composition time (§M.1, M-3).
          leaseDurationSeconds: resolve(current, "lease.duration", scope),
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
    /**
     * Every identifier this round has resolved for an agent → its `Agent.id`. Written by
     * `evaluateExact` as snapshots load; read wherever the memo is keyed. See
     * `rememberAgentIdentity`.
     */
    agentIdentity: new Map(),
    /**
     * Every identifier this round has resolved for a Leg → its business `Leg.legId`.
     *
     * The same defect `agentIdentity` closes, one entity over — and it was measured, not
     * reasoned about: the V1 trace ran with every input present and ended
     * `LOST_TO_ANOTHER_LEG` with **one Leg and one feasible agent**. `WorkQueue.legId` is
     * the FK to `Leg.id` (the **row** id), so `solve/round.plan` and `commit` name the Leg
     * by row id, while `rememberLeg` and the priced memo key on the business `Leg.legId`.
     * `pricedCandidateFor(agent, rowId)` missed, `round.plan` dropped the candidate
     * silently, and no column ever reached the solve. Resolved here, never guessed: an
     * identifier this round has not loaded maps to itself.
     */
    legIdentity: new Map(),
    /**
     * Business `Leg.legId` → what this round's evaluation of that Leg's candidates found:
     * one row per agent (its binding predicate or refusal when rejected, its γ when priced)
     * and the §7.7 per-predicate counts. `perLegFor` hands it to the round's decision record
     * (`coordinator.worker.recordRound` → `decisionRecord.writeRound`'s `perLeg`). Written
     * by `evaluateExact`; observation only — nothing on the decision path reads it.
     */
    outcomes: new Map(),
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
      const canonical = String(state.leg.legId);
      round.legs.set(canonical, state);
      round.legIdentity.set(canonical, canonical);
      if (state.leg.legRowId !== undefined && state.leg.legRowId !== null) {
        round.legIdentity.set(String(state.leg.legRowId), canonical);
      }
    },

    /** Discard every Leg's state and every priced plan. Called at the round boundary. */
    clear() {
      round.legs.clear();
      round.priced.clear();
      round.agentIdentity.clear();
      round.legIdentity.clear();
      round.outcomes.clear();
    },

    /**
     * The business `Leg.legId` this identifier names, as far as this round has loaded it.
     *
     * @param {string} legId the row id or the business id
     * @returns {string}
     */
    canonicalLegId(legId) {
      const key = String(legId);
      return round.legIdentity.get(key) ?? key;
    },

    /**
     * The `Agent.id` this identifier names, as far as this round has established it.
     * An unresolved identifier maps to itself — never to a guess.
     *
     * @param {string} agentId any of the three identifiers named in `rememberAgentIdentity`
     * @returns {string}
     */
    canonicalAgentId(agentId) {
      const key = String(agentId);
      return round.agentIdentity.get(key) ?? key;
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

    // A composition that routes agents at different speeds keys its cache by what the route
    // depends on (`v1DemonstrationComposition.profileKeyFor`); otherwise the traversal domain.
    profileKeyFor: (agentSnapshot) =>
      (isFunction(enriched.profileKeyFor) ? enriched.profileKeyFor(agentSnapshot) : null) ||
      (agentSnapshot.mobilityModel && agentSnapshot.mobilityModel.traversalDomain) ||
      agentSnapshot.agentClassId,

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
    missionFor: (state) => {
      // A Leg loaded by anything but `legLoaderFor` carries no `tasks` block. Absent
      // rather than empty: `{}` reads through as `undefined` for each attribute, which is
      // what F4, F21 and F25 read as "nobody established this" — never as a permission.
      const tasks = state.leg.tasks || {};
      const mission = {
      legId: state.leg.legId,
      missionId: state.leg.missionId,
      purpose: state.leg.purpose,
      custodyState: state.leg.custodyState,
      slaClass: state.slaClass,
      targetMs: state.leg.targetMs,
      // Carried, and it was not. `Leg.slaDeadline` is set on the row and `legLoaderFor`
      // has always read it, and dropping it here made F37 report *"the task states no
      // deadline; F37 does not bind"* — a contractual deadline that exists, reported as
      // absent, and SATISFIED only because the omission was total (§M.6). F37 now binds
      // and asks its second question, `deadlineIsContractuallyHard`, which **no column in
      // this schema carries**: hardness is a contract term recorded upstream, and F37's
      // own text forbids inferring it here from proximity or SLA-class name. So this moves
      // F37 from a false SATISFIED to an honest INDETERMINATE with a named input.
      deadlineMs: state.leg.deadlineMs,
      // §2.4's Task-carried attributes, agreed across the Mission's Tasks or absent.
      // `Mission` carries none of these columns; `Task` carries all three (§2.8's
      // many-to-many is the join `legLoaderFor` now makes).
      tenantId: tasks.tenantId,
      requirements: tasks.requirements,
      payload: tasks.payload,
      manifests: state.leg.manifests,
      stops: state.leg.stops,
      };
      // The deployment's declared mission profile, filling only what no Task stated (see
      // `services/v1DemonstrationProfile.applyMissionProfile`). Absent, nothing is filled.
      return isFunction(enriched.missionProfileFor) ? enriched.missionProfileFor(mission) : mission;
    },

    /**
     * The mission as the gate reads it for one plan: `missionFor` plus F19's latest
     * feasible start, derived from this plan's duration (`latestFeasibleStartFor`).
     *
     * @param {object} state a `rememberLeg` entry
     * @param {object} plan the candidate plan
     */
    missionForPlan: (state, plan) => {
      const mission = round.missionFor(state);
      if (mission.latestFeasibleStartMs !== undefined && mission.latestFeasibleStartMs !== null) return mission;
      const latest = latestFeasibleStartFor(
        state.leg,
        plan,
        state.decisionTimeMs,
        resolve(round.snapshotFor(), "plan.commitment_horizon", state.scope),
      );
      return latest === undefined ? mission : { ...mission, latestFeasibleStartMs: latest };
    },

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
      round.priced.get(pricedKey(round.canonicalLegId(legId), round.canonicalAgentId(agentId))) || null,
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
    // §21.2 — this round's per-Leg candidate outcomes and rejection counts, for the
    // decision record `coordinator.worker.recordRound` writes after the round.
    perLegFor: () => perLegFor(round),
    // Legs the lifecycle returned to QUEUED go back on the work list (coordinator.worker).
    requeueReturnedLegs: (input) => coordinatorWorker.requeueReturnedLegs({ prisma: enriched.prisma }, input),
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
  ASSIGNABLE_LEG_STATES,
  noteCandidateOutcome,
  noteRejectionTuples,
  perLegFor,
  contextFor,
  delayParametersFrom,
  routingSeamFor,
  agentSnapshotLoaderFor,
  legLoaderFor,
  planInputFor,
  phiInputFor,
  cellIdFor,
  payloadFor,
  taskAttributesFor,
  serviceabilityFor,
  chargerCandidatesFor,
  pinnedChargerProjection,
  publishedTargetSocFrom,
  targetSocFor,
  gatedAgentSnapshot,
  latestFeasibleStartFor,
  legExclusionsFor,
  AGENT_FACT_FIELDS,
  create,
  // Re-exported so a caller that has an assembly can start the worker it was built for
  // without a second require, and so the composition test can assert the two are the same
  // function rather than two things with the same name.
  worker: coordinatorWorker,
};

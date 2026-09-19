"use strict";

/**
 * V1 — the coordinator's solve-path **composition**, and what it does and does not prove.
 *
 * ═══ READ THIS BEFORE QUOTING ANY RESULT IN THIS FILE ═══════════════════════
 *
 * **These are composition and unit tests. None of them is end-to-end evidence.**
 *
 * They prove that the real modules are wired together, that the wiring is reached, and
 * that it fails closed by name when an input is absent. They do **not** prove that a
 * request is assigned, that a commitment is written, or that any priced number is right —
 * and they cannot, because the routing source, the fifteen unresolved register parameters
 * and the four families with no producer do not exist. S-6 remains open and nothing here
 * may be cited against it.
 *
 * ── Where a test double appears, and the rule it is held to ────────────────
 * Three doubles are used, each labelled at every use:
 *
 *   · `declaredRouter()` — a fixed six-field `route(parts)`. It exists so the wiring past
 *     the routing seam can be exercised at all. **Its numbers are not travel times**, no
 *     assertion in this file depends on their values, and it is never presented as a
 *     traversal source.
 *   · `snapshotWith(overrides)` — the **real** `service.defaultSnapshot()` with named
 *     parameters overridden **in that object alone**. Nothing is written to the register,
 *     no default is proposed, and §22.3 reserves every one of those values for §22.4's
 *     calibration owner.
 *
 *   · a `storeWith()` in-memory Prisma double. A double for the **store**, never for an
 *     engine module: every row is in the shape `prisma/schema.prisma` declares and the
 *     assembly's own loaders convert them.
 *
 * One further pair of spies appears in exactly one test — `feasibility.gate` and
 * `column.price`, in *"a plan that builds but cannot be PRICED"* — and that test says in
 * its own body why, and that it is a unit test of one branch.
 *
 * The rule they are all held to is the one that makes the C-group tests meaningful: a
 * double may stand in for a *seam*, never for a *decision*. `evaluateExact` is the real
 * one — `tests/engine/candidatesExpansion.test.js`'s
 * `async (agentId) => ({ feasible: true, gammaMilliCU: 42_000n })` appears nowhere here,
 * because a fake evaluator would make every assertion below vacuous.
 */

const path = require("path");
const fs = require("fs");

const solvePath = require("../../src/workers/coordinatorSolvePath");
const pipeline = require("../../src/workers/coordinatorPipeline");
const leaderWorkers = require("../../src/workers/leaderWorkers");
const coordinatorWorker = require("../../src/workers/coordinator.worker");
const service = require("../../src/engine/config/service");
const cells = require("../../src/engine/spatial/cells");
const availabilityIndex = require("../../src/engine/candidates/availabilityIndex");
const planBuilder = require("../../src/engine/plan/planBuilder");
const consumption = require("../../src/engine/energy/consumption");
const feasibility = require("../../src/engine/feasibility/evaluate");
const columnModel = require("../../src/engine/plan/column");
const { createTestKv } = require("../helpers/testKv");
const energyFixture = require("./helpers/energyFixture");

const SHARD_ID = "shard-composition";
const DECISION_TIME_MS = Date.UTC(2026, 8, 4, 12, 0, 0);
const ORIGIN = { lat: 12.9716, lon: 77.5946 };
const PICKUP = { lat: 12.9724, lon: 77.5951 };
const DROP = { lat: 12.9731, lon: 77.5960 };

/* ═══════════════════════════════════════════════════════════════════════════
   Fixtures. Labelled, bounded, and never presented as production data.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * **TEST DOUBLE — a router-shaped function, not a traversal source.**
 *
 * It answers the six-field §F.2 contract with fixed numbers so that the wiring downstream
 * of `routing/cellPairCache` can be reached. No assertion in this file depends on the
 * values; changing all six would change no expectation. It is not a proposal, a benchmark,
 * or evidence that any engine returns these fields — `travelSdSeconds` and
 * `stopStartCycles` are returned by no shortlisted engine at all (N29, F-6).
 */
function declaredRouter() {
  const calls = [];
  const route = async (parts) => {
    calls.push(parts);
    return { distanceM: 800, travelSeconds: 400, travelSdSeconds: 20, climbM: 6, descentM: 3, stopStartCycles: 4 };
  };
  route.calls = calls;
  return route;
}

/**
 * The **real** configuration snapshot with named parameters overridden in this object only.
 *
 * `omega.combinedCorrection` reads more of a snapshot than `resolve()` does, so a
 * hand-built stand-in that satisfied the probe where a real snapshot would not is exactly
 * the false green this suite exists to prevent.
 */
function snapshotWith(overrides, extras) {
  const real = service.defaultSnapshot();
  const map = overrides || {};
  return Object.assign(Object.create(Object.getPrototypeOf(real)), real, extras || {}, {
    resolve: (name, context, options) =>
      Object.prototype.hasOwnProperty.call(map, name) ? map[name] : real.resolve(name, context, options),
    explain: (name, context, options) => {
      if (!Object.prototype.hasOwnProperty.call(map, name)) return real.explain(name, context, options);
      const explained = real.explain(name, context, options);
      return { ...explained, value: map[name] };
    },
  });
}

/**
 * Every register parameter the contract declares, resolvable.
 *
 * **None of these is a proposed value.** They are the smallest resolvable numbers that let
 * the assembly be exercised, and the whole point of the C-group tests below is what happens
 * when one of them is taken away again.
 *
 * ── Two entries were removed here, and their absence is load-bearing ───────
 * This map used to override `"energy.uncertainty_inflation"` and
 * `"energy.projection_max_age"`. **Neither name exists in the register.** The production
 * code asked for the same two misspellings, so the overrides landed, every test here went
 * green, and §L.9 concluded from that green suite that no composition defect remained —
 * while in production `snapshot.resolve()` answered `undefined` for both, exactly as it
 * does for an unsupplied input, and **no plan was built for any candidate** (§M.1).
 *
 * They are not renamed to the real names either. `energy.variance_inflation` and
 * `energy.charger_projection_max_age` both **resolve on the published register**, so an
 * override would only hide whether the code reads the name that resolves. The G-group test
 * *"both names resolve on the published register"* asserts that directly.
 */
function resolvableRegister(omit) {
  const values = {
    "candidate.max_radius_by_sla_class": 5000,
    "candidate.max_expansion_tiers": 2,
    "candidate.target_feasible": 1,
    "candidate.max_evaluated": 4,
    "plan.service_time_prior": 60,
    "energy.model_residual_cv": 0.1,
    "energy.reserve_floor_wh": 50,
    "energy.contingency_quantile": 0.99,
    "energy.charger_availability_margin": 1.15,
    "energy.uncalibrated_reserve_factor": 1.25,
    "cost.energy.cu_per_wh": 0.5,
    "cost.wear.cu_per_metre": 0.001,
    "cost.failure.cu": 100,
    "cost.staleness.cu_per_second_age": 0.001,
    "cost.energy_consequence": { T1: 10, T2: 100, T3: 1000 },
    "cost.sla.cu_per_second_late": 0.01,
    "cost.sla.breach_penalty": 50,
    "lifecycle.cu_per_actuator_cycle": { LIFT: 0.1, DOOR: 0.05, LATCH: 0.05 },
    "lifecycle.cu_per_braking_event": 0.01,
    "lifecycle.cu_per_gradient_metre": 0.002,
    "lifecycle.cu_per_thermal_stress_second": 0.0001,
    "cost.battery.cu_per_equivalent_cycle": 40,
  };
  if (omit) delete values[omit];
  return values;
}

/** An `EnergyModelParams` row, in the Prisma column spelling the mapper converts from. */
function energyModelParamsRow() {
  const fitted = energyFixture.energyModelParams();
  return {
    modelVersion: 1,
    betaDist: fitted[consumption.COEFFICIENT.DIST],
    betaMass: fitted[consumption.COEFFICIENT.MASS],
    betaClimb: fitted[consumption.COEFFICIENT.CLIMB],
    betaRegen: fitted[consumption.COEFFICIENT.REGEN],
    betaMoveTime: fitted[consumption.COEFFICIENT.MOVE_TIME],
    betaStopStart: fitted[consumption.COEFFICIENT.STOP_START],
    betaDwell: fitted[consumption.COEFFICIENT.DWELL],
    betaAux: fitted[consumption.COEFFICIENT.AUX],
    betaThermal: fitted[consumption.COEFFICIENT.THERMAL],
    betaPayloadThermal: fitted[consumption.COEFFICIENT.PAYLOAD_THERMAL],
    etaRegen: fitted[consumption.COEFFICIENT.REGEN_EFFICIENCY],
  };
}

/**
 * An in-memory stand-in for the three Prisma reads the assembly makes.
 *
 * A double for the **store**, not for any engine module: every row below is in the shape
 * `prisma/schema.prisma` declares, and the assembly's own loaders convert them. Nothing
 * here decides anything.
 */
function storeWith(options) {
  const settings = options || {};
  const fineCellId = cells.cellForPoint(ORIGIN.lat, ORIGIN.lon, cells.RESOLUTION.FINE);

  const agentClass = {
    classId: "class-composition",
    mobilityModel: { kinematicLimits: { maxSpeedMs: 2 }, traversalDomain: "GROUND" },
    energyModel: {
      packNominalWh: 1000,
      chargePowerCurve: energyFixture.chargePowerCurve(),
      thermalDeratingCurve: energyFixture.thermalDeratingCurve(),
    },
    containerModel: settings.containerModel === undefined ? null : settings.containerModel,
    capabilityBundle: null,
    energyModelParams: settings.omitEnergyParams ? [] : [energyModelParamsRow()],
  };

  const agent = {
    id: "agent-row-1",
    agentId: "agent-1",
    lifecycleState: "ACTIVE",
    authorityEpoch: 3n,
    fenceCounter: 7n,
    capacityOverride: null,
    tenantId: "tenant-a",
    fleetId: null,
    regionId: null,
    homeDepotId: null,
    agentClass,
    batteryState: settings.omitBattery
      ? null
      : { kappa: 1, lastObservedSoc: 0.9, soh: 0.95, kappaSampleCount: 10, kappaUpdatedAt: new Date(DECISION_TIME_MS) },
    commitments: [],
  };

  const position = {
    agentId: agent.id,
    shardId: SHARD_ID,
    lat: ORIGIN.lat,
    lon: ORIGIN.lon,
    fineCellId,
    coarseCellId: cells.coarseParentOf(fineCellId),
    availabilityClass: "IDLE_READY",
    capabilityClasses: [],
    containerClasses: [],
    observedAtMs: BigInt(DECISION_TIME_MS),
    agent,
  };

  const leg = {
    id: "leg-row-1",
    legId: "leg-1",
    missionId: "mission-row-1",
    purpose: "PRIMARY",
    state: "QUEUED",
    custodyState: "NONE",
    version: 0,
    cancelRequestedAt: null,
    obstructionClass: null,
    slaDeadline: new Date(DECISION_TIME_MS + 3_600_000),
    startNotBefore: null,
    createdAt: new Date(DECISION_TIME_MS - 60_000),
    manifests: [],
    mission: { missionId: "mission-1", legs: [{ id: "leg-row-1", sequence: 1 }] },
    stops: [
      { stopId: "stop-1", sequence: 1, stopType: "PICKUP", siteId: "site-a", lat: PICKUP.lat, lon: PICKUP.lon },
      { stopId: "stop-2", sequence: 2, stopType: "DROP", siteId: "site-b", lat: DROP.lat, lon: DROP.lon },
    ],
  };

  // A second Leg, for the batch case. §9.2's round claims a *batch*, and a fixture with one
  // Leg in it cannot tell a per-Leg memo from a single "current Leg" slot.
  const secondLeg = {
    ...leg,
    id: "leg-row-2",
    legId: "leg-2",
    version: 4,
    state: "QUEUED",
    stops: leg.stops.map((stop) => ({ ...stop, stopId: `${stop.stopId}-b` })),
  };
  const legsById = new Map([
    [leg.legId, leg],
    [leg.id, leg],
    [secondLeg.legId, secondLeg],
    [secondLeg.id, secondLeg],
  ]);

  // The declared charger estate, as `Charger` rows. **Empty by default**, because an
  // empty estate is what this deployment actually has (`RD-2026-08-30-01`) and because
  // §M.3's whole finding is what an empty one does to F34 and F35. A test that wants a
  // charger declares one and says so.
  const chargers = settings.chargers || [];
  const projections = settings.projections || [];

  return {
    fineCellId,
    dropCellId: cells.cellForPoint(DROP.lat, DROP.lon, cells.RESOLUTION.FINE),
    agent,
    leg,
    secondLeg,
    prisma: {
      leg: {
        findFirst: async (query) => {
          if (settings.omitLeg) return null;
          const wanted = ((query && query.where && query.where.OR) || []).map((row) => row.legId || row.id)[0];
          return legsById.get(wanted) || null;
        },
      },
      agentCellPosition: {
        findFirst: async () => (settings.omitAgent ? null : position),
        findMany: async () => (settings.omitAgent ? [] : [position]),
      },
      charger: {
        findMany: async () => chargers.map((row) => ({ ...row })),
      },
      chargerAvailabilityProjection: {
        findFirst: async () => {
          if (projections.length === 0) return null;
          return [...projections].sort((a, b) => b.version - a.version)[0];
        },
      },
    },
  };
}

/**
 * A composition context in which every declared input resolves.
 *
 * Assembled from the doubles above. Its purpose is to make the wiring *reachable*, never
 * to stand in for the world: `create()` against the published register and no router is the
 * production case, and the B-group tests below are the ones that describe it.
 */
function completeContext(overrides) {
  const settings = overrides || {};
  const store = storeWith({ ...(settings.store || {}), chargers: settings.chargers, projections: settings.projections });
  return {
    store,
    context: {
      snapshot: snapshotWith(resolvableRegister(settings.omitParameter), { spatial: settings.spatial || null }),
      prisma: store.prisma,
      kv: settings.kv,
      shardId: SHARD_ID,
      regionId: "region-1",
      instanceId: "instance-1",
      route: settings.route === undefined ? declaredRouter() : settings.route,
      travelTimeSpread: { source: "TEST DOUBLE — declared for this composition test only" },
      speedMetresPerSecondFor: () => 2,
      hopTerrainSource: { source: "TEST DOUBLE — declared for this composition test only" },
      timeBucket: "test-bucket",
      environmentFor: () => ({ ambientC: 20, packC: 22 }),
      vehicleMassKgFor: () => 60,
      // **TEST DOUBLE — not a fleet measurement.** §14.5's return leg is priced at the
      // profile's marginal Wh per metre, which `chargerReachabilityCache.buildEntry` asks
      // its caller for and which no register entry and no column carries. No assertion in
      // this file depends on the number.
      returnLegEnergyWhPerMetreFor: () => 0.05,
      failureProbabilityFor: () => ({ probability: 0.01, provenance: "TEST DOUBLE — no producer exists" }),
      routeHazardCuFor: () => 0,
      batteryWearInputsFor: () => ({
        socThroughput: 0.2,
        curves: energyFixture.stressCurves(),
        conditions: { dod: 0.2, socMid: 0.8, tempC: 22, cRate: 0.5 },
      }),
      runSerializable: settings.runSerializable || (async (client, fn) => fn(client)),
      selectForUpdate: async () => null,
      signingKey: "test-only-signing-key",
      values: new Map(),
      record: () => {},
      ...(settings.context || {}),
    },
  };
}

let kvHandle;
beforeAll(async () => {
  kvHandle = await createTestKv();
});
afterAll(async () => {
  if (kvHandle && kvHandle.close) await kvHandle.close();
});

/* ═══════════════════════════════════════════════════════════════════════════
   A — THE COMPOSITION TEST

   That the real modules are injected, asserted by *behaviour reaching them* rather
   than by any object being non-null. A non-null assertion would have passed against
   every one of the six passes in which this assembly did not exist.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("A — the composition constructs the real coordinator solve path", () => {
  test("`create()` returns the five collaborators `coordinator.worker.runRound` destructures", () => {
    const { context } = completeContext({ kv: kvHandle.kv });
    const assembly = solvePath.create(context);

    expect(assembly.ok).toBe(true);
    for (const name of ["expandCandidates", "pricedCandidateFor", "expansionInputFor", "commit", "planState"]) {
      expect({ name, present: assembly.deps[name] !== undefined && assembly.deps[name] !== null }).toEqual({
        name,
        present: true,
      });
    }
    // `planState` is a real `shard/planState.js` instance, not a placeholder: it refuses an
    // agent whose capacity this round has not declared, which is §2.6's own accounting and
    // the thing a stub returning `{ ok: true }` would not do.
    const refused = assembly.deps.planState.reserve({ legId: "l", agentId: "a" });
    expect(refused).toEqual(expect.objectContaining({ ok: false, refusal: "AGENT_NOT_IN_PLAN_STATE" }));
  });

  test("the REAL `expandCandidates` is injected — it is `candidates/expansion` and behaves like it", async () => {
    const { context } = completeContext({ kv: kvHandle.kv });
    const assembly = solvePath.create(context);

    const outcome = await assembly.deps.expandCandidates({
      legId: "leg-1",
      shardId: SHARD_ID,
      decisionTimeMs: DECISION_TIME_MS,
      slaClass: null,
      queueAgeSeconds: 60,
    });

    // The shape `expansion.expandCandidates` returns and nothing else does: §6.1's three
    // reported quantities plus §6.4's proven-gap pair. A hand-written stand-in would not
    // carry `achievedGapProven` beside `achievedGapMilliCU`, which is the I20 distinction.
    for (const field of [
      "candidates",
      "bestGammaMilliCU",
      "achievedGapMilliCU",
      "achievedGapProven",
      "unexploredRingDistance",
      "cellsExplored",
      "agentsEvaluated",
      "truncatedBy",
      "problems",
    ]) {
      expect({ field, present: Object.prototype.hasOwnProperty.call(outcome, field) }).toEqual({ field, present: true });
    }
  });

  test("the routing dependency is injected through the cell-pair seam, not imported", async () => {
    const route = declaredRouter();
    const { context } = completeContext({ kv: kvHandle.kv, route });
    const assembly = solvePath.create(context);

    // Put the agent in the live index so the expansion reaches an evaluation at all.
    const store = storeWith();
    await kvHandle.kv.sadd(availabilityIndex.fineKey(SHARD_ID, store.fineCellId, "IDLE_READY"), "agent-row-1");

    await assembly.deps.expandCandidates({
      legId: "leg-1",
      shardId: SHARD_ID,
      decisionTimeMs: DECISION_TIME_MS,
      slaClass: null,
      queueAgeSeconds: 60,
    });

    // The injected function was called, with the §20.3 key components `cellPairCache`
    // builds — which is what "through the seam" means. The assembly never calls a router.
    expect(route.calls.length).toBeGreaterThan(0);
    expect(Object.keys(route.calls[0]).sort()).toEqual(["destCell", "originCell", "profileKey", "timeBucket"]);
    expect(route.calls[0].timeBucket).toBe("test-bucket");
  });

  test("the REAL `evaluateExact` runs — the gate, the Plan Builder and Φ are all reached", async () => {
    const route = declaredRouter();
    // A distinct §20.3 time bucket, so this pairing's cell pairs are a cache **miss** and
    // the router is genuinely consulted. Reusing the previous test's bucket would hit the
    // cache the previous test populated — correct behaviour, and it would make this
    // assertion prove nothing.
    const { context, store } = completeContext({ kv: kvHandle.kv, route, context: { timeBucket: "test-bucket-miss" } });
    const assembly = solvePath.create(context);
    await kvHandle.kv.sadd(availabilityIndex.fineKey(SHARD_ID, store.fineCellId, "IDLE_READY"), "agent-row-1");

    const outcome = await assembly.deps.expandCandidates({
      legId: "leg-1",
      shardId: SHARD_ID,
      decisionTimeMs: DECISION_TIME_MS,
      slaClass: null,
      queueAgeSeconds: 60,
    });

    // The agent was reached and exactly evaluated. Whether it survived is a *decision* this
    // test does not assert — the point is that a real evaluation happened, which is what
    // `agentsEvaluated` counts and what no earlier state of this repository could produce.
    expect(outcome.agentsEvaluated).toBeGreaterThan(0);
    expect(route.calls.length).toBeGreaterThan(0);
  });

  test("`pricedCandidateFor` returns the memoised entry `columnBuilder.build` consumes", () => {
    const { context } = completeContext({ kv: kvHandle.kv });
    const assembly = solvePath.create(context);

    // Nothing evaluated yet, so nothing is priced. `null` — never a fabricated entry — is
    // what `round.plan` skips with `if (!entry) continue`.
    expect(assembly.deps.pricedCandidateFor("agent-1", "leg-1", {})).toBeNull();
  });

  test("`commit` is built here and reaches §10.3.2's transaction seam", async () => {
    let opened = 0;
    const { context, store } = completeContext({
      kv: kvHandle.kv,
      runSerializable: async (client, fn) => {
        opened += 1;
        return fn({
          commitment: { findUnique: async () => null },
          agent: { findFirst: async () => null },
          leg: { findFirst: async () => null },
        });
      },
    });
    const assembly = solvePath.create(context);

    // The Leg has to be loaded before a commit can name its row id, exactly as a round
    // would: `expandCandidates` is what loads it.
    await assembly.deps.expandCandidates({ legId: "leg-1", shardId: SHARD_ID, decisionTimeMs: DECISION_TIME_MS, queueAgeSeconds: 60 });

    const outcome = await assembly.deps.commit(
      { legId: store.leg.legId, agentId: store.agent.agentId },
      { roundId: "round-1", leadershipFence: 1 },
    );

    // The real `commitment/commit.js` ran: it opened the serialisable transaction and
    // aborted on step 1's row lock returning nothing. An abort is the correct outcome for a
    // store with no rows, and it is produced by the shipped guards, not by this assembly.
    expect(opened).toBe(1);
    expect(outcome.committed).toBe(false);
    expect(outcome.outcome).toBe("ABORTED");
  });

  test("the composer starts the worker it assembled — one coordinator, from this module", () => {
    const { context } = completeContext({ kv: kvHandle.kv });
    const outcome = leaderWorkers.COMPOSERS.coordinator(context);

    expect(outcome.ok).toBe(true);
    expect(typeof outcome.handle.stop).toBe("function");
    outcome.handle.stop();
    // The assembly hands back the same worker module the registry declares, so a future
    // refactor cannot leave the composer starting something else with the same name.
    expect(solvePath.worker).toBe(coordinatorWorker);
  });

  /**
   * A defect found in this assembly while writing it, fixed, and pinned here.
   *
   * The first draft held the round's per-Leg state — the Leg row, its version, its
   * manifests, its Ω correction — in **one slot**, overwritten by each `expandCandidates`
   * call. That is correct for a batch of one and silently wrong for a batch of two:
   * `solve/round.plan` expands and prices Leg by Leg, and `round.execute` commits every
   * assignment **after** the whole batch is planned, so every commit would have named the
   * last-expanded Leg's row id, version and expected state.
   *
   * It would have written a real commitment against the wrong Leg and reported success —
   * the class of defect that a green single-Leg suite cannot see, which is why the fixture
   * above carries a second Leg and why this is a test rather than a comment.
   */
  test("a two-Leg batch keeps each Leg's state apart — one slot would not", async () => {
    const { context, store } = completeContext({ kv: kvHandle.kv, context: { timeBucket: "batch-bucket" } });
    const assembly = solvePath.create(context);
    await kvHandle.kv.sadd(availabilityIndex.fineKey(SHARD_ID, store.fineCellId, "IDLE_READY"), "agent-row-1");

    // A batch: both Legs expanded before either is committed, exactly as `round.plan` does.
    for (const legId of ["leg-1", "leg-2"]) {
      // eslint-disable-next-line no-await-in-loop
      await assembly.deps.expandCandidates({
        legId,
        shardId: SHARD_ID,
        decisionTimeMs: DECISION_TIME_MS,
        slaClass: null,
        queueAgeSeconds: 60,
      });
    }

    expect([...assembly.round.legs.keys()].sort()).toEqual(["leg-1", "leg-2"]);
    // The two Legs carry different row ids and different versions, and a commit for each
    // must reach for its own. Under the one-slot draft both of these read `leg-2`'s.
    expect(assembly.round.legs.get("leg-1").leg.legRowId).toBe("leg-row-1");
    expect(assembly.round.legs.get("leg-1").leg.version).toBe(store.leg.version);
    expect(assembly.round.legs.get("leg-2").leg.legRowId).toBe("leg-row-2");
    expect(assembly.round.legs.get("leg-2").leg.version).toBe(store.secondLeg.version);
  });

  test("a commit for a Leg this round never planned is refused, not reconstructed", async () => {
    const { context } = completeContext({ kv: kvHandle.kv });
    const assembly = solvePath.create(context);

    const outcome = await assembly.deps.commit({ legId: "never-planned", agentId: "agent-1" }, { roundId: "r" });

    // Refused rather than re-read: the only way here is a defect, and a defect that re-read
    // the Leg would commit against a version no guard was fenced on.
    expect(outcome.committed).toBe(false);
    expect(outcome.reason).toBe("ROUND_STATE_MISSING");
    expect(outcome.detail).toMatch(/nothing was written/);
  });

  test("`planState.beginRound` clears the pinned plans — §9.6's round boundary", async () => {
    const { context, store } = completeContext({ kv: kvHandle.kv, context: { timeBucket: "boundary-bucket" } });
    const assembly = solvePath.create(context);
    await kvHandle.kv.sadd(availabilityIndex.fineKey(SHARD_ID, store.fineCellId, "IDLE_READY"), "agent-row-1");

    await assembly.deps.expandCandidates({ legId: "leg-1", shardId: SHARD_ID, decisionTimeMs: DECISION_TIME_MS, queueAgeSeconds: 60 });
    expect(assembly.round.legs.size).toBe(1);

    // The signal `coordinator.worker.runRound` already sends, once per round. A plan pinned
    // to one decision time and configuration version must not be priced into another
    // (§9.6 requirements 4–5).
    assembly.deps.planState.beginRound("round-2");
    expect(assembly.round.legs.size).toBe(0);
    expect(assembly.round.priced.size).toBe(0);
  });

  test("`server.js` still passes the pinned snapshot — E-8b must not regress", () => {
    // A source pin, because no unit test boots `server.js`. Phase 15's repeated finding is
    // that a producer exists and the composition root does not use it, and E-8b was that
    // finding at the snapshot. The three seams the commit is built from are pinned beside
    // it for the same reason.
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "server.js"), "utf8");
    expect(source).toMatch(/snapshot:\s*\(\)\s*=>\s*app\.locals\.config,/u);
    expect(source).toMatch(/values:\s*\(\)\s*=>\s*app\.locals\.config\s*&&\s*app\.locals\.config\.values,/u);
    for (const seam of ["runSerializable,", "selectForUpdate,", "isSerializationFailure,"]) {
      expect(source.includes(seam)).toBe(true);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   B — THE MISSING-ROUTING TEST

   Without a routing source: no assembly, no assignment, no commitment, and a
   failure that names the missing routing dependency.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("B — without a routing source the composition fails closed", () => {
  test("`create()` builds NOTHING, and the refusal names `route`", () => {
    const { context } = completeContext({ kv: kvHandle.kv, route: undefined, context: { route: undefined } });
    const assembly = solvePath.create({ ...context, route: undefined });

    expect(assembly.ok).toBe(false);
    expect(assembly.deps).toBeUndefined();
    expect(assembly.refusal).toBe(solvePath.REFUSAL.REQUIREMENTS_UNRESOLVED);
    expect(assembly.missing.map((row) => row.input)).toContain("route");
    const routing = assembly.missing.find((row) => row.input === "route");
    expect(routing.class).toBe(pipeline.REQUIREMENT_CLASS.EXTERNAL_ROUTING);
    expect(assembly.blockedBy).toMatch(/EXTERNAL_ROUTING/);
  });

  test("the composer refuses and starts no worker, so no round can run at all", () => {
    const { context } = completeContext({ kv: kvHandle.kv });
    const outcome = leaderWorkers.COMPOSERS.coordinator({ ...context, route: undefined });

    expect(outcome.ok).toBe(false);
    expect(outcome.handle).toBeUndefined();
    expect(outcome.missing.map((row) => row.input)).toContain("route");
  });

  test("no commitment is reachable, because there is no `commit` to call", () => {
    const assembly = solvePath.create({ ...completeContext({ kv: kvHandle.kv }).context, route: undefined });
    // The strongest statement available: not "commit refuses" but "commit does not exist".
    // A pipeline that assembled and then declined would have a path to a durable write;
    // this one has none.
    expect(assembly.deps).toBeUndefined();
  });

  test("on the published register, with no router, the production case refuses", () => {
    const assembly = solvePath.create({
      snapshot: service.defaultSnapshot(),
      prisma: {},
      kv: {},
      shardId: SHARD_ID,
      runSerializable: async () => null,
      selectForUpdate: async () => null,
      signingKey: "k",
    });

    expect(assembly.ok).toBe(false);
    // Every class that is genuinely blocked is represented. The count is not asserted: it
    // is a measurement, and pinning it here would make this suite the place a future
    // correction has to be argued rather than recorded.
    expect(Object.keys(assembly.missingByClass).sort()).toEqual([
      "EXTERNAL_ROUTING",
      "NO_PRODUCER",
      "REGISTER_UNRESOLVED",
    ]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   C — THE MISSING-ENERGY-INPUT TEST

   The REAL plan and evaluation path, with one required physical input removed.
   Proves the refusal, proves nothing is substituted, and proves no commitment.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("C — the real plan path refuses an absent physical input", () => {
  /**
   * Drive `planBuilder.build` through the assembly's own `planInputFor`, so the input under
   * test is the one production would build — not a fixture shaped to fail.
   */
  function planFor(overrides) {
    const settings = overrides || {};
    const { context, store } = completeContext({ kv: kvHandle.kv, omitParameter: settings.omitParameter });
    const snapshot = context.snapshot;

    const agentSnapshot = {
      agentId: "agent-1",
      agentClassId: "class-composition",
      tenantId: "tenant-a",
      lat: ORIGIN.lat,
      lon: ORIGIN.lon,
      cellId: store.fineCellId,
      energyModel: store.agent.agentClass.energyModel,
      energyCoefficients: settings.omitCoefficients
        ? null
        : require("../../src/engine/domain/mappers/decisionInputs").energyCoefficientsFrom(energyModelParamsRow()),
      kappa: 1,
      soc: 0.9,
      soh: 0.95,
      containerModel: null,
      ambientC: settings.omitEnvironment ? null : 20,
      packC: settings.omitEnvironment ? null : 22,
    };

    const leg = {
      legId: "leg-1",
      missionId: "mission-1",
      role: "TERMINAL",
      custodyState: "NONE",
      targetMs: DECISION_TIME_MS + 3_600_000,
      deadlineMs: DECISION_TIME_MS + 3_600_000,
      stops: store.leg.stops.map((stop) => ({ ...stop, cellId: solvePath.cellIdFor(stop) })),
    };

    const hops = [1, 2].map(() => ({
      distanceM: 800,
      travelSeconds: 400,
      travelSdSeconds: 20,
      climbM: settings.omitTerrain ? null : 6,
      descentM: settings.omitTerrain ? null : 3,
      stopStartCycles: settings.omitTerrain ? null : 4,
    }));

    return planBuilder.build(
      solvePath.planInputFor({
        agentSnapshot,
        leg,
        hops,
        hopsForSequence: () => hops,
        snapshot,
        scope: { sla_class: null },
        decisionTimeMs: DECISION_TIME_MS,
        seams: {
          ...context,
          vehicleMassKgFor: settings.omitMass ? undefined : context.vehicleMassKgFor,
        },
        slaClass: null,
        queueAgeSeconds: 60,
      }),
    );
  }

  test("with every input present the REAL Plan Builder produces a plan — the baseline", () => {
    // Without this row the refusals below would be unattributable: a path that refuses
    // everything refuses nothing in particular.
    const built = planFor();
    expect(built.ok).toBe(true);
    expect(built.plan).not.toBeNull();
    expect(built.plan.stops.length).toBe(2);
  });

  /**
   * A finding, recorded as a test rather than as a sentence.
   *
   * §F.0 classed `charging.chargerCandidates` as *"RESIDUAL for V1 — empty is survivable"*,
   * on the grounds that `NO_FEASIBLE_INSERTION` is a priced result rather than a crash.
   * That is true and it is not the whole consequence. With **no charger estate declared**,
   * `energy/eReturn.evaluate` resolves no return leg, `reserves.compose` refuses — §14.5
   * calls a zero return reserve *"a reachability question nobody answered"* — and therefore
   * **no plan holds its reserves**, for any agent, at any state of charge.
   *
   * So an empty charger estate is survivable in the sense that the engine keeps running and
   * keeps saying why. It is not survivable in the sense of producing an assignment.
   */
  test("with no charger estate declared, NO plan holds its reserves — §14.5, not a crash", () => {
    const built = planFor();

    expect(built.charging).toBe(planBuilder.CHARGING.NO_FEASIBLE_INSERTION);
    expect(built.plan.reserves).toBeNull();
    expect(built.plan.reserveFloorWh).toBeNull();
    // The plan is still produced with its shortfall visible, which is §13.4's division of
    // labour: the Plan Builder does not refuse, F34 decides.
    expect(built.problems.join(" ")).toMatch(/reserve shortfall visible and the gate decides/);
  });

  test("omitting `energy.model_residual_cv` refuses with MISSING_ENERGY_INPUT", () => {
    const built = planFor({ omitParameter: "energy.model_residual_cv" });

    expect(built.ok).toBe(false);
    expect(built.plan).toBeNull();
    expect(built.problems[0]).toBe(planBuilder.FAILURE.MISSING_ENERGY_INPUT);
    // The refusal names the input, so a reader is sent to §22.4's calibration owner rather
    // than to a layer.
    expect(built.problems.join(" ")).toMatch(/residual/i);
  });

  test("omitting `energy.reserve_floor_wh` leaves it absent — never a floor of zero", () => {
    // §14.5's first layer is Safety-class and `required: true` with no default. What must
    // never happen is a reserve floor of zero standing in for one nobody set: zero is the
    // *weakest* possible floor, so a coerced one would admit exactly the missions §14.5
    // exists to refuse.
    const { context } = completeContext({ kv: kvHandle.kv, omitParameter: "energy.reserve_floor_wh" });
    const input = solvePath.planInputFor({
      agentSnapshot: { agentId: "a", agentClassId: "c", ambientC: 20, packC: 22, soc: 0.9, soh: 0.95, kappa: 1, energyModel: null, energyCoefficients: null, containerModel: null },
      leg: { legId: "leg-1", stops: [], role: "TERMINAL", targetMs: null, deadlineMs: null, custodyState: "NONE" },
      hops: [],
      hopsForSequence: () => null,
      snapshot: context.snapshot,
      scope: {},
      decisionTimeMs: DECISION_TIME_MS,
      seams: context,
      slaClass: null,
      queueAgeSeconds: 60,
    });

    expect(input.energy.floorWh).toBeNull();
    expect(input.energy.floorWh).not.toBe(0);
  });

  test("omitting the ambient and pack temperatures refuses — no assumed ambient", () => {
    const built = planFor({ omitEnvironment: true });

    expect(built.ok).toBe(false);
    expect(built.problems.join(" ")).toMatch(/ambientC|packC/);
    // The specific thing E-8 established: an absent temperature is not a room-temperature
    // one. If this ever passes with a plan, a default has been introduced upstream.
    expect(built.plan).toBeNull();
  });

  test("omitting the vehicle mass refuses — a limit is not a mass", () => {
    const built = planFor({ omitMass: true });

    expect(built.ok).toBe(false);
    expect(built.problems.join(" ")).toMatch(/vehicleMassKg/);
  });

  test("omitting hop terrain refuses with MISSING_TERRAIN — E-8's guard, reached through the composition", () => {
    const built = planFor({ omitTerrain: true });

    expect(built.ok).toBe(false);
    // Refused at `timeline.project`, which is one layer *earlier* than `legProfiles` —
    // E-8's stated enforcement point: terrain is a decision-path requirement and is refused
    // before any plan is built or priced, so the marker is the hop failure and the detail
    // names all three fields.
    expect(built.problems[0]).toBe(planBuilder.FAILURE.MISSING_HOP);
    expect(built.problems.join(" ")).toMatch(/climbM, descentM, stopStartCycles/);
    expect(built.problems.join(" ")).toMatch(/understates mission energy/);
  });

  test("no fabricated physical value is substituted anywhere in the composed input", () => {
    // The assembly's own input, inspected directly. Every absent seam must arrive at
    // `planBuilder` as absent — an assembly that filled one in would make each refusal above
    // unreachable, which is exactly how E-8's coercion hid `REQUIRED_PROFILE_FIELDS`.
    const { context, store } = completeContext({ kv: kvHandle.kv });
    const input = solvePath.planInputFor({
      agentSnapshot: { agentId: "a", agentClassId: "c", cellId: store.fineCellId, ambientC: null, packC: null, soc: null, soh: null, kappa: null, energyModel: null, energyCoefficients: null, containerModel: null },
      leg: { legId: "leg-1", stops: [], role: "TERMINAL", targetMs: null, deadlineMs: null, custodyState: "NONE" },
      hops: [],
      hopsForSequence: () => null,
      snapshot: service.defaultSnapshot(),
      scope: {},
      decisionTimeMs: DECISION_TIME_MS,
      seams: { ...context, environmentFor: undefined, vehicleMassKgFor: undefined },
      slaClass: null,
      queueAgeSeconds: null,
    });

    expect(input.environment).toEqual({ ambientC: null, packC: null });
    expect(input.masses.vehicleMassKg).toBeUndefined();
    expect(input.energy.kappa).toBeNull();
    expect(input.energy.model).toBeNull();
    // The three UNCALIBRATED register entries arrive as `null`, not as a chosen number.
    expect(input.energy.residualCv).toBeNull();
    expect(input.energy.floorWh).toBeNull();
    expect(input.serviceTime.priorSeconds).toBeNull();
  });

  /**
   * Added because a mutant survived — recorded as a survival, not presented as a kill.
   *
   * **M14** made `evaluateExact` admit a candidate `column.price` had refused, at
   * `gammaMilliCU: 0n`. It survived the whole suite. Zero is not a neutral placeholder
   * here: it is the *cheapest possible* price, so the unpriceable candidate would win every
   * solve it entered and the round would commit the one pairing it could not price.
   *
   * The gap was in the test, not the code. Every refusal this suite reached happened at
   * `planBuilder.build` — **before** pricing — so the `!priced.ok` branch was never
   * executed. Reaching it needs a plan that builds and a `Φ` that cannot price it, and the
   * seams are where that is reachable: `coordinatorPipeline`'s probe checks that
   * `routeHazardCuFor` **is a function**, which is all a contract can check, and a function
   * that returns nothing usable is a runtime failure by construction.
   *
   * That distinction is worth keeping: a contract-level probe cannot see a seam that
   * answers badly, only one that is absent. This is the layer that catches the other case.
   */
  test("a plan that builds but cannot be PRICED is refused — never admitted at a zero γ", async () => {
    // **A unit test of one branch, with two seams doubled, and it is labelled as such.**
    //
    // The branch is unreachable through the whole pipeline today for the reason the F-group
    // below measures: §7.5's gate denies every candidate at F1, before pricing is
    // attempted. So the gate and the pricer are stood in for — nothing else is — and the
    // assertion is about the assembly's own conduct between them: given a plan the gate
    // admitted and a price the pricer refused, does it decline, or does it invent a number?
    const { context, store } = completeContext({ kv: kvHandle.kv, context: { timeBucket: "unpriceable-bucket" } });
    const assembly = solvePath.create(context);
    await kvHandle.kv.sadd(availabilityIndex.fineKey(SHARD_ID, store.fineCellId, "IDLE_READY"), "agent-row-1");

    const gate = jest.spyOn(feasibility, "gate").mockImplementation((candidate) => ({
      feasible: true,
      candidate,
      outcome: { denials: [], deniedForIndeterminacyOnly: false, penaltyMilliCu: 0, envelopeReduced: false, evaluated: [] },
      tuples: [],
    }));
    const price = jest.spyOn(columnModel, "price").mockReturnValue({
      ok: false,
      gammaMilliCU: null,
      breakdown: null,
      omittedTerms: [],
      missing: ["Φ(plan(c)): cost.wear.cu_per_metre"],
      problems: [],
    });

    try {
      const outcome = await assembly.deps.expandCandidates({
        legId: "leg-1",
        shardId: SHARD_ID,
        decisionTimeMs: DECISION_TIME_MS,
        slaClass: null,
        queueAgeSeconds: 60,
      });

      // Both doubles were genuinely reached, so the branch under test actually ran.
      expect(gate).toHaveBeenCalled();
      expect(price).toHaveBeenCalled();

      // And the refused price produced no candidate. Zero would not be a neutral
      // placeholder here: it is the *cheapest possible* price, so an unpriceable candidate
      // admitted at zero wins every solve it enters and the round commits the one pairing
      // it could not price.
      expect(outcome.candidates).toEqual([]);
      expect(assembly.deps.pricedCandidateFor("agent-1", "leg-1", {})).toBeNull();
      // Nothing was priced, so there is no `C*` and no gap may be claimed (I20).
      expect(outcome.bestGammaMilliCU).toBeNull();
      expect(outcome.achievedGapMilliCU).toBeNull();
      expect(outcome.achievedGapProven).toBe(false);
    } finally {
      gate.mockRestore();
      price.mockRestore();
    }
  });

  test("a refused evaluation produces no priced candidate, so nothing can be committed", async () => {
    // The gap here is a **data** gap rather than a contract gap: the agent class has no
    // fitted `EnergyModelParams` row, which `create()`'s probe cannot see because it is a
    // property of one agent rather than of the deployment. So the assembly is built, the
    // expansion runs, and the refusal happens where it must — inside the real evaluation,
    // per candidate. That is the case a contract-level check could never cover.
    const { context, store } = completeContext({
      kv: kvHandle.kv,
      store: { omitEnergyParams: true },
    });
    const assembly = solvePath.create(context);
    await kvHandle.kv.sadd(availabilityIndex.fineKey(SHARD_ID, store.fineCellId, "IDLE_READY"), "agent-row-1");

    const outcome = await assembly.deps.expandCandidates({
      legId: "leg-1",
      shardId: SHARD_ID,
      decisionTimeMs: DECISION_TIME_MS,
      slaClass: null,
      queueAgeSeconds: 60,
    });

    // The agent was evaluated and produced no candidate — which is the whole chain holding:
    // `buildVariant` refused, `evaluateExact` returned `feasible: false` with a null price,
    // and `expansion` excluded it from the ordered set.
    expect(outcome.candidates).toEqual([]);
    expect(assembly.deps.pricedCandidateFor("agent-1", "leg-1", {})).toBeNull();
    // I20: nothing was priced, so there is no `C*` and no gap may be claimed.
    expect(outcome.achievedGapMilliCU).toBeNull();
    expect(outcome.achievedGapProven).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   D — REAL COMPONENT CONTRACT TESTS

   The assembly's own adapters, exercised against the real register and the real
   modules they feed.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("D — the assembly's adapters, against the real register", () => {
  test("`delayParametersFrom` refuses on the published register and names every absent rate", () => {
    const result = solvePath.delayParametersFrom(service.defaultSnapshot(), {});

    expect(result.ok).toBe(false);
    expect(result.parameters).toBeNull();
    expect(result.missing).toEqual(
      expect.arrayContaining(["cost.sla.cu_per_second_late", "cost.sla.breach_penalty"]),
    );
  });

  test("`delayParametersFrom` substitutes nothing — an absent rate is never a zero one", () => {
    // The distinction this reader exists for. `diagnostics.controller` coalesces the same
    // names to neutral values, which is admissible for a *lower bound* and inadmissible for
    // the exact price a commitment is taken on: a zeroed SLA rate prices a late completion
    // identically to a punctual one.
    const partial = snapshotWith({ "cost.sla.cu_per_second_late": 0.01 });
    const result = solvePath.delayParametersFrom(partial, {});

    expect(result.ok).toBe(false);
    expect(result.missing).not.toContain("cost.sla.cu_per_second_late");
    expect(result.missing).toContain("cost.sla.breach_penalty");
  });

  test("`contextFor` resolves §6.3's wall-clock half from `solve.time_budget`", () => {
    // The E-8 classification, measured rather than argued: the composed path supplies the
    // clock bound, so `expandCandidates` does not refuse `unbounded_search_refused` for the
    // want of a radius. `solve.time_budget` is registered and resolves on the published
    // register — no override is used here.
    const enriched = solvePath.contextFor({ snapshot: service.defaultSnapshot() });
    expect(enriched.expansionWallClockBudgetMs).toBe(250);

    const radiusRow = pipeline.REQUIREMENTS.find((row) => row.id === "candidate.max_radius_by_sla_class");
    expect(radiusRow.probe({ snapshot: service.defaultSnapshot() })).toBe(false);
    expect(radiusRow.probe(enriched)).toBe(true);
  });

  test("the routing seam fails closed with no router, and names the missing source", async () => {
    const seam = solvePath.routingSeamFor({ kv: undefined, route: undefined, snapshot: service.defaultSnapshot() });
    const cellPairCache = require("../../src/engine/routing/cellPairCache");

    const result = await cellPairCache.hopsFor(seam.deps, {
      originCell: "cell-a",
      stops: [{ sequence: 1, cellId: "cell-b" }],
      profileKey: "GROUND",
      timeBucket: "bucket",
      options: seam.optionsFor("GROUND"),
    });

    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/no router is available/);
  });

  /**
   * §15's payload mass — schema-backed, so this repository's to assemble, and §F.0 said so:
   * *"schema-backed (`PayloadSpec`, `massKg`, `massToleranceKg`) — **assembly code
   * absent**"*. It is `payloadFor`.
   */
  test("`payloadFor` prefers an observed mass over a declared one, and sums the manifests", () => {
    const resolved = solvePath.payloadFor({
      manifests: [
        { manifestId: "m1", observedMassKg: 7, declaredMassKg: 5, payloadSpec: { massKg: 3 } },
        { manifestId: "m2", declaredMassKg: 4, payloadSpec: { massKg: 3 } },
        { manifestId: "m3", payloadSpec: { massKg: 2 } },
      ],
    });

    // 7 (weighed) + 4 (declared) + 2 (spec). A weighed mass is a measurement where a
    // declared one is a claim, so the order is stated rather than left to whichever field
    // happened to be non-null.
    expect(resolved.massKg).toBe(13);
    expect(resolved.unresolved).toEqual([]);
  });

  test("one manifest with no mass makes the whole Leg's mass absent — never a partial sum", () => {
    const resolved = solvePath.payloadFor({
      manifests: [{ manifestId: "m1", observedMassKg: 7 }, { manifestId: "m2", payloadSpec: {} }],
    });

    // A partial sum would understate the load, and understating mass understates
    // consumption — the permissive direction, and E-8's failure mode one model along.
    expect(resolved.massKg).toBeUndefined();
    expect(resolved.unresolved).toEqual(["manifest m2 states no mass"]);
  });

  test("no manifest at all is a stated empty load, which is not the same fact", () => {
    // A Leg carrying nothing weighs nothing; a manifest that cannot say what it weighs is
    // an absence. The two must not produce the same number — the same distinction §F.2
    // draws for a declared zero climb against a silent one.
    expect(solvePath.payloadFor({ manifests: [] }).massKg).toBe(0);
    expect(solvePath.payloadFor({ manifests: [{ manifestId: "m" }] }).massKg).toBeUndefined();
  });

  test("`cellIdFor` derives the fine cell from the stop alone — no published cover (§D.3)", () => {
    const cellId = solvePath.cellIdFor({ lat: PICKUP.lat, lon: PICKUP.lon });
    expect(cellId).toBe(cells.cellForPoint(PICKUP.lat, PICKUP.lon, cells.RESOLUTION.FINE));
    expect(solvePath.cellIdFor({ lat: null, lon: null })).toBeNull();
  });

  test("the agent snapshot carries no derived stand-in for an absent battery row", async () => {
    const { context } = completeContext({ kv: kvHandle.kv, store: { omitBattery: true } });
    const load = solvePath.agentSnapshotLoaderFor(context);
    const snapshot = await load("agent-row-1");

    // κ, SoC and SoH all absent — and absent, not neutral. A κ silently read as 1 reports an
    // uncalibrated fleet as a calibrated one.
    expect(snapshot.kappa).toBeNull();
    expect(snapshot.soc).toBeNull();
    expect(snapshot.soh).toBeNull();
  });

  test("the leg loader resolves the §8.7 role from the mission rather than assuming it", async () => {
    const { context } = completeContext({ kv: kvHandle.kv });
    const load = solvePath.legLoaderFor(context);
    const leg = await load("leg-1");

    expect(leg.role).toBe("TERMINAL");
    expect(leg.legRowId).toBe("leg-row-1");
    // Both identifiers, because `commit.js` locks on the row id and every engine module
    // reads the business one — conflating them is what `diagnoseMissingRow` exists to name.
    expect(leg.legId).toBe("leg-1");
  });

  test("an unresolvable Leg refuses the expansion rather than expanding over nothing", async () => {
    const { context } = completeContext({ kv: kvHandle.kv, store: { omitLeg: true } });
    const assembly = solvePath.create(context);

    const outcome = await assembly.deps.expandCandidates({ legId: "absent", shardId: SHARD_ID, decisionTimeMs: DECISION_TIME_MS, queueAgeSeconds: 60 });

    expect(outcome.ok).toBe(false);
    expect(outcome.candidates).toEqual([]);
    expect(outcome.truncatedBy).toBe(solvePath.REFUSAL.LEG_UNRESOLVED);
    // I20 again: no `C*`, so no gap — not a zero one.
    expect(outcome.achievedGapMilliCU).toBeNull();
    expect(outcome.achievedGapProven).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   F — THE FEASIBILITY GATE'S OWN UNRESOLVED INPUTS

   The largest finding of the V1 composition, measured by the shipped gate rather
   than read off it. Every earlier audit of "what does the coordinator need" stopped
   at `planBuilder`, and §7.5's gate is a layer this repository had never run against
   a candidate assembled from its own schema.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("F — §7.5's gate cannot resolve most of its inputs from this schema", () => {
  /**
   * Build the best candidate this repository can assemble, and evaluate **every**
   * predicate against it.
   *
   * `collectAll` disables §7.5's short-circuit, so the answer is the whole set rather than
   * whichever predicate happened to deny first. The verdict is identical either way — every
   * predicate is a pure function of the snapshot — which is what makes this a measurement
   * of the gate's inputs and not of its evaluation order.
   */
  /**
   * The hop this fixture's plan traverses twice, and the shape of the mission it makes.
   *
   * Lifted out of `everyVerdict` so that the commitment-horizon assumption below can be
   * *derived* from the fixture rather than restated beside it. **These are not travel
   * times** — see `declaredRouter` in the file header.
   */
  const FIXTURE_HOP = Object.freeze({
    distanceM: 800,
    travelSeconds: 400,
    travelSdSeconds: 20,
    climbM: 6,
    descentM: 3,
    stopStartCycles: 4,
  });
  const FIXTURE_HOP_COUNT = 2;
  const FIXTURE_STOP_COUNT = 2;

  /**
   * **W-A2 — the assumption the F17 `VIOLATED` below rests on, computed rather than assumed.**
   *
   * F17's condition 2 compares the plan's furthest extent against `plan.commitment_horizon`.
   * This fixture does **not** override that parameter: it is read from the shipped register,
   * which is the whole evidential value of the `VIOLATED` — a real rule, read from the
   * register, broken by a real plan (§6.3).
   *
   * That is also its fragility. `plan.commitment_horizon` is `PROVISIONAL`/`UNCALIBRATED`
   * and `awaits: "observed commitment lead times"`, so §22.4's calibration owner may
   * legitimately move it. Calibrated to anything at or above this fixture's extent, F17
   * stops being violated and the expectations below stop holding — **for no defect at all.**
   *
   * So the assumption is asserted first, by name and with its arithmetic. If it is the
   * assertion that fails, the message says what happened and what must not be done about
   * it. **It must NOT be discharged by shortening the fixture, by overriding the parameter
   * here, or by removing the `VIOLATED`** (§6.8, §17 rule 7).
   */
  function commitmentHorizonAssumption() {
    const horizonSeconds = service.defaultSnapshot().resolve("plan.commitment_horizon", {});
    const serviceTimeSeconds = resolvableRegister()["plan.service_time_prior"];
    const extentSeconds = FIXTURE_HOP_COUNT * FIXTURE_HOP.travelSeconds + FIXTURE_STOP_COUNT * serviceTimeSeconds;
    return { horizonSeconds, serviceTimeSeconds, extentSeconds, holds: extentSeconds > horizonSeconds };
  }

  function everyVerdict() {
    const { context, store } = completeContext({ kv: kvHandle.kv });
    const snapshot = context.snapshot;

    const agentSnapshot = {
      agentId: "agent-1",
      agentClassId: "class-composition",
      tenantId: "tenant-a",
      lat: ORIGIN.lat,
      lon: ORIGIN.lon,
      cellId: store.fineCellId,
      lifecycleState: "ACTIVE",
      energyModel: store.agent.agentClass.energyModel,
      energyCoefficients: require("../../src/engine/domain/mappers/decisionInputs").energyCoefficientsFrom(
        energyModelParamsRow(),
      ),
      kappa: 1,
      soc: 0.9,
      soh: 0.95,
      containerModel: null,
      ambientC: 20,
      packC: 22,
      commitments: [],
      hardCommitmentCount: 0,
    };

    const leg = {
      legId: "leg-1",
      missionId: "mission-1",
      role: "TERMINAL",
      custodyState: "NONE",
      purpose: "PRIMARY",
      targetMs: DECISION_TIME_MS + 3_600_000,
      deadlineMs: DECISION_TIME_MS + 3_600_000,
      stops: store.leg.stops.map((stop) => ({ ...stop, cellId: solvePath.cellIdFor(stop) })),
      manifests: [],
    };

    const hops = Array.from({ length: FIXTURE_HOP_COUNT }, () => ({ ...FIXTURE_HOP }));

    const built = planBuilder.build(
      solvePath.planInputFor({
        agentSnapshot,
        leg,
        hops,
        hopsForSequence: () => hops,
        snapshot,
        scope: { sla_class: null },
        decisionTimeMs: DECISION_TIME_MS,
        seams: context,
        slaClass: null,
        queueAgeSeconds: 60,
      }),
    );
    expect(built.ok).toBe(true);

    return feasibility.evaluateCandidate(
      {
        agentSnapshot,
        mission: { legId: leg.legId, missionId: leg.missionId, purpose: leg.purpose, custodyState: leg.custodyState, stops: leg.stops },
        plan: built.plan,
        config: { get: (name) => snapshot.resolve(name, {}) },
        decisionTimeMs: DECISION_TIME_MS,
      },
      { collectAll: true },
    );
  }

  test("W-A2 — the F17 VIOLATED rests on a PROVISIONAL horizon, and this is that assumption", () => {
    const assumption = commitmentHorizonAssumption();

    // The fixture's own arithmetic, pinned. If someone shortens the mission to make F17
    // green, this is the assertion that says so — which is the point of pinning it.
    expect(assumption.serviceTimeSeconds).toBe(60);
    expect(assumption.extentSeconds).toBe(
      FIXTURE_HOP_COUNT * FIXTURE_HOP.travelSeconds + FIXTURE_STOP_COUNT * assumption.serviceTimeSeconds,
    );
    expect(assumption.extentSeconds).toBe(920);

    // The register's side of the comparison, read live and never overridden here.
    expect(typeof assumption.horizonSeconds).toBe("number");

    if (!assumption.holds) {
      throw new Error(
        "W-A2 — the fixture's commitment-horizon assumption no longer holds.\n" +
          `  plan.commitment_horizon now publishes as ${assumption.horizonSeconds} s.\n` +
          `  This fixture's plan extends ${assumption.extentSeconds} s past the decision time.\n` +
          "  The horizon is at or above the extent, so F17 no longer reports VIOLATED and the\n" +
          "  expectations in the next test cannot hold.\n" +
          "\n" +
          "  THIS IS NOT A DEFECT. plan.commitment_horizon is PROVISIONAL/UNCALIBRATED and awaits\n" +
          "  'observed commitment lead times'; §22.4's calibration owner is entitled to move it.\n" +
          "\n" +
          "  It must NOT be closed by shortening this fixture, by overriding plan.commitment_horizon\n" +
          "  in resolvableRegister(), or by deleting the VIOLATED assertion (§6.8 / W-A2, and §17\n" +
          "  rule 7 of docs/v1/V1_IMPLEMENTATION_CONTROL.md). Re-derive the fixture's extent against\n" +
          "  the new horizon, record the new arithmetic here, and keep the VIOLATED real.",
      );
    }
    expect(assumption.holds).toBe(true);
  });

  test("the gate denies, and every denial but one is INDETERMINATE — an absence, not a violation", () => {
    const outcome = everyVerdict();

    expect(outcome.feasible).toBe(false);
    // **One VIOLATED, and it is new.** Until the E-10 execution pass this read *"not one
    // VIOLATED — a gate that cannot see, not a fleet that fails"*, and that was true
    // because F17 could not read `capacity` at all: `readIndexedParameter` discarded the
    // register's scope-resolved scalar, so the predicate stopped at condition 1 and never
    // reached condition 2. With the value readable, F17 evaluates the §2.6 commitment
    // horizon — and **this fixture's plan genuinely exceeds it**: two 400 s hops plus two
    // 60 s service times is 920 s against a 900 s `plan.commitment_horizon`.
    //
    // The fixture is deliberately **not** shortened to make this green. It is a real rule,
    // read from the register, broken by a real plan, and it is the first thing §7.5 has
    // ever been able to say about this deployment other than "I cannot see".
    //
    // **W-A2**: the horizon this is measured against is read from the register rather than
    // written as a literal, so the assertion states the relation the predicate actually
    // checks. The assumption that the relation holds at all is asserted in the test above,
    // where a future calibration explains itself instead of failing here as a lost list.
    const assumption = commitmentHorizonAssumption();
    const violated = outcome.denials.filter((row) => row.outcome === "VIOLATED");
    expect(violated.map((row) => row.predicateId)).toEqual(["F17"]);
    expect(violated[0].result.reason).toMatch(/commitment horizon/);
    expect(violated[0].result.observed.extentMs).toBeGreaterThan(assumption.horizonSeconds * 1000);

    // Every other denial is an absence.
    const outcomes = new Set(outcome.denials.filter((row) => row.outcome !== "VIOLATED").map((row) => row.outcome));
    expect([...outcomes]).toEqual(["INDETERMINATE"]);
    // §7.3's three-valued resolution, and the sharper half of the finding: the denied set
    // is **not** confined to predicates whose declared policy is `DENY`. It also contains
    // the two *admitting* policies — `ADMIT_WITH_PENALTY` and `DENY_UNLESS_ENVELOPE` —
    // which denied anyway, because the inputs those policies need to admit on
    // (`cost.uncertainty_penalty`, a reduced-envelope evaluation) are unresolved too.
    //
    // So "UNKNOWN IS NOT PERMISSION" holds all the way down, including at the two seams
    // designed to let an unknown through under a price. Every one of these is an
    // indeterminacy denial, not a rule broken.
    expect(outcome.denials.filter((row) => row.outcome !== "VIOLATED").every((row) => row.deniedForIndeterminacy === true)).toBe(true);
    expect([...new Set(outcome.denials.map((row) => row.policy))].sort()).toEqual([
      "ADMIT_WITH_PENALTY",
      "DENY",
      "DENY_UNLESS_ENVELOPE",
    ]);
    // And the tally §7.4 step 1 keeps — which has now **flipped**, and that is the point of
    // it. "Denied solely for indeterminacy" is the state an operator must be able to tell
    // from a genuinely infeasible fleet, and this candidate is no longer in it: one real
    // constraint is broken. An operator reading `false` here is being told something true
    // that they could not previously be told.
    expect(outcome.deniedForIndeterminacyOnly).toBe(false);
  });

  test("F1 denies first, so no candidate is ever priced — the branch above is unreachable", () => {
    const outcome = everyVerdict();

    // §7.5 evaluates cheapest-first and F1 is first: *"an uncommissioned agent has no
    // validated configuration, so no other predicate's inputs are trustworthy"*. It reads
    // `agentSnapshot.commissioning`, a CONTROL_PLANE fact with **no schema column and no
    // producer anywhere in `src/`** — so it is `absent` for every agent this repository can
    // build, and its policy is DENY.
    const f1 = outcome.denials.find((row) => row.predicateId === "F1");
    expect(f1).toBeDefined();
    expect(f1.policy).toBe("DENY");
    expect(f1.result.required).toMatch(/commissioning record/);
  });

  test("the unresolved inputs group by SOURCE, and the sources are the actionable part", () => {
    const outcome = everyVerdict();
    const sources = new Set(outcome.denials.map((row) => row.result.inputSource).filter(Boolean));

    // The classes, not the count — for the same reason `coordinatorPipeline` reports classes:
    // a source says *who can supply this*. A count says nothing and rots on the first fix.
    //
    //   CONTROL_PLANE      — commissioning, firmware set, certifications, tenant scope
    //   SENSOR             — e-stop, faults, battery and telemetry freshness
    //   OPERATOR           — holds and quarantine
    //   PLAN / INFERRED    — availability, cooloff, health tier, §14.5's energy tiers
    //   ROUTING / MAP      — constrictions, restrictions, the serviceable region
    //   EXTERNAL_SUBSYSTEM — reservations held by another subsystem
    //   CONFIG             — register entries
    //
    // Not one of them is a decision anyone is withholding. Every one is a fact with no
    // column and no producer, or a source nobody has named.
    for (const expected of ["CONTROL_PLANE", "SENSOR", "OPERATOR", "PLAN", "ROUTING", "MAP", "CONFIG"]) {
      expect({ source: expected, present: sources.has(expected) }).toEqual({ source: expected, present: true });
    }
  });

  /**
   * A direct correction of §D.3, evidenced.
   *
   * §D.3 concluded that *"a V1 expansion does not require the D1 H3 cover"*, and §K.3 told
   * the owner not to be asked for *"the D1 H3 cover, boundary polygon, CRS or charger
   * estate"*. The first half is right and the conclusion drawn from it is not: **F33
   * requires every endpoint to lie inside the serviceable region**, and F35 requires a
   * reachable charger. The cover is not a *search* prerequisite and it is a *gate*
   * prerequisite, which is one seam further along than §D.3 looked.
   */
  test("F33 and F35 need D1's serviceable region and charger estate — §D.3 stopped a seam short", () => {
    const outcome = everyVerdict();
    const byId = new Map(outcome.denials.map((row) => [row.predicateId, row]));

    expect(byId.get("F33").result.required).toMatch(/inside the serviceable region/);
    expect(byId.get("F33").policy).toBe("DENY");
    expect(byId.get("F35").result.required).toMatch(/charger reachable/);
    expect(byId.get("F35").policy).toBe("DENY");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   G — THE SEAMS E-10 NAMED, BUILT AND EXERCISED

   Three register names the code asked for and the register does not carry (§M.1),
   and the two producers §M.2 and §M.3 measured as absent. Every assertion below
   runs the REAL modules; the doubles are the store and the two seams that have no
   producer anywhere, each labelled at its use.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("G — the three misspelled register names (§M.1)", () => {
  test("all three names the composition asks for are published by the register", () => {
    // The direct statement of M-1, M-2 and M-3. Each of these resolved to `undefined`
    // under the name the code used, which is indistinguishable from a `null` entry the
    // owner has not supplied — so a **published** value read as a missing input.
    const real = service.defaultSnapshot();

    expect(real.resolve("energy.variance_inflation", {})).toEqual(
      expect.objectContaining({ route_novelty: expect.any(Number) }),
    );
    expect(typeof real.resolve("energy.charger_projection_max_age", {})).toBe("number");
    expect(typeof real.resolve("lease.duration", {})).toBe("number");

    // And the names they replaced are genuinely absent, which is why the substitution was
    // silent rather than a throw.
    for (const absent of ["energy.uncertainty_inflation", "energy.projection_max_age", "commitment.lease_duration"]) {
      expect(real.resolve(absent, {})).toBeUndefined();
    }
  });

  test("`planInputFor` reads the published names — on the register, with NO overrides", () => {
    // The counterfactual that M-1 failed. Against `service.defaultSnapshot()` itself —
    // no `snapshotWith`, no fixture override — the two energy inputs must arrive with the
    // register's published values rather than as `undefined`.
    const { context, store } = completeContext({ kv: kvHandle.kv });
    const input = solvePath.planInputFor({
      agentSnapshot: { agentId: "a", agentClassId: "c", cellId: store.fineCellId, ambientC: 20, packC: 22, soc: 0.9, soh: 0.95, kappa: 1, energyModel: null, energyCoefficients: null, containerModel: null },
      leg: { legId: "leg-1", stops: [], role: "TERMINAL", targetMs: null, deadlineMs: null, custodyState: "NONE" },
      hops: [],
      hopsForSequence: () => null,
      snapshot: service.defaultSnapshot(),
      scope: {},
      decisionTimeMs: DECISION_TIME_MS,
      seams: context,
      slaClass: null,
      queueAgeSeconds: 60,
    });

    expect(input.energy.inflations).toEqual(service.defaultSnapshot().resolve("energy.variance_inflation", {}));
    expect(input.energy.projectionMaxAgeSeconds).toBe(
      service.defaultSnapshot().resolve("energy.charger_projection_max_age", {}),
    );
    expect(input.energy.inflations).toBeDefined();
  });

  test("the whole plan path builds on the published inflation factors alone", () => {
    // M-1's measured consequence, inverted. With `energy.uncertainty_inflation` the
    // fixture's override was consumed and the register's value never reached
    // `consumption.predictiveDistribution`; in production nothing reached it and
    // `buildVariant` returned `MISSING_ENERGY_INPUT` for every candidate. Here the
    // fixture supplies **no** inflation factors at all, so the plan can only build if the
    // published `energy.variance_inflation` is what the code reads.
    const overrides = resolvableRegister();
    expect(Object.keys(overrides)).not.toContain("energy.variance_inflation");

    const { context, store } = completeContext({ kv: kvHandle.kv });
    const built = planBuilder.build(
      solvePath.planInputFor({
        agentSnapshot: {
          agentId: "agent-1",
          agentClassId: "class-composition",
          cellId: store.fineCellId,
          lat: ORIGIN.lat,
          lon: ORIGIN.lon,
          energyModel: store.agent.agentClass.energyModel,
          energyCoefficients: require("../../src/engine/domain/mappers/decisionInputs").energyCoefficientsFrom(
            energyModelParamsRow(),
          ),
          kappa: 1,
          soc: 0.9,
          soh: 0.95,
          containerModel: null,
          ambientC: 20,
          packC: 22,
        },
        leg: {
          legId: "leg-1",
          missionId: "mission-1",
          role: "TERMINAL",
          custodyState: "NONE",
          targetMs: DECISION_TIME_MS + 3_600_000,
          deadlineMs: DECISION_TIME_MS + 3_600_000,
          stops: store.leg.stops.map((stop) => ({ ...stop, cellId: solvePath.cellIdFor(stop) })),
        },
        hops: [1, 2].map(() => ({ distanceM: 800, travelSeconds: 400, travelSdSeconds: 20, climbM: 6, descentM: 3, stopStartCycles: 4 })),
        hopsForSequence: () => null,
        snapshot: context.snapshot,
        scope: { sla_class: null },
        decisionTimeMs: DECISION_TIME_MS,
        seams: context,
        slaClass: null,
        queueAgeSeconds: 60,
      }),
    );

    expect(built.ok).toBe(true);
    expect(built.problems.join(" ")).not.toMatch(/variance_inflation|MISSING_ENERGY_INPUT/);
  });

  test("`commit` hands §10.3.2 a POSITIVE lease duration — M-3, at the seam", async () => {
    // **The assertion §M.1 said this suite could not make.** `leases.grant` throws a
    // RangeError on a non-positive lease **inside** the serialisable transaction, after
    // step 1's row locks — and the existing commit test aborts at step 1 on a store with
    // no rows, so M-3 was never reached and reverting the name broke nothing.
    //
    // So the assertion is moved to the seam instead of the outcome: `commitment/commit.js`
    // is spied on to capture the `config` the composer builds, and called through to the
    // real implementation so the abort below is still the shipped guard's.
    const real = service.defaultSnapshot();
    const published = real.resolve("lease.duration", {});
    expect(published).toBeGreaterThan(0);

    const { context, store } = completeContext({
      kv: kvHandle.kv,
      runSerializable: async (client, fn) =>
        fn({ commitment: { findUnique: async () => null }, agent: { findFirst: async () => null }, leg: { findFirst: async () => null } }),
    });
    const assembly = solvePath.create(context);
    await assembly.deps.expandCandidates({ legId: "leg-1", shardId: SHARD_ID, decisionTimeMs: DECISION_TIME_MS, queueAgeSeconds: 60 });

    const commitment = require("../../src/engine/commitment/commit");
    const realCommit = commitment.commit;
    let captured = null;
    const spy = jest.spyOn(commitment, "commit").mockImplementation((deps, input) => {
      captured = input;
      return realCommit(deps, input);
    });

    try {
      const outcome = await assembly.deps.commit(
        { legId: store.leg.legId, agentId: store.agent.agentId },
        { roundId: "round-lease", leadershipFence: 1 },
      );

      // The composer resolved the register's published lease, under the register's own
      // name. Under the old spelling this is `undefined`, and `leases.grant` would throw
      // at the last step of a commit that had already taken its locks.
      expect(captured.config.leaseDurationSeconds).toBe(published);
      expect(captured.config.leaseDurationSeconds).toBeGreaterThan(0);
      // And the real `commit.js` still ran and aborted at step 1 — the shipped guard.
      expect(outcome.outcome).toBe("ABORTED");
    } finally {
      spy.mockRestore();
    }
  });

  test("`gate:params` rule 2 fails on each of the three names — the gate, not the fix", () => {
    // R-4: the defect class, not the three instances. A test pinning the three names
    // would not catch the fourth; this asserts the **scanner** rejects an unregistered
    // read in each of the three call shapes the composition root actually uses.
    const { checkResolvedNames, loadRegister } = require("../../tools/gates/checkParameterRegister");
    const { names } = loadRegister(path.join(__dirname, "..", ".."));

    const offending = [
      'const a = resolve(snapshot, "energy.uncertainty_inflation", scope);',
      'const b = snapshot.resolve("energy.projection_max_age", scope);',
      'const c = config.get("commitment.lease_duration");',
    ].join("\n");
    const found = checkResolvedNames("probe.js", offending, names);
    // Sorted, because the scanner runs one pattern at a time and reports in pattern order;
    // the gate itself sorts by (file, line) before rendering.
    expect(found.map((row) => row.line).sort()).toEqual([1, 2, 3]);
    expect(found.every((row) => row.kind === "unregistered-parameter-read")).toBe(true);

    // And it does not fire on the shipped spellings, nor on the two call shapes that
    // merely share a name — `path.resolve` and `Map.get`.
    const clean = [
      'const a = resolve(snapshot, "energy.variance_inflation", scope);',
      'const b = snapshot.resolve("energy.charger_projection_max_age", scope);',
      'const c = config.get("lease.duration");',
      'const d = path.resolve(__dirname, "..", "not-a-parameter");',
      'const e = terms.get("C_opportunity");',
    ].join("\n");
    expect(checkResolvedNames("probe.js", clean, names)).toEqual([]);
  });
});

describe("G — F33: containment by assignment, from the published map (§M.2)", () => {
  /** A published `spatial` payload assigning exactly the cells this fixture's stops sit in. */
  function coverFor(stops) {
    return {
      version: 1,
      regions: [{ id: "region-1" }],
      zones: [{ id: "zone-1", regionId: "region-1" }],
      sites: [],
      cells: stops.map((stop) => ({
        cellId: cells.cellForPoint(stop.lat, stop.lon, cells.RESOLUTION.FINE),
        resolution: cells.RESOLUTION.FINE,
        regionId: "region-1",
        zoneId: "zone-1",
      })),
    };
  }

  test("with NO published map every stop's assignment stays absent — F33 denies", () => {
    const { context, store } = completeContext({ kv: kvHandle.kv });
    expect(context.snapshot.spatial).toBeNull();

    const withAssignment = solvePath.serviceabilityFor(context.snapshot)(store.leg.stops);
    for (const stop of withAssignment) {
      expect(stop.serviceable).toBeUndefined();
    }
    // A deployment that has declared no region has not declared the world serviceable.
    const verdict = require("../../src/engine/feasibility/predicates/f33").evaluate({
      plan: { stops: withAssignment.map((stop, index) => ({ ...stop, sequence: index + 1 })) },
    });
    expect(verdict.outcome).toBe("INDETERMINATE");
  });

  /**
   * **RD-2026-09-14-01 D1 changed this test's contract, and the change is a tightening.**
   *
   * Assignment alone used to produce `serviceable: true`. It no longer does, because
   * asserting serviceability from the index alone silently asserted two further facts:
   * that the indexed cell's ground is inside the delivery domain, and that the point can
   * be reached by the road network. Serviceability is now
   * `assigned ∧ inDeliveryDomain ∧ routable`, and the two added conjuncts are supplied
   * here rather than assumed.
   */
  test("with the cells assigned, the domain pinned INSIDE and the point routable, F33 is SATISFIED", () => {
    const { context, store } = completeContext({ kv: kvHandle.kv, spatial: coverFor([PICKUP, DROP]) });
    const stops = store.leg.stops.map((stop) => ({ ...stop, geofenceResult: "INSIDE", routable: true }));

    const withAssignment = solvePath.serviceabilityFor(context.snapshot)(stops);
    expect(withAssignment.map((stop) => stop.serviceable)).toEqual([true, true]);

    const verdict = require("../../src/engine/feasibility/predicates/f33").evaluate({
      plan: { stops: withAssignment.map((stop, index) => ({ ...stop, sequence: index + 1 })) },
    });
    expect(verdict.outcome).toBe("SATISFIED");
  });

  /**
   * The same fixture with each added conjunct withheld in turn. Every one of these was
   * SATISFIED before D1 — that is precisely the defect D1 removes — and each must now
   * deny, **absent rather than false**, because an unmeasured fact is not a negative one.
   */
  test.each([
    ["the pinned geofence verdict", { routable: true }],
    ["routability (R13)", { geofenceResult: "INSIDE" }],
    ["both", {}],
  ])("with the cells assigned but %s withheld, F33 is INDETERMINATE — never SATISFIED", (_label, extra) => {
    const { context, store } = completeContext({ kv: kvHandle.kv, spatial: coverFor([PICKUP, DROP]) });
    const stops = store.leg.stops.map((stop) => ({ ...stop, ...extra }));

    const withAssignment = solvePath.serviceabilityFor(context.snapshot)(stops);
    expect(withAssignment.every((stop) => stop.serviceable === undefined)).toBe(true);

    const verdict = require("../../src/engine/feasibility/predicates/f33").evaluate({
      plan: { stops: withAssignment.map((stop, index) => ({ ...stop, sequence: index + 1 })) },
    });
    expect(verdict.outcome).toBe("INDETERMINATE");
    expect(verdict.outcome).not.toBe("VIOLATED");
  });

  /**
   * **D6 in one test.** An indexed cell whose ground straddles the campus boundary is an
   * index bucket. A point inside that cell but outside the campus is a definite
   * geographic fact, and it must DENY — with `VIOLATED`, not `INDETERMINATE`, because
   * something *is* known about it.
   */
  test("an assigned cell does NOT rescue a point the pinned verdict says is OUTSIDE — VIOLATED", () => {
    const { context, store } = completeContext({ kv: kvHandle.kv, spatial: coverFor([PICKUP, DROP]) });
    const stops = store.leg.stops.map((stop) => ({ ...stop, geofenceResult: "OUTSIDE", routable: true }));

    const withAssignment = solvePath.serviceabilityFor(context.snapshot)(stops);
    expect(withAssignment.every((stop) => stop.serviceable === false)).toBe(true);

    const verdict = require("../../src/engine/feasibility/predicates/f33").evaluate({
      plan: { stops: withAssignment.map((stop, index) => ({ ...stop, sequence: index + 1 })) },
    });
    expect(verdict.outcome).toBe("VIOLATED");
    expect(verdict.reason).toMatch(/outside the serviceable region/u);
  });

  test("a published map that does not assign the cell leaves it ABSENT, never `false`", () => {
    // The distinction §M.2 draws and the one an eager implementation gets wrong. `false`
    // is read by F33 as VIOLATED — *"lies outside the serviceable region"* — which is a
    // definite claim about the request. An unassigned cell does not support it.
    // A cover of somewhere else entirely — the two campus points are metres apart and can
    // share a fine cell, which would make this assertion pass for the wrong reason.
    const elsewhere = { lat: 51.5074, lon: -0.1278 };
    const { context, store } = completeContext({ kv: kvHandle.kv, spatial: coverFor([elsewhere]) });

    const withAssignment = solvePath.serviceabilityFor(context.snapshot)(store.leg.stops);
    expect(withAssignment.every((stop) => stop.serviceable === undefined)).toBe(true);

    const verdict = require("../../src/engine/feasibility/predicates/f33").evaluate({
      plan: { stops: withAssignment.map((stop, index) => ({ ...stop, sequence: index + 1 })) },
    });
    expect(verdict.outcome).toBe("INDETERMINATE");
    expect(verdict.outcome).not.toBe("VIOLATED");
  });

  test("an unreadable published map is not a permissive one", () => {
    const withAssignment = solvePath.serviceabilityFor({ spatial: { cells: "not-a-list" } })([{ sequence: 1, lat: PICKUP.lat, lon: PICKUP.lon }]);
    expect(withAssignment[0].serviceable).toBeUndefined();
  });

  /**
   * **The full D1 integration, end to end through the production callers.**
   *
   * The audit of 2026-09-14 found that this test had been reduced to asserting only the
   * *absent* case (`every(s => s.serviceable === undefined)`) — an assertion that also
   * passes if `planInputFor` stops calling `serviceabilityFor` altogether, because raw
   * `leg.stops` carry no `serviceable` field either. That is weaker than what it
   * replaced. This restores positive coverage and adds the integration the old test
   * never had: the pinned column travelling through `legLoaderFor` as well.
   *
   * Nothing here is mocked away. `prismaDouble` stands in for the database rows only;
   * `legLoaderFor`, `serviceabilityFor`, `planInputFor` and `f33.evaluate` are the
   * shipped functions, called in the order production calls them.
   */
  describe("the D1 conjunction through legLoaderFor → planInputFor — the production callers", () => {
    const f33 = require("../../src/engine/feasibility/predicates/f33");

    /** The two Stop rows as the database holds them, with whatever intake pinned. */
    function prismaDoubleWith(pins) {
      return {
        leg: {
          findFirst: async () => ({
            id: "leg-row-1", legId: "leg-1", missionId: null, purpose: "PRIMARY", state: "QUEUED",
            custodyState: "NONE", version: 1, cancelRequestedAt: null, obstructionClass: null,
            slaDeadline: null, startNotBefore: null, createdAt: null, manifests: [], mission: null,
            stops: [
              { stopId: "s1", sequence: 1, stopType: "PICKUP", siteId: "a", lat: PICKUP.lat, lon: PICKUP.lon, geofenceResult: pins[0], accessConstraints: null },
              { stopId: "s2", sequence: 2, stopType: "DROP", siteId: "b", lat: DROP.lat, lon: DROP.lon, geofenceResult: pins[1], accessConstraints: null },
            ],
          }),
        },
      };
    }

    /** Load through the real `legLoaderFor`, then build through the real `planInputFor`. */
    async function throughProductionCallers(pins, { routable } = {}) {
      const { context, store } = completeContext({ kv: kvHandle.kv, spatial: coverFor([PICKUP, DROP]) });
      const loaded = await solvePath.legLoaderFor({ prisma: prismaDoubleWith(pins) })("leg-1");
      // `routable` is R13's conjunct. Nothing in `src/` produces it, so a test that wants
      // the positive case has to supply it — which is itself the point being recorded.
      const stops = routable === undefined ? loaded.stops : loaded.stops.map((stop) => ({ ...stop, routable }));

      const input = solvePath.planInputFor({
        agentSnapshot: { agentId: "a", agentClassId: "c", cellId: store.fineCellId, ambientC: 20, packC: 22, soc: 0.9, soh: 0.95, kappa: 1, energyModel: null, energyCoefficients: null, containerModel: null },
        leg: { legId: "leg-1", stops, role: "TERMINAL", targetMs: null, deadlineMs: null, custodyState: "NONE" },
        hops: [],
        hopsForSequence: () => null,
        snapshot: context.snapshot,
        scope: {},
        decisionTimeMs: DECISION_TIME_MS,
        seams: context,
        slaClass: null,
        queueAgeSeconds: 60,
      });
      const planStops = input.newLegs[0].stops;
      return { loaded, planStops, verdict: f33.evaluate({ plan: { stops: planStops } }) };
    }

    // (1) and (2) — invocation and consumption, proved behaviourally rather than by spy.
    // `planInputFor` calls the module-local `serviceabilityFor`, which a spy on the export
    // cannot intercept; so the proof is that the stops reaching the plan carry fields that
    // ONLY `serviceabilityFor` adds. Raw `leg.stops` have neither `cellId` nor `serviceable`.
    test("1/2. planInputFor actually invokes serviceabilityFor, and its result reaches the plan", async () => {
      const { loaded, planStops } = await throughProductionCallers(["INSIDE", "INSIDE"], { routable: true });

      expect(loaded.stops.every((stop) => stop.cellId === undefined)).toBe(true);
      expect(loaded.stops.every((stop) => stop.serviceable === undefined)).toBe(true);

      // Both fields are present on the plan's stops, so the seam ran and was consumed.
      expect(planStops.every((stop) => typeof stop.cellId === "string" && stop.cellId.length > 0)).toBe(true);
      expect(planStops.map((stop) => stop.serviceable)).toEqual([true, true]);
    });

    // (3) and (4) — the pin survives both callers, and INSIDE yields the positive input.
    test("3/4. a pinned INSIDE verdict survives legLoaderFor and planInputFor, and F33 is SATISFIED", async () => {
      const { loaded, planStops, verdict } = await throughProductionCallers(["INSIDE", "INSIDE"], { routable: true });

      expect(loaded.stops.map((stop) => stop.geofenceResult)).toEqual(["INSIDE", "INSIDE"]);
      expect(planStops.map((stop) => stop.geofenceResult)).toEqual(["INSIDE", "INSIDE"]);
      expect(planStops.map((stop) => stop.serviceable)).toEqual([true, true]);
      expect(verdict.outcome).toBe("SATISFIED");
    });

    // (5) — a definite OUTSIDE cannot become serviceable even fully assigned and routable.
    test("5. a pinned OUTSIDE verdict is a definite refusal through the whole path — VIOLATED", async () => {
      const { loaded, planStops, verdict } = await throughProductionCallers(["INSIDE", "OUTSIDE"], { routable: true });

      expect(loaded.stops.map((stop) => stop.geofenceResult)).toEqual(["INSIDE", "OUTSIDE"]);
      // The cell IS published and assigned, and the point IS routable. Only the pin differs.
      expect(planStops.map((stop) => stop.serviceable)).toEqual([true, false]);
      expect(verdict.outcome).toBe("VIOLATED");
      expect(verdict.reason).toMatch(/outside the serviceable region/u);
    });

    // (6) — missing geofence information stays absent, never silently true.
    test("6. a missing pinned verdict stays INDETERMINATE through the whole path, never true", async () => {
      const { loaded, planStops, verdict } = await throughProductionCallers([null, null], { routable: true });

      expect(loaded.stops.map((stop) => stop.geofenceResult)).toEqual([null, null]);
      expect(planStops.every((stop) => stop.serviceable === undefined)).toBe(true);
      expect(planStops.some((stop) => stop.serviceable === true)).toBe(false);
      expect(verdict.outcome).toBe("INDETERMINATE");
      expect(verdict.outcome).not.toBe("VIOLATED");
    });

    /**
     * R13's standing consequence, through the production callers.
     *
     * Note what F33 does and does not do here. It scans stops in order and **returns on
     * the first stop it cannot satisfy**, so a plan whose first stop is absent reports
     * INDETERMINATE even though a later stop is a definite refusal. That is F33's
     * pre-existing, unchanged behaviour and both answers deny. What matters for D1 is the
     * *conjunction's* output per stop, which is asserted directly: absent where a conjunct
     * is unmeasured, `false` where one is definitely false.
     */
    test("with R13 unsupplied no stop is serviceable, and a definite OUTSIDE is still false", async () => {
      const allInside = await throughProductionCallers(["INSIDE", "INSIDE"]);
      expect(allInside.planStops.every((stop) => stop.serviceable === undefined)).toBe(true);
      expect(allInside.verdict.outcome).toBe("INDETERMINATE");

      const oneOutside = await throughProductionCallers(["INSIDE", "OUTSIDE"]);
      // The outside stop is a definite refusal even with routability unmeasured — a false
      // conjunct short-circuits the conjunction, which is the whole three-valued point.
      expect(oneOutside.planStops.map((stop) => stop.serviceable)).toEqual([undefined, false]);
      expect(oneOutside.planStops.some((stop) => stop.serviceable === true)).toBe(false);
      // And evaluated on its own, that stop is VIOLATED rather than merely undecided.
      expect(f33.evaluate({ plan: { stops: [oneOutside.planStops[1]] } }).outcome).toBe("VIOLATED");
    });
  });

  /**
   * The seam that produced the verdict and the seam that consumes it were each correct
   * in isolation and did not meet: `legLoaderFor`'s stop projection is a **whitelist**,
   * and it did not carry `geofenceResult`. A pin nothing can read is not a pin.
   */
  test("`legLoaderFor` carries the pinned geofence verdict out of the database", async () => {
    const rows = [
      { stopId: "s1", sequence: 1, stopType: "PICKUP", siteId: "a", lat: PICKUP.lat, lon: PICKUP.lon, geofenceResult: "INSIDE", accessConstraints: null },
      { stopId: "s2", sequence: 2, stopType: "DROP", siteId: "b", lat: DROP.lat, lon: DROP.lon, geofenceResult: "OUTSIDE", accessConstraints: null },
    ];
    const prisma = {
      leg: {
        findFirst: async () => ({
          id: "leg-row-1", legId: "leg-1", missionId: null, purpose: "PRIMARY", state: "QUEUED",
          custodyState: "NONE", version: 1, cancelRequestedAt: null, obstructionClass: null,
          slaDeadline: null, startNotBefore: null, createdAt: null, manifests: [], mission: null,
          stops: rows,
        }),
      },
    };
    const loaded = await solvePath.legLoaderFor({ prisma })("leg-1");
    expect(loaded.stops.map((stop) => stop.geofenceResult)).toEqual(["INSIDE", "OUTSIDE"]);
  });
});

describe("G — F35: the declared charger estate, read from the store (§M.3)", () => {
  /** A depot-class `Charger` row, in the shape `prisma/schema.prisma` declares. */
  function depotRow(cellId) {
    return { chargerId: "charger-depot-1", cellId, isDepot: true, chargerClass: "DEPOT", regionId: null };
  }

  test("with no `Charger` rows the seam supplies nothing and says so", async () => {
    const { context, store } = completeContext({ kv: kvHandle.kv });
    const seam = solvePath.routingSeamFor(context);
    const routing = {
      forPairing: async () => ({ ok: true, hops: [{ distanceM: 800, travelSeconds: 400 }], hopsForSequence: null, problems: [] }),
    };

    const estate = await solvePath.chargerCandidatesFor({
      context,
      routing,
      originCell: store.dropCellId,
      profileKey: "GROUND",
      snapshot: context.snapshot,
      scope: {},
    });

    expect(seam.deps.route).toBeDefined();
    expect(estate.candidates).toEqual([]);
    expect(estate.problems.join(" ")).toMatch(/no Charger rows are declared/);
  });

  test("one declared depot becomes one candidate in `eReturn`'s own contract", async () => {
    const { context, store } = completeContext({ kv: kvHandle.kv, chargers: [depotRow("placeholder")] });
    const routing = {
      forPairing: async () => ({ ok: true, hops: [{ distanceM: 800, travelSeconds: 400 }], hopsForSequence: null, problems: [] }),
    };

    const estate = await solvePath.chargerCandidatesFor({
      context,
      routing,
      originCell: store.dropCellId,
      profileKey: "GROUND",
      snapshot: context.snapshot,
      scope: {},
    });

    expect(estate.candidates.length).toBe(1);
    // Exactly the four fields `energy/eReturn.evaluate` documents, each from a real
    // source: two columns, the routing seam, and the declared return-leg rate.
    expect(estate.candidates[0]).toEqual(
      expect.objectContaining({ chargerId: "charger-depot-1", isDepot: true, travelSeconds: 400, energyWh: 800 * 0.05 }),
    );
  });

  test("a charger with no cell is omitted and named — never routed to at a guessed distance", async () => {
    const { context, store } = completeContext({
      kv: kvHandle.kv,
      chargers: [{ chargerId: "charger-no-cell", cellId: null, isDepot: true }],
    });
    const routing = { forPairing: async () => ({ ok: true, hops: [{ distanceM: 1, travelSeconds: 1 }], hopsForSequence: null, problems: [] }) };

    const estate = await solvePath.chargerCandidatesFor({
      context,
      routing,
      originCell: store.dropCellId,
      profileKey: "GROUND",
      snapshot: context.snapshot,
      scope: {},
    });

    expect(estate.candidates).toEqual([]);
    expect(estate.problems.join(" ")).toMatch(/states no cell/);
  });

  test("without the declared return-leg Wh per metre NO candidate is built — β_dist is not a substitute", async () => {
    const { context, store } = completeContext({ kv: kvHandle.kv, chargers: [depotRow("cell")] });
    const routing = { forPairing: async () => ({ ok: true, hops: [{ distanceM: 800, travelSeconds: 400 }], hopsForSequence: null, problems: [] }) };

    const estate = await solvePath.chargerCandidatesFor({
      context: { ...context, returnLegEnergyWhPerMetreFor: undefined, returnLegEnergyWhPerMetre: undefined },
      routing,
      originCell: store.dropCellId,
      profileKey: "GROUND",
      snapshot: context.snapshot,
      scope: {},
    });

    // §14.5's `E_return` understated is a surplus overstated, which admits exactly the
    // missions the reserve exists to refuse. Absent, the candidate is not built.
    expect(estate.candidates).toEqual([]);
    expect(estate.problems.join(" ")).toMatch(/return-leg Wh per metre/);
  });

  test("`create()` refuses without the return-leg rate — it is a declared requirement", () => {
    const { context } = completeContext({ kv: kvHandle.kv });
    const assembly = solvePath.create({ ...context, returnLegEnergyWhPerMetreFor: undefined });

    expect(assembly.ok).toBe(false);
    expect(assembly.missing.map((row) => row.input)).toContain("return-leg Wh per metre (per routing profile)");
  });

  test("no published projection is DEPOT_ONLY by §14.5's defined degradation, not by silence", async () => {
    const { context } = completeContext({ kv: kvHandle.kv });
    const pinned = await solvePath.pinnedChargerProjection(context);

    expect(pinned.projection).toBeNull();
    expect(pinned.problems.join(" ")).toMatch(/no charger availability projection has been published/);
  });

  test("a published projection is pinned through the module that validates it", async () => {
    const { context } = completeContext({
      kv: kvHandle.kv,
      projections: [
        {
          version: 7,
          publishedAt: new Date(DECISION_TIME_MS - 30_000),
          horizonEnd: new Date(DECISION_TIME_MS + 3_600_000),
          payload: { chargers: [{ chargerId: "charger-depot-1", isDepot: true, intervals: [{ fromMs: DECISION_TIME_MS, untilMs: DECISION_TIME_MS + 3_600_000, state: "FREE" }] }] },
        },
      ],
    });

    const pinned = await solvePath.pinnedChargerProjection(context);
    expect(pinned.projection.version).toBe(7);
    expect(pinned.projection.chargers[0].chargerId).toBe("charger-depot-1");
    // Frozen, because §14.7 calls the projection immutable and a round that could mutate
    // its own pinned input could not be replayed from the version it recorded.
    expect(Object.isFrozen(pinned.projection)).toBe(true);
  });

  test("a projection with no version is NOT pinned — the round degrades rather than keys on nothing", async () => {
    const { context } = completeContext({
      kv: kvHandle.kv,
      projections: [{ version: null, publishedAt: new Date(DECISION_TIME_MS), payload: { chargers: [] } }],
    });

    const pinned = await solvePath.pinnedChargerProjection(context);
    expect(pinned.projection).toBeNull();
    expect(pinned.problems.join(" ")).toMatch(/version/);
  });
});

describe("G — the §7.5 mapping gaps this pass closed (§M.4)", () => {
  test("F17: the gate's scope carries `agent_class`, so `capacity` can be indexed", () => {
    // The value resolves; the scope could not index it. `readIndexedParameter` cannot
    // index a scalar by a dimension the scope does not carry, so F17 denied on a
    // parameter the register publishes.
    const real = service.defaultSnapshot();
    const withClass = require("../../src/engine/feasibility/threeValued").readIndexedParameter(
      { get: (name) => real.resolve(name, { sla_class: null, agent_class: "class-composition" }) },
      "capacity",
      "class-composition",
    );
    expect(typeof withClass).toBe("number");
  });

  test("F19: `projectedAvailableAtMs` is written for a ready class and NOT for a busier one", () => {
    const ready = solvePath.gatedAgentSnapshot({ agentId: "a", availabilityClass: "IDLE_READY" }, DECISION_TIME_MS);
    expect(ready.projectedAvailableAtMs).toBe(DECISION_TIME_MS);

    // `FINISHING_SOON` becomes free at a time only a chaining projection can state, and
    // chaining is Tier 2. Absent is the honest answer; F19 denies and names it.
    const busy = solvePath.gatedAgentSnapshot({ agentId: "a", availabilityClass: "FINISHING_SOON" }, DECISION_TIME_MS);
    expect(busy.projectedAvailableAtMs).toBeUndefined();
  });

  test("F4/F21/F25: §2.4's Task attributes reach the mission through the Mission→Task relation", () => {
    const attributes = solvePath.taskAttributesFor({
      tasks: [{ tenantId: "tenant-a", requirements: [{ name: "cold_chain" }], payloadSpec: { thermalMinC: 2, thermalMaxC: 8 } }],
    });

    expect(attributes.tenantId).toBe("tenant-a");
    expect(attributes.requirements).toEqual([{ name: "cold_chain" }]);
    expect(attributes.payload).toEqual({ thermalMinC: 2, thermalMaxC: 8 });
  });

  test("two Tasks disagreeing leaves the attribute ABSENT — never the first one's value", () => {
    // §2.8 makes `Task >──< Mission` many-to-many. Picking the first Task's tenant would
    // let F4 certify multi-tenant isolation against one of two customers, which is the
    // permissive direction on an isolation predicate.
    const attributes = solvePath.taskAttributesFor({
      tasks: [{ tenantId: "tenant-a" }, { tenantId: "tenant-b" }],
    });

    expect(attributes.tenantId).toBeUndefined();
    expect(attributes.taskCount).toBe(2);
  });

  test("a non-list RequirementSet is not carried — F21 must not match against a shape it did not expect", () => {
    expect(solvePath.taskAttributesFor({ tasks: [{ requirements: { cold_chain: true } }] }).requirements).toBeUndefined();
  });

  test("F32: a stop carries access prerequisites only when the column STATES a list", async () => {
    const { context } = completeContext({ kv: kvHandle.kv });
    const load = solvePath.legLoaderFor(context);
    const leg = await load("leg-1");

    // The fixture's stops declare nothing, so the field is absent and F32 denies. A
    // `Json?` column nobody has populated is "nobody established what this site requires",
    // which is a different fact from "none required" — and F32 reads them differently.
    expect(leg.stops.every((stop) => stop.accessPrerequisites === undefined)).toBe(true);
  });

  test("F28/F29: the whole declared MobilityModel is mapped, not two of its columns", async () => {
    const { context } = completeContext({ kv: kvHandle.kv });
    const load = solvePath.agentSnapshotLoaderFor(context);
    const snapshot = await load("agent-row-1");

    // `permissionSet`, `envelopeConstraints` and `dimensionalFootprint` are the columns
    // F28 and F29 read. The fixture's model declares none of them, so they arrive
    // `undefined` and the predicates name them — which is the point: the mapper no longer
    // decides that they do not exist.
    expect(Object.keys(snapshot.mobilityModel).sort()).toEqual([
      "dimensionalFootprint",
      "envelopeConstraints",
      "kinematicLimits",
      "permissionSet",
      "speedModel",
      "traversalDomain",
    ]);
    expect(snapshot.mobilityModel.traversalDomain).toBe("GROUND");
  });

  test("F37: the Leg's own deadline reaches the mission — a stated deadline is not an absent one", async () => {
    const { context, store } = completeContext({ kv: kvHandle.kv });
    const assembly = solvePath.create(context);
    await assembly.deps.expandCandidates({ legId: "leg-1", shardId: SHARD_ID, decisionTimeMs: DECISION_TIME_MS, queueAgeSeconds: 60 });

    const mission = assembly.round.missionFor(assembly.round.legs.get("leg-1"));
    expect(mission.deadlineMs).toBe(store.leg.slaDeadline.getTime());

    // And F37 now *binds*, which moves it from a SATISFIED it did not earn to an honest
    // INDETERMINATE naming the input this schema has no column for.
    const verdict = require("../../src/engine/feasibility/predicates/f37").evaluate({
      mission,
      plan: { earliestFeasibleCompletionMs: DECISION_TIME_MS + 1000 },
    });
    expect(verdict.outcome).toBe("INDETERMINATE");
    expect(verdict.reason).toMatch(/contractually hard/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   G — §14.4's VENDOR STRESS CURVES: THE COLUMN THAT WAS LOADED AND NOT READ

   W-B4, repository side. The `battery wear inputs (§14.4)` requirement said its
   inputs had **no schema column**, naming `EnergyModel`. That row does hold
   `chargePowerCurve` and `thermalDeratingCurve` and no wear curve — and it is the
   wrong row. `EnergyModelParams.stressCurves` is declared for exactly this, and
   `agentSnapshotLoaderFor` already loads it onto the snapshot.

   **This closes a read path, not the requirement.** The mission half — `dod`,
   `socMid`, `tempC`, `cRate` and `socThroughput` — still has no column and no
   producer, and no test below invents one.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("G — §14.4's stress curves are read from the column that declares them (W-B4)", () => {
  const wear = require("../../src/engine/energy/wear");

  /** The mission half of §14.4, which no column carries. Supplied here, never derived. */
  function missionConditions() {
    return {
      socThroughput: 0.2,
      conditions: { dod: 0.2, socMid: 0.8, tempC: 22, cRate: 0.5 },
    };
  }

  /**
   * `Φ`'s argument set for a real built plan, with the battery seam and the
   * `EnergyModelParams` row varied independently.
   */
  function phiFor({ columnCurves, seamCurves, omitSeam }) {
    const { context, store } = completeContext({ kv: kvHandle.kv });

    const params = { ...energyModelParamsRow() };
    if (columnCurves !== undefined) params.stressCurves = columnCurves;

    const agentSnapshot = {
      agentId: "agent-1",
      agentClassId: "class-composition",
      tenantId: "tenant-a",
      lat: ORIGIN.lat,
      lon: ORIGIN.lon,
      cellId: store.fineCellId,
      lifecycleState: "ACTIVE",
      energyModel: store.agent.agentClass.energyModel,
      // The row, whole, exactly as `agentSnapshotLoaderFor` puts it on the snapshot.
      energyModelParams: params,
      energyCoefficients: require("../../src/engine/domain/mappers/decisionInputs").energyCoefficientsFrom(params),
      kappa: 1,
      soc: 0.9,
      soh: 0.95,
      containerModel: null,
      ambientC: 20,
      packC: 22,
      commitments: [],
      hardCommitmentCount: 0,
    };

    const leg = {
      legId: "leg-1",
      missionId: "mission-1",
      role: "TERMINAL",
      custodyState: "NONE",
      purpose: "PRIMARY",
      targetMs: DECISION_TIME_MS + 3_600_000,
      deadlineMs: DECISION_TIME_MS + 3_600_000,
      stops: store.leg.stops.map((stop) => ({ ...stop, cellId: solvePath.cellIdFor(stop) })),
      manifests: [],
    };

    const hops = [1, 2].map(() => ({
      distanceM: 800,
      travelSeconds: 400,
      travelSdSeconds: 20,
      climbM: 6,
      descentM: 3,
      stopStartCycles: 4,
    }));

    const built = planBuilder.build(
      solvePath.planInputFor({
        agentSnapshot,
        leg,
        hops,
        hopsForSequence: () => hops,
        snapshot: context.snapshot,
        scope: { sla_class: null },
        decisionTimeMs: DECISION_TIME_MS,
        seams: context,
        slaClass: null,
        queueAgeSeconds: 60,
      }),
    );
    expect(built.ok).toBe(true);

    const seams = { ...context };
    if (omitSeam) {
      delete seams.batteryWearInputsFor;
    } else {
      seams.batteryWearInputsFor = () => {
        const mission = missionConditions();
        return seamCurves === undefined ? mission : { ...mission, curves: seamCurves };
      };
    }

    return solvePath.phiInputFor({
      plan: built.plan,
      snapshot: context.snapshot,
      scope: { sla_class: null },
      agentSnapshot,
      leg,
      decisionTimeMs: DECISION_TIME_MS,
      seams,
      correction: { ok: false },
    });
  }

  test("the schema still declares the column this read path depends on", () => {
    // A source-of-truth assertion, not a restatement. If `EnergyModelParams.stressCurves`
    // is ever removed or renamed, the read path below silently stops finding anything and
    // the family quietly reverts to "no column" — which is the state this test exists to
    // make undeniable rather than arguable.
    const schema = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");
    const model = schema.slice(schema.indexOf("model EnergyModelParams {"));
    expect(model.slice(0, model.indexOf("\n}")).replace(/\s+/g, " ")).toMatch(/stressCurves\s+Json\?/);
  });

  test("with nothing supplying curves, the column supplies them — the defect, inverted", () => {
    // The measured defect: this value was **loaded onto the snapshot and never read**.
    // Before the fix `battery.curves` was `undefined` here even with the column populated.
    const declared = energyFixture.stressCurves();
    const phi = phiFor({ columnCurves: declared, seamCurves: undefined });

    expect(phi.phiInput.lifecycle.battery.curves).toBe(declared);

    // And it is *usable*: `wear.batteryWear` prices against it rather than naming it.
    const priced = wear.batteryWear({
      ...phi.phiInput.lifecycle.battery,
      cuPerEquivalentCycle: 40,
    });
    expect(priced.missing).not.toContain("stressCurves");
    expect(priced.ok).toBe(true);
  });

  test("an absent column stays absent — the refusal is unchanged, not softened", () => {
    // The fail-closed half, and the one that matters most. A deployment that has not
    // characterised its pack must get exactly the answer it got before: `batteryWear`
    // names `stressCurves`. Nothing is defaulted, interpolated, or assumed flat.
    const phi = phiFor({ columnCurves: null, seamCurves: undefined });

    expect(phi.phiInput.lifecycle.battery.curves).toBeUndefined();

    const priced = wear.batteryWear({
      ...phi.phiInput.lifecycle.battery,
      cuPerEquivalentCycle: 40,
    });
    expect(priced.ok).toBe(false);
    expect(priced.missing).toContain("stressCurves");
  });

  test("a non-object column is not a curve set — it stays absent too", () => {
    // `stressCurves` is `Json?`, so the column can legitimately hold a scalar or an array
    // that is not a curve set. Passing one through would put a shape `evaluateCurve`
    // cannot read where a refusal belongs.
    const phi = phiFor({ columnCurves: "not-a-curve-set", seamCurves: undefined });
    expect(phi.phiInput.lifecycle.battery.curves).toBeUndefined();
  });

  test("an injected seam value still wins over the column", () => {
    // Precedence is stated in `batteryWearInputFor` and asserted here: the column fills a
    // gap, it does not override a caller. Overriding an injected value would make every
    // existing seam-driven test assert against a row it never named.
    const seamCurves = energyFixture.stressCurves();
    const phi = phiFor({ columnCurves: { calendarAgeing: [] }, seamCurves });
    expect(phi.phiInput.lifecycle.battery.curves).toBe(seamCurves);
  });

  test("with no battery seam at all, the column is still read — and the mission half is still missing", () => {
    // The production shape today: no `batteryWearInputsFor` is composed anywhere in
    // `server.js`, so this is what the path would see. The curves resolve; `socThroughput`
    // and `conditions` do not, and `batteryWear` names them.
    //
    // **This is why the requirement row stays declared and unsatisfied.** The family was
    // narrowed by a read path, not closed by one, and a test that stopped at the curves
    // would read as though it had been closed.
    const phi = phiFor({ columnCurves: energyFixture.stressCurves(), omitSeam: true });

    expect(phi.phiInput.lifecycle.battery.curves).toBeDefined();

    const priced = wear.batteryWear({ ...phi.phiInput.lifecycle.battery, cuPerEquivalentCycle: 40 });
    expect(priced.ok).toBe(false);
    expect(priced.missing).toContain("socThroughput");
    expect(priced.missing.some((name) => String(name).startsWith("condition."))).toBe(true);
    expect(priced.missing).not.toContain("stressCurves");
  });

  test("the composition contract still declares `battery wear inputs (§14.4)` as unsatisfied", () => {
    // The load-bearing negative. Reading one column must not remove a row from the
    // coordinator's declared contract, and S-3's count must not fall because a comment was
    // corrected. `batteryWearInputsFor` is still probed and still required.
    const ids = pipeline.REQUIREMENT_IDS;
    expect(ids).toContain("battery wear inputs (§14.4)");

    const { context } = completeContext({ kv: kvHandle.kv });
    const withoutSeam = { ...context };
    delete withoutSeam.batteryWearInputsFor;
    const missing = pipeline.requirements(withoutSeam).missing.map((row) => row.input);
    expect(missing).toContain("battery wear inputs (§14.4)");
  });
});

describe("G — two AgentClass columns the snapshot mapper dropped (N-2)", () => {
  async function snapshotFor(agentClassOverrides) {
    const { context, store } = completeContext({ kv: kvHandle.kv });
    Object.assign(store.agent.agentClass, agentClassOverrides || {});
    return solvePath.agentSnapshotLoaderFor(context)("agent-1");
  }

  test("`firmwareVersionSet` reaches F5 as `supportedFirmwareByMissionType`", async () => {
    // The column F5 names in its own refusal — "the agent class's firmwareVersionSet".
    const set = { DELIVERY: ["2.4.1", "2.4.2"] };
    const snapshot = await snapshotFor({ firmwareVersionSet: set });
    expect(snapshot.supportedFirmwareByMissionType).toEqual(set);
  });

  test("`hardwareRevision` reaches F12's advisory matcher", async () => {
    const snapshot = await snapshotFor({ hardwareRevision: "rev-C" });
    expect(snapshot.hardwareRevision).toBe("rev-C");
  });

  test("an undeclared column stays absent — nothing is defaulted or inferred", async () => {
    // The fixture's AgentClass declares neither, which is what this deployment has. A
    // fabricated empty object would be a *different and false* claim: F5 reads `{}` as
    // "the class declares no supported set for this mission type", which is an
    // INDETERMINATE about a qualification act, not an ABSENT about a missing column.
    //
    // An undeclared column reaches the snapshot as `undefined` and a declared-null one as
    // `null`; both are absent to the predicates, and the assertion covers the pair rather
    // than pinning whichever the fixture happens to produce.
    const snapshot = await snapshotFor();
    expect([null, undefined]).toContain(snapshot.supportedFirmwareByMissionType);
    expect([null, undefined]).toContain(snapshot.hardwareRevision);

    const nulled = await snapshotFor({ firmwareVersionSet: null, hardwareRevision: null });
    expect(nulled.supportedFirmwareByMissionType).toBeNull();
    expect(nulled.hardwareRevision).toBeNull();
  });

  test("the value passes through unshaped — F5 owns the shape check, not the mapper", async () => {
    // Deliberate: F5 answers `absent` for a non-object, `indeterminate` for a non-array
    // member, and `indeterminate` for an unlisted mission type — three different verdicts a
    // mapper that "normalised" the column would collapse into one.
    const malformed = "2.4.1";
    const snapshot = await snapshotFor({ firmwareVersionSet: malformed });
    expect(snapshot.supportedFirmwareByMissionType).toBe(malformed);

    const f05 = require("../../src/engine/feasibility/predicates/f05");
    const verdict = f05.evaluate({
      agentSnapshot: { ...snapshot, firmwareVersion: "2.4.1" },
      mission: { missionType: "DELIVERY" },
    });
    expect(verdict.outcome).toBe("INDETERMINATE");
    expect(verdict.reason).toMatch(/the agent class.s firmwareVersionSet is absent/);
  });

  test("F5 still denies, because the attested firmware version has no read path", async () => {
    // The load-bearing negative. Supplying the class's supported set does NOT make F5
    // admit: it reads `agent.firmwareVersion` first, and that comes from a verified
    // `CapabilityAttestation` this loader does not query (N-2's recorded bucket-(a) item).
    // A test that only asserted the two new fields would let a reader conclude F5 was
    // closed.
    const snapshot = await snapshotFor({ firmwareVersionSet: { DELIVERY: ["2.4.1"] } });
    expect(snapshot.firmwareVersion).toBeUndefined();

    const f05 = require("../../src/engine/feasibility/predicates/f05");
    const verdict = f05.evaluate({ agentSnapshot: snapshot, mission: { missionType: "DELIVERY" } });
    expect(verdict.outcome).toBe("INDETERMINATE");
    expect(verdict.reason).toMatch(/attested firmware version is absent/);
  });
});

describe("G — §14.6's target SoC is resolved by its owner's client (N-1)", () => {
  const schedulerClient = require("../../src/engine/energy/chargingSchedulerClient");

  /** The scope the composition root builds for this resolver — `agent_class` included. */
  const SCOPE = { sla_class: null, agent_class: "class-composition" };

  function resolveWith(agentSnapshot, extras) {
    const { context } = completeContext({ kv: kvHandle.kv });
    return solvePath.targetSocFor({
      agentSnapshot,
      snapshot: extras && extras.snapshot ? extras.snapshot : context.snapshot,
      scope: SCOPE,
      decisionTimeMs: DECISION_TIME_MS,
    });
  }

  test("both register rows the resolver reads resolve on the PUBLISHED register", () => {
    // Not on an override map. The refusal `planBuilder.insertChargingStop` printed before
    // this fix said "neither a published target nor the class fallback resolved"; the
    // second half of that sentence was false about the shipped register, and this is the
    // assertion that keeps it false-if-it-ever-returns.
    const published = service.defaultSnapshot();
    expect(published.resolve("energy.target_soc_max_age", { region: "r1" })).toBe(300);
    expect(published.resolve("energy.target_soc_fallback", { agent_class: "class-composition" })).toBe(0.8);
  });

  test("a fresh published target is consumed, with SCHEDULER provenance", () => {
    const result = resolveWith({
      agentId: "agent-1",
      reservations: [{ subsystem: "CHARGING", targetSoc: 0.85, publishedAtMs: DECISION_TIME_MS - 60_000 }],
    });

    expect(result.targetSoc).toBe(0.85);
    expect(result.targetSocSource).toBe(schedulerClient.TARGET_SOC_SOURCE.SCHEDULER);
    expect(result.problems).toEqual([]);
    // The value is the Scheduler's, unrounded and unadjusted. §14.6's whole point.
    expect(schedulerClient.assertNotEngineComputed(result.targetSocSource).ok).toBe(true);
  });

  test("a published target older than energy.target_soc_max_age is not consumed", () => {
    const result = resolveWith({
      agentId: "agent-1",
      reservations: [{ subsystem: "CHARGING", targetSoc: 0.85, publishedAtMs: DECISION_TIME_MS - 600_000 }],
    });
    expect(result.targetSoc).toBeUndefined();
  });

  test("a target with no publication time is not consumed — age cannot be assumed", () => {
    // The shape `consumeReservations` produces carries no publication time. Attributing the
    // pinned projection's time to a reservation would assert a freshness nobody measured,
    // and in the permissive direction: it would make a stale target look current.
    const result = resolveWith({
      agentId: "agent-1",
      reservations: [{ subsystem: "CHARGING", targetSoc: 0.85, from: new Date(DECISION_TIME_MS), until: new Date(DECISION_TIME_MS + 1000) }],
    });
    expect(result.targetSoc).toBeUndefined();
  });

  test("two reservations stating different targets are refused, not reconciled", () => {
    const result = resolveWith({
      agentId: "agent-1",
      reservations: [
        { subsystem: "CHARGING", targetSoc: 0.85, publishedAtMs: DECISION_TIME_MS - 1000 },
        { subsystem: "CHARGING", targetSoc: 0.7, publishedAtMs: DECISION_TIME_MS - 1000 },
      ],
    });
    expect(result.targetSoc).toBeUndefined();
    expect(result.problems.join(" ")).toMatch(/different target states of charge/);
    // Neither value is picked, and the refusal names both.
    expect(result.problems.join(" ")).toMatch(/0\.85/);
    expect(result.problems.join(" ")).toMatch(/0\.7/);
  });

  test("a reservation held by another subsystem is not a charging target", () => {
    const result = resolveWith({
      agentId: "agent-1",
      reservations: [{ subsystem: "MAINTENANCE", targetSoc: 0.9, publishedAtMs: DECISION_TIME_MS - 1000 }],
    });
    expect(result.targetSoc).toBeUndefined();
  });

  test("§14.7's class-default substitution is DECLINED by name, not taken silently", () => {
    // The load-bearing negative of this block. The substitution is lawful under §14.6 only
    // where it is recorded as a degradation flag on every affected decision, and this
    // composition root supplies no per-Leg degradation context to `decisionRecord`. The
    // refusal must say so, and must name the value it is declining — a refusal that hid the
    // available value would be indistinguishable from the parameter being unresolved.
    const result = resolveWith({ agentId: "agent-1" });

    expect(result.targetSoc).toBeUndefined();
    expect(result.targetSocSource).toBeUndefined();
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("TARGET_SOC_CLASS_DEFAULT");
    expect(result.problems[0]).toContain("0.8");
    expect(result.problems[0]).toMatch(/degradation flag on every affected decision/);
  });

  test("the channel the declined flag would need genuinely has no producer", () => {
    // Measured, not asserted from the comment above it.
    //
    // `decisionRecord.writeRound` reads per-Leg degradations out of
    // `context.perLeg[legId].degradations`. The two workers that call it forward whatever
    // their own caller passed and construct nothing, and the composition root — the only
    // place that *sees* a degradation, because it is where the resolver runs — never
    // mentions `perLeg` at all. So the flag has nowhere to go.
    //
    // Scoped to these three files deliberately: `solve/round.js` and `cost/cDelay.js` have
    // their own unrelated `perLeg` locals (a per-Leg outcome list and a per-Leg cost
    // breakdown), and a repository-wide text search would match those and prove nothing.
    // If a real producer is ever added here, this test fails and the decline above must be
    // revisited — which is the point of pinning it.
    const fs = require("fs");
    const pathMod = require("path");
    const read = (relative) => fs.readFileSync(pathMod.join(__dirname, "../../src", relative), "utf8");

    // Pass-through only: the value forwarded is the caller's own input, never assembled.
    expect(read("workers/coordinator.worker.js")).toMatch(/perLeg:\s*input\.perLeg\s*\|\|\s*\{\}/);
    expect(read("workers/shadow.worker.js")).toMatch(/perLeg:\s*source\.perLeg\s*\|\|\s*\{\}/);

    // And the composition root, which is where a degradation is actually observed,
    // constructs no such property. (It *names* the channel, in the prose explaining why the
    // substitution is declined — so the assertion is on a `perLeg:` binding, not on the
    // word, and it would fail the moment one were written.)
    expect(read("workers/coordinatorSolvePath.js")).not.toMatch(/perLeg\s*:/);
  });

  test("the composition root supplies these two fields, which no caller used to set", () => {
    // The defect itself: `planInputFor` read `input.targetSoc` and `input.targetSocSource`
    // and nothing set them, so `insertChargingStop` refused on every plan that needed a
    // charge. The seam is asserted rather than the wiring narrated.
    const { context, store } = completeContext({ kv: kvHandle.kv });
    const built = solvePath.planInputFor({
      agentSnapshot: { agentId: "agent-1", soc: 0.4, packC: 22, energyModel: null },
      leg: { legId: "leg-1", stops: store.leg.stops, manifests: [] },
      hops: [],
      hopsForSequence: () => null,
      snapshot: context.snapshot,
      scope: SCOPE,
      decisionTimeMs: DECISION_TIME_MS,
      seams: context,
      targetSoc: 0.85,
      targetSocSource: schedulerClient.TARGET_SOC_SOURCE.SCHEDULER,
    });

    expect(built.charging.targetSoc).toBe(0.85);
    expect(built.charging.targetSocSource).toBe(schedulerClient.TARGET_SOC_SOURCE.SCHEDULER);
  });

  test("the REAL evaluateExact consults the resolver and carries its answer to the Plan Builder", async () => {
    // The wiring itself, through the production path rather than through a direct call.
    // Without this, a mutant that deletes the two fields from the `planInputFor` call site
    // survives every other test in this block, because the unit-level tests exercise
    // `targetSocFor` and `planInputFor` separately and nothing joins them.
    const route = declaredRouter();
    const { context, store } = completeContext({
      kv: kvHandle.kv,
      route,
      context: { timeBucket: "test-bucket-target-soc" },
    });
    const assembly = solvePath.create(context);
    await kvHandle.kv.sadd(availabilityIndex.fineKey(SHARD_ID, store.fineCellId, "IDLE_READY"), "agent-row-1");

    // The Scheduler's answer, injected at the module that owns the question. The resolver's
    // own behaviour is asserted above; what is under test here is that the composition root
    // asks it and uses what it says.
    const resolveSpy = jest.spyOn(schedulerClient, "resolveTargetSoc").mockReturnValue({
      ok: true,
      targetSoc: 0.85,
      source: schedulerClient.TARGET_SOC_SOURCE.SCHEDULER,
      degradationFlag: null,
      reason: null,
    });
    const buildSpy = jest.spyOn(planBuilder, "build");

    try {
      await assembly.deps.expandCandidates({
        legId: "leg-1",
        shardId: SHARD_ID,
        decisionTimeMs: DECISION_TIME_MS,
        slaClass: null,
        queueAgeSeconds: 60,
      });

      expect(resolveSpy).toHaveBeenCalled();
      const asked = resolveSpy.mock.calls[0][0];
      // The round's pinned time, never a clock read — the same rule every other input on
      // this path obeys.
      expect(asked.decisionTimeMs).toBe(DECISION_TIME_MS);
      // Read from the register, not restated in the composition root.
      expect(asked.maxAgeSeconds).toBe(300);
      expect(asked.classFallback).toBe(0.8);
      // This deployment's agent snapshot carries no reservations at all (see the §7.5
      // inventory block above), so there is no published target to be fresh.
      expect(asked.publishedTargetSoc).toBeNull();

      expect(buildSpy).toHaveBeenCalled();
      const planInput = buildSpy.mock.calls[0][0];
      expect(planInput.charging.targetSoc).toBe(0.85);
      expect(planInput.charging.targetSocSource).toBe(schedulerClient.TARGET_SOC_SOURCE.SCHEDULER);
    } finally {
      resolveSpy.mockRestore();
      buildSpy.mockRestore();
    }
  });

  test("targetSoc is NOT a 35th declared requirement, and must not become one", () => {
    // It is F35's blind spot again (§5.6.6): the dependency it needs — `prisma` — is
    // satisfied, and what is absent is *data inside* it. A dependency probe cannot see an
    // empty table at any depth of walk, so registering a row would be adding a requirement
    // the probe can never report on.
    expect(pipeline.REQUIREMENT_IDS).toHaveLength(34);
    expect(pipeline.REQUIREMENT_IDS.filter((id) => /soc|target/i.test(id))).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   E — NO FALSE END-TO-END CLAIM
   ═══════════════════════════════════════════════════════════════════════════ */

describe("E — what this suite does NOT establish", () => {
  test("the published register cannot compose, so S-6 is untouched by anything above", () => {
    // The load-bearing assertion of the whole file. Every green test above ran against a
    // snapshot with fifteen register parameters overridden in one object and a router-shaped
    // double. Against the register this repository actually publishes, with the routing
    // source that actually exists, the assembly refuses — and no test in this suite may be
    // read as evidence that a real request was assigned.
    const assembly = solvePath.create({
      snapshot: service.defaultSnapshot(),
      prisma: {},
      kv: {},
      shardId: SHARD_ID,
      runSerializable: async () => null,
      selectForUpdate: async () => null,
      signingKey: "k",
    });

    expect(assembly.ok).toBe(false);
    expect(assembly.deps).toBeUndefined();
  });

  test("`gate:composition`'s declarative row is untouched — the gate stays RED", () => {
    // Making the composer *able* to compose must not make the gate conditional. The row is
    // removed when the coordinator actually starts in production, which is the rule that
    // table sets for itself and which no context in this file satisfies.
    expect(leaderWorkers.UNCOMPOSABLE.coordinator).toBeDefined();
    expect(leaderWorkers.UNCOMPOSABLE.coordinator.external).toBe(true);
    expect(leaderWorkers.UNCOMPOSABLE.coordinator.requires).toBe(pipeline.REQUIREMENT_IDS);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   H — the execution geometry an offer carries (P0-11)
   ═══════════════════════════════════════════════════════════════════════════ */

describe("H — the offer's drivable route is resolved outside the commit transaction", () => {
  /**
   * §10.3.2's commit is a SERIALIZABLE transaction over locked rows. A provider call inside
   * it would hold those locks across an external round trip, so a slow provider response
   * would become a store-wide stall on the decision path. The **ordering** is therefore the
   * property under test: the route is fetched by the composition root before
   * `runSerializable` opens, and the `sideEffects` writer that runs inside closes over
   * already-resolved points.
   *
   * ── Why the plan is placed in the memo rather than produced by the fixture ──
   * Geometry is resolved only for a pairing that reached the commit **with a priced plan**,
   * and no fixture in this file produces one: `evaluateExact` runs the real §7.5 gate, one
   * predicate is `VIOLATED` and the rest `INDETERMINATE` against a snapshot with no routing
   * source, so nothing is ever memoised into `round.priced` (group A says as much —
   * *"whether it survived is a decision this test does not assert"*).
   *
   * So the memo is seeded with the entry `round.plan` would have written. That is a **test
   * double for the round's own memo**, not for a decision: the plan is placed there, the
   * gate is not persuaded to admit anything, and no assertion below reads a cost. It is the
   * only way to reach the geometry seam on a tree where the coordinator cannot compose.
   */
  const PRICED_PLAN = Object.freeze({
    planId: "plan-geometry-1",
    stops: Object.freeze([
      Object.freeze({ sequence: 1, stopType: "PICKUP", siteId: "site-a", lat: PICKUP.lat, lon: PICKUP.lon, projectedArrivalMs: 0, departureMs: 60_000 }),
      Object.freeze({ sequence: 2, stopType: "DROP", siteId: "site-b", lat: DROP.lat, lon: DROP.lon, projectedArrivalMs: 300_000, departureMs: 360_000 }),
    ]),
    reserves: null,
    charging: null,
  });

  /**
   * An assembly whose round has already expanded `leg-1` and priced it against the agent.
   *
   * @param {object} settings `{ directions, runSerializable }`
   */
  async function assemblyWithPricedPlan(settings) {
    const { context, store } = completeContext({
      kv: kvHandle.kv,
      context: { directions: settings.directions, timeBucket: settings.timeBucket || "geometry-bucket" },
      runSerializable: settings.runSerializable,
    });
    const assembly = solvePath.create(context);

    await assembly.deps.expandCandidates({
      legId: "leg-1",
      shardId: SHARD_ID,
      decisionTimeMs: DECISION_TIME_MS,
      queueAgeSeconds: 60,
    });

    assembly.round.priced.set(`${store.leg.legId}|${store.agent.agentId}`, { plan: PRICED_PLAN });
    return { assembly, store };
  }

  const abortingTransaction = (onOpen) => async (client, fn) => {
    if (onOpen) onOpen();
    return fn({
      commitment: { findUnique: async () => null },
      agent: { findFirst: async () => null },
      leg: { findFirst: async () => null },
    });
  };

  test("the routing provider is called, and called before the transaction opens", async () => {
    const events = [];
    const directions = jest.fn(async ({ from, to }) => {
      events.push("directions");
      return { points: [{ lat: from.lat, lon: from.lon }, { lat: to.lat, lon: to.lon }], distanceMeters: 120 };
    });

    const { assembly, store } = await assemblyWithPricedPlan({
      directions,
      runSerializable: abortingTransaction(() => events.push("transaction")),
    });

    await assembly.deps.commit(
      { legId: store.leg.legId, agentId: store.agent.agentId },
      { roundId: "round-geometry", leadershipFence: 1 },
    );

    expect(directions).toHaveBeenCalled();
    expect(events).toContain("transaction");
    expect(events.indexOf("directions")).toBeLessThan(events.indexOf("transaction"));
    // Every call is before the transaction, not merely the first.
    expect(events.lastIndexOf("directions")).toBeLessThan(events.indexOf("transaction"));
  });

  test("the first leg runs from the agent's own position, not from the first stop", async () => {
    const seen = [];
    const directions = jest.fn(async ({ from, to }) => {
      seen.push({ from, to });
      return { points: [{ lat: from.lat, lon: from.lon }, { lat: to.lat, lon: to.lon }], distanceMeters: 1 };
    });

    const { assembly, store } = await assemblyWithPricedPlan({
      directions,
      runSerializable: abortingTransaction(),
      timeBucket: "geometry-bucket-2",
    });

    await assembly.deps.commit(
      { legId: store.leg.legId, agentId: store.agent.agentId },
      { roundId: "round-geometry-2", leadershipFence: 1 },
    );

    expect(seen).toHaveLength(2);
    // A stop sequence says where to be; it does not say how to reach the first of them.
    // `ORIGIN` is where the fixture's `AgentCellPosition` puts the agent.
    expect(seen[0].from).toEqual({ lat: ORIGIN.lat, lon: ORIGIN.lon });
    expect(seen[0].to).toEqual({ lat: PICKUP.lat, lon: PICKUP.lon });
    // …and the second leg runs from the pickup to the drop.
    expect(seen[1].from).toEqual({ lat: PICKUP.lat, lon: PICKUP.lon });
    expect(seen[1].to).toEqual({ lat: DROP.lat, lon: DROP.lon });
  });

  test("a provider that cannot answer invents nothing, and the commit still reaches its guards", async () => {
    const directions = jest.fn(async () => {
      throw new Error("provider unavailable");
    });

    let opened = 0;
    const { assembly, store } = await assemblyWithPricedPlan({
      directions,
      runSerializable: abortingTransaction(() => { opened += 1; }),
      timeBucket: "geometry-bucket-3",
    });

    const outcome = await assembly.deps.commit(
      { legId: store.leg.legId, agentId: store.agent.agentId },
      { roundId: "round-geometry-3", leadershipFence: 1 },
    );

    // No geometry is attached and no straight line is substituted for it. The agent's own
    // `assessExecutability` is what refuses such an offer, by name (`NO_EXECUTABLE_PATH`),
    // which returns the Leg to QUEUED and records a feasibility observation. The commit
    // itself is unaffected and still aborts on the shipped guards.
    expect(directions).toHaveBeenCalled();
    expect(opened).toBe(1);
    expect(outcome.outcome).toBe("ABORTED");
  });

  test("the route is not the §5 routing contract — the composition still requires `route`", () => {
    // Geometry for an agent that has already been chosen is not a traversal source for
    // choosing one. `gate:composition` must not go green because a polyline exists.
    expect(pipeline.REQUIREMENT_IDS).toContain("route");
    expect(leaderWorkers.UNCOMPOSABLE.coordinator.external).toBe(true);
  });
});

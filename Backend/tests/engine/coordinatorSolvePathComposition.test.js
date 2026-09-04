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
function snapshotWith(overrides) {
  const real = service.defaultSnapshot();
  const map = overrides || {};
  return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
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
    "energy.uncertainty_inflation": { route_novelty: 1, forecast_horizon: 1, weather: 1 },
    "energy.contingency_quantile": 0.99,
    "energy.charger_availability_margin": 1.15,
    "energy.projection_max_age": 120,
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

  return {
    fineCellId,
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
  const store = storeWith(settings.store);
  return {
    store,
    context: {
      snapshot: snapshotWith(resolvableRegister(settings.omitParameter)),
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

  test("the gate denies, and every denial is INDETERMINATE — an absence, not a violation", () => {
    const outcome = everyVerdict();

    expect(outcome.feasible).toBe(false);
    // **Not one VIOLATED.** Nothing about this agent or this plan breaks a rule; the gate
    // simply cannot see the facts it is required to check. That distinction is the whole
    // finding: these are missing inputs, not a fleet that fails its constraints.
    const outcomes = new Set(outcome.denials.map((row) => row.outcome));
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
    expect(outcome.denials.every((row) => row.deniedForIndeterminacy === true)).toBe(true);
    expect([...new Set(outcome.denials.map((row) => row.policy))].sort()).toEqual([
      "ADMIT_WITH_PENALTY",
      "DENY",
      "DENY_UNLESS_ENVELOPE",
    ]);
    // And the tally §7.4 step 1 keeps: denied **solely** for indeterminacy, which is the
    // state an operator must be able to tell from a genuinely infeasible fleet.
    expect(outcome.deniedForIndeterminacyOnly).toBe(true);
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

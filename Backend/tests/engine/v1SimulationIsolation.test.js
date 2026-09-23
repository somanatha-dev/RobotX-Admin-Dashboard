"use strict";

/**
 * **V1 simplifications stay simulated.** Every input the V1 demonstration composition
 * supplies from the simulator (`DEVELOPMENT_SIMULATION`) or declares (`V1_DEMONSTRATION`)
 * must:
 *   1. answer for a simulated agent — so the V1 path is real, not vacuous;
 *   2. answer NOTHING for a physical agent — it cannot silently become a physical value;
 *   3. leave the predicate that needs the real input to deny the physical agent by name.
 *
 * Plus the unit-level failure cases the live run cannot construct cheaply: an agent beyond
 * the search radius is never evaluated, and an energy shortfall is reported as one.
 */

const composition = require("../../src/services/v1DemonstrationComposition");
const agentFacts = require("../../src/services/agentFacts.service");
const simulatedAgentState = require("../../src/simulation/simulatedAgentState");
const profile = require("../../src/services/v1DemonstrationProfile");
const planBuilder = require("../../src/engine/plan/planBuilder");
const expansion = require("../../src/engine/candidates/expansion");
const availabilityIndex = require("../../src/engine/candidates/availabilityIndex");
const cells = require("../../src/engine/spatial/cells");
const f01 = require("../../src/engine/feasibility/predicates/f01");
const f07 = require("../../src/engine/feasibility/predicates/f07");
const f08 = require("../../src/engine/feasibility/predicates/f08");
const f10 = require("../../src/engine/feasibility/predicates/f10");
const f = require("./helpers/candidateFixture");

const SIM_ENV = Object.freeze({ ENABLE_VIRTUAL_SIMULATOR: "true", V1_DEMONSTRATION_COMPOSITION: "true" });

const seams = composition.createV1DemonstrationComposition({ prisma: {}, snapshot: () => null, env: SIM_ENV });

const simulatedSnapshot = {
  agentId: "SIM-1",
  provenance: simulatedAgentState.PROVENANCE,
  cellId: null,
  mobilityModel: { speedModel: { nominalSpeedMps: 1.5 } },
  energyModel: { packNominalWh: 1000 },
};
const physicalSnapshot = { ...simulatedSnapshot, agentId: "ROBOTX-1", provenance: "PHYSICAL_DERIVED_ONLY" };

describe("every V1 simulation seam answers nothing for a physical agent", () => {
  const cases = [
    ["profileKeyFor", (s) => seams.profileKeyFor(s)],
    ["agentEnergyDeclarationsFor", (s) => seams.agentEnergyDeclarationsFor(s)],
    ["routeDescriptorFor", (s) => seams.routeDescriptorFor({ agentSnapshot: s, stops: [], decisionTimeMs: 0, horizonSeconds: 60 })],
    ["environmentForecastFor", (s) => seams.environmentForecastFor(s)],
    ["thermalStressMultiplierFor", (s) => seams.thermalStressMultiplierFor(s)],
    ["failureProbabilityFor", (s) => seams.failureProbabilityFor(s)],
    ["directionsFor", (s) => seams.directionsFor(s)],
  ];

  test.each(cases)("%s — simulated: a labelled value; physical: nothing", (_name, call) => {
    expect(call(simulatedSnapshot)).not.toBeNull();
    expect(call(simulatedSnapshot)).not.toBeUndefined();
    const physical = call(physicalSnapshot);
    expect(physical === null || physical === undefined).toBe(true);
  });

  test("environmentFor answers only for a simulated Robot row", () => {
    expect(seams.environmentFor("SIM-1", { robot: { robotId: "SIM-1", simulated: true } })).toMatchObject({ provenance: "DEVELOPMENT_SIMULATION" });
    expect(seams.environmentFor("ROBOTX-1", { robot: { robotId: "ROBOTX-1", simulated: false } })).toBeNull();
    expect(seams.environmentFor("ROBOTX-1", { robot: { robotId: "ROBOTX-1" } })).toBeNull();
  });

  test("the speed and return-leg rate answer only for a SIMULATED profile key", () => {
    const key = seams.profileKeyFor(simulatedSnapshot);
    expect(seams.speedMetresPerSecondFor(key)).toBe(1.5);
    expect(seams.returnLegEnergyWhPerMetreFor(key)).toBeGreaterThan(0);
    expect(seams.speedMetresPerSecondFor("PHYSICAL:v=1.5:wh=1000")).toBeUndefined();
    expect(seams.returnLegEnergyWhPerMetreFor("ROBOTX")).toBeUndefined();
  });

  test("a route's hazard is zero only when the route itself is a simulated one", () => {
    expect(seams.routeHazardCuFor({ route: { provenance: "DEVELOPMENT_SIMULATION" } })).toBe(0);
    expect(seams.routeHazardCuFor({ route: { provenance: "PRODUCTION_EXTERNAL" } })).toBeNull();
    expect(seams.routeHazardCuFor({ route: null })).toBeNull();
  });

  test("the composition cannot be built in a process that is not running the simulator", () => {
    expect(() => composition.createV1DemonstrationComposition({ prisma: {}, snapshot: () => null, env: {} })).toThrow(/simulator is not enabled/);
    expect(composition.composeIfEnabled({ prisma: {}, snapshot: () => null, env: { V1_DEMONSTRATION_COMPOSITION: "true" } })).toEqual({});
  });
});

describe("agentFacts — the control-plane half is simulated-only", () => {
  const prismaFor = () => ({
    agentCellPosition: { findUnique: async () => null },
    shard: { findUnique: async () => null },
    observation: { findFirst: async () => ({ observedAt: new Date(1_000), value: { lat: 1, lon: 2 }, source: "AGENT_REPORT" }) },
    chargerReservation: { findMany: async () => [] },
    zone: { findMany: async () => [{ id: "z1" }] },
  });
  const CONTROL_PLANE = ["commissioning", "operatorHold", "firmwareVersion", "calibrations", "emergencyStop", "faults", "localisation", "reliability", "advisories", "authorisedZoneIds", "maintenance"];
  const agentWith = (robot) => ({ id: "row-1", agentId: robot.robotId, regionId: "r1", robot });

  test("a simulated robot receives every control-plane fact, labelled", async () => {
    const provider = agentFacts.createAgentFactsProvider({ prisma: prismaFor() });
    const facts = await provider({ agent: agentWith({ robotId: "SIM-1", simulated: true, isOnline: true, status: "IDLE", lastSeenAt: new Date(1_000), createdAt: new Date(0) }) });
    expect(facts.provenance).toBe("DEVELOPMENT_SIMULATION");
    for (const field of CONTROL_PLANE) expect(facts[field]).not.toBeUndefined();
  });

  test("a physical robot receives only facts derived from its own rows — none is invented", async () => {
    const provider = agentFacts.createAgentFactsProvider({ prisma: prismaFor() });
    const facts = await provider({ agent: agentWith({ robotId: "ROBOTX-1", simulated: false, isOnline: true, status: "IDLE", lastSeenAt: new Date(1_000), createdAt: new Date(0) }) });
    expect(facts.provenance).toBe("PHYSICAL_DERIVED_ONLY");
    for (const field of CONTROL_PLANE) expect(facts[field]).toBeUndefined();
    // The real-row half is still there for it.
    expect(facts.session.live).toBe(true);
    expect(facts.healthTier).toBe("NOMINAL");
  });

  test("…and so the predicates that need those facts deny the physical robot by name", async () => {
    const provider = agentFacts.createAgentFactsProvider({ prisma: prismaFor() });
    const facts = await provider({ agent: agentWith({ robotId: "ROBOTX-1", simulated: false, isOnline: true, status: "IDLE", lastSeenAt: new Date(1_000) }) });
    const context = { agentSnapshot: { agentId: "ROBOTX-1", ...facts }, mission: profile.applyMissionProfile({}), decisionTimeMs: 2_000, config: { get: () => undefined } };
    for (const predicate of [f01, f07, f08, f10]) {
      expect(predicate.evaluate(context).outcome).not.toBe("SATISFIED");
    }
  });
});

describe("the V1 mission profile fills gaps and never overrides the task", () => {
  test("explicit task requirements, payload and supervision survive", () => {
    const stated = { requirements: [{ capability: "chassis", value: "DRONE" }], payload: { specId: "P1" }, supervisionRequirement: "TELEOPERATED", tenantId: "t-other" };
    const filled = profile.applyMissionProfile(stated);
    expect(filled.requirements).toEqual(stated.requirements);
    expect(filled.payload).toEqual(stated.payload);
    expect(filled.supervisionRequirement).toBe("TELEOPERATED");
    expect(filled.tenantId).toBe("t-other");
    expect(filled.profileProvenance).toBe("V1_DEMONSTRATION");
  });

  test("a declared parcel mass is used as declared — the envelope does not lighten it", () => {
    expect(profile.consignmentFor({ massKg: 10, massToleranceKg: 0.5 }).massKg).toBe(10.5);
  });
});

describe("case 3 — an agent beyond the search radius is never evaluated", () => {
  const IDLE = availabilityIndex.AVAILABILITY_CLASS.IDLE_READY;
  const originFine = cells.cellForPoint(f.ORIGIN.lat, f.ORIGIN.lon, cells.RESOLUTION.FINE);
  const farCell = cells.ringAt(originFine, 40)[0];

  test("with a 100 m radius the agent 40 rings out is not loaded, let alone offered", async () => {
    const store = {
      [`engine:idx:default:${originFine}:${IDLE}`]: ["agent-near"],
      [`engine:idx:default:${farCell}:${IDLE}`]: ["agent-far"],
    };
    const loaded = [];
    const farCentre = cells.centreOfCell(farCell);
    const snapshots = {
      "agent-near": f.agentSnapshot({ agentId: "agent-near" }),
      "agent-far": f.agentSnapshot({ agentId: "agent-far", lat: farCentre.lat, lon: farCentre.lon }),
    };
    const result = await expansion.expandCandidates({
      legId: "leg-1",
      shardId: "default",
      originLat: f.ORIGIN.lat,
      originLon: f.ORIGIN.lon,
      leg: f.legForBound(),
      decisionTimeMs: f.DECISION_TIME_MS,
      rates: f.boundRates(),
      delayParameters: f.delayParameters(),
      correction: f.zeroCorrection(),
      fleetBestCase: { maxSpeedMs: 2, kappaMin: 1, betaDistMin: 0.02 },
      targetFeasible: 5,
      maxEvaluated: 100,
      maxRadiusMetres: 100,
      optimalityToleranceMilliCU: 25_000n,
      waitUntilAvailableFor: async () => 0,
      energyFor: async () => f.energyInput(),
      kv: { async smembers(key) { return store[key] ? [...store[key]] : []; } },
      loadAgentSnapshot: async (id) => {
        loaded.push(id);
        return snapshots[id];
      },
      evaluateExact: async () => ({ feasible: true, gammaMilliCU: 1_000n, dutyCycle: 0, healthTier: 0 }),
    });
    expect(loaded).toContain("agent-near");
    expect(loaded).not.toContain("agent-far");
    expect(result.candidates.map((row) => row.agentId)).toEqual(["agent-near"]);
  });
});

describe("case 1 — an energy shortfall is reported as one", () => {
  test("the unreachable return reserve states the balance, not an unreadable projection", () => {
    const text = planBuilder.describeUnreachableReturn(
      { reachable: false, chargerId: "DEPOT-1", eReturnWh: 30, surplusWh: -12.34 },
      { usableWh: 70, floorWh: 50 },
      2.34,
    );
    expect(text).toBe("E_return: insufficient energy to return to charger DEPOT-1 — usable 70 Wh − mission 2.3 Wh − floor 50 Wh − return 30 Wh = -12.3 Wh");
  });

  test("with no charger admitted it says so", () => {
    expect(planBuilder.describeUnreachableReturn({ reachable: false, chargerId: null, considered: [{}, {}] }, {}, 1)).toMatch(/no charger admitted .*2 considered/);
  });
});

describe("task validation — a pickup that is the drop is not a delivery", () => {
  const taskService = require("../../src/services/task.service");
  const OLD = process.env.VERIFY_ARRIVAL_RADIUS_M;
  beforeAll(() => {
    process.env.VERIFY_ARRIVAL_RADIUS_M = "25";
  });
  afterAll(() => {
    if (OLD === undefined) delete process.env.VERIFY_ARRIVAL_RADIUS_M;
    else process.env.VERIFY_ARRIVAL_RADIUS_M = OLD;
  });
  const untouched = new Proxy({}, { get: () => { throw new Error("the store was touched"); } });

  test("two points within the arrival radius are refused 400 before anything is written", async () => {
    await expect(
      taskService.assignTask(untouched, { pickup: "A", drop: "B", pickupLat: 12.901151, pickupLon: 77.517575, dropLat: 12.901151, dropLon: 77.517575 }),
    ).rejects.toMatchObject({ status: 400, code: "PICKUP_EQUALS_DROP" });
  });

  test("points further apart than the radius pass this check (and go on to the next one)", async () => {
    const outcome = await taskService
      .assignTask(untouched, { pickup: "A", drop: "B", pickupLat: 12.9, pickupLon: 77.5, dropLat: 12.9003, dropLon: 77.5 })
      .catch((error) => error);
    expect(outcome.code).not.toBe("PICKUP_EQUALS_DROP");
  });
});

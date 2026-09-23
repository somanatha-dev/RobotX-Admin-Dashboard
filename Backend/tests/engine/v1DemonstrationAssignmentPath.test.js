"use strict";

/**
 * The V1 demonstration assignment path (2026-09-23) — every defect found by driving the
 * real path end to end, pinned mechanically, plus the V1 providers' honesty properties.
 *
 * Each block names the live symptom it was found by. None of these were visible to the
 * existing suite: every one is a join between two individually correct modules.
 */

const coordinatorSolvePath = require("../../src/workers/coordinatorSolvePath");
const { fleetBestCaseFrom } = require("../../src/engine/domain/mappers/decisionInputs");
const lowerBound = require("../../src/engine/candidates/lowerBound");
const simulatedAgentState = require("../../src/simulation/simulatedAgentState");
const constants = require("../../src/simulation/constants");
const profile = require("../../src/services/v1DemonstrationProfile");
const composition = require("../../src/services/v1DemonstrationComposition");
const offers = require("../../src/engine/dispatch/offers");

/* ═══════════════════════════════════════════════════════════════════════════
   1. Leg identity — "LOST_TO_ANOTHER_LEG" with one Leg and one feasible agent.
   ═══════════════════════════════════════════════════════════════════════════ */

const service = require("../../src/engine/config/service");
const demonstration = require("../../tools/config/v1DemonstrationConfig");

/**
 * The real default register, overlaid with the V1 demonstration bindings and — as a TEST
 * DOUBLE only — the two Safety rows, so `create()` genuinely assembles.
 */
function demonstrationSnapshot() {
  const real = service.defaultSnapshot();
  const map = Object.fromEntries(
    [...demonstration.bindings(), ...demonstration.executionBindings()].map((row) => [row.name, row.value]),
  );
  map["energy.model_residual_cv"] = 0.1;
  map["energy.reserve_floor_wh"] = 50;
  return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
    resolve: (name, context, options) =>
      Object.prototype.hasOwnProperty.call(map, name) ? map[name] : real.resolve(name, context, options),
    explain: (name, context, options) => {
      const explained = real.explain(name, context, options);
      return Object.prototype.hasOwnProperty.call(map, name) ? { ...explained, value: map[name] } : explained;
    },
  });
}

function assembled() {
  const snapshot = demonstrationSnapshot();
  const assembly = coordinatorSolvePath.create({
    prisma: {},
    kv: {},
    snapshot: () => snapshot,
    shardId: "s1",
    signingKey: "k",
    runSerializable: async () => null,
    selectForUpdate: async () => null,
    route: async () => ({}),
    travelTimeSpread: "TEST DOUBLE",
    speedMetresPerSecondFor: () => 1.5,
    hopTerrainSource: "TEST DOUBLE",
    timeBucket: "b",
    environmentFor: () => null,
    vehicleMassKgFor: () => null,
    failureProbabilityFor: () => null,
    routeHazardCuFor: () => null,
    batteryWearInputsFor: () => null,
    returnLegEnergyWhPerMetreFor: () => null,
  });
  if (!assembly.ok) throw new Error(`create() refused: ${assembly.blockedBy}`);
  return assembly;
}

describe("the round names a Leg the way the solver does", () => {
  test("a priced candidate memoised for a Leg is found by the WorkQueue's Leg.id", () => {
    const { round, deps } = assembled();
    round.rememberLeg({ leg: { legId: "LEG-1", legRowId: "row-uuid-1" } });
    round.agentIdentity.set("agent-row-1", "agent-row-1");
    const entry = { legId: "row-uuid-1", agentId: "A-1" };
    round.priced.set("LEG-1|agent-row-1", entry);

    // The solver asks with the row id (WorkQueue.legId → Leg.id). Before the fix: null.
    expect(deps.pricedCandidateFor("agent-row-1", "row-uuid-1")).toBe(entry);
    expect(deps.pricedCandidateFor("agent-row-1", "LEG-1")).toBe(entry);
  });

  test("an identifier the round never loaded maps to itself — never to a guess", () => {
    const { round } = assembled();
    round.rememberLeg({ leg: { legId: "LEG-1", legRowId: "row-uuid-1" } });
    expect(round.canonicalLegId("row-uuid-1")).toBe("LEG-1");
    expect(round.canonicalLegId("row-uuid-2")).toBe("row-uuid-2");
  });

  test("the round boundary forgets every Leg identity", () => {
    const { round, planState } = assembled();
    round.rememberLeg({ leg: { legId: "LEG-1", legRowId: "row-uuid-1" } });
    planState.beginRound("r-2");
    expect(round.canonicalLegId("row-uuid-1")).toBe("row-uuid-1");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. §7.5 F19 / F20 derivations — never a permissive default.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("latestFeasibleStartFor (F19)", () => {
  test("a deadline bounds the start by the plan's own duration", () => {
    const leg = { deadlineMs: 10_000 };
    const plan = { projectedStartMs: 1_000, projectedEndMs: 4_000 };
    expect(coordinatorSolvePath.latestFeasibleStartFor(leg, plan, 0, 900)).toBe(7_000);
  });

  test("no deadline: the commitment horizon is the bound", () => {
    expect(coordinatorSolvePath.latestFeasibleStartFor({}, {}, 5_000, 900)).toBe(905_000);
  });

  test("nothing resolvable: absent, so F19 denies", () => {
    expect(coordinatorSolvePath.latestFeasibleStartFor({}, {}, 5_000, undefined)).toBeUndefined();
  });
});

describe("legExclusionsFor (F20)", () => {
  const released = new Date("2026-09-23T00:00:00Z");

  test("no history: an empty, readable exclusion set", () => {
    expect(coordinatorSolvePath.legExclusionsFor([], "a1", 120)).toEqual({
      isIncumbent: false,
      reassignmentsSoFar: 0,
      cooloffUntil: null,
      nackCooloffUntil: null,
    });
  });

  test("a released commitment of this pairing starts the NACK cooloff", () => {
    const out = coordinatorSolvePath.legExclusionsFor([{ agentId: "a1", releasedAt: released }], "a1", 120);
    expect(out.nackCooloffUntil).toBe(released.getTime() + 120_000);
    expect(out.reassignmentsSoFar).toBe(1);
  });

  test("another agent's release counts as a reassignment, not this agent's cooloff", () => {
    const out = coordinatorSolvePath.legExclusionsFor([{ agentId: "a2", releasedAt: released }], "a1", 120);
    expect(out.nackCooloffUntil).toBeNull();
    expect(out.reassignmentsSoFar).toBe(1);
  });

  test("a prior release with no resolvable cooloff fails closed", () => {
    expect(coordinatorSolvePath.legExclusionsFor([{ agentId: "a1", releasedAt: released }], "a1", undefined)).toBeNull();
  });

  test("a live commitment of this agent makes it the incumbent", () => {
    expect(coordinatorSolvePath.legExclusionsFor([{ agentId: "a1", releasedAt: null }], "a1", 120).isIncumbent).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. The commissioning key `maxSpeedMps` — discovery evaluated no agent at all.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the kinematic limit commissioning writes is the one the search reads", () => {
  const agentClass = (limits) => ({
    agent: {
      agentClass: {
        mobilityModel: { kinematicLimits: limits },
        energyModelParams: [{ betaDist: 0, betaMass: 0, betaClimb: 0, betaRegen: 0, etaRegen: 0, betaMoveTime: 0.1, betaStopStart: 0, betaDwell: 0, betaAux: 0.04 }],
      },
    },
  });

  test("fleetBestCaseFrom reads maxSpeedMps", () => {
    expect(fleetBestCaseFrom([agentClass({ maxSpeedMps: 2 })])).toMatchObject({ maxSpeedMs: 2 });
  });

  test("the older maxSpeedMs spelling still resolves", () => {
    expect(fleetBestCaseFrom([agentClass({ maxSpeedMs: 3 })])).toMatchObject({ maxSpeedMs: 3 });
  });

  test("lowerBound does not report the limit missing for a commissioned agent", () => {
    const out = lowerBound.lowerBound({ agent: { lat: 12.9, lon: 77.5, mobilityModel: { kinematicLimits: { maxSpeedMps: 2 } } } });
    expect(out.missing).not.toContain("agent.mobilityModel.kinematicLimits.maxSpeedMs");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. SimulatedAgentState — derived from the simulator, labelled, never permissive.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the simulated pack's coefficients are the simulator's own drain constants", () => {
  test("β_aux is the idle draw and β_aux + β_move_time the active draw", () => {
    const beta = simulatedAgentState.simulatedEnergyCoefficients(1000);
    const tick = constants.TELEMETRY_INTERVAL_MS / 1000;
    expect(beta.betaAux).toBeCloseTo(((constants.BATTERY_DRAIN_IDLE / 100) * 1000) / tick, 10);
    expect(beta.betaAux + beta.betaMoveTime).toBeCloseTo(((constants.BATTERY_DRAIN_ACTIVE / 100) * 1000) / tick, 10);
  });

  test("the draw scales with the unit's own pack (the simulator drains a percentage)", () => {
    expect(simulatedAgentState.simulatedEnergyCoefficients(500).betaAux).toBeCloseTo(
      simulatedAgentState.simulatedEnergyCoefficients(1000).betaAux / 2,
      10,
    );
  });

  test("the floor is the simulator's own clamp, as a fraction of the pack", () => {
    expect(simulatedAgentState.simulatedPackDeclaration(1000).reserveFloorWh).toBe((constants.BATTERY_MIN / 100) * 1000);
  });
});

describe("simulatedAgentFacts", () => {
  const robot = { robotId: "SIM-1", status: "IDLE", createdAt: new Date("2026-09-01"), lastSeenAt: new Date("2026-09-23T00:00:00Z") };

  test("every fact is labelled DEVELOPMENT_SIMULATION", () => {
    expect(simulatedAgentState.simulatedAgentFacts({ robot, regionZoneIds: ["z1"] }).provenance).toBe("DEVELOPMENT_SIMULATION");
  });

  test("a PAUSED unit is held (an operator STOP or a charging dock)", () => {
    const facts = simulatedAgentState.simulatedAgentFacts({ robot: { ...robot, status: "PAUSED" }, regionZoneIds: [] });
    expect(facts.operatorHold.held).toBe(true);
  });

  test("ERROR is a BLOCKING fault and ISSUES a DEGRADED one", () => {
    expect(simulatedAgentState.simulatedAgentFacts({ robot: { ...robot, status: "ERROR" } }).faults[0].severity).toBe("BLOCKING");
    expect(simulatedAgentState.simulatedAgentFacts({ robot: { ...robot, status: "ISSUES" } }).faults[0].severity).toBe("DEGRADED");
  });

  test("no telemetry, no e-stop reading — F7 then denies", () => {
    expect(simulatedAgentState.simulatedAgentFacts({ robot: { ...robot, lastSeenAt: null } }).emergencyStop).toBeNull();
  });

  test("the e-stop reading is stamped at the last telemetry, so it goes stale with it", () => {
    expect(simulatedAgentState.simulatedAgentFacts({ robot }).emergencyStop.observedAt).toEqual(robot.lastSeenAt);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. The V1 mission profile — fills only what nobody stated.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("applyMissionProfile", () => {
  test("a Task-stated tenant is never overridden (F4 stays meaningful)", () => {
    expect(profile.applyMissionProfile({ tenantId: "other" }).tenantId).toBe("other");
  });

  test("absent attributes take the V1 declaration", () => {
    const mission = profile.applyMissionProfile({});
    expect(mission).toMatchObject({ missionType: "DELIVERY", supervisionRequirement: "AUTONOMOUS", requiredHealthTier: "NOMINAL", deadlineIsContractuallyHard: false });
    expect(mission.requirements).toEqual([]);
  });
});

describe("consignmentFor — mass is real, geometry is the declared envelope", () => {
  test("an undeclared parcel is taken at the envelope's maximum mass", () => {
    expect(profile.consignmentFor(null).items[0].massKg).toBe(profile.SERVICE_ENVELOPE.parcel.maxMassKg);
  });

  test("a declared mass and tolerance are kept", () => {
    const item = profile.consignmentFor({ massKg: 4, massToleranceKg: 0.5 }).items[0];
    expect(item).toMatchObject({ massKg: 4, massToleranceKg: 0.5 });
  });

  test("the item volume is derived from its dimensions", () => {
    const item = profile.consignmentFor(null).items[0];
    expect(item.volumeLitres).toBeCloseTo((item.lengthMm * item.widthMm * item.heightMm) / 1e6, 10);
  });

  test("the undeclared-parcel mass fits every preset after F22's safety factor", () => {
    // LIGHT preset: 3 kg × 0.9 = 2.7 kg.
    expect(profile.SERVICE_ENVELOPE.parcel.maxMassKg).toBeLessThanOrEqual(3 * 0.9);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. The composition answers only for simulated agents.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("simulated routing profiles route an agent at the speed it drives", () => {
  const simulated = { provenance: "DEVELOPMENT_SIMULATION", mobilityModel: { speedModel: { nominalSpeedMps: 1.5 } }, energyModel: { packNominalWh: 1000 } };

  test("the profile key carries the commissioned speed, and the speed seam reads it back", () => {
    const key = composition.simulatedProfileKeyFor(simulated);
    expect(composition.speedForProfile(key)).toBe(1.5);
  });

  test("a physical agent gets no simulated profile, speed or return-leg rate", () => {
    const physical = { ...simulated, provenance: "PHYSICAL_DERIVED_ONLY" };
    expect(composition.simulatedProfileKeyFor(physical)).toBeNull();
    expect(composition.speedForProfile("GROUND")).toBeUndefined();
    expect(composition.simulatedWhPerMetre("GROUND")).toBeUndefined();
  });

  test("the return-leg rate is the pack's declared draw over the driven speed", () => {
    const key = composition.simulatedProfileKeyFor(simulated);
    const beta = simulatedAgentState.simulatedEnergyCoefficients(1000);
    expect(composition.simulatedWhPerMetre(key)).toBeCloseTo((beta.betaAux + beta.betaMoveTime) / 1.5, 10);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   7. §23.3 — an OFFER is addressed to the agent's wire identity.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("enqueueOffer signs for the addressee the agent checks against", () => {
  const commandSigning = require("../../src/engine/security/commandSigning");
  const KEY = "v1-demonstration-test-signing-key-32b";

  function txDouble() {
    const rows = [];
    return {
      rows,
      outbox: {
        findMany: async () => [],
        findUnique: async () => null,
        create: async ({ data }) => {
          rows.push(data);
          return data;
        },
      },
    };
  }

  async function signedOffer(addressee) {
    const tx = txDouble();
    await offers.enqueueOffer(tx, {
      commitment: { commitmentId: "c-1", agentId: "agent-row-uuid", legId: "leg-row", fence: 1n },
      storeTime: new Date("2026-09-23T00:00:00Z"),
      offerTtlSeconds: 20,
      signingKey: KEY,
      ...(addressee === undefined ? {} : { addressee }),
      offer: {},
    });
    expect(tx.rows).toHaveLength(1);
    return tx.rows[0];
  }

  function verifiesFor(row, agentId) {
    return commandSigning.verify(
      {
        agentId,
        command: row.command,
        commandClass: row.commandClass,
        fenceScope: row.fenceScope,
        commitmentId: row.commitmentId,
        fence: row.fence === null || row.fence === undefined ? null : BigInt(row.fence),
        authorityEpoch: row.authorityEpoch === null || row.authorityEpoch === undefined ? null : BigInt(row.authorityEpoch),
        fenceFloor: row.fenceFloor === null || row.fenceFloor === undefined ? null : BigInt(row.fenceFloor),
        sequence: row.sequence,
        notValidAfter: row.notValidAfter,
        payload: row.payload,
      },
      row.signature,
      KEY,
    );
  }

  test("the signature verifies for the robot code, and the Outbox row keeps the Agent row id", async () => {
    const row = await signedOffer("SIM-ROBOT-1");
    expect(row.agentId).toBe("agent-row-uuid");
    const verdict = verifiesFor(row, "SIM-ROBOT-1");
    expect(verdict === true || (verdict && verdict.ok === true) || (verdict && verdict.valid === true)).toBe(true);
  });

  test("without an addressee the row id is signed, as before", async () => {
    const row = await signedOffer(undefined);
    const verdict = verifiesFor(row, "agent-row-uuid");
    expect(verdict === true || (verdict && verdict.ok === true) || (verdict && verdict.valid === true)).toBe(true);
  });
});

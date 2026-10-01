/**
 * T1 — the commissioning-time producer for `EnergyModelParams` and `BatteryState`.
 *
 * The claim under test is narrow and mostly negative: commissioning a **simulated** unit
 * now creates both rows, it is idempotent, and — the part that matters most — it writes
 * **no physical value that nobody declared**. A producer that filled `soh: 1.0` and a
 * plausible `beta_dist` would satisfy every "the row exists" assertion and would be
 * exactly the fabrication this programme refuses, so most of what follows checks that
 * specific columns are `null`.
 */

const provisioning = require("../../../src/services/agentEnergyProvisioning.service");
const robotService = require("../../../src/services/robot.service");
const { createMockPrisma } = require("../../helpers/mockPrisma");

/** A transaction client that records every energy write and answers like Prisma. */
function makeEnergyTx() {
  const batteryRows = new Map();
  const paramRows = new Map();

  return {
    batteryRows,
    paramRows,
    batteryState: {
      upsert: jest.fn(async ({ where, create, update }) => {
        const key = where.agentId;
        if (batteryRows.has(key)) {
          // Prisma's update branch merges; an empty update changes nothing.
          const merged = { ...batteryRows.get(key), ...(update || {}) };
          batteryRows.set(key, merged);
          return merged;
        }
        const row = { id: `bs-${batteryRows.size + 1}`, ...create };
        batteryRows.set(key, row);
        return row;
      }),
    },
    energyModelParams: {
      upsert: jest.fn(async ({ where, create, update }) => {
        const key = `${where.agentClassId_modelVersion.agentClassId}:${where.agentClassId_modelVersion.modelVersion}`;
        if (paramRows.has(key)) {
          const merged = { ...paramRows.get(key), ...(update || {}) };
          paramRows.set(key, merged);
          return merged;
        }
        const row = { id: `emp-${paramRows.size + 1}`, ...create };
        paramRows.set(key, row);
        return row;
      }),
    },
  };
}

describe("T1 — energy provisioning at commissioning", () => {
  test("it creates exactly one BatteryState and one EnergyModelParams", async () => {
    const tx = makeEnergyTx();

    await provisioning.provisionAgentEnergyState(tx, {
      agentRowId: "agent-1",
      agentClassRowId: "class-1",
      initialBatteryPct: 80,
    });

    expect(tx.batteryState.upsert).toHaveBeenCalledTimes(1);
    expect(tx.energyModelParams.upsert).toHaveBeenCalledTimes(1);
    expect(tx.batteryRows.size).toBe(1);
    expect(tx.paramRows.size).toBe(1);
  });

  test("κ is the identity **and** its sample count is zero — the pair, not either half", async () => {
    const tx = makeEnergyTx();
    await provisioning.provisionAgentEnergyState(tx, {
      agentRowId: "agent-1",
      agentClassRowId: "class-1",
      initialBatteryPct: 80,
    });

    const battery = tx.batteryRows.get("agent-1");
    expect(battery.kappa).toBe(1);
    // The load-bearing assertion. `kappa: 1` with a positive sample count would claim
    // missions were observed and came out at unity; zero says nothing has been measured.
    expect(battery.kappaSampleCount).toBe(0);
    expect(battery.kappaUpdatedAt).toBeNull();
  });

  test("no physical measurement is fabricated: SoH and every resistance stay null", async () => {
    const tx = makeEnergyTx();
    await provisioning.provisionAgentEnergyState(tx, {
      agentRowId: "agent-1",
      agentClassRowId: "class-1",
      initialBatteryPct: 100,
    });

    const battery = tx.batteryRows.get("agent-1");
    // A new pack is conventionally 1.0, and writing that would be a fabricated
    // calibration §14.5's usable-energy model would then reason from.
    expect(battery.soh).toBeNull();
    expect(battery.internalResistanceMilliOhm).toBeNull();
    expect(battery.baselineResistanceMilliOhm).toBeNull();
    expect(battery.resistanceTrendPerCycle).toBeNull();
  });

  test("counters start at zero rather than being estimated", async () => {
    const tx = makeEnergyTx();
    await provisioning.provisionAgentEnergyState(tx, {
      agentRowId: "agent-1",
      agentClassRowId: "class-1",
      initialBatteryPct: 55,
    });

    const battery = tx.batteryRows.get("agent-1");
    expect(battery.socThroughput).toBe(0);
    expect(battery.cycleCount).toBe(0);
  });

  test("residualCv is null, and so is every §14.2 coefficient", async () => {
    const tx = makeEnergyTx();
    await provisioning.provisionAgentEnergyState(tx, {
      agentRowId: "agent-1",
      agentClassRowId: "class-1",
      initialBatteryPct: 90,
    });

    const params = tx.paramRows.get("class-1:1");
    expect(params.residualCv).toBeNull();
    expect(params.fittedAt).toBeNull();

    for (const column of [
      "betaDist", "betaMass", "betaClimb", "betaRegen", "betaMoveTime",
      "betaStopStart", "betaDwell", "betaAux", "etaRegen",
      "betaThermal", "betaPayloadThermal", "stressCurves",
    ]) {
      expect(params[column]).toBeNull();
    }
  });

  test("the declared initial SoC is stored as a [0,1] fraction, not a percentage", async () => {
    const tx = makeEnergyTx();
    await provisioning.provisionAgentEnergyState(tx, {
      agentRowId: "agent-1",
      agentClassRowId: "class-1",
      initialBatteryPct: 42,
    });

    // `energy/usable.js` validates `soc < 0 || soc > 1`; storing 42 would be silently out
    // of range and would make every usable-energy computation refuse for the wrong reason.
    expect(tx.batteryRows.get("agent-1").lastObservedSoc).toBeCloseTo(0.42, 10);
  });

  test("an unstated state of charge is stored as null, never defaulted to full", async () => {
    const tx = makeEnergyTx();
    await provisioning.provisionAgentEnergyState(tx, {
      agentRowId: "agent-1",
      agentClassRowId: "class-1",
      initialBatteryPct: null,
    });

    const battery = tx.batteryRows.get("agent-1");
    expect(battery.lastObservedSoc).toBeNull();
    // No level means no observation instant either.
    expect(battery.lastObservedAt).toBeNull();
  });

  test("it is idempotent: applying twice converges rather than duplicating", async () => {
    const tx = makeEnergyTx();
    const input = { agentRowId: "agent-1", agentClassRowId: "class-1", initialBatteryPct: 70 };

    await provisioning.provisionAgentEnergyState(tx, input);
    await provisioning.provisionAgentEnergyState(tx, input);

    expect(tx.batteryRows.size).toBe(1);
    expect(tx.paramRows.size).toBe(1);
  });

  test("re-provisioning does NOT reset a κ calibration has since moved", async () => {
    const tx = makeEnergyTx();
    const input = { agentRowId: "agent-1", agentClassRowId: "class-1", initialBatteryPct: 70 };

    await provisioning.provisionAgentEnergyState(tx, input);

    // `energyCalibration.worker` moves κ at settlement.
    tx.batteryRows.set("agent-1", {
      ...tx.batteryRows.get("agent-1"),
      kappa: 1.12,
      kappaSampleCount: 9,
    });

    await provisioning.provisionAgentEnergyState(tx, input);

    // Idempotence means "converges on the same row", not "rewrites the row". A producer
    // that reset κ here would silently discard nine missions of calibration.
    expect(tx.batteryRows.get("agent-1").kappa).toBe(1.12);
    expect(tx.batteryRows.get("agent-1").kappaSampleCount).toBe(9);
  });

  test("it refuses without the identifiers its rows key on, rather than writing a partial row", async () => {
    const tx = makeEnergyTx();
    await expect(
      provisioning.provisionAgentEnergyState(tx, { agentClassRowId: "class-1" }),
    ).rejects.toThrow(/Agent row id/);
    await expect(
      provisioning.provisionAgentEnergyState(tx, { agentRowId: "agent-1" }),
    ).rejects.toThrow(/AgentClass row id/);
    expect(tx.batteryState.upsert).not.toHaveBeenCalled();
  });
});

describe("T1 — integration with the one shared commissioning transaction", () => {
  const specification = {
    massKg: 2,
    maxSpeedMps: 2.5,
    normalSpeedMps: 1.5,
    batteryCapacityWh: 500,
    batteryReservePct: 15,
    payloadCapacityKg: 5,
    initialBatteryPct: 80,
  };

  function primeCommissioning(prisma) {
    prisma.robot.findUnique.mockResolvedValue(null);
    prisma.location.findUnique.mockResolvedValue({ id: "loc-1", lat: 12.9, lon: 77.5 });
    prisma.robot.create.mockImplementation(async ({ data }) => ({ id: "robot-row-1", ...data }));
    prisma.agentClass.upsert.mockResolvedValue({ id: "class-1", classId: "AC-X" });
    prisma.mobilityModel.upsert.mockResolvedValue({ id: "mob-1" });
    prisma.energyModel.upsert.mockResolvedValue({ id: "eng-1" });
    prisma.containerModel.upsert.mockResolvedValue({ id: "ctr-1" });
    prisma.capabilityBundle.upsert.mockResolvedValue({ id: "bundle-1" });
    prisma.capability.deleteMany.mockResolvedValue({ count: 0 });
    prisma.capability.createMany.mockResolvedValue({ count: 0 });
    prisma.agent.upsert.mockResolvedValue({ id: "agent-row-1" });
    prisma.robot.findUnique.mockResolvedValueOnce(null);
  }

  test("creating a SIMULATED unit provisions both energy rows in the same transaction", async () => {
    const prisma = createMockPrisma();
    primeCommissioning(prisma);

    await robotService.createRobotWithProjection(
      prisma,
      { locationId: "loc-1", chassisType: "ROVER", specification },
      { robotCode: "SIM-A", simulated: true, simulationOwnerId: "user-1" },
    );

    expect(prisma.batteryState.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.energyModelParams.upsert).toHaveBeenCalledTimes(1);

    const battery = prisma.batteryState.upsert.mock.calls[0][0].create;
    expect(battery.agentId).toBe("agent-row-1");
    expect(battery.kappa).toBe(1);
    expect(battery.kappaSampleCount).toBe(0);
    expect(battery.soh).toBeNull();
    expect(battery.lastObservedSoc).toBeCloseTo(0.8, 10);
  });

  test("creating a PHYSICAL unit provisions neither — no telemetry is fabricated for hardware", async () => {
    const prisma = createMockPrisma();
    primeCommissioning(prisma);

    await robotService.createRobotWithProjection(
      prisma,
      { locationId: "loc-1", chassisType: "ROVER", specification },
      { robotCode: "PHYS-A", simulated: false, simulationOwnerId: null },
    );

    // `lastObservedSoc` is an observation. Nobody has connected to this hardware, so
    // recording the operator's typed number as an observed state of charge would be
    // fabricated telemetry. A physical unit stays fail-closed with no BatteryState.
    expect(prisma.batteryState.upsert).not.toHaveBeenCalled();
    expect(prisma.energyModelParams.upsert).not.toHaveBeenCalled();
  });
});

describe("T1 — the provisioned parameter row widens nothing", () => {
  const consumption = require("../../../src/engine/energy/consumption");
  const { energyCoefficientsFrom } = require("../../../src/engine/domain/mappers/decisionInputs");

  const completeProfile = {
    distanceM: 100, climbM: 0, descentM: 0, movingSeconds: 60, dwellSeconds: 0,
    totalSeconds: 60, stopStartCycles: 1, payloadMassKg: 1, vehicleMassKg: 2,
    ambientC: 28, packC: 30,
  };

  test("an all-null row refuses exactly as an absent row does — it only names better", () => {
    const absent = consumption.legEnergyWh(null, completeProfile, 1);
    expect(absent.ok).toBe(false);

    // The row this producer actually writes.
    const provisioned = energyCoefficientsFrom({
      betaDist: null, betaMass: null, betaClimb: null, betaRegen: null,
      betaMoveTime: null, betaStopStart: null, betaDwell: null, betaAux: null,
      etaRegen: null, betaThermal: null, betaPayloadThermal: null,
    });
    const withRow = consumption.legEnergyWh(provisioned, completeProfile, 1);

    // Still refuses — the verdict does not move — but now names the coefficients an owner
    // has to supply instead of reporting the row as missing.
    expect(withRow.ok).toBe(false);
    expect(absent.missing).toContain("energyModelParams");
    expect(withRow.missing).toEqual(expect.arrayContaining(["beta_dist", "beta_mass", "beta_thermal"]));
    expect(withRow.missing).not.toContain("energyModelParams");
  });
});

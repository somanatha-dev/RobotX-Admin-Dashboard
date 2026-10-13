"use strict";

/**
 * Decision 4 (2026-10-13) — a PHYSICAL robot's reserve floor respects BOTH valid policies and takes
 * the stricter: the owner's declaration (`energy.reserveFloorWh`, the physical deployment file) and
 * the robot's commissioned `Robot.batteryReservePct` of its commissioned pack
 * (`EnergyModel.packNominalWh`), both carried on the agent snapshot.
 *
 *   floor = max(declared reserveFloorWh, pack × batteryReservePct / 100)
 *
 * Nothing simulator-only enters it: `SIM_FIXED_RESERVE_WH` and the simulator's energy policy are
 * not read. No battery reading is involved — the floor is a Wh quantity; whether the physical
 * state of charge is trustworthy is the separate, existing operator-declared SoC policy.
 * A commissioned percentage that is not a number in [0, 100], or a pack that is not known, adds
 * nothing: the declaration still applies, never weakened.
 */

const physicalProvider = require("../../src/services/fleetProviders/physicalProvider");
const physicalPolicy = require("../../src/services/fleetProviders/physicalPolicy");
const energyPolicy = require("../../src/simulation/energyPolicy");

const ROBOT_ID = "RBT-PHYS-RESERVE";
const DECLARED_FLOOR_WH = 15;

const policy = physicalPolicy.fromDeclaration({
  declaredBy: "test owner",
  declaredAt: "2026-10-13",
  charging: { policy: "MANUAL_OUT_OF_SERVICE" },
  stateOfCharge: { policy: "OPERATOR_DECLARED", maxAgeSeconds: 7200 },
  emergencyStop: { mechanism: "SOFTWARE_STOP_LATCH" },
  site: { ambientC: { min: 18, max: 38 }, terrain: "FLAT_DECLARED", connectivityDeadZones: "NONE_DECLARED", constrictions: "NONE_DECLARED", stopStartCyclesPerHop: 1, snapRadiusM: 50 },
  localisation: { referenceRadiusM: 25, acceptedFixTypes: ["3D", "RTK_FLOAT", "RTK_FIXED"] },
  risk: { failureProbabilityPrior: 0.05, routeHazardCu: 0 },
  robots: [
    {
      robotId: ROBOT_ID,
      control: {
        firmwareVersion: "robotx-pi-agent/0.9.0",
        hardwareRevision: "rover-rev-a",
        missionTypes: ["DELIVERY"],
        calibrations: [],
        serviceDueAt: "2027-01-01T00:00:00Z",
        regionId: "rnsit",
        authorisation: "REGION",
        advisories: [],
        operatingAmbientC: { min: 0, max: 45 },
      },
      energy: { idlePowerW: 6, movingPowerW: 30, soh: 0.9, residualCv: 0.2, reserveFloorWh: DECLARED_FLOOR_WH },
    },
  ],
});

const physical = physicalProvider.createPhysicalProvider({ prisma: {}, policy });
const snapshot = (overrides) => ({ agentId: ROBOT_ID, energyModel: { packNominalWh: 200 }, batteryReservePct: null, ...(overrides || {}) });
const floorOf = (overrides) => physical.seams.agentEnergyDeclarationsFor(snapshot(overrides)).reserveFloorWh;

test("the declaration loads (fixture sanity)", () => {
  expect(policy.problems).toEqual([]);
  expect(policy.robotFor(ROBOT_ID)).not.toBeNull();
});

describe("the stricter of the two valid policies", () => {
  test("commissioned 15 % of a 200 Wh pack (30 Wh) is stricter than the declared 15 Wh → 30 Wh", () => {
    expect(floorOf({ batteryReservePct: 15 })).toBe(30);
  });

  test("commissioned 5 % (10 Wh) is weaker than the declared 15 Wh → the declaration stands (15 Wh)", () => {
    expect(floorOf({ batteryReservePct: 5 })).toBe(DECLARED_FLOOR_WH);
  });

  test("the declaration is never relaxed: 0 % commissioned → 15 Wh", () => {
    expect(floorOf({ batteryReservePct: 0 })).toBe(DECLARED_FLOOR_WH);
  });

  test("the rest of the declaration is unchanged (residual CV, provenance)", () => {
    expect(physical.seams.agentEnergyDeclarationsFor(snapshot({ batteryReservePct: 15 }))).toMatchObject({ residualCv: 0.2, provenance: physicalPolicy.PROVENANCE });
  });
});

describe("no authoritative commissioned value → the declaration alone (nothing invented)", () => {
  test.each([
    ["no commissioned percentage", { batteryReservePct: null }],
    ["a percentage above 100", { batteryReservePct: 150 }],
    ["a negative percentage", { batteryReservePct: -1 }],
    ["a percentage that is not a number", { batteryReservePct: "15" }],
    ["no commissioned pack", { batteryReservePct: 15, energyModel: null }],
    ["a pack of 0 Wh", { batteryReservePct: 15, energyModel: { packNominalWh: 0 } }],
  ])("%s → %s Wh declared", (_label, overrides) => {
    expect(floorOf(overrides)).toBe(DECLARED_FLOOR_WH);
  });

  test("an undeclared robot still has no declarations (null), whatever it was commissioned with", () => {
    expect(physical.seams.agentEnergyDeclarationsFor({ agentId: "RBT-UNDECLARED", energyModel: { packNominalWh: 200 }, batteryReservePct: 15 })).toBeNull();
  });
});

describe("a simulator-only setting does not reach a physical robot", () => {
  const before = process.env.SIM_FIXED_RESERVE_WH;
  afterEach(() => {
    if (before === undefined) delete process.env.SIM_FIXED_RESERVE_WH;
    else process.env.SIM_FIXED_RESERVE_WH = before;
    energyPolicy.resetForTests();
  });

  test("SIM_FIXED_RESERVE_WH=100 changes nothing: 30 Wh, not 130 Wh", () => {
    process.env.SIM_FIXED_RESERVE_WH = "100";
    energyPolicy.resetForTests();
    expect(energyPolicy.policy().fixedReserveWh).toBe(100);
    expect(floorOf({ batteryReservePct: 15 })).toBe(30);
  });
});

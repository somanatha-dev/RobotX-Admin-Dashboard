/**
 * Commissioning — the type reaches the backend, the specification persists, and the
 * initial battery is entered rather than invented.
 */

const robotService = require("../../../src/services/robot.service");
const { createMockPrisma } = require("../../helpers/mockPrisma");

const SPEC = Object.freeze({
  massKg: 45,
  maxSpeedMps: 2.5,
  normalSpeedMps: 1.4,
  batteryCapacityWh: 500,
  batteryReservePct: 15,
  payloadCapacityKg: 20,
  initialBatteryPct: 82,
});

function commissioningPrisma() {
  const prisma = createMockPrisma();

  prisma.robot.findUnique.mockResolvedValue(null);
  prisma.location.findUnique.mockResolvedValue({ id: "loc-1", lat: 12.9, lon: 77.5 });
  prisma.robot.create = jest.fn(async ({ data }) => ({ id: "robot-row-1", ...data }));

  prisma.mobilityModel.upsert.mockImplementation(async ({ create }) => ({ id: "mob-1", ...create }));
  prisma.energyModel.upsert.mockImplementation(async ({ create }) => ({ id: "eng-1", ...create }));
  prisma.containerModel.upsert.mockImplementation(async ({ create }) => ({ id: "ctr-1", ...create }));
  prisma.capabilityBundle.upsert.mockImplementation(async ({ create }) => ({ id: "cap-1", ...create }));
  prisma.capability.deleteMany.mockResolvedValue({ count: 0 });
  prisma.capability.create.mockImplementation(async ({ data }) => data);
  prisma.agentClass.upsert.mockImplementation(async ({ create }) => ({ id: "class-1", ...create }));
  prisma.agent.upsert.mockImplementation(async ({ create }) => ({ id: "agent-1", ...create }));

  return prisma;
}

const BODY = Object.freeze({
  robotId: "RBT-1000",
  name: "Warehouse Rover A",
  locationId: "loc-1",
  chassisType: "Rover (Ground)",
  specification: SPEC,
});

describe("commissionRobot — the chassis type reaches the backend (P0-1)", () => {
  test("resolves the form's label to an AgentClass and links the Agent to it", async () => {
    const prisma = commissioningPrisma();
    await robotService.commissionRobot(prisma, BODY);

    expect(prisma.agentClass.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { classId: "AC-RBT-1000" },
        create: expect.objectContaining({ chassisType: "ROVER" }),
      }),
    );
    expect(prisma.agent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ agentId: "RBT-1000", agentClassId: "class-1" }),
        update: expect.objectContaining({ agentClassId: "class-1" }),
      }),
    );
  });

  test("refuses a commission with no chassis type rather than defaulting one", async () => {
    const prisma = commissioningPrisma();
    await expect(robotService.commissionRobot(prisma, { ...BODY, chassisType: undefined })).rejects.toThrow(
      /chassisType is required/,
    );
    expect(prisma.robot.create).not.toHaveBeenCalled();
  });

  test("refuses an unrecognised chassis type", async () => {
    const prisma = commissioningPrisma();
    await expect(robotService.commissionRobot(prisma, { ...BODY, chassisType: "Hovercraft" })).rejects.toThrow(
      /chassisType is required/,
    );
  });
});

describe("commissionRobot — the specification persists (P0-2)", () => {
  test("each entered value reaches the existing model field that means it", async () => {
    const prisma = commissioningPrisma();
    await robotService.commissionRobot(prisma, BODY);

    expect(prisma.energyModel.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ packNominalWh: 500 }) }),
    );
    expect(prisma.containerModel.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ totalMassLimitKg: 20 }) }),
    );
    expect(prisma.mobilityModel.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          kinematicLimits: { maxSpeedMps: 2.5 },
          speedModel: { nominalSpeedMps: 1.4 },
        }),
      }),
    );
  });

  test("mass and battery reserve are written to the Robot row", async () => {
    const prisma = commissioningPrisma();
    await robotService.commissionRobot(prisma, BODY);

    expect(prisma.robot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ massKg: 45, batteryReservePct: 15 }),
      }),
    );
  });

  test("the payload capacity is also written as a capability, so a task can be matched to it", async () => {
    const prisma = commissioningPrisma();
    await robotService.commissionRobot(prisma, BODY);

    const names = prisma.capability.create.mock.calls.map(([{ data }]) => data.name);
    expect(names).toEqual(expect.arrayContaining(["chassis_type", "max_payload_mass"]));
  });

  test("refuses an incomplete specification, and writes no Robot row when it does", async () => {
    const prisma = commissioningPrisma();
    await expect(
      robotService.commissionRobot(prisma, { ...BODY, specification: { massKg: 45 } }),
    ).rejects.toThrow(/Invalid robot specification/);
    expect(prisma.robot.create).not.toHaveBeenCalled();
  });
});

describe("commissionRobot — the initial battery is configured, not randomised (P0-12)", () => {
  test("the Robot row carries exactly the state of charge the operator entered", async () => {
    const prisma = commissioningPrisma();
    await robotService.commissionRobot(prisma, BODY);

    expect(prisma.robot.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ battery: 82 }) }),
    );
  });

  test("two commissions with the same entered value produce the same battery — nothing random", async () => {
    const first = commissioningPrisma();
    const second = commissioningPrisma();

    await robotService.commissionRobot(first, { ...BODY, robotId: "RBT-A" });
    await robotService.commissionRobot(second, { ...BODY, robotId: "RBT-B" });

    const batteryOf = (prisma) => prisma.robot.create.mock.calls[0][0].data.battery;
    expect(batteryOf(first)).toBe(82);
    expect(batteryOf(second)).toBe(82);
  });

  test("does not consult Math.random at all", async () => {
    const prisma = commissioningPrisma();
    const random = jest.spyOn(Math, "random");
    await robotService.commissionRobot(prisma, BODY);
    expect(random).not.toHaveBeenCalled();
  });
});

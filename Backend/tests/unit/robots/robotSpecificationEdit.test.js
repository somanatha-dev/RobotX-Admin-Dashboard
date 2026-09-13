/**
 * `PATCH /api/robots/:robotId` — the smallest proper edit capability, and the fence
 * around it.
 *
 * The behavioural tests matter, but the field-list tests matter more: an edit endpoint
 * that could write `battery` or `currentTaskId` would let an operator assert a measurement
 * or an assignment, and §23.5 makes the first untrusted while §7.2 forbids the second.
 */

const robotService = require("../../../src/services/robot.service");
const robotsController = require("../../../src/controllers/robots.controller");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { createFakeIo } = require("../../helpers/fakeSocket");

let mockPrisma;
jest.mock("../../../src/db/prisma", () => ({
  getPrisma: () => mockPrisma,
}));

const STORED = Object.freeze({
  id: "robot-row-1",
  robotId: "RBT-1000",
  name: "Warehouse Rover A",
  massKg: 45,
  batteryReservePct: 15,
  // STEP 3 — `Robot.simulated` is `Boolean @default(false)` and **not nullable**, so
  // every real row carries it. The fixture omitted it, which made it a row the database
  // cannot produce; `robotProjection.toPublicRobot` now refuses such a row rather than
  // answering "physical" for a unit whose nature it was not told. Adding the column here
  // makes the fixture match the schema — no assertion in this file changes.
  simulated: false,
  agent: {
    agentClass: {
      classId: "AC-RBT-1000",
      chassisType: "ROVER",
      mobilityModel: { kinematicLimits: { maxSpeedMps: 2.5 }, speedModel: { nominalSpeedMps: 1.4 } },
      energyModel: { packNominalWh: 500 },
      containerModel: { totalMassLimitKg: 20 },
    },
  },
});

function editPrisma() {
  const prisma = createMockPrisma();
  prisma.robot.findUnique.mockResolvedValue(STORED);
  prisma.robot.update.mockImplementation(async ({ data }) => ({ ...STORED, ...data }));
  prisma.mobilityModel.upsert.mockImplementation(async ({ create }) => ({ id: "mob-1", ...create }));
  prisma.energyModel.upsert.mockImplementation(async ({ create }) => ({ id: "eng-1", ...create }));
  prisma.containerModel.upsert.mockImplementation(async ({ create }) => ({ id: "ctr-1", ...create }));
  prisma.capabilityBundle.upsert.mockImplementation(async ({ create }) => ({ id: "cap-1", ...create }));
  prisma.capability.deleteMany.mockResolvedValue({ count: 3 });
  prisma.capability.create.mockImplementation(async ({ data }) => data);
  prisma.agentClass.upsert.mockImplementation(async ({ create }) => ({ id: "class-1", ...create }));
  prisma.agent.upsert.mockImplementation(async ({ create }) => ({ id: "agent-1", ...create }));
  return prisma;
}

// `asyncHandler` returns undefined and routes completion through `res.json` or `next`,
// so the settle signal is one of those two — never the return value, which resolves
// immediately and would make every assertion race the handler.
function runController(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      body: null,
      set() { return this; },
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; resolve(this); return this; },
    };
    handler(req, res, (e) => (e ? reject(e) : resolve(res)));
  });
}

describe("updateRobotSpecification — a partial edit changes only what it names", () => {
  test("editing the payload capacity leaves the other five values stored", async () => {
    const prisma = editPrisma();
    await robotService.updateRobotSpecification(prisma, "RBT-1000", { payloadCapacityKg: 12 });

    expect(prisma.containerModel.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ totalMassLimitKg: 12 }) }),
    );
    // Unchanged values are re-written from the stored row, not blanked.
    expect(prisma.energyModel.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ packNominalWh: 500 }) }),
    );
    expect(prisma.mobilityModel.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ kinematicLimits: { maxSpeedMps: 2.5 } }) }),
    );
    expect(prisma.robot.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ massKg: 45, batteryReservePct: 15 }) }),
    );
  });

  test("changing the chassis repoints the Agent's class", async () => {
    const prisma = editPrisma();
    await robotService.updateRobotSpecification(prisma, "RBT-1000", { chassisType: "DRONE" });

    expect(prisma.agentClass.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ chassisType: "DRONE" }) }),
    );
    expect(prisma.agent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ agentClassId: "class-1" }) }),
    );
  });

  test("refuses a max speed that would fall below the STORED normal speed", async () => {
    const prisma = editPrisma();
    await expect(
      robotService.updateRobotSpecification(prisma, "RBT-1000", { maxSpeedMps: 1.0 }),
    ).rejects.toThrow(/Normal speed cannot exceed max speed/);
    expect(prisma.robot.update).not.toHaveBeenCalled();
  });

  test("404s on a robot that is not commissioned", async () => {
    const prisma = editPrisma();
    prisma.robot.findUnique.mockResolvedValue(null);
    await expect(robotService.updateRobotSpecification(prisma, "RBT-NOPE", { massKg: 1 })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("PATCH /api/robots/:robotId — the editable field list is the fence", () => {
  beforeEach(() => {
    mockPrisma = editPrisma();
  });

  const request = (body) => ({
    params: { robotId: "RBT-1000" },
    body,
    app: { locals: { io: createFakeIo() } },
  });

  test.each([
    ["battery", { battery: 100 }],
    ["position", { lat: 12.9, lon: 77.5 }],
    ["status", { status: "ACTIVE" }],
    ["the current assignment", { currentTaskId: "task-row-1" }],
    ["online state", { isOnline: true }],
  ])("refuses to write %s — and names the field rather than ignoring it", async (_label, body) => {
    await expect(runController(robotsController.updateRobot, request(body))).rejects.toMatchObject({
      status: 400,
    });
    expect(mockPrisma.robot.update).not.toHaveBeenCalled();
  });

  test("refuses an empty patch", async () => {
    await expect(runController(robotsController.updateRobot, request({}))).rejects.toMatchObject({ status: 400 });
  });

  test("accepts the specification fields and returns the projection", async () => {
    const res = await runController(robotsController.updateRobot, request({ payloadCapacityKg: 12, name: "Rover A" }));
    expect(res.body.ok).toBe(true);
    expect(res.body.robot.specification).toEqual(
      expect.objectContaining({ chassisType: "ROVER", massKg: 45 }),
    );
  });

  test("announces the change on its own event, not on the telemetry one", async () => {
    const req = request({ payloadCapacityKg: 12 });
    await runController(robotsController.updateRobot, req);

    const io = req.app.locals.io;
    expect(io.emittedTo("dashboard", "ROBOT_SPECIFICATION_UPDATED")).toHaveLength(1);
    expect(io.emittedTo("dashboard", "ROBOT_UPDATE")).toHaveLength(0);
  });
});

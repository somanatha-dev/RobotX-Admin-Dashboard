/**
 * The task submission's payload and requested agent class, and the route each takes to
 * the feasibility gate.
 *
 * Both travel the architecture that already exists: `Task.payloadSpecId → PayloadSpec`
 * (§15.1) and `Task.requirements` (§2.4's RequirementSet, matched by F21 through §2.3's
 * typed algebra). Neither introduces a model, a predicate, or a candidate filter.
 *
 * The most important test in this file is the last group: §2.8's `Task >──< Mission` join
 * is how `coordinatorSolvePath.legLoaderFor` reads both of them, and until the Mission was
 * connected to its Task that join returned nothing — so a declared payload and a requested
 * class were columns the decision path could not reach.
 */

const taskService = require("../../../src/services/task.service");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { createFakeIo } = require("../../helpers/fakeSocket");

// The cutover switch is a conjunction: the process flag AND the shard's published
// binding. Both halves are set here, explicitly and only for this file, which is what
// `tests/setup/env.js` asks of a test that needs the engine's request path — the default
// is off so no suite wanders down it by accident.
//
// This is a **test fixture for the request path**, not a staging act: nothing is published
// to a register, no shard is enabled anywhere, and the process variable is restored below.
const ENGINE_ENABLED_BEFORE = process.env.ENGINE_ENABLED;
beforeAll(() => {
  process.env.ENGINE_ENABLED = "true";
});
afterAll(() => {
  process.env.ENGINE_ENABLED = ENGINE_ENABLED_BEFORE;
});

/** A published snapshot whose shard is cut over, so `assignTask` reaches its write path. */
function liveSnapshot() {
  return { resolve: (name) => (name === "cutover.engine_enabled" ? true : null), values: new Map() };
}

/**
 * The seeded region, as two different strings.
 *
 * `Region.regionId` is the business identifier a submission names; `Region.id` is the uuid
 * every foreign key and the `cutover.engine_enabled` binding mean. They are deliberately
 * not the same value here, so a fixture cannot pass by conflating them.
 */
const REGION_KEY = "RGN-BLR";
const REGION_ROW_ID = "11111111-2222-3333-4444-555555555555";

function taskPrisma() {
  const prisma = createMockPrisma();
  prisma.region.findUnique.mockImplementation(async ({ where }) =>
    where.regionId === REGION_KEY ? { id: REGION_ROW_ID } : null,
  );
  prisma.task.create.mockImplementation(async ({ data }) => ({ id: "task-row-1", ...data }));
  prisma.task.update.mockImplementation(async ({ data }) => data);
  prisma.payloadSpec.upsert.mockImplementation(async ({ create }) => ({ id: "payload-row-1", ...create }));
  prisma.mission.upsert.mockImplementation(async ({ create }) => create);
  prisma.leg.upsert.mockImplementation(async ({ create }) => create);
  prisma.leg.findUnique.mockResolvedValue(null);
  prisma.leg.update.mockResolvedValue({});
  prisma.stop.upsert.mockImplementation(async ({ create }) => create);
  prisma.stop.update.mockResolvedValue({});
  prisma.timer = { count: jest.fn().mockResolvedValue(0), create: jest.fn() };
  prisma.identityRecord = {
    findUnique: jest.fn().mockResolvedValue(null),
    upsert: jest.fn(async ({ create }) => create),
    create: jest.fn(async ({ data }) => data),
  };
  prisma.workQueue = {
    findUnique: jest.fn().mockResolvedValue(null),
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn(async ({ data }) => data),
    count: jest.fn().mockResolvedValue(0),
  };
  return prisma;
}

const SUBMISSION = Object.freeze({
  taskId: "TSK-PAYLOAD-1",
  pickup: "Gate 1, RNSIT",
  pickupLat: 12.9081,
  pickupLon: 77.5012,
  drop: "Block C, RNSIT",
  dropLat: 12.9095,
  dropLon: 77.5031,
});

const OPTIONS = { regionId: REGION_KEY, config: liveSnapshot() };

/** `assignTask` up to its Task write; the round admission beyond it is not this test's subject. */
async function submit(prisma, body) {
  try {
    await taskService.assignTask(prisma, body, { io: createFakeIo(), ...OPTIONS });
  } catch {
    // Admission needs stores this fake does not fully model. Every assertion below is
    // about what was written before that point, and the Task write is complete by then.
  }
}

describe("payload declaration — validated before anything is written (P0-5)", () => {
  test("a task with no payload is legitimate and creates no PayloadSpec", async () => {
    const prisma = taskPrisma();
    await submit(prisma, SUBMISSION);
    expect(prisma.payloadSpec.upsert).not.toHaveBeenCalled();
  });

  test("a mass with no tolerance is refused, because §15.1's feasibility bound needs both", async () => {
    const prisma = taskPrisma();
    await expect(
      taskService.assignTask(prisma, { ...SUBMISSION, payload: { massKg: 5 } }, OPTIONS),
    ).rejects.toThrow(/massToleranceKg is required/);
    expect(prisma.task.create).not.toHaveBeenCalled();
  });

  test("a tolerance is never defaulted to zero — that would declare a precision nobody stated", async () => {
    const prisma = taskPrisma();
    await expect(
      taskService.assignTask(prisma, { ...SUBMISSION, payload: { massKg: 5 } }, OPTIONS),
    ).rejects.toThrow();
    expect(prisma.payloadSpec.upsert).not.toHaveBeenCalled();
  });

  test.each([
    ["a zero mass", { massKg: 0, massToleranceKg: 0.5 }, /greater than zero/],
    ["a negative tolerance", { massKg: 5, massToleranceKg: -1 }, /must not be negative/],
    ["a tolerance larger than the mass", { massKg: 5, massToleranceKg: 6 }, /must not exceed the declared mass/],
    ["a fractional item count", { massKg: 5, massToleranceKg: 1, itemCount: 1.5 }, /positive whole number/],
  ])("refuses %s", async (_label, payload, message) => {
    const prisma = taskPrisma();
    await expect(taskService.assignTask(prisma, { ...SUBMISSION, payload }, OPTIONS)).rejects.toThrow(message);
  });

  test.each([
    ["a string", "7.5kg"],
    ["a number", 7.5],
    ["a list", [7.5, 0.5]],
  ])("refuses a payload that is %s rather than ignoring it", async (_label, payload) => {
    const prisma = taskPrisma();
    await expect(taskService.assignTask(prisma, { ...SUBMISSION, payload }, OPTIONS)).rejects.toThrow(
      /payload must be an object/,
    );
    expect(prisma.task.create).not.toHaveBeenCalled();
  });

  test("the refusal happens before the cutover gate's write path, leaving no Task row", async () => {
    const prisma = taskPrisma();
    await expect(
      taskService.assignTask(prisma, { ...SUBMISSION, payload: { massKg: -1, massToleranceKg: 1 } }, OPTIONS),
    ).rejects.toThrow();
    expect(prisma.task.create).not.toHaveBeenCalled();
  });
});

describe("payload persistence — the existing PayloadSpec relation (P0-6)", () => {
  test("creates the PayloadSpec and links it from the Task", async () => {
    const prisma = taskPrisma();
    await submit(prisma, { ...SUBMISSION, payload: { massKg: 7.5, massToleranceKg: 0.5, itemCount: 2 } });

    expect(prisma.payloadSpec.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { specId: "PLD-TSK-PAYLOAD-1" },
        create: expect.objectContaining({ massKg: 7.5, massToleranceKg: 0.5, itemCount: 2 }),
      }),
    );
    expect(prisma.task.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ payloadSpecId: "payload-row-1" }) }),
    );
  });

  test("the spec id is a pure function of the task id, so a retry converges on one row", async () => {
    const prisma = taskPrisma();
    await submit(prisma, { ...SUBMISSION, payload: { massKg: 7.5, massToleranceKg: 0.5 } });
    await submit(prisma, { ...SUBMISSION, payload: { massKg: 7.5, massToleranceKg: 0.5 } });

    const specIds = prisma.payloadSpec.upsert.mock.calls.map(([{ where }]) => where.specId);
    expect(new Set(specIds).size).toBe(1);
  });

  test("mass and tolerance are both stored, because feasibility reads the upper bound", async () => {
    const prisma = taskPrisma();
    await submit(prisma, { ...SUBMISSION, payload: { massKg: 7.5, massToleranceKg: 0.5 } });

    const [{ create }] = prisma.payloadSpec.upsert.mock.calls[0];
    // `engine/payload/spec.itemMassForFeasibilityKg` returns null without both.
    expect(create.massKg).toBe(7.5);
    expect(create.massToleranceKg).toBe(0.5);
  });
});

describe("requested agent class — through the existing AgentClass architecture (P0-7)", () => {
  test("a requested chassis becomes a RequirementSet entry on the Task", async () => {
    const prisma = taskPrisma();
    await submit(prisma, { ...SUBMISSION, requestedChassisType: "Drone (Aerial)" });

    const [{ data }] = prisma.task.create.mock.calls[0];
    expect(data.requirements).toEqual([
      { name: "chassis_type", kind: "ENUMERATED", comparator: "EQUALS", value: "DRONE" },
    ]);
  });

  test("the declared payload mass becomes a second requirement, matched against the agent's bundle", async () => {
    const prisma = taskPrisma();
    await submit(prisma, {
      ...SUBMISSION,
      requestedChassisType: "ROVER",
      payload: { massKg: 7.5, massToleranceKg: 0.5 },
    });

    const [{ data }] = prisma.task.create.mock.calls[0];
    expect(data.requirements).toContainEqual(
      expect.objectContaining({ name: "max_payload_mass", comparator: "AT_LEAST", value: 7.5 }),
    );
  });

  test("an unrecognised class is refused, not dropped — a dropped one sends a drone mission to a rover", async () => {
    const prisma = taskPrisma();
    await expect(
      taskService.assignTask(prisma, { ...SUBMISSION, requestedChassisType: "Hovercraft" }, OPTIONS),
    ).rejects.toThrow(/requestedChassisType must be one of/);
    expect(prisma.task.create).not.toHaveBeenCalled();
  });

  test("stating no requirements writes null, not an empty list", async () => {
    const prisma = taskPrisma();
    await submit(prisma, SUBMISSION);

    const [{ data }] = prisma.task.create.mock.calls[0];
    // F21 reads `undefined`/absent as "nobody established this" and `[]` as "no
    // requirements". Only one of those is true when the submitter stated nothing.
    expect(data.requirements).toBeUndefined();
  });

  test("does not resurrect caller-nominated agent selection", async () => {
    const prisma = taskPrisma();
    await submit(prisma, { ...SUBMISSION, robotId: "RBT-1000" });

    const [{ data }] = prisma.task.create.mock.calls[0];
    expect(data.robotId).toBeUndefined();
  });
});

describe("the Mission is connected to its Task, so the decision path can read either", () => {
  test("admitToRound connects the Mission on create AND on the retried upsert", async () => {
    const prisma = taskPrisma();
    await submit(prisma, { ...SUBMISSION, requestedChassisType: "ROVER" });

    const [{ create, update }] = prisma.mission.upsert.mock.calls[0];
    expect(create.tasks).toEqual({ connect: { id: "task-row-1" } });
    expect(update.tasks).toEqual({ connect: { id: "task-row-1" } });
  });

  test("without that join, taskAttributesFor reports every §2.4 attribute as absent", () => {
    // The shape `legLoaderFor` produces, asserted directly so the consequence of an
    // unconnected Mission is recorded rather than inferred.
    const { taskAttributesFor } = require("../../../src/workers/coordinatorSolvePath");
    const unconnected = taskAttributesFor({ tasks: [] });
    expect(unconnected.requirements).toBeUndefined();
    expect(unconnected.payload).toBeUndefined();
    expect(unconnected.taskIds).toEqual([]);

    const connected = taskAttributesFor({
      tasks: [{ taskId: "TSK-1", requirements: [{ name: "chassis_type" }], payloadSpec: { massKg: 5 } }],
    });
    expect(connected.requirements).toEqual([{ name: "chassis_type" }]);
    expect(connected.payload).toEqual({ massKg: 5 });
    expect(connected.taskIds).toEqual(["TSK-1"]);
  });
});

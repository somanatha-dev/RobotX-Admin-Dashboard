/**
 * The commissioning transaction's latency budget and round trips (simulator-create P2028).
 *
 * `POST /api/simulator/robot` answered 500 with P2028 against a remote database: about
 * twenty sequential statements in one interactive transaction outlived Prisma's 5000 ms
 * default. The fix keeps the transaction whole and does three things:
 *   - gives this transaction, and only this one, an explicit 15000 ms budget;
 *   - drops the `include` on the initial create, which nothing inside the transaction read;
 *   - writes the capability set with one `createMany` instead of a create per row.
 * Live rollback and latency behaviour are verified against PostgreSQL in the fix report.
 */

const robotService = require("../../../src/services/robot.service");
const { createMockPrisma } = require("../../helpers/mockPrisma");

const SPEC = Object.freeze({
  massKg: 2,
  maxSpeedMps: 2.5,
  normalSpeedMps: 1.5,
  batteryCapacityWh: 500,
  batteryReservePct: 15,
  payloadCapacityKg: 5,
  initialBatteryPct: 100,
});

function commissioningPrisma() {
  const prisma = createMockPrisma();
  prisma.robot.findUnique.mockImplementation(async ({ where }) => (where.id ? { id: where.id, robotId: "RBT-TX" } : null));
  prisma.location.findUnique.mockResolvedValue({ id: "loc-1", lat: 12.9, lon: 77.5 });
  prisma.robot.create = jest.fn(async ({ data }) => ({ id: "robot-row-1", ...data }));
  prisma.mobilityModel.upsert.mockImplementation(async ({ create }) => ({ id: "mob-1", ...create }));
  prisma.energyModel.upsert.mockImplementation(async ({ create }) => ({ id: "eng-1", ...create }));
  prisma.containerModel.upsert.mockImplementation(async ({ create }) => ({ id: "ctr-1", ...create }));
  prisma.capabilityBundle.upsert.mockImplementation(async ({ create }) => ({ id: "bundle-1", ...create }));
  prisma.capability.deleteMany.mockResolvedValue({ count: 0 });
  prisma.capability.createMany.mockImplementation(async ({ data }) => ({ count: data.length }));
  prisma.agentClass.upsert.mockImplementation(async ({ create }) => ({ id: "class-1", ...create }));
  prisma.agent.upsert.mockImplementation(async ({ create }) => ({ id: "agent-1", ...create }));
  return prisma;
}

const BODY = Object.freeze({ robotId: "RBT-TX", locationId: "loc-1", chassisType: "ROVER", specification: SPEC });

test("the budget is 15000 ms and is passed to this transaction only, with no other option changed", async () => {
  const prisma = commissioningPrisma();
  await robotService.commissionRobot(prisma, BODY);

  expect(robotService.COMMISSIONING_TRANSACTION_TIMEOUT_MS).toBe(15000);
  expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  const [callback, options] = prisma.$transaction.mock.calls[0];
  expect(typeof callback).toBe("function");
  // Exactly the timeout: maxWait and the isolation level stay Prisma's defaults.
  expect(options).toEqual({ timeout: 15000 });
});

test("the initial create carries no include; the response's includes come from the final re-read", async () => {
  const prisma = commissioningPrisma();
  await robotService.commissionRobot(prisma, BODY);

  const [createArgs] = prisma.robot.create.mock.calls[0];
  expect(createArgs).not.toHaveProperty("include");
  const reRead = prisma.robot.findUnique.mock.calls.map(([args]) => args).find((args) => args.where.id === "robot-row-1");
  expect(reRead.include).toEqual(expect.objectContaining({ location: true, campus: true, currentTask: true, agent: expect.any(Object) }));
});

test("the Agent projection still receives the created row's id and robotId", async () => {
  const prisma = commissioningPrisma();
  await robotService.commissionRobot(prisma, BODY);

  expect(prisma.agent.upsert).toHaveBeenCalledWith(
    expect.objectContaining({ create: expect.objectContaining({ agentId: "RBT-TX", robotDbId: "robot-row-1" }) }),
  );
});

test("capabilities are replaced with one createMany: same rows, bundle-keyed, duplicates not skipped", async () => {
  const prisma = commissioningPrisma();
  await robotService.commissionRobot(prisma, BODY);

  expect(prisma.capability.create).not.toHaveBeenCalled();
  expect(prisma.capability.createMany).toHaveBeenCalledTimes(1);
  const [{ data, ...rest }] = prisma.capability.createMany.mock.calls[0];
  expect(rest).toEqual({}); // no skipDuplicates: a repeated name must still fail the transaction
  expect(data.map((row) => row.name).sort()).toEqual(["chassis_type", "custody_transfer_capable", "max_payload_mass"]);
  expect(data.every((row) => row.bundleId === "bundle-1")).toBe(true);
  // The old rows are deleted before the new set is written.
  expect(prisma.capability.deleteMany.mock.invocationCallOrder[0])
    .toBeLessThan(prisma.capability.createMany.mock.invocationCallOrder[0]);
});

test("a capability write failure propagates out of the transaction, as a per-row create's did", async () => {
  const prisma = commissioningPrisma();
  const unique = Object.assign(new Error("Unique constraint failed on the fields: (`bundleId`,`name`)"), { code: "P2002" });
  prisma.capability.createMany.mockRejectedValue(unique);

  await expect(robotService.commissionRobot(prisma, BODY)).rejects.toBe(unique);
  expect(prisma.agent.upsert).not.toHaveBeenCalled();
});

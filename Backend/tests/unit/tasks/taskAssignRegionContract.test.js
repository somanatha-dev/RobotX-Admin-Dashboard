/**
 * `POST /api/tasks/assign` — the region a submission names, and the region identity the
 * persistence layer and the cutover gate mean.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * `Region` carries two identifiers: `Region.id`, a uuid, and `Region.regionId`, the
 * operator-facing business key. A submission names the second — `tools/verify/
 * v1CorePath.js` posts `regionId: region.regionId`, and a uuid is not something a UI or an
 * external client can hold — while everything below the request boundary means the first:
 *
 *   · `Mission.regionId` is the foreign key to `Region.id`;
 *   · `intake.resolveShardFor` keys the region→shard map on `Shard.regionId`, the same FK;
 *   · `cutover.engine_enabled` is published by `stage.authoriseEnable` as
 *     `{ level: "region", key: shard.regionId }`.
 *
 * The request path passed the caller's value straight through to all three, so a live HTTP
 * probe against a real PostgreSQL returned HTTP 500 — `P2003 Mission_regionId_fkey` — and
 * no single request value could have satisfied both sides.
 *
 * The prisma double below therefore **enforces the foreign key**: `mission.upsert` raises
 * Prisma's own P2003 shape for a `regionId` that is not a Region row id. A test that
 * conflated the two identifiers would fail here rather than pass quietly.
 */

const taskService = require("../../../src/services/task.service");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { createFakeIo } = require("../../helpers/fakeSocket");

// The process half of the cutover switch, set only for this file — the shard half is the
// published binding each test supplies. `tests/setup/env.js` leaves the default off so no
// suite wanders down the engine's request path by accident.
const ENGINE_ENABLED_BEFORE = process.env.ENGINE_ENABLED;
beforeAll(() => {
  process.env.ENGINE_ENABLED = "true";
});
afterAll(() => {
  process.env.ENGINE_ENABLED = ENGINE_ENABLED_BEFORE;
});

/**
 * Two regions, each with both of its identifiers, deliberately different strings.
 *
 * A fixture that used one value for both could not distinguish a correct translation from
 * no translation at all — which is the trap `tools/verify/phase15CurrentTree.js` records
 * having fallen into on this exact pair of columns.
 */
const REGIONS = Object.freeze({
  rnsit: { key: "RGN-RNSIT", rowId: "0d9b6f5a-1c2d-4e3f-8a9b-0c1d2e3f4a5b" },
  jssate: { key: "RGN-JSSATE", rowId: "7f1e2d3c-4b5a-4968-8877-665544332211" },
});

const REGION_ROW_IDS = new Set(Object.values(REGIONS).map((region) => region.rowId));

/** A snapshot whose `cutover.engine_enabled` is bound true at the given region-scope key. */
function snapshotStagedAt(regionScopeKey) {
  return {
    resolve: (name, context) =>
      name === "cutover.engine_enabled" && context && context.region === regionScopeKey ? true : null,
    values: new Map(),
  };
}

function taskPrisma() {
  const prisma = createMockPrisma();

  prisma.region.findUnique.mockImplementation(async ({ where }) => {
    const match = Object.values(REGIONS).find((region) => region.key === where.regionId);
    return match ? { id: match.rowId } : null;
  });

  const missions = [];
  // The foreign key, enforced. `Mission.regionId` references `Region.id`; Prisma reports a
  // violation as P2003 naming the constraint, which is exactly what the live probe saw.
  prisma.mission.upsert.mockImplementation(async ({ create }) => {
    if (create && create.regionId !== undefined && create.regionId !== null && !REGION_ROW_IDS.has(create.regionId)) {
      const error = new Error("Foreign key constraint violated on the constraint: `Mission_regionId_fkey`");
      error.code = "P2003";
      error.meta = { field_name: "Mission_regionId_fkey (index)" };
      throw error;
    }
    missions.push({ ...create });
    return { ...create };
  });

  prisma.task.create.mockImplementation(async ({ data }) => ({ id: "task-row-1", ...data }));
  prisma.task.update.mockImplementation(async ({ data }) => data);
  prisma.payloadSpec.upsert.mockImplementation(async ({ create }) => ({ id: "payload-row-1", ...create }));
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
  const queued = [];
  prisma.workQueue = {
    findUnique: jest.fn().mockResolvedValue(null),
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn(async ({ data }) => {
      queued.push({ id: `wq-${queued.length + 1}`, ...data });
      return queued[queued.length - 1];
    }),
    // §3.4 writes the quoted window back onto the durable row it just created.
    update: jest.fn(async ({ where, data }) => {
      const row = queued.find((entry) => entry.id === where.id);
      if (row) Object.assign(row, data);
      return row;
    }),
    count: jest.fn().mockResolvedValue(0),
  };

  prisma.__missions = missions;
  prisma.__queued = queued;
  return prisma;
}

const SUBMISSION = Object.freeze({
  taskId: "TSK-REGION-1",
  pickup: "Gate 1, RNSIT",
  pickupLat: 12.9081,
  pickupLon: 77.5012,
  drop: "Block C, RNSIT",
  dropLat: 12.9095,
  dropLon: 77.5031,
});

const submit = (prisma, body, options) =>
  taskService.assignTask(prisma, body, { io: createFakeIo(), ...options });

describe("the business region identifier resolves to the Region the FK means", () => {
  test("a valid business identifier is accepted and the request is admitted", async () => {
    const prisma = taskPrisma();
    const created = await submit(prisma, SUBMISSION, {
      regionId: REGIONS.rnsit.key,
      config: snapshotStagedAt(REGIONS.rnsit.rowId),
    });

    expect(prisma.region.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { regionId: REGIONS.rnsit.key } }),
    );
    expect(created.intake).toBeDefined();
    expect(created.intake.accepted).toBe(true);
  });

  test("the Mission receives the Region row id, never the business key", async () => {
    const prisma = taskPrisma();
    await submit(prisma, SUBMISSION, {
      regionId: REGIONS.rnsit.key,
      config: snapshotStagedAt(REGIONS.rnsit.rowId),
    });

    expect(prisma.__missions).toHaveLength(1);
    expect(prisma.__missions[0].regionId).toBe(REGIONS.rnsit.rowId);
    expect(prisma.__missions[0].regionId).not.toBe(REGIONS.rnsit.key);
  });

  // The failure this whole contract exists to close, asserted as a negative: with the
  // double enforcing the constraint, an untranslated business key raises P2003 exactly as
  // the live database did. The test is that admission never reaches that state.
  test("admission reaches the engine rather than failing with P2003", async () => {
    const prisma = taskPrisma();
    const created = await submit(prisma, SUBMISSION, {
      regionId: REGIONS.rnsit.key,
      config: snapshotStagedAt(REGIONS.rnsit.rowId),
    });

    expect(created.intake.accepted).toBe(true);
    expect(prisma.__queued).toHaveLength(1);
    expect(prisma.mission.upsert).toHaveBeenCalled();
  });

  test("the P2003 the double raises is real — an untranslated key still violates the FK", async () => {
    const prisma = taskPrisma();
    await expect(
      prisma.mission.upsert({ where: { id: "m1" }, create: { id: "m1", regionId: REGIONS.rnsit.key } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  test("a submission naming no region writes no region onto the Mission", async () => {
    const prisma = taskPrisma();
    // No region named means no shard subject, so the gate refuses — which is the existing,
    // deliberate P15-R5 behaviour and is asserted here so the translation cannot have
    // quietly introduced a default region.
    await expect(submit(prisma, SUBMISSION, { config: snapshotStagedAt(REGIONS.rnsit.rowId) })).rejects.toMatchObject({
      status: 503,
      code: "ENGINE_NOT_LIVE",
    });
    expect(prisma.region.findUnique).not.toHaveBeenCalled();
    expect(prisma.task.create).not.toHaveBeenCalled();
  });
});

describe("an unknown region is refused cleanly, before anything is written", () => {
  test("a region that does not exist is a 400 naming the identifier, not a 500", async () => {
    const prisma = taskPrisma();
    const error = await submit(prisma, SUBMISSION, {
      regionId: "RGN-DOES-NOT-EXIST",
      config: snapshotStagedAt(REGIONS.rnsit.rowId),
    }).catch((caught) => caught);

    expect(error.status).toBe(400);
    expect(error.code).toBe("UNKNOWN_REGION");
    expect(error.message).toMatch(/RGN-DOES-NOT-EXIST/);
    expect(error.message).toMatch(/OperatingRegion/);
  });

  test("the refusal leaves no Task, no PayloadSpec and no Mission behind", async () => {
    const prisma = taskPrisma();
    await expect(
      submit(
        prisma,
        { ...SUBMISSION, payload: { massKg: 5, massToleranceKg: 0.5 } },
        { regionId: "RGN-DOES-NOT-EXIST", config: snapshotStagedAt(REGIONS.rnsit.rowId) },
      ),
    ).rejects.toThrow();

    expect(prisma.task.create).not.toHaveBeenCalled();
    expect(prisma.payloadSpec.upsert).not.toHaveBeenCalled();
    expect(prisma.mission.upsert).not.toHaveBeenCalled();
  });

  test("a Region row id posted as the business identifier is refused, not silently accepted", async () => {
    const prisma = taskPrisma();
    // One identifier at the boundary. Accepting either would make `regionId` mean
    // whichever of two columns happened to match.
    await expect(
      submit(prisma, SUBMISSION, {
        regionId: REGIONS.rnsit.rowId,
        config: snapshotStagedAt(REGIONS.rnsit.rowId),
      }),
    ).rejects.toMatchObject({ status: 400, code: "UNKNOWN_REGION" });
  });
});

describe("campus isolation — the translation does not widen the cutover gate", () => {
  test("a region that exists but is not staged is still refused 503", async () => {
    const prisma = taskPrisma();
    await expect(
      submit(prisma, SUBMISSION, {
        regionId: REGIONS.jssate.key,
        // Only RNSIT is staged.
        config: snapshotStagedAt(REGIONS.rnsit.rowId),
      }),
    ).rejects.toMatchObject({ status: 503, code: "ENGINE_NOT_LIVE" });

    expect(prisma.task.create).not.toHaveBeenCalled();
  });

  test("the gate is asked about the Region row id, which is the key stage.authoriseEnable publishes", async () => {
    const prisma = taskPrisma();
    const asked = [];
    const config = {
      resolve: (name, context) => {
        if (name === "cutover.engine_enabled") {
          asked.push(context && context.region);
          return context && context.region === REGIONS.jssate.rowId ? true : null;
        }
        return null;
      },
      values: new Map(),
    };

    await submit(prisma, SUBMISSION, { regionId: REGIONS.jssate.key, config });

    expect(asked).toContain(REGIONS.jssate.rowId);
    expect(asked).not.toContain(REGIONS.jssate.key);
  });

  test("two campuses stay distinct: each submission's Mission carries its own region", async () => {
    const rnsit = taskPrisma();
    await submit(rnsit, SUBMISSION, {
      regionId: REGIONS.rnsit.key,
      config: snapshotStagedAt(REGIONS.rnsit.rowId),
    });

    const jssate = taskPrisma();
    await submit(
      jssate,
      { ...SUBMISSION, taskId: "TSK-REGION-2" },
      { regionId: REGIONS.jssate.key, config: snapshotStagedAt(REGIONS.jssate.rowId) },
    );

    expect(rnsit.__missions[0].regionId).toBe(REGIONS.rnsit.rowId);
    expect(jssate.__missions[0].regionId).toBe(REGIONS.jssate.rowId);
    expect(rnsit.__missions[0].regionId).not.toBe(jssate.__missions[0].regionId);
  });
});

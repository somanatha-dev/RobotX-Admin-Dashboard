"use strict";

/**
 * P1.2 — task intake is atomic (SD-4).
 *
 * The unit a successful intake commits, measured on a live PostgreSQL (2026-09-27): the
 * PayloadSpec, the Task, its Mission and the Task↔Mission link, the Leg, the Leg's §4.5
 * QUEUED deadline (Timer), two Stops, their §23.7 IdentityRecords, and the WorkQueue row.
 * There is no outbox on this path. Before this change every step committed on its own, and
 * three measured routes left a PENDING Task and a QUEUED Leg with no queue row: a sealing
 * failure (short privacy secret), an admission refusal after the writes, and a retried
 * Idempotency-Key.
 *
 * The double below is transactional in the one way that matters here: the root client may
 * READ but refuses to WRITE, and `$transaction` stages every write on a copy that is
 * committed only if the callback resolves. So a write that escapes the transaction fails
 * the test, and a failure anywhere inside it leaves the committed store untouched. The
 * rollback itself is PostgreSQL's; its live proof is in the P1.2 report.
 */

const taskService = require("../../src/services/task.service");
const cutoverEnabled = require("../../src/engine/cutover/enabled");

const REGION_KEY = "rnsit";
const REGION_ROW_ID = "region-row-rnsit";
const SHARD_ID = "v1demo-shard";
const STORE_NOW = new Date("2026-09-27T12:00:00.000Z");
const TABLES = ["payloadSpec", "task", "mission", "missionTask", "leg", "timer", "stop", "identityRecord", "workQueue"];

/** Matches a row on the scalar fields of a `where`; relation/OR clauses are not modelled. */
const matches = (row, where) =>
  Object.entries(where || {}).every(([key, value]) => (value === null || typeof value !== "object" ? row[key] === value : true));

function transactionalPrisma(options = {}) {
  let committed = Object.fromEntries(TABLES.map((name) => [name, []]));
  let ids = 0;
  const failOn = options.failOn || null;

  function modelsOver(tables, writable) {
    const guard = (op) => {
      if (!writable) throw new Error(`WRITE OUTSIDE THE INTAKE TRANSACTION: ${op}`);
      if (failOn === op) throw new Error(`injected failure at ${op}`);
    };
    const model = (name) => ({
      findUnique: async ({ where, include }) => {
        const row = tables[name].find((entry) => matches(entry, where));
        if (!row) return null;
        if (name === "leg" && include && include.mission) {
          const mission = tables.mission.find((m) => m.id === row.missionId);
          const tasks = tables.missionTask.filter((l) => l.missionId === mission.id).map((l) => tables.task.find((t) => t.id === l.taskId));
          return { ...row, mission: { ...mission, tasks } };
        }
        return { ...row };
      },
      findFirst: async ({ where } = {}) => {
        const row = tables[name].find((entry) => matches(entry, where));
        return row ? { ...row } : null;
      },
      count: async ({ where } = {}) => tables[name].filter((entry) => matches(entry, where)).length,
      create: async ({ data }) => {
        guard(`${name}.create`);
        const row = { id: `${name}-${(ids += 1)}`, ...data };
        if (name === "task") Object.assign(row, { robot: null, payloadSpec: tables.payloadSpec.find((p) => p.id === data.payloadSpecId) || null });
        tables[name].push(row);
        return { ...row };
      },
      upsert: async ({ where, create, update }) => {
        guard(`${name}.upsert`);
        const { tasks, ...plain } = create;
        let row = tables[name].find((entry) => matches(entry, where));
        if (!row) {
          row = { id: `${name}-${(ids += 1)}`, ...plain };
          tables[name].push(row);
        } else {
          const { tasks: ignored, ...changes } = update || {};
          Object.assign(row, changes);
        }
        const link = (tasks || (update && update.tasks));
        if (name === "mission" && link && link.connect) tables.missionTask.push({ missionId: row.id, taskId: link.connect.id });
        return { ...row };
      },
      update: async ({ where, data }) => {
        guard(`${name}.update`);
        const row = tables[name].find((entry) => matches(entry, where));
        if (!row) throw new Error(`no ${name} row`);
        Object.assign(row, data);
        return { ...row };
      },
    });
    const models = Object.fromEntries(TABLES.map((name) => [name, model(name)]));
    return {
      ...models,
      region: { findUnique: async ({ where }) => (where.regionId === REGION_KEY ? { id: REGION_ROW_ID } : null) },
      shard: { findMany: async () => [{ shardId: SHARD_ID, regionId: REGION_ROW_ID, state: "ACTIVE" }] },
      $queryRawUnsafe: async () => [{ now: STORE_NOW }],
    };
  }

  const root = {
    ...modelsOver(new Proxy({}, { get: (_, name) => committed[name] }), false),
    async $transaction(fn) {
      const staged = structuredClone(committed);
      const result = await fn(modelsOver(staged, true)); // throws → staged is dropped
      committed = staged;
      return result;
    },
    rows: () => Object.fromEntries(TABLES.map((name) => [name, committed[name].length])),
    committed: () => committed,
  };
  return root;
}

const liveSnapshot = () => ({
  version: 1,
  values: new Map([["sla.assignment_deadline", 3600]]),
  resolve: (name, scope) => (name === cutoverEnabled.PARAMETER && scope && scope.region === REGION_ROW_ID ? true : undefined),
  deliveryDomain: null,
});

const SUBMISSION = Object.freeze({
  pickup: "RNSIT Canara Bank",
  pickupLat: 12.902348,
  pickupLon: 77.518589,
  drop: "RNSIT Food Court",
  dropLat: 12.900817,
  dropLon: 77.518043,
  payload: { massKg: 1, massToleranceKg: 0.1 },
  requestedChassisType: "ROVER",
});

function fakeIo() {
  const emitted = [];
  return { emitted, to: () => ({ emit: (event, payload) => emitted.push({ event, payload }) }) };
}

const ENV = {};
beforeAll(() => {
  for (const name of ["ENGINE_ENABLED", "PRIVACY_SURROGATE_SECRET", "PRIVACY_IDENTITY_KEY", "VERIFY_ARRIVAL_RADIUS_M"]) ENV[name] = process.env[name];
  process.env.ENGINE_ENABLED = "true";
  process.env.PRIVACY_SURROGATE_SECRET = "a-surrogate-secret-of-plenty-of-bytes";
  process.env.PRIVACY_IDENTITY_KEY = "22".repeat(32);
  process.env.VERIFY_ARRIVAL_RADIUS_M = "25";
});
afterAll(() => {
  for (const [name, value] of Object.entries(ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const submit = (prisma, extra = {}, body = SUBMISSION) =>
  taskService.assignTask(prisma, { ...body }, {
    io: extra.io || fakeIo(),
    config: liveSnapshot(),
    regionId: REGION_KEY,
    shardByRegionId: { [REGION_ROW_ID]: SHARD_ID },
    ...extra,
  });

const EMPTY = Object.fromEntries(TABLES.map((name) => [name, 0]));

async function withShortSecret(fn) {
  const saved = process.env.PRIVACY_SURROGATE_SECRET;
  process.env.PRIVACY_SURROGATE_SECRET = "audit-secret"; // 12 bytes: the original SD-4 failure
  try {
    return await fn();
  } finally {
    process.env.PRIVACY_SURROGATE_SECRET = saved;
  }
}

describe("SD-4 — intake commits everything or nothing", () => {
  test("A: an invalid privacy secret fails the request and leaves no Task, Leg, Stop, queue or identity row", async () => {
    const prisma = transactionalPrisma();
    await expect(withShortSecret(() => submit(prisma))).rejects.toThrow(/12 bytes/);
    expect(prisma.rows()).toEqual(EMPTY);
  });

  test("B: a failure at the last write (the queue row) rolls back every earlier write", async () => {
    const prisma = transactionalPrisma({ failOn: "workQueue.create" });
    await expect(submit(prisma)).rejects.toThrow(/injected failure at workQueue.create/);
    expect(prisma.rows()).toEqual(EMPTY);
  });

  test("B': a failure in the middle (a Stop write) rolls back the Task and Leg written before it", async () => {
    const prisma = transactionalPrisma({ failOn: "stop.upsert" });
    await expect(submit(prisma)).rejects.toThrow(/injected failure at stop.upsert/);
    expect(prisma.rows()).toEqual(EMPTY);
  });

  test("C: a valid intake commits the whole unit, with consistent references", async () => {
    const prisma = transactionalPrisma();
    const created = await submit(prisma);
    expect(created.intake).toMatchObject({ accepted: true, outcome: "ACCEPTED" });
    expect(prisma.rows()).toEqual({
      payloadSpec: 1, task: 1, mission: 1, missionTask: 1, leg: 1, timer: 1, stop: 2, identityRecord: 4, workQueue: 1,
    });
    const { task, mission, missionTask, leg, stop, workQueue, timer } = prisma.committed();
    expect(missionTask[0]).toEqual({ missionId: mission[0].id, taskId: task[0].id });
    expect(leg[0].missionId).toBe(mission[0].id);
    expect(stop.every((row) => row.legId === leg[0].id && typeof row.identityKey === "string")).toBe(true);
    expect(workQueue[0]).toMatchObject({ legId: leg[0].id, shardId: SHARD_ID, state: "QUEUED" });
    expect(timer[0]).toMatchObject({ entityId: leg[0].id });
    expect(task[0]).toMatchObject({ status: "PENDING", originIdentityKey: expect.any(String) });
  });

  test("E: the same invalid request three times leaves nothing behind", async () => {
    const prisma = transactionalPrisma();
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await expect(withShortSecret(() => submit(prisma))).rejects.toThrow();
    }
    expect(prisma.rows()).toEqual(EMPTY);
  });

  test("an admission refusal after the writes rolls them back and still answers with the refusal", async () => {
    const prisma = transactionalPrisma();
    const answer = await submit(prisma, { admissionInputs: { observedRatePerMinute: 10, rateQuotaPerMinute: 1 } });
    expect(answer).toMatchObject({ persisted: false, intake: { accepted: false, outcome: "DECLINED", reason: "TENANT_RATE_QUOTA_EXCEEDED" } });
    expect(prisma.rows()).toEqual(EMPTY);
  });

  test("a retried Idempotency-Key returns the original acceptance and creates nothing new", async () => {
    const prisma = transactionalPrisma();
    const first = await submit(prisma, { idempotencyKey: "retry-1" });
    const afterFirst = prisma.rows();
    const retry = await submit(prisma, { idempotencyKey: "retry-1" });
    expect(retry.intake).toMatchObject({ accepted: true, outcome: "DUPLICATE", legId: first.intake.legId, taskId: first.taskId });
    expect(retry.taskId).toBe(first.taskId);
    expect(prisma.rows()).toEqual(afterFirst);
  });

  test("the dashboard hears of a task only once it is committed", async () => {
    const failed = fakeIo();
    await expect(withShortSecret(() => submit(transactionalPrisma(), { io: failed }))).rejects.toThrow();
    expect(failed.emitted).toEqual([]);

    const ok = fakeIo();
    const created = await submit(transactionalPrisma(), { io: ok });
    expect(ok.emitted).toEqual([expect.objectContaining({ event: "TASK_CREATED", payload: expect.objectContaining({ taskId: created.taskId }) })]);
  });

  test("validation still refuses before any transaction is opened", async () => {
    const prisma = transactionalPrisma();
    const opened = jest.spyOn(prisma, "$transaction");
    await expect(submit(prisma, {}, { ...SUBMISSION, requestedChassisType: "HOVERCRAFT" })).rejects.toMatchObject({ status: 400 });
    await expect(submit(prisma, { regionId: "nowhere" })).rejects.toMatchObject({ status: 400, code: "UNKNOWN_REGION" });
    expect(opened).not.toHaveBeenCalled();
  });
});

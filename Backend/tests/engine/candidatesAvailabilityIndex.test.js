"use strict";

/**
 * `candidates/availabilityIndex.js` — the four partitions, secondary indices, and
 * the advisory Redis write/read/rebuild path (§6.2).
 *
 * Uses the real `kv` client's in-memory fallback (no `REDIS_URL` in the test
 * environment — `tests/setup/env.js`), so `sadd`/`srem`/`smembers` are exercised
 * for real rather than mocked, while still running with no external service.
 */

const availabilityIndex = require("../../src/engine/candidates/availabilityIndex");
const { initKv } = require("../../src/cache/kv");

const DECISION_TIME_MS = Date.UTC(2026, 7, 4, 12, 0, 0);

describe("§6.2 — classify()", () => {
  test("a lifecycle-ineligible agent is never indexed", () => {
    expect(availabilityIndex.classify({ lifecycleEligible: false, idle: true }, DECISION_TIME_MS, 300)).toBeNull();
  });

  test("IDLE_READY: no active commitment and idle", () => {
    expect(
      availabilityIndex.classify(
        { lifecycleEligible: true, hasActiveCommitment: false, idle: true },
        DECISION_TIME_MS,
        300,
      ),
    ).toBe(availabilityIndex.AVAILABILITY_CLASS.IDLE_READY);
  });

  test("QUEUE_CAPACITY_AVAILABLE takes priority over CHARGING_INTERRUPTIBLE and FINISHING_SOON", () => {
    const state = {
      lifecycleEligible: true,
      hasActiveCommitment: true,
      idle: false,
      queueDepth: 1,
      capacity: 2,
      charging: true,
      chargingInterruptible: true,
      projectedFreeAtMs: DECISION_TIME_MS + 60_000,
    };
    expect(availabilityIndex.classify(state, DECISION_TIME_MS, 300)).toBe(
      availabilityIndex.AVAILABILITY_CLASS.QUEUE_CAPACITY_AVAILABLE,
    );
  });

  test("CHARGING_INTERRUPTIBLE when charging and interruptible, no spare queue capacity", () => {
    const state = {
      lifecycleEligible: true,
      hasActiveCommitment: true,
      idle: false,
      queueDepth: 2,
      capacity: 2,
      charging: true,
      chargingInterruptible: true,
    };
    expect(availabilityIndex.classify(state, DECISION_TIME_MS, 300)).toBe(
      availabilityIndex.AVAILABILITY_CLASS.CHARGING_INTERRUPTIBLE,
    );
  });

  test("FINISHING_SOON when the projected free time is within the horizon", () => {
    const state = {
      lifecycleEligible: true,
      hasActiveCommitment: true,
      idle: false,
      queueDepth: 2,
      capacity: 2,
      projectedFreeAtMs: DECISION_TIME_MS + 200_000,
    };
    expect(availabilityIndex.classify(state, DECISION_TIME_MS, 300)).toBe(
      availabilityIndex.AVAILABILITY_CLASS.FINISHING_SOON,
    );
  });

  test("null when busy with no spare capacity and not finishing soon (not indexed at all)", () => {
    const state = { lifecycleEligible: true, hasActiveCommitment: true, idle: false, queueDepth: 2, capacity: 2 };
    expect(availabilityIndex.classify(state, DECISION_TIME_MS, 300)).toBeNull();
  });

  test("a projected free time beyond the horizon is not FINISHING_SOON", () => {
    const state = {
      lifecycleEligible: true,
      hasActiveCommitment: true,
      idle: false,
      queueDepth: 2,
      capacity: 2,
      projectedFreeAtMs: DECISION_TIME_MS + 10 * 60_000,
    };
    expect(availabilityIndex.classify(state, DECISION_TIME_MS, 300)).toBeNull();
  });
});

describe("§6.2 — positionRecord()", () => {
  const goodInput = () => ({
    agentId: "agent-1",
    shardId: "default",
    lat: 12.9716,
    lon: 77.5946,
    capabilityClasses: ["REFRIGERATED"],
    containerClasses: ["LOCKER_M"],
    state: { lifecycleEligible: true, hasActiveCommitment: false, idle: true },
    decisionTimeMs: DECISION_TIME_MS,
    finishingSoonHorizonSeconds: 300,
  });

  test("computes fine/coarse cells and canonically orders the secondary classes", () => {
    const result = availabilityIndex.positionRecord(goodInput());
    expect(result.ok).toBe(true);
    expect(result.record.fineCellId).toEqual(expect.any(String));
    expect(result.record.coarseCellId).toEqual(expect.any(String));
    expect(result.record.availabilityClass).toBe(availabilityIndex.AVAILABILITY_CLASS.IDLE_READY);
    expect(result.record.capabilityClasses).toEqual(["REFRIGERATED"]);
  });

  test("returns record:null (not an error) for a not-indexable agent", () => {
    const result = availabilityIndex.positionRecord({
      ...goodInput(),
      state: { lifecycleEligible: false },
    });
    expect(result).toEqual({ ok: true, record: null, problems: [] });
  });

  test("reports a problem rather than guessing when agentId/shardId/coordinates are missing", () => {
    const result = availabilityIndex.positionRecord({ ...goodInput(), agentId: undefined });
    expect(result.ok).toBe(false);
    expect(result.problems).toContain("agentId");
  });
});

describe("§6.2 — applyPosition / removePosition / candidatesInFineCell (in-memory kv)", () => {
  let kv;
  let close;

  beforeAll(async () => {
    const initialized = await initKv({ logger: { warn() {}, info() {}, error() {} } });
    kv = initialized.kv;
    close = initialized.close;
  });

  afterAll(async () => {
    if (close) await close();
  });

  test("placing an agent makes it findable in its fine cell and class", async () => {
    const record = availabilityIndex.positionRecord({
      agentId: "agent-a",
      shardId: "shard-1",
      lat: 12.9716,
      lon: 77.5946,
      state: { lifecycleEligible: true, hasActiveCommitment: false, idle: true },
      decisionTimeMs: DECISION_TIME_MS,
      finishingSoonHorizonSeconds: 300,
    }).record;

    const applied = await availabilityIndex.applyPosition({ kv }, null, record);
    expect(applied.ok).toBe(true);

    const found = await availabilityIndex.candidatesInFineCell(
      { kv },
      "shard-1",
      record.fineCellId,
      availabilityIndex.AVAILABILITY_CLASS.IDLE_READY,
    );
    expect(found).toEqual(["agent-a"]);
  });

  test("moving an agent removes it from its old key and adds it to the new one", async () => {
    const previous = availabilityIndex.positionRecord({
      agentId: "agent-b",
      shardId: "shard-1",
      lat: 12.9716,
      lon: 77.5946,
      state: { lifecycleEligible: true, hasActiveCommitment: false, idle: true },
      decisionTimeMs: DECISION_TIME_MS,
      finishingSoonHorizonSeconds: 300,
    }).record;
    await availabilityIndex.applyPosition({ kv }, null, previous);

    const moved = availabilityIndex.positionRecord({
      agentId: "agent-b",
      shardId: "shard-1",
      lat: 13.5, // far away — a different fine and coarse cell
      lon: 78.2,
      state: { lifecycleEligible: true, hasActiveCommitment: false, idle: true },
      decisionTimeMs: DECISION_TIME_MS,
      finishingSoonHorizonSeconds: 300,
    }).record;
    await availabilityIndex.applyPosition({ kv }, previous, moved);

    const oldCell = await availabilityIndex.candidatesInFineCell(
      { kv },
      "shard-1",
      previous.fineCellId,
      availabilityIndex.AVAILABILITY_CLASS.IDLE_READY,
    );
    const newCell = await availabilityIndex.candidatesInFineCell(
      { kv },
      "shard-1",
      moved.fineCellId,
      availabilityIndex.AVAILABILITY_CLASS.IDLE_READY,
    );
    expect(oldCell).not.toContain("agent-b");
    expect(newCell).toContain("agent-b");
  });

  test("removePosition removes an agent from every key it was in", async () => {
    const record = availabilityIndex.positionRecord({
      agentId: "agent-c",
      shardId: "shard-1",
      lat: 12.9716,
      lon: 77.5946,
      state: { lifecycleEligible: true, hasActiveCommitment: false, idle: true },
      decisionTimeMs: DECISION_TIME_MS,
      finishingSoonHorizonSeconds: 300,
    }).record;
    await availabilityIndex.applyPosition({ kv }, null, record);
    await availabilityIndex.removePosition({ kv }, record);

    const found = await availabilityIndex.candidatesInFineCell(
      { kv },
      "shard-1",
      record.fineCellId,
      availabilityIndex.AVAILABILITY_CLASS.IDLE_READY,
    );
    expect(found).not.toContain("agent-c");
  });

  test("secondary index filtering intersects the primary set with the capability set", async () => {
    const cold = availabilityIndex.positionRecord({
      agentId: "agent-cold",
      shardId: "shard-2",
      lat: 1,
      lon: 1,
      capabilityClasses: ["REFRIGERATED"],
      state: { lifecycleEligible: true, hasActiveCommitment: false, idle: true },
      decisionTimeMs: DECISION_TIME_MS,
      finishingSoonHorizonSeconds: 300,
    }).record;
    const warm = availabilityIndex.positionRecord({
      agentId: "agent-warm",
      shardId: "shard-2",
      lat: 1,
      lon: 1,
      capabilityClasses: [],
      state: { lifecycleEligible: true, hasActiveCommitment: false, idle: true },
      decisionTimeMs: DECISION_TIME_MS,
      finishingSoonHorizonSeconds: 300,
    }).record;
    await availabilityIndex.applyPosition({ kv }, null, cold);
    await availabilityIndex.applyPosition({ kv }, null, warm);

    const anyAgent = await availabilityIndex.candidatesInFineCell(
      { kv },
      "shard-2",
      cold.fineCellId,
      availabilityIndex.AVAILABILITY_CLASS.IDLE_READY,
    );
    expect(anyAgent.sort()).toEqual(["agent-cold", "agent-warm"]);

    const refrigeratedOnly = await availabilityIndex.candidatesInFineCell(
      { kv },
      "shard-2",
      cold.fineCellId,
      availabilityIndex.AVAILABILITY_CLASS.IDLE_READY,
      { capabilityClass: "REFRIGERATED" },
    );
    expect(refrigeratedOnly).toEqual(["agent-cold"]);
  });

  test("candidatesInCoarseCell finds an agent via the regional sweep key", async () => {
    const record = availabilityIndex.positionRecord({
      agentId: "agent-region",
      shardId: "shard-3",
      lat: 40,
      lon: 40,
      state: { lifecycleEligible: true, hasActiveCommitment: false, idle: true },
      decisionTimeMs: DECISION_TIME_MS,
      finishingSoonHorizonSeconds: 300,
    }).record;
    await availabilityIndex.applyPosition({ kv }, null, record);

    const found = await availabilityIndex.candidatesInCoarseCell(
      { kv },
      "shard-3",
      record.coarseCellId,
      availabilityIndex.AVAILABILITY_CLASS.IDLE_READY,
    );
    expect(found).toEqual(["agent-region"]);
  });

  test("a kv failure degrades to an empty result, never a thrown error (advisory index, §3.3, I16)", async () => {
    const throwingKv = {
      smembers: async () => {
        throw new Error("redis down");
      },
      sadd: async () => {
        throw new Error("redis down");
      },
      srem: async () => {
        throw new Error("redis down");
      },
    };
    await expect(
      availabilityIndex.candidatesInFineCell({ kv: throwingKv }, "s", "c", availabilityIndex.AVAILABILITY_CLASS.IDLE_READY),
    ).resolves.toEqual([]);

    const record = availabilityIndex.positionRecord({
      agentId: "agent-x",
      shardId: "s",
      lat: 1,
      lon: 1,
      state: { lifecycleEligible: true, hasActiveCommitment: false, idle: true },
      decisionTimeMs: DECISION_TIME_MS,
      finishingSoonHorizonSeconds: 300,
    }).record;
    await expect(availabilityIndex.applyPosition({ kv: throwingKv }, null, record)).resolves.toEqual({
      ok: false,
      added: [],
      removed: [],
    });
  });

  test("rebuildFromRecords is idempotent and skips nulls without failing", async () => {
    const record = availabilityIndex.positionRecord({
      agentId: "agent-rebuild",
      shardId: "shard-4",
      lat: 5,
      lon: 5,
      state: { lifecycleEligible: true, hasActiveCommitment: false, idle: true },
      decisionTimeMs: DECISION_TIME_MS,
      finishingSoonHorizonSeconds: 300,
    }).record;

    const first = await availabilityIndex.rebuildFromRecords({ kv }, [record, null]);
    expect(first).toEqual({ ok: true, indexed: 1, skipped: 1, failed: 0 });

    const second = await availabilityIndex.rebuildFromRecords({ kv }, [record, null]);
    expect(second).toEqual({ ok: true, indexed: 1, skipped: 1, failed: 0 });

    const found = await availabilityIndex.candidatesInFineCell(
      { kv },
      "shard-4",
      record.fineCellId,
      availabilityIndex.AVAILABILITY_CLASS.IDLE_READY,
    );
    expect(found).toEqual(["agent-rebuild"]);
  });
});

"use strict";

/**
 * The availability index across a Redis outage.
 *
 * Reproduced defect (2026-10-21): with Redis configured, the KV facade answers from an in-memory
 * store that starts empty when Redis is lost, the index was rebuilt from its durable mirror only
 * at boot, and a sweep writes only deltas — so three available, stationary agents disappeared
 * from candidate search for the whole outage (3 → 0), and came back only when Redis did.
 *
 * Now the facade announces "fallback" and "recovered", and the index maintainer rebuilds from the
 * mirror on each, in the same queue as its sweeps.
 */

const mockStore = { sets: new Map(), strings: new Map(), down: false };

jest.mock("ioredis", () => {
  const unavailable = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const apply = (op, args) => {
    const [key, ...rest] = args;
    if (op === "sadd") {
      const set = mockStore.sets.get(key) || new Set();
      rest.forEach((m) => set.add(String(m)));
      mockStore.sets.set(key, set);
      return rest.length;
    }
    if (op === "srem") {
      rest.forEach((m) => mockStore.sets.get(key)?.delete(String(m)));
      return rest.length;
    }
    if (op === "smembers") return [...(mockStore.sets.get(key) || [])];
    if (op === "del") {
      args.forEach((k) => {
        mockStore.sets.delete(k);
        mockStore.strings.delete(k);
      });
      return args.length;
    }
    if (op === "set") {
      mockStore.strings.set(key, String(rest[0]));
      return "OK";
    }
    if (op === "get") return mockStore.strings.get(key) ?? null;
    throw new Error(`unmodelled ${op}`);
  };
  class FakeRedis {
    on() {
      return this;
    }

    async connect() {
      if (mockStore.down) throw unavailable();
    }

    disconnect() {}

    async quit() {}

    pipeline() {
      const queued = [];
      const builder = {};
      for (const op of ["sadd", "srem", "smembers", "del", "set", "get"]) {
        builder[op] = (...args) => {
          queued.push([op, args]);
          return builder;
        };
      }
      builder.exec = async () => {
        if (mockStore.down) throw unavailable();
        return queued.map(([op, args]) => [null, apply(op, args)]);
      };
      return builder;
    }
  }
  for (const op of ["sadd", "srem", "smembers", "del", "set", "get"]) {
    FakeRedis.prototype[op] = async function command(...args) {
      if (mockStore.down) throw unavailable();
      return apply(op, args);
    };
  }
  return FakeRedis;
});

const { initKv } = require("../../../src/cache/kv");
const availabilityIndex = require("../../../src/engine/candidates/availabilityIndex");
const indexMaintainer = require("../../../src/workers/indexMaintainer.worker");

const quiet = { info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SHARD = "rnsit-shard";

function mirrorRow(agentId, fineCellId = "fine-A") {
  return {
    agentId,
    shardId: SHARD,
    lat: 12.9,
    lon: 77.5,
    fineCellId,
    coarseCellId: "coarse-A",
    availabilityClass: "IDLE",
    capabilityClasses: [],
    containerClasses: [],
  };
}

/** The durable mirror (`AgentCellPosition`), as the rebuild reads it. */
function mirror(rows) {
  const state = { rows, reads: 0 };
  return {
    state,
    prisma: {
      agentCellPosition: {
        findMany: async () => {
          state.reads += 1;
          return state.rows.map((row) => ({ ...row }));
        },
      },
    },
  };
}

async function openKv() {
  const saved = { url: process.env.REDIS_URL, enabled: process.env.REDIS_ENABLED };
  process.env.REDIS_URL = "redis://fake:6379";
  process.env.REDIS_ENABLED = "true";
  try {
    return await initKv({ logger: quiet });
  } finally {
    if (saved.url === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = saved.url;
    process.env.REDIS_ENABLED = saved.enabled;
  }
}

async function eventually(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
}

const inCell = (kv, cell) => availabilityIndex.candidatesInFineCell({ kv }, SHARD, cell, "IDLE");

let handle;
let maintainer;

beforeEach(() => {
  mockStore.sets.clear();
  mockStore.strings.clear();
  mockStore.down = false;
});

afterEach(async () => {
  if (maintainer) maintainer.stop();
  maintainer = null;
  if (handle) await handle.close();
  handle = null;
});

async function startWorld(rows) {
  handle = await openKv();
  const world = mirror(rows);
  // No sweep during the test (it needs the full engine world); the sweep's own effect on the
  // index — a delta per moved agent — is applied explicitly where a test needs it.
  maintainer = indexMaintainer.start({ prisma: world.prisma, kv: handle.kv }, { intervalMs: 3_600_000 });
  await maintainer.idle();
  return world;
}

describe("availability index — a Redis outage does not empty candidate search", () => {
  test("the reproduced case: three stationary agents stay assignable through the outage and after it", async () => {
    const world = await startWorld(["agent-1", "agent-2", "agent-3"].map((id) => mirrorRow(id)));
    const { kv } = handle;
    expect(await inCell(kv, "fine-A")).toEqual(["agent-1", "agent-2", "agent-3"]);

    mockStore.down = true;
    // The first read after the loss is what notices it; the facade then rebuilds into memory.
    await inCell(kv, "fine-A");
    expect(kv.health().redis).toBe(false);
    expect(await eventually(async () => (await inCell(kv, "fine-A")).length === 3)).toBe(true);
    expect(await inCell(kv, "fine-A")).toEqual(["agent-1", "agent-2", "agent-3"]);

    mockStore.down = false;
    expect(await eventually(() => kv.health().redis)).toBe(true);
    await sleep(20);
    await maintainer.idle();
    expect(await inCell(kv, "fine-A")).toEqual(["agent-1", "agent-2", "agent-3"]);
    expect([...mockStore.sets.get(availabilityIndex.fineKey(SHARD, "fine-A", "IDLE"))].sort()).toEqual(["agent-1", "agent-2", "agent-3"]);
    expect(world.state.reads).toBe(3); // boot, fallback, recovery
  }, 15000);

  test("an agent that moves during the outage is in its new cell only — not left in its old one", async () => {
    const world = await startWorld(["agent-1", "agent-2", "agent-3"].map((id) => mirrorRow(id)));
    const { kv } = handle;

    mockStore.down = true;
    await inCell(kv, "fine-A");
    await eventually(async () => (await inCell(kv, "fine-A")).length === 3);
    await maintainer.idle();

    // What a sweep does for a moved agent: the mirror row changes, and the delta is applied.
    const previous = mirrorRow("agent-1", "fine-A");
    const next = mirrorRow("agent-1", "fine-B");
    world.state.rows = [next, mirrorRow("agent-2"), mirrorRow("agent-3")];
    await availabilityIndex.applyPosition({ kv }, previous, next);

    mockStore.down = false;
    expect(await eventually(() => kv.health().redis)).toBe(true);
    await sleep(20);
    await maintainer.idle();

    expect(await inCell(kv, "fine-A")).toEqual(["agent-2", "agent-3"]);
    expect(await inCell(kv, "fine-B")).toEqual(["agent-1"]);
  }, 15000);

  test("an agent that leaves service during the outage is not restored on recovery", async () => {
    const world = await startWorld(["agent-1", "agent-2", "agent-3"].map((id) => mirrorRow(id)));
    const { kv } = handle;

    mockStore.down = true;
    await inCell(kv, "fine-A");
    await eventually(async () => (await inCell(kv, "fine-A")).length === 3);
    await maintainer.idle();

    world.state.rows = [mirrorRow("agent-2"), mirrorRow("agent-3")];
    await availabilityIndex.applyPosition({ kv }, mirrorRow("agent-3"), null);
    await availabilityIndex.applyPosition({ kv }, mirrorRow("agent-1"), null);
    world.state.rows = [mirrorRow("agent-2")];

    mockStore.down = false;
    expect(await eventually(() => kv.health().redis)).toBe(true);
    await sleep(20);
    await maintainer.idle();

    expect(await inCell(kv, "fine-A")).toEqual(["agent-2"]);
  }, 15000);

  test("repeated outages converge: every stationary agent is present after each, exactly once", async () => {
    await startWorld(["agent-1", "agent-2", "agent-3"].map((id) => mirrorRow(id)));
    const { kv } = handle;

    for (let round = 0; round < 2; round += 1) {
      mockStore.down = true;
      await inCell(kv, "fine-A");
      expect(await eventually(async () => (await inCell(kv, "fine-A")).length === 3)).toBe(true);
      mockStore.down = false;
      expect(await eventually(() => kv.health().redis, 8000)).toBe(true);
      await sleep(20);
      await maintainer.idle();
      expect(await inCell(kv, "fine-A")).toEqual(["agent-1", "agent-2", "agent-3"]);
    }
  }, 30000);
});

describe("index maintainer — rebuild scheduling", () => {
  /** A KV stand-in whose mode changes the test announces. */
  function announcingKv() {
    const listeners = new Set();
    const sets = new Map();
    return {
      sets,
      announce: (mode) => [...listeners].forEach((l) => l(mode)),
      listeners,
      onModeChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async sadd(key, ...members) {
        const set = sets.get(key) || new Set();
        members.forEach((m) => set.add(String(m)));
        sets.set(key, set);
        return members.length;
      },
      async srem() {
        return 0;
      },
      async smembers(key) {
        return [...(sets.get(key) || [])];
      },
    };
  }

  test("mode changes during a rebuild are answered by one more rebuild, not one each", async () => {
    const kv = announcingKv();
    let reads = 0;
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const prisma = {
      agentCellPosition: {
        findMany: async () => {
          reads += 1;
          if (reads === 1) await gate; // the boot rebuild is held open
          return [mirrorRow("agent-1")];
        },
      },
    };
    maintainer = indexMaintainer.start({ prisma, kv }, { intervalMs: 3_600_000 });
    await sleep(10);
    kv.announce("fallback");
    kv.announce("recovered");
    kv.announce("fallback");
    release();
    await maintainer.idle();
    await maintainer.idle();

    expect(reads).toBe(2);
    expect(await kv.smembers(availabilityIndex.fineKey(SHARD, "fine-A", "IDLE"))).toEqual(["agent-1"]);
  });

  test("a rebuild that fails is reported and does not stop the next one", async () => {
    const kv = announcingKv();
    const errors = [];
    let reads = 0;
    const prisma = {
      agentCellPosition: {
        findMany: async () => {
          reads += 1;
          if (reads === 1) throw new Error("database unavailable");
          return [mirrorRow("agent-1")];
        },
      },
    };
    maintainer = indexMaintainer.start({ prisma, kv, onError: (e) => errors.push(e.message) }, { intervalMs: 3_600_000 });
    await maintainer.idle();
    expect(errors).toEqual(["database unavailable"]);

    kv.announce("fallback");
    await maintainer.idle();
    expect(await kv.smembers(availabilityIndex.fineKey(SHARD, "fine-A", "IDLE"))).toEqual(["agent-1"]);
  });

  test("stop() unsubscribes: a mode change after it starts nothing", async () => {
    const kv = announcingKv();
    let reads = 0;
    const prisma = { agentCellPosition: { findMany: async () => ((reads += 1), []) } };
    maintainer = indexMaintainer.start({ prisma, kv }, { intervalMs: 3_600_000 });
    await maintainer.idle();
    maintainer.stop();
    expect(kv.listeners.size).toBe(0);
    kv.announce("fallback");
    await maintainer.idle();
    expect(reads).toBe(1);
  });

  test("a KV without mode changes (Redis not configured) is started exactly as before", async () => {
    const kv = announcingKv();
    delete kv.onModeChange;
    let reads = 0;
    const prisma = { agentCellPosition: { findMany: async () => ((reads += 1), [mirrorRow("agent-1")]) } };
    maintainer = indexMaintainer.start({ prisma, kv }, { intervalMs: 3_600_000 });
    await maintainer.idle();
    expect(reads).toBe(1);
    expect(await kv.smembers(availabilityIndex.fineKey(SHARD, "fine-A", "IDLE"))).toEqual(["agent-1"]);
  });
});

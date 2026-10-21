"use strict";

/**
 * A robot re-paired while Redis is down reconnects after Redis recovers — through the real AUTH
 * handler, the KV facade in Redis mode, and the durable `RobotSession` record.
 *
 * Before the facade reconciled its outage writes, Redis came back still holding the session
 * token from before the outage. AUTH found a KV session, saw it did not match the robot's new
 * token, skipped the durable record (it is consulted only on a KV miss), fell through to pairing
 * with a consumed code, and counted a failure toward the lockout.
 */

const crypto = require("crypto");

const mockStore = { strings: new Map(), sets: new Map(), down: false };

jest.mock("ioredis", () => {
  const unavailable = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const apply = (op, args) => {
    const [key, ...rest] = args;
    switch (op) {
      case "set":
        mockStore.strings.set(key, String(rest[0]));
        return "OK";
      case "get":
        return mockStore.strings.has(key) ? mockStore.strings.get(key) : null;
      case "del":
        args.forEach((k) => {
          mockStore.strings.delete(k);
          mockStore.sets.delete(k);
        });
        return args.length;
      case "incr": {
        const next = Number(mockStore.strings.get(key) || 0) + 1;
        mockStore.strings.set(key, String(next));
        return next;
      }
      case "expire":
        return 1;
      case "sadd": {
        const set = mockStore.sets.get(key) || new Set();
        rest.forEach((m) => set.add(String(m)));
        mockStore.sets.set(key, set);
        return rest.length;
      }
      case "srem":
        rest.forEach((m) => mockStore.sets.get(key)?.delete(String(m)));
        return rest.length;
      case "smembers":
        return [...(mockStore.sets.get(key) || [])];
      case "mget":
        return args.flat().map((k) => (mockStore.strings.has(k) ? mockStore.strings.get(k) : null));
      default:
        throw new Error(`unmodelled ${op}`);
    }
  };
  const batch = (ops) => {
    const queued = [];
    const builder = {};
    for (const op of ops) {
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
      return batch(["get", "set", "del", "sadd", "srem", "smembers"]);
    }

    multi() {
      return batch(["incr", "expire"]);
    }
  }
  for (const op of ["set", "get", "del", "incr", "expire", "sadd", "srem", "smembers", "mget"]) {
    FakeRedis.prototype[op] = async function command(...args) {
      if (mockStore.down) throw unavailable();
      return apply(op, args);
    };
  }
  return FakeRedis;
});

const { createFakeSocket, createFakeIo } = require("../../helpers/fakeSocket");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { waitFor } = require("../../helpers/waitFor");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ROBOT_ROW = "row-R1";

/** `RobotSession` with the semantics robotSession.service relies on (as in robotSessionDurability). */
function sessionStore() {
  const rows = new Map();
  const matches = (row, where = {}) =>
    (where.robotDbId === undefined || row.robotDbId === where.robotDbId) &&
    (where.tokenHash === undefined || row.tokenHash === where.tokenHash) &&
    (where.expiresAt?.gt === undefined || row.expiresAt > where.expiresAt.gt);
  return {
    rows,
    findUnique: jest.fn(async ({ where }) => rows.get(where.robotDbId) ?? null),
    upsert: jest.fn(async ({ where, create, update }) => {
      const current = rows.get(where.robotDbId);
      const next = current ? { ...current, ...update } : { ...create };
      rows.set(where.robotDbId, next);
      return next;
    }),
    create: jest.fn(async ({ data }) => {
      if (rows.has(data.robotDbId)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      rows.set(data.robotDbId, { ...data });
      return data;
    }),
    updateMany: jest.fn(async ({ where, data }) => {
      let count = 0;
      for (const [key, row] of rows) {
        if (matches(row, where)) {
          rows.set(key, { ...row, ...data });
          count += 1;
        }
      }
      return { count };
    }),
    deleteMany: jest.fn(async ({ where }) => {
      let count = 0;
      for (const [key, row] of rows) {
        if (matches(row, where)) {
          rows.delete(key);
          count += 1;
        }
      }
      return { count };
    }),
  };
}

let handle;

beforeEach(() => {
  mockStore.strings.clear();
  mockStore.sets.clear();
  mockStore.down = false;
});

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
});

async function startProcess() {
  jest.resetModules();
  const saved = { url: process.env.REDIS_URL, enabled: process.env.REDIS_ENABLED };
  process.env.REDIS_URL = "redis://fake:6379";
  process.env.REDIS_ENABLED = "true";
  try {
    const { initKv } = require("../../../src/cache/kv");
    handle = await initKv({ logger: { info() {}, warn() {}, error() {} } });
  } finally {
    if (saved.url === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = saved.url;
    process.env.REDIS_ENABLED = saved.enabled;
  }
  const { registerRobotHandlers } = require("../../../src/sockets/handlers/robot.handler");
  const prisma = createMockPrisma();
  prisma.robotSession = sessionStore();
  prisma.robot.findUnique.mockImplementation(async ({ where }) =>
    where.robotId === "R1" ? { id: ROBOT_ROW, status: "IDLE", isOnline: false, lat: null, lon: null, battery: 90 } : null,
  );
  prisma.robot.update.mockResolvedValue({ status: "IDLE" });
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const io = createFakeIo();
  const { kv } = handle;

  async function auth(payload) {
    const socket = createFakeSocket();
    registerRobotHandlers(io, socket, { prisma, kv, logger, appLocals: {} });
    socket.trigger("AUTH", payload);
    await waitFor(() => socket.sent.some((s) => s.event === "AUTH_SUCCESS") || socket.disconnect.mock.calls.length > 0);
    const ack = socket.sent.find((s) => s.event === "AUTH_SUCCESS");
    return { ok: Boolean(ack), token: ack?.payload?.token };
  }

  async function pair(code) {
    await kv.set("pairing:R1", code, { ex: 300 }); // what POST /api/robots/commission writes
    return auth({ robotId: "R1", pairingCode: code });
  }

  const authModes = () => logger.info.mock.calls.filter(([m]) => m === "Robot AUTH success").map(([, meta]) => meta.mode);
  return { kv, prisma, auth, pair, authModes };
}

async function untilConnected(kv) {
  const deadline = Date.now() + 4000;
  while (!kv.health().redis && Date.now() < deadline) await sleep(50);
  return kv.health().redis;
}

test("a robot re-paired during a Redis outage reconnects after recovery with the token it was given", async () => {
  const proc = await startProcess();
  const first = await proc.pair("111111");
  expect(first.ok).toBe(true);
  expect(mockStore.strings.get("session:R1")).toBe(first.token);

  mockStore.down = true;
  const second = await proc.pair("222222"); // pairing during the outage: memory + RobotSession
  expect(second.ok).toBe(true);
  expect(second.token).not.toBe(first.token);
  const sha = crypto.createHash("sha256").update(second.token, "utf8").digest("hex");
  expect(proc.prisma.robotSession.rows.get(ROBOT_ROW).tokenHash).toBe(sha);

  mockStore.down = false;
  expect(await untilConnected(proc.kv)).toBe(true);

  // Recovery wrote the outage's session back to Redis, so the robot reconnects with the token it
  // was given during the outage from the live session; the durable record agrees with it.
  expect(mockStore.strings.get("session:R1")).toBe(second.token);
  const back = await proc.auth({ robotId: "R1", token: second.token });
  expect(back.ok).toBe(true);
  expect(proc.authModes().slice(-1)).toEqual(["session"]);
  expect(await proc.kv.get("pairingAttempts:R1")).toBeNull();
}, 15000);

test("the token revoked by that re-pairing is refused after recovery", async () => {
  const proc = await startProcess();
  const first = await proc.pair("111111");
  mockStore.down = true;
  await proc.pair("222222");
  mockStore.down = false;
  expect(await untilConnected(proc.kv)).toBe(true);

  const stale = await proc.auth({ robotId: "R1", token: first.token });
  expect(stale.ok).toBe(false);
}, 15000);

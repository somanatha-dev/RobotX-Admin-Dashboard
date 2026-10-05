/**
 * C1 (LAN-3) — a paired robot's legacy session survives a backend restart, and nothing else
 * about AUTH moves.
 *
 * Before: the session token lived only in the KV (`session:{robotId}`). With
 * `REDIS_ENABLED=false` the KV is process memory. After a restart the token was unknown, AUTH
 * fell through to pairing with a consumed code, and five of those locked the robot out for an
 * hour.
 *
 * Now: pairing also records a SHA-256 of the token in `RobotSession`. AUTH consults that row
 * only when the KV holds no session at all.
 *
 * In this file a "restart" is a **fresh in-memory KV and a fresh handler over the same
 * durable store**: exactly the state a new process starts in. The proof across a real process
 * death, against PostgreSQL, is `tools/verify/c1SessionRestart.js`.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createTestKv } = require("../../helpers/testKv");
const { createFakeSocket, createFakeIo } = require("../../helpers/fakeSocket");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { waitFor } = require("../../helpers/waitFor");

const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
const ROBOTS = { R1: "row-R1", R2: "row-R2" };

/** An in-memory `RobotSession` table with the semantics the service relies on. */
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

/** The durable world (the database) outlives every "process" made from it. */
function createWorld() {
  const store = sessionStore();
  const prisma = createMockPrisma();
  prisma.robotSession = store;
  prisma.robot.findUnique.mockImplementation(async ({ where }) =>
    ROBOTS[where.robotId] ? { id: ROBOTS[where.robotId], status: "IDLE", isOnline: false, lat: null, lon: null, battery: 90 } : null,
  );
  prisma.robot.update.mockResolvedValue({ status: "IDLE" });
  return { prisma, store };
}

/** One backend process: its own KV (process memory) and its own handler module state. */
async function startProcess(world) {
  jest.resetModules();
  const { registerRobotHandlers } = require("../../../src/sockets/handlers/robot.handler");
  const { kv } = await createTestKv();
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const io = createFakeIo();

  async function auth(payload) {
    const socket = createFakeSocket();
    registerRobotHandlers(io, socket, { prisma: world.prisma, kv, logger, appLocals: {} });
    socket.trigger("AUTH", payload);
    await waitFor(() => socket.sent.some((s) => s.event === "AUTH_SUCCESS") || socket.disconnect.mock.calls.length > 0);
    const ack = socket.sent.find((s) => s.event === "AUTH_SUCCESS");
    return { ok: Boolean(ack), token: ack?.payload?.token, socket };
  }

  const authModes = () => logger.info.mock.calls.filter(([m]) => m === "Robot AUTH success").map(([, meta]) => meta.mode);
  return { kv, logger, auth, authModes };
}

async function pair(proc, robotId = "R1", code = "123456") {
  await proc.kv.set(`pairing:${robotId}`, code, { ex: 300 }); // what POST /api/robots/commission writes
  return proc.auth({ robotId, pairingCode: code });
}

describe("C1 — robot sessions are durable across a backend restart", () => {
  test("1. first pairing succeeds, records only a hash of the token, and consumes the code", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    const paired = await pair(p1);

    expect(paired.ok).toBe(true);
    expect(typeof paired.token).toBe("string");
    const row = world.store.rows.get("row-R1");
    expect(row.tokenHash).toBe(sha256(paired.token));
    expect(Object.values(row).map(String).some((v) => v.includes(paired.token))).toBe(false);
    const ttlMs = row.expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(86_400_000 - 5_000);
    expect(ttlMs).toBeLessThanOrEqual(86_400_000);
    expect(await p1.kv.get("pairing:R1")).toBeNull();
    expect(p1.authModes()).toEqual(["pairing"]);
  });

  test("2/3. AUTH with the token, no restart: admitted from the KV, same token, durable expiry slid", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    const { token } = await pair(p1);
    world.store.rows.get("row-R1").expiresAt = new Date(Date.now() + 60_000);

    const again = await p1.auth({ robotId: "R1", token });
    expect(again.ok).toBe(true);
    expect(again.token).toBe(token);
    expect(world.store.rows.get("row-R1").expiresAt.getTime()).toBeGreaterThan(Date.now() + 86_400_000 - 5_000);
    expect(p1.authModes()).toEqual(["pairing", "session"]);
  });

  test("4. after a restart the same token is admitted, with no pairing and no failure counted", async () => {
    const world = createWorld();
    const { token } = await pair(await startProcess(world));

    const p2 = await startProcess(world); // the KV is empty: a new process
    expect(await p2.kv.get("session:R1")).toBeNull();
    const back = await p2.auth({ robotId: "R1", token });

    expect(back.ok).toBe(true);
    expect(back.token).toBe(token);
    expect(p2.authModes()).toEqual(["durable-session"]);
    expect(await p2.kv.get("pairingAttempts:R1")).toBeNull();
    expect(world.store.upsert).toHaveBeenCalledTimes(1); // the pairing only; nothing re-issued
  });

  test("4b. BEFORE-C1 behaviour, for contrast: without the durable row the restart strands the robot", async () => {
    const world = createWorld();
    const { token } = await pair(await startProcess(world));
    world.store.rows.clear(); // what the database held before C1: nothing

    const p2 = await startProcess(world);
    expect((await p2.auth({ robotId: "R1", token })).ok).toBe(false);
    expect(Number(await p2.kv.get("pairingAttempts:R1"))).toBe(1);
  });

  test("5. an invalid token after a restart is refused and counted, never admitted", async () => {
    const world = createWorld();
    await pair(await startProcess(world));
    const p2 = await startProcess(world);

    const forged = await p2.auth({ robotId: "R1", token: crypto.randomUUID() });
    expect(forged.ok).toBe(false);
    expect(forged.socket.disconnect).toHaveBeenCalledWith(true);
    expect(forged.socket.data.isAuthed).toBeUndefined();
    expect(Number(await p2.kv.get("pairingAttempts:R1"))).toBe(1);

    const tokenless = await p2.auth({ robotId: "R1" });
    expect(tokenless.ok).toBe(false);
  });

  test("6. an expired session is refused after a restart", async () => {
    const world = createWorld();
    const { token } = await pair(await startProcess(world));
    world.store.rows.get("row-R1").expiresAt = new Date(Date.now() - 1);

    const p2 = await startProcess(world);
    expect((await p2.auth({ robotId: "R1", token })).ok).toBe(false);
    // Refused, not slid: an expired row is never brought back by presenting its token.
    expect(world.store.rows.get("row-R1").expiresAt.getTime()).toBeLessThan(Date.now());
  });

  test("7a. re-pairing revokes the previous token, and the revocation survives a restart", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    const first = await pair(p1, "R1", "111111");
    const second = await pair(p1, "R1", "222222");
    expect(second.ok).toBe(true);
    expect(second.token).not.toBe(first.token);
    expect((await p1.auth({ robotId: "R1", token: first.token })).ok).toBe(false);

    const p2 = await startProcess(world);
    expect((await p2.auth({ robotId: "R1", token: first.token })).ok).toBe(false);
    expect((await p2.auth({ robotId: "R1", token: second.token })).ok).toBe(true);
  });

  test("7b. a removed durable session (mTLS replacement, Robot deleted) is refused after a restart", async () => {
    const world = createWorld();
    const { token } = await pair(await startProcess(world));
    await require("../../../src/services/robotSession.service").revoke(world.prisma, "row-R1");

    const p2 = await startProcess(world);
    expect((await p2.auth({ robotId: "R1", token })).ok).toBe(false);
  });

  test("7c. the mTLS branch revokes the durable bearer record before it writes the binding", () => {
    const raw = fs.readFileSync(path.join(__dirname, "../../../src/sockets/handlers/robot.handler.js"), "utf8");
    const mtls = raw.slice(raw.indexOf('if (certificateSession.mode === "MTLS") {'));
    expect(mtls.indexOf("robotSession.revoke(prisma, robot.id)")).toBeGreaterThan(-1);
    expect(mtls.indexOf("robotSession.revoke(prisma, robot.id)")).toBeLessThan(mtls.indexOf("kv.set(sessionBinding.sessionKey(robotId)"));
  });

  test("8. another robot presenting this robot's token is refused, and the owner's row is untouched", async () => {
    const world = createWorld();
    const { token } = await pair(await startProcess(world));
    const before = { ...world.store.rows.get("row-R1") };

    const p2 = await startProcess(world);
    const impostor = await p2.auth({ robotId: "R2", token });
    expect(impostor.ok).toBe(false);
    expect(world.store.rows.get("row-R1")).toEqual(before);
    expect(world.store.rows.has("row-R2")).toBe(false);
    expect((await p2.auth({ robotId: "R1", token })).ok).toBe(true);
  });

  test("9. repeated invalid attempts after a restart still lock pairing; a valid session still reconnects", async () => {
    const world = createWorld();
    const { token } = await pair(await startProcess(world));
    const p2 = await startProcess(world);

    for (let i = 0; i < 5; i += 1) expect((await p2.auth({ robotId: "R1", token: crypto.randomUUID() })).ok).toBe(false);
    expect(await p2.kv.get("pairingLocked:R1")).toBe("1");
    // A correct, freshly minted code is now refused: the lockout is intact.
    expect((await pair(p2, "R1", "654321")).ok).toBe(false);
    // As before C1, the lockout gates the pairing branch only; the live session reconnects.
    expect((await p2.auth({ robotId: "R1", token })).ok).toBe(true);
  });

  test("10. valid reconnects after a restart count no failure and do not touch pairing", async () => {
    const world = createWorld();
    const { token } = await pair(await startProcess(world));
    const p2 = await startProcess(world);

    for (let i = 0; i < 6; i += 1) expect((await p2.auth({ robotId: "R1", token })).ok).toBe(true);
    expect(await p2.kv.get("pairingAttempts:R1")).toBeNull();
    expect(await p2.kv.get("pairingLocked:R1")).toBeNull();
    expect(world.store.upsert).toHaveBeenCalledTimes(1);
    expect(p2.authModes()).toEqual(Array(6).fill("durable-session"));
  });

  test("11. duplicate AUTH after a restart: both admitted, the earlier socket replaced; a replayed code is refused", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    const { token } = await pair(p1, "R1", "123456");
    expect((await p1.auth({ robotId: "R1", pairingCode: "123456" })).ok).toBe(false);

    const p2 = await startProcess(world);
    const a = await p2.auth({ robotId: "R1", token });
    const b = await p2.auth({ robotId: "R1", token });
    expect(a.ok && b.ok).toBe(true);
    expect(a.socket.disconnect).toHaveBeenCalledWith(true);
    expect(b.socket.disconnect).not.toHaveBeenCalled();
  });

  test("a KV that holds a certificate binding is never bypassed by the durable record (P14-R8)", async () => {
    const world = createWorld();
    const { token } = await pair(await startProcess(world));
    const p2 = await startProcess(world);
    await p2.kv.set("session:R1", JSON.stringify({ fingerprint: "ab:cd", sessionId: "s-1" }), { ex: 60 });

    expect((await p2.auth({ robotId: "R1", token })).ok).toBe(false);
    expect(world.store.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ expiresAt: expect.anything() }) }));
  });

  test("a KV session is authoritative: the durable record is not consulted for a token the KV rejects", async () => {
    const world = createWorld();
    const { token } = await pair(await startProcess(world));
    const p2 = await startProcess(world);
    await p2.kv.set("session:R1", "a-newer-token", { ex: 60 });

    expect((await p2.auth({ robotId: "R1", token })).ok).toBe(false);
  });

  test("a durable read failure fails closed (refused, as an unknown token always was)", async () => {
    const world = createWorld();
    const { token } = await pair(await startProcess(world));
    world.store.updateMany.mockRejectedValueOnce(new Error("connection reset"));

    const p2 = await startProcess(world);
    expect((await p2.auth({ robotId: "R1", token })).ok).toBe(false);
  });

  test("a pairing whose durable record fails issues nothing and leaves the code usable", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    world.store.upsert.mockRejectedValueOnce(new Error("connection reset"));

    expect((await pair(p1, "R1", "123456")).ok).toBe(false);
    expect(await p1.kv.get("session:R1")).toBeNull();
    expect(await p1.kv.get("pairing:R1")).toBe("123456");
    expect(await p1.kv.get("pairingAttempts:R1")).toBeNull();
    expect((await p1.auth({ robotId: "R1", pairingCode: "123456" })).ok).toBe(true);
  });

  test("a failed durable refresh on a KV reconnect does not refuse the robot", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    const { token } = await pair(p1);
    world.store.updateMany.mockRejectedValueOnce(new Error("connection reset"));

    expect((await p1.auth({ robotId: "R1", token })).ok).toBe(true);
    expect(p1.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/durable session refresh failed/), expect.anything());
  });
});

describe("C1 — robotSession.service", () => {
  const robotSession = require("../../../src/services/robotSession.service");

  test("refresh never overwrites a newer pairing's record with an older token", async () => {
    const world = createWorld();
    await robotSession.recordIssued(world.prisma, "row-R1", "token-new");
    expect(await robotSession.refresh(world.prisma, "row-R1", "token-old")).toBe("SUPERSEDED");
    expect(world.store.rows.get("row-R1").tokenHash).toBe(sha256("token-new"));
  });

  test("refresh creates the record for a KV session that predates the table", async () => {
    const world = createWorld();
    expect(await robotSession.refresh(world.prisma, "row-R1", "token-a")).toBe("CREATED");
    expect(await robotSession.refresh(world.prisma, "row-R1", "token-a")).toBe("REFRESHED");
  });

  test("validate is scoped to the robot, the token's hash and an unexpired row", async () => {
    const world = createWorld();
    await robotSession.recordIssued(world.prisma, "row-R1", "token-a");
    expect(await robotSession.validate(world.prisma, "row-R1", "token-a")).toBe(true);
    expect(await robotSession.validate(world.prisma, "row-R2", "token-a")).toBe(false);
    expect(await robotSession.validate(world.prisma, "row-R1", "token-b")).toBe(false);
    expect(await robotSession.validate(world.prisma, "row-R1", "")).toBe(false);
    expect(await robotSession.validate(world.prisma, "row-R1", null)).toBe(false);
    world.store.rows.get("row-R1").expiresAt = new Date(Date.now() - 1);
    expect(await robotSession.validate(world.prisma, "row-R1", "token-a")).toBe(false);
  });
});

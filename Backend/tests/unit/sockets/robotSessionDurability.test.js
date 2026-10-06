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

  // R2 — one HEARTBEAT on an authenticated socket, awaited through the throttled database flush
  // (the `lastSeenAt` write) and whatever the flush awaits after it.
  const lastSeenWrites = () => world.prisma.robot.update.mock.calls.filter(([arg]) => arg?.data?.lastSeenAt).length;
  async function heartbeat(socket, payload = {}) {
    const before = lastSeenWrites();
    socket.trigger("HEARTBEAT", payload);
    await waitFor(() => lastSeenWrites() > before);
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }

  // The service instance this process's handler uses (same module registry), for spying.
  const robotSession = require("../../../src/services/robotSession.service");
  return { kv, logger, io, auth, authModes, heartbeat, robotSession };
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

/**
 * R2 — the durable session expiry used to slide only at AUTH, so a robot that stayed connected
 * for more than 24 h was refused at its next reconnect. The heartbeat's throttled database flush
 * now slides `RobotSession.expiresAt`, conditionally on this robot, this socket's token hash and
 * an unexpired row. The KV `session:` key is not touched.
 */
describe("R2 — a session in continuous use is renewed by the heartbeat flush", () => {
  const DAY_MS = 86_400_000;
  const renewalCalls = (store) => store.updateMany.mock.calls.filter(([arg]) => arg?.where?.tokenHash && arg?.where?.expiresAt);

  test("A. the heartbeat flush moves an active session's expiry forward by the session lifetime", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    const { token, socket } = await pair(p1);
    expect(socket.data.sessionTokenHash).toBe(sha256(token));
    expect(socket.data.robotDbId).toBe("row-R1");
    world.store.rows.get("row-R1").expiresAt = new Date(Date.now() + 60_000); // close to lapsing

    await p1.heartbeat(socket);

    const row = world.store.rows.get("row-R1");
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + DAY_MS - 5_000);
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + DAY_MS);
    expect(row.tokenHash).toBe(sha256(token));
  });

  test("B. an expired session is not revived by a heartbeat", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    const { socket } = await pair(p1);
    const expiredAt = new Date(Date.now() - 1);
    world.store.rows.get("row-R1").expiresAt = expiredAt;

    await p1.heartbeat(socket);

    expect(renewalCalls(world.store)).toHaveLength(1); // asked, and matched nothing
    expect(world.store.rows.get("row-R1").expiresAt).toEqual(expiredAt);
  });

  test("C. a superseded token is not renewed: the socket of a replaced pairing extends nothing", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    const first = await pair(p1, "R1", "111111");
    const second = await pair(p1, "R1", "222222");
    expect(world.store.rows.get("row-R1").tokenHash).toBe(sha256(second.token));
    const liveExpiry = new Date(Date.now() + 60_000);
    world.store.rows.get("row-R1").expiresAt = liveExpiry;

    await p1.heartbeat(first.socket); // the replaced socket, still carrying sha256(first.token)

    expect(renewalCalls(world.store)).toHaveLength(1);
    expect(renewalCalls(world.store)[0][0].where.tokenHash).toBe(sha256(first.token));
    expect(world.store.rows.get("row-R1")).toMatchObject({ tokenHash: sha256(second.token), expiresAt: liveExpiry });
  });

  test("D. a heartbeat renews only its own robot's session; a robot/token mismatch renews nothing", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    const r1 = await pair(p1, "R1", "111111");
    const r2 = await pair(p1, "R2", "222222");
    const r2Expiry = new Date(Date.now() + 60_000);
    world.store.rows.get("row-R1").expiresAt = new Date(Date.now() + 60_000);
    world.store.rows.get("row-R2").expiresAt = r2Expiry;

    await p1.heartbeat(r1.socket);

    expect(world.store.rows.get("row-R1").expiresAt.getTime()).toBeGreaterThan(Date.now() + DAY_MS - 5_000);
    expect(world.store.rows.get("row-R2").expiresAt).toEqual(r2Expiry);

    // The service itself: a hash only renews the row of the robot it belongs to.
    const robotSession = require("../../../src/services/robotSession.service");
    expect(await robotSession.renewLive(world.prisma, "row-R2", sha256(r1.token))).toBe(false);
    expect(await robotSession.renewLive(world.prisma, "row-R1", sha256(r2.token))).toBe(false);
    expect(world.store.rows.get("row-R2").expiresAt).toEqual(r2Expiry);
    const calls = world.store.updateMany.mock.calls.length;
    expect(await robotSession.renewLive(world.prisma, "", sha256(r1.token))).toBe(false);
    expect(await robotSession.renewLive(world.prisma, "row-R1", null)).toBe(false);
    expect(world.store.updateMany.mock.calls.length).toBe(calls); // no query without both keys
  });

  test("E. mTLS is unchanged: the bearer record is revoked as before, and the heartbeat renews no bearer session", async () => {
    const sessionBinding = require("../../../src/engine/security/sessionBinding");
    const certificate = { raw: Buffer.from("certificate-for-R1") };
    const certificateRow = {
      id: "cert-r1",
      fingerprint: sessionBinding.fingerprint(certificate),
      agentId: "R1",
      status: sessionBinding.CERTIFICATE_STATUS.ACTIVE,
      keyStorage: sessionBinding.KEY_STORAGE.SECURE_ELEMENT,
      notBefore: new Date(Date.now() - DAY_MS),
      notAfter: new Date(Date.now() + 365 * DAY_MS),
      revokedAt: null,
      revocationReason: null,
    };
    const world = createWorld();
    world.prisma.agentCertificate = {
      findUnique: jest.fn(async ({ where }) => (where.fingerprint === certificateRow.fingerprint ? certificateRow : null)),
      findMany: jest.fn(async () => [certificateRow]),
      updateMany: jest.fn(async () => ({ count: 1 })),
    };
    const p1 = await startProcess(world);
    await pair(p1); // a bearer session first, which the certificate session must replace
    expect(world.store.rows.has("row-R1")).toBe(true);

    const mtls = await p1.auth({ robotId: "R1", certificate });
    expect(mtls.ok).toBe(true);
    expect(p1.authModes()).toEqual(["pairing", "mtls"]);
    expect(mtls.socket.data.certificateBinding).toBeTruthy();
    expect(mtls.socket.data.sessionTokenHash).toBeNull();
    expect(world.store.rows.has("row-R1")).toBe(false); // revoked, exactly as before R2
    const binding = await p1.kv.get("session:R1");
    expect(JSON.parse(binding).fingerprint).toBe(certificateRow.fingerprint);

    const renewLive = jest.spyOn(p1.robotSession, "renewLive");
    const updatesBefore = world.store.updateMany.mock.calls.length;
    await p1.heartbeat(mtls.socket);

    expect(renewLive).not.toHaveBeenCalled();
    expect(world.store.updateMany.mock.calls.length).toBe(updatesBefore);
    expect(world.store.rows.has("row-R1")).toBe(false); // nothing created for an mTLS session
    // The heartbeat's existing §23.2 revocation re-check still runs on the binding (it rolls
    // the check window forward) and still names the same certificate and session.
    const before = JSON.parse(binding);
    const after = JSON.parse(await p1.kv.get("session:R1"));
    expect(after).toMatchObject({ agentId: "R1", fingerprint: before.fingerprint, sessionId: before.sessionId, certificateId: "cert-r1" });
    expect(after.lastRevocationCheckAtMs).toBeGreaterThanOrEqual(before.lastRevocationCheckAtMs);
  });

  test("a bearer session's KV `session:` key is never written by a heartbeat", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    const { token, socket } = await pair(p1);
    const set = jest.spyOn(p1.kv, "set");

    await p1.heartbeat(socket);

    expect(set.mock.calls.filter(([key]) => String(key).startsWith("session:"))).toEqual([]);
    expect(await p1.kv.get("session:R1")).toBe(token);
  });

  describe("F. a simulated 25-hour continuous run", () => {
    // Only `Date` is faked, and it advances with real time between jumps, so `waitFor`, the
    // flush's awaits and `setImmediate` all run normally while the wall clock moves 25 h.
    const ONLY_DATE = [
      "hrtime", "nextTick", "performance", "queueMicrotask", "requestAnimationFrame", "cancelAnimationFrame",
      "requestIdleCallback", "cancelIdleCallback", "setImmediate", "clearImmediate", "setInterval",
      "clearInterval", "setTimeout", "clearTimeout",
    ];
    const STEP_MS = 30 * 60_000; // one flushed heartbeat per half hour (the flush gate is 15 s)
    const HOURS = 25;

    async function runConnected({ withRenewal }) {
      const t0 = Date.now();
      jest.useFakeTimers({ now: t0, advanceTimers: true, doNotFake: ONLY_DATE });
      const world = createWorld();
      const p1 = await startProcess(world);
      const { token, socket } = await pair(p1);
      // BEFORE R2, for contrast: the heartbeat path exactly as it was, i.e. without the renewal.
      if (!withRenewal) jest.spyOn(p1.robotSession, "renewLive").mockResolvedValue(false);

      for (let t = t0 + STEP_MS; t <= t0 + HOURS * 3_600_000; t += STEP_MS) {
        jest.setSystemTime(t);
        await p1.heartbeat(socket);
      }
      return { world, p1, token, t0 };
    }

    afterEach(() => jest.useRealTimers());

    test("with heartbeats the session stays valid; reconnect and restart after 25 h succeed through RobotSession", async () => {
      const { world, p1, token, t0 } = await runConnected({ withRenewal: true });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(HOURS * 3_600_000);

      // The KV key was never slid: it lapsed 24 h after the pairing, as before R2.
      expect(await p1.kv.get("session:R1")).toBeNull();
      // The durable row was: it is still live, a full lifetime ahead of the last flush.
      expect(world.store.rows.get("row-R1").expiresAt.getTime()).toBeGreaterThan(Date.now() + DAY_MS - STEP_MS - 5_000);

      const reconnect = await p1.auth({ robotId: "R1", token });
      expect(reconnect.ok).toBe(true);
      expect(reconnect.token).toBe(token);

      const p2 = await startProcess(world); // a backend restart after 25 h
      const afterRestart = await p2.auth({ robotId: "R1", token });
      expect(afterRestart.ok).toBe(true);
      expect(afterRestart.token).toBe(token);
      expect(p1.authModes()).toEqual(["pairing", "durable-session"]);
      expect(p2.authModes()).toEqual(["durable-session"]);
      expect(await p2.kv.get("pairingAttempts:R1")).toBeNull();
    });

    test("BEFORE R2, for contrast: the same 25 h with no renewal strands the robot at its next reconnect", async () => {
      const { world, p1, token } = await runConnected({ withRenewal: false });

      expect(world.store.rows.get("row-R1").expiresAt.getTime()).toBeLessThan(Date.now());
      expect((await p1.auth({ robotId: "R1", token })).ok).toBe(false);
      const p2 = await startProcess(world);
      expect((await p2.auth({ robotId: "R1", token })).ok).toBe(false);
      expect(Number(await p2.kv.get("pairingAttempts:R1"))).toBe(1);
    });
  });
});

/**
 * Y1 — a replaced socket's late `disconnect` must not take the robot offline, through the real
 * handler: AUTH on socket A, AUTH on socket B for the same robot, then A's `disconnect` event.
 *
 * The robot table here is stateful and applies `where` literally (the conditional updates are
 * compare-and-set, as in the real client). The race is driven deterministically: A's handler is
 * held at its offline write — after its "is this still the current socket?" checks passed — while
 * B authenticates, which is the window the checks alone could not close.
 */
describe("Y1 — a replaced socket's late disconnect leaves the robot online", () => {
  function statefulRobots(world) {
    const rows = new Map(
      Object.entries(ROBOTS).map(([robotId, id]) => [
        robotId,
        { id, robotId, status: "IDLE", isOnline: false, socketId: null, statusBeforeOffline: null, lat: null, lon: null, battery: 90 },
      ]),
    );
    const matches = (row, where) => Object.entries(where).every(([k, v]) => row[k] === v);
    world.prisma.robot.findUnique.mockImplementation(async ({ where }) => (rows.has(where.robotId) ? { ...rows.get(where.robotId) } : null));
    world.prisma.robot.update.mockImplementation(async ({ where, data }) => Object.assign(rows.get(where.robotId), data) && { ...rows.get(where.robotId) });
    world.prisma.robot.updateMany.mockImplementation(async ({ where, data }) => {
      const row = rows.get(where.robotId);
      if (!row || !matches(row, where)) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    });
    return rows;
  }

  /** Hold the first offline write (a robot update to OFFLINE) until released. */
  function holdOfflineWrite(world) {
    const write = world.prisma.robot.updateMany.getMockImplementation();
    let reached;
    let release;
    const atWrite = new Promise((resolve) => (reached = resolve));
    const released = new Promise((resolve) => (release = resolve));
    let armed = true;
    world.prisma.robot.updateMany.mockImplementation(async (args) => {
      if (armed && args?.data?.status === "OFFLINE") {
        armed = false;
        reached();
        await released;
      }
      return write(args);
    });
    return { atWrite, release };
  }

  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const registry = async (proc) => JSON.parse(await proc.kv.get("registry:R1"));
  const offlineEmits = (proc) => proc.io.roomEmits("dashboard").filter((e) => e.event === "robot_offline");

  test("socket A authenticated → socket B replaces it → A's late disconnect: R1 stays ONLINE on socket B", async () => {
    const world = createWorld();
    const robots = statefulRobots(world);
    const p1 = await startProcess(world);
    const a = await pair(p1);
    expect(robots.get("R1")).toMatchObject({ isOnline: true, socketId: a.socket.id });

    const hold = holdOfflineWrite(world);
    a.socket.trigger("disconnect"); // A's handler: A is still the current socket, so its checks pass …
    await hold.atWrite; //             … and it is now about to write OFFLINE

    const b = await p1.auth({ robotId: "R1", token: a.token }); // B authenticates for the same robot
    expect(b.ok).toBe(true);
    await waitFor(async () => (await registry(p1))?.socketId === b.socket.id);
    await waitFor(async () => (await p1.kv.smembers("robots:all")).includes("R1"));
    expect(robots.get("R1")).toMatchObject({ isOnline: true, socketId: b.socket.id });

    hold.release(); // A's delayed offline transition now runs
    await settle();

    expect(robots.get("R1")).toMatchObject({ isOnline: true, status: "IDLE", socketId: b.socket.id });
    expect(await registry(p1)).toMatchObject({ socketId: b.socket.id, connected: true });
    expect(await p1.kv.smembers("robots:all")).toContain("R1");
    expect(offlineEmits(p1)).toEqual([]);
    expect(world.prisma.robot.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ socketId: a.socket.id }) }));

    // R2 is untouched: the live socket B still renews its durable session on the heartbeat flush.
    expect(b.socket.data).toMatchObject({ robotDbId: "row-R1", sessionTokenHash: sha256(a.token) });
    world.store.rows.get("row-R1").expiresAt = new Date(Date.now() + 60_000);
    await p1.heartbeat(b.socket);
    expect(world.store.rows.get("row-R1").expiresAt.getTime()).toBeGreaterThan(Date.now() + 86_400_000 - 5_000);
  });

  test("A's disconnect after B fully replaced it is also a no-op", async () => {
    const world = createWorld();
    const robots = statefulRobots(world);
    const p1 = await startProcess(world);
    const a = await pair(p1);
    const b = await p1.auth({ robotId: "R1", token: a.token });
    expect(a.socket.disconnect).toHaveBeenCalledWith(true); // the replacement closed A

    a.socket.trigger("disconnect");
    await settle();

    expect(robots.get("R1")).toMatchObject({ isOnline: true, socketId: b.socket.id });
    expect(await registry(p1)).toMatchObject({ socketId: b.socket.id, connected: true });
    expect(offlineEmits(p1)).toEqual([]);
  });

  test("the current socket's disconnect takes R1 offline; a repeated disconnect changes nothing more", async () => {
    const world = createWorld();
    const robots = statefulRobots(world);
    const p1 = await startProcess(world);
    const b = await pair(p1);

    b.socket.trigger("disconnect");
    await settle();
    expect(robots.get("R1")).toMatchObject({ isOnline: false, status: "OFFLINE", socketId: null, statusBeforeOffline: "IDLE" });
    expect(await registry(p1)).toMatchObject({ connected: false });
    expect(await p1.kv.smembers("robots:all")).not.toContain("R1");
    expect(offlineEmits(p1)).toEqual([{ event: "robot_offline", payload: { robotId: "R1" } }]);

    const after = { ...robots.get("R1") };
    b.socket.trigger("disconnect");
    await settle();
    expect(robots.get("R1")).toEqual(after);
    expect(offlineEmits(p1)).toHaveLength(1);

    const back = await p1.auth({ robotId: "R1", token: b.token }); // LF-1 restoration still works
    expect(back.ok).toBe(true);
    expect(robots.get("R1")).toMatchObject({ isOnline: true, status: "IDLE", socketId: back.socket.id });
  });
});

/**
 * R1 — a robot must be able to tell "your credential is invalid" from "the backend could not
 * finish". The first is now an explicit `AUTH_FAILED { reason: "INVALID_CREDENTIAL" }` before the
 * disconnect; the second stays the plain disconnect it always was. A robot that discarded its
 * token on the second would strand itself over a database blip.
 */
describe("R1 — AUTH_FAILED names a definite credential rejection, and nothing else", () => {
  const { AUTH_FAILURE_REASON } = require("../../../src/sockets/handlers/robot.handler");
  const REFUSED = { event: "AUTH_FAILED", payload: { reason: "INVALID_CREDENTIAL" } };
  const authFailed = (socket) => socket.sent.filter((s) => s.event === "AUTH_FAILED");
  const succeeded = (socket) => socket.sent.filter((s) => s.event === "AUTH_SUCCESS" || s.event === "AUTH_OK").map((s) => s.event);

  /** A definite verdict: exactly one AUTH_FAILED, carrying only the reason, sent before the disconnect. */
  function expectCredentialRefused(result) {
    expect(result.ok).toBe(false);
    expect(authFailed(result.socket)).toEqual([REFUSED]);
    expect(result.socket.disconnect).toHaveBeenCalledWith(true);
    const sentAt = result.socket.emitToClient.mock.invocationCallOrder[result.socket.sent.findIndex((s) => s.event === "AUTH_FAILED")];
    expect(sentAt).toBeLessThan(result.socket.disconnect.mock.invocationCallOrder[0]);
  }
  /** No verdict: the disconnect as before, and no AUTH_FAILED a robot could act on. */
  function expectSilentRefusal(result) {
    expect(result.ok).toBe(false);
    expect(authFailed(result.socket)).toEqual([]);
    expect(result.socket.disconnect).toHaveBeenCalledWith(true);
  }

  test("the wire reason is the single stable value INVALID_CREDENTIAL", () => {
    expect(AUTH_FAILURE_REASON).toEqual({ INVALID_CREDENTIAL: "INVALID_CREDENTIAL" });
    expect(Object.isFrozen(AUTH_FAILURE_REASON)).toBe(true);
  });

  test("1. an invalid / forged / revoked / expired session token is refused with AUTH_FAILED", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    const first = await pair(p1, "R1", "111111");

    const wrong = await p1.auth({ robotId: "R1", token: crypto.randomUUID() }); // KV holds the real one
    expectCredentialRefused(wrong);
    expect(Number(await p1.kv.get("pairingAttempts:R1"))).toBe(1); // counted, as before

    const second = await pair(p1, "R1", "222222");
    expectCredentialRefused(await p1.auth({ robotId: "R1", token: first.token })); // revoked by the re-pairing

    const p2 = await startProcess(world); // restart: the durable record decides
    expectCredentialRefused(await p2.auth({ robotId: "R1", token: crypto.randomUUID() }));
    expectCredentialRefused(await p2.auth({ robotId: "R1", token: first.token }));
    world.store.rows.get("row-R1").expiresAt = new Date(Date.now() - 1);
    expectCredentialRefused(await p2.auth({ robotId: "R1", token: second.token })); // expired
  });

  test("2. an invalid or expired pairing code is refused with AUTH_FAILED; the lockout is unchanged", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    await p1.kv.set("pairing:R1", "123456", { ex: 300 });
    expectCredentialRefused(await p1.auth({ robotId: "R1", pairingCode: "000000" }));
    await p1.kv.del("pairing:R1"); // the 300 s TTL elapsed
    expectCredentialRefused(await p1.auth({ robotId: "R1", pairingCode: "123456" }));
    expect(Number(await p1.kv.get("pairingAttempts:R1"))).toBe(2);

    const { token } = await pair(p1, "R1", "654321"); // a fresh code still pairs
    for (let i = 0; i < 5; i += 1) expectCredentialRefused(await p1.auth({ robotId: "R1", pairingCode: "999999" }));
    expect(await p1.kv.get("pairingLocked:R1")).toBe("1");
    await p1.kv.set("pairing:R1", "777777", { ex: 300 });
    expectCredentialRefused(await p1.auth({ robotId: "R1", pairingCode: "777777" })); // locked: refused as before
    const live = await p1.auth({ robotId: "R1", token }); // the lockout still gates pairing only
    expect(live.ok).toBe(true);
    expect(authFailed(live.socket)).toEqual([]);
  });

  test("3a. PostgreSQL failure on the robot lookup: plain disconnect, no AUTH_FAILED", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    const { token } = await pair(p1);
    world.prisma.robot.findUnique.mockRejectedValueOnce(new Error("Can't reach database server at db.internal:5432"));

    expectSilentRefusal(await p1.auth({ robotId: "R1", token }));
    expect(p1.logger.error).toHaveBeenCalledWith("AUTH handler failed", expect.anything());
  });

  test("3b. PostgreSQL failure on the durable session check: a VALID token gets no AUTH_FAILED, and is admitted once the database is back", async () => {
    const world = createWorld();
    const { token } = await pair(await startProcess(world));
    const p2 = await startProcess(world); // restart: only the durable record can admit the token
    world.store.updateMany.mockRejectedValueOnce(new Error("connection reset by peer"));

    expectSilentRefusal(await p2.auth({ robotId: "R1", token }));

    const back = await p2.auth({ robotId: "R1", token }); // the database recovered
    expect(back.ok).toBe(true);
    expect(back.token).toBe(token);
    expect(p2.authModes()).toEqual(["durable-session"]);
  });

  test("3c. PostgreSQL failure while recording a pairing: no AUTH_FAILED, and the code stays usable", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    world.store.upsert.mockRejectedValueOnce(new Error("deadlock detected"));

    const failed = await pair(p1, "R1", "123456");
    expectSilentRefusal(failed);
    expect((await p1.auth({ robotId: "R1", pairingCode: "123456" })).ok).toBe(true);
  });

  test("4. an unexpected exception during AUTH: plain disconnect, no AUTH_FAILED", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    const { token } = await pair(p1);
    world.prisma.robot.update.mockRejectedValueOnce(new TypeError("Cannot read properties of undefined (reading 'socketId')"));

    expectSilentRefusal(await p1.auth({ robotId: "R1", token })); // the credential was valid; markRobotOnline threw
    expect(p1.logger.error).toHaveBeenCalledWith("AUTH handler failed", expect.anything());
  });

  test("5. a successful pairing: AUTH_SUCCESS and AUTH_OK with the issued token, no AUTH_FAILED", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    const paired = await pair(p1);

    expect(paired.ok).toBe(true);
    expect(succeeded(paired.socket)).toEqual(["AUTH_SUCCESS", "AUTH_OK"]);
    expect(paired.socket.sent.find((s) => s.event === "AUTH_OK").payload.token).toBe(paired.token);
    expect(authFailed(paired.socket)).toEqual([]);
    expect(paired.socket.disconnect).not.toHaveBeenCalled();
  });

  test("6. a successful bearer AUTH (KV session, then durable session after a restart): no AUTH_FAILED", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    const { token } = await pair(p1);

    const kvSession = await p1.auth({ robotId: "R1", token });
    expect(kvSession.ok).toBe(true);
    expect(succeeded(kvSession.socket)).toEqual(["AUTH_SUCCESS", "AUTH_OK"]);
    expect(authFailed(kvSession.socket)).toEqual([]);

    const p2 = await startProcess(world);
    const durable = await p2.auth({ robotId: "R1", token });
    expect(durable.ok).toBe(true);
    expect(authFailed(durable.socket)).toEqual([]);
    expect(p2.authModes()).toEqual(["durable-session"]);
  });

  describe("7. mTLS", () => {
    const sessionBinding = require("../../../src/engine/security/sessionBinding");
    const DAY_MS = 86_400_000;
    const certificate = { raw: Buffer.from("certificate-for-R1") };
    function certificateRow(overrides) {
      return {
        id: "cert-r1",
        fingerprint: sessionBinding.fingerprint(certificate),
        agentId: "R1",
        status: sessionBinding.CERTIFICATE_STATUS.ACTIVE,
        keyStorage: sessionBinding.KEY_STORAGE.SECURE_ELEMENT,
        notBefore: new Date(Date.now() - DAY_MS),
        notAfter: new Date(Date.now() + 365 * DAY_MS),
        revokedAt: null,
        revocationReason: null,
        ...overrides,
      };
    }
    function withCertificates(world, rows) {
      world.prisma.agentCertificate = {
        findUnique: jest.fn(async ({ where }) => rows.find((row) => row.fingerprint === where.fingerprint) || null),
        findMany: jest.fn(async () => rows),
        updateMany: jest.fn(async () => ({ count: rows.length })),
      };
    }

    test("a valid certificate still authenticates exactly as before: binding, bearer revoked, no sessionTokenHash, no AUTH_FAILED", async () => {
      const world = createWorld();
      withCertificates(world, [certificateRow()]);
      const p1 = await startProcess(world);
      await pair(p1);

      const mtls = await p1.auth({ robotId: "R1", certificate });
      expect(mtls.ok).toBe(true);
      expect(succeeded(mtls.socket)).toEqual(["AUTH_SUCCESS", "AUTH_OK"]);
      expect(authFailed(mtls.socket)).toEqual([]);
      expect(p1.authModes()).toEqual(["pairing", "mtls"]);
      expect(mtls.socket.data.sessionTokenHash).toBeNull();
      expect(mtls.socket.data.certificateBinding).toMatchObject({ agentId: "R1", certificateId: "cert-r1" });
      expect(world.store.rows.has("row-R1")).toBe(false);
      expect(JSON.parse(await p1.kv.get("session:R1")).fingerprint).toBe(certificateRow().fingerprint);
    });

    test("an unknown, revoked or another agent's certificate is refused with AUTH_FAILED, revealing nothing about it", async () => {
      for (const rows of [[], [certificateRow({ status: sessionBinding.CERTIFICATE_STATUS.REVOKED, revokedAt: new Date(), revocationReason: "KEY_COMPROMISE" })], [certificateRow({ agentId: "R2" })]]) {
        const world = createWorld();
        withCertificates(world, rows);
        const p1 = await startProcess(world);
        const refused = await p1.auth({ robotId: "R1", certificate });
        expectCredentialRefused(refused);
        expect(p1.logger.warn).toHaveBeenCalledWith("Agent session refused by §23.2", expect.objectContaining({ refusal: expect.any(String) }));
      }
    });

    test("a certificate store failure is not a verdict: plain disconnect, no AUTH_FAILED", async () => {
      const world = createWorld();
      withCertificates(world, [certificateRow()]);
      world.prisma.agentCertificate.findUnique.mockRejectedValueOnce(new Error("relation \"AgentCertificate\" does not exist"));
      const p1 = await startProcess(world);

      expectSilentRefusal(await p1.auth({ robotId: "R1", certificate }));
    });

    test("pairing where mTLS is required is a definite refusal: AUTH_FAILED", async () => {
      const world = createWorld();
      const p1 = await startProcess(world);
      await p1.kv.set("pairing:R1", "123456", { ex: 300 });
      process.env.AGENT_MTLS_REQUIRED = "true";
      try {
        expectCredentialRefused(await p1.auth({ robotId: "R1", pairingCode: "123456" }));
      } finally {
        delete process.env.AGENT_MTLS_REQUIRED;
      }
    });
  });

  test("an uncommissioned robotId gets the same AUTH_FAILED as a wrong credential (no robot-id oracle)", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    const unknown = await p1.auth({ robotId: "NOT-A-ROBOT", token: crypto.randomUUID() });
    expectCredentialRefused(unknown);
    await pair(p1);
    const known = await p1.auth({ robotId: "R1", token: crypto.randomUUID() });
    expectCredentialRefused(known);
    expect(authFailed(unknown.socket)).toEqual(authFailed(known.socket));
  });

  test("a malformed AUTH or a second robot on an authenticated socket is not a credential verdict: no AUTH_FAILED", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    expectSilentRefusal(await p1.auth({ token: "x" })); // no robotId
    expectSilentRefusal(await p1.auth({ robotId: 42, pairingCode: "123456" })); // schema

    const r1 = await pair(p1);
    await new Promise((resolve) => setTimeout(resolve, 150)); // past the per-socket AUTH limiter (100 ms)
    r1.socket.trigger("AUTH", { robotId: "R2", token: r1.token });
    await waitFor(() => r1.socket.disconnect.mock.calls.length > 0);
    expect(authFailed(r1.socket)).toEqual([]);
  });

  test("8. AUTH_FAILED leaks nothing: no token, code, hash, error text or internal detail", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    const { token } = await pair(p1, "R1", "135790");
    const presented = crypto.randomUUID();
    const refusals = [
      await p1.auth({ robotId: "R1", token: presented }),
      await p1.auth({ robotId: "R1", pairingCode: "135790" }), // consumed
      await p1.auth({ robotId: "NOT-A-ROBOT", token: presented }),
    ];
    world.prisma.robot.findUnique.mockRejectedValueOnce(new Error("password authentication failed for user \"robotx\" at 10.0.0.5"));
    refusals.push(await p1.auth({ robotId: "R1", token }));

    const payloads = refusals.flatMap((r) => authFailed(r.socket).map((s) => s.payload));
    expect(payloads).toEqual([{ reason: "INVALID_CREDENTIAL" }, { reason: "INVALID_CREDENTIAL" }, { reason: "INVALID_CREDENTIAL" }]);
    const wire = JSON.stringify(payloads);
    for (const secret of [token, presented, "135790", sha256(token), sha256(presented), "password", "10.0.0.5", "robotx", "Error", "stack"]) {
      expect(wire).not.toContain(secret);
    }
  });
});

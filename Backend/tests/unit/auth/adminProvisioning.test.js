"use strict";

/**
 * RBAC — campus administrator provisioning (`/api/users`) and the SUPER_ADMIN bootstrap.
 *
 * Provisioning: only a SUPER_ADMIN may create or manage an ADMIN; the role is never an input;
 * exactly one valid campus is required; the account and its audit event commit together or
 * not at all; nothing secret is returned; an account change disconnects its open sockets.
 *
 * Bootstrap: creates the first SUPER_ADMIN, then never changes an existing account — no
 * password reset (unless explicitly requested for recovery) and never a promotion.
 */

const bcrypt = require("bcrypt");
const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const CAMPUS = { id: "c0a00000-0000-4000-8000-00000000000a", code: "RNSIT", name: "RNS Institute of Technology" };
const OTHER_CAMPUS = { id: "c0b00000-0000-4000-8000-00000000000b", code: "jssate-bengaluru", name: "JSS Academy" };
const SUPER = { id: "11111111-1111-4111-8111-111111111111", email: "root@robotx.test", role: "SUPER_ADMIN", campusId: null, campus: null, disabledAt: null, createdAt: new Date(0) };
const ADMIN = { id: "22222222-2222-4222-8222-222222222222", email: "a@robotx.test", role: "ADMIN", campusId: CAMPUS.id, campus: { ...CAMPUS, regionId: null, region: null }, disabledAt: null, createdAt: new Date(0) };

let users;
let auditEvents;
let failAuditWith;
function makePrisma() {
  const mockPrisma = {
    user: {
      findUnique: jest.fn(async ({ where }) => users.find((u) => (where.id ? u.id === where.id : u.email === where.email)) || null),
      findFirst: jest.fn(async ({ where }) => users.find((u) => u.email.toLowerCase() === String(where.email.equals).toLowerCase()) || null),
      findMany: jest.fn(async () => users),
      create: jest.fn(async ({ data }) => {
        if (users.some((u) => u.email === data.email)) throw Object.assign(new Error("unique"), { code: "P2002" });
        const campus = [CAMPUS, OTHER_CAMPUS].find((c) => c.id === data.campusId) || null;
        const row = { id: `new-${users.length}`, disabledAt: null, createdAt: new Date(), campus, ...data };
        users.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }) => {
        const row = users.find((u) => u.id === where.id);
        Object.assign(row, data);
        if (data.campusId) row.campus = [CAMPUS, OTHER_CAMPUS].find((c) => c.id === data.campusId);
        return row;
      }),
    },
    campus: { findUnique: jest.fn(async ({ where }) => [CAMPUS, OTHER_CAMPUS].find((c) => c.id === where.id) || null) },
    auditEvent: {
      findFirst: jest.fn(async () => auditEvents[auditEvents.length - 1] || null),
      create: jest.fn(async ({ data }) => {
        if (failAuditWith) throw failAuditWith;
        auditEvents.push(data);
        return data;
      }),
    },
    adminPinAuth: { upsert: jest.fn(async () => ({})) },
  };
  // A transaction that really rolls back: writes inside it are undone if the callback throws.
  mockPrisma.$transaction = jest.fn(async (callback) => {
    const snapshot = { users: users.map((u) => ({ ...u })), audit: auditEvents.slice() };
    try {
      return await callback(mockPrisma);
    } catch (error) {
      users = snapshot.users;
      auditEvents = snapshot.audit;
      throw error;
    }
  });
  return mockPrisma;
}

let mockPrisma;
jest.mock("../../../src/db/prisma", () => ({ getPrisma: () => mockPrisma }));

const usersRoutes = require("../../../src/routes/users.routes");
const { ensureAdminUser } = require("../../../src/services/adminBootstrap.service");

const disconnectSockets = jest.fn(async () => {});
const roomEmit = jest.fn();
const order = [];
const io = {
  in: jest.fn(() => ({ disconnectSockets: (...a) => (order.push("disconnect"), disconnectSockets(...a)) })),
  to: jest.fn(() => ({ emit: (...a) => (order.push("emit"), roomEmit(...a)) })),
};

const app = express();
app.use(express.json());
app.use("/api/users", usersRoutes);
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ ok: false, error: err.message, code: err.code }));
app.locals.io = io;

const as = (user) => `Bearer ${jwt.sign({ id: user.id }, process.env.JWT_SECRET)}`;
const create = (user, body) => request(app).post("/api/users").set("Authorization", as(user)).send(body);
const VALID = { email: "new.admin@robotx.test", password: "correct horse battery", campusId: CAMPUS.id };

beforeEach(() => {
  users = [{ ...SUPER }, { ...ADMIN }];
  auditEvents = [];
  failAuditWith = null;
  mockPrisma = makePrisma();
  app.locals.mockPrisma = mockPrisma;
  disconnectSockets.mockClear();
  roomEmit.mockClear();
  order.length = 0;
  io.in.mockClear();
  io.to.mockClear();
});

describe("POST /api/users — only a SUPER_ADMIN creates campus administrators", () => {
  test("a SUPER_ADMIN creates an ADMIN of exactly one campus; the password is hashed and never returned", async () => {
    const response = await create(SUPER, VALID).expect(201);
    expect(response.body.user).toEqual({
      id: expect.any(String),
      email: VALID.email,
      role: "ADMIN",
      campus: { id: CAMPUS.id, code: CAMPUS.code, name: CAMPUS.name },
      disabled: false,
      disabledAt: null,
      createdAt: expect.any(String),
    });
    expect(JSON.stringify(response.body)).not.toMatch(/password|\$2[aby]\$/);
    const stored = users.find((u) => u.email === VALID.email);
    expect(stored.role).toBe("ADMIN");
    expect(stored.campusId).toBe(CAMPUS.id);
    expect(await bcrypt.compare(VALID.password, stored.password)).toBe(true);
  });

  test("the creation is on the audit stream, made by the verified caller, with no secret in it", async () => {
    await create(SUPER, VALID).expect(201);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      eventType: "OPERATOR_ACTION",
      actorId: SUPER.id,
      actorRole: "SUPER_ADMIN",
      subjectType: "USER",
      payload: { action: "ADMIN_CREATED", role: "ADMIN", campusId: CAMPUS.id, campusCode: CAMPUS.code },
    });
    // `sequence` is a BigInt on the audit row.
    expect(JSON.stringify(auditEvents[0], (_k, v) => (typeof v === "bigint" ? String(v) : v))).not.toContain(VALID.password);
  });

  test("atomic: when the audit append fails, no account is left behind", async () => {
    failAuditWith = new Error("audit store down");
    await create(SUPER, VALID).expect(500);
    expect(users.find((u) => u.email === VALID.email)).toBeUndefined();
  });

  test("a campus ADMIN cannot create an ADMIN — or a SUPER_ADMIN", async () => {
    await create(ADMIN, VALID).expect(403);
    await create(ADMIN, { ...VALID, role: "SUPER_ADMIN" }).expect(403);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  test("an unauthenticated request cannot create anything (there is no public registration)", async () => {
    await request(app).post("/api/users").send(VALID).expect(401);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  test("the role is not an input: naming one is refused, even ADMIN", async () => {
    for (const role of ["SUPER_ADMIN", "ADMIN"]) {
      const response = await create(SUPER, { ...VALID, role }).expect(400);
      expect(response.body.code).toBe("ROLE_NOT_SETTABLE");
    }
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  test.each([
    ["no campus", { campusId: undefined }, "CAMPUS_REQUIRED"],
    ["an empty campus", { campusId: "" }, "CAMPUS_REQUIRED"],
    ["several campuses in campusId", { campusId: [CAMPUS.id, OTHER_CAMPUS.id] }, "CAMPUS_REQUIRED"],
    ["a campusIds list", { campusIds: [CAMPUS.id] }, "UNKNOWN_FIELDS"],
    ["a campus that does not exist", { campusId: "c0c00000-0000-4000-8000-00000000000c" }, "INVALID_CAMPUS"],
    ["a short password", { password: "short" }, "WEAK_PASSWORD"],
    ["a password bcrypt would truncate", { password: "x".repeat(73) }, "PASSWORD_TOO_LONG"],
    ["an invalid email", { email: "not-an-email" }, "INVALID_EMAIL"],
    ["a creator id", { createdBy: SUPER.id }, "UNKNOWN_FIELDS"],
  ])("refuses %s", async (_label, change, code) => {
    const response = await create(SUPER, { ...VALID, ...change }).expect(400);
    expect(response.body.code).toBe(code);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  test("a duplicate email — exact or differing only in case — is a 409", async () => {
    expect((await create(SUPER, { ...VALID, email: ADMIN.email }).expect(409)).body.code).toBe("EMAIL_IN_USE");
    expect((await create(SUPER, { ...VALID, email: ADMIN.email.toUpperCase() }).expect(409)).body.code).toBe("EMAIL_IN_USE");
  });
});

describe("GET/PATCH /api/users — account lifecycle", () => {
  test("listing is SUPER_ADMIN only and carries no password", async () => {
    await request(app).get("/api/users").set("Authorization", as(ADMIN)).expect(403);
    const response = await request(app).get("/api/users").set("Authorization", as(SUPER)).expect(200);
    expect(response.body.users.map((u) => u.role).sort()).toEqual(["ADMIN", "SUPER_ADMIN"]);
    expect(JSON.stringify(response.body)).not.toMatch(/password/i);
  });

  test("disabling an ADMIN records it, and disconnects its open sockets at once", async () => {
    const response = await request(app).patch(`/api/users/${ADMIN.id}`).set("Authorization", as(SUPER)).send({ disabled: true }).expect(200);
    expect(response.body.user.disabled).toBe(true);
    expect(auditEvents.map((e) => e.payload.action)).toEqual(["ADMIN_DISABLED"]);
    expect(io.in).toHaveBeenCalledWith(`user:${ADMIN.id}`);
    expect(disconnectSockets).toHaveBeenCalledWith(true);
    // The dashboard is told why before it is disconnected, so it signs out instead of going quiet.
    expect(io.to).toHaveBeenCalledWith(`user:${ADMIN.id}`);
    expect(roomEmit).toHaveBeenCalledWith("UNAUTHORIZED", { message: "Your access has been revoked", code: "ACCOUNT_DISABLED" });
    expect(order).toEqual(["emit", "disconnect"]);
  });

  test("moving an ADMIN to another campus records it and disconnects its sockets", async () => {
    await request(app).patch(`/api/users/${ADMIN.id}`).set("Authorization", as(SUPER)).send({ campusId: OTHER_CAMPUS.id }).expect(200);
    expect(users.find((u) => u.id === ADMIN.id).campusId).toBe(OTHER_CAMPUS.id);
    expect(auditEvents[0].payload).toEqual({ action: "ADMIN_CAMPUS_CHANGED", fromCampusId: CAMPUS.id, toCampusId: OTHER_CAMPUS.id });
    expect(roomEmit).toHaveBeenCalledWith("UNAUTHORIZED", { message: "Your access changed", code: "ACCESS_CHANGED" });
    expect(order).toEqual(["emit", "disconnect"]);
  });

  test("a change that changes nothing writes nothing", async () => {
    await request(app).patch(`/api/users/${ADMIN.id}`).set("Authorization", as(SUPER)).send({ campusId: CAMPUS.id, disabled: false }).expect(200);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(auditEvents).toEqual([]);
    expect(disconnectSockets).not.toHaveBeenCalled();
  });

  test("an ADMIN cannot change its own campus, or anyone's", async () => {
    await request(app).patch(`/api/users/${ADMIN.id}`).set("Authorization", as(ADMIN)).send({ campusId: OTHER_CAMPUS.id }).expect(403);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  test("a SUPER_ADMIN account is not managed here, and no role can be set", async () => {
    expect((await request(app).patch(`/api/users/${SUPER.id}`).set("Authorization", as(SUPER)).send({ disabled: true }).expect(403)).body.code).toBe("NOT_MANAGEABLE");
    expect((await request(app).patch(`/api/users/${ADMIN.id}`).set("Authorization", as(SUPER)).send({ role: "SUPER_ADMIN" }).expect(400)).body.code).toBe("ROLE_NOT_SETTABLE");
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  test("an ADMIN cannot be given zero campuses", async () => {
    expect((await request(app).patch(`/api/users/${ADMIN.id}`).set("Authorization", as(SUPER)).send({ campusId: null }).expect(400)).body.code).toBe("CAMPUS_REQUIRED");
  });
});

describe("ensureAdminUser — create once, never promote, never silently reset", () => {
  const saved = {};
  beforeEach(() => {
    for (const k of ["SEED_ADMIN_EMAIL", "SEED_ADMIN_PASSWORD", "SEED_ADMIN_RESET_PASSWORD", "DEFAULT_ADMIN_PIN"]) saved[k] = process.env[k];
    process.env.SEED_ADMIN_PASSWORD = "configured-bootstrap-password";
    delete process.env.SEED_ADMIN_RESET_PASSWORD;
    delete process.env.DEFAULT_ADMIN_PIN;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  });
  const quiet = { info: jest.fn(), warn: jest.fn() };

  test("no account with the email: the first SUPER_ADMIN is created", async () => {
    process.env.SEED_ADMIN_EMAIL = "first@robotx.test";
    expect(await ensureAdminUser(mockPrisma, { logger: quiet })).toMatchObject({ bootstrapped: true });
    expect(mockPrisma.user.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ email: "first@robotx.test", role: "SUPER_ADMIN" }) }));
  });

  test("an existing SUPER_ADMIN is left alone: its changed password survives a restart", async () => {
    process.env.SEED_ADMIN_EMAIL = SUPER.email;
    await ensureAdminUser(mockPrisma, { logger: quiet });
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  test("an existing ADMIN with the configured email is never promoted", async () => {
    process.env.SEED_ADMIN_EMAIL = ADMIN.email;
    expect(await ensureAdminUser(mockPrisma, { logger: quiet })).toEqual({ bootstrapped: false, reason: "existing_account_not_super_admin" });
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(users.find((u) => u.id === ADMIN.id).role).toBe("ADMIN");
  });

  test("an explicit recovery flag re-applies the password to a SUPER_ADMIN only, and never the role", async () => {
    process.env.SEED_ADMIN_RESET_PASSWORD = "true";
    process.env.SEED_ADMIN_EMAIL = SUPER.email;
    await ensureAdminUser(mockPrisma, { logger: quiet });
    const [{ data }] = mockPrisma.user.update.mock.calls[0];
    expect(Object.keys(data)).toEqual(["password"]);
    mockPrisma.user.update.mockClear();
    process.env.SEED_ADMIN_EMAIL = ADMIN.email;
    await ensureAdminUser(mockPrisma, { logger: quiet });
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });
});

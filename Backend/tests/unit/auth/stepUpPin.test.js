"use strict";

/**
 * The account's own step-up PIN (`GET/PUT /api/auth/pin`) and account revocation.
 *
 * An account a SUPER_ADMIN created had no PIN and no way to get one, so it could never pass the
 * dashboard's step-up dialog. The fix is a signed-in setup that re-verifies the current
 * password; this checks it end to end through the real routes and `pin-auth`.
 */

const bcrypt = require("bcrypt");
const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const CAMPUS = { id: "c0a00000-0000-4000-8000-00000000000a", code: "RNSIT", name: "RNSIT", regionId: null, region: null };
const PASSWORD = "admin-password-123";
let mockUsers;
let mockPins;
let mockAudit;

function mockMakePrisma() {
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }) => mockUsers.find((u) => u.id === where.id) || null),
    },
    adminPinAuth: {
      findUnique: jest.fn(async ({ where }) => (mockPins.has(where.userId) ? { id: `pin-${where.userId}`, userId: where.userId, pinHash: mockPins.get(where.userId) } : null)),
      upsert: jest.fn(async ({ where, update, create }) => {
        mockPins.set(where.userId, mockPins.has(where.userId) ? update.pinHash : create.pinHash);
        return {};
      }),
      update: jest.fn(async ({ where, data }) => mockPins.set(where.userId, data.pinHash)),
    },
    auditEvent: {
      findFirst: jest.fn(async () => mockAudit[mockAudit.length - 1] || null),
      create: jest.fn(async ({ data }) => (mockAudit.push(data), data)),
    },
  };
  prisma.$transaction = jest.fn(async (callback) => callback(prisma));
  return prisma;
}

let mockPrisma;
jest.mock("../../../src/db/prisma", () => ({ getPrisma: () => mockPrisma }));

const authRoutes = require("../../../src/routes/auth.routes");

const app = express();
app.use(express.json());
app.use("/api/auth", authRoutes);

let admin;
let disabled;
const bearer = (user) => `Bearer ${jwt.sign({ id: user.id }, process.env.JWT_SECRET)}`;
// The setup route is rate-limited per client address; each test is its own client.
let client = 0;
const setPin = (user, body) => request(app).put("/api/auth/pin").set("Authorization", bearer(user)).set("X-Forwarded-For", `10.0.0.${client}`).send(body);
const noSecret = (value) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? String(v) : v));

beforeAll(async () => {
  const hash = await bcrypt.hash(PASSWORD, 4);
  admin = { id: "22222222-2222-4222-8222-222222222222", email: "a@robotx.test", role: "ADMIN", campusId: CAMPUS.id, campus: CAMPUS, disabledAt: null, password: hash };
  disabled = { ...admin, id: "55555555-5555-4555-8555-555555555555", disabledAt: new Date() };
});

beforeEach(() => {
  client += 1;
  mockUsers = [admin, disabled];
  mockPins = new Map();
  mockAudit = [];
  mockPrisma = mockMakePrisma();
});

describe("PUT /api/auth/pin — an account sets its own step-up PIN", () => {
  test("a new ADMIN has no PIN, sets one with its password, and can then pass pin-auth", async () => {
    expect((await request(app).get("/api/auth/pin").set("Authorization", bearer(admin)).expect(200)).body).toEqual({ configured: false });
    // Before: the step-up dialog's PIN check cannot succeed.
    expect((await request(app).post("/api/auth/pin-auth").set("Authorization", bearer(admin)).send({ pin: "4821" }).expect(403)).body.message).toBe("PIN not configured");

    const response = await setPin(admin, { currentPassword: PASSWORD, pin: "4821" }).expect(200);
    expect(response.body).toEqual({ message: "PIN set", configured: true });
    expect(await bcrypt.compare("4821", mockPins.get(admin.id))).toBe(true);
    expect((await request(app).get("/api/auth/pin").set("Authorization", bearer(admin)).expect(200)).body).toEqual({ configured: true });

    await request(app).post("/api/auth/pin-auth").set("Authorization", bearer(admin)).send({ pin: "4821" }).expect(200);
    await request(app).post("/api/auth/pin-auth").set("Authorization", bearer(admin)).send({ pin: "0000" }).expect(401);
  });

  test("setting and changing are audited, and the PIN is in no response and no audit event", async () => {
    const first = await setPin(admin, { currentPassword: PASSWORD, pin: "4821" }).expect(200);
    const second = await setPin(admin, { currentPassword: PASSWORD, pin: "735190" }).expect(200);
    expect(second.body.message).toBe("PIN changed");
    expect(mockAudit.map((e) => e.payload.action)).toEqual(["STEP_UP_PIN_SET", "STEP_UP_PIN_CHANGED"]);
    expect(mockAudit[0]).toMatchObject({ eventType: "OPERATOR_ACTION", actorId: admin.id, actorRole: "ADMIN", subjectType: "USER", subjectId: admin.id });
    for (const text of [noSecret(first.body), noSecret(second.body), noSecret(mockAudit)]) {
      expect(text).not.toContain("4821");
      expect(text).not.toContain("735190");
      expect(text).not.toContain(PASSWORD);
    }
  });

  test.each([
    ["a wrong password", { currentPassword: "not-my-password", pin: "4821" }, "WRONG_PASSWORD"],
    ["no password", { pin: "4821" }, "PASSWORD_REQUIRED"],
    ["a PIN that is too short", { currentPassword: PASSWORD, pin: "12" }, "INVALID_PIN"],
    ["a PIN that is not digits", { currentPassword: PASSWORD, pin: "12ab" }, "INVALID_PIN"],
    ["no PIN", { currentPassword: PASSWORD }, "INVALID_PIN"],
  ])("refuses %s and writes nothing", async (_label, body, code) => {
    expect((await setPin(admin, body).expect(400)).body.code).toBe(code);
    expect(mockPins.size).toBe(0);
    expect(mockAudit).toEqual([]);
  });

  test("password guessing through the setup route is rate-limited: the sixth attempt in a minute is refused", async () => {
    for (let i = 0; i < 5; i += 1) await setPin(admin, { currentPassword: `guess-${i}`, pin: "4821" }).expect(400);
    await setPin(admin, { currentPassword: PASSWORD, pin: "4821" }).expect(429);
    expect(mockPins.size).toBe(0);
  });

  test("an unauthenticated request cannot set or read a PIN", async () => {
    await request(app).put("/api/auth/pin").send({ currentPassword: PASSWORD, pin: "4821" }).expect(401);
    await request(app).get("/api/auth/pin").expect(401);
    expect(mockPins.size).toBe(0);
  });
});

describe("a disabled account", () => {
  test("is told its access was revoked (401 ACCOUNT_DISABLED) — and cannot set a PIN", async () => {
    const me = await request(app).get("/api/auth/me").set("Authorization", bearer(disabled)).expect(401);
    expect(me.body).toEqual({ message: "Your access has been revoked", code: "ACCOUNT_DISABLED" });
    await setPin(disabled, { currentPassword: PASSWORD, pin: "4821" }).expect(401);
    expect(mockPins.size).toBe(0);
  });

  test("an unknown or malformed token stays a plain 401 with no reason", async () => {
    const unknown = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${jwt.sign({ id: "99999999-9999-4999-8999-999999999999" }, process.env.JWT_SECRET)}`).expect(401);
    expect(unknown.body).toEqual({ message: "Unauthorized" });
    expect((await request(app).get("/api/auth/me").set("Authorization", "Bearer not-a-jwt").expect(401)).body).toEqual({ message: "Unauthorized" });
  });
});

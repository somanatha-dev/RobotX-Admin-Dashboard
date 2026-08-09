"use strict";

/**
 * Engine lane — Phase 14: `POST /api/privacy/erasure` and the identity-status read
 * (§23.7).
 *
 * The endpoint's contract is unusual and is asserted as such: a request is a **dry run by
 * default**, and the destructive call is an explicit `dryRun: false`. Erasure is
 * irreversible and its blast radius is a query the caller cannot easily run themselves;
 * one round trip removes the class of mistake where a mistyped subject id erases the wrong
 * record.
 */

const request = require("supertest");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const surrogateKeys = require("../../src/engine/privacy/surrogateKeys");
const identityStore = require("../../src/engine/privacy/identityStore");

const SECRET = "a-surrogate-secret-of-sufficient-length";
const KEY = crypto.createHash("sha256").update("identity-store-test-key").digest();
const IDENTITY_KEY = surrogateKeys.surrogateKey({ subjectType: "STOP", naturalId: "12 Acacia Avenue", secret: SECRET });

const identityRows = [];

const mockPrismaClient = {
  user: { findUnique: jest.fn() },
  auditEvent: { findFirst: jest.fn(), create: jest.fn() },
  overrideAudit: { create: jest.fn() },
  identityRecord: {
    findUnique: jest.fn(async ({ where }) => identityRows.find((row) => row.surrogateKey === where.surrogateKey) || null),
    findMany: jest.fn(async ({ where }) =>
      identityRows.filter((row) => row.subjectType === where.subjectType && row.subjectId === where.subjectId),
    ),
    update: jest.fn(async ({ where, data }) => {
      const row = identityRows.find((entry) => entry.surrogateKey === where.surrogateKey);
      Object.assign(row, data);
      return row;
    }),
  },
  $transaction: jest.fn(async (callback) => callback(mockPrismaClient)),
};

jest.mock("../../src/db/prisma", () => ({
  getPrisma: () => mockPrismaClient,
  connectPrisma: jest.fn(),
  connectPrismaWithRetry: jest.fn(),
  disconnectPrisma: jest.fn(),
}));

const app = require("../../src/app");

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "legal@robotx.test", role: "SUPER_ADMIN" };
const token = () => jwt.sign({ id: USER.id }, process.env.JWT_SECRET);

beforeEach(() => {
  identityRows.length = 0;
  identityRows.push({
    surrogateKey: IDENTITY_KEY,
    subjectType: "STOP",
    subjectId: "STOP-1",
    classification: "LOCATION_IDENTIFIER",
    fieldNames: ["label"],
    ...identityStore.seal({ label: "12 Acacia Avenue" }, KEY),
    erasedAt: null,
    retainUntil: new Date("2026-09-01T00:00:00Z"),
  });

  mockPrismaClient.user.findUnique.mockResolvedValue(USER);
  mockPrismaClient.auditEvent.findFirst.mockResolvedValue(null);
  mockPrismaClient.auditEvent.create.mockImplementation(async ({ data }) => ({ ...data }));
  app.locals.prisma = mockPrismaClient;
});

const post = () => request(app).post("/api/privacy/erasure").set("Authorization", `Bearer ${token()}`);

describe("§23.7 — the erasure endpoint is authenticated and elevated", () => {
  test("unauthenticated is refused", async () => {
    await request(app).post("/api/privacy/erasure").send({}).expect(401);
    await request(app).get(`/api/privacy/identity/${IDENTITY_KEY}`).expect(401);
  });

  test("an unelevated role is refused — erasure is irreversible", async () => {
    mockPrismaClient.user.findUnique.mockResolvedValue({ ...USER, role: "VIEWER" });
    await post().send({ by: "SUBJECT", subjectType: "STOP", subjectId: "STOP-1", reason: "r" }).expect(403);
  });
});

describe("§23.7 — the request is validated before it destroys anything", () => {
  test("a malformed body is refused with the field named", async () => {
    const response = await post().send({ by: "EVERYTHING", reason: "r" }).expect(400);
    expect(response.body.error).toBe("Invalid erasure request");
  });

  test("a request with no reason is refused", async () => {
    const response = await post().send({ by: "SUBJECT", subjectType: "STOP", subjectId: "STOP-1" }).expect(400);
    expect(response.body.detail.join(" ")).toMatch(/reason/);
  });

  test("an unknown field is refused rather than ignored", async () => {
    // `strict()`, not `passthrough()`: a field this endpoint silently dropped would be a
    // field a caller believed had narrowed the erasure.
    await post().send({ by: "SUBJECT", subjectType: "STOP", subjectId: "STOP-1", reason: "r", alsoErase: "everything" }).expect(400);
  });
});

describe("§23.7 — dry run by default", () => {
  test("it reports the plan and erases nothing", async () => {
    const response = await post().send({ by: "SUBJECT", subjectType: "STOP", subjectId: "STOP-1", reason: "subject request 41" }).expect(200);

    expect(response.body).toMatchObject({ ok: true, dryRun: true });
    expect(response.body.targets).toEqual([
      { identityKey: IDENTITY_KEY, subjectType: "STOP", classification: "LOCATION_IDENTIFIER", alreadyErased: false },
    ]);
    expect(identityRows[0].ciphertext).not.toBeNull();
    expect(response.body.note).toMatch(/continue to replay identically/);
  });

  test("dryRun: false performs the erasure and audits it", async () => {
    const response = await post()
      .send({ by: "SUBJECT", subjectType: "STOP", subjectId: "STOP-1", reason: "subject request 41", dryRun: false })
      .expect(200);

    expect(response.body).toMatchObject({ ok: true, dryRun: false, erased: 1 });
    expect(identityRows[0].ciphertext).toBeNull();
    expect(identityRows[0].erasedBy).toBe(USER.id);

    const audited = mockPrismaClient.auditEvent.create.mock.calls[0][0].data;
    expect(audited).toMatchObject({ subjectType: "ERASURE_REQUEST", actorId: USER.id, reason: "subject request 41" });
  });

  test("the requester is the authenticated user, never a body field", async () => {
    // A requester id a caller could supply is a requester id a caller could supply
    // somebody else's. `strict()` refuses the field outright.
    await post()
      .send({ by: "SUBJECT", subjectType: "STOP", subjectId: "STOP-1", reason: "r", dryRun: false, requestedBy: "someone-else" })
      .expect(400);
  });
});

describe("§23.7 — the identity-status read", () => {
  test("it answers RESOLVABLE without returning any identifying value", async () => {
    const response = await request(app).get(`/api/privacy/identity/${IDENTITY_KEY}`).set("Authorization", `Bearer ${token()}`).expect(200);

    expect(response.body).toMatchObject({ status: "RESOLVABLE", subjectType: "STOP", fieldNames: ["label"] });
    // Names, never values. Reading the values goes through `identityStore.resolve()`,
    // which requires a reason and audits the access, and is not an HTTP surface.
    expect(JSON.stringify(response.body)).not.toMatch(/Acacia/);
  });

  test("after erasure it answers ERASED, which is a different answer from NOT_FOUND", async () => {
    await post().send({ by: "SUBJECT", subjectType: "STOP", subjectId: "STOP-1", reason: "r", dryRun: false }).expect(200);

    const response = await request(app).get(`/api/privacy/identity/${IDENTITY_KEY}`).set("Authorization", `Bearer ${token()}`).expect(200);
    expect(response.body.status).toBe(surrogateKeys.ERASED);
    // "This is the correct trade and it is bounded, but it must be visible to whoever
    // later reads such a record in a dispute."
    expect(response.body.erasedAt).not.toBeNull();
  });

  test("a key that was never minted is NOT_FOUND", async () => {
    const other = surrogateKeys.surrogateKey({ subjectType: "STOP", naturalId: "somewhere else", secret: SECRET });
    const response = await request(app).get(`/api/privacy/identity/${other}`).set("Authorization", `Bearer ${token()}`).expect(404);
    expect(response.body.status).toBe("NOT_FOUND");
  });

  test("an address supplied in place of a surrogate key is refused", async () => {
    await request(app).get("/api/privacy/identity/12%20Acacia%20Avenue").set("Authorization", `Bearer ${token()}`).expect(400);
  });
});

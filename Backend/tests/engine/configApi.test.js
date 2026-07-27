"use strict";

/**
 * Engine lane — the configuration REST surface (§22.2, §22.3, §23.4).
 *
 * `GET /api/config/resolve` is the resolution-explain query §22.2 requires to exist,
 * not a convenience: "why is this threshold 34?" must have a single, immediate answer,
 * and an operator who cannot get one will not trust the engine's decisions either.
 */

const request = require("supertest");
const jwt = require("jsonwebtoken");

const mockPrismaClient = {
  user: { findUnique: jest.fn() },
  configVersion: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn() },
  configScopeBinding: { createMany: jest.fn() },
  configActiveVersion: { findUnique: jest.fn(), upsert: jest.fn() },
  $transaction: jest.fn(async (callback) => callback(mockPrismaClient)),
};

jest.mock("../../src/db/prisma", () => ({
  getPrisma: () => mockPrismaClient,
  connectPrisma: jest.fn(),
  connectPrismaWithRetry: jest.fn(),
  disconnectPrisma: jest.fn(),
}));

const app = require("../../src/app");

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "ops@robotx.test", role: "SUPER_ADMIN" };
const token = () => jwt.sign({ id: USER.id }, process.env.JWT_SECRET);

beforeEach(() => {
  mockPrismaClient.user.findUnique.mockResolvedValue(USER);
  mockPrismaClient.configActiveVersion.findUnique.mockResolvedValue(null);
  mockPrismaClient.configVersion.findFirst.mockResolvedValue(null);
  mockPrismaClient.configVersion.findMany.mockResolvedValue([]);
});

describe("authorisation", () => {
  test("the whole surface requires authentication", async () => {
    await request(app).get("/api/config/resolve?param=solve.window_min").expect(401);
    await request(app).get("/api/config/versions").expect(401);
    await request(app).post("/api/config/publish").send({}).expect(401);
  });

  test("an authenticated user without the elevated role is refused", async () => {
    mockPrismaClient.user.findUnique.mockResolvedValue({ ...USER, role: "VIEWER" });
    await request(app)
      .get("/api/config/resolve?param=solve.window_min")
      .set("Authorization", `Bearer ${token()}`)
      .expect(403);
  });
});

describe("GET /api/config/resolve — the §22.2 resolution-explain query", () => {
  test("returns the effective value with the scope level that supplied it", async () => {
    const response = await request(app)
      .get("/api/config/resolve?param=solve.window_min")
      .set("Authorization", `Bearer ${token()}`)
      .expect(200);

    expect(response.body.resolution).toMatchObject({
      name: "solve.window_min",
      value: 500,
      unit: "ms",
      source: "default",
      level: "global",
      changeClass: "TUNED",
      owner: "Eng",
      calibrationStatus: "PROVISIONAL",
    });
    expect(response.body.resolution.chain).toBeDefined();
  });

  test("accepts a scope and reports the levels it considered", async () => {
    const response = await request(app)
      .get("/api/config/resolve?param=verify.arrival_radius&scope=region:eu-west,site:depot-3")
      .set("Authorization", `Bearer ${token()}`)
      .expect(200);

    expect(response.body.resolution.chain.map((step) => step.level)).toEqual(["global", "region", "site"]);
  });

  test("indexes into an indexed parameter", async () => {
    const response = await request(app)
      .get("/api/config/resolve?param=energy.event_budget_per_fleet_year&index=T3")
      .set("Authorization", `Bearer ${token()}`)
      .expect(200);
    expect(response.body.resolution.value).toBe(4);
  });

  test("rejects an unknown scope level rather than silently ignoring it", async () => {
    const response = await request(app)
      .get("/api/config/resolve?param=solve.window_min&scope=rack:r1")
      .set("Authorization", `Bearer ${token()}`)
      .expect(400);
    expect(response.body.message).toMatch(/unknown scope level/);
  });

  test("404s an unregistered parameter, naming the rule", async () => {
    const response = await request(app)
      .get("/api/config/resolve?param=cost.made_up_weight")
      .set("Authorization", `Bearer ${token()}`)
      .expect(404);
    expect(response.body.detail).toMatch(/not in the parameter register/);
  });

  test("requires the param argument", async () => {
    await request(app).get("/api/config/resolve").set("Authorization", `Bearer ${token()}`).expect(400);
  });
});

describe("GET /api/config/versions", () => {
  test("reports the published versions and which one is active", async () => {
    mockPrismaClient.configVersion.findMany.mockResolvedValue([
      { version: 2, publishedBy: "ops-1", signature: "abc", note: null, safetyClassChanges: [] },
    ]);
    const response = await request(app)
      .get("/api/config/versions")
      .set("Authorization", `Bearer ${token()}`)
      .expect(200);
    expect(response.body.versions).toHaveLength(1);
    expect(response.body.activeVersion).toBeNull();
  });
});

describe("POST /api/config/publish", () => {
  test("returns 422 with the findings when validation rejects the configuration", async () => {
    const response = await request(app)
      .post("/api/config/publish")
      .set("Authorization", `Bearer ${token()}`)
      .send({ bindings: [{ level: "global", name: "agent.dedup_retention", value: 5 }] })
      .expect(422);

    expect(response.body.ok).toBe(false);
    expect(response.body.findings.some((item) => item.id === "V5")).toBe(true);
    expect(mockPrismaClient.configVersion.create).not.toHaveBeenCalled();
  });

  test("publishes and pins a valid configuration", async () => {
    mockPrismaClient.configVersion.create.mockImplementation(async ({ data }) => ({
      id: "cv-1",
      publishedAt: new Date("2026-07-28T09:00:00Z"),
      ...data,
    }));
    mockPrismaClient.configVersion.findUnique.mockResolvedValue({ version: 1, payload: {} });
    mockPrismaClient.configActiveVersion.upsert.mockResolvedValue({ id: "singleton", version: 1 });

    const response = await request(app)
      .post("/api/config/publish")
      .set("Authorization", `Bearer ${token()}`)
      .send({
        bindings: [{ level: "global", name: "energy.max_combined_conservatism", value: 2.1 }],
        approvals: [{ approverId: "safety-1", approvedAt: "2026-07-28T09:00:00Z" }],
        note: "raise the combined conservatism cap",
      })
      .expect(200);

    expect(response.body).toMatchObject({ ok: true, version: 1, pinned: true });
    expect(response.body.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(mockPrismaClient.configActiveVersion.upsert).toHaveBeenCalled();
  });

  test("refuses an automated Safety-class change", async () => {
    const response = await request(app)
      .post("/api/config/publish")
      .set("Authorization", `Bearer ${token()}`)
      .send({
        automated: true,
        bindings: [{ level: "global", name: "energy.max_combined_conservatism", value: 2.1 }],
        approvals: [
          { approverId: "safety-1", approvedAt: "t" },
          { approverId: "safety-2", approvedAt: "t" },
        ],
      })
      .expect(422);

    expect(response.body.findings.map((item) => item.message).join(" ")).toMatch(
      /No automated tuner may modify a Safety-class parameter/,
    );
  });
});

describe("GET /health", () => {
  test("reports which configuration version the process is resolving against", async () => {
    const response = await request(app).get("/health").expect(200);
    expect(response.body).toHaveProperty("configVersion");
    expect(response.body.configRegisterDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

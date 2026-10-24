"use strict";

/**
 * `POST /api/dtaro/decisions/:decisionId` and `GET /api/dtaro/decisions` through the real express
 * app: authentication, SUPER_ADMIN only, validation, idempotent retries, lateness, and the switch.
 */

const request = require("supertest");
const jwt = require("jsonwebtoken");

const USERS = {
  "11111111-1111-4111-8111-111111111111": { id: "11111111-1111-4111-8111-111111111111", email: "root@robotx.test", role: "SUPER_ADMIN", campusId: null, disabledAt: null },
  "22222222-2222-4222-8222-222222222222": { id: "22222222-2222-4222-8222-222222222222", email: "campus@robotx.test", role: "ADMIN", campusId: "campus-1", disabledAt: null },
};

const mockPrismaClient = new Proxy(
  {},
  {
    get(_t, model) {
      if (model === "then") return undefined;
      if (model === "user") return { findUnique: async ({ where }) => USERS[where.id] || null };
      if (typeof model === "string" && model.startsWith("$")) return async () => [];
      return new Proxy({}, { get: (_m, method) => (method === "then" ? undefined : async () => (method === "findMany" ? [] : method === "updateMany" ? { count: 1 } : method === "findUnique" || method === "findFirst" ? null : {})) });
    },
  },
);

jest.mock("../../../src/db/prisma", () => ({
  getPrisma: () => mockPrismaClient,
  connectPrisma: jest.fn(),
  connectPrismaWithRetry: jest.fn(),
  disconnectPrisma: jest.fn(),
}));

const app = require("../../../src/app");
const dtaroZoneAlert = require("../../../src/services/dtaroZoneAlert.service");
const obstacleDecision = require("../../../src/services/dtaroObstacleDecision.service");
const world = require("../../helpers/dtaroDecisionWorld");

const SPATIAL = world.buildMap();
const bearer = (id) => `Bearer ${jwt.sign({ id }, process.env.JWT_SECRET)}`;
const SA = bearer("11111111-1111-4111-8111-111111111111");
const ADMIN = bearer("22222222-2222-4222-8222-222222222222");

async function openDecision() {
  const io = { to: () => ({ emit: () => {}, except: () => ({ emit: () => {} }) }), in: () => ({ fetchSockets: async () => [] }), fetchSockets: async () => [] };
  const socket = { data: { robotId: "REP", isAuthed: true, dtaroEligible: true, dtaroZone: { regionId: "rA", zoneId: "zE", room: dtaroZoneAlert.zoneRoom("rA", "zE") } }, emit: () => {} };
  const report = await dtaroZoneAlert.processReport({ io, prisma: mockPrismaClient, kv: null, snapshot: { spatial: SPATIAL }, socket, reporterRobotId: "REP", report: { lat: world.O.lat, lon: world.O.lon, severity: "HIGH" }, deferDelivery: true });
  return obstacleDecision.open({ io, prisma: mockPrismaClient, snapshotOf: () => ({ spatial: SPATIAL }), positionOf: async () => null, report });
}

beforeEach(() => {
  process.env[dtaroZoneAlert.ENV_SWITCH] = "true";
  process.env[obstacleDecision.ENV_SWITCH] = "true";
  dtaroZoneAlert.resetForTests();
  obstacleDecision.resetForTests();
});
afterAll(() => {
  obstacleDecision.resetForTests();
  delete process.env[obstacleDecision.ENV_SWITCH];
  delete process.env[dtaroZoneAlert.ENV_SWITCH];
});

describe("POST /api/dtaro/decisions/:decisionId", () => {
  test("refuses an unauthenticated request and a campus ADMIN; nothing is decided", async () => {
    const { decisionId } = await openDecision();
    const body = { decision: "STOP", idempotencyKey: "click-0001" };
    expect((await request(app).post(`/api/dtaro/decisions/${decisionId}`).send(body)).status).toBe(401);
    expect((await request(app).post(`/api/dtaro/decisions/${decisionId}`).set("Authorization", ADMIN).send(body)).status).toBe(403);
    const list = await request(app).get("/api/dtaro/decisions").set("Authorization", SA);
    expect(list.body.decisions.find((d) => d.decisionId === decisionId).decision).toBeNull();
  });

  test("commits a SUPER_ADMIN's decision once; a retried request returns the committed result; a different one is refused", async () => {
    const { decisionId } = await openDecision();
    const first = await request(app).post(`/api/dtaro/decisions/${decisionId}`).set("Authorization", SA).send({ decision: "REROUTE", idempotencyKey: "click-0002" });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ outcome: "COMMITTED", decision: { decision: { choice: "REROUTE", source: "MANUAL", decidedBy: { userId: "11111111-1111-4111-8111-111111111111" } } } });
    const retry = await request(app).post(`/api/dtaro/decisions/${decisionId}`).set("Authorization", SA).send({ decision: "REROUTE", idempotencyKey: "click-0002" });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ outcome: "ALREADY_COMMITTED", replay: true });
    const other = await request(app).post(`/api/dtaro/decisions/${decisionId}`).set("Authorization", SA).send({ decision: "STOP", idempotencyKey: "click-0003" });
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ error: "ALREADY_DECIDED", committed: { choice: "REROUTE" } });
  });

  test("validates the body and names unknown decisions", async () => {
    const { decisionId } = await openDecision();
    expect((await request(app).post(`/api/dtaro/decisions/${decisionId}`).set("Authorization", SA).send({ decision: "WAIT", idempotencyKey: "click-0004" })).status).toBe(400);
    expect((await request(app).post(`/api/dtaro/decisions/${decisionId}`).set("Authorization", SA).send({ decision: "STOP" })).status).toBe(400);
    const unknown = await request(app).post("/api/dtaro/decisions/not-a-decision").set("Authorization", SA).send({ decision: "STOP", idempotencyKey: "click-0005" });
    expect(unknown.status).toBe(404);
  });

  test("feature off: 404 and the GET answers disabled without touching the table", async () => {
    delete process.env[obstacleDecision.ENV_SWITCH];
    const post = await request(app).post("/api/dtaro/decisions/anything").set("Authorization", SA).send({ decision: "STOP", idempotencyKey: "click-0006" });
    expect(post.status).toBe(404);
    expect(post.body).toEqual({ error: "OPERATOR_DECISIONS_DISABLED" });
    const get = await request(app).get("/api/dtaro/decisions").set("Authorization", SA);
    expect(get.body).toMatchObject({ enabled: false, decisions: [] });
  });
});

describe("GET /api/dtaro/decisions", () => {
  test("restores a pending decision with the server's deadline and clock, so a dashboard never restarts the countdown", async () => {
    const { decisionId, deadlineAt } = await openDecision();
    const res = await request(app).get("/api/dtaro/decisions").set("Authorization", SA);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const found = res.body.decisions.find((d) => d.decisionId === decisionId);
    expect(found).toMatchObject({ status: "AWAITING_OPERATOR_DECISION", deadlineAt, windowMs: 5000, provenance: "SIMULATED" });
    expect(Date.parse(res.body.serverNow)).toBeGreaterThan(0);
  });
});

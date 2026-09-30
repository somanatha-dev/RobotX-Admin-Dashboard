"use strict";

/**
 * P1.3-A — `GET /api/explain/task/:taskId`: the existing explanation, for a task's latest
 * decision.
 *
 * A dashboard holds a task, not a decision id (`<shard>:<decisionTime>:<Leg.id>`, minted by
 * whichever round ran last), so it had no way to reach `GET /api/explain/:decisionId`. This
 * route only resolves the id — Task → Mission → Legs → newest production `DecisionRecordA`
 * — and returns exactly what the decision route returns. The record below is built by the
 * real `tierA.build` in the shape P1.1 persists for a task no robot could take.
 */

const request = require("supertest");
const jwt = require("jsonwebtoken");

const tierA = require("../../src/engine/observability/tierA");
const decisionRecord = require("../../src/engine/observability/decisionRecord");

const mockPrismaClient = {
  user: { findUnique: jest.fn() },
  task: { findUnique: jest.fn() },
  decisionRecordA: { findFirst: jest.fn() },
  calibrationObservation: { findMany: jest.fn() },
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
const DECISION_ID = "v1demo-shard:1790505031894:leg-row-1";

/** A DRONE + 1 kg task on a ROVER fleet, as P1.1 records it. */
const refused = tierA.build({
  identity: { decisionId: DECISION_ID, roundId: "v1demo-shard:1790505031894", shardId: "v1demo-shard", decisionTimeMs: 1790505031894 },
  versions: { configVersion: "1" },
  trigger: "NEW_ARRIVAL",
  inputSnapshotRefs: { snapshotId: "s1" },
  leg: { legId: "LEG-TSK-1", purpose: "PRIMARY", queueAgeSeconds: 40, ladderStep: 0 },
  outcome: { outcome: "NO_FEASIBLE_CANDIDATE", agentId: null },
  candidates: [
    { agentId: "V1DEMO-01", rejected: true, bindingPredicateId: "F21", gammaMilliCU: null },
    { agentId: "V1DEMO-02", rejected: true, bindingPredicateId: "F21", gammaMilliCU: null },
    { agentId: "V1DEMO-05", rejected: true, bindingPredicateId: "MISSING_HOP", gammaMilliCU: null },
  ],
  costTotals: null,
  rejectionSummary: [{ predicateId: "F21", tier: null, count: 2 }],
  searchAndSolveBounds: { regime: "SINGLETON" },
  degradation: {},
  deferral: null,
  overrides: [],
  predictions: {},
  compactTopN: 5,
});
const storedRow = {
  ...tierA.toRow(refused, { tierBWritten: false, samplingRate: 0.01, samplingDraw: 0.4 }),
  decisionTime: new Date(1790505031894),
  inputSnapshot: null,
  tierB: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPrismaClient.user.findUnique.mockResolvedValue(USER);
  mockPrismaClient.calibrationObservation.findMany.mockResolvedValue([]);
  mockPrismaClient.task.findUnique.mockResolvedValue({ missions: [{ legs: [{ id: "leg-row-1" }] }] });
  mockPrismaClient.decisionRecordA.findFirst.mockImplementation(async (args) =>
    args.where && args.where.decisionId ? storedRow : { decisionId: DECISION_ID },
  );
});

const get = (path) => request(app).get(path).set("Authorization", `Bearer ${token()}`);

describe("GET /api/explain/task/:taskId", () => {
  test("requires authentication, like the rest of the surface", async () => {
    await request(app).get("/api/explain/task/TSK-1").expect(401);
  });

  test("resolves the task's newest production decision across its Legs", async () => {
    await get("/api/explain/task/TSK-1").expect(200);
    const resolve = mockPrismaClient.decisionRecordA.findFirst.mock.calls[0][0];
    expect(resolve.where).toMatchObject({ legId: { in: ["leg-row-1"] }, ...decisionRecord.PRODUCTION_ONLY });
    expect(resolve.orderBy).toEqual({ decisionTime: "desc" });
    expect(mockPrismaClient.task.findUnique.mock.calls[0][0].where).toEqual({ taskId: "TSK-1" });
  });

  test("answers exactly as GET /api/explain/:decisionId does for that decision", async () => {
    const byTask = await get("/api/explain/task/TSK-1").expect(200);
    const byDecision = await get(`/api/explain/${encodeURIComponent(DECISION_ID)}`).expect(200);
    expect(byTask.body.decisionId).toBe(DECISION_ID);
    expect(byTask.body.answers).toEqual(byDecision.body.answers);
  });

  test("the answers carry why the task waits and each robot's binding reason", async () => {
    const { body } = await get("/api/explain/task/TSK-1").expect(200);
    const waiting = body.answers.find((a) => a.query === "why_still_waiting");
    expect(waiting).toMatchObject({ outcome: "NO_FEASIBLE_CANDIDATE", bindingConstraint: { predicateId: "F21", count: 2 } });
    const levers = body.answers.find((a) => a.query === "what_would_change_it").feasibilityLevers;
    expect(levers.map((l) => [l.agentId, l.bindingPredicateId])).toEqual([
      ["V1DEMO-01", "F21"],
      ["V1DEMO-02", "F21"],
      ["V1DEMO-05", "MISSING_HOP"],
    ]);
  });

  test("a task no round has considered yet is a 404 that says so", async () => {
    mockPrismaClient.decisionRecordA.findFirst.mockResolvedValue(null);
    const { body } = await get("/api/explain/task/TSK-1").expect(404);
    expect(body.reason).toBe("NO_DECISION_YET");
  });

  test("an unknown task is a 404 that says so", async () => {
    mockPrismaClient.task.findUnique.mockResolvedValue(null);
    const { body } = await get("/api/explain/task/NOPE").expect(404);
    expect(body.reason).toBe("NO_SUCH_TASK");
  });

  test("the decision route is unchanged and still validates its query", async () => {
    await get(`/api/explain/${encodeURIComponent(DECISION_ID)}?query=bogus`).expect(400);
    await get("/api/explain/task/TSK-1?query=bogus").expect(400);
  });
});

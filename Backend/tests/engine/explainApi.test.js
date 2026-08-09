"use strict";

/**
 * Engine lane — Phase 11: `GET /api/explain/:decisionId` (§21.3), the `/health` SLI
 * surface (§20.1), and §21.7's log-volume discipline.
 *
 * The Explanation API is a deliverable rather than a diagnostic: T8 makes explainability
 * a functional requirement, and §21.3 requires every answer to name its source "rather
 * than presenting recomputation as though it were retrieval".
 */

const request = require("supertest");
const jwt = require("jsonwebtoken");

const tierA = require("../../src/engine/observability/tierA");
const tierBModel = require("../../src/engine/observability/tierB");

const MILLI = (cu) => BigInt(cu) * 1000n;

const mockPrismaClient = {
  user: { findUnique: jest.fn() },
  decisionRecordA: { findFirst: jest.fn() },
  calibrationObservation: { findMany: jest.fn() },
  robot: { groupBy: jest.fn() },
  task: { groupBy: jest.fn() },
  $queryRaw: jest.fn(),
  $metrics: { json: jest.fn() },
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

const record = tierA.build({
  identity: { decisionId: "shard-a:1770000000000:LEG-1", roundId: "shard-a:1770000000000", shardId: "shard-a", decisionTimeMs: 1770000000000 },
  versions: { configVersion: "42" },
  trigger: "NEW_ARRIVAL",
  inputSnapshotRefs: { snapshotId: "s1" },
  leg: { legId: "LEG-1", purpose: "PRIMARY", queueAgeSeconds: 120, ladderStep: 1 },
  outcome: { outcome: "ASSIGNED", agentId: "AGT-002" },
  candidates: [
    { agentId: "AGT-001", gammaMilliCU: MILLI(140), discoveryTier: 0, rejected: false },
    { agentId: "AGT-002", gammaMilliCU: MILLI(100), discoveryTier: 1, rejected: false },
  ],
  costTotals: { chosen: { cDirect: MILLI(100) }, runnerUp: { cDirect: MILLI(140) } },
  rejectionSummary: [{ predicateId: "F34", tier: "T2", count: 4 }],
  searchAndSolveBounds: { regime: "SINGLETON" },
  degradation: {},
  deferral: null,
  overrides: [],
  predictions: { TRAVEL_TIME: 300 },
  compactTopN: 5,
});

const storedRow = {
  ...tierA.toRow(record, { tierBWritten: false, samplingRate: 0.01, samplingDraw: 0.4 }),
  decisionTime: new Date(record.identity.decisionTimeMs),
  inputSnapshot: { id: "snap-1", snapshotId: "s1" },
  tierB: null,
};

beforeEach(() => {
  mockPrismaClient.user.findUnique.mockResolvedValue(USER);
  mockPrismaClient.decisionRecordA.findFirst.mockResolvedValue(storedRow);
  mockPrismaClient.calibrationObservation.findMany.mockResolvedValue([]);
  mockPrismaClient.robot.groupBy.mockResolvedValue([]);
  mockPrismaClient.task.groupBy.mockResolvedValue([]);
  mockPrismaClient.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  mockPrismaClient.$metrics.json.mockResolvedValue(null);
});

describe("authorisation", () => {
  test("the surface requires authentication", async () => {
    await request(app).get("/api/explain/shard-a:1770000000000:LEG-1").expect(401);
    await request(app).get("/api/explain/queries").expect(401);
  });
});

describe("GET /api/explain/:decisionId — §21.3", () => {
  test("returns all eight answers, each naming its source", async () => {
    const response = await request(app)
      .get("/api/explain/shard-a:1770000000000:LEG-1")
      .set("Authorization", `Bearer ${token()}`)
      .expect(200);

    expect(response.body.answers).toHaveLength(7);
    // Seven, not eight: `why_not_agent` is skipped when no agent is named rather than
    // guessed at. Naming one returns all eight.
    const named = await request(app)
      .get("/api/explain/shard-a:1770000000000:LEG-1?agentId=AGT-001")
      .set("Authorization", `Bearer ${token()}`)
      .expect(200);
    expect(named.body.answers).toHaveLength(8);

    for (const answer of named.body.answers) {
      expect(["TIER_A", "TIER_B", "RECONSTRUCTED"]).toContain(answer.source);
    }
  });

  test("rolls the sources up — §21.4's 'answers served by source'", async () => {
    const response = await request(app)
      .get("/api/explain/shard-a:1770000000000:LEG-1")
      .set("Authorization", `Bearer ${token()}`)
      .expect(200);

    expect(response.body.sources.TIER_A).toBeGreaterThan(0);
    expect(response.body.sources.RECONSTRUCTED).toBe(1);
  });

  test("states the record's retention and reconstruction state up front", async () => {
    const response = await request(app)
      .get("/api/explain/shard-a:1770000000000:LEG-1")
      .set("Authorization", `Bearer ${token()}`)
      .expect(200);

    expect(response.body.record).toMatchObject({
      tierARetained: true,
      tierBRetained: false,
      inputSnapshotRetained: true,
      reconstructable: true,
      samplingRate: 0.01,
    });
    expect(response.body.record.reconstructionNote).toMatch(/byte-identically/);
  });

  test("an expired input snapshot is reported as the §24.3 defect it is", async () => {
    mockPrismaClient.decisionRecordA.findFirst.mockResolvedValue({ ...storedRow, inputSnapshot: null });
    const response = await request(app)
      .get("/api/explain/shard-a:1770000000000:LEG-1")
      .set("Authorization", `Bearer ${token()}`)
      .expect(200);

    expect(response.body.record.reconstructable).toBe(false);
    expect(response.body.record.reconstructionNote).toMatch(/defect, not a capacity signal/);
  });

  test("a single query is selectable", async () => {
    const response = await request(app)
      .get("/api/explain/shard-a:1770000000000:LEG-1?query=why_this_agent")
      .set("Authorization", `Bearer ${token()}`)
      .expect(200);

    expect(response.body.answers).toHaveLength(1);
    expect(response.body.answers[0].query).toBe("why_this_agent");
    expect(response.body.answers[0].chosenAgentId).toBe("AGT-002");
  });

  test("an unknown query is refused with the list of the real ones", async () => {
    const response = await request(app)
      .get("/api/explain/shard-a:1770000000000:LEG-1?query=why_is_the_sky_blue")
      .set("Authorization", `Bearer ${token()}`)
      .expect(400);
    expect(response.body.queries).toHaveLength(8);
  });

  test("why_not_agent without an agent id is refused rather than guessed", async () => {
    await request(app)
      .get("/api/explain/shard-a:1770000000000:LEG-1?query=why_not_agent")
      .set("Authorization", `Bearer ${token()}`)
      .expect(400);
  });

  test("an unknown decision is a 404", async () => {
    mockPrismaClient.decisionRecordA.findFirst.mockResolvedValue(null);
    await request(app).get("/api/explain/nope").set("Authorization", `Bearer ${token()}`).expect(404);
  });

  test("the query filters out shadow records — a decision the fleet never took", async () => {
    await request(app).get("/api/explain/shard-a:1770000000000:LEG-1").set("Authorization", `Bearer ${token()}`).expect(200);
    const [{ where }] = mockPrismaClient.decisionRecordA.findFirst.mock.calls[0];
    expect(where.shadowLabel).toBeNull();
  });

  test("a stored Tier B is read directly and labelled TIER_B", async () => {
    const full = tierBModel.build({
      decisionId: "shard-a:1770000000000:LEG-1",
      decisionTimeMs: 1770000000000,
      candidates: [{ agentId: "AGT-050", rejected: true, bindingPredicateId: "F22", predicateResults: [] }],
    });
    mockPrismaClient.decisionRecordA.findFirst.mockResolvedValue({ ...storedRow, tierBWritten: true, tierBReason: "SAMPLED", tierB: tierBModel.toRow(full, { writtenBecause: "SAMPLED" }) });

    const response = await request(app)
      .get("/api/explain/shard-a:1770000000000:LEG-1?query=why_not_agent&agentId=AGT-050")
      .set("Authorization", `Bearer ${token()}`)
      .expect(200);

    expect(response.body.answers[0].source).toBe("TIER_B");
    expect(response.body.answers[0].sentence).toMatch(/rejected by F22/);
  });

  test("the realised outcome is joined from where §21.5's loop already lands it", async () => {
    mockPrismaClient.calibrationObservation.findMany.mockResolvedValue([{ predictor: "TRAVEL_TIME", realised: 360 }]);
    const response = await request(app)
      .get("/api/explain/shard-a:1770000000000:LEG-1?query=what_happened")
      .set("Authorization", `Bearer ${token()}`)
      .expect(200);

    expect(response.body.answers[0].settled).toBe(true);
    expect(response.body.answers[0].deltas).toEqual([{ quantity: "TRAVEL_TIME", predicted: 300, realised: 360, signedError: 60 }]);
  });

  test("the query index is self-describing", async () => {
    const response = await request(app).get("/api/explain/queries").set("Authorization", `Bearer ${token()}`).expect(200);
    expect(response.body.queries).toHaveLength(8);
    expect(response.body.queries.find((row) => row.query === "why_not_agent").needsAgentId).toBe(true);
    expect(response.body.sources).toEqual({ TIER_A: "TIER_A", TIER_B: "TIER_B", RECONSTRUCTED: "RECONSTRUCTED" });
  });
});

describe("/health gains the §20.1 SLI surface", () => {
  test("carries an sli block with the target inventory and the safety-window breaches", async () => {
    const response = await request(app).get("/health").expect(200);
    expect(response.body.sli).toMatchObject({
      targets: expect.any(Number),
      measured: expect.any(Number),
      breached: expect.any(Number),
      safetyWindowBreaches: expect.any(Array),
      metricGroups: 7,
    });
    expect(response.body.sli.targets).toBeGreaterThanOrEqual(20);
  });

  test("the legacy /health fields are unchanged", async () => {
    const response = await request(app).get("/health").expect(200);
    for (const field of ["server", "redis", "db", "uptime", "robots", "tasks", "configVersion"]) {
      expect(response.body).toHaveProperty(field);
    }
  });
});

describe("§21.7 — log-volume discipline", () => {
  // The real logger, not the silent stand-in: the discipline is what is under test.
  const logger = jest.requireActual("../../src/config/logger");

  test("the round summary is a log line; a candidate set is not", () => {
    expect(() => logger.round({ roundId: "r1", shardId: "s1", legCount: 40, assigned: 38 })).not.toThrow();
    // "Emitting full candidate sets to logs at fleet scale is a self-inflicted outage."
    expect(() => logger.round({ roundId: "r1", candidates: [{ agentId: "A1" }, { agentId: "A2" }] })).toThrow(logger.LogVolumeDisciplineError);
    expect(() => logger.round({ roundId: "r1", predicateResults: [{ predicateId: "F1" }] })).toThrow(/belongs in the decision record/);
  });

  test("a candidate COUNT survives — that is the round summary §21.7 asks for", () => {
    const { kept, removed } = logger.withoutPerCandidateDetail({ candidates: [1, 2, 3], legCount: 4 });
    expect(kept).toEqual({ candidatesCount: 3, legCount: 4 });
    expect(removed).toEqual([{ field: "candidates", length: 3 }]);
    // A scalar count is not per-candidate detail and must not be stripped.
    expect(logger.withoutPerCandidateDetail({ candidates: 47 }).removed).toEqual([]);
  });

  test("anomalies are the other thing logs carry", () => {
    const line = logger.anomaly("commit_aborted", { decisionId: "d1", commitmentId: "c1", shardId: "s1" });
    expect(line.kind).toBe("anomaly.commit_aborted");
  });

  test("the mandatory correlation fields of §21.7 are named, and a gap is reportable", () => {
    expect(logger.TRACE_FIELDS).toEqual(["traceId", "decisionId", "commitmentId", "missionId", "agentId", "shardId"]);
    expect(logger.missingTraceFields({ decisionId: "d1", shardId: "s1" })).toEqual(["traceId", "commitmentId", "missionId", "agentId"]);
  });

  test("no observability module emits a candidate set to the log stream", () => {
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(__dirname, "..", "..", "src", "engine", "observability");
    for (const name of fs.readdirSync(dir).filter((file) => file.endsWith(".js"))) {
      const source = fs.readFileSync(path.join(dir, name), "utf8");
      // Per-candidate detail belongs in Tier B; these modules do not log at all.
      expect({ name, logs: /logger\./.test(source.replace(/\/\*[\s\S]*?\*\//g, "")) }).toEqual({ name, logs: false });
    }
  });
});

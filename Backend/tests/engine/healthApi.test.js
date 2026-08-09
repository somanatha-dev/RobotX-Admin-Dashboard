"use strict";

/**
 * Engine lane — Phase 12: `GET /api/health/invariants`, `GET /api/health/modes`, and the
 * `/health` degraded summary.
 *
 * §26.1 gives each status a *response* — silence, a page, or a counted time-boxed event —
 * and those responses are only actionable if an operator can see which of the three each
 * invariant is in, and why, during the incident. These tests are about the two properties
 * that make the surface trustworthy rather than merely present: an invariant the checker
 * has never reported on appears as **unreported** rather than being silently absent, and
 * every suspension names the mode that authorised it on the wire as well as in the table.
 */

const request = require("supertest");
const jwt = require("jsonwebtoken");

const modeRegister = require("../../src/engine/degraded/modeRegister");

const mockPrismaClient = {
  user: { findUnique: jest.fn() },
  invariantStatus: { findMany: jest.fn(), groupBy: jest.fn() },
  degradedModeEvent: { findMany: jest.fn() },
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

const NOW = Date.now();

/** @param {string} invariantId @param {object} [overrides] @returns {object} */
function statusRow(invariantId, overrides) {
  return {
    invariantId,
    shardId: "shard-a",
    subjectType: "SHARD",
    subjectId: "",
    status: "ENFORCED",
    checkedAt: new Date(NOW - 5000),
    violationCount: 0,
    authorisingMode: null,
    instrument: "test instrument",
    detail: null,
    ...(overrides || {}),
  };
}

const openCustodial = {
  id: "dme-1",
  shardId: "shard-a",
  mode: modeRegister.MODE.CUSTODIAL_OPERATION,
  cause: "Commitment Store health check failed (B1)",
  enteringComponent: "failure/infraFailures",
  suspendedInvariants: ["I2"],
  degradedInvariants: ["I11", "I13"],
  enteredAt: new Date(NOW - 240000),
  timeBoxExpiresAt: new Date(NOW + 660000),
  exitCriterion: "the store returns **and** full reconciliation completes",
  envelope: { noCommits: true, noCommands: true },
  exitedAt: null,
};

beforeEach(() => {
  // `/health` reads its client from `app.locals`, which is where `server.js` puts it, and
  // not from `getPrisma()` — so the probe keeps working when the process has no connection
  // to hand. Wiring it the way production does is what makes these assertions about the
  // route rather than about the mock.
  app.locals.prisma = mockPrismaClient;
  mockPrismaClient.user.findUnique.mockResolvedValue(USER);
  mockPrismaClient.invariantStatus.findMany.mockResolvedValue([]);
  mockPrismaClient.invariantStatus.groupBy.mockResolvedValue([]);
  mockPrismaClient.degradedModeEvent.findMany.mockResolvedValue([]);
  mockPrismaClient.robot.groupBy.mockResolvedValue([]);
  mockPrismaClient.task.groupBy.mockResolvedValue([]);
  mockPrismaClient.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  mockPrismaClient.$metrics.json.mockResolvedValue(null);
});

describe("GET /api/health/invariants", () => {
  test("requires authentication", async () => {
    const response = await request(app).get("/api/health/invariants");
    expect(response.status).toBe(401);
  });

  test("returns all twenty-two, driven by §26.1's register rather than by what is in the table", async () => {
    // An invariant the checker has never reported on appears as *unreported* rather than
    // being absent. "We have never checked this" and "this is fine" are different
    // sentences, and only one of them is reassuring.
    mockPrismaClient.invariantStatus.findMany.mockResolvedValue([statusRow("I1"), statusRow("I2")]);

    const response = await request(app).get("/api/health/invariants").set("Cookie", [`token=${token()}`]);

    expect(response.status).toBe(200);
    expect(response.body.invariants).toHaveLength(22);
    expect(response.body.summary.unreported).toBe(20);
    expect(response.body.summary.complete).toBe(false);

    const unreported = response.body.invariants.find((row) => row.invariantId === "I22");
    expect(unreported).toMatchObject({ reported: false, status: null, checkedAt: null });
  });

  test("a suspension names the mode that authorised it, and is not counted as a violation", async () => {
    mockPrismaClient.invariantStatus.findMany.mockResolvedValue([
      statusRow("I2", { status: "SUSPENDED", authorisingMode: modeRegister.MODE.CUSTODIAL_OPERATION, violationCount: 3 }),
    ]);
    mockPrismaClient.degradedModeEvent.findMany.mockResolvedValue([openCustodial]);

    const response = await request(app).get("/api/health/invariants").set("Cookie", [`token=${token()}`]);

    const i2 = response.body.invariants.find((row) => row.invariantId === "I2");
    expect(i2.status).toBe("SUSPENDED");
    expect(i2.authorisingMode).toBe("CUSTODIAL_OPERATION");
    expect(response.body.summary.suspended).toBe(1);
    expect(response.body.summary.violated).toBe(0);
    expect(response.body.activeModes).toEqual(["CUSTODIAL_OPERATION"]);
  });

  test("each row carries what §26.2 expects, so a matrix disagreement is visible on the wire", async () => {
    // The specific failure the plan's testing row names: an invariant reporting VIOLATED
    // where the matrix says SUSPENDED.
    mockPrismaClient.invariantStatus.findMany.mockResolvedValue([
      statusRow("I2", { status: "VIOLATED", violationCount: 4 }),
    ]);
    mockPrismaClient.degradedModeEvent.findMany.mockResolvedValue([openCustodial]);

    const response = await request(app).get("/api/health/invariants").set("Cookie", [`token=${token()}`]);

    const i2 = response.body.invariants.find((row) => row.invariantId === "I2");
    expect(i2.expected).toMatchObject({ behaviour: "S", authorisedBy: "CUSTODIAL_OPERATION" });
    expect(i2.matchesMatrix).toBe(false);
    expect(response.body.summary.matrixDisagreements).toEqual(["I2"]);
  });

  test("a `D` cell is consistent with either ENFORCED or VIOLATED — the matrix says whether verification happens, not what it finds", async () => {
    mockPrismaClient.invariantStatus.findMany.mockResolvedValue([statusRow("I11", { status: "VIOLATED", violationCount: 1 })]);
    mockPrismaClient.degradedModeEvent.findMany.mockResolvedValue([openCustodial]);

    const response = await request(app).get("/api/health/invariants").set("Cookie", [`token=${token()}`]);
    const i11 = response.body.invariants.find((row) => row.invariantId === "I11");
    expect(i11.expected.behaviour).toBe("D");
    expect(i11.matchesMatrix).toBe(true);
  });

  test("every row names its obligation tier, so a page can be triaged without a lookup", async () => {
    mockPrismaClient.invariantStatus.findMany.mockResolvedValue([statusRow("I7"), statusRow("I3")]);
    const response = await request(app).get("/api/health/invariants").set("Cookie", [`token=${token()}`]);

    expect(response.body.invariants.find((row) => row.invariantId === "I7").tier).toEqual({ tier: 0, name: "Tier 0 — Safety core" });
    expect(response.body.invariants.find((row) => row.invariantId === "I3").tier).toEqual({ tier: 1, name: "Tier 1 — Operational integrity" });
  });

  test("the age of each stored verdict is reported — a stored verdict is only as good as its age", async () => {
    mockPrismaClient.invariantStatus.findMany.mockResolvedValue([statusRow("I1", { checkedAt: new Date(NOW - 600000) })]);
    const response = await request(app).get("/api/health/invariants").set("Cookie", [`token=${token()}`]);
    expect(response.body.invariants.find((row) => row.invariantId === "I1").ageSeconds).toBeGreaterThanOrEqual(599);
  });

  test("the violation SLI is summed across the register, with a target of exactly zero", async () => {
    mockPrismaClient.invariantStatus.findMany.mockResolvedValue([
      statusRow("I1", { status: "VIOLATED", violationCount: 2 }),
      statusRow("I3", { status: "VIOLATED", violationCount: 5 }),
    ]);
    const response = await request(app).get("/api/health/invariants").set("Cookie", [`token=${token()}`]);
    expect(response.body.summary.invariantViolations).toBe(7);
    expect(response.body.summary.violated).toBe(2);
  });
});

describe("GET /api/health/modes", () => {
  test("requires authentication", async () => {
    expect((await request(app).get("/api/health/modes")).status).toBe(401);
  });

  test("reports the open modes, their envelopes, and their time boxes", async () => {
    mockPrismaClient.degradedModeEvent.findMany.mockImplementation(({ where }) =>
      Promise.resolve(where.exitedAt === null ? [openCustodial] : []),
    );

    const response = await request(app).get("/api/health/modes").set("Cookie", [`token=${token()}`]);

    expect(response.status).toBe(200);
    expect(response.body.degraded).toBe(true);
    expect(response.body.open).toHaveLength(1);
    expect(response.body.open[0]).toMatchObject({
      mode: "CUSTODIAL_OPERATION",
      cause: "Commitment Store health check failed (B1)",
      enteringComponent: "failure/infraFailures",
      suspendedInvariants: ["I2"],
    });
    expect(response.body.open[0].timeBox.expired).toBe(false);
    expect(response.body.commandsSuspended.suspended).toBe(true);
    expect(response.body.commitsSuspended.suspended).toBe(true);
  });

  test("an overdue mode that suspends something is alertable", async () => {
    mockPrismaClient.degradedModeEvent.findMany.mockImplementation(({ where }) =>
      Promise.resolve(where.exitedAt === null ? [{ ...openCustodial, timeBoxExpiresAt: new Date(NOW - 1000) }] : []),
    );

    const response = await request(app).get("/api/health/modes").set("Cookie", [`token=${token()}`]);
    expect(response.body.open[0].timeBox.expired).toBe(true);
    expect(response.body.open[0].timeBox.alertable).toBe(true);
  });

  test("names the durable event stream as the authority, never the advisory mirror", async () => {
    const response = await request(app).get("/api/health/modes").set("Cookie", [`token=${token()}`]);
    expect(response.body.authority).toBe("DegradedModeEvent");
  });

  test("publishes the whole register, so an operator can read a mode before one is entered", async () => {
    // §18.5's argument is that the modes are named *in advance*. Publishing them is what
    // lets an operator read what Custodial Operation will do before the store fails.
    const response = await request(app).get("/api/health/modes").set("Cookie", [`token=${token()}`]);
    expect(response.body.register).toHaveLength(6);
    const custodial = response.body.register.find((row) => row.mode === "CUSTODIAL_OPERATION");
    expect(custodial.envelope.noCommands).toBe(true);
    expect(custodial.suspendsInvariants).toEqual(["I2"]);
    expect(custodial.enteredWhen).toMatch(/Commitment Store is unavailable/);
  });

  test("a nominal shard reports degraded false with an empty open list", async () => {
    const response = await request(app).get("/api/health/modes").set("Cookie", [`token=${token()}`]);
    expect(response.body.degraded).toBe(false);
    expect(response.body.open).toEqual([]);
    expect(response.body.commandsSuspended.suspended).toBe(false);
  });
});

describe("the unauthenticated /health probe", () => {
  test("gains a degraded summary — a process that is up while its shard has suspended an invariant is not healthy", async () => {
    mockPrismaClient.degradedModeEvent.findMany.mockResolvedValue([openCustodial]);
    mockPrismaClient.invariantStatus.groupBy.mockResolvedValue([
      { status: "ENFORCED", _count: { _all: 20 } },
      { status: "SUSPENDED", _count: { _all: 1 } },
      { status: "VIOLATED", _count: { _all: 1 } },
    ]);

    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body.degraded).toMatchObject({
      shardId: "default",
      modes: ["CUSTODIAL_OPERATION"],
      suspendedInvariants: ["I2"],
      invariants: { enforced: 20, violated: 1, suspended: 1 },
    });
  });

  test("is best-effort — a register that cannot be read costs visibility, never availability", async () => {
    mockPrismaClient.degradedModeEvent.findMany.mockRejectedValue(new Error("connection terminated"));

    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body.degraded).toBeNull();
    expect(response.body.server).toBe("ok");
  });

  test("carries no per-invariant detail — that is behind authentication", async () => {
    mockPrismaClient.degradedModeEvent.findMany.mockResolvedValue([openCustodial]);
    const response = await request(app).get("/health");
    expect(response.body.degraded.invariants).toEqual(expect.any(Object));
    expect(response.body.degraded.open).toBeUndefined();
    expect(JSON.stringify(response.body.degraded)).not.toContain("Commitment Store health check failed");
  });
});

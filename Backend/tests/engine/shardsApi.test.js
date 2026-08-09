"use strict";

/**
 * Engine lane — Phase 13: `GET /api/shards`, `POST /api/shards/:id/rebalance`, and the
 * `/health` shard summary.
 *
 * The plan's REST row:
 *
 * > New `GET /api/shards` (membership, leader, **both sizing bounds with the binding one
 * > reported**), `POST /api/shards/:id/rebalance` (control plane, elevated role)
 *
 * Two properties are what make the surface worth having rather than merely present:
 *
 *   - **Both bounds, always.** §3.5 requires both to be monitored and the binding one
 *     reported; a surface returning only the binding one makes the other unmonitorable
 *     through the only place it is shown.
 *   - **The rebalance moves nothing.** §19.2 forbids a bulk reassignment, and an HTTP
 *     request that synchronously moved four hundred agents would be one reached through a
 *     different door. The response says so in a field, not only in prose.
 */

const request = require("supertest");
const jwt = require("jsonwebtoken");

const mockPrismaClient = {
  user: { findUnique: jest.fn() },
  shard: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn() },
  shardLeadership: { findUnique: jest.fn() },
  shardMembership: { findMany: jest.fn(), count: jest.fn() },
  commitment: { count: jest.fn() },
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

const ADMIN = { id: "11111111-1111-4111-8111-111111111111", email: "ops@robotx.test", role: "SUPER_ADMIN" };
const token = (user) => jwt.sign({ id: (user || ADMIN).id }, process.env.JWT_SECRET);

const NOW = Date.now();

function shardRow(overrides) {
  return {
    id: "s-1",
    shardId: "shard-north",
    regionId: "region-north",
    state: "ACTIVE",
    drainingSince: null,
    agentCount: 5000,
    bindingBound: "ROUND_WALL_CLOCK",
    sizingDetail: {
      why: "both bounds hold",
      bounds: {
        ROUND_WALL_CLOCK: { bound: "ROUND_WALL_CLOCK", evaluated: true, satisfied: true, observedMs: 200, samples: 500 },
        SERIAL_COMMIT: { bound: "SERIAL_COMMIT", evaluated: true, satisfied: true },
      },
    },
    sizingCheckedAt: new Date(NOW - 30000),
    lastLeadershipChangeAt: new Date(NOW - 600000),
    lastFailoverAt: new Date(NOW - 600000),
    lastFailoverReconstructedLegs: 12,
    lastFailoverRecoveredCommitments: 340,
    roundsResumableAt: new Date(NOW - 599000),
    ...(overrides || {}),
  };
}

beforeEach(() => {
  // `/health` reads its client from `app.locals`, which is where `server.js` puts it, and
  // the API routes read theirs from `getPrisma()`. Both are the same double here.
  app.locals.prisma = mockPrismaClient;
  mockPrismaClient.user.findUnique.mockResolvedValue(ADMIN);
  mockPrismaClient.shard.findMany.mockResolvedValue([shardRow()]);
  mockPrismaClient.shard.count.mockResolvedValue(1);
  mockPrismaClient.shard.findUnique.mockResolvedValue(shardRow());
  mockPrismaClient.shard.update.mockImplementation(async ({ where, data }) => ({ ...shardRow(), shardId: where.shardId, ...data }));
  mockPrismaClient.shardLeadership.findUnique.mockResolvedValue({
    shardId: "shard-north",
    leadershipFence: 42n,
    holder: "coordinator-a",
    leaseExpiry: new Date(NOW + 4000),
    lastAdvancedBy: "coordinator-a",
    lastAdvancedAt: new Date(NOW - 600000),
  });
  mockPrismaClient.shardMembership.count.mockResolvedValue(5000);
  mockPrismaClient.shardMembership.findMany.mockResolvedValue([]);
  mockPrismaClient.commitment.count.mockResolvedValue(0);
  mockPrismaClient.invariantStatus.findMany.mockResolvedValue([]);
  mockPrismaClient.invariantStatus.groupBy.mockResolvedValue([]);
  mockPrismaClient.degradedModeEvent.findMany.mockResolvedValue([]);
  mockPrismaClient.robot.groupBy.mockResolvedValue([]);
  mockPrismaClient.task.groupBy.mockResolvedValue([]);
  mockPrismaClient.$queryRaw.mockResolvedValue([{ 1: 1 }]);
  mockPrismaClient.$metrics.json.mockResolvedValue(null);
});

/* ═══════════════════════════════════════════════════════════════════════════
   GET /api/shards
   ═══════════════════════════════════════════════════════════════════════════ */

describe("GET /api/shards", () => {
  test("requires authentication, like every diagnostic read since Phase 5", async () => {
    await request(app).get("/api/shards").expect(401);
  });

  test("returns each shard's membership, leader, and both sizing bounds", async () => {
    const response = await request(app).get("/api/shards").set("Cookie", [`token=${token()}`]).expect(200);

    expect(response.body.shardCount).toBe(1);
    const shard = response.body.shards[0];
    expect(shard).toMatchObject({ shardId: "shard-north", regionId: "region-north", state: "ACTIVE", admitsNewWork: true });
    expect(shard.leadership).toMatchObject({ holder: "coordinator-a", leadershipFence: "42" });
    expect(Object.keys(shard.sizing.bounds).sort()).toEqual(["ROUND_WALL_CLOCK", "SERIAL_COMMIT"]);
    expect(shard.sizing.bindingBound).toEqual(expect.any(String));
  });

  test("**both** bounds are returned even when only one binds", async () => {
    const response = await request(app).get("/api/shards").set("Cookie", [`token=${token()}`]).expect(200);
    const { bounds, bindingBound } = response.body.shards[0].sizing;
    expect(bounds.SERIAL_COMMIT).toBeDefined();
    expect(bounds.ROUND_WALL_CLOCK).toBeDefined();
    expect([bounds.SERIAL_COMMIT.bound, bounds.ROUND_WALL_CLOCK.bound]).toContain(bindingBound);
  });

  test("the failover metric appears, separate from anything the reconciler reports", async () => {
    const response = await request(app).get("/api/shards").set("Cookie", [`token=${token()}`]).expect(200);
    expect(response.body.shards[0].failover).toMatchObject({
      reconstructedLegs: 12,
      recoveredCommitments: 340,
      roundsResumable: true,
    });
  });

  test("a membership count that disagrees with the rows is reported as a disagreement, not resolved", async () => {
    mockPrismaClient.shardMembership.count.mockResolvedValue(4999);
    const response = await request(app).get("/api/shards").set("Cookie", [`token=${token()}`]).expect(200);
    expect(response.body.shards[0].membership).toEqual({ countedOnShardRow: 5000, currentMembershipRows: 4999, consistent: false });
  });

  test("the leader's stored verdict is reported beside the live arithmetic, with its age", async () => {
    const response = await request(app).get("/api/shards").set("Cookie", [`token=${token()}`]).expect(200);
    expect(response.body.shards[0].sizing.asRecordedByLeader).toMatchObject({ bindingBound: "ROUND_WALL_CLOCK" });
    expect(response.body.shards[0].sizing.asRecordedByLeader.checkedAt).toBeDefined();
  });

  test("a fleet with no shard definitions says it is a single-shard deployment, not that it has no shards", async () => {
    mockPrismaClient.shard.findMany.mockResolvedValue([]);
    const response = await request(app).get("/api/shards").set("Cookie", [`token=${token()}`]).expect(200);
    expect(response.body).toMatchObject({ shardCount: 0, singleShardDeployment: true, defaultShardId: "default" });
  });

  test("§3.5's operating range is reported, and the floor is flagged when a shard is below it", async () => {
    mockPrismaClient.shard.findMany.mockResolvedValue([shardRow({ agentCount: 40 })]);
    const response = await request(app).get("/api/shards").set("Cookie", [`token=${token()}`]).expect(200);
    expect(response.body.shards[0].sizing.configuredRange.minAgents).toBe(1000);
    expect(response.body.shards[0].sizing.belowOperatingFloor).toBe(true);
  });

  test("a draining shard reports that it admits no new work", async () => {
    mockPrismaClient.shard.findMany.mockResolvedValue([shardRow({ state: "DRAINING", drainingSince: new Date(NOW - 1000) })]);
    const response = await request(app).get("/api/shards").set("Cookie", [`token=${token()}`]).expect(200);
    expect(response.body.shards[0].admitsNewWork).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   POST /api/shards/:id/rebalance
   ═══════════════════════════════════════════════════════════════════════════ */

describe("POST /api/shards/:id/rebalance", () => {
  beforeEach(() => {
    mockPrismaClient.shard.findUnique.mockImplementation(async ({ where }) =>
      where.shardId === "shard-south" ? shardRow({ id: "s-2", shardId: "shard-south", regionId: "region-south", agentCount: 0 }) : shardRow(),
    );
    mockPrismaClient.shardMembership.findMany.mockResolvedValue([
      { agentId: "agent-1", shardId: "shard-north" },
      { agentId: "agent-2", shardId: "shard-north" },
    ]);
  });

  test("requires authentication and an elevated role — §22.3 makes shard definition STRUCTURAL", async () => {
    await request(app).post("/api/shards/shard-north/rebalance").send({ targetShardId: "shard-south" }).expect(401);

    mockPrismaClient.user.findUnique.mockResolvedValue({ ...ADMIN, role: "VIEWER" });
    await request(app)
      .post("/api/shards/shard-north/rebalance")
      .set("Cookie", [`token=${token()}`])
      .send({ targetShardId: "shard-south" })
      .expect(403);
  });

  test("returns 202 with an ordered plan and **executes nothing**", async () => {
    const response = await request(app)
      .post("/api/shards/shard-north/rebalance")
      .set("Cookie", [`token=${token()}`])
      .send({ targetShardId: "shard-south" })
      .expect(202);

    expect(response.body.executed).toBe(false);
    expect(response.body.plan.moves).toHaveLength(2);
    expect(response.body.note).toMatch(/\*\*no agent has moved\*\*/);
    expect(response.body.note).toMatch(/one agent at a time/);
  });

  test("a full drain moves the source shard to DRAINING; a partial one to REBALANCING", async () => {
    const full = await request(app)
      .post("/api/shards/shard-north/rebalance")
      .set("Cookie", [`token=${token()}`])
      .send({ targetShardId: "shard-south" })
      .expect(202);
    expect(full.body.state).toBe("DRAINING");

    const partial = await request(app)
      .post("/api/shards/shard-north/rebalance")
      .set("Cookie", [`token=${token()}`])
      .send({ targetShardId: "shard-south", moveCount: 1 })
      .expect(202);
    expect(partial.body.state).toBe("REBALANCING");
  });

  test("a rebalance with no target is refused — there is no operation that removes an agent from every shard", async () => {
    const response = await request(app)
      .post("/api/shards/shard-north/rebalance")
      .set("Cookie", [`token=${token()}`])
      .send({})
      .expect(422);
    expect(response.body.message).toMatch(/every agent to belong to exactly one shard at a time/);
  });

  test("a rebalance to the same shard is refused — an epoch burnt for a handoff that changes nothing", async () => {
    const response = await request(app)
      .post("/api/shards/shard-north/rebalance")
      .set("Cookie", [`token=${token()}`])
      .send({ targetShardId: "shard-north" })
      .expect(422);
    expect(response.body.message).toMatch(/source and target shards are the same/);
  });

  test("a rebalance into a draining shard is refused", async () => {
    mockPrismaClient.shard.findUnique.mockImplementation(async ({ where }) =>
      where.shardId === "shard-south"
        ? shardRow({ id: "s-2", shardId: "shard-south", regionId: "region-south", state: "DRAINING", drainingSince: new Date(NOW) })
        : shardRow(),
    );
    const response = await request(app)
      .post("/api/shards/shard-north/rebalance")
      .set("Cookie", [`token=${token()}`])
      .send({ targetShardId: "shard-south" })
      .expect(422);
    expect(response.body.message).toMatch(/does not admit members/);
  });

  test("an unknown shard is a 404", async () => {
    mockPrismaClient.shard.findUnique.mockResolvedValue(null);
    await request(app)
      .post("/api/shards/nowhere/rebalance")
      .set("Cookie", [`token=${token()}`])
      .send({ targetShardId: "shard-south" })
      .expect(404);
  });

  test("idle agents are ordered first in the plan", async () => {
    mockPrismaClient.commitment.count.mockImplementation(async ({ where }) => (where.agentId === "agent-1" ? 3 : 0));
    const response = await request(app)
      .post("/api/shards/shard-north/rebalance")
      .set("Cookie", [`token=${token()}`])
      .send({ targetShardId: "shard-south" })
      .expect(202);
    expect(response.body.plan.moves.map((move) => move.agentId)).toEqual(["agent-2", "agent-1"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The /health summary
   ═══════════════════════════════════════════════════════════════════════════ */

describe("`/health` gains a shard summary", () => {
  test("it reports whether the shard is led and whether its rounds have resumed", async () => {
    const response = await request(app).get("/health").expect(200);
    expect(response.body.shard).toMatchObject({
      shardId: "default",
      led: true,
      leaseValid: true,
      roundsResumable: true,
      leadershipFence: "42",
    });
  });

  test("the holder's identity is **not** on the unauthenticated route", async () => {
    const response = await request(app).get("/health").expect(200);
    expect(JSON.stringify(response.body.shard)).not.toContain("coordinator-a");
  });

  test("it reads the durable leadership row, never the advisory cache mirror", async () => {
    await request(app).get("/health").expect(200);
    expect(mockPrismaClient.shardLeadership.findUnique).toHaveBeenCalled();
  });

  test("zero shard definitions reads as a single-shard deployment", async () => {
    mockPrismaClient.shard.count.mockResolvedValue(0);
    const response = await request(app).get("/health").expect(200);
    expect(response.body.shard).toMatchObject({ shardCount: 0, singleShardDeployment: true });
  });

  test("a shard whose leader has not finished reconciling is distinguishable from an unled one", async () => {
    mockPrismaClient.shard.findUnique.mockResolvedValue(shardRow({ roundsResumableAt: null }));
    const response = await request(app).get("/health").expect(200);
    expect(response.body.shard).toMatchObject({ led: true, roundsResumable: false });
  });

  test("a store that cannot be read costs visibility and never availability", async () => {
    mockPrismaClient.shardLeadership.findUnique.mockRejectedValue(new Error("db down"));
    const response = await request(app).get("/health").expect(200);
    expect(response.body.shard).toBeNull();
    expect(response.body.server).toBe("ok");
  });
});

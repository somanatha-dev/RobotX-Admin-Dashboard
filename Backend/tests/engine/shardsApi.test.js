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
  shard: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
  shardLeadership: { findUnique: jest.fn() },
  shardMembership: { findMany: jest.fn(), count: jest.fn() },
  // PHASE 13 REMEDIATION — §19.2's durable intent. The endpoint writes it and the shard
  // state in one transaction, so the double models `$transaction` as well.
  shardRebalance: { findFirst: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
  commitment: { count: jest.fn() },
  invariantStatus: { findMany: jest.fn(), groupBy: jest.fn() },
  degradedModeEvent: { findMany: jest.fn() },
  robot: { groupBy: jest.fn() },
  task: { groupBy: jest.fn() },
  $queryRaw: jest.fn(),
  $metrics: { json: jest.fn() },
  // The transaction is the double's own client: every assertion below is about *what* was
  // written, and a double that ran the callback against a second object would let the two
  // halves of an atomic write be checked against different state.
  $transaction: (fn) => (typeof fn === "function" ? fn(mockPrismaClient) : Promise.all(fn)),
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

/**
 * A fresh rate-limit bucket per request.
 *
 * `createRateLimiter` keys on client IP + method + path and the rebalance route allows ten
 * per minute — deliberately, because a rebalance is a STRUCTURAL change. Tests that share
 * one bucket would start reporting 429 as the suite grew, which is a suite that fails for a
 * reason having nothing to do with the behaviour under test. The limiter itself is
 * unchanged and is asserted on its own below.
 */
let callerOctet = 0;
const fromANewCaller = () => {
  callerOctet += 1;
  return ["X-Forwarded-For", `10.0.0.${callerOctet}`];
};

/** A durable intent shaped as `shardModel.openRebalance()` writes one. */
function rebalanceRow(overrides) {
  const moves = (overrides && overrides.moves) || [{ order: 0, agentId: "agent-1", fromShardId: "shard-north", targetShardId: "shard-south", reason: "REBALANCE_MERGE", liveCommitments: 0, allowCustodyTransfer: false }];
  return {
    id: "rb-1",
    sourceShardId: "shard-north",
    targetShardId: "shard-south",
    state: "PENDING",
    reason: "REBALANCE_MERGE",
    restoreState: "ACTIVE",
    plan: { moves, surplus: moves.length, note: "" },
    plannedMoves: moves.length,
    completedMoves: 0,
    blocked: null,
    requestedBy: ADMIN.id,
    requestedAt: new Date(NOW),
    startedAt: null,
    lastMoveAt: null,
    closedAt: null,
    closedReason: null,
    detail: null,
    ...(overrides || {}),
  };
}

beforeEach(() => {
  // §23.3 — the endpoint refuses to record an intent this deployment cannot execute, so
  // every rebalance test needs the key the supervisor will sign `SHARD_MIGRATE` with. The
  // refusal itself is asserted in its own test, which unsets it.
  process.env.COMMAND_SIGNING_KEY = "a-signing-key-long-enough-for-§23.3-to-accept-it";
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
  mockPrismaClient.shardRebalance.findFirst.mockResolvedValue(null);
  mockPrismaClient.shardRebalance.create.mockImplementation(async ({ data }) => ({ id: "rb-1", ...data }));
  mockPrismaClient.shardRebalance.updateMany.mockResolvedValue({ count: 1 });
  mockPrismaClient.shard.updateMany.mockResolvedValue({ count: 1 });
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
   PHASE 13 REMEDIATION — P13-R4: the intent is durable, and it terminates

   The endpoint used to move a shard to DRAINING and return the plan in a response
   body that was its only copy. Nothing executed it, `shardModel.setState`'s only
   caller was this endpoint and it only ever set DRAINING or REBALANCING, and
   `intake.js` had already stopped routing Legs to the shard. Every test below is
   about a durable state a shard can no longer be left in.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("POST /api/shards/:id/rebalance — the durable intent", () => {
  beforeEach(() => {
    mockPrismaClient.shard.findUnique.mockImplementation(async ({ where }) =>
      where.shardId === "shard-south" ? shardRow({ id: "s-2", shardId: "shard-south", regionId: "region-south", agentCount: 0 }) : shardRow(),
    );
    mockPrismaClient.shardMembership.findMany.mockResolvedValue([
      { agentId: "agent-1", shardId: "shard-north" },
      { agentId: "agent-2", shardId: "shard-north" },
    ]);
  });

  test("**the plan is persisted**, in the same transaction as the state change", async () => {
    const response = await request(app)
      .post("/api/shards/shard-north/rebalance")
      .set(...fromANewCaller())
      .set("Cookie", [`token=${token()}`])
      .send({ targetShardId: "shard-south" })
      .expect(202);

    expect(mockPrismaClient.shardRebalance.create).toHaveBeenCalledTimes(1);
    const written = mockPrismaClient.shardRebalance.create.mock.calls[0][0].data;
    expect(written).toMatchObject({
      sourceShardId: "shard-north",
      targetShardId: "shard-south",
      state: "PENDING",
      plannedMoves: 2,
      completedMoves: 0,
      // The route back, recorded at creation rather than guessed at closure.
      restoreState: "ACTIVE",
      requestedBy: ADMIN.id,
    });
    // Byte-for-byte the plan the operator was shown.
    expect(written.plan.moves.map((move) => move.agentId)).toEqual(response.body.plan.moves.map((move) => move.agentId));
    expect(response.body.rebalance).toMatchObject({ state: "PENDING", plannedMoves: 2, restoreState: "ACTIVE" });
  });

  test("a plan with no move changes nothing — the shard is not taken out of service for an empty plan", async () => {
    mockPrismaClient.shardMembership.findMany.mockResolvedValue([]);

    const response = await request(app)
      .post("/api/shards/shard-north/rebalance")
      .set(...fromANewCaller())
      .set("Cookie", [`token=${token()}`])
      .send({ targetShardId: "shard-south" })
      .expect(422);

    expect(response.body.refusal).toBe("THE_PLAN_CONTAINS_NO_MOVE");
    expect(response.body.state).toBe("ACTIVE");
    expect(mockPrismaClient.shardRebalance.create).not.toHaveBeenCalled();
    expect(mockPrismaClient.shard.update).not.toHaveBeenCalled();
  });

  test("a second rebalance is refused while one is open — two plans over one membership set is a bulk reassignment", async () => {
    mockPrismaClient.shardRebalance.findFirst.mockResolvedValue(rebalanceRow());

    const response = await request(app)
      .post("/api/shards/shard-north/rebalance")
      .set(...fromANewCaller())
      .set("Cookie", [`token=${token()}`])
      .send({ targetShardId: "shard-south" })
      .expect(422);

    expect(response.body.refusal).toBe("A_REBALANCE_IS_ALREADY_OPEN_FOR_THIS_SHARD");
    expect(response.body.open).toMatchObject({ id: "rb-1", state: "PENDING" });
    expect(mockPrismaClient.shardRebalance.create).not.toHaveBeenCalled();
  });

  test("a request that loses the index race is refused, not turned into a 500", async () => {
    // Both requests pass the pre-read in the same instant; the partial unique index decides.
    // Live check Y6 exercises the genuine race; this pins the branch that turns the loser's
    // constraint violation into an answer the caller can act on.
    const conflict = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    mockPrismaClient.shardRebalance.create.mockRejectedValueOnce(conflict);
    mockPrismaClient.shardRebalance.findFirst
      .mockResolvedValueOnce(null) // the pre-read: nothing open yet
      .mockResolvedValueOnce(null) // the in-transaction re-read: still nothing
      .mockResolvedValue(rebalanceRow()); // after the violation: the winner

    const response = await request(app)
      .post("/api/shards/shard-north/rebalance")
      .set(...fromANewCaller())
      .set("Cookie", [`token=${token()}`])
      .send({ targetShardId: "shard-south" })
      .expect(422);

    expect(response.body.refusal).toBe("A_REBALANCE_IS_ALREADY_OPEN_FOR_THIS_SHARD");
    expect(response.body.open).toMatchObject({ id: "rb-1" });
  });

  test("without a signing key no intent is recorded — an unexecutable plan is not written down", async () => {
    delete process.env.COMMAND_SIGNING_KEY;

    const response = await request(app)
      .post("/api/shards/shard-north/rebalance")
      .set(...fromANewCaller())
      .set("Cookie", [`token=${token()}`])
      .send({ targetShardId: "shard-south" })
      .expect(422);

    expect(response.body.message).toMatch(/COMMAND_SIGNING_KEY/);
    expect(mockPrismaClient.shardRebalance.create).not.toHaveBeenCalled();
    expect(mockPrismaClient.shard.update).not.toHaveBeenCalled();
  });

  test("**the route back**: cancelling restores the shard and closes the intent", async () => {
    mockPrismaClient.shardRebalance.findFirst.mockResolvedValue(rebalanceRow({ state: "EXECUTING", completedMoves: 1 }));

    const response = await request(app)
      .post("/api/shards/shard-north/rebalance")
      .set(...fromANewCaller())
      .set("Cookie", [`token=${token()}`])
      .send({ cancel: true, reason: "the split was premature" })
      .expect(200);

    expect(response.body).toMatchObject({ cancelled: true, shardRestoredTo: "ACTIVE", completedMoves: 1 });

    // The shard is restored **before** the intent is closed: the other order leaves a crash
    // window in which no intent is open and the shard is still draining.
    const restore = mockPrismaClient.shard.updateMany.mock.calls[0][0];
    expect(restore).toEqual({
      where: { shardId: "shard-north", state: { in: ["DRAINING", "REBALANCING"] } },
      data: { state: "ACTIVE", drainingSince: null },
    });
    const close = mockPrismaClient.shardRebalance.updateMany.mock.calls[0][0];
    expect(close.where).toEqual({ id: "rb-1", state: { in: ["PENDING", "EXECUTING"] } });
    expect(close.data.state).toBe("CANCELLED");
    expect(close.data.closedAt).toBeInstanceOf(Date);
  });

  test("cancelling when nothing is open is a refusal that says what the state actually is", async () => {
    mockPrismaClient.shard.findUnique.mockResolvedValue(shardRow({ state: "DRAINING", drainingSince: new Date(NOW) }));

    const response = await request(app)
      .post("/api/shards/shard-north/rebalance")
      .set(...fromANewCaller())
      .set("Cookie", [`token=${token()}`])
      .send({ cancel: true })
      .expect(422);

    expect(response.body.refusal).toBe("NO_OPEN_REBALANCE_FOR_THIS_SHARD");
    expect(response.body.state).toBe("DRAINING");
    expect(mockPrismaClient.shard.updateMany).not.toHaveBeenCalled();
  });

  test("cancellation is elevated, like the rebalance it withdraws", async () => {
    mockPrismaClient.user.findUnique.mockResolvedValue({ ...ADMIN, role: "VIEWER" });
    await request(app)
      .post("/api/shards/shard-north/rebalance")
      .set(...fromANewCaller())
      .set("Cookie", [`token=${token()}`])
      .send({ cancel: true })
      .expect(403);
  });

  test("§2.5's custody consent is carried onto every move rather than re-derived by the executor", async () => {
    const response = await request(app)
      .post("/api/shards/shard-north/rebalance")
      .set(...fromANewCaller())
      .set("Cookie", [`token=${token()}`])
      .send({ targetShardId: "shard-south", allowCustodyTransfer: true })
      .expect(202);

    expect(response.body.plan.moves.every((move) => move.allowCustodyTransfer === true)).toBe(true);
    // And absent unless asked for.
    const plain = await request(app)
      .post("/api/shards/shard-north/rebalance")
      .set(...fromANewCaller())
      .set("Cookie", [`token=${token()}`])
      .send({ targetShardId: "shard-south" })
      .expect(202);
    expect(plain.body.plan.moves.every((move) => move.allowCustodyTransfer === false)).toBe(true);
  });

  test("GET /api/shards reports the open intent, so a DRAINING shard says why", async () => {
    mockPrismaClient.shard.findMany.mockResolvedValue([shardRow({ state: "DRAINING", drainingSince: new Date(NOW) })]);
    mockPrismaClient.shardRebalance.findFirst.mockResolvedValue(rebalanceRow({ state: "EXECUTING", completedMoves: 1 }));

    const response = await request(app).get("/api/shards").set(...fromANewCaller()).set("Cookie", [`token=${token()}`]).expect(200);

    expect(response.body.shards[0]).toMatchObject({ state: "DRAINING", admitsNewWork: false });
    expect(response.body.shards[0].rebalance).toMatchObject({
      id: "rb-1",
      state: "EXECUTING",
      targetShardId: "shard-south",
      plannedMoves: 1,
      completedMoves: 1,
      restoreState: "ACTIVE",
    });
  });

  test("a shard with no open intent reports none rather than omitting the field", async () => {
    const response = await request(app).get("/api/shards").set(...fromANewCaller()).set("Cookie", [`token=${token()}`]).expect(200);
    expect(response.body.shards[0].rebalance).toBeNull();
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

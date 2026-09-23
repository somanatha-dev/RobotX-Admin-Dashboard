"use strict";

/**
 * Regression tests for two producers the V1 demonstration path needed and that had no
 * caller before it (defects D12 and D13 in docs/runbooks/v1-demonstration-assignment.md):
 *
 *   · `commitmentLeaseRenewal` — a commitment-scoped heartbeat renews the §12.2 lease;
 *     without it every mission longer than one lease was reassigned mid-drive.
 *   · `legProgress` — §4.4's execution events from the server's own position evidence and
 *     the agent's commitment-scoped custody report; without it an accepted Leg sat in
 *     ACCEPTED until it was reassigned while the agent was driving it.
 *
 * Each test states the refusal as well as the success, so the producer cannot be satisfied
 * by an agent's bare claim.
 */

const leases = require("../../src/engine/supervision/leases");
const transitions = require("../../src/engine/lifecycle/transitions");
const renewal = require("../../src/services/commitmentLeaseRenewal.service");
const legProgress = require("../../src/services/legProgress.service");

const STORE_NOW = new Date("2026-09-23T10:00:00.000Z");

function txWith(rows) {
  return {
    $queryRawUnsafe: async () => [{ now: STORE_NOW }],
    commitment: { findUnique: async () => rows.commitment || null },
    leg: { findUnique: async () => rows.leg || null },
    observation: { findMany: async () => rows.fixes || [] },
    outbox: { findFirst: async () => null },
  };
}

function prismaWith(rows) {
  const tx = txWith(rows);
  return {
    agent: { findUnique: async ({ where }) => (where.agentId === "SIM-1" ? { id: "agent-row-1" } : null) },
    commitment: { findFirst: async () => rows.commitment || null },
    $transaction: async (fn) => fn(tx),
  };
}

const snapshot = { resolve: (name) => ({ "lease.duration": 60 }[name]), values: {} };

afterEach(() => jest.restoreAllMocks());

describe("D12 — commitment lease renewal from the agent's heartbeat", () => {
  const commitment = (msLeft) => ({
    commitmentId: "c-1",
    agentId: "agent-row-1",
    fence: 7n,
    leaseExpiry: new Date(STORE_NOW.getTime() + msLeft),
  });

  test("a heartbeat naming the commitment renews it once half the lease has elapsed", async () => {
    const spy = jest.spyOn(leases, "renew").mockResolvedValue({ outcome: leases.RENEWAL_OUTCOME.RENEWED });
    const out = await renewal.renewFromHeartbeat({
      prisma: prismaWith({ commitment: commitment(20_000) }),
      robotId: "SIM-1",
      evidence: { commitmentId: "c-1", fence: "7" },
      snapshot,
    });
    expect(out).toEqual({ renewed: true, reason: null });
    expect(spy.mock.calls[0][1]).toMatchObject({ evidence: { commitmentId: "c-1", fence: "7" }, leaseDurationSeconds: 60 });
  });

  test("not yet due: a 2 s heartbeat does not become a 2 s write", async () => {
    const spy = jest.spyOn(leases, "renew");
    const out = await renewal.renewFromHeartbeat({ prisma: prismaWith({ commitment: commitment(50_000) }), robotId: "SIM-1", evidence: { commitmentId: "c-1", fence: "7" }, snapshot });
    expect(out.reason).toBe("NOT_DUE");
    expect(spy).not.toHaveBeenCalled();
  });

  test("a bare heartbeat renews nothing", async () => {
    const out = await renewal.renewFromHeartbeat({ prisma: prismaWith({}), robotId: "SIM-1", evidence: undefined, snapshot });
    expect(out).toEqual({ renewed: false, reason: "UNSCOPED_HEARTBEAT" });
  });

  test("another agent's commitment is never renewed on this agent's word", async () => {
    const out = await renewal.renewFromHeartbeat({
      prisma: prismaWith({ commitment: { ...commitment(10_000), agentId: "someone-else" } }),
      robotId: "SIM-1",
      evidence: { commitmentId: "c-1", fence: "7" },
      snapshot,
    });
    expect(out.reason).toBe("NOT_THIS_AGENTS_COMMITMENT");
  });

  test("with no lease.duration published it refuses rather than guessing", async () => {
    const out = await renewal.renewFromHeartbeat({ prisma: prismaWith({}), robotId: "SIM-1", evidence: { commitmentId: "c-1", fence: "7" }, snapshot: { resolve: () => undefined } });
    expect(out.reason).toBe("LEASE_DURATION_UNRESOLVED");
  });
});

describe("D13 — §4.4 execution events from evidence", () => {
  const OLD_RADIUS = process.env.VERIFY_ARRIVAL_RADIUS_M;
  beforeAll(() => {
    process.env.VERIFY_ARRIVAL_RADIUS_M = "25";
  });
  afterAll(() => {
    if (OLD_RADIUS === undefined) delete process.env.VERIFY_ARRIVAL_RADIUS_M;
    else process.env.VERIFY_ARRIVAL_RADIUS_M = OLD_RADIUS;
  });

  const PICKUP = { stopType: "PICKUP", sequence: 1, lat: 12.9, lon: 77.5 };
  const DROP = { stopType: "DROP", sequence: 2, lat: 12.905, lon: 77.505 };
  const liveCommitment = { commitmentId: "c-1", agentId: "agent-row-1", legId: "leg-row-1", fence: 7n, grantedAt: new Date(0), releasedAt: null };
  const legIn = (state) => ({ id: "leg-row-1", legId: "L1", state, version: 3, stops: [PICKUP, DROP] });
  const fix = (lat, lon) => ({ value: { lat, lon } });

  const applied = () => jest.spyOn(transitions, "apply").mockImplementation(async (_tx, input) => ({ outcome: "APPLIED", event: input.event }));

  test("ACCEPTED → departure only once the agent has actually moved (≥ MIN_DEPARTURE_M)", async () => {
    const spy = applied();
    const still = await legProgress.onPositionFix({ prisma: prismaWith({ commitment: liveCommitment, leg: legIn("ACCEPTED"), fixes: [fix(12.9, 77.5), fix(12.90001, 77.5)] }), agentRowId: "agent-row-1", snapshot });
    expect(still).toBeNull();
    const moved = await legProgress.onPositionFix({ prisma: prismaWith({ commitment: liveCommitment, leg: legIn("ACCEPTED"), fixes: [fix(12.9, 77.5), fix(12.9001, 77.5)] }), agentRowId: "agent-row-1", snapshot });
    expect(moved.event).toBe(transitions.EVENT.DEPARTURE_DETECTED);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("EN_ROUTE_PICKUP → arrival only inside the verification radius of the pickup stop", async () => {
    applied();
    const far = await legProgress.onPositionFix({ prisma: prismaWith({ commitment: liveCommitment, leg: legIn("EN_ROUTE_PICKUP"), fixes: [fix(12.901, 77.5)] }), agentRowId: "agent-row-1", snapshot });
    expect(far).toBeNull();
    const there = await legProgress.onPositionFix({ prisma: prismaWith({ commitment: liveCommitment, leg: legIn("EN_ROUTE_PICKUP"), fixes: [fix(12.90005, 77.5)] }), agentRowId: "agent-row-1", snapshot });
    expect(there.event).toBe(transitions.EVENT.ARRIVAL_VERIFIED);
  });

  test("no live commitment, no progress", async () => {
    const out = await legProgress.onPositionFix({ prisma: prismaWith({}), agentRowId: "agent-row-1", snapshot });
    expect(out).toBeNull();
  });

  test("custody is admitted only at the stop the server verified, with the live fence", async () => {
    const spy = applied();
    const early = await legProgress.onCustodyReport({ prisma: prismaWith({ commitment: liveCommitment, leg: legIn("EN_ROUTE_PICKUP") }), robotId: "SIM-1", report: { commitmentId: "c-1", fence: "7", kind: "ACQUIRED" }, snapshot });
    // Not applied: held until the server verifies the arrival (see the next test).
    expect(early.outcome).toBe("HELD_UNTIL_ARRIVAL");
    expect(spy).not.toHaveBeenCalled();
    const stale = await legProgress.onCustodyReport({ prisma: prismaWith({ commitment: liveCommitment, leg: legIn("AT_PICKUP") }), robotId: "SIM-1", report: { commitmentId: "c-1", fence: "6", kind: "ACQUIRED" }, snapshot });
    expect(stale.reason).toBe("STALE_OR_MISSING_FENCE");
    const ok = await legProgress.onCustodyReport({ prisma: prismaWith({ commitment: liveCommitment, leg: legIn("AT_PICKUP") }), robotId: "SIM-1", report: { commitmentId: "c-1", fence: "7", kind: "ACQUIRED" }, snapshot });
    expect(ok.event).toBe(transitions.EVENT.CUSTODY_ACQUIRED);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("a custody report that arrives before the verified arrival is held, then applied at arrival — never before", async () => {
    const leg = legIn("EN_ROUTE_PICKUP");
    const events = [];
    jest.spyOn(transitions, "apply").mockImplementation(async (_tx, input) => {
      events.push(input.event);
      const to = input.event === transitions.EVENT.ARRIVAL_VERIFIED ? "AT_PICKUP" : "LOADED";
      leg.state = to;
      return { outcome: transitions.OUTCOME.APPLIED, from: input.leg.state, to, event: input.event };
    });
    const prisma = prismaWith({ commitment: liveCommitment, leg, fixes: [fix(12.901, 77.5)] });

    // The agent finished its pickup dwell before the server saw it arrive.
    const early = await legProgress.onCustodyReport({ prisma, robotId: "SIM-1", report: { commitmentId: "c-1", fence: "7", kind: "ACQUIRED" }, snapshot });
    expect(early.outcome).toBe("HELD_UNTIL_ARRIVAL");
    expect(events).toEqual([]);

    // A fix outside the radius changes nothing, and the held report is not applied.
    expect(await legProgress.onPositionFix({ prisma, agentRowId: "agent-row-1", snapshot })).toBeNull();
    expect(events).toEqual([]);

    // The server verifies the arrival from its own fix — only then is custody admitted.
    const arrivedPrisma = prismaWith({ commitment: liveCommitment, leg, fixes: [fix(12.90005, 77.5)] });
    const out = await legProgress.onPositionFix({ prisma: arrivedPrisma, agentRowId: "agent-row-1", snapshot });
    expect(events).toEqual([transitions.EVENT.ARRIVAL_VERIFIED, transitions.EVENT.CUSTODY_ACQUIRED]);
    expect(out.custody.event).toBe(transitions.EVENT.CUSTODY_ACQUIRED);
    expect(leg.state).toBe("LOADED");
  });

  test("a released commitment's custody report is ignored", async () => {
    const out = await legProgress.onCustodyReport({
      prisma: prismaWith({ commitment: { ...liveCommitment, releasedAt: new Date() }, leg: legIn("AT_DROP") }),
      robotId: "SIM-1",
      report: { commitmentId: "c-1", fence: "7", kind: "RELEASED" },
      snapshot,
    });
    expect(out.reason).toBe("NOT_THIS_AGENTS_LIVE_COMMITMENT");
  });
});

describe("the Task follows a reassigned Leg to its new robot", () => {
  const projection = require("../../src/services/assignmentProjection.service");

  /** A small in-memory store that evaluates exactly the where-clauses the projection writes. */
  function store(task, robots) {
    const matchesTask = (where) =>
      where.id === task.id &&
      where.OR.some((branch) => branch.status.in.includes(task.status) && (!branch.robotId || task.robotId !== branch.robotId.not));
    const tx = {
      task: {
        updateMany: async ({ where, data }) => {
          if (!matchesTask(where)) return { count: 0 };
          Object.assign(task, data);
          return { count: 1 };
        },
      },
      robot: {
        updateMany: async ({ where, data }) => {
          const rows = robots.filter((r) =>
            where.OR
              ? r.id === where.id && (r.currentTaskId === null || r.currentTaskId === where.OR[1].currentTaskId)
              : r.currentTaskId === where.currentTaskId && r.id !== where.id.not,
          );
          rows.forEach((r) => Object.assign(r, data));
          return { count: rows.length };
        },
      },
    };
    return {
      leg: { findUnique: async () => ({ mission: { tasks: [task] } }) },
      robot: { findUnique: async ({ where }) => robots.find((r) => r.robotCode === where.robotId) || null },
      $transaction: async (fn) => fn(tx),
    };
  }

  test("a Task ASSIGNED to the robot that died moves to the robot that accepted the reassignment", async () => {
    const task = { id: "t1", taskId: "V1F-ABANDONED", status: "ASSIGNED", robotId: "row-dies" };
    const robots = [
      { id: "row-dies", robotCode: "V1F-DIES", currentTaskId: "t1" },
      { id: "row-okc", robotCode: "V1F-OK-C", currentTaskId: null },
    ];
    const out = await projection.projectAcceptedAssignment(store(task, robots), { legRowId: "leg-1", robotCode: "V1F-OK-C" });
    expect(out.projected).toBe(true);
    expect(task.robotId).toBe("row-okc");
    expect(robots.map((r) => r.currentTaskId)).toEqual([null, "t1"]);
  });

  test("a COMPLETED Task is never re-projected", async () => {
    const task = { id: "t1", taskId: "T", status: "COMPLETED", robotId: "row-a" };
    const robots = [{ id: "row-b", robotCode: "B", currentTaskId: null }];
    const out = await projection.projectAcceptedAssignment(store(task, robots), { legRowId: "leg-1", robotCode: "B" });
    expect(out).toMatchObject({ projected: false, reason: "TASK_NOT_PENDING" });
    expect(task.robotId).toBe("row-a");
  });
});

describe("a completion verified before custody was released is settled at the release", () => {
  const settlement = require("../../src/engine/lifecycle/settlement");
  const STORE = new Date("2026-09-23T10:00:00.000Z");

  function prismaFor({ evidence }) {
    const commitment = { commitmentId: "c-9", agentId: "agent-row-1", legId: "leg-row-9", fence: 4n, releasedAt: null, version: 1 };
    const leg = { id: "leg-row-9", legId: "L9", state: "AT_DROP", version: 6, custodyState: "HELD" };
    const tx = {
      $queryRawUnsafe: async () => [{ now: STORE }],
      commitment: { findUnique: async () => commitment },
      leg: { findUnique: async () => leg },
      payloadManifest: { findMany: async () => [] },
    };
    return {
      agent: { findUnique: async () => ({ id: "agent-row-1" }) },
      commitment: { findUnique: async () => commitment },
      verificationEvidence: { findFirst: async () => evidence },
      $transaction: async (fn) => fn(tx),
    };
  }

  test("RELEASED applied + SUFFICIENT evidence for this commitment → settle runs", async () => {
    jest.spyOn(transitions, "apply").mockResolvedValue({ outcome: transitions.OUTCOME.APPLIED, from: "AT_DROP", to: "RELEASED" });
    const settle = jest.spyOn(settlement, "settle").mockResolvedValue({ outcome: "SETTLED" });
    const out = await legProgress.onCustodyReport({
      prisma: prismaFor({ evidence: { evidenceId: "L9-c-9-1", outcome: "SUFFICIENT" } }),
      robotId: "SIM-1",
      report: { commitmentId: "c-9", fence: "4", kind: "RELEASED" },
      snapshot,
    });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0][1].verification.outcome).toBe("SUFFICIENT");
    expect(out.settlement).toEqual({ outcome: "SETTLED" });
  });

  test("no verified completion yet → nothing is settled (TASK_COMPLETE will do it)", async () => {
    jest.spyOn(transitions, "apply").mockResolvedValue({ outcome: transitions.OUTCOME.APPLIED, from: "AT_DROP", to: "RELEASED" });
    const settle = jest.spyOn(settlement, "settle");
    const out = await legProgress.onCustodyReport({
      prisma: prismaFor({ evidence: null }),
      robotId: "SIM-1",
      report: { commitmentId: "c-9", fence: "4", kind: "RELEASED" },
      snapshot,
    });
    expect(settle).not.toHaveBeenCalled();
    expect(out.settlement).toBeUndefined();
  });
});

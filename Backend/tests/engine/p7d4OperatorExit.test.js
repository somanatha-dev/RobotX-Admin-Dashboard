"use strict";

/**
 * P7-D4 Part 3 (Phase 15, 2026-10-10) — the operator's exit from an exhausted reassignment chain.
 *
 * §4.7 freezes an exhausted chain in REASSIGNING "for operator decision", and nothing could
 * leave that state: the chain bound refuses another reassignment, the orphan scan leaves the Leg
 * to its ESCALATE timer, and the timer escalates in place for ever (P7-D2 on LOCAL: two Tasks
 * "Executing" on units that carried nothing). The exit is §4.6 step 3's first case — custody NONE
 * and no HARD commitment: CANCELLED immediately — through the existing operator route
 * `POST /api/tasks/:taskId/cancel` and its engine-owned, audited, all-or-nothing transaction.
 *
 * The stranding is produced by the real §4.7 path (`reassignment.reassign`, exhausted), and the
 * exit runs through the real service, engine function and §4.4 row on the transactional store
 * model (conditional writes, `FOR UPDATE` as a real mutex, overlays committed atomically).
 *
 * MOCKED BOUNDARIES: the store (`helpers/commitmentStore`, no database); the legacy `Robot` table
 * (`withRobots`, staged per transaction and discarded on rollback, as the store's own tables
 * are); the audit stream (an in-memory sink, as in `queuedTaskCancellation.test.js`); and, for
 * the controller tests, `getPrisma`, the dashboard `io` and the KV.
 */

jest.mock("../../src/db/prisma");

const { getPrisma } = require("../../src/db/prisma");
const { createCommitmentStore } = require("./helpers/commitmentStore");
const fixtures = require("./helpers/dispatchFixture");
const reassignment = require("../../src/engine/lifecycle/reassignment");
const cancellation = require("../../src/engine/lifecycle/cancellation");
const transitions = require("../../src/engine/lifecycle/transitions");
const outbox = require("../../src/engine/dispatch/outbox");
const taskCancellation = require("../../src/services/taskCancellation.service");
const { cancelTask } = require("../../src/controllers/tasks.controller");
const tasksRouter = require("../../src/routes/tasks.routes");
const { authUser } = require("../../src/middlewares/auth_middleware");
const { waitFor } = require("../helpers/waitFor");

const NOW = new Date("2026-10-10T06:00:00.000Z");
const MAX = 3; // recover.max_reassignments_per_leg, as LOCAL resolves it
const TASK_ROW = "task-row-254";
const TASK_ID = "TSK-1790958521622-254";
const OTHER_TASK_ROW = "task-row-other";
const ROBOT_ROW = "robot-row-A";
const OTHER_ROBOT_ROW = "robot-row-B";

// ── world ────────────────────────────────────────────────────────────────────

/** The legacy Robot table, staged per transaction exactly like the store's overlays. */
function withRobots(store, robots) {
  const rows = new Map(robots.map((r) => [r.id, { status: "IDLE", currentTaskId: null, ...r }]));
  const tableOf = (map) => ({
    async findUnique({ where }) {
      const row = map.get(where.id);
      return row ? { ...row } : null;
    },
    async updateMany({ where, data }) {
      const row = map.get(where.id);
      if (!row) return { count: 0 };
      if (Object.prototype.hasOwnProperty.call(where, "currentTaskId") && row.currentTaskId !== where.currentTaskId) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  });
  const client = {
    ...store.client,
    robot: tableOf(rows),
    async $transaction(fn) {
      const staged = new Map([...rows].map(([id, row]) => [id, { ...row }]));
      const result = await store.client.$transaction((tx) => fn({ ...tx, robot: tableOf(staged) }));
      rows.clear();
      for (const [id, row] of staged) rows.set(id, row);
      return result;
    },
  };
  return { client, robots: rows };
}

function auditSink(options) {
  const events = [];
  return {
    events,
    audit: async (_tx, event) => {
      if (options && options.fail) return { ok: false };
      events.push(event);
      return { ok: true, event };
    },
  };
}

/**
 * A Leg stranded exactly as on LOCAL: three earlier reassignments, a live commitment C1 whose
 * lease lapsed, then the real exhausted `reassign` — Leg REASSIGNING, C1 released, RECALL written
 * — and the RECALL FAILED after the simulator refused it. Task ASSIGNED, robot bound.
 */
async function strandedLeg(options) {
  const o = options || {};
  const fixture = fixtures.seed({ legs: 2, capacity: 1, now: NOW });
  fixture.legs[0].state = "EN_ROUTE_PICKUP";
  fixture.agent.fenceCounter = 42n;
  const released = o.history === undefined ? MAX : o.history;
  const history = Array.from({ length: released }, (_, i) => ({
    ...fixtures.commitmentRow(fixture, { commitmentId: `old-${i + 1}`, fence: BigInt(30 + i), slot: i + 1 }),
    releasedAt: new Date(NOW.getTime() - (10 - i) * 60_000),
  }));
  const store = createCommitmentStore({
    agent: [fixture.agent],
    leg: fixture.legs,
    shardLeadership: [fixture.leadership],
    commitment: [...history, fixtures.commitmentRow(fixture, { commitmentId: "C1", fence: 42n })],
    outbox: [],
    agentDedupState: [],
    agentFenceAudit: [],
    observation: [],
    timer: [],
    workQueue: [],
    mission: fixture.legs.map((leg) => ({ id: leg.missionId, missionId: `MSN-${leg.missionId}` })),
    task: [
      { id: TASK_ROW, taskId: TASK_ID, status: "ASSIGNED", robotId: ROBOT_ROW, version: 0, missionId: fixture.legs[0].missionId },
      { id: OTHER_TASK_ROW, taskId: "TSK-OTHER", status: "ASSIGNED", robotId: OTHER_ROBOT_ROW, version: 0, missionId: fixture.legs[1].missionId },
    ],
    now: NOW,
  });
  const world = withRobots(store, [
    { id: ROBOT_ROW, robotId: "SIM-A", currentTaskId: TASK_ROW },
    { id: OTHER_ROBOT_ROW, robotId: "SIM-B", currentTaskId: OTHER_TASK_ROW },
  ]);

  const leg = await store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } });
  const agent = await store.client.agent.findUnique({ where: { id: fixtures.AGENT_ROW_ID } });
  const commitment = await store.client.commitment.findUnique({ where: { commitmentId: "C1" } });
  const withdrawn = await store.client.$transaction((tx) =>
    reassignment.reassign(tx, {
      leg,
      agent,
      commitment,
      legCommitments: store.rows("commitment").filter((row) => row.legId === leg.id),
      storeTime: store.now(),
      trigger: reassignment.TRIGGER.LEASE_EXPIRY,
      maxReassignmentsPerLeg: MAX,
      incumbentCooloffSeconds: 300,
      reassignBudgetSeconds: 300,
      maxDeliveryDelaySeconds: 30,
      signingKey: fixtures.TEST_SIGNING_KEY,
    }),
  );
  const recallState = o.recallState === undefined ? "FAILED" : o.recallState;
  if (recallState) {
    await outbox.settleRow(store.client, { id: withdrawn.recallOutboxId, state: recallState, storeTime: store.now(), detail: "HELD_FOR_ORDER" });
  }
  return { fixture, store, ...world, withdrawn };
}

function exit(world, sink, overrides) {
  return taskCancellation.cancelQueuedTask(world.client, {
    taskRowId: TASK_ROW,
    taskId: TASK_ID,
    missionIds: [world.fixture.legs[0].missionId],
    actor: { id: "operator-1", role: "SUPER_ADMIN" },
    authorised: true,
    storeTime: NOW,
    reason: "OPERATOR_EXIT_EXHAUSTED_CHAIN",
    maxReassignmentsPerLeg: MAX,
    audit: sink.audit,
    ...(overrides || {}),
  });
}

/** Everything the exit could write, for "nothing was changed" comparisons. */
function snapshot(world) {
  return {
    leg: world.store.rows("leg").map((r) => ({ ...r })),
    task: world.store.rows("task").map((r) => ({ ...r })),
    commitment: world.store.rows("commitment").map((r) => ({ ...r })),
    outbox: world.store.rows("outbox").map((r) => ({ ...r })),
    timer: world.store.rows("timer").map((r) => ({ id: r.id, timerState: r.timerState })),
    agent: world.store.rows("agent").map((r) => ({ ...r })),
    robots: [...world.robots.values()].map((r) => ({ ...r })),
  };
}

async function expectRefused(world, sink, overrides, { code, status }) {
  const before = snapshot(world);
  await expect(exit(world, sink, overrides)).rejects.toMatchObject({ code, status });
  expect(snapshot(world)).toEqual(before);
  expect(sink.events).toEqual([]);
}

const legRow = (world) => world.store.rows("leg").find((r) => r.id === fixtures.LEG_ROW_ID);
const taskRow = (world, id = TASK_ROW) => world.store.rows("task").find((r) => r.id === id);

// ── 1. the successful exit ───────────────────────────────────────────────────

describe("P7-D4 Part 3 — an eligible exhausted Leg is resolved by the operator", () => {
  test("REASSIGNING (chain exhausted), no live commitment, custody NONE → Leg and Task CANCELLED, robot unbound, one audit event", async () => {
    const world = await strandedLeg();
    expect(legRow(world)).toMatchObject({ state: "REASSIGNING", custodyState: "NONE" });
    expect(reassignment.chainExceedsBound(world.store.rows("commitment").filter((c) => c.legId === fixtures.LEG_ROW_ID), MAX)).toBe(true);
    const before = snapshot(world);
    const legVersion = legRow(world).version;
    const sink = auditSink();

    const out = await exit(world, sink);

    expect(out).toMatchObject({ outcome: "CANCELLED", operatorExit: "EXHAUSTED_REASSIGNMENT", releasedRobotId: "SIM-A", robotUnbound: true });
    expect(out.legs).toEqual([
      expect.objectContaining({ legId: fixtures.LEG_BUSINESS_ID, from: "REASSIGNING", to: "CANCELLED", exit: "EXHAUSTED_REASSIGNMENT", chainLength: MAX + 1 }),
    ]);
    // The Leg: step 1's flag, then the §4.6 row — two CAS writes.
    expect(legRow(world)).toMatchObject({ state: "CANCELLED", version: legVersion + 2, cancelRequestedAt: NOW, cancelReason: "OPERATOR_EXIT_EXHAUSTED_CHAIN" });
    // Its REASSIGNING (ESCALATE) timer is cancelled on exit (§4.5) — it stops escalating.
    const legTimers = world.store.rows("timer").filter((t) => t.entityId === fixtures.LEG_ROW_ID);
    expect(legTimers.filter((t) => t.timerState === "PENDING")).toEqual([]);
    // The Task view stops showing execution; the robot stops carrying it. Not COMPLETED.
    expect(taskRow(world)).toMatchObject({ status: "CANCELLED", version: 1 });
    expect(world.robots.get(ROBOT_ROW).currentTaskId).toBeNull();
    // The authority is otherwise untouched: no fence, epoch, commitment or outbox write, no ACK invented.
    expect(world.store.rows("commitment")).toEqual(before.commitment);
    expect(world.store.rows("agent")).toEqual(before.agent);
    expect(world.store.rows("outbox")).toEqual(before.outbox);
    expect(world.store.rows("outbox").filter((r) => r.state === "ACKED")).toEqual([]);
    // Nothing else moved.
    expect(taskRow(world, OTHER_TASK_ROW)).toEqual(before.task.find((t) => t.id === OTHER_TASK_ROW));
    expect(world.store.rows("leg").find((r) => r.id !== fixtures.LEG_ROW_ID)).toEqual(before.leg.find((r) => r.id !== fixtures.LEG_ROW_ID));
    expect(world.robots.get(OTHER_ROBOT_ROW).currentTaskId).toBe(OTHER_TASK_ROW);
    // Audit evidence, written in the same transaction.
    expect(sink.events).toEqual([
      expect.objectContaining({
        eventType: "CANCELLATION",
        actorId: "operator-1",
        actorRole: "SUPER_ADMIN",
        subjectType: "TASK",
        subjectId: TASK_ID,
        reason: "OPERATOR_EXIT_EXHAUSTED_CHAIN",
        payload: expect.objectContaining({
          resolution: "CANCELLED_IMMEDIATELY",
          taskStatusFrom: "ASSIGNED",
          legs: [{ legId: fixtures.LEG_BUSINESS_ID, from: "REASSIGNING", to: "CANCELLED" }],
          operatorExit: "EXHAUSTED_REASSIGNMENT",
          chainLengths: [{ legId: fixtures.LEG_BUSINESS_ID, chainLength: MAX + 1 }],
          taskRobotRowId: ROBOT_ROW,
          robotUnbound: true,
        }),
      }),
    ]);
  });

  test("after a confirmed reset (RECALL SUPPRESSED, Task already released to PENDING by Part 2) the exit still resolves it", async () => {
    const world = await strandedLeg({ recallState: "SUPPRESSED" });
    await world.store.client.task.updateMany({ where: { id: TASK_ROW }, data: { status: "PENDING", robotId: null } });
    world.robots.get(ROBOT_ROW).currentTaskId = null;
    const sink = auditSink();

    const out = await exit(world, sink);
    expect(out).toMatchObject({ outcome: "CANCELLED", operatorExit: "EXHAUSTED_REASSIGNMENT", releasedRobotId: null, robotUnbound: false });
    expect(legRow(world).state).toBe("CANCELLED");
    expect(taskRow(world)).toMatchObject({ status: "CANCELLED", robotId: null });
  });
});

// ── 2–4. rejections ──────────────────────────────────────────────────────────

describe("P7-D4 Part 3 — every unproven precondition refuses, writing nothing", () => {
  test("a live commitment on the Leg (a newer grant) → LIVE_COMMITMENT_EXISTS", async () => {
    const world = await strandedLeg();
    await world.store.client.commitment.create({
      data: { ...fixtures.commitmentRow(world.fixture, { commitmentId: "C-NEWER", fence: 43n, slot: 0 }), grantedAt: NOW },
    });
    await expectRefused(world, auditSink(), {}, { code: "LIVE_COMMITMENT_EXISTS", status: 409 });
  });

  test.each([["HELD"], ["PENDING_TRANSFER"], ["DISPUTED"], [null], [undefined], ["SOMETHING_UNKNOWN"]])(
    "Leg custody %s → CUSTODY_NOT_NONE (unknown or missing is not NONE)",
    async (state) => {
      const world = await strandedLeg();
      await world.store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { custodyState: state } });
      await expectRefused(world, auditSink(), {}, { code: "CUSTODY_NOT_NONE", status: 409 });
    },
  );

  test.each([["HELD"], ["PENDING_TRANSFER"], [null], ["SOMETHING_UNKNOWN"]])(
    "a released commitment of the Leg with custody %s → COMMITMENT_CUSTODY_NOT_NONE",
    async (state) => {
      const world = await strandedLeg();
      await world.store.client.commitment.update({ where: { commitmentId: "C1" }, data: { custodyState: state } });
      await expectRefused(world, auditSink(), {}, { code: "COMMITMENT_CUSTODY_NOT_NONE", status: 409 });
    },
  );

  test.each([["HELD"], ["PENDING_TRANSFER"]])(
    "the incumbent holds a live commitment on another Leg with custody %s → AGENT_CUSTODY_UNRESOLVED",
    async (state) => {
      const world = await strandedLeg();
      await world.store.client.commitment.create({
        data: { ...fixtures.commitmentRow(world.fixture, { commitmentId: "C-OTHER", fence: 44n, legIndex: 1, custodyState: state, slot: 0 }) },
      });
      await expectRefused(world, auditSink(), {}, { code: "AGENT_CUSTODY_UNRESOLVED", status: 409 });
    },
  );

  test("REASSIGNING but the chain is NOT exhausted (the orphan scan's to requeue) → CHAIN_NOT_EXHAUSTED", async () => {
    const world = await strandedLeg({ history: 0 });
    expect(legRow(world).state).toBe("REASSIGNING");
    await expectRefused(world, auditSink(), {}, { code: "CHAIN_NOT_EXHAUSTED", status: 409 });
  });

  test.each([[null], [undefined], [-1], [2.5], ["3"]])("an unresolved chain bound (%s) → 503 CHAIN_BOUND_UNRESOLVED", async (bound) => {
    const world = await strandedLeg();
    await expectRefused(world, auditSink(), { maxReassignmentsPerLeg: bound }, { code: "CHAIN_BOUND_UNRESOLVED", status: 503 });
  });

  test("the RECALL is still in flight → COMMAND_IN_FLIGHT (wait for it to settle, fail or expire)", async () => {
    const world = await strandedLeg({ recallState: null });
    expect(world.store.rows("outbox").find((r) => r.command === "RECALL").state).toBe("PENDING");
    await expectRefused(world, auditSink(), {}, { code: "COMMAND_IN_FLIGHT", status: 409 });
  });

  test("a Leg back in execution (re-accepted) with a robot → refused as before (ENGINE_CANCELLATION_UNAVAILABLE)", async () => {
    const world = await strandedLeg();
    await world.store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { state: "ACCEPTED" } });
    await expectRefused(world, auditSink(), {}, { code: "ENGINE_CANCELLATION_UNAVAILABLE", status: 409 });
  });

  test("a custodial-purpose Leg (RECOVERY) is not requester-cancellable → refused", async () => {
    const world = await strandedLeg();
    await world.store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { purpose: "RECOVERY" } });
    await expectRefused(world, auditSink(), {}, { code: "CUSTODIAL_PURPOSE_NOT_REQUESTER_CANCELLABLE", status: 409 });
  });

  test("an audit event that cannot be written rolls the whole exit back", async () => {
    const world = await strandedLeg();
    const before = snapshot(world);
    await expect(exit(world, auditSink({ fail: true }))).rejects.toMatchObject({ code: "AUDIT_NOT_RECORDED", status: 503 });
    expect(snapshot(world)).toEqual(before);
  });
});

// ── 5. authorization ─────────────────────────────────────────────────────────

describe("P7-D4 Part 3 — only an authenticated, elevated operator", () => {
  test("an unauthorised requester → 403 NOT_AUTHORISED, nothing written", async () => {
    const world = await strandedLeg();
    await expectRefused(world, auditSink(), { authorised: false }, { code: "NOT_AUTHORISED", status: 403 });
  });

  test("the route sits behind authUser (every request on the tasks router is authenticated first)", () => {
    expect(tasksRouter.stack[0].handle).toBe(authUser);
    const cancelLayer = tasksRouter.stack.find((layer) => layer.route && layer.route.path === "/:taskId/cancel");
    expect(cancelLayer.route.methods).toEqual({ post: true });
  });
});

// ── 6. idempotency and concurrency ───────────────────────────────────────────

describe("P7-D4 Part 3 — retries and concurrent duplicates are harmless", () => {
  test("a retry after success is answered ALREADY_TERMINAL: no second write, no second audit event", async () => {
    const world = await strandedLeg();
    const sink = auditSink();
    await exit(world, sink);
    const after = snapshot(world);

    const again = await exit(world, sink);
    expect(again.outcome).toBe("ALREADY_TERMINAL");
    expect(snapshot(world)).toEqual(after);
    expect(sink.events).toHaveLength(1);
  });

  test("two concurrent requests serialise on the Task lock: one cancels, the other finds it terminal", async () => {
    const world = await strandedLeg();
    const sink = auditSink();
    const legVersion = legRow(world).version;

    const outcomes = await Promise.all([exit(world, sink), exit(world, sink)]);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(["ALREADY_TERMINAL", "CANCELLED"]);
    expect(sink.events).toHaveLength(1);
    expect(legRow(world)).toMatchObject({ state: "CANCELLED", version: legVersion + 2 });
    expect(taskRow(world).version).toBe(1);
  });

  test("a writer holding a stale Leg row loses its CAS after the exit (LOST_RACE), writing nothing", async () => {
    const world = await strandedLeg();
    const stale = { ...legRow(world) };
    await exit(world, auditSink());
    const after = snapshot(world);
    const late = await world.store.client.$transaction((tx) =>
      cancellation.cancelExhaustedReassigningLeg(tx, { leg: stale, storeTime: NOW, authorised: true, maxReassignmentsPerLeg: MAX }),
    );
    expect(late.outcome).toBe("LOST_RACE");
    expect(snapshot(world)).toEqual(after);
  });
});

// ── 7. never undo a newer grant or another Task ─────────────────────────────

describe("P7-D4 Part 3 — a newer grant or projection is never undone", () => {
  test("a Task projection that lands mid-transaction (robot moved, version unchanged) makes the exit lose: TASK_MOVED, nothing written", async () => {
    const world = await strandedLeg();
    const sink = auditSink();
    const interfering = {
      ...world,
      client: {
        ...world.client,
        $transaction: (fn) =>
          world.client.$transaction((tx) =>
            fn({
              ...tx,
              task: {
                ...tx.task,
                // `projectAcceptedAssignment` commits a re-projection just before the exit's
                // conditional write — it moves `robotId` and leaves `version` alone.
                updateMany: async (args) => {
                  await world.store.client.task.updateMany({ where: { id: TASK_ROW }, data: { robotId: OTHER_ROBOT_ROW } });
                  return tx.task.updateMany(args);
                },
              },
            }),
          ),
      },
    };
    await expect(exit(interfering, sink)).rejects.toMatchObject({ code: "TASK_MOVED", status: 409 });
    expect(legRow(world).state).toBe("REASSIGNING");
    expect(taskRow(world)).toMatchObject({ status: "ASSIGNED", robotId: OTHER_ROBOT_ROW, version: 0 });
    expect(sink.events).toEqual([]);
  });

  test("a robot already rebound to another Task keeps that binding", async () => {
    const world = await strandedLeg();
    world.robots.get(ROBOT_ROW).currentTaskId = "task-row-newer";
    const out = await exit(world, auditSink());
    expect(out).toMatchObject({ outcome: "CANCELLED", robotUnbound: false });
    expect(world.robots.get(ROBOT_ROW).currentTaskId).toBe("task-row-newer");
  });
});

// ── 8. the operator route and the dashboard ─────────────────────────────────

describe("P7-D4 Part 3 — through POST /api/tasks/:taskId/cancel", () => {
  /**
   * The controller's legacy-schema reads, resolved over the store (task → mission → leg), and the
   * `AuditEvent` table the real hash-chained `auditStream.append` writes — staged per
   * transaction and kept only on commit, like every other table here.
   */
  function controllerPrisma(world) {
    const missionOf = (taskRowId) => world.store.rows("task").find((t) => t.id === taskRowId).missionId;
    world.auditEvents = world.auditEvents || [];
    const auditTable = (rows) => ({
      async findFirst({ where }) {
        const stream = rows.filter((e) => e.streamId === where.streamId).sort((a, b) => Number(b.sequence) - Number(a.sequence));
        return stream[0] || null;
      },
      async create({ data }) {
        rows.push({ ...data });
        return { ...data };
      },
    });
    return {
      ...world.client,
      async $transaction(fn) {
        const staged = [...world.auditEvents];
        const result = await world.client.$transaction((tx) => fn({ ...tx, auditEvent: auditTable(staged) }));
        world.auditEvents = staged;
        return result;
      },
      leg: {
        ...world.client.leg,
        findFirst: async ({ where }) => {
          const missionId = missionOf(where.mission.tasks.some.id);
          return world.store.rows("leg").find((l) => l.missionId === missionId) || null;
        },
      },
      mission: { findMany: async ({ where }) => [{ id: missionOf(where.tasks.some.id) }] },
    };
  }
  function makeRes() {
    const res = { body: null, statusCode: 200 };
    res.status = jest.fn((c) => ((res.statusCode = c), res));
    res.json = jest.fn((b) => ((res.body = b), res));
    return res;
  }
  function makeIo() {
    const emitted = [];
    return { emitted, to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };
  }
  function makeKv() {
    const values = new Map();
    return { values, del: async (k) => values.delete(k), set: async (k, v) => values.set(k, v), get: async (k) => values.get(k) ?? null };
  }
  async function call(world, { role = "SUPER_ADMIN", config = new Map([["recover.max_reassignments_per_leg", MAX]]) } = {}) {
    getPrisma.mockReturnValue(controllerPrisma(world));
    const io = makeIo();
    const kv = makeKv();
    await kv.set(`taskPath:${TASK_ID}`, "{}");
    await kv.set("robotTaskState:SIM-A", "{}");
    const res = makeRes();
    cancelTask(
      { params: { taskId: TASK_ID }, body: { reason: "operator exit" }, user: { id: "operator-1", role }, app: { locals: { io, kv, config: { values: config } } } },
      res,
      (e) => {
        throw e;
      },
    );
    await waitFor(() => res.json.mock.calls.length > 0);
    return { res, io, kv };
  }

  test("an elevated operator resolves it: 200 with an explicit outcome, the dashboard is told, the unit's route caches are cleared", async () => {
    const world = await strandedLeg();
    const { res, io, kv } = await call(world);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      task: expect.objectContaining({ taskId: TASK_ID, status: "CANCELLED" }),
      cancellation: { resolution: "CANCELLED_IMMEDIATELY", operatorExit: "EXHAUSTED_REASSIGNMENT", releasedRobotId: "SIM-A", robotUnbound: true },
    });
    expect(io.emitted).toEqual([
      { room: "dashboard", event: "TASK_UPDATED", payload: { taskId: TASK_ID, status: "CANCELLED", robotId: null, releasedRobotId: "SIM-A", timestamp: expect.any(Number) } },
    ]);
    expect(kv.values.has(`taskPath:${TASK_ID}`)).toBe(false);
    expect(kv.values.has("robotTaskState:SIM-A")).toBe(false);
    expect(legRow(world).state).toBe("CANCELLED");
    // The real hash-chained audit event, committed with the cancellation.
    expect(world.auditEvents).toEqual([
      expect.objectContaining({
        eventType: "CANCELLATION",
        actorId: "operator-1",
        subjectId: TASK_ID,
        reason: "operator exit",
        hash: expect.any(String),
        payload: expect.objectContaining({ operatorExit: "EXHAUSTED_REASSIGNMENT", robotUnbound: true }),
      }),
    ]);
  });

  test("a non-elevated role → 403 NOT_AUTHORISED with nothing written and nothing emitted", async () => {
    const world = await strandedLeg();
    const before = snapshot(world);
    const { res, io } = await call(world, { role: "OPERATOR" });
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ ok: false, code: "NOT_AUTHORISED" });
    expect(snapshot(world)).toEqual(before);
    expect(io.emitted).toEqual([]);
  });

  test("no chain bound in the pinned configuration → 503, nothing written", async () => {
    const world = await strandedLeg();
    const before = snapshot(world);
    const { res } = await call(world, { config: new Map() });
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ ok: false, code: "CHAIN_BOUND_UNRESOLVED" });
    expect(snapshot(world)).toEqual(before);
  });

  test("a repeated request after success is a 200 no-op", async () => {
    const world = await strandedLeg();
    await call(world);
    const after = snapshot(world);
    const { res, io } = await call(world);
    expect(res.statusCode).toBe(200);
    expect(res.body.task.status).toBe("CANCELLED");
    expect(io.emitted).toEqual([]);
    expect(snapshot(world)).toEqual(after);
  });
});

// ── 9. the table itself, and what did not change ────────────────────────────

describe("P7-D4 Part 3 — the §4.6 row and the unchanged behaviour around it", () => {
  test("CANCELLATION_RESOLVED reaches CANCELLED from QUEUED and REASSIGNING only; REASSIGNING's expiry still escalates in place", () => {
    expect(transitions.find("REASSIGNING", transitions.EVENT.CANCELLATION_RESOLVED)).toMatchObject({ to: "CANCELLED", source: transitions.SECTION_4_6_SOURCED });
    expect(transitions.find("QUEUED", transitions.EVENT.CANCELLATION_RESOLVED)).toMatchObject({ to: "CANCELLED" });
    for (const state of ["PLANNED", "OFFERED", "ACCEPTED", "EN_ROUTE_PICKUP", "LOADED", "ABORTING", "STRANDED_SAFE"]) {
      expect({ state, row: transitions.find(state, transitions.EVENT.CANCELLATION_RESOLVED) }).toEqual({ state, row: null });
    }
    expect(transitions.statesWhoseExpiryHasNoDedicatedRow()).toEqual(["REASSIGNING"]);
    expect(transitions.statesWithoutExit()).toEqual([]);
  });

  test("the row's guard still demands the flag, custody NONE and positive no-commitment evidence from REASSIGNING", () => {
    const evaluate = transitions.GUARD_EVALUATORS[transitions.GUARD.CANCEL_REQUESTED_NO_COMMITMENT_NO_CUSTODY];
    const leg = { state: "REASSIGNING", custodyState: "NONE", cancelRequestedAt: NOW };
    expect(evaluate({ leg: { ...leg, cancelRequestedAt: null }, noHardCommitment: true }).ok).toBe(false);
    expect(evaluate({ leg: { ...leg, custodyState: "PENDING_TRANSFER" }, noHardCommitment: true }).ok).toBe(false);
    expect(evaluate({ leg }).ok).toBe(false);
    expect(evaluate({ leg, noHardCommitment: true }).ok).toBe(true);
  });

  test("the exhausted reassignment itself is unchanged: SUSPENDED hand-off, RECALL at an advanced fence, no requeue", async () => {
    const world = await strandedLeg({ recallState: null });
    expect(world.withdrawn).toMatchObject({ outcome: "SUSPENDED", reason: "MAX_REASSIGNMENTS_EXHAUSTED", requeued: false, recallFence: 43n });
    expect(legRow(world).state).toBe("REASSIGNING");
    expect(world.store.rows("commitment").find((c) => c.commitmentId === "C1").releasedAt).not.toBeNull();
  });
});

/**
 * P7 Step 8 (A3) — the legacy cancel guard.
 *
 * `POST /api/tasks/:taskId/cancel` on a task with no engine Leg (the legacy branch of
 * `tasks.controller.cancelTask`) released the robot with `status: "IDLE"` written
 * unconditionally. Over a PAUSED (an operator hold, P7-D1), ERROR, ISSUES or OFFLINE row that
 * raised the robot's health tier — MARGINAL/QUARANTINED → NOMINAL — so F9 admitted a unit
 * the server was holding out of service: §23.5's asymmetric rule, broken by the server's own
 * write rather than by a self-report.
 *
 * Invariant pinned here: a legacy cancel never changes the robot's health tier. It unbinds the
 * robot from the task; it puts the status back to IDLE only from a status already at IDLE's
 * tier (`taskCompletion.RELEASABLE_STATUSES`, F1's rule for a completion), evaluated in the
 * database at write time. Everything else the cancel does — Task CANCELLED, STOP to the
 * robot's room, Redis cleanup, TASK_UPDATED — is unchanged.
 *
 * The store below is strict: any model or method the legacy branch did not use before throws,
 * so a cancel that started writing audit, commitment or reservation rows would fail here.
 */

jest.mock("../../../src/db/prisma");

const { getPrisma } = require("../../../src/db/prisma");
const { cancelTask } = require("../../../src/controllers/tasks.controller");
const { RELEASABLE_STATUSES } = require("../../../src/services/taskCompletion.service");
const { HEALTH_TIER_BY_STATUS, createAgentFactsProvider } = require("../../../src/services/agentFacts.service");
const { displayedStatus } = require("../../../src/services/robotStatusPrecedence");
const f09 = require("../../../src/engine/feasibility/predicates/f09");
const { setRobotState, getRobotState } = require("../../../src/services/robotRegistry.service");
const { createTestKv } = require("../../helpers/testKv");
const { createFakeIo } = require("../../helpers/fakeSocket");
const { waitFor } = require("../../helpers/waitFor");

const TASK_ID = "TSK-A3";
const TASK_ROW = "db-task-a3";
const ROBOT_ROW = "db-robot-a3";
const ROBOT = "R-A3";

/** Properties Jest and `await` probe on any value; they are not model access. */
const PROBES = new Set(["then", "toJSON", "asymmetricMatch", "$$typeof", "nodeType", "constructor", "@@__IMMUTABLE_ITERABLE__@@"]);

function strict(name, target) {
  return new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key];
      if (typeof key === "symbol" || PROBES.has(key)) return undefined;
      throw new Error(`legacy cancel touched ${name}.${String(key)}, which it never used`);
    },
  });
}

function matches(row, where) {
  return Object.entries(where).every(([key, want]) => {
    if (want && typeof want === "object" && Array.isArray(want.in)) return want.in.includes(row[key]);
    if (want && typeof want === "object" && Array.isArray(want.notIn)) return !want.notIn.includes(row[key]);
    return row[key] === want;
  });
}

/**
 * One Task row and one Robot row. `afterRobotRead` runs once the transaction has read the
 * robot — a concurrent writer committing between that read and the release.
 */
function createStore({ robot, taskStatus = "ASSIGNED", taskRobotId = ROBOT_ROW, afterRobotRead } = {}) {
  const task = { id: TASK_ROW, taskId: TASK_ID, status: taskStatus, robotId: taskRobotId };
  const writes = [];

  const tx = strict("tx", {
    task: strict("tx.task", {
      update: jest.fn(async ({ where, data }) => {
        expect(where).toEqual({ taskId: TASK_ID });
        Object.assign(task, data);
        writes.push({ model: "task", data });
        return { ...task, robot: { robotId: ROBOT } };
      }),
    }),
    robot: strict("tx.robot", {
      findUnique: jest.fn(async ({ where }) => {
        const found = robot && where.id === robot.id ? { ...robot } : null;
        if (afterRobotRead) afterRobotRead(robot);
        return found;
      }),
      update: jest.fn(async ({ where, data }) => {
        if (!robot || !matches(robot, where)) throw new Error("Record to update not found.");
        Object.assign(robot, data);
        writes.push({ model: "robot", op: "update", data });
        return { ...robot };
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        if (!robot || !matches(robot, where)) return { count: 0 };
        Object.assign(robot, data);
        writes.push({ model: "robot", op: "updateMany", data });
        return { count: 1 };
      }),
    }),
  });

  // Outside the transaction the branch only reads the Task and asks for a Leg; a Robot write
  // here (no `robot` model) would be a release outside the cancel's transaction.
  const prisma = strict("prisma", {
    task: strict("prisma.task", {
      findUnique: jest.fn(async () => ({ id: task.id, status: task.status, robotId: task.robotId })),
    }),
    leg: strict("prisma.leg", { findFirst: jest.fn().mockResolvedValue(null) }),
    $transaction: jest.fn(async (fn) => fn(tx)),
  });

  return { prisma, tx, task, robot, writes };
}

function makeRes() {
  const res = { body: null, statusCode: 200 };
  res.status = jest.fn((c) => {
    res.statusCode = c;
    return res;
  });
  res.json = jest.fn((b) => {
    res.body = b;
    return res;
  });
  return res;
}

function robotRow(status, extra = {}) {
  return { id: ROBOT_ROW, robotId: ROBOT, currentTaskId: TASK_ROW, status, statusBeforeOffline: null, ...extra };
}

/** F9 for a mission that requires NOMINAL, from the tier `agentFacts` derives from `status`. */
function f9For(status) {
  return f09.evaluate({ agentSnapshot: { healthTier: HEALTH_TIER_BY_STATUS[status] ?? null }, mission: { requiredHealthTier: "NOMINAL" } })
    .outcome;
}

describe("P7 A3 — legacy cancel never raises the robot's health tier", () => {
  let kv;
  let io;

  beforeEach(async () => {
    ({ kv } = await createTestKv());
    io = createFakeIo();
    io.joinRoom(`robot:${ROBOT}`, { id: "sock-a3" });
  });

  async function cancel(store) {
    getPrisma.mockReturnValue(store.prisma);
    await setRobotState(kv, ROBOT, { assignedTaskId: TASK_ID });
    await kv.set(`taskPath:${TASK_ID}`, JSON.stringify({ toPickup: [], toDrop: [] }), { ex: 86400 });
    await kv.set(`task:${TASK_ID}`, "{}", { ex: 86400 });
    await kv.set(`robotTaskState:${ROBOT}`, JSON.stringify({ taskId: TASK_ID }), { ex: 86400 });
    await kv.set(`robotTask:${ROBOT}`, TASK_ID, { ex: 86400 });
    const res = makeRes();
    const next = jest.fn();
    cancelTask({ params: { taskId: TASK_ID }, body: {}, app: { locals: { kv, io } } }, res, next);
    await waitFor(() => res.json.mock.calls.length > 0 || next.mock.calls.length > 0);
    if (next.mock.calls.length > 0) throw next.mock.calls[0][0];
    return res;
  }

  /** Everything the legacy cancel did before A3, for a robot it released. */
  async function expectEstablishedCancellation(store, res) {
    expect(store.task.status).toBe("CANCELLED");
    expect(store.robot.currentTaskId).toBeNull();
    expect(res.body).toMatchObject({ ok: true, task: { taskId: TASK_ID, status: "CANCELLED" } });
    await waitFor(() => io.emittedTo(`robot:${ROBOT}`, "STOP").length > 0);
    expect(io.emittedTo(`robot:${ROBOT}`, "STOP")[0]).toMatchObject({ taskId: TASK_ID, reason: "TASK_CANCELLED" });
    await waitFor(async () => (await kv.get(`taskPath:${TASK_ID}`)) === null);
    expect(await kv.get(`task:${TASK_ID}`)).toBeNull();
    expect(await kv.get(`robotTaskState:${ROBOT}`)).toBeNull();
    expect(await kv.get(`robotTask:${ROBOT}`)).toBeNull();
    expect((await getRobotState(kv, ROBOT)).assignedTaskId).toBeNull();
    expect(io.emittedTo("dashboard", "TASK_UPDATED")).toEqual([
      expect.objectContaining({ taskId: TASK_ID, status: "CANCELLED", robotId: ROBOT }),
    ]);
  }

  test("the release rule is F1's completion rule: IDLE and ACTIVE only", () => {
    expect([...RELEASABLE_STATUSES]).toEqual(["IDLE", "ACTIVE"]);
    for (const status of RELEASABLE_STATUSES) expect(HEALTH_TIER_BY_STATUS[status]).toBe(HEALTH_TIER_BY_STATUS.IDLE);
  });

  describe.each([
    ["IDLE", "IDLE"],
    ["ACTIVE", "IDLE"],
  ])("ordinary case: %s → %s", (before, after) => {
    test("unbinds, releases to IDLE, and does everything a cancel did before", async () => {
      const store = createStore({ robot: robotRow(before) });
      const res = await cancel(store);
      expect(store.robot.status).toBe(after);
      expect(f9For(store.robot.status)).toBe(f9For(before));
      await expectEstablishedCancellation(store, res);
    });
  });

  describe.each([
    // P7-D1 — an operator STOP/PAUSE hold; also every pre-D1 row where CHARGING was stored as PAUSED.
    ["PAUSED", "MARGINAL"],
    ["ISSUES", "MARGINAL"],
    ["ERROR", "QUARANTINED"],
  ])("held case: %s (%s) is preserved", (status, tier) => {
    test("unbinds and stops the robot, but leaves the status — and F9's verdict — as it was", async () => {
      expect(HEALTH_TIER_BY_STATUS[status]).toBe(tier);
      // The defect: the old unconditional IDLE would have turned this VIOLATED into SATISFIED.
      expect(f9For(status)).toBe("VIOLATED");
      expect(f9For("IDLE")).toBe("SATISFIED");

      const store = createStore({ robot: robotRow(status) });
      const res = await cancel(store);
      expect(store.robot.status).toBe(status);
      expect(f9For(store.robot.status)).toBe("VIOLATED");
      expect(store.writes.filter((w) => w.model === "robot" && "status" in w.data)).toEqual([]);
      await expectEstablishedCancellation(store, res);
    });
  });

  describe.each([[null], ["IDLE"], ["ACTIVE"], ["PAUSED"], ["ERROR"], ["ISSUES"]])(
    "OFFLINE (statusBeforeOffline %s)",
    (statusBeforeOffline) => {
      test("stays OFFLINE with the status a reconnect restores untouched", async () => {
        const store = createStore({ robot: robotRow("OFFLINE", { statusBeforeOffline }) });
        const res = await cancel(store);
        expect(store.robot.status).toBe("OFFLINE");
        expect(store.robot.statusBeforeOffline).toBe(statusBeforeOffline);
        expect(f9For(store.robot.status)).toBe("VIOLATED");
        await expectEstablishedCancellation(store, res);
      });
    }
  );

  test("a status outside the release list is left alone — the list is an allowlist, not a denylist", async () => {
    const store = createStore({ robot: robotRow("MAINTENANCE") });
    const res = await cancel(store);
    expect(store.robot.status).toBe("MAINTENANCE");
    await expectEstablishedCancellation(store, res);
  });

  test("the release is conditional at write time: a fault committed after the robot was read is kept", async () => {
    const store = createStore({
      robot: robotRow("ACTIVE"),
      afterRobotRead: (row) => {
        row.status = "ERROR";
      },
    });
    const res = await cancel(store);
    expect(store.robot.status).toBe("ERROR");
    await expectEstablishedCancellation(store, res);
  });

  describe("charging (P7-D1: CHARGING is a live report, never a stored status)", () => {
    async function factsFor(row) {
      const factsPrisma = {
        observation: { findFirst: jest.fn().mockResolvedValue(null) },
        chargerReservation: { findMany: jest.fn().mockResolvedValue([]) },
        zone: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const agentFactsFor = createAgentFactsProvider({ prisma: factsPrisma, kv, physicalControlPlaneConnected: true });
      return agentFactsFor({ agent: { id: "agent-a3", regionId: "REGION-A3", robot: { ...row } } });
    }

    test.each([["IDLE"], ["ACTIVE"]])(
      "a %s row whose robot reports CHARGING: released to IDLE, still displayed CHARGING, still held by F18's self-report",
      async (status) => {
        const store = createStore({ robot: robotRow(status) });
        await setRobotState(kv, ROBOT, { status: "CHARGING" });
        const before = await factsFor(store.robot);

        const res = await cancel(store);

        expect(store.robot.status).toBe("IDLE");
        expect((await getRobotState(kv, ROBOT)).status).toBe("CHARGING");
        expect(displayedStatus(store.robot.status, "CHARGING")).toBe("CHARGING");
        const after = await factsFor(store.robot);
        expect(after.healthTier).toBe(before.healthTier);
        expect(after.reservations).toEqual([expect.objectContaining({ subsystem: "CHARGING", reservationId: "SELF_REPORTED_CHARGING", until: null })]);
        await expectEstablishedCancellation(store, res);
      }
    );

    test("a PAUSED row whose robot reports CHARGING (an operator STOP during a charge) keeps the hold", async () => {
      const store = createStore({ robot: robotRow("PAUSED") });
      await setRobotState(kv, ROBOT, { status: "CHARGING" });
      const before = await factsFor(store.robot);

      const res = await cancel(store);

      expect(store.robot.status).toBe("PAUSED");
      expect(displayedStatus(store.robot.status, "CHARGING")).toBe("PAUSED");
      const after = await factsFor(store.robot);
      expect(after.healthTier).toBe("MARGINAL");
      expect(after.healthTier).toBe(before.healthTier);
      await expectEstablishedCancellation(store, res);
    });
  });

  test("a robot that has moved on to another task is not touched at all, whatever its status", async () => {
    const store = createStore({ robot: robotRow("PAUSED", { currentTaskId: "db-other-task" }) });
    const res = await cancel(store);
    expect(store.task.status).toBe("CANCELLED");
    expect(store.robot).toMatchObject({ status: "PAUSED", currentTaskId: "db-other-task" });
    expect(store.writes.filter((w) => w.model === "robot")).toEqual([]);
    expect(io.emittedTo(`robot:${ROBOT}`, "STOP")).toEqual([]);
    expect(res.body.ok).toBe(true);
  });

  test("a task with no robot cancels without any robot read or write", async () => {
    const store = createStore({ robot: robotRow("IDLE"), taskRobotId: null });
    const res = await cancel(store);
    expect(store.task.status).toBe("CANCELLED");
    expect(store.tx.robot.findUnique).not.toHaveBeenCalled();
    expect(store.writes.filter((w) => w.model === "robot")).toEqual([]);
    expect(res.body.ok).toBe(true);
  });
});

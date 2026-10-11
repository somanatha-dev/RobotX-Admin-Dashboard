"use strict";

/**
 * P7-D4 Part 2 (Phase 15, 2026-10-10) — after a CONFIRMED dedup reset, the legacy Task view of
 * an assignment the engine already withdrew is released without the RECALL ACK that can now
 * never arrive.
 *
 * The stranding, as measured on LOCAL: the reassignment protocol (`reassignment.reassign` →
 * `withdrawIncumbent`) froze the Leg in REASSIGNING, advanced the commitment's fence, released
 * the commitment and wrote a RECALL — all in one transaction. The Task/Robot read model is
 * released only when the agent ACKs that RECALL (`command.handler.publishStandDown`). The
 * simulator had lost its dedup state, refused the RECALL (HELD_FOR_ORDER), and the Task stayed
 * "Executing" on a unit that carried nothing.
 *
 * Driven through the real pieces: `VirtualRobot`, the real grant/OFFER/ACK settlement, the real
 * `reassignment.reassign` (exhausted chain, as on LOCAL), the real
 * `assignmentProjection.projectAcceptedAssignment`, and the real AUTH-path function
 * `robot.handler.runDedupHandshake` with its read-model sink.
 *
 * MOCKED BOUNDARIES: the Commitment Store (`helpers/commitmentStore`); the legacy `Task`/`Robot`/
 * `Event` tables and the Leg→Mission→Task read (`withLegacyView` below — the store models no
 * legacy table), with the same conditional-update semantics and `Robot.currentTaskId`
 * uniqueness the schema has; the agent's flash; the socket; the dashboard `io`; the KV; and
 * `Date.now` (the simulator's generation is seeded from the wall clock).
 */

const VirtualRobot = require("../../src/simulation/VirtualRobot");
const commandSigning = require("../../src/engine/security/commandSigning");
const dedupHandshake = require("../../src/engine/dispatch/dedupHandshake");
const outbox = require("../../src/engine/dispatch/outbox");
const reassignment = require("../../src/engine/lifecycle/reassignment");
const availabilityIndex = require("../../src/engine/candidates/availabilityIndex");
const assignmentProjection = require("../../src/services/assignmentProjection.service");
const { envelopeOf } = require("../../src/workers/outbox.worker");
const { runDedupHandshake } = require("../../src/sockets/handlers/robot.handler");
const { acknowledgeOutboxRow, publishStandDown } = require("../../src/sockets/handlers/command.handler");

const fixtures = require("./helpers/dispatchFixture");

const ROBOT_ID = fixtures.AGENT_BUSINESS_ID; // "porter-07"
const OTHER_ROBOT_ID = "porter-08";
const ROBOT_ROW = "robot-row-A";
const OTHER_ROBOT_ROW = "robot-row-B";
const OTHER_AGENT_ROW = "33333333-3333-4333-8333-333333333333";
const T0 = 1_791_600_000_000;
const HOUR_MS = 3600_000;
const GATE = Object.freeze({ allowed: true, refusal: null, shardId: "default" });
const silent = { info() {}, warn() {}, error() {}, debug() {} };

const pinClock = (ms) => jest.spyOn(Date, "now").mockReturnValue(ms);
afterEach(() => jest.restoreAllMocks());

// ── doubles ──────────────────────────────────────────────────────────────────

function makeFlash() {
  const values = new Map();
  return {
    values,
    async get(key) {
      return values.has(key) ? values.get(key) : null;
    },
    async set(key, value) {
      values.set(key, value);
      return "OK";
    },
    async del(key) {
      values.delete(key);
    },
    wipe() {
      values.clear();
    },
  };
}

function makeSocket() {
  const emitted = [];
  return { emitted, connected: true, emit: (event, payload) => emitted.push({ event, payload }), on() {}, disconnect() {} };
}

function makeAgent(flash) {
  const socket = makeSocket();
  const robot = new VirtualRobot({ robotId: ROBOT_ID, lat: 0, lon: 0, logger: silent, kv: flash, commandSigningKey: fixtures.TEST_SIGNING_KEY });
  robot.socket = socket;
  robot.connected = true;
  return { robot, socket };
}

function makeIo() {
  const emitted = [];
  return { emitted, to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };
}

/**
 * The legacy read-model tables over the engine store. Writes are conditional exactly as
 * Prisma's `updateMany` is, and `Robot.currentTaskId` is unique as in the schema, so a
 * projection that would double-bind a robot fails here as it would at the database.
 */
function withLegacyView(store, { tasks, robots }) {
  const taskRows = new Map(tasks.map((row) => [row.id, { startedAt: null, robotId: null, ...row }]));
  const robotRows = new Map(robots.map((row) => [row.id, { status: "IDLE", currentTaskId: null, ...row }]));
  const events = [];
  const faults = { taskUpdates: 0 };

  const compare = (actual, condition) => {
    if (condition === null) return actual === null || actual === undefined;
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      return Object.entries(condition).every(([op, bound]) => {
        if (op === "in") return bound.includes(actual);
        if (op === "not") return actual !== bound;
        throw new Error(`legacy view does not implement "${op}"`);
      });
    }
    return actual === condition;
  };
  const matches = (row, where) =>
    Object.entries(where || {}).every(([key, value]) => (key === "OR" ? value.some((c) => matches(row, c)) : compare(row[key], value)));
  const tableOf = (rows, { onUpdate } = {}) => ({
    async findUnique({ where }) {
      const row = [...rows.values()].find((r) => matches(r, where));
      return row ? { ...row } : null;
    },
    async findMany({ where } = {}) {
      return [...rows.values()].filter((r) => matches(r, where)).map((r) => ({ ...r }));
    },
    async updateMany({ where, data }) {
      if (onUpdate) onUpdate(data);
      const hit = [...rows.values()].filter((r) => matches(r, where));
      if (rows === robotRows && data.currentTaskId) {
        const holder = [...robotRows.values()].find((r) => r.currentTaskId === data.currentTaskId && !hit.includes(r));
        if (holder || hit.length > 1) throw new Error("Unique constraint failed on Robot.currentTaskId");
      }
      for (const row of hit) Object.assign(row, data);
      return { count: hit.length };
    },
  });

  const legacy = {
    task: tableOf(taskRows, {
      onUpdate: () => {
        if (faults.taskUpdates > 0) {
          faults.taskUpdates -= 1;
          throw new Error("injected read-model write failure");
        }
      },
    }),
    robot: tableOf(robotRows),
    event: {
      async create({ data }) {
        const row = { id: `event-${events.length + 1}`, ...data };
        events.push(row);
        return { ...row };
      },
    },
  };
  // `assignmentProjection.taskForLeg`'s Leg → Mission → Task read.
  const legOf = (legClient) => ({
    ...legClient,
    async findUnique(args) {
      if (args && args.select && args.select.mission) {
        const leg = await legClient.findUnique({ where: args.where });
        if (!leg) return null;
        const linked = [...taskRows.values()].filter((t) => t.missionId === leg.missionId);
        return { mission: { tasks: linked.map((t) => ({ id: t.id, taskId: t.taskId, status: t.status, pickup: null, pickupLat: null, pickupLon: null, drop: null, dropLat: null, dropLon: null })) } };
      }
      return legClient.findUnique(args);
    },
  });
  const wrap = (base) => ({ ...base, ...legacy, leg: legOf(base.leg) });
  const client = { ...wrap(store.client), $transaction: (fn) => store.client.$transaction((tx) => fn(wrap(tx))) };
  return { client, tasks: taskRows, robots: robotRows, events, faults };
}

// ── the engine path, as production drives it ────────────────────────────────

/** The commitment write's effect: a fence drawn from the counter, a live HARD commitment. */
async function grant(store, fixture, { id, fence, legIndex = 0, custody = "NONE", agentRowId = fixtures.AGENT_ROW_ID }) {
  await store.client.$transaction(async (tx) => {
    await tx.agent.update({ where: { id: agentRowId }, data: { fenceCounter: fence } });
    await tx.commitment.create({
      data: { ...fixtures.commitmentRow(fixture, { commitmentId: id, fence, legIndex, custodyState: custody }), agentId: agentRowId },
    });
  });
}

/** The envelope the delivery arm sends, signed for the agent's business id. */
function envelopeFor(row) {
  const wire = { ...envelopeOf(row), agentId: ROBOT_ID };
  const signed = commandSigning.sign(
    {
      agentId: wire.agentId,
      command: wire.command,
      commandClass: wire.commandClass,
      fenceScope: wire.fenceScope,
      commitmentId: wire.commitmentId,
      fence: BigInt(wire.fence),
      authorityEpoch: null,
      fenceFloor: null,
      sequence: wire.sequence,
      notValidAfter: new Date(wire.notValidAfter),
      payload: wire.payload,
    },
    fixtures.TEST_SIGNING_KEY,
  );
  return { ...wire, signature: signed.signature || signed };
}

async function issueOffer(store, { commitmentId, fence, agentRowId = fixtures.AGENT_ROW_ID }) {
  const row = await store.client.$transaction((tx) =>
    outbox.enqueue(
      tx,
      outbox.buildRow({
        command: "OFFER",
        agentId: agentRowId,
        commitmentId,
        fence,
        sequence: 0,
        payload: { legId: fixtures.LEG_ROW_ID },
        notValidAfter: new Date(T0 + 24 * HOUR_MS),
        signature: "row-signature-unused-by-this-test",
      }),
    ),
  );
  return { row, envelope: envelopeFor(row) };
}

/** Deliver to the agent; settle the agent's own COMMAND_ACK through the real server path. */
async function deliver(store, agent, envelope) {
  const before = agent.socket.emitted.length;
  const outcome = await agent.robot._onMissionCommand(envelope.command, envelope);
  const acks = agent.socket.emitted.slice(before).filter((e) => e.event === "COMMAND_ACK");
  const settled = [];
  for (const ack of acks) {
    // eslint-disable-next-line no-await-in-loop
    settled.push(await acknowledgeOutboxRow(store.client, ROBOT_ID, ack.payload));
  }
  return { outcome, acks, settled };
}

/** §4.7 through the real `reassign` — exhausted by default, which is the LOCAL shape. */
async function withdraw(store, { commitmentId = "C1", exhausted = true } = {}) {
  const commitment = await store.client.commitment.findUnique({ where: { commitmentId } });
  const leg = await store.client.leg.findUnique({ where: { id: commitment.legId } });
  const agent = await store.client.agent.findUnique({ where: { id: commitment.agentId } });
  const result = await store.client.$transaction((tx) =>
    reassignment.reassign(tx, {
      leg,
      agent,
      commitment,
      legCommitments: store.rows("commitment").filter((row) => row.legId === leg.id),
      storeTime: store.now(),
      trigger: reassignment.TRIGGER.LEASE_EXPIRY,
      maxReassignmentsPerLeg: exhausted ? 0 : 3,
      incumbentCooloffSeconds: 300,
      reassignBudgetSeconds: 300,
      maxDeliveryDelaySeconds: 30,
      signingKey: fixtures.TEST_SIGNING_KEY,
    }),
  );
  expect(result.outcome).toBe(exhausted ? reassignment.OUTCOME.SUSPENDED : reassignment.OUTCOME.REASSIGNED);
  const recall = store.rows("outbox").find((row) => row.id === result.recallOutboxId);
  return { result, recall, envelope: envelopeFor(recall) };
}

const login = (client, robot, readModel) => runDedupHandshake(client, ROBOT_ID, robot.dedupReport(), silent, GATE, readModel);
const agentRow = (store, id = fixtures.AGENT_ROW_ID) => store.rows("agent").find((row) => row.id === id);
const rowState = (store, id) => store.rows("outbox").find((row) => row.id === id).state;
const taskUpdates = (io) => io.emitted.filter((e) => e.event === "TASK_UPDATED");

/**
 * Robot A accepted C1 (OFFER applied and ACKed, Task projected), then the engine withdrew it:
 * Leg REASSIGNING, C1 released, RECALL written. Optionally the RECALL is already FAILED, as the
 * outbox ladder left the two LOCAL rows after the simulator refused them.
 */
async function strandedAssignment({ legs = 1, exhausted = true, recallState = null } = {}) {
  const fixture = fixtures.seed({ capacity: 1, legs, now: new Date(T0) }); // store and simulator share one clock
  fixture.legs[0].state = "EN_ROUTE_PICKUP";
  const store = fixtures.storeFor(fixture);
  const view = withLegacyView(store, {
    tasks: fixture.legs.map((leg, i) => ({ id: `task-row-${i + 1}`, taskId: `TSK-${i + 1}`, status: "PENDING", missionId: leg.missionId })),
    robots: [
      { id: ROBOT_ROW, robotId: ROBOT_ID },
      { id: OTHER_ROBOT_ROW, robotId: OTHER_ROBOT_ID },
    ],
  });

  const flash = makeFlash();
  pinClock(T0);
  const first = makeAgent(flash);
  await first.robot.loadDedupState();
  expect((await login(view.client, first.robot)).path).toBe("FIRST_CONTACT");

  await grant(store, fixture, { id: "C1", fence: 42n });
  const offer = await issueOffer(store, { commitmentId: "C1", fence: 42n });
  expect((await deliver(store, first, offer.envelope)).settled).toEqual([expect.objectContaining({ acked: true })]);
  const projected = await assignmentProjection.projectAcceptedAssignment(view.client, { legRowId: fixtures.LEG_ROW_ID, robotCode: ROBOT_ID });
  expect(projected.projected).toBe(true);

  const recall = await withdraw(store, { exhausted });
  if (recallState) {
    await outbox.settleRow(store.client, { id: recall.recall.id, state: recallState, storeTime: store.now(), detail: "HELD_FOR_ORDER" });
  }
  return { fixture, store, view, flash, first, offer, recall };
}

/** The process restarts and its flash is gone. */
async function wipedReboot(flash, atMs) {
  flash.wipe();
  pinClock(atMs);
  const agent = makeAgent(flash);
  await agent.robot.loadDedupState();
  return agent;
}

function snapshot(store) {
  return {
    leg: store.rows("leg").map((row) => ({ ...row })),
    commitment: store.rows("commitment").map((row) => ({ ...row })),
    fenceCounter: agentRow(store).fenceCounter,
  };
}

// ── 1 + 6: the release, and what the dashboard reads ─────────────────────────

describe("P7-D4 Part 2 — a confirmed reset releases the Task view of the stand-down it voided", () => {
  test.each([
    ["the RECALL still outstanding (the reset suppresses it)", null, "SUPPRESSED"],
    ["the RECALL already FAILED after the simulator refused it (the LOCAL shape)", "FAILED", "FAILED"],
  ])("custody NONE, %s → Task released through the projection, no ACK invented", async (_label, recallState, expectedRecallState) => {
    const s = await strandedAssignment({ recallState });
    expect(s.view.tasks.get("task-row-1")).toMatchObject({ status: "ASSIGNED", robotId: ROBOT_ROW });
    expect(s.view.robots.get(ROBOT_ROW).currentTaskId).toBe("task-row-1");
    const before = snapshot(s.store);
    const epoch = agentRow(s.store).authorityEpoch;
    const io = makeIo();

    const rebooted = await wipedReboot(s.flash, T0 + 5_000);
    const ack = await login(s.view.client, rebooted.robot, { io, kv: makeFlash() });

    expect(ack).toMatchObject({ path: "SUPPRESS_AND_REFENCE", redeliverySuppressed: true, custodyReconciliationRequired: false });
    expect(agentRow(s.store).authorityEpoch).toBe(epoch + 1n);
    // The authority is exactly as the engine left it: no fence, Leg or commitment write.
    expect(snapshot(s.store)).toEqual(before);
    expect(s.store.rows("leg")[0].state).toBe("REASSIGNING");
    // No ACK was invented: the RECALL never reaches ACKED.
    expect(rowState(s.store, s.recall.recall.id)).toBe(expectedRecallState);
    expect(s.store.rows("outbox").filter((row) => row.state === "ACKED").map((row) => row.command)).toEqual(["OFFER"]);
    // The read model follows the authority.
    expect(s.view.tasks.get("task-row-1")).toMatchObject({ status: "PENDING", robotId: null, startedAt: null });
    expect(s.view.robots.get(ROBOT_ROW).currentTaskId).toBeNull();
    expect(taskUpdates(io)).toHaveLength(1);
    // Audit evidence, since no ACK exists to explain the release.
    expect(s.view.events).toEqual([
      expect.objectContaining({ robotId: ROBOT_ROW, taskId: "task-row-1", type: "WARNING", message: expect.stringContaining("without an ACK") }),
    ]);
    expect(s.view.events[0].message).toContain("commitment C1");
  });

  test("the dashboard is told exactly what an acknowledged stand-down tells it, plus the cause", async () => {
    const s = await strandedAssignment();
    const io = makeIo();
    const kv = makeFlash();
    await kv.set("taskPath:TSK-1", "{}");
    await kv.set(`robotTaskState:${ROBOT_ID}`, "{}");

    const rebooted = await wipedReboot(s.flash, T0 + 5_000);
    await login(s.view.client, rebooted.robot, { io, kv });

    expect(io.emitted).toEqual([
      {
        room: "dashboard",
        event: "TASK_UPDATED",
        payload: {
          taskId: "TSK-1",
          releasedRobotId: ROBOT_ID,
          status: "PENDING",
          // The value the dashboard's `standDownRobot` removes a unit's route on.
          action: "RECALLED",
          cause: "DEDUP_RESET",
          timestamp: expect.any(Number),
        },
      },
    ]);
    expect(io.emitted[0].payload.robotId).toBeUndefined();
    expect(kv.values.has("taskPath:TSK-1")).toBe(false);
    expect(kv.values.has(`robotTaskState:${ROBOT_ID}`)).toBe(false);
    // No longer "Executing" in any column the Tasks/Units views read.
    expect(["ASSIGNED", "IN_PROGRESS"]).not.toContain(s.view.tasks.get("task-row-1").status);
    expect(s.view.robots.get(ROBOT_ROW).currentTaskId).toBeNull();
  });
});

// ── 2: custody ───────────────────────────────────────────────────────────────

describe("P7-D4 Part 2 — unresolved custody retains the hold", () => {
  test("a live commitment HELD on another Leg: nothing is released and the robot is not made available", async () => {
    const s = await strandedAssignment({ legs: 2 });
    await grant(s.store, s.fixture, { id: "C2", fence: 44n, legIndex: 1, custody: "HELD" });
    const io = makeIo();

    const rebooted = await wipedReboot(s.flash, T0 + 5_000);
    const ack = await login(s.view.client, rebooted.robot, { io, kv: makeFlash() });

    expect(ack).toMatchObject({ path: "SUPPRESS_AND_REFENCE", custodyReconciliationRequired: true });
    expect(s.view.tasks.get("task-row-1")).toMatchObject({ status: "ASSIGNED", robotId: ROBOT_ROW });
    expect(s.view.robots.get(ROBOT_ROW).currentTaskId).toBe("task-row-1");
    expect(io.emitted).toEqual([]);
    expect(s.view.events).toEqual([]);
    expect(s.store.rows("commitment").find((c) => c.commitmentId === "C2").releasedAt).toBeNull();
    expect(
      availabilityIndex.classify({ lifecycleEligible: true, hasActiveCommitment: true, idle: false, queueDepth: 1, capacity: 1, charging: false }, T0, 300),
    ).toBeNull();
  });

  test.each([
    ["the released commitment's custody is PENDING_TRANSFER", async (s) => s.store.client.commitment.update({ where: { commitmentId: "C1" }, data: { custodyState: "PENDING_TRANSFER" } })],
    ["the Leg's custody is HELD", async (s) => s.store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { custodyState: "HELD" } })],
    ["a live commitment on another Leg is PENDING_TRANSFER", async (s) => grant(s.store, s.fixture, { id: "C2", fence: 44n, legIndex: 1, custody: "PENDING_TRANSFER" })],
  ])("custody not exactly NONE — %s → the Task view is not released", async (_label, arrange) => {
    const s = await strandedAssignment({ legs: 2 });
    await arrange(s);
    const io = makeIo();

    const rebooted = await wipedReboot(s.flash, T0 + 5_000);
    const ack = await login(s.view.client, rebooted.robot, { io, kv: makeFlash() });

    expect(ack.path).toBe("SUPPRESS_AND_REFENCE"); // the reset itself is unaffected
    expect(s.view.tasks.get("task-row-1")).toMatchObject({ status: "ASSIGNED", robotId: ROBOT_ROW });
    expect(io.emitted).toEqual([]);
    expect(s.view.events).toEqual([]);
  });
});

// ── 3: idempotency ───────────────────────────────────────────────────────────

describe("P7-D4 Part 2 — repeated reset and reconciliation are idempotent", () => {
  test("a second reset and an intact reconnect release nothing more, emit nothing more, and advance no fence", async () => {
    const s = await strandedAssignment();
    const io = makeIo();
    const kv = makeFlash();
    const counter = agentRow(s.store).fenceCounter;

    const once = await wipedReboot(s.flash, T0 + 5_000);
    const first = await login(s.view.client, once.robot, { io, kv });
    await once.robot.applyDedupAcknowledgement(first);
    const epochAfterFirst = agentRow(s.store).authorityEpoch;

    // The same process reconnects with its state intact: not a reset.
    pinClock(T0 + 65_000);
    const reconnect = await login(s.view.client, once.robot, { io, kv });
    expect(reconnect.path).not.toBe("SUPPRESS_AND_REFENCE");
    expect(agentRow(s.store).authorityEpoch).toBe(epochAfterFirst);

    // It loses its state a second time: a genuine second reset (one more epoch), nothing else.
    const twice = await wipedReboot(s.flash, T0 + 125_000);
    expect((await login(s.view.client, twice.robot, { io, kv })).path).toBe("SUPPRESS_AND_REFENCE");
    expect(agentRow(s.store).authorityEpoch).toBe(epochAfterFirst + 1n);

    expect(agentRow(s.store).fenceCounter).toBe(counter);
    expect(taskUpdates(io)).toHaveLength(1);
    expect(s.view.events).toHaveLength(1);
    expect(s.view.tasks.get("task-row-1")).toMatchObject({ status: "PENDING", robotId: null });
  });

  test("re-running the selection and the release directly moves nothing twice", async () => {
    const s = await strandedAssignment();
    const io = makeIo();
    const rebooted = await wipedReboot(s.flash, T0 + 5_000);
    await login(s.view.client, rebooted.robot, { io, kv: makeFlash() });

    const classification = { path: "SUPPRESS_AND_REFENCE", custodyReconciliationRequired: false };
    const agent = agentRow(s.store);
    const again = await s.store.client.$transaction((tx) =>
      dedupHandshake.standDownsVoidedByReset(tx, { agent, classification, fenceFloor: agent.fenceCounter }),
    );
    expect(again).toEqual([{ commitmentId: "C1", legId: fixtures.LEG_ROW_ID, command: "RECALL" }]);
    const repeated = await publishStandDown({
      prisma: s.view.client,
      kv: makeFlash(),
      io,
      log: silent,
      robotId: ROBOT_ID,
      commitmentId: "C1",
      cause: { kind: "DEDUP_RESET", reason: "retry", command: "RECALL" },
    });
    expect(repeated).toMatchObject({ released: false, reason: "TASK_NOT_HELD_BY_ROBOT" });
    expect(taskUpdates(io)).toHaveLength(1);
    expect(s.view.events).toHaveLength(1);
  });

  test("a read-model failure never fails the reset, and the next confirmed reset completes the release", async () => {
    const s = await strandedAssignment();
    const io = makeIo();
    s.view.faults.taskUpdates = 1;

    const once = await wipedReboot(s.flash, T0 + 5_000);
    const ack = await login(s.view.client, once.robot, { io, kv: makeFlash() });
    // The agent still gets its new epoch and floor — the authority is committed.
    expect(ack).toMatchObject({ path: "SUPPRESS_AND_REFENCE", fenceFloor: String(agentRow(s.store).fenceCounter) });
    expect(s.view.tasks.get("task-row-1").status).toBe("ASSIGNED");
    expect(io.emitted).toEqual([]);

    const twice = await wipedReboot(s.flash, T0 + 10_000);
    await login(s.view.client, twice.robot, { io, kv: makeFlash() });
    expect(s.view.tasks.get("task-row-1")).toMatchObject({ status: "PENDING", robotId: null });
    expect(taskUpdates(io)).toHaveLength(1);
  });
});

// ── 4: scope ─────────────────────────────────────────────────────────────────

describe("P7-D4 Part 2 — a reset touches only its own voided stand-downs", () => {
  test("a Task already re-projected onto the robot the Leg was reassigned to is left alone", async () => {
    const s = await strandedAssignment({ exhausted: false });
    expect(
      (await assignmentProjection.projectAcceptedAssignment(s.view.client, { legRowId: fixtures.LEG_ROW_ID, robotCode: OTHER_ROBOT_ID })).projected,
    ).toBe(true);
    const io = makeIo();

    const rebooted = await wipedReboot(s.flash, T0 + 5_000);
    await login(s.view.client, rebooted.robot, { io, kv: makeFlash() });

    expect(s.view.tasks.get("task-row-1")).toMatchObject({ status: "ASSIGNED", robotId: OTHER_ROBOT_ROW });
    expect(s.view.robots.get(OTHER_ROBOT_ROW).currentTaskId).toBe("task-row-1");
    expect(io.emitted).toEqual([]);
    expect(s.view.events).toEqual([]);
  });

  test("the same robot's live commitment on another Leg, and its Task, are untouched", async () => {
    const s = await strandedAssignment({ legs: 2 });
    await grant(s.store, s.fixture, { id: "C2", fence: 44n, legIndex: 1 });
    Object.assign(s.view.tasks.get("task-row-2"), { status: "ASSIGNED", robotId: ROBOT_ROW });
    const io = makeIo();

    const rebooted = await wipedReboot(s.flash, T0 + 5_000);
    await login(s.view.client, rebooted.robot, { io, kv: makeFlash() });

    expect(s.view.tasks.get("task-row-1")).toMatchObject({ status: "PENDING", robotId: null });
    expect(s.view.tasks.get("task-row-2")).toMatchObject({ status: "ASSIGNED", robotId: ROBOT_ROW });
    expect(s.store.rows("commitment").find((c) => c.commitmentId === "C2").releasedAt).toBeNull();
    expect(taskUpdates(io).map((e) => e.payload.taskId)).toEqual(["TSK-1"]);
  });

  test("another robot's stand-down, commitment, epoch and Task are untouched", async () => {
    const s = await strandedAssignment({ legs: 2 });
    await s.store.client.agent.create({
      data: { id: OTHER_AGENT_ROW, agentId: OTHER_ROBOT_ID, lifecycleState: "ACTIVE", authorityEpoch: 3n, fenceCounter: 10n, capacityOverride: null },
    });
    await grant(s.store, s.fixture, { id: "CB", fence: 11n, legIndex: 1, agentRowId: OTHER_AGENT_ROW });
    await issueOffer(s.store, { commitmentId: "CB", fence: 11n, agentRowId: OTHER_AGENT_ROW });
    const other = await withdraw(s.store, { commitmentId: "CB" });
    Object.assign(s.view.tasks.get("task-row-2"), { status: "ASSIGNED", robotId: OTHER_ROBOT_ROW });
    s.view.robots.get(OTHER_ROBOT_ROW).currentTaskId = "task-row-2";
    const otherBefore = { ...agentRow(s.store, OTHER_AGENT_ROW) };
    const io = makeIo();

    const rebooted = await wipedReboot(s.flash, T0 + 5_000);
    await login(s.view.client, rebooted.robot, { io, kv: makeFlash() });

    expect(s.view.tasks.get("task-row-2")).toMatchObject({ status: "ASSIGNED", robotId: OTHER_ROBOT_ROW });
    expect(s.view.robots.get(OTHER_ROBOT_ROW).currentTaskId).toBe("task-row-2");
    expect(rowState(s.store, other.recall.id)).toBe("PENDING"); // the other agent's RECALL is still deliverable
    expect(agentRow(s.store, OTHER_AGENT_ROW)).toEqual(otherBefore);
    expect(taskUpdates(io).map((e) => e.payload.taskId)).toEqual(["TSK-1"]);
  });
});

// ── 5: stale commands ────────────────────────────────────────────────────────

describe("P7-D4 Part 2 — stale commands stay rejected and nothing old is redelivered", () => {
  test("after the reset the old OFFER and RECALL are refused at the floor, unacknowledged, and unclaimable", async () => {
    const s = await strandedAssignment();
    const rebooted = await wipedReboot(s.flash, T0 + 5_000);
    const ack = await login(s.view.client, rebooted.robot, { io: makeIo(), kv: makeFlash() });
    await rebooted.robot.applyDedupAcknowledgement(ack);

    for (const envelope of [s.offer.envelope, s.recall.envelope]) {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await rebooted.robot._onMissionCommand(envelope.command, envelope);
      expect({ command: envelope.command, ...outcome }).toEqual({ command: envelope.command, applied: false, reason: "FENCE_AT_OR_BELOW_FLOOR" });
    }
    expect(rebooted.socket.emitted.filter((e) => e.event === "COMMAND_ACK")).toEqual([]);
    expect(rowState(s.store, s.recall.recall.id)).toBe("SUPPRESSED");
    expect(await outbox.claim(s.store.client, { workerId: "w1", storeTime: s.store.now(), limit: 10, claimTtlSeconds: 20 })).toHaveLength(0);
  });
});

// ── 7: unchanged behaviour ───────────────────────────────────────────────────

describe("P7-D4 Part 2 — reconnect, redelivery and the acknowledged stand-down are unchanged", () => {
  test("an intact reconnect with the RECALL outstanding releases nothing and leaves the RECALL deliverable", async () => {
    const s = await strandedAssignment();
    const io = makeIo();
    pinClock(T0 + HOUR_MS);
    const again = makeAgent(s.flash);
    await again.robot.loadDedupState();
    const ack = await login(s.view.client, again.robot, { io, kv: makeFlash() });

    expect(ack.path).toBe("RESUME");
    expect(rowState(s.store, s.recall.recall.id)).toBe("PENDING");
    expect(s.view.tasks.get("task-row-1")).toMatchObject({ status: "ASSIGNED", robotId: ROBOT_ROW });
    expect(io.emitted).toEqual([]);
  });

  test("an OFFER never acknowledged still takes the redelivery path, and nothing is released", async () => {
    const fixture = fixtures.seed({ capacity: 1, now: new Date(T0) });
    const store = fixtures.storeFor(fixture);
    const view = withLegacyView(store, { tasks: [{ id: "task-row-1", taskId: "TSK-1", status: "PENDING", missionId: fixture.legs[0].missionId }], robots: [{ id: ROBOT_ROW, robotId: ROBOT_ID }] });
    pinClock(T0);
    const { robot } = makeAgent(makeFlash());
    await robot.loadDedupState();
    await login(view.client, robot);
    await grant(store, fixture, { id: "C1", fence: 42n });
    const offer = await issueOffer(store, { commitmentId: "C1", fence: 42n });
    const epoch = agentRow(store).authorityEpoch;
    const io = makeIo();

    const ack = await login(view.client, robot, { io, kv: makeFlash() });
    expect(ack.path).toBe("REDELIVER_FROM_MARK");
    expect(agentRow(store).authorityEpoch).toBe(epoch);
    expect(rowState(store, offer.row.id)).toBe("PENDING");
    expect(io.emitted).toEqual([]);
  });

  test("a RECALL the intact agent applies and ACKs releases the Task exactly as before — no cause, no audit row", async () => {
    const s = await strandedAssignment();
    const recalled = await deliver(s.store, s.first, s.recall.envelope);
    expect(recalled.outcome.applied).toBe(true);
    expect(recalled.settled).toEqual([expect.objectContaining({ acked: true, command: "RECALL", commitmentId: "C1" })]);

    // What `COMMAND_ACK` does next for a settled stand-down.
    const io = makeIo();
    const released = await publishStandDown({ prisma: s.view.client, kv: makeFlash(), io, log: silent, robotId: ROBOT_ID, commitmentId: "C1" });
    expect(released.released).toBe(true);
    expect(io.emitted).toEqual([
      {
        room: "dashboard",
        event: "TASK_UPDATED",
        payload: { taskId: "TSK-1", releasedRobotId: ROBOT_ID, status: "PENDING", action: "RECALLED", timestamp: expect.any(Number) },
      },
    ]);
    expect(s.view.events).toEqual([]);

    // A later reset finds that stand-down ACKED, so it is not "voided" and nothing repeats.
    const io2 = makeIo();
    const rebooted = await wipedReboot(s.flash, T0 + 5_000);
    await login(s.view.client, rebooted.robot, { io: io2, kv: makeFlash() });
    expect(io2.emitted).toEqual([]);
  });
});

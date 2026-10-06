const { registerDtaroHandlers } = require("../../../src/sockets/handlers/dtaro.handler");
const { setRobotState, getRobotState } = require("../../../src/services/robotRegistry.service");
const { createTestKv } = require("../../helpers/testKv");
const { createFakeSocket, createFakeIo } = require("../../helpers/fakeSocket");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { waitFor } = require("../../helpers/waitFor");
const silentLogger = require("../../mocks/silentLogger");

describe("dtaro.handler — TASK_COMPLETE (task lifecycle: completion)", () => {
  let prisma;
  let kv;
  let io;
  let socket;

  beforeEach(async () => {
    prisma = createMockPrisma();
    ({ kv } = await createTestKv());
    io = createFakeIo();
    socket = createFakeSocket();
    socket.data.robotId = "R1";
    // §2.4 — the handler resolves the identifier the agent reported to a `Task.taskId`
    // before acting on it, because an agent may report the `Leg` it was offered instead.
    // A completion is about a Task that exists, so the fake client says so; without this
    // the resolver would find no Task, fall through to the Leg lookup, and these tests
    // would be asserting the behaviour of an unresolvable identifier.
    prisma.task.findUnique.mockResolvedValue({ taskId: "TSK-1" });
    registerDtaroHandlers(io, socket, { prisma, kv, logger: silentLogger });
  });

  test("ignores TASK_COMPLETE from an unauthenticated socket (no robotId bound)", async () => {
    const anon = createFakeSocket();
    registerDtaroHandlers(io, anon, { prisma, kv, logger: console });
    anon.trigger("TASK_COMPLETE", { taskId: "TSK-1" });
    await new Promise((r) => setTimeout(r, 20));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // P2B-2 — these two tests used to assert that a claim with no engine, no commitment and no
  // thresholds completed the Task and freed the robot: completion on the agent's word alone.
  // That path is closed. The same claim is now held for operator verification, and nothing
  // about the Task, the robot or its Redis task state is touched. The graded paths are
  // covered by `taskCompleteVerification.test.js`.
  test("an ungradable claim does NOT mark the task COMPLETED, free the robot, or clear its task state", async () => {
    await kv.set("robotTaskState:R1", JSON.stringify({ taskId: "TSK-1" }), { ex: 86400 });
    await kv.set("robotTask:R1", "TSK-1", { ex: 86400 });
    await setRobotState(kv, "R1", { assignedTaskId: "TSK-1" });

    prisma.task.updateMany.mockResolvedValue({ count: 1 });
    prisma.robot.update.mockResolvedValue({});

    socket.trigger("TASK_COMPLETE", { taskId: "TSK-1" });

    await waitFor(() => socket.sent.some((s) => s.event === "TASK_COMPLETE_ACK"));
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.task.updateMany).not.toHaveBeenCalled();
    expect(prisma.robot.update).not.toHaveBeenCalled();

    expect(await kv.get("robotTaskState:R1")).not.toBeNull();
    expect(await kv.get("robotTask:R1")).toBe("TSK-1");
    const registry = await getRobotState(kv, "R1");
    expect(registry.assignedTaskId).toBe("TSK-1");

    expect(io.to).toHaveBeenCalledWith("dashboard");
  });

  test("acknowledges the claim back to the robot as being verified, with the reason", async () => {
    socket.trigger("TASK_COMPLETE", { taskId: "TSK-1" });
    await waitFor(() => socket.sent.some((s) => s.event === "TASK_COMPLETE_ACK"));
    const ack = socket.sent.find((s) => s.event === "TASK_COMPLETE_ACK").payload;
    expect(ack).toMatchObject({ taskId: "TSK-1", verifying: true, reason: "ENGINE_GATE_CLOSED" });
  });
});

/**
 * C5 (Gate 1b, 2026-10-04) — the Task is completed only once its Leg is settled.
 *
 * `TASK_COMPLETE` used to complete the Task, free the robot and tell the dashboard COMPLETED
 * whatever settlement answered, so a claim sent while custody was still HELD reported the
 * delivery done with the goods aboard. These run the real verification, the real
 * `settlement.settle`, the real custody admission (`legProgress`) and the real completion, over
 * one in-memory store shared by `TASK_COMPLETE` and `CUSTODY_EVENT`. Only §4.4's transition
 * write is stubbed (as in `v1ExecutionProducers.test.js`), applying AT_DROP → RELEASED.
 */
describe("dtaro.handler — C5: the Task completes only after settlement", () => {
  const { registerOfferHandlers } = require("../../../src/sockets/handlers/offer.handler");
  const settlement = require("../../../src/engine/lifecycle/settlement");
  const transitions = require("../../../src/engine/lifecycle/transitions");
  const agentGate = require("../../../src/engine/cutover/agentGate");

  const VERIFY_V1 = Object.freeze({
    VERIFY_ARRIVAL_RADIUS_M: "25",
    VERIFY_TRACK_MIN_FIX_RATE: "10",
    VERIFY_TRACK_MIN_CORRIDOR_FRACTION: "0.8",
    VERIFY_TRACK_MAX_GAP_SECONDS: "10",
    VERIFY_CORRIDOR_HALF_WIDTH_M: "30",
    VERIFY_MAX_SPEED_MS: "8.33",
  });
  const ENV_BEFORE = { ...process.env };
  beforeEach(() => {
    process.env.ENGINE_ENABLED = "true";
    Object.assign(process.env, VERIFY_V1);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => {
    for (const key of [...Object.keys(VERIFY_V1), "ENGINE_ENABLED"]) {
      if (ENV_BEFORE[key] === undefined) delete process.env[key];
      else process.env[key] = ENV_BEFORE[key];
    }
  });

  const snapshot = {
    resolve: (name) => (name === "cutover.engine_enabled" ? true : name === "security.position_plausibility_tolerance" ? 1.2 : null),
    values: new Map(),
  };

  // An 80 m drive due north-east that ends at the drop, one fix every 2 s, ending 2 s ago.
  const START = Object.freeze({ lat: 12.9081, lon: 77.5012 });
  const DROP = Object.freeze({ lat: 12.90862, lon: 77.50172 });
  function track(now = Date.now()) {
    const fixes = [];
    for (let i = 0; i <= 28; i += 1) {
      const t = i / 28;
      fixes.push({
        observedAt: new Date(now - 58_000 + i * 2000),
        value: { lat: START.lat + (DROP.lat - START.lat) * t, lon: START.lon + (DROP.lon - START.lon) * t, provenance: "PHYSICAL" },
      });
    }
    return fixes;
  }

  /** One store for both handlers; each method evaluates only the where-clauses the code writes. */
  function store({ legState, custodyState }) {
    // §2.8 — Task >──< Mission >──< Leg. TSK-1 is the Task this Leg's Mission discharges. TSK-2
    // is a second Task bound to the same robot (`Task.robotId` is many-to-one) and TSK-3 one
    // bound to another robot; neither belongs to this Leg.
    const tasks = {
      "TSK-1": { id: "task-row-1", taskId: "TSK-1", status: "ASSIGNED", robotCode: "RBT-1", completedAt: null },
      "TSK-2": { id: "task-row-2", taskId: "TSK-2", status: "ASSIGNED", robotCode: "RBT-1", completedAt: null },
      "TSK-3": { id: "task-row-3", taskId: "TSK-3", status: "ASSIGNED", robotCode: "RBT-9", completedAt: null },
    };
    const s = {
      tasks,
      task: tasks["TSK-1"],
      missionTaskIds: ["TSK-1"],
      robot: { id: "robot-row-1", robotId: "RBT-1", status: "ACTIVE", currentTaskId: "task-row-1", speed: 1 },
      commitment: { commitmentId: "CMT-1", agentId: "agent-row-1", legId: "leg-1", fence: 5n, grantedAt: new Date(Date.now() - 60_000), releasedAt: null, version: 1, custodyState: "NONE" },
      leg: { id: "leg-1", legId: "LEG-1", purpose: "DELIVERY", state: legState, custodyState, version: 7 },
      evidence: [],
      fixes: track(),
    };
    const copy = (row) => (row ? { ...row } : null);
    const p = {
      task: {
        findUnique: jest.fn(async ({ where, select }) => {
          const task = s.tasks[where.taskId];
          if (!task) return null;
          return select && select.status ? { taskId: task.taskId, status: task.status, robot: { robotId: task.robotCode } } : { taskId: task.taskId };
        }),
        updateMany: jest.fn(async ({ where, data }) => {
          const task = s.tasks[where.taskId];
          const hit = Boolean(task) && where.robot.robotId === task.robotCode && where.status.in.includes(task.status);
          if (hit) Object.assign(task, data);
          return { count: hit ? 1 : 0 };
        }),
      },
      robot: {
        update: jest.fn(async ({ where, data }) => {
          if (where.robotId === s.robot.robotId) Object.assign(s.robot, data);
          return copy(s.robot);
        }),
        // Evaluates the status filter against the row as it is *when the write runs*, as
        // PostgreSQL re-evaluates an UPDATE's WHERE on the newest committed version.
        // `s.beforeStatusWrite` lets a test land a concurrent write first.
        updateMany: jest.fn(async ({ where, data }) => {
          if (typeof s.beforeStatusWrite === "function") s.beforeStatusWrite(s);
          const hit = where.robotId === s.robot.robotId && (!where.status || where.status.in.includes(s.robot.status));
          if (hit) Object.assign(s.robot, data);
          return { count: hit ? 1 : 0 };
        }),
        findUnique: jest.fn(async () => ({ id: s.robot.id })),
      },
      agent: { findUnique: jest.fn(async ({ where }) => (where.agentId === "RBT-1" ? { id: "agent-row-1", agentId: "RBT-1" } : null)) },
      commitment: {
        findFirst: jest.fn(async ({ where }) => (where.agentId === s.commitment.agentId && s.commitment.releasedAt === null ? copy(s.commitment) : null)),
        findUnique: jest.fn(async ({ where }) => (where.commitmentId === s.commitment.commitmentId ? copy(s.commitment) : null)),
        update: jest.fn(async ({ data }) => Object.assign(s.commitment, data)),
      },
      leg: {
        // `select.mission.tasks` is the §2.8 relationship `assignmentProjection.taskForLeg` reads.
        findUnique: jest.fn(async ({ where, select }) => {
          if (where.id !== s.leg.id) return null;
          if (select && select.mission) return { mission: { tasks: s.missionTaskIds.map((id) => ({ ...s.tasks[id] })) } };
          return copy(s.leg);
        }),
        // `resolveCompletedTaskId` — a claim naming the Leg by `legId` or `id`.
        findFirst: jest.fn(async ({ where }) =>
          where.OR.some((c) => c.legId === s.leg.legId || c.id === s.leg.id)
            ? { mission: { tasks: s.missionTaskIds.map((id) => ({ taskId: id })) } }
            : null,
        ),
        updateMany: jest.fn(async ({ where, data }) => {
          const hit = where.id === s.leg.id && where.version === s.leg.version;
          if (hit) Object.assign(s.leg, data);
          return { count: hit ? 1 : 0 };
        }),
      },
      stop: { findMany: jest.fn(async () => [{ sequence: 2, stopType: "DROP", lat: DROP.lat, lon: DROP.lon }]) },
      observation: { findMany: jest.fn(async () => s.fixes) },
      outbox: { findFirst: jest.fn(async () => ({ payload: { stopSequence: [{ sequence: 2, path: [START, DROP] }] } })) },
      verificationEvidence: {
        create: jest.fn(async ({ data }) => {
          s.evidence.push(data);
          return data;
        }),
        findFirst: jest.fn(async ({ where }) =>
          [...s.evidence].reverse().find((row) => row.legId === where.legId && row.outcome === where.outcome && row.evidenceId.includes(where.evidenceId.contains)) || null,
        ),
      },
      payloadManifest: { findMany: jest.fn(async () => []) },
      timer: { updateMany: jest.fn(async () => ({ count: 0 })) },
      event: { create: jest.fn(async () => ({})) },
      $queryRawUnsafe: jest.fn(async () => [{ now: new Date() }]),
    };
    // A transaction client has no `$transaction` (the shape `timers.requireTransaction` checks,
    // as in `helpers/mockPrisma`); the model objects are shared, so writes land in `s`.
    p.$transaction = jest.fn(async (fn) => {
      const { $transaction, ...tx } = p;
      return fn(tx);
    });
    return { s, prisma: p };
  }

  /** §4.4's write for the one event these tests raise: AT_DROP —CUSTODY_RELEASED→ RELEASED. */
  function stubCustodyTransition(s) {
    jest.spyOn(transitions, "apply").mockImplementation(async (_tx, input) => {
      const from = s.leg.state;
      if (input.event === transitions.EVENT.CUSTODY_RELEASED && from === "AT_DROP" && input.leg.version === s.leg.version) {
        Object.assign(s.leg, { state: "RELEASED", ...(input.data || {}), version: s.leg.version + 1 });
        return { outcome: transitions.OUTCOME.APPLIED, from, to: "RELEASED", event: input.event };
      }
      return { outcome: "REJECTED", from, event: input.event };
    });
  }

  /** A robot socket with both agent handlers, as `socket.server.js` composes them. */
  async function connect(h) {
    const { kv } = await createTestKv();
    const robotSocket = createFakeSocket();
    robotSocket.data.robotId = "RBT-1";
    robotSocket.data.isAuthed = true;
    agentGate.bind(robotSocket, { agentId: "RBT-1", shardId: "SHARD-1", regionId: "RGN-1", resolvedAtMs: Date.now() });
    // Handler failures are logged, never thrown, so they are recorded here and asserted empty.
    const logger = { ...silentLogger, error: (...args) => h.errors.push(args.map((a) => (a && a.message) || JSON.stringify(a)).join(" ")) };
    const deps = { prisma: h.prisma, kv, logger, appLocals: { config: snapshot } };
    registerDtaroHandlers(h.io, robotSocket, deps);
    registerOfferHandlers(h.io, robotSocket, deps);
    return robotSocket;
  }

  const harness = (state) => {
    const h = { ...store(state), io: createFakeIo(), errors: [] };
    stubCustodyTransition(h.s);
    return h;
  };
  afterEach(() => {
    // A handler that failed would be invisible otherwise: assert every case ran clean.
    for (const h of harnesses.splice(0)) expect(h.errors).toEqual([]);
  });
  const harnesses = [];
  const tracked = (h) => {
    harnesses.push(h);
    return h;
  };
  const acks = (sock) => sock.sent.filter((m) => m.event === "TASK_COMPLETE_ACK").map((m) => m.payload);
  const completedEvents = (h) => h.io.emittedTo("dashboard", "TASK_UPDATED").filter((e) => e.status === "COMPLETED");
  const claim = async (sock, count = 1) => {
    sock.trigger("TASK_COMPLETE", { taskId: "TSK-1", lat: DROP.lat, lon: DROP.lon });
    await waitFor(() => acks(sock).length >= count);
    return acks(sock)[count - 1];
  };
  const release = (sock) => sock.trigger("CUSTODY_EVENT", { commitmentId: "CMT-1", fence: "5", kind: "RELEASED" });

  test("1 — custody already RELEASED: TASK_COMPLETE settles the Leg and completes the Task, as before", async () => {
    const h = tracked(harness({ legState: "RELEASED", custodyState: "RELEASED" }));
    const sock = await connect(h);

    const ack = await claim(sock);

    expect(ack).toMatchObject({ taskId: "TSK-1" });
    expect(ack.verifying).toBeUndefined();
    expect(h.s.evidence.map((row) => row.outcome)).toEqual(["SUFFICIENT"]);
    expect(h.s.leg.state).toBe("SETTLED");
    expect(h.s.commitment.releasedAt).toBeInstanceOf(Date);
    expect(h.s.task.status).toBe("COMPLETED");
    expect(h.s.robot).toMatchObject({ status: "IDLE", currentTaskId: null });
    expect(completedEvents(h)).toHaveLength(1);
    expect(completedEvents(h)[0]).toMatchObject({ robotId: "RBT-1", taskId: "TSK-1" });
  });

  test("2 — custody HELD: the claim is verified and held; nothing is completed and the commitment stays live", async () => {
    const h = tracked(harness({ legState: "AT_DROP", custodyState: "HELD" }));
    const settleSpy = jest.spyOn(settlement, "settle");
    const sock = await connect(h);

    const ack = await claim(sock);

    expect(await settleSpy.mock.results[0].value).toMatchObject({ outcome: "REFUSED", reason: "CUSTODY_STILL_HELD" });
    expect(ack).toMatchObject({ taskId: "TSK-1", verifying: true, reason: "CUSTODY_STILL_HELD" });
    expect(h.s.evidence.map((row) => row.outcome)).toEqual(["SUFFICIENT"]);
    expect(h.s.task.status).toBe("ASSIGNED");
    expect(h.s.task.completedAt).toBeNull();
    expect(h.s.robot).toMatchObject({ status: "ACTIVE", currentTaskId: "task-row-1" });
    expect(h.prisma.robot.update).not.toHaveBeenCalled();
    expect(h.s.commitment.releasedAt).toBeNull();
    expect(h.s.leg).toMatchObject({ state: "AT_DROP", custodyState: "HELD" });
    expect(completedEvents(h)).toHaveLength(0);
  });

  test("3 — the later RELEASED settles the Leg against the held claim and completes the Task exactly once", async () => {
    const h = tracked(harness({ legState: "AT_DROP", custodyState: "HELD" }));
    const sock = await connect(h);
    await claim(sock);
    expect(h.s.task.status).toBe("ASSIGNED");

    release(sock);
    await waitFor(() => h.s.leg.state === "SETTLED" && completedEvents(h).length > 0);

    expect(h.s.leg).toMatchObject({ state: "SETTLED", custodyState: "RELEASED" });
    expect(h.s.commitment.releasedAt).toBeInstanceOf(Date);
    expect(h.s.task.status).toBe("COMPLETED");
    expect(h.s.task.completedAt).toBeInstanceOf(Date);
    expect(h.s.robot).toMatchObject({ status: "IDLE", currentTaskId: null });
    expect(completedEvents(h)).toHaveLength(1);
    expect(completedEvents(h)[0]).toMatchObject({ robotId: "RBT-1", taskId: "TSK-1" });
  });

  test("4 — RELEASED with no verified claim releases custody and fabricates no completion", async () => {
    const h = tracked(harness({ legState: "AT_DROP", custodyState: "HELD" }));
    const sock = await connect(h);

    release(sock);
    await waitFor(() => h.s.leg.state === "RELEASED");
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(h.s.leg).toMatchObject({ state: "RELEASED", custodyState: "RELEASED" });
    expect(h.s.commitment.releasedAt).toBeNull();
    expect(h.s.task.status).toBe("ASSIGNED");
    expect(h.s.robot.status).toBe("ACTIVE");
    expect(completedEvents(h)).toHaveLength(0);

    // The contract order that follows — TASK_COMPLETE after the release — completes it.
    const ack = await claim(sock);
    expect(ack.verifying).toBeUndefined();
    expect(h.s.leg.state).toBe("SETTLED");
    expect(h.s.task.status).toBe("COMPLETED");
    expect(completedEvents(h)).toHaveLength(1);
  });

  test("5 — replayed TASK_COMPLETE and RELEASED messages finalize once and publish one COMPLETED", async () => {
    const h = tracked(harness({ legState: "AT_DROP", custodyState: "HELD" }));
    const first = await connect(h);
    await claim(first);

    // The robot reconnects and repeats its claim while custody is still HELD: held again.
    const second = await connect(h);
    expect(await claim(second)).toMatchObject({ verifying: true, reason: "CUSTODY_STILL_HELD" });
    expect(h.s.task.status).toBe("ASSIGNED");

    release(second);
    await waitFor(() => h.s.task.status === "COMPLETED");
    const completedAt = h.s.task.completedAt;
    const robotWrites = h.prisma.robot.update.mock.calls.length;

    // Replays after completion, each from a reconnected socket.
    const third = await connect(h);
    release(third);
    expect(await claim(third)).toMatchObject({ taskId: "TSK-1", alreadyCompleted: true });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(completedEvents(h)).toHaveLength(1);
    expect(h.prisma.robot.update.mock.calls.length).toBe(robotWrites);
    expect(h.s.task.completedAt).toBe(completedAt);
    expect(h.s.leg.state).toBe("SETTLED");
  });

  // ── F1 — a completion never raises a robot's health tier ─────────────────
  //
  // ERROR and OFFLINE are QUARANTINED, PAUSED and ISSUES MARGINAL, IDLE and ACTIVE NOMINAL
  // (`agentFacts.HEALTH_TIER_BY_STATUS`). Writing IDLE over a lower tier on the strength of the
  // agent's own completion is the expansion §23.5 forbids; return to service is the operator's
  // `clear-fault`. Both completion paths share `taskCompletion.recordInTx`/`publish`, so each
  // case runs through both: TASK_COMPLETE after custody RELEASED, and the RELEASED report that
  // settles a held claim (`legProgress.settleIfVerified`).
  const robotStateCache = require("../../../src/cache/robotStateCache");
  const { HEALTH_TIER_BY_STATUS } = require("../../../src/services/agentFacts.service");
  const f09 = require("../../../src/engine/feasibility/predicates/f09");
  const trustBoundaries = require("../../../src/engine/security/trustBoundaries");
  const tierOf = (status) => f09.HEALTH_TIER_ORDER.indexOf(HEALTH_TIER_BY_STATUS[status]);

  const PATHS = [
    [
      "TASK_COMPLETE after RELEASED",
      { legState: "RELEASED", custodyState: "RELEASED" },
      async (h, sock) => {
        await claim(sock);
      },
    ],
    [
      "RELEASED settling a held claim",
      { legState: "AT_DROP", custodyState: "HELD" },
      async (h, sock) => {
        await claim(sock);
        release(sock);
      },
    ],
  ];

  /** Run one completion with the robot in `status`, and wait for it to finalize. */
  async function completeFrom(status, [, state, drive]) {
    const h = tracked(harness(state));
    h.s.robot.status = status;
    robotStateCache.del("RBT-1");
    const sock = await connect(h);
    await drive(h, sock);
    await waitFor(() => h.s.task.status === "COMPLETED" && completedEvents(h).length > 0);
    return h;
  }

  describe.each(PATHS)("F1 via %s", (...path) => {
    test.each(["ERROR", "PAUSED", "ISSUES", "OFFLINE"])(
      "a %s robot keeps its status; the task, the Leg and the robot's task binding still complete",
      async (status) => {
        const h = await completeFrom(status, path);

        expect(h.s.robot).toMatchObject({ status, currentTaskId: null, speed: 0 });
        expect(h.s.task.status).toBe("COMPLETED");
        expect(h.s.leg.state).toBe("SETTLED");
        expect(h.s.commitment.releasedAt).toBeInstanceOf(Date);
        expect(completedEvents(h)).toHaveLength(1);
        // The live cache must not claim IDLE either: telemetry's §23.5 check reads it as the
        // current status, and an IDLE there would let the agent's next status report pass.
        expect(robotStateCache.get("RBT-1")?.status).not.toBe("IDLE");
      },
    );

    test.each(["ACTIVE", "IDLE"])("a %s robot becomes IDLE, as before", async (status) => {
      const h = await completeFrom(status, path);
      expect(h.s.robot).toMatchObject({ status: "IDLE", currentTaskId: null, speed: 0 });
      expect(h.s.task.status).toBe("COMPLETED");
      expect(completedEvents(h)).toHaveLength(1);
    });
  });

  test("F1 — an ERROR robot stays excluded by F9 after it completes a task", async () => {
    const h = await completeFrom("ERROR", PATHS[0]);
    const verdict = f09.evaluate({
      agentSnapshot: { healthTier: HEALTH_TIER_BY_STATUS[h.s.robot.status] },
      mission: { slaClass: "STANDARD", requiredHealthTier: "NOMINAL" },
    });
    expect(verdict).toMatchObject({ outcome: "VIOLATED", observed: "QUARANTINED", required: "NOMINAL" });
  });

  test("F1 — after an ERROR robot completes, its next self-reported ACTIVE cannot clear the fault (§23.5)", async () => {
    const h = await completeFrom("ERROR", PATHS[0]);
    // What telemetry would take as the current status: the cache, else the database row.
    const current = robotStateCache.get("RBT-1")?.status ?? h.s.robot.status;
    const verdict = trustBoundaries.validateHealth({ reportedTier: tierOf("ACTIVE"), currentTier: tierOf(current) });
    expect(current).toBe("ERROR");
    expect(verdict.applied).toBe(false);
  });

  test("F1 RACE — a fault that commits before the completion's status write is not overwritten", async () => {
    const h = tracked(harness({ legState: "RELEASED", custodyState: "RELEASED" }));
    // The robot is ACTIVE when the completion starts; a ROBOT_FAULT lands just before the
    // status write evaluates its filter.
    h.s.beforeStatusWrite = (s) => {
      s.robot.status = "ERROR";
      s.beforeStatusWrite = null;
    };
    robotStateCache.del("RBT-1");
    const sock = await connect(h);
    await claim(sock);
    await waitFor(() => h.s.task.status === "COMPLETED" && completedEvents(h).length > 0);

    expect(h.s.robot).toMatchObject({ status: "ERROR", currentTaskId: null, speed: 0 });
    expect(robotStateCache.get("RBT-1")?.status).not.toBe("IDLE");
  });

  // ── F2 — a completion is bound to the Task the settled Leg belongs to ─────
  //
  // The Leg comes from the agent's live commitment; the Task must come from that Leg
  // (§2.8, `assignmentProjection.taskForLeg`), never from the agent's `taskId`. The claim is a
  // consistency check: it must name that Task (or the Leg itself). A claim that does not is
  // held before it is graded — no evidence, no settlement, no release, nothing completed — and
  // the dashboard hears about the Leg's own Task, never the one the claim named.
  const claimWith = async (sock, payload, count = 1) => {
    sock.trigger("TASK_COMPLETE", { lat: DROP.lat, lon: DROP.lon, ...payload });
    await waitFor(() => acks(sock).length >= count);
    return acks(sock)[count - 1];
  };
  const dashboardTaskIds = (h) => h.io.emittedTo("dashboard", "TASK_UPDATED").map((e) => [e.taskId, e.status]);

  /** Nothing about the Leg, the commitment, the robot or any Task moved. */
  function expectNothingSettled(h, { legState }) {
    expect(h.s.leg.state).toBe(legState);
    expect(h.s.commitment.releasedAt).toBeNull();
    expect(h.s.robot).toMatchObject({ status: "ACTIVE", currentTaskId: "task-row-1" });
    for (const id of ["TSK-1", "TSK-2", "TSK-3"]) expect(h.s.tasks[id]).toMatchObject({ status: "ASSIGNED", completedAt: null });
    expect(completedEvents(h)).toHaveLength(0);
  }

  test.each([
    ["another Task of this same robot (TSK-2)", { taskId: "TSK-2" }, "TASK_CLAIM_MISMATCH"],
    ["another robot's Task (TSK-3)", { taskId: "TSK-3" }, "TASK_CLAIM_MISMATCH"],
    ["an identifier that names no Task or Leg", { taskId: "NOPE-404" }, "TASK_CLAIM_MISMATCH"],
    ["no taskId at all", {}, "TASK_NOT_NAMED"],
    ["taskId null", { taskId: null }, "TASK_NOT_NAMED"],
  ])("F2 TASK_COMPLETE path — a claim naming %s is held: nothing graded, settled or completed", async (_name, payload, reason) => {
    const h = tracked(harness({ legState: "RELEASED", custodyState: "RELEASED" }));
    const sock = await connect(h);

    const ack = await claimWith(sock, payload);

    expect(ack).toMatchObject({ verifying: true, reason });
    expect(h.s.evidence).toEqual([]);
    expectNothingSettled(h, { legState: "RELEASED" });
    // The operator's queue names the Leg's own Task — never the one the claim named.
    expect(dashboardTaskIds(h)).toEqual([["TSK-1", "VERIFYING"]]);
    // An identifier naming nothing is logged at error level by the handler, as it always was;
    // that line is the expected record, not a handler failure.
    if (payload.taskId === "NOPE-404") {
      expect(h.errors).toEqual([expect.stringContaining("resolves to no single Task")]);
      h.errors.length = 0;
    }
  });

  test("F2 TASK_COMPLETE path — the claim may name the Leg itself; the Leg's own Task completes", async () => {
    const h = tracked(harness({ legState: "RELEASED", custodyState: "RELEASED" }));
    const sock = await connect(h);

    const ack = await claimWith(sock, { taskId: "LEG-1" });

    expect(ack).toMatchObject({ taskId: "TSK-1" });
    expect(ack.verifying).toBeUndefined();
    expect(h.s.leg.state).toBe("SETTLED");
    expect(h.s.tasks["TSK-1"].status).toBe("COMPLETED");
    expect(h.s.tasks["TSK-2"].status).toBe("ASSIGNED");
    expect(completedEvents(h).map((e) => e.taskId)).toEqual(["TSK-1"]);
    expect(h.s.evidence.map((row) => row.taskId)).toEqual(["TSK-1"]);
  });

  test("F2 — a Mission discharging two Tasks has no single Task to complete: held, nothing settled", async () => {
    const h = tracked(harness({ legState: "RELEASED", custodyState: "RELEASED" }));
    h.s.missionTaskIds = ["TSK-1", "TSK-2"];
    const sock = await connect(h);

    const ack = await claimWith(sock, { taskId: "TSK-1" });

    expect(ack).toMatchObject({ verifying: true, reason: "NO_SINGLE_TASK_FOR_LEG" });
    expect(h.s.evidence).toEqual([]);
    expectNothingSettled(h, { legState: "RELEASED" });
    expect(dashboardTaskIds(h)).toEqual([[null, "VERIFYING"]]);
  });

  test("F2 custody-release path — a held wrong claim leaves no evidence, so the RELEASED report settles nothing", async () => {
    const h = tracked(harness({ legState: "AT_DROP", custodyState: "HELD" }));
    const sock = await connect(h);

    expect(await claimWith(sock, { taskId: "TSK-2" })).toMatchObject({ verifying: true, reason: "TASK_CLAIM_MISMATCH" });
    release(sock);
    await waitFor(() => h.s.leg.state !== "AT_DROP");
    await new Promise((resolve) => setTimeout(resolve, 30));

    expectNothingSettled(h, { legState: "RELEASED" });

    // The correct claim then completes the Leg's own Task, exactly once (from a reconnected
    // socket, as test 5 does: the handler rate-limits TASK_COMPLETE to one a second per socket).
    const ack = await claimWith(await connect(h), { taskId: "TSK-1" });
    expect(ack.verifying).toBeUndefined();
    expect(h.s.leg.state).toBe("SETTLED");
    expect(h.s.tasks["TSK-1"].status).toBe("COMPLETED");
    expect(h.s.tasks["TSK-2"].status).toBe("ASSIGNED");
    expect(completedEvents(h).map((e) => e.taskId)).toEqual(["TSK-1"]);
  });

  test.each([
    ["names another Task (TSK-2)", "TSK-2"],
    ["names no Task (null)", null],
  ])("F2 custody-release path — SUFFICIENT evidence that %s does not settle the Leg or release the commitment", async (_name, taskId) => {
    // A row the pre-F2 handler wrote: graded against this Leg and commitment, carrying the
    // agent's unchecked claim.
    const h = tracked(harness({ legState: "AT_DROP", custodyState: "HELD" }));
    h.s.evidence.push({ evidenceId: `LEG-1-CMT-1-${Date.now()}`, legId: "leg-1", taskId, outcome: "SUFFICIENT", observedAt: new Date() });
    const sock = await connect(h);

    release(sock);
    await waitFor(() => h.s.leg.state !== "AT_DROP");
    await new Promise((resolve) => setTimeout(resolve, 30));

    expectNothingSettled(h, { legState: "RELEASED" });
  });
});

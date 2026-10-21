"use strict";

/**
 * A RESUME may only resume the mission of the commitment the server holds live for the robot.
 *
 * The defect: a unit drops a mission only when a RECALL / WITHDRAW is admitted. One that never
 * arrives leaves the mission and its route on the unit after the engine has released the
 * commitment and given the Leg to another robot. Each case below is reachable:
 *   · the RECALL was emitted while the unit was disconnected;
 *   · it was held for a sequence gap (measured live in the P7-D2 recovery: both simulated units
 *     answered HELD_FOR_ORDER and kept their missions);
 *   · it went unacknowledged past its deadline and the outbox failed it as
 *     UNACKNOWLEDGED_AND_NOT_AN_OFFER, never to be redelivered.
 * The unit is PAUSED (the operator's STOP/PAUSE, or the Pi's link-loss pause). RESUME was the
 * unchecked `{ commandId, type, timestamp }`, and the unit drove the obsolete route.
 *
 * The fix names the commitment the server holds live on RESUME (`commitmentId`, null for none),
 * read when each delivery is made. A unit carrying a commitment-bound mission resumes it only
 * when the two match; otherwise it refuses the RESUME (not applied, not acknowledged). A RESUME
 * without the field, and one to a unit holding no commitment-bound mission, behave as before.
 *
 * The robot side is the real `VirtualRobot`, fed exactly the payload the controller emitted.
 * The commitment it carries is set as its OFFER_ACCEPT path sets it (`_activeCommitment`).
 */

jest.mock("../../../src/db/prisma");

const { getPrisma } = require("../../../src/db/prisma");
const { sendRobotCommand } = require("../../../src/controllers/robots.controller");
const VirtualRobot = require("../../../src/simulation/VirtualRobot");
const { createTestKv } = require("../../helpers/testKv");
const { createFakeIo } = require("../../helpers/fakeSocket");
const silentLogger = require("../../mocks/silentLogger");

const AGENT_ROW = "agent-row-1";

/** A store whose live commitment for the robot can be changed between deliveries. */
function store({ live = null, agent = true } = {}) {
  const s = { live, commandStatus: "SENT" };
  s.prisma = {
    robot: { findUnique: jest.fn(async () => ({ id: "db-robot-1" })), updateMany: jest.fn(async () => ({ count: 1 })) },
    command: {
      create: jest.fn(async ({ data }) => ({ id: "cmd-1", ...data })),
      findUnique: jest.fn(async () => ({ status: s.commandStatus })),
      update: jest.fn(async () => ({})),
    },
    agent: { findUnique: jest.fn(async ({ where }) => (agent && where.agentId === "R1" ? { id: AGENT_ROW } : null)) },
    commitment: {
      findFirst: jest.fn(async ({ where }) =>
        where.agentId === AGENT_ROW && where.releasedAt === null && s.live ? { commitmentId: s.live } : null,
      ),
    },
  };
  return s;
}

async function send(s, type) {
  const { kv } = await createTestKv();
  const io = createFakeIo();
  io.joinRoom("robot:R1", { id: "sock-r1" });
  const res = { body: null, statusCode: 200 };
  res.status = jest.fn((c) => { res.statusCode = c; return res; });
  await new Promise((resolve, reject) => {
    res.json = jest.fn((b) => { res.body = b; resolve(); return res; });
    getPrisma.mockReturnValue(s.prisma);
    sendRobotCommand({ params: { robotId: "R1" }, body: { type }, user: { id: "11111111-1111-4111-8111-111111111111", role: "SUPER_ADMIN" }, app: { locals: { kv, io } } }, res, reject);
  });
  return { io, res, commands: () => io.emittedTo("robot:R1", "COMMAND") };
}

function virtualRobot() {
  const vr = new VirtualRobot({ robotId: "R1", lat: 12.9, lon: 77.5, logger: silentLogger, kv: null });
  const sent = [];
  vr.socket = { connected: true, emit: (event, payload) => sent.push({ event, payload }), on: () => {} };
  vr.connected = true;
  return { vr, acked: () => sent.filter((m) => m.event === "COMMAND_ACK").map((m) => m.payload.commandId) };
}

/** A unit carrying out commitment `commitmentId`, then paused by the operator. */
function pausedOnCommitment(commitmentId) {
  const robot = virtualRobot();
  const { vr } = robot;
  vr.task = { taskId: "TSK-OLD", pathToPickup: [{ lat: 12.9, lon: 77.5 }], pathToDrop: [] };
  vr.phase = "TO_PICKUP";
  vr.activePath = vr.task.pathToPickup;
  vr.status = "ACTIVE";
  vr._activeCommitment = { commitmentId, fence: "5" };
  vr._onCommand({ commandId: "cmd-pause", type: "PAUSE" });
  expect(vr.status).toBe("PAUSED");
  return robot;
}

afterEach(() => {
  jest.useRealTimers();
});

describe("the RESUME the server sends names the commitment it holds live", () => {
  test("RESUME carries the robot's live commitment, read by agent and unreleased", async () => {
    const s = store({ live: "CMT-1" });
    const { commands } = await send(s, "RESUME");
    expect(commands()).toEqual([expect.objectContaining({ commandId: "cmd-1", type: "RESUME", commitmentId: "CMT-1" })]);
    expect(s.prisma.commitment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { agentId: AGENT_ROW, releasedAt: null }, orderBy: { grantedAt: "desc" } }),
    );
  });

  test.each([
    ["no live commitment", { live: null }],
    ["no Agent row", { live: "CMT-1", agent: false }],
  ])("RESUME carries commitmentId null when the robot has %s", async (_name, options) => {
    const { commands } = await send(store(options), "RESUME");
    const [payload] = commands();
    expect(payload).toHaveProperty("commitmentId", null);
  });

  test.each(["STOP", "PAUSE", "RETURN"])("%s is sent exactly as before, with no commitmentId", async (type) => {
    const s = store({ live: "CMT-1" });
    const { commands } = await send(s, type);
    const [payload] = commands();
    expect(payload).toMatchObject({ commandId: "cmd-1", type });
    expect(payload).not.toHaveProperty("commitmentId");
    expect(s.prisma.commitment.findFirst).not.toHaveBeenCalled();
  });

  test("a redelivery re-reads the live commitment: one released meanwhile is not named again", async () => {
    jest.useFakeTimers();
    const s = store({ live: "CMT-1" });
    const { commands } = await send(s, "RESUME");
    expect(commands()[0].commitmentId).toBe("CMT-1");

    s.live = null; // the engine released it before the robot acknowledged
    await jest.advanceTimersByTimeAsync(5_000);

    expect(commands()).toHaveLength(2);
    expect(commands()[1]).toMatchObject({ commandId: "cmd-1", type: "RESUME", commitmentId: null });
  });
});

describe("end to end against VirtualRobot: an obsolete route is never resumed", () => {
  test("the server released the commitment and the RECALL never arrived: the unit stays PAUSED and does not ACK", async () => {
    const { vr, acked } = pausedOnCommitment("CMT-OLD");
    const { commands } = await send(store({ live: null }), "RESUME");

    vr._onCommand(commands()[0]);

    expect(vr.status).toBe("PAUSED");
    expect(vr.task).not.toBeNull(); // nothing is driven; the route is not dropped by a RESUME either
    expect(acked()).toEqual(["cmd-pause"]);
  });

  test("the Leg was reassigned and the unit now holds another commitment: the obsolete route is not resumed", async () => {
    const { vr, acked } = pausedOnCommitment("CMT-OLD");
    const { commands } = await send(store({ live: "CMT-NEW" }), "RESUME");

    vr._onCommand(commands()[0]);

    expect(vr.status).toBe("PAUSED");
    expect(acked()).toEqual(["cmd-pause"]);
  });

  test("a legitimate pause during a live commitment resumes, and is acknowledged", async () => {
    const { vr, acked } = pausedOnCommitment("CMT-1");
    const { commands } = await send(store({ live: "CMT-1" }), "RESUME");

    vr._onCommand(commands()[0]);

    expect(vr.status).toBe("ACTIVE");
    expect(acked()).toEqual(["cmd-pause", "cmd-1"]);
  });

  test("an idle unit held PAUSED still reports IDLE on RESUME (the clear-fault recovery path)", async () => {
    const { vr, acked } = virtualRobot();
    vr.status = "PAUSED";
    const { commands } = await send(store({ live: null }), "RESUME");

    vr._onCommand(commands()[0]);

    expect(vr.status).toBe("IDLE");
    expect(acked()).toEqual(["cmd-1"]);
  });

  test("a STOP latched during a charge is still withdrawn by RESUME", () => {
    const { vr, acked } = virtualRobot();
    vr.status = "CHARGING";
    vr._stopLatched = true;

    vr._onCommand({ commandId: "cmd-r", type: "RESUME", commitmentId: null });

    expect(vr.status).toBe("CHARGING");
    expect(vr._stopLatched).toBe(false);
    expect(acked()).toEqual(["cmd-r"]);
  });

  test("a RESUME from an older server, without the field, behaves as before", () => {
    const { vr, acked } = pausedOnCommitment("CMT-OLD");
    vr._onCommand({ commandId: "cmd-legacy", type: "RESUME" });
    expect(vr.status).toBe("ACTIVE");
    expect(acked()).toEqual(["cmd-pause", "cmd-legacy"]);
  });

  test("a refused RESUME is not recorded as applied, so a corrected redelivery of it is decided afresh", () => {
    const { vr, acked } = pausedOnCommitment("CMT-1");
    vr._onCommand({ commandId: "cmd-r", type: "RESUME", commitmentId: "CMT-OTHER" });
    expect(vr.status).toBe("PAUSED");

    vr._onCommand({ commandId: "cmd-r", type: "RESUME", commitmentId: "CMT-1" });
    expect(vr.status).toBe("ACTIVE");
    expect(acked()).toEqual(["cmd-pause", "cmd-r"]);
  });
});

"use strict";

/**
 * Task completion maps to the Task, not to the Leg (P0-10).
 *
 * ── The defect this closes ──────────────────────────────────────────────────
 * A `Leg` is the unit of assignment and a `Task` is the unit of customer-visible work
 * (§2.4). The agent reported `plan.legId || commitmentId` and `dtaro.handler` matched on
 * `Task.taskId`, so the `updateMany` matched **zero rows**: the mission finished on the
 * agent, the Task stayed `ASSIGNED` forever, the robot stayed bound to it, and nothing
 * anywhere recorded that the completion had gone nowhere.
 *
 * It is closed at both ends, and both ends are tested here:
 *
 *   * the **producer** — the offer envelope now carries `taskId` (§11.2's content, one
 *     field wider), and the agent prefers it;
 *   * the **consumer** — `dtaro.handler` resolves an identifier that is not a Task through
 *     §2.8's `Task >──< Mission >──< Leg`, so firmware built against the older envelope
 *     still completes correctly.
 */

const VirtualRobot = require("../../src/simulation/VirtualRobot");
const offers = require("../../src/engine/dispatch/offers");
const { resolveCompletedTaskId } = require("../../src/sockets/handlers/dtaro.handler");
const { createMockPrisma } = require("../helpers/mockPrisma");

const ROBOT_ID = "vr-completion-1";

function makeAgent() {
  const emitted = [];
  const robot = new VirtualRobot({
    robotId: ROBOT_ID,
    lat: 12.906,
    lon: 77.499,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    kv: null,
  });
  robot.socket = { connected: true, emit: (event, payload) => emitted.push({ event, payload }), on() {}, disconnect() {} };
  robot.connected = true;
  robot.emitted = emitted;
  return robot;
}

const PATH_TO_PICKUP = [
  { lat: 12.906, lon: 77.499 },
  { lat: 12.9071, lon: 77.5001 },
  { lat: 12.9081, lon: 77.5012 },
];
const PATH_TO_DROP = [
  { lat: 12.9081, lon: 77.5012 },
  { lat: 12.9093, lon: 77.5028 },
  { lat: 12.9105, lon: 77.5044 },
];

function offerEnvelope(payload) {
  return {
    commitmentId: "CMT-1",
    fence: 5n,
    payload: {
      legId: "LEG-TSK-1",
      stopSequence: [
        { sequence: 0, stopType: "PICKUP", path: PATH_TO_PICKUP },
        { sequence: 1, stopType: "DROP", path: PATH_TO_DROP },
      ],
      ...payload,
    },
  };
}

describe("the offer envelope carries the Task id (§11.2's content, one field wider)", () => {
  test("buildOfferPayload passes taskId through", () => {
    const payload = offers.buildOfferPayload({
      commitmentId: "CMT-1",
      fence: 3n,
      legId: "leg-row-1",
      taskId: "TSK-1",
      offerExpiry: new Date(Date.now() + 60_000),
    });
    expect(payload.taskId).toBe("TSK-1");
  });

  test("an offer that names no Task carries null rather than a fabricated identifier", () => {
    const payload = offers.buildOfferPayload({
      commitmentId: "CMT-1",
      fence: 3n,
      offerExpiry: new Date(Date.now() + 60_000),
    });
    expect(payload.taskId).toBeNull();
  });

  test("every field the pre-existing envelope carried is unchanged", () => {
    const payload = offers.buildOfferPayload({
      commitmentId: "CMT-1",
      fence: 3n,
      legId: "leg-row-1",
      missionPlan: "PLAN-1",
      stopSequence: [{ sequence: 0 }],
      offerExpiry: new Date(1_700_000_000_000),
    });
    expect(payload).toEqual(
      expect.objectContaining({
        commitmentId: "CMT-1",
        fence: "3",
        legId: "leg-row-1",
        missionPlan: "PLAN-1",
        routeReference: null,
        energyReserveParams: null,
        targetSoc: null,
      }),
    );
  });
});

describe("the agent reports the Task it was told about", () => {
  test("prefers payload.taskId over the Leg", () => {
    const agent = makeAgent();
    agent._respondToOffer(offerEnvelope({ taskId: "TSK-1" }));
    expect(agent.task.taskId).toBe("TSK-1");
  });

  test("falls back to the Leg for a server not yet supplying taskId", () => {
    const agent = makeAgent();
    agent._respondToOffer(offerEnvelope({}));
    expect(agent.task.taskId).toBe("LEG-TSK-1");
  });

  test("falls back to the commitment when the offer names neither", () => {
    const agent = makeAgent();
    agent._respondToOffer(offerEnvelope({ legId: null }));
    expect(agent.task.taskId).toBe("CMT-1");
  });

  test("emits TASK_COMPLETE under the Task id it was given", () => {
    const agent = makeAgent();
    agent._respondToOffer(offerEnvelope({ taskId: "TSK-1" }));

    // Drive the phase machine to the end without waiting out the real dwell timers.
    agent.pathIndex = agent.task.pathToPickup.length - 1;
    agent._advanceTask(Date.now());
    agent.waitUntil = 0;
    agent._advanceTask(Date.now());
    agent.pathIndex = agent.task.pathToDrop.length - 1;
    agent._advanceTask(Date.now());
    agent.waitUntil = 0;
    agent._advanceTask(Date.now());

    const completions = agent.emitted.filter((e) => e.event === "TASK_COMPLETE");
    expect(completions).toHaveLength(1);
    expect(completions[0].payload.taskId).toBe("TSK-1");
  });

  test("the fail-closed refusal is untouched: an offer with no geometry is still rejected", () => {
    const agent = makeAgent();
    agent._respondToOffer({
      commitmentId: "CMT-1",
      fence: 5n,
      payload: { taskId: "TSK-1", legId: "LEG-TSK-1", stopSequence: [{ sequence: 0 }, { sequence: 1 }] },
    });

    expect(agent.task).toBeNull();
    const rejections = agent.emitted.filter((e) => e.event === "OFFER_REJECT");
    expect(rejections).toHaveLength(1);
    expect(rejections[0].payload.reason).toBe("NO_EXECUTABLE_PATH:pathToPickup,pathToDrop");
  });
});

describe("the server resolves whatever identifier the agent reported", () => {
  test("a Task id resolves to itself", async () => {
    const prisma = createMockPrisma();
    prisma.task.findUnique.mockResolvedValue({ taskId: "TSK-1" });

    const resolved = await resolveCompletedTaskId(prisma, "TSK-1");
    expect(resolved).toEqual({ taskId: "TSK-1", resolvedFrom: "TASK_ID" });
    expect(prisma.leg.findFirst).not.toHaveBeenCalled();
  });

  test("a Leg id resolves through the Mission to the single Task it discharges", async () => {
    const prisma = createMockPrisma();
    prisma.task.findUnique.mockResolvedValue(null);
    prisma.leg.findFirst.mockResolvedValue({ mission: { tasks: [{ taskId: "TSK-1" }] } });

    const resolved = await resolveCompletedTaskId(prisma, "LEG-TSK-1");
    expect(resolved).toEqual({ taskId: "TSK-1", resolvedFrom: "LEG_VIA_MISSION" });
  });

  test("looks the Leg up under both of its identifiers", async () => {
    const prisma = createMockPrisma();
    prisma.task.findUnique.mockResolvedValue(null);
    prisma.leg.findFirst.mockResolvedValue({ mission: { tasks: [{ taskId: "TSK-1" }] } });

    await resolveCompletedTaskId(prisma, "some-uuid");
    expect(prisma.leg.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { OR: [{ legId: "some-uuid" }, { id: "some-uuid" }] } }),
    );
  });

  test("a Leg discharging several Tasks resolves to none rather than to an arbitrary one", async () => {
    const prisma = createMockPrisma();
    prisma.task.findUnique.mockResolvedValue(null);
    prisma.leg.findFirst.mockResolvedValue({ mission: { tasks: [{ taskId: "TSK-1" }, { taskId: "TSK-2" }] } });

    const resolved = await resolveCompletedTaskId(prisma, "LEG-X");
    expect(resolved).toEqual({ taskId: null, resolvedFrom: "LEG_DISCHARGES_SEVERAL_TASKS" });
  });

  test("an unknown identifier resolves to none, and says so", async () => {
    const prisma = createMockPrisma();
    prisma.task.findUnique.mockResolvedValue(null);
    prisma.leg.findFirst.mockResolvedValue(null);

    expect(await resolveCompletedTaskId(prisma, "nonsense")).toEqual({ taskId: null, resolvedFrom: "UNRESOLVED" });
  });

  test("a completion naming nothing is distinguished from one naming something unknown", async () => {
    const prisma = createMockPrisma();
    expect(await resolveCompletedTaskId(prisma, null)).toEqual({ taskId: null, resolvedFrom: "ABSENT" });
    expect(prisma.task.findUnique).not.toHaveBeenCalled();
  });
});

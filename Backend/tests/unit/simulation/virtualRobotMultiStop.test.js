/**
 * T4 — a mission's **whole** stop sequence is executed.
 *
 * ── The defect this pins ────────────────────────────────────────────────────
 * `_respondToOffer` built its assignment as `stops[0].path` and `stops[1].path` and
 * dropped the rest, and the phase machine was a four-case switch that could only express
 * PICKUP→DROP. So a three-stop plan — the shape §14.6's Charging Scheduler produces when
 * it inserts a charge between pickup and drop — was accepted, executed as its first two
 * stops, and then reported `TASK_COMPLETE`. The payload was still aboard.
 *
 * Every test in the first describe is written so that it **fails** under that truncation:
 * each asserts on a stop the old code could not reach.
 */

const VirtualRobot = require("../../../src/simulation/VirtualRobot");

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** A short traversable path between two points. */
function pathBetween(fromLat, fromLon, toLat, toLon) {
  return [
    { lat: fromLat, lon: fromLon },
    { lat: (fromLat + toLat) / 2, lon: (fromLon + toLon) / 2 },
    { lat: toLat, lon: toLon },
  ];
}

function makeSocket() {
  const emitted = [];
  const listeners = new Map();
  return {
    emitted,
    connected: true,
    emit(event, payload) { emitted.push({ event, payload }); },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    disconnect() { this.connected = false; },
    of(event) { return emitted.filter((e) => e.event === event); },
  };
}

/** An agent ready to be driven, with a socket attached and no timer running. */
function makeAgent() {
  const agent = new VirtualRobot({
    robotId: "SIM-MS",
    lat: 12.900, lon: 77.500,
    logger: silentLogger,
    simulated: true,
    telemetryIntervalMs: 1000,
    specification: {
      massKg: 2, normalSpeedMps: 1.5, maxSpeedMps: 2.5,
      packNominalWh: 300, payloadCapacityKg: 5,
    },
    batteryState: { kappa: 1, kappaSampleCount: 0 },
  });
  agent.socket = makeSocket();
  agent.connected = true;
  agent.battery = 95;
  return agent;
}

/**
 * A three-stop mission: pickup, a charging stop inserted by the scheduler, then the drop.
 * This is the plan shape the old two-stop reader could not represent.
 */
function threeStopPlan() {
  return {
    taskId: "TASK-3",
    stopSequence: [
      { sequence: 0, stopType: "PICKUP", lat: 12.901, lon: 77.501, path: pathBetween(12.900, 77.500, 12.901, 77.501) },
      { sequence: 1, stopType: "CHARGE", lat: 12.902, lon: 77.502, path: pathBetween(12.901, 77.501, 12.902, 77.502) },
      { sequence: 2, stopType: "DROP",   lat: 12.903, lon: 77.503, path: pathBetween(12.902, 77.502, 12.903, 77.503) },
    ],
  };
}

/** Drive the agent until it completes, or until the tick budget runs out. */
function runToCompletion(agent, { maxTicks = 4000 } = {}) {
  let now = Date.now();
  const phasesSeen = [];
  for (let i = 0; i < maxTicks; i += 1) {
    if (!agent.task) break;
    now += 1000;
    phasesSeen.push(agent.phase);
    agent._advanceTask(now);
    // Keep it moving: the EMA needs a non-zero speed to cover ground.
    if (agent.phase && agent.phase.startsWith("TO_")) agent.speed = 2.0;
  }
  return { phasesSeen, completed: agent.socket.of("TASK_COMPLETE") };
}

describe("T4 — a 3+ stop mission executes completely", () => {
  test("all three stops are executed, in order, before TASK_COMPLETE", () => {
    // Assigned through the offer path, which is the producer that carries a stop sequence.
    const fresh = makeAgent();
    fresh._respondToOffer({ commitmentId: "CMT-3", fence: "7", payload: threeStopPlan() });

    expect(fresh.socket.of("OFFER_ACCEPT")).toHaveLength(1);
    expect(fresh.getStatus().stopCount).toBe(3);
    expect(fresh.getStatus().stopTypes).toEqual(["PICKUP", "CHARGE", "DROP"]);

    const { phasesSeen, completed } = runToCompletion(fresh);

    // The decisive assertions: the third stop was reached at all.
    expect(phasesSeen).toContain("TO_CHARGE");
    expect(phasesSeen).toContain("WAIT_CHARGE");
    expect(phasesSeen).toContain("TO_DROP");
    expect(phasesSeen).toContain("WAIT_DROP");
    expect(completed).toHaveLength(1);
    expect(completed[0].payload.taskId).toBe("TASK-3");
  });

  test("REGRESSION: completion never occurs having executed only the first two stops", () => {
    const agent = makeAgent();
    agent._respondToOffer({ commitmentId: "CMT-3", fence: "7", payload: threeStopPlan() });

    let now = Date.now();
    let completedAtStopIndex = null;
    for (let i = 0; i < 4000 && agent.task; i += 1) {
      now += 1000;
      const indexBefore = agent.stopIndex;
      agent._advanceTask(now);
      if (agent.socket.of("TASK_COMPLETE").length > 0 && completedAtStopIndex === null) {
        completedAtStopIndex = indexBefore;
      }
      if (agent.phase && agent.phase.startsWith("TO_")) agent.speed = 2.0;
    }

    // Under the old `stops[0]` / `stops[1]` truncation this fired at index 1.
    expect(agent.socket.of("TASK_COMPLETE")).toHaveLength(1);
    expect(completedAtStopIndex).toBe(2);
  });

  test("the drop is genuinely visited — the agent ends at the last stop's coordinates", () => {
    const agent = makeAgent();
    agent._respondToOffer({ commitmentId: "CMT-3", fence: "7", payload: threeStopPlan() });
    runToCompletion(agent);

    // Truncating after the charge stop would leave it at 12.902 / 77.502.
    expect(agent.lat).toBeCloseTo(12.903, 5);
    expect(agent.lon).toBeCloseTo(77.503, 5);
  });

  test("custody tracks the sequence: carried after pickup, released after the drop", () => {
    const agent = makeAgent();
    agent._respondToOffer({ commitmentId: "CMT-3", fence: "7", payload: { ...threeStopPlan(), payloadMassKg: 4 } });

    let now = Date.now();
    let carriedDuringCharge = null;
    for (let i = 0; i < 4000 && agent.task; i += 1) {
      now += 1000;
      agent._advanceTask(now);
      if (agent.phase === "TO_DROP" && carriedDuringCharge === null) {
        carriedDuringCharge = agent._carryingPayload;
      }
      if (agent.phase && agent.phase.startsWith("TO_")) agent.speed = 2.0;
    }

    // Still holding the payload while leaving the charge stop — which is exactly why
    // completing there would have been a false delivery.
    expect(carriedDuringCharge).toBe(true);
    expect(agent._carryingPayload).toBe(false);
  });

  test("a charge stop is executed and recorded, and no charge is invented at it", () => {
    const agent = makeAgent();
    const batteryBefore = agent.battery;
    agent._respondToOffer({ commitmentId: "CMT-3", fence: "7", payload: threeStopPlan() });
    runToCompletion(agent);

    expect(agent.getStatus().chargeStopsVisited).toBe(1);
    // The Charging Scheduler is out of scope for this batch, so visiting a charge stop
    // must not manufacture charge against a target nobody published.
    expect(agent.battery).toBeLessThanOrEqual(batteryBefore);
  });

  test("a five-stop mission works too — nothing is hard-coded to three", () => {
    const agent = makeAgent();
    const stops = [];
    for (let i = 0; i < 5; i += 1) {
      const fromLat = 12.900 + i * 0.001;
      const toLat = 12.900 + (i + 1) * 0.001;
      stops.push({
        sequence: i,
        stopType: i === 0 ? "PICKUP" : i === 4 ? "DROP" : "CHARGE",
        lat: toLat, lon: 77.500,
        path: pathBetween(fromLat, 77.500, toLat, 77.500),
      });
    }

    agent._respondToOffer({ commitmentId: "CMT-5", fence: "9", payload: { taskId: "TASK-5", stopSequence: stops } });
    expect(agent.getStatus().stopCount).toBe(5);

    runToCompletion(agent);
    expect(agent.socket.of("TASK_COMPLETE")).toHaveLength(1);
    expect(agent.lat).toBeCloseTo(12.905, 5);
  });
});

describe("T4 — executability is assessed over every stop", () => {
  test("a three-stop plan whose THIRD stop has no route is rejected, not truncated", () => {
    const agent = makeAgent();
    const plan = threeStopPlan();
    plan.stopSequence[2].path = []; // the drop could not be routed

    agent._respondToOffer({ commitmentId: "CMT-X", fence: "7", payload: plan });

    // The old reader never looked at stop 2, so it accepted and drove a mission whose
    // final leg did not exist.
    expect(agent.socket.of("OFFER_ACCEPT")).toHaveLength(0);
    const rejects = agent.socket.of("OFFER_REJECT");
    expect(rejects).toHaveLength(1);
    expect(rejects[0].payload.reason).toBe("NO_EXECUTABLE_PATH:stop2:DROP");
    expect(agent.task).toBeNull();
  });

  test("a plan with no stops at all is refused rather than completing trivially", () => {
    const agent = makeAgent();
    agent._respondToOffer({ commitmentId: "CMT-0", fence: "7", payload: { taskId: "T0", stopSequence: [] } });

    const rejects = agent.socket.of("OFFER_REJECT");
    expect(rejects).toHaveLength(1);
    expect(rejects[0].payload.reason).toMatch(/NO_EXECUTABLE_PATH/);
    expect(agent.socket.of("TASK_COMPLETE")).toHaveLength(0);
  });
});

describe("T4 — the ordinary two-stop mission is unchanged", () => {
  test("a legacy TASK_ASSIGN still walks TO_PICKUP → WAIT_PICKUP → TO_DROP → WAIT_DROP", () => {
    const agent = makeAgent();
    agent._onTaskAssign({
      taskId: "TASK-2",
      pathToPickup: pathBetween(12.900, 77.500, 12.901, 77.501),
      pathToDrop: pathBetween(12.901, 77.501, 12.902, 77.502),
    });

    expect(agent.phase).toBe("TO_PICKUP");
    expect(agent.getStatus().stopCount).toBe(2);

    const { phasesSeen, completed } = runToCompletion(agent);
    expect(phasesSeen).toContain("TO_PICKUP");
    expect(phasesSeen).toContain("WAIT_PICKUP");
    expect(phasesSeen).toContain("TO_DROP");
    expect(phasesSeen).toContain("WAIT_DROP");
    expect(completed).toHaveLength(1);
  });

  test("a two-stop offer keeps the legacy refusal vocabulary", () => {
    const agent = makeAgent();
    agent._respondToOffer({
      commitmentId: "CMT-2", fence: "3",
      payload: {
        taskId: "TASK-2",
        stopSequence: [
          { sequence: 0, stopType: "PICKUP", path: [] },
          { sequence: 1, stopType: "DROP", path: [] },
        ],
      },
    });

    expect(agent.socket.of("OFFER_REJECT")[0].payload.reason)
      .toBe("NO_EXECUTABLE_PATH:pathToPickup,pathToDrop");
  });

  test("a deferred mission keeps all of its stops, not the first two", () => {
    const agent = makeAgent();
    agent.status = "CHARGING";
    agent.battery = 5; // below the interrupt threshold

    agent._onTaskAssign({ taskId: "TASK-3", stops: undefined, ...threeStopPlan() });

    expect(agent.task).toBeNull();
    expect(agent._pendingResume).not.toBeNull();
    expect(agent._pendingResume.stops).toHaveLength(3);
  });
});

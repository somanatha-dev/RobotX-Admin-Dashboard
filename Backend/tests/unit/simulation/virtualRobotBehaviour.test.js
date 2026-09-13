/**
 * STEP 4 — the simulated robot's runtime behaviour.
 *
 * The claim under test is that a simulated robot is a believable, deterministic, *truthful*
 * robot client: it moves along real routes, drains and charges a coherent battery, answers
 * commands exactly once, survives a reconnect, and never reports something that did not
 * happen. Several robots do all of that at once without touching each other's state.
 *
 * ── What is deliberately absent ──────────────────────────────────────────────
 * Nothing here produces a `TASK_ASSIGN`. The Assignment Engine is the only producer, and
 * these tests feed the agent assignments the way the protocol does — an `OFFER` it answers,
 * or a `TASK_ASSIGN` the server dispatched — never by inventing an assignment path. The
 * refusal tests are the ones that matter most in that respect: an agent handed no route
 * must reject, not complete.
 *
 * ── Why the socket double dispatches ─────────────────────────────────────────
 * `tests/engine/dispatchAgentProtocol.test.js` uses a socket that records emissions and
 * delivers nothing, which is right for testing the agent's *answers*. Two of Step 4's
 * findings are about delivery itself — one event arriving at two registered handlers — so
 * the double here keeps the listener table and can deliver into it. A recording-only socket
 * cannot see that defect at all: the duplicate registration is invisible until something is
 * delivered through it.
 */

const VirtualRobot = require("../../../src/simulation/VirtualRobot");
const { createVirtualRobotSimulator } = require("../../../src/simulation/SimulationEngine");
const { rehydrateSimulatedRobots } = require("../../../src/simulation/rehydrate");
const simulationConfig = require("../../../src/simulation/simulationConfig");
const { createRandom, forkSeed, hashSeed } = require("../../../src/simulation/random");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { createTestKv } = require("../../helpers/testKv");

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** An in-memory stand-in for the agent's non-volatile storage. */
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
    async sadd() {
      return 1;
    },
  };
}

/**
 * A socket that records emissions **and** delivers to whatever the agent registered.
 *
 * `listenerCount` is what makes the reconnect finding visible: the defect is not a wrong
 * answer, it is two handlers where there should be one, and that is a property of the
 * emitter rather than of any single message.
 */
function makeSocket() {
  const emitted = [];
  const listeners = new Map();
  return {
    emitted,
    listeners,
    connected: true,
    emit(event, payload) {
      emitted.push({ event, payload });
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    disconnect() {
      this.connected = false;
    },
    /** Deliver one event to every registered handler, as socket.io would. */
    deliver(event, payload) {
      const handlers = listeners.get(event) || [];
      return handlers.map((handler) => handler(payload));
    },
    listenerCount(event) {
      return (listeners.get(event) || []).length;
    },
    of(event) {
      return emitted.filter((entry) => entry.event === event);
    },
    clear() {
      emitted.length = 0;
    },
  };
}

/** A simulated agent already past AUTH, with its socket attached. */
function makeAgent(overrides = {}) {
  const socket = overrides.socket || makeSocket();
  const robot = new VirtualRobot({
    robotId: "SIM-BEHAVIOUR-1",
    lat: 12.9,
    lon: 77.5,
    logger: silentLogger,
    kv: overrides.kv || makeFlash(),
    simulated: true,
    ...overrides,
    socket: undefined,
  });
  robot.socket = socket;
  robot.connected = true;
  return { robot, socket };
}

/**
 * A real two-leg route. Fixture geometry, standing for what the route producer attaches —
 * deliberately not a straight line between the stops, because a straight line is not a
 * route and this suite must not normalise inventing one.
 */
function routeToPickup() {
  return [
    { lat: 12.9000, lon: 77.5000 },
    { lat: 12.9012, lon: 77.5009 },
    { lat: 12.9025, lon: 77.5015 },
    { lat: 12.9039, lon: 77.5026 },
  ];
}

function routeToDrop() {
  return [
    { lat: 12.9039, lon: 77.5026 },
    { lat: 12.9051, lon: 77.5038 },
    { lat: 12.9066, lon: 77.5049 },
  ];
}

function executableAssignment(taskId = "TSK-1") {
  return { taskId, pathToPickup: routeToPickup(), pathToDrop: routeToDrop() };
}

/**
 * A monotonic simulated clock.
 *
 * Held as an object rather than recreated per call because the robot's own state machine
 * reads wall time — `waitUntil`, the docking delay, §18.5's continuation limit — so a
 * driver that restarted the clock on every call would freeze those timers while still
 * advancing position and battery. (It did, in the first draft of this file: the pickup wait
 * never elapsed, so no mission ever completed and the failure looked like a movement defect
 * rather than a test-harness one.)
 */
function makeClock(startMs = 1_700_000_000_000) {
  let now = startMs;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
    },
    /** Run `fn` with `Date.now` pinned to the current simulated instant. */
    at(fn) {
      const realNow = Date.now;
      Date.now = () => now;
      try {
        return fn();
      } finally {
        Date.now = realNow;
      }
    },
  };
}

/** Drive one robot for `ticks` ticks at a fixed cadence, as its interval timer would. */
function runTicks(robot, ticks, { intervalMs = 2000, clock = makeClock() } = {}) {
  for (let i = 0; i < ticks; i++) {
    clock.advance(intervalMs);
    clock.at(() => robot._tick());
  }
  return clock;
}

/**
 * Drive several robots on **one** shared clock, which is what several interval timers in one
 * process actually do: they interleave in real time, they do not each get their own.
 */
function driveTogether(robots, ticks, { intervalMs = 2000 } = {}) {
  const clock = makeClock();
  for (let i = 0; i < ticks; i++) {
    clock.advance(intervalMs);
    clock.at(() => {
      for (const robot of robots) robot._tick();
    });
  }
  return clock;
}

/** A Prisma stand-in whose Robot table is the given rows. */
function prismaWithRobots(rows) {
  const prisma = createMockPrisma();
  prisma.robot.findMany.mockImplementation(async ({ where } = {}) => {
    if (where && where.simulated === true) return rows.filter((row) => row.simulated === true);
    return rows;
  });
  prisma.robot.findUnique.mockImplementation(
    async ({ where } = {}) => rows.find((row) => row.robotId === where?.robotId) || null,
  );
  return prisma;
}

// ═══════════════════════════════════════════════════════════════════════════
// A / B / C — several robots at once, with independent state and telemetry
// ═══════════════════════════════════════════════════════════════════════════

describe("Step 4 A–C — multiple simulated robots run independently", () => {
  test("one engine holds three robots, each with its own VirtualRobot instance", async () => {
    const rows = [
      { robotId: "SIM-001", lat: 12.90, lon: 77.50, simulated: true, battery: 80 },
      { robotId: "SIM-002", lat: 12.91, lon: 77.51, simulated: true, battery: 60 },
      { robotId: "SIM-003", lat: 12.92, lon: 77.52, simulated: true, battery: 40 },
    ];
    const { kv, close } = await createTestKv();
    try {
      const engine = createVirtualRobotSimulator({
        prisma: prismaWithRobots(rows),
        kv,
        serverUrl: "http://127.0.0.1:0",
        logger: silentLogger,
        enabled: true,
      });
      engine.start();

      for (const row of rows) {
        const verdict = await engine.addRobot({ robotId: row.robotId, lat: row.lat, lon: row.lon, simulated: true });
        expect(verdict.started).toBe(true);
      }

      const status = engine.getStatus();
      expect(status.robotCount).toBe(3);
      expect(status.runningCount).toBe(3);
      expect(status.robots.map((entry) => entry.robotId).sort()).toEqual(["SIM-001", "SIM-002", "SIM-003"]);

      // Each restored its own battery from its own row — no shared value, and no default.
      const byId = Object.fromEntries(status.robots.map((entry) => [entry.robotId, entry]));
      expect(byId["SIM-001"].battery).toBeCloseTo(80, 1);
      expect(byId["SIM-002"].battery).toBeCloseTo(60, 1);
      expect(byId["SIM-003"].battery).toBeCloseTo(40, 1);

      // ...and its own session credential. One shared key would be the Step 1 hazard
      // reappearing between simulated units rather than between simulated and physical.
      const tokens = await Promise.all(rows.map((row) => kv.get(`session:${row.robotId}`)));
      expect(new Set(tokens).size).toBe(3);
      expect(tokens.every((token) => typeof token === "string" && token.length > 0)).toBe(true);

      engine.stop();
    } finally {
      await close();
    }
  });

  test("driving one robot's mission leaves the other two untouched", () => {
    const agents = ["SIM-A", "SIM-B", "SIM-C"].map((robotId) => {
      const { robot, socket } = makeAgent({ robotId, lat: 12.9, lon: 77.5 });
      robot.battery = 70;
      return { robotId, robot, socket };
    });

    const [driven, ...idle] = agents;
    driven.robot._onTaskAssign(executableAssignment("TSK-DRIVEN"));
    runTicks(driven.robot, 30);

    // The driven one moved, spent charge and has a task.
    expect(driven.robot.distanceTravelled).toBeGreaterThan(0);
    expect(driven.robot.battery).toBeLessThan(70);
    expect(driven.robot.getStatus().telemetrySequence).toBe(30);

    // The others did not tick at all, so nothing about them changed.
    for (const other of idle) {
      expect(other.robot.distanceTravelled).toBe(0);
      expect(other.robot.battery).toBe(70);
      expect(other.robot.task).toBeNull();
      expect(other.robot.lat).toBe(12.9);
      expect(other.robot.lon).toBe(77.5);
      expect(other.robot.getStatus().telemetrySequence).toBe(0);
      expect(other.socket.of("TELEMETRY")).toHaveLength(0);
    }
  });

  test("three robots ticking together each emit their own telemetry stream", () => {
    const agents = ["SIM-A", "SIM-B", "SIM-C"].map((robotId, index) => {
      const { robot, socket } = makeAgent({ robotId, lat: 12.9 + index * 0.01, lon: 77.5 });
      robot.battery = 90 - index * 10;
      robot._onTaskAssign(executableAssignment(`TSK-${robotId}`));
      return { robotId, robot, socket };
    });

    // Interleaved on one clock, which is how three interval timers in one process run.
    driveTogether(agents.map((agent) => agent.robot), 12);

    for (const agent of agents) {
      const frames = agent.socket.of("TELEMETRY");
      expect(frames).toHaveLength(12);
      // Every frame names its own robot...
      expect(new Set(frames.map((frame) => frame.payload.robotId))).toEqual(new Set([agent.robotId]));
      // ...and carries a per-robot ordinal that starts at 1 and never repeats or skips.
      expect(frames.map((frame) => frame.payload.sequence)).toEqual([...Array(12)].map((_, i) => i + 1));
      // Each frame's timestamp is the instant its values were computed at, so the stream
      // is monotonic in time as well as in sequence.
      const stamps = frames.map((frame) => frame.payload.timestamp);
      expect(stamps.every((stamp, i) => i === 0 || stamp > stamps[i - 1])).toBe(true);
    }

    // The three ended in different places with different charge: no state was shared.
    const positions = agents.map((agent) => `${agent.robot.lat},${agent.robot.lon}`);
    expect(new Set(positions).size).toBe(3);
    const batteries = agents.map((agent) => agent.robot.battery);
    expect(new Set(batteries).size).toBe(3);
  });

  test("a robot's movement trace does not depend on how many other robots exist", () => {
    // The coupling the seeded streams removed. With one shared `Math.random()`, draw order
    // decides who gets which number, so the second robot's speed trace changed when a third
    // robot was added — robots sharing mutable state through the generator.
    const traceOf = (peers) => {
      const agents = [...Array(peers)].map((_, index) => {
        const { robot } = makeAgent({ robotId: `SIM-PEER-${index}`, lat: 12.9, lon: 77.5 });
        robot.battery = 80;
        robot._onTaskAssign(executableAssignment(`TSK-${index}`));
        return robot;
      });
      const subject = agents[0];
      driveTogether(agents, 15);
      return subject.socket.of("TELEMETRY").map((frame) => frame.payload.speed);
    };

    expect(traceOf(3)).toEqual(traceOf(1));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Determinism — the seeded streams
// ═══════════════════════════════════════════════════════════════════════════

describe("Step 4 — simulation randomness is seeded, per robot, and reproducible", () => {
  test("the same robot id produces the same trace on a fresh instance", () => {
    const traceOf = () => {
      const { robot, socket } = makeAgent({ robotId: "SIM-DETERMINISTIC" });
      robot.battery = 75;
      robot._onTaskAssign(executableAssignment());
      runTicks(robot, 20);
      return socket.of("TELEMETRY").map((frame) => [frame.payload.speed, frame.payload.lat, frame.payload.lon]);
    };
    expect(traceOf()).toEqual(traceOf());
  });

  test("two different robot ids produce different traces", () => {
    // A seed that did not separate near-identical identifiers would make the fleet move in
    // lockstep, which looks like a bug on a dashboard even though every value is legal.
    const traceOf = (robotId) => {
      const { robot, socket } = makeAgent({ robotId });
      robot.battery = 75;
      robot._onTaskAssign(executableAssignment());
      runTicks(robot, 20);
      return socket.of("TELEMETRY").map((frame) => frame.payload.speed);
    };
    expect(traceOf("SIM-000000000001")).not.toEqual(traceOf("SIM-000000000002"));
  });

  test("no simulation behaviour reads the global Math.random", () => {
    // A structural guard, because the property is an absence. The two draws that used it
    // were speed jitter and the obstacle report; a third one added later would reintroduce
    // both the irreproducibility and the cross-robot coupling.
    const source = require("fs").readFileSync(
      require("path").join(__dirname, "..", "..", "..", "src", "simulation", "VirtualRobot.js"),
      "utf8",
    );
    const codeLines = source
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\*|\/\/)/.test(line))
      .filter((line) => /Math\.random/.test(line));
    expect(codeLines).toEqual([]);
  });

  test("the speed and obstacle streams are independent of each other", () => {
    // Sharing one stream would make the speed trace depend on whether an obstacle was
    // reported, so an obstacle test would silently change a movement test.
    const traceOf = (obstacleProbability) => {
      const { robot, socket } = makeAgent({ robotId: "SIM-STREAMS", obstacleProbability });
      robot.battery = 80;
      robot._onTaskAssign(executableAssignment());
      runTicks(robot, 25);
      return socket.of("TELEMETRY").map((frame) => frame.payload.speed);
    };
    // Obstacles on for one run, off for the other. Same speeds either way.
    expect(traceOf(1)).toEqual(traceOf(0));
  });

  test("a configured seed is still offset per robot, so a fleet does not move in lockstep", async () => {
    const rows = [
      { robotId: "SIM-S1", lat: 12.9, lon: 77.5, simulated: true, battery: 80 },
      { robotId: "SIM-S2", lat: 12.9, lon: 77.5, simulated: true, battery: 80 },
    ];
    const engine = createVirtualRobotSimulator({
      prisma: prismaWithRobots(rows),
      kv: makeFlash(),
      serverUrl: "http://127.0.0.1:0",
      logger: silentLogger,
      enabled: true,
    });
    engine.setConfig({ randomSeed: 4242 });
    // Not started, so nothing connects; the constructed seeds are what is under test.
    await engine.addRobot({ robotId: "SIM-S1", lat: 12.9, lon: 77.5, simulated: true });
    await engine.addRobot({ robotId: "SIM-S2", lat: 12.9, lon: 77.5, simulated: true });

    const seeds = engine.getStatus().robots.map((entry) => entry.randomSeed);
    expect(seeds).toHaveLength(2);
    expect(seeds[0]).not.toBe(seeds[1]);
    // ...and each is the configured seed mixed with the robot's own identifier.
    expect(seeds[0]).toBe((4242 ^ hashSeed("SIM-S1")) >>> 0);
  });

  test("the generator itself is a pure function of its seed", () => {
    const a = createRandom(forkSeed("SIM-X", "speed"));
    const b = createRandom(forkSeed("SIM-X", "speed"));
    const drawsA = [...Array(8)].map(() => a());
    const drawsB = [...Array(8)].map(() => b());
    expect(drawsA).toEqual(drawsB);
    expect(drawsA.every((value) => value >= 0 && value < 1)).toBe(true);
    // Not a constant, and not obviously degenerate.
    expect(new Set(drawsA).size).toBe(8);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D — movement along a real route
// ═══════════════════════════════════════════════════════════════════════════

describe("Step 4 D — movement follows the route it was given", () => {
  test("the robot progresses along the polyline, updates heading and speed, and finishes the leg", () => {
    const { robot, socket } = makeAgent({ robotId: "SIM-MOVE" });
    robot.battery = 90;
    robot._onTaskAssign(executableAssignment());

    expect(robot.status).toBe("ACTIVE");
    expect(robot.phase).toBe("TO_PICKUP");
    // Snapped onto the route rather than driving to it across country.
    expect(robot.lat).toBeCloseTo(12.9000, 4);

    const clock = makeClock();
    const seen = [];
    for (let tick = 0; tick < 40; tick++) {
      runTicks(robot, 1, { clock });
      seen.push({ lat: robot.lat, lon: robot.lon, phase: robot.phase });
    }

    // Position changed monotonically northward along this route.
    const lats = seen.map((entry) => entry.lat);
    expect(lats[lats.length - 1]).toBeGreaterThan(lats[0]);
    expect(robot.distanceTravelled).toBeGreaterThan(0);

    // Speed ramped up under the EMA and stayed inside the model's bounds.
    const speeds = socket.of("TELEMETRY").map((frame) => frame.payload.speed);
    expect(Math.max(...speeds)).toBeGreaterThan(4);
    expect(Math.max(...speeds)).toBeLessThanOrEqual(8.33);

    // Heading is reported and is a compass bearing.
    const headings = socket.of("TELEMETRY").map((frame) => frame.payload.heading).filter((h) => h !== null);
    expect(headings.length).toBeGreaterThan(0);
    expect(headings.every((h) => h >= 0 && h < 360)).toBe(true);

    // The leg was actually finished — the phase machine advanced past TO_PICKUP.
    expect(seen.some((entry) => entry.phase !== "TO_PICKUP")).toBe(true);
  });

  test("a whole mission completes exactly once, and only after travelling", () => {
    const { robot, socket } = makeAgent({ robotId: "SIM-MISSION" });
    robot.battery = 95;
    robot._onTaskAssign(executableAssignment("TSK-FULL"));

    const clock = makeClock();
    let ticks = 0;
    while (ticks < 400 && socket.of("TASK_COMPLETE").length === 0) {
      runTicks(robot, 1, { clock });
      ticks += 1;
    }

    const complete = socket.of("TASK_COMPLETE");
    expect(complete).toHaveLength(1);
    expect(complete[0].payload).toMatchObject({ taskId: "TSK-FULL" });
    expect(robot.distanceTravelled).toBeGreaterThan(0);
    // Ended at the drop, and went back to IDLE with no task held.
    expect(robot.lat).toBeCloseTo(12.9066, 3);
    expect(robot.lon).toBeCloseTo(77.5049, 3);
    expect(robot.status).toBe("IDLE");
    expect(robot.task).toBeNull();

    // Ticking on does not produce a second completion.
    runTicks(robot, 20, { clock });
    expect(socket.of("TASK_COMPLETE")).toHaveLength(1);
  });

  test("a configured tick period moves the robot by that period's worth of travel", () => {
    // The coherence property: speed, position and timestamp must agree. A 4-second tick
    // that budgeted 2 seconds of distance would report a speed the robot was not making.
    const distanceAfter = (intervalMs, ticks) => {
      const { robot } = makeAgent({ robotId: "SIM-CADENCE", telemetryIntervalMs: intervalMs });
      robot.battery = 90;
      robot._onTaskAssign(executableAssignment());
      runTicks(robot, ticks, { intervalMs });
      return robot.distanceTravelled;
    };

    // Same elapsed simulated time, two cadences: the same ground covered, within the
    // tolerance the EMA's ramp-up allows.
    const slow = distanceAfter(4000, 10);
    const fast = distanceAfter(2000, 20);
    expect(slow).toBeGreaterThan(fast * 0.85);
    expect(slow).toBeLessThan(fast * 1.15);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E / F — battery and charging
// ═══════════════════════════════════════════════════════════════════════════

describe("Step 4 E — battery drains coherently and never goes out of range", () => {
  test("an active robot drains faster than an idle one, and neither goes negative", () => {
    const { robot: active } = makeAgent({ robotId: "SIM-ACTIVE" });
    active.battery = 50;
    active._onTaskAssign(executableAssignment());
    runTicks(active, 100);

    const { robot: idle } = makeAgent({ robotId: "SIM-IDLE" });
    idle.battery = 50;
    runTicks(idle, 100);

    expect(active.battery).toBeLessThan(50);
    expect(idle.battery).toBeLessThan(50);
    expect(50 - active.battery).toBeGreaterThan(50 - idle.battery);
    expect(active.battery).toBeGreaterThan(0);
    expect(idle.battery).toBeGreaterThan(0);
  });

  test("the battery floors at the model's minimum rather than going negative", () => {
    // Driven through `_applyBattery` directly, because a *ticking* robot at this level does
    // not stay there: an idle robot below the critical threshold docks and charges, which is
    // the correct behaviour and is asserted separately. The clamp is the unit under test.
    const { robot } = makeAgent({ robotId: "SIM-FLOOR" });
    robot.battery = 5.2;
    for (let i = 0; i < 500; i++) robot._applyBattery();
    expect(robot.battery).toBe(5);
  });

  test("a robot below the critical threshold with no task docks instead of draining on", () => {
    // The counterpart: the model's response to a depleted pack is to charge, not to keep
    // reporting a robot that is somehow still working at 5 %.
    const { robot } = makeAgent({ robotId: "SIM-DEPLETED" });
    robot.battery = 6;
    runTicks(robot, 2);
    expect(robot.status).toBe("CHARGING");
    expect(robot.speed).toBe(0);
  });

  test("a robot with an active task does NOT dock, and floors while still under way", () => {
    // A known limitation, stated as a test rather than left to be discovered: `_enterCharging`
    // requires `phase === null`, so a robot mid-mission drives on at the floor instead of
    // docking. Recorded here so the behaviour is deliberate and visible, not accidental.
    const { robot } = makeAgent({ robotId: "SIM-TASKED-LOW" });
    robot.battery = 6;
    robot._onTaskAssign(executableAssignment());
    runTicks(robot, 30);

    expect(robot.status).not.toBe("CHARGING");
    expect(robot.battery).toBeGreaterThanOrEqual(5);
  });

  test("the drain rate is per unit of time, not per tick", () => {
    // `constants.js` documents the two rates as wall-clock durations ("100 % → 20 % in one
    // hour"). A robot ticking twice as often must not deplete twice as fast, or the
    // constants' stated meaning is false for every configured cadence.
    const drainOver = (intervalMs, ticks) => {
      const { robot } = makeAgent({ robotId: "SIM-RATE", telemetryIntervalMs: intervalMs });
      robot.battery = 80;
      runTicks(robot, ticks, { intervalMs });
      return 80 - robot.battery;
    };
    expect(drainOver(1000, 40)).toBeCloseTo(drainOver(2000, 20), 5);
  });

  test("a robot below the warning threshold while working reports ISSUES and keeps moving", () => {
    const { robot } = makeAgent({ robotId: "SIM-LOW" });
    robot.battery = 19;
    robot._onTaskAssign(executableAssignment());
    const before = robot.distanceTravelled;
    runTicks(robot, 10);

    expect(robot.status).toBe("ISSUES");
    // ISSUES means "navigating on low charge", not "halted" — it must still travel.
    expect(robot.distanceTravelled).toBeGreaterThan(before);
  });
});

describe("Step 4 F — charging follows the shared curve and never runs backwards", () => {
  test("a critically low idle robot docks, waits, then charges toward the target", () => {
    const { robot } = makeAgent({ robotId: "SIM-CHARGE" });
    robot.battery = 9;

    runTicks(robot, 1);
    expect(robot.status).toBe("CHARGING");
    expect(robot._chargingPhase).toBe("WAITING");

    // The docking wait is 30 s; nothing flows before it elapses.
    const duringWait = robot.battery;
    runTicks(robot, 5);
    expect(robot.battery).toBeCloseTo(duringWait, 5);

    // Past the wait, current flows and the level rises.
    runTicks(robot, 20);
    expect(robot._chargingPhase).toBe("CHARGING");
    expect(robot.battery).toBeGreaterThan(duringWait);
  });

  test("charging is nonlinear — the same increment takes longer near the top of the pack", () => {
    // §14.6's shape, through the same `chargeCurve` module the server plans with. A linear
    // rate would make these two equal.
    const stepAt = (soc) => {
      const { robot } = makeAgent({ robotId: "SIM-CURVE" });
      robot.battery = soc;
      return robot._chargeStepPercent();
    };
    expect(stepAt(40)).toBeGreaterThan(stepAt(95));
  });

  test("charging stops at the published target and does not exceed 100 %", () => {
    const { robot } = makeAgent({ robotId: "SIM-TARGET" });
    robot.battery = 9;
    robot._publishedTargetSoc = 0.5; // published by an offer

    runTicks(robot, 600);
    expect(robot.battery).toBeLessThanOrEqual(50 + 1e-9);
    expect(robot.status).toBe("IDLE");

    const { robot: full } = makeAgent({ robotId: "SIM-FULL" });
    full.battery = 9;
    full._publishedTargetSoc = 1;
    runTicks(full, 5000);
    expect(full.battery).toBeLessThanOrEqual(100);
  });

  test("a charge session never LOWERS the battery to reach a lower published target", () => {
    // The Step 4 finding. `_handleCharging` computed `min(target, battery + step)` with no
    // floor at the present level, and the target is an *input* — §14.6 gives it to the
    // Charging Scheduler and the agent adopts whatever an offer published. A target below
    // the pack's state of charge therefore discharged it to the target in one tick, and
    // reported the drop as charging: a pack losing ten points while docked.
    const { robot } = makeAgent({ robotId: "SIM-REGRESSION" });
    robot.battery = 90;
    robot._publishedTargetSoc = 0.4; // 40 %, well below where the pack is
    robot.status = "CHARGING";
    robot._chargingPhase = "CHARGING";

    // The charging step itself, in isolation: it may raise the level or leave it, never lower
    // it. Before the fix this single call took the pack from 90 % to 40 %.
    const before = robot.battery;
    robot._handleCharging(Date.now());
    expect(robot.battery).toBeGreaterThanOrEqual(before);
    // The session finishes at the level actually reached, not snapped down to the target.
    expect(robot.battery).toBeCloseTo(90, 5);
    expect(robot.status).toBe("IDLE");

    // And across full ticks the pack is nowhere near the low target: what little it loses is
    // ordinary idle drain *after* the session ended, which is a different mechanism.
    runTicks(robot, 5);
    expect(robot.battery).toBeGreaterThan(89.5);
  });

  test("battery survives a restart through the persistence key", async () => {
    const flash = makeFlash();
    const { robot } = makeAgent({ robotId: "SIM-PERSIST", kv: flash });
    await robot.commission(flash);
    robot.battery = 43.7;
    // Force the periodic snapshot.
    robot._batteryPersistTicks = 10_000;
    robot._maybePersistBattery();
    await Promise.resolve();

    // A fresh instance for the same robot restores that level rather than starting at 100.
    const { robot: restarted } = makeAgent({ robotId: "SIM-PERSIST", kv: flash, dbBattery: 12 });
    await restarted.commission(flash);
    expect(restarted.battery).toBeCloseTo(43.7, 1);
  });

  test("a configured initialBattery is the fallback for a fresh robot, never an override", async () => {
    // Ordering matters: Redis → DB → configured → 100. Letting configuration win would make
    // every restart reset the pack, which is a charge that never happened.
    const flash = makeFlash();
    const { robot: fresh } = makeAgent({ robotId: "SIM-INIT-A", kv: flash, initialBattery: 55 });
    await fresh.commission(flash);
    expect(fresh.battery).toBeCloseTo(55, 5);

    const persisted = makeFlash();
    await persisted.set("vr:battery:SIM-INIT-B", "31.5");
    const { robot: restored } = makeAgent({ robotId: "SIM-INIT-B", kv: persisted, initialBattery: 55 });
    await restored.commission(persisted);
    expect(restored.battery).toBeCloseTo(31.5, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G / H / I — reconnect, command/ACK, deduplication
// ═══════════════════════════════════════════════════════════════════════════

describe("Step 4 G — a reconnect does not duplicate the agent's handlers", () => {
  test("handlers are registered once per socket, however many sessions run on it", () => {
    const { robot, socket } = makeAgent({ robotId: "SIM-RECONNECT" });

    robot._registerHandlers();
    expect(socket.listenerCount("COMMAND")).toBe(1);

    // Two drop/reconnect cycles. socket.io-client reuses this same `Socket` object and
    // re-emits `connect`, so AUTH_SUCCESS → `_registerHandlers` runs again on the same
    // emitter; clearing `_handlersRegistered` is exactly what the old `disconnect` handler
    // did, so these four lines are the defect's own sequence. Against the defective version
    // the counts below are 3, not 1.
    for (let session = 0; session < 2; session++) {
      socket.connected = false;
      robot._handlersRegistered = false;
      socket.connected = true;
      robot._registerHandlers();
    }

    expect(socket.listenerCount("COMMAND")).toBe(1);
    expect(socket.listenerCount("TASK_ASSIGN")).toBe(1);
    expect(socket.listenerCount("OFFER")).toBe(1);
    expect(socket.listenerCount("STOP")).toBe(1);
  });

  test("one delivered COMMAND is applied once and acknowledged once after a reconnect", () => {
    // The observable half of the same finding. Before the fix this delivered two ACKs for
    // one command — and with `RETURN`, applied the task-clearing effect twice.
    const { robot, socket } = makeAgent({ robotId: "SIM-RECONNECT-2" });
    robot._registerHandlers();

    // Replay precisely what the old `disconnect` handler did — clear the boolean — and then
    // let the next session register, which is what AUTH_SUCCESS does on reconnect. Setting
    // the flag by hand is what makes this a faithful reproduction rather than a restatement:
    // against the defective version this line is the whole defect, and the assertions below
    // then see two acknowledgements for one command.
    robot._handlersRegistered = false;
    robot._registerHandlers();

    robot._onTaskAssign(executableAssignment("TSK-KEEP"));
    socket.clear();

    socket.deliver("COMMAND", { commandId: "cmd-once", type: "STOP" });

    expect(socket.of("COMMAND_ACK")).toHaveLength(1);
    expect(robot.status).toBe("PAUSED");
  });

  test("a fresh socket does get its own handlers", () => {
    // The guard must not be so tight that a genuinely new emitter goes unregistered — that
    // would be an agent that silently stops answering after `stop()`.
    const { robot, socket } = makeAgent({ robotId: "SIM-RECONNECT-3" });
    robot._registerHandlers();
    expect(socket.listenerCount("COMMAND")).toBe(1);

    const replacement = makeSocket();
    robot.socket = replacement;
    robot._registerHandlers();
    expect(replacement.listenerCount("COMMAND")).toBe(1);
  });

  test("stop() clears the registration record so a restarted robot re-registers", () => {
    const { robot } = makeAgent({ robotId: "SIM-RECONNECT-4" });
    robot._registerHandlers();
    robot.stop();
    expect(robot._handlerSocket).toBeNull();
    expect(robot.isRunning()).toBe(false);
  });
});

describe("Step 4 H/I — command, ACK and duplicate suppression", () => {
  test("each command type has its effect and is acknowledged", () => {
    const cases = [
      { type: "STOP", expect: (vr) => expect(vr.status).toBe("PAUSED") },
      { type: "PAUSE", expect: (vr) => expect(vr.task).not.toBeNull() },
      { type: "RETURN", expect: (vr) => expect(vr.task).toBeNull() },
    ];
    cases.forEach(({ type, expect: assert }, index) => {
      const { robot, socket } = makeAgent({ robotId: `SIM-CMD-${index}` });
      robot._onTaskAssign(executableAssignment());
      socket.clear();
      robot._onCommand({ commandId: `cmd-${index}`, type });
      expect(socket.of("COMMAND_ACK")).toHaveLength(1);
      assert(robot);
    });
  });

  test("a redelivered command is re-acknowledged but NOT re-applied", () => {
    // The reliability scheduler re-sends a command it has not seen acknowledged, so this is
    // ordinary traffic rather than an exotic case. Applying `RETURN` twice would abandon a
    // mission accepted in between — the operator's one instruction cancelling a task it was
    // never about.
    const { robot, socket } = makeAgent({ robotId: "SIM-DEDUP" });
    robot._onTaskAssign(executableAssignment("TSK-FIRST"));
    socket.clear();

    robot._onCommand({ commandId: "cmd-return", type: "RETURN" });
    expect(robot.task).toBeNull();
    expect(socket.of("COMMAND_ACK")).toHaveLength(1);

    // A new, legitimate assignment arrives...
    robot._onTaskAssign(executableAssignment("TSK-SECOND"));
    expect(robot.task.taskId).toBe("TSK-SECOND");

    // ...and the redelivery of the old command must not cancel it.
    robot._onCommand({ commandId: "cmd-return", type: "RETURN" });
    expect(robot.task).not.toBeNull();
    expect(robot.task.taskId).toBe("TSK-SECOND");
    // Still answered, because the acknowledgement is the thing that probably went missing.
    expect(socket.of("COMMAND_ACK")).toHaveLength(2);
  });

  test("an unknown command type is neither applied, acknowledged, nor recorded as applied", () => {
    const { robot, socket } = makeAgent({ robotId: "SIM-UNKNOWN" });
    robot._onTaskAssign(executableAssignment());
    socket.clear();

    robot._onCommand({ commandId: "cmd-unknown", type: "SELF_DESTRUCT" });
    expect(socket.of("COMMAND_ACK")).toHaveLength(0);
    expect(robot.getStatus().appliedCommandCount).toBe(0);

    // A redelivery reaches the same refusal rather than being answered from the table.
    robot._onCommand({ commandId: "cmd-unknown", type: "SELF_DESTRUCT" });
    expect(socket.of("COMMAND_ACK")).toHaveLength(0);
  });

  test("a mission command redelivered at the same fence is rejected, not applied twice", async () => {
    // The §10.3.1 surface's own deduplication, unchanged by Step 4 and asserted here so the
    // two command paths are known to be covered rather than assumed to be.
    const flash = makeFlash();
    const { robot } = makeAgent({ robotId: "SIM-FENCE", kv: flash });
    await robot.loadDedupState();

    const envelope = {
      agentId: "SIM-FENCE",
      command: "OFFER",
      commitmentId: "C-1",
      fence: "5",
      sequence: 0,
      payload: { taskId: "TSK-F", stopSequence: [{ path: routeToPickup() }, { path: routeToDrop() }] },
    };

    const first = await robot._onMissionCommand("OFFER", envelope);
    expect(first.applied).toBe(true);

    const before = robot.protocolRejections.length;
    const second = await robot._onMissionCommand("OFFER", envelope);
    expect(second.applied).toBe(false);
    expect(robot.protocolRejections.length).toBe(before + 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// J / K — invalid routes and the absence of false completion
// ═══════════════════════════════════════════════════════════════════════════

describe("Step 4 J/K — no route means refusal, never a completion", () => {
  const unusable = [
    { label: "an empty pickup path", assignment: { taskId: "T", pathToPickup: [], pathToDrop: routeToDrop() } },
    { label: "an empty drop path", assignment: { taskId: "T", pathToPickup: routeToPickup(), pathToDrop: [] } },
    { label: "both paths empty", assignment: { taskId: "T", pathToPickup: [], pathToDrop: [] } },
    {
      label: "a single-point path",
      assignment: { taskId: "T", pathToPickup: [{ lat: 12.9, lon: 77.5 }], pathToDrop: routeToDrop() },
    },
    {
      label: "a path with a non-finite coordinate",
      assignment: {
        taskId: "T",
        pathToPickup: [{ lat: 12.9, lon: 77.5 }, { lat: Number.NaN, lon: 77.5 }],
        pathToDrop: routeToDrop(),
      },
    },
    { label: "a missing path", assignment: { taskId: "T", pathToDrop: routeToDrop() } },
  ];

  test.each(unusable)("$label is refused, and the robot stays IDLE with no task", ({ assignment }) => {
    const { robot, socket } = makeAgent({ robotId: "SIM-NOROUTE" });
    robot._onTaskAssign(assignment);

    expect(robot.task).toBeNull();
    expect(robot.phase).toBeNull();
    expect(robot.status).toBe("IDLE");

    // And it never reports a delivery it did not make, however long it runs.
    runTicks(robot, 200);
    expect(socket.of("TASK_COMPLETE")).toHaveLength(0);
  });

  test("an offer with no route is REJECTED rather than accepted hopefully", async () => {
    const flash = makeFlash();
    const { robot, socket } = makeAgent({ robotId: "SIM-REJECT", kv: flash });
    await robot.loadDedupState();
    robot.battery = 90;

    await robot._onMissionCommand("OFFER", {
      agentId: "SIM-REJECT",
      command: "OFFER",
      commitmentId: "C-NOROUTE",
      fence: "1",
      sequence: 0,
      // Production shape for a stop sequence whose geometry could not be resolved.
      payload: { taskId: "TSK-NOROUTE", stopSequence: [{ stopType: "PICKUP" }, { stopType: "DROP" }] },
    });

    const rejects = socket.of("OFFER_REJECT");
    expect(rejects).toHaveLength(1);
    expect(rejects[0].payload.reason).toMatch(/^NO_EXECUTABLE_PATH:/);
    expect(socket.of("OFFER_ACCEPT")).toHaveLength(0);
    expect(robot.task).toBeNull();

    runTicks(robot, 100);
    expect(socket.of("TASK_COMPLETE")).toHaveLength(0);
  });

  test("an unexecutable assignment is not stashed for later while charging", () => {
    // Deferring it would replay the same refusal once the pack filled, holding a slot for a
    // mission that can never run.
    const { robot } = makeAgent({ robotId: "SIM-NOROUTE-CHARGING" });
    robot.status = "CHARGING";
    robot.battery = 12;

    robot._onTaskAssign({ taskId: "T", pathToPickup: [], pathToDrop: [] });

    expect(robot._pendingResume).toBeNull();
    expect(robot.task).toBeNull();
    expect(robot.status).toBe("CHARGING");
  });

  test("a simulator with no assignment at all completes nothing", () => {
    // §10's boundary, stated as a test: the simulator never fabricates an assignment, so a
    // running robot with no task produces telemetry and no task lifecycle events.
    const { robot, socket } = makeAgent({ robotId: "SIM-NOWORK" });
    robot.battery = 80;
    runTicks(robot, 60);

    expect(socket.of("TELEMETRY").length).toBe(60);
    expect(socket.of("TASK_COMPLETE")).toHaveLength(0);
    expect(socket.of("OFFER_ACCEPT")).toHaveLength(0);
    expect(robot.task).toBeNull();
    expect(robot.status).toBe("IDLE");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L / M / N / O — engine posture, identity, rehydration, coexistence
// ═══════════════════════════════════════════════════════════════════════════

describe("Step 4 L/M — a disabled simulator runs nothing, and a physical row never runs", () => {
  test("a disabled engine refuses every robot and reports itself disabled", async () => {
    const engine = createVirtualRobotSimulator({
      prisma: prismaWithRobots([{ robotId: "SIM-X", simulated: true, battery: 50 }]),
      kv: makeFlash(),
      serverUrl: "http://127.0.0.1:0",
      logger: silentLogger,
      enabled: false,
    });

    const startOutcome = engine.start();
    expect(startOutcome).toMatchObject({ started: false, reason: "SIMULATOR_DISABLED" });

    const verdict = await engine.addRobot({ robotId: "SIM-X", simulated: true });
    expect(verdict).toEqual({ started: false, reason: "SIMULATOR_DISABLED" });
    expect(engine.getStatus()).toMatchObject({ enabled: false, started: false, robotCount: 0, runningCount: 0 });
  });

  test("commission() refuses a target that is not marked simulated, before writing anything", async () => {
    const flash = makeFlash();
    const physical = new VirtualRobot({
      robotId: "PHYS-1",
      lat: 12.9,
      lon: 77.5,
      logger: silentLogger,
      kv: flash,
      // No `simulated: true` — the row is physical.
    });

    await expect(physical.commission(flash)).rejects.toMatchObject({ code: "ROBOT_NOT_SIMULATED" });
    // Not one key written: no session credential minted over the hardware's own.
    expect(flash.values.size).toBe(0);
  });
});

describe("Step 4 N — rehydration restores the simulated half of the fleet only", () => {
  test("a restart re-creates a VirtualRobot for every persisted simulated row", async () => {
    const rows = [
      { robotId: "SIM-R1", lat: 12.90, lon: 77.50, simulated: true, battery: 70 },
      { robotId: "SIM-R2", lat: 12.91, lon: 77.51, simulated: true, battery: 65 },
      { robotId: "SIM-R3", lat: 12.92, lon: 77.52, simulated: true, battery: 60 },
      { robotId: "PHYS-R1", lat: 12.93, lon: 77.53, simulated: false, battery: 55 },
    ];
    const engine = createVirtualRobotSimulator({
      prisma: prismaWithRobots(rows),
      kv: makeFlash(),
      serverUrl: "http://127.0.0.1:0",
      logger: silentLogger,
      enabled: true,
    });
    engine.start();

    const outcome = await rehydrateSimulatedRobots({
      prisma: prismaWithRobots(rows),
      simulator: engine,
      logger: silentLogger,
      enabled: true,
    });

    expect(outcome).toMatchObject({ enabled: true, considered: 3, spawned: 3, refused: [] });
    const status = engine.getStatus();
    expect(status.robotCount).toBe(3);
    expect(status.robots.map((entry) => entry.robotId).sort()).toEqual(["SIM-R1", "SIM-R2", "SIM-R3"]);
    expect(status.robots.every((entry) => entry.simulated === true)).toBe(true);

    engine.stop();
  });

  test("a disabled simulator reads nothing and starts nothing, though the rows exist", async () => {
    const prisma = prismaWithRobots([{ robotId: "SIM-R1", simulated: true, battery: 70 }]);
    const outcome = await rehydrateSimulatedRobots({
      prisma,
      simulator: { addRobot: async () => ({ started: true }) },
      logger: silentLogger,
      enabled: false,
    });

    expect(outcome).toMatchObject({ enabled: false, considered: 0, spawned: 0 });
    expect(prisma.robot.findMany).not.toHaveBeenCalled();
  });
});

describe("Step 4 O — one physical robot and three simulated robots coexist", () => {
  test("the physical row gets no instance, no credential and no simulated twin", async () => {
    const rows = [
      { robotId: "PHYS-1", lat: 12.90, lon: 77.50, simulated: false, battery: 88 },
      { robotId: "SIM-C1", lat: 12.91, lon: 77.51, simulated: true, battery: 70 },
      { robotId: "SIM-C2", lat: 12.92, lon: 77.52, simulated: true, battery: 60 },
      { robotId: "SIM-C3", lat: 12.93, lon: 77.53, simulated: true, battery: 50 },
    ];
    const { kv, close } = await createTestKv();
    try {
      // The physical unit's own credential, as its pairing flow would have written it.
      await kv.set("session:PHYS-1", "hardware-issued-token", { ex: 600 });

      const engine = createVirtualRobotSimulator({
        prisma: prismaWithRobots(rows),
        kv,
        serverUrl: "http://127.0.0.1:0",
        logger: silentLogger,
        enabled: true,
      });
      engine.start();

      await rehydrateSimulatedRobots({
        prisma: prismaWithRobots(rows),
        simulator: engine,
        logger: silentLogger,
        enabled: true,
      });

      // Three simulated instances, and only three.
      const status = engine.getStatus();
      expect(status.robotCount).toBe(3);
      expect(status.runningCount).toBe(3);
      expect(status.robots.map((entry) => entry.robotId)).not.toContain("PHYS-1");

      // The hardware's credential is untouched — the Step 1 hazard, re-asserted with a
      // populated simulated fleet alongside it rather than in isolation.
      expect(await kv.get("session:PHYS-1")).toBe("hardware-issued-token");

      // And an explicit request to adopt the physical unit is still refused.
      const verdict = await engine.addRobot({ robotId: "PHYS-1", lat: 12.9, lon: 77.5, simulated: true });
      expect(verdict).toEqual({ started: false, reason: "ROBOT_NOT_SIMULATED" });
      expect(engine.getStatus().robotCount).toBe(3);

      engine.stop();
    } finally {
      await close();
    }
  });

  test("simulated robots write only their own live-state keys", async () => {
    const rows = [
      { robotId: "PHYS-2", lat: 12.90, lon: 77.50, simulated: false, battery: 88 },
      { robotId: "SIM-D1", lat: 12.91, lon: 77.51, simulated: true, battery: 70 },
      { robotId: "SIM-D2", lat: 12.92, lon: 77.52, simulated: true, battery: 60 },
      { robotId: "SIM-D3", lat: 12.93, lon: 77.53, simulated: true, battery: 50 },
    ];
    const { kv, close } = await createTestKv();
    try {
      const engine = createVirtualRobotSimulator({
        prisma: prismaWithRobots(rows),
        kv,
        serverUrl: "http://127.0.0.1:0",
        logger: silentLogger,
        enabled: true,
      });
      engine.start();
      for (const row of rows.filter((r) => r.simulated)) {
        await engine.addRobot({ robotId: row.robotId, lat: row.lat, lon: row.lon, simulated: true });
      }

      // The physical robot has no simulator-written live state.
      expect(await kv.get("robot:PHYS-2")).toBeNull();
      // Each simulated robot's own key holds its own position.
      for (const row of rows.filter((r) => r.simulated)) {
        const live = JSON.parse(await kv.get(`robot:${row.robotId}`));
        expect(live.lat).toBeCloseTo(row.lat, 5);
        expect(live.battery).toBe(Math.round(row.battery));
      }

      engine.stop();
    } finally {
      await close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Engine lifecycle — the start/stop/start finding
// ═══════════════════════════════════════════════════════════════════════════

describe("Step 4 — the engine's started flag means the robots are started", () => {
  async function engineWithRobots(ids) {
    const rows = ids.map((robotId, index) => ({
      robotId,
      lat: 12.9 + index * 0.01,
      lon: 77.5,
      simulated: true,
      battery: 70,
    }));
    const engine = createVirtualRobotSimulator({
      prisma: prismaWithRobots(rows),
      kv: makeFlash(),
      serverUrl: "http://127.0.0.1:0",
      logger: silentLogger,
      enabled: true,
    });
    return { engine, rows };
  }

  test("a robot added before start() is started by start(), not left queued forever", async () => {
    const { engine, rows } = await engineWithRobots(["SIM-Q1", "SIM-Q2"]);

    // Engine deliberately not started yet.
    for (const row of rows) {
      const verdict = await engine.addRobot({ robotId: row.robotId, lat: row.lat, lon: row.lon, simulated: true });
      expect(verdict).toEqual({ started: false, reason: "ENGINE_NOT_STARTED" });
    }
    expect(engine.getStatus()).toMatchObject({ robotCount: 2, runningCount: 0 });

    const outcome = engine.start();
    expect(outcome).toMatchObject({ started: true, running: 2, total: 2 });
    expect(engine.getStatus()).toMatchObject({ started: true, robotCount: 2, runningCount: 2 });

    engine.stop();
  });

  test("stop() then start() revives the fleet instead of reporting a dead one as running", async () => {
    // The finding. `stop()` nulls every socket and clears every timer; `start()` used only
    // to set a flag. The engine then reported `started: true` with nothing ticking, and the
    // frontend's RUNNING verdict is computed from that flag — so a stopped fleet was
    // labelled RUNNING on the dashboard.
    const { engine, rows } = await engineWithRobots(["SIM-L1", "SIM-L2", "SIM-L3"]);
    engine.start();
    for (const row of rows) {
      await engine.addRobot({ robotId: row.robotId, lat: row.lat, lon: row.lon, simulated: true });
    }
    expect(engine.getStatus().runningCount).toBe(3);

    engine.stop();
    const stopped = engine.getStatus();
    expect(stopped.started).toBe(false);
    expect(stopped.runningCount).toBe(0);
    // The robots are retained, not lost, so they can be revived.
    expect(stopped.robotCount).toBe(3);

    const restarted = engine.start();
    expect(restarted).toMatchObject({ started: true, running: 3, total: 3 });
    const after = engine.getStatus();
    expect(after.started).toBe(true);
    expect(after.runningCount).toBe(3);
    // Every robot reports itself running, not merely present.
    expect(after.robots.every((entry) => entry.running === true)).toBe(true);

    engine.stop();
  });

  test("start() is idempotent on a healthy fleet", async () => {
    const { engine, rows } = await engineWithRobots(["SIM-I1"]);
    engine.start();
    await engine.addRobot({ robotId: rows[0].robotId, lat: rows[0].lat, lon: rows[0].lon, simulated: true });

    const first = engine.getStatus().robots[0].telemetrySequence;
    engine.start();
    engine.start();
    expect(engine.getStatus().runningCount).toBe(1);
    expect(engine.getStatus().robots[0].telemetrySequence).toBe(first);

    engine.stop();
  });

  test("removeRobot stops and drops exactly one robot", async () => {
    const { engine, rows } = await engineWithRobots(["SIM-M1", "SIM-M2"]);
    engine.start();
    for (const row of rows) {
      await engine.addRobot({ robotId: row.robotId, lat: row.lat, lon: row.lon, simulated: true });
    }

    engine.removeRobot("SIM-M1");
    const status = engine.getStatus();
    expect(status.robotCount).toBe(1);
    expect(status.robots[0].robotId).toBe("SIM-M2");
    expect(status.runningCount).toBe(1);

    engine.stop();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Configuration — the minimum needed to make a demo repeatable
// ═══════════════════════════════════════════════════════════════════════════

describe("Step 4 — simulator configuration is a closed set, validated, and honest about scope", () => {
  test("a valid request is accepted and reports which half took effect where", async () => {
    const engine = createVirtualRobotSimulator({
      prisma: prismaWithRobots([{ robotId: "SIM-CFG", simulated: true, battery: 50 }]),
      kv: makeFlash(),
      serverUrl: "http://127.0.0.1:0",
      logger: silentLogger,
      enabled: true,
    });
    engine.start();
    await engine.addRobot({ robotId: "SIM-CFG", lat: 12.9, lon: 77.5, simulated: true });

    const outcome = engine.setConfig({ telemetryIntervalMs: 500, initialBattery: 64 });
    expect(outcome.ok).toBe(true);
    expect(outcome.appliedLive).toEqual(["telemetryIntervalMs"]);
    expect(outcome.appliesToNewRobots).toEqual(["initialBattery"]);
    expect(outcome.robotsUpdated).toBe(1);

    // The live parameter reached the running robot.
    expect(engine.getStatus().robots[0].telemetryIntervalMs).toBe(500);
    expect(engine.getStatus().config).toMatchObject({ telemetryIntervalMs: 500, initialBattery: 64 });

    engine.stop();
  });

  test("protected identity and specification fields are refused by name", () => {
    for (const field of [
      "robotId",
      "simulated",
      "chassisType",
      "specification",
      "battery",
      "isOnline",
      "sessionToken",
    ]) {
      const outcome = simulationConfig.normaliseConfig({ [field]: "anything" });
      expect(outcome.ok).toBe(false);
      expect(outcome.problems.join(" ")).toContain(field);
      expect(outcome.problems.join(" ")).toMatch(/protected/i);
    }
  });

  test("the operator-ownership column is refused, even though no simulator file names it", () => {
    // `tests/engine/simulationBoundary.test.js` forbids any file under `src/simulation` from
    // naming this column — ownership never travels with the agent. So the refusal cannot come
    // from a by-name list in the module; it comes from the tunable set being closed. Asserted
    // here because a test file is not inside that boundary, so this is the one place the
    // property can be stated with the column's actual name.
    const outcome = simulationConfig.normaliseConfig({ simulationOwnerId: "user-1" });
    expect(outcome.ok).toBe(false);
    expect(outcome.problems[0]).toMatch(/not a simulator parameter/);

    // ...and it really is absent from both shipped lists, so the refusal above is the
    // closed-set rule doing the work and not a list entry this test would also have matched.
    expect(simulationConfig.PROTECTED_FIELDS).not.toContain("simulationOwnerId");
    expect(simulationConfig.TUNABLE_PARAMETERS).not.toContain("simulationOwnerId");
  });

  test("an unknown parameter is refused rather than silently ignored", () => {
    // The old endpoint accepted `{ tickMs: 500 }`, answered ok, and changed nothing, so a
    // misspelling was indistinguishable from a working request.
    const outcome = simulationConfig.normaliseConfig({ tickMs: 500 });
    expect(outcome.ok).toBe(false);
    expect(outcome.problems[0]).toMatch(/tickMs is not a simulator parameter/);
  });

  test("out-of-range and non-numeric values are refused, and every problem is reported", () => {
    const outcome = simulationConfig.normaliseConfig({
      telemetryIntervalMs: 5, // below the rate limiter's floor
      obstacleProbability: 2, // not a probability
      speedBaseMs: "fast", // not coerced
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.problems).toHaveLength(3);
    expect(outcome.problems.join(" ")).toMatch(/telemetryIntervalMs must be between 100 and 60000/);
    expect(outcome.problems.join(" ")).toMatch(/obstacleProbability must be between 0 and 1/);
    expect(outcome.problems.join(" ")).toMatch(/speedBaseMs must be a finite number \(received a string\)/);
  });

  test("a refused request changes nothing", () => {
    const engine = createVirtualRobotSimulator({
      prisma: prismaWithRobots([]),
      kv: makeFlash(),
      serverUrl: "http://127.0.0.1:0",
      logger: silentLogger,
      enabled: true,
    });
    engine.setConfig({ telemetryIntervalMs: 1000 });
    const before = engine.getStatus().config;

    const refused = engine.setConfig({ telemetryIntervalMs: 1, nonsense: 3 });
    expect(refused.ok).toBe(false);
    expect(engine.getStatus().config).toEqual(before);
  });

  test("an empty or absent configuration is accepted and changes nothing", () => {
    expect(simulationConfig.normaliseConfig(undefined)).toMatchObject({ ok: true, config: {} });
    expect(simulationConfig.normaliseConfig({})).toMatchObject({ ok: true, config: {} });
    expect(simulationConfig.normaliseConfig([]).ok).toBe(false);
  });

  test("a live tick-period change restarts the timer rather than being accepted inertly", () => {
    // `setInterval`'s period is fixed at creation, so a config change that did not replace
    // the timer would be accepted and have no effect — the exact failure the change removes.
    const { robot } = makeAgent({ robotId: "SIM-TIMER" });
    robot.start();
    const firstTimer = robot._timer;
    expect(robot.setTelemetryInterval(500)).toBe(true);
    expect(robot._timer).not.toBe(firstTimer);
    expect(robot.isRunning()).toBe(true);
    expect(robot.getStatus().telemetryIntervalMs).toBe(500);
    // An unchanged value is not a change.
    expect(robot.setTelemetryInterval(500)).toBe(false);
    robot.stop();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Liveness — identity is not runtime
// ═══════════════════════════════════════════════════════════════════════════

describe("Step 4 — a simulated robot's runtime state is its runtime, not its row", () => {
  test("a disconnected robot ticks nothing: no telemetry, no movement, no drain", () => {
    const { robot, socket } = makeAgent({ robotId: "SIM-OFFLINE" });
    robot.battery = 60;
    robot._onTaskAssign(executableAssignment());

    robot.connected = false;
    socket.connected = false;
    const position = { lat: robot.lat, lon: robot.lon };

    runTicks(robot, 50);

    expect(socket.of("TELEMETRY")).toHaveLength(0);
    expect(socket.of("HEARTBEAT")).toHaveLength(0);
    expect(robot.battery).toBe(60);
    expect(robot.lat).toBe(position.lat);
    expect(robot.getStatus().telemetrySequence).toBe(0);
  });

  test("a connected robot heartbeats every tick, so liveness comes from the session", () => {
    const { robot, socket } = makeAgent({ robotId: "SIM-BEAT" });
    robot.battery = 60;
    runTicks(robot, 7);
    expect(socket.of("HEARTBEAT")).toHaveLength(7);
    expect(socket.of("TELEMETRY")).toHaveLength(7);
  });

  test("an agent stopped while loading its dedup state abandons AUTH instead of throwing", async () => {
    // Found by the live run, where it surfaced as
    // "AUTH failed: Cannot read properties of null (reading 'emit')" during an ordinary,
    // correct shutdown. `loadDedupState` awaits non-volatile storage and `stop()` nulls the
    // socket, so the emit could land on nothing. Nothing was broken by it — but an error log
    // that cries wolf during normal operation is how a real one gets ignored.
    const slowFlash = {
      async get() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return null;
      },
      async set() {
        return "OK";
      },
    };
    const { robot } = makeAgent({ robotId: "SIM-STOPPED-MID-AUTH", kv: slowFlash });

    const pending = robot._authWithDedupReport();
    robot.stop(); // the shutdown that lands inside the await
    await expect(pending).resolves.toBeUndefined();
  });

  test("inspectTransport reports counts and identity, never the socket itself", () => {
    const { robot } = makeAgent({ robotId: "SIM-INSPECT" });
    robot._registerHandlers();

    const view = robot.inspectTransport();
    expect(view).toMatchObject({
      robotId: "SIM-INSPECT",
      running: false,
      connected: true,
      listeners: expect.objectContaining({ COMMAND: 1, TASK_ASSIGN: 1, OFFER: 1 }),
    });
    // It hands out no mutable handle on the agent or its transport.
    expect(Object.values(view)).not.toContain(robot.socket);
    expect(view.socket).toBeUndefined();
  });

  test("socketGeneration counts distinct sockets, so a reuse is distinguishable from a rebuild", () => {
    // What the live verifier reads to establish that socket.io-client reconnects on the same
    // `Socket` object — the premise the registration fix rests on.
    const { robot } = makeAgent({ robotId: "SIM-GENERATION" });
    expect(robot.inspectTransport().socketGeneration).toBe(0);

    // A reconnection on the existing emitter does not advance it.
    robot._registerHandlers();
    robot._handlersRegistered = false;
    robot._registerHandlers();
    expect(robot.inspectTransport().socketGeneration).toBe(0);
  });

  test("getStatus distinguishes an instance that exists from one that is running", () => {
    const { robot } = makeAgent({ robotId: "SIM-RUNSTATE" });
    expect(robot.getStatus().running).toBe(false);
    robot.start();
    expect(robot.getStatus().running).toBe(true);
    robot.stop();
    expect(robot.getStatus().running).toBe(false);
  });
});

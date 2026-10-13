"use strict";

/**
 * D-1 (docs/ROBOTX_CHARGING_LIFECYCLE_AUDIT.md) — low battery is an energy condition, not a
 * persistent fault.
 *
 * Before: a simulated robot below the 20 % warning level on a delivery reported `ISSUES`.
 * `ISSUES` is a health statement (MARGINAL), and §23.5's asymmetric rule refuses every later
 * self-report that would raise it (IDLE, ACTIVE, CHARGING), task completion does not release
 * it, and clear-fault refuses it — so a robot that ran low once was out of V1 service (F09
 * requires NOMINAL) for good, even after charging to 80 %.
 *
 * After: the simulated robot no longer encodes low battery as `ISSUES`. Its battery is
 * reported numerically and F34 (task energy feasibility) is the authority on whether it may
 * take work. Genuine faults are untouched: a persisted ERROR or ISSUES still blocks.
 *
 * REAL: VirtualRobot, telemetry.handler (engine on, §23.5 enforced), F09, the health-tier map.
 * MOCKED: the socket, flash, the Robot row (a mock that applies conditional writes like the DB).
 */

const VirtualRobot = require("../../../src/simulation/VirtualRobot");
const constants = require("../../../src/simulation/constants");
const f09 = require("../../../src/engine/feasibility/predicates/f09");
const { HEALTH_TIER_BY_STATUS } = require("../../../src/services/agentFacts.service");
const { createTelemetryReplay } = require("../../helpers/telemetryReplay");

jest.setTimeout(60_000);

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function makeFlash() {
  const values = new Map();
  return {
    async get(key) { return values.has(key) ? values.get(key) : null; },
    async set(key, value) { values.set(key, value); return "OK"; },
    async del(key) { values.delete(key); },
    async sadd() { return 1; },
  };
}

function makeAgent(overrides) {
  const emitted = [];
  const robot = new VirtualRobot({ robotId: "SIM-D1", lat: 12.9, lon: 77.5, logger: silentLogger, kv: makeFlash(), simulated: true, ...overrides });
  robot.socket = { connected: true, emit(event, payload) { emitted.push({ event, payload }); }, on() {} };
  robot.connected = true;
  return { robot, emitted };
}

let clock = 1_791_900_000_000;
function runTicks(robot, ticks, until) {
  const realNow = Date.now;
  try {
    for (let i = 0; i < ticks; i += 1) {
      if (until && until()) return i;
      clock += constants.TELEMETRY_INTERVAL_MS;
      Date.now = () => clock;
      robot._tick();
    }
  } finally {
    Date.now = realNow;
  }
  return ticks;
}

/** A straight north-bound path of `n` points spaced `stepDeg` apart. */
function line(fromLat, n, stepDeg) {
  return Array.from({ length: n }, (_, i) => ({ lat: fromLat + i * stepDeg, lon: 77.5 }));
}

/** A delivery long enough to take a robot from 20.6 % to below 19.5 % at the moving drain. */
function longDelivery() {
  const toPickup = line(12.9, 60, 0.0005); // ≈ 3.3 km
  const toDrop = line(toPickup[toPickup.length - 1].lat, 60, -0.0005);
  return { taskId: "TSK-D1", pathToPickup: toPickup, pathToDrop: toDrop };
}

const telemetry = (emitted) => emitted.filter((e) => e.event === "TELEMETRY").map((e) => e.payload);
const nominal = (status) => f09.evaluate({
  agentSnapshot: { healthTier: HEALTH_TIER_BY_STATUS[status] },
  mission: { requiredHealthTier: "NOMINAL", slaClass: "STANDARD" },
  config: {},
});

describe("D-1 — the simulated robot does not report low battery as a fault", () => {
  test("below the warning level on a delivery it stays ACTIVE, keeps moving, and never reports ISSUES", () => {
    const { robot, emitted } = makeAgent();
    robot.battery = 20.6;
    robot._onTaskAssign(longDelivery());
    const before = robot.distanceTravelled;
    runTicks(robot, 400, () => robot.battery < 19.5);

    expect(robot.battery).toBeLessThan(constants.BATTERY_WARN_THRESHOLD);
    expect(robot.status).toBe("ACTIVE");
    expect(robot.distanceTravelled).toBeGreaterThan(before);
    expect(telemetry(emitted).map((f) => f.status)).not.toContain("ISSUES");
  });
});

describe("D-1 — through the real engine-on telemetry handler, a recharged robot is NOMINAL again", () => {
  test("delivery below 20 % → completion → charge to the target → the next accepted frame leaves the row NOMINAL", async () => {
    const { robot, emitted } = makeAgent();
    robot.battery = 20.6;
    robot._onTaskAssign(longDelivery());
    // 1) the delivery, down through the warning level, to completion
    runTicks(robot, 4000, () => robot.task === null);
    expect(emitted.some((e) => e.event === "TASK_COMPLETE")).toBe(true);
    const deliveryFrames = telemetry(emitted);
    expect(deliveryFrames.some((f) => f.battery < constants.BATTERY_WARN_THRESHOLD)).toBe(true);
    // 2) idle down to the charge trigger, charge (unscheduled local dock) to the target, then idle on
    robot.battery = constants.BATTERY_CRITICAL_THRESHOLD + 0.05;
    runTicks(robot, 4000, () => robot.status === "CHARGING");
    runTicks(robot, 6000, () => robot.status !== "CHARGING");
    runTicks(robot, 300);
    const frames = telemetry(emitted);

    const replay = await createTelemetryReplay({
      robotId: "SIM-D1",
      row: { status: "ACTIVE", battery: frames[0].battery, lat: frames[0].lat, lon: frames[0].lon },
      configValues: { "security.implausible_report_quarantine_threshold": 3 },
    });
    const seenStatuses = new Set();
    let lastAccepted = null;
    for (const frame of frames) {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await replay.send(frame);
      seenStatuses.add(replay.dbRow.status);
      if (outcome.accepted) lastAccepted = frame;
    }

    expect(seenStatuses.has("ISSUES")).toBe(false);
    expect(lastAccepted.status).toBe("IDLE");
    expect(lastAccepted.battery).toBeGreaterThanOrEqual(75);
    expect(replay.dbRow.status).toBe("IDLE");
    expect(nominal(replay.dbRow.status).outcome).toBe("SATISFIED");
  });
});

describe("D-1 — genuine faults still block (the health rule is unchanged)", () => {
  test.each(["ERROR", "ISSUES"])("a row held at %s by a genuine fault stays there under IDLE reports, and F09 denies", async (held) => {
    const replay = await createTelemetryReplay({
      robotId: `SIM-FAULT-${held}`,
      row: { status: held, battery: 60, lat: 12.9, lon: 77.5 },
    });
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await replay.send({ lat: 12.9, lon: 77.5, battery: 60 - i * 0.01, speed: 0, status: "IDLE", sequence: i + 1 });
    }
    expect(replay.dbRow.status).toBe(held);
    const verdict = nominal(held);
    expect(verdict.outcome).toBe("VIOLATED");
  });
});

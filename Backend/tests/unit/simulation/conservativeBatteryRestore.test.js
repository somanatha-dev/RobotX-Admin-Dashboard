"use strict";

/**
 * D-3 (docs/ROBOTX_CHARGING_LIFECYCLE_AUDIT.md) — a restarted simulated robot restores the LOWER
 * of its two persisted states of charge.
 *
 * Before: `commission()` took the Redis snapshot (`vr:battery:{id}`, written every 2 min) ahead
 * of the Robot row (flushed at least every 15 s). The snapshot is normally the older and so the
 * higher of the two; the robot came back with energy a newer record said it had spent, and its
 * first frames "rose" against the row and were refused (50 frames for a 0.5-point gap).
 *
 * After: both valid sources are compared and the lower is restored — never energy that one of
 * them says is gone. Invalid values are ignored rather than coerced; with neither source the
 * configured initial level, then 100 %, applies as before.
 */

const VirtualRobot = require("../../../src/simulation/VirtualRobot");
const constants = require("../../../src/simulation/constants");
const { createTelemetryReplay } = require("../../helpers/telemetryReplay");

jest.setTimeout(60_000);

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function makeFlash(initial) {
  const values = new Map(Object.entries(initial || {}));
  return {
    async get(key) { return values.has(key) ? values.get(key) : null; },
    async set(key, value) { values.set(key, value); return "OK"; },
    async del(key) { values.delete(key); },
    async sadd() { return 1; },
  };
}

async function restored({ redis, db, initialBattery }) {
  const flash = makeFlash(redis === undefined ? {} : { "vr:battery:SIM-D3": redis });
  const robot = new VirtualRobot({ robotId: "SIM-D3", lat: 12.9, lon: 77.5, logger: silentLogger, kv: flash, dbBattery: db, initialBattery, simulated: true });
  await robot.commission(flash);
  return robot;
}

describe("D-3 — the lower valid persisted state of charge is restored", () => {
  test.each([
    ["Redis higher than the row", "50.5", 50, 50],
    ["Redis lower than the row", "49", 50, 49],
    ["Redis missing", undefined, 50, 50],
    ["row missing", "47.2", null, 47.2],
    ["Redis malformed", "abc", 50, 50],
    ["Redis out of range", "150", 50, 50],
    ["Redis negative", "-3", 50, 50],
    ["row not finite", "48", Number.NaN, 48],
    ["row out of range", "48", 250, 48],
  ])("%s", async (_label, redis, db, expected) => {
    const robot = await restored({ redis, db });
    expect(robot.battery).toBeCloseTo(expected, 5);
  });

  test("neither source usable: the configured initial level applies", async () => {
    const robot = await restored({ redis: "abc", db: null, initialBattery: 63 });
    expect(robot.battery).toBe(63);
  });

  test("neither source nor a configured level: 100 %, as before", async () => {
    const robot = await restored({ redis: undefined, db: null });
    expect(robot.battery).toBe(100);
  });
});

describe("D-3 — the first telemetry after a restart raises no false plausibility event", () => {
  test("snapshot 50.5 %, row 50.0 %: every frame is accepted", async () => {
    const robot = await restored({ redis: "50.5", db: 50 });
    const emitted = [];
    robot.socket = { connected: true, emit(event, payload) { emitted.push({ event, payload }); }, on() {} };
    robot.connected = true;
    let clock = 1_792_000_000_000;
    const realNow = Date.now;
    try {
      for (let i = 0; i < 30; i += 1) {
        clock += constants.TELEMETRY_INTERVAL_MS;
        Date.now = () => clock;
        robot._tick();
      }
    } finally {
      Date.now = realNow;
    }
    const frames = emitted.filter((e) => e.event === "TELEMETRY").map((e) => e.payload);

    const replay = await createTelemetryReplay({
      robotId: "SIM-D3",
      row: { status: "IDLE", battery: 50, lat: 12.9, lon: 77.5, isOnline: false },
      configValues: { "security.implausible_report_quarantine_threshold": 3 },
    });
    const refused = [];
    for (const f of frames) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await replay.send(f)).accepted) refused.push(f.battery);
    }
    expect(refused).toEqual([]);
    expect(replay.securityEvents()).toHaveLength(0);
  });
});

"use strict";

/**
 * D-2 (docs/ROBOTX_CHARGING_LIFECYCLE_AUDIT.md) — the §23.5 energy row measures a report against
 * the LAST ACCEPTED report, not against the database row.
 *
 * Before: `assessAgentReport` compared each frame's state of charge with `existing.battery`, the
 * Robot row, which the flush gate writes only on a 2-point swing, every 15 s or on a status
 * change. At the end of a charge the row trailed the robot (79.3 % against 80.0 %), so the
 * robot's first IDLE frames "rose while not charging" and were refused for minutes (73 frames
 * and 71 SECURITY_EVENTs measured), freezing the dashboard at CHARGING and leaving F18/F16
 * denying. The same stale reference also ADMITTED a real rise that stayed below a stale, higher
 * row value.
 *
 * After: the reference is the state of charge of the last accepted report for the robot (the
 * row only when no report has been accepted yet in this process), and the simulated robot reports
 * the tick in which charge flowed as CHARGING. The plausibility rule itself is unchanged.
 *
 * REAL: VirtualRobot (its own frames), telemetry.handler with the engine on.
 */

const VirtualRobot = require("../../../src/simulation/VirtualRobot");
const constants = require("../../../src/simulation/constants");
const { createTelemetryReplay } = require("../../helpers/telemetryReplay");

jest.setTimeout(60_000);

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };
const THRESHOLD = { "security.implausible_report_quarantine_threshold": 3 };

function makeFlash() {
  const values = new Map();
  return {
    async get(key) { return values.has(key) ? values.get(key) : null; },
    async set(key, value) { values.set(key, value); return "OK"; },
    async del(key) { values.delete(key); },
    async sadd() { return 1; },
  };
}

/** The real frames of one charge session: from the trigger to the target, then idle. */
function chargeSessionFrames() {
  const emitted = [];
  const robot = new VirtualRobot({ robotId: "SIM-D2", lat: 12.9, lon: 77.5, logger: silentLogger, kv: makeFlash(), simulated: true });
  robot.socket = { connected: true, emit(event, payload) { emitted.push({ event, payload }); }, on() {} };
  robot.connected = true;
  robot.battery = constants.BATTERY_CRITICAL_THRESHOLD;
  let clock = 1_791_950_000_000;
  const realNow = Date.now;
  try {
    let sawCharging = false;
    for (let i = 0; i < 8000; i += 1) {
      clock += constants.TELEMETRY_INTERVAL_MS;
      Date.now = () => clock;
      robot._tick();
      if (robot.status === "CHARGING") sawCharging = true;
      if (sawCharging && robot.status === "IDLE") break;
    }
    for (let i = 0; i < 120; i += 1) {
      clock += constants.TELEMETRY_INTERVAL_MS;
      Date.now = () => clock;
      robot._tick();
    }
  } finally {
    Date.now = realNow;
  }
  return emitted.filter((e) => e.event === "TELEMETRY").map((e) => e.payload);
}

const frame = (status, battery, sequence) => ({ lat: 12.9, lon: 77.5, speed: 0, status, battery, sequence });

describe("D-2 — legitimate end-of-charge frames are accepted", () => {
  test("every real frame of a charge session, through to idle after the target, is accepted with no security event", async () => {
    const frames = chargeSessionFrames();
    const target = frames.findIndex((f, i) => i > 0 && frames[i - 1].status === "CHARGING" && f.status !== "CHARGING");
    expect(target).toBeGreaterThan(0);

    const replay = await createTelemetryReplay({
      robotId: "SIM-D2",
      row: { status: "IDLE", battery: frames[0].battery, lat: 12.9, lon: 77.5 },
      configValues: THRESHOLD,
    });
    const refused = [];
    for (const f of frames) {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await replay.send(f);
      if (!outcome.accepted) refused.push({ sequence: f.sequence, status: f.status, battery: f.battery });
    }

    expect(refused).toEqual([]);
    expect(replay.securityEvents()).toHaveLength(0);
    // The dashboard's last word is the robot's own idle state, not a frozen CHARGING frame.
    const last = replay.io.emittedTo("dashboard", "robot:update").slice(-1)[0];
    expect(last.status).toBe("IDLE");
  });
});

describe("D-2 — the check is not weakened", () => {
  test("a genuine rise while not charging is still refused, and the refused frame changes nothing", async () => {
    const replay = await createTelemetryReplay({ robotId: "SIM-RISE", row: { status: "IDLE", battery: 60, lat: 12.9, lon: 77.5 }, configValues: THRESHOLD });
    expect((await replay.send(frame("IDLE", 60, 1))).accepted).toBe(true);
    const writesBefore = replay.writes.length;
    const rowBefore = { ...replay.dbRow };
    const updatesBefore = replay.io.emittedTo("dashboard", "robot:update").length;
    const liveBefore = await replay.kv.get("robot:SIM-RISE");

    const outcome = await replay.send(frame("IDLE", 61, 2));

    expect(outcome.refused).toBe(true);
    expect(replay.writes.length).toBe(writesBefore);
    expect(replay.dbRow).toEqual(rowBefore);
    expect(replay.io.emittedTo("dashboard", "robot:update")).toHaveLength(updatesBefore);
    expect(await replay.kv.get("robot:SIM-RISE")).toEqual(liveBefore);
  });

  test("a rise that stays below a STALE, higher row value is refused (the old reference admitted it)", async () => {
    // The row says 70 % (stale: not yet flushed down); the robot has reported 60 % and 59.9 %.
    const replay = await createTelemetryReplay({ robotId: "SIM-STALE", row: { status: "IDLE", battery: 70, lat: 12.9, lon: 77.5 }, configValues: THRESHOLD });
    expect((await replay.send(frame("IDLE", 60, 1))).accepted).toBe(true);
    expect((await replay.send(frame("IDLE", 59.9, 2))).accepted).toBe(true);
    replay.dbRow.battery = 70; // the flush has not caught up
    expect((await replay.send(frame("IDLE", 65, 3))).refused).toBe(true);
  });

  // On one connection a frame whose sequence is not newer is dropped before any check runs (the
  // handler's frame ordering). The energy reference is per robot, not per connection, so the same
  // frames are also replayed across a reconnect, where only the §23.5 check stands between them
  // and the reference.
  test("an out-of-order (older, higher) frame after a newer accepted one is not applied", async () => {
    const replay = await createTelemetryReplay({ robotId: "SIM-OOO", row: { status: "IDLE", battery: 60, lat: 12.9, lon: 77.5 }, configValues: THRESHOLD });
    expect((await replay.send(frame("IDLE", 60, 1))).accepted).toBe(true);
    expect((await replay.send(frame("IDLE", 59.5, 3))).accepted).toBe(true);
    expect((await replay.send(frame("IDLE", 59.9, 2))).dropped).toBe(true);
  });

  test("across a reconnect, the same out-of-order frame is refused by the energy check", async () => {
    const replay = await createTelemetryReplay({ robotId: "SIM-OOO-RC", row: { status: "IDLE", battery: 60, lat: 12.9, lon: 77.5 }, configValues: THRESHOLD });
    expect((await replay.send(frame("IDLE", 60, 1))).accepted).toBe(true);
    expect((await replay.send(frame("IDLE", 59.5, 3))).accepted).toBe(true);
    replay.reconnect();
    expect((await replay.send(frame("IDLE", 59.9, 2))).refused).toBe(true);
  });

  test("a duplicate of the newest frame carries no rise and cannot raise the reference", async () => {
    const replay = await createTelemetryReplay({ robotId: "SIM-DUP", row: { status: "IDLE", battery: 60, lat: 12.9, lon: 77.5 }, configValues: THRESHOLD });
    expect((await replay.send(frame("IDLE", 59.8, 1))).accepted).toBe(true);
    expect((await replay.send(frame("IDLE", 59.8, 1))).dropped).toBe(true);
    expect((await replay.send(frame("IDLE", 60, 2))).refused).toBe(true);
  });

  test("across a reconnect, a duplicate is admitted by the energy check and still cannot raise the reference", async () => {
    const replay = await createTelemetryReplay({ robotId: "SIM-DUP-RC", row: { status: "IDLE", battery: 60, lat: 12.9, lon: 77.5 }, configValues: THRESHOLD });
    expect((await replay.send(frame("IDLE", 59.8, 1))).accepted).toBe(true);
    replay.reconnect();
    expect((await replay.send(frame("IDLE", 59.8, 1))).accepted).toBe(true);
    expect((await replay.send(frame("IDLE", 60, 2))).refused).toBe(true);
  });

  test("a rise reported as CHARGING is admitted (the charging exemption is unchanged)", async () => {
    const replay = await createTelemetryReplay({ robotId: "SIM-CHG", row: { status: "IDLE", battery: 40, lat: 12.9, lon: 77.5 }, configValues: THRESHOLD });
    expect((await replay.send(frame("IDLE", 40, 1))).accepted).toBe(true);
    expect((await replay.send(frame("CHARGING", 40.4, 2))).accepted).toBe(true);
    expect((await replay.send(frame("CHARGING", 40.8, 3))).accepted).toBe(true);
    expect((await replay.send(frame("IDLE", 40.8, 4))).accepted).toBe(true);
    expect((await replay.send(frame("IDLE", 41, 5))).refused).toBe(true);
  });
});

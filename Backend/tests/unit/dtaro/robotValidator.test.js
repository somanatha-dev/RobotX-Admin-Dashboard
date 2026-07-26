const { validateRobot } = require("../../../src/services/robotValidator.service");
const { setRobotState } = require("../../../src/services/robotRegistry.service");
const { setRobotSocket, deleteRobotSocket } = require("../../../src/sockets/robotSockets");
const { createTestKv } = require("../../helpers/testKv");
const { BATTERY_THRESHOLD, CHARGING_INTERRUPT_BATTERY } = require("../../../src/config/dtaro.constants");

describe("robotValidator.service — DTARO eligibility", () => {
  let kv;

  beforeEach(async () => {
    ({ kv } = await createTestKv());
  });

  test("rejects an offline robot before anything else", async () => {
    const result = await validateRobot(kv, { robotId: "R1", isOnline: false, status: "IDLE", battery: 100, currentTaskId: null });
    expect(result).toEqual({ valid: false, reason: "Robot is offline" });
  });

  test("accepts an IDLE, online robot with battery at exactly the threshold", async () => {
    await setRobotState(kv, "R1", { battery: BATTERY_THRESHOLD });
    const result = await validateRobot(kv, { robotId: "R1", isOnline: true, status: "IDLE", battery: BATTERY_THRESHOLD, currentTaskId: null });
    expect(result.valid).toBe(true);
  });

  test("rejects battery one point below the threshold", async () => {
    const battery = BATTERY_THRESHOLD - 1;
    await setRobotState(kv, "R1", { battery });
    const result = await validateRobot(kv, { robotId: "R1", isOnline: true, status: "IDLE", battery, currentTaskId: null });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/below threshold/);
  });

  test("rejects a non-IDLE, non-charging robot (e.g. ACTIVE)", async () => {
    const result = await validateRobot(kv, { robotId: "R1", isOnline: true, status: "ACTIVE", battery: 100, currentTaskId: null });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/expected IDLE/);
  });

  test("rejects a robot that already has a currentTaskId", async () => {
    const result = await validateRobot(kv, { robotId: "R1", isOnline: true, status: "IDLE", battery: 100, currentTaskId: "some-task" });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/already has an active task/);
  });

  test("rejects a robot flagged FAULT in the registry even though DB says IDLE", async () => {
    await setRobotState(kv, "R1", { battery: 100, healthStatus: "FAULT" });
    const result = await validateRobot(kv, { robotId: "R1", isOnline: true, status: "IDLE", battery: 100, currentTaskId: null });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/hardware fault/);
  });

  describe("CHARGING (DB=PAUSED, Redis=CHARGING)", () => {
    test("rejected when allowCharging is false (default)", async () => {
      await setRobotState(kv, "R1", { status: "CHARGING", battery: 100 });
      const result = await validateRobot(kv, { robotId: "R1", isOnline: true, status: "PAUSED", battery: 100, currentTaskId: null });
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/charging/i);
    });

    test("accepted when allowCharging is true and battery meets CHARGING_INTERRUPT_BATTERY", async () => {
      await setRobotState(kv, "R1", { status: "CHARGING", battery: CHARGING_INTERRUPT_BATTERY });
      const result = await validateRobot(
        kv,
        { robotId: "R1", isOnline: true, status: "PAUSED", battery: CHARGING_INTERRUPT_BATTERY, currentTaskId: null },
        { allowCharging: true }
      );
      expect(result.valid).toBe(true);
    });

    test("rejected when charging but battery is below the explicit charging-interrupt floor passed by the caller", async () => {
      const battery = CHARGING_INTERRUPT_BATTERY - 1;
      await setRobotState(kv, "R1", { status: "CHARGING", battery });
      const result = await validateRobot(
        kv,
        { robotId: "R1", isOnline: true, status: "PAUSED", battery, currentTaskId: null },
        { allowCharging: true, batteryThreshold: CHARGING_INTERRUPT_BATTERY }
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/below minimum/);
    });

    test("in production wiring (no batteryThreshold override), a charging robot below CHARGING_INTERRUPT_BATTERY is rejected", async () => {
      const battery = CHARGING_INTERRUPT_BATTERY - 1; // 29% — below the documented 30% floor
      await setRobotState(kv, "R1", { status: "CHARGING", battery });
      const result = await validateRobot(
        kv,
        { robotId: "R1", isOnline: true, status: "PAUSED", battery, currentTaskId: null },
        { allowCharging: true } // matches taskAssignment.service.js's actual call site exactly
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/below minimum/);
    });
  });

  test("uses the pre-fetched liveState (F9 batching) instead of issuing its own registry read", async () => {
    // Deliberately do NOT write anything to the registry for this robotId —
    // if validateRobot ignored `liveState` and fetched itself, it would see
    // no battery override and fall back to the (also-missing) DB battery.
    const result = await validateRobot(
      kv,
      { robotId: "GHOST", isOnline: true, status: "IDLE", battery: 5, currentTaskId: null },
      { liveState: { battery: 90 } }
    );
    expect(result.valid).toBe(true); // 90 >= BATTERY_THRESHOLD, overriding the DB's stale 5%
  });

  test("rejects when socket is connected but registry says unauthenticated (desync guard)", async () => {
    const fakeSocket = { id: "sock-1" };
    setRobotSocket("R1", fakeSocket);
    try {
      await setRobotState(kv, "R1", { battery: 100, authenticated: false });
      const result = await validateRobot(kv, { robotId: "R1", isOnline: true, status: "IDLE", battery: 100, currentTaskId: null });
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/connected but not authenticated/);
    } finally {
      deleteRobotSocket("R1", fakeSocket);
    }
  });

  test("null robotRow is rejected outright", async () => {
    const result = await validateRobot(kv, null);
    expect(result).toEqual({ valid: false, reason: "Robot not found" });
  });
});

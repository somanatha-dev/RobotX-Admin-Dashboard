const { createTestKv } = require("../../helpers/testKv");

// F4 — the allocation reservation primitive itself (`kv.reserveRobot` /
// `releaseReservation`). `task.service.js`'s retry loop is built directly on
// top of these two calls, so their atomic "claim if free" semantics are the
// foundation the whole allocation-race fix depends on.
describe("kv reservation locking (F4 foundation)", () => {
  let kv;

  beforeEach(async () => {
    ({ kv } = await createTestKv());
  });

  test("first reservation on a free key succeeds", async () => {
    const ok = await kv.reserveRobot("robotReserve:R1", "task-1", 30);
    expect(ok).toBe(true);
  });

  test("a second concurrent reservation on the same key fails (simulates two assignments racing for one robot)", async () => {
    const first = await kv.reserveRobot("robotReserve:R1", "task-1", 30);
    const second = await kv.reserveRobot("robotReserve:R1", "task-2", 30);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  test("releasing a reservation allows a subsequent claim to succeed", async () => {
    await kv.reserveRobot("robotReserve:R1", "task-1", 30);
    await kv.releaseReservation("robotReserve:R1");
    const reclaimed = await kv.reserveRobot("robotReserve:R1", "task-2", 30);
    expect(reclaimed).toBe(true);
  });

  test("reservation expires after its TTL, acting as a deadlock/crash backstop", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    try {
      const ok = await kv.reserveRobot("robotReserve:R1", "task-1", 1); // 1s TTL
      expect(ok).toBe(true);

      // Still held just under the TTL.
      jest.advanceTimersByTime(900);
      expect(await kv.reserveRobot("robotReserve:R1", "task-2", 1)).toBe(false);

      // Past the TTL — the orphaned reservation must be gone even though
      // nobody ever called releaseReservation (simulates a process crash
      // between reserve and release).
      jest.advanceTimersByTime(200);
      expect(await kv.reserveRobot("robotReserve:R1", "task-3", 1)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test("reservations on different robot keys are independent", async () => {
    const a = await kv.reserveRobot("robotReserve:R1", "task-1", 30);
    const b = await kv.reserveRobot("robotReserve:R2", "task-1", 30);
    expect(a).toBe(true);
    expect(b).toBe(true);
  });

  test("simulated retry loop: losing robot excluded, next candidate reserved successfully", async () => {
    // Mirrors task.service.js's _processAssignment retry shape: attempt 1
    // picks R1 but a concurrent request already holds it; attempt 2 excludes
    // R1 and successfully reserves R2.
    await kv.reserveRobot("robotReserve:R1", "concurrent-task", 30); // simulate a winner elsewhere

    const excludeRobotIds = [];
    let reservedRobot = null;
    const candidateOrder = ["R1", "R2"];

    for (const robotId of candidateOrder) {
      if (excludeRobotIds.includes(robotId)) continue;
      const ok = await kv.reserveRobot(`robotReserve:${robotId}`, "task-x", 30);
      if (ok) {
        reservedRobot = robotId;
        break;
      }
      excludeRobotIds.push(robotId);
    }

    expect(excludeRobotIds).toEqual(["R1"]);
    expect(reservedRobot).toBe("R2");
  });
});

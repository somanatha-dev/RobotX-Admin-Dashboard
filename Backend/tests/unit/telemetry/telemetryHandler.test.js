const { createTestKv } = require("../../helpers/testKv");
const { createFakeSocket, createFakeIo } = require("../../helpers/fakeSocket");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { waitFor } = require("../../helpers/waitFor");
const silentLogger = require("../../mocks/silentLogger");

function existingRobot(overrides = {}) {
  return {
    id: "db-robot-1", status: "IDLE", lat: 1, lon: 1, speed: 0, battery: 50, isOnline: true,
    ...overrides,
  };
}

// telemetry.handler.js keeps a module-level `lastDbFlushAt` Map (the F10
// dirty-state Postgres-flush gate) that persists for the life of the
// process — by design, it's keyed per-robotId across ticks, not per-test.
// We `jest.resetModules()` and re-require both the handler and the registry
// service in every test so each test starts from a clean flush-gate state,
// rather than leaking flush timing between unrelated test cases.
describe("telemetry.handler — TELEMETRY (real-time pipeline)", () => {
  let prisma;
  let kv;
  let io;
  let socket;
  let registerTelemetryHandlers;
  let getRobotState;

  beforeEach(async () => {
    jest.resetModules();
    ({ registerTelemetryHandlers } = require("../../../src/sockets/handlers/telemetry.handler"));
    ({ getRobotState } = require("../../../src/services/robotRegistry.service"));

    prisma = createMockPrisma();
    prisma.zone.findMany.mockResolvedValue([]);
    ({ kv } = await createTestKv());
    io = createFakeIo();
    socket = createFakeSocket();
    registerTelemetryHandlers(io, socket, { prisma, kv, logger: silentLogger });
  });

  test("drops the frame and emits AUTH_REQUIRED when the socket never completed AUTH (F26)", async () => {
    // socket.data.isAuthed / robotId are intentionally left unset.
    socket.trigger("TELEMETRY", { robotId: "R1", lat: 1, lon: 1, battery: 50, status: "ACTIVE" });
    await waitFor(() => socket.sent.some((s) => s.event === "AUTH_REQUIRED"));
    expect(prisma.robot.findUnique).not.toHaveBeenCalled();
  });

  test("rejects/ignores an unregistered robotId (emits robot_unregistered, no crash)", async () => {
    socket.data.isAuthed = true;
    socket.data.robotId = "GHOST";
    prisma.robot.findUnique.mockResolvedValue(null);

    socket.trigger("TELEMETRY", { lat: 1, lon: 1, battery: 50, status: "ACTIVE" });
    await waitFor(() => io.emittedTo("dashboard", "robot_unregistered").length > 0);
  });

  test("a non-numeric lat does not crash the handler and falls back to the existing DB lat", async () => {
    // zod's preprocessor turns an invalid numeric string into `null`; `toNumberOrNull(null)`
    // must also return `null` (not coerce via `Number(null) === 0`) so the
    // `typeof lat === "number" ? lat : ...prevState/existing...` fallback chain below
    // actually runs and preserves the robot's last known position.
    socket.data.isAuthed = true;
    socket.data.robotId = "R1";
    prisma.robot.findUnique.mockResolvedValue(existingRobot());
    prisma.robot.update.mockResolvedValue({});

    socket.trigger("TELEMETRY", { lat: "not-a-number", lon: 1, battery: 50, status: "ACTIVE" });
    await waitFor(() => io.emittedTo("dashboard", "robot:update").length > 0);
    const [state] = io.emittedTo("dashboard", "robot:update");
    expect(state.lat).toBe(existingRobot().lat);
  });

  test("updates the registry (registry:{robotId}) with live lat/lon/battery/status/speed", async () => {
    socket.data.isAuthed = true;
    socket.data.robotId = "R1";
    prisma.robot.findUnique.mockResolvedValue(existingRobot());
    prisma.robot.update.mockResolvedValue({});

    socket.trigger("TELEMETRY", { lat: 12.5, lon: 77.5, battery: 61, speed: 10, status: "ACTIVE" });
    await waitFor(() => io.emittedTo("dashboard", "robot:update").length > 0);

    const registry = await getRobotState(kv, "R1");
    expect(registry).toMatchObject({ lat: 12.5, lon: 77.5, battery: 61, status: "ACTIVE" });
  });

  test("utilization EMA increases toward 1 while ACTIVE (0 -> 0.05 -> 0.0975)", async () => {
    socket.data.isAuthed = true;
    socket.data.robotId = "R1";
    prisma.robot.findUnique.mockResolvedValue(existingRobot({ status: "IDLE" }));
    prisma.robot.update.mockResolvedValue({});

    socket.trigger("TELEMETRY", { lat: 1, lon: 1, battery: 50, status: "ACTIVE" });
    await waitFor(() => io.emittedTo("dashboard", "robot:update").length > 0);
    const afterFirst = await getRobotState(kv, "R1");
    expect(afterFirst.utilization).toBeCloseTo(0.05, 4); // 0 + 0.05*(1-0)

    // TELEMETRY is rate-limited at a 100ms minimum interval per socket — a
    // second trigger any sooner would be silently dropped, not processed.
    await new Promise((r) => setTimeout(r, 150));
    prisma.robot.findUnique.mockResolvedValue(existingRobot({ status: "ACTIVE" }));
    socket.trigger("TELEMETRY", { lat: 1, lon: 1, battery: 50, status: "ACTIVE" });
    await waitFor(async () => (await getRobotState(kv, "R1")).utilization > 0.05);
    const afterSecond = await getRobotState(kv, "R1");
    expect(afterSecond.utilization).toBeCloseTo(0.0975, 4); // 0.05 + 0.05*(1-0.05)
  });

  test("an unmodeled status jump (ERROR -> PAUSED is not in the transition table) is not written to Postgres", async () => {
    socket.data.isAuthed = true;
    socket.data.robotId = "R1";
    // ERROR robots may only go to IDLE/ACTIVE/OFFLINE/ISSUES per TRANSITIONS.ERROR.
    prisma.robot.findUnique.mockResolvedValue(existingRobot({ status: "ERROR" }));
    prisma.robot.update.mockResolvedValue({});

    socket.trigger("TELEMETRY", { lat: 1, lon: 1, battery: 50, status: "PAUSED" });
    await waitFor(() => io.emittedTo("dashboard", "robot:update").length > 0);

    // The flush gate fires anyway (first tick for this robot, time-due), but
    // must never report the rejected PAUSED transition.
    await waitFor(() => prisma.robot.update.mock.calls.length > 0);
    const [{ data }] = prisma.robot.update.mock.calls[0];
    expect(data.status).toBeUndefined();
  });

  test("CHARGING is preserved as the raw registry status but stored as PAUSED in Postgres", async () => {
    socket.data.isAuthed = true;
    socket.data.robotId = "R1";
    prisma.robot.findUnique.mockResolvedValue(existingRobot({ status: "IDLE" }));
    prisma.robot.update.mockResolvedValue({});

    socket.trigger("TELEMETRY", { lat: 1, lon: 1, battery: 50, status: "CHARGING" });
    await waitFor(() => io.emittedTo("dashboard", "robot:update").length > 0);

    const registry = await getRobotState(kv, "R1");
    expect(registry.status).toBe("CHARGING");

    await waitFor(() => prisma.robot.update.mock.calls.length > 0);
    const [{ data }] = prisma.robot.update.mock.calls[0];
    expect(data.status).toBe("PAUSED");
  });

  test("broadcasts robot:update ONLY to the dashboard room, never globally", async () => {
    socket.data.isAuthed = true;
    socket.data.robotId = "R1";
    prisma.robot.findUnique.mockResolvedValue(existingRobot());
    prisma.robot.update.mockResolvedValue({});

    socket.trigger("TELEMETRY", { lat: 1, lon: 1, battery: 50, status: "ACTIVE" });
    await waitFor(() => io.emittedTo("dashboard", "robot:update").length > 0);

    // A bare io.emit would fan out to every connected socket, including every
    // OTHER robot — an O(N^2) pattern at fleet scale. This must never happen.
    expect(io.emit).not.toHaveBeenCalled();
    expect(io.to).toHaveBeenCalledWith("dashboard");
  });

  describe("F10 — dirty-state Postgres flush gate", () => {
    test("first tick for a robot always flushes to Postgres (time-due, gate starts at 0)", async () => {
      socket.data.isAuthed = true;
      socket.data.robotId = "R1";
      prisma.robot.findUnique.mockResolvedValue(existingRobot({ status: "ACTIVE" }));
      prisma.robot.update.mockResolvedValue({});

      socket.trigger("TELEMETRY", { lat: 1, lon: 1, battery: 50, status: "ACTIVE" });
      await waitFor(() => prisma.robot.update.mock.calls.length > 0);
    });

    test("a second tick moments later, with no status/battery change, does NOT re-flush to Postgres", async () => {
      socket.data.isAuthed = true;
      socket.data.robotId = "R1";
      prisma.robot.findUnique.mockResolvedValue(existingRobot({ status: "ACTIVE" }));
      prisma.robot.update.mockResolvedValue({});

      socket.trigger("TELEMETRY", { lat: 1, lon: 1, battery: 50, status: "ACTIVE" });
      await waitFor(() => io.emittedTo("dashboard", "robot:update").length >= 1);
      const firstEmitCount = io.emittedTo("dashboard", "robot:update").length;
      const flushesAfterFirst = prisma.robot.update.mock.calls.length;
      expect(flushesAfterFirst).toBeGreaterThan(0);

      await new Promise((r) => setTimeout(r, 150)); // clear the 100ms rate-limit gate
      prisma.robot.findUnique.mockResolvedValue(existingRobot({ status: "ACTIVE" }));
      socket.trigger("TELEMETRY", { lat: 1.00001, lon: 1.00001, battery: 50, status: "ACTIVE" });
      await waitFor(() => io.emittedTo("dashboard", "robot:update").length > firstEmitCount);

      // Movement/position alone does not force a DB write — Redis carries
      // live position every tick regardless (see the handler's own comment).
      expect(prisma.robot.update.mock.calls.length).toBe(flushesAfterFirst);
    });

    test("a battery swing of >=2% forces an immediate flush even before the time-based interval", async () => {
      socket.data.isAuthed = true;
      socket.data.robotId = "R1";
      prisma.robot.findUnique.mockResolvedValue(existingRobot({ status: "ACTIVE", battery: 50 }));
      prisma.robot.update.mockResolvedValue({});
      socket.trigger("TELEMETRY", { lat: 1, lon: 1, battery: 50, status: "ACTIVE" });
      await waitFor(() => prisma.robot.update.mock.calls.length > 0);
      const afterFirst = prisma.robot.update.mock.calls.length;

      await new Promise((r) => setTimeout(r, 150)); // clear the 100ms rate-limit gate
      // DB row still reports battery=50 (unchanged) while live battery drops by 3%.
      prisma.robot.findUnique.mockResolvedValue(existingRobot({ status: "ACTIVE", battery: 50 }));
      socket.trigger("TELEMETRY", { lat: 1, lon: 1, battery: 47, status: "ACTIVE" });
      await waitFor(() => prisma.robot.update.mock.calls.length > afterFirst);
      const [{ data }] = prisma.robot.update.mock.calls[prisma.robot.update.mock.calls.length - 1];
      expect(data.battery).toBe(47);
    });
  });
});

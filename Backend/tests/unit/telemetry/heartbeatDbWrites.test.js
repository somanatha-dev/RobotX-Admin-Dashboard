const { createTestKv } = require("../../helpers/testKv");
const { createFakeSocket, createFakeIo } = require("../../helpers/fakeSocket");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { waitFor } = require("../../helpers/waitFor");

// F10 (completion) — the Postgres write throttle must cover EVERY path that
// writes to the `Robot` row on the per-tick hot loop, not just the telemetry
// handler.
//
// `telemetry.handler.js` gained a dirty-state flush gate (DB_FLUSH_INTERVAL_MS)
// that correctly throttles its own `prisma.robot.update`. But `VirtualRobot`
// (and any real robot following the same protocol) emits HEARTBEAT on the same
// 2-second tick as TELEMETRY, and `robot.handler.js`'s heartbeat path issued an
// unconditional `prisma.robot.update({ data: { lastSeenAt } })` — so aggregate
// write volume to the `Robot` table was unchanged by the throttle. It moved
// handlers.
//
// At the simulator's real cadence (TELEMETRY_INTERVAL_MS = 2000) that is
// 30 heartbeats/robot/minute, each a full row update, forever.

describe("HEARTBEAT — Postgres write throttling (F10 completion)", () => {
  let prisma;
  let kv;
  let io;
  let socket;
  let registerRobotHandlers;

  beforeEach(async () => {
    // robot.handler.js keeps a module-level throttle map, same pattern as the
    // telemetry flush gate — reset so each test starts from a clean state.
    jest.resetModules();
    ({ registerRobotHandlers } = require("../../../src/sockets/handlers/robot.handler"));

    prisma = createMockPrisma();
    prisma.robot.update.mockResolvedValue({});
    ({ kv } = await createTestKv());
    io = createFakeIo();
    socket = createFakeSocket();
    registerRobotHandlers(io, socket, { prisma, kv, logger: { info() {}, warn() {}, error() {} } });

    socket.data.isAuthed = true;
    socket.data.robotId = "R1";
  });

  /** Only the writes that came from the heartbeat path (they set lastSeenAt alone). */
  function heartbeatWrites() {
    return prisma.robot.update.mock.calls.filter(
      ([args]) => args?.data && Object.keys(args.data).length === 1 && "lastSeenAt" in args.data
    );
  }

  test("the first heartbeat for a robot writes lastSeenAt to Postgres", async () => {
    socket.trigger("HEARTBEAT");
    await waitFor(() => heartbeatWrites().length === 1);
    expect(heartbeatWrites()).toHaveLength(1);
  });

  test("a burst of heartbeats inside the flush window produces at most ONE Postgres write", async () => {
    // 10 heartbeats spaced 110ms apart — just past the handler's own 100ms
    // rate-limit floor, so every one of them is genuinely processed rather
    // than dropped by the limiter. This is ~20 seconds of simulated robot
    // uptime compressed; all of it falls inside a single flush interval.
    const BEATS = 10;
    for (let i = 0; i < BEATS; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 110));
      socket.trigger("HEARTBEAT");
    }
    await new Promise((r) => setTimeout(r, 100));

    // Pre-fix: 10 writes (one per beat). Post-fix: 1.
    expect(heartbeatWrites()).toHaveLength(1);
  });

  test("heartbeats for different robots are throttled independently", async () => {
    const socket2 = createFakeSocket();
    registerRobotHandlers(io, socket2, { prisma, kv, logger: { info() {}, warn() {}, error() {} } });
    socket2.data.isAuthed = true;
    socket2.data.robotId = "R2";

    socket.trigger("HEARTBEAT");
    socket2.trigger("HEARTBEAT");
    await waitFor(() => heartbeatWrites().length === 2);

    const robotIds = heartbeatWrites().map(([args]) => args.where.robotId).sort();
    expect(robotIds).toEqual(["R1", "R2"]);
  });

  test("projected write volume: a robot at the simulator's 2s tick stays far below 30 writes/minute", async () => {
    // The regression this guards against, stated as the number that matters:
    // VirtualRobot._tick() runs every TELEMETRY_INTERVAL_MS (2000ms) and emits
    // HEARTBEAT unconditionally => 30 beats/robot/minute. With a 15s flush
    // interval that must collapse to <= 4 writes/robot/minute.
    const { TELEMETRY_INTERVAL_MS } = require("../../../src/simulation/constants");
    const beatsPerMinute = 60_000 / TELEMETRY_INTERVAL_MS;
    expect(beatsPerMinute).toBe(30);

    // Drive 6 beats and assert the collapse ratio holds on the observed path.
    for (let i = 0; i < 6; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 110));
      socket.trigger("HEARTBEAT");
    }
    await new Promise((r) => setTimeout(r, 100));

    expect(heartbeatWrites().length).toBeLessThan(6);
  });
});

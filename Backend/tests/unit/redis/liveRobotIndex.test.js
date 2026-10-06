const { createTestKv } = require("../../helpers/testKv");
const { createFakeSocket, createFakeIo } = require("../../helpers/fakeSocket");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { waitFor } = require("../../helpers/waitFor");
const silentLogger = require("../../mocks/silentLogger");

// `robots:all` is the live-robot index. Two consumers depend on it:
//
//   - metrics.getSystemMetrics -> /health's robots.online count
//   - robotRegistry.getAllRobotIds -> alertDissemination's obstacle fan-out
//
// It used to be written ONLY by commissioning, VirtualRobot.commission, and
// task recovery — never by AUTH, and never pruned on disconnect. So a robot
// that authenticated by any other route (a real unit reconnecting, any fleet
// present after a Redis flush) was absent from the set for its whole session,
// and departed robots lingered in it forever. The second failure mode is the
// dangerous one: a robot missing from the index is skipped by obstacle
// dissemination, so it is never rerouted around an obstacle on its path.

describe("robots:all — the live-robot index tracks actual connection state", () => {
  let prisma;
  let kv;
  let io;
  let socket;
  let registerRobotHandlers;

  beforeEach(async () => {
    jest.resetModules();
    ({ registerRobotHandlers } = require("../../../src/sockets/handlers/robot.handler"));

    prisma = createMockPrisma();
    prisma.robot.findUnique.mockResolvedValue({
      id: "db-robot-1", status: "IDLE", isOnline: false, lat: 1, lon: 1, battery: 90,
    });
    prisma.robot.update.mockResolvedValue({});
    ({ kv } = await createTestKv());
    io = createFakeIo();
    socket = createFakeSocket();
    registerRobotHandlers(io, socket, { prisma, kv, logger: silentLogger });
  });

  async function authenticate(robotId = "R1") {
    await kv.set(`session:${robotId}`, "tok-1", { ex: 3600 });
    socket.trigger("AUTH", { robotId, token: "tok-1" });
    await waitFor(() => socket.sent.some((s) => s.event === "AUTH_SUCCESS"));
  }

  test("a robot joins the index when it authenticates, not only when commissioned", async () => {
    expect(await kv.smembers("robots:all")).not.toContain("R1");

    await authenticate("R1");

    await waitFor(async () => (await kv.smembers("robots:all")).includes("R1"));
    expect(await kv.smembers("robots:all")).toContain("R1");
  });

  test("a robot leaves the index when its socket disconnects", async () => {
    await authenticate("R1");
    await waitFor(async () => (await kv.smembers("robots:all")).includes("R1"));

    // The disconnect handler only acts when this socket is still the current
    // one, which it is: AUTH wrote this socket id to the DB row (so Y1's conditional offline
    // write, keyed by that socket id, matches the row).
    prisma.robot.findUnique.mockResolvedValue({ socketId: socket.id });
    prisma.robot.updateMany.mockResolvedValue({ count: 1 });
    socket.trigger("disconnect", "transport close");

    await waitFor(async () => !(await kv.smembers("robots:all")).includes("R1"));
    expect(await kv.smembers("robots:all")).not.toContain("R1");
  });

  test("disconnect also clears the stale socket binding on the Robot row", async () => {
    await authenticate("R1");
    prisma.robot.findUnique.mockResolvedValue({ socketId: socket.id });
    prisma.robot.updateMany.mockResolvedValue({ count: 1 });
    socket.trigger("disconnect", "transport close");

    await waitFor(() =>
      prisma.robot.updateMany.mock.calls.some(([args]) => args?.data?.isOnline === false)
    );
    const offlineWrite = prisma.robot.updateMany.mock.calls
      .map(([args]) => args)
      .find((args) => args?.data?.isOnline === false);

    // Leaving a dead socket id on the row makes it look like a live handle.
    expect(offlineWrite.data).toMatchObject({ isOnline: false, status: "OFFLINE", socketId: null });
    // Y1 — and the write is conditional on this socket still being the row's socket.
    expect(offlineWrite.where).toMatchObject({ robotId: "R1", socketId: socket.id });
  });

  test("a superseded socket's disconnect does not evict the robot that replaced it", async () => {
    await authenticate("R1");
    await waitFor(async () => (await kv.smembers("robots:all")).includes("R1"));

    // A newer connection has since taken over — the DB row points elsewhere.
    prisma.robot.findUnique.mockResolvedValue({ socketId: "some-newer-socket" });
    socket.trigger("disconnect", "transport close");

    await new Promise((r) => setTimeout(r, 150));
    expect(await kv.smembers("robots:all")).toContain("R1");
  });
});

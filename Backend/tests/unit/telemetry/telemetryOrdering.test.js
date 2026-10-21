"use strict";

/**
 * Duplicate, out-of-order and overlapping TELEMETRY frames must not put older state over
 * newer state in the live cache (`robot:{id}`) or on the dashboard (`robot:update`).
 *
 * The durable writers already order their own rows — the Observation log refuses a sequence
 * at or below its high-water mark, `BatteryState` refuses an older `lastObservedAt` — but the
 * live state and the broadcast were written unconditionally, so:
 *   - an agent that re-sent or reordered a frame moved the robot backwards on the map, and a
 *     stale `status` in it reached the Robot row;
 *   - two frames in flight at once (the first one held up on a slow database write) finished
 *     in the wrong order, and the older one's position was the one left in the cache.
 */

const { createTestKv } = require("../../helpers/testKv");
const { createFakeSocket, createFakeIo } = require("../../helpers/fakeSocket");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { waitFor } = require("../../helpers/waitFor");
const silentLogger = require("../../mocks/silentLogger");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// TELEMETRY is rate-limited to one frame per 100 ms per socket.
const SPACING_MS = 130;

function existingRobot(overrides = {}) {
  return { id: "db-robot-1", status: "IDLE", lat: 1, lon: 1, speed: 0, battery: 50, isOnline: true, ...overrides };
}

function frame(sequence, lat, extra = {}) {
  return { lat, lon: 77.5, battery: 60, speed: 1, status: "IDLE", sequence, timestamp: 1_760_000_000_000 + sequence * 1000, ...extra };
}

describe("telemetry.handler — frame ordering for the live state", () => {
  let prisma;
  let kv;
  let io;
  let socket;
  let registerTelemetryHandlers;

  beforeEach(async () => {
    jest.resetModules();
    ({ registerTelemetryHandlers } = require("../../../src/sockets/handlers/telemetry.handler"));
    prisma = createMockPrisma();
    prisma.zone.findMany.mockResolvedValue([]);
    prisma.robot.updateMany.mockResolvedValue({ count: 1 });
    prisma.robot.update.mockResolvedValue({});
    prisma.robot.findUnique.mockResolvedValue(existingRobot());
    ({ kv } = await createTestKv());
    io = createFakeIo();
    socket = createFakeSocket();
    socket.data.isAuthed = true;
    socket.data.robotId = "R1";
    registerTelemetryHandlers(io, socket, { prisma, kv, logger: silentLogger });
  });

  const updates = () => io.emittedTo("dashboard", "robot:update");
  const liveLat = async () => JSON.parse(await kv.get("robot:R1")).lat;

  test("a re-sent frame (same sequence) is dropped: one update, nothing written twice", async () => {
    socket.trigger("TELEMETRY", frame(5, 12.9));
    await waitFor(() => updates().length === 1);
    const writesAfterFirst = prisma.robot.update.mock.calls.length + prisma.robot.updateMany.mock.calls.length;

    await sleep(SPACING_MS);
    socket.trigger("TELEMETRY", frame(5, 12.9));
    await sleep(SPACING_MS);

    expect(updates()).toHaveLength(1);
    expect(prisma.robot.update.mock.calls.length + prisma.robot.updateMany.mock.calls.length).toBe(writesAfterFirst);
  });

  test("an older frame arriving after a newer one does not move the robot backwards", async () => {
    socket.trigger("TELEMETRY", frame(7, 12.97));
    await waitFor(() => updates().length === 1);

    await sleep(SPACING_MS);
    socket.trigger("TELEMETRY", frame(6, 12.96));
    await sleep(SPACING_MS);

    expect(updates()).toHaveLength(1);
    expect(updates()[0].lat).toBe(12.97);
    expect(await liveLat()).toBe(12.97);
  });

  test("a stale frame's status never reaches the Robot row", async () => {
    socket.trigger("TELEMETRY", frame(9, 12.9, { status: "IDLE" }));
    await waitFor(() => updates().length === 1);
    prisma.robot.updateMany.mockClear();
    prisma.robot.update.mockClear();

    await sleep(SPACING_MS);
    socket.trigger("TELEMETRY", frame(8, 12.9, { status: "ACTIVE" }));
    await sleep(SPACING_MS);

    expect(prisma.robot.updateMany).not.toHaveBeenCalled();
    expect(prisma.robot.update).not.toHaveBeenCalled();
  });

  test("without a sequence the agent timestamp orders frames", async () => {
    socket.trigger("TELEMETRY", { lat: 12.91, lon: 77.5, timestamp: 2_000 });
    await waitFor(() => updates().length === 1);

    await sleep(SPACING_MS);
    socket.trigger("TELEMETRY", { lat: 12.90, lon: 77.5, timestamp: 1_000 });
    await sleep(SPACING_MS);

    expect(updates()).toHaveLength(1);
    expect(await liveLat()).toBe(12.91);
  });

  test("the sequence wins over a timestamp that stepped backwards (agent clock corrected)", async () => {
    socket.trigger("TELEMETRY", frame(3, 12.93, { timestamp: 9_000_000 }));
    await waitFor(() => updates().length === 1);

    await sleep(SPACING_MS);
    socket.trigger("TELEMETRY", frame(4, 12.94, { timestamp: 1_000 }));
    await waitFor(() => updates().length === 2);

    expect(await liveLat()).toBe(12.94);
  });

  test("frames carrying neither a sequence nor a timestamp are applied as before", async () => {
    socket.trigger("TELEMETRY", { lat: 12.95, lon: 77.5 });
    await waitFor(() => updates().length === 1);
    await sleep(SPACING_MS);
    socket.trigger("TELEMETRY", { lat: 12.95, lon: 77.5 });
    await waitFor(() => updates().length === 2);
  });

  test("a new connection starts its own ordering (an agent whose counter restarted is not frozen)", async () => {
    socket.trigger("TELEMETRY", frame(50, 12.9));
    await waitFor(() => updates().length === 1);

    const reconnected = createFakeSocket();
    reconnected.data.isAuthed = true;
    reconnected.data.robotId = "R1";
    registerTelemetryHandlers(io, reconnected, { prisma, kv, logger: silentLogger });
    reconnected.trigger("TELEMETRY", frame(1, 12.91));

    await waitFor(() => updates().length === 2);
    expect(await liveLat()).toBe(12.91);
  });

  test("two frames in flight at once: the older one finishing last does not overwrite the newer", async () => {
    // The first frame's robot lookup is held until the second frame has finished.
    let releaseFirst;
    prisma.robot.findUnique
      .mockImplementationOnce(() => new Promise((resolve) => (releaseFirst = () => resolve(existingRobot()))))
      .mockResolvedValue(existingRobot());

    socket.trigger("TELEMETRY", frame(20, 12.920));
    await sleep(SPACING_MS);
    socket.trigger("TELEMETRY", frame(21, 12.921));
    await waitFor(() => updates().length === 1);
    expect(updates()[0].lat).toBe(12.921);

    releaseFirst();
    await sleep(SPACING_MS);

    expect(await liveLat()).toBe(12.921);
    expect(updates().map((u) => u.lat)).toEqual([12.921]);
  });
});

"use strict";

/**
 * Stale location, readiness and battery provenance — driven through the *real* telemetry handler
 * (socket event, zod schema, rate limiter, in-memory KV facade), as production drives it.
 *
 * The defect: a TELEMETRY frame that omits `lat`/`lon` (the Pi omits them whenever it has no fresh
 * fix) had its position completed from the previous tick or the `Robot` row, written back to the
 * row with a fresh `lastSeenAt`, recorded in the `Telemetry` history under the frame's time and
 * broadcast as `robot:update` — a fix hours old, shown exactly as a live one.
 */

const { createTestKv } = require("../../helpers/testKv");
const { createFakeSocket, createFakeIo } = require("../../helpers/fakeSocket");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { waitFor } = require("../../helpers/waitFor");
const silentLogger = require("../../mocks/silentLogger");

const COMMISSIONED = Object.freeze({ lat: 12.9716, lon: 77.5946 });
const FIX = Object.freeze({ lat: 12.8998974, lon: 77.5193889 });

function existingRobot(overrides = {}) {
  return { id: "db-robot-1", status: "IDLE", lat: COMMISSIONED.lat, lon: COMMISSIONED.lon, speed: 0, battery: 50, isOnline: true, ...overrides };
}

describe("telemetry.handler — measured position, readiness and battery provenance", () => {
  let prisma;
  let kv;
  let close;
  let io;
  let socket;

  beforeEach(async () => {
    jest.resetModules();
    const handler = require("../../../src/sockets/handlers/telemetry.handler");
    require("../../../src/services/positionObservation.service").resetPositionObservationState();
    require("../../../src/services/robotPosition.service").resetRobotPositionState();
    handler.resetPositionObservationLogState();
    handler.resetTrustBoundaryState();

    prisma = createMockPrisma();
    prisma.zone.findMany.mockResolvedValue([]);
    prisma.robot.update.mockResolvedValue({});
    prisma.observation.findFirst.mockResolvedValue(null);
    prisma.observation.create.mockResolvedValue({});
    prisma.telemetry.create.mockResolvedValue({});
    ({ kv, close } = await createTestKv());
    io = createFakeIo();
    socket = createFakeSocket();
    handler.registerTelemetryHandlers(io, socket, { prisma, kv, logger: silentLogger });
  });

  afterEach(async () => {
    if (close) await close();
  });

  function robotReads({ simulated = false, row = existingRobot() } = {}) {
    prisma.robot.findUnique.mockImplementation(async ({ select }) => {
      if (select && "agent" in select) return { simulated, agent: { id: "agent-row-1" } };
      return row;
    });
  }

  function authenticate(robotId = "RBT-2000") {
    socket.data.isAuthed = true;
    socket.data.robotId = robotId;
  }

  const updates = () => io.emittedTo("dashboard", "robot:update");
  const lastUpdate = () => updates()[updates().length - 1];
  const send = async (payload) => {
    const before = updates().length;
    socket.trigger("TELEMETRY", payload);
    await waitFor(() => updates().length > before);
    return lastUpdate();
  };

  test("a fresh measured fix: LIVE, with its own time, fix quality and provenance; kept beside its Observation", async () => {
    authenticate();
    robotReads();
    const measuredAt = Date.now() - 500;

    const update = await send({ ...FIX, battery: 50, timestamp: measuredAt, sequence: 1, position: { fixType: "3D", hAccM: 2.157 } });

    expect(update.position).toMatchObject({
      status: "LIVE",
      measured: true,
      fresh: true,
      lat: FIX.lat,
      lon: FIX.lon,
      observedAtMs: measuredAt,
      fixType: "3D",
      hAccM: 2.157,
      provenance: "PHYSICAL",
      qualified: true,
      freshnessBoundMs: 10_000,
    });
    expect(JSON.parse(await kv.get("position:RBT-2000"))).toMatchObject({ lat: FIX.lat, observedAtMs: measuredAt });
    // The row takes the reported coordinates.
    expect(prisma.robot.update.mock.calls[0][0].data).toMatchObject({ lat: FIX.lat, lon: FIX.lon });
  });

  test("then frames with NO coordinates: the old fix is reported STALE at its ORIGINAL time — never refreshed into the row or the history", async () => {
    authenticate();
    robotReads();
    const measuredAt = Date.now() - 60_000; // a real fix, a minute old

    await send({ ...FIX, battery: 50, timestamp: measuredAt, sequence: 1, position: { fixType: "3D", hAccM: 2.157 } });
    prisma.robot.update.mockClear();
    prisma.robot.updateMany.mockClear();
    prisma.telemetry.create.mockClear();
    // The handler admits at most one frame per 100 ms per socket.
    await new Promise((resolve) => setTimeout(resolve, 150));

    // A battery swing forces a row flush and a history row on this coordinate-less frame.
    const update = await send({ battery: 45, status: "IDLE", timestamp: Date.now() - 100, sequence: 2 });

    expect(update.position).toMatchObject({ status: "STALE", fresh: false, measured: true, observedAtMs: measuredAt, lat: FIX.lat });
    expect(update.position.ageMs).toBeGreaterThanOrEqual(59_000);
    // `lat`/`lon` stay the last known coordinates for existing clients…
    expect(update).toMatchObject({ lat: FIX.lat, lon: FIX.lon });
    // …but the row is NOT re-written with them under a fresh lastSeenAt,
    // Through whichever write the frame takes (a reported status goes through the stale-write guard).
    const rowWrites = () => [...prisma.robot.update.mock.calls, ...prisma.robot.updateMany.mock.calls].map(([args]) => args.data);
    await waitFor(() => rowWrites().length > 0);
    const data = rowWrites()[0];
    expect(data).not.toHaveProperty("lat");
    expect(data).not.toHaveProperty("lon");
    expect(data.lastSeenAt).toBeInstanceOf(Date);
    // …the history row carries no position for this frame,
    await waitFor(() => prisma.telemetry.create.mock.calls.length > 0);
    expect(prisma.telemetry.create.mock.calls[0][0].data).toMatchObject({ lat: null, lon: null });
    // …and no Observation was invented from the fallback.
    expect(prisma.observation.create).toHaveBeenCalledTimes(1);
  });

  test("a robot that has never had a fix: position UNKNOWN; lat/lon are the commissioning row's, and say so only through position", async () => {
    authenticate();
    robotReads();

    const update = await send({ battery: 50, status: "IDLE", timestamp: Date.now() - 100, sequence: 1 });

    expect(update.position).toMatchObject({ status: "UNKNOWN", measured: false, fresh: false, lat: null, lon: null, observedAt: null });
    expect(update).toMatchObject({ lat: COMMISSIONED.lat, lon: COMMISSIONED.lon });
    expect(prisma.observation.create).not.toHaveBeenCalled();
  });

  test("the readiness report is recorded and broadcast; IDLE status does not imply it", async () => {
    authenticate();
    robotReads();

    const update = await send({ battery: 50, status: "IDLE", timestamp: Date.now() - 100, sequence: 1, readiness: { blockers: ["NO_MOTOR_LINK", "NO_POSITION_FIX"] } });

    expect(update.status).toBe("IDLE");
    expect(update.readiness).toMatchObject({ reported: true, current: true, ready: false, blockers: ["NO_MOTOR_LINK", "NO_POSITION_FIX"] });
    expect(JSON.parse(await kv.get("readiness:RBT-2000"))).toMatchObject({ socketId: socket.id, blockers: ["NO_MOTOR_LINK", "NO_POSITION_FIX"] });
  });

  test("no readiness block: reported false, ready null — never ready by default", async () => {
    authenticate();
    robotReads();
    const update = await send({ battery: 50, status: "IDLE", timestamp: Date.now() - 100, sequence: 1 });
    expect(update.readiness).toMatchObject({ reported: false, current: false, ready: null, blockers: [] });
  });

  test("demo battery: shown as DEMO_SIMULATED, never written to BatteryState", async () => {
    authenticate();
    robotReads({ row: existingRobot({ battery: 99 }) });
    const update = await send({ battery: 99, status: "IDLE", timestamp: Date.now() - 100, sequence: 1, energy: { batterySource: "DEMO_SIMULATION" } });
    expect(update).toMatchObject({ battery: 99, batteryProvenance: "DEMO_SIMULATED" });
    expect(prisma.batteryState.updateMany).not.toHaveBeenCalled();
  });

  test("an unlabelled physical battery is UNVERIFIED (shown, never planned with), as the Pi sends it today", async () => {
    authenticate();
    robotReads({ row: existingRobot({ battery: 99 }) });
    const update = await send({ battery: 99, status: "IDLE", timestamp: Date.now() - 100, sequence: 1 });
    expect(update.batteryProvenance).toBe("UNVERIFIED");
    expect(prisma.batteryState.updateMany).not.toHaveBeenCalled();
  });

  test("a simulated robot is unchanged: its fix is its Observation, its battery is the simulator's", async () => {
    authenticate("SIM-A");
    robotReads({ simulated: true });
    prisma.batteryState.updateMany.mockResolvedValue({ count: 1 });
    prisma.agent.findUnique.mockResolvedValue({ id: "agent-row-1" });

    const update = await send({ lat: 12.9, lon: 77.5, battery: 50, status: "ACTIVE", timestamp: Date.now() - 100, sequence: 1 });

    expect(update.batteryProvenance).toBe("SIMULATOR");
    expect(update.position).toMatchObject({ status: "LIVE", provenance: "SIMULATED", qualified: null });
    await waitFor(() => prisma.batteryState.updateMany.mock.calls.length > 0);
  });
});

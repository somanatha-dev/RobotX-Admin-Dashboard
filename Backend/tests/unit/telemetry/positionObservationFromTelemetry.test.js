"use strict";

/**
 * STEP 5 — the position Observation, driven through the *real* telemetry handler.
 *
 * ── Why this file exists beside `tests/engine/positionObservationPipeline.test.js` ──
 * That file tests the writer. This one tests the *wiring*, and the two are different
 * claims. Every one of Step 5's refusal requirements — unauthenticated, capability-claim,
 * trust-boundary-refused — is enforced by a `return` in `telemetry.handler.js` that the
 * writer never sees, so a test that called the writer directly could not tell a handler
 * that refuses from a handler that has no such branch at all.
 *
 * The handler is driven exactly as production drives it: a socket event, through the real
 * zod schema, the real rate limiter and the real Redis facade.
 */

const { createTestKv } = require("../../helpers/testKv");
const { createFakeSocket, createFakeIo } = require("../../helpers/fakeSocket");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { waitFor } = require("../../helpers/waitFor");
const silentLogger = require("../../mocks/silentLogger");

const AGENT_MEASURED_AT = 1_700_000_000_000;

function existingRobot(overrides = {}) {
  return { id: "db-robot-1", status: "IDLE", lat: 12.9716, lon: 77.5946, speed: 0, battery: 50, isOnline: true, ...overrides };
}

describe("telemetry.handler — STEP 5: the canonical position Observation", () => {
  let prisma;
  let kv;
  let io;
  let socket;
  let positionObservation;

  beforeEach(async () => {
    jest.resetModules();
    const handler = require("../../../src/sockets/handlers/telemetry.handler");
    positionObservation = require("../../../src/services/positionObservation.service");
    positionObservation.resetPositionObservationState();
    handler.resetPositionObservationLogState();
    handler.resetTrustBoundaryState();

    prisma = createMockPrisma();
    prisma.zone.findMany.mockResolvedValue([]);
    prisma.robot.update.mockResolvedValue({});
    prisma.observation.findFirst.mockResolvedValue(null);
    ({ kv } = await createTestKv());
    io = createFakeIo();
    socket = createFakeSocket();
    handler.registerTelemetryHandlers(io, socket, { prisma, kv, logger: silentLogger });
  });

  /** `robot.findUnique` serves two different reads; answer each by its `select`. */
  function robotReads({ simulated, agentRowId = "agent-row-1", row = existingRobot() }) {
    prisma.robot.findUnique.mockImplementation(async ({ select }) => {
      if (select && "agent" in select) return { simulated, agent: agentRowId ? { id: agentRowId } : null };
      return row;
    });
  }

  function authenticate(robotId = "RBT-1") {
    socket.data.isAuthed = true;
    socket.data.robotId = robotId;
  }

  const observationsWritten = () => prisma.observation.create.mock.calls.map(([{ data }]) => data);

  // ═════════════════════════════════════════════════════════════════════════
  test("accepted PHYSICAL telemetry creates a position Observation", async () => {
    authenticate();
    robotReads({ simulated: false });

    socket.trigger("TELEMETRY", {
      lat: 12.9716, lon: 77.5946, battery: 50, status: "ACTIVE",
      timestamp: AGENT_MEASURED_AT, sequence: 1,
    });

    await waitFor(() => prisma.observation.create.mock.calls.length > 0);
    const [written] = observationsWritten();
    expect(written).toMatchObject({
      agentId: "agent-row-1",
      kind: "position",
      source: "AGENT_REPORT",
      value: { lat: 12.9716, lon: 77.5946, provenance: "PHYSICAL" },
    });
    expect(written.observedAt.getTime()).toBe(AGENT_MEASURED_AT);
  });

  test("accepted SIMULATED telemetry creates a position Observation through the same handler", async () => {
    authenticate("SIM-A");
    robotReads({ simulated: true, agentRowId: "agent-row-sim" });

    // Battery matches the stored row: §23.5's energy row rejects a SoC that *rises* while
    // not charging, and a frame refused for that reason is correctly not evidence. This
    // test is about provenance, so it does not also trip that rule.
    socket.trigger("TELEMETRY", {
      lat: 12.8, lon: 77.4, battery: 50, status: "ACTIVE",
      timestamp: AGENT_MEASURED_AT, sequence: 1,
    });

    await waitFor(() => prisma.observation.create.mock.calls.length > 0);
    const [written] = observationsWritten();
    expect(written).toMatchObject({ agentId: "agent-row-sim", kind: "position", source: "AGENT_REPORT" });
    expect(written.value.provenance).toBe("SIMULATED");
  });

  test("the simulated frame is distinguishable from the physical one and is not physical evidence", async () => {
    authenticate("SIM-A");
    robotReads({ simulated: true, agentRowId: "agent-row-sim" });
    socket.trigger("TELEMETRY", { lat: 1, lon: 2, battery: 50, timestamp: AGENT_MEASURED_AT, sequence: 1 });
    await waitFor(() => prisma.observation.create.mock.calls.length > 0);

    const [written] = observationsWritten();
    expect(positionObservation.isSimulatedEvidence(written)).toBe(true);
    expect(positionObservation.isPhysicalEvidence(written)).toBe(false);
  });

  // ═════════════════════════════════════════════════════════════════════════
  test("UNAUTHENTICATED telemetry creates no position Observation", async () => {
    // `socket.data.isAuthed` deliberately unset — F26's rule, upstream of everything here.
    robotReads({ simulated: false });

    socket.trigger("TELEMETRY", { robotId: "RBT-1", lat: 1, lon: 2, timestamp: AGENT_MEASURED_AT, sequence: 1 });

    await waitFor(() => socket.sent.some((s) => s.event === "AUTH_REQUIRED"));
    expect(prisma.observation.create).not.toHaveBeenCalled();
  });

  test("CAPABILITY-CLAIMING telemetry creates no position Observation — the frame is dropped whole", async () => {
    authenticate();
    robotReads({ simulated: false });

    socket.trigger("TELEMETRY", {
      lat: 1, lon: 2, battery: 50, timestamp: AGENT_MEASURED_AT, sequence: 1,
      // §23.2/§23.5: a capability claim on agent telemetry is rejected entirely.
      capabilities: ["hazmat_certified"],
    });

    // The refusal path emits a SECURITY_EVENT only past the threshold, so the observable
    // fact is the absence: wait long enough for the accepted path to have written.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(prisma.observation.create).not.toHaveBeenCalled();
    expect(io.emittedTo("dashboard", "robot:update")).toHaveLength(0);
  });

  test("telemetry REFUSED by the §23.5 trust boundaries creates no position Observation", async () => {
    authenticate();
    // A kinematically impossible jump against a MobilityModel ceiling: the last accepted
    // fix is in Bengaluru and this frame claims Chennai a second later.
    robotReads({ simulated: false, row: existingRobot({ maxSpeedMps: 2 }) });

    socket.trigger("TELEMETRY", { lat: 12.9716, lon: 77.5946, battery: 50, timestamp: AGENT_MEASURED_AT, sequence: 1 });
    await waitFor(() => prisma.observation.create.mock.calls.length === 1);

    await new Promise((resolve) => setTimeout(resolve, 150));
    socket.trigger("TELEMETRY", { lat: 13.0827, lon: 80.2707, battery: 50, timestamp: AGENT_MEASURED_AT + 1000, sequence: 2 });
    await waitFor(() => io.emittedTo("dashboard", "robot:update").length > 1);

    // Still one: the implausible frame is refused, and a refused frame is not evidence.
    expect(prisma.observation.create).toHaveBeenCalledTimes(1);
  });

  // ═════════════════════════════════════════════════════════════════════════
  test("a frame with NO agent timestamp creates no Observation — receipt time is not substituted", async () => {
    authenticate();
    robotReads({ simulated: false });

    socket.trigger("TELEMETRY", { lat: 1, lon: 2, battery: 50, status: "ACTIVE" });

    await waitFor(() => io.emittedTo("dashboard", "robot:update").length > 0);
    // The rest of the legacy pipeline ran — the live state was published — and no
    // Observation was invented for it.
    expect(prisma.observation.create).not.toHaveBeenCalled();
  });

  test("a frame that reports no position of its own creates no Observation from the fallback position", async () => {
    authenticate();
    robotReads({ simulated: false });

    // `fullState.lat/lon` will fall back to the DB row's 12.9716/77.5946. Pairing those
    // with this frame's fresh timestamp would be a measurement nobody took.
    socket.trigger("TELEMETRY", { battery: 50, status: "ACTIVE", timestamp: AGENT_MEASURED_AT, sequence: 1 });

    await waitFor(() => io.emittedTo("dashboard", "robot:update").length > 0);
    expect(prisma.observation.create).not.toHaveBeenCalled();
  });

  test("an unprojected robot (no Agent row) creates no Observation and no Agent is invented", async () => {
    authenticate();
    robotReads({ simulated: false, agentRowId: null });

    socket.trigger("TELEMETRY", { lat: 1, lon: 2, battery: 50, timestamp: AGENT_MEASURED_AT, sequence: 1 });

    await waitFor(() => io.emittedTo("dashboard", "robot:update").length > 0);
    expect(prisma.observation.create).not.toHaveBeenCalled();
    expect(prisma.agent.upsert).not.toHaveBeenCalled();
  });

  test("an Observation write failure does not take down the telemetry pipeline", async () => {
    authenticate();
    robotReads({ simulated: false });
    prisma.observation.create.mockRejectedValue(new Error("db down"));

    socket.trigger("TELEMETRY", { lat: 1, lon: 2, battery: 50, status: "ACTIVE", timestamp: AGENT_MEASURED_AT, sequence: 1 });

    // The live state is still published: a missing index entry must not cost a telemetry
    // frame. (It is logged at `error`, not swallowed — see `writePositionObservation`.)
    await waitFor(() => io.emittedTo("dashboard", "robot:update").length > 0);
  });
});

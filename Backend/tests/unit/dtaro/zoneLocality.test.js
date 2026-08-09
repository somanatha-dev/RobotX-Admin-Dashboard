const { createTestKv } = require("../../helpers/testKv");
const { createFakeSocket, createFakeIo } = require("../../helpers/fakeSocket");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { waitFor } = require("../../helpers/waitFor");
const silentLogger = require("../../mocks/silentLogger");

// F6 — zone-locality is a real, live input to the DTARO cost function.
//
// The cost function's Z term (`costEvaluator.service.js`) reads a candidate's
// `zoneId`, which is only ever populated from the robot registry (Redis) or
// the `Robot.zoneId` column. If nothing on the telemetry path actually writes
// that field, every candidate scores Z=1 whenever the pickup's zone is known —
// a constant offset with zero effect on ranking, i.e. the term is inert even
// though it is present in the formula.
//
// These tests pin the write path itself, not just the arithmetic:
//   1. a telemetry tick inside a zone persists that zone to the registry
//   2. the persisted value is what makes Z discriminate between candidates
//   3. a robot that has not changed zone does not re-broadcast ZONE_UPDATED
//
// (3) is the same root cause as (1): with `zoneId` never persisted, the
// "did the zone change?" check in `zoneManager.assignRobotToZone` compares a
// real zone against a permanently-null previous value and is therefore true on
// EVERY tick, turning a state-change notification into a per-tick broadcast.

const ZONE_A = { id: "zone-a", name: "Campus Zone-NE", minLat: 12.9, maxLat: 13.0, minLon: 77.5, maxLon: 77.6 };
const ZONE_B = { id: "zone-b", name: "Campus Zone-SW", minLat: 12.7, maxLat: 12.8, minLon: 77.3, maxLon: 77.4 };

// Inside ZONE_A / inside ZONE_B respectively.
const IN_A = { lat: 12.95, lon: 77.55 };
const IN_B = { lat: 12.75, lon: 77.35 };

function existingRobot(overrides = {}) {
  return {
    id: "db-robot-1", status: "ACTIVE", lat: IN_A.lat, lon: IN_A.lon,
    speed: 0, battery: 50, isOnline: true,
    ...overrides,
  };
}

/** Every ZONE_UPDATED payload broadcast to the `dashboard` room. */
function zoneUpdates(io) {
  return io.emittedTo("dashboard", "ZONE_UPDATED");
}

describe("DTARO zone-locality (F6) — registry persistence + change detection", () => {
  let prisma;
  let kv;
  let io;
  let socket;
  let registerTelemetryHandlers;
  let getRobotState;

  beforeEach(async () => {
    // telemetry.handler.js and zoneManager.service.js both hold module-level
    // caches (the F10 flush gate and the 60s in-process zone cache). Reset so
    // each test starts from a clean slate rather than inheriting timing state.
    jest.resetModules();
    ({ registerTelemetryHandlers } = require("../../../src/sockets/handlers/telemetry.handler"));
    ({ getRobotState } = require("../../../src/services/robotRegistry.service"));

    prisma = createMockPrisma();
    prisma.zone.findMany.mockResolvedValue([ZONE_A, ZONE_B]);
    prisma.robot.update.mockResolvedValue({});
    ({ kv } = await createTestKv());
    io = createFakeIo();
    socket = createFakeSocket();
    registerTelemetryHandlers(io, socket, { prisma, kv, logger: silentLogger });

    socket.data.isAuthed = true;
    socket.data.robotId = "R1";
  });

  test("a telemetry tick inside a zone persists that zone to the robot registry", async () => {
    prisma.robot.findUnique.mockResolvedValue(existingRobot());

    socket.trigger("TELEMETRY", { ...IN_A, battery: 50, status: "ACTIVE" });
    await waitFor(() => io.emittedTo("dashboard", "robot:update").length > 0);

    // Without this, `registry.zoneId` is undefined forever and the Z term
    // in the cost function can never discriminate between candidates.
    await waitFor(async () => (await getRobotState(kv, "R1"))?.zoneId === ZONE_A.id);
    const registry = await getRobotState(kv, "R1");
    expect(registry.zoneId).toBe(ZONE_A.id);
  });

  // PHASE 15 — these two tests used to call `costEvaluator.service.computeCosts` and assert
  // that its Z term discriminated by zone. That module is gone: §1.3 prohibits the min-max
  // normalisation it was built on ("a 10 km mission must cost more than a 1 km mission, all
  // else equal — a property the baseline's min-max normalisation cannot satisfy"), Phase 8
  // replaced it with absolute-CU cost terms, and Phase 15 removed it from the build.
  //
  // What the tests were really pinning survives, and is what is pinned here: the *write
  // path*. A zone that is never persisted cannot influence any allocation under either cost
  // model, so the regression guard is still worth having. The consumers are now
  // `cost/cOpportunity.js` (λ_zone is keyed by zone) and `cost/cPolicy.js` (zone affinity).
  test("the persisted zone is the value a zone-keyed cost term would read", async () => {
    prisma.robot.findUnique.mockResolvedValue(existingRobot());

    socket.trigger("TELEMETRY", { ...IN_A, battery: 50, status: "ACTIVE" });
    await waitFor(async () => (await getRobotState(kv, "R1"))?.zoneId === ZONE_A.id);

    // λ_zone (§8.3) and the zone-affinity credit (§8.6) are both keyed by exactly this id.
    expect((await getRobotState(kv, "R1")).zoneId).toBe(ZONE_A.id);
  });

  test("a robot that never reported carries no zone at all (regression guard)", async () => {
    const unseen = await getRobotState(kv, "R-never-reported");
    // Absent, not defaulted. §6's missing-data policy: a zone-affinity credit granted to an
    // agent whose zone nobody recorded would be a policy credit applied on absent evidence,
    // which is the pre-fix production state this guard exists to keep out.
    expect(unseen === null || unseen.zoneId === null || unseen.zoneId === undefined).toBe(true);
  });

  describe("ZONE_UPDATED is a state-change notification, not a per-tick broadcast", () => {
    test("five consecutive ticks in the SAME zone broadcast ZONE_UPDATED exactly once", async () => {
      prisma.robot.findUnique.mockResolvedValue(existingRobot());

      const TICKS = 5;
      for (let i = 0; i < TICKS; i++) {
        // TELEMETRY enforces a 100ms minimum interval per socket; anything
        // faster is silently dropped rather than processed.
        if (i > 0) await new Promise((r) => setTimeout(r, 120));
        socket.trigger("TELEMETRY", { ...IN_A, battery: 50, status: "ACTIVE" });
        await waitFor(() => io.emittedTo("dashboard", "robot:update").length >= i + 1);
      }

      // Give any trailing best-effort zone work a moment to land.
      await new Promise((r) => setTimeout(r, 50));

      expect(io.emittedTo("dashboard", "robot:update")).toHaveLength(TICKS);
      // The robot never left ZONE_A, so exactly one zone transition occurred
      // (null -> ZONE_A on the first tick). Pre-fix this is TICKS broadcasts.
      expect(zoneUpdates(io)).toHaveLength(1);
    });

    test("crossing into a different zone broadcasts exactly one further ZONE_UPDATED", async () => {
      prisma.robot.findUnique.mockResolvedValue(existingRobot());

      socket.trigger("TELEMETRY", { ...IN_A, battery: 50, status: "ACTIVE" });
      await waitFor(() => io.emittedTo("dashboard", "robot:update").length > 0);
      await waitFor(() => zoneUpdates(io).length === 1);

      await new Promise((r) => setTimeout(r, 120));
      prisma.robot.findUnique.mockResolvedValue(existingRobot({ lat: IN_B.lat, lon: IN_B.lon }));
      socket.trigger("TELEMETRY", { ...IN_B, battery: 50, status: "ACTIVE" });
      await waitFor(() => zoneUpdates(io).length === 2);

      const [, second] = zoneUpdates(io);
      expect(second).toMatchObject({
        robotId: "R1",
        oldZoneId: ZONE_A.id,
        newZoneId: ZONE_B.id,
      });

      // …and the new zone is persisted, so the next tick is a no-op again.
      await waitFor(async () => (await getRobotState(kv, "R1"))?.zoneId === ZONE_B.id);
    });
  });
});

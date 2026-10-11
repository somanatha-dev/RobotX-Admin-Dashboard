/**
 * P7-D1 — FIXED (was a characterisation of the defect). Through the REAL telemetry handler.
 *
 * Measured on LOCAL before the fix: every simulated robot that auto-docked to charge stayed
 * `Robot.status = PAUSED` for good — CHARGING was persisted as PAUSED (the enum has no CHARGING),
 * PAUSED is an F3 operator hold, and the robot's IDLE after charging was refused by §23.5
 * (SIM-0A8C043FFE67: 4 595 refusals in one backend lifetime; SIM-1ABF/CFE1: 6 259 / 6 213).
 *
 * Now:
 *   · a CHARGING report writes NO `Robot.status` — charging is the reservation's (and F18's
 *     restriction on a live CHARGING report, `p7d1HoldAndRestore`), not an operator hold;
 *   · so after the charge nothing is left to clear: the robot was never PAUSED;
 *   · an operator hold (PAUSED) and a fault (ERROR) are still never cleared by the robot's own
 *     IDLE/ACTIVE report, and a CHARGING report does not clear them either.
 *
 * MOCKED BOUNDARY: the store (a Prisma double whose Robot row is real state, as in
 * `telemetryStatusStaleWrite.test.js`) and `agentGate.mayAct` (engine enabled). The telemetry
 * handler, the KV facade, the status-precedence mapping, the simulated facts and F3 are real.
 */

const { createTestKv } = require("../../helpers/testKv");
const { createFakeSocket, createFakeIo } = require("../../helpers/fakeSocket");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { waitFor } = require("../../helpers/waitFor");
const silentLogger = require("../../mocks/silentLogger");

const ROBOT = "SIM-P7-CHARGER";

function statefulPrisma(initial) {
  const prisma = createMockPrisma();
  const row = { id: "db-robot", robotId: ROBOT, lat: 12.9011, lon: 77.5175, speed: 0, battery: 10, isOnline: true, socketId: "sock", currentTaskId: null, simulated: true, createdAt: new Date("2026-10-06T07:25:11Z"), ...initial };
  const applied = [];
  const matches = (where) =>
    Object.entries(where || {}).every(([key, value]) =>
      value && typeof value === "object" && Array.isArray(value.in) ? value.in.includes(row[key]) : row[key] === value,
    );
  prisma.robot.findUnique.mockImplementation(async () => ({ ...row }));
  prisma.robot.update.mockImplementation(async ({ data }) => {
    Object.assign(row, data);
    if (data.status !== undefined) applied.push(data.status);
    return { ...row };
  });
  prisma.robot.updateMany.mockImplementation(async ({ where, data }) => {
    if (!matches(where)) return { count: 0 };
    Object.assign(row, data);
    if (data.status !== undefined) applied.push(data.status);
    return { count: 1 };
  });
  prisma.zone.findMany.mockResolvedValue([]);
  prisma.event.create.mockResolvedValue({});
  return { prisma, applied, row };
}

const handles = [];
beforeEach(() => jest.resetModules());
afterEach(async () => {
  jest.restoreAllMocks();
  require("../../../src/cache/robotStateCache").del(ROBOT);
  while (handles.length > 0) await handles.pop().close();
});

const frame = (status, battery, lat) => ({ lat, lon: 77.5175, battery, speed: 0, status });

async function frameDone(kv, lat) {
  await waitFor(async () => JSON.parse((await kv.get(`registry:${ROBOT}`)) || "{}").lat === lat);
  await new Promise((r) => setTimeout(r, 30));
}

/** Wire the real handler to a stateful store; return the pieces a test drives. */
async function wired(initial) {
  const { kv, close } = await createTestKv();
  handles.push({ close });
  const agentGate = require("../../../src/engine/cutover/agentGate");
  jest.spyOn(agentGate, "mayAct").mockReturnValue(true); // the engine is enabled on LOCAL
  const { registerTelemetryHandlers } = require("../../../src/sockets/handlers/telemetry.handler");
  const robotStateCache = require("../../../src/cache/robotStateCache");
  const store = statefulPrisma(initial);
  robotStateCache.set(ROBOT, { id: store.row.id, status: store.row.status, isOnline: true, lat: store.row.lat, lon: store.row.lon, battery: store.row.battery, speed: 0 });
  const io = createFakeIo();
  const socket = createFakeSocket({ id: "sock" });
  socket.data.isAuthed = true;
  socket.data.robotId = ROBOT;
  registerTelemetryHandlers(io, socket, { prisma: store.prisma, kv, logger: silentLogger, appLocals: { config: {} } });
  let lat = 12.9011;
  /** One frame, after the handler's minimum interval, with the row re-read as after any flush. */
  async function send(status, battery) {
    robotStateCache.del(ROBOT);
    await new Promise((r) => setTimeout(r, 150)); // TELEMETRY min interval
    lat += 0.00001;
    socket.trigger("TELEMETRY", frame(status, battery, lat));
    await frameDone(kv, lat);
  }
  return { kv, store, send };
}

describe("FIXED P7-D1 — a charging dock is not an operator hold, and a hold is not cleared by self-report", () => {
  test("CHARGING writes no status: the robot stays IDLE, F3 holds nothing, and after the charge there is nothing to clear", async () => {
    const simulatedAgentState = require("../../../src/simulation/simulatedAgentState");
    const f03 = require("../../../src/engine/feasibility/predicates/f03");
    const { kv, store, send } = await wired({ status: "IDLE", battery: 10 });

    await send("CHARGING", 10);
    await send("CHARGING", 10.2);
    expect(store.row.status).toBe("IDLE");
    expect(store.applied).toEqual([]);
    // The live registry carries the robot's own CHARGING (what F18's live restriction reads).
    expect(JSON.parse(await kv.get(`registry:${ROBOT}`)).status).toBe("CHARGING");
    const facts = simulatedAgentState.simulatedAgentFacts({ robot: { ...store.row }, regionZoneIds: [] });
    expect(facts.operatorHold).toEqual({ held: false });
    expect(f03.evaluate({ agentSnapshot: { lifecycleState: "ACTIVE", operatorHold: facts.operatorHold } }).outcome).toBe("SATISFIED");

    // Charge complete: the robot reports IDLE, and nothing had ever been held.
    await send("IDLE", store.row.battery);
    expect(store.row.status).toBe("IDLE");
    expect(store.applied).toEqual([]);
  });

  test("an operator hold (PAUSED) survives any number of IDLE, ACTIVE and CHARGING reports", async () => {
    const { store, send } = await wired({ status: "PAUSED", battery: 80 });
    await send("IDLE", 79.99);
    await send("ACTIVE", 79.98);
    await send("CHARGING", 79.98);
    await send("IDLE", 79.97);
    expect(store.row.status).toBe("PAUSED");
    expect(store.applied).toEqual([]);
  });

  test("a fault (ERROR) survives the robot's own IDLE and ACTIVE reports", async () => {
    const { store, send } = await wired({ status: "ERROR", battery: 60 });
    await send("IDLE", 59.99);
    await send("ACTIVE", 59.98);
    expect(store.row.status).toBe("ERROR");
    expect(store.applied).toEqual([]);
  });

  test("a robot may still restrict itself: PAUSED reported over IDLE is written", async () => {
    const { store, send } = await wired({ status: "IDLE", battery: 60 });
    await send("PAUSED", 59.99);
    expect(store.row.status).toBe("PAUSED");
  });
});

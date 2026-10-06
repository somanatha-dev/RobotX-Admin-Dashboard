/**
 * Robot.status stale-write guard (telemetry.handler).
 *
 * A TELEMETRY frame validates its status transition against the status cached at the top of
 * the frame, then awaits before it writes Robot.status. A newer writer can change the row in
 * between: ROBOT_FAULT's ERROR, the disconnect's OFFLINE, an operator's clear-fault. The write
 * used to be unconditional, so the frame's status replaced the newer one: TELEMETRY(ACTIVE) then
 * ROBOT_FAULT back-to-back ended with Robot.status ACTIVE, erasing a blocking fault and
 * defeating §23.5 (reproduced by the 2026-10-06 safety audit, deterministically).
 *
 * Everything here goes through the real handlers: `registerTelemetryHandlers`,
 * `registerDtaroHandlers` (ROBOT_FAULT), the real kv facade and robotStateCache. The store is a
 * Prisma double whose Robot row is real state: `update` applies, `updateMany` applies only where
 * its `where` matches, `findUnique` reads the row.
 */

const { createTestKv } = require("../../helpers/testKv");
const { createFakeSocket, createFakeIo } = require("../../helpers/fakeSocket");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { waitFor } = require("../../helpers/waitFor");
const silentLogger = require("../../mocks/silentLogger");

const ROBOT = "R-STATUS";

/** The real kv; the next pipeline that READS `registry:{robot}` parks after its reply (the frame's first await after validation). */
function gatedKv(kv, robotId) {
  let release;
  const released = new Promise((r) => (release = r));
  let reachedResolve;
  const reached = new Promise((r) => (reachedResolve = r));
  let armed = true;
  const wrapper = Object.create(kv);
  wrapper.pipeline = () => {
    const inner = kv.pipeline();
    let reads = false;
    const builder = {
      get(key) {
        if (key === `registry:${robotId}`) reads = true;
        inner.get(key);
        return builder;
      },
      set(key, value, options) {
        inner.set(key, value, options);
        return builder;
      },
      async exec() {
        const out = await inner.exec();
        if (reads && armed) {
          armed = false;
          reachedResolve();
          await released;
        }
        return out;
      },
    };
    return builder;
  };
  return { kv: wrapper, reached, release };
}

function matches(row, where) {
  return Object.entries(where || {}).every(([key, value]) => {
    if (value && typeof value === "object" && Array.isArray(value.in)) return value.in.includes(row[key]);
    return row[key] === value;
  });
}

/** A Prisma double whose Robot row is real state, and a log of every status the store applied. */
function statefulPrisma(initial) {
  const prisma = createMockPrisma();
  let row = { id: "db-robot", robotId: ROBOT, lat: 12.9, lon: 77.5, speed: 0, battery: 60, isOnline: true, socketId: "sock", currentTaskId: null, ...initial };
  const applied = [];
  const delay = () => new Promise((r) => setTimeout(r, 2)); // a write takes a round trip
  prisma.robot.findUnique.mockImplementation(async () => (row ? { ...row } : null));
  prisma.robot.update.mockImplementation(async ({ where, data }) => {
    await delay();
    if (!row || row.robotId !== where.robotId) {
      const e = new Error("Record to update not found.");
      e.code = "P2025";
      throw e;
    }
    Object.assign(row, data);
    if (data.status !== undefined) applied.push({ via: "update", status: data.status });
    return { ...row };
  });
  prisma.robot.updateMany.mockImplementation(async ({ where, data }) => {
    await delay();
    if (!row || !matches(row, where)) return { count: 0 };
    Object.assign(row, data);
    if (data.status !== undefined) applied.push({ via: "updateMany", status: data.status, where });
    return { count: 1 };
  });
  prisma.zone.findMany.mockResolvedValue([]);
  prisma.event.create.mockResolvedValue({});
  return {
    prisma,
    applied,
    get row() {
      return row;
    },
    set: (patch) => Object.assign(row, patch),
    remove: () => {
      row = null;
    },
  };
}

function rig({ status, engineOn, gate, cacheStatus }) {
  const agentGate = require("../../../src/engine/cutover/agentGate");
  jest.spyOn(agentGate, "mayAct").mockReturnValue(Boolean(engineOn));
  const { registerTelemetryHandlers } = require("../../../src/sockets/handlers/telemetry.handler");
  const { registerDtaroHandlers } = require("../../../src/sockets/handlers/dtaro.handler");
  const robotStateCache = require("../../../src/cache/robotStateCache");
  const store = statefulPrisma({ status });
  robotStateCache.set(ROBOT, { id: store.row.id, status: cacheStatus || status, isOnline: true, lat: 12.9, lon: 77.5, battery: 60, speed: 0 });
  const io = createFakeIo();
  const socket = createFakeSocket({ id: "sock" });
  socket.data.isAuthed = true;
  socket.data.robotId = ROBOT;
  return { store, io, socket, robotStateCache, registerTelemetryHandlers, registerDtaroHandlers };
}

const frame = (status, lat = 12.9001) => ({ lat, lon: 77.5001, battery: 60, speed: 0, status });

async function frameDone(kv, lat) {
  await waitFor(async () => JSON.parse((await kv.get(`registry:${ROBOT}`)) || "{}").lat === lat);
  await new Promise((r) => setTimeout(r, 30));
}

async function fault(socket) {
  socket.trigger("ROBOT_FAULT", { code: "MOTOR", message: "driver overcurrent" });
  await waitFor(() => socket.sent.some((s) => s.event === "ROBOT_FAULT_ACK"));
}

const handles = [];
async function freshKv() {
  const handle = await createTestKv();
  handles.push(handle);
  return handle.kv;
}

beforeEach(() => jest.resetModules());
afterEach(async () => {
  jest.restoreAllMocks();
  require("../../../src/cache/robotStateCache").del(ROBOT);
  while (handles.length > 0) await handles.pop().close();
});

describe("Robot.status — a stale telemetry frame never overwrites a newer status", () => {
  test("TELEMETRY(ACTIVE) then ROBOT_FAULT back-to-back, no hold anywhere (the audit's reproduction) → ERROR stays", async () => {
    const kv = await freshKv();
    const t = rig({ status: "IDLE", engineOn: true });
    t.registerTelemetryHandlers(t.io, t.socket, { prisma: t.store.prisma, kv, logger: silentLogger, appLocals: { config: {} } });
    t.registerDtaroHandlers(t.io, t.socket, { prisma: t.store.prisma, kv, logger: silentLogger });

    t.socket.trigger("TELEMETRY", frame("ACTIVE"));
    await fault(t.socket);
    await frameDone(kv, 12.9001);

    // Before the guard the store applied ERROR then ACTIVE. Now the stale ACTIVE matches nothing.
    expect(t.store.applied.map((a) => a.status)).toEqual(["ERROR"]);
    expect(t.store.row.status).toBe("ERROR");
    expect((t.robotStateCache.get(ROBOT) || {}).status).not.toBe("ACTIVE");
  });

  test.each([
    ["engine on (§23.5 enforced)", true],
    ["engine off (§23.5 staged)", false],
  ])("validated against ACTIVE, the fault lands inside the frame, the frame then writes → ERROR stays (%s)", async (_label, engineOn) => {
    const real = await freshKv();
    const gate = gatedKv(real, ROBOT);
    const t = rig({ status: "ACTIVE", engineOn });
    t.registerTelemetryHandlers(t.io, t.socket, { prisma: t.store.prisma, kv: gate.kv, logger: silentLogger, appLocals: { config: {} } });
    t.registerDtaroHandlers(t.io, t.socket, { prisma: t.store.prisma, kv: real, logger: silentLogger });

    t.socket.trigger("TELEMETRY", frame("ACTIVE")); // validated against the cached ACTIVE
    await gate.reached;
    await fault(t.socket); // the row becomes ERROR
    expect(t.store.row.status).toBe("ERROR");
    gate.release();
    await frameDone(real, 12.9001);

    expect(t.store.row.status).toBe("ERROR");
    expect(t.store.applied.filter((a) => a.status === "ACTIVE")).toEqual([]);
    // The attempted write was conditional on the status the frame validated against.
    const attempt = t.store.prisma.robot.updateMany.mock.calls.find(([args]) => args.data.status === "ACTIVE");
    expect(attempt[0].where).toEqual({ robotId: ROBOT, status: "ACTIVE" });
    expect((t.robotStateCache.get(ROBOT) || {}).status).not.toBe("ACTIVE");
  });

  test("OFFLINE written after validation (a disconnect) is kept, isOnline included", async () => {
    const real = await freshKv();
    const gate = gatedKv(real, ROBOT);
    const t = rig({ status: "ACTIVE", engineOn: true });
    t.registerTelemetryHandlers(t.io, t.socket, { prisma: t.store.prisma, kv: gate.kv, logger: silentLogger, appLocals: { config: {} } });

    t.socket.trigger("TELEMETRY", frame("ACTIVE"));
    await gate.reached;
    t.store.set({ status: "OFFLINE", isOnline: false, socketId: null }); // markRobotOffline's write
    gate.release();
    await frameDone(real, 12.9001);

    expect(t.store.row).toMatchObject({ status: "OFFLINE", isOnline: false });
  });

  test("after a superseded write the next frame reads the row and validates against it (§23.5 then refuses ACTIVE over ERROR)", async () => {
    const real = await freshKv();
    const gate = gatedKv(real, ROBOT);
    const t = rig({ status: "ACTIVE", engineOn: true });
    t.registerTelemetryHandlers(t.io, t.socket, { prisma: t.store.prisma, kv: gate.kv, logger: silentLogger, appLocals: { config: {} } });
    t.registerDtaroHandlers(t.io, t.socket, { prisma: t.store.prisma, kv: real, logger: silentLogger });

    t.socket.trigger("TELEMETRY", frame("ACTIVE"));
    await gate.reached;
    await fault(t.socket);
    gate.release();
    await frameDone(real, 12.9001);
    t.robotStateCache.del(ROBOT); // whichever of the fault and the guard ran last, the next frame reads the row
    t.store.prisma.robot.findUnique.mockClear();

    await new Promise((r) => setTimeout(r, 150)); // TELEMETRY min interval
    t.socket.trigger("TELEMETRY", frame("ACTIVE", 12.9002));
    await frameDone(real, 12.9002);

    expect(t.store.prisma.robot.findUnique).toHaveBeenCalled(); // re-read from the store
    expect(t.store.row.status).toBe("ERROR");
    expect(t.robotStateCache.get(ROBOT).status).toBe("ERROR");
  });

  test("a clear-fault inside the frame is kept, and the next frame's legitimate ACTIVE then applies", async () => {
    const real = await freshKv();
    const gate = gatedKv(real, ROBOT);
    const t = rig({ status: "ERROR", engineOn: false }); // staged §23.5: ERROR → ACTIVE is allowed by the table
    t.registerTelemetryHandlers(t.io, t.socket, { prisma: t.store.prisma, kv: gate.kv, logger: silentLogger, appLocals: { config: {} } });

    t.socket.trigger("TELEMETRY", frame("ACTIVE")); // validated against ERROR
    await gate.reached;
    t.store.set({ status: "IDLE" }); // the operator's clear-fault
    gate.release();
    await frameDone(real, 12.9001);
    expect(t.store.row.status).toBe("IDLE"); // the stale frame wrote nothing over it

    await new Promise((r) => setTimeout(r, 150));
    t.socket.trigger("TELEMETRY", frame("ACTIVE", 12.9002)); // validated against IDLE, read from the row
    await frameDone(real, 12.9002);
    expect(t.store.row.status).toBe("ACTIVE");
  });

  test("the robot deleted mid-frame is still reported robot_unregistered (the P2025 path, unchanged)", async () => {
    const real = await freshKv();
    const gate = gatedKv(real, ROBOT);
    const t = rig({ status: "ACTIVE", engineOn: true });
    t.registerTelemetryHandlers(t.io, t.socket, { prisma: t.store.prisma, kv: gate.kv, logger: silentLogger, appLocals: { config: {} } });

    t.socket.trigger("TELEMETRY", frame("IDLE"));
    await gate.reached;
    t.store.remove();
    gate.release();
    await waitFor(() => t.io.emittedTo("dashboard", "robot_unregistered").length > 0);
    expect(t.robotStateCache.get(ROBOT)).toBeNull();
  });
});

describe("Robot.status — legitimate telemetry transitions are unchanged", () => {
  test.each([
    ["ACTIVE", "IDLE"],
    ["IDLE", "ACTIVE"],
  ])("%s → %s is written and cached", async (from, to) => {
    const kv = await freshKv();
    const t = rig({ status: from, engineOn: true });
    t.registerTelemetryHandlers(t.io, t.socket, { prisma: t.store.prisma, kv, logger: silentLogger, appLocals: { config: {} } });
    t.socket.trigger("TELEMETRY", frame(to));
    await frameDone(kv, 12.9001);
    expect(t.store.row.status).toBe(to);
    expect(t.store.applied).toEqual([{ via: "updateMany", status: to, where: { robotId: ROBOT, status: from } }]);
    expect(t.robotStateCache.get(ROBOT)).toMatchObject({ status: to, isOnline: true });
  });

  test("an agent declaring itself unfit (ACTIVE → ERROR) is applied — §23.5's restricting direction", async () => {
    const kv = await freshKv();
    const t = rig({ status: "ACTIVE", engineOn: true });
    t.registerTelemetryHandlers(t.io, t.socket, { prisma: t.store.prisma, kv, logger: silentLogger, appLocals: { config: {} } });
    t.socket.trigger("TELEMETRY", frame("ERROR"));
    await frameDone(kv, 12.9001);
    expect(t.store.row.status).toBe("ERROR");
    expect(t.robotStateCache.get(ROBOT).status).toBe("ERROR");
  });

  test("§23.5 unchanged: ROBOT_FAULT, then a self-reported ACTIVE frame → ERROR kept, no status written", async () => {
    const kv = await freshKv();
    const t = rig({ status: "IDLE", engineOn: true });
    t.registerTelemetryHandlers(t.io, t.socket, { prisma: t.store.prisma, kv, logger: silentLogger, appLocals: { config: {} } });
    t.registerDtaroHandlers(t.io, t.socket, { prisma: t.store.prisma, kv, logger: silentLogger });
    await fault(t.socket);
    t.socket.trigger("TELEMETRY", frame("ACTIVE"));
    await frameDone(kv, 12.9001);
    expect(t.store.row.status).toBe("ERROR");
    expect(t.store.applied.map((a) => a.status)).toEqual(["ERROR"]);
  });

  test("a flush with no status in the frame keeps the plain write (position/battery/liveness only)", async () => {
    const kv = await freshKv();
    const t = rig({ status: "ACTIVE", engineOn: true });
    t.registerTelemetryHandlers(t.io, t.socket, { prisma: t.store.prisma, kv, logger: silentLogger, appLocals: { config: {} } });
    t.socket.trigger("TELEMETRY", { lat: 12.9001, lon: 77.5001, battery: 55, speed: 0 });
    await frameDone(kv, 12.9001);
    expect(t.store.prisma.robot.updateMany).not.toHaveBeenCalled();
    const [[args]] = t.store.prisma.robot.update.mock.calls;
    expect(args.where).toEqual({ robotId: ROBOT });
    expect(args.data).not.toHaveProperty("status");
    expect(t.store.row).toMatchObject({ status: "ACTIVE", battery: 55, isOnline: true });
  });
});

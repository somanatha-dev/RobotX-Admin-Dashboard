"use strict";

/**
 * Replay telemetry frames through the REAL `telemetry.handler`, with the engine on (§23.5
 * enforced), against a mock Robot row that behaves like the database row: conditional writes
 * honour `where.status`, and every accepted write is applied to the row.
 *
 * The handler's per-socket rate limiter and its timestamps read `Date.now()`, so the replay
 * drives a virtual clock that advances by `stepMs` per frame (the simulator's 2 s tick by
 * default) instead of waiting in real time. Each frame is settled by draining the event loop
 * until the handler has either broadcast it (`robot:update`) or refused it (the §23.5 log
 * line), so a refused frame is told apart from a slow one.
 *
 * Requires jest (it resets modules and spies on `agentGate.mayAct`).
 */

const { createTestKv } = require("./testKv");
const { createFakeSocket, createFakeIo } = require("./fakeSocket");
const { createMockPrisma } = require("./mockPrisma");

const SRC = "../../src";

/**
 * @param {object} input
 * @param {string} input.robotId
 * @param {object} input.row the Robot row's starting state ({ status, battery, lat, lon, ... })
 * @param {object} [input.configValues] pinned configuration values (e.g. the quarantine threshold)
 * @param {boolean} [input.engineOn] default true
 * @param {number} [input.startMs] virtual clock start
 * @param {number} [input.stepMs] virtual clock step per frame
 */
async function createTelemetryReplay(input) {
  const { robotId, row, configValues = {}, engineOn = true, startMs = 1_791_800_000_000, stepMs = 2000 } = input;
  jest.resetModules();
  const agentGate = require(`${SRC}/engine/cutover/agentGate`);
  jest.spyOn(agentGate, "mayAct").mockReturnValue(engineOn);
  const { registerTelemetryHandlers } = require(`${SRC}/sockets/handlers/telemetry.handler`);
  const robotStateCache = require(`${SRC}/cache/robotStateCache`);

  const socket = createFakeSocket({ id: `sock-${robotId}` });
  const dbRow = { id: `db-${robotId}`, robotId, speed: 0, isOnline: true, socketId: socket.id, ...row };
  const writes = [];
  const prisma = createMockPrisma();
  prisma.robot.findUnique.mockImplementation(async () => ({ ...dbRow }));
  prisma.robot.update.mockImplementation(async ({ data }) => { writes.push({ ...data }); return Object.assign(dbRow, data); });
  prisma.robot.updateMany.mockImplementation(async ({ where, data }) => {
    if (where.status !== undefined && where.status !== dbRow.status) return { count: 0 };
    writes.push({ ...data });
    Object.assign(dbRow, data);
    return { count: 1 };
  });
  prisma.zone.findMany.mockResolvedValue([]);
  robotStateCache.set(robotId, { id: dbRow.id, status: dbRow.status, isOnline: true, lat: dbRow.lat, lon: dbRow.lon, battery: dbRow.battery, speed: 0 });

  const { kv } = await createTestKv();
  const io = createFakeIo();
  socket.data.isAuthed = true;
  socket.data.robotId = robotId;
  const logLines = [];
  const logger = new Proxy({}, { get: (_t, level) => (msg, meta) => logLines.push({ level: String(level), msg: String(msg), meta }) });

  let virtualNow = startMs;
  const realNow = Date.now;
  registerTelemetryHandlers(io, socket, { prisma, kv, logger, appLocals: { config: { values: configValues } } });

  const refusals = () => logLines.filter((l) => /TELEMETRY refused/.test(l.msg)).length;
  const updates = () => io.emittedTo("dashboard", "robot:update").length;

  /**
   * Send one frame and settle it.
   * @param {object} frame a TELEMETRY payload; its `timestamp` is replaced by the virtual clock
   * @returns {Promise<{ accepted: boolean, refused: boolean, broadcast: object|null }>}
   */
  async function send(frame) {
    virtualNow += stepMs;
    Date.now = () => virtualNow;
    try {
      const before = { refused: refusals(), updates: updates() };
      socket.trigger("TELEMETRY", { ...frame, timestamp: virtualNow });
      for (let i = 0; i < 2000; i += 1) {
        if (updates() > before.updates) {
          return { accepted: true, refused: false, broadcast: io.emittedTo("dashboard", "robot:update").slice(-1)[0] };
        }
        if (refusals() > before.refused) return { accepted: false, refused: true, broadcast: null };
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error(`telemetryReplay: frame neither broadcast nor refused (${JSON.stringify(frame)})`);
    } finally {
      Date.now = realNow;
    }
  }

  return {
    send,
    dbRow,
    writes,
    io,
    kv,
    logLines,
    securityEvents: () => io.emittedTo("dashboard", "SECURITY_EVENT"),
    refusals,
  };
}

module.exports = { createTelemetryReplay };

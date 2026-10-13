"use strict";

/**
 * A working in-memory charging world for simulator tests: the REAL `SimulationEngine`,
 * `VirtualRobot`, `devChargingScheduler`, `chargerRoute` and campus network over the pinned
 * RNSIT declaration of `tests/fixtures/phase7/local-2026-10-09.json`, with only the database
 * (a small store that honours the `where`/`orderBy` shapes the scheduler uses), the sockets,
 * flash and the wall clock replaced.
 *
 * Extracted from `tests/unit/simulation/p7d3RestartRecovery.test.js` (whose own copy is left as
 * it is) for the charging-lifecycle regression suites.
 *
 * Requires jest: `boot` isolates the engine module so each boot records its own instances.
 */

const path = require("path");

const SRC = path.resolve(__dirname, "../../src");
const constants = require(`${SRC}/simulation/constants`);
const devChargingScheduler = require(`${SRC}/simulation/devChargingScheduler`);
const fixture = require("../fixtures/phase7/local-2026-10-09.json");

const VR_PATH = `${SRC}/simulation/VirtualRobot`;
const ENGINE_PATH = `${SRC}/simulation/SimulationEngine`;

const DEPOT_ROW = Object.freeze({ ...fixture.rows.Charger.find((row) => row.chargerId === "V1DEMO-DEPOT-01") });
const DEV_SIM_ROW = Object.freeze({ ...fixture.rows.Charger.find((row) => row.chargerId === "DEV-SIM-RNSIT-MBA-01") });
const MOBILITY = fixture.rows.MobilityModel[0];
const PERMISSION_SET = MOBILITY.permissionSet;
const DECLARATION = fixture.configVersion.payload.deliveryDomain;
const AT_DEPOT = Object.freeze({ lat: DEPOT_ROW.latitude, lon: DEPOT_ROW.longitude });
/** SIM-0A8C043FFE67's LOCAL position, 47 m from the depot (62 m by the campus route). */
const AWAY = Object.freeze({ lat: 12.901151, lon: 77.517575 });
/** The MBA block centroid: a campus point on the network, 156 m from the depot. */
const MBA = Object.freeze({ lat: DEV_SIM_ROW.latitude, lon: DEV_SIM_ROW.longitude });

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function matches(row, where) {
  for (const [field, condition] of Object.entries(where || {})) {
    const value = row[field];
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      if (Array.isArray(condition.in) && !condition.in.includes(value)) return false;
      if (Array.isArray(condition.notIn) && condition.notIn.includes(value)) return false;
      if (condition.lt !== undefined) {
        const left = value instanceof Date ? value.getTime() : value;
        const right = condition.lt instanceof Date ? condition.lt.getTime() : condition.lt;
        if (!(left < right)) return false;
      }
      continue;
    }
    if (value instanceof Date && condition instanceof Date) {
      if (value.getTime() !== condition.getTime()) return false;
      continue;
    }
    if (value !== condition) return false;
  }
  return true;
}

function ordered(rows, orderBy) {
  const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  return [...rows].sort((a, b) => {
    for (const clause of clauses) {
      const [field, direction] = Object.entries(clause)[0];
      let left = a[field];
      let right = b[field];
      if (left instanceof Date) left = left.getTime();
      if (right instanceof Date) right = right.getTime();
      if (left < right) return direction === "desc" ? 1 : -1;
      if (left > right) return direction === "desc" ? -1 : 1;
    }
    return 0;
  });
}

/**
 * @param {{ chargers?: object[] }} [options]
 */
function createWorld({ chargers = [DEPOT_ROW, DEV_SIM_ROW] } = {}) {
  let sequence = 0;
  const rows = {
    charger: chargers.map((row) => ({ ...row })),
    chargerReservation: [],
    chargerAvailabilityProjection: [],
  };
  const robots = new Map();
  const agents = new Map();
  const calls = {};
  const count = (key) => { calls[key] = (calls[key] || 0) + 1; };

  const table = (name) => {
    const list = rows[name];
    return {
      async findFirst({ where, orderBy } = {}) { count(`${name}.findFirst`); return ordered(list.filter((row) => matches(row, where)), orderBy)[0] || null; },
      async findMany({ where, orderBy, take } = {}) {
        count(`${name}.findMany`);
        const found = ordered(list.filter((row) => matches(row, where)), orderBy);
        return take === undefined ? found : found.slice(0, take);
      },
      async count({ where } = {}) { return list.filter((row) => matches(row, where)).length; },
      async findUnique({ where }) {
        count(`${name}.findUnique`);
        const [field, value] = Object.entries(where)[0];
        return list.find((row) => row[field] === value) || null;
      },
      async create({ data }) {
        count(`${name}.create`);
        sequence += 1;
        if (name === "chargerReservation" && list.some((row) => row.reservationId === data.reservationId)) {
          const error = new Error("Unique constraint failed on the fields: (`reservationId`)");
          error.code = "P2002";
          throw error;
        }
        const row = { id: `${name}-${sequence}`, ...data };
        list.push(row);
        return row;
      },
      async update({ where, data }) {
        const row = list.find((entry) => entry.id === where.id);
        if (!row) throw new Error("record not found");
        Object.assign(row, data);
        return row;
      },
      async updateMany({ where, data }) {
        const affected = list.filter((row) => matches(row, where));
        for (const row of affected) Object.assign(row, data);
        return { count: affected.length };
      },
    };
  };

  const prisma = {
    charger: table("charger"),
    chargerReservation: table("chargerReservation"),
    chargerAvailabilityProjection: table("chargerAvailabilityProjection"),
    robot: {
      async findUnique({ where }) {
        const row = robots.get(where.robotId);
        return row ? JSON.parse(JSON.stringify(row)) : null;
      },
    },
    agent: { async findUnique({ where }) { return agents.get(where.id) || null; } },
  };

  return {
    prisma,
    rows,
    robots,
    agents,
    calls,
    runSerializable: (client, fn) => fn(client),
    selectForUpdate: async () => null,
    deps() { return { prisma, runSerializable: this.runSerializable, selectForUpdate: this.selectForUpdate }; },
  };
}

/** A simulated Robot row with its Agent, in the shape `SimulationEngine.addRobot` selects. */
function addRobotRow(world, { robotId, agentRowId, battery, status = "IDLE", statusBeforeOffline = null, packNominalWh = 500, batteryReservePct = null }) {
  world.robots.set(robotId, {
    battery,
    simulated: true,
    massKg: null,
    batteryReservePct,
    status,
    statusBeforeOffline,
    agent: {
      id: agentRowId,
      batteryState: null,
      agentClass: {
        mobilityModel: { kinematicLimits: MOBILITY.kinematicLimits, speedModel: MOBILITY.speedModel, permissionSet: PERMISSION_SET },
        energyModel: { packNominalWh },
        containerModel: null,
        energyModelParams: [],
      },
    },
  });
  world.agents.set(agentRowId, { id: agentRowId, agentId: robotId, robot: { robotId } });
}

/** A reservation as an earlier process left it (`devChargingScheduler.requestPlug`'s shape). */
function seedReservation(world, { agentRowId, charger = DEPOT_ROW, state, fromMs, untilMs, targetSoc = 0.8, ordinal = 0 }) {
  const row = {
    id: `seeded-${agentRowId}-${ordinal}`,
    reservationId: `${charger.chargerId}:${agentRowId}:${ordinal}`,
    agentId: agentRowId,
    chargerDbId: charger.id,
    reservedFrom: new Date(fromMs),
    reservedUntil: new Date(untilMs),
    targetSoc,
    state,
    externalId: null,
    projectionVersion: 1,
  };
  world.rows.chargerReservation.push(row);
  return row;
}

const liveReservations = (world, agentRowId) =>
  world.rows.chargerReservation.filter(
    (row) => (agentRowId === undefined || row.agentId === agentRowId) && devChargingScheduler.LIVE_STATES.includes(row.state),
  );

/** A pinned clock: install in beforeEach, uninstall in afterEach. */
function createClock(start = 1_791_700_000_000) {
  const realNow = Date.now;
  const clock = {
    now: start,
    install() { clock.now = start; Date.now = () => clock.now; },
    uninstall() { Date.now = realNow; },
    advance(ms) { clock.now += ms; },
  };
  return clock;
}

function makeFlash() {
  const values = new Map();
  return {
    async get(key) { return values.has(key) ? values.get(key) : null; },
    async set(key, value) { values.set(key, value); return "OK"; },
    async del(key) { values.delete(key); },
    async sadd() { return 1; },
  };
}

function makeSocket() {
  const emitted = [];
  return { emitted, connected: true, emit(event, payload) { emitted.push({ event, payload }); }, on() {} };
}

const settle = async () => {
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setImmediate(resolve));
  }
};

/** Tick every robot once per step on the pinned clock; `onTick` runs after each step. */
async function runTicks(clock, robots, ticks, onTick) {
  const fleet = Array.isArray(robots) ? robots : [robots];
  for (let i = 0; i < ticks; i += 1) {
    clock.advance(constants.TELEMETRY_INTERVAL_MS);
    for (const robot of fleet) robot._tick();
    // eslint-disable-next-line no-await-in-loop
    await settle();
    // eslint-disable-next-line no-await-in-loop
    if (onTick) await onTick(i);
  }
}

/** Tick until `predicate` holds (or `max` ticks); returns the ticks taken, or -1. */
async function runUntil(clock, robots, predicate, max = 600) {
  for (let i = 0; i < max; i += 1) {
    if (predicate()) return i;
    // eslint-disable-next-line no-await-in-loop
    await runTicks(clock, robots, 1);
  }
  return predicate() ? max : -1;
}

/**
 * Boot a simulator process on `world`: provisioning (+ its restart reconciliation) unless
 * `provision: false`, then `addRobot` for each robot, as `rehydrateSimulatedRobots` does.
 *
 * @returns {Promise<{ simulator, provisioned, verdicts, instances, byId, log }>}
 */
async function boot(clock, world, robots, { provision = true, deliveryDomain = DECLARATION, simulatorOptions = {} } = {}) {
  const instances = [];
  const lines = [];
  const record = (level) => (msg, meta) => lines.push({ level, msg: String(msg), meta: meta || null, at: clock.now });
  const log = { lines, info: record("info"), warn: record("warn"), error: record("error"), debug: record("debug") };
  let createVirtualRobotSimulator;
  jest.isolateModules(() => {
    jest.doMock(VR_PATH, () => {
      const Real = jest.requireActual(VR_PATH);
      return class RecordedVirtualRobot extends Real {
        constructor(options) {
          super(options);
          instances.push(this);
        }
      };
    });
    ({ createVirtualRobotSimulator } = require(ENGINE_PATH));
  });
  const simulator = createVirtualRobotSimulator({
    prisma: world.prisma,
    kv: makeFlash(),
    logger: log,
    enabled: true,
    runSerializable: world.runSerializable,
    selectForUpdate: world.selectForUpdate,
    deliveryDomainFor: () => deliveryDomain,
    ...simulatorOptions,
  });
  const provisioned = provision ? await simulator.provisionCharging({ nowMs: clock.now }) : null;
  const verdicts = [];
  for (const robot of robots) {
    // eslint-disable-next-line no-await-in-loop
    verdicts.push(await simulator.addRobot({ robotId: robot.robotId, lat: robot.at.lat, lon: robot.at.lon, simulated: true }));
  }
  for (const vr of instances) {
    vr.socket = makeSocket();
    vr.connected = true;
  }
  const byId = (robotId) => instances.find((vr) => vr.robotId === robotId);
  return { simulator, provisioned, verdicts, instances, byId, log };
}

module.exports = {
  ENGINE_PATH,
  VR_PATH,
  DEPOT_ROW,
  DEV_SIM_ROW,
  MOBILITY,
  PERMISSION_SET,
  DECLARATION,
  AT_DEPOT,
  AWAY,
  MBA,
  fixture,
  silentLogger,
  createWorld,
  addRobotRow,
  seedReservation,
  liveReservations,
  createClock,
  makeFlash,
  makeSocket,
  settle,
  runTicks,
  runUntil,
  boot,
};

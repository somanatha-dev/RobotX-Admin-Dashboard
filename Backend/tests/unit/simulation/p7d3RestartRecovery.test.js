"use strict";

/**
 * P7-D3 Step 2 — a simulated robot recovers its charging reservation after a simulator restart.
 *
 * Before (D3-3 of the P7-D3 audit): a restart rebuilt every `VirtualRobot` IDLE with no charging
 * state. The `ChargerReservation` row survived, so the engine kept the robot out of every plan
 * (F18 denies against the live window), but the robot never acted on it: above 10 % it never
 * re-entered charging, so it neither drove to the charger nor charged, and stayed stranded until
 * the window expired (~2.2 h).
 *
 * After: `VirtualRobot.commission()` asks the scheduler, once, for the reservation it may adopt
 * (`devChargingScheduler.reservationForRecovery`, a read that writes nothing), and:
 *   · live, at the declared charger, robot on the charger    → docks and charges (to the target)
 *   · live, at the declared charger, robot away              → drives the campus route, then docks
 *   · live but at or above its target                        → released TARGET_REACHED, no charge
 *   · expired / superseded / foreign / unusable / unreadable → refused: no charge, no movement,
 *     no ownership, and no second reservation
 * The P7-D1 hold survives: a row the server holds PAUSED (or OFFLINE over PAUSED) restarts the
 * robot PAUSED — on the charger the STOP is latched, away from it the robot does not move.
 *
 * MOCKED BOUNDARIES: the database (a small working in-memory store, as in
 * `devChargingScheduler.test.js` — rows are asserted, not calls), the agent's socket and flash, and
 * the wall clock. The SimulationEngine, VirtualRobot, devChargingScheduler, chargerRoute, the
 * campus network and the fixture's real RNSIT declaration, depot row and permission set are real.
 */

const path = require("path");

const constants = require("../../../src/simulation/constants");
const chargerRoute = require("../../../src/simulation/chargerRoute");
const devChargingScheduler = require("../../../src/simulation/devChargingScheduler");
const { haversineMeters } = require("../../../src/utils/distance");
const fixture = require("../../fixtures/phase7/local-2026-10-09.json");

const { RESERVATION_STATE, RELEASE_REASON } = devChargingScheduler;

jest.setTimeout(120_000);

const VR_PATH = path.resolve(__dirname, "../../../src/simulation/VirtualRobot");
const ENGINE_PATH = path.resolve(__dirname, "../../../src/simulation/SimulationEngine");
// Required here, before any `jest.doMock` below: a plain require after one would cache the
// recording VirtualRobot in the main mock registry, and every later isolated boot would reuse it.
const { operatorHoldFrom } = require(ENGINE_PATH);

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

const DEPOT_ROW = Object.freeze({ ...fixture.rows.Charger.find((row) => row.chargerId === "V1DEMO-DEPOT-01") });
const DEV_SIM_ROW = Object.freeze({ ...fixture.rows.Charger.find((row) => row.chargerId === "DEV-SIM-RNSIT-MBA-01") });
const PERMISSION_SET = fixture.rows.MobilityModel[0].permissionSet;
const DECLARATION = fixture.configVersion.payload.deliveryDomain;

const AT_DEPOT = Object.freeze({ lat: DEPOT_ROW.latitude, lon: DEPOT_ROW.longitude });
/** SIM-0A8C's recorded LOCAL position; the campus route from here to the depot is 65.7059 m. */
const AWAY = Object.freeze({ lat: 12.901151, lon: 77.517575 });
const AT_DEV_SIM = Object.freeze({ lat: DEV_SIM_ROW.latitude, lon: DEV_SIM_ROW.longitude });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/* ── A working in-memory store ─────────────────────────────────────────────── */

function matches(row, where) {
  for (const [field, condition] of Object.entries(where || {})) {
    const value = row[field];
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      if (Array.isArray(condition.in) && !condition.in.includes(value)) return false;
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

function createWorld({ chargers = [DEPOT_ROW, DEV_SIM_ROW] } = {}) {
  let sequence = 0;
  const rows = {
    charger: chargers.map((row) => ({ ...row })),
    chargerReservation: [],
    chargerAvailabilityProjection: [],
  };
  const robots = new Map();
  /** Set to make the next reservation read throw (an unreachable database). */
  const faults = { reservationReads: 0 };

  const table = (name) => {
    const list = rows[name];
    const read = () => {
      if (name === "chargerReservation" && faults.reservationReads > 0) {
        faults.reservationReads -= 1;
        throw new Error("connection terminated unexpectedly");
      }
    };
    return {
      async findFirst({ where, orderBy } = {}) { read(); return ordered(list.filter((row) => matches(row, where)), orderBy)[0] || null; },
      async findMany({ where, orderBy, take } = {}) {
        read();
        const found = ordered(list.filter((row) => matches(row, where)), orderBy);
        return take === undefined ? found : found.slice(0, take);
      },
      async count({ where } = {}) { return list.filter((row) => matches(row, where)).length; },
      async findUnique({ where }) {
        const [field, value] = Object.entries(where)[0];
        return list.find((row) => row[field] === value) || null;
      },
      async create({ data }) {
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
  };

  return {
    prisma,
    rows,
    robots,
    faults,
    runSerializable: (client, fn) => fn(client),
    selectForUpdate: async () => null,
  };
}

/** A simulated Robot row with its Agent, in the shape `SimulationEngine.addRobot` selects. */
function addRobotRow(world, { robotId, agentRowId, battery, status = "IDLE", statusBeforeOffline = null, omitStatus = false }) {
  world.robots.set(robotId, {
    battery,
    simulated: true,
    massKg: null,
    ...(omitStatus ? {} : { status, statusBeforeOffline }),
    agent: {
      id: agentRowId,
      batteryState: null,
      agentClass: {
        mobilityModel: { kinematicLimits: null, speedModel: null, permissionSet: PERMISSION_SET },
        energyModel: null,
        containerModel: null,
        energyModelParams: [],
      },
    },
  });
}

/** A reservation as an earlier process left it (`devChargingScheduler.requestPlug`'s shape). */
function seedReservation(world, { agentRowId, charger = DEPOT_ROW, state, fromMs, untilMs, targetSoc = 0.8, ordinal = 0, chargerDbId }) {
  const row = {
    id: `seeded-${agentRowId}-${ordinal}`,
    reservationId: `${charger ? charger.chargerId : "GONE"}:${agentRowId}:${ordinal}`,
    agentId: agentRowId,
    chargerDbId: chargerDbId !== undefined ? chargerDbId : charger ? charger.id : null,
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

const live = (world, agentRowId) =>
  world.rows.chargerReservation.filter(
    (row) => (agentRowId === undefined || row.agentId === agentRowId) && devChargingScheduler.LIVE_STATES.includes(row.state),
  );

/* ── Clock, sockets, flash ──────────────────────────────────────────────────── */

// Reset per test: the simulated ambient (and so the charge rate) is a function of the clock, so a
// clock carried over from earlier tests would make each case depend on the ones before it.
const CLOCK_START = 1_791_700_000_000;
let clock = CLOCK_START;
const realNow = Date.now;
beforeEach(() => { clock = CLOCK_START; Date.now = () => clock; });
afterEach(() => { Date.now = realNow; });

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
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setImmediate(resolve));
  }
};

/** Tick every robot once per step on one clock; `onTick` runs after each step. */
async function runTicks(robots, ticks, onTick) {
  const fleet = Array.isArray(robots) ? robots : [robots];
  for (let i = 0; i < ticks; i += 1) {
    clock += constants.TELEMETRY_INTERVAL_MS;
    for (const robot of fleet) robot._tick();
    // eslint-disable-next-line no-await-in-loop
    await settle();
    if (onTick) onTick(i);
  }
}

/** Tick until `predicate` holds (or `max` ticks), returning how many ticks it took. */
async function runUntil(robots, predicate, max = 600) {
  for (let i = 0; i < max; i += 1) {
    if (predicate()) return i;
    // eslint-disable-next-line no-await-in-loop
    await runTicks(robots, 1);
  }
  return predicate() ? max : -1;
}

/**
 * Boot a simulator process on `world`: the real engine, provisioning (+ its restart
 * reconciliation) unless `provision: false`, then `addRobot` for each robot, exactly as
 * `rehydrateSimulatedRobots` does. Returns the real VirtualRobot instances it built.
 */
async function boot(world, robots, { provision = true } = {}) {
  const instances = [];
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
    logger: silentLogger,
    enabled: true,
    runSerializable: world.runSerializable,
    selectForUpdate: world.selectForUpdate,
    deliveryDomainFor: () => DECLARATION,
  });
  const provisioned = provision ? await simulator.provisionCharging({ nowMs: clock }) : null;
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
  return { simulator, provisioned, verdicts, instances, byId };
}

const distanceTo = (robot, point) => haversineMeters(robot.lat, robot.lon, point.lat, point.lon);

/* ═══════════════════════════════════════════════════════════════════════════
   1. Restart above 10 % with a live reservation, away from the charger
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D3 Step 2 — restart above 10 % with a live reservation, away from the charger", () => {
  test("the robot resumes its approach over the campus route, docks within the radius, and charges on the SAME reservation", async () => {
    const world = createWorld();
    addRobotRow(world, { robotId: "SIM-AWAY", agentRowId: "agent-away", battery: 55 });
    const seeded = seedReservation(world, {
      agentRowId: "agent-away", state: RESERVATION_STATE.ACTIVE, fromMs: clock - 10 * MINUTE, untilMs: clock + HOUR,
    });
    const before = { ...seeded };

    const { byId } = await boot(world, [{ robotId: "SIM-AWAY", at: AWAY }]);
    const robot = byId("SIM-AWAY");

    // Before the fix the robot came up IDLE with no charging phase and stayed there (55 % > 10 %).
    expect(robot.battery).toBe(55);
    expect(robot.getStatus()).toMatchObject({ chargingRecovery: "RESUMING_APPROACH", chargingPhase: "SEEKING", chargingReservationState: "ACTIVE" });
    expect(robot.status).toBe("IDLE");

    let maxBatteryBeforeDock = robot.battery;
    const ticks = await runUntil(robot, () => {
      if (robot.status !== "CHARGING") maxBatteryBeforeDock = Math.max(maxBatteryBeforeDock, robot.battery);
      return robot.status === "CHARGING";
    }, 80);
    expect(ticks).toBeGreaterThan(0);
    expect(maxBatteryBeforeDock).toBe(55); // never rose on the way
    expect(robot.distanceTravelled).toBeGreaterThan(60); // the 65.7 m campus route, not a teleport
    expect(distanceTo(robot, AT_DEPOT)).toBeLessThanOrEqual(chargerRoute.DOCKING_RADIUS_M);

    const docked = robot.battery;
    await runTicks(robot, 20);
    expect(robot.battery).toBeGreaterThan(docked);

    // The same reservation, unchanged in identity, queue key and charger; no second row.
    expect(world.rows.chargerReservation).toHaveLength(1);
    expect(live(world, "agent-away")).toHaveLength(1);
    expect(world.rows.chargerReservation[0]).toMatchObject({
      reservationId: before.reservationId, chargerDbId: DEPOT_ROW.id, state: RESERVATION_STATE.ACTIVE,
    });
    expect(world.rows.chargerReservation[0].reservedFrom.getTime()).toBe(before.reservedFrom.getTime());
  });

  test("a QUEUED reservation is resumed too: the robot drives to the charger and waits there, it does not charge", async () => {
    const world = createWorld();
    for (const n of [1, 2, 3]) {
      addRobotRow(world, { robotId: `SIM-ACT-${n}`, agentRowId: `agent-act-${n}`, battery: 30 });
      seedReservation(world, { agentRowId: `agent-act-${n}`, state: RESERVATION_STATE.ACTIVE, fromMs: clock - 30 * MINUTE + n, untilMs: clock + HOUR });
    }
    addRobotRow(world, { robotId: "SIM-Q", agentRowId: "agent-q", battery: 50 });
    seedReservation(world, { agentRowId: "agent-q", state: RESERVATION_STATE.QUEUED, fromMs: clock - 5 * MINUTE, untilMs: clock + HOUR });

    const { byId } = await boot(world, [{ robotId: "SIM-Q", at: AWAY }]);
    const robot = byId("SIM-Q");
    expect(robot.getStatus()).toMatchObject({ chargingRecovery: "RESUMING_APPROACH", chargingReservationState: "QUEUED" });

    await runUntil(robot, () => robot.status === "CHARGING", 80);
    const waiting = robot.battery;
    await runTicks(robot, 15);
    expect(robot._chargingPhase).toBe("WAITING");
    expect(robot.battery).toBe(waiting); // no plug, no current
    expect(live(world, "agent-q")).toHaveLength(1);
    expect(live(world, "agent-q")[0].state).toBe(RESERVATION_STATE.QUEUED);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. Restart at the charger with a valid reservation
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D3 Step 2 — restart at the charger with a valid reservation", () => {
  test("ACTIVE, below target: the robot charges where it stands — it IS at the charger — and never drives", async () => {
    const world = createWorld();
    addRobotRow(world, { robotId: "SIM-DOCK", agentRowId: "agent-dock", battery: 40 });
    seedReservation(world, { agentRowId: "agent-dock", state: RESERVATION_STATE.ACTIVE, fromMs: clock - 20 * MINUTE, untilMs: clock + HOUR });

    const { byId } = await boot(world, [{ robotId: "SIM-DOCK", at: AT_DEPOT }]);
    const robot = byId("SIM-DOCK");

    expect(robot.getStatus()).toMatchObject({ chargingRecovery: "RESUMED_AT_CHARGER", status: "CHARGING", chargingPhase: "WAITING" });
    const statuses = new Set();
    await runTicks(robot, 20, () => statuses.add(robot.status));
    expect(robot._chargingPhase).toBe("CHARGING");
    expect(robot.battery).toBeGreaterThan(40);
    expect(robot.distanceTravelled).toBe(0);
    expect(statuses.has("RETURNING")).toBe(false);
    expect(distanceTo(robot, AT_DEPOT)).toBe(0);
    expect(world.rows.chargerReservation).toHaveLength(1);
  });

  test("the session charges to the target the reservation recorded, then releases TARGET_REACHED", async () => {
    const world = createWorld();
    addRobotRow(world, { robotId: "SIM-TGT", agentRowId: "agent-tgt", battery: 59.5 });
    seedReservation(world, { agentRowId: "agent-tgt", state: RESERVATION_STATE.ACTIVE, fromMs: clock - 20 * MINUTE, untilMs: clock + HOUR, targetSoc: 0.6 });

    const { byId } = await boot(world, [{ robotId: "SIM-TGT", at: AT_DEPOT }]);
    const robot = byId("SIM-TGT");
    expect(robot._targetSocPercent()).toBeCloseTo(60, 9); // not the 80 % class default

    const ticks = await runUntil(robot, () => robot.status !== "CHARGING", 600);
    expect(ticks).toBeGreaterThan(0);
    expect(robot.status).toBe("IDLE");
    // The session ends AT 60 %, not at 80 %; the same tick then drains one idle tick, as it
    // always has, so the level read afterwards is a hair under 60.
    expect(robot.battery).toBeGreaterThan(59.9);
    expect(robot.battery).toBeLessThan(60.5);
    await settle();
    expect(world.rows.chargerReservation[0]).toMatchObject({ state: RESERVATION_STATE.RELEASED, externalId: RELEASE_REASON.TARGET_REACHED });
  });

  test("already at or above the target: the reservation is released TARGET_REACHED and no charge is drawn", async () => {
    const world = createWorld();
    addRobotRow(world, { robotId: "SIM-FULL", agentRowId: "agent-full", battery: 85 });
    seedReservation(world, { agentRowId: "agent-full", state: RESERVATION_STATE.ACTIVE, fromMs: clock - 20 * MINUTE, untilMs: clock + HOUR, targetSoc: 0.8 });

    const { byId } = await boot(world, [{ robotId: "SIM-FULL", at: AT_DEPOT }]);
    const robot = byId("SIM-FULL");
    await settle();

    expect(robot.getStatus()).toMatchObject({ chargingRecovery: "RELEASED_TARGET_REACHED", status: "IDLE", chargingPhase: null });
    expect(live(world)).toHaveLength(0);
    expect(world.rows.chargerReservation[0].externalId).toBe(RELEASE_REASON.TARGET_REACHED);
    await runTicks(robot, 10);
    expect(robot.battery).toBeLessThanOrEqual(85);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. Restart with an expired reservation
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D3 Step 2 — restart with an expired reservation", () => {
  test("expired before boot: the boot reconciliation releases it STALE_EXPIRED, and the robot adopts nothing", async () => {
    const world = createWorld();
    addRobotRow(world, { robotId: "SIM-EXP", agentRowId: "agent-exp", battery: 55 });
    seedReservation(world, { agentRowId: "agent-exp", state: RESERVATION_STATE.ACTIVE, fromMs: clock - 3 * HOUR, untilMs: clock - MINUTE });

    const { byId, provisioned } = await boot(world, [{ robotId: "SIM-EXP", at: AT_DEPOT }]);
    const robot = byId("SIM-EXP");

    expect(provisioned.expired).toBe(1);
    expect(world.rows.chargerReservation[0]).toMatchObject({ state: RESERVATION_STATE.RELEASED, externalId: RELEASE_REASON.STALE_EXPIRED });
    expect(robot.getStatus()).toMatchObject({ chargingRecovery: "NONE", status: "IDLE", chargingPhase: null });
    await runTicks(robot, 10);
    expect(robot.status).toBe("IDLE");
    expect(robot.battery).toBeLessThan(55); // drains at rest; it does not charge in place
    expect(world.rows.chargerReservation).toHaveLength(1); // nothing new was granted
  });

  test("expired between the boot pass and adoption: refused EXPIRED, untouched by the robot, released by the next pass", async () => {
    const world = createWorld();
    addRobotRow(world, { robotId: "SIM-LATE", agentRowId: "agent-late", battery: 55 });
    const { simulator } = await boot(world, []); // the boot pass ran over an empty table
    seedReservation(world, { agentRowId: "agent-late", state: RESERVATION_STATE.ACTIVE, fromMs: clock - 3 * HOUR, untilMs: clock - 1 });
    expect(simulator).toBeTruthy();

    const { byId } = await boot(world, [{ robotId: "SIM-LATE", at: AT_DEPOT }], { provision: false });
    const robot = byId("SIM-LATE");

    expect(robot._restartRecovery).toMatchObject({ outcome: "REFUSED", refusal: "EXPIRED" });
    expect(robot.status).toBe("IDLE");
    expect(robot._chargingPhase).toBeNull();
    expect(live(world, "agent-late")).toHaveLength(1); // the robot neither adopted nor wrote it

    await devChargingScheduler.reconcile(world, { nowMs: clock });
    expect(world.rows.chargerReservation[0]).toMatchObject({ state: RESERVATION_STATE.RELEASED, externalId: RELEASE_REASON.STALE_EXPIRED });
    await runTicks(robot, 10);
    expect(robot.status).toBe("IDLE");
    expect(world.rows.chargerReservation).toHaveLength(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. Restart with a reservation for the superseded DEV-SIM charger
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D3 Step 2 — restart with a reservation for the superseded DEV-SIM charger", () => {
  test("the boot pass releases it CHARGER_SUPERSEDED; a robot standing at DEV-SIM does not charge there", async () => {
    const world = createWorld();
    addRobotRow(world, { robotId: "SIM-OLD", agentRowId: "agent-old", battery: 40 });
    seedReservation(world, { agentRowId: "agent-old", charger: DEV_SIM_ROW, state: RESERVATION_STATE.ACTIVE, fromMs: clock - 10 * MINUTE, untilMs: clock + HOUR });

    const { byId } = await boot(world, [{ robotId: "SIM-OLD", at: AT_DEV_SIM }]);
    const robot = byId("SIM-OLD");

    expect(world.rows.chargerReservation[0]).toMatchObject({ state: RESERVATION_STATE.RELEASED, externalId: RELEASE_REASON.CHARGER_SUPERSEDED });
    expect(robot.getStatus()).toMatchObject({ chargingRecovery: "NONE", status: "IDLE", chargingPhase: null });
    await runTicks(robot, 10);
    expect(robot.status).not.toBe("CHARGING");
    expect(robot.battery).toBeLessThan(40);
    expect(world.rows.chargerReservation).toHaveLength(1);
  });

  test("not yet reconciled: the recovery read refuses it SUPERSEDED_CHARGER and the robot assumes nothing", async () => {
    const world = createWorld();
    addRobotRow(world, { robotId: "SIM-OLD2", agentRowId: "agent-old2", battery: 40 });
    await boot(world, []);
    seedReservation(world, { agentRowId: "agent-old2", charger: DEV_SIM_ROW, state: RESERVATION_STATE.ACTIVE, fromMs: clock - 10 * MINUTE, untilMs: clock + HOUR });

    const { byId } = await boot(world, [{ robotId: "SIM-OLD2", at: AT_DEV_SIM }], { provision: false });
    const robot = byId("SIM-OLD2");
    expect(robot._restartRecovery).toMatchObject({ outcome: "REFUSED", refusal: "SUPERSEDED_CHARGER" });
    await runTicks(robot, 10);
    expect(robot.status).not.toBe("CHARGING");
    expect(robot.battery).toBeLessThan(40);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. Missing, foreign or unreadable reservation state
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D3 Step 2 — missing, foreign or unreadable reservation state fails closed", () => {
  test("no reservation: NONE, and a robot above 10 % stays IDLE (the unchanged non-charging path)", async () => {
    const world = createWorld();
    addRobotRow(world, { robotId: "SIM-NONE", agentRowId: "agent-none", battery: 55 });
    const { byId } = await boot(world, [{ robotId: "SIM-NONE", at: AWAY }]);
    expect(byId("SIM-NONE").getStatus()).toMatchObject({ chargingRecovery: "NONE", status: "IDLE", chargingPhase: null });
    expect(world.rows.chargerReservation).toHaveLength(0);
  });

  test("unreadable: the read throws → refused UNREADABLE; the robot adopts nothing and the row is untouched", async () => {
    const world = createWorld();
    addRobotRow(world, { robotId: "SIM-ERR", agentRowId: "agent-err", battery: 40 });
    await boot(world, []);
    const seeded = seedReservation(world, { agentRowId: "agent-err", state: RESERVATION_STATE.ACTIVE, fromMs: clock - 10 * MINUTE, untilMs: clock + HOUR });
    const snapshot = JSON.stringify(seeded);

    world.faults.reservationReads = 1;
    const { byId, verdicts } = await boot(world, [{ robotId: "SIM-ERR", at: AT_DEPOT }], { provision: false });
    const robot = byId("SIM-ERR");

    expect(verdicts[0]).toMatchObject({ started: false, reason: "ENGINE_NOT_STARTED" }); // still added
    expect(robot._restartRecovery).toMatchObject({ outcome: "REFUSED", refusal: "UNREADABLE" });
    expect(robot.status).toBe("IDLE");
    expect(robot._chargingPhase).toBeNull();
    expect(JSON.stringify(world.rows.chargerReservation[0])).toBe(snapshot);
  });

  test("a reservation at a charger this scheduler does not declare (row deleted, chargerDbId null): refused FOREIGN_CHARGER, no charge, no duplicate", async () => {
    const world = createWorld();
    addRobotRow(world, { robotId: "SIM-FOR", agentRowId: "agent-for", battery: 40 });
    seedReservation(world, { agentRowId: "agent-for", charger: null, chargerDbId: null, state: RESERVATION_STATE.ACTIVE, fromMs: clock - 10 * MINUTE, untilMs: clock + HOUR });

    const { byId } = await boot(world, [{ robotId: "SIM-FOR", at: AT_DEPOT }]);
    const robot = byId("SIM-FOR");
    expect(robot._restartRecovery).toMatchObject({ outcome: "REFUSED", refusal: "FOREIGN_CHARGER" });
    await runTicks(robot, 10);
    expect(robot.status).not.toBe("CHARGING");
    expect(robot.battery).toBeLessThan(40);

    // And the plug request path does not adopt it either, nor grant a second one beside it.
    const verdict = await devChargingScheduler.requestPlug(world, { agentRowId: "agent-for", targetSoc: 0.8, nowMs: clock });
    expect(verdict).toMatchObject({ ok: false, created: false, reservation: null });
    expect(verdict.problems.join(" ")).toMatch(/does not declare/);
    expect(world.rows.chargerReservation).toHaveLength(1);
  });

  test("a robot at 10 % holding a foreign reservation never charges on it (it used to be handed back as 'held')", async () => {
    const world = createWorld();
    addRobotRow(world, { robotId: "SIM-FOR-LOW", agentRowId: "agent-for-low", battery: constants.BATTERY_CRITICAL_THRESHOLD });
    seedReservation(world, { agentRowId: "agent-for-low", charger: null, chargerDbId: "charger-that-was-deleted", state: RESERVATION_STATE.ACTIVE, fromMs: clock - 10 * MINUTE, untilMs: clock + HOUR });

    const { byId } = await boot(world, [{ robotId: "SIM-FOR-LOW", at: AT_DEPOT }]);
    const robot = byId("SIM-FOR-LOW");
    const statuses = new Set();
    await runTicks(robot, 30, () => statuses.add(robot.status));
    expect(statuses.has("CHARGING")).toBe(false);
    expect(robot.battery).toBeLessThanOrEqual(constants.BATTERY_CRITICAL_THRESHOLD);
    expect(world.rows.chargerReservation).toHaveLength(1); // no depot reservation granted beside it
  });

  test("the depot row is gone: refused CHARGER_UNUSABLE and nothing charges", async () => {
    const world = createWorld({ chargers: [DEV_SIM_ROW] });
    addRobotRow(world, { robotId: "SIM-NODEPOT", agentRowId: "agent-nodepot", battery: 40 });
    seedReservation(world, { agentRowId: "agent-nodepot", state: RESERVATION_STATE.ACTIVE, fromMs: clock - 10 * MINUTE, untilMs: clock + HOUR });

    const { byId, provisioned } = await boot(world, [{ robotId: "SIM-NODEPOT", at: AT_DEPOT }]);
    expect(provisioned.ok).toBe(false);
    const robot = byId("SIM-NODEPOT");
    expect(robot._restartRecovery).toMatchObject({ outcome: "REFUSED", refusal: "CHARGER_UNUSABLE" });
    await runTicks(robot, 10);
    expect(robot.status).not.toBe("CHARGING");
  });

  test("the hold cannot be established (no status on the row): adoption is refused HOLD_UNKNOWN — nothing moves", async () => {
    const world = createWorld();
    addRobotRow(world, { robotId: "SIM-NOSTAT", agentRowId: "agent-nostat", battery: 55, omitStatus: true });
    seedReservation(world, { agentRowId: "agent-nostat", state: RESERVATION_STATE.ACTIVE, fromMs: clock - 10 * MINUTE, untilMs: clock + HOUR });

    const { byId } = await boot(world, [{ robotId: "SIM-NOSTAT", at: AWAY }]);
    const robot = byId("SIM-NOSTAT");
    expect(robot._restartRecovery).toMatchObject({ outcome: "REFUSED", refusal: "HOLD_UNKNOWN" });
    await runTicks(robot, 10);
    expect(robot.distanceTravelled).toBe(0);
    expect(robot.status).toBe("IDLE");
  });

  test("the scheduler's recovery read refuses two live rows rather than choosing one", async () => {
    const world = createWorld();
    seedReservation(world, { agentRowId: "agent-two", state: RESERVATION_STATE.ACTIVE, fromMs: clock - 10 * MINUTE, untilMs: clock + HOUR, ordinal: 0 });
    seedReservation(world, { agentRowId: "agent-two", state: RESERVATION_STATE.QUEUED, fromMs: clock - 5 * MINUTE, untilMs: clock + HOUR, ordinal: 1 });
    const verdict = await devChargingScheduler.reservationForRecovery(world, { agentRowId: "agent-two", nowMs: clock });
    expect(verdict).toMatchObject({ verdict: "REFUSED", refusal: "MULTIPLE_LIVE" });
  });

  test("a malformed target SoC is refused rather than charged towards", async () => {
    const world = createWorld();
    seedReservation(world, { agentRowId: "agent-bad", state: RESERVATION_STATE.ACTIVE, fromMs: clock - 10 * MINUTE, untilMs: clock + HOUR, targetSoc: 80 });
    const verdict = await devChargingScheduler.reservationForRecovery(world, { agentRowId: "agent-bad", nowMs: clock });
    expect(verdict).toMatchObject({ verdict: "REFUSED", refusal: "MALFORMED" });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. Repeated reconciliation is idempotent; no duplicate reservation
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D3 Step 2 — repeated reconciliation is idempotent", () => {
  test("the recovery read writes nothing, and answers the same twice", async () => {
    const world = createWorld();
    seedReservation(world, { agentRowId: "agent-r", state: RESERVATION_STATE.ACTIVE, fromMs: clock - 10 * MINUTE, untilMs: clock + HOUR });
    const before = JSON.stringify(world.rows);
    const first = await devChargingScheduler.reservationForRecovery(world, { agentRowId: "agent-r", nowMs: clock });
    const second = await devChargingScheduler.reservationForRecovery(world, { agentRowId: "agent-r", nowMs: clock });
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      verdict: "ADOPTABLE",
      reservation: { state: RESERVATION_STATE.ACTIVE, targetSoc: 0.8 },
      charger: { chargerId: DEPOT_ROW.chargerId, lat: DEPOT_ROW.latitude, lon: DEPOT_ROW.longitude },
    });
    expect(JSON.stringify(world.rows)).toBe(before);
  });

  test("recovering an instance again changes nothing; the outcome is decided once", async () => {
    const world = createWorld();
    addRobotRow(world, { robotId: "SIM-TWICE", agentRowId: "agent-twice", battery: 40 });
    seedReservation(world, { agentRowId: "agent-twice", state: RESERVATION_STATE.ACTIVE, fromMs: clock - 10 * MINUTE, untilMs: clock + HOUR });
    const { byId } = await boot(world, [{ robotId: "SIM-TWICE", at: AT_DEPOT }]);
    const robot = byId("SIM-TWICE");
    const outcome = robot._restartRecovery;
    await runTicks(robot, 3);
    const phase = robot._chargingPhase;

    const again = await robot._recoverChargingAtRestart();
    expect(again).toBe(outcome);
    expect(robot._chargingPhase).toBe(phase);
    expect(robot.status).toBe("CHARGING");
    expect(world.rows.chargerReservation).toHaveLength(1);
  });

  test("two restarts in a row resume the same reservation: one live row, same id, same queue key", async () => {
    const world = createWorld();
    addRobotRow(world, { robotId: "SIM-RB", agentRowId: "agent-rb", battery: 45 });
    const seeded = seedReservation(world, { agentRowId: "agent-rb", state: RESERVATION_STATE.QUEUED, fromMs: clock - 10 * MINUTE, untilMs: clock + HOUR });
    for (const n of [1, 2, 3]) {
      seedReservation(world, { agentRowId: `agent-hold-${n}`, state: RESERVATION_STATE.ACTIVE, fromMs: clock - 20 * MINUTE + n, untilMs: clock + HOUR });
    }

    const first = await boot(world, [{ robotId: "SIM-RB", at: AWAY }]);
    await runTicks(first.byId("SIM-RB"), 5);
    first.byId("SIM-RB").stop(); // the process dies mid-approach

    const second = await boot(world, [{ robotId: "SIM-RB", at: AWAY }]);
    expect(second.byId("SIM-RB").getStatus()).toMatchObject({ chargingRecovery: "RESUMING_APPROACH", chargingReservationState: "QUEUED" });
    await runTicks(second.byId("SIM-RB"), 30);

    expect(live(world, "agent-rb")).toHaveLength(1);
    expect(live(world, "agent-rb")[0].reservationId).toBe(seeded.reservationId);
    expect(live(world, "agent-rb")[0].reservedFrom.getTime()).toBe(seeded.reservedFrom.getTime());
    expect(world.rows.chargerReservation.filter((row) => row.agentId === "agent-rb")).toHaveLength(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   7. The P7-D1 STOP/PAUSE hold survives the restart
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D3 Step 2 — the P7-D1 STOP/PAUSE hold survives a restart", () => {
  test("held (PAUSED) on the charger: the session continues with the STOP latched, executes no task, and ends PAUSED", async () => {
    const world = createWorld();
    addRobotRow(world, { robotId: "SIM-HELD", agentRowId: "agent-held", battery: 59.5, status: "PAUSED" });
    seedReservation(world, { agentRowId: "agent-held", state: RESERVATION_STATE.ACTIVE, fromMs: clock - 10 * MINUTE, untilMs: clock + HOUR, targetSoc: 0.6 });

    const { byId } = await boot(world, [{ robotId: "SIM-HELD", at: AT_DEPOT }]);
    const robot = byId("SIM-HELD");
    expect(robot.getStatus()).toMatchObject({ chargingRecovery: "RESUMED_AT_CHARGER", status: "CHARGING" });
    expect(robot._stopLatched).toBe(true);

    await runTicks(robot, 2);
    robot._onTaskAssign({
      taskId: "TSK-HELD",
      pathToPickup: [AT_DEPOT, AWAY],
      pathToDrop: [AWAY, AT_DEPOT],
    });
    expect(robot.task).toBeNull();

    await runUntil(robot, () => robot.status !== "CHARGING", 600);
    expect(robot.status).toBe("PAUSED");
    expect(robot.task).toBeNull();
  });

  test("held while OFFLINE (statusBeforeOffline PAUSED), away from the charger: the reservation is RELEASED, not adopted (D-4); the robot stays put", async () => {
    // Owner decision 2026-10-12 (charging audit D-4): a robot that is not docked does not keep a
    // reservation while it cannot move. This used to resume the approach and hold the plug, still,
    // for the whole window.
    const world = createWorld();
    addRobotRow(world, { robotId: "SIM-HOLD-AWAY", agentRowId: "agent-hold-away", battery: 55, status: "OFFLINE", statusBeforeOffline: "PAUSED" });
    seedReservation(world, { agentRowId: "agent-hold-away", state: RESERVATION_STATE.ACTIVE, fromMs: clock - 10 * MINUTE, untilMs: clock + HOUR });

    const { byId } = await boot(world, [{ robotId: "SIM-HOLD-AWAY", at: AWAY }]);
    const robot = byId("SIM-HOLD-AWAY");
    expect(robot.getStatus()).toMatchObject({ chargingRecovery: "RELEASED_HELD_AWAY", status: "PAUSED" });

    await runTicks(robot, 15);
    expect(robot._chargingPhase).toBeNull();
    expect(robot.status).toBe("PAUSED");
    expect(robot.distanceTravelled).toBe(0);
    expect(live(world, "agent-hold-away")).toHaveLength(0);
    const frames = robot.socket.emitted.filter((entry) => entry.event === "TELEMETRY");
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((entry) => entry.payload.status === "PAUSED")).toBe(true);

    // 55 % is above the charge trigger: after a RESUME the robot is simply IDLE.
    robot._applyResume();
    await runTicks(robot, 10);
    expect(robot.status).toBe("IDLE");
    expect(robot._chargingPhase).toBeNull();
  });

  test("held with no reservation: the robot restarts PAUSED and stays PAUSED; an unheld one restarts IDLE", async () => {
    const world = createWorld();
    addRobotRow(world, { robotId: "SIM-H", agentRowId: "agent-h", battery: 55, status: "PAUSED" });
    addRobotRow(world, { robotId: "SIM-U", agentRowId: "agent-u", battery: 55, status: "IDLE" });
    const { byId } = await boot(world, [{ robotId: "SIM-H", at: AWAY }, { robotId: "SIM-U", at: AWAY }]);

    await runTicks([byId("SIM-H"), byId("SIM-U")], 10);
    expect(byId("SIM-H").status).toBe("PAUSED");
    expect(byId("SIM-U").status).toBe("IDLE");
  });

  test("operatorHoldFrom reads the server's hold from the row, and says 'unknown' rather than guess", () => {
    expect(operatorHoldFrom({ status: "PAUSED" })).toBe(true);
    expect(operatorHoldFrom({ status: "OFFLINE", statusBeforeOffline: "PAUSED" })).toBe(true);
    expect(operatorHoldFrom({ status: "OFFLINE", statusBeforeOffline: null })).toBe(false);
    expect(operatorHoldFrom({ status: "OFFLINE", statusBeforeOffline: "IDLE" })).toBe(false);
    for (const status of ["IDLE", "ACTIVE", "ISSUES", "ERROR"]) expect(operatorHoldFrom({ status })).toBe(false);
    expect(operatorHoldFrom({})).toBeNull();
    expect(operatorHoldFrom({ status: "SOMETHING_NEW" })).toBeNull();
    expect(operatorHoldFrom({ status: "OFFLINE", statusBeforeOffline: "SOMETHING_NEW" })).toBeNull();
    expect(operatorHoldFrom(null)).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   8. Queue capacity and fairness survive the restart
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D3 Step 2 — plug capacity and FIFO order survive a fleet restart", () => {
  test("three ACTIVE + two QUEUED restart: never more than three charging, and the plug goes to the longest waiter", async () => {
    const world = createWorld();
    const fleet = [
      { robotId: "SIM-A", agentRowId: "agent-a", battery: 79.8, state: RESERVATION_STATE.ACTIVE, fromMs: clock - 40 * MINUTE, at: AT_DEPOT },
      { robotId: "SIM-B", agentRowId: "agent-b", battery: 30, state: RESERVATION_STATE.ACTIVE, fromMs: clock - 39 * MINUTE, at: AT_DEPOT },
      { robotId: "SIM-C", agentRowId: "agent-c", battery: 30, state: RESERVATION_STATE.ACTIVE, fromMs: clock - 38 * MINUTE, at: AWAY },
      // D has waited longer than E; E is already on the charger, D is not.
      { robotId: "SIM-D", agentRowId: "agent-d", battery: 40, state: RESERVATION_STATE.QUEUED, fromMs: clock - 20 * MINUTE, at: AWAY },
      { robotId: "SIM-E", agentRowId: "agent-e", battery: 40, state: RESERVATION_STATE.QUEUED, fromMs: clock - 10 * MINUTE, at: AT_DEPOT },
    ];
    for (const entry of fleet) {
      addRobotRow(world, { robotId: entry.robotId, agentRowId: entry.agentRowId, battery: entry.battery });
      seedReservation(world, { agentRowId: entry.agentRowId, state: entry.state, fromMs: entry.fromMs, untilMs: clock + 2 * HOUR });
    }
    const keys = Object.fromEntries(world.rows.chargerReservation.map((row) => [row.agentId, row.reservedFrom.getTime()]));

    const { instances, byId } = await boot(world, fleet);
    expect(world.rows.chargerReservation).toHaveLength(5); // nothing new at restart

    let maxActiveRows = 0;
    let maxDrawing = 0;
    const promotedOrder = [];
    const check = () => {
      const active = world.rows.chargerReservation.filter((row) => row.state === RESERVATION_STATE.ACTIVE);
      maxActiveRows = Math.max(maxActiveRows, active.length);
      maxDrawing = Math.max(maxDrawing, instances.filter((vr) => vr.status === "CHARGING" && vr._chargingPhase === "CHARGING").length);
      for (const row of active) if (!promotedOrder.includes(row.agentId) && ["agent-d", "agent-e"].includes(row.agentId)) promotedOrder.push(row.agentId);
    };
    await runTicks(instances, 200, check);

    expect(maxActiveRows).toBeLessThanOrEqual(devChargingScheduler.DEVELOPMENT_CHARGER.plugCount);
    expect(maxDrawing).toBeLessThanOrEqual(devChargingScheduler.DEVELOPMENT_CHARGER.plugCount);
    // A finished first, freeing one plug: it went to D (enqueued earlier), not E (already docked).
    expect(world.rows.chargerReservation.find((row) => row.agentId === "agent-a")).toMatchObject({
      state: RESERVATION_STATE.RELEASED, externalId: RELEASE_REASON.TARGET_REACHED,
    });
    expect(promotedOrder[0]).toBe("agent-d");
    expect(byId("SIM-E")._chargingPhase).toBe("WAITING");
    expect(world.rows.chargerReservation.find((row) => row.agentId === "agent-e").state).toBe(RESERVATION_STATE.QUEUED);
    // No queue key was rewritten and no robot holds two rows.
    for (const row of world.rows.chargerReservation) expect(row.reservedFrom.getTime()).toBe(keys[row.agentId]);
    for (const entry of fleet) expect(world.rows.chargerReservation.filter((row) => row.agentId === entry.agentRowId)).toHaveLength(1);
  });
});

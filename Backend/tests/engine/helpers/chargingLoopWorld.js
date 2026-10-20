"use strict";

/**
 * Charging-to-reassignment loop — ONE persistent in-memory world in which the real assignment
 * engine and the real simulated charging lifecycle act on the same rows, so a second round
 * decides on exactly what the first round, the robot and the charger left behind.
 *
 * ── What is real ────────────────────────────────────────────────────────────
 *   · the decision path `phase7World.decide` runs (the published LOCAL configuration, the V1
 *     composition, `indexMaintainer.sweepAgents` with `chargingStatus.service`, the solve path,
 *     `round.plan`), and here ALSO the §10.3.2 commit, applied to the store;
 *   · the outbox worker as `leaderWorkers.COMPOSERS.outbox` composes it, delivering through
 *     `commandDispatcher.outboxDeliveryArm` — the OFFER a robot receives is the Outbox row the
 *     commit wrote, routed, enveloped and emitted by production code;
 *   · the server's socket handlers, registered as `socket.server.js` registers them: robot,
 *     telemetry, command, dtaro (TASK_COMPLETE), offer (OFFER_ACCEPT);
 *   · `SimulationEngine` / `VirtualRobot` / `devChargingScheduler` / `chargerRoute` (booted by
 *     `chargingWorld.boot`), on the same store.
 *
 * ── What is doubled (MOCKED BOUNDARIES) ─────────────────────────────────────
 *   · the STORE: `phase7World.createStore`, persistent across rounds; writes are applied in place.
 *     A "transaction" is the store itself: there is no rollback and no concurrency, so this world
 *     says nothing about serialisation failures (those have their own suites);
 *   · raw SQL: `SELECT NOW()` answers the pinned clock; the leadership row answers this shard
 *     held by this harness; `FOR UPDATE` row locks return the row;
 *   · the WALL CLOCK: `Date.now` is pinned (`chargingWorld.createClock`) and advanced one
 *     telemetry interval per tick; rounds use the clock's instant as their decision time;
 *   · the store's DEFAULTS: `@default(now())` / `@updatedAt` are stamped from the pinned clock,
 *     and every row is returned with Dates of this realm, as a Prisma row carries them;
 *   · SOCKETS: an in-process pair — what the robot emits is triggered on the server socket, and
 *     what the server emits to the robot's room is handed to the robot's listeners;
 *   · the outbox worker's INTERVAL LOOP: its deps and config are captured and drained on demand;
 *   · AUTH: the robot socket is marked authenticated, and its shard identity bound, with the
 *     fields and the `agentGate.resolveIdentity`/`bind` calls `robot.handler`'s AUTH path uses.
 *     The pairing/session handshake itself is not exercised here;
 *   · Task INTAKE: a Leg/Mission/Task/Stops is built as `phase7World.legRows` builds it (the
 *     TSK-816 rows with new stops), not through `POST /api/tasks/assign`.
 */

const path = require("path");

const w = require("./phase7World");
const cw = require("../../helpers/chargingWorld");
const { createFakeSocket } = require("../../helpers/fakeSocket");
const { createTestKv } = require("../../helpers/testKv");

const SRC = path.resolve(__dirname, "../../../src");
const service = require(`${SRC}/engine/config/service`);
const composition = require(`${SRC}/services/v1DemonstrationComposition`);
const chargingStatus = require(`${SRC}/services/chargingStatus.service`);
const indexMaintainer = require(`${SRC}/workers/indexMaintainer.worker`);
const coordinatorSolvePath = require(`${SRC}/workers/coordinatorSolvePath`);
const roundModel = require(`${SRC}/engine/solve/round`);
const budgetModel = require(`${SRC}/engine/solve/budgets`);
const feasibility = require(`${SRC}/engine/feasibility/evaluate`);
const outboxWorker = require(`${SRC}/workers/outbox.worker`);
const leaderWorkers = require(`${SRC}/workers/leaderWorkers`);
const commandDispatcher = require(`${SRC}/services/commandDispatcher.service`);
const agentGate = require(`${SRC}/engine/cutover/agentGate`);
const simulatedAgentState = require(`${SRC}/simulation/simulatedAgentState`);

const SHARD_ID = w.SHARD_ID;
const SIGNING_KEY = "charging-loop-test-only-signing-key-32b";
const FIXTURE_ROWS = w.FIXTURE.rows;

/** The store as a Prisma client: tables the fixture lacks are created on first use. */
function clientOf(store, clock) {
  const own = {
    $queryRawUnsafe: async (sql, ...params) => {
      if (/SELECT NOW\(\)/i.test(sql)) return [{ now: new Date(clock.now) }];
      if (/FROM "ShardLeadership"/.test(sql)) {
        return [{ shardId: SHARD_ID, leadershipFence: 1n, holder: "charging-loop", leaseExpiry: new Date(clock.now + 3_600_000) }];
      }
      // A single-row lock read: SELECT "a", "b" FROM "Table" WHERE "key" = $1 FOR SHARE|UPDATE.
      // The store has no concurrency, so the lock is the row itself.
      const lock = /^\s*SELECT\s+(.+?)\s+FROM\s+"(\w+)"\s+WHERE\s+"(\w+)"\s*=\s*\$1\s+FOR\s+(SHARE|UPDATE)\s*$/is.exec(sql);
      if (lock) {
        const model = lock[2].charAt(0).toLowerCase() + lock[2].slice(1);
        const row = store.rowsOf(model).find((entry) => entry[lock[3]] === params[0]);
        if (!row) return [];
        const columns = lock[1].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
        return [Object.fromEntries(columns.map((c) => [c, row[c]]))];
      }
      throw new Error(`chargingLoopWorld: unexpected SQL ${sql}`);
    },
    $executeRawUnsafe: async (sql) => {
      throw new Error(`chargingLoopWorld: unexpected SQL write ${sql}`);
    },
  };
  // `@default(now())` and `@updatedAt`, as the database applies them: from the store's clock.
  const withTimes = (data, creating) => {
    if (!data || typeof data !== "object" || Array.isArray(data)) return data;
    const now = new Date(clock.now);
    return { ...(creating ? { createdAt: now } : {}), updatedAt: now, ...data };
  };
  const stamped = (op, args) => {
    if (!args) return args;
    if (op === "create") return { ...args, data: withTimes(args.data, true) };
    if (op === "createMany") return { ...args, data: (Array.isArray(args.data) ? args.data : [args.data]).map((d) => withTimes(d, true)) };
    if (op === "upsert") return { ...args, create: withTimes(args.create, true), update: withTimes(args.update, false) };
    if (op === "update" || op === "updateMany") return { ...args, data: withTimes(args.data, false) };
    return args;
  };
  // Every row comes back with Dates of the engine's realm, as a Prisma row carries them: the
  // store copies with `structuredClone`, whose Dates fail `instanceof Date` here (see
  // `phase7World.sameRealm`). The decision-only scenarios keep the store's own behaviour.
  const delegates = new Map();
  const realmSafe = (model) => {
    if (!delegates.has(model)) {
      const raw = store.delegateFor(model);
      const wrapped = {};
      for (const [op, fn] of Object.entries(raw)) wrapped[op] = async (args) => w.sameRealm(await fn(stamped(op, args)));
      delegates.set(model, wrapped);
    }
    return delegates.get(model);
  };
  const view = (base) =>
    new Proxy(base, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop !== "string" || prop === "then" || prop.startsWith("$") || prop.startsWith("_")) return undefined;
        return realmSafe(prop);
      },
    });
  // The transaction client has no `$transaction`, as on a Prisma interactive-transaction client
  // (`outbox.isTransactionClient` tells the two apart).
  const tx = view({ ...own });
  const client = view({ ...own, $transaction: async (fn) => (typeof fn === "function" ? fn(tx) : Promise.all(fn)) });
  return { client, tx };
}

/**
 * Build the world: the fixture's estate, one simulated robot cloned from SIM-0A8C043FFE67's real
 * rows, its class carrying the coefficients today's commissioning writes, and no other unit.
 *
 * @param {object} input
 * @param {object} input.clock `chargingWorld.createClock()`, installed
 * @param {string} input.robotId
 * @param {{lat:number, lon:number}} input.at
 * @param {number} input.socFraction
 */
async function createLoopWorld({ clock, robotId, at, socFraction }) {
  const store = w.createStore(FIXTURE_ROWS);
  const { client: prisma, tx } = clientOf(store, clock);
  const { kv, close } = await createTestKv();

  const versionRow = {
    version: w.FIXTURE.configVersion.version,
    publishedAt: new Date(w.FIXTURE.configVersion.publishedAt),
    payload: w.FIXTURE.configVersion.payload,
    signature: "fixture",
  };
  const snapshot = await service.loadPinnedSnapshot({ prisma: { configVersion: { findUnique: async () => versionRow } }, version: 1 });

  // The fleet is this one robot. Its rows are SIM-0A8C's (class, pack 500 Wh, reserve 15 %),
  // exactly as `phase7World.robotRows` clones them; only its position and charge are stated.
  store.tables.set("agent", []);
  store.tables.set("robot", []);
  const rows = w.robotRows({ robotId, cloneOf: "SIM-0A8C043FFE67", at, socFraction }, clock.now);
  store.rowsOf("agent").push(rows.agent);
  store.rowsOf("robot").push(rows.robot);
  store.rowsOf("batteryState").push(rows.battery);
  if (rows.observation) store.rowsOf("observation").push(rows.observation);
  // The class's energy row as commissioning writes it today (`simulatedEnergyCoefficients`, the
  // 9.5 W / 30 W power policy) — the row F34 prices with AND the row the simulator drains by.
  const coefficients = simulatedAgentState.simulatedEnergyCoefficients(500);
  for (const params of store.rowsOf("energyModelParams").filter((row) => row.agentClassId === rows.agent.agentClassId)) {
    Object.assign(params, coefficients);
  }
  // The fixture's other Legs are not this world's work.
  for (const table of ["leg", "mission", "task", "stop", "missionToTask"]) store.tables.set(table, []);

  return {
    store,
    prisma,
    tx,
    kv,
    close,
    snapshot,
    robotId,
    agentRowId: rows.agentRowId,
    robotDbId: rows.robot.id,
    clock,
    rounds: [],
  };
}

/** Add a delivery Leg (intake's row shape, `phase7World.legRows`), QUEUED now. */
function addLeg(world, { legKey, pickup, drop }) {
  const built = w.legRows({ legKey, pickup, drop, queueAgeMs: 1000 }, world.clock.now, world.snapshot);
  world.store.rowsOf("leg").push(built.leg);
  world.store.rowsOf("mission").push(built.mission);
  world.store.rowsOf("task").push(built.task);
  for (const stop of built.stops) world.store.rowsOf("stop").push(stop);
  world.store.rowsOf("missionToTask").push(built.link);
  return built;
}

/**
 * One real round for one Leg, at the clock's instant: index sweep → composition → solve path →
 * `round.plan` → §10.3.2 commit, applied. The same steps `phase7World.decide` takes, on the
 * persistent store, with the commit included.
 */
async function runRound(world, { legRowId, inScope }) {
  const { store, prisma, kv, snapshot, clock } = world;
  const decisionTimeMs = clock.now;
  const agentRowIds = store.rowsOf("agent").map((row) => row.id);
  const simulated = new Set(store.rowsOf("robot").filter((row) => row.simulated === true).map((row) => row.robotId));

  const indexErrors = [];
  const sweep = await indexMaintainer.sweepAgents(
    {
      prisma,
      kv,
      snapshot,
      now: () => decisionTimeMs,
      chargingStatusFor: chargingStatus.createChargingStatusReader({
        prisma,
        inScope: inScope || ((subject) => simulated.has(subject.agentId)),
      }),
      onError: (error, agentId) => indexErrors.push({ agentId, message: error && error.message }),
    },
    agentRowIds,
  );
  const indexed = store.rowsOf("agentCellPosition").map((row) => ({
    agentId: (store.rowsOf("agent").find((a) => a.id === row.agentId) || {}).agentId,
    availabilityClass: row.availabilityClass,
    cellId: row.cellId,
  }));

  const seams = composition.createV1DemonstrationComposition({ prisma, kv, snapshot: () => snapshot, env: w.ENV });
  const records = [];
  const assembly = coordinatorSolvePath.create({
    ...seams,
    prisma,
    kv,
    snapshot: () => snapshot,
    values: () => snapshot.values,
    shardId: SHARD_ID,
    regionId: FIXTURE_ROWS.Shard[0].regionId,
    instanceId: "charging-loop",
    signingKey: SIGNING_KEY,
    runSerializable: async (_client, fn) => fn(world.tx),
    selectForUpdate: async (_tx, tableName, _column, value) => {
      const model = tableName.charAt(0).toLowerCase() + tableName.slice(1);
      const row = store.rowsOf(model).find((entry) => entry.id === value);
      return row ? w.sameRealm(structuredClone(row)) : null;
    },
    record: (event, detail) => records.push({ event, detail }),
  });
  if (!assembly.ok) throw new Error(`coordinatorSolvePath.create refused: ${assembly.blockedBy}`);

  // Observation only: the gate's own verdicts, returned unchanged.
  const gateCalls = [];
  const originalGate = feasibility.gate;
  const gateSpy = jest.spyOn(feasibility, "gate").mockImplementation(function observed(candidate, context, options) {
    const result = originalGate.call(this, candidate, context, options);
    gateCalls.push({ agentId: context && context.agentSnapshot ? context.agentSnapshot.agentId : null, result });
    return result;
  });

  const roundId = `${SHARD_ID}:${decisionTimeMs}`;
  const values = snapshot.values;
  const finite = (name) => {
    const v = values.get(name);
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  const config = {
    maxEvaluatedPerLeg: finite("candidate.max_evaluated"),
    maxColumnsPerRound: finite("plan.max_columns_per_round"),
    branchNodeBudget: finite("solve.branch_node_budget"),
    timeBudgetMs: assembly.context.expansionWallClockBudgetMs,
  };
  let planned;
  try {
    assembly.deps.planState.beginRound(roundId);
    await assembly.deps.prepareRound({ shardId: SHARD_ID, roundId, decisionTimeMs, legIds: [legRowId] });
    const queueRow = { legId: legRowId, slaClass: null, purpose: "PRIMARY", shardId: SHARD_ID, enqueuedAt: new Date(decisionTimeMs - 1000), priority: 0 };
    planned = await roundModel.plan(
      {
        expandCandidates: assembly.deps.expandCandidates,
        pricedCandidateFor: assembly.deps.pricedCandidateFor,
        planState: assembly.deps.planState,
        budgets: budgetModel.create({ config: { ...config, maxLegsPerRound: 1 }, elapsedMs: () => 0 }),
      },
      {
        roundId,
        shardId: SHARD_ID,
        decisionTimeMs,
        legs: [{ legId: legRowId, priority: 0, purpose: "PRIMARY", slaClass: null, expansionInput: assembly.deps.expansionInputFor(queueRow) }],
        config,
        killSwitches: {},
      },
    );
  } finally {
    gateSpy.mockRestore();
  }

  const businessIdOf = (id) => {
    const agent = store.rowsOf("agent").find((row) => row.id === id || row.agentId === id);
    return agent ? agent.agentId : id;
  };
  const perLeg = assembly.deps.perLegFor()[legRowId] || { candidates: [], rejectionSummary: [] };
  const decision = planned.decisions.find((row) => row.legId === legRowId) || null;
  const assignment = planned.assignments.find((row) => row.legId === legRowId) || null;

  let committed = null;
  if (assignment) {
    const outcome = await assembly.deps.commit(assignment, { roundId, leadershipFence: 1n });
    committed = {
      outcome: outcome ? outcome.outcome ?? null : null,
      committed: outcome ? outcome.committed === true : false,
      reason: outcome ? outcome.reason ?? null : null,
      detail: outcome ? outcome.detail ?? null : null,
    };
  }

  const denials = {};
  const gated = new Set();
  for (const call of gateCalls) {
    gated.add(call.agentId);
    const outcome = call.result && call.result.outcome;
    if (!outcome || outcome.feasible) continue;
    denials[call.agentId] = outcome.denials.map((row) => ({ predicateId: row.predicateId, reason: row.result && row.result.reason }));
  }
  const evaluatedPredicates = {};
  for (const call of gateCalls) {
    const evaluated = call.result && call.result.outcome && call.result.outcome.evaluated;
    if (Array.isArray(evaluated)) evaluatedPredicates[call.agentId] = [...evaluated];
  }

  // The E_return verdict F35 read for each priced candidate: its basis and the charger it chose.
  const returnReach = {};
  for (const entry of assembly.round.priced.values()) {
    const energy = entry.plan && entry.plan.energy && typeof entry.plan.energy === "object" ? entry.plan.energy : null;
    const reach = energy && energy.chargerReachability ? energy.chargerReachability : null;
    if (reach) {
      returnReach[businessIdOf(entry.agentId)] = {
        basis: reach.basis ?? null,
        chargerId: reach.chargerId ?? null,
        reachable: reach.reachable ?? null,
        projectionVersion: reach.projectionVersion ?? null,
      };
    }
  }

  const result = {
    decisionTimeMs,
    legRowId,
    returnReach,
    outcome: decision ? decision.outcome : null,
    winner: assignment ? businessIdOf(assignment.agentId) : null,
    assignment,
    candidates: perLeg.candidates,
    rejectionSummary: perLeg.rejectionSummary,
    indexed,
    indexSweep: sweep,
    indexErrors,
    gateCalls,
    gated: [...gated],
    denials,
    evaluatedPredicates,
    committed,
    records,
  };
  world.rounds.push(result);
  return result;
}

/**
 * The robot's connection: a server-side socket with the five handler groups `socket.server.js`
 * registers, and a client-side socket the VirtualRobot holds. What the robot emits is triggered on
 * the server socket; what the server emits to the robot (its socket or its `robot:<id>` room) is
 * handed to the robot's listeners.
 */
function connectRobot(world, vr, { logger } = {}) {
  const { prisma, kv, snapshot, robotId } = world;
  const server = createFakeSocket({ id: `sock-${robotId}` });
  const listeners = new Map();
  const delivered = [];
  const client = {
    connected: true,
    emitted: [],
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    off() {},
    removeAllListeners() { listeners.clear(); },
    emit(event, payload) {
      client.emitted.push({ event, payload });
      server.trigger(event, payload);
      return true;
    },
    disconnect() {},
  };
  const toRobot = (event, payload) => {
    delivered.push({ event, payload });
    for (const handler of listeners.get(event) || []) handler(payload);
  };
  // What a handler sends to this socket goes to the robot.
  server.emitToClient.mockImplementation((event, payload) => {
    server.sent.push({ event, payload });
    toRobot(event, payload);
  });

  const rooms = new Map();
  const roomEmits = [];
  const target = (room) => ({
    emit: (event, payload) => {
      roomEmits.push({ room, event, payload });
      if ((rooms.get(room) || []).includes(server)) toRobot(event, payload);
    },
    fetchSockets: async () => rooms.get(room) || [],
  });
  const io = { to: target, in: target, emit: () => {}, roomEmits, emittedTo: (room, event) => roomEmits.filter((m) => m.room === room && m.event === event).map((m) => m.payload) };
  server.join.mockImplementation((room) => {
    const list = rooms.get(room) || [];
    if (!list.includes(server)) list.push(server);
    rooms.set(room, list);
  });

  const appLocals = { config: snapshot };
  const log = logger || cw.silentLogger;
  const handlers = [
    require(`${SRC}/sockets/handlers/robot.handler`).registerRobotHandlers,
    require(`${SRC}/sockets/handlers/telemetry.handler`).registerTelemetryHandlers,
    require(`${SRC}/sockets/handlers/command.handler`).registerCommandHandlers,
    require(`${SRC}/sockets/handlers/dtaro.handler`).registerDtaroHandlers,
  ];
  for (const register of handlers) register(io, server, { prisma, kv, logger: log, appLocals });
  require(`${SRC}/sockets/handlers/offer.handler`).registerOfferHandlers(io, server, {
    prisma,
    kv,
    logger: log,
    config: { signingKey: SIGNING_KEY },
    appLocals,
  });

  vr.socket = client;
  vr.connected = true;
  vr._registerHandlers();

  return { server, client, io, delivered, rooms };
}

/** What `robot.handler`'s AUTH success path records on the socket, and the room it joins. */
async function authenticate(world, connection) {
  const { prisma, robotId, store } = world;
  const robot = store.rowsOf("robot").find((row) => row.robotId === robotId);
  const socket = connection.server;
  socket.data.robotId = robotId;
  socket.data.isAuthed = true;
  socket.data.robotDbId = robot.id;
  robot.socketId = socket.id;
  robot.isOnline = true;
  agentGate.bind(socket, await agentGate.resolveIdentity(prisma, robotId, Date.now()));
  socket.join(`robot:${robotId}`);
}

/**
 * The outbox worker as the composition root builds it (`leaderWorkers.COMPOSERS.outbox`: the
 * `Agent.id` → `robot:<agentId>` routing, the resolved parameters, the withdrawal transaction),
 * bound to the robot's `io` with `commandDispatcher.outboxDeliveryArm`. Only its interval loop is
 * replaced: the deps and config it would run every `intervalMs` are captured, and the test drains
 * once at a time (`drainOutbox`) on the pinned clock.
 */
function composeOutbox(world, connection) {
  let captured = null;
  const startSpy = jest.spyOn(outboxWorker, "start").mockImplementation((deps, config, workerId) => {
    captured = { deps, config, workerId };
    return { stop() {} };
  });
  try {
    const composed = leaderWorkers.COMPOSERS.outbox({
      prisma: world.prisma,
      kv: world.kv,
      io: connection.io,
      values: world.snapshot.values,
      record: () => {},
      deliver: commandDispatcher.outboxDeliveryArm(connection.io),
      runInTransaction: (fn) => fn(world.tx),
      shardId: SHARD_ID,
      signingKey: SIGNING_KEY,
      instanceId: "charging-loop",
    });
    if (!composed.ok) throw new Error(`the outbox worker was not composed: ${composed.blockedBy}`);
  } finally {
    startSpy.mockRestore();
  }
  // Its `readStoreTime` is `outboxWorker.storeTimeReader` (`SELECT NOW()`), answered by the pinned clock.
  world.outbox = captured;
  return captured;
}

/** One drain pass of the composed outbox worker. */
async function drainOutbox(world) {
  const { deps, config, workerId } = world.outbox;
  return outboxWorker.drainOnce(deps, config, workerId);
}

/** Drain the event loop deeply enough for a handler chain (many awaits) to finish. */
async function settleDeep(rounds = 40) {
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setImmediate(resolve));
  }
}

module.exports = {
  SIGNING_KEY,
  SHARD_ID,
  createLoopWorld,
  addLeg,
  runRound,
  connectRobot,
  authenticate,
  composeOutbox,
  drainOutbox,
  settleDeep,
};

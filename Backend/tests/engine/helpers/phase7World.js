"use strict";

/**
 * Phase 7 assignment-quality world — the REAL decision path over an in-memory store.
 *
 * ── What is real ────────────────────────────────────────────────────────────
 *   · the published LOCAL configuration (`ConfigVersion` v1 payload, read-only export),
 *     built into a snapshot by the real `engine/config/service.loadPinnedSnapshot`;
 *   · the real V1 composition (`services/v1DemonstrationComposition`): the RNSIT campus
 *     traversal router, the agent-facts provider (`services/agentFacts.service`, which calls
 *     `simulation/simulatedAgentState`), the simulated energy and environment seams;
 *   · the real Availability Index maintainer (`workers/indexMaintainer.sweepAgents`) with the
 *     real charging classifier (`services/chargingStatus.service`), writing into the real KV
 *     facade in its in-memory mode (`tests/helpers/testKv`);
 *   · the real solve path (`workers/coordinatorSolvePath.create`) — expansion, the §7 gate,
 *     the Plan Builder, Φ/γ — driven through the real `engine/solve/round.plan`, exactly as
 *     `coordinator.worker.runRound` drives it (steps 3–5, minus the commit);
 *   · the agent classes, mobility/energy/container models, chargers, shard, zones and the
 *     TSK-1791553228180-816 Leg/Mission/Task/Stops: verbatim rows exported read-only from the
 *     canonical LOCAL database on 2026-10-09 (`tests/fixtures/phase7/local-2026-10-09.json`).
 *
 * ── What is doubled (MOCKED BOUNDARIES) ─────────────────────────────────────
 *   · the STORE: an in-memory Prisma double answering the query shapes the decision path
 *     issues. Writes land only in this process's memory. Unknown query options throw rather
 *     than being answered approximately.
 *   · the WALL CLOCK: `Date.now()` is pinned to the scenario's decision time, and the round's
 *     budget clock reads 0 ms elapsed, so a decision is never truncated by test-machine load.
 *     Production's §9.4 wall-clock truncation is therefore NOT exercised here.
 *   · the COMMIT (§10.3.2) is not run unless a scenario asks for it (`scenario.commit`, step F):
 *     the decision is `round.plan`'s output. With `scenario.commit` the real commit runs on a
 *     recording transaction double (`commitTxDouble`) — writes are recorded, never applied.
 *   · scenario rows (positions, battery, status, commitments) are constructed per test from
 *     the fixture's real rows; each test says which values it changed.
 *
 * Nothing here injects a candidate or a winner: a robot reaches the result only by being
 * indexed by the real maintainer, discovered by the real expansion, admitted by the real gate
 * and priced by the real Φ.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const service = require("../../../src/engine/config/service");
const cells = require("../../../src/engine/spatial/cells");
const deliveryDomain = require("../../../src/engine/spatial/deliveryDomain");
const composition = require("../../../src/services/v1DemonstrationComposition");
const chargingStatus = require("../../../src/services/chargingStatus.service");
const indexMaintainer = require("../../../src/workers/indexMaintainer.worker");
const coordinatorSolvePath = require("../../../src/workers/coordinatorSolvePath");
const roundModel = require("../../../src/engine/solve/round");
const budgetModel = require("../../../src/engine/solve/budgets");
const feasibility = require("../../../src/engine/feasibility/evaluate");
const { haversineMeters } = require("../../../src/utils/distance");
const { createTestKv } = require("../../helpers/testKv");
const robotRegistry = require("../../../src/services/robotRegistry.service");

const FIXTURE = require("../../fixtures/phase7/local-2026-10-09.json");

const SHARD_ID = "rnsit-shard";
const ENV = Object.freeze({ ENABLE_VIRTUAL_SIMULATOR: "true", V1_DEMONSTRATION_COMPOSITION: "true" });

/** The recorded decision that assigned TSK-1791553228180-816 (DecisionRecordA, LOCAL). */
const TSK816 = Object.freeze({
  legRowId: "f7db6e93-c341-5745-9439-7affb48e4f1f",
  legId: "LEG-TSK-1791553228180-816",
  firstRoundMs: Date.parse("2026-10-09T13:40:28.521Z"),
  assignRoundMs: Date.parse("2026-10-09T13:44:13.786Z"),
  recordedWinner: "SIM-9F6F88D84EBD",
  recordedGammaMilliCU: "748531",
});

/* ── Named RNSIT points, from the repository's own campus data ─────────────── */

const REPO = path.resolve(__dirname, "..", "..", "..", "..");
const POINTS = Object.freeze(
  Object.fromEntries(
    JSON.parse(fs.readFileSync(path.join(REPO, "rnsit-campus-supplemental.geojson"), "utf8")).features.map((feature) => [
      feature.properties.id,
      Object.freeze({ lat: feature.geometry.coordinates[1], lon: feature.geometry.coordinates[0] }),
    ]),
  ),
);

/* ── Row revival: the export's text timestamps are UTC (`timestamp without time zone`) ── */

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/u;
const BIGINT_COLUMNS = new Set(["authorityEpoch", "fenceCounter", "observedAtMs", "fence", "leadershipFence"]);

function reviveRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "string" && TIMESTAMP.test(value)) out[key] = new Date(`${value}Z`);
    else if (BIGINT_COLUMNS.has(key) && typeof value === "number") out[key] = BigInt(value);
    else out[key] = value;
  }
  return out;
}

const copy = (value) => (value === null || value === undefined ? value : structuredClone(value));

/**
 * Charging lifecycle step D — `structuredClone` returns its Dates from Node's own realm, not Jest's
 * sandbox, so the engine's `publishedAt instanceof Date` (`chargingSchedulerClient.consumeProjection`)
 * is false for every projection this store returns and none is ever pinned (the P7-C1 suite pins
 * that artefact for the recorded replays). A scenario that publishes its own projections
 * (`scenario.projections`) reads them with Dates of the engine's realm, as a Prisma row carries.
 */
function sameRealm(value) {
  if (Object.prototype.toString.call(value) === "[object Date]") return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(sameRealm);
  if (value && typeof value === "object" && Object.prototype.toString.call(value) === "[object Object]") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = sameRealm(entry);
    return out;
  }
  return value;
}

/* ── The in-memory store ─────────────────────────────────────────────────── */

const FIXTURE_TABLE_TO_DELEGATE = Object.freeze({
  Agent: "agent",
  Robot: "robot",
  AgentClass: "agentClass",
  MobilityModel: "mobilityModel",
  EnergyModel: "energyModel",
  EnergyModelParams: "energyModelParams",
  ContainerModel: "containerModel",
  Compartment: "compartment",
  CapabilityBundle: "capabilityBundle",
  Capability: "capability",
  Shard: "shard",
  Region: "region",
  Zone: "zone",
  Charger: "charger",
  ChargerAvailabilityProjection: "chargerAvailabilityProjection",
  PayloadSpec: "payloadSpec",
  Leg: "leg",
  Stop: "stop",
  Mission: "mission",
  Task: "task",
});

const EMPTY_DELEGATES = Object.freeze([
  "commitment",
  "batteryState",
  "observation",
  "chargerReservation",
  "agentCellPosition",
  "shardMembership",
  "payloadManifest",
]);

/** Relations the decision path follows: delegate → field → how to find the related rows. */
const RELATIONS = Object.freeze({
  agentCellPosition: { agent: { model: "agent", one: true, local: "agentId", foreign: "id" } },
  // Charging-to-reassignment loop — the simulator's `addRobot` selects a Robot's Agent.
  robot: { agent: { model: "agent", one: true, local: "id", foreign: "robotDbId" } },
  agent: {
    robot: { model: "robot", one: true, local: "robotDbId", foreign: "id" },
    batteryState: { model: "batteryState", one: true, local: "id", foreign: "agentId" },
    commitments: { model: "commitment", one: false, local: "id", foreign: "agentId" },
    agentClass: { model: "agentClass", one: true, local: "agentClassId", foreign: "id" },
    cellPosition: { model: "agentCellPosition", one: true, local: "id", foreign: "agentId" },
  },
  agentClass: {
    mobilityModel: { model: "mobilityModel", one: true, local: "mobilityModelId", foreign: "id" },
    energyModel: { model: "energyModel", one: true, local: "energyModelId", foreign: "id" },
    containerModel: { model: "containerModel", one: true, local: "containerModelId", foreign: "id" },
    capabilityBundle: { model: "capabilityBundle", one: true, local: "capabilityBundleId", foreign: "id" },
    energyModelParams: { model: "energyModelParams", one: false, local: "id", foreign: "agentClassId" },
  },
  mobilityModel: { agentClasses: { model: "agentClass", one: false, local: "id", foreign: "mobilityModelId" } },
  energyModel: { agentClasses: { model: "agentClass", one: false, local: "id", foreign: "energyModelId" } },
  containerModel: {
    agentClasses: { model: "agentClass", one: false, local: "id", foreign: "containerModelId" },
    compartments: { model: "compartment", one: false, local: "id", foreign: "containerModelId" },
  },
  capabilityBundle: {
    agentClasses: { model: "agentClass", one: false, local: "id", foreign: "capabilityBundleId" },
    capabilities: { model: "capability", one: false, local: "id", foreign: "bundleId" },
  },
  leg: {
    stops: { model: "stop", one: false, local: "id", foreign: "legId" },
    manifests: { model: "payloadManifest", one: false, local: "id", foreign: "legId" },
    mission: { model: "mission", one: true, local: "missionId", foreign: "id" },
  },
  mission: {
    legs: { model: "leg", one: false, local: "id", foreign: "missionId" },
    tasks: { model: "task", one: false, joinTable: "missionToTask" },
  },
  task: { payloadSpec: { model: "payloadSpec", one: true, local: "payloadSpecId", foreign: "id" } },
});

const SCALAR_OPERATORS = new Set(["equals", "in", "notIn", "not", "lt", "lte", "gt", "gte", "contains"]);

function comparable(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "bigint") return Number(value);
  return value;
}

function equal(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  return comparable(a) === comparable(b);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !(value instanceof Date) && !Array.isArray(value);
}

function createStore(seed) {
  const tables = new Map();
  for (const [table, delegate] of Object.entries(FIXTURE_TABLE_TO_DELEGATE)) {
    tables.set(delegate, (seed[table] || []).map(reviveRow));
  }
  for (const delegate of EMPTY_DELEGATES) tables.set(delegate, []);
  tables.set("missionToTask", (seed.MissionToTask || []).map((row) => ({ ...row })));
  const writes = [];

  const rowsOf = (model) => {
    if (!tables.has(model)) throw new Error(`phase7World store: no table "${model}"`);
    return tables.get(model);
  };

  function related(model, row, field) {
    const spec = RELATIONS[model] && RELATIONS[model][field];
    if (!spec) return undefined;
    if (spec.joinTable) {
      const ids = new Set(rowsOf(spec.joinTable).filter((link) => link.A === row.id).map((link) => link.B));
      return rowsOf(spec.model).filter((target) => ids.has(target.id));
    }
    const key = row[spec.local];
    const matches = rowsOf(spec.model).filter((target) => key !== null && key !== undefined && equal(target[spec.foreign], key));
    return spec.one ? matches[0] || null : matches;
  }

  function matchScalar(value, condition) {
    if (condition === null) return value === null || value === undefined;
    if (!isPlainObject(condition)) return equal(value, condition);
    for (const [operator, operand] of Object.entries(condition)) {
      if (!SCALAR_OPERATORS.has(operator)) throw new Error(`phase7World store: unsupported operator "${operator}"`);
      if (operator === "equals" && !equal(value, operand)) return false;
      if (operator === "in" && !operand.some((item) => equal(value, item))) return false;
      if (operator === "notIn" && operand.some((item) => equal(value, item))) return false;
      if (operator === "contains" && !(typeof value === "string" && value.includes(operand))) return false;
      if (operator === "not" && (isPlainObject(operand) ? matchScalar(value, operand) : equal(value, operand))) return false;
      if (value === null || value === undefined) {
        if (["lt", "lte", "gt", "gte"].includes(operator)) return false;
        continue;
      }
      if (operator === "lt" && !(comparable(value) < comparable(operand))) return false;
      if (operator === "lte" && !(comparable(value) <= comparable(operand))) return false;
      if (operator === "gt" && !(comparable(value) > comparable(operand))) return false;
      if (operator === "gte" && !(comparable(value) >= comparable(operand))) return false;
    }
    return true;
  }

  function matches(model, row, where) {
    if (!where) return true;
    for (const [key, condition] of Object.entries(where)) {
      if (condition === undefined) continue;
      if (key === "AND") {
        if (!(Array.isArray(condition) ? condition : [condition]).every((w) => matches(model, row, w))) return false;
        continue;
      }
      if (key === "OR") {
        if (!condition.some((w) => matches(model, row, w))) return false;
        continue;
      }
      if (key === "NOT") {
        if ((Array.isArray(condition) ? condition : [condition]).some((w) => matches(model, row, w))) return false;
        continue;
      }
      const spec = RELATIONS[model] && RELATIONS[model][key];
      if (spec) {
        const target = related(model, row, key);
        if (spec.one) {
          if (condition === null) {
            if (target !== null) return false;
          } else if (isPlainObject(condition) && ("is" in condition || "isNot" in condition)) {
            if ("is" in condition && !(target && matches(spec.model, target, condition.is))) return false;
            if ("isNot" in condition && target && matches(spec.model, target, condition.isNot)) return false;
          } else if (!(target && matches(spec.model, target, condition))) {
            return false;
          }
        } else {
          if ("some" in condition && !target.some((t) => matches(spec.model, t, condition.some))) return false;
          if ("every" in condition && !target.every((t) => matches(spec.model, t, condition.every))) return false;
          if ("none" in condition && target.some((t) => matches(spec.model, t, condition.none))) return false;
        }
        continue;
      }
      if (!matchScalar(row[key], condition)) return false;
    }
    return true;
  }

  function order(rows, orderBy) {
    if (!orderBy) return rows;
    const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((entry) => Object.entries(entry));
    return [...rows].sort((a, b) => {
      for (const [field, direction] of keys) {
        const dir = (typeof direction === "string" ? direction : direction.sort) === "desc" ? -1 : 1;
        const x = comparable(a[field]);
        const y = comparable(b[field]);
        if (x === y) continue;
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        return x < y ? -dir : dir;
      }
      return 0;
    });
  }

  function project(model, row, args) {
    const options = args && args !== true ? args : {};
    const { select, include } = options;
    const out = {};
    if (select) {
      for (const [field, spec] of Object.entries(select)) {
        if (!spec) continue;
        out[field] = RELATIONS[model] && RELATIONS[model][field] ? projectRelation(model, row, field, spec) : copy(row[field]);
      }
      return out;
    }
    for (const [field, value] of Object.entries(row)) out[field] = copy(value);
    for (const [field, spec] of Object.entries(include || {})) {
      if (!spec) continue;
      out[field] = projectRelation(model, row, field, spec);
    }
    return out;
  }

  function projectRelation(model, row, field, spec) {
    const relation = RELATIONS[model] && RELATIONS[model][field];
    if (!relation) throw new Error(`phase7World store: no relation ${model}.${field}`);
    const options = spec === true ? {} : spec;
    const target = related(model, row, field);
    if (relation.one) return target ? project(relation.model, target, options) : null;
    let rows = target.filter((t) => matches(relation.model, t, options.where));
    rows = order(rows, options.orderBy);
    if (Number.isInteger(options.take)) rows = rows.slice(0, options.take);
    return rows.map((t) => project(relation.model, t, options));
  }

  const ALLOWED_READ_KEYS = new Set(["where", "include", "select", "orderBy", "take"]);

  function readMany(model, query) {
    const q = query || {};
    for (const key of Object.keys(q)) {
      if (!ALLOWED_READ_KEYS.has(key)) throw new Error(`phase7World store: unsupported read option "${key}" on ${model}`);
    }
    let rows = rowsOf(model).filter((row) => matches(model, row, q.where));
    rows = order(rows, q.orderBy);
    if (Number.isInteger(q.take)) rows = rows.slice(0, q.take);
    return rows.map((row) => project(model, row, q));
  }

  function delegate(model) {
    return {
      findMany: async (query) => readMany(model, query),
      findFirst: async (query) => readMany(model, { ...(query || {}), take: 1 })[0] || null,
      findUnique: async (query) => readMany(model, { ...(query || {}), take: 1 })[0] || null,
      count: async (query) => rowsOf(model).filter((row) => matches(model, row, query && query.where)).length,
      create: async ({ data }) => {
        const row = { id: crypto.randomUUID(), ...copy(data) };
        rowsOf(model).push(row);
        writes.push({ model, op: "create", row: copy(row) });
        return copy(row);
      },
      upsert: async ({ where, create, update }) => {
        const existing = rowsOf(model).find((row) => matches(model, row, where));
        if (existing) {
          Object.assign(existing, copy(update));
          writes.push({ model, op: "update", row: copy(existing) });
          return copy(existing);
        }
        const row = { id: crypto.randomUUID(), ...copy(create) };
        rowsOf(model).push(row);
        writes.push({ model, op: "create", row: copy(row) });
        return copy(row);
      },
      delete: async ({ where }) => {
        const rows = rowsOf(model);
        const index = rows.findIndex((row) => matches(model, row, where));
        if (index < 0) throw new Error(`phase7World store: ${model}.delete matched nothing`);
        const [removed] = rows.splice(index, 1);
        writes.push({ model, op: "delete", row: copy(removed) });
        return copy(removed);
      },
      // Charging-to-reassignment loop — the writes a persistent world needs (the decision-only
      // scenarios above never issue them). Applied in place, like a committed row.
      update: async ({ where, data, select, include }) => {
        const row = rowsOf(model).find((entry) => matches(model, entry, where));
        if (!row) {
          const error = new Error(`phase7World store: ${model}.update matched nothing`);
          error.code = "P2025";
          throw error;
        }
        applyData(row, data);
        writes.push({ model, op: "update", row: copy(row) });
        return project(model, row, { select, include });
      },
      updateMany: async ({ where, data }) => {
        const rows = rowsOf(model).filter((entry) => matches(model, entry, where));
        for (const row of rows) {
          applyData(row, data);
          writes.push({ model, op: "update", row: copy(row) });
        }
        return { count: rows.length };
      },
      deleteMany: async ({ where } = {}) => {
        const rows = rowsOf(model);
        const removed = rows.filter((entry) => matches(model, entry, where));
        tables.set(model, rows.filter((entry) => !removed.includes(entry)));
        for (const row of removed) writes.push({ model, op: "delete", row: copy(row) });
        return { count: removed.length };
      },
      createMany: async ({ data }) => {
        for (const item of Array.isArray(data) ? data : [data]) {
          const row = { id: crypto.randomUUID(), ...copy(item) };
          rowsOf(model).push(row);
          writes.push({ model, op: "create", row: copy(row) });
        }
        return { count: Array.isArray(data) ? data.length : 1 };
      },
    };
  }

  /** Prisma's update data: plain values, or `{ set | increment | decrement }` operations. */
  function applyData(row, data) {
    for (const [field, value] of Object.entries(data || {})) {
      if (value === undefined) continue;
      if (isPlainObject(value) && ("increment" in value || "decrement" in value || "set" in value)) {
        if ("set" in value) row[field] = copy(value.set);
        const current = row[field] === null || row[field] === undefined ? 0 : row[field];
        if ("increment" in value) row[field] = typeof current === "bigint" ? current + BigInt(value.increment) : current + value.increment;
        if ("decrement" in value) row[field] = typeof current === "bigint" ? current - BigInt(value.decrement) : current - value.decrement;
        continue;
      }
      row[field] = copy(value);
    }
  }

  const prisma = {};
  for (const model of tables.keys()) prisma[model] = delegate(model);
  /** A delegate for a table the fixture does not carry, created empty on first use. */
  const delegateFor = (model) => {
    if (!tables.has(model)) tables.set(model, []);
    if (!prisma[model]) prisma[model] = delegate(model);
    return prisma[model];
  };
  return { prisma, tables, writes, rowsOf, delegateFor };
}

/**
 * Charging lifecycle step F — the §10.3.2 transaction double for `scenario.commit`. Reads go to the
 * store (the commit's idempotency and active-commitment reads; the `FOR UPDATE` locks return the
 * store's CURRENT rows — whatever changed since the round planned); every write is recorded and
 * NOT applied, so a test can see whether the commit got past step 3. `$transaction` is absent, as
 * on a Prisma interactive-transaction client (`outbox.isTransactionClient`).
 */
function commitTxDouble(store, { storeTimeMs, leadershipFence }) {
  const writes = [];
  const READS = new Set(["findMany", "findFirst", "findUnique", "count"]);
  const table = (name) =>
    new Proxy({}, {
      get(_target, op) {
        if (typeof op !== "string") return undefined;
        return async (args) => {
          if (READS.has(op)) {
            const delegate = store.prisma[name];
            if (delegate && typeof delegate[op] === "function") return sameRealm(await delegate[op](args));
            return op === "findMany" ? [] : op === "count" ? 0 : null;
          }
          writes.push({ table: name, op, args: copy(args) });
          if (op === "updateMany" || op === "deleteMany") return { count: 1 };
          const data = (args && (args.data || args.create)) || {};
          return { id: crypto.randomUUID(), ...copy(data) };
        };
      },
    });
  const own = {
    __writes: writes,
    $queryRawUnsafe: async (sql) => {
      if (/FROM "ShardLeadership"/.test(sql)) {
        return [{ shardId: SHARD_ID, leadershipFence, holder: "phase7-harness", leaseExpiry: new Date(storeTimeMs + 3_600_000) }];
      }
      if (/SELECT NOW\(\)/.test(sql)) return [{ now: new Date(storeTimeMs) }];
      throw new Error(`phase7World commit double: unexpected SQL ${sql}`);
    },
    $executeRawUnsafe: async (sql, ...params) => {
      writes.push({ table: "$executeRawUnsafe", op: "execute", args: { sql, params: copy(params) } });
      return 1;
    },
  };
  const tx = new Proxy(own, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== "string" || prop === "then" || prop.startsWith("$")) return undefined;
      return table(prop);
    },
  });
  const selectForUpdate = async (_tx, tableName, _column, value) => {
    const model = tableName === "Agent" ? "agent" : tableName === "Leg" ? "leg" : null;
    if (!model) return null;
    const row = store.rowsOf(model).find((entry) => entry.id === value);
    return row ? sameRealm(copy(row)) : null;
  };
  return { tx, writes, selectForUpdate, runSerializable: async (_client, fn) => fn(tx) };
}

/* ── Scenario construction ───────────────────────────────────────────────── */

const FIXTURE_ROWS = FIXTURE.rows;
const fixtureAgent = (agentId) => FIXTURE_ROWS.Agent.find((row) => row.agentId === agentId);
const fixtureRobot = (robotId) => FIXTURE_ROWS.Robot.find((row) => row.robotId === robotId);

/**
 * @param {object} spec
 * @param {string} spec.robotId the agent/robot business id (a fixture robot, or a clone)
 * @param {string} [spec.cloneOf] fixture robot whose Agent/Robot/class rows a clone copies
 * @param {{lat:number, lon:number}} spec.at position at decision time
 * @param {number} spec.socFraction state of charge in [0, 1] (BatteryState.lastObservedSoc)
 * @param {string} [spec.status] persisted Robot.status (default IDLE)
 * @param {boolean} [spec.isOnline] default true
 * @param {number} [spec.lastSeenAgeMs] Robot.lastSeenAt age at decision time (default 1 000)
 * @param {number|null} [spec.positionAgeMs] position Observation age (default 1 000); null = no Observation
 * @param {object[]} [spec.openCommitments] live Commitment rows to place on this agent
 * @param {Object<string,*>} [spec.capabilities] capability values for a CLONED class/bundle (scenario construction)
 * @param {boolean} [spec.noBattery] no BatteryState row at all
 * @param {object} [spec.liveState] a KV live-registry state for the robot (what the dashboard overlays)
 */
function robotRows(spec, decisionTimeMs) {
  const sourceId = spec.cloneOf || spec.robotId;
  const agentRow = fixtureAgent(sourceId);
  const robotRow = fixtureRobot(sourceId);
  if (!agentRow || !robotRow) throw new Error(`phase7World: no fixture robot "${sourceId}"`);
  const cloned = Boolean(spec.cloneOf);
  const robotDbId = cloned ? `robot-row-${spec.robotId}` : robotRow.id;
  const agentRowId = cloned ? `agent-row-${spec.robotId}` : agentRow.id;
  const lastSeenAt = new Date(decisionTimeMs - (spec.lastSeenAgeMs ?? 1000));
  const robot = {
    ...robotRow,
    id: robotDbId,
    robotId: spec.robotId,
    status: spec.status || "IDLE",
    battery: Math.round(spec.socFraction * 1000) / 10,
    isOnline: spec.isOnline !== false,
    lastSeenAt: lastSeenAt.toISOString().replace("Z", ""),
    lat: spec.at.lat,
    lon: spec.at.lon,
    speed: 0,
    currentTaskId: null,
    simulated: true,
    statusBeforeOffline: null,
    // Charging lifecycle — the commissioned reserve, when a scenario states one (the fixture's
    // otherwise: 15 % on every LOCAL unit).
    ...(spec.batteryReservePct !== undefined ? { batteryReservePct: spec.batteryReservePct } : {}),
  };
  const agent = {
    ...agentRow,
    id: agentRowId,
    agentId: spec.robotId,
    robotDbId,
    agentClassId: agentRow.agentClassId,
  };
  const battery = {
    id: `battery-${spec.robotId}`,
    agentId: agentRowId,
    soh: 1,
    socThroughput: 0,
    cycleCount: 0,
    kappa: 1,
    kappaSampleCount: 0,
    kappaUpdatedAt: null,
    lastObservedSoc: spec.socFraction,
    lastObservedAt: new Date(decisionTimeMs - 1000),
    internalResistanceMilliOhm: null,
    baselineResistanceMilliOhm: null,
    resistanceTrendPerCycle: null,
  };
  const observation =
    spec.positionAgeMs === null
      ? null
      : {
          id: `obs-${spec.robotId}`,
          agentId: agentRowId,
          kind: "position",
          // The shape `positionObservation.service` writes for a simulated agent.
          value: { lat: spec.at.lat, lon: spec.at.lon, provenance: "SIMULATED" },
          observedAt: new Date(decisionTimeMs - (spec.positionAgeMs ?? 1000)),
          receivedAt: new Date(decisionTimeMs - (spec.positionAgeMs ?? 1000) + 5),
          source: "AGENT_REPORT",
          confidence: null,
          variance: null,
          sequence: null,
          deadReckoned: false,
          uncertaintyRadiusM: null,
        };
  const commitments = (spec.openCommitments || []).map((row, i) => ({
    id: `commitment-row-${spec.robotId}-${i}`,
    commitmentId: `commitment-${spec.robotId}-${i}`,
    agentId: agentRowId,
    legId: row.legId,
    kind: "HARD",
    fence: 1n,
    leaseExpiry: row.leaseExpiry || new Date(decisionTimeMs + 300_000),
    custodyState: "NONE",
    planSnapshotRef: null,
    decisionRef: null,
    version: 1,
    grantedAt: row.grantedAt || new Date(decisionTimeMs - 600_000),
    releasedAt: row.releasedAt === undefined ? null : row.releasedAt,
    capacitySlot: 0,
  }));
  return { robot: reviveRow(robot), agent: reviveRow(agent), battery, observation, commitments, agentRowId };
}

/**
 * A `ChargerReservation` row for a scenario robot, in `devChargingScheduler`'s shape, at the depot.
 * @param {{ robotId: string, state: string, fromAgoMs?: number, untilInMs?: number }} spec
 */
function reservationRow(spec, agentRowIdOf, decisionTimeMs) {
  const depot = FIXTURE_ROWS.Charger.find((row) => row.chargerId === "V1DEMO-DEPOT-01");
  const agentId = agentRowIdOf[spec.robotId];
  if (!agentId) throw new Error(`phase7World: no scenario robot "${spec.robotId}" for a reservation`);
  return {
    id: `reservation-${spec.robotId}`,
    reservationId: `V1DEMO-DEPOT-01:${agentId}:0`,
    agentId,
    chargerDbId: depot.id,
    reservedFrom: new Date(decisionTimeMs - (spec.fromAgoMs ?? 60_000)),
    reservedUntil: new Date(decisionTimeMs + (spec.untilInMs ?? 3_600_000)),
    targetSoc: 0.8,
    state: spec.state,
    externalId: null,
    projectionVersion: 1,
  };
}

/** A Leg/Mission/Task/Stops for a delivery, cloned from TSK-816's real rows with new stops. */
function legRows(spec, decisionTimeMs, snapshot) {
  const base = {
    leg: FIXTURE_ROWS.Leg[0],
    mission: FIXTURE_ROWS.Mission[0],
    task: FIXTURE_ROWS.Task[0],
    stops: FIXTURE_ROWS.Stop,
  };
  const id = spec.legKey || "P7";
  const createdAt = new Date(decisionTimeMs - (spec.queueAgeMs ?? 60_000));
  const legRowId = `leg-row-${id}`;
  const missionRowId = `mission-row-${id}`;
  const taskRowId = `task-row-${id}`;
  // Exactly as intake builds it (`task.service`, `validateDomainDeclaration(source.deliveryDomain)`).
  const domain = deliveryDomain.validateDomainDeclaration(snapshot.deliveryDomain || null);
  const stopRow = (kind, point, sequence) => {
    const template = base.stops.find((s) => s.stopType === kind);
    return reviveRow({
      ...template,
      id: `stop-row-${id}-${kind}`,
      stopId: `STP-${id}-${kind[0]}`,
      legId: legRowId,
      sequence,
      label: point.label || kind,
      lat: point.lat,
      lon: point.lon,
      fineCell: cells.cellForPoint(point.lat, point.lon, cells.RESOLUTION.FINE),
      // Intake's own verdict function on the exact coordinate (`task.service`, D1 layer 2).
      geofenceResult: deliveryDomain.evaluatePoint(domain, point.lat, point.lon).verdict,
      identityKey: null,
    });
  };
  const leg = reviveRow({
    ...base.leg,
    id: legRowId,
    legId: `LEG-${id}`,
    missionId: missionRowId,
    state: "QUEUED",
    custodyState: "NONE",
    version: 0,
    cancelRequestedAt: null,
    slaDeadline: new Date(createdAt.getTime() + (spec.slaSeconds ?? 3600) * 1000).toISOString().replace("Z", ""),
    createdAt: createdAt.toISOString().replace("Z", ""),
    updatedAt: createdAt.toISOString().replace("Z", ""),
  });
  const mission = reviveRow({ ...base.mission, id: missionRowId, missionId: `MSN-${id}` });
  const task = reviveRow({
    ...base.task,
    id: taskRowId,
    taskId: `TSK-${id}`,
    robotId: null,
    status: "PENDING",
    pickupLat: spec.pickup.lat,
    pickupLon: spec.pickup.lon,
    dropLat: spec.drop.lat,
    dropLon: spec.drop.lon,
    requirements: spec.requirements === undefined ? null : spec.requirements,
  });
  return {
    leg,
    mission,
    task,
    stops: [stopRow("PICKUP", spec.pickup, 0), stopRow("DROP", spec.drop, 1)],
    link: { A: missionRowId, B: taskRowId },
  };
}

/** The published snapshot with named parameters answered differently (counterfactuals only). */
function overriddenSnapshot(published, overrides) {
  const values = new Map(published.values);
  for (const [name, value] of Object.entries(overrides)) values.set(name, value);
  return Object.assign(Object.create(Object.getPrototypeOf(published)), published, {
    values,
    resolve: (name, context, options) =>
      Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name] : published.resolve(name, context, options),
    explain: (name, context, options) => {
      const explained = published.explain(name, context, options);
      return Object.prototype.hasOwnProperty.call(overrides, name) ? { ...explained, value: overrides[name] } : explained;
    },
  });
}

/**
 * Clone an agent class and its capability bundle with some capability values changed — the
 * shape `robotSpecification` commissions, with different declared numbers. Scenario construction.
 */
function cloneClassWithCapabilities(store, agentClassId, robotId, capabilities) {
  const classRow = store.rowsOf("agentClass").find((row) => row.id === agentClassId);
  const bundleRow = store.rowsOf("capabilityBundle").find((row) => row.id === classRow.capabilityBundleId);
  const newBundleId = `bundle-${robotId}`;
  const newClassId = `class-${robotId}`;
  store.rowsOf("capabilityBundle").push({ ...copy(bundleRow), id: newBundleId, bundleId: `CB-${robotId}` });
  for (const capability of store.rowsOf("capability").filter((row) => row.bundleId === bundleRow.id)) {
    const value = Object.prototype.hasOwnProperty.call(capabilities, capability.name) ? capabilities[capability.name] : capability.value;
    store.rowsOf("capability").push({ ...copy(capability), id: `${capability.id}-${robotId}`, bundleId: newBundleId, value });
  }
  store.rowsOf("agentClass").push({ ...copy(classRow), id: newClassId, classId: `AC-${robotId}`, capabilityBundleId: newBundleId });
  // The class's newest energy parameters belong to the class row; the clone carries the same fit.
  for (const params of store.rowsOf("energyModelParams").filter((row) => row.agentClassId === agentClassId)) {
    store.rowsOf("energyModelParams").push({ ...copy(params), id: `${params.id}-${robotId}`, agentClassId: newClassId });
  }
  return newClassId;
}

/**
 * Build a world and decide one Leg through the real path.
 *
 * @param {object} scenario
 * @param {number} scenario.decisionTimeMs
 * @param {object[]} scenario.robots `robotRows` specs
 * @param {object} [scenario.leg] `legRows` spec; absent = the real TSK-816 Leg
 * @param {object[]} [scenario.priorCommitmentsOnLeg] released Commitment rows on the decided Leg (F20)
 * @returns {Promise<object>} the decision and its evidence
 */
async function decide(scenario) {
  const decisionTimeMs = scenario.decisionTimeMs;
  const nowSpy = jest.spyOn(Date, "now").mockReturnValue(decisionTimeMs);
  const store = createStore(FIXTURE_ROWS);
  const { kv, close } = await createTestKv();
  try {
    const versionRow = {
      version: FIXTURE.configVersion.version,
      publishedAt: new Date(FIXTURE.configVersion.publishedAt),
      payload: FIXTURE.configVersion.payload,
      signature: "fixture",
    };
    const published = await service.loadPinnedSnapshot({
      prisma: { configVersion: { findUnique: async () => versionRow } },
      version: 1,
    });
    // COUNTERFACTUAL ONLY: a named parameter answered differently. Every scenario that sets
    // this says so; the published configuration is what every other scenario decides on.
    const snapshot = scenario.configOverrides ? overriddenSnapshot(published, scenario.configOverrides) : published;

    // The fleet for this scenario replaces the fixture's four live rows.
    store.tables.set("agent", []);
    store.tables.set("robot", []);
    const agentRowIds = [];
    const simulatedRobotIds = new Set();
    const agentRowIdOf = {};
    for (const spec of scenario.robots) {
      const rows = robotRows(spec, decisionTimeMs);
      if (spec.capabilities) rows.agent.agentClassId = cloneClassWithCapabilities(store, rows.agent.agentClassId, spec.robotId, spec.capabilities);
      store.rowsOf("agent").push(rows.agent);
      store.rowsOf("robot").push(rows.robot);
      if (!spec.noBattery) store.rowsOf("batteryState").push(rows.battery);
      if (spec.liveState) await robotRegistry.setRobotState(kv, spec.robotId, spec.liveState);
      if (rows.observation) store.rowsOf("observation").push(rows.observation);
      for (const c of rows.commitments) store.rowsOf("commitment").push(c);
      agentRowIds.push(rows.agentRowId);
      simulatedRobotIds.add(spec.robotId);
      agentRowIdOf[spec.robotId] = rows.agentRowId;
    }
    // Charging lifecycle (Phase C) — charger reservations held before the round (QUEUED/ACTIVE
    // rows a scenario names by robot), in the scheduler's row shape.
    for (const row of scenario.reservations || []) {
      store.rowsOf("chargerReservation").push(reservationRow(row, agentRowIdOf, decisionTimeMs));
    }
    // Charging lifecycle step D — projection rows a scenario publishes (`devChargingScheduler`'s own
    // shape), ADDED after the recorded one, so the latest version is the scenario's.
    if (scenario.projections) {
      for (const row of scenario.projections) store.rowsOf("chargerAvailabilityProjection").push({ ...row });
      const table = store.prisma.chargerAvailabilityProjection;
      const findFirst = table.findFirst;
      const findMany = table.findMany;
      table.findFirst = async (query) => sameRealm(await findFirst(query));
      table.findMany = async (query) => sameRealm(await findMany(query));
    }

    let legRowId;
    if (scenario.leg) {
      const built = legRows(scenario.leg, decisionTimeMs, snapshot);
      store.tables.set("leg", [built.leg]);
      store.tables.set("mission", [built.mission]);
      store.tables.set("task", [built.task]);
      store.tables.set("stop", built.stops);
      store.tables.set("missionToTask", [built.link]);
      legRowId = built.leg.id;
    } else {
      // The real TSK-816 Leg, as it stood when the engine first saw it (QUEUED, version 0).
      const leg = store.rowsOf("leg")[0];
      Object.assign(leg, { state: "QUEUED", custodyState: "NONE", version: 0 });
      store.rowsOf("task")[0].status = "PENDING";
      legRowId = leg.id;
    }
    for (const row of scenario.priorCommitmentsOnLeg || []) {
      store.rowsOf("commitment").push({ ...row, legId: legRowId });
    }

    // ── 1. The Availability Index, built by the real maintainer (server.js wiring) ──
    const indexErrors = [];
    const sweep = await indexMaintainer.sweepAgents(
      {
        prisma: store.prisma,
        kv,
        snapshot,
        now: () => decisionTimeMs,
        chargingStatusFor: chargingStatus.createChargingStatusReader({
          prisma: store.prisma,
          // server.js: `virtualSimulator.managesAgent(subject)` — every scenario robot is simulated.
          inScope: (subject) => simulatedRobotIds.has(subject.agentId),
        }),
        onError: (error, agentId) => indexErrors.push({ agentId, message: error && error.message }),
      },
      agentRowIds,
    );
    // Charging lifecycle (Phase C) — a change that lands AFTER the index was built and before the
    // round decides (a robot reserving a charger in that window): the round must not trust the
    // index for it.
    if (typeof scenario.afterIndex === "function") {
      await scenario.afterIndex({
        store,
        addReservation: (row) => store.rowsOf("chargerReservation").push(reservationRow(row, agentRowIdOf, decisionTimeMs)),
      });
    }
    const indexed = store.rowsOf("agentCellPosition").map((row) => ({
      agentId: store.rowsOf("agent").find((a) => a.id === row.agentId).agentId,
      availabilityClass: row.availabilityClass,
    }));

    // ── 2. The composition and the assembly (leaderWorkers.create + server.js) ──
    const seams = composition.createV1DemonstrationComposition({ prisma: store.prisma, kv, snapshot: () => snapshot, env: ENV });
    const records = [];
    let commitDouble = null;
    const assembly = coordinatorSolvePath.create({
      ...seams,
      prisma: store.prisma,
      kv,
      snapshot: () => snapshot,
      values: () => snapshot.values,
      shardId: SHARD_ID,
      regionId: FIXTURE_ROWS.Shard[0].regionId,
      instanceId: "phase7-harness",
      signingKey: "phase7-test-only-signing-key-32-bytes",
      // Step F — the commit runs only when a scenario asks for it (`scenario.commit`), on the
      // recording transaction double; otherwise it stays outside this harness, as before.
      runSerializable: async (client, fn) => {
        if (!commitDouble) throw new Error("phase7World: the commit is outside this harness");
        return commitDouble.runSerializable(client, fn);
      },
      selectForUpdate: async (...args) => {
        if (!commitDouble) throw new Error("phase7World: the commit is outside this harness");
        return commitDouble.selectForUpdate(...args);
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

    // Observation only: every route the round asked for, and what the router answered.
    const routeCalls = [];
    const originalForPairing = assembly.round.routing.forPairing;
    const routeSpy = jest.spyOn(assembly.round.routing, "forPairing").mockImplementation(async function observedRoute(...args) {
      const [originCell, stops, profileKey, originPoint] = args;
      const result = await originalForPairing.apply(this, args);
      routeCalls.push({
        originCell,
        originPoint: originPoint || null,
        stops: (stops || []).map((stop) => ({ cellId: stop.cellId, lat: stop.lat ?? null, lon: stop.lon ?? null })),
        profileKey,
        ok: result.ok,
        hops: (result.hops || []).map((hop) => ({
          distanceM: hop.distanceM,
          travelSeconds: hop.travelSeconds,
          intraCellOffsetM: hop.intraCellOffsetM ?? null,
          exact: Array.isArray(hop.path),
        })),
        problems: result.problems || [],
      });
      return result;
    });

    // ── 3. The round (coordinator.worker.runRound steps 3–5, minus the commit) ──
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
    assembly.deps.planState.beginRound(roundId);
    await assembly.deps.prepareRound({ shardId: SHARD_ID, roundId, decisionTimeMs, legIds: [legRowId] });
    const queueRow = { legId: legRowId, slaClass: null, purpose: "PRIMARY", shardId: SHARD_ID, enqueuedAt: new Date(decisionTimeMs - 1000), priority: 0 };
    let planned;
    try {
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
      routeSpy.mockRestore();
    }

    const businessIdOf = (id) => {
      const agent = store.rowsOf("agent").find((row) => row.id === id || row.agentId === id);
      return agent ? agent.agentId : id;
    };
    const perLeg = assembly.deps.perLegFor()[legRowId] || { candidates: [], rejectionSummary: [] };
    const decision = planned.decisions.find((row) => row.legId === legRowId) || null;
    const assignment = planned.assignments.find((row) => row.legId === legRowId) || null;

    // ── 4. Step F (opt-in) — §10.3.2's commit of the round's assignment, after a change that
    // lands BETWEEN the decision and the commit (`scenario.commit.between`). The real
    // `assembly.deps.commit` runs: the row locks, the guards and the volatile re-check (step 3)
    // read the store as it is NOW; writes are recorded on the transaction double, not applied.
    let committed = null;
    if (scenario.commit && assignment) {
      const storeTimeMs = decisionTimeMs + (Number.isFinite(scenario.commit.afterMs) ? scenario.commit.afterMs : 1000);
      const leadershipFence = 1n;
      if (typeof scenario.commit.between === "function") {
        await scenario.commit.between({
          store,
          kv,
          agentRowIdOf,
          robotRow: (robotId) => store.rowsOf("robot").find((row) => row.robotId === robotId),
          batteryRow: (robotId) => store.rowsOf("batteryState").find((row) => row.agentId === agentRowIdOf[robotId]),
          setLiveState: (robotId, state) => robotRegistry.setRobotState(kv, robotId, state),
          addReservation: (row) => store.rowsOf("chargerReservation").push(reservationRow(row, agentRowIdOf, storeTimeMs)),
        });
      }
      commitDouble = commitTxDouble(store, { storeTimeMs, leadershipFence });
      nowSpy.mockReturnValue(storeTimeMs);
      const outcome = await assembly.deps.commit(assignment, { roundId, leadershipFence });
      committed = {
        outcome: outcome ? outcome.outcome ?? null : null,
        committed: outcome ? outcome.committed === true : false,
        reason: outcome ? outcome.reason ?? null : null,
        detail: outcome ? outcome.detail ?? null : null,
        writes: commitDouble.writes.map((row) => `${row.table}.${row.op}`),
        // The recorded writes themselves (arguments included), e.g. the OFFER row the agent would be sent.
        recorded: commitDouble.writes,
      };
    }

    // Priced plans — distance and ETA the engine priced each surviving candidate on.
    const priced = {};
    for (const entry of assembly.round.priced.values()) {
      const plan = entry.plan || {};
      const pickupStop = (plan.stops || []).find((stop) => stop.stopType === "PICKUP") || (plan.stops || [])[0] || null;
      const energy = plan.energy && typeof plan.energy === "object" ? plan.energy : null;
      const reach = energy && energy.chargerReachability ? energy.chargerReachability : null;
      priced[businessIdOf(entry.agentId)] = {
        energyReserves: energy ? energy.reserves || energy.ledger || null : null,
        // Step D — the E_return verdict F35 read: its basis and the charger it chose.
        returnReach: reach
          ? {
            basis: reach.basis ?? null,
            chargerId: reach.chargerId ?? null,
            reachable: reach.reachable ?? null,
            projectionVersion: reach.projectionVersion ?? null,
            eReturnWh: reach.eReturnWh ?? null,
            considered: Array.isArray(reach.considered) ? reach.considered.map((row) => ({ ...row })) : [],
          }
          : null,
        tierProbabilities: energy ? energy.tierProbabilities || null : null,
        distanceM: plan.totals ? plan.totals.distanceM : (plan.distanceM ?? null),
        durationSeconds: plan.durationSeconds ?? null,
        pickupEtaSeconds: pickupStop && Number.isFinite(pickupStop.projectedArrivalMs) ? (pickupStop.projectedArrivalMs - decisionTimeMs) / 1000 : null,
        energyWh: plan.energyWh ?? null,
      };
    }

    const denials = {};
    for (const call of gateCalls) {
      const outcome = call.result && call.result.outcome;
      if (!outcome || outcome.feasible) continue;
      denials[call.agentId] = outcome.denials.map((row) => ({
        predicateId: row.predicateId,
        verdict: row.result && row.result.verdict,
        observed: row.result && row.result.observed,
        required: row.result && row.result.required,
        reason: row.result && row.result.reason,
      }));
    }

    const leg = store.rowsOf("leg").find((row) => row.id === legRowId);
    const pickup = store.rowsOf("stop").find((row) => row.legId === legRowId && row.stopType === "PICKUP");
    const straightLineToPickupM = Object.fromEntries(
      scenario.robots.map((spec) => [spec.robotId, Math.round(haversineMeters(spec.at.lat, spec.at.lon, pickup.lat, pickup.lon) * 10) / 10]),
    );

    return {
      decisionTimeMs,
      legId: leg.legId,
      legRowId,
      outcome: decision ? decision.outcome : null,
      winner: assignment ? businessIdOf(assignment.agentId) : null,
      assignment,
      decision,
      candidates: perLeg.candidates,
      rejectionSummary: perLeg.rejectionSummary,
      // P7-D5 — the Tier B input the round's decision record is handed.
      tierBInput: perLeg.tierBInput ?? null,
      indexed,
      indexSweep: sweep,
      indexErrors,
      priced,
      denials,
      straightLineToPickupM,
      routeCalls,
      records,
      writes: store.writes,
      // Step F — the commit's outcome (`scenario.commit`), or null.
      committed,
    };
  } finally {
    nowSpy.mockRestore();
    await close();
  }
}

/**
 * Replay robots AS RECORDED before 2026-10-12: with the commissioned `batteryReservePct` absent, as
 * the engine read them then (F34's floor was the simulator's 5 %). For replays that pin a recorded
 * round or an analysis of one; a current-behaviour scenario must not use it.
 */
function asRecorded(robots) {
  return robots.map((spec) => ({ ...spec, batteryReservePct: null }));
}

/** A robot at a named RNSIT point (or a literal point), cloned from SIM-9F6F88D84EBD's real rows. */
function sim(robotId, at, overrides) {
  return { robotId, cloneOf: "SIM-9F6F88D84EBD", at, socFraction: 0.9, ...(overrides || {}) };
}

module.exports = {
  FIXTURE,
  POINTS,
  asRecorded,
  SHARD_ID,
  TSK816,
  createStore,
  decide,
  sim,
  // Charging-to-reassignment loop (`chargingLoopWorld.js`) — the same row builders and
  // environment the decision scenarios use.
  ENV,
  robotRows,
  legRows,
  sameRealm,
};

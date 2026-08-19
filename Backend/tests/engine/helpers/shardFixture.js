"use strict";

/**
 * Fixtures for Phase 13 — §3.5's shard model, §19's leadership and failover, and §19.6's
 * cross-region saga.
 *
 * ── Two stores, deliberately ────────────────────────────────────────────────
 * Phase 13's tests use **two** doubles, and which one a test picks is itself a statement
 * about what the test is proving:
 *
 *   - `helpers/commitmentStore.js` (Phase 3's) models row locks that genuinely block and
 *     transaction overlays that land atomically or not at all. Every test about
 *     **leadership** uses it, because the whole claim of `leadership.tryAcquire` is that
 *     two concurrent acquirers cannot both win, and a store that cannot make two callers
 *     race proves nothing about it. The chaos suite uses it for the same reason: G1's
 *     abort is a property of a transaction, not of a function.
 *   - `memoryStore()` below is the cheap one, for the modules whose claims are about
 *     *content* rather than about concurrency — the failover inventory, the sizing
 *     report, the saga's compensation record.
 *
 * The rule this file follows, and that a reviewer should hold it to: **a test whose claim
 * is about concurrency does not use `memoryStore()`.**
 *
 * ── What the partial indexes cost, and why they are modelled ────────────────
 * `ShardMembership_one_current_per_agent` is §3.5's "Every Agent belongs to exactly one
 * shard at a time" expressed as a schema property. A double that accepted two current rows
 * would let the handoff's idempotence test pass against a store the database would refuse,
 * which is precisely the class of false pass Phase 12's report recorded finding and fixing
 * in its own fixture. It is modelled.
 */

/**
 * Does a row match a Prisma-style `where` clause?
 *
 * Supports the operators the Phase 13 modules use: equality, `in`, `not`, `lt`, `lte`,
 * `gt`, `gte`, `OR`, and a one-level relation filter (`mission: { regionId: { in: [...] } }`),
 * which is what `failover.legsInShard` needs.
 *
 * @param {object} row
 * @param {object} where
 * @param {object} store the whole store, for relation resolution
 * @returns {boolean}
 */
function matches(row, where, store) {
  for (const [key, condition] of Object.entries(where || {})) {
    if (key === "OR") {
      if (!condition.some((clause) => matches(row, clause, store))) return false;
      continue;
    }
    if (key === "mission") {
      const mission = (store.mission || []).find((entry) => entry.id === row.missionId);
      if (!mission) return false;
      if (!matches(mission, condition, store)) return false;
      continue;
    }

    // A real row always has every column, so an unset field reads as NULL rather than as
    // absent — without which `{ supersededAt: null }` would fail to match a row created
    // without the key, and a test would pass against a store Postgres would never produce.
    const value = row[key] === undefined ? null : row[key];

    if (condition !== null && typeof condition === "object" && !(condition instanceof Date) && typeof condition !== "bigint") {
      if ("in" in condition && !condition.in.some((candidate) => same(value, candidate))) return false;
      if ("notIn" in condition && condition.notIn.some((candidate) => same(value, candidate))) return false;
      if ("not" in condition) {
        if (condition.not === null) {
          if (value === null) return false;
        } else if (same(value, condition.not)) {
          return false;
        }
      }
      if ("lt" in condition && !(value !== null && cmp(value) < cmp(condition.lt))) return false;
      if ("lte" in condition && !(value !== null && cmp(value) <= cmp(condition.lte))) return false;
      if ("gt" in condition && !(value !== null && cmp(value) > cmp(condition.gt))) return false;
      if ("gte" in condition && !(value !== null && cmp(value) >= cmp(condition.gte))) return false;
      continue;
    }

    if (!same(value, condition)) return false;
  }
  return true;
}

/** @param {*} left @param {*} right @returns {boolean} */
function same(left, right) {
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  if (typeof left === "bigint" || typeof right === "bigint") {
    if (left === null || right === null || left === undefined || right === undefined) return left === right;
    return BigInt(left) === BigInt(right);
  }
  return left === right;
}

/** @param {*} value @returns {*} */
function cmp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "bigint") return Number(value);
  return value;
}

/**
 * @param {object[]} rows
 * @param {object|object[]} orderBy
 * @returns {object[]}
 */
function sortRows(rows, orderBy) {
  const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  return [...rows].sort((a, b) => {
    for (const clause of clauses) {
      const [key, direction] = Object.entries(clause)[0];
      const left = cmp(a[key]);
      const right = cmp(b[key]);
      if (left === right) continue;
      if (left === null || left === undefined) return 1;
      if (right === null || right === undefined) return -1;
      const less = left < right ? -1 : 1;
      return direction === "desc" ? -less : less;
    }
    return 0;
  });
}

/**
 * @param {object} row
 * @param {object} select
 * @returns {object}
 */
function project(row, select) {
  const out = {};
  for (const [key, wanted] of Object.entries(select)) {
    if (wanted) out[key] = row[key];
  }
  return out;
}

/**
 * One table's client surface.
 *
 * @param {object} store
 * @param {string} name
 * @param {object} [options] `{ currentUniqueBy }` — a partial unique index over the rows
 *   whose `supersededAt` is null
 * @returns {object}
 */
function table(store, name, options) {
  const settings = options || {};
  const rows = () => (store[name] = store[name] || []);
  let sequence = 0;

  const applyAtomics = (target, data) => {
    const next = {};
    for (const [key, value] of Object.entries(data || {})) {
      if (value !== null && typeof value === "object" && !(value instanceof Date) && typeof value !== "bigint") {
        if ("increment" in value) {
          next[key] = (target[key] || 0) + value.increment;
          continue;
        }
        if ("decrement" in value) {
          next[key] = (target[key] || 0) - value.decrement;
          continue;
        }
      }
      next[key] = value;
    }
    return next;
  };

  return {
    async findMany({ where, orderBy, take, select } = {}) {
      const found = sortRows(rows().filter((row) => matches(row, where, store)), orderBy).map((row) => ({ ...row }));
      const limited = take === undefined ? found : found.slice(0, take);
      return select ? limited.map((row) => project(row, select)) : limited;
    },
    async findFirst({ where, orderBy, select } = {}) {
      const found = sortRows(rows().filter((row) => matches(row, where, store)), orderBy)[0];
      if (!found) return null;
      return select ? project({ ...found }, select) : { ...found };
    },
    async findUnique({ where, select } = {}) {
      const found = rows().find((row) => matches(row, where, store));
      if (!found) return null;
      return select ? project({ ...found }, select) : { ...found };
    },
    async count({ where } = {}) {
      return rows().filter((row) => matches(row, where, store)).length;
    },
    async create({ data }) {
      // The partial unique index the Phase 13 migration adds. Without it a double would
      // accept the second current membership the database refuses, and §3.5's "exactly one
      // shard at a time" would be a property of this fixture's silence.
      if (settings.currentUniqueBy) {
        const clash = rows().find(
          (entry) =>
            settings.currentUniqueBy.every((field) => same(entry[field], data[field])) &&
            (entry.supersededAt ?? null) === null &&
            (data.supersededAt ?? null) === null,
        );
        if (clash) {
          const error = new Error(`Unique constraint failed on the fields: (${settings.currentUniqueBy.join(",")})`);
          error.code = "P2002";
          throw error;
        }
      }
      sequence += 1;
      const row = { id: data.id || `${name}-${sequence}`, createdAt: new Date(), updatedAt: new Date(), ...data };
      rows().push(row);
      return { ...row };
    },
    async updateMany({ where, data }) {
      let count = 0;
      for (const row of rows()) {
        if (!matches(row, where, store)) continue;
        Object.assign(row, applyAtomics(row, data), { updatedAt: new Date() });
        count += 1;
      }
      return { count };
    },
    async update({ where, data }) {
      const row = rows().find((entry) => matches(entry, where, store));
      if (!row) throw new Error(`no ${name} row matching ${JSON.stringify(where, bigintSafe)}`);
      Object.assign(row, applyAtomics(row, data), { updatedAt: new Date() });
      return { ...row };
    },
    async upsert({ where, create, update }) {
      const compound = Object.values(where)[0];
      const criteria = typeof compound === "object" && compound !== null && !(compound instanceof Date) ? compound : where;
      const row = rows().find((entry) => matches(entry, criteria, store));
      if (row) {
        Object.assign(row, applyAtomics(row, update), { updatedAt: new Date() });
        return { ...row };
      }
      sequence += 1;
      const created = { id: `${name}-${sequence}`, createdAt: new Date(), updatedAt: new Date(), ...create };
      rows().push(created);
      return { ...created };
    },
    async deleteMany({ where } = {}) {
      const before = rows().length;
      store[name] = rows().filter((row) => !matches(row, where, store));
      return { count: before - store[name].length };
    },
  };
}

/** JSON replacer that survives BigInt, for fixture error messages only. */
function bigintSafe(key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * An in-memory store carrying every table the Phase 13 modules touch.
 *
 * `$transaction(fn)` runs the callback against the same client. It is **not** atomic and
 * does not claim to be — no test in this phase asserts atomicity against it, because the
 * tests that make that claim use `helpers/commitmentStore.js`, which models it.
 *
 * @param {object} [seed] `{ tableName: rows[] }`
 * @returns {object}
 */
function memoryStore(seed) {
  const store = {
    shard: [],
    shardMembership: [],
    shardLeadership: [],
    crossRegionSaga: [],
    transferPoint: [],
    agent: [],
    agentFenceAudit: [],
    leg: [],
    mission: [],
    commitment: [],
    outbox: [],
    timer: [],
    workQueue: [],
    reconcilerRepair: [],
    ...(seed || {}),
  };

  const client = {
    __store: store,
    shard: table(store, "shard"),
    // §3.5 — one current membership per agent, as the migration's partial unique index.
    shardMembership: table(store, "shardMembership", { currentUniqueBy: ["agentId"] }),
    shardLeadership: table(store, "shardLeadership"),
    crossRegionSaga: table(store, "crossRegionSaga"),
    transferPoint: table(store, "transferPoint"),
    agent: table(store, "agent"),
    agentFenceAudit: table(store, "agentFenceAudit"),
    leg: table(store, "leg"),
    mission: table(store, "mission"),
    commitment: table(store, "commitment"),
    outbox: table(store, "outbox"),
    timer: table(store, "timer"),
    workQueue: table(store, "workQueue"),
    reconcilerRepair: table(store, "reconcilerRepair"),
  };

  client.$transaction = (fn) => (typeof fn === "function" ? fn(client) : Promise.all(fn));
  return client;
}

/**
 * A two-shard world with one agent in each, both leadership rows present.
 *
 * @param {object} [options] `{ nowMs }`
 * @returns {object} the seed for `memoryStore`
 */
function twoShardWorld(options) {
  const settings = options || {};
  const nowMs = Number.isFinite(settings.nowMs) ? settings.nowMs : 1770000000000;
  const at = new Date(nowMs - 60000);

  return {
    shardLeadership: [
      { id: "sl-north", shardId: "shard-north", leadershipFence: 3n, holder: "coordinator-a", leaseExpiry: new Date(nowMs + 5000) },
      { id: "sl-south", shardId: "shard-south", leadershipFence: 1n, holder: null, leaseExpiry: null },
    ],
    shard: [
      { id: "shard-1", shardId: "shard-north", regionId: "region-north", state: "ACTIVE", agentCount: 1, bindingBound: "NEITHER_EVALUATED", roundsResumableAt: at },
      { id: "shard-2", shardId: "shard-south", regionId: "region-south", state: "ACTIVE", agentCount: 1, bindingBound: "NEITHER_EVALUATED", roundsResumableAt: at },
    ],
    agent: [
      { id: "agent-n", agentId: "AGT-N", authorityEpoch: 4n, fenceCounter: 11n, regionId: "region-north" },
      { id: "agent-s", agentId: "AGT-S", authorityEpoch: 2n, fenceCounter: 7n, regionId: "region-south" },
    ],
    shardMembership: [
      { id: "sm-1", agentId: "agent-n", shardId: "shard-north", fromShardId: null, movedAt: at, supersededAt: null, authorityEpochBefore: 4n, authorityEpochAfter: 4n, reason: "COMMISSIONING", movedBy: "seed" },
      { id: "sm-2", agentId: "agent-s", shardId: "shard-south", fromShardId: null, movedAt: at, supersededAt: null, authorityEpochBefore: 2n, authorityEpochAfter: 2n, reason: "COMMISSIONING", movedBy: "seed" },
    ],
    mission: [
      { id: "mission-n", missionId: "MSN-N", regionId: "region-north" },
      { id: "mission-s", missionId: "MSN-S", regionId: "region-south" },
    ],
    leg: [],
    commitment: [],
    workQueue: [],
  };
}

/**
 * A shard that has just lost its leader, with the volatile and durable state §19.5
 * distinguishes: two Legs in `PLANNED` — one with a live HARD commitment, one without —
 * and one Leg past `PLANNED` with nothing holding it.
 *
 * The three are the three §19.5 and §12.4 give different answers for, so a failover test
 * against this world is a test of the distinction rather than of the count.
 *
 * @param {object} [options] `{ nowMs }`
 * @returns {object} the seed for `memoryStore`
 */
function postFailoverWorld(options) {
  const settings = options || {};
  const nowMs = Number.isFinite(settings.nowMs) ? settings.nowMs : 1770000000000;
  const base = twoShardWorld({ nowMs });

  return {
    ...base,
    leg: [
      // Reconstructed: PLANNED, no live commitment. §19.5's volatile half.
      { id: "leg-planned-orphan", legId: "LEG-P1", missionId: "mission-n", state: "PLANNED", custodyState: "NONE", purpose: "PRIMARY", version: 2 },
      // Left alone: PLANNED **with** a live commitment. An agent has been told.
      { id: "leg-planned-committed", legId: "LEG-P2", missionId: "mission-n", state: "PLANNED", custodyState: "NONE", purpose: "PRIMARY", version: 1 },
      // A genuine §12.4 defect orphan: past PLANNED with nothing holding it.
      { id: "leg-defect-orphan", legId: "LEG-D1", missionId: "mission-n", state: "EN_ROUTE_PICKUP", custodyState: "HELD", purpose: "PRIMARY", version: 5 },
      // Another shard's Leg, so scoping is exercised rather than assumed.
      { id: "leg-south", legId: "LEG-S1", missionId: "mission-s", state: "PLANNED", custodyState: "NONE", purpose: "PRIMARY", version: 0 },
    ],
    commitment: [
      { id: "cmt-1", commitmentId: "CMT-1", agentId: "agent-n", legId: "leg-planned-committed", kind: "HARD", fence: 11n, releasedAt: null, leaseExpiry: new Date(nowMs + 30000) },
    ],
    workQueue: [
      { id: "wq-1", legId: "leg-planned-orphan", shardId: "shard-north", state: "CLAIMED", priority: 200, version: 0 },
      { id: "wq-2", legId: "leg-planned-committed", shardId: "shard-north", state: "SOLVED", priority: 200, version: 0 },
      { id: "wq-3", legId: "leg-defect-orphan", shardId: "shard-north", state: "SOLVED", priority: 200, version: 0 },
      { id: "wq-4", legId: "leg-south", shardId: "shard-south", state: "CLAIMED", priority: 200, version: 0 },
    ],
    // PHASE 13 REMEDIATION — `shardId` is now carried, and a **third timer in the other
    // shard** is seeded deliberately. `failover.inventory()` scopes its timer counts by
    // `Timer.shardId`; before that it counted the fleet's while reporting the shard's, and
    // a fixture with only one shard's timers in it could not tell the two apart. This is
    // the negative control: `shard-north`'s inventory must still read 2 pending / 1
    // overdue with `t-3` present.
    timer: [
      { id: "t-1", timerKey: "LEG:leg-planned-committed:PLANNED:1:hardening", entityType: "LEG", entityId: "leg-planned-committed", timerState: "PENDING", dueAt: new Date(nowMs + 10000), shardId: "shard-north" },
      { id: "t-2", timerKey: "LEG:leg-defect-orphan:EN_ROUTE_PICKUP:5:progress", entityType: "LEG", entityId: "leg-defect-orphan", timerState: "PENDING", dueAt: new Date(nowMs - 10000), shardId: "shard-north" },
      { id: "t-3", timerKey: "LEG:leg-south:PLANNED:1:hardening", entityType: "LEG", entityId: "leg-south", timerState: "PENDING", dueAt: new Date(nowMs - 20000), shardId: "shard-south" },
    ],
    outbox: [
      { id: "ob-1", idempotencyKey: "k1", agentId: "agent-n", commandClass: "MISSION", command: "OFFER", state: "CLAIMED", claimExpiresAt: new Date(nowMs - 1000), sequence: 1 },
    ],
  };
}

/**
 * A transfer point that satisfies §19.6's custodian requirement.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function transferPoint(overrides) {
  return {
    id: "tp-1",
    transferPointId: "TP-NORTH-SOUTH",
    name: "Central Depot",
    upstreamRegionId: "region-north",
    downstreamRegionId: "region-south",
    custodianType: "DEPOT",
    custodianId: "DEPOT-42",
    capacity: 20,
    securityProperties: null,
    ...(overrides || {}),
  };
}

module.exports = {
  memoryStore,
  twoShardWorld,
  postFailoverWorld,
  transferPoint,
  matches,
  sortRows,
};

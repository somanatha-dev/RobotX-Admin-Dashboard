"use strict";

/**
 * Fixtures for §9's round loop and solve, and §3.4's intake path.
 *
 * Two things every round test needs:
 *
 *   1. **Priced, branded columns.** `solve/objective.js` and `solve/regime.js` both assert
 *      the feasibility brand (T1, I14), and the brand is a non-enumerable Symbol only
 *      `feasibility/evaluate.js` may apply. So columns here are built on
 *      `costFixture.brandedPlan()`, which brands by running the real gate — the same
 *      discipline `costFixture` established rather than a second, weaker one.
 *
 *   2. **Hand-checkable prices.** `γ` values are round numbers in whole CU, so a reviewer
 *      can verify a min-cost-flow allocation by inspection: with agents priced 10, 20, 30
 *      against two Legs, the optimal assignment is obvious and the test is meaningful.
 */

const costFixture = require("./costFixture");
const { toMilliCU } = require("../../../src/engine/determinism/fixedPoint");

/** A branded plan, shared by every column — the round's shape, not its physics. */
function brandedPlan(overrides) {
  return costFixture.brandedPlan(overrides);
}

/**
 * One priced column, in the shape `plan/columnBuilder.build()` emits.
 *
 * @param {object} input `{ legId, agentId, gammaCu, identity }`
 * @returns {object}
 */
function column(input) {
  const source = input || {};
  const legIds = source.legIds ? [...source.legIds] : [String(source.legId)];
  const identity = source.identity || `${source.agentId}|${legIds.join(",")}|`;
  const plan = source.plan || brandedPlan();
  return {
    identity,
    agentId: String(source.agentId),
    legIds,
    singleton: legIds.length === 1,
    gammaMilliCU: typeof source.gammaMilliCU === "bigint" ? source.gammaMilliCU : toMilliCU(source.gammaCu ?? 0),
    breakdown: null,
    omittedTerms: [],
    plan,
    column: { identity, agentId: String(source.agentId), legIds, plan, singleton: legIds.length === 1 },
  };
}

/**
 * A batch of Legs, in the shape `solve/objective.buildInstance()` expects.
 *
 * @param {string[]} legIds
 * @param {object} [options] `{ deferralAdmissible, deferCu }`
 * @returns {object[]}
 */
function legs(legIds, options) {
  const settings = options || {};
  return legIds.map((legId) => ({
    legId,
    deferralAdmissible: settings.deferralAdmissible === true,
    deferPriceMilliCU: settings.deferralAdmissible === true ? toMilliCU(settings.deferCu ?? 100) : null,
  }));
}

/** The cadence configuration, at the specification's own defaults (§9.2, §9.4). */
function cadenceConfig(overrides) {
  return {
    windowMinMs: 500,
    windowMaxMs: 3000,
    saturatedWindowMs: 10000,
    batchGrowthThreshold: 10,
    fastPathClasses: ["critical"],
    maxLegsPerRound: 500,
    maxWindowSlaFraction: 0.05,
    ...(overrides || {}),
  };
}

/** The §9.4 budget configuration, at the specification's own defaults. */
function budgetConfig(overrides) {
  return {
    maxLegsPerRound: 500,
    maxEvaluatedPerLeg: 200,
    maxColumnsPerRound: 2000,
    branchNodeBudget: 5000,
    timeBudgetMs: 250,
    ...(overrides || {}),
  };
}

/**
 * An in-memory `prisma` double covering exactly the tables intake and the coordinator
 * touch. Deliberately not a general mock: a fake that answered every query would let a
 * test pass against a call the real client would reject.
 *
 * @returns {object}
 */
function memoryPrisma() {
  const workQueue = [];
  // PHASE 13 — §3.5's `Shard` table, which the request path reads to route a Leg.
  const shards = [];
  const rounds = [];
  const decisionRecords = [];
  // PHASE 11 — §21's four tables.
  const tierBRecords = [];
  const snapshots = [];
  const calibrationObservations = [];
  const auditEvents = [];
  // PHASE 12 — §18.5's mode events, §26's status rows, §18.6's chain, and the Legs the
  // stranding SLIs group over.
  const degradedModeEvents = [];
  const invariantStatuses = [];
  const externalEscalations = [];
  const legRows = [];
  let sequence = 0;

  /**
   * `to-one` relations this double can resolve, as `table.field → resolver`.
   *
   * `DecisionRecordB` has no `shadowLabel` column of its own — §21.6's marker lives on
   * the `DecisionRecordA` it points at — so the production filter on a Tier B query is
   * necessarily a *relation* condition (`decision: { shadowLabel: null }`). A double that
   * could not resolve one would silently treat that filter as a plain column comparison
   * against `undefined` and match nothing, which would let a broken query and a correct
   * one produce the same answer here. That is the failure this fixture exists to refuse.
   */
  const RELATIONS = {
    tierBRecords: {
      decision: (row) => decisionRecords.find((entry) => entry.decisionId === row.decisionId) || null,
    },
  };

  const matches = (row, where, relations) => {
    for (const [key, condition] of Object.entries(where || {})) {
      if (key === "OR") {
        if (!condition.some((clause) => matches(row, clause, relations))) return false;
        continue;
      }
      if (key === "NOT") {
        if (matches(row, condition, relations)) return false;
        continue;
      }
      if (relations && Object.prototype.hasOwnProperty.call(relations, key)) {
        const related = relations[key](row);
        // Prisma's to-one relation filter does not match when the relation is absent.
        if (related === null || !matches(related, condition)) return false;
        continue;
      }
      const value = row[key];
      if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
        if ("lt" in condition && !(value !== null && value < condition.lt)) return false;
        if ("lte" in condition && !(value !== null && value <= condition.lte)) return false;
        if ("gt" in condition && !(value !== null && value > condition.gt)) return false;
        if ("in" in condition && !condition.in.includes(value)) return false;
        continue;
      }
      if (value !== condition) return false;
    }
    return true;
  };

  const sortRows = (rows, orderBy) => {
    const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return [...rows].sort((a, b) => {
      for (const clause of clauses) {
        const [key, direction] = Object.entries(clause)[0];
        if (a[key] === b[key]) continue;
        const less = a[key] < b[key] ? -1 : 1;
        return direction === "desc" ? -less : less;
      }
      return 0;
    });
  };

  return {
    __tables: {
      workQueue, rounds, decisionRecords, tierBRecords, snapshots, calibrationObservations, auditEvents,
      degradedModeEvents, invariantStatuses, externalEscalations, legRows, shards,
    },
    // §3.5's published estate. `intake.resolveShardFor` reads it on the request path, so a
    // double without it turns intake's own routing into a TypeError a handler swallows.
    // Empty by default, which is the single-shard deployment every existing test assumes;
    // a test that wants multi-shard routing pushes rows into `__tables.shards`.
    shard: {
      async findMany({ where, orderBy } = {}) {
        return sortRows(shards.filter((row) => matches(row, where)), orderBy).map((row) => ({ ...row }));
      },
    },
    workQueue: {
      // Every read returns a COPY, exactly as a real Prisma client does. A double that
      // handed back live references would let a caller mutate the store by accident and,
      // worse, would let an optimistic-concurrency test pass against a version the real
      // client would never have shown it.
      async findUnique({ where }) {
        const row = workQueue.find((entry) => matches(entry, where));
        return row ? { ...row } : null;
      },
      async findFirst({ where } = {}) {
        const row = workQueue.find((entry) => matches(entry, where));
        return row ? { ...row } : null;
      },
      async findMany({ where, orderBy, take } = {}) {
        const rows = sortRows(workQueue.filter((row) => matches(row, where)), orderBy).map((row) => ({ ...row }));
        return take === undefined ? rows : rows.slice(0, take);
      },
      async count({ where } = {}) {
        return workQueue.filter((row) => matches(row, where)).length;
      },
      async create({ data }) {
        if (workQueue.some((row) => row.idempotencyKey === data.idempotencyKey)) {
          const error = new Error("Unique constraint failed on the fields: (`idempotencyKey`)");
          error.code = "P2002";
          throw error;
        }
        sequence += 1;
        const row = {
          id: `wq-${sequence}`,
          priority: 0,
          state: "QUEUED",
          availableAt: null,
          claimedByRoundId: null,
          claimedAt: null,
          roundsConsidered: 0,
          consecutiveDeferrals: 0,
          firstDeferredAt: null,
          predictedWindow: null,
          version: 0,
          settledAt: null,
          enqueuedAt: new Date(),
          ...data,
        };
        workQueue.push(row);
        return { ...row };
      },
      async update({ where, data }) {
        const row = workQueue.find((entry) => matches(entry, where));
        if (!row) throw new Error("record not found");
        Object.assign(row, data);
        return { ...row };
      },
      async updateMany({ where, data }) {
        const rows = workQueue.filter((entry) => matches(entry, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
    round: {
      async create({ data }) {
        rounds.push({ ...data });
        return { ...data };
      },
      async findMany({ where, orderBy, take } = {}) {
        const rows = sortRows(rounds.filter((row) => matches(row, where)), orderBy).map((row) => ({ ...row }));
        return take === undefined ? rows : rows.slice(0, take);
      },
      async groupBy({ by, where }) {
        const groups = new Map();
        for (const row of rounds.filter((entry) => matches(entry, where))) {
          const key = by.map((field) => row[field]).join("|");
          if (!groups.has(key)) groups.set(key, { row, count: 0 });
          groups.get(key).count += 1;
        }
        return [...groups.values()].map(({ row, count }) => ({
          ...Object.fromEntries(by.map((field) => [field, row[field]])),
          _count: { _all: count },
        }));
      },
    },
    decisionRecordA: {
      async create({ data }) {
        decisionRecords.push({ ...data });
        return { ...data };
      },
      async findUnique({ where } = {}) {
        const row = decisionRecords.find((entry) => matches(entry, where));
        return row ? { ...row } : null;
      },
      async findFirst({ where } = {}) {
        const row = decisionRecords.find((entry) => matches(entry, where));
        return row ? { ...row } : null;
      },
      async findMany({ where } = {}) {
        return decisionRecords.filter((row) => matches(row, where)).map((row) => ({ ...row }));
      },
      async count({ where } = {}) {
        return decisionRecords.filter((row) => matches(row, where)).length;
      },
      async updateMany({ where, data }) {
        const rows = decisionRecords.filter((entry) => matches(entry, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
    // PHASE 11 — §21.2's Tier B and the pinned inputs replay consumes.
    decisionRecordB: {
      async create({ data }) {
        tierBRecords.push({ ...data });
        return { ...data };
      },
      async findMany({ where } = {}) {
        return tierBRecords.filter((row) => matches(row, where, RELATIONS.tierBRecords)).map((row) => ({ ...row }));
      },
      async deleteMany({ where } = {}) {
        const keep = tierBRecords.filter((row) => !matches(row, where, RELATIONS.tierBRecords));
        const removed = tierBRecords.length - keep.length;
        tierBRecords.length = 0;
        tierBRecords.push(...keep);
        return { count: removed };
      },
      async groupBy({ by, where }) {
        const rows = tierBRecords.filter((row) => matches(row, where, RELATIONS.tierBRecords));
        const groups = new Map();
        for (const row of rows) {
          const key = by.map((field) => row[field]).join("|");
          if (!groups.has(key)) groups.set(key, { row, count: 0 });
          groups.get(key).count += 1;
        }
        return [...groups.values()].map(({ row, count }) => ({
          ...Object.fromEntries(by.map((field) => [field, row[field]])),
          _count: { _all: count },
        }));
      },
    },
    inputSnapshot: {
      // §21.2 — immutable. The upsert's `update` is empty by design, so an existing
      // snapshot is never rewritten; this double reproduces that rather than assigning,
      // or a test could pass against a write the real schema's intent forbids.
      async upsert({ where, create }) {
        const existing = snapshots.find((row) => matches(row, where));
        if (existing) return { ...existing };
        sequence += 1;
        const row = { id: `snap-${sequence}`, capturedAt: new Date(), ...create };
        snapshots.push(row);
        return { ...row };
      },
      async findFirst({ where } = {}) {
        const row = snapshots.find((entry) => matches(entry, where));
        return row ? { ...row } : null;
      },
      async findMany({ where } = {}) {
        return snapshots.filter((row) => matches(row, where)).map((row) => ({ ...row }));
      },
    },
    calibrationObservation: {
      async create({ data }) {
        calibrationObservations.push({ ...data });
        return { ...data };
      },
      async createMany({ data }) {
        for (const row of data) calibrationObservations.push({ ...row });
        return { count: data.length };
      },
      async findMany({ where } = {}) {
        return calibrationObservations.filter((row) => matches(row, where)).map((row) => ({ ...row }));
      },
    },
    auditEvent: {
      async create({ data }) {
        if (auditEvents.some((row) => row.streamId === data.streamId && String(row.sequence) === String(data.sequence))) {
          const error = new Error("Unique constraint failed on the fields: (`streamId`,`sequence`)");
          error.code = "P2002";
          throw error;
        }
        auditEvents.push({ ...data });
        return { ...data };
      },
      async findFirst({ where, orderBy } = {}) {
        const rows = sortRows(auditEvents.filter((row) => matches(row, where)), orderBy);
        return rows.length > 0 ? { ...rows[0] } : null;
      },
      async findMany({ where, orderBy, take } = {}) {
        const rows = sortRows(auditEvents.filter((row) => matches(row, where)), orderBy).map((row) => ({ ...row }));
        return take === undefined ? rows : rows.slice(0, take);
      },
    },
    reconcilerRepair: {
      async groupBy() {
        return [];
      },
    },
    // PHASE 12 — the three tables §18.5's mode SLI, §26.1's violation SLI and §4.3's
    // stranding SLIs are derived from. Backed by real arrays rather than by `return []` stubs:
    // a metric derived from a table the double cannot represent fails as "the derivation query
    // failed", which reads identically to a metric nobody wired — the exact confusion the
    // producer-landed classification exists to prevent.
    degradedModeEvent: {
      async create({ data }) {
        degradedModeEvents.push({ ...data });
        return { ...data };
      },
      async findMany({ where, orderBy, take } = {}) {
        const rows = sortRows(degradedModeEvents.filter((row) => matches(row, where)), orderBy).map((row) => ({ ...row }));
        return take === undefined ? rows : rows.slice(0, take);
      },
    },
    invariantStatus: {
      async upsert({ where, create, update }) {
        const key = where.invariantId_shardId_subjectId || where;
        const row = invariantStatuses.find((entry) => matches(entry, key));
        if (row) {
          Object.assign(row, update);
          return { ...row };
        }
        const created = { ...key, ...create };
        invariantStatuses.push(created);
        return { ...created };
      },
      async findMany({ where } = {}) {
        return invariantStatuses.filter((row) => matches(row, where)).map((row) => ({ ...row }));
      },
    },
    externalEscalation: {
      async create({ data }) {
        externalEscalations.push({ ...data });
        return { ...data };
      },
      async findMany({ where, orderBy } = {}) {
        return sortRows(externalEscalations.filter((row) => matches(row, where)), orderBy).map((row) => ({ ...row }));
      },
    },
    leg: {
      async groupBy({ by, where }) {
        const groups = new Map();
        for (const row of legRows.filter((entry) => matches(entry, where))) {
          const key = by.map((field) => row[field]).join("|");
          if (!groups.has(key)) groups.set(key, { row, count: 0 });
          groups.get(key).count += 1;
        }
        return [...groups.values()].map(({ row, count }) => ({
          ...Object.fromEntries(by.map((field) => [field, row[field]])),
          _count: { _all: count },
        }));
      },
      async findMany({ where } = {}) {
        return legRows.filter((row) => matches(row, where)).map((row) => ({ ...row }));
      },
    },
    rejectionAggregate: {
      async groupBy() {
        return [];
      },
    },
    outbox: {
      async count() {
        return 0;
      },
      async findFirst() {
        return null;
      },
    },
    commitment: {
      async count() {
        return 0;
      },
    },
  };
}

module.exports = {
  brandedPlan,
  column,
  legs,
  cadenceConfig,
  budgetConfig,
  memoryPrisma,
};

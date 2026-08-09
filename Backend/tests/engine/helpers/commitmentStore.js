"use strict";

/**
 * A Commitment Store model with the semantics the commit transaction depends on.
 *
 * The commit path's correctness rests on properties a `jest.fn()` cannot express:
 * exclusive row locks that actually block, a transaction whose writes land
 * atomically or not at all, and two schema backstops that reject a write **even when
 * the application logic that should have prevented it is defective**. A mock that
 * returns canned values would let every one of those properties pass vacuously.
 *
 * This store therefore models:
 *
 *   - `SELECT … FOR UPDATE` as a real mutex with a FIFO wait queue, so a second
 *     transaction genuinely blocks on the first;
 *   - `FOR SHARE` as a shared lock that conflicts with `FOR UPDATE` only;
 *   - transaction-local write overlays applied atomically at commit and discarded on
 *     abort, so a guard failure leaves nothing behind;
 *   - the `Commitment_kind_hard_only` CHECK (invariant I18);
 *   - the `Commitment_agent_capacity_slot_active_key` **partial unique index**,
 *     evaluated against globally committed state at apply time — which is what makes
 *     it a backstop rather than a second copy of the guard;
 *   - the `Commitment_capacity_slot_in_bounds` trigger against
 *     `COALESCE(Agent.capacityOverride, 1)`;
 *   - a store clock the test advances, since §10.6 makes the store's clock the sole
 *     authority for lease validity.
 *
 * **What it is not.** It is not PostgreSQL. It does not implement predicate locking,
 * so it models the specification's `REPEATABLE READ + FOR UPDATE` leg rather than
 * true `SERIALIZABLE`; the production path requests both. Every claim this store
 * supports is stated in the Phase 3 report as evidence from a model, not from a
 * database.
 */

/** Rows a caller may seed and the store may hold. */
const TABLES = Object.freeze([
  "agent",
  "leg",
  "commitment",
  "shardLeadership",
  "agentFenceAudit",
  // PHASE 4 — §11.1's outbox and §11.5's reported dedup high-water mark, with the
  // four CHECK constraints the Phase 4 migration adds evaluated at apply time in the
  // same way Phase 3's backstops are.
  "outbox",
  "agentDedupState",
  "observation",
  // PHASE 5 — §4.5's durable timer store, §12.4's repair ledger, §12.5's evidence, and
  // the Task the §4.2 machine writes. The four CHECK constraints the Phase 5 migration
  // adds are evaluated at apply time in the same way Phases 3 and 4's are.
  "timer",
  "reconcilerRepair",
  "verificationEvidence",
  "task",
  "stop",
  // PHASE 13 — §3.5's shard model and its transactional membership handoff. The four
  // CHECK constraints and the partial unique index the Phase 13 migration adds are
  // evaluated at apply time in the same way Phases 3, 4 and 5's are, so a migration that
  // writes two current memberships for one agent fails here exactly as it would at the
  // database.
  //
  // `mission` and `workQueue` come with them, unconstrained: §19.5's failover scopes a
  // shard's Legs by the `WorkQueue` row that records the routing decision intake made, and
  // by the mission's region where none survives.
  "shard",
  "shardMembership",
  "mission",
  "workQueue",
]);

const TABLE_OF_SQL_NAME = Object.freeze({
  Agent: "agent",
  Leg: "leg",
  Commitment: "commitment",
  ShardLeadership: "shardLeadership",
  AgentFenceAudit: "agentFenceAudit",
  Outbox: "outbox",
  AgentDedupState: "agentDedupState",
  Observation: "observation",
  Timer: "timer",
  ReconcilerRepair: "reconcilerRepair",
  VerificationEvidence: "verificationEvidence",
  Task: "task",
  Stop: "stop",
  Shard: "shard",
  ShardMembership: "shardMembership",
  Mission: "mission",
  WorkQueue: "workQueue",
});

function clone(row) {
  if (row === null || row === undefined) return row;
  const copy = {};
  for (const [key, value] of Object.entries(row)) {
    copy[key] = value instanceof Date ? new Date(value.getTime()) : value;
  }
  return copy;
}

/**
 * @param {object} [seed]
 * @returns {object} the store
 */
function createCommitmentStore(seed) {
  const committed = Object.fromEntries(TABLES.map((table) => [table, new Map()]));
  const settings = seed || {};

  for (const table of TABLES) {
    for (const row of settings[table] || []) {
      committed[table].set(row.id, clone(row));
    }
  }

  let storeTime = settings.now instanceof Date ? new Date(settings.now.getTime()) : new Date("2026-07-29T12:00:00.000Z");
  let nextTxId = 1;

  /** lockKey → { exclusive: txId|null, shared: Set<txId>, queue: [] } */
  const locks = new Map();

  const stats = { commits: 0, rollbacks: 0, lockWaits: 0, uniqueViolations: 0, triggerViolations: 0 };

  function lockEntry(key) {
    if (!locks.has(key)) locks.set(key, { exclusive: null, shared: new Set(), queue: [] });
    return locks.get(key);
  }

  function canTake(entry, txId, mode) {
    if (entry.exclusive !== null && entry.exclusive !== txId) return false;
    if (mode === "exclusive") {
      return [...entry.shared].every((holder) => holder === txId);
    }
    return true;
  }

  async function acquire(key, txId, mode) {
    const entry = lockEntry(key);
    if (!canTake(entry, txId, mode)) {
      stats.lockWaits += 1;
      await new Promise((resolve) => entry.queue.push({ txId, mode, resolve }));
    }
    if (mode === "exclusive") entry.exclusive = txId;
    else entry.shared.add(txId);
  }

  function releaseAll(txId) {
    for (const entry of locks.values()) {
      if (entry.exclusive === txId) entry.exclusive = null;
      entry.shared.delete(txId);
      while (entry.queue.length > 0 && canTake(entry, entry.queue[0].txId, entry.queue[0].mode)) {
        const waiter = entry.queue.shift();
        if (waiter.mode === "exclusive") entry.exclusive = waiter.txId;
        else entry.shared.add(waiter.txId);
        waiter.resolve();
      }
    }
  }

  /* ── Schema backstops, exactly as the migration writes them ──────────────── */

  function assertHardOnly(row) {
    if (String(row.kind) !== "HARD") {
      const error = new Error(
        `new row for relation "Commitment" violates check constraint "Commitment_kind_hard_only"`,
      );
      error.code = "23514";
      throw error;
    }
  }

  function assertCapacitySlotInBounds(row, view) {
    if (row.releasedAt !== null && row.releasedAt !== undefined) return;
    const agent = view.agent.get(row.agentId);
    if (!agent) {
      throw new Error(`Commitment ${row.commitmentId} names agent ${row.agentId} which does not exist (§10.3.2).`);
    }
    const capacity = agent.capacityOverride === null || agent.capacityOverride === undefined ? 1 : agent.capacityOverride;
    if (row.capacitySlot >= capacity) {
      stats.triggerViolations += 1;
      throw new Error(
        `Commitment ${row.commitmentId} would occupy capacity slot ${row.capacitySlot} on agent ` +
          `${row.agentId}, whose durable capacity is ${capacity} (§10.3.2, invariant I1).`,
      );
    }
  }

  function assertPartialUniqueIndex(row, view) {
    if (row.releasedAt !== null && row.releasedAt !== undefined) return;
    for (const other of view.commitment.values()) {
      if (other.id === row.id) continue;
      if (other.releasedAt !== null && other.releasedAt !== undefined) continue;
      if (other.agentId === row.agentId && other.capacitySlot === row.capacitySlot) {
        stats.uniqueViolations += 1;
        const error = new Error(
          'duplicate key value violates unique constraint "Commitment_agent_capacity_slot_active_key"',
        );
        error.code = "23505";
        throw error;
      }
    }
  }

  function assertUniqueCommitmentId(row, view) {
    for (const other of view.commitment.values()) {
      if (other.id !== row.id && other.commitmentId === row.commitmentId) {
        const error = new Error('duplicate key value violates unique constraint "Commitment_commitmentId_key"');
        error.code = "23505";
        throw error;
      }
    }
  }

  /* ── Phase 4's backstops, exactly as its migration writes them ────────────── */

  const OUTBOX_STATES = ["PENDING", "CLAIMED", "DELIVERED", "ACKED", "UNACKNOWLEDGED", "EXPIRED", "SUPPRESSED", "FAILED"];

  function assertOutboxConstraints(row, view) {
    // Outbox_command_class_known
    if (!["MISSION", "AGENT"].includes(row.commandClass)) {
      throw checkViolation("Outbox_command_class_known", row.commandClass);
    }

    // Outbox_fence_scope_columns — a row carries the columns its own scope requires,
    // and not the other scope's.
    const isMission =
      row.fenceScope === "COMMITMENT" &&
      row.commandClass === "MISSION" &&
      row.commitmentId !== null &&
      row.commitmentId !== undefined &&
      row.fence !== null &&
      row.fence !== undefined &&
      (row.authorityEpoch === null || row.authorityEpoch === undefined) &&
      (row.fenceFloor === null || row.fenceFloor === undefined);
    const isAgent =
      row.fenceScope === "AGENT" &&
      row.commandClass === "AGENT" &&
      (row.commitmentId === null || row.commitmentId === undefined) &&
      (row.fence === null || row.fence === undefined) &&
      row.authorityEpoch !== null &&
      row.authorityEpoch !== undefined &&
      row.fenceFloor !== null &&
      row.fenceFloor !== undefined;
    if (!isMission && !isAgent) {
      throw checkViolation("Outbox_fence_scope_columns", `${row.fenceScope}/${row.commandClass}`);
    }

    // Outbox_sequence_non_negative
    if (!Number.isInteger(row.sequence) || row.sequence < 0) {
      throw checkViolation("Outbox_sequence_non_negative", row.sequence);
    }

    // Outbox_state_known
    if (!OUTBOX_STATES.includes(row.state)) {
      throw checkViolation("Outbox_state_known", row.state);
    }

    // Outbox_idempotencyKey_key — the unique index that makes §10.5's two namespaces
    // enforceable rather than conventional.
    for (const other of view.outbox.values()) {
      if (other.id !== row.id && other.idempotencyKey === row.idempotencyKey) {
        const error = new Error('duplicate key value violates unique constraint "Outbox_idempotencyKey_key"');
        error.code = "23505";
        throw error;
      }
    }

    // Outbox_commitmentId_fkey
    if (row.commitmentId !== null && row.commitmentId !== undefined) {
      const referenced = [...view.commitment.values()].some((c) => c.commitmentId === row.commitmentId);
      if (!referenced) {
        const error = new Error(
          'insert or update on table "Outbox" violates foreign key constraint "Outbox_commitmentId_fkey"',
        );
        error.code = "23503";
        throw error;
      }
    }
  }

  function assertDedupStateConstraints(row) {
    for (const field of ["dedupStateGeneration", "authorityEpoch", "fenceFloor"]) {
      if (BigInt(row[field] === undefined || row[field] === null ? 0 : row[field]) < BigInt(0)) {
        throw checkViolation("AgentDedupState_counters_non_negative", `${field}=${row[field]}`);
      }
    }
  }

  /* ── Phase 5's backstops, exactly as its migration writes them ────────────── */

  const TIMER_ENTITY_TYPES = ["LEG", "TASK", "COMMITMENT"];
  const TIMER_STATES = ["PENDING", "FIRED", "CANCELLED", "DISCARDED"];
  const REPAIR_CATEGORIES = [
    "COMMITMENT_UNKNOWN_TO_AGENT",
    "AGENT_REPORTS_UNKNOWN_COMMITMENT",
    "ORPHAN_LEG",
    "COMMITMENT_ON_TERMINAL_LEG",
    "LEASE_EXPIRED_UNPROCESSED",
    "CUSTODY_HELD_WITHOUT_MISSION",
    "TASK_WAITING_BEYOND_SLA",
    "OUTBOX_UNDELIVERED_PAST_DEADLINE",
    "AGENT_ABSENT_FROM_AVAILABILITY_INDEX",
    "ENERGY_ACCOUNTING_INCONSISTENT",
  ];
  const VERIFICATION_LEVELS = ["L0", "L1", "L2", "L3"];
  const VERIFICATION_OUTCOMES = ["SUFFICIENT", "INSUFFICIENT"];

  function assertTimerConstraints(row, view) {
    if (!TIMER_ENTITY_TYPES.includes(row.entityType)) {
      throw checkViolation("Timer_entity_type_known", row.entityType);
    }
    if (!TIMER_STATES.includes(row.timerState)) {
      throw checkViolation("Timer_state_known", row.timerState);
    }
    if (BigInt(row.entityVersion === undefined || row.entityVersion === null ? -1 : row.entityVersion) < BigInt(0)) {
      throw checkViolation("Timer_entity_version_non_negative", row.entityVersion);
    }
    if (!Number.isInteger(row.attempts === undefined ? 0 : row.attempts) || (row.attempts || 0) < 0) {
      throw checkViolation("Timer_attempts_non_negative", row.attempts);
    }
    // Timer_timerKey_key — the unique index that makes §4.5's "one deadline, one timer"
    // enforceable rather than conventional.
    for (const other of view.timer.values()) {
      if (other.id !== row.id && other.timerKey === row.timerKey) {
        const error = new Error('duplicate key value violates unique constraint "Timer_timerKey_key"');
        error.code = "23505";
        throw error;
      }
    }
  }

  function assertRepairConstraints(row) {
    if (!REPAIR_CATEGORIES.includes(row.category)) {
      throw checkViolation("ReconcilerRepair_category_known", row.category);
    }
  }

  function assertVerificationConstraints(row) {
    if (!VERIFICATION_LEVELS.includes(row.requiredLevel) || !VERIFICATION_LEVELS.includes(row.achievedLevel)) {
      throw checkViolation("VerificationEvidence_levels_known", `${row.requiredLevel}/${row.achievedLevel}`);
    }
    if (!VERIFICATION_OUTCOMES.includes(row.outcome)) {
      throw checkViolation("VerificationEvidence_outcome_known", row.outcome);
    }
  }

  function checkViolation(constraint, value) {
    const error = new Error(
      `new row violates check constraint "${constraint}" (offending value: ${String(value)})`,
    );
    error.code = "23514";
    return error;
  }

  /* ── Phase 13's backstops, exactly as its migration writes them ──────────── */

  const SHARD_STATES = ["ACTIVE", "REBALANCING", "DRAINING", "RETIRED"];
  const BINDING_BOUNDS = ["ROUND_WALL_CLOCK", "SERIAL_COMMIT", "NEITHER_EVALUATED"];
  const MEMBERSHIP_REASONS = ["COMMISSIONING", "REBALANCE_SPLIT", "REBALANCE_MERGE", "REDISTRICTING", "OPERATOR"];

  function assertShardConstraints(row) {
    if (row.state !== undefined && !SHARD_STATES.includes(String(row.state))) {
      throw checkViolation("Shard", "Shard_state_known", row.state);
    }
    if (row.bindingBound !== undefined && row.bindingBound !== null && !BINDING_BOUNDS.includes(String(row.bindingBound))) {
      throw checkViolation("Shard", "Shard_binding_bound_known", row.bindingBound);
    }
    if (typeof row.agentCount === "number" && row.agentCount < 0) {
      throw checkViolation("Shard", "Shard_agent_count_non_negative", row.agentCount);
    }
    const draining = String(row.state) === "DRAINING";
    const timed = row.drainingSince !== null && row.drainingSince !== undefined;
    if (row.state !== undefined && draining !== timed) {
      throw checkViolation("Shard", "Shard_draining_is_timed", row.state);
    }
  }

  function assertMembershipConstraints(row, view) {
    if (!MEMBERSHIP_REASONS.includes(String(row.reason))) {
      throw checkViolation("ShardMembership", "ShardMembership_reason_known", row.reason);
    }
    const before = BigInt(row.authorityEpochBefore ?? 0);
    const after = BigInt(row.authorityEpochAfter ?? 0);
    if (before < 0n || after < 0n) {
      throw checkViolation("ShardMembership", "ShardMembership_epochs_non_negative", `${before}/${after}`);
    }
    const from = row.fromShardId === undefined ? null : row.fromShardId;
    if (from !== null && after <= before) {
      // §19.2 — a migration that did not advance the epoch would leave every mission
      // authority the agent holds valid under the *old* shard's coordinator.
      throw checkViolation("ShardMembership", "ShardMembership_migration_advances_epoch", `${before}->${after}`);
    }
    if (from !== null && from === row.shardId) {
      throw checkViolation("ShardMembership", "ShardMembership_move_changes_shard", from);
    }
    // The partial unique index: §3.5's "exactly one shard at a time".
    if ((row.supersededAt ?? null) === null) {
      for (const other of view.shardMembership.values()) {
        if (other.id === row.id) continue;
        if ((other.supersededAt ?? null) !== null) continue;
        if (other.agentId === row.agentId) {
          stats.uniqueViolations += 1;
          const error = new Error('duplicate key value violates unique constraint "ShardMembership_one_current_per_agent"');
          error.code = "23505";
          throw error;
        }
      }
    }
  }

  /**
   * Apply a transaction's overlay to committed state, re-checking every backstop
   * against the *global* view. This is the property that makes the index a backstop:
   * a transaction that never took the agent lock still fails here.
   */
  function applyOverlay(overlay) {
    const view = Object.fromEntries(TABLES.map((table) => [table, new Map(committed[table])]));

    for (const table of TABLES) {
      for (const [id, row] of overlay[table]) {
        if (row === null) view[table].delete(id);
        else view[table].set(id, row);
      }
    }

    for (const [id, row] of overlay.commitment) {
      if (row === null) continue;
      assertHardOnly(row);
      assertUniqueCommitmentId(row, view);
      assertCapacitySlotInBounds(row, view);
      assertPartialUniqueIndex(row, view);
      void id;
    }

    for (const [, row] of overlay.outbox) {
      if (row === null) continue;
      assertOutboxConstraints(row, view);
    }

    for (const [, row] of overlay.agentDedupState) {
      if (row === null) continue;
      assertDedupStateConstraints(row);
    }

    for (const [, row] of overlay.timer) {
      if (row === null) continue;
      assertTimerConstraints(row, view);
    }

    for (const [, row] of overlay.reconcilerRepair) {
      if (row === null) continue;
      assertRepairConstraints(row);
    }

    for (const [, row] of overlay.verificationEvidence) {
      if (row === null) continue;
      assertVerificationConstraints(row);
    }

    for (const [, row] of overlay.shard) {
      if (row === null) continue;
      assertShardConstraints(row);
    }

    for (const [, row] of overlay.shardMembership) {
      if (row === null) continue;
      assertMembershipConstraints(row, view);
    }

    for (const table of TABLES) {
      for (const [id, row] of overlay[table]) {
        if (row === null) committed[table].delete(id);
        else committed[table].set(id, row);
      }
    }
  }

  /* ── The transaction client ──────────────────────────────────────────────── */

  function createTx(txId) {
    const overlay = Object.fromEntries(TABLES.map((table) => [table, new Map()]));

    const read = (table, id) => {
      if (overlay[table].has(id)) return clone(overlay[table].get(id));
      const row = committed[table].get(id);
      return row ? clone(row) : null;
    };

    const rows = (table) => {
      const merged = new Map(committed[table]);
      for (const [id, row] of overlay[table]) {
        if (row === null) merged.delete(id);
        else merged.set(id, row);
      }
      return [...merged.values()].map(clone);
    };

    // Prisma's filter subset the Phase 4 modules actually use. Written out rather
    // than stubbed, because `claim`'s correctness is a claim about a *conditional*
    // write — `state = PENDING`, or `CLAIMED` with an expired lease — and a matcher
    // that ignored the operators would let that condition pass vacuously.
    const compare = (actual, operator) => {
      if (operator === null) return actual === null || actual === undefined;
      if (operator === undefined) return true;
      if (operator instanceof Date || typeof operator !== "object") {
        if (operator instanceof Date) return actual instanceof Date && actual.getTime() === operator.getTime();
        return actual === operator;
      }
      return Object.entries(operator).every(([op, bound]) => {
        const left = actual instanceof Date ? actual.getTime() : actual;
        const right = bound instanceof Date ? bound.getTime() : bound;
        switch (op) {
          case "in":
            return bound.includes(actual);
          case "notIn":
            return !bound.includes(actual);
          case "lt":
            return left !== null && left !== undefined && left < right;
          case "lte":
            return left !== null && left !== undefined && left <= right;
          case "gt":
            return left !== null && left !== undefined && left > right;
          case "gte":
            return left !== null && left !== undefined && left >= right;
          case "not":
            return actual !== bound;
          case "equals":
            return left === right;
          default:
            throw new Error(`the store model does not implement filter operator "${op}"`);
        }
      });
    };

    const matches = (row, where) =>
      Object.entries(where || {}).every(([key, value]) => {
        if (key === "OR") return value.some((clause) => matches(row, clause));
        if (key === "AND") return value.every((clause) => matches(row, clause));
        if (key === "NOT") return !matches(row, value);
        return compare(row[key], value);
      });

    // `{ increment: n }` and friends — the atomic update shapes `recordAttempt` uses.
    const applyData = (existing, data) => {
      const next = { ...existing };
      for (const [key, value] of Object.entries(data || {})) {
        if (value !== null && typeof value === "object" && !(value instanceof Date) && "increment" in value) {
          next[key] = (existing[key] || 0) + value.increment;
        } else if (value !== null && typeof value === "object" && !(value instanceof Date) && "decrement" in value) {
          // PHASE 13 — the membership handoff moves an `agentCount` off one shard and onto
          // another in one transaction, so the store must model both directions or the
          // decrement would silently write an object into the column.
          next[key] = (existing[key] || 0) - value.decrement;
        } else {
          next[key] = value;
        }
      }
      return next;
    };

    const applyOrdering = (list, orderBy) => {
      const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
      if (clauses.length === 0) return list;
      return [...list].sort((a, b) => {
        for (const clause of clauses) {
          for (const [key, direction] of Object.entries(clause)) {
            const left = a[key] instanceof Date ? a[key].getTime() : a[key];
            const right = b[key] instanceof Date ? b[key].getTime() : b[key];
            if (left === right) continue;
            if (left === null || left === undefined) return 1;
            if (right === null || right === undefined) return -1;
            const sign = left < right ? -1 : 1;
            return direction === "desc" ? -sign : sign;
          }
        }
        return 0;
      });
    };

    const findFirst = (table, where) => rows(table).find((row) => matches(row, where)) || null;

    const modelClient = (table) => ({
      async findUnique({ where }) {
        return findFirst(table, where);
      },
      async findMany({ where, orderBy, take } = {}) {
        const matched = applyOrdering(
          rows(table).filter((row) => matches(row, where)),
          orderBy,
        );
        return typeof take === "number" ? matched.slice(0, take) : matched;
      },
      // PHASE 13 — `membership.currentMembership()` reads the newest un-superseded row,
      // which is `findFirst` with an ordering rather than `findUnique`: the partial unique
      // index makes at most one *current*, and the history holds the rest.
      async findFirst({ where, orderBy } = {}) {
        const matched = applyOrdering(
          rows(table).filter((row) => matches(row, where)),
          orderBy,
        );
        return matched.length > 0 ? matched[0] : null;
      },
      async count({ where } = {}) {
        return rows(table).filter((row) => matches(row, where)).length;
      },
      async create({ data }) {
        const id = data.id || `${table}-${nextRowId(table)}`;
        const row = clone({ ...data, id, createdAt: data.createdAt || new Date(storeTime.getTime()) });
        overlay[table].set(id, row);
        return clone(row);
      },
      async update({ where, data }) {
        const existing = findFirst(table, where);
        if (!existing) throw new Error(`no ${table} row matches ${JSON.stringify(where)}`);
        const row = clone(applyData(existing, data));
        overlay[table].set(existing.id, row);
        return clone(row);
      },
      async updateMany({ where, data }) {
        const targets = rows(table).filter((row) => matches(row, where));
        for (const target of targets) overlay[table].set(target.id, clone(applyData(target, data)));
        return { count: targets.length };
      },
      async upsert({ where, create, update }) {
        const existing = findFirst(table, where);
        if (existing) {
          const row = clone(applyData(existing, update));
          overlay[table].set(existing.id, row);
          return clone(row);
        }
        const id = create.id || `${table}-${create.agentId || create.shardId || nextRowId(table)}`;
        const row = clone({ ...create, id });
        overlay[table].set(id, row);
        return clone(row);
      },
    });

    const tx = {
      __txId: txId,
      __overlay: overlay,
      async $queryRawUnsafe(sql, ...params) {
        if (/SELECT NOW\(\)/i.test(sql)) return [{ now: new Date(storeTime.getTime()) }];

        const forUpdate = /FOR UPDATE\s*$/i.test(sql);
        const forShare = /FOR SHARE\s*$/i.test(sql);
        const match = /FROM "(\w+)" WHERE "(\w+)" = \$1/i.exec(sql);
        if (!match) throw new Error(`the store model does not implement: ${sql}`);

        const table = TABLE_OF_SQL_NAME[match[1]];
        const column = match[2];
        const value = params[0];

        const target = rows(table).find((row) => row[column] === value);
        if (!target) return [];

        if (forUpdate) await acquire(`${table}:${target.id}`, txId, "exclusive");
        else if (forShare) await acquire(`${table}:${target.id}`, txId, "shared");

        const fresh = rows(table).find((row) => row[column] === value);
        return fresh ? [clone(fresh)] : [];
      },
    };

    for (const table of TABLES) tx[table] = modelClient(table);
    return tx;
  }

  // Monotone per table, so a row's generated id is stable under replay and two rows
  // created in one transaction cannot collide the way a size-derived id could.
  const rowCounters = new Map();
  function nextRowId(table) {
    const next = (rowCounters.get(table) || 0) + 1;
    rowCounters.set(table, next);
    return next;
  }

  async function transaction(fn) {
    const txId = nextTxId;
    nextTxId += 1;
    const tx = createTx(txId);
    try {
      const result = await fn(tx);
      applyOverlay(tx.__overlay);
      stats.commits += 1;
      return result;
    } catch (error) {
      stats.rollbacks += 1;
      throw error;
    } finally {
      releaseAll(txId);
    }
  }

  const client = {
    $transaction: (fn) => transaction(fn),
    $queryRawUnsafe: (...args) => transaction((tx) => tx.$queryRawUnsafe(...args)),
  };

  for (const table of TABLES) {
    client[table] = {
      findUnique: ({ where }) => transaction((tx) => tx[table].findUnique({ where })),
      findFirst: (args) => transaction((tx) => tx[table].findFirst(args || {})),
      findMany: (args) => transaction((tx) => tx[table].findMany(args || {})),
      count: (args) => transaction((tx) => tx[table].count(args || {})),
      create: ({ data }) => transaction((tx) => tx[table].create({ data })),
      update: ({ where, data }) => transaction((tx) => tx[table].update({ where, data })),
      // The outbox worker's claim, attempt record, and expiry sweep are all conditional
      // `updateMany`s issued outside a caller-supplied transaction — each is its own
      // atomic statement, which is what makes two workers racing for one row produce a
      // winner and a no-op rather than two winners.
      updateMany: (args) => transaction((tx) => tx[table].updateMany(args)),
      upsert: (args) => transaction((tx) => tx[table].upsert(args)),
    };
  }

  return {
    client,
    stats,
    committed,
    /** Rows as the database holds them, for assertions. */
    rows(table) {
      return [...committed[table].values()].map(clone);
    },
    now() {
      return new Date(storeTime.getTime());
    },
    advanceClock(seconds) {
      storeTime = new Date(storeTime.getTime() + seconds * 1000);
    },
    /**
     * Write a commitment **without** the commit path — the defective-code-path case.
     * The backstops must reject it on their own.
     */
    async insertCommitmentDirectly(row) {
      return transaction(async (tx) => tx.commitment.create({ data: row }));
    },
  };
}

/**
 * A minimal, coherent fixture: one shard, one agent, N Legs.
 *
 * @param {{ capacity?: number, legs?: number }} [options]
 * @returns {object}
 */
function fixture(options) {
  const settings = options || {};
  const capacity = settings.capacity || 1;
  const legCount = settings.legs || 1;

  const legs = [];
  for (let index = 0; index < legCount; index += 1) {
    legs.push({
      id: `leg-${index}`,
      legId: `leg-${index}`,
      missionId: `mission-${index}`,
      sequence: 0,
      purpose: "PRIMARY",
      state: "PLANNED",
      custodyState: "NONE",
      version: 0,
      cancelRequestedAt: null,
      obstructionClass: null,
    });
  }

  return {
    agent: {
      id: "agent-1",
      agentId: "agent-1",
      lifecycleState: "ACTIVE",
      authorityEpoch: 7n,
      fenceCounter: 41n,
      capacityOverride: capacity === 1 ? null : capacity,
    },
    legs,
    leadership: {
      id: "shard-leadership-default",
      shardId: "default",
      leadershipFence: 1n,
      holder: "coordinator-a",
      leaseExpiry: new Date("2026-07-29T12:00:30.000Z"),
    },
    capacity,
  };
}

module.exports = { createCommitmentStore, fixture };

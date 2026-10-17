"use strict";

/**
 * An in-memory store with the slice of Prisma that robot soft retirement reads and writes.
 *
 * Built on `createMockPrisma` so every other model stays a `jest.fn()` and a test can still
 * assert on calls. What it adds over the plain mock is *state* and two transaction
 * properties the retirement path depends on:
 *
 *   · `SELECT … FROM "Agent" … FOR UPDATE` takes a per-agent lock held until the enclosing
 *     `$transaction` callback settles, and the `FOR SHARE` read in `markRobotOnline` waits
 *     for it — a model of PostgreSQL's row lock, enough to order two transactions;
 *   · a transaction whose callback throws restores the state it started from (used only
 *     with one transaction in flight; the real-PostgreSQL harness covers interleaved
 *     rollback).
 *
 * It is a model, not PostgreSQL. `tools/verify/robotRetirementLiveDatabase.js` drives the
 * same service against a real disposable database.
 */

const { createMockPrisma } = require("./mockPrisma");

const clone = (value) =>
  JSON.parse(JSON.stringify(value, (key, v) => (typeof v === "bigint" ? { $big: v.toString() } : v)), (key, v) =>
    v && typeof v === "object" && Object.keys(v).length === 1 && typeof v.$big === "string" ? BigInt(v.$big) : v,
  );

function inList(value, filter) {
  if (filter === undefined) return true;
  if (filter && typeof filter === "object" && Array.isArray(filter.in)) return filter.in.includes(value);
  if (filter && typeof filter === "object" && Array.isArray(filter.notIn)) return !filter.notIn.includes(value);
  return value === filter;
}

/**
 * @param {object} seed `{ robots, agents, commitments, outbox, tasks, reservations, cells, sessions }`
 */
function createRetirementStore(seed) {
  const initial = seed || {};
  const state = {
    robots: (initial.robots || []).map((row) => ({
      socketId: null,
      currentTaskId: null,
      isOnline: false,
      status: "IDLE",
      simulated: false,
      ...row,
    })),
    agents: (initial.agents || []).map((row) => ({
      authorityEpoch: 0n,
      fenceCounter: 0n,
      lifecycleState: "ACTIVE",
      ...row,
      authorityEpoch: BigInt(row.authorityEpoch ?? 0),
      fenceCounter: BigInt(row.fenceCounter ?? 0),
    })),
    commitments: initial.commitments || [],
    outbox: initial.outbox || [],
    tasks: initial.tasks || [],
    reservations: initial.reservations || [],
    cells: initial.cells || [],
    sessions: initial.sessions || [],
    fenceAudits: [],
    events: [],
  };

  const prisma = createMockPrisma();
  const locks = new Map(); // agent row id -> { promise, release }
  let txSeq = 0;

  const agentOf = (robotDbId) => state.agents.find((a) => a.robotDbId === robotDbId) || null;
  const withAgent = (robot) => {
    if (!robot) return null;
    const agent = agentOf(robot.id);
    return { ...robot, agent: agent ? { id: agent.id, lifecycleState: agent.lifecycleState } : null };
  };
  const isRetiredRow = (robot) => agentOf(robot.id)?.lifecycleState === "DECOMMISSIONED";
  const robotMatches = (robot, where = {}) => {
    if (where.robotId !== undefined && robot.robotId !== where.robotId) return false;
    if (where.id !== undefined && robot.id !== where.id) return false;
    if (where.simulated !== undefined && robot.simulated !== where.simulated) return false;
    if (where.NOT?.agent?.is?.lifecycleState === "DECOMMISSIONED" && isRetiredRow(robot)) return false;
    // The positive relation filter (`GET /api/robots/retired`).
    if (where.agent?.is?.lifecycleState !== undefined && agentOf(robot.id)?.lifecycleState !== where.agent.is.lifecycleState) return false;
    return true;
  };

  prisma.robot.findUnique.mockImplementation(async ({ where }) => withAgent(state.robots.find((r) => robotMatches(r, where))));
  prisma.robot.findMany.mockImplementation(async ({ where } = {}) => state.robots.filter((r) => robotMatches(r, where)).map(withAgent));
  prisma.robot.update.mockImplementation(async ({ where, data }) => {
    const row = state.robots.find((r) => robotMatches(r, where));
    if (!row) throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
    Object.assign(row, data);
    return { ...row };
  });
  prisma.robot.delete.mockImplementation(async () => {
    throw new Error("soft retirement must never delete a Robot row");
  });

  prisma.agent.findUnique.mockImplementation(async ({ where }) => {
    const row = state.agents.find((a) => (where.id !== undefined ? a.id === where.id : a.robotDbId === where.robotDbId));
    return row ? { ...row } : null;
  });
  prisma.agent.update.mockImplementation(async ({ where, data }) => {
    const row = state.agents.find((a) => a.id === where.id);
    Object.assign(row, data);
    return { ...row };
  });
  prisma.agent.upsert.mockImplementation(async ({ where, create, update }) => {
    const existing = state.agents.find((a) => a.id === where.id);
    if (existing) {
      Object.assign(existing, update);
      return { ...existing };
    }
    const row = { ...create, authorityEpoch: BigInt(create.authorityEpoch ?? 0), fenceCounter: BigInt(create.fenceCounter ?? 0) };
    state.agents.push(row);
    return { ...row };
  });
  prisma.agent.delete = jest.fn(async () => {
    throw new Error("soft retirement must never delete an Agent row");
  });

  prisma.command = { create: jest.fn(async ({ data }) => ({ id: "cmd-1", status: "SENT", ...data })), findUnique: jest.fn(), update: jest.fn() };

  prisma.agentFenceAudit = {
    upsert: jest.fn(async ({ where, create, update }) => {
      const existing = state.fenceAudits.find((row) => row.agentId === where.agentId);
      if (existing) Object.assign(existing, update);
      else state.fenceAudits.push({ ...create });
    }),
    findUnique: jest.fn(async ({ where }) => {
      const row = state.fenceAudits.find((r) => r.agentId === where.agentId);
      return row ? { ...row } : null;
    }),
    findMany: jest.fn(async ({ where } = {}) =>
      state.fenceAudits.filter((r) => inList(r.agentId, where?.agentId)).map((r) => ({ ...r })),
    ),
  };

  prisma.agentCellPosition.findUnique.mockImplementation(async ({ where }) => {
    const row = state.cells.find((c) => c.agentId === where.agentId);
    return row ? { ...row } : null;
  });
  prisma.agentCellPosition.deleteMany = jest.fn(async ({ where }) => {
    const before = state.cells.length;
    state.cells = state.cells.filter((c) => c.agentId !== where.agentId);
    return { count: before - state.cells.length };
  });

  // `RobotSession`, with the semantics `robotSession.service` relies on (one row per robot).
  const sessionMatches = (row, where = {}) =>
    (where.robotDbId === undefined || row.robotDbId === where.robotDbId) &&
    (where.tokenHash === undefined || row.tokenHash === where.tokenHash) &&
    (where.expiresAt?.gt === undefined || new Date(row.expiresAt) > where.expiresAt.gt);
  prisma.robotSession.findUnique.mockImplementation(async ({ where }) => {
    const row = state.sessions.find((s) => s.robotDbId === where.robotDbId);
    return row ? { ...row } : null;
  });
  prisma.robotSession.upsert.mockImplementation(async ({ where, create, update }) => {
    const row = state.sessions.find((s) => s.robotDbId === where.robotDbId);
    if (row) Object.assign(row, update);
    else state.sessions.push({ ...create });
  });
  prisma.robotSession.create.mockImplementation(async ({ data }) => {
    if (state.sessions.some((s) => s.robotDbId === data.robotDbId)) {
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    }
    state.sessions.push({ ...data });
  });
  prisma.robotSession.updateMany.mockImplementation(async ({ where, data }) => {
    let count = 0;
    for (const row of state.sessions) {
      if (sessionMatches(row, where)) {
        Object.assign(row, data);
        count += 1;
      }
    }
    return { count };
  });
  prisma.robotSession.deleteMany.mockImplementation(async ({ where }) => {
    const before = state.sessions.length;
    state.sessions = state.sessions.filter((s) => s.robotDbId !== where.robotDbId);
    return { count: before - state.sessions.length };
  });

  prisma.commitment.findMany.mockImplementation(async ({ where }) =>
    state.commitments.filter((c) => c.agentId === where.agentId && (where.releasedAt !== null || !c.releasedAt)),
  );
  prisma.outbox.findMany.mockImplementation(async ({ where }) =>
    state.outbox.filter((o) => o.agentId === where.agentId && inList(o.state, where.state)),
  );
  prisma.task.findMany.mockImplementation(async ({ where }) =>
    state.tasks.filter(
      (t) =>
        (where.OR || []).some((clause) => (clause.robotId !== undefined ? t.robotId === clause.robotId : t.id === clause.id)) &&
        inList(t.status, where.status),
    ),
  );
  prisma.chargerReservation = {
    findMany: jest.fn(async ({ where }) => state.reservations.filter((r) => r.agentId === where.agentId && inList(r.state, where.state))),
  };
  prisma.event.create.mockImplementation(async ({ data }) => {
    state.events.push({ ...data });
    return data;
  });

  // ── Row locks ─────────────────────────────────────────────────────────────
  async function acquire(agentRowId, owner) {
    for (;;) {
      const held = locks.get(agentRowId);
      if (!held || held.owner === owner) break;
      // eslint-disable-next-line no-await-in-loop
      await held.promise;
    }
    if (locks.get(agentRowId)?.owner === owner) return;
    let release;
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    locks.set(agentRowId, { owner, promise, release });
  }

  function makeRaw(owner, held) {
    return jest.fn(async (sql, ...params) => {
      const text = String(sql);
      if (/SELECT NOW\(\)/i.test(text)) return [{ now: new Date() }];
      if (/FROM "Agent" WHERE "id" = \$1 FOR UPDATE/.test(text)) {
        await acquire(params[0], owner);
        held.add(params[0]);
        const row = state.agents.find((a) => a.id === params[0]);
        return row ? [{ ...row }] : [];
      }
      if (/FOR SHARE OF a/.test(text)) {
        const robot = state.robots.find((r) => r.robotId === params[0]);
        const agent = robot ? agentOf(robot.id) : null;
        if (!agent) return [];
        // A share lock waits for an exclusive holder, then reads the committed row.
        const exclusive = locks.get(agent.id);
        if (exclusive && exclusive.owner !== owner) await exclusive.promise;
        return [{ lifecycleState: agentOf(robot.id).lifecycleState }];
      }
      return [];
    });
  }

  prisma.$transaction.mockImplementation(async (fn) => {
    txSeq += 1;
    const owner = `tx-${txSeq}`;
    const held = new Set();
    const snapshot = clone(state);
    const { $transaction, ...base } = prisma;
    const tx = { ...base, $queryRawUnsafe: makeRaw(owner, held) };
    try {
      return await fn(tx);
    } catch (error) {
      Object.assign(state, clone(snapshot));
      throw error;
    } finally {
      for (const id of held) {
        const lock = locks.get(id);
        if (lock && lock.owner === owner) {
          locks.delete(id);
          lock.release();
        }
      }
    }
  });
  prisma.$queryRawUnsafe.mockImplementation(makeRaw("no-tx", new Set()));

  return { prisma, state };
}

module.exports = { createRetirementStore };

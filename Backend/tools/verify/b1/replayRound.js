"use strict";

/**
 * B1 measurement tooling — replay ONE coordinator round against a captured world, with the
 * production modules of a chosen source tree, and record everything the round decided.
 * **Test-only.** Nothing in `src/` requires it.
 *
 * Run once with the pre-change tree and once with the changed tree, each on its own clone of
 * the same captured database (`decisionEquivalence.js`), and the two records must be equal.
 *
 * ── Determinism ────────────────────────────────────────────────────────────
 * The decision path reads no clock (T6). The worker and the composition read `Date.now()` for
 * the budget clock, the queue age and the time bucket, and the store clock is `SELECT NOW()`.
 * Both are pinned here to the capture instant + 1 s, identically for both trees:
 *   · `Date.now` returns the pinned instant, so elapsed time is 0 and no wall-clock bound
 *     truncates anything: the round is the full, untruncated decision for this world.
 *   · `clock.readStoreTime` still issues its statement (so I/O counts are honest) and then
 *     returns the pinned instant.
 * Budget behaviour under latency is measured separately, by `latencyMatrix.js`, on real clocks.
 *
 * ── What is recorded, in call order ────────────────────────────────────────
 *   expansions  every `expansion.expandCandidates` result (ordered candidates, γ, LB, tiers,
 *               cells, agents evaluated, truncation, gap)
 *   gates       every `feasibility.gate` verdict (agent, Leg, feasible, denials, all verdicts)
 *   bounds      every `lowerBound` result (incl. its energy term)
 *   plans       every `planBuilder.build` energy / reserves / charging outcome
 *   energyFor   every `energyFor(agentId)` answer (κ, coefficients)
 *   result      the round's decisions, assignments, commits, aborts, perLeg context
 *   db          the durable effects: commitments, Legs, queue rows, outbox, fence audit, Round,
 *               decision records
 *   io          statements, Prisma operations, DB critical path, KV calls/keys, stage spans
 *
 * Usage:
 *   node tools/verify/b1/replayRound.js --root <dir holding src/> --db <url> --capture <json>
 *        --out <json> [--kv-delay-ms N] [--rtt-ms N]
 */

const Module = require("module");
const path = require("path");
const fs = require("fs");
const { AsyncLocalStorage } = require("async_hooks");
const { performance } = require("perf_hooks");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const ROOT = path.resolve(arg("--root"));
const DB = arg("--db");
const CAPTURE = JSON.parse(fs.readFileSync(arg("--capture"), "utf8"));
const OUT = arg("--out");
const KV_DELAY_MS = Number(arg("--kv-delay-ms", "0"));
const RTT_MS = Number(arg("--rtt-ms", "0"));
/**
 * Fault injection, identical for both trees, so a failure's handling is compared too:
 *   epoch-after-plan        every agent's authority epoch advances after planning, before commit
 *   offline-after-plan      every robot goes offline after planning, before commit
 *   leg-cancel-after-plan   every Leg is cancel-requested after planning, before commit
 *   leg-version-after-plan  every Leg's version moves after planning, before commit
 *   kv-batch-fail           the KV's pipelined read throws (the batched path must fall back)
 *   prepare-fail            the agent-class read throws (preparation and the concurrent commit
 *                           read must fall back to the per-item reads)
 *   commit-timeout          the commit transaction is given a 1 ms timeout
 *   outbox-fail             the outbox write inside the commit transaction throws (rollback)
 *   settle-fail             the queue settlement write throws; B3 recovery then runs
 *   concurrent-commit       a second commit for the same agent and another priced Leg races the first
 */
const FAULT = arg("--fault", null);
const FROZEN = CAPTURE.capturedAtMs + 1000;

/* ── environment exactly as the runner sets it ──────────────────────────── */
process.env.DATABASE_URL = DB;
process.env.DATABASE_URL_LOCAL = DB;
process.env.REDIS_ENABLED = "false";
delete process.env.REDIS_URL;
process.env.ENABLE_VIRTUAL_SIMULATOR = "true";
process.env.V1_DEMONSTRATION_COMPOSITION = "true";
process.env.ENGINE_ENABLED = "true";
process.env.PRIVACY_SURROGATE_SECRET = process.env.PRIVACY_SURROGATE_SECRET || "v1-demonstration-run-secret";
process.env.PRIVACY_IDENTITY_KEY = process.env.PRIVACY_IDENTITY_KEY || "22".repeat(32);
process.env.COMMAND_SIGNING_KEY = process.env.COMMAND_SIGNING_KEY || "v1-demonstration-run-signing-key";
process.env.LOG_LEVEL = "error";

/* ── the pinned clock ───────────────────────────────────────────────────── */
const realNow = Date.now.bind(Date);
const mono = () => performance.now();
Date.now = () => FROZEN;

/* ── traces ─────────────────────────────────────────────────────────────── */
const trace = { expansions: [], gates: [], bounds: [], plans: [], energyFor: [], commits: [] };
const stageMs = {};
const addStage = (name, ms) => {
  stageMs[name] = (stageMs[name] || 0) + ms;
};
const big = (key, value) => (typeof value === "bigint" ? `${value}n` : value);
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value, big)));

function timed(name, fn) {
  return function timedFn(...args) {
    const s = mono();
    const res = fn.apply(this, args);
    if (res && typeof res.then === "function") {
      return res.finally(() => addStage(name, mono() - s));
    }
    addStage(name, mono() - s);
    return res;
  };
}

const PATCHES = {
  "engine/commitment/clock.js": (exp) => {
    const orig = exp.readStoreTime;
    exp.readStoreTime = async (client) => {
      await orig(client);
      return new Date(FROZEN);
    };
  },
  "engine/feasibility/evaluate.js": (exp) => {
    const orig = exp.gate;
    exp.gate = function gate(candidate, context, options) {
      const out = orig.call(this, candidate, context, options);
      trace.gates.push({
        legId: context && context.mission ? context.mission.legId : null,
        agentId: context && context.agentSnapshot ? context.agentSnapshot.agentId : null,
        feasible: out.feasible,
        denials: out.outcome.denials.map((d) => `${d.predicateId}:${d.outcome}:${d.resolution}`),
        verdicts: plain(out.outcome.verdicts),
        deniedForIndeterminacyOnly: out.outcome.deniedForIndeterminacyOnly,
      });
      return out;
    };
  },
  "engine/candidates/lowerBound.js": (exp) => {
    const orig = exp.lowerBound;
    exp.lowerBound = function lowerBound(input) {
      const out = orig.call(this, input);
      trace.bounds.push({
        agentId: input && input.agent ? input.agent.agentId : null,
        legId: input && input.leg ? input.leg.legId : null,
        energy: plain(input && input.energy),
        out: plain(out),
      });
      return out;
    };
  },
  "engine/plan/planBuilder.js": (exp) => {
    const orig = exp.build;
    exp.build = function build(input) {
      const s = mono();
      const out = orig.call(this, input);
      addStage("planBuilder", mono() - s);
      trace.plans.push({
        planId: input && input.planId,
        ok: out.ok,
        problems: plain(out.problems),
        energy: out.ok ? plain(out.plan.energy) : null,
        reserves: out.ok ? plain(out.plan.reserves) : null,
        charging: out.ok ? plain(out.plan.charging) : null,
        stops: out.ok ? plain(out.plan.stops.map((stop) => ({ seq: stop.sequence, arr: stop.projectedArrivalMs, dep: stop.departureMs }))) : null,
      });
      return out;
    };
  },
  "engine/candidates/expansion.js": (exp) => {
    const orig = exp.expandCandidates;
    exp.expandCandidates = async function expandCandidates(input) {
      const s = mono();
      const out = await orig.call(this, input);
      addStage("expansion", mono() - s);
      trace.expansions.push({ legId: input.legId, out: plain(out) });
      return out;
    };
  },
  "engine/solve/minCostFlow.js": (exp) => {
    for (const name of Object.keys(exp)) {
      if (typeof exp[name] === "function" && /^solve/.test(name)) exp[name] = timed("solve", exp[name]);
    }
  },
  "engine/commitment/commit.js": (exp) => {
    const orig = exp.commit;
    exp.commit = async function commit(deps, request) {
      const s = mono();
      const out = await orig.call(this, deps, request);
      addStage("commit", mono() - s);
      trace.commits.push({
        agentId: request.agentId,
        legId: request.legId,
        snapshot: plain(request.snapshot),
        config: plain(request.config),
        outcome: out.outcome,
        reason: out.reason,
      });
      return out;
    };
  },
  "engine/observability/decisionRecord.js": (exp) => {
    exp.writeRound = timed("record", exp.writeRound);
  },
};

const rootSrc = path.join(ROOT, "src").split(path.sep).join("/");
const origLoad = Module._load;
const patched = new Set();
Module._load = function load(request, parent, isMain) {
  // eslint-disable-next-line prefer-rest-params
  const exp = origLoad.apply(this, arguments);
  let file;
  try {
    file = Module._resolveFilename(request, parent, isMain).split(path.sep).join("/");
  } catch {
    return exp;
  }
  if (patched.has(file) || !file.startsWith(`${rootSrc}/`)) return exp;
  const rel = file.slice(rootSrc.length + 1);
  if (PATCHES[rel]) {
    patched.add(file);
    PATCHES[rel](exp);
  }
  return exp;
};

/* ── Prisma, instrumented: statements, operations and their call sites ──── */
const { PrismaClient } = require("@prisma/client");
const siteAls = new AsyncLocalStorage();
const io = { statements: 0, ops: [], counting: false };
const SKIP = /node_modules|replayRound\.js|node:internal|<anonymous>/;
function siteOf(stack) {
  const out = [];
  for (const line of String(stack).split("\n").slice(1)) {
    if (SKIP.test(line)) continue;
    const m = line.match(/at (?:async )?(?:(\S+) )?\(?(.*?[\\/]src[\\/](.*?)):(\d+):\d+\)?$/);
    if (m) out.push(`${m[3].replace(/\\/g, "/")}:${m[4]}${m[1] ? ` ${m[1]}` : ""}`);
    if (out.length >= 4) break;
  }
  return out.join(" < ");
}

const faultState = { armed: {}, fired: [] };

function instrumentedPrisma() {
  const base = new PrismaClient({ datasources: { db: { url: DB } }, log: [{ emit: "event", level: "query" }] });
  base.$on("query", () => {
    if (io.counting) io.statements += 1;
  });
  const ext = base.$extends({
    query: {
      async $allOperations({ model, operation, args, query }) {
        const site = siteAls.getStore() || "(tx)";
        if (FAULT === "prepare-fail" && model === "AgentClass" && operation === "findMany") {
          faultState.fired.push("agentClass.findMany");
          throw new Error("B1 FAULT — agent class read failed");
        }
        if (FAULT === "outbox-fail" && faultState.armed.outbox && model === "Outbox" && operation === "create") {
          faultState.armed.outbox = false;
          faultState.fired.push("outbox.create");
          throw new Error("B1 FAULT — outbox write failed inside the commit transaction");
        }
        if (
          FAULT === "settle-fail" &&
          faultState.armed.settle &&
          model === "WorkQueue" &&
          operation === "updateMany" &&
          args && args.data && (args.data.state === "SOLVED" || args.data.state === "QUEUED")
        ) {
          faultState.armed.settle = false;
          faultState.fired.push("workQueue.updateMany (settle)");
          throw new Error("B1 FAULT — settlement write failed");
        }
        const s = mono();
        try {
          return await query(args);
        } finally {
          if (io.counting) io.ops.push({ op: `${model || "raw"}.${operation}`, t0: s, ms: mono() - s, site });
        }
      },
    },
  });
  const withSite = (p, site) =>
    p && typeof p.then === "function"
      ? new Proxy(p, {
          get(t, prop) {
            if (prop === "then" || prop === "catch" || prop === "finally") return (...a) => siteAls.run(site, () => t[prop](...a));
            const v = Reflect.get(t, prop);
            return typeof v === "function" ? v.bind(t) : v;
          },
        })
      : p;
  const proxify = (client, inTx) => {
    const delegates = new Map();
    return new Proxy(client, {
      get(t, prop) {
        const v = Reflect.get(t, prop);
        if (prop === "$transaction" && typeof v === "function") {
          return (fn, opts) => (typeof fn === "function" ? v.call(t, (tx) => fn(proxify(tx, true)), opts) : v.call(t, fn, opts));
        }
        if (typeof prop === "string" && /^\$(queryRaw|executeRaw)/.test(prop) && typeof v === "function") {
          return (...a) => withSite(v.apply(t, a), (inTx ? "[tx] " : "") + siteOf(new Error().stack));
        }
        if (typeof prop === "string" && !prop.startsWith("$") && v && typeof v === "object" && typeof v.findMany === "function") {
          if (!delegates.has(prop)) {
            delegates.set(
              prop,
              new Proxy(v, {
                get(d, m) {
                  const f = Reflect.get(d, m);
                  if (typeof f !== "function") return f;
                  return (...a) => withSite(f.apply(d, a), (inTx ? "[tx] " : "") + siteOf(new Error().stack));
                },
              }),
            );
          }
          return delegates.get(prop);
        }
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  };
  return { client: proxify(ext, false), base };
}

/** The in-memory KV, instrumented: calls, keys, and an optional per-call delay. */
function instrumentKv(kv) {
  const stats = { calls: 0, keys: 0, byOp: {}, busyMs: 0 };
  for (const name of Object.keys(kv)) {
    const fn = kv[name];
    if (typeof fn !== "function" || name === "pipeline" || name === "health") continue;
    kv[name] = async function measured(...args) {
      if (!io.counting) return fn.apply(this, args);
      const s = mono();
      stats.calls += 1;
      stats.keys += Array.isArray(args[0]) ? args[0].length : 1;
      stats.byOp[name] = (stats.byOp[name] || 0) + 1;
      if (KV_DELAY_MS > 0) await new Promise((res) => setTimeout(res, KV_DELAY_MS));
      try {
        return await fn.apply(this, args);
      } finally {
        stats.busyMs += mono() - s;
      }
    };
  }
  return stats;
}

const { categoryOf, union } = require("./analyseTrace");

async function main() {
  const req = (rel) => require(path.join(ROOT, "src", rel));
  const { initKv } = req("cache/kv.js");
  const dbModule = req("db/prisma.js");
  const configService = req("engine/config/service.js");
  const availabilityIndex = req("engine/candidates/availabilityIndex.js");
  const v1Composition = req("services/v1DemonstrationComposition.js");
  const solvePath = req("workers/coordinatorSolvePath.js");

  const { client: prisma, base } = instrumentedPrisma();
  const { kv } = await initKv({ logger: { info() {}, warn() {}, error() {} } });
  const kvStats = instrumentKv(kv);
  if (FAULT === "kv-batch-fail" && typeof kv.smembersMany === "function") {
    kv.smembersMany = async () => {
      faultState.fired.push("kv.smembersMany");
      throw new Error("B1 FAULT — pipelined KV read failed");
    };
  }

  // The Availability Index, rebuilt from its durable mirror (§6.2: "rebuildable") — the same
  // records for both trees.
  const positions = await prisma.agentCellPosition.findMany({ orderBy: { agentId: "asc" } });
  for (const row of positions) {
    // eslint-disable-next-line no-await-in-loop
    await availabilityIndex.applyPosition({ kv }, null, {
      agentId: row.agentId,
      shardId: row.shardId,
      fineCellId: row.fineCellId,
      coarseCellId: row.coarseCellId,
      availabilityClass: row.availabilityClass,
      capabilityClasses: row.capabilityClasses,
      containerClasses: row.containerClasses,
    });
  }

  const pinned = await configService.loadPinnedSnapshot({ prisma });
  const region = await prisma.region.findFirst({ orderBy: { createdAt: "asc" } });
  const shardId = CAPTURE.shardId;
  const events = [];
  const composition = v1Composition.createV1DemonstrationComposition({ prisma, kv, snapshot: () => pinned, env: process.env });
  const context = {
    prisma,
    kv,
    values: () => pinned.values,
    snapshot: () => pinned,
    shardId,
    regionId: region.regionId,
    instanceId: "b1-replay",
    runInTransaction: (fn) => dbModule.runSerializable(prisma, fn),
    runSerializable:
      FAULT === "commit-timeout" ? (client, fn) => dbModule.runSerializable(client, fn, { timeoutMs: 1 }) : dbModule.runSerializable,
    selectForUpdate: dbModule.selectForUpdate,
    isSerializationFailure: dbModule.isSerializationFailure,
    signingKey: process.env.COMMAND_SIGNING_KEY,
    record: (event, detail) => events.push({ event, detail: plain(detail) }),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    ...composition,
  };
  const assembly = solvePath.create(context);
  if (!assembly.ok) throw new Error(`solve path did not assemble: ${assembly.blockedBy}`);

  const origEnergyFor = assembly.round.energyFor;
  assembly.round.energyFor = async (agentId) => {
    const out = await origEnergyFor(agentId);
    trace.energyFor.push({ agentId: String(agentId), out: plain(out) });
    return out;
  };
  if (typeof assembly.deps.prepareRound === "function") assembly.deps.prepareRound = timed("prepare", assembly.deps.prepareRound);

  // Faults applied between planning and the first commit — the same moment on both trees.
  const AFTER_PLAN_SQL = {
    "epoch-after-plan": 'UPDATE "Agent" SET "authorityEpoch" = "authorityEpoch" + 1',
    "offline-after-plan": 'UPDATE "Robot" SET "isOnline" = false',
    "leg-cancel-after-plan": `UPDATE "Leg" SET "cancelRequestedAt" = '${new Date(FROZEN).toISOString()}'`,
    "leg-version-after-plan": 'UPDATE "Leg" SET version = version + 1',
  };
  const concurrent = [];
  const commit = assembly.deps.commit;
  let commits = 0;
  assembly.deps.commit = async (assignment, roundResult) => {
    commits += 1;
    if (commits === 1 && AFTER_PLAN_SQL[FAULT]) {
      faultState.fired.push(`${FAULT}: ${await base.$executeRawUnsafe(AFTER_PLAN_SQL[FAULT])} rows`);
    }
    if (FAULT === "outbox-fail" && commits === 1) faultState.armed.outbox = true;
    if (FAULT === "settle-fail") faultState.armed.settle = true;
    if (FAULT === "concurrent-commit" && commits === 1) {
      // Another priced Leg for the same agent, committed at the same instant on another connection.
      const agentKey = assembly.round.canonicalAgentId(assignment.agentId);
      const ownLeg = assembly.round.canonicalLegId(assignment.legId);
      const other = [...assembly.round.priced.entries()].find(([key]) => key.endsWith(`|${agentKey}`) && !key.startsWith(`${ownLeg}|`));
      if (other) {
        const second = { legId: other[1].legId, agentId: assignment.agentId };
        const [a, b] = await Promise.all([commit(assignment, roundResult), commit(second, roundResult)]);
        concurrent.push({ first: { legId: String(assignment.legId), outcome: a.outcome, reason: a.reason }, second: { legId: String(second.legId), outcome: b.outcome, reason: b.reason } });
        return a;
      }
      concurrent.push({ skipped: "no second priced Leg for the agent" });
    }
    return commit(assignment, roundResult);
  };

  const finite = (name) => {
    const value = pinned.values.get(name);
    return Number.isFinite(value) ? value : undefined;
  };
  const config = {
    maxEvaluatedPerLeg: finite("candidate.max_evaluated"),
    maxColumnsPerRound: finite("plan.max_columns_per_round"),
    branchNodeBudget: finite("solve.branch_node_budget"),
    timeBudgetMs: assembly.context.expansionWallClockBudgetMs,
    maxClockSkewMillis: finite("time.max_clock_skew"),
    storeRoundTripMillis: finite("time.store_round_trip"),
    windowMinMs: finite("solve.window_min"),
    windowMaxMs: finite("solve.window_max"),
    saturatedWindowMs: finite("solve.saturated_window"),
    maxLegsPerRound: finite("solve.max_legs_per_round"),
  };

  // A server's pool is warm; a fresh process's is not. Open the pool's connections before the
  // round so neither tree pays connection setup inside the measured round — identically for both.
  await Promise.all(Array.from({ length: 32 }, () => prisma.$queryRawUnsafe("SELECT pg_sleep(0.05)::text AS slept")));
  // The effective RTT, measured in this process through the same proxy — a calibration taken in
  // another process can see a different Windows timer granularity.
  const samples = [];
  for (let i = 0; i < 15; i += 1) {
    const s = mono();
    // eslint-disable-next-line no-await-in-loop
    await prisma.$queryRawUnsafe("SELECT 1");
    samples.push(mono() - s);
  }
  samples.sort((a, b) => a - b);
  const measuredRtt = RTT_MS > 0 ? samples[samples.length >> 1] : 0;

  io.counting = true;
  const t0 = mono();
  let threw = null;
  const run = await solvePath.worker.runRound(assembly.deps, {
    shardId,
    instanceId: "b1-replay",
    regionId: region.regionId,
    config,
    killSwitches: {},
    record: context.record,
  }).catch((error) => {
    threw = { name: error && error.name, code: (error && error.code) || null, fault: Boolean(error && /B1 FAULT/.test(error.message)) };
    return { ran: false, reason: "THREW" };
  });
  const wallMs = mono() - t0;
  let recovery = null;
  if (threw && FAULT === "settle-fail") {
    // B3 — the dead settlement's claims, recovered by the next round's first step.
    const leadershipRow = await prisma.shardLeadership.findUnique({ where: { shardId } });
    const worker = solvePath.worker;
    recovery = await worker.recoverOrphanedClaims(
      { prisma, selectForUpdate: dbModule.selectForUpdate },
      { shardId, storeTime: new Date(FROZEN), leadershipFence: leadershipRow.leadershipFence },
    );
  }
  io.counting = false;

  const perLeg = typeof assembly.deps.perLegFor === "function" ? plain(assembly.deps.perLegFor()) : null;

  /* ── durable effects, read after the round ─────────────────────────────── */
  const legs = await prisma.leg.findMany({ select: { legId: true, state: true, version: true }, orderBy: { legId: "asc" } });
  const legById = new Map((await prisma.leg.findMany({ select: { id: true, legId: true } })).map((row) => [row.id, row.legId]));
  const agentById = new Map((await prisma.agent.findMany({ select: { id: true, agentId: true } })).map((row) => [row.id, row.agentId]));
  const commitments = (await prisma.commitment.findMany({ orderBy: { commitmentId: "asc" } })).map((row) => ({
    ...row,
    agentId: agentById.get(row.agentId),
    legId: legById.get(row.legId),
  }));
  const queue = (await prisma.workQueue.findMany()).map((row) => ({ ...row, legId: legById.get(row.legId) })).sort((a, b) => (a.legId < b.legId ? -1 : 1));
  const outbox = await prisma.outbox.findMany({ orderBy: { createdAt: "asc" } });
  const fenceAudit = (await prisma.agentFenceAudit.findMany()).map((row) => ({ ...row, agentId: agentById.get(row.agentId) }));
  const rounds = await prisma.round.findMany();
  const decisionRecords = await prisma.decisionRecordA.findMany();

  const ops = io.ops;
  const byCategory = {};
  for (const op of ops) {
    const c = categoryOf(op);
    (byCategory[c] = byCategory[c] || []).push(op);
  }
  const dbCriticalMs = union(ops.map((o) => [o.t0, o.t0 + o.ms]));

  const record = {
    meta: {
      root: ROOT,
      db: DB.replace(/\/\/[^@]*@/, "//***@"),
      frozenAtMs: FROZEN,
      kvDelayMs: KV_DELAY_MS,
      rttMs: RTT_MS,
      agentsPlaced: positions.length,
      realStartedAt: new Date(realNow()).toISOString(),
    },
    io: {
      wallMs,
      statements: io.statements,
      operations: ops.length,
      dbCriticalMs,
      measuredRttMs: measuredRtt,
      dbRttEq: measuredRtt > 0 ? dbCriticalMs / measuredRtt : null,
      byCategory: Object.fromEntries(
        Object.entries(byCategory).map(([c, rows]) => [
          c,
          { ops: rows.length, criticalMs: union(rows.map((o) => [o.t0, o.t0 + o.ms])), rttEq: measuredRtt > 0 ? union(rows.map((o) => [o.t0, o.t0 + o.ms])) / measuredRtt : null },
        ]),
      ),
      kv: kvStats,
      stageMs,
      opsBySite: Object.entries(
        ops.reduce((acc, o) => {
          const key = `${o.op} @ ${o.site.split(" < ").slice(0, 2).join(" < ")}`;
          acc[key] = (acc[key] || 0) + 1;
          return acc;
        }, {}),
      ).sort((a, b) => b[1] - a[1]),
    },
    decision: {
      run: plain({ ran: run.ran, reason: run.reason || null, roundId: run.roundId, cadenceVerdict: run.cadenceVerdict, settlement: run.settlement, threw }),
      fault: plain({ name: FAULT, fired: faultState.fired, concurrent, recovery }),
      result: run.result
        ? plain({
            outcome: run.result.outcome,
            regime: run.result.regime,
            note: run.result.note,
            decisions: run.result.decisions,
            assignments: run.result.assignments,
            committed: run.result.committed,
            aborted: run.result.aborted,
            columns: run.result.columns,
            searchGapMilliCU: run.result.searchGapMilliCU,
            lpIpGapMilliCU: run.result.lpIpGapMilliCU,
            budgets: run.result.budgets,
          })
        : null,
      perLeg,
      trace: plain(trace),
      events,
      db: plain({ legs, commitments, queue, outbox, fenceAudit, rounds, decisionRecords }),
    },
  };
  fs.writeFileSync(OUT, JSON.stringify(record, null, 1));
  await base.$disconnect();
  console.log(
    `[replay] ${path.basename(ROOT)} ran=${run.ran} outcome=${run.result ? run.result.outcome : run.reason} ` +
      `assigned=${run.result ? run.result.assignments.length : 0} committed=${run.result ? (run.result.committed || []).length : 0} ` +
      `statements=${io.statements} ops=${ops.length} dbCriticalMs=${dbCriticalMs.toFixed(0)} kvCalls=${kvStats.calls} wallMs=${wallMs.toFixed(0)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

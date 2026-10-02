"use strict";

/**
 * B1 measurement tooling — a read-only tracing preload (`node -r`) for
 * `tools/demo/runV1Assignment.js`. **Test-only.** Nothing in `src/` requires it, and it edits
 * no file: it wraps module exports in memory as they load.
 *
 * Ported from the B1 audit's scratch tracer (2026-10-01) so before/after numbers come from one
 * harness. The audit's measurement-only budget override is deliberately NOT carried: nothing in
 * B1 may change `solve.time_budget`, so nothing here can.
 *
 * Emits JSON lines to `TRACE_FILE`:
 *   {k:"round"}  a coordinator round began (runRound's first store-clock read)
 *   {k:"exit"}   a wrapped stage returned (stage, ms, outcome fields)
 *   {k:"op"}     one Prisma operation attributed to its round and call site
 *   {k:"sql"}    one SQL statement (Prisma query event)
 *   {k:"kv"}     one KV call attributed to its round
 *   {k:"flip"}   the moment latency was raised (the runner printed "[workers] running")
 *
 * Environment:
 *   TRACE_FILE   output path (required)
 *   CTL_FILE     the latency proxy's control file; RTT_ONEWAY is written to it at the flip
 *   RTT_ONEWAY   one-way delay in ms (RTT = 2×), applied from the flip on
 *   KV_DELAY_MS  per-KV-call delay applied after the flip — models a remote KV's round trip.
 *                A pipelined call (`smembersMany`) is one round trip and is delayed once.
 */

const Module = require("module");
const path = require("path");
const fs = require("fs");
const { AsyncLocalStorage } = require("async_hooks");
const { performance } = require("perf_hooks");

const als = new AsyncLocalStorage();
const siteAls = new AsyncLocalStorage();
const fd = fs.openSync(process.env.TRACE_FILE, "a");
const now = () => performance.timeOrigin + performance.now();
const r1 = (x) => Math.round(x * 10) / 10;
const emit = (o) => fs.writeSync(fd, `${JSON.stringify(o)}\n`);
let roundSeq = 0;
let flipped = false;
const KV_DELAY = Number(process.env.KV_DELAY_MS || 0);

/* ── the flip: setup at 0 ms, rounds at the target latency ───────────────── */
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  const s = String(chunk);
  if (!flipped && s.includes("[workers] running")) {
    flipped = true;
    if (process.env.CTL_FILE) fs.writeFileSync(process.env.CTL_FILE, String(process.env.RTT_ONEWAY || 0));
    emit({ k: "flip", t: now(), oneWay: Number(process.env.RTT_ONEWAY || 0), kvDelay: KV_DELAY });
  }
  return origWrite(chunk, ...rest);
};

/* ── call-site resolution ─────────────────────────────────────────────────── */
const SKIP = /node_modules|roundTrace\.js|[\\/]db[\\/]prisma\.js|node:internal|<anonymous>/;
function siteOf(stack) {
  const lines = String(stack).split("\n").slice(1);
  const out = [];
  for (const line of lines) {
    if (SKIP.test(line)) continue;
    const m = line.match(/at (?:async )?(?:(\S+) )?\(?(.*?[\\/](?:src|tools)[\\/](.*?)):(\d+):\d+\)?$/);
    if (m) out.push(`${m[3].replace(/\\/g, "/")}:${m[4]}${m[1] ? ` ${m[1]}` : ""}`);
    if (out.length >= 4) break;
  }
  return out.join(" < ");
}

/* ── stage wrappers ───────────────────────────────────────────────────────── */
const TARGETS = {
  "engine/commitment/clock.js": ["readStoreTime"],
  "engine/shard/leadership.js": ["readLeadership"],
  "engine/solve/round.js": ["execute"],
  "engine/candidates/expansion.js": ["expandCandidates"],
  "engine/candidates/availabilityIndex.js": ["candidatesInFineCell", "candidatesInFineCells", "candidatesInCoarseCell"],
  "engine/routing/cellPairCache.js": ["hopsFor"],
  "engine/solve/minCostFlow.js": ["solve"],
  "engine/commitment/commit.js": ["commit"],
  "engine/observability/decisionRecord.js": ["writeRound"],
  "engine/plan/planBuilder.js": ["build"],
  "engine/feasibility/evaluate.js": ["gate"],
  "services/executionGeometry.service.js": ["attachStopPaths"],
  "engine/dispatch/offers.js": ["enqueueOffer"],
};

function wrap(mod, label, names) {
  for (const name of Object.keys(mod)) {
    const fn = mod[name];
    if (typeof fn !== "function" || /^[A-Z]/.test(name) || (names && !names.includes(name))) continue;
    mod[name] = function traced(...args) {
      let parent = als.getStore();
      // A round starts where runRound reads the store clock (its first act); commit.js reads
      // it again inside the transaction, with runRound still on the async stack.
      if (
        label === "clock" &&
        name === "readStoreTime" &&
        /coordinator\.worker\.js:\d+:\d+\)?\s*$/m.test(String(new Error().stack).split("\n")[2] || "")
      ) {
        parent = { r: ++roundSeq, stage: "round" };
        als.enterWith(parent);
        emit({ k: "round", r: parent.r, t: now(), flipped });
      }
      if (!parent) return fn.apply(this, args);
      const stage = `${label}.${name}`;
      const ctx = { r: parent.r, stage };
      const s = now();
      const done = (ok, v) => {
        const e = { k: "exit", r: ctx.r, stage, parent: parent.stage, t0: s, ms: r1(now() - s), ok };
        if (v && typeof v === "object") {
          for (const key of ["truncatedBy", "agentsEvaluated", "cellsExplored", "outcome", "committed", "reason", "budgetLimited"]) {
            if (v[key] !== undefined && typeof v[key] !== "object") e[key] = v[key];
          }
          if (Array.isArray(v.candidates)) e.candidates = v.candidates.length;
          if (Array.isArray(v.assignments)) e.assignments = v.assignments.length;
          if (v.budgets && v.budgets.wallClock) e.wallClock = v.budgets.wallClock;
          if (v.budgets && v.budgets.exceeded) e.exceeded = v.budgets.exceeded.map((x) => x.bound);
          if (Array.isArray(v.decisions)) e.decisions = v.decisions.map((d) => d.outcome);
        }
        if (Array.isArray(v)) e.n = v.length;
        emit(e);
      };
      let res;
      try {
        res = als.run(ctx, () => fn.apply(this, args));
      } catch (error) {
        done(false);
        throw error;
      }
      if (res && typeof res.then === "function") {
        return res.then(
          (v) => {
            done(true, v);
            return v;
          },
          (error) => {
            done(false);
            throw error;
          },
        );
      }
      done(true, res);
      return res;
    };
  }
}

const origLoad = Module._load;
const patched = new Set();
let opSeq = 0;
Module._load = function load(request, parent, isMain) {
  // eslint-disable-next-line prefer-rest-params
  const exp = origLoad.apply(this, arguments);
  let file;
  try {
    file = Module._resolveFilename(request, parent, isMain);
  } catch {
    return exp;
  }
  if (patched.has(file)) return exp;
  const norm = file.split(String.fromCharCode(92)).join("/");

  if (
    /node_modules\/\.prisma\/client\/index\.js$|node_modules\/@prisma\/client\/index\.js$/.test(norm) &&
    exp &&
    exp.PrismaClient &&
    !exp.PrismaClient.__traced
  ) {
    patched.add(file);
    const Orig = exp.PrismaClient;
    const Traced = class extends Orig {
      constructor(opts = {}) {
        super({ ...opts, log: [...(opts.log || []), { emit: "event", level: "query" }] });
        this.$on("query", (e) =>
          emit({ k: "sql", ts: new Date(e.timestamp).getTime(), ms: e.duration, q: e.query.replace(/\s+/g, " ").slice(0, 70) }),
        );
        const ext = this.$extends({
          query: {
            async $allOperations({ model, operation, args, query }) {
              const st = als.getStore();
              const id = ++opSeq;
              const site = siteAls.getStore() || "(tx/unknown)";
              const s = now();
              try {
                return await query(args);
              } finally {
                emit({
                  k: "op",
                  id,
                  r: st ? st.r : null,
                  stage: st ? st.stage : null,
                  op: `${model || "raw"}.${operation}`,
                  t0: s,
                  ms: r1(now() - s),
                  site,
                  raw: model ? undefined : String((args && args[0]) || "").replace(/\s+/g, " ").slice(0, 60),
                });
              }
            },
          },
        });
        // The call site is captured at the delegate call, where the app's frames are on the
        // stack, and carried into the lazy PrismaPromise's execution.
        const withSite = (p, site) =>
          p && typeof p.then === "function"
            ? new Proxy(p, {
                get(t, prop) {
                  if (prop === "then" || prop === "catch" || prop === "finally") {
                    return (...a) => siteAls.run(site, () => t[prop](...a));
                  }
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
        return proxify(ext, false);
      }
    };
    Traced.__traced = true;
    exp.PrismaClient = Traced;
    return exp;
  }

  // Any tree's `src/` — the repository's or a pre-change copy — so one tracer measures both.
  const m = norm.match(/\/src\/((?:engine|workers|services|cache|db)\/.*)$/);
  if (m && m[1] in TARGETS) {
    patched.add(file);
    wrap(exp, path.basename(m[1], ".js").replace(".service", ""), TARGETS[m[1]]);
  }
  if (m && m[1] === "cache/kv.js" && typeof exp.initKv === "function") {
    patched.add(file);
    const orig = exp.initKv;
    const siteSeen = new Map();
    exp.initKv = async (...a) => {
      const r = await orig(...a);
      for (const k of Object.keys(r.kv)) {
        const f = r.kv[k];
        if (typeof f !== "function" || k === "pipeline" || k === "health") continue;
        r.kv[k] = async function tracedKv(...x) {
          const st = als.getStore();
          if (st) {
            const sk = `${st.stage}|${k}`;
            const n = (siteSeen.get(sk) || 0) + 1;
            siteSeen.set(sk, n);
            const s = now();
            if (flipped && KV_DELAY > 0) await new Promise((res) => setTimeout(res, KV_DELAY));
            try {
              return await f.apply(this, x);
            } finally {
              emit({
                k: "kv",
                r: st.r,
                stage: st.stage,
                op: k,
                keys: Array.isArray(x[0]) ? x[0].length : 1,
                t0: s,
                ms: r1(now() - s),
                site: n <= 3 ? siteOf(new Error().stack) : undefined,
              });
            }
          }
          return f.apply(this, x);
        };
      }
      return r;
    };
  }
  return exp;
};

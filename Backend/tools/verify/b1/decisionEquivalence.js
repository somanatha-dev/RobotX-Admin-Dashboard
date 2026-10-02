"use strict";

/**
 * B1 measurement tooling — decision equivalence and round I/O, BEFORE vs AFTER, on one
 * captured world. **Test-only.** Nothing in `src/` requires it.
 *
 * For each side (a source tree), it clones the captured database (`CREATE DATABASE … TEMPLATE`),
 * optionally puts the calibrated latency proxy in front of it, and runs `replayRound.js` with
 * that tree's production modules. The two `decision` records — every expansion result, every
 * gate verdict, every lower bound, every plan's energy, every `energyFor` answer, the round's
 * decisions/assignments/commits and every durable row the round wrote — are then compared
 * field for field, after removing only row identifiers and wall-clock timestamps the database
 * assigns (`id`, `createdAt`, `updatedAt`).
 *
 * A difference is printed path by path and the process exits 1. Nothing is "close enough".
 *
 * Usage:
 *   node tools/verify/b1/decisionEquivalence.js --template <worldDb> --capture <json>
 *        --side pre=<root> --side new=<root> [--rtt-oneway-ms N] [--kv-delay-ms N]
 *        [--server postgresql://user@127.0.0.1:55720] [--out <dir>] [--label <name>]
 * A single `--side` runs the replay without a comparison (I/O measurement only).
 */

const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const sides = args
  .map((value, index) => (args[index - 1] === "--side" ? value : null))
  .filter(Boolean)
  .map((value) => {
    const [name, root] = value.split("=");
    return { name, root: path.resolve(root) };
  });
const TEMPLATE = arg("--template");
const CAPTURE = path.resolve(arg("--capture"));
const SERVER = arg("--server", "postgresql://pgverify@127.0.0.1:55720");
const ONE_WAY = Number(arg("--rtt-oneway-ms", "0"));
const KV_DELAY = Number(arg("--kv-delay-ms", "0"));
const OUT_DIR = path.resolve(arg("--out", "."));
const LABEL = arg("--label", TEMPLATE);
const FAULT = arg("--fault", null);
const PG_BIN = process.env.PG_BIN || "C:/Program Files/PostgreSQL/18/bin";
const BACKEND = path.resolve(__dirname, "../../..");

const server = new URL(SERVER);
if (!["127.0.0.1", "localhost"].includes(server.hostname) || server.port === "" || server.port === "5432") {
  throw new Error("decisionEquivalence: loopback disposable cluster only (never 5432, never Neon)");
}
fs.mkdirSync(OUT_DIR, { recursive: true });

function pg(tool, ...rest) {
  const out = spawnSync(path.join(PG_BIN, tool), ["-h", server.hostname, "-p", server.port, "-U", server.username, ...rest], {
    encoding: "utf8",
  });
  if (out.status !== 0 && !/does not exist/.test(out.stderr)) throw new Error(`${tool} ${rest.join(" ")}: ${out.stderr}`);
  return out.stdout;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function calibrate(url) {
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  await prisma.$queryRawUnsafe("SELECT 1");
  const samples = [];
  for (let i = 0; i < 9; i += 1) {
    const s = process.hrtime.bigint();
    // eslint-disable-next-line no-await-in-loop
    await prisma.$queryRawUnsafe("SELECT 1");
    samples.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  await prisma.$disconnect();
  samples.sort((a, b) => a - b);
  return samples[samples.length >> 1];
}

async function runSide(side) {
  const db = `b1eq_${LABEL}_${side.name}`.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  pg("dropdb.exe", "--if-exists", db);
  pg("createdb.exe", "-T", TEMPLATE, db);
  let url = `${SERVER}/${db}`;
  let proxy = null;
  let ctl = null;
  if (ONE_WAY > 0) {
    const port = 56100 + Math.floor(Math.random() * 800);
    ctl = path.join(OUT_DIR, `ctl_${db}`);
    fs.writeFileSync(ctl, String(ONE_WAY));
    proxy = spawn(process.execPath, [path.join(__dirname, "latencyProxy.js"), String(port), server.port, ctl], { stdio: "ignore" });
    await sleep(500);
    url = `postgresql://${server.username}@127.0.0.1:${port}/${db}`;
  }
  const effectiveRtt = ONE_WAY > 0 ? await calibrate(url) : 0;
  const out = path.join(OUT_DIR, `${LABEL}_${side.name}.json`);
  const child = spawnSync(
    process.execPath,
    [
      path.join(__dirname, "replayRound.js"),
      "--root", side.root,
      "--db", url,
      "--capture", CAPTURE,
      "--out", out,
      "--kv-delay-ms", String(KV_DELAY),
      "--rtt-ms", String(effectiveRtt),
      ...(FAULT ? ["--fault", FAULT] : []),
    ],
    { encoding: "utf8", env: { ...process.env, NODE_PATH: path.join(BACKEND, "node_modules") }, maxBuffer: 64 * 1024 * 1024 },
  );
  if (proxy) proxy.kill();
  if (ctl) fs.rmSync(ctl, { force: true });
  process.stdout.write(child.stdout);
  if (child.status !== 0) throw new Error(`replay ${side.name} failed:\n${child.stderr.slice(-4000)}`);
  return { side, db, effectiveRtt, record: JSON.parse(fs.readFileSync(out, "utf8")) };
}

/**
 * Remove the identifiers and timestamps the database assigns, nothing else: row ids (uuid
 * defaults), the `@default(now())` / `@updatedAt` columns, `Round.startedAt` (a `now()` default)
 * and `DecisionRecordA.inputSnapshotId` (a foreign key to an `InputSnapshot` row's uuid). Measured
 * by running the same tree on both sides (2026-10-01): these five are the only fields that differ.
 */
const VOLATILE = new Set(["id", "createdAt", "updatedAt", "startedAt", "inputSnapshotId"]);
function normalise(value) {
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) if (!VOLATILE.has(key)) out[key] = normalise(value[key]);
    return out;
  }
  return value;
}

function diff(a, b, at, out) {
  if (out.length >= 40) return;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return void out.push(`${at}: array vs non-array`);
    if (a.length !== b.length) out.push(`${at}: length ${a.length} vs ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) diff(a[i], b[i], `${at}[${i}]`, out);
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(key in a)) out.push(`${at}.${key}: missing before`);
      else if (!(key in b)) out.push(`${at}.${key}: missing after`);
      else diff(a[key], b[key], `${at}.${key}`, out);
    }
    return;
  }
  if (a !== b) out.push(`${at}: ${JSON.stringify(a)?.slice(0, 160)} vs ${JSON.stringify(b)?.slice(0, 160)}`);
}

(async () => {
  const results = [];
  for (const side of sides) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await runSide(side));
  }
  const summary = results.map(({ side, effectiveRtt, record }) => ({
    side: side.name,
    effectiveRttMs: Number(effectiveRtt.toFixed(1)),
    measuredRttMs: record.io.measuredRttMs === undefined ? null : Number(record.io.measuredRttMs.toFixed(1)),
    agents: record.meta.agentsPlaced,
    outcome: record.decision.result ? record.decision.result.outcome : record.decision.run.reason,
    assigned: record.decision.result ? record.decision.result.assignments.length : 0,
    committed: record.decision.result ? (record.decision.result.committed || []).length : 0,
    statements: record.io.statements,
    operations: record.io.operations,
    wallMs: Math.round(record.io.wallMs),
    dbCriticalMs: Math.round(record.io.dbCriticalMs),
    dbRttEq: record.io.dbRttEq === null ? null : Number(record.io.dbRttEq.toFixed(1)),
    kvCalls: record.io.kv.calls,
    kvKeys: record.io.kv.keys,
    byCategory: Object.fromEntries(Object.entries(record.io.byCategory).map(([c, v]) => [c, `${v.ops} ops/${v.rttEq === null ? Math.round(v.criticalMs) + "ms" : v.rttEq.toFixed(1) + " RTT"}`])),
    stageMs: Object.fromEntries(Object.entries(record.io.stageMs).map(([k, v]) => [k, Math.round(v)])),
  }));
  console.log(JSON.stringify(summary, null, 1));
  let verdict = { compared: false };
  if (results.length === 2) {
    const differences = [];
    // Which injected faults fired is reported, not compared: the pipelined KV read and the class
    // read exist only on the B1 side, so only that side can trip their faults.
    const strip = (decision) => ({ ...decision, fault: decision.fault ? { ...decision.fault, fired: undefined } : decision.fault });
    diff(normalise(strip(results[0].record.decision)), normalise(strip(results[1].record.decision)), "decision", differences);
    verdict = {
      compared: true,
      fault: FAULT,
      fired: results.map((r) => ({ side: r.side.name, fired: r.record.decision.fault ? r.record.decision.fault.fired : [] })),
      threw: results.map((r) => ({ side: r.side.name, threw: r.record.decision.run.threw || null })),
      equal: differences.length === 0,
      differences,
      counts: Object.fromEntries(
        ["expansions", "gates", "bounds", "plans", "energyFor", "commits"].map((k) => [
          k,
          `${results[0].record.decision.trace[k].length} vs ${results[1].record.decision.trace[k].length}`,
        ]),
      ),
    };
    console.log(JSON.stringify(verdict, null, 1));
  }
  fs.writeFileSync(path.join(OUT_DIR, `${LABEL}_summary.json`), JSON.stringify({ summary, verdict }, null, 1));
  process.exit(verdict.compared && !verdict.equal ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(2);
});

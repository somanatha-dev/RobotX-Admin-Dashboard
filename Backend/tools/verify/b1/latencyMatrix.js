"use strict";

/**
 * B1 measurement tooling — the latency matrix, on REAL clocks, through the shipped runner.
 * **Test-only.** Nothing in `src/` requires it.
 *
 * For each configuration it seeds a fresh disposable database (`CREATE DATABASE … TEMPLATE`),
 * starts `latencyProxy.js` in front of it at 0 ms, runs `tools/demo/runV1Assignment.js` from
 * the chosen source tree with `roundTrace.js` preloaded, and raises the latency at the moment
 * the runner's workers start — so the world is seeded at loopback speed and every coordinator
 * round runs at the target RTT. The effective RTT is calibrated separately (`SELECT 1` through a
 * second proxy at the same setting) and reported instead of the nominal one.
 *
 * `solve.time_budget` is whatever the runner publishes (2000 ms). Nothing here changes it.
 *
 * Usage:
 *   node tools/verify/b1/latencyMatrix.js --root <tree> --label <name> --out <dir>
 *        [--config <name>:<oneWayMs>[:<kvDelayMs>] ...] [--scenario baseline] [--timeout-s 150]
 *        [--template rx_tpl] [--server postgresql://pgverify@127.0.0.1:55720]
 */

const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const { analyse } = require("./analyseTrace");

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const ROOT = path.resolve(arg("--root", "."));
const LABEL = arg("--label", "run");
const OUT = path.resolve(arg("--out", "."));
const SCENARIO = arg("--scenario", "baseline");
const TIMEOUT_S = Number(arg("--timeout-s", "150"));
const TEMPLATE = arg("--template", "rx_tpl");
const SERVER = new URL(arg("--server", "postgresql://pgverify@127.0.0.1:55720"));
const PG_BIN = process.env.PG_BIN || "C:/Program Files/PostgreSQL/18/bin";
const BACKEND = path.resolve(__dirname, "../../..");
const configs = args
  .map((value, index) => (args[index - 1] === "--config" ? value : null))
  .filter(Boolean)
  .map((value) => {
    const [name, oneWay, kvDelay] = value.split(":");
    return { name, oneWay: Number(oneWay), kvDelay: Number(kvDelay || 0) };
  });
if (!["127.0.0.1", "localhost"].includes(SERVER.hostname) || SERVER.port === "5432" || SERVER.port === "") {
  throw new Error("latencyMatrix: loopback disposable cluster only");
}
fs.mkdirSync(OUT, { recursive: true });

const pg = (tool, ...rest) => {
  const out = spawnSync(path.join(PG_BIN, tool), ["-h", SERVER.hostname, "-p", SERVER.port, "-U", SERVER.username, ...rest], { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`${tool}: ${out.stderr}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomPort = () => 56900 + Math.floor(Math.random() * 900);

async function calibrate(db, oneWay) {
  if (oneWay === 0) return 0;
  const port = randomPort();
  const ctl = path.join(OUT, `ctl_cal_${port}`);
  fs.writeFileSync(ctl, String(oneWay));
  const proxy = spawn(process.execPath, [path.join(__dirname, "latencyProxy.js"), String(port), SERVER.port, ctl], { stdio: "ignore" });
  await sleep(500);
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient({ datasources: { db: { url: `postgresql://${SERVER.username}@127.0.0.1:${port}/${db}` } } });
  await prisma.$queryRawUnsafe("SELECT 1");
  const samples = [];
  for (let i = 0; i < 9; i += 1) {
    const s = process.hrtime.bigint();
    // eslint-disable-next-line no-await-in-loop
    await prisma.$queryRawUnsafe("SELECT 1");
    samples.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  await prisma.$disconnect();
  proxy.kill();
  fs.rmSync(ctl, { force: true });
  samples.sort((a, b) => a - b);
  return samples[samples.length >> 1];
}

async function runOne(config) {
  const db = `b1lat_${LABEL}_${config.name}`.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  pg("dropdb.exe", "--if-exists", db);
  pg("createdb.exe", "-T", TEMPLATE, db);
  const effectiveRtt = await calibrate(db, config.oneWay);
  const port = randomPort();
  const ctl = path.join(OUT, `ctl_${db}`);
  fs.writeFileSync(ctl, "0");
  const proxy = spawn(process.execPath, [path.join(__dirname, "latencyProxy.js"), String(port), SERVER.port, ctl], { stdio: "ignore" });
  await sleep(500);
  const trace = path.join(OUT, `${LABEL}_${config.name}.trace.jsonl`);
  const json = path.join(OUT, `${LABEL}_${config.name}.run.json`);
  const log = path.join(OUT, `${LABEL}_${config.name}.log`);
  fs.rmSync(trace, { force: true });
  const started = Date.now();
  const child = spawnSync(
    process.execPath,
    [
      "-r", path.join(__dirname, "roundTrace.js"),
      path.join(ROOT, "tools/demo/runV1Assignment.js"),
      `postgresql://${SERVER.username}@127.0.0.1:${port}/${db}`,
      "--scenario", SCENARIO,
      "--timeout-s", String(TIMEOUT_S),
      "--json", json,
    ],
    {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      timeout: (TIMEOUT_S + 420) * 1000,
      env: {
        ...process.env,
        NODE_PATH: path.join(BACKEND, "node_modules"),
        TRACE_FILE: trace,
        CTL_FILE: ctl,
        RTT_ONEWAY: String(config.oneWay),
        KV_DELAY_MS: String(config.kvDelay),
      },
    },
  );
  proxy.kill();
  fs.rmSync(ctl, { force: true });
  fs.writeFileSync(log, `${child.stdout}\n${child.stderr}`);
  const lines = fs.existsSync(trace)
    ? fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const analysed = analyse(lines, effectiveRtt);
  const run = fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, "utf8")) : null;
  const resultLine = (String(child.stdout).match(/RESULT: .*/) || ["(no RESULT line)"])[0];
  return {
    config,
    effectiveRttMs: Number(effectiveRtt.toFixed(1)),
    wallS: Math.round((Date.now() - started) / 1000),
    exit: child.status,
    resultLine,
    tasksCompleted: run && run.summary ? run.summary.completed : null,
    tasks: run && run.summary ? run.summary.tasks : null,
    ...analysed.summary,
  };
}

(async () => {
  const rows = [];
  for (const config of configs) {
    // eslint-disable-next-line no-await-in-loop
    const row = await runOne(config);
    rows.push(row);
    console.log(JSON.stringify(row));
    fs.writeFileSync(path.join(OUT, `${LABEL}_matrix.json`), JSON.stringify(rows, null, 1));
  }
  console.log("MATRIX DONE");
})().catch((error) => {
  console.error(error);
  process.exit(2);
});

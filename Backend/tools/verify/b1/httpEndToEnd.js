"use strict";

/**
 * B1 — a real HTTP end-to-end run of the real `server.js`, on throwaway infrastructure,
 * optionally with the server's database behind the latency proxy. **Test-only.**
 *
 *   1. a fresh disposable database (`CREATE DATABASE … TEMPLATE`, loopback cluster only)
 *   2. `tools/demo/seedV1Demonstration.js --fleet baseline` — the seeded world and six
 *      simulated robots, through the real commissioning service
 *   3. `tools/demo/startV1Server.js` — the real `server.js`, ENGINE_ENABLED, in-memory KV —
 *      with its DATABASE_URL pointing at `latencyProxy.js` when `--oneway-ms` > 0
 *   4. `POST /api/tasks/assign` × N, each with a real JWT for the seed's real `User` row
 *   5. the durable outcome, read back from the database: every Task COMPLETED, every Leg
 *      SETTLED, one Commitment per Leg, no Leg ever holding two live commitments
 *
 * `solve.time_budget` is the seed's published 2000 ms. Nothing here changes it.
 *
 * Usage:
 *   node tools/verify/b1/httpEndToEnd.js [--root .] [--oneway-ms 0] [--tasks 5]
 *        [--timeout-s 600] [--port 3999] [--server postgresql://pgverify@127.0.0.1:55720]
 */

const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const ROOT = path.resolve(arg("--root", "."));
const ONE_WAY = Number(arg("--oneway-ms", "0"));
const TASKS = Number(arg("--tasks", "5"));
const TIMEOUT_S = Number(arg("--timeout-s", "600"));
const PORT = Number(arg("--port", "3999"));
const SERVER = new URL(arg("--server", "postgresql://pgverify@127.0.0.1:55720"));
const PG_BIN = process.env.PG_BIN || "C:/Program Files/PostgreSQL/18/bin";
const BACKEND = path.resolve(__dirname, "../../..");
if (!["127.0.0.1", "localhost"].includes(SERVER.hostname) || SERVER.port === "5432" || SERVER.port === "") {
  throw new Error("httpEndToEnd: loopback disposable cluster only");
}

const JOBS = [
  ["rnsit-food-court", "rnsit-innovation-center"],
  ["rnsit-playground-2", "rnsit-canara-bank"],
  ["rnsit-pre-university-college", "rns-evening-college"],
  ["rns-first-grade-college", "rnsit-food-court"],
  ["rnsit-cyber-security-department", "rnsit-playground-2"],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (line) => process.stdout.write(`${line}\n`);
// Only the secrets a server started from another tree needs (it has no `.env` of its own) —
// never `.env`'s DATABASE_URL (the shared Neon instance) or REDIS_URL (the hosted Redis): the
// children get the loopback database by flag and the in-memory KV, pinned here as well.
const dotenvValues = require(path.join(BACKEND, "node_modules/dotenv")).parse(
  fs.existsSync(path.join(BACKEND, ".env")) ? fs.readFileSync(path.join(BACKEND, ".env")) : "",
);
const SECRETS = ["JWT_SECRET", "PRIVACY_SURROGATE_SECRET", "PRIVACY_IDENTITY_KEY", "COMMAND_SIGNING_KEY"];
const env = {
  ...Object.fromEntries(SECRETS.filter((k) => dotenvValues[k] !== undefined && process.env[k] === undefined).map((k) => [k, dotenvValues[k]])),
  ...process.env,
  REDIS_ENABLED: "false",
  REDIS_URL: "",
  NODE_PATH: path.join(BACKEND, "node_modules"),
};
delete env.DATABASE_URL;
delete env.DATABASE_URL_LOCAL;

async function main() {
  const db = `b1http_${ONE_WAY}_${Date.now()}`;
  const pg = (tool, ...rest) => {
    const out = spawnSync(path.join(PG_BIN, tool), ["-h", SERVER.hostname, "-p", SERVER.port, "-U", SERVER.username, ...rest], { encoding: "utf8" });
    if (out.status !== 0) throw new Error(`${tool}: ${out.stderr}`);
  };
  pg("createdb.exe", "-T", "rx_tpl", db);
  const direct = `postgresql://${SERVER.username}@127.0.0.1:${SERVER.port}/${db}`;

  const seeded = spawnSync(process.execPath, [path.join(ROOT, "tools/demo/seedV1Demonstration.js"), "--database-url", direct, "--fleet", "baseline"], {
    encoding: "utf8",
    env,
    cwd: BACKEND,
  });
  if (seeded.status !== 0) throw new Error(`seed failed: ${seeded.stderr.slice(-2000)}`);
  say(`[seed] ${db}: world + baseline fleet`);

  let url = direct;
  let proxy = null;
  if (ONE_WAY > 0) {
    const port = 57300 + Math.floor(Math.random() * 500);
    const ctl = path.join(require("os").tmpdir(), `b1http_ctl_${port}`);
    fs.writeFileSync(ctl, String(ONE_WAY));
    proxy = spawn(process.execPath, [path.join(__dirname, "latencyProxy.js"), String(port), SERVER.port, ctl], { stdio: "ignore" });
    await sleep(500);
    url = `postgresql://${SERVER.username}@127.0.0.1:${port}/${db}`;
  }

  const logFile = path.join(require("os").tmpdir(), `${db}.server.log`);
  const log = fs.openSync(logFile, "w");
  const server = spawn(
    process.execPath,
    [path.join(ROOT, "tools/demo/startV1Server.js"), "--database-url", url, "--port", String(PORT), "--host", "127.0.0.1"],
    { env, cwd: BACKEND, stdio: ["ignore", log, log] },
  );
  const stop = () => {
    try {
      server.kill();
    } catch {
      /* already gone */
    }
    if (proxy) proxy.kill();
  };

  try {
    const { PrismaClient } = require(path.join(BACKEND, "node_modules/@prisma/client"));
    const prisma = new PrismaClient({ datasources: { db: { url: direct } } });

    // The server is up, its robots online and indexed, and its shard has a leader.
    const deadlineUp = Date.now() + 180_000;
    let up = false;
    while (Date.now() < deadlineUp) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await fetch(`http://127.0.0.1:${PORT}/health`);
        // eslint-disable-next-line no-await-in-loop
        const placed = await prisma.agentCellPosition.count();
        // eslint-disable-next-line no-await-in-loop
        const leader = await prisma.shardLeadership.findFirst({ where: { leaseExpiry: { gt: new Date() } } });
        if (res.status < 500 && placed >= 5 && leader) {
          up = true;
          break;
        }
      } catch {
        /* not yet */
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
    if (!up) throw new Error(`server did not come up with an indexed fleet and a shard leader (log: ${logFile})`);
    say(`[server] up on ${PORT}${ONE_WAY > 0 ? `, database behind the proxy at one-way ${ONE_WAY} ms` : ""}`);

    // A real token for the seed's real User row, signed with the server's own secret.
    require(path.join(BACKEND, "node_modules/dotenv")).config({ path: path.join(BACKEND, ".env") });
    const jwt = require(path.join(BACKEND, "node_modules/jsonwebtoken"));
    const user = await prisma.user.findFirst({ where: { email: "v1-demonstration-seed@localhost" } });
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: "30m" });
    const { points } = require(path.join(ROOT, "tools/demo/seedV1Demonstration.js")).loadGeometry();

    const taskIds = [];
    for (let i = 0; i < TASKS; i += 1) {
      const [from, to] = JOBS[i % JOBS.length];
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(`http://127.0.0.1:${PORT}/api/tasks/assign`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "Idempotency-Key": `${db}-${i}` },
        body: JSON.stringify({
          pickup: from,
          pickupLat: points[from].lat,
          pickupLon: points[from].lon,
          drop: to,
          dropLat: points[to].lat,
          dropLon: points[to].lon,
          regionId: "rnsit",
        }),
      });
      // eslint-disable-next-line no-await-in-loop
      const body = await res.json().catch(() => ({}));
      const taskId = body.taskId || (body.task && body.task.taskId) || (body.data && body.data.taskId);
      say(`[http] POST /api/tasks/assign → ${res.status}${taskId ? ` ${taskId}` : ` ${JSON.stringify(body).slice(0, 200)}`}`);
      if (res.status >= 300 || !taskId) throw new Error("task request refused");
      taskIds.push(taskId);
    }

    const started = Date.now();
    let last = "";
    let done = false;
    while (Date.now() - started < TIMEOUT_S * 1000) {
      // eslint-disable-next-line no-await-in-loop
      const tasks = await prisma.task.findMany({ where: { taskId: { in: taskIds } }, select: { status: true } });
      const completed = tasks.filter((t) => t.status === "COMPLETED").length;
      // eslint-disable-next-line no-await-in-loop
      const commitments = await prisma.commitment.count();
      const line = `completed ${completed}/${taskIds.length}, commitments ${commitments}`;
      if (line !== last) say(`[watch +${Math.round((Date.now() - started) / 1000)}s] ${line}`);
      last = line;
      if (completed === taskIds.length) {
        done = true;
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(2000);
    }

    // The durable outcome.
    const legs = await prisma.leg.findMany({ select: { id: true, legId: true, state: true } });
    const commitments = await prisma.commitment.findMany({ select: { legId: true, agentId: true, releasedAt: true, grantedAt: true } });
    const rounds = await prisma.round.findMany({ select: { regime: true, budgets: true, outcome: true } });
    const doubleLive = legs.filter((leg) => commitments.filter((c) => c.legId === leg.id && !c.releasedAt).length > 1).length;
    const budgetLimited = rounds.filter((r) => r.budgets && r.budgets.budgetLimited).length;
    const result = {
      oneWayMs: ONE_WAY,
      tasks: taskIds.length,
      completed: done,
      elapsedS: Math.round((Date.now() - started) / 1000),
      legStates: legs.reduce((acc, leg) => ({ ...acc, [leg.state]: (acc[leg.state] || 0) + 1 }), {}),
      commitments: commitments.length,
      legsWithTwoLiveCommitments: doubleLive,
      rounds: rounds.length,
      budgetLimitedRounds: budgetLimited,
    };
    say(`RESULT ${JSON.stringify(result)}`);
    await prisma.$disconnect();
    return done && doubleLive === 0 ? 0 : 1;
  } finally {
    stop();
    fs.closeSync(log);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    say(`ERROR ${error.message}`);
    process.exit(2);
  });

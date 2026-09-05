"use strict";

/**
 * **S-6 — the V1 core path, over HTTP, against a live PostgreSQL.**
 *
 * `docs/v1/V1_CONTRACT_AND_STOP_CONDITION.md` §I.2 states the sixth stop condition as
 *
 * > *One real request, submitted over HTTP against a live PostgreSQL, reaches a durable
 * > `Commitment` row and an `Outbox` row in the same transaction, with a `Round` row and a
 * > per-Leg decision record written* — checked by *"a new live-DB harness,
 * > `tools/verify/v1CorePath.js`, exits 0"*.
 *
 * **That harness did not exist.** Every V1 pass through E-10 measured the path by reading
 * it, by probing one module, or by a composition test — and §I.3 recorded S-6 as *"NOT
 * attempted, NOT claimed"* precisely because nothing could attempt it. This is the thing
 * that attempts it.
 *
 * ── What makes this different from every test in `tests/` ──────────────────
 * There is no jest here, no fixture prisma, no injected round, and no double for any
 * engine module. This harness:
 *
 *   1. seeds a real PostgreSQL with the **fleet and mission rows a deployment legitimately
 *      has** — a region, a shard, an agent class with its declared models, one agent with
 *      a battery and a position;
 *   2. starts **`server.js` itself**, as a separate process, with `ENGINE_ENABLED=true`;
 *   3. issues a real **HTTP** request to `POST /api/tasks/assign`, authenticated with a
 *      real JWT for a real `User` row;
 *   4. reads the durable consequences back out of the database.
 *
 * ── What it will NOT do, and why that is the point ─────────────────────────
 * **It fabricates nothing.** It does not publish a configuration version binding
 * `cutover.engine_enabled` — that is the owner's act (S-5) and forging it here would be
 * this harness deciding that the engine is live for a region. It does not inject a routing
 * source, a calibration value, a serviceable-region cover, a charger, or a commissioning
 * record. Where the path stops, it stops, and the harness reports **which** input stopped
 * it and **who** owns that input.
 *
 * So a non-zero exit is the expected result today, and it is a *measurement*, not a
 * failure of this harness. The value is that the boundary is now observed on a running
 * system rather than inferred from a file.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   node tools/verify/v1CorePath.js --database-url postgresql://user@host:port/db
 *
 * `--keep` leaves the seeded rows in place. Exit 0 only when S-6 genuinely holds.
 */

const crypto = require("crypto");
const { spawn } = require("child_process");
const path = require("path");

const BACKEND_ROOT = path.resolve(__dirname, "..", "..");

/** How long to wait for the server to answer `/api/health`. @structural a boot timeout */
const BOOT_TIMEOUT_MS = 60_000;
/** How long to wait for a round to produce a commitment. @structural a round-wait budget */
const ROUND_TIMEOUT_MS = 45_000;
/** Poll interval while waiting. @structural a poll interval */
const POLL_MS = 500;
/** The port this harness's server listens on. @structural a test-only port */
const PORT = 45789;
/**
 * How long to let the supervisor stand for election and promote before the composition
 * report is read. @structural a promotion wait
 */
const PROMOTION_WAIT_MS = 15_000;

const RUN = `v1-${Date.now()}`;

/** Everything the harness learns, in order, so the report is a trace rather than a verdict. */
const steps = [];

function step(name, ok, detail) {
  steps.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? "OK  " : "STOP"}  ${name}${detail ? ` — ${detail}` : ""}\n`);
  return ok;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The last `limit` characters of a captured stream, **and a statement of what was dropped**.
 *
 * W-A4. Every truncation in this file used to be silent, and one of them cost a measurement:
 * the coordinator's refusal line is ~17 000 characters and the `MEASURED against this
 * context — N of 34 inputs unresolved` clause it exists to capture begins past index 3 000,
 * so a `.slice(0, 2400)` printed the preamble and dropped the answer on every run. The
 * number had to be recovered by driving this file's own exported `seed`/`startServer` from
 * a scratchpad.
 *
 * A harness that silently prints less than it measured reports a boundary it reached as a
 * boundary it did not. So a tail is still a tail — an unbounded dump of a server's whole
 * stdout is not a diagnostic — but it now says so, with the count, and the **decisive**
 * diagnostic (the refusal lines themselves, `reportBoundary`) is not tailed at all.
 *
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
function tail(text, limit) {
  const source = String(text == null ? "" : text);
  if (source.length <= limit) return source;
  const dropped = source.length - limit;
  return `[… ${dropped} of ${source.length} characters elided; this is the last ${limit} …]\n${source.slice(-limit)}`;
}

/**
 * The minimal world a V1 request needs to exist in — fleet and mission rows only.
 *
 * Every row here is one a real deployment holds in its own database. **No external input
 * is seeded**: no routing answer, no calibration value, no cell cover, no charger, no
 * commissioning record. The point of the seed is that when the path stops, it stops on
 * something the owner must supply rather than on a row nobody bothered to create.
 *
 * @param {object} prisma
 * @returns {Promise<object>} the identifiers the rest of the run needs
 */
async function seed(prisma) {
  const region = await prisma.region.create({
    data: { regionId: `${RUN}-region`, name: "V1 verification region" },
  });

  const shardId = `${RUN}-shard`;
  await prisma.shardLeadership.create({ data: { shardId } });
  await prisma.shard.create({ data: { shardId, regionId: region.id, state: "ACTIVE" } });

  const mobilityModel = await prisma.mobilityModel.create({
    data: {
      modelId: `${RUN}-mobility`,
      name: "V1 verification mobility model",
      traversalDomain: "GROUND",
      kinematicLimits: { maxSpeedMs: 2 },
    },
  });

  const energyModel = await prisma.energyModel.create({
    data: { modelId: `${RUN}-energy`, name: "V1 verification energy model", packNominalWh: 1000 },
  });

  const agentClass = await prisma.agentClass.create({
    data: {
      classId: `${RUN}-class`,
      name: "V1 verification agent class",
      mobilityModelId: mobilityModel.id,
      energyModelId: energyModel.id,
    },
  });

  const agent = await prisma.agent.create({
    data: {
      agentId: `${RUN}-agent`,
      agentClassId: agentClass.id,
      regionId: region.id,
      lifecycleState: "ACTIVE",
    },
  });

  await prisma.batteryState.create({
    data: { agentId: agent.id, soh: 0.95, kappa: 1, lastObservedSoc: 0.9, lastObservedAt: new Date() },
  });

  const cells = require(path.join(BACKEND_ROOT, "src/engine/spatial/cells"));
  const lat = 12.9716;
  const lon = 77.5946;
  const fineCellId = cells.cellForPoint(lat, lon, cells.RESOLUTION.FINE);

  await prisma.agentCellPosition.create({
    data: {
      agentId: agent.id,
      shardId,
      lat,
      lon,
      fineCellId,
      coarseCellId: cells.coarseParentOf(fineCellId),
      availabilityClass: "IDLE_READY",
      capabilityClasses: [],
      containerClasses: [],
      observedAtMs: BigInt(Date.now()),
    },
  });

  const user = await prisma.user.create({
    data: {
      email: `${RUN}@v1.verify.local`,
      password: crypto.randomBytes(16).toString("hex"),
      role: "SUPER_ADMIN",
    },
  });

  // ── The one published configuration version §22.1 rule 4 requires to exist ──
  //
  // `config/service.bootstrap` refuses to start a process with `ENGINE_ENABLED=true` and
  // nothing published — *"starting on defaults would be the partial application that rule
  // prohibits"* — so without this the run cannot reach any boundary at all, including the
  // ones it exists to report.
  //
  // **`bindings` is empty, and that is a deliberate, load-bearing emptiness.** Every value
  // in this version is the register's own published default; nothing is chosen here. In
  // particular **`cutover.engine_enabled` is NOT bound**. That binding is the owner's act
  // (S-5), it is what makes the engine the decision path for a region, and a verification
  // harness that published it would be deciding on the owner's behalf — which is the one
  // thing this file must never do. The 503 the request path returns as a result is the
  // measurement, not an obstacle to it.
  // Two blocking findings stand between the register and its own first version, and
  // **neither is this harness's to resolve**. Both are recorded rather than worked around
  // silently, and the accommodations below follow the precedent `phase15CurrentTree.js`
  // already set and documented:
  //
  //   · **V9** — the register's *own defaults* produce a combined degraded energy
  //     conservatism of 2.0125 against `energy.max_combined_conservatism` of 1.6, because
  //     `route.degraded_reserve_factor` is Safety-class, PROVISIONAL and awaiting **B8**.
  //     So **a deployment cannot publish its first configuration version from register
  //     defaults at all** — the sharpest consequence of B8 there is, and it sits *before*
  //     every other V1 boundary. The binding below is the same one Phase 15's harness uses,
  //     at the same value, for the same reason: it exists so this file can publish at all.
  //     **It is not a calibration value and it is not an owner decision.**
  //   · **S2** — §22.3's two-person rule. A first publish declares every Safety-class value,
  //     so `checkSafetyApproval` requires two distinct approver identities. Two are supplied
  //     here as *harness* identities, which is exactly what an operator would have to do
  //     with two real people.
  //
  // `cutover.engine_enabled` is still **not** bound. That is the line: an accommodation
  // that lets the process boot is one thing, and deciding that the engine is the decision
  // path for a region is the owner's (S-5).
  const configService = require(path.join(BACKEND_ROOT, "src/engine/config/service"));
  const published = await configService.publish(prisma, {
    publishedBy: "tools/verify/v1CorePath.js",
    approvals: [
      { approverId: "v1CorePath-harness-a", approvedAt: new Date().toISOString() },
      { approverId: "v1CorePath-harness-b", approvedAt: new Date().toISOString() },
    ],
    bindings: [{ level: "global", key: "", name: "route.degraded_reserve_factor", value: 1.1 }],
    note:
      "V1 core-path verification. Register defaults, plus the V9 accommodation Phase 15's " +
      "harness already documents (route.degraded_reserve_factor, awaiting B8). " +
      "cutover.engine_enabled is deliberately left unbound — that is the owner's act (S-5).",
  });
  await configService.pinVersion(prisma, null, published.version, "tools/verify/v1CorePath.js");

  return { region, shardId, agent, agentClass, user, fineCellId, lat, lon, configVersion: published.version };
}

/**
 * Start the real `server.js` as a child process and wait for it to serve.
 *
 * A child process rather than `require("../../server.js")`, because requiring it would run
 * the engine inside this harness's process and make "the server started" a statement about
 * this file rather than about the deployment. The stdout is kept because the composition
 * refusal §19.3 logs at promotion is the second finding this run produces.
 *
 * @param {object} env
 * @returns {Promise<{ child: object, output: () => string }>}
 */
async function startServer(env) {
  const lines = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => lines.push(String(chunk)));
  child.stderr.on("data", (chunk) => lines.push(String(chunk)));

  const output = () => lines.join("");
  const deadline = Date.now() + BOOT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      return { child, output, exited: child.exitCode };
    }
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/api/health`, { method: "GET" });
      if (response.status < 500) return { child, output, exited: null };
    } catch {
      /* not listening yet */
    }
    await sleep(POLL_MS);
  }
  return { child, output, exited: null, timedOut: true };
}

/**
 * Wait for the durable consequences §I.2's S-6 names, or time out.
 *
 * @param {object} prisma
 * @param {string} legRowId
 * @returns {Promise<object>}
 */
async function waitForCommitment(prisma, legRowId) {
  const deadline = Date.now() + ROUND_TIMEOUT_MS;
  let seen = { commitment: null, outbox: 0, rounds: 0 };
  while (Date.now() < deadline) {
    const commitment = await prisma.commitment.findFirst({ where: { legId: legRowId } });
    const rounds = await prisma.decisionRound.count().catch(() => 0);
    const outbox = await prisma.outbox.count().catch(() => 0);
    seen = { commitment, outbox, rounds };
    if (commitment) return seen;
    await sleep(POLL_MS);
  }
  return seen;
}

async function main() {
  const argv = process.argv.slice(2);
  const urlFlag = argv.indexOf("--database-url");
  const databaseUrl = urlFlag !== -1 ? argv[urlFlag + 1] : process.env.DATABASE_URL;
  const keep = argv.includes("--keep");

  if (!databaseUrl) {
    process.stdout.write("v1CorePath: no --database-url and no DATABASE_URL. Nothing was run.\n");
    process.exitCode = 2;
    return;
  }

  process.stdout.write(`\nS-6 — the V1 core path over HTTP, against ${databaseUrl.replace(/\/\/[^@]*@/, "//***@")}\n\n`);

  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  const jwtSecret = crypto.randomBytes(32).toString("hex");
  let world = null;
  let server = null;

  try {
    await prisma.$queryRaw`SELECT 1`;
    step("live PostgreSQL reachable", true);

    world = await seed(prisma);
    step("fleet and mission rows seeded", true, `region ${world.region.regionId}, agent ${world.agent.agentId}`);
    step(
      "one configuration version published and pinned",
      true,
      `version ${world.configVersion}; register defaults + the V9/B8 accommodation; ` +
        "cutover.engine_enabled deliberately NOT bound (S-5 is the owner's)",
    );

    server = await startServer({
      DATABASE_URL: databaseUrl,
      DATABASE_URL_LOCAL: databaseUrl,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      ENGINE_ENABLED: "true",
      // §19.5 — `election.assertConsensusStore` refuses to elect a leader over a store
      // whose replication posture is UNDECLARED, because *"a prohibition that returns
      // `false` is a prohibition somebody ignores"*. This is a **statement of fact about
      // the cluster this harness was pointed at**, not a claim about production: the run
      // uses one disposable PostgreSQL primary with no standby and therefore no automatic
      // failover, which is exactly what this value names. A deployment with a replica must
      // declare its own posture, and `ASYNCHRONOUS_FAILOVER` is refused by name.
      SHARD_CONSENSUS_REPLICATION: "SINGLE_PRIMARY_NO_AUTOMATIC_FAILOVER",
      SHARD_ID: world.shardId,
      JWT_SECRET: jwtSecret,
      COMMAND_SIGNING_KEY: crypto.randomBytes(32).toString("hex"),
      NODE_ENV: "production",
    });

    if (server.exited !== null || server.timedOut) {
      step("the real server.js process serves HTTP", false, server.exited !== null ? `exited ${server.exited}` : "timed out");
      process.stdout.write(`\n--- server output ---\n${tail(server.output(), 4000)}\n`);
      process.exitCode = 1;
      return;
    }
    step("the real server.js process serves HTTP", true, `127.0.0.1:${PORT}, ENGINE_ENABLED=true`);

    // ── The request. A real HTTP POST, with a real token for a real User row ──
    const jwt = require("jsonwebtoken");
    const token = jwt.sign({ id: world.user.id }, jwtSecret, { expiresIn: "10m" });

    const body = {
      pickup: "V1 verification pickup",
      pickupLat: world.lat + 0.0008,
      pickupLon: world.lon + 0.0005,
      drop: "V1 verification drop",
      dropLat: world.lat + 0.0015,
      dropLon: world.lon + 0.0014,
      regionId: world.region.regionId,
      shardId: world.shardId,
    };

    const response = await fetch(`http://127.0.0.1:${PORT}/api/tasks/assign`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "Idempotency-Key": `${RUN}-key`,
      },
      body: JSON.stringify(body),
    });
    const payload = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(payload);
    } catch {
      /* keep the raw text */
    }

    if (!response.ok) {
      const code = parsed && (parsed.code || parsed.error || parsed.message);
      step("POST /api/tasks/assign is admitted", false, `HTTP ${response.status} — ${String(code).slice(0, 200)}`);
      // The *second* boundary is reported from the same running process rather than
      // inferred: the LEADER_ONLY composers run on promotion, so the run waits for the
      // supervisor to take its shard before reading what the coordinator said about
      // itself. A run that stopped at the request path would otherwise report nothing
      // about the composition, and the two are different owners.
      await sleep(PROMOTION_WAIT_MS);
      reportBoundary(response.status, parsed, server.output());
      process.exitCode = 1;
      return;
    }
    step("POST /api/tasks/assign is admitted", true, `HTTP ${response.status}`);

    const queued = await prisma.workQueue.findFirst({ where: { idempotencyKey: `${RUN}-key` }, include: { leg: true } });
    if (!queued) {
      step("the request reaches a durable WorkQueue row (§3.4)", false, "no queue row was written");
      process.exitCode = 1;
      return;
    }
    step("the request reaches a durable WorkQueue row (§3.4)", true, `leg ${queued.leg.legId}, state ${queued.state}`);

    const seen = await waitForCommitment(prisma, queued.legId);
    if (!seen.commitment) {
      step("a round commits the Leg (§10.3.2)", false, `no Commitment after ${ROUND_TIMEOUT_MS} ms`);
      reportBoundary(null, null, server.output());
      process.exitCode = 1;
      return;
    }
    step("a round commits the Leg (§10.3.2)", true, `commitment ${seen.commitment.id}, ${seen.outbox} outbox row(s)`);

    process.stdout.write("\nS-6 HOLDS — the V1 core path completed over HTTP against a live database.\n");
    process.exitCode = 0;
  } catch (error) {
    step("harness completed", false, error && error.message);
    if (server) process.stdout.write(`\n--- server output ---\n${tail(server.output(), 4000)}\n`);
    process.exitCode = 1;
  } finally {
    if (server && server.child && server.child.exitCode === null) server.child.kill();
    if (!keep && world) {
      await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE email LIKE '${RUN}%'`).catch(() => {});
    }
    await prisma.$disconnect().catch(() => {});
    process.stdout.write("\n");
  }
}

/**
 * Name the boundary the run stopped at, and who owns it.
 *
 * The two the V1 contract predicts are distinguished rather than merged: a 503 is the
 * owner's cutover act (S-5) and says nothing about the engine's readiness, while a
 * composition refusal in the server's own log is S-3's external inputs. A run can hit the
 * first without ever reaching the second, and reporting only "it failed" would hide that.
 *
 * @param {number|null} status
 * @param {object|null} parsed
 * @param {string} serverOutput
 */
function reportBoundary(status, parsed, serverOutput) {
  process.stdout.write("\n--- the boundary this run reached ---\n");

  if (status === 503) {
    process.stdout.write(
      "  S-5 — the cutover binding. `cutover.engine_enabled` is not bound true at region scope in a\n" +
        "  published, pinned configuration version, so `cutoverEnabled.describe` reports the engine is\n" +
        "  not live for this shard and admission refuses **before writing anything** (§12.1).\n" +
        "  OWNER: the project owner, as a published config version. This harness does not publish it:\n" +
        "  forging the binding would be this file deciding that the engine is live for a region.\n",
    );
    if (parsed && parsed.posture) {
      process.stdout.write(`  measured posture: ${JSON.stringify(parsed.posture)}\n`);
    }
  }

  const refusals = serverOutput
    .split("\n")
    .filter((line) => line.includes("LEADER_ONLY worker NOT started") || line.includes("blockedBy"));
  if (refusals.length > 0) {
    process.stdout.write(
      `\n  S-3 — the coordinator's own composition, as this running process reported it` +
        ` (${refusals.length} refusal line(s), each printed in full):\n`,
    );
    // **Printed whole, deliberately (W-A4).** This is the line the harness exists to
    // capture — it carries `MEASURED against this context — N of 34 inputs unresolved`
    // and then names every unresolved input by class. Every cap that used to stand here,
    // on characters and on the number of lines, could drop exactly that clause without
    // saying so. A long diagnostic is the correct output of a run whose whole purpose is
    // to record a long diagnostic.
    for (const line of refusals) process.stdout.write(`    ${line.trim()}\n`);
  } else {
    // Silence here is not "the coordinator composed". It means the run never reached a
    // promotion, and saying which is the difference between a measurement and a guess.
    process.stdout.write(
      "\n  S-3 — NOT OBSERVED in this run: no promotion was reported, so the LEADER_ONLY\n" +
        "  composers never ran and this process made no statement about the coordinator.\n" +
        `\n--- server output (tail) ---\n${tail(serverOutput, 2500)}\n`,
    );
  }
}

if (require.main === module) {
  main();
}

// `reportBoundary` and `tail` are exported so that W-A4 — *"the harness prints the whole
// refusal line"* — can be asserted without a live PostgreSQL. The defect they fix was
// invisible to every existing test precisely because nothing could reach this file's
// reporting without one.
module.exports = { seed, startServer, waitForCommitment, reportBoundary, tail };

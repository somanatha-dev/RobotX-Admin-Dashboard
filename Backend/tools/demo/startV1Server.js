"use strict";

/**
 * **Start the real `server.js` as a V1 demonstration backend** — against a throwaway local
 * PostgreSQL only.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `Backend/.env` is the shared development configuration: `ENGINE_ENABLED=false` and a
 * `DATABASE_URL` that is the hosted Neon instance. The assignment engine's V1 path needs a
 * process configured quite differently, and until now only `tools/demo/runV1Assignment.js`
 * ever configured one — inside its own process, with its own socket server. This launcher
 * configures the actual `server.js` (the process the dashboard and the robots connect to)
 * the same way, **without editing `.env`**:
 *
 *     .env (unchanged) ──┐
 *                        ├─► process.env ──► preflight (read-only) ──► require("server.js")
 *     V1 values (here) ──┘   V1 values win: dotenv never overrides a variable already set
 *
 * ── What it sets ────────────────────────────────────────────────────────────
 *   DATABASE_URL, DATABASE_URL_LOCAL  the --database-url, after the loopback check
 *   REDIS_ENABLED=false, REDIS_URL="" never the hosted Redis in `.env`; in-memory KV
 *   ENGINE_ENABLED=true               the process half of the engine switch
 *   ENABLE_VIRTUAL_SIMULATOR=true     the in-process simulator (simulated robots)
 *   V1_DEMONSTRATION_COMPOSITION=true the V1 input providers (`v1DemonstrationComposition`)
 *   SHARD_CONSENSUS_REPLICATION       SINGLE_PRIMARY_NO_AUTOMATIC_FAILOVER — a true statement
 *                                     about one local PostgreSQL primary, nothing more
 *   SHARD_ID                          --shard-id (default v1demo-shard, the seed tool's)
 *   COMMAND_SIGNING_KEY               kept if already set; otherwise a random key for this
 *                                     process (OFFERs are still signed; nothing is unsigned)
 *   VERIFY_* (six)                    `v1DemonstrationConfig.VERIFICATION_THRESHOLDS`
 *   PORT / HOST                       only when --port / --host are given
 *
 * Everything else — JWT_SECRET, the §23.7 privacy secrets — comes from `.env` as usual, and
 * `server.js` itself refuses to boot an engine process whose privacy secret is invalid.
 *
 * ── What it checks before starting (read-only) ─────────────────────────────
 * The execution bindings, the region's cutover binding and the V1 world live in the
 * database's published configuration, not in the environment — `seedV1Demonstration.js`
 * publishes them. So the launcher reads the pinned version and refuses to start, naming
 * what is missing, when it lacks the V1 execution bindings or any region cutover, when the
 * shard is not published, or when there are no simulated robots. It writes nothing.
 *
 * ── What it is NOT ──────────────────────────────────────────────────────────
 * Not a second server, not a second engine, not a production switch. It changes no module
 * and no default; with the launcher unused, the repository behaves exactly as before.
 *
 * Usage:
 *   node tools/demo/seedV1Demonstration.js --database-url postgresql://…@127.0.0.1:<port>/<db> --fleet baseline
 *   node tools/demo/startV1Server.js       --database-url postgresql://…@127.0.0.1:<port>/<db>
 *        [--port 3000] [--host 127.0.0.1] [--shard-id v1demo-shard]
 */

const crypto = require("crypto");
const path = require("path");

// Dependency-free: nothing under `src/` has been required yet, so `.env` is not loaded yet.
const { assertDisposableLocal } = require("./disposableDatabase");
const demonstration = require("../config/v1DemonstrationConfig");

const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : argv[at + 1];
};

function refuse(message) {
  process.stderr.write(`\nV1 LAUNCHER REFUSED TO START — ${message}\n\n`);
  process.exit(2);
}

/* ── 1. The database: explicit, parsed, loopback, never `.env`'s ─────────────────── */
// Deliberately NOT read from DATABASE_URL: in this repository that variable is `.env`'s
// hosted Neon URL, and a launcher that fell back to it would be one missing flag away
// from enabling the engine against a shared database.
const databaseUrl = flag("--database-url", process.env.V1_DATABASE_URL || "");
try {
  assertDisposableLocal(databaseUrl, { purpose: "start the V1 engine" });
} catch (error) {
  refuse(`${error.message}\nThe V1 launcher requires a throwaway local database (--database-url or V1_DATABASE_URL).`);
}

/* ── 2. The V1 environment, set before `.env` is loaded so these values win ─────── */
const shardId = flag("--shard-id", "v1demo-shard");
const generatedSigningKey = !process.env.COMMAND_SIGNING_KEY;

Object.assign(process.env, {
  DATABASE_URL: databaseUrl,
  DATABASE_URL_LOCAL: databaseUrl,
  // Empty rather than deleted: an absent variable would be filled from `.env` (hosted Redis).
  REDIS_ENABLED: "false",
  REDIS_URL: "",
  ENGINE_ENABLED: "true",
  ENABLE_VIRTUAL_SIMULATOR: "true",
  V1_DEMONSTRATION_COMPOSITION: "true",
  SHARD_CONSENSUS_REPLICATION: "SINGLE_PRIMARY_NO_AUTOMATIC_FAILOVER",
  SHARD_ID: shardId,
  COMMAND_SIGNING_KEY: process.env.COMMAND_SIGNING_KEY || crypto.randomBytes(32).toString("hex"),
});
for (const [name, value] of Object.entries(demonstration.VERIFICATION_THRESHOLDS)) {
  process.env[name] = process.env[name] || value;
}
if (flag("--port", null)) process.env.PORT = flag("--port", null);
if (flag("--host", null)) process.env.HOST = flag("--host", null);

// Now `.env` may load. dotenv does not override, so every value above survives; this is
// re-checked rather than assumed.
require(path.join(BACKEND_ROOT, "src/config/env"));
for (const name of ["DATABASE_URL", "DATABASE_URL_LOCAL"]) {
  try {
    assertDisposableLocal(process.env[name], { purpose: "start the V1 engine" });
  } catch (error) {
    refuse(`${name} changed after .env was loaded: ${error.message}`);
  }
}
if (process.env.REDIS_URL !== "" || process.env.REDIS_ENABLED !== "false") {
  refuse("the Redis settings changed after .env was loaded; the V1 launcher runs on the in-memory KV only");
}

/* ── 3. Preflight: is this database a seeded V1 world? (read-only) ──────────────── */
async function preflight() {
  const { PrismaClient } = require(path.join(BACKEND_ROOT, "node_modules/@prisma/client"));
  const configService = require(path.join(BACKEND_ROOT, "src/engine/config/service"));
  const cutoverEnabled = require(path.join(BACKEND_ROOT, "src/engine/cutover/enabled"));
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const problems = [];
  try {
    const pinned = await configService.loadPinnedSnapshot({ prisma });
    if (!pinned) {
      problems.push("no configuration version is published and pinned");
    } else {
      for (const binding of demonstration.executionBindings()) {
        const actual = pinned.values.get(binding.name);
        if (JSON.stringify(actual) !== JSON.stringify(binding.value)) {
          problems.push(
            `pinned version ${pinned.version} does not carry the V1 execution binding ${binding.name}=` +
              `${JSON.stringify(binding.value)} (it resolves to ${JSON.stringify(actual)})`,
          );
        }
      }
    }
    const regions = await prisma.region.findMany({ select: { id: true, regionId: true } });
    const live = pinned ? regions.filter((region) => cutoverEnabled.configEnabled(pinned, { regionId: region.id })) : [];
    if (live.length === 0) problems.push("no region has cutover.engine_enabled bound in the pinned version");

    const shard = await prisma.shard.findUnique({ where: { shardId }, select: { regionId: true } });
    if (!shard) problems.push(`shard "${shardId}" is not published (--shard-id must name the seeded shard)`);

    const simulated = await prisma.robot.count({ where: { simulated: true } });
    if (simulated === 0) problems.push("there are no simulated robots");

    return { problems, version: pinned && pinned.version, liveRegions: live.map((r) => r.regionId), simulated };
  } finally {
    await prisma.$disconnect();
  }
}

preflight()
  .then((result) => {
    if (result.problems.length > 0) {
      refuse(
        `this database is not a seeded V1 world:\n  - ${result.problems.join("\n  - ")}\n` +
          "Seed it first: node tools/demo/seedV1Demonstration.js --database-url <url> --fleet baseline",
      );
    }
    const target = new URL(databaseUrl);
    process.stdout.write(
      "═══════════════════════════════════════════════════════════════════════\n" +
        " V1 DEMONSTRATION BACKEND — the real server.js, the real engine. NOT PRODUCTION.\n" +
        `   database      ${target.hostname}:${target.port}${target.pathname} (loopback, checked)\n` +
        `   config        pinned version ${result.version}; engine live for region(s) ${result.liveRegions.join(", ")}\n` +
        `   shard         ${shardId}   simulated robots ${result.simulated}\n` +
        "   engine        ENGINE_ENABLED=true  V1_DEMONSTRATION_COMPOSITION=true  ENABLE_VIRTUAL_SIMULATOR=true\n" +
        `   signing key   ${generatedSigningKey ? "generated for this process" : "from the environment"}\n` +
        "   redis         disabled (in-memory KV)\n" +
        "═══════════════════════════════════════════════════════════════════════\n",
    );
    require(path.join(BACKEND_ROOT, "server.js"));
  })
  .catch((error) => refuse(`preflight could not read the database: ${error.message}`));

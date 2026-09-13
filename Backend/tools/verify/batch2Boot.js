"use strict";

/**
 * BATCH 2 — does the **composition root** actually wire any of this up?
 *
 * ── Why this is a separate instrument ───────────────────────────────────────
 * Everything else in this batch is verified through its own module or through a harness
 * that builds the collaborators itself. Neither can answer the question this programme has
 * got wrong most often: *is it called from `server.js`?* `tools/gates/checkCompositionRoot.js`
 * answers it by reading the source for a `require` and a `.start(`, which is a textual
 * proxy — it cannot tell a `start()` behind a condition that is never true from one that
 * runs.
 *
 * So this boots the real `server.js`, as a child process, against a disposable database
 * with the simulator enabled and `ENGINE_ENABLED` off — the development-simulation posture
 * Batch 2 targets — and then asks the database what happened. Three facts, none of which
 * any unit test can establish:
 *
 *   1. the development charger and its availability projection were **provisioned at
 *      boot**, by `SimulationEngine.provisionCharging` reached from `server.js`;
 *   2. the **index maintainer is running** — it is started outside the `ENGINE_ENABLED`
 *      gate, and a sweep really happens on its own timer;
 *   3. the process **shuts down cleanly**, which is the half that fails when an interval
 *      outlives `disconnectPrisma()`.
 *
 * ── What it does NOT claim ──────────────────────────────────────────────────
 * No robot is commissioned, so no charging session occurs here; that is
 * `batch2ChargingScheduler.js`'s subject. Nothing here is physical evidence, and no V1
 * stop condition is touched — `ENGINE_ENABLED` is deliberately false, which is the state
 * S-5 describes.
 *
 *   node tools/verify/batch2Boot.js "postgresql://user@127.0.0.1:55432/db"
 */

const url = process.argv[2];
if (!url) {
  process.stderr.write("usage: node tools/verify/batch2Boot.js <postgres-url>\n");
  process.exit(2);
}
if (/neon\.tech/i.test(url)) {
  process.stderr.write("refused: this tool boots a server against the given database and must never use shared infrastructure\n");
  process.exit(2);
}

const path = require("path");
const { spawn } = require("child_process");
const { PrismaClient } = require("@prisma/client");

const BACKEND_ROOT = path.join(__dirname, "..", "..");

const checks = [];
let failures = 0;
function record(name, ok, detail) {
  checks.push({ name, ok });
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const admin = new PrismaClient({ datasources: { db: { url } } });
  await admin.$connect();

  process.stdout.write("\nBATCH 2 — the composition root, booted for real\n");
  process.stdout.write("  DEVELOPMENT SIMULATION posture: ENABLE_VIRTUAL_SIMULATOR=true, ENGINE_ENABLED=false\n");

  for (const table of ["ChargerReservation", "ChargerAvailabilityProjection", "Charger", "AgentCellPosition"]) {
    await admin.$executeRawUnsafe(`DELETE FROM "${table}"`).catch(() => {});
  }

  const child = spawn(process.execPath, [path.join(BACKEND_ROOT, "server.js")], {
    cwd: BACKEND_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: url,
      PORT: "45911",
      ENABLE_VIRTUAL_SIMULATOR: "true",
      DISABLE_VIRTUAL_SIMULATOR: "",
      ENGINE_ENABLED: "false",
      REDIS_ENABLED: "false",
      REDIS_URL: "",
      JWT_SECRET: "batch2-boot-secret",
      NODE_ENV: "development",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk.toString(); });
  child.stderr.on("data", (chunk) => { log += chunk.toString(); });

  // Boot, then two sweep intervals (5 s each) so a running maintainer has demonstrably run.
  await sleep(18_000);

  try {
    const chargers = await admin.$queryRawUnsafe(`SELECT "chargerId" FROM "Charger"`);
    record(
      "the development charger was provisioned AT BOOT by the composition root",
      chargers.length === 1 && chargers[0].chargerId === "DEV-SIM-RNSIT-MBA-01",
      chargers.map((c) => c.chargerId).join(", ") || "none",
    );

    const projections = await admin.$queryRawUnsafe(
      `SELECT "version","publishedBy", ("payload"->'chargers'->0->>'plugCount')::int AS plugs
         FROM "ChargerAvailabilityProjection"`,
    );
    record(
      "its availability projection was published, with three plugs",
      projections.length === 1 && projections[0].plugs === 3,
      projections.length ? `v${projections[0].version} by ${projections[0].publishedBy}, ${projections[0].plugs} plug(s)` : "none",
    );

    record(
      "the simulator reported the scheduler ready, and labelled it development simulation",
      /development charging scheduler ready/i.test(log) && /DEVELOPMENT SIMULATION/i.test(log),
    );

    record(
      "the index maintainer was STARTED outside the ENGINE_ENABLED gate",
      /Availability index maintainer started \(development simulation\)/i.test(log),
    );

    // Asserted on the part of the note the logger actually EMITS. `config/logger` elides
    // long fields (`…+61`), so the tail of the note — "this closes no V1 stop condition and
    // is not physical evidence" — is in the code and not on stdout. Checking for text the
    // logger truncates away would be a check that can only ever fail, and quietly dropping
    // the check would leave the claim unasserted; so it is made against the visible half,
    // which is the half that carries the operational meaning.
    record(
      "…and it says that uncovered agents are NOT indexed",
      /Agents no Charging Scheduler covers are NOT indexed/i.test(log),
    );

    record(
      "the engine workers were NOT started — ENGINE_ENABLED is false",
      /Engine workers not started/i.test(log),
    );

    // A running maintainer sweeps every 5 s. With no agents there is nothing to index, and
    // the decisive fact is that it ran without throwing: an unhandled sweep error is logged
    // by `onError` and would appear here.
    record(
      "no index maintainer sweep failed",
      !/Index maintainer sweep failed/i.test(log),
    );

    record(
      "no charging reservation was created — no robot was commissioned",
      (await admin.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "ChargerReservation"`))[0].n === 0,
    );

    // Clean shutdown: the half that fails when a 5 s interval outlives disconnectPrisma().
    child.kill("SIGTERM");
    const exited = await Promise.race([
      new Promise((resolve) => child.once("exit", (code) => resolve(code))),
      sleep(20_000).then(() => "TIMEOUT"),
    ]);
    record(
      "the process shut down cleanly — the maintainer's interval does not outlive it",
      exited !== "TIMEOUT",
      exited === "TIMEOUT" ? "still running after 20 s" : `exit ${exited}`,
    );
  } finally {
    if (!child.killed) child.kill("SIGKILL");
    await admin.$disconnect().catch(() => {});
  }

  if (failures > 0) process.stdout.write(`\n--- server log ---\n${log}\n`);
  process.stdout.write(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks.length - failures}/${checks.length} checks\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`\nharness crashed: ${error && error.stack}\n`);
  process.exit(1);
});

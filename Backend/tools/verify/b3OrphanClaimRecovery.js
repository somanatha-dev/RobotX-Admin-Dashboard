"use strict";

/**
 * B3 on a real PostgreSQL: recovery of a queue claim left CLAIMED by a coordinator that died
 * between `claimBatch` and `settleBatch`, raced against the things that can touch the same
 * rows. The in-memory cases are `tests/engine/coordinatorClaimRecovery.test.js`; this is the
 * part only real row locks can show.
 *
 * Input: a disposable database captured right after the crash, holding exactly one WorkQueue
 * row CLAIMED by a round that has no Round row, its Leg QUEUED, no commitment. Every scenario
 * runs on its own `CREATE DATABASE … TEMPLATE` copy, so each starts from that state.
 *
 *   S1  the orphan is released, then claimed by the next round
 *   S2  two recoveries in two clients at once: exactly one releases it
 *   S3  a commit holding the Leg lock and inserting a live Commitment: recovery waits for the
 *       lock, then sends the row to SOLVED, never QUEUED
 *   S4  a leadership change holding the ShardLeadership row and advancing the fence: recovery
 *       waits, then refuses, and the row is untouched
 *   S5  the recovering process is killed inside its transaction: nothing is written, and the
 *       next recovery releases the row
 *   S6  the dead round's late settlement after recovery and a fresh claim: a no-op
 *
 * Usage:
 *   node tools/verify/b3OrphanClaimRecovery.js --template <db> \
 *        --server postgresql://<user>@127.0.0.1:<port>   (loopback, never 5432, never Neon)
 */

const path = require("path");
const { spawn } = require("child_process");

const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const { assertDisposableLocal } = require(path.join(BACKEND_ROOT, "tools/demo/disposableDatabase"));

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? null : argv[at + 1];
};

const SHARD_ID = process.env.SHARD_ID || "v1demo-shard";

if (process.argv[2] === "--child-recover") {
  // S5's victim: run one recovery against the given database and never finish it on purpose.
  const url = process.argv[3];
  const fence = process.argv[4];
  process.env.DATABASE_URL = url;
  const { PrismaClient } = require(path.join(BACKEND_ROOT, "node_modules/@prisma/client"));
  const coordinator = require(path.join(BACKEND_ROOT, "src/workers/coordinator.worker"));
  const { selectForUpdate } = require(path.join(BACKEND_ROOT, "src/db/prisma"));
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  process.stdout.write("CHILD_STARTED\n");
  coordinator
    .recoverOrphanedClaims({ prisma, selectForUpdate }, { shardId: SHARD_ID, storeTime: new Date(), leadershipFence: BigInt(fence) })
    .then((outcome) => process.stdout.write(`CHILD_DONE ${JSON.stringify(outcome)}\n`));
} else {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}

async function main() {
  const template = flag("--template");
  const server = flag("--server");
  if (!template || !server) throw new Error("usage: --template <db> --server postgresql://user@127.0.0.1:<port>");
  assertDisposableLocal(`${server}/${template}`, { purpose: "run the B3 claim-recovery races" });

  process.env.DATABASE_URL = `${server}/${template}`;
  const { PrismaClient } = require(path.join(BACKEND_ROOT, "node_modules/@prisma/client"));
  const coordinator = require(path.join(BACKEND_ROOT, "src/workers/coordinator.worker"));
  const leadership = require(path.join(BACKEND_ROOT, "src/engine/shard/leadership"));
  const intake = require(path.join(BACKEND_ROOT, "src/engine/intake/intake"));
  const roundModel = require(path.join(BACKEND_ROOT, "src/engine/solve/round"));
  const { selectForUpdate } = require(path.join(BACKEND_ROOT, "src/db/prisma"));

  const admin = new PrismaClient({ datasources: { db: { url: `${server}/postgres` } } });
  const clientFor = (db) => new PrismaClient({ datasources: { db: { url: `${server}/${db}` } } });
  const results = [];
  const check = (scenario, name, ok, detail) => {
    results.push({ scenario, name, ok });
    process.stdout.write(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}\n`);
  };

  async function scenario(id, title, body) {
    const db = `b3_${id.toLowerCase()}_${Date.now()}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${db}" TEMPLATE "${template}"`);
    const a = clientFor(db);
    const b = clientFor(db);
    process.stdout.write(`\n${id}  ${title}\n`);
    try {
      const row = await a.workQueue.findFirst({ where: { state: intake.QUEUE_STATE.CLAIMED } });
      if (!row) throw new Error(`template ${template} holds no CLAIMED row`);
      const fence = (await a.shardLeadership.findUnique({ where: { shardId: SHARD_ID } })).leadershipFence;
      const recover = (client, pinned = fence) =>
        coordinator.recoverOrphanedClaims({ prisma: client, selectForUpdate }, { shardId: SHARD_ID, storeTime: new Date(), leadershipFence: pinned });
      await body({ a, b, db, row, fence, recover });
    } finally {
      await a.$disconnect();
      await b.$disconnect();
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    }
  }

  const reread = (client, row) => client.workQueue.findUnique({ where: { id: row.id } });

  await scenario("S1", "orphan released, then claimed by the next round", async ({ a, row, recover }) => {
    const leg = await a.leg.findUnique({ where: { id: row.legId } });
    check("S1", "starting state is the crash: CLAIMED, Leg QUEUED, no Round row, no commitment",
      row.state === "CLAIMED" && leg.state === "QUEUED" &&
      (await a.round.count({ where: { roundId: row.claimedByRoundId } })) === 0 &&
      (await a.commitment.count({ where: { legId: row.legId } })) === 0,
      `claimedBy=${row.claimedByRoundId} v${row.version}`);
    const outcome = await recover(a);
    const after = await reread(a, row);
    check("S1", "released to QUEUED with version+1", outcome.requeued === 1 && after.state === "QUEUED" && after.version === row.version + 1 && after.claimedByRoundId === null, JSON.stringify(outcome));
    const claimed = await coordinator.claimBatch({ prisma: a }, { shardId: SHARD_ID, roundId: `${SHARD_ID}:next`, storeTime: new Date(), limit: 10 });
    check("S1", "the next round's claimBatch takes it", claimed.length === 1 && claimed[0].legId === row.legId);
  });

  await scenario("S2", "two recoveries at once, two clients", async ({ a, b, row, recover }) => {
    const [x, y] = await Promise.all([recover(a), recover(b)]);
    const after = await reread(a, row);
    check("S2", "exactly one release; the other saw the row changed",
      x.requeued + y.requeued === 1 && [...x.left, ...y.left].every((entry) => entry.reason === "ROW_CHANGED") && after.version === row.version + 1,
      `a=${JSON.stringify(x)} b=${JSON.stringify(y)}`);
  });

  await scenario("S3", "a commit holds the Leg lock and creates a live commitment", async ({ a, b, row, fence, recover }) => {
    const agent = await a.agent.findFirst();
    let lockHeld;
    const held = new Promise((resolve) => { lockHeld = resolve; });
    const commit = a.$transaction(async (tx) => {
      await selectForUpdate(tx, "Leg", "id", row.legId);
      lockHeld();
      await tx.$executeRawUnsafe(
        `INSERT INTO "Commitment"(id,"commitmentId","agentId","legId",fence,"leaseExpiry") VALUES (gen_random_uuid()::text, $1, $2, $3, $4, now() + interval '5 minutes')`,
        `b3-s3-${Date.now()}`, agent.id, row.legId, BigInt(fence),
      );
      await tx.$executeRawUnsafe(`UPDATE "Leg" SET state='OFFERED', version=version+1 WHERE id=$1`, row.legId);
      await tx.$executeRawUnsafe("SELECT pg_sleep(1.5)");
    }, { timeout: 10_000 });
    await held;
    const started = Date.now();
    const outcome = await recover(b);
    const waited = Date.now() - started;
    await commit;
    const after = await reread(a, row);
    check("S3", "recovery waited for the commit's Leg lock", waited >= 1200, `${waited} ms`);
    check("S3", "row → SOLVED, never QUEUED; Leg keeps the commit's state",
      outcome.solved === 1 && outcome.requeued === 0 && after.state === "SOLVED" && (await a.leg.findUnique({ where: { id: row.legId } })).state === "OFFERED",
      JSON.stringify(outcome));
    const claimed = await coordinator.claimBatch({ prisma: a }, { shardId: SHARD_ID, roundId: `${SHARD_ID}:next`, storeTime: new Date(), limit: 10 });
    check("S3", "nothing claimable: the committed Leg cannot be assigned twice", claimed.length === 0);
  });

  await scenario("S4", "a leadership change holds the leadership row and advances the fence", async ({ a, b, row, fence, recover }) => {
    let lockHeld;
    const held = new Promise((resolve) => { lockHeld = resolve; });
    const takeover = a.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT "shardId" FROM "ShardLeadership" WHERE "shardId" = $1 FOR UPDATE', SHARD_ID);
      lockHeld();
      await tx.$executeRawUnsafe('UPDATE "ShardLeadership" SET "leadershipFence" = "leadershipFence" + 1, holder = $2 WHERE "shardId" = $1', SHARD_ID, "new-leader");
      await tx.$executeRawUnsafe("SELECT pg_sleep(1.5)");
    }, { timeout: 10_000 });
    await held;
    const started = Date.now();
    const outcome = await recover(b, fence);
    const waited = Date.now() - started;
    await takeover;
    const after = await reread(a, row);
    check("S4", "recovery waited for the leadership change", waited >= 1200, `${waited} ms`);
    check("S4", "refused on the advanced fence; the claim is untouched",
      outcome.refusal === "LEADERSHIP_FENCE_ADVANCED" && outcome.requeued === 0 && after.state === "CLAIMED" && after.version === row.version,
      JSON.stringify(outcome));
    const newFence = (await leadership.readLeadershipFence(a, SHARD_ID));
    const asNewLeader = await recover(a, newFence);
    check("S4", "the new leader's own recovery then releases it", asNewLeader.requeued === 1, `fence ${fence} → ${newFence}`);
  });

  await scenario("S5", "the recovering process dies inside its transaction", async ({ a, db, row, fence, recover }) => {
    let lockHeld;
    let release;
    const held = new Promise((resolve) => { lockHeld = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    // Something else holds the Leg lock, so the child blocks inside its recovery transaction.
    const blocker = a.$transaction(async (tx) => {
      await selectForUpdate(tx, "Leg", "id", row.legId);
      lockHeld();
      await gate;
    }, { timeout: 20_000 });
    await held;
    const child = spawn(process.execPath, [__filename, "--child-recover", `${server}/${db}`, String(fence)], { stdio: ["ignore", "pipe", "pipe"] });
    let childOut = "";
    child.stdout.on("data", (chunk) => { childOut += chunk; });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    child.kill();
    await new Promise((resolve) => child.on("exit", resolve));
    release();
    await blocker;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const afterKill = await reread(a, row);
    check("S5", "child was inside recovery and was killed before finishing", childOut.includes("CHILD_STARTED") && !childOut.includes("CHILD_DONE"));
    check("S5", "nothing was written by the killed recovery", afterKill.state === "CLAIMED" && afterKill.version === row.version);
    const outcome = await recover(a);
    check("S5", "the next recovery releases it", outcome.requeued === 1, JSON.stringify(outcome));
  });

  await scenario("S6", "the dead round's settlement arrives after recovery and a fresh claim", async ({ a, row, recover }) => {
    await recover(a);
    const fresh = await coordinator.claimBatch({ prisma: a }, { shardId: SHARD_ID, roundId: `${SHARD_ID}:live`, storeTime: new Date(), limit: 10 });
    const late = await coordinator.settleBatch({ prisma: a }, {
      claimed: [row],
      storeTime: new Date(),
      result: { decisions: [{ legId: row.legId, outcome: roundModel.LEG_OUTCOME.ASSIGNED }], committed: [{ legId: row.legId }] },
    });
    const after = await reread(a, row);
    check("S6", "the late settlement changed nothing; the live claim stands",
      after.state === "CLAIMED" && after.claimedByRoundId === `${SHARD_ID}:live` && after.version === fresh[0].version,
      `late=${JSON.stringify(late)}`);
  });

  await admin.$disconnect();
  const failed = results.filter((entry) => !entry.ok);
  process.stdout.write(`\nRESULT: ${failed.length === 0 ? "PASS" : "FAIL"} — ${results.length - failed.length}/${results.length} checks\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

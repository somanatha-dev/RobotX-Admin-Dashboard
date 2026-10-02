"use strict";

/**
 * B1 — queue claim and settlement races on a REAL PostgreSQL. **Test-only.**
 *
 * The in-memory cases are `tests/engine/b1ClaimSettle.test.js`; this is the part only real
 * statements on separate connections can show. Each scenario runs on its own
 * `CREATE DATABASE … TEMPLATE` copy of a captured world (QUEUED rows, no round run), with the
 * `coordinator.worker` of the chosen source tree — so the same script measures the pre-B1
 * one-row-at-a-time code and the grouped code.
 *
 *   R1  K claimers on K connections at once: claims are disjoint, every claimable row is
 *       claimed exactly once, and each CLAIMED row names the round that returned it
 *   R2  a claimer that read the queue before another claimed it writes nothing (CAS) and
 *       returns nothing
 *   R3  two settlements of the same claim at once: exactly one applies, the replay is a no-op
 *   R4  settlement racing B3's recovery of the same claim (its round not live in the
 *       recovering process): every row ends in exactly one legal state, versions advanced once
 *       per applied write, and no row is left CLAIMED
 *
 * Usage:
 *   node tools/verify/b1/claimSettleRaces.js --root <tree> --template <worldDb>
 *        [--server postgresql://pgverify@127.0.0.1:55720] [--claimers 4]
 */

const { spawnSync } = require("child_process");
const path = require("path");

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const ROOT = path.resolve(arg("--root", "."));
const TEMPLATE = arg("--template");
const SERVER = new URL(arg("--server", "postgresql://pgverify@127.0.0.1:55720"));
const CLAIMERS = Number(arg("--claimers", "4"));
const PG_BIN = process.env.PG_BIN || "C:/Program Files/PostgreSQL/18/bin";
if (!["127.0.0.1", "localhost"].includes(SERVER.hostname) || SERVER.port === "5432" || SERVER.port === "") {
  throw new Error("claimSettleRaces: loopback disposable cluster only");
}

const { PrismaClient } = require("@prisma/client");
const coordinator = require(path.join(ROOT, "src/workers/coordinator.worker.js"));
const round = require(path.join(ROOT, "src/engine/solve/round.js"));
const dbModule = require(path.join(ROOT, "src/db/prisma.js"));
const leadership = require(path.join(ROOT, "src/engine/shard/leadership.js"));

const pg = (tool, ...rest) => {
  const out = spawnSync(path.join(PG_BIN, tool), ["-h", SERVER.hostname, "-p", SERVER.port, "-U", SERVER.username, ...rest], { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`${tool}: ${out.stderr}`);
};

async function fresh(name) {
  const db = `b1race_${name}`.toLowerCase();
  pg("dropdb.exe", "--if-exists", db);
  pg("createdb.exe", "-T", TEMPLATE, db);
  const url = `postgresql://${SERVER.username}@127.0.0.1:${SERVER.port}/${db}`;
  const clients = Array.from({ length: CLAIMERS + 1 }, () => new PrismaClient({ datasources: { db: { url } } }));
  await Promise.all(clients.map((c) => c.$connect()));
  const admin = clients[0];
  const shard = await admin.workQueue.findFirst({ select: { shardId: true } });
  const storeTime = (await admin.$queryRawUnsafe('SELECT NOW() AS "now"'))[0].now;
  return { db, clients, admin, shardId: shard.shardId, storeTime, close: () => Promise.all(clients.map((c) => c.$disconnect())) };
}

const results = [];
const check = (scenario, ok, detail) => {
  results.push({ scenario, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${scenario}  ${JSON.stringify(detail)}`);
};

async function r1() {
  const w = await fresh("r1");
  const claimable = await w.admin.workQueue.count({ where: { shardId: w.shardId, state: "QUEUED" } });
  const claims = await Promise.all(
    w.clients.slice(1).map((client, i) =>
      coordinator.claimBatch({ prisma: client }, { shardId: w.shardId, roundId: `race-r1-${i}`, storeTime: w.storeTime, limit: 500 }),
    ),
  );
  const all = claims.flat().map((row) => row.id);
  const rows = await w.admin.workQueue.findMany({ where: { shardId: w.shardId } });
  const claimedRows = rows.filter((row) => row.state === "CLAIMED");
  const namesOwner = claimedRows.every((row) => claims.some((c, i) => c.some((x) => x.id === row.id) && row.claimedByRoundId === `race-r1-${i}`));
  check("R1 concurrent claimers are disjoint and complete", new Set(all).size === all.length && all.length === claimable && claimedRows.length === claimable && namesOwner, {
    claimable,
    perClaimer: claims.map((c) => c.length),
    duplicates: all.length - new Set(all).size,
    claimedRows: claimedRows.length,
  });
  await w.close();
}

async function r2() {
  const w = await fresh("r2");
  // A claimer that read the queue, then lost every row to another before writing.
  const stale = w.clients[1];
  const readFirst = stale.workQueue.findMany.bind(stale.workQueue);
  let gate;
  const released = new Promise((r) => (gate = r));
  stale.workQueue.findMany = async (q) => {
    const read = await readFirst(q);
    stale.workQueue.findMany = readFirst;
    await released;
    return read;
  };
  const late = coordinator.claimBatch({ prisma: stale }, { shardId: w.shardId, roundId: "race-r2-late", storeTime: w.storeTime, limit: 500 });
  await new Promise((r) => setTimeout(r, 300));
  const first = await coordinator.claimBatch({ prisma: w.clients[2] }, { shardId: w.shardId, roundId: "race-r2-first", storeTime: w.storeTime, limit: 500 });
  gate();
  const lateClaimed = await late;
  const byLate = await w.admin.workQueue.count({ where: { claimedByRoundId: "race-r2-late" } });
  check("R2 a claimer that read before another claimed writes nothing", lateClaimed.length === 0 && byLate === 0 && first.length > 0, {
    first: first.length,
    late: lateClaimed.length,
    rowsNamingLate: byLate,
  });
  await w.close();
}

function settlementFor(claimed) {
  // Half assigned+committed, a quarter deferred, the rest undecided (requeued).
  const decisions = [];
  const committed = [];
  claimed.forEach((row, i) => {
    if (i % 4 === 0 || i % 4 === 1) {
      decisions.push({ legId: row.legId, outcome: round.LEG_OUTCOME.ASSIGNED });
      if (i % 4 === 0) committed.push({ legId: row.legId });
    } else if (i % 4 === 2) decisions.push({ legId: row.legId, outcome: round.LEG_OUTCOME.DEFERRED });
  });
  return { decisions, committed };
}

async function r3() {
  const w = await fresh("r3");
  const claimed = await coordinator.claimBatch({ prisma: w.clients[1] }, { shardId: w.shardId, roundId: "race-r3", storeTime: w.storeTime, limit: 500 });
  const result = settlementFor(claimed);
  await Promise.all([
    coordinator.settleBatch({ prisma: w.clients[1] }, { claimed, result, storeTime: w.storeTime }),
    coordinator.settleBatch({ prisma: w.clients[2] }, { claimed, result, storeTime: w.storeTime }),
  ]);
  const rows = await w.admin.workQueue.findMany({ where: { id: { in: claimed.map((r) => r.id) } } });
  const advancedOnce = rows.every((row) => row.version === claimed.find((c) => c.id === row.id).version + 1);
  const noneClaimed = rows.every((row) => row.state !== "CLAIMED");
  const deferredOnce = rows
    .filter((row) => result.decisions.some((d) => d.legId === row.legId && d.outcome === round.LEG_OUTCOME.DEFERRED))
    .every((row) => row.consecutiveDeferrals === claimed.find((c) => c.id === row.id).consecutiveDeferrals + 1);
  check("R3 two settlements of one claim: exactly one applies", advancedOnce && noneClaimed && deferredOnce, {
    rows: rows.length,
    states: rows.reduce((acc, row) => ({ ...acc, [row.state]: (acc[row.state] || 0) + 1 }), {}),
  });
  await w.close();
}

async function r4() {
  const w = await fresh("r4");
  const claimed = await coordinator.claimBatch({ prisma: w.clients[1] }, { shardId: w.shardId, roundId: "race-r4-dead", storeTime: w.storeTime, limit: 500 });
  const fence = (await leadership.readLeadership(w.admin, w.shardId)).leadershipFence;
  const result = settlementFor(claimed);
  const [, recovery] = await Promise.all([
    coordinator.settleBatch({ prisma: w.clients[1] }, { claimed, result, storeTime: w.storeTime }),
    coordinator.recoverOrphanedClaims(
      { prisma: w.clients[2], selectForUpdate: dbModule.selectForUpdate },
      { shardId: w.shardId, storeTime: w.storeTime, leadershipFence: fence },
    ),
  ]);
  const rows = await w.admin.workQueue.findMany({ where: { id: { in: claimed.map((r) => r.id) } } });
  const legal = rows.every((row) => ["QUEUED", "SOLVED"].includes(row.state));
  const oneWrite = rows.every((row) => row.version === claimed.find((c) => c.id === row.id).version + 1);
  check("R4 settlement racing B3 recovery: one legal outcome per row", legal && oneWrite, {
    rows: rows.length,
    states: rows.reduce((acc, row) => ({ ...acc, [row.state]: (acc[row.state] || 0) + 1 }), {}),
    recovery: { requeued: recovery.requeued, solved: recovery.solved, left: recovery.left.length, refusal: recovery.refusal },
  });
  await w.close();
}

(async () => {
  for (const scenario of [r1, r2, r3, r4]) {
    // eslint-disable-next-line no-await-in-loop
    await scenario();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} PASS  (root ${ROOT})`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(2);
});

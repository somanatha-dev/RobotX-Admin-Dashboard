"use strict";

/**
 * STEP 1 (tests first) — GROUP 6: can a FUTURE leadership-first commit coexist with everything
 * else that locks the same rows? On a real PostgreSQL. **Verification tooling only**: the
 * commit transaction is NOT changed, and nothing in `src/` requires this file.
 *
 * The candidate order (Step 1 report, Part D option 2) is
 *
 *     leadership FOR SHARE  →  Agent FOR UPDATE  →  Leg FOR UPDATE  →  write
 *
 * in a SERIALIZABLE transaction. It is emulated here by `candidate()` — a test-local transaction
 * that takes exactly those locks with the repository's own `readLeadership` and `selectForUpdate`
 * and then writes the Agent row as `applyCommit` does. It is a probe of the lock order, not a
 * proposed implementation.
 *
 * It is raced against the **real** code of every other path that locks those rows:
 *
 *   migrate   membership.migrate        SERIALIZABLE: leadership FOR SHARE → Agent FOR UPDATE → writes
 *   b3        recoverOrphanedClaims     READ COMMITTED: leadership FOR SHARE → Leg FOR UPDATE → writes
 *   renew     leadership.renewLease     leadership FOR UPDATE → UPDATE leaseExpiry
 *   acquire   leadership.tryAcquire     leadership FOR UPDATE → UPDATE fence+1 (lease made expired)
 *   release   leadership.releaseLease   leadership FOR UPDATE → UPDATE fence+1
 *   commit    commitment.commit (today's order: Agent → Leg → leadership FOR SHARE), G4-forced
 *
 * in three interleavings each, forced through injected seams (`selectForUpdate`) and gates:
 *
 *   I1  candidate holds all three locks; the contender starts and must wait; candidate commits
 *   I2  candidate holds only the leadership FOR SHARE; the contender runs; candidate resumes
 *   I3  the contender holds its first lock(s); the candidate starts and must wait; contender resumes
 *       (for renew/acquire/release, whose locks are internal, a held-open renewal stands in)
 *
 * Pass criteria: no `40P01` deadlock in any pairing, no hang, and every outcome equal to the one
 * derived from the lock rules (recorded per row, including the `40001`s that are expected).
 *
 * Usage:
 *   node tools/verify/step1/leadershipFirstLockOrder.js --template <db> \
 *        --server postgresql://<user>@127.0.0.1:<port>      (loopback only; never 5432, never Neon)
 *   The template must hold ≥1 Agent with a current ShardMembership and no live commitment,
 *   ≥1 Leg with a WorkQueue row, and the shard's ShardLeadership row (any `step0_*` database).
 */

const path = require("path");
const crypto = require("crypto");

const BACKEND_ROOT = path.resolve(__dirname, "..", "..", "..");
const { assertDisposableLocal } = require(path.join(BACKEND_ROOT, "tools/demo/disposableDatabase"));

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? null : argv[at + 1];
};
const SHARD_ID = process.env.SHARD_ID || "v1demo-shard";
const TARGET_SHARD = "step1-target";
const LEADER = "step1-leader";
const SIGNING_KEY = crypto.randomBytes(64).toString("hex");
const BLOCKED_PROBE_MS = 700;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});

async function main() {
  const template = flag("--template");
  const server = flag("--server");
  if (!template || !server) throw new Error("usage: --template <db> --server postgresql://user@127.0.0.1:<port>");
  assertDisposableLocal(`${server}/${template}`, { purpose: "run the Step 1 leadership-first lock-order races" });
  process.env.DATABASE_URL = `${server}/${template}`;

  const { PrismaClient } = require(path.join(BACKEND_ROOT, "node_modules/@prisma/client"));
  const commitment = require(path.join(BACKEND_ROOT, "src/engine/commitment/commit"));
  const leadership = require(path.join(BACKEND_ROOT, "src/engine/shard/leadership"));
  const membership = require(path.join(BACKEND_ROOT, "src/engine/shard/membership"));
  const coordinator = require(path.join(BACKEND_ROOT, "src/workers/coordinator.worker"));
  const { runSerializable, selectForUpdate } = require(path.join(BACKEND_ROOT, "src/db/prisma"));

  const admin = new PrismaClient({ datasources: { db: { url: `${server}/postgres` } } });
  const results = [];
  const matrix = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok });
    process.stdout.write(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}\n`);
  };

  const classify = (error) => {
    const text = String((error && error.message) || error);
    if (/40P01|deadlock detected/i.test(text)) return "DEADLOCK";
    if (/40001|could not serialize/i.test(text)) return "SERIALIZATION";
    return `ERROR:${text.split("\n").pop().slice(0, 90)}`;
  };

  /** A gate an actor can be parked at, and released from. */
  function gate() {
    let open;
    const opened = new Promise((resolve) => {
      open = resolve;
    });
    let arrive;
    const arrived = new Promise((resolve) => {
      arrive = resolve;
    });
    return { arrived, arrive, opened, open };
  }

  /** Settle-tracking wrapper: is the promise still pending after `ms`? */
  const settledWithin = async (promise, ms) => {
    let done = false;
    promise.then(() => { done = true; }, () => { done = true; });
    await sleep(ms);
    return done;
  };

  /** The future candidate: leadership FOR SHARE → Agent FOR UPDATE → Leg FOR UPDATE → write. */
  function candidate(world, pauseAfter) {
    const g = gate();
    const done = runSerializable(
      world.c,
      async (tx) => {
        await leadership.readLeadership(tx, SHARD_ID);
        if (pauseAfter === "leadership") { g.arrive(); await g.opened; }
        await selectForUpdate(tx, "Agent", "id", world.agent.id);
        if (pauseAfter === "agent") { g.arrive(); await g.opened; }
        await selectForUpdate(tx, "Leg", "id", world.leg.id);
        if (pauseAfter === "leg") { g.arrive(); await g.opened; }
        await tx.$executeRawUnsafe(`UPDATE "Agent" SET "fenceCounter" = "fenceCounter" + 1 WHERE id = $1`, world.agent.id);
        return "COMMITTED";
      },
      { timeoutMs: 30_000, maxWaitMs: 10_000 },
    ).then((value) => ({ status: value }), (error) => ({ status: classify(error) }));
    return { gate: g, done };
  }

  /** A `selectForUpdate` that parks after locking `table`, for contenders that take it injected. */
  const pausingSelect = (table, g) => async (tx, t, column, value) => {
    const row = await selectForUpdate(tx, t, column, value);
    if (g && t === table) { g.arrive(); await g.opened; }
    return row;
  };

  const contenders = {
    migrate: (world, g) =>
      membership
        .migrate(
          { prisma: world.x, runSerializable, selectForUpdate: pausingSelect("Agent", g) },
          {
            agentId: world.agent.id,
            targetShardId: TARGET_SHARD,
            reason: "REBALANCE_MERGE",
            movedBy: "step1-lock-order",
            storeTime: new Date(),
            commandTtlSeconds: 30,
            signingKey: SIGNING_KEY,
            leadershipGuard: { shardId: SHARD_ID, holder: LEADER, leadershipFence: world.fence },
          },
        )
        .then((outcome) => ({ status: outcome.ok ? "MIGRATED" : `REFUSED:${outcome.refusal}` }), (error) => ({ status: classify(error) })),
    b3: (world, g) =>
      coordinator
        .recoverOrphanedClaims({ prisma: world.x, selectForUpdate: pausingSelect("Leg", g) }, { shardId: SHARD_ID, storeTime: new Date(), leadershipFence: world.fence })
        .then((outcome) => ({ status: outcome.refusal ? `REFUSED:${outcome.refusal}` : `RECOVERED:${outcome.requeued}q/${outcome.solved}s` }), (error) => ({ status: classify(error) })),
    renew: (world) =>
      leadership
        .renewLease(world.x, { shardId: SHARD_ID, holder: LEADER, expectedFence: world.fence, storeTime: new Date(), leaseDurationSeconds: 3600 })
        .then((r) => ({ status: r.renewed ? "RENEWED" : `REFUSED:${r.refusal}` }), (error) => ({ status: classify(error) })),
    acquire: (world) =>
      leadership
        .tryAcquire(world.x, { shardId: SHARD_ID, holder: "step1-rival", expectedFence: world.fence, storeTime: new Date(), leaseDurationSeconds: 3600 })
        .then((r) => ({ status: r.acquired ? "ACQUIRED" : `REFUSED:${r.refusal}` }), (error) => ({ status: classify(error) })),
    release: (world) =>
      leadership
        .releaseLease(world.x, { shardId: SHARD_ID, holder: LEADER, expectedFence: world.fence, storeTime: new Date() })
        .then((r) => ({ status: r.released ? "RELEASED" : `REFUSED:${r.refusal}` }), (error) => ({ status: classify(error) })),
    commit: (world, g) =>
      commitment
        .commit(
          {
            prisma: world.x,
            runSerializable,
            selectForUpdate: pausingSelect("Agent", g),
            isSerializationFailure: () => false,
            volatileRecheck: async () => ({ ok: true }),
            sideEffects: async () => {},
          },
          {
            agentId: world.agent.id,
            legId: world.leg.id,
            decisionRoundId: `step1-lo-${Date.now()}`,
            targetLegState: "OFFERED",
            shardId: SHARD_ID,
            snapshot: { leadershipFence: world.fence, authorityEpoch: world.agent.authorityEpoch, legVersion: world.leg.version + 1000, expectedLegState: world.leg.state },
            config: { capacity: 1, leaseDurationSeconds: 60 },
          },
        )
        .then((outcome) => ({ status: outcome.committed ? "COMMITTED" : `ABORTED:${outcome.reason}` }), (error) => ({ status: classify(error) })),
  };

  /** A renewal held open (FOR UPDATE + its UPDATE), standing in for renew/acquire/release in I3. */
  function heldLeadershipWrite(world, g) {
    return world.x
      .$transaction(
        async (tx) => {
          await leadership.lockLeadershipRow(tx, SHARD_ID);
          await tx.shardLeadership.updateMany({ where: { shardId: SHARD_ID }, data: { leaseExpiry: new Date(Date.now() + 3600 * 1000) } });
          g.arrive();
          await g.opened;
          return "WROTE";
        },
        { timeout: 20_000 },
      )
      .then((status) => ({ status }), (error) => ({ status: classify(error) }));
  }

  async function world(id, contender) {
    setUp.contender = contender;
    const db = `step1_lo_${id}_${Date.now()}`.toLowerCase();
    await admin.$executeRawUnsafe(`CREATE DATABASE "${db}" TEMPLATE "${template}"`);
    const url = `${server}/${db}`;
    const c = new PrismaClient({ datasources: { db: { url } } });
    const x = new PrismaClient({ datasources: { db: { url } } });
    try {
      return await setUp(db, c, x);
    } catch (error) {
      await c.$disconnect();
      await x.$disconnect();
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
      throw error;
    }
  }

  async function setUp(db, c, x) {
    const contender = setUp.contender;
    // The leadership row: held by LEADER; for "acquire", already expired so the rival can win.
    // Written as a Date parameter: the column is `timestamp` without zone, and SQL `now()` would
    // store the session's local wall time (+05:30 here), which Prisma then reads as UTC.
    await x.shardLeadership.update({
      where: { shardId: SHARD_ID },
      data: { holder: LEADER, leaseExpiry: new Date(Date.now() + (contender === "acquire" ? -60_000 : 3_600_000)) },
    });
    const lead = await x.shardLeadership.findUnique({ where: { shardId: SHARD_ID } });
    // `Shard.regionId` is unique: the migration target gets its own region.
    const region = await x.region.create({ data: { regionId: "step1-target-region", name: "Step 1 migration target" } });
    // `Shard.shardId` references its own ShardLeadership row.
    await x.shardLeadership.create({ data: { shardId: TARGET_SHARD, leadershipFence: 1n } });
    await x.shard.create({ data: { shardId: TARGET_SHARD, regionId: region.id, state: "ACTIVE" } });
    // The Step 0 world's initial placement (indexMaintainer) creates memberships without counting
    // them on `Shard.agentCount` (0 for 6 current members — the inconsistency
    // `shards.controller` itself reports). A real migration decrements it and would trip
    // `Shard_agent_count_non_negative`, which is a property of the template, not of the lock
    // order, so the copy is made consistent first.
    const members = await x.shardMembership.count({ where: { shardId: SHARD_ID, supersededAt: null } });
    await x.shard.update({ where: { shardId: SHARD_ID }, data: { agentCount: members } });
    // An agent with a current membership and no live commitment (so a migration is admissible).
    const agents = await x.agent.findMany({ orderBy: { id: "asc" } });
    let agent = null;
    for (const candidateAgent of agents) {
      // eslint-disable-next-line no-await-in-loop
      const live = await x.commitment.count({ where: { agentId: candidateAgent.id, releasedAt: null } });
      if (live === 0) { agent = candidateAgent; break; }
    }
    if (!agent) throw new Error(`template ${template} has no agent without a live commitment`);
    // A Leg with an orphaned claim, for B3: CLAIMED by a round that is not live. The Leg holds a
    // live commitment, so B3 takes its writing branch (WorkQueue → SOLVED) rather than skipping.
    const queued = await x.workQueue.findMany({ orderBy: { id: "asc" } });
    let wq = null;
    for (const row of queued) {
      // eslint-disable-next-line no-await-in-loop
      if ((await x.commitment.count({ where: { legId: row.legId, releasedAt: null } })) > 0) { wq = row; break; }
    }
    if (!wq) throw new Error(`template ${template} has no WorkQueue row whose Leg holds a live commitment`);
    await x.workQueue.update({ where: { id: wq.id }, data: { state: "CLAIMED", claimedByRoundId: "step1-dead-round", claimedAt: new Date(), version: { increment: 1 } } });
    const leg = await x.leg.findUnique({ where: { id: wq.legId } });
    return {
      db, c, x, agent, leg, fence: lead.leadershipFence,
      close: async () => {
        await c.$disconnect();
        await x.$disconnect();
        await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
      },
    };
  }

  /**
   * Expected outcomes, derived from PostgreSQL's lock and snapshot rules (see the header):
   *  - the leadership writers and B3 run READ COMMITTED, so they wait and then proceed;
   *  - migrate and the candidate are SERIALIZABLE, so whichever locks the Agent row *after* the
   *    other committed a write to it fails 40001 — the same conflict today's commit has with
   *    migrate, surfacing here as SERIALIZATION instead of G3;
   *  - a leadership write committed while the candidate waits on its FOR SHARE fails it 40001
   *    (the residual window option 2 leaves);
   *  - I1 commit: today's commit takes its snapshot (idempotency read) while the candidate holds
   *    the Agent lock, then waits on it; the candidate's Agent write commits first, so today's
   *    commit fails 40001 on the Agent row — the same rule as I1 migrate.
   */
  const EXPECT = {
    I1: { migrate: ["COMMITTED", "SERIALIZATION"], b3: ["COMMITTED", "RECOVERED"], renew: ["COMMITTED", "RENEWED"], acquire: ["COMMITTED", "ACQUIRED"], release: ["COMMITTED", "RELEASED"], commit: ["COMMITTED", "SERIALIZATION"] },
    I2: { migrate: ["SERIALIZATION", "MIGRATED"], b3: ["COMMITTED", "RECOVERED"], renew: ["COMMITTED", "RENEWED"], acquire: ["COMMITTED", "ACQUIRED"], release: ["COMMITTED", "RELEASED"], commit: ["COMMITTED", "ABORTED:G4_LEG_VERSION_CHANGED"] },
    I3: { migrate: ["SERIALIZATION", "MIGRATED"], b3: ["COMMITTED", "RECOVERED"], renew: ["SERIALIZATION", "WROTE"], acquire: ["SERIALIZATION", "WROTE"], release: ["SERIALIZATION", "WROTE"], commit: ["COMMITTED", "ABORTED:G4_LEG_VERSION_CHANGED"] },
  };
  // B3 must actually write: one orphaned claim, settled to SOLVED because its Leg holds a live commitment.
  const statusMatches = (got, want) => got === want || (want === "RECOVERED" && got === "RECOVERED:0q/1s");

  for (const name of Object.keys(contenders)) {
    for (const interleaving of ["I1", "I2", "I3"]) {
      // eslint-disable-next-line no-await-in-loop
      const w = await world(`${name}_${interleaving}`, name);
      let cand;
      let other;
      let blocked = null;
      try {
        if (interleaving === "I1") {
          cand = candidate(w, "leg");
          await cand.gate.arrived;
          other = contenders[name](w, null);
          blocked = !(await settledWithin(other, BLOCKED_PROBE_MS));
          cand.gate.open();
        } else if (interleaving === "I2") {
          cand = candidate(w, "leadership");
          await cand.gate.arrived;
          other = contenders[name](w, null);
          await settledWithin(other, BLOCKED_PROBE_MS);
          cand.gate.open();
        } else {
          const g = gate();
          other = ["renew", "acquire", "release"].includes(name) ? heldLeadershipWrite(w, g) : contenders[name](w, g);
          await g.arrived;
          cand = candidate(w, null);
          blocked = !(await settledWithin(cand.done, BLOCKED_PROBE_MS));
          g.open();
        }
        // eslint-disable-next-line no-await-in-loop
        const [a, b] = await Promise.all([cand.done, other]);
        const want = EXPECT[interleaving][name];
        const row = { interleaving, contender: name, candidate: a.status, other: b.status, blocked };
        matrix.push(row);
        check(
          `${interleaving} ${name.padEnd(7)} candidate=${a.status} contender=${b.status}${blocked === null ? "" : ` ${interleaving === "I1" ? "contender" : "candidate"} waited=${blocked}`}`,
          a.status !== "DEADLOCK" && b.status !== "DEADLOCK" && statusMatches(a.status, want[0]) && statusMatches(b.status, want[1]) && blocked !== false,
          `expected candidate=${want[0]} contender=${want[1]}`,
        );
      } finally {
        // eslint-disable-next-line no-await-in-loop
        await w.close();
      }
    }
  }

  // The residual window, stated directly: once the candidate HOLDS its FOR SHARE, a renewal
  // cannot commit underneath it (it waits), so the candidate can never see a renewal 40001.
  {
    const w = await world("renew_after_share", "renew");
    try {
      const cand = candidate(w, "leadership");
      await cand.gate.arrived;
      const renewal = contenders.renew(w);
      const waited = !(await settledWithin(renewal, BLOCKED_PROBE_MS));
      cand.gate.open();
      const [a, b] = await Promise.all([cand.done, renewal]);
      check(`candidate holding FOR SHARE: a renewal waits (${waited}), the candidate commits (${a.status}), the renewal then succeeds (${b.status})`,
        waited && a.status === "COMMITTED" && b.status === "RENEWED");
    } finally {
      await w.close();
    }
  }

  await admin.$disconnect();
  const deadlocks = matrix.filter((row) => row.candidate === "DEADLOCK" || row.other === "DEADLOCK").length;
  process.stdout.write(`\nDEADLOCKS: ${deadlocks} of ${matrix.length} pairings\n`);
  const failed = results.filter((entry) => !entry.ok);
  process.stdout.write(`RESULT: ${failed.length === 0 ? "PASS" : "FAIL"} — ${results.length - failed.length}/${results.length} checks\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

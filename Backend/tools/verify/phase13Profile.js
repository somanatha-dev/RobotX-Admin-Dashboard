"use strict";

/**
 * PHASE 13 — measured latency of the leadership critical paths, against live PostgreSQL.
 *
 * Jest timings are not evidence about these paths: every Phase 13 concurrency test runs
 * against `tests/engine/helpers/commitmentStore.js`, an in-memory model whose `FOR UPDATE`
 * is a JavaScript mutex and whose "transaction" is a function call. What that model can
 * prove is a *logical* property (exactly one winner); what it cannot produce is a number.
 *
 * The paths measured are the ones §19.5's margin arithmetic depends on:
 *
 *   · `tryAcquire`  — the compare-and-set, inside a transaction, taking `FOR UPDATE`.
 *   · `renewLease`  — the operation whose latency the renewal margin is sized against.
 *   · `releaseLease` — the shutdown drain's last act, which advances the fence.
 *   · `readLeadership` — guard G1's read, on the commit path, per commit.
 *   · `failover.run()` — §19.5's reconciliation, once per acquisition.
 *   · one full supervisor tick — renewal + failover + sizing + migration + hint.
 *   · the **migration tick** — §19.2's handoff, the heaviest thing the supervisor does:
 *     nine write statements in one SERIALIZABLE transaction.
 *
 * ── What this measurement is NOT ───────────────────────────────────────────
 * The cluster is a throwaway PostgreSQL on **loopback, on the same machine**, with no
 * replication, no synchronous quorum, and no network. `shard.store_round_trip_budget` is
 * registered SAFETY-class with `calibrationStatus: PROVISIONAL` and `awaits` "measured p99
 * round-trip to the operated consensus store" — and *this is not that store*. These numbers
 * are a floor: they establish that the implementation adds no gross overhead of its own, and
 * they do **not** calibrate the parameter. Reporting them as a calibration would be the
 * fabrication this exercise exists to avoid.
 *
 * Usage:
 *   DATABASE_URL=postgresql://pgverify:verify@127.0.0.1:55435/robotx_p13 \
 *     node tools/verify/phase13Profile.js
 */

const { PrismaClient } = require("@prisma/client");

const leadership = require("../../src/engine/shard/leadership");
const election = require("../../src/engine/shard/election");
const shardSupervisor = require("../../src/workers/shardSupervisor.worker");
const { runSerializable, selectForUpdate } = require("../../src/db/prisma");

const P = "p13-perf";
const SAMPLES = 200;
const WARMUP = 20;

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function report(label, samples, note) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  console.log(
    `  ${label.padEnd(34)} n=${String(samples.length).padStart(4)}  ` +
      `mean ${mean.toFixed(2).padStart(7)} ms   p50 ${percentile(sorted, 50).toFixed(2).padStart(7)} ms   ` +
      `p95 ${percentile(sorted, 95).toFixed(2).padStart(7)} ms   p99 ${percentile(sorted, 99).toFixed(2).padStart(7)} ms   ` +
      `max ${sorted[sorted.length - 1].toFixed(2).padStart(7)} ms`,
  );
  if (note) console.log(`  ${" ".repeat(34)} ${note}`);
  return { label, n: samples.length, mean, p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99) };
}

async function timed(times, fn) {
  for (let i = 0; i < WARMUP; i += 1) await fn(i); // eslint-disable-line no-await-in-loop
  for (let i = 0; i < SAMPLES; i += 1) {
    const at = process.hrtime.bigint();
    await fn(i + WARMUP); // eslint-disable-line no-await-in-loop
    times.push(Number(process.hrtime.bigint() - at) / 1e6);
  }
}

async function main() {
  const url = process.env.DATABASE_URL || "";
  if (/neon\.tech/i.test(url) || /:5432\//.test(url)) throw new Error(`refusing to profile against ${url}`);
  const prisma = new PrismaClient({ datasources: { db: { url } } });

  console.log("PHASE 13 — measured leadership latency (live PostgreSQL, loopback)");
  const version = await prisma.$queryRawUnsafe("SELECT version() AS v");
  console.log(`  ${version[0].v}\n`);

  const shardId = `${P}-shard`;
  const results = [];

  try {
    await prisma.shardLeadership.deleteMany({ where: { shardId: { startsWith: P } } });
    await prisma.shardLeadership.create({ data: { shardId, leadershipFence: BigInt(1) } });

    // ── G1's read: on the commit path, once per commit ────────────────────
    const reads = [];
    await timed(reads, () => leadership.readLeadership(prisma, shardId));
    results.push(report("readLeadership (guard G1's read)", reads, "runs inside every commit transaction (§10.3.2)"));

    // ── tryAcquire: the CAS, with FOR UPDATE, inside a transaction ─────────
    const acquires = [];
    await timed(acquires, async () => {
      const row = await prisma.shardLeadership.findUnique({ where: { shardId } });
      await leadership.tryAcquire(prisma, {
        shardId, holder: `${P}-holder`, expectedFence: row.leadershipFence,
        storeTime: new Date(), leaseDurationSeconds: 30,
      });
      // Release the lease so the next iteration can acquire again.
      await prisma.shardLeadership.update({ where: { shardId }, data: { holder: null, leaseExpiry: null } });
    });
    results.push(report("tryAcquire (CAS + FOR UPDATE)", acquires, "includes the read, the CAS transaction, and the reset"));

    // ── renewLease: the operation the renewal margin is sized against ──────
    const store = election.postgresLeadershipStore(prisma, { replicationPosture: "SYNCHRONOUS_QUORUM" });
    let session = await election.acquire(store, {
      shardId, candidateId: `${P}-leader`, storeTime: new Date(), leaseDurationSeconds: 300,
    });
    const renewals = [];
    await timed(renewals, async () => {
      session = await election.renew(store, session, {
        storeTime: new Date(), leaseDurationSeconds: 300, maxClockSkewMillis: 500, storeRoundTripMillis: 500,
      });
    });
    results.push(report("renewLease (the margin's subject)", renewals, "§19.5 sizes the renewal interval against this"));

    // ── releaseLease: the shutdown drain's last act; it ADVANCES the fence ─
    const releases = [];
    await timed(releases, async () => {
      const row = await prisma.shardLeadership.findUnique({ where: { shardId } });
      await leadership.releaseLease(prisma, {
        shardId, holder: `${P}-leader`, expectedFence: row.leadershipFence, storeTime: new Date(),
      });
      // Re-acquire so the next iteration has a lease to release. The re-acquisition is
      // inside the measured window and is stated rather than hidden: releasing without it
      // would measure one release and 199 refusals.
      const next = await prisma.shardLeadership.findUnique({ where: { shardId } });
      await leadership.tryAcquire(prisma, {
        shardId, holder: `${P}-leader`, expectedFence: next.leadershipFence,
        storeTime: new Date(), leaseDurationSeconds: 300,
      });
    });
    results.push(report("releaseLease + re-acquire", releases, "the shutdown drain; a rolling deploy pays this once per process"));

    // The session's fence is now far behind the row's, so re-establish one.
    session = await election.acquire(store, { shardId, candidateId: `${P}-leader`, storeTime: new Date(), leaseDurationSeconds: 300 });

    // ── one full supervisor tick ──────────────────────────────────────────
    const deps = {
      prisma, kv: { set: async () => "OK" }, store, runSerializable, selectForUpdate,
      reconcile: async () => ({ total: 0, results: [] }),
      onError: (e) => { throw e; },
    };
    const settings = {
      shardId, candidateId: `${P}-leader`, leaseDurationSeconds: 300,
      maxClockSkewMillis: 500, storeRoundTripMillis: 500,
    };
    const ticks = [];
    await timed(ticks, async () => {
      const tick = await shardSupervisor.runOnce(deps, { ...settings, session, storeTime: new Date() });
      session = tick.session;
    });
    results.push(report("supervisor tick (steady-state renew)", ticks, "renewal + failover check + sizing + migration check + hint"));

    // ── §19.5's reconciliation, once per acquisition ──────────────────
    // The sweep itself is Phase 5's and is injected as a no-op, exactly as the supervisor
    // injects it. What is measured is the inventory, the reconstruction prediction and the
    // persistence around it — the part §19.5 adds and the part this phase owns.
    const failover = require("../../src/engine/shard/failover");
    const recoveries = [];
    await timed(recoveries, async () => {
      const result = await failover.run(
        { prisma, reconcile: async () => ({ total: 0, results: [] }) },
        { shardId, storeTime: new Date() },
      );
      await failover.persist({ prisma }, { shardId, result, at: new Date() });
    });
    results.push(report("failover.run + persist (§19.5)", recoveries, "once per acquisition; rounds do not resume until it returns"));

    // ── §19.2's handoff: the heaviest write the supervisor performs ───
    const membership = require("../../src/engine/shard/membership");
    const migrations = [];
    try {
      await prisma.region.create({ data: { id: `${P}-region-1`, regionId: `${P}-region-1`, name: `${P} region 1` } });
      await prisma.region.create({ data: { id: `${P}-region-2`, regionId: `${P}-region-2`, name: `${P} region 2` } });
      await prisma.shardLeadership.create({ data: { shardId: `${P}-shard-1`, leadershipFence: BigInt(1) } });
      await prisma.shardLeadership.create({ data: { shardId: `${P}-shard-2`, leadershipFence: BigInt(1) } });
      // `agentCount: 1` because the handoff decrements the source: starting at zero, the first
      // migration is refused by `Shard_agent_count_non_negative`, which is the constraint
      // doing its job rather than a defect.
      await prisma.shard.create({ data: { id: `${P}-s1`, shardId: `${P}-shard-1`, regionId: `${P}-region-1`, agentCount: 1, updatedAt: new Date() } });
      await prisma.shard.create({ data: { id: `${P}-s2`, shardId: `${P}-shard-2`, regionId: `${P}-region-2`, updatedAt: new Date() } });
      await prisma.agent.create({ data: { id: `${P}-agent`, agentId: `${P}-agent`, authorityEpoch: BigInt(0) } });
      await prisma.shardMembership.create({
        data: {
          id: `${P}-mem`, agentId: `${P}-agent`, shardId: `${P}-shard-1`, fromShardId: null, movedAt: new Date(),
          authorityEpochBefore: BigInt(0), authorityEpochAfter: BigInt(0), reason: "COMMISSIONING", movedBy: P,
        },
      });

      // The agent ping-pongs between two shards, so every iteration is a genuine migration
      // rather than a refusal — which a fixed target would have made 219 of them.
      await timed(migrations, async (i) => {
        const to = i % 2 === 0 ? `${P}-shard-2` : `${P}-shard-1`;
        const outcome = await membership.migrate(
          { prisma, runSerializable, selectForUpdate },
          {
            agentId: `${P}-agent`, targetShardId: to, reason: "REBALANCE_MERGE", movedBy: P,
            storeTime: new Date(), commandTtlSeconds: 60, signingKey: `${P}-signing-key-long-enough-for-23-3`,
          },
        );
        if (!outcome.ok) throw new Error(`migration refused: ${outcome.refusal}`);
      });
      results.push(report("membership.migrate (§19.2's handoff)", migrations, "nine writes in one SERIALIZABLE transaction; one per tick"));
    } finally {
      await prisma.outbox.deleteMany({ where: { agentId: { startsWith: P } } }).catch(() => {});
      await prisma.agentFenceAudit.deleteMany({ where: { agentId: { startsWith: P } } }).catch(() => {});
      await prisma.shardMembership.deleteMany({ where: { agentId: { startsWith: P } } }).catch(() => {});
      await prisma.shard.deleteMany({ where: { shardId: { startsWith: P } } }).catch(() => {});
      await prisma.agent.deleteMany({ where: { id: { startsWith: P } } }).catch(() => {});
      await prisma.region.deleteMany({ where: { id: { startsWith: P } } }).catch(() => {});
    }

    // ── The margin these numbers have to fit inside ───────────────────────
    console.log("\n── §19.5's margin, against the register's defaults ──");
    const lease = 5000;      // shard.lease_duration = 5 s
    const renewal = 1500;    // shard.renewal_interval = 1500 ms
    const skew = 500;        // time.max_clock_skew = 500 ms
    const budget = 500;      // shard.store_round_trip_budget = 500 ms
    const latest = lease - skew - budget;
    console.log(`  lease ${lease} ms − skew ${skew} ms − round-trip budget ${budget} ms = latest lawful renewal at ${latest} ms`);
    console.log(`  renewal interval ${renewal} ms < ${latest} ms — validator A4's inequality holds`);
    const renewP99 = results.find((r) => r.label.startsWith("renewLease")).p99;
    console.log(`  measured renewal p99 ${renewP99.toFixed(2)} ms against a ${budget} ms budget — ` +
      `${renewP99 < budget ? "within" : "OVER"} it on this hardware`);

    const handoff = results.find((r) => r.label.startsWith("membership.migrate"));
    if (handoff) {
      const pace = 2000; // shard.migration_min_interval, in ms
      console.log(
        `  measured handoff p99 ${handoff.p99.toFixed(2)} ms against the ${pace} ms pacing interval \u2014 ` +
        `the migration occupies ${((handoff.p99 / pace) * 100).toFixed(1)}% of the interval it is paced by`,
      );
    }
    console.log(
      "\n  NOT A CALIBRATION. This is loopback PostgreSQL on one machine with no replication.\n" +
      "  `shard.store_round_trip_budget` remains PROVISIONAL and still awaits a measured p99\n" +
      "  against the operated consensus store, exactly as its register entry says.",
    );
  } finally {
    await prisma.shardLeadership.deleteMany({ where: { shardId: { startsWith: P } } });
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error("PROFILE ERROR:", e); process.exit(1); });

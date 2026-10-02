"use strict";

/**
 * STEP 1 (tests first) — GROUP 5: lease renewal → commit SERIALIZATION_FAILURE, on a real
 * PostgreSQL. **Verification tooling only**; nothing in `src/` requires it and it changes no
 * production behaviour.
 *
 * Why a `tools/verify` harness and not a Jest test: the engine lane runs against doubles
 * (`tests/engine/helpers/commitmentStore`), which model row locks but not PostgreSQL's
 * SERIALIZABLE snapshot rules — and `40001 could not serialize access due to concurrent update`
 * is exactly a snapshot rule. The repository's real-database checks already live here
 * (`tools/verify/b3OrphanClaimRecovery.js`); this follows that pattern.
 *
 * It drives the **real** `commitment.commit` with the **real** `runSerializable`,
 * `selectForUpdate` and `isSerializationFailure` (`src/db/prisma.js`), and the **real**
 * `leadership.renewLease` / `releaseLease`. The interleaving is forced deterministically through
 * the two seams `commit` already takes as injected dependencies — no production code is wrapped:
 *
 *   hookAfterBegin  inside `runSerializable`'s callback, before the commit's first statement
 *   hookAfterLeg    inside `selectForUpdate`, right after the Leg row lock (`commit.js:113`)
 *
 * Each scenario runs on its own `CREATE DATABASE … TEMPLATE` copy. The request pins a Leg
 * version that cannot match, so every commit that gets *past* the leadership read aborts on G4
 * and writes nothing — the scenarios observe the read, not a commitment.
 *
 *   R0  control: no concurrent leadership write → passes the FOR SHARE read, aborts on G4
 *   R1  renewal COMMITS after the snapshot (after the Leg lock) → FOR SHARE → 40001
 *   R2  renewal COMMITS after BEGIN but before the first data statement → no 40001
 *       (the snapshot is taken at the first data statement, not at BEGIN)
 *   R3  renewal COMMITS before the transaction → no 40001
 *   R4  renewal IN FLIGHT (holding FOR UPDATE) when FOR SHARE runs, then commits → waits, 40001
 *   R5  renewal IN FLIGHT, then ROLLS BACK → waits, then passes (G4)
 *   R6  a fence advance (real releaseLease) commits in the window → 40001, classified
 *       SERIALIZATION_FAILURE rather than G1
 *
 * Usage:
 *   node tools/verify/step1/renewalCommitSerialization.js --template <db> \
 *        --server postgresql://<user>@127.0.0.1:<port>      (loopback only; never 5432, never Neon)
 *   The template must hold ≥1 Agent, ≥1 Leg and the shard's ShardLeadership row (any Step 0
 *   `step0_*` database does). SHARD_ID defaults to `v1demo-shard`.
 */

const path = require("path");

const BACKEND_ROOT = path.resolve(__dirname, "..", "..", "..");
const { assertDisposableLocal } = require(path.join(BACKEND_ROOT, "tools/demo/disposableDatabase"));

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? null : argv[at + 1];
};
const SHARD_ID = process.env.SHARD_ID || "v1demo-shard";
const LEADER = "step1-leader";

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});

async function main() {
  const template = flag("--template");
  const server = flag("--server");
  if (!template || !server) throw new Error("usage: --template <db> --server postgresql://user@127.0.0.1:<port>");
  assertDisposableLocal(`${server}/${template}`, { purpose: "run the Step 1 renewal/commit serialization scenarios" });
  process.env.DATABASE_URL = `${server}/${template}`;

  const { PrismaClient } = require(path.join(BACKEND_ROOT, "node_modules/@prisma/client"));
  const commitment = require(path.join(BACKEND_ROOT, "src/engine/commitment/commit"));
  const leadership = require(path.join(BACKEND_ROOT, "src/engine/shard/leadership"));
  const { runSerializable, selectForUpdate, isSerializationFailure } = require(path.join(BACKEND_ROOT, "src/db/prisma"));

  const admin = new PrismaClient({ datasources: { db: { url: `${server}/postgres` } } });
  const results = [];
  const check = (scenario, name, ok, detail) => {
    results.push({ scenario, name, ok });
    process.stdout.write(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}\n`);
  };

  async function scenario(id, title, body) {
    const db = `step1_rcs_${id.toLowerCase()}_${Date.now()}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${db}" TEMPLATE "${template}"`);
    const url = `${server}/${db}`;
    const statements = [];
    const committer = new PrismaClient({ datasources: { db: { url } }, log: [{ emit: "event", level: "query" }] });
    committer.$on("query", (event) => statements.push(event.query.replace(/\s+/g, " ")));
    const other = new PrismaClient({ datasources: { db: { url } } });
    process.stdout.write(`\n${id}  ${title}\n`);
    try {
      // A Date parameter, not SQL now(): the column is `timestamp` without zone.
      await other.shardLeadership.update({ where: { shardId: SHARD_ID }, data: { holder: LEADER, leaseExpiry: new Date(Date.now() + 3_600_000) } });
      const lead = await other.shardLeadership.findUnique({ where: { shardId: SHARD_ID } });
      if (!lead) throw new Error(`template ${template} has no ShardLeadership row for ${SHARD_ID}`);
      const agent = await other.agent.findFirst({ orderBy: { id: "asc" } });
      const leg = await other.leg.findFirst({ orderBy: { id: "asc" } });
      if (!agent || !leg) throw new Error(`template ${template} needs at least one Agent and one Leg`);
      const baselineCommitments = await other.commitment.count();
      await body({ committer, other, statements, fence: lead.leadershipFence, agent, leg, url, baselineCommitments });
    } finally {
      await committer.$disconnect();
      await other.$disconnect();
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    }
  }

  /** The real commit with optional hooks at the two injected seams. */
  async function commitWith(world, hooks) {
    const settings = hooks || {};
    let captured = null;
    const started = Date.now();
    let leaderReadStartedAt = null;
    const outcome = await commitment.commit(
      {
        prisma: world.committer,
        runSerializable: (client, fn, options) =>
          runSerializable(
            client,
            async (tx) => {
              if (settings.afterBegin) await settings.afterBegin();
              return fn(tx);
            },
            options,
          ),
        selectForUpdate: async (tx, table, column, value) => {
          const row = await selectForUpdate(tx, table, column, value);
          if (table === "Leg" && settings.afterLeg) await settings.afterLeg();
          if (table === "Leg") leaderReadStartedAt = Date.now();
          return row;
        },
        isSerializationFailure: (error) => {
          captured = error;
          return isSerializationFailure(error);
        },
        volatileRecheck: async () => ({ ok: true }),
        sideEffects: async () => {},
      },
      {
        agentId: world.agent.id,
        legId: world.leg.id,
        decisionRoundId: `step1-${Date.now()}`,
        targetLegState: "OFFERED",
        shardId: SHARD_ID,
        snapshot: {
          leadershipFence: world.fence,
          authorityEpoch: world.agent.authorityEpoch,
          // Cannot match: a commit that gets past the leadership read aborts on G4 and writes nothing.
          legVersion: world.leg.version + 1000,
          expectedLegState: world.leg.state,
        },
        config: { capacity: 1, leaseDurationSeconds: 60 },
      },
    );
    const finished = Date.now();
    return {
      outcome,
      error: captured,
      ms: finished - started,
      afterLegLockMs: leaderReadStartedAt === null ? null : finished - leaderReadStartedAt,
    };
  }

  const renew = (world) =>
    leadership.renewLease(world.other, { shardId: SHARD_ID, holder: LEADER, expectedFence: world.fence, storeTime: new Date(), leaseDurationSeconds: 3600 });

  /** A renewal held open: FOR UPDATE + the same UPDATE renewLease makes, then commit or roll back. */
  function renewalInFlight(world, { holdMs, rollback }) {
    let locked;
    const lockHeld = new Promise((resolve) => {
      locked = resolve;
    });
    const done = world.other
      .$transaction(
        async (tx) => {
          await leadership.lockLeadershipRow(tx, SHARD_ID);
          await tx.shardLeadership.updateMany({
            where: { shardId: SHARD_ID, holder: LEADER, leadershipFence: world.fence },
            data: { leaseExpiry: new Date(Date.now() + 3600 * 1000) },
          });
          locked();
          await tx.$executeRawUnsafe(`SELECT pg_sleep(${holdMs / 1000})`);
          if (rollback) throw new Error("ROLLBACK_ON_PURPOSE");
        },
        { timeout: 20_000 },
      )
      .catch((error) => (error.message === "ROLLBACK_ON_PURPOSE" ? "rolled back" : Promise.reject(error)));
    return { lockHeld, done };
  }

  const nothingWritten = async (world) => {
    const commitments = await world.other.commitment.count();
    const agent = await world.other.agent.findUnique({ where: { id: world.agent.id } });
    return commitments === world.baselineCommitments && BigInt(agent.fenceCounter) === BigInt(world.agent.fenceCounter);
  };
  const is40001 = (error) => Boolean(error) && /40001/.test(String(error.message)) && /could not serialize access due to concurrent update/.test(String(error.message));
  const indexOf = (statements, pattern, from = 0) => statements.findIndex((s, i) => i >= from && pattern.test(s));

  await scenario("R0", "control — no concurrent leadership write", async (world) => {
    const run = await commitWith(world);
    check("R0", "passes the leadership FOR SHARE read and aborts on G4 (the pinned Leg version)", run.outcome.reason === "G4_LEG_VERSION_CHANGED", run.outcome.reason);
    check("R0", "nothing written", await nothingWritten(world));
  });

  await scenario("R1", "renewal commits after the snapshot, before the leadership FOR SHARE", async (world) => {
    let renewed = null;
    const run = await commitWith(world, { afterLeg: async () => { renewed = await renew(world); } });
    check("R1", "the renewal itself succeeded (it never waited: the commit holds no lock on the leadership row yet)", renewed && renewed.renewed === true, JSON.stringify(renewed && renewed.refusal));
    check("R1", "commit aborted SERIALIZATION_FAILURE", run.outcome.reason === "SERIALIZATION_FAILURE", run.outcome.reason);
    check("R1", "the underlying error is PostgreSQL 40001 'could not serialize access due to concurrent update'", is40001(run.error), String(run.error && run.error.message).split("\n").pop().slice(0, 140));
    check("R1", "nothing written by the commit", await nothingWritten(world));
    const s = world.statements;
    const begin = indexOf(s, /^BEGIN/);
    const iso = indexOf(s, /SET TRANSACTION ISOLATION LEVEL SERIALIZABLE/, begin);
    const first = indexOf(s, /FROM "public"."Commitment"/, iso);
    const agentLock = indexOf(s, /FROM "Agent" WHERE "id" = \$1 FOR UPDATE/, first);
    const legLock = indexOf(s, /FROM "Leg" WHERE "id" = \$1 FOR UPDATE/, agentLock);
    const share = indexOf(s, /FROM "ShardLeadership" WHERE "shardId" = \$1 FOR SHARE/, legLock);
    const rollback = indexOf(s, /^ROLLBACK/, share);
    check(
      "R1",
      "statement order: BEGIN → SET SERIALIZABLE → idempotency read (snapshot) → Agent FOR UPDATE → Leg FOR UPDATE → leadership FOR SHARE → ROLLBACK",
      [begin, iso, first, agentLock, legLock, share, rollback].every((value, index, all) => value >= 0 && (index === 0 || value > all[index - 1])),
      JSON.stringify({ begin, iso, first, agentLock, legLock, share, rollback }),
    );
  });

  await scenario("R2", "renewal commits after BEGIN, before the first data statement", async (world) => {
    let renewed = null;
    const run = await commitWith(world, { afterBegin: async () => { renewed = await renew(world); } });
    check("R2", "the renewal succeeded inside the open transaction's lifetime", renewed && renewed.renewed === true);
    check("R2", "no 40001: the snapshot is taken at the first data statement, not at BEGIN", run.outcome.reason === "G4_LEG_VERSION_CHANGED", run.outcome.reason);
  });

  await scenario("R3", "renewal commits before the transaction", async (world) => {
    const renewed = await renew(world);
    const run = await commitWith(world);
    check("R3", "no 40001", renewed.renewed === true && run.outcome.reason === "G4_LEG_VERSION_CHANGED", run.outcome.reason);
  });

  await scenario("R4", "renewal in flight (holding FOR UPDATE) when the FOR SHARE runs, then commits", async (world) => {
    let flight;
    const run = await commitWith(world, {
      afterLeg: async () => {
        flight = renewalInFlight(world, { holdMs: 1000, rollback: false });
        await flight.lockHeld;
      },
    });
    await flight.done;
    check("R4", "the FOR SHARE waited for the renewal (≥ 800 ms after the Leg lock)", run.afterLegLockMs >= 800, `${run.afterLegLockMs} ms`);
    check("R4", "then aborted SERIALIZATION_FAILURE with 40001", run.outcome.reason === "SERIALIZATION_FAILURE" && is40001(run.error), run.outcome.reason);
  });

  await scenario("R5", "renewal in flight, then rolls back", async (world) => {
    let flight;
    const run = await commitWith(world, {
      afterLeg: async () => {
        flight = renewalInFlight(world, { holdMs: 1000, rollback: true });
        await flight.lockHeld;
      },
    });
    const ended = await flight.done;
    check("R5", "the FOR SHARE waited, then passed (no row version was committed)", ended === "rolled back" && run.afterLegLockMs >= 800 && run.outcome.reason === "G4_LEG_VERSION_CHANGED", `${run.afterLegLockMs} ms, ${run.outcome.reason}`);
  });

  await scenario("R6", "a fence advance (real releaseLease) commits in the same window", async (world) => {
    let released = null;
    const run = await commitWith(world, {
      afterLeg: async () => {
        released = await leadership.releaseLease(world.other, { shardId: SHARD_ID, holder: LEADER, expectedFence: world.fence, storeTime: new Date() });
      },
    });
    check("R6", "the release advanced the fence", released && released.released === true, released ? `fence → ${String(released.leadershipFence)}` : "none");
    check("R6", "commit aborted SERIALIZATION_FAILURE (40001) — not G1 — because the read fails before G1 is evaluated", run.outcome.reason === "SERIALIZATION_FAILURE" && is40001(run.error), run.outcome.reason);
  });

  await admin.$disconnect();
  const failed = results.filter((entry) => !entry.ok);
  process.stdout.write(`\nRESULT: ${failed.length === 0 ? "PASS" : "FAIL"} — ${results.length - failed.length}/${results.length} checks\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

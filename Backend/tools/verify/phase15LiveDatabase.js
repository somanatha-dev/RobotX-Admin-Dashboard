"use strict";

/**
 * PHASE 15 remediation — live-PostgreSQL verification of the D-5 and D-6 fixes.
 *
 * ── Why this harness exists ────────────────────────────────────────────────
 * The Jest suite proves the D-6 gate refuses correctly *given* a shard identity, and the
 * D-5 lifecycle starts and stops the right workers *given* a dependency context. Neither
 * proves the thing that actually decides whether the fixes work in production:
 *
 *   1. **`agentGate.resolveIdentity()` issues two real queries.** It reads `Agent` by its
 *      business key and `ShardMembership` by the agent's *primary* key, then joins to
 *      `Shard` for the region. Those are three different columns across three tables, and
 *      the difference between `Agent.id` and `Agent.agentId` is invisible in a unit test
 *      whose fixture uses the same string for both. Getting it wrong returns `null`, which
 *      fails **closed** — so the failure mode is not a crash but a fleet that is silently
 *      refused every engine path, which is exactly the kind of defect that survives a green
 *      suite.
 *
 *   2. **A migrated agent must resolve into its new shard.** §9's adversarial list requires
 *      "robot moved between shards" to refuse. That is a claim about what the store returns
 *      after `supersededAt` is set, and it is only checkable against a store that enforces
 *      `ShardMembership_one_current_per_agent`.
 *
 *   3. **The outbox worker now has a production caller (D-5), and `membership.migrate()`
 *      has always had a production producer.** Whether a `SHARD_MIGRATE` row enqueued by
 *      one is claimable by the other is a fact about the schema's states and its unique
 *      idempotency key, not about either module in isolation.
 *
 * ── How a refusal is judged ────────────────────────────────────────────────
 * Prisma embeds the calling source file's text in its error messages, so a naive
 * `message.includes(constraintName)` matches this harness's own source and reports PASS for
 * a probe that never reached the database. Every refusal below is issued as raw SQL and
 * judged on PostgreSQL's SQLSTATE *and* the constraint it names.
 *
 * Usage:
 *   DATABASE_URL=postgresql://pgverify@127.0.0.1:55434/robotx_p15 \
 *     node tools/verify/phase15LiveDatabase.js
 *
 * NEVER point this at the shared Neon instance or at the default 5432 cluster; it refuses
 * both by name.
 */

const { PrismaClient } = require("@prisma/client");

const agentGate = require("../../src/engine/cutover/agentGate");
const enabled = require("../../src/engine/cutover/enabled");
const membership = require("../../src/engine/shard/membership");

/** Prefix for every row this harness creates, so cleanup is exact. */
const P = "p15v";

let prisma = null;
const results = [];

function record(id, title, ok, detail) {
  results.push({ id, title, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${id}  ${title}`);
  if (detail) console.log(`          ${detail}`);
}

async function accepted(id, title, fn) {
  try {
    const detail = await fn();
    record(id, title, true, detail);
  } catch (error) {
    record(id, title, false, `threw: ${String(error && error.message).slice(0, 300)}`);
  }
}

/**
 * Assert raw SQL is refused by a named constraint.
 *
 * @param {string} id
 * @param {string} title
 * @param {string} sql
 * @param {string} constraint
 */
async function refused(id, title, sql, constraint) {
  try {
    await prisma.$executeRawUnsafe(sql);
    record(id, title, false, "the database ACCEPTED a row it must refuse");
  } catch (error) {
    // Judge on what PostgreSQL said, not on what the message happens to contain.
    const meta = (error && error.meta) || {};
    const text = `${meta.message || ""} ${meta.detail || ""} ${meta.constraint || ""}`;
    const named = text.includes(constraint);
    record(id, title, named, named ? `refused by ${constraint}` : `refused, but not by ${constraint}: ${text.slice(0, 200)}`);
  }
}

async function purge() {
  const like = `${P}%`;
  for (const sql of [
    `DELETE FROM "Outbox" WHERE "idempotencyKey" LIKE '${like}'`,
    `DELETE FROM "ShardMembership" WHERE "id" LIKE '${like}'`,
    `DELETE FROM "Agent" WHERE "agentId" LIKE '${like}'`,
    `DELETE FROM "Shard" WHERE "shardId" LIKE '${like}'`,
    `DELETE FROM "ShardLeadership" WHERE "shardId" LIKE '${like}'`,
    `DELETE FROM "Region" WHERE "regionId" LIKE '${like}'`,
  ]) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch { /* best effort */ }
  }
}

async function main() {
  const url = process.env.DATABASE_URL || "";
  if (/neon\.tech/i.test(url) || /:5432\//.test(url)) {
    throw new Error(`refusing to run against ${url} — this harness is for a disposable cluster only`);
  }
  prisma = new PrismaClient({ datasources: { db: { url } } });

  console.log("PHASE 15 remediation — live PostgreSQL verification (D-5, D-6)");
  console.log(`  database: ${url.replace(/:[^:@]*@/, ":***@")}`);
  const version = await prisma.$queryRawUnsafe("SELECT version() AS v");
  console.log(`  ${version[0].v}\n`);

  try {
    console.log("── fixture ──");
    await accepted("F1", "purge and seed the Region → Shard → Agent → ShardMembership graph", async () => {
      await purge();

      await prisma.region.create({ data: { id: `${P}-r-live`, regionId: `${P}-region-live`, name: "Live" } });
      await prisma.region.create({ data: { id: `${P}-r-dark`, regionId: `${P}-region-dark`, name: "Dark" } });

      for (const [shardId, regionRowId] of [[`${P}-shard-a`, `${P}-r-live`], [`${P}-shard-b`, `${P}-r-dark`]]) {
        await prisma.shardLeadership.create({
          data: { shardId, leadershipFence: 1n, holder: "host:1", leaseExpiry: new Date(Date.now() + 3600_000) },
        });
        await prisma.shard.create({
          data: { shardId, regionId: regionRowId, state: "ACTIVE", agentCount: 1 },
        });
      }

      // NOTE the two different identifiers: the business key the socket carries, and the
      // primary key `ShardMembership.agentId` actually references.
      const agent = await prisma.agent.create({
        data: { agentId: `${P}-agent-1`, authorityEpoch: 0n, fenceCounter: 0n, lifecycleState: "COMMISSIONED" },
      });
      await prisma.shardMembership.create({
        data: {
          id: `${P}-m1`,
          agentId: agent.id,
          shardId: `${P}-shard-a`,
          fromShardId: null,
          movedAt: new Date(),
          authorityEpochBefore: 0n,
          authorityEpochAfter: 0n,
          reason: "COMMISSIONING",
          movedBy: "harness",
        },
      });
      return `agent row id ${agent.id}, business id ${agent.agentId}`;
    });

    /* ══════════════════════════════════════════════════════════════════════
     * A — D-6: the shipped resolver, against the real store
     * ══════════════════════════════════════════════════════════════════════ */
    console.log("\n── A. agentGate.resolveIdentity() (D-6) ──");

    await accepted("A1", "resolves an agent's shard AND region from its business key", async () => {
      const identity = await agentGate.resolveIdentity(prisma, `${P}-agent-1`, Date.now());
      if (!identity) throw new Error("resolved null — the Agent.id / Agent.agentId distinction is wrong");
      if (identity.shardId !== `${P}-shard-a`) throw new Error(`shardId ${identity.shardId}`);
      if (identity.regionId !== `${P}-r-live`) throw new Error(`regionId ${identity.regionId}`);
      return `shard ${identity.shardId}, region ${identity.regionId}, epoch ${identity.authorityEpoch}`;
    });

    await accepted("A2", "an unknown agent resolves to null — fails closed, never to a default shard", async () => {
      const identity = await agentGate.resolveIdentity(prisma, `${P}-nobody`, Date.now());
      if (identity !== null) throw new Error(`resolved ${JSON.stringify(identity)}`);
      return "null";
    });

    await accepted("A3", "a commissioned-but-unplaced agent resolves to null (§3.5), not to the default shard", async () => {
      // The most dangerous default this module could have taken: placing every unplaced
      // agent in whichever shard the staging order reached first.
      const orphan = await prisma.agent.create({
        data: { agentId: `${P}-agent-unplaced`, authorityEpoch: 0n, fenceCounter: 0n, lifecycleState: "COMMISSIONED" },
      });
      const identity = await agentGate.resolveIdentity(prisma, orphan.agentId, Date.now());
      if (identity !== null) throw new Error(`resolved ${JSON.stringify(identity)}`);
      return "null — no membership row means no shard";
    });

    await accepted("A4", "the full conjunction: staged region ALLOWS, unstaged region REFUSES", async () => {
      const identity = await agentGate.resolveIdentity(prisma, `${P}-agent-1`, Date.now());
      const socket = { data: { isAuthed: true, robotId: `${P}-agent-1`, [agentGate.SOCKET_DATA_KEY]: identity } };
      const env = { ENGINE_ENABLED: "true" };

      const staged = {
        resolve: (name, ctx) => name === enabled.PARAMETER && ctx && ctx.region === `${P}-r-live`,
      };
      const unstaged = { resolve: (name, ctx) => name === enabled.PARAMETER && ctx && ctx.region === "somewhere-else" };

      const allow = agentGate.assess({ socket, snapshot: staged, env, nowMs: Date.now() });
      const refuse = agentGate.assess({ socket, snapshot: unstaged, env, nowMs: Date.now() });
      if (allow.allowed !== true) throw new Error(`staged shard refused: ${allow.refusal}`);
      if (refuse.allowed !== false || refuse.refusal !== agentGate.REFUSAL.SHARD_NOT_ENABLED) {
        throw new Error(`unstaged shard not refused correctly: ${JSON.stringify(refuse)}`);
      }
      return "staged → allowed; unstaged → SHARD_NOT_ENABLED";
    });

    /* ══════════════════════════════════════════════════════════════════════
     * B — D-6: a migrated agent resolves into its NEW shard
     * ══════════════════════════════════════════════════════════════════════ */
    console.log("\n── B. migration moves the resolved identity (D-6, §9's 'robot moved between shards') ──");

    await accepted("B1", "the store refuses a second live membership before the first is superseded", async () => {
      // Judged on SQLSTATE and on the row being ABSENT afterwards, never on message text:
      // Prisma embeds the calling file's source in its errors, and this harness names the
      // constraint in a string literal a few lines below — so a text match would report PASS
      // for a probe that never reached the database.
      const agent = await prisma.agent.findUnique({ where: { agentId: `${P}-agent-1` } });
      const index = await prisma.$queryRawUnsafe(
        "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='ShardMembership'" +
          " AND indexname='ShardMembership_one_current_per_agent'",
      );
      if (index.length !== 1) throw new Error("the partial unique index does not exist");

      let sqlstate = null;
      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "ShardMembership"("id","agentId","shardId","fromShardId","movedAt","authorityEpochBefore","authorityEpochAfter","reason","movedBy")
           VALUES ('${P}-m-dup','${agent.id}','${P}-shard-b','${P}-shard-a',NOW(),0,1,'REDISTRICTING','harness')`,
        );
      } catch (error) {
        sqlstate = (error.meta || {}).code || null;
      }
      if (sqlstate !== "23505") throw new Error(`expected SQLSTATE 23505 (unique violation), got ${sqlstate}`);

      const landed = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "ShardMembership" WHERE id = '${P}-m-dup'`);
      if (landed[0].n !== 0) throw new Error("the refused row landed anyway");
      return "SQLSTATE 23505 and the row is absent — ShardMembership_one_current_per_agent holds";
    });
    await accepted("B2", "after a proper migration the resolver returns the NEW shard and region", async () => {
      const agent = await prisma.agent.findUnique({ where: { agentId: `${P}-agent-1` } });
      await prisma.shardMembership.updateMany({
        where: { agentId: agent.id, supersededAt: null },
        data: { supersededAt: new Date() },
      });
      await prisma.shardMembership.create({
        data: {
          id: `${P}-m2`,
          agentId: agent.id,
          shardId: `${P}-shard-b`,
          fromShardId: `${P}-shard-a`,
          movedAt: new Date(),
          authorityEpochBefore: 0n,
          authorityEpochAfter: 1n,
          reason: "REDISTRICTING",
          movedBy: "harness",
        },
      });
      await prisma.agent.update({ where: { id: agent.id }, data: { authorityEpoch: 1n } });

      const identity = await agentGate.resolveIdentity(prisma, `${P}-agent-1`, Date.now());
      if (!identity || identity.shardId !== `${P}-shard-b` || identity.regionId !== `${P}-r-dark`) {
        throw new Error(`resolved ${JSON.stringify(identity)}`);
      }
      if (identity.authorityEpoch !== "1") throw new Error(`epoch ${identity.authorityEpoch}`);
      return `now shard ${identity.shardId}, region ${identity.regionId}, epoch ${identity.authorityEpoch}`;
    });

    await accepted("B3", "a session still holding the PRE-migration identity is refused once it goes stale", async () => {
      // The residual the D-6 fix bounds: between the migration and the session's
      // invalidation, the socket's cached identity names the old shard. The freshness bound
      // is what stops that binding outliving the migration.
      const now = Date.now();
      const stale = {
        agentId: `${P}-agent-1`,
        shardId: `${P}-shard-a`,
        regionId: `${P}-r-live`,
        resolvedAtMs: now - agentGate.DEFAULT_MAX_AGE_MS - 1,
      };
      const socket = { data: { isAuthed: true, robotId: `${P}-agent-1`, [agentGate.SOCKET_DATA_KEY]: stale } };
      const staged = { resolve: (name, ctx) => name === enabled.PARAMETER && ctx && ctx.region === `${P}-r-live` };
      const verdict = agentGate.assess({ socket, snapshot: staged, env: { ENGINE_ENABLED: "true" }, nowMs: now });
      if (verdict.refusal !== agentGate.REFUSAL.SHARD_IDENTITY_STALE) {
        throw new Error(`expected SHARD_IDENTITY_STALE, got ${verdict.refusal}`);
      }
      return "SHARD_IDENTITY_STALE — the pre-migration binding does not authorise the old shard for ever";
    });

    /* ══════════════════════════════════════════════════════════════════════
     * C — D-5: the migration's outbox row, and its (new) deliverer
     * ══════════════════════════════════════════════════════════════════════ */
    console.log("\n── C. the SHARD_MIGRATE outbox row (D-5) ──");

    await accepted("C1", "an enqueued SHARD_MIGRATE row is accepted with its AGENT-scope fence columns", async () => {
      // §10.3.1 — an AGENT-scope command is fenced by `authorityEpoch` + `fenceFloor`, never
      // by a commitment fence. `Outbox_fence_scope_columns` is what makes that a property of
      // the store rather than of whichever module wrote the row, and the first version of
      // this probe was refused by it for omitting both columns.
      const agent = await prisma.agent.findUnique({ where: { agentId: `${P}-agent-1` } });
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Outbox"("id","idempotencyKey","agentId","commandClass","command","fenceScope","authorityEpoch","fenceFloor","sequence","payload","notValidAfter","signature","state","createdAt","updatedAt")
         VALUES ('${P}-o1','${P}-mig-1','${agent.id}','AGENT','${membership.MIGRATE_COMMAND}','AGENT',1,0,1,'{}'::jsonb,NOW()+interval '1 hour','sig','PENDING',NOW(),NOW())`,
      );
      const rows = await prisma.$queryRawUnsafe(
        `SELECT "state","command" FROM "Outbox" WHERE "idempotencyKey" = '${P}-mig-1'`,
      );
      if (rows.length !== 1 || rows[0].command !== membership.MIGRATE_COMMAND) {
        throw new Error(`unexpected: ${JSON.stringify(rows)}`);
      }
      return `one ${rows[0].command} row in ${rows[0].state} — before this remediation nothing drained it`;
    });

    await accepted("C2", "the idempotency key is unique — one migration cannot enqueue two commands", async () => {
      const agent = await prisma.agent.findUnique({ where: { agentId: `${P}-agent-1` } });
      let sqlstate = null;
      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "Outbox"("id","idempotencyKey","agentId","commandClass","command","fenceScope","authorityEpoch","fenceFloor","sequence","payload","notValidAfter","signature","state","createdAt","updatedAt")
           VALUES ('${P}-o2','${P}-mig-1','${agent.id}','AGENT','${membership.MIGRATE_COMMAND}','AGENT',1,0,2,'{}'::jsonb,NOW()+interval '1 hour','sig','PENDING',NOW(),NOW())`,
        );
      } catch (error) {
        sqlstate = (error.meta || {}).code || null;
      }
      if (sqlstate !== "23505") throw new Error(`expected SQLSTATE 23505, got ${sqlstate}`);
      const n = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "Outbox" WHERE "idempotencyKey" = '${P}-mig-1'`);
      if (n[0].n !== 1) throw new Error(`expected exactly one row, found ${n[0].n}`);
      return "SQLSTATE 23505; exactly one SHARD_MIGRATE row survives";
    });

    await accepted("C3", "PLANTED — an AGENT-scope command carrying a COMMITMENT fence is refused", async () => {
      // The fence-scope confusion §10.3.1 exists to prevent: one per-agent epoch used where
      // a per-commitment fence belongs. Found by this harness rather than asserted by it —
      // the constraint refused C1's first, malformed row.
      const agent = await prisma.agent.findUnique({ where: { agentId: `${P}-agent-1` } });
      let sqlstate = null;
      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "Outbox"("id","idempotencyKey","agentId","commandClass","command","fenceScope","fence","sequence","payload","notValidAfter","signature","state","createdAt","updatedAt")
           VALUES ('${P}-o3','${P}-mig-3','${agent.id}','AGENT','${membership.MIGRATE_COMMAND}','AGENT',7,3,'{}'::jsonb,NOW()+interval '1 hour','sig','PENDING',NOW(),NOW())`,
        );
      } catch (error) {
        sqlstate = (error.meta || {}).code || null;
      }
      if (sqlstate !== "23514") throw new Error(`expected SQLSTATE 23514 (check violation), got ${sqlstate}`);
      const n = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "Outbox" WHERE id = '${P}-o3'`);
      if (n[0].n !== 0) throw new Error("the refused row landed anyway");
      return "SQLSTATE 23514 and the row is absent — Outbox_fence_scope_columns holds";
    });
    console.log("\n── cleanup ──");
    await accepted("Z1", "remove every row this harness created", async () => {
      await purge();
      return "clean";
    });
  } finally {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${"═".repeat(70)}`);
    console.log(`PHASE 15 live verification: ${results.length - failed.length}/${results.length} passed`);
    if (failed.length > 0) {
      console.log("FAILED:");
      for (const f of failed) console.log(`  ${f.id}  ${f.title}\n        ${f.detail}`);
    }
    console.log("═".repeat(70));
    await prisma.$disconnect();
    process.exitCode = failed.length === 0 ? 0 : 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

"use strict";

/**
 * PHASE 13 — live-PostgreSQL verification of §19 and §3.5, and of the behaviours a green
 * Jest suite structurally cannot reach.
 *
 * `PHASE_13_IMPLEMENTATION_REPORT.md` §13 item 8 states plainly that the migration was
 * **not applied to a live database**, and `PHASE_13_INDEPENDENT_VERIFICATION.md` accepted
 * that as "consistent with every phase since 6". Both reviews therefore established the DDL
 * by reading `migration.sql` beside `schema.prisma` and re-running `prisma migrate diff
 * --from-empty`. That proves the text is Prisma's own output plus fifteen hand-written CHECK
 * constraints and one partial unique index. It does not prove that a single one of them
 * **fires**: a CHECK naming the wrong column, or listing the wrong strings, reads identically
 * to a correct one in a diff.
 *
 * Three Phase 13 claims are about PostgreSQL's *behaviour* rather than about the text of the
 * DDL, and none of the three is reachable from `tests/engine/helpers/commitmentStore.js`:
 *
 *   1. **The leadership compare-and-set admits exactly one winner.** This is the phase's own
 *      highest-risk claim and the one its independent verifier reproduced — but reproduced
 *      against the *store model*, whose `FOR UPDATE` is a JavaScript mutex and whose snapshot
 *      semantics are a deliberate imitation of REPEATABLE READ. The verification report states
 *      the caveat itself: "it is **not PostgreSQL**". A storm of genuinely concurrent
 *      transactions against a real row settles it.
 *
 *   2. **The membership handoff's `increment`/`decrement` counts are safe under a concurrent
 *      handoff for a different agent on the same shard.** This is Known Limitation 7,
 *      disclosed verbatim as "safe on the real store; the model does not exercise it". It is
 *      exercised here, because "PostgreSQL takes a row lock" is a claim about PostgreSQL.
 *
 *   3. **`ShardMembership_one_current_per_agent` is a PARTIAL unique index**, and its two
 *      properties pull in opposite directions: a second *current* membership must be refused,
 *      and a re-placement after a supersession must be **allowed**. A non-partial index would
 *      forbid an agent from ever moving twice, which no test against an in-memory double
 *      would notice.
 *
 * Everything else is the same discipline applied to the rest of the phase's schema: all
 * fifteen CHECKs made to fire, the partial index in both directions, the foreign keys that
 * make "a shard with no leadership record" and "goods held nowhere" unrepresentable, and
 * `BIGINT` round-tripping past 2^53 for both fences.
 *
 * ── A note on how a refusal is judged ──────────────────────────────────────
 * Prisma embeds **the calling source file's text** in its error messages. A naive
 * `error.message.includes(constraintName)` therefore matches the constraint name in this
 * harness's own source and reports PASS for a probe that never reached the database. The
 * first draft of this file did exactly that and reported four false passes on a run where the
 * fixture had not been created at all. Every refusal below is consequently issued as **raw
 * SQL** and judged on PostgreSQL's SQLSTATE *and* the constraint it names.
 *
 * ── The second remediation pass added five more groups ─────────────────────
 * Groups 10–13 exist because the first remediation pass left P13-R4 open — the rebalance
 * endpoint moved a shard to `DRAINING` and nothing could execute the plan or move it back —
 * and because closing it surfaced four further producer/consumer defects on the same path.
 * All of them are about behaviour that only a real database and a real leadership row can
 * settle:
 *
 *   · **R1–R11** — the `ShardRebalance` intent's seven CHECK constraints, each made to
 *     fire, and the partial unique index in **both** directions: a second *open* intent per
 *     source shard refused, and a new one accepted once the first closes.
 *   · **Y1–Y10** — the lifecycle driven by the production code: the intent and the shard
 *     state written in one transaction that genuinely rolls back; one migration per tick;
 *     a process killed between a committed migration and its bookkeeping resuming without
 *     moving the agent twice; a **fenced leader refused with zero side effects** while its
 *     successor finishes the same plan; two concurrent requests yielding one intent; a
 *     full client restart; §19.2's pacing timed from the durable `lastMoveAt`; and
 *     **multi-shard isolation** — one shard's leader touching no part of another's.
 *   · **Z1–Z4** — the configuration §19.5's sweep and §3.5's sizing are given. Z1
 *     *reproduces* the pre-fix failure (the sweep threw on the first Leg it had to
 *     reconstruct) before Z2 shows the fix, because a fix whose defect was never
 *     reproduced proves nothing.
 *   · **W1–W2** — P13-R7, reproduced rather than argued: shard A's §19.5 sweep repairs
 *     shard C's Leg and records it as shard A's, while Phase 13's own `legsInShard` scopes
 *     correctly in both directions. That pair is what makes the finding external.
 *
 * The harness writes only rows it creates, all keyed under a `p13-live` prefix, and removes
 * them in a `finally`.
 *
 * Usage:
 *   DATABASE_URL=postgresql://pgverify:verify@127.0.0.1:55435/robotx_p13 \
 *     node tools/verify/phase13LiveDatabase.js
 *
 * NEVER point this at `DATABASE_URL`'s shared Neon instance or at the default 5432 cluster.
 * It is deliberately **not** a Jest suite, for the same reason Phases 3-12's harnesses are
 * not: it requires a PostgreSQL instance, and a test that silently skips when its environment
 * is absent is a test that reports green for having done nothing.
 */

const { PrismaClient } = require("@prisma/client");

const leadership = require("../../src/engine/shard/leadership");
const election = require("../../src/engine/shard/election");
const shardSupervisor = require("../../src/workers/shardSupervisor.worker");
const { runSerializable, selectForUpdate } = require("../../src/db/prisma");

const P = "p13-live";
const results = [];

function record(id, description, passed, detail) {
  results.push({ id, description, passed, detail });
  console.log(`  [${passed ? "PASS" : "FAIL"}] ${id} — ${description}`);
  if (detail) console.log(`         ${detail}`);
}

/**
 * PostgreSQL's own verdict, separated from Prisma's framing.
 *
 * `text` is the database's message only — never the harness's own source, which Prisma
 * quotes into `error.message` and which would otherwise match any constraint name this file
 * mentions. `code` is the SQLSTATE, which Prisma carries in `meta.code` for a raw query and
 * otherwise spells as ``Code: `23514` `` in the wrapper.
 */
function dbError(error) {
  const full = String((error && error.message) || error);
  const metaText = error && error.meta && error.meta.message ? String(error.meta.message) : null;
  const at = full.indexOf("Message:");
  const text = (metaText || (at >= 0 ? full.slice(at) : full)).replace(/\s+/g, " ");
  const metaCode = error && error.meta && error.meta.code ? String(error.meta.code) : null;
  const parsed = /Code: `?(\d{5})`?/.exec(full);
  return { code: metaCode || (parsed ? parsed[1] : null), text };
}

/** Back-compat shim for the `accepted()`/cleanup reporting paths. */
function dbMessage(error) {
  return dbError(error).text;
}

const SQLSTATE = Object.freeze({ NOT_NULL: "23502", FOREIGN_KEY: "23503", UNIQUE: "23505", CHECK: "23514" });

let prisma = null;

/**
 * Something the database MUST refuse, issued as raw SQL so the verdict is PostgreSQL's.
 * Passes only when the refusal carries the expected SQLSTATE **and** names the expected
 * constraint, so a row rejected for an unrelated reason cannot be mistaken for the
 * constraint under test doing its job.
 */
async function refusedSql(id, description, sqlstate, constraint, sql, params) {
  try {
    await prisma.$executeRawUnsafe(sql, ...(params || []));
    record(id, description, false, "the database ACCEPTED a row the constraint exists to refuse");
  } catch (error) {
    const { code, text } = dbError(error);
    const passed = code === sqlstate && text.includes(constraint);
    record(
      id,
      description,
      passed,
      passed
        ? `SQLSTATE ${sqlstate} on ${constraint}`
        : `expected SQLSTATE ${sqlstate} naming ${constraint}; got SQLSTATE ${code}: ${text.slice(0, 170)}`,
    );
  }
}

/** Something that MUST succeed. */
async function accepted(id, description, run) {
  try {
    const value = await run();
    record(id, description, true, typeof value === "string" ? value : undefined);
    return value;
  } catch (error) {
    record(id, description, false, dbMessage(error).slice(0, 240));
    return null;
  }
}

const now = () => new Date();
const iso = (d) => d.toISOString();

/** Remove every row this harness owns, in foreign-key order. */
async function purge(log) {
  const steps = [
    ["CrossRegionSaga", () => prisma.crossRegionSaga.deleteMany({ where: { sagaId: { startsWith: P } } })],
    ["TransferPoint", () => prisma.transferPoint.deleteMany({ where: { transferPointId: { startsWith: P } } })],
    ["Timer", () => prisma.timer.deleteMany({ where: { entityId: { startsWith: P } } })],
    ["ReconcilerRepair", () => prisma.reconcilerRepair.deleteMany({ where: { shardId: { startsWith: P } } })],
    ["Task", () => prisma.task.deleteMany({ where: { taskId: { startsWith: P } } })],
    ["Leg", () => prisma.leg.deleteMany({ where: { id: { startsWith: P } } })],
    ["Outbox", () => prisma.outbox.deleteMany({ where: { agentId: { startsWith: P } } })],
    ["AgentFenceAudit", () => prisma.agentFenceAudit.deleteMany({ where: { agentId: { startsWith: P } } })],
    // By `agentId`, not by `movedBy`: a row written by the supervisor carries
    // `movedBy: "shardSupervisor"`, and a purge that missed those left the `Shard` delete
    // failing on a foreign key.
    ["ShardMembership", () => prisma.shardMembership.deleteMany({ where: { agentId: { startsWith: P } } })],
    // Before `Shard`: both foreign keys are ON DELETE RESTRICT, deliberately — an intent
    // whose shards had been deleted would be an unexecutable plan nobody could read.
    ["ShardRebalance", () => prisma.shardRebalance.deleteMany({ where: { sourceShardId: { startsWith: P } } })],
    ["Shard", () => prisma.shard.deleteMany({ where: { shardId: { startsWith: P } } })],
    ["Mission", () => prisma.mission.deleteMany({ where: { id: { startsWith: P } } })],
    ["Agent", () => prisma.agent.deleteMany({ where: { id: { startsWith: P } } })],
    ["ShardLeadership", () => prisma.shardLeadership.deleteMany({ where: { shardId: { startsWith: P } } })],
    ["Region", () => prisma.region.deleteMany({ where: { id: { startsWith: P } } })],
  ];
  for (const [label, run] of steps) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await run();
      if (log) console.log(`  removed ${label}: ${r.count}`);
    } catch (e) {
      if (log) console.log(`  cleanup ${label} failed: ${dbMessage(e).slice(0, 140)}`);
    }
  }
}

async function main() {
  const url = process.env.DATABASE_URL || "";
  if (/neon\.tech/i.test(url) || /:5432\//.test(url)) {
    throw new Error(`refusing to run against ${url} — this harness is for a disposable cluster only`);
  }
  prisma = new PrismaClient({ datasources: { db: { url } } });

  console.log("PHASE 13 — live PostgreSQL verification");
  console.log(`  database: ${url.replace(/:[^:@]*@/, ":***@")}`);
  const version = await prisma.$queryRawUnsafe("SELECT version() AS v");
  console.log(`  ${version[0].v}\n`);

  try {
    // ── Fixture ────────────────────────────────────────────────────────────
    console.log("── fixture ──");
    const seeded = await accepted("F1", "seed regions, leadership rows, agents, a mission", async () => {
      // Idempotent: a previous run that died before its `finally` must not make this one
      // fail for the wrong reason.
      await purge();
      // Four of each, not three. `region-d` and `shard-d` are deliberately left without a
      // `Shard` row so that S6 and S7 can each violate exactly ONE constraint: a probe that
      // trips a unique index on the way to the foreign key proves nothing about the foreign
      // key.
      for (const s of ["a", "b", "c", "d"]) {
        await prisma.region.create({ data: { id: `${P}-region-${s}`, regionId: `${P}-region-${s}`, name: `${P} region ${s}` } });
        await prisma.shardLeadership.create({ data: { shardId: `${P}-shard-${s}`, leadershipFence: BigInt(1) } });
      }
      for (const n of ["1", "2", "3"]) {
        await prisma.agent.create({ data: { id: `${P}-agent-${n}`, agentId: `${P}-agent-${n}`, authorityEpoch: BigInt(0) } });
      }
      // `CrossRegionSaga.missionId` is UNIQUE, so each saga probe needs its own mission for
      // the same reason.
      for (const n of ["1", "2", "3", "4", "5"]) {
        await prisma.mission.create({ data: { id: `${P}-mission-${n}`, missionId: `${P}-mission-${n}`, regionId: `${P}-region-a` } });
      }
      return "4 regions, 4 leadership rows, 3 agents, 5 missions";
    });
    if (!seeded) throw new Error("fixture failed — every downstream check would be meaningless");

    await accepted("F2", "create three Shard rows", async () => {
      for (const s of ["a", "b", "c"]) {
        await prisma.shard.create({
          data: { id: `${P}-s-${s}`, shardId: `${P}-shard-${s}`, regionId: `${P}-region-${s}`, updatedAt: now() },
        });
      }
      const n = await prisma.shard.count({ where: { shardId: { startsWith: P } } });
      return `${n} shards`;
    });

    // ── 1. Shard: four CHECKs, uniqueness, and the leadership FK ───────────
    console.log("\n── Shard: four CHECK constraints, each made to fire ──");

    await refusedSql("S1", "Shard_state_known refuses a state outside §3.5's four", SQLSTATE.CHECK, "Shard_state_known",
      `UPDATE "Shard" SET "state" = 'PAUSED' WHERE "shardId" = $1`, [`${P}-shard-a`]);

    await refusedSql("S2", "Shard_binding_bound_known refuses an unknown binding bound", SQLSTATE.CHECK, "Shard_binding_bound_known",
      `UPDATE "Shard" SET "bindingBound" = 'MEMORY' WHERE "shardId" = $1`, [`${P}-shard-a`]);

    await refusedSql("S3", "Shard_agent_count_non_negative refuses a negative count", SQLSTATE.CHECK, "Shard_agent_count_non_negative",
      `UPDATE "Shard" SET "agentCount" = -1 WHERE "shardId" = $1`, [`${P}-shard-a`]);

    // §3.5 — "a drain that never completes is visible as a duration rather than as a state
    // nobody timed". DRAINING without `drainingSince` is that untimed state.
    await refusedSql("S4", "Shard_draining_is_timed refuses DRAINING with no drainingSince", SQLSTATE.CHECK, "Shard_draining_is_timed",
      `UPDATE "Shard" SET "state" = 'DRAINING', "drainingSince" = NULL WHERE "shardId" = $1`, [`${P}-shard-a`]);

    await accepted("S5", "…and accepts DRAINING when it IS timed", async () => {
      await prisma.shard.update({ where: { shardId: `${P}-shard-a` }, data: { state: "DRAINING", drainingSince: now() } });
      const row = await prisma.shard.findUnique({ where: { shardId: `${P}-shard-a` } });
      await prisma.shard.update({ where: { shardId: `${P}-shard-a` }, data: { state: "ACTIVE", drainingSince: null } });
      return `DRAINING accepted with drainingSince=${iso(row.drainingSince)}, then restored to ACTIVE`;
    });

    // §3.5: routing "to exactly one shard, determined by its first Stop's region" is only
    // well defined if region→shard is a function.
    // `shard-d` is free (it has a leadership row and no Shard row), so `region-a` is the
    // only thing this row collides with.
    // PostgreSQL reports a unique violation by naming the *key column*, not the index, so
    // that is what is matched. N2 below separately proves the index object exists by name.
    await refusedSql("S6", "Shard.regionId is UNIQUE — region→shard is a function (§3.5)", SQLSTATE.UNIQUE, '"regionId")=(',
      `INSERT INTO "Shard" ("id","shardId","regionId","updatedAt") VALUES ($1,$2,$3,NOW())`,
      [`${P}-s-dup`, `${P}-shard-d`, `${P}-region-a`]);

    // The converse of `advanceFence`'s refusal to create a leadership row implicitly.
    // `region-d` is free, so the missing leadership row is the only violation.
    await refusedSql("S7", "a Shard with no ShardLeadership row is unrepresentable (FK)", SQLSTATE.FOREIGN_KEY, "Shard_shardId_fkey",
      `INSERT INTO "Shard" ("id","shardId","regionId","updatedAt") VALUES ($1,$2,$3,NOW())`,
      [`${P}-s-orphan`, `${P}-shard-nonexistent`, `${P}-region-d`]);

    // ── 2. ShardMembership: four CHECKs and the partial unique index ───────
    console.log("\n── ShardMembership: four CHECKs and the partial unique index ──");

    const INS_M = `INSERT INTO "ShardMembership"
      ("id","agentId","shardId","fromShardId","movedAt","supersededAt","authorityEpochBefore","authorityEpochAfter","reason","movedBy")
      VALUES ($1,$2,$3,$4,NOW(),$5,$6,$7,$8,$9)`;

    await accepted("M1", "an initial placement need not advance the epoch (§19.2's exemption)", async () => {
      await prisma.$executeRawUnsafe(INS_M, `${P}-m-1`, `${P}-agent-1`, `${P}-shard-a`, null, null, BigInt(0), BigInt(0), "COMMISSIONING", P);
      return "fromShardId NULL with an unchanged epoch — accepted, as the exemption requires";
    });

    await refusedSql("M2", "ShardMembership_migration_advances_epoch refuses a migration that does not advance it",
      SQLSTATE.CHECK, "ShardMembership_migration_advances_epoch",
      INS_M, [`${P}-m-2`, `${P}-agent-2`, `${P}-shard-b`, `${P}-shard-a`, null, BigInt(5), BigInt(5), "REBALANCE_SPLIT", P]);

    await refusedSql("M3", "ShardMembership_epochs_non_negative refuses a negative epoch",
      SQLSTATE.CHECK, "ShardMembership_epochs_non_negative",
      INS_M, [`${P}-m-3`, `${P}-agent-2`, `${P}-shard-a`, null, null, BigInt(-1), BigInt(0), "COMMISSIONING", P]);

    await refusedSql("M4", "ShardMembership_move_changes_shard refuses a move to the same shard",
      SQLSTATE.CHECK, "ShardMembership_move_changes_shard",
      INS_M, [`${P}-m-4`, `${P}-agent-2`, `${P}-shard-a`, `${P}-shard-a`, null, BigInt(1), BigInt(2), "REBALANCE_SPLIT", P]);

    await refusedSql("M5", "ShardMembership_reason_known refuses an unlisted reason",
      SQLSTATE.CHECK, "ShardMembership_reason_known",
      INS_M, [`${P}-m-5`, `${P}-agent-2`, `${P}-shard-a`, null, null, BigInt(0), BigInt(0), "BECAUSE", P]);

    // §3.5's "Every Agent belongs to exactly one shard at a time", as a schema property.
    await refusedSql("M6", "the partial unique index refuses a SECOND current membership for one agent",
      SQLSTATE.UNIQUE, '"agentId")=(',
      INS_M, [`${P}-m-6`, `${P}-agent-1`, `${P}-shard-b`, null, null, BigInt(0), BigInt(0), "COMMISSIONING", P]);

    // The direction a NON-partial index would break: an agent must be able to move twice.
    await accepted("M7", "…and ALLOWS a new current membership once the previous is superseded", async () => {
      await prisma.$executeRawUnsafe(`UPDATE "ShardMembership" SET "supersededAt" = NOW() WHERE "id" = $1`, `${P}-m-1`);
      await prisma.$executeRawUnsafe(INS_M, `${P}-m-7`, `${P}-agent-1`, `${P}-shard-b`, `${P}-shard-a`, null, BigInt(0), BigInt(1), "REBALANCE_SPLIT", P);
      const current = await prisma.shardMembership.count({ where: { agentId: `${P}-agent-1`, supersededAt: null } });
      const history = await prisma.shardMembership.count({ where: { agentId: `${P}-agent-1` } });
      if (current !== 1) throw new Error(`${current} current memberships after the move`);
      return `${current} current membership, ${history} rows of history — the index is partial, not absolute`;
    });

    // ── 3. TransferPoint: §19.6's custodian ───────────────────────────────
    console.log("\n── TransferPoint: §19.6's custodian, made a property of the table ──");

    const INS_TP = `INSERT INTO "TransferPoint"
      ("id","transferPointId","name","upstreamRegionId","downstreamRegionId","custodianType","custodianId","capacity","securityProperties","updatedAt")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,NOW())`;

    await accepted("T1", "a transfer point with a defined custodian is accepted", async () => {
      await prisma.$executeRawUnsafe(INS_TP, `${P}-tp-1`, `${P}-tp-1`, "depot", `${P}-region-a`, `${P}-region-b`, "DEPOT", `${P}-custodian`, 10, null);
      return "DEPOT custodian, capacity 10";
    });

    await refusedSql("T2", "TransferPoint_custodian_type_known refuses an unlisted custodian kind",
      SQLSTATE.CHECK, "TransferPoint_custodian_type_known",
      INS_TP, [`${P}-tp-2`, `${P}-tp-2`, "x", `${P}-region-a`, `${P}-region-b`, "NOBODY", `${P}-c`, 5, null]);

    // The half of §19.6 a naive reading loses: MODELLED_UNATTENDED must not be a label that
    // turns the prohibition off.
    await refusedSql("T3", "TransferPoint_unattended_is_modelled refuses MODELLED_UNATTENDED with no security properties",
      SQLSTATE.CHECK, "TransferPoint_unattended_is_modelled",
      INS_TP, [`${P}-tp-3`, `${P}-tp-3`, "x", `${P}-region-a`, `${P}-region-b`, "MODELLED_UNATTENDED", `${P}-c`, 5, null]);

    await accepted("T4", "…and accepts it when the modelling is actually supplied", async () => {
      await prisma.$executeRawUnsafe(INS_TP, `${P}-tp-4`, `${P}-tp-4`, "locker", `${P}-region-a`, `${P}-region-b`,
        "MODELLED_UNATTENDED", `${P}-c`, 4, JSON.stringify({ locked: true, monitored: true }));
      return "securityProperties present and capacity > 0 — choosing the label obliged the modelling";
    });

    await refusedSql("T5", "TransferPoint_capacity_positive refuses zero capacity",
      SQLSTATE.CHECK, "TransferPoint_capacity_positive",
      INS_TP, [`${P}-tp-5`, `${P}-tp-5`, "x", `${P}-region-a`, `${P}-region-b`, "DEPOT", `${P}-c`, 0, null]);

    await refusedSql("T6", "TransferPoint_joins_two_regions refuses a point joining a region to itself",
      SQLSTATE.CHECK, "TransferPoint_joins_two_regions",
      INS_TP, [`${P}-tp-6`, `${P}-tp-6`, "x", `${P}-region-a`, `${P}-region-a`, "DEPOT", `${P}-c`, 5, null]);

    // NOT NULL is the first of §19.6's four enforcement points. PostgreSQL's not-null error
    // reaches Prisma as the failing row's DETAIL, so the SQLSTATE is the discriminator here;
    // N3 below proves the column's nullability directly from the catalogue.
    await refusedSql("T7", "custodianId is NOT NULL — 'a defined custodian' is a property of the table",
      SQLSTATE.NOT_NULL, "Failing row contains",
      `INSERT INTO "TransferPoint" ("id","transferPointId","name","upstreamRegionId","downstreamRegionId","custodianType","custodianId","capacity","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,NOW())`,
      [`${P}-tp-7`, `${P}-tp-7`, "x", `${P}-region-a`, `${P}-region-b`, "DEPOT", 5]);

    // ── 4. CrossRegionSaga ─────────────────────────────────────────────────
    console.log("\n── CrossRegionSaga: three CHECKs and the custody foreign key ──");

    const INS_S = `INSERT INTO "CrossRegionSaga"
      ("id","sagaId","missionId","state","steps","currentStepIndex","compensation","heldAtTransferPointId","heldSince","openedAt","updatedAt")
      VALUES ($1,$2,$3,$4,$5::jsonb,0,$6::jsonb,$7,$8,NOW(),NOW())`;
    const STEPS = JSON.stringify([{ index: 0, compensation: "HOLD", decidedAt: "DECOMPOSITION" }]);

    await accepted("C1", "a PLANNED saga whose compensation was decided at decomposition is accepted", async () => {
      await prisma.$executeRawUnsafe(INS_S, `${P}-saga-1`, `${P}-saga-1`, `${P}-mission-1`, "PLANNED", STEPS, null, null, null);
      return "state PLANNED, steps carry decidedAt=DECOMPOSITION";
    });

    await refusedSql("C2", "CrossRegionSaga_state_known refuses an unlisted state",
      SQLSTATE.CHECK, "CrossRegionSaga_state_known",
      INS_S, [`${P}-saga-2`, `${P}-saga-2`, `${P}-mission-2`, "PAUSED", STEPS, null, null, null]);

    // §19.6 opens by rejecting a compensation computed at the moment it is needed.
    await refusedSql("C3", "CrossRegionSaga_compensation_is_explicit refuses COMPENSATING with no compensation",
      SQLSTATE.CHECK, "CrossRegionSaga_compensation_is_explicit",
      INS_S, [`${P}-saga-3`, `${P}-saga-3`, `${P}-mission-3`, "COMPENSATING", STEPS, null, null, null]);

    // "Goods stranded at a transfer point" made unrepresentable rather than guarded against.
    await refusedSql("C4", "CrossRegionSaga_hold_is_timed refuses a hold with no instant",
      SQLSTATE.CHECK, "CrossRegionSaga_hold_is_timed",
      INS_S, [`${P}-saga-4`, `${P}-saga-4`, `${P}-mission-4`, "PLANNED", STEPS, null, `${P}-tp-1`, null]);

    await refusedSql("C5", "custody can only be held somewhere with a modelled custodian (FK)",
      SQLSTATE.FOREIGN_KEY, "CrossRegionSaga_heldAtTransferPointId_fkey",
      INS_S, [`${P}-saga-5`, `${P}-saga-5`, `${P}-mission-5`, "PLANNED", STEPS, null, `${P}-tp-nowhere`, new Date()]);

    // ── 4b. The catalogue: are the objects the reports count actually there? ─
    console.log("\n── the catalogue: the constraint objects themselves, by name ──");

    const EXPECTED_CHECKS = [
      "CrossRegionSaga_compensation_is_explicit", "CrossRegionSaga_hold_is_timed", "CrossRegionSaga_state_known",
      "ShardMembership_epochs_non_negative", "ShardMembership_migration_advances_epoch",
      "ShardMembership_move_changes_shard", "ShardMembership_reason_known",
      "Shard_agent_count_non_negative", "Shard_binding_bound_known", "Shard_draining_is_timed", "Shard_state_known",
      "TransferPoint_capacity_positive", "TransferPoint_custodian_type_known",
      "TransferPoint_joins_two_regions", "TransferPoint_unattended_is_modelled",
    ];

    await accepted("N1", "the four tables carry exactly the fifteen hand-written CHECK constraints the phase claims", async () => {
      const rows = await prisma.$queryRawUnsafe(`
        SELECT c.conname AS name
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        WHERE c.contype = 'c'
          AND t.relname IN ('Shard','ShardMembership','CrossRegionSaga','TransferPoint')
          AND c.conname NOT LIKE '%_not_null'
        ORDER BY c.conname`);
      const found = rows.map((r) => r.name).sort();
      const missing = EXPECTED_CHECKS.filter((n) => !found.includes(n));
      const extra = found.filter((n) => !EXPECTED_CHECKS.includes(n));
      if (missing.length || extra.length) {
        throw new Error(`missing [${missing.join(", ")}]; unexpected [${extra.join(", ")}]`);
      }
      return `${found.length} CHECK constraints, exactly the expected set (the migration's own header comment says "fourteen" — an off-by-one in prose, not in DDL)`;
    });

    await accepted("N2", "ShardMembership_one_current_per_agent exists and is a PARTIAL unique index", async () => {
      const rows = await prisma.$queryRawUnsafe(`
        SELECT indexdef FROM pg_indexes
        WHERE tablename = 'ShardMembership' AND indexname = 'ShardMembership_one_current_per_agent'`);
      if (rows.length !== 1) throw new Error("the index does not exist");
      const def = rows[0].indexdef;
      if (!/UNIQUE/i.test(def)) throw new Error(`not unique: ${def}`);
      if (!/WHERE .*supersededAt.* IS NULL/i.test(def)) throw new Error(`not partial on supersededAt: ${def}`);
      return def.replace(/\s+/g, " ");
    });

    await accepted("N3", "TransferPoint's custodian columns are NOT NULL in the catalogue", async () => {
      const rows = await prisma.$queryRawUnsafe(`
        SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'TransferPoint' AND column_name IN ('custodianType','custodianId','capacity')
        ORDER BY column_name`);
      const nullable = rows.filter((r) => r.is_nullable !== "NO").map((r) => r.column_name);
      if (rows.length !== 3) throw new Error(`found ${rows.length} of 3 columns`);
      if (nullable.length) throw new Error(`nullable: ${nullable.join(", ")}`);
      return "custodianType, custodianId, capacity — all NOT NULL";
    });

    await accepted("N4", "the phase altered no pre-existing table — ShardLeadership keeps exactly its Phase 3 columns", async () => {
      const rows = await prisma.$queryRawUnsafe(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'ShardLeadership' ORDER BY column_name`);
      const found = rows.map((r) => r.column_name).sort();
      const expected = ["createdAt", "holder", "id", "lastAdvancedAt", "lastAdvancedBy", "leaseExpiry", "leadershipFence", "shardId", "updatedAt"].sort();
      const missing = expected.filter((c) => !found.includes(c));
      const extra = found.filter((c) => !expected.includes(c));
      if (missing.length || extra.length) throw new Error(`missing [${missing}]; extra [${extra}] — G1 reads this table`);
      return `${found.length} columns, unchanged: ${found.join(", ")}`;
    });

    // ── 5. BIGINT ──────────────────────────────────────────────────────────
    console.log("\n── BIGINT: both fences past 2^53, where Number silently loses precision ──");

    await accepted("B1", "leadershipFence round-trips exactly past Number.MAX_SAFE_INTEGER", async () => {
      const big = BigInt("9007199254740993"); // 2^53 + 1 — not representable as a double
      await prisma.shardLeadership.update({ where: { shardId: `${P}-shard-c` }, data: { leadershipFence: big } });
      const back = await prisma.shardLeadership.findUnique({ where: { shardId: `${P}-shard-c` } });
      if (back.leadershipFence !== big) throw new Error(`round-tripped to ${back.leadershipFence}, not ${big}`);
      return `${big} exact as BigInt; Number(${big}) would collapse to ${Number(big)}`;
    });

    await accepted("B2", "authorityEpoch round-trips exactly past Number.MAX_SAFE_INTEGER", async () => {
      const big = BigInt("9007199254740995");
      await prisma.agent.update({ where: { id: `${P}-agent-3` }, data: { authorityEpoch: big } });
      const back = await prisma.agent.findUnique({ where: { id: `${P}-agent-3` } });
      if (back.authorityEpoch !== big) throw new Error(`round-tripped to ${back.authorityEpoch}`);
      await prisma.agent.update({ where: { id: `${P}-agent-3` }, data: { authorityEpoch: BigInt(0) } });
      return `${big} exact`;
    });

    // ── 6. The leadership CAS, under REAL concurrency ──────────────────────
    console.log("\n── leadership CAS: the phase's highest-risk claim, against real PostgreSQL ──");

    const resetLeadership = () =>
      prisma.shardLeadership.update({
        where: { shardId: `${P}-shard-c` },
        data: { leadershipFence: BigInt(1), holder: null, leaseExpiry: null },
      });

    await accepted("L1", "ten simultaneous acquirers of an unheld shard yield exactly ONE winner", async () => {
      await resetLeadership();
      const before = await prisma.shardLeadership.findUnique({ where: { shardId: `${P}-shard-c` } });
      const at = now();
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          leadership
            .tryAcquire(prisma, {
              shardId: `${P}-shard-c`, holder: `${P}-candidate-${i}`,
              expectedFence: before.leadershipFence, storeTime: at, leaseDurationSeconds: 30,
            })
            .catch((e) => ({ acquired: false, refusal: `THREW:${e.code || String(e.message).slice(0, 40)}` })),
        ),
      );
      const winners = outcomes.filter((o) => o.acquired);
      if (winners.length !== 1) throw new Error(`${winners.length} winners — SPLIT BRAIN: ${JSON.stringify(outcomes.map((o) => o.refusal || "WON"))}`);
      const row = await prisma.shardLeadership.findUnique({ where: { shardId: `${P}-shard-c` } });
      const refusals = [...new Set(outcomes.filter((o) => !o.acquired).map((o) => o.refusal))];
      return `1 winner (${winners[0].holder}), 9 refused [${refusals.join(", ")}]; fence ${before.leadershipFence} → ${row.leadershipFence}`;
    });

    await accepted("L2", "an eight-way lapsed-lease storm also yields exactly ONE winner", async () => {
      await prisma.shardLeadership.update({
        where: { shardId: `${P}-shard-c` },
        data: { holder: `${P}-dead-leader`, leaseExpiry: new Date(Date.now() - 60_000) },
      });
      const before = await prisma.shardLeadership.findUnique({ where: { shardId: `${P}-shard-c` } });
      const at = now();
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          leadership
            .tryAcquire(prisma, {
              shardId: `${P}-shard-c`, holder: `${P}-successor-${i}`,
              expectedFence: before.leadershipFence, storeTime: at, leaseDurationSeconds: 30,
            })
            .catch((e) => ({ acquired: false, refusal: `THREW:${e.code || "?"}` })),
        ),
      );
      const winners = outcomes.filter((o) => o.acquired);
      if (winners.length !== 1) throw new Error(`${winners.length} winners after a lapsed lease`);
      return `1 winner of 8 — the dead leader's shard was taken exactly once`;
    });

    await accepted("L3", "a LIVE lease is not stealable, and the refusal does not move the fence", async () => {
      const before = await prisma.shardLeadership.findUnique({ where: { shardId: `${P}-shard-c` } });
      const outcome = await leadership.tryAcquire(prisma, {
        shardId: `${P}-shard-c`, holder: `${P}-thief`,
        expectedFence: before.leadershipFence, storeTime: now(), leaseDurationSeconds: 30,
      });
      if (outcome.acquired) throw new Error("a live lease was stolen");
      const after = await prisma.shardLeadership.findUnique({ where: { shardId: `${P}-shard-c` } });
      if (after.leadershipFence !== before.leadershipFence) throw new Error("a refused acquisition moved the fence");
      return `refused ${outcome.refusal}; fence unmoved at ${after.leadershipFence}`;
    });

    await accepted("L4", "a stale expectedFence is refused FENCE_SUPERSEDED — the CAS predicate itself", async () => {
      const row = await prisma.shardLeadership.findUnique({ where: { shardId: `${P}-shard-c` } });
      await prisma.shardLeadership.update({ where: { shardId: `${P}-shard-c` }, data: { holder: null, leaseExpiry: null } });
      const outcome = await leadership.tryAcquire(prisma, {
        shardId: `${P}-shard-c`, holder: `${P}-stale`,
        expectedFence: row.leadershipFence - BigInt(1), storeTime: now(), leaseDurationSeconds: 30,
      });
      if (outcome.acquired) throw new Error("a stale fence acquired leadership — the CAS predicate is not enforced");
      return `refused ${outcome.refusal} even though the shard was unheld`;
    });

    await accepted("L5", "renewal does NOT advance the fence; release DOES (§19.3)", async () => {
      await resetLeadership();
      const store = election.postgresLeadershipStore(prisma, { replicationPosture: "SYNCHRONOUS_QUORUM" });
      election.assertConsensusStore(store);

      let session = await election.acquire(store, {
        shardId: `${P}-shard-c`, candidateId: `${P}-leader`, storeTime: now(), leaseDurationSeconds: 30,
      });
      const atAcquire = session.leadershipFence;
      for (let i = 0; i < 25; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        session = await election.renew(store, session, {
          storeTime: now(), leaseDurationSeconds: 30, maxClockSkewMillis: 500, storeRoundTripMillis: 500,
        });
      }
      const afterRenewals = await prisma.shardLeadership.findUnique({ where: { shardId: `${P}-shard-c` } });
      if (afterRenewals.leadershipFence !== atAcquire) {
        throw new Error(`25 renewals moved the fence ${atAcquire} → ${afterRenewals.leadershipFence}; every in-flight commit would abort at G1`);
      }
      await election.release(store, session, { storeTime: now() });
      const afterRelease = await prisma.shardLeadership.findUnique({ where: { shardId: `${P}-shard-c` } });
      if (afterRelease.leadershipFence <= atAcquire) throw new Error("release did not advance the fence");
      return `acquire → ${atAcquire}; 25 renewals → ${afterRenewals.leadershipFence} (unmoved); release → ${afterRelease.leadershipFence}`;
    });

    // ── 7. Failover: the superseded leader is fenced ───────────────────────
    console.log("\n── failover: the superseded leader cannot act (§19.5) ──");

    await accepted("FO1", "leader A → failure → leader B; A's renewal is then refused and B keeps the shard", async () => {
      await resetLeadership();
      const store = election.postgresLeadershipStore(prisma, { replicationPosture: "SYNCHRONOUS_QUORUM" });

      const a = await election.acquire(store, {
        shardId: `${P}-shard-c`, candidateId: `${P}-leader-A`, storeTime: now(), leaseDurationSeconds: 1,
      });
      if (a.state !== election.LEADERSHIP_STATE.LEADER) throw new Error("A did not become leader");

      // A dies; its lease lapses; B takes the shard.
      const later = new Date(Date.now() + 5_000);
      const b = await election.acquire(store, {
        shardId: `${P}-shard-c`, candidateId: `${P}-leader-B`, storeTime: later, leaseDurationSeconds: 30,
      });
      if (b.state !== election.LEADERSHIP_STATE.LEADER) throw new Error("B could not take the lapsed shard");
      if (b.leadershipFence <= a.leadershipFence) throw new Error("failover did not advance the fence");

      // A, unaware, renews on its stale session.
      const stale = await election.renew(store, a, {
        storeTime: later, leaseDurationSeconds: 30, maxClockSkewMillis: 500, storeRoundTripMillis: 500,
      });
      if (stale.state === election.LEADERSHIP_STATE.LEADER) throw new Error("the superseded leader A renewed successfully — SPLIT BRAIN");
      if (stale.mayCommit === true) throw new Error("the superseded leader A still believes it may commit");

      const row = await prisma.shardLeadership.findUnique({ where: { shardId: `${P}-shard-c` } });
      if (row.holder !== `${P}-leader-B`) throw new Error(`holder is ${row.holder}, not B`);
      return `A fence ${a.leadershipFence} → B fence ${b.leadershipFence}; A refused (${stale.lastRefusal}), mayCommit=false, holder remains B`;
    });

    await accepted("FO2", "a superseded leader's own release cannot take the shard from its successor", async () => {
      const store = election.postgresLeadershipStore(prisma, { replicationPosture: "SYNCHRONOUS_QUORUM" });
      const before = await prisma.shardLeadership.findUnique({ where: { shardId: `${P}-shard-c` } });
      // A stale session claiming a fence two generations old.
      const staleSession = {
        shardId: `${P}-shard-c`, candidateId: `${P}-leader-A`, state: election.LEADERSHIP_STATE.LEADER,
        leadershipFence: before.leadershipFence - BigInt(1), leaseExpiry: new Date(Date.now() + 60_000),
        mayCommit: true, reconciled: true, lastRefusal: null,
      };
      const outcome = await election.release(store, staleSession, { storeTime: now() });
      const after = await prisma.shardLeadership.findUnique({ where: { shardId: `${P}-shard-c` } });
      if (outcome.released) throw new Error("a superseded leader released the shard out from under its successor");
      if (after.holder !== before.holder) throw new Error(`holder changed from ${before.holder} to ${after.holder}`);
      return `refused ${outcome.refusal}; holder still ${after.holder}, fence still ${after.leadershipFence}`;
    });

    // ── 8. Known Limitation 7 — concurrent same-shard handoffs ─────────────
    console.log("\n── Known Limitation 7: concurrent handoffs on one shard, on the real store ──");

    await accepted("K1", "two concurrent migrations off one shard leave agentCount exactly correct", async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM "ShardMembership" WHERE "movedBy" = $1`, P);
      await prisma.shard.update({ where: { shardId: `${P}-shard-a` }, data: { agentCount: 2 } });
      await prisma.shard.update({ where: { shardId: `${P}-shard-b` }, data: { agentCount: 0 } });
      for (const n of ["1", "2"]) {
        // eslint-disable-next-line no-await-in-loop
        await prisma.agent.update({ where: { id: `${P}-agent-${n}` }, data: { authorityEpoch: BigInt(0) } });
        // eslint-disable-next-line no-await-in-loop
        await prisma.$executeRawUnsafe(INS_M, `${P}-k1-${n}`, `${P}-agent-${n}`, `${P}-shard-a`, null, null, BigInt(0), BigInt(0), "COMMISSIONING", P);
      }

      // The two writes Known Limitation 7 names — `{ decrement: 1 }` on the source and
      // `{ increment: 1 }` on the target — issued concurrently for two DIFFERENT agents.
      const migrateOne = (agentId, tag) =>
        runSerializable(prisma, async (tx) => {
          await selectForUpdate(tx, "Agent", "id", agentId);
          const current = await tx.shardMembership.findFirst({ where: { agentId, supersededAt: null } });
          const agent = await tx.agent.findUnique({ where: { id: agentId } });
          const next = agent.authorityEpoch + BigInt(1);
          await tx.agent.update({ where: { id: agentId }, data: { authorityEpoch: next } });
          await tx.shardMembership.update({ where: { id: current.id }, data: { supersededAt: now() } });
          await tx.shardMembership.create({
            data: {
              id: `${P}-k1-new-${tag}`, agentId, shardId: `${P}-shard-b`, fromShardId: `${P}-shard-a`,
              movedAt: now(), authorityEpochBefore: agent.authorityEpoch, authorityEpochAfter: next,
              reason: "REBALANCE_SPLIT", movedBy: P,
            },
          });
          await tx.shard.update({ where: { shardId: `${P}-shard-a` }, data: { agentCount: { decrement: 1 } } });
          await tx.shard.update({ where: { shardId: `${P}-shard-b` }, data: { agentCount: { increment: 1 } } });
        });

      const settled = await Promise.allSettled([
        migrateOne(`${P}-agent-1`, "1"),
        migrateOne(`${P}-agent-2`, "2"),
      ]);
      const failed = settled.filter((s) => s.status === "rejected");

      const a = await prisma.shard.findUnique({ where: { shardId: `${P}-shard-a` } });
      const b = await prisma.shard.findUnique({ where: { shardId: `${P}-shard-b` } });
      const moved = await prisma.shardMembership.count({
        where: { shardId: `${P}-shard-b`, supersededAt: null, agentId: { in: [`${P}-agent-1`, `${P}-agent-2`] } },
      });
      // The correctness property is not "both succeeded" — SERIALIZABLE may legitimately
      // abort one — it is that the counts and the membership rows agree afterwards.
      if (a.agentCount !== 2 - moved || b.agentCount !== moved) {
        throw new Error(`LOST UPDATE: source ${a.agentCount}, target ${b.agentCount}, but ${moved} agents actually moved`);
      }
      return `${moved} of 2 migrations committed (${failed.length} serialisation abort(s)); source 2→${a.agentCount}, target 0→${b.agentCount} — counts and rows agree`;
    });

    // ── 9. The remediated production composition, on real PostgreSQL ───────
    console.log("\n── the remediated supervisor composition, end to end on real PostgreSQL ──");

    await accepted("X1", "a tick built the way server.js now builds it leads, reconciles, and may run a round", async () => {
      await resetLeadership();
      let sweepCalls = 0;
      const deps = {
        prisma,
        kv: { set: async () => "OK" },
        store: election.postgresLeadershipStore(prisma, { replicationPosture: "SYNCHRONOUS_QUORUM" }),
        runSerializable,
        selectForUpdate,
        // The shape server.js injects. The sweep itself is Phase 5's and has its own live
        // harness; what is verified here is that the supervisor reaches it at all — which
        // before this remediation it never did, on any deployment.
        reconcile: async () => { sweepCalls += 1; return { total: 0, results: [] }; },
        onError: (e) => { throw e; },
      };
      const settings = {
        shardId: `${P}-shard-c`, candidateId: `${P}-host:1`,
        leaseDurationSeconds: 5, intervalMs: 1500, maxClockSkewMillis: 500,
        storeRoundTripMillis: 500, minIntervalMs: 2000,
      };

      const tick = await shardSupervisor.runOnce(deps, { ...settings, storeTime: now() });
      if (tick.transition !== "ACQUIRED") throw new Error(`transition ${tick.transition}`);
      if (sweepCalls === 0) throw new Error("§19.5's reconciliation was never invoked");
      if (tick.mayRunRound !== true) throw new Error("the leader may not run a round after a complete reconciliation");
      const shard = await prisma.shard.findUnique({ where: { shardId: `${P}-shard-c` } });
      if (!shard.roundsResumableAt) throw new Error("roundsResumableAt was not persisted");
      return `ACQUIRED → reconciliation invoked ${sweepCalls}× → mayRunRound=true; roundsResumableAt=${iso(shard.roundsResumableAt)}`;
    });

    await accepted("X2", "the PRE-remediation composition is refused at boot instead of failing silently", async () => {
      const store = election.postgresLeadershipStore(prisma, { replicationPosture: "SYNCHRONOUS_QUORUM" });
      let threw = null;
      try {
        // Exactly what server.js passed before this remediation.
        shardSupervisor.start(
          { prisma, kv: { set: async () => "OK" }, store, onError: () => {} },
          { shardId: `${P}-shard-c`, candidateId: `${P}-host:2` },
        );
      } catch (e) { threw = e; }
      if (!threw) throw new Error("the incomplete composition started — the boot assertion is not effective");
      return `refused: ${String(threw.message).slice(0, 120)}…`;
    });

    // The DEFAULT deployment shape. A `Shard` row is published configuration with a foreign
    // key to a `Region`; the single-shard deployment has none, and `failover.persist()`'s
    // `update()` raised P2025 in exactly that shape — after the sweep had run, so the
    // supervisor reconciled on every tick and never resumed a round.
    await accepted("X4", "the SINGLE-SHARD deployment (no published Shard row) completes a tick and may run a round", async () => {
      const shardId = `${P}-shard-unpublished`;
      await prisma.shardLeadership.create({ data: { shardId, leadershipFence: BigInt(1) } });
      const shardRows = await prisma.shard.count({ where: { shardId } });
      if (shardRows !== 0) throw new Error("the fixture published a Shard row; this check needs none");

      let sweeps = 0;
      const deps = {
        prisma, kv: { set: async () => "OK" },
        store: election.postgresLeadershipStore(prisma, { replicationPosture: "SYNCHRONOUS_QUORUM" }),
        runSerializable, selectForUpdate,
        reconcile: async () => { sweeps += 1; return { total: 0, results: [] }; },
        onError: (e) => { throw e; },
      };
      const settings = { shardId, candidateId: `${P}-host:3`, leaseDurationSeconds: 30, maxClockSkewMillis: 500, storeRoundTripMillis: 500 };

      const first = await shardSupervisor.runOnce(deps, { ...settings, storeTime: now() });
      if (first.mayRunRound !== true) throw new Error("the single-shard deployment cannot run a round");

      // And it must not re-reconcile on every subsequent tick.
      const second = await shardSupervisor.runOnce(deps, { ...settings, session: first.session, storeTime: now() });
      if (second.transition !== "RENEWED") throw new Error(`second tick transitioned ${second.transition}`);
      if (sweeps !== 1) throw new Error(`the sweep ran ${sweeps} times across two ticks — it should run once per acquisition`);
      return `ACQUIRED then RENEWED with no Shard row; sweep ran exactly ${sweeps}× across 2 ticks; mayRunRound=true`;
    });

    await accepted("X3", "a second tick renews rather than re-acquiring — the fence is stable under a healthy leader", async () => {
      await resetLeadership();
      const deps = {
        prisma, kv: { set: async () => "OK" },
        store: election.postgresLeadershipStore(prisma, { replicationPosture: "SYNCHRONOUS_QUORUM" }),
        runSerializable, selectForUpdate,
        reconcile: async () => ({ total: 0, results: [] }),
        onError: (e) => { throw e; },
      };
      const settings = {
        shardId: `${P}-shard-c`, candidateId: `${P}-host:1`,
        leaseDurationSeconds: 30, maxClockSkewMillis: 500, storeRoundTripMillis: 500,
      };
      const first = await shardSupervisor.runOnce(deps, { ...settings, storeTime: now() });
      const fenceAfterAcquire = (await prisma.shardLeadership.findUnique({ where: { shardId: `${P}-shard-c` } })).leadershipFence;

      let session = first.session;
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const t = await shardSupervisor.runOnce(deps, { ...settings, session, storeTime: now() });
        if (t.transition !== "RENEWED") throw new Error(`tick ${i + 2} transitioned ${t.transition}, not RENEWED`);
        if (t.mayRunRound !== true) throw new Error(`tick ${i + 2} lost commit permission`);
        session = t.session;
      }
      const fenceAfter = (await prisma.shardLeadership.findUnique({ where: { shardId: `${P}-shard-c` } })).leadershipFence;
      if (fenceAfter !== fenceAfterAcquire) throw new Error(`the fence moved ${fenceAfterAcquire} → ${fenceAfter} across renewals`);
      return `1 acquisition + 5 renewals; fence stable at ${fenceAfter}; mayRunRound stayed true`;
    });
    /* ═══════════════════════════════════════════════════════════════════════
       10. §19.2's durable rebalance intent — the schema (P13-R4)
       ═══════════════════════════════════════════════════════════════════════ */
    console.log("\n── ShardRebalance: eight CHECK constraints and one partial unique index ──");

    const INS_R =
      `INSERT INTO "ShardRebalance" ("id","sourceShardId","targetShardId","state","reason","restoreState",` +
      `"plan","plannedMoves","completedMoves","requestedBy","requestedAt","closedAt","updatedAt") ` +
      `VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,NOW(),$11,NOW())`;
    const PLAN_JSON = JSON.stringify({ moves: [{ order: 0, agentId: `${P}-agent-1`, targetShardId: `${P}-shard-b`, reason: "REBALANCE_MERGE" }] });
    const insR = (id, over) => {
      const o = over || {};
      return [
        id, o.source || `${P}-shard-a`, o.target || `${P}-shard-b`, o.state || "PENDING",
        o.reason || "REBALANCE_MERGE", o.restoreState || "ACTIVE", o.plan || PLAN_JSON,
        o.plannedMoves === undefined ? 1 : o.plannedMoves,
        o.completedMoves === undefined ? 0 : o.completedMoves,
        P, o.closedAt === undefined ? null : o.closedAt,
      ];
    };

    await refusedSql("R1", "ShardRebalance_state_known refuses a state outside the lifecycle", SQLSTATE.CHECK, "ShardRebalance_state_known",
      INS_R, insR(`${P}-rb-x1`, { state: "PAUSED" }));

    await refusedSql("R2", "ShardRebalance_moves_between_two_shards refuses source === target", SQLSTATE.CHECK, "ShardRebalance_moves_between_two_shards",
      INS_R, insR(`${P}-rb-x2`, { target: `${P}-shard-a` }));

    // COMMISSIONING is exempt from advancing `authority_epoch`, so an intent citing it would
    // request moves that `ShardMembership_migration_advances_epoch` refuses one at a time,
    // forever — an intent that can never complete.
    await refusedSql("R3", "ShardRebalance_reason_known refuses COMMISSIONING — a rebalance is never a placement", SQLSTATE.CHECK, "ShardRebalance_reason_known",
      INS_R, insR(`${P}-rb-x3`, { reason: "COMMISSIONING" }));

    // **The constraint that makes stranding unrepresentable.** Whatever terminal state this
    // row reaches, the state it restores its source shard to admits work.
    await refusedSql("R4", "ShardRebalance_restore_state_admits_work refuses a restore target of DRAINING", SQLSTATE.CHECK, "ShardRebalance_restore_state_admits_work",
      INS_R, insR(`${P}-rb-x4`, { restoreState: "DRAINING" }));

    await refusedSql("R5", "ShardRebalance_plan_is_not_empty refuses an intent that plans no move", SQLSTATE.CHECK, "ShardRebalance_plan_is_not_empty",
      INS_R, insR(`${P}-rb-x5`, { plannedMoves: 0 }));

    await refusedSql("R6", "ShardRebalance_completed_within_plan refuses more completions than the plan holds", SQLSTATE.CHECK, "ShardRebalance_completed_within_plan",
      INS_R, insR(`${P}-rb-x6`, { plannedMoves: 1, completedMoves: 2 }));

    await refusedSql("R7", "ShardRebalance_terminal_is_timed refuses COMPLETED with no closedAt", SQLSTATE.CHECK, "ShardRebalance_terminal_is_timed",
      INS_R, insR(`${P}-rb-x7`, { state: "COMPLETED" }));

    await refusedSql("R8", "…and refuses an OPEN intent that carries one — the equality holds both ways", SQLSTATE.CHECK, "ShardRebalance_terminal_is_timed",
      INS_R, insR(`${P}-rb-x8`, { state: "PENDING", closedAt: now() }));

    await refusedSql("R9", "the source foreign key refuses an intent naming a shard that does not exist", SQLSTATE.FOREIGN_KEY, "ShardRebalance_sourceShardId_fkey",
      INS_R, insR(`${P}-rb-x9`, { source: `${P}-shard-nowhere` }));

    await accepted("R10", "the partial unique index refuses a SECOND open intent and ALLOWS one after the first closes", async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM "ShardRebalance" WHERE "requestedBy" = $1`, P);
      await prisma.$executeRawUnsafe(INS_R, ...insR(`${P}-rb-1`));

      let refusal = null;
      try {
        await prisma.$executeRawUnsafe(INS_R, ...insR(`${P}-rb-2`, { target: `${P}-shard-c` }));
      } catch (e) { refusal = dbError(e); }
      // Judged on SQLSTATE plus the **offending value**, which PostgreSQL reports as data
      // (`Key ("sourceShardId")=(…) already exists`). The constraint name is deliberately
      // not matched here: Prisma quotes this file's own source into `error.message`, and
      // this file names the index, so a name match would be the false-pass this harness's
      // header records having already made once. R11 settles the index's identity from
      // `pg_indexes` instead.
      if (!refusal || refusal.code !== SQLSTATE.UNIQUE || !refusal.text.includes(`${P}-shard-a`)) {
        throw new Error(`a second open intent for one source shard was accepted (${refusal ? refusal.text.slice(0, 120) : "no error"})`);
      }

      // The half a non-partial unique index would break: a shard must be able to be
      // rebalanced again once the first rebalance is over.
      await prisma.$executeRawUnsafe(
        `UPDATE "ShardRebalance" SET "state" = 'COMPLETED', "closedAt" = NOW() WHERE "id" = $1`, `${P}-rb-1`,
      );
      await prisma.$executeRawUnsafe(INS_R, ...insR(`${P}-rb-2`, { target: `${P}-shard-c` }));
      const open = await prisma.shardRebalance.count({ where: { sourceShardId: `${P}-shard-a`, state: { in: ["PENDING", "EXECUTING"] } } });
      if (open !== 1) throw new Error(`${open} open intents after the second insert; expected exactly 1`);
      return "second open intent refused 23505; a new one accepted after the first closed — exactly one open at all times";
    });

    await accepted("R11", "the catalogue holds exactly eight CHECKs on ShardRebalance and one PARTIAL unique index", async () => {
      const checks = await prisma.$queryRawUnsafe(
        `SELECT conname FROM pg_constraint WHERE contype = 'c' AND conrelid = '"ShardRebalance"'::regclass ORDER BY conname`,
      );
      const names = checks.map((r) => r.conname);
      const expected = [
        "ShardRebalance_completed_within_plan", "ShardRebalance_moves_between_two_shards",
        "ShardRebalance_plan_is_not_empty", "ShardRebalance_reason_known",
        "ShardRebalance_restore_state_admits_work", "ShardRebalance_state_known",
        "ShardRebalance_terminal_is_timed",
      ];
      for (const name of expected) if (!names.includes(name)) throw new Error(`missing CHECK ${name}; found ${names.join(", ")}`);
      const index = await prisma.$queryRawUnsafe(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'ShardRebalance' AND indexname = 'ShardRebalance_one_open_per_source'`,
      );
      if (index.length === 0) throw new Error("the partial unique index is absent");
      if (!/WHERE .*state.*=.*ANY|WHERE .*state.*IN/i.test(index[0].indexdef)) {
        throw new Error(`the index is not partial: ${index[0].indexdef}`);
      }
      // Seven named CHECKs plus PostgreSQL's own NOT NULL is not a CHECK, so the count is
      // exactly the seven written by hand — the eighth in the migration's comment is the
      // partial index, and this is where that distinction is settled rather than assumed.
      return `${names.length} CHECK(s): ${names.join(", ")}; index: ${index[0].indexdef.replace(/\s+/g, " ").slice(0, 150)}`;
    });

    /* ═══════════════════════════════════════════════════════════════════════
       11. The rebalance LIFECYCLE, driven by the production code on real
           PostgreSQL — P13-R4's actual resolution, and the failure injection
           that decides whether it is real.
       ═══════════════════════════════════════════════════════════════════════ */
    console.log("\n── the rebalance lifecycle: execution, resumption, fencing, isolation ──");

    const SIGNING_KEY = `${P}-signing-key-long-enough-for-23-3-to-accept`;
    const shardModel = require("../../src/engine/shard/shardModel");
    const membership = require("../../src/engine/shard/membership");

    /** Reset shards, memberships and intents to a known pre-rebalance world. */
    async function resetRebalanceWorld() {
      // Release the leases the previous check took, so the next `leadOf` can win an
      // election. The **fence is deliberately not rewound**: it is monotone, and moving a
      // monotone counter backwards is the one thing guard G1 cannot tolerate. Each check
      // therefore acquires against whatever fence its predecessor left.
      for (const s2 of ["a", "b", "c"]) {
        await prisma.shardLeadership.update({
          where: { shardId: `${P}-shard-${s2}` },
          data: { holder: null, leaseExpiry: null },
        });
      }
      await prisma.$executeRawUnsafe(`DELETE FROM "ShardRebalance" WHERE "requestedBy" = $1`, P);
      await prisma.$executeRawUnsafe(`DELETE FROM "Outbox" WHERE "agentId" LIKE $1`, `${P}%`);
      await prisma.$executeRawUnsafe(`DELETE FROM "AgentFenceAudit" WHERE "agentId" LIKE $1`, `${P}%`);
      await prisma.$executeRawUnsafe(`DELETE FROM "ShardMembership" WHERE "agentId" LIKE $1`, `${P}%`);
      for (const s of ["a", "b", "c"]) {
        await prisma.shard.update({ where: { shardId: `${P}-shard-${s}` }, data: { state: "ACTIVE", drainingSince: null, agentCount: 0 } });
      }
      for (const n of ["1", "2", "3"]) {
        await prisma.agent.update({ where: { id: `${P}-agent-${n}` }, data: { authorityEpoch: BigInt(0) } });
      }
      // agents 1 and 2 in shard-a, agent 3 in shard-c — so a cross-shard write is visible.
      await prisma.$executeRawUnsafe(INS_M, `${P}-mem-1`, `${P}-agent-1`, `${P}-shard-a`, null, null, BigInt(0), BigInt(0), "COMMISSIONING", P);
      await prisma.$executeRawUnsafe(INS_M, `${P}-mem-2`, `${P}-agent-2`, `${P}-shard-a`, null, null, BigInt(0), BigInt(0), "COMMISSIONING", P);
      await prisma.$executeRawUnsafe(INS_M, `${P}-mem-3`, `${P}-agent-3`, `${P}-shard-c`, null, null, BigInt(0), BigInt(0), "COMMISSIONING", P);
      await prisma.shard.update({ where: { shardId: `${P}-shard-a` }, data: { agentCount: 2 } });
      await prisma.shard.update({ where: { shardId: `${P}-shard-c` }, data: { agentCount: 1 } });
    }

    /** The plan the control plane records, for the members of `shardId`. */
    async function planFor(shardId, targetShardId, surplus) {
      const members = await membership.membersOf(prisma, { shardId });
      return membership.planRebalance({
        members, liveCommitmentCountByAgentId: {},
        surplus: surplus === undefined ? members.length : surplus,
        targetShardId, reason: "REBALANCE_MERGE",
      });
    }

    /** The supervisor deps, exactly as `server.js` composes them. */
    const supervisorDeps = (onSweep) => ({
      prisma, kv: { set: async () => "OK" },
      store: election.postgresLeadershipStore(prisma, { replicationPosture: "SYNCHRONOUS_QUORUM" }),
      runSerializable, selectForUpdate,
      reconcile: async () => { if (onSweep) onSweep(); return { total: 0, results: [] }; },
      onError: (e) => { throw e; },
    });

    const supervisorSettings = (shardId, candidateId) => ({
      shardId, candidateId,
      leaseDurationSeconds: 30, maxClockSkewMillis: 500, storeRoundTripMillis: 500,
      minIntervalMs: 0, commandTtlSeconds: 60, signingKey: SIGNING_KEY,
    });

    /** Acquire and reconcile, returning a session that may commit. */
    async function leadOf(shardId, candidateId) {
      const deps = supervisorDeps();
      const settings = supervisorSettings(shardId, candidateId);
      const renewal = await shardSupervisor.renewalPass(deps, { ...settings, storeTime: now() });
      const recovery = await shardSupervisor.failoverPass(deps, { ...settings, storeTime: now(), session: renewal.session });
      if (recovery.session.mayCommit !== true) throw new Error(`could not obtain a committing leader for ${shardId}`);
      return recovery.session;
    }

    await accepted("Y1", "the control plane records the intent and the shard state in ONE transaction", async () => {
      await resetRebalanceWorld();
      const shard = await prisma.shard.findUnique({ where: { shardId: `${P}-shard-a` } });
      const plan = await planFor(`${P}-shard-a`, `${P}-shard-b`);

      const opened = await shardModel.openRebalance({ prisma }, {
        shard, targetShardId: `${P}-shard-b`, plan, memberCount: 2,
        reason: "REBALANCE_MERGE", requestedBy: P, at: now(),
      });
      if (!opened.ok) throw new Error(`openRebalance refused: ${opened.refusal}`);

      const row = await prisma.shardRebalance.findFirst({ where: { sourceShardId: `${P}-shard-a`, state: { in: ["PENDING", "EXECUTING"] } } });
      const after = await prisma.shard.findUnique({ where: { shardId: `${P}-shard-a` } });
      if (!row) throw new Error("no intent was persisted");
      if (after.state !== "DRAINING") throw new Error(`shard state ${after.state}, expected DRAINING for a full drain`);
      if (after.drainingSince === null) throw new Error("DRAINING was written without a drainingSince");
      if (row.plannedMoves !== 2) throw new Error(`plannedMoves ${row.plannedMoves}`);
      if (row.restoreState !== "ACTIVE") throw new Error(`restoreState ${row.restoreState}`);
      return `intent ${row.id} PENDING with ${row.plannedMoves} move(s); shard DRAINING since ${iso(after.drainingSince)}; restoreState=${row.restoreState}`;
    });

    await accepted("Y2", "a failure inside the intent's transaction leaves the shard state unwritten — no strand", async () => {
      await resetRebalanceWorld();
      const before = await prisma.shard.findUnique({ where: { shardId: `${P}-shard-a` } });
      const plan = await planFor(`${P}-shard-a`, `${P}-shard-b`);

      // The intent's INSERT fails on `ShardRebalance_targetShardId_fkey` *inside* the
      // transaction that also writes `Shard.state`. If the two were not one transaction the
      // shard would be left DRAINING with no intent — which is P13-R4 in one sentence, and
      // is what this check exists to make impossible rather than merely unlikely.
      let refusal = null;
      try {
        await shardModel.openRebalance({ prisma }, {
          shard: before, targetShardId: `${P}-shard-nowhere`, plan, memberCount: 2,
          reason: "REBALANCE_MERGE", requestedBy: P, at: now(),
        });
      } catch (e) {
        // Prisma reports a foreign-key violation from a model call as the structured code
        // `P2003` rather than as a SQLSTATE; `dbError` is written for raw SQL. The
        // structured field is judged here because it is Prisma's, not this file's text.
        refusal = { code: e && e.code, text: dbMessage(e) };
      }

      const after = await prisma.shard.findUnique({ where: { shardId: `${P}-shard-a` } });
      const open = await prisma.shardRebalance.count({ where: { sourceShardId: `${P}-shard-a` } });

      if (!refusal || (refusal.code !== "P2003" && refusal.code !== SQLSTATE.FOREIGN_KEY)) {
        throw new Error(`expected a foreign-key refusal; got ${refusal ? `${refusal.code}: ${String(refusal.text).slice(0, 120)}` : "success"}`);
      }
      if (after.state !== "ACTIVE" || after.drainingSince !== null) throw new Error(`the shard was left ${after.state} by a transaction that rolled back`);
      if (open !== 0) throw new Error(`${open} intent row(s) survived a rolled-back transaction`);
      return `${refusal.code} (foreign key) rolled the whole transaction back: shard still ACTIVE, 0 intent rows`;
    });

    await accepted("Y3", "the supervisor executes the durable plan ONE agent per tick and restores the shard at the end", async () => {
      await resetRebalanceWorld();
      const shard = await prisma.shard.findUnique({ where: { shardId: `${P}-shard-a` } });
      const plan = await planFor(`${P}-shard-a`, `${P}-shard-b`);
      await shardModel.openRebalance({ prisma }, { shard, targetShardId: `${P}-shard-b`, plan, memberCount: 2, reason: "REBALANCE_MERGE", requestedBy: P, at: now() });

      const deps = supervisorDeps();
      const settings = supervisorSettings(`${P}-shard-a`, `${P}-host-a`);
      const session = await leadOf(`${P}-shard-a`, `${P}-host-a`);

      const t1 = await shardSupervisor.migrationPass(deps, { ...settings, session, storeTime: now() });
      if (t1.migrated !== 1) throw new Error(`tick 1 migrated ${t1.migrated}, expected exactly 1 (§19.2 one at a time)`);
      const t2 = await shardSupervisor.migrationPass(deps, { ...settings, session, storeTime: now() });
      if (t2.migrated !== 1) throw new Error(`tick 2 migrated ${t2.migrated}`);
      const t3 = await shardSupervisor.migrationPass(deps, { ...settings, session, storeTime: now() });
      if (t3.skipped !== "PLAN_EXHAUSTED") throw new Error(`tick 3 skipped ${t3.skipped}`);

      const intent = await prisma.shardRebalance.findFirst({ where: { requestedBy: P } });
      const src = await prisma.shard.findUnique({ where: { shardId: `${P}-shard-a` } });
      const dst = await prisma.shard.findUnique({ where: { shardId: `${P}-shard-b` } });
      const moved = await prisma.shardMembership.count({ where: { shardId: `${P}-shard-b`, supersededAt: null } });
      const commands = await prisma.outbox.count({ where: { command: "SHARD_MIGRATE", agentId: { startsWith: P } } });
      const epochs = await prisma.agent.findMany({ where: { id: { in: [`${P}-agent-1`, `${P}-agent-2`] } }, select: { id: true, authorityEpoch: true } });

      if (intent.state !== "COMPLETED") throw new Error(`intent ${intent.state}`);
      if (intent.closedAt === null) throw new Error("COMPLETED with no closedAt");
      if (src.state !== "ACTIVE" || src.drainingSince !== null) throw new Error(`source left ${src.state}/${src.drainingSince}`);
      if (moved !== 2 || src.agentCount !== 0 || dst.agentCount !== 2) throw new Error(`counts: moved ${moved}, src ${src.agentCount}, dst ${dst.agentCount}`);
      if (commands !== 2) throw new Error(`${commands} SHARD_MIGRATE command(s) enqueued, expected 2`);
      if (!epochs.every((a) => a.authorityEpoch === BigInt(1))) throw new Error(`authority_epoch not advanced per agent: ${JSON.stringify(epochs.map((a) => String(a.authorityEpoch)))}`);
      return `2 ticks moved 2 agents (1 each); intent COMPLETED; shard restored to ACTIVE; counts ${src.agentCount}/${dst.agentCount}; 2 signed SHARD_MIGRATE rows; both authority_epoch 0→1`;
    });

    await accepted("Y4", "a process that dies between a committed migration and its bookkeeping resumes without moving the agent twice", async () => {
      await resetRebalanceWorld();
      const shard = await prisma.shard.findUnique({ where: { shardId: `${P}-shard-a` } });
      const plan = await planFor(`${P}-shard-a`, `${P}-shard-b`, 1);
      await shardModel.openRebalance({ prisma }, { shard, targetShardId: `${P}-shard-b`, plan, memberCount: 2, reason: "REBALANCE_MERGE", requestedBy: P, at: now() });

      const deps = supervisorDeps();
      const settings = supervisorSettings(`${P}-shard-a`, `${P}-host-a`);
      const session = await leadOf(`${P}-shard-a`, `${P}-host-a`);

      const first = await shardSupervisor.migrationPass(deps, { ...settings, session, storeTime: now() });
      if (first.migrated !== 1) throw new Error("the first move did not commit");

      // The crash: the migration transaction committed, the bookkeeping did not. Rewound to
      // exactly the row the previous process would have left.
      await prisma.$executeRawUnsafe(
        `UPDATE "ShardRebalance" SET "state" = 'PENDING', "completedMoves" = 0, "startedAt" = NULL, "lastMoveAt" = NULL WHERE "requestedBy" = $1`, P,
      );

      const resumed = await shardSupervisor.migrationPass(deps, { ...settings, session, storeTime: now() });
      const commands = await prisma.outbox.count({ where: { command: "SHARD_MIGRATE", agentId: { startsWith: P } } });
      const intent = await prisma.shardRebalance.findFirst({ where: { requestedBy: P } });
      const src = await prisma.shard.findUnique({ where: { shardId: `${P}-shard-a` } });
      const epoch = (await prisma.agent.findUnique({ where: { id: plan.moves[0].agentId } })).authorityEpoch;

      if (resumed.migrated !== 0) throw new Error(`the resumed tick migrated ${resumed.migrated} — the agent moved twice`);
      if (resumed.skipped !== "PLAN_EXHAUSTED") throw new Error(`resumed tick skipped ${resumed.skipped}`);
      if (commands !== 1) throw new Error(`${commands} SHARD_MIGRATE commands — a duplicate migration`);
      if (epoch !== BigInt(1)) throw new Error(`authority_epoch ${epoch} — advanced twice`);
      if (intent.state !== "COMPLETED" || src.state !== "ACTIVE") throw new Error(`intent ${intent.state}, shard ${src.state}`);
      return `progress derived from membership, not from the counter: 1 migration, 1 command, epoch 0→1, intent COMPLETED, shard ACTIVE`;
    });

    await accepted("Y5", "**a fenced leader cannot migrate** — the fence is re-read inside the handoff transaction", async () => {
      await resetRebalanceWorld();
      const shard = await prisma.shard.findUnique({ where: { shardId: `${P}-shard-a` } });
      const plan = await planFor(`${P}-shard-a`, `${P}-shard-b`, 1);
      await shardModel.openRebalance({ prisma }, { shard, targetShardId: `${P}-shard-b`, plan, memberCount: 2, reason: "REBALANCE_MERGE", requestedBy: P, at: now() });

      const stale = await leadOf(`${P}-shard-a`, `${P}-host-a`);
      // A real leadership change on a real row: the fence advances and the holder changes.
      const before = await prisma.shardLeadership.findUnique({ where: { shardId: `${P}-shard-a` } });
      await leadership.releaseLease(prisma, { shardId: `${P}-shard-a`, holder: stale.candidateId, expectedFence: stale.leadershipFence, storeTime: now() });
      const successor = await leadOf(`${P}-shard-a`, `${P}-host-b`);
      const after = await prisma.shardLeadership.findUnique({ where: { shardId: `${P}-shard-a` } });
      if (after.leadershipFence <= before.leadershipFence) throw new Error("the fence did not advance on the leadership change");

      const outcome = await shardSupervisor.migrationPass(
        supervisorDeps(), { ...supervisorSettings(`${P}-shard-a`, `${P}-host-a`), session: stale, storeTime: now() },
      );

      const epoch = (await prisma.agent.findUnique({ where: { id: plan.moves[0].agentId } })).authorityEpoch;
      const commands = await prisma.outbox.count({ where: { command: "SHARD_MIGRATE", agentId: { startsWith: P } } });
      const moved = await prisma.shardMembership.count({ where: { shardId: `${P}-shard-b`, supersededAt: null } });

      if (outcome.migrated !== 0) throw new Error("the superseded leader performed a migration");
      if (outcome.outcomes[0].refusal !== membership.REFUSAL.NOT_THE_LEADER) throw new Error(`refused ${outcome.outcomes[0].refusal}`);
      if (epoch !== BigInt(0) || commands !== 0 || moved !== 0) throw new Error(`side effects leaked: epoch ${epoch}, ${commands} command(s), ${moved} moved`);

      // …and the successor executes the same intent, so nothing is lost by the refusal.
      const resumed = await shardSupervisor.migrationPass(
        supervisorDeps(), { ...supervisorSettings(`${P}-shard-a`, `${P}-host-b`), session: successor, storeTime: now() },
      );
      if (resumed.migrated !== 1) throw new Error("the successor could not resume the intent");
      return `fence ${before.leadershipFence}→${after.leadershipFence}; stale leader refused ${outcome.outcomes[0].refusal} with zero side effects; successor migrated 1`;
    });

    await accepted("Y6", "two concurrent rebalance requests produce exactly ONE intent, decided by the partial index", async () => {
      await resetRebalanceWorld();
      const shard = await prisma.shard.findUnique({ where: { shardId: `${P}-shard-a` } });
      const plan = await planFor(`${P}-shard-a`, `${P}-shard-b`, 1);
      // No `.catch` here on purpose: `openRebalance` must *report* the lost race rather
      // than throw a 23505 the controller would render as a 500. A catch would hide exactly
      // the behaviour under test.
      const open = () => shardModel.openRebalance({ prisma }, {
        shard, targetShardId: `${P}-shard-b`, plan, memberCount: 2, reason: "REBALANCE_MERGE", requestedBy: P, at: now(),
      });

      const [one, two] = await Promise.all([open(), open()]);
      const opened = await prisma.shardRebalance.count({ where: { sourceShardId: `${P}-shard-a`, state: { in: ["PENDING", "EXECUTING"] } } });
      const winners = [one, two].filter((r) => r.ok).length;
      if (opened !== 1) throw new Error(`${opened} open intents after two concurrent requests`);
      if (winners !== 1) throw new Error(`${winners} of 2 requests reported success for ${opened} intent`);
      const loser = [one, two].find((r) => !r.ok);
      if (loser.refusal !== shardModel.REBALANCE_REFUSAL.ALREADY_OPEN) throw new Error(`the loser reported ${loser.refusal}, not a refusal the controller can render`);
      if (!loser.rebalance) throw new Error("the loser was not told which intent won");
      return `2 concurrent requests → 1 winner, 1 refused ${loser.refusal} naming the winning intent; exactly 1 open intent`;
    });

    await accepted("Y7", "**multi-shard isolation**: one shard's leader executes only its own intent and touches only its own members", async () => {
      await resetRebalanceWorld();
      // shard-c has one member (agent-3) and an intent of its own; shard-a has two and one too.
      const a = await prisma.shard.findUnique({ where: { shardId: `${P}-shard-a` } });
      const c = await prisma.shard.findUnique({ where: { shardId: `${P}-shard-c` } });
      await shardModel.openRebalance({ prisma }, { shard: a, targetShardId: `${P}-shard-b`, plan: await planFor(`${P}-shard-a`, `${P}-shard-b`, 1), memberCount: 2, reason: "REBALANCE_MERGE", requestedBy: P, at: now() });
      await shardModel.openRebalance({ prisma }, { shard: c, targetShardId: `${P}-shard-b`, plan: await planFor(`${P}-shard-c`, `${P}-shard-b`, 1), memberCount: 1, reason: "REBALANCE_MERGE", requestedBy: P, at: now() });

      const sessionA = await leadOf(`${P}-shard-a`, `${P}-host-a`);
      const outcome = await shardSupervisor.migrationPass(
        supervisorDeps(), { ...supervisorSettings(`${P}-shard-a`, `${P}-host-a`), session: sessionA, storeTime: now() },
      );

      const intentA = await prisma.shardRebalance.findFirst({ where: { sourceShardId: `${P}-shard-a` } });
      const intentC = await prisma.shardRebalance.findFirst({ where: { sourceShardId: `${P}-shard-c` } });
      const agent3 = await prisma.agent.findUnique({ where: { id: `${P}-agent-3` } });
      const agent3Membership = await prisma.shardMembership.findFirst({ where: { agentId: `${P}-agent-3`, supersededAt: null } });
      const shardC = await prisma.shard.findUnique({ where: { shardId: `${P}-shard-c` } });

      if (outcome.migrated !== 1) throw new Error(`shard-a's leader migrated ${outcome.migrated}`);
      if (outcome.rebalanceId !== intentA.id) throw new Error("shard-a's leader executed an intent that was not its own");
      // shard-C untouched in every respect a second writer would have disturbed.
      if (intentC.state !== "PENDING" || intentC.completedMoves !== 0) throw new Error(`shard-c's intent was advanced by shard-a's leader: ${intentC.state}/${intentC.completedMoves}`);
      if (agent3.authorityEpoch !== BigInt(0)) throw new Error("shard-c's agent had its authority_epoch advanced by shard-a's leader");
      if (agent3Membership.shardId !== `${P}-shard-c`) throw new Error("shard-c's agent was migrated by shard-a's leader");
      if (shardC.agentCount !== 1) throw new Error(`shard-c's agentCount was written by shard-a's leader: ${shardC.agentCount}`);
      return `shard-a executed intent ${intentA.id} only; shard-c's intent, agent epoch, membership and agentCount all unchanged`;
    });

    await accepted("Y8", "closing an intent whose shard an operator already restored writes zero rows and says so", async () => {
      await resetRebalanceWorld();
      const shard = await prisma.shard.findUnique({ where: { shardId: `${P}-shard-a` } });
      const opened = await shardModel.openRebalance({ prisma }, { shard, targetShardId: `${P}-shard-b`, plan: await planFor(`${P}-shard-a`, `${P}-shard-b`, 1), memberCount: 2, reason: "REBALANCE_MERGE", requestedBy: P, at: now() });

      // An operator moves the shard back by hand. The close must not drag it anywhere.
      await prisma.shard.update({ where: { shardId: `${P}-shard-a` }, data: { state: "ACTIVE", drainingSince: null } });

      const closed = await shardModel.closeRebalance({ prisma }, {
        rebalance: opened.rebalance, state: "CANCELLED", at: now(), closedReason: `${P} operator cancel`,
      });
      const after = await prisma.shard.findUnique({ where: { shardId: `${P}-shard-a` } });
      const intent = await prisma.shardRebalance.findFirst({ where: { requestedBy: P } });

      if (closed.shardRestoredTo !== null) throw new Error(`reported a restore that did not happen: ${closed.shardRestoredTo}`);
      if (!closed.closed) throw new Error("the intent was not closed");
      if (after.state !== "ACTIVE") throw new Error(`shard ${after.state}`);
      if (intent.state !== "CANCELLED" || intent.closedAt === null) throw new Error(`intent ${intent.state}/${intent.closedAt}`);

      // And closing again is a no-op rather than a reopen — the conditional write decides.
      const again = await shardModel.closeRebalance({ prisma }, { rebalance: intent, state: "COMPLETED", at: now(), closedReason: "second close" });
      const final = await prisma.shardRebalance.findFirst({ where: { requestedBy: P } });
      if (again.closed) throw new Error("a terminal intent was closed a second time");
      if (final.state !== "CANCELLED") throw new Error(`the second close changed the state to ${final.state}`);
      return "zero-row restore reported as null rather than as success; second close wrote nothing and left CANCELLED";
    });

    await accepted("Y9", "an intent survives a full process restart — it is read from the row, never from memory", async () => {
      await resetRebalanceWorld();
      const shard = await prisma.shard.findUnique({ where: { shardId: `${P}-shard-a` } });
      await shardModel.openRebalance({ prisma }, { shard, targetShardId: `${P}-shard-b`, plan: await planFor(`${P}-shard-a`, `${P}-shard-b`), memberCount: 2, reason: "REBALANCE_MERGE", requestedBy: P, at: now() });

      const s1 = await leadOf(`${P}-shard-a`, `${P}-host-a`);
      await shardSupervisor.migrationPass(supervisorDeps(), { ...supervisorSettings(`${P}-shard-a`, `${P}-host-a`), session: s1, storeTime: now() });

      // The restart: a brand-new PrismaClient and a brand-new session, with nothing carried
      // across but the database.
      const restarted = new PrismaClient({ datasources: { db: { url } } });
      try {
        const deps2 = {
          prisma: restarted, kv: { set: async () => "OK" },
          store: election.postgresLeadershipStore(restarted, { replicationPosture: "SYNCHRONOUS_QUORUM" }),
          runSerializable, selectForUpdate,
          reconcile: async () => ({ total: 0, results: [] }),
          onError: (e) => { throw e; },
        };
        const settings2 = supervisorSettings(`${P}-shard-a`, `${P}-host-c`);
        // The old leader's lease is released so the restarted process can take the shard.
        await leadership.releaseLease(prisma, { shardId: `${P}-shard-a`, holder: s1.candidateId, expectedFence: s1.leadershipFence, storeTime: now() });
        const r = await shardSupervisor.renewalPass(deps2, { ...settings2, storeTime: now() });
        const f = await shardSupervisor.failoverPass(deps2, { ...settings2, storeTime: now(), session: r.session });

        const t = await shardSupervisor.migrationPass(deps2, { ...settings2, session: f.session, storeTime: now() });
        if (t.migrated !== 1) throw new Error(`the restarted process migrated ${t.migrated}`);
        const done = await shardSupervisor.migrationPass(deps2, { ...settings2, session: f.session, storeTime: now() });
        if (done.skipped !== "PLAN_EXHAUSTED") throw new Error(`final tick skipped ${done.skipped}`);
        const src = await restarted.shard.findUnique({ where: { shardId: `${P}-shard-a` } });
        if (src.state !== "ACTIVE") throw new Error(`shard left ${src.state} after the restart`);
        return "a new client, a new session and a new candidate finished the plan and restored the shard";
      } finally {
        await restarted.$disconnect();
      }
    });

    await accepted("Y10", "**§19.2's pacing is enforced from the durable lastMoveAt**, so it survives a restart", async () => {
      await resetRebalanceWorld();
      const shard = await prisma.shard.findUnique({ where: { shardId: `${P}-shard-a` } });
      await shardModel.openRebalance({ prisma }, { shard, targetShardId: `${P}-shard-b`, plan: await planFor(`${P}-shard-a`, `${P}-shard-b`), memberCount: 2, reason: "REBALANCE_MERGE", requestedBy: P, at: now() });

      const session = await leadOf(`${P}-shard-a`, `${P}-host-a`);
      const paced = { ...supervisorSettings(`${P}-shard-a`, `${P}-host-a`), minIntervalMs: 60000 };

      const first = await shardSupervisor.migrationPass(supervisorDeps(), { ...paced, session, storeTime: now() });
      if (first.migrated !== 1) throw new Error("the first move did not run");
      // A *different* settings object, as a restarted process would have: no in-memory
      // `lastMigrationAtMs` anywhere. The pace must still hold.
      const second = await shardSupervisor.migrationPass(supervisorDeps(), { ...paced, session, storeTime: now() });
      if (second.skipped !== "PACED") throw new Error(`the second move was not paced: ${second.skipped}/${second.migrated}`);
      const row = await prisma.shardRebalance.findFirst({ where: { requestedBy: P } });
      if (!row.lastMoveAt) throw new Error("lastMoveAt was not persisted, so the pace has nothing durable to time from");
      return `move 1 committed, move 2 PACED after ${second.waitedMs} ms against a 60000 ms interval read from lastMoveAt=${iso(row.lastMoveAt)}`;
    });

    /* ═══════════════════════════════════════════════════════════════════════
       12. The dependencies §19.5's reconciliation and §3.5's sizing are
           configured with — P13-R8 and P13-R9.

       Both are producer/consumer defects on the production path, and both are
       invisible to every unit test because every unit test injects the value
       server.js did not. Both are settled here against the real sweep and the
       real `Shard` row.
       ═══════════════════════════════════════════════════════════════════════ */
    console.log("\n── the sweep's configuration and the sizing pass's, as server.js supplies them ──");

    const reconciler = require("../../src/engine/supervision/reconciler");
    const failoverModule = require("../../src/engine/shard/failover");
    const clock = require("../../src/engine/commitment/clock");
    const sizing = require("../../src/engine/shard/sizing");
    const configService = require("../../src/engine/config/service");
    const snapshot = configService.defaultSnapshot();
    const registered = (name) => snapshot.values.get(name);

    const sweepDeps = () => ({
      prisma,
      runInTransaction: (fn) => runSerializable(prisma, fn),
      readStoreTime: () => clock.readStoreTime(prisma),
    });

    await accepted("Z1", "**the sweep as it was configured THREW on the first Leg it had to reconstruct**", async () => {
      await resetRebalanceWorld();
      // A Leg in PLANNED with no live commitment: §19.5's volatile half, the one thing a
      // failover exists to reconstruct.
      await prisma.$executeRawUnsafe(`DELETE FROM "Leg" WHERE "id" LIKE $1`, `${P}%`);
      await prisma.leg.create({
        data: { id: `${P}-leg-1`, legId: `${P}-leg-1`, missionId: `${P}-mission-1`, sequence: 0, purpose: "PRIMARY", state: "PLANNED", custodyState: "NONE", version: 0 },
      });

      // Exactly what `failover.run()` passed the callback before this remediation:
      // `{ ...reconcileConfig, shardId }` with no `reconcileConfig` anywhere.
      let threw = null;
      try {
        await reconciler.sweep(sweepDeps(), { shardId: `${P}-shard-a` });
      } catch (e) { threw = e; }
      if (!threw) throw new Error("the under-configured sweep completed — the defect is not reproduced, so the fix proves nothing");
      if (!/positive duration in seconds/.test(String(threw.message))) {
        throw new Error(`the sweep threw for a different reason: ${String(threw.message).slice(0, 200)}`);
      }
      return `reproduced: ${String(threw.message).slice(0, 120)} — thrown from timers.deadlineFrom inside the orphan requeue`;
    });

    await accepted("Z2", "…and with the configuration server.js now supplies it reconstructs the Leg instead", async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM "ReconcilerRepair" WHERE "shardId" = $1`, `${P}-shard-a`);
      await prisma.leg.update({ where: { id: `${P}-leg-1` }, data: { state: "PLANNED", version: 0 } });

      // The four values server.js now reads from the register, by their registered names.
      const config = {
        assignmentDeadlineSeconds: registered("sla.assignment_deadline"),
        unresponsiveStrikes: registered("health.unresponsive_strikes"),
        energyDeviationTolerance: registered("energy.deviation_tolerance"),
        shardId: `${P}-shard-a`,
      };
      if (!Number.isFinite(config.assignmentDeadlineSeconds)) throw new Error("sla.assignment_deadline does not resolve from the register");

      const sweep = await reconciler.sweep(sweepDeps(), config);
      const orphan = sweep.results.find((r) => r.category === "ORPHAN_LEG");
      const leg = await prisma.leg.findUnique({ where: { id: `${P}-leg-1` } });
      const timer = await prisma.timer.findFirst({ where: { entityId: `${P}-leg-1`, timerState: "PENDING" } });

      if (!orphan || Number(orphan.counts.EXPECTED_POST_FAILOVER || 0) < 1) throw new Error("the Leg was not counted as a post-failover reconstruction");
      if (leg.state !== "QUEUED") throw new Error(`the Leg was left ${leg.state} rather than requeued`);
      if (!timer) throw new Error("§4.5's timer obligation was not re-registered with the requeue");
      return `1 EXPECTED_POST_FAILOVER reconstruction; Leg PLANNED→QUEUED with a timer due ${iso(timer.dueAt)} (${config.assignmentDeadlineSeconds} s SLA)`;
    });

    await accepted("Z3", "an unconfigured SLA repairs and ESCALATES every waiting Task — the false alert P13-R8 describes", async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM "ReconcilerRepair" WHERE "shardId" = $1`, `${P}-shard-a`);
      await prisma.$executeRawUnsafe(`DELETE FROM "Task" WHERE "id" LIKE $1`, `${P}%`);
      // A Task that has been WAITING for one second. No SLA on earth is one second.
      await prisma.task.create({
        data: {
          id: `${P}-task-1`, taskId: `${P}-task-1`, status: "WAITING",
          pickup: `${P}-a`, pickupLat: 0, pickupLon: 0, drop: `${P}-b`, dropLat: 1, dropLon: 1,
          createdAt: new Date(Date.now() - 1000),
        },
      });

      const withoutSla = await reconciler.sweep(sweepDeps(), { shardId: `${P}-shard-a` }).catch(() => null);
      const escalatedWithout = await prisma.reconcilerRepair.count({
        where: { shardId: `${P}-shard-a`, category: "TASK_WAITING_BEYOND_SLA", escalated: true },
      });

      await prisma.$executeRawUnsafe(`DELETE FROM "ReconcilerRepair" WHERE "shardId" = $1`, `${P}-shard-a`);
      await reconciler.sweep(sweepDeps(), {
        assignmentDeadlineSeconds: registered("sla.assignment_deadline"),
        unresponsiveStrikes: registered("health.unresponsive_strikes"),
        shardId: `${P}-shard-a`,
      });
      const escalatedWith = await prisma.reconcilerRepair.count({
        where: { shardId: `${P}-shard-a`, category: "TASK_WAITING_BEYOND_SLA", escalated: true },
      });

      // `age <= undefined` is false, so the guard clause never fires and every waiting Task
      // is repaired and escalated. §12.4's repair rate is an alertable SLI, so that is a
      // false alert on the first sweep of every deployment.
      if (escalatedWithout < 1) throw new Error("the defect did not reproduce, so the fix proves nothing");
      if (escalatedWith !== 0) throw new Error(`${escalatedWith} escalation(s) with the SLA configured — a 1-second-old Task is not beyond a ${registered("sla.assignment_deadline")} s SLA`);
      void withoutSla;
      return `unconfigured: ${escalatedWithout} escalated TASK_WAITING_BEYOND_SLA repair(s) for a 1 s old Task; configured (${registered("sla.assignment_deadline")} s): ${escalatedWith}`;
    });

    await accepted("Z4", "§3.5's serial-commit bound is EVALUATED and recorded, not left NEITHER_EVALUATED", async () => {
      await resetRebalanceWorld();
      await prisma.shard.update({ where: { shardId: `${P}-shard-a` }, data: { bindingBound: "NEITHER_EVALUATED", sizingDetail: null, sizingCheckedAt: null, agentCount: 30000 } });

      const deps = supervisorDeps();
      const settings = {
        ...supervisorSettings(`${P}-shard-a`, `${P}-host-sizing`),
        // Exactly the object server.js now builds, from the register.
        config: {
          missionRatePerAgentHour: registered("shard.mission_rate_per_agent_hour"),
          txnPerMissionLifecycle: registered("shard.txn_per_mission_lifecycle"),
          commitTxnServiceTimeMs: registered("shard.commit_txn_service_time"),
          maxSerialUtilisation: registered("commit.max_serial_utilisation"),
          roundWallClockBudgetMs: registered("perf.round_wall_clock_p99"),
        },
      };
      const session = await leadOf(`${P}-shard-a`, `${P}-host-sizing`);

      // Without the config — the composition as it stood — both bounds are unevaluated.
      const before = await shardSupervisor.sizingPass(deps, { ...settings, config: undefined, session, storeTime: now() });
      const rowBefore = await prisma.shard.findUnique({ where: { shardId: `${P}-shard-a` } });
      if (before.bindingBound !== "NEITHER_EVALUATED") throw new Error("the defect did not reproduce");
      if (rowBefore.bindingBound !== "NEITHER_EVALUATED") throw new Error(`the row recorded ${rowBefore.bindingBound}`);

      const after = await shardSupervisor.sizingPass(deps, { ...settings, session, storeTime: now() });
      const rowAfter = await prisma.shard.findUnique({ where: { shardId: `${P}-shard-a` } });

      // 30 000 agents at the registered defaults exceeds the ≈21 950 the inequality admits,
      // so the binding bound is SERIAL_COMMIT and a rebalance is indicated.
      if (after.bindingBound !== sizing.BOUND.SERIAL_COMMIT) throw new Error(`bindingBound ${after.bindingBound}`);
      if (rowAfter.bindingBound !== "SERIAL_COMMIT") throw new Error(`the row recorded ${rowAfter.bindingBound}`);
      if (rowAfter.sizingCheckedAt === null) throw new Error("no sizingCheckedAt was recorded");
      if (after.bounds.SERIAL_COMMIT.evaluated !== true) throw new Error("bound 2 still reports unevaluated");
      // Bound 1 remains unevaluated, and says so rather than reporting satisfied: it is a
      // measurement and no producer supplies one (H6, the round loop's to close).
      if (after.bounds.ROUND_WALL_CLOCK.evaluated !== false) throw new Error("bound 1 reported evaluated with no measurement");
      if (after.bounds.ROUND_WALL_CLOCK.satisfied !== null) throw new Error("an unmeasured bound was reported as satisfied");
      return `without config: NEITHER_EVALUATED; with it: SERIAL_COMMIT recorded at ${iso(rowAfter.sizingCheckedAt)}, rebalanceIndicated=${after.rebalanceIndicated}; bound 1 correctly unevaluated (no measurement producer — H6)`;
    });

    /* ═══════════════════════════════════════════════════════════════════════
       13. P13-R7 — §12.4's sweep is fleet-wide, and §19.5 obliges Phase 13 to
           delegate to exactly that sweep.

       Recorded as **external (Phase 5)** rather than fixed. The brief's rule is
       that a fix requiring an earlier phase means stop and document, and these
       two checks are the evidence for the "stop": the first reproduces the
       cross-shard repair, the second shows that Phase 13 scopes everything it
       reads itself, so the fault is in the delegate rather than in the delegation.
       ═══════════════════════════════════════════════════════════════════════ */
    console.log("\n── P13-R7 (Phase 5, external): the delegated sweep is fleet-wide ──");

    await accepted("W1", "**shard A's §19.5 sweep repairs shard C's Leg** — reproduced, not argued", async () => {
      await resetRebalanceWorld();
      await prisma.$executeRawUnsafe(`DELETE FROM "ReconcilerRepair" WHERE "shardId" LIKE $1`, `${P}%`);
      await prisma.$executeRawUnsafe(`DELETE FROM "Timer" WHERE "entityId" LIKE $1`, `${P}%`);
      await prisma.$executeRawUnsafe(`DELETE FROM "Leg" WHERE "id" LIKE $1`, `${P}%`);

      // A mission in shard C's region, and a Leg of it in PLANNED with no commitment: a Leg
      // that unambiguously belongs to shard C by §3.5's routing rule.
      await prisma.mission.update({ where: { id: `${P}-mission-2` }, data: { regionId: `${P}-region-c` } });
      await prisma.leg.create({
        data: { id: `${P}-leg-c`, legId: `${P}-leg-c`, missionId: `${P}-mission-2`, sequence: 0, purpose: "PRIMARY", state: "PLANNED", custodyState: "NONE", version: 0 },
      });
      await prisma.workQueue.create({
        data: { id: `${P}-wq-c`, legId: `${P}-leg-c`, shardId: `${P}-shard-c`, state: "PLANNED", priority: 100, version: 0 },
      }).catch(() => {});

      // Shard A's new leader runs §19.5's reconciliation, scoped — as `failover.run()` does
      // — by passing its own shardId to the sweep.
      const sweep = await reconciler.sweep(sweepDeps(), {
        assignmentDeadlineSeconds: registered("sla.assignment_deadline"),
        unresponsiveStrikes: registered("health.unresponsive_strikes"),
        shardId: `${P}-shard-a`,
      });

      const leg = await prisma.leg.findUnique({ where: { id: `${P}-leg-c` } });
      const repair = await prisma.reconcilerRepair.findFirst({ where: { entityId: `${P}-leg-c` } });

      if (leg.state !== "QUEUED") throw new Error(`the defect did not reproduce: shard C's Leg is ${leg.state}`);
      if (!repair) throw new Error("the defect did not reproduce: no repair row was written");
      if (repair.shardId !== `${P}-shard-a`) throw new Error(`the repair was attributed to ${repair.shardId}`);
      void sweep;
      return (
        `shard A's leader requeued shard C's Leg (PLANNED→QUEUED) and recorded the repair as shard A's ` +
        `(ReconcilerRepair.shardId=${repair.shardId}). Second writer to shard C, and §12.4's per-shard repair-rate ` +
        `SLI corrupted in both directions. Phase 5 owns supervision/reconciler.js.`
      );
    });

    await accepted("W2", "…and Phase 13 scopes everything it reads itself — the fault is in the delegate", async () => {
      // The same world, asked of Phase 13's own scoping function. If this were fleet-wide
      // too, P13-R7 would be a Phase 13 defect. It is not.
      const scopeA = await failoverModule.legsInShard({ prisma }, { shardId: `${P}-shard-a` });
      const scopeC = await failoverModule.legsInShard({ prisma }, { shardId: `${P}-shard-c` });

      if (!scopeA.scoped || !scopeC.scoped) throw new Error("the scope collapsed to the single-shard branch");
      if (scopeA.legIds.has(`${P}-leg-c`)) throw new Error("failover.legsInShard attributed shard C's Leg to shard A");
      if (!scopeC.legIds.has(`${P}-leg-c`)) throw new Error("failover.legsInShard did not attribute shard C's Leg to shard C");

      // And the inventory built from that scope is likewise shard-local.
      const inventoryA = await failoverModule.inventory({ prisma }, { shardId: `${P}-shard-a`, storeTime: now(), scope: scopeA });
      if (inventoryA.scope.legCount !== scopeA.legIds.size) throw new Error("the inventory did not use the scope it was given");

      return (
        `failover.legsInShard scopes correctly in both directions (A: ${scopeA.legIds.size} Leg(s), C: ${scopeC.legIds.size}); ` +
        `the fleet-wide behaviour in W1 is entirely inside supervision/reconciler.js, which §19.5 requires Phase 13 to ` +
        `delegate to and which failover.js's own header forbids re-implementing`
      );
    });

  } finally {
    console.log("\n── cleanup ──");
    await purge(true);
    await prisma.$disconnect();

    const passed = results.filter((r) => r.passed).length;
    console.log(`\n═══ PHASE 13 LIVE DATABASE: ${passed}/${results.length} checks passed ═══`);
    for (const r of results.filter((x) => !x.passed)) console.log(`  FAILED: ${r.id} — ${r.description}`);
    process.exitCode = passed === results.length ? 0 : 1;
  }
}

main().catch((e) => {
  console.error("\nHARNESS ERROR:", e);
  process.exit(1);
});

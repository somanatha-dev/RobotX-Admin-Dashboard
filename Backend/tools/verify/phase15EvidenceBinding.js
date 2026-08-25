"use strict";

/**
 * PHASE 15 current-tree re-audit (second pass) — live-PostgreSQL verification of the
 * evidence-binding findings.
 *
 * ── Why these need a database at all ───────────────────────────────────────
 * P15-C1 is arithmetic and a unit test can hold all of it. **P15-C2 cannot be seen without
 * one**, and that is the whole reason this file exists.
 *
 * The defect is a disagreement between two sides of one contract that never meet in the
 * same process in any test:
 *
 *   write side   `stage.authoriseEnable()` → `stage.auditEventFor()` → §21.7's stream
 *   read side    `cutover/store.declarationFor()` → `guardrails.declare()` → the controller
 *
 * Every existing test drives one side or the other with an object it built itself. The
 * append-only audit stream is the only place the two ever actually meet, so the round trip
 * is the check — write what the authority authorises, read it back the way the controller
 * does, and see whether the shard is assessed or silently abandoned.
 *
 * Group C reproduces the **pre-fix consequence** by writing the bad event directly, which
 * is what the unremediated `authoriseEnable` would have written. It is the evidence that the
 * finding was a real outcome and not a shape argument, and it stays in the harness so the
 * claim is reproducible after the fix rather than only before it.
 *
 * Usage:
 *   DATABASE_URL=postgresql://pgverify@127.0.0.1:55437/robotx_phase15 \
 *     node tools/verify/phase15EvidenceBinding.js
 *
 * NEVER point this at a shared instance or at the default 5432 cluster; it refuses both.
 */

const { PrismaClient } = require("@prisma/client");

const auditStream = require("../../src/engine/observability/auditStream");
const cutoverStore = require("../../src/engine/cutover/store");
// eslint-disable-next-line no-unused-vars -- read in group D's constraint comparison
const cutoverWorker = require("../../src/workers/cutover.worker");
const evidence = require("../../src/engine/cutover/evidence");
const gates = require("../../src/engine/cutover/gates");
const guardrails = require("../../src/engine/cutover/guardrails");
const stage = require("../../src/engine/cutover/stage");
const configService = require("../../src/engine/config/service");

/** Prefix for every row this harness creates, so cleanup is exact. */
const P = "p15eb";
const REGION = `${P}-region`;
const SHARD_ID = `${P}-shard-a`;

const HOUR = 3600000;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;
const DIGEST = "b".repeat(64);

/** P15-F1 — the authoritative parameter source `stage.authoriseEnable()` resolves bounds from. */
const REGISTER = configService.loadRegister({ reload: true });
const PARAMETER_VALUES = Object.freeze({
  get: (name) => (REGISTER.entries.get(name) || {}).default,
});

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
    record(id, title, false, `threw: ${String(error && error.message).slice(0, 400)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ── evidence fixtures ────────────────────────────────────────────────────────

function rehearsalRecord(producedAtMs) {
  return {
    gateId: "rollback_rehearsed",
    producedAtMs,
    producer: "operator tooling",
    owner: "release-manager",
    pass: true,
    rehearsal: {
      environment: { id: `${P}-staging`, production: false },
      configVersion: "17",
      automaticRollbackFired: true,
      steps: Object.fromEntries(evidence.REHEARSAL_STEPS.map((step) => [step, true])),
    },
    approval: { recordedBy: "alice", approvedBy: "bob" },
  };
}

function greenRecord(gate, nowMs) {
  if (gate.evidence === gates.EVIDENCE.BUILD || gate.evidence === gates.EVIDENCE.SUITE) {
    return {
      gateId: gate.id,
      producedAtMs: nowMs - 1000,
      producer: "tools/release/collectEvidence.js",
      run: { command: gate.command, exitCode: 0, build: { sourceDigest: DIGEST } },
      build: { sourceDigest: DIGEST },
    };
  }
  if (gate.evidence === gates.EVIDENCE.PRODUCTION) {
    return {
      gateId: gate.id,
      producedAtMs: nowMs - 1000,
      producer: "observability",
      owner: "sre-oncall",
      pass: true,
      observation: { windowStartedAtMs: nowMs - 40 * DAY, windowEndedAtMs: nowMs, source: "prod-metrics" },
    };
  }
  const rec = {
    gateId: gate.id,
    producedAtMs: nowMs - 1000,
    producer: "operator tooling",
    owner: "release-manager",
    pass: true,
    approval: { recordedBy: "alice", approvedBy: "bob" },
  };
  if (gate.runnable === true) rec.corroboratingRun = { command: gate.command, exitCode: 0, build: { sourceDigest: DIGEST } };
  if (gate.rehearsal === true) rec.rehearsal = rehearsalRecord(nowMs - 1000).rehearsal;
  return rec;
}

function greenTable(nowMs) {
  const table = {};
  for (const gate of gates.RELEASE_GATES) table[gate.id] = greenRecord(gate, nowMs);
  return table;
}

function validDeclaration(nowMs, overrides) {
  return guardrails.declare({
    shardId: SHARD_ID,
    declaredBy: "release-manager",
    declaredAtMs: nowMs - DAY,
    observationWindowSeconds: 3600,
    guardrails: [
      { id: "commit_latency_p99", direction: "AT_MOST", threshold: 250, minSamples: 100, unit: "ms" },
    ],
    ...overrides,
  });
}

function enableRequest(nowMs, overrides) {
  return {
    shard: { shardId: SHARD_ID, regionId: REGION, state: "ACTIVE" },
    allShards: [{ shardId: SHARD_ID, regionId: REGION, state: "ACTIVE", agentCount: 1 }],
    liveShardIds: [],
    releaseEvidence: greenTable(nowMs),
    killSwitchState: {},
    declaration: validDeclaration(nowMs),
    requestedBy: "alice",
    approvedBy: "bob",
    reason: "stage the least-loaded shard first",
    requestedAtMs: nowMs,
    sourceDigest: DIGEST,
    evidenceMaxAgeMs: DAY,
    /**
     * P15-F1 — this line read `minObservationMs: { shadow_agreement: 14 * DAY, soak: DAY }`.
     *
     * `soak: DAY` is **24 hours** against a register value of **72**, and this harness's
     * 17/17 green therefore included a soak gate judged against a third of the required
     * duration. Nothing refused it because nothing compared it to anything — which is P15-F1
     * in one line, in the repository, not in the abstract.
     *
     * The authority now resolves the bound from the register itself and refuses a request
     * that states one. The 40-day window `greenRecord` builds satisfies the real 72 h, so
     * this fixture is strictly stricter than it was and no assertion below was relaxed.
     */
    parameterValues: PARAMETER_VALUES,
    ...overrides,
  };
}

async function appendCutoverEvent(event) {
  const appended = await auditStream.append({ prisma }, { ...event, streamId: `${P}-stream` });
  assert(appended.ok, `the audit append was refused: ${appended.detail}`);
  return appended.event;
}

async function purge() {
  for (const sql of [
    `DELETE FROM "AuditEvent" WHERE "streamId" LIKE '${P}%'`,
    `DELETE FROM "Shard" WHERE "shardId" LIKE '${P}%'`,
    `DELETE FROM "ShardLeadership" WHERE "shardId" LIKE '${P}%'`,
    `DELETE FROM "Region" WHERE "regionId" LIKE '${P}%'`,
  ]) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch { /* best effort */ }
  }
}

async function main() {
  const url = process.env.DATABASE_URL || "";
  if (!url) throw new Error("DATABASE_URL is required");
  if (/neon\.tech/i.test(url) || /:5432\//.test(url)) {
    throw new Error("refusing to run against a shared or default-port instance; use a disposable cluster");
  }

  prisma = new PrismaClient({ datasources: { db: { url } } });
  await prisma.$connect();
  await purge();

  const region = await prisma.region.create({ data: { regionId: REGION, name: `${P} region` } });
  // `Shard.shardId` is a foreign key to `ShardLeadership`, so the leadership row comes first.
  await prisma.shardLeadership.create({
    data: { shardId: SHARD_ID, leadershipFence: 1n, holder: `${P}-host:1`, leaseExpiry: new Date(Date.now() + 3600_000) },
  });
  await prisma.shard.create({
    data: { id: `${P}-s-a`, shardId: SHARD_ID, regionId: region.id, state: "ACTIVE", agentCount: 1 },
  });

  const NOW = Date.now();

  // ── A. P15-C1 — the authority refuses what it cannot judge ────────────────
  console.log("\n── A. P15-C1 — an authorisation is refused unless the evidence can be judged ──");

  await accepted("A1", "the control: a complete request with a complete green table is authorised", async () => {
    const result = stage.authoriseEnable(enableRequest(NOW));
    assert(result.authorised === true, `refused: ${result.refusal && result.refusal.message}`);
    assert(result.action.binding.value === true, "the action did not bind the switch true");
    return `binding ${JSON.stringify(result.action.binding)}`;
  });

  for (const field of ["evidenceMaxAgeMs", "requestedAtMs", "sourceDigest"]) {
    await accepted(`A2.${field}`, `omitting \`${field}\` is refused by name, not judged against nothing`, async () => {
      const request = enableRequest(NOW);
      delete request[field];
      const result = stage.authoriseEnable(request);
      assert(result.authorised === false, `AUTHORISED with no ${field} — the fail-open is back`);
      assert(
        result.refusal.code === stage.REFUSAL.EVIDENCE_CONTEXT_INCOMPLETE,
        `refused as ${result.refusal.code}, which names the wrong thing`,
      );
      assert(result.refusal.message.includes(field), "the refusal does not name the missing field");
      return `[${result.refusal.code}] names ${field}`;
    });
  }

  await accepted("A3", "THE DEFECT: a three-year-old rollback rehearsal no longer takes a shard live", async () => {
    const table = greenTable(NOW);
    table.rollback_rehearsed = rehearsalRecord(NOW - 3 * YEAR);

    const unbounded = enableRequest(NOW, { releaseEvidence: table });
    delete unbounded.evidenceMaxAgeMs;
    const before = stage.authoriseEnable(unbounded);
    assert(before.authorised === false, "AUTHORISED on three-year-old evidence with no age bound");

    const bounded = stage.authoriseEnable(enableRequest(NOW, { releaseEvidence: table }));
    assert(bounded.authorised === false, "AUTHORISED on three-year-old evidence with an age bound");
    assert(bounded.refusal.code === stage.REFUSAL.RELEASE_GATE_NOT_GREEN, "the stale record was not the reason");
    assert(bounded.refusal.message.includes("rollback_rehearsed"), "the refusal does not name the stale gate");
    return "refused both ways — as an incomplete request, and as a stale record once the bound is stated";
  });

  await accepted("A4", "the age bound is the only binding six of the twenty-four gates have", async () => {
    // PRODUCTION and ORGANISATIONAL records carry no source digest by construction, so
    // without the age bound nothing at all binds them to the system being shipped.
    const unbindable = gates.RELEASE_GATES.filter(
      (gate) => gate.evidence === gates.EVIDENCE.PRODUCTION || gate.evidence === gates.EVIDENCE.ORGANISATIONAL,
    );
    assert(unbindable.length === 7, `expected 7 digest-free gates, found ${unbindable.length}`);
    for (const gate of unbindable) {
      const verdict = evidence.admit(gate, greenRecord(gate, NOW), { nowMs: NOW, sourceDigest: DIGEST });
      assert(
        verdict.code === evidence.INADMISSIBLE.AGE_BOUND_REQUIRED,
        `${gate.id} was admitted with no age bound (${verdict.code})`,
      );
    }
    return `${unbindable.length} PRODUCTION/ORGANISATIONAL gates, each refused without a bound`;
  });

  // ── B. P15-C2 — the round trip through the real audit stream ──────────────
  console.log("\n── B. P15-C2 — what the authority writes is what the controller reads ──");

  await accepted("B1", "an authorised enable writes a declaration `declarationFor` accepts", async () => {
    const authorised = stage.authoriseEnable(enableRequest(NOW));
    assert(authorised.authorised === true, "the control request was refused");

    await appendCutoverEvent(stage.auditEventFor(authorised.action));

    const readBack = await cutoverStore.declarationFor({ prisma }, SHARD_ID);
    assert(readBack !== null, "declarationFor returned null for a declaration the authority just wrote");
    assert(readBack.shardId === SHARD_ID, "the declaration came back for a different shard");
    assert(readBack.guardrails.length === 1, "the guardrails did not survive the round trip");
    return `round trip intact: ${readBack.guardrails.length} guardrail(s), declaredBy=${readBack.declaredBy}`;
  });

  await accepted("B2", "the controller assesses that shard rather than abandoning it", async () => {
    const pass = await cutoverWorker.runOnce(
      {
        liveShards: async () => [{ shardId: SHARD_ID, regionId: REGION, state: "ACTIVE" }],
        declarationFor: (shardId) => cutoverStore.declarationFor({ prisma }, shardId),
        observationsFor: async (_shardId, declaration) => ({
          windowStartedAtMs: declaration.declaredAtMs,
          windowEndedAtMs: NOW,
          observations: { commit_latency_p99: { value: 120, samples: 500 } },
        }),
        publish: async () => {
          throw new Error("no rollback should be published for a healthy shard");
        },
        audit: async () => {},
      },
      { nowMs: NOW },
    );
    const outcome = pass.results[0];
    assert(outcome.skipped === null, `the shard was skipped: ${outcome.skipped}`);
    assert(outcome.assessment !== null, "no assessment was produced");
    assert(outcome.rolledBack === false, "a healthy shard was rolled back");
    return `verdict=${outcome.verdict}, ${outcome.assessment.findings.length} guardrail(s) evaluated`;
  });

  await accepted("B3", "a real breach on that shard reaches the rollback, so the loop is closed", async () => {
    let published = null;
    const pass = await cutoverWorker.runOnce(
      {
        liveShards: async () => [{ shardId: SHARD_ID, regionId: REGION, state: "ACTIVE" }],
        declarationFor: (shardId) => cutoverStore.declarationFor({ prisma }, shardId),
        observationsFor: async (_shardId, declaration) => ({
          windowStartedAtMs: declaration.declaredAtMs,
          windowEndedAtMs: NOW,
          // 900 ms against a pre-declared AT_MOST 250 ms.
          observations: { commit_latency_p99: { value: 900, samples: 500 } },
        }),
        publish: async (action) => {
          published = action;
        },
        audit: async () => {},
      },
      { nowMs: NOW },
    );
    const outcome = pass.results[0];
    assert(outcome.rolledBack === true, `a breaching shard was not rolled back (verdict ${outcome.verdict})`);
    assert(published !== null, "no binding was handed to the publisher");
    assert(published.binding.value === false, "the rollback did not disable the shard");
    return `ROLL_BACK on commit_latency_p99=900 vs AT_MOST 250; binding ${JSON.stringify(published.binding)}`;
  });

  await accepted("B4", "every declaration `declare()` refuses is refused by the authority too", async () => {
    const invalid = [
      ["hand-built, no declarer and no guardrails", { shardId: SHARD_ID, declaredAtMs: NOW - DAY }],
      ["an empty guardrail set", { shardId: SHARD_ID, declaredBy: "rm", declaredAtMs: NOW - DAY, observationWindowSeconds: 3600, guardrails: [] }],
      ["a guardrail with no minSamples", { shardId: SHARD_ID, declaredBy: "rm", declaredAtMs: NOW - DAY, observationWindowSeconds: 3600, guardrails: [{ id: "x", direction: "AT_MOST", threshold: 1 }] }],
      ["no observation window", { shardId: SHARD_ID, declaredBy: "rm", declaredAtMs: NOW - DAY, guardrails: [{ id: "x", direction: "AT_MOST", threshold: 1, minSamples: 10 }] }],
    ];
    for (const [label, declaration] of invalid) {
      let readerRefuses = false;
      try {
        guardrails.declare(declaration);
      } catch {
        readerRefuses = true;
      }
      assert(readerRefuses, `${label}: the reader accepts it, so it is not a valid probe`);
      const result = stage.authoriseEnable(enableRequest(NOW, { declaration }));
      assert(result.authorised === false, `${label}: AUTHORISED by the write side and refused by the read side`);
      assert(result.refusal.code === stage.REFUSAL.GUARDRAILS_NOT_DECLARED, `${label}: wrong refusal code`);
    }
    return `${invalid.length} declarations the reader refuses, all refused by the authority`;
  });

  // ── C. the pre-fix consequence, reproduced against the database ───────────
  console.log("\n── C. the consequence the fix removes, reproduced by bypassing the authority ──");

  await accepted("C1", "REPRODUCTION: an invalid declaration in the stream leaves the shard unassessed for ever", async () => {
    // Exactly what the unremediated `authoriseEnable` would have written: a valid-looking
    // ENABLE event whose `guardrails` payload the reader cannot validate. Written directly,
    // because the fixed authority will no longer produce one.
    await appendCutoverEvent({
      eventType: cutoverStore.EVENT.ENABLED,
      recordedAtMs: NOW,
      subjectType: "SHARD",
      subjectId: SHARD_ID,
      actorId: "alice",
      actorRole: "OPERATOR",
      reason: "the pre-fix write side, reproduced",
      payload: {
        regionId: REGION,
        binding: { level: "region", key: REGION, name: "cutover.engine_enabled", value: true },
        approvedBy: "bob",
        guardrails: { shardId: SHARD_ID, declaredAtMs: NOW - DAY },
      },
    });

    const readBack = await cutoverStore.declarationFor({ prisma }, SHARD_ID);
    assert(readBack === null, "the reader accepted the invalid declaration — the probe is wrong");

    let rollbackAttempted = false;
    const pass = await cutoverWorker.runOnce(
      {
        liveShards: async () => [{ shardId: SHARD_ID, regionId: REGION, state: "ACTIVE" }],
        declarationFor: (shardId) => cutoverStore.declarationFor({ prisma }, shardId),
        observationsFor: async () => {
          throw new Error("the controller should never get as far as observing");
        },
        publish: async () => {
          rollbackAttempted = true;
        },
        audit: async () => {},
      },
      { nowMs: NOW },
    );
    const outcome = pass.results[0];
    assert(outcome.skipped !== null, "the shard was assessed, so the reproduction does not hold");
    assert(outcome.assessment === null, "an assessment was produced from nothing");
    assert(rollbackAttempted === false, "a rollback was attempted");
    assert(pass.rolledBack === 0, "something was rolled back");
    return `live, and reported "${String(outcome.skipped).slice(0, 68)}…" — no guardrail can ever breach`;
  });

  await accepted("C2", "and the authority can no longer produce that event", async () => {
    const result = stage.authoriseEnable(
      enableRequest(NOW, { declaration: { shardId: SHARD_ID, declaredAtMs: NOW - DAY } }),
    );
    assert(result.authorised === false, "the authority still authorises the event that produces C1");
    assert(result.action === null, "a refused authorisation still produced an action");
    return `[${result.refusal.code}] ${String(result.refusal.message).slice(0, 90)}…`;
  });

  await accepted("C3", "the two sides now share one implementation of 'well formed'", async () => {
    // Asserted structurally as well as behaviourally: a second implementation of the
    // question is how the two sides came to disagree in the first place.
    const source = require("fs").readFileSync(`${__dirname}/../../src/engine/cutover/stage.js`, "utf8");
    assert(
      /declaration = guardrails\.declare\(source\.declaration\)/.test(source),
      "the write side no longer validates through guardrails.declare()",
    );
    const readerSource = require("fs").readFileSync(`${__dirname}/../../src/engine/cutover/store.js`, "utf8");
    assert(/guardrails\.declare\(recorded\)/.test(readerSource), "the read side no longer validates through it either");
    return "stage.authoriseEnable and store.declarationFor both call guardrails.declare()";
  });

  // ── D. P15-C4 — the vocabulary, against the database that enforces it ─────
  console.log("\n── D. P15-C4 — the audit stream and the database admit the cutover's events ──");

  await accepted("D1", "the database CHECK constraint admits both cutover event types", async () => {
    // The constraint is the authority: it refused these two names, so no cutover event
    // could be written by any means — the application refused it and PostgreSQL refused it
    // again underneath. Read from `pg_constraint`, not from the migration text.
    const [row] = await prisma.$queryRawUnsafe(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'AuditEvent_event_type_known'`,
    );
    assert(row && row.def, "the AuditEvent_event_type_known constraint is missing entirely");
    for (const type of [cutoverStore.EVENT.ENABLED, cutoverStore.EVENT.ROLLED_BACK]) {
      assert(row.def.includes(type), `the constraint still refuses ${type}`);
    }
    // Every type the application declares, admitted — the drift that caused this, closed.
    for (const type of Object.values(auditStream.EVENT_TYPE)) {
      assert(row.def.includes(type), `the constraint refuses the declared type ${type}`);
    }
    return `${Object.values(auditStream.EVENT_TYPE).length} declared type(s), all admitted by the constraint`;
  });

  await accepted("D2", "a raw insert of a cutover event is accepted by PostgreSQL", async () => {
    // Bypassing the application entirely, because before the fix this was refused with
    // `ERROR 23514: violates check constraint "AuditEvent_event_type_known"`.
    await prisma.$executeRawUnsafe(`
      INSERT INTO "AuditEvent" ("id","streamId","sequence","eventType","subjectType","subjectId","hash","recordedAt")
      VALUES ('${P}-raw','${P}-raw-stream',0,'${cutoverStore.EVENT.ENABLED}','SHARD','${SHARD_ID}','${P}-raw-hash', NOW())
    `);
    const count = await prisma.auditEvent.count({ where: { id: `${P}-raw` } });
    assert(count === 1, "the raw insert did not land");
    await prisma.$executeRawUnsafe(`DELETE FROM "AuditEvent" WHERE "id" = '${P}-raw'`);
    return "accepted at the database, so the constraint and the vocabulary now agree";
  });

  await accepted("D3", "an unrecognised cutover-shaped type is still refused by the database", async () => {
    // The widening must not have become a removal: §21.7's constraint exists because "an
    // append-only stream that accepts an unrecognised event type accepts an event nobody
    // defined the meaning of".
    let refused = false;
    try {
      await prisma.$executeRawUnsafe(`
        INSERT INTO "AuditEvent" ("id","streamId","sequence","eventType","subjectType","subjectId","hash","recordedAt")
        VALUES ('${P}-bad','${P}-raw-stream',1,'CUTOVER_SHARD_MAYBE','SHARD','${SHARD_ID}','${P}-bad-hash', NOW())
      `);
    } catch (error) {
      refused = /AuditEvent_event_type_known/.test(String(error && error.message));
    }
    assert(refused, "the database accepted an event type nobody declared");
    return "refused by AuditEvent_event_type_known, as it should be";
  });

  // ── Z. cleanup ────────────────────────────────────────────────────────────
  console.log("\n── cleanup ──");
  await accepted("Z1", "remove every row this harness created", async () => {
    await purge();
    const left = await prisma.auditEvent.count({ where: { streamId: { startsWith: P } } });
    assert(left === 0, `${left} audit event(s) left behind`);
    return "clean";
  });

  const passed = results.filter((r) => r.ok).length;
  console.log("\n══════════════════════════════════════════════════════════════════════════════");
  console.log(`PHASE 15 evidence-binding verification: ${passed}/${results.length} passed`);
  console.log("══════════════════════════════════════════════════════════════════════════════");
  return passed === results.length;
}

main()
  .then(async (ok) => {
    if (prisma) await prisma.$disconnect();
    process.exitCode = ok ? 0 : 1;
  })
  .catch(async (error) => {
    console.error(error);
    if (prisma) await prisma.$disconnect();
    process.exitCode = 1;
  });

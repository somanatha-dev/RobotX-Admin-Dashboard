"use strict";

/**
 * PHASE 4 — live-PostgreSQL verification of the transactional outbox and the agent
 * protocol's durable state (§11).
 *
 * Phase 4's independent verification recorded, as its issue 6, that no migration in
 * this programme had been executed against a real PostgreSQL instance — the fourth
 * consecutive phase to carry that gap forward. Its Part 4.3 named precisely what static
 * cross-checking could not reach:
 *
 *   1. **The first foreign key to a non-primary-key unique column.**
 *      `Outbox.commitmentId → Commitment.commitmentId` is a form no earlier migration
 *      used. That it *parses* is not evidence that it *references*, that it restricts a
 *      delete, or that PostgreSQL will even accept it without a unique index behind it.
 *   2. **The five hand-written CHECK constraints.** They are absent from Prisma's own
 *      generated SQL by design, so nothing but PostgreSQL evaluates their predicates.
 *      A CHECK with a typo in a column name is a constraint that never fires.
 *   3. **`BigInt` and `DateTime` marshalling.** The fences are `BigInt` columns and the
 *      test store model is JavaScript; a fence that round-trips through the driver as a
 *      Number would be silently wrong above 2^53 and right everywhere a hand-written
 *      test would look.
 *   4. **Claim atomicity.** `outbox.claim`'s conditional `updateMany` is a claim about a
 *      race. A single-threaded JavaScript model cannot lose that race.
 *
 * This harness drives the **shipped** `dispatch/outbox.js`, `dispatch/offers.js`,
 * `dispatch/escalation.js` and `workers/outbox.worker.js` against a real instance
 * carrying the real migration chain. It writes no file and mutates only rows it
 * creates, under identifiers prefixed `p4-`.
 *
 * Usage:
 *   DATABASE_URL=postgresql://user:pw@127.0.0.1:55432/db node tools/verify/phase4LiveDatabase.js
 *
 * Deliberately **not** a Jest suite, for the same reason Phase 3's harness is not: it
 * requires a PostgreSQL instance, and a test that silently skips when its environment is
 * absent is a test that reports green for having done nothing.
 */

const { PrismaClient } = require("@prisma/client");

const escalation = require("../../src/engine/dispatch/escalation");
const offers = require("../../src/engine/dispatch/offers");
const outbox = require("../../src/engine/dispatch/outbox");
const worker = require("../../src/workers/outbox.worker");

const SIGNING_KEY = "p4-live-verification-signing-key-32b";
const OFFER_TTL_SECONDS = 20;
const RETRY_WINDOW_SECONDS = 10;
const UNRESPONSIVE_STRIKES = 3;
const SYSTEMIC_THRESHOLD = 0.2;
const MAX_DELIVERY_DELAY_SECONDS = 30;
const NACK_COOLOFF_SECONDS = 60;
const TX_TIMEOUT_MS = 30000;

const results = [];
let currentGroup = "";

function group(name) {
  currentGroup = name;
  console.log(`\n─── ${name} ${"─".repeat(Math.max(0, 74 - name.length))}`);
}

function record(label, ok, detail) {
  results.push({ group: currentGroup, label, ok, detail: detail || "" });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n          ${detail}` : ""}`);
}

function check(label, condition, detail) {
  record(label, Boolean(condition), detail);
}

let seq = 0;
const uid = (prefix) => `p4-${prefix}-${process.pid}-${(seq += 1)}`;

/** Did this operation fail, and with what PostgreSQL said about it? */
async function rejected(fn) {
  try {
    await fn();
    return { rejected: false, message: null };
  } catch (error) {
    return { rejected: true, message: (error && error.message ? error.message : String(error)).replace(/\s+/g, " ") };
  }
}

async function reset(prisma) {
  await prisma.$executeRawUnsafe(`DELETE FROM "Outbox" WHERE "agentId" LIKE 'p4-%'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "AgentDedupState" WHERE "agentId" LIKE 'p4-%'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Commitment" WHERE "agentId" LIKE 'p4-%'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "AgentFenceAudit" WHERE "agentId" LIKE 'p4-%'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Leg" WHERE "id" LIKE 'p4-%'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Mission" WHERE "id" LIKE 'p4-%'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Agent" WHERE "id" LIKE 'p4-%'`);
}

/**
 * One agent, one mission, one Leg, and one held commitment — the state a delivered
 * `OFFER` sits on top of.
 */
async function seed(prisma, options) {
  const settings = options || {};
  const agentRowId = uid("agent");
  const missionRowId = uid("mission");
  const legRowId = uid("leg");
  const commitmentId = uid("commitment");

  await prisma.agent.create({
    data: {
      id: agentRowId,
      agentId: `BUSINESS-${agentRowId}`,
      authorityEpoch: BigInt(7),
      fenceCounter: BigInt(settings.fenceCounter === undefined ? 41 : settings.fenceCounter),
    },
  });
  await prisma.mission.create({ data: { id: missionRowId, missionId: `M-${missionRowId}` } });
  const leg = await prisma.leg.create({
    data: {
      id: legRowId,
      legId: `BUSINESS-${legRowId}`,
      missionId: missionRowId,
      sequence: 0,
      purpose: "PRIMARY",
      state: settings.legState || offers.LEG_STATE.OFFERED,
      version: 0,
    },
  });

  const commitment = await prisma.commitment.create({
    data: {
      commitmentId,
      agentId: agentRowId,
      legId: legRowId,
      kind: "HARD",
      fence: BigInt(settings.fence === undefined ? 42 : settings.fence),
      planSnapshotRef: "plan-live",
      decisionRef: "decision-live",
      leaseExpiry: new Date(Date.now() + 3600_000),
      releasedAt: settings.released ? new Date() : null,
    },
  });

  return { agentRowId, legRowId, leg, commitment, commitmentId };
}

/* ═══════════════════════════════════════════════════════════════════════════
   1 — The objects the migration claims to create actually exist
   ═══════════════════════════════════════════════════════════════════════════ */

async function schemaObjects(prisma) {
  group("1 — Phase 4's schema objects, read from PostgreSQL's own catalogue");

  const tables = await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('Outbox','AgentDedupState')
      ORDER BY table_name`,
  );
  check(
    "both Phase 4 tables exist",
    tables.length === 2,
    tables.map((t) => t.table_name).join(", ") || "(none)",
  );

  const columns = await prisma.$queryRawUnsafe(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Outbox' ORDER BY ordinal_position`,
  );
  const columnNames = columns.map((c) => c.column_name);
  const expected = [
    "id", "idempotencyKey", "agentId", "commitmentId", "commandClass", "command", "fenceScope",
    "fence", "authorityEpoch", "fenceFloor", "sequence", "payload", "notValidAfter", "signature",
    "state", "attempts", "claimedBy", "claimedAt", "claimExpiresAt", "deliveredAt", "ackedAt",
    "lastError", "createdAt", "updatedAt",
  ];
  const missing = expected.filter((name) => !columnNames.includes(name));
  check(`all ${expected.length} Outbox columns exist`, missing.length === 0, missing.length ? `missing: ${missing}` : `${columnNames.length} columns present`);

  // The BigInt columns are the ones the store model cannot prove anything about.
  const bigints = columns.filter((c) => ["fence", "authorityEpoch", "fenceFloor"].includes(c.column_name));
  check(
    "the three fence columns are bigint, not integer — a fence must outlive 2^31",
    bigints.length === 3 && bigints.every((c) => c.data_type === "bigint"),
    bigints.map((c) => `${c.column_name}=${c.data_type}`).join(", "),
  );

  const indexes = await prisma.$queryRawUnsafe(
    `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename IN ('Outbox','AgentDedupState') ORDER BY indexname`,
  );
  const indexNames = indexes.map((i) => i.indexname);
  check(
    "the plan's named index (state, notValidAfter) exists",
    indexNames.includes("Outbox_state_notValidAfter_idx"),
    indexNames.join(", "),
  );
  check(
    "the idempotency key is uniquely indexed — one authority cannot become two obligations",
    indexNames.includes("Outbox_idempotencyKey_key"),
    "",
  );

  const checks = await prisma.$queryRawUnsafe(
    `SELECT con.conname FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE con.contype = 'c' AND rel.relname IN ('Outbox','AgentDedupState')
      ORDER BY con.conname`,
  );
  const checkNames = checks.map((c) => c.conname);
  for (const name of [
    "Outbox_command_class_known",
    "Outbox_fence_scope_columns",
    "Outbox_sequence_non_negative",
    "Outbox_state_known",
    "AgentDedupState_counters_non_negative",
  ]) {
    check(`CHECK ${name} exists in the live catalogue`, checkNames.includes(name), "");
  }

  const fks = await prisma.$queryRawUnsafe(
    `SELECT con.conname, con.confdeltype,
            (SELECT relname FROM pg_class WHERE oid = con.confrelid) AS target
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE con.contype = 'f' AND rel.relname IN ('Outbox','AgentDedupState')
      ORDER BY con.conname`,
  );
  check(
    "Outbox → Commitment foreign key exists — the schema's first FK to a non-primary-key unique column",
    fks.some((f) => f.conname === "Outbox_commitmentId_fkey" && f.target === "Commitment"),
    fks.map((f) => `${f.conname}→${f.target}(del=${f.confdeltype})`).join(", "),
  );
  check(
    "that FK restricts deletes (confdeltype 'r'), so a held commitment cannot be deleted from under its obligation",
    fks.some((f) => f.conname === "Outbox_commitmentId_fkey" && f.confdeltype === "r"),
    "",
  );
  check(
    "AgentDedupState → Agent cascades (confdeltype 'c') — the dedup state is the agent's, and dies with it",
    fks.some((f) => f.conname === "AgentDedupState_agentId_fkey" && f.confdeltype === "c"),
    "",
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   2 — The constraints actually reject what they claim to reject
   ═══════════════════════════════════════════════════════════════════════════ */

async function constraintsBite(prisma) {
  group("2 — every CHECK, unique and FK is exercised with a row it must refuse");

  const fixture = await seed(prisma);

  const base = {
    idempotencyKey: uid("idem"),
    agentId: fixture.agentRowId,
    commitmentId: fixture.commitmentId,
    commandClass: "MISSION",
    command: "OFFER",
    fenceScope: "COMMITMENT",
    fence: BigInt(42),
    sequence: 0,
    payload: {},
    notValidAfter: new Date(Date.now() + 3600_000),
    signature: "sig",
  };

  // A valid row is accepted — otherwise every rejection below proves nothing.
  const accepted = await rejected(() => prisma.outbox.create({ data: { ...base } }));
  check("a well-formed mission row is accepted", accepted.rejected === false, accepted.message || "");

  const unknownState = await rejected(() =>
    prisma.outbox.create({ data: { ...base, idempotencyKey: uid("idem"), state: "NOT_A_STATE" } }),
  );
  check(
    "Outbox_state_known rejects a state the module does not define",
    unknownState.rejected && /Outbox_state_known/.test(unknownState.message),
    unknownState.message,
  );

  const queryClass = await rejected(() =>
    prisma.outbox.create({ data: { ...base, idempotencyKey: uid("idem"), commandClass: "QUERY" } }),
  );
  check(
    "Outbox_command_class_known rejects QUERY — §10.3.1 row 3 is never enqueued",
    queryClass.rejected && /Outbox_command_class_known/.test(queryClass.message),
    queryClass.message,
  );

  const negativeSequence = await rejected(() =>
    prisma.outbox.create({ data: { ...base, idempotencyKey: uid("idem"), sequence: -1 } }),
  );
  check(
    "Outbox_sequence_non_negative rejects a negative sequence",
    negativeSequence.rejected && /Outbox_sequence_non_negative/.test(negativeSequence.message),
    negativeSequence.message,
  );

  // §10.3.1's scope discipline, as a database constraint rather than a convention: a
  // mission row without a fence, and an agent row that names a commitment.
  const missionWithoutFence = await rejected(() =>
    prisma.outbox.create({ data: { ...base, idempotencyKey: uid("idem"), fence: null } }),
  );
  check(
    "Outbox_fence_scope_columns rejects a mission row with no fence",
    missionWithoutFence.rejected && /Outbox_fence_scope_columns/.test(missionWithoutFence.message),
    missionWithoutFence.message,
  );

  const agentNamingCommitment = await rejected(() =>
    prisma.outbox.create({
      data: {
        ...base,
        idempotencyKey: uid("idem"),
        commandClass: "AGENT",
        command: "STAND_DOWN_ALL",
        fenceScope: "AGENT",
        fence: null,
        authorityEpoch: BigInt(8),
        fenceFloor: BigInt(50),
      },
    }),
  );
  check(
    "Outbox_fence_scope_columns rejects an agent row that names a commitment",
    agentNamingCommitment.rejected && /Outbox_fence_scope_columns/.test(agentNamingCommitment.message),
    agentNamingCommitment.message,
  );

  const duplicateKey = await rejected(() =>
    prisma.outbox.create({ data: { ...base, idempotencyKey: base.idempotencyKey } }),
  );
  check(
    "the unique idempotency key refuses a second row for one authority (§10.5)",
    duplicateKey.rejected && /idempotencyKey|unique/i.test(duplicateKey.message),
    duplicateKey.message,
  );

  // The FK the report flagged as the migration's novel risk.
  const danglingCommitment = await rejected(() =>
    prisma.outbox.create({ data: { ...base, idempotencyKey: uid("idem"), commitmentId: "p4-no-such-commitment" } }),
  );
  check(
    "the non-primary-key FK refuses a row naming a commitment that does not exist",
    danglingCommitment.rejected && /foreign key|Outbox_commitmentId_fkey/i.test(danglingCommitment.message),
    danglingCommitment.message,
  );

  const restrictedDelete = await rejected(() =>
    prisma.commitment.delete({ where: { commitmentId: fixture.commitmentId } }),
  );
  check(
    "onDelete: Restrict actually restricts — a commitment with a dispatch obligation cannot be deleted",
    restrictedDelete.rejected,
    restrictedDelete.message,
  );

  const negativeGeneration = await rejected(() =>
    prisma.agentDedupState.create({
      data: { agentId: fixture.agentRowId, dedupStateGeneration: BigInt(-1), authorityEpoch: BigInt(0), fenceFloor: BigInt(0) },
    }),
  );
  check(
    "AgentDedupState_counters_non_negative rejects a negative generation",
    negativeGeneration.rejected && /AgentDedupState_counters_non_negative/.test(negativeGeneration.message),
    negativeGeneration.message,
  );

  // A fence beyond 2^53 — the value a Number-typed column would silently corrupt.
  const hugeFence = BigInt("9007199254740993");
  await prisma.agent.update({ where: { id: fixture.agentRowId }, data: { fenceCounter: hugeFence } });
  const readBack = await prisma.agent.findUnique({ where: { id: fixture.agentRowId } });
  check(
    "a fence above 2^53 round-trips through the driver exactly",
    BigInt(readBack.fenceCounter) === hugeFence,
    `wrote ${hugeFence}, read ${readBack.fenceCounter}`,
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   3 — The transactional-outbox invariant, against a real transaction
   ═══════════════════════════════════════════════════════════════════════════ */

async function transactionalInvariant(prisma) {
  group("3 — §4.1 rule 5: the row lives or dies with its authorising transaction");

  const fixture = await seed(prisma);

  const before = await prisma.outbox.count({ where: { commitmentId: fixture.commitmentId } });

  // A transaction that writes the obligation and then fails.
  const rolledBack = await rejected(() =>
    prisma.$transaction(
      async (tx) => {
        await offers.enqueueOffer(tx, {
          commitment: fixture.commitment,
          storeTime: new Date(),
          offerTtlSeconds: OFFER_TTL_SECONDS,
          offer: { legId: fixture.legRowId, stopSequence: [] },
          signingKey: SIGNING_KEY,
        });
        throw new Error("the authorising transaction fails after the enqueue");
      },
      { timeout: TX_TIMEOUT_MS },
    ),
  );
  const afterRollback = await prisma.outbox.count({ where: { commitmentId: fixture.commitmentId } });
  check(
    "an authorising transaction that fails leaves no dispatch obligation behind",
    rolledBack.rejected && afterRollback === before,
    `rows before ${before}, after rollback ${afterRollback}`,
  );

  // The same transaction, committed.
  const row = await prisma.$transaction(
    (tx) =>
      offers.enqueueOffer(tx, {
        commitment: fixture.commitment,
        storeTime: new Date(),
        offerTtlSeconds: OFFER_TTL_SECONDS,
        offer: { legId: fixture.legRowId, stopSequence: [] },
        signingKey: SIGNING_KEY,
      }),
    { timeout: TX_TIMEOUT_MS },
  );
  const afterCommit = await prisma.outbox.count({ where: { commitmentId: fixture.commitmentId } });
  check(
    "a committed authorising transaction leaves exactly one",
    afterCommit === before + 1 && row.state === outbox.OUTBOX_STATE.PENDING,
    `rows ${afterCommit}, state ${row.state}, fence ${row.fence}`,
  );

  check(
    "the fence survived the round trip as a BigInt equal to the commitment's",
    BigInt(row.fence) === BigInt(fixture.commitment.fence),
    `outbox ${row.fence} vs commitment ${fixture.commitment.fence}`,
  );

  // Idempotency, against the live unique index rather than against a model of it.
  //
  // The retry that matters is the *same command* enqueued twice — a transaction that
  // was retried after a serialization failure, replaying the identical authority. It is
  // not "call `enqueueOffer` again", which allocates the next sequence and is therefore
  // a genuinely different command by construction (§10.5's key includes the sequence).
  const replayed = outbox.buildRow({
    command: "OFFER",
    agentId: fixture.agentRowId,
    commitmentId: fixture.commitmentId,
    fence: BigInt(row.fence),
    sequence: row.sequence,
    payload: row.payload,
    notValidAfter: row.notValidAfter,
    signature: row.signature,
  });
  check(
    "the replayed command derives the same idempotency key",
    replayed.idempotencyKey === row.idempotencyKey,
    `${replayed.idempotencyKey}`,
  );

  const again = await prisma.$transaction((tx) => outbox.enqueue(tx, replayed), { timeout: TX_TIMEOUT_MS });
  const afterRetry = await prisma.outbox.count({ where: { commitmentId: fixture.commitmentId } });
  check(
    "a retried enqueue observes its own prior row rather than creating a second obligation",
    afterRetry === afterCommit && again.id === row.id,
    `rows ${afterRetry}`,
  );

  const enqueueOutsideTransaction = await rejected(() =>
    outbox.enqueue(prisma, outbox.buildRow({
      command: "RECALL",
      agentId: fixture.agentRowId,
      commitmentId: fixture.commitmentId,
      fence: BigInt(43),
      sequence: 1,
      payload: {},
      notValidAfter: new Date(Date.now() + 3600_000),
      signature: "sig",
    })),
  );
  check(
    "enqueue refuses the base client — the rule is structural, not a convention",
    enqueueOutsideTransaction.rejected && /MUST be written inside the transaction/.test(enqueueOutsideTransaction.message),
    "",
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   4 — Claim atomicity, against a race a JavaScript model cannot lose
   ═══════════════════════════════════════════════════════════════════════════ */

async function claimRace(prisma) {
  group("4 — two workers race for one row; PostgreSQL decides, not the model");

  const fixture = await seed(prisma);
  // A long envelope validity, and a claim lease far shorter than it: the reclaim this
  // group tests is a *lease* expiring, and a fixture whose lease and `not_valid_after`
  // lapse together would prove the wrong thing (the row would be excluded by validity,
  // not reclaimed by lease).
  const CLAIM_LEASE_SECONDS = 5;
  await prisma.$transaction(
    (tx) =>
      offers.enqueueOffer(tx, {
        commitment: fixture.commitment,
        storeTime: new Date(),
        offerTtlSeconds: 3600,
        offer: { legId: fixture.legRowId, stopSequence: [] },
        signingKey: SIGNING_KEY,
      }),
    { timeout: TX_TIMEOUT_MS },
  );

  const storeTime = new Date();
  const claimArgs = (workerId) => ({ workerId, storeTime, limit: 8, claimTtlSeconds: CLAIM_LEASE_SECONDS });

  const [a, b, c] = await Promise.all([
    outbox.claim(prisma, claimArgs("worker-a")),
    outbox.claim(prisma, claimArgs("worker-b")),
    outbox.claim(prisma, claimArgs("worker-c")),
  ]);

  const mine = (claimed) => claimed.filter((r) => r.commitmentId === fixture.commitmentId).length;
  const total = mine(a) + mine(b) + mine(c);
  check(
    "exactly one of three concurrent workers claims the row",
    total === 1,
    `worker-a ${mine(a)}, worker-b ${mine(b)}, worker-c ${mine(c)}`,
  );

  const row = await prisma.outbox.findFirst({ where: { commitmentId: fixture.commitmentId, command: "OFFER" } });
  check(
    "the row is CLAIMED, by exactly one named holder, with a lease",
    row.state === outbox.OUTBOX_STATE.CLAIMED && Boolean(row.claimedBy) && row.claimExpiresAt instanceof Date,
    `state ${row.state}, holder ${row.claimedBy}, expires ${row.claimExpiresAt && row.claimExpiresAt.toISOString()}`,
  );

  // A lapsed claim is reclaimable — the "stuck with no owner" class §12.1 forbids.
  const afterLease = new Date(row.claimExpiresAt.getTime() + 1000);
  const reclaimed = await outbox.claim(prisma, {
    workerId: "worker-d",
    storeTime: afterLease,
    limit: 8,
    claimTtlSeconds: CLAIM_LEASE_SECONDS,
  });
  check(
    "once the lease expires another worker reclaims it",
    reclaimed.some((r) => r.id === row.id),
    `reclaimed ${reclaimed.length} row(s)`,
  );

  // And a worker whose claim lapsed cannot overwrite the new holder's progress.
  const staleWrite = await outbox.recordAttempt(prisma, {
    id: row.id,
    workerId: row.claimedBy,
    delivered: true,
    storeTime: afterLease,
  });
  check(
    "the displaced worker's attempt record is discarded, not applied",
    staleWrite === 0,
    `updateMany matched ${staleWrite} row(s)`,
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   5 — §11.3's backoff, against the `updatedAt` PostgreSQL maintains
   ═══════════════════════════════════════════════════════════════════════════ */

async function backoffPacing(prisma) {
  group("5 — §11.3: the retry schedule is enforced against a real updatedAt");

  const fixture = await seed(prisma);
  await prisma.$transaction(
    (tx) =>
      offers.enqueueOffer(tx, {
        commitment: fixture.commitment,
        storeTime: new Date(),
        offerTtlSeconds: OFFER_TTL_SECONDS,
        offer: { legId: fixture.legRowId, stopSequence: [] },
        signingKey: SIGNING_KEY,
      }),
    { timeout: TX_TIMEOUT_MS },
  );

  const deliver = async () => ({ delivered: false, detail: "AGENT_NOT_CONNECTED" });
  const config = {
    retryWindowSeconds: RETRY_WINDOW_SECONDS,
    offerTtlSeconds: OFFER_TTL_SECONDS,
    unresponsiveStrikes: UNRESPONSIVE_STRIKES,
    systemicThreshold: SYSTEMIC_THRESHOLD,
  };

  const first = await worker.drainOnce(
    { prisma, deliver, readStoreTime: async () => new Date() },
    config,
    "w-live-1",
  );
  const afterFirst = await prisma.outbox.findFirst({ where: { commitmentId: fixture.commitmentId } });
  check(
    "a failed attempt returns the row to PENDING with the attempt counted",
    afterFirst.state === outbox.OUTBOX_STATE.PENDING && afterFirst.attempts === 1,
    `claimed ${first.claimed}, state ${afterFirst.state}, attempts ${afterFirst.attempts}`,
  );

  check(
    "PostgreSQL maintained updatedAt on the updateMany the attempt record performed",
    afterFirst.updatedAt instanceof Date && afterFirst.updatedAt.getTime() >= afterFirst.createdAt.getTime(),
    `createdAt ${afterFirst.createdAt.toISOString()}, updatedAt ${afterFirst.updatedAt.toISOString()}`,
  );

  const dueAt = escalation.retryDueAt({ row: afterFirst, retryWindowSeconds: RETRY_WINDOW_SECONDS });
  check(
    "the row's next attempt is scheduled in the future, not immediately",
    dueAt instanceof Date && dueAt.getTime() > afterFirst.updatedAt.getTime(),
    `due at ${dueAt && dueAt.toISOString()}`,
  );

  let attemptedInsideBackoff = false;
  const second = await worker.drainOnce(
    {
      prisma,
      deliver: async () => {
        attemptedInsideBackoff = true;
        return { delivered: true };
      },
      readStoreTime: async () => new Date(),
    },
    config,
    "w-live-1",
  );
  check(
    "the pass that follows immediately does not retry — the backoff is enforced, not logged",
    attemptedInsideBackoff === false && second.claimed === 0,
    `claimed ${second.claimed}`,
  );

  let attemptedAfterBackoff = false;
  await worker.drainOnce(
    {
      prisma,
      deliver: async () => {
        attemptedAfterBackoff = true;
        return { delivered: true };
      },
      readStoreTime: async () => new Date(dueAt.getTime() + 1000),
    },
    config,
    "w-live-1",
  );
  check(
    "the pass after the backoff has elapsed does retry — the row is paced, not abandoned",
    attemptedAfterBackoff === true,
    "",
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   6 — §11.4 step 2, end to end, in one real transaction
   ═══════════════════════════════════════════════════════════════════════════ */

async function escalationStepTwo(prisma) {
  group("6 — §11.4 step 2: the withdrawal actually lands, atomically");

  const fixture = await seed(prisma);
  const enqueuedAt = new Date();
  await prisma.$transaction(
    (tx) =>
      offers.enqueueOffer(tx, {
        commitment: fixture.commitment,
        storeTime: enqueuedAt,
        offerTtlSeconds: OFFER_TTL_SECONDS,
        offer: { legId: fixture.legRowId, stopSequence: [] },
        signingKey: SIGNING_KEY,
      }),
    { timeout: TX_TIMEOUT_MS },
  );

  const config = {
    retryWindowSeconds: RETRY_WINDOW_SECONDS,
    offerTtlSeconds: OFFER_TTL_SECONDS,
    unresponsiveStrikes: UNRESPONSIVE_STRIKES,
    systemicThreshold: SYSTEMIC_THRESHOLD,
    maxDeliveryDelaySeconds: MAX_DELIVERY_DELAY_SECONDS,
    nackCooloffSeconds: NACK_COOLOFF_SECONDS,
    signingKey: SIGNING_KEY,
  };

  // Deliver it, then let the ACK deadline pass with no answer.
  await worker.drainOnce(
    { prisma, deliver: async () => ({ delivered: true }), readStoreTime: async () => enqueuedAt },
    config,
    "w-live-2",
  );

  const pastTtl = new Date(enqueuedAt.getTime() + (OFFER_TTL_SECONDS + 5) * 1000);
  const agentBefore = await prisma.agent.findUnique({ where: { id: fixture.agentRowId } });
  const sliBefore = await outbox.readSli(prisma, pastTtl);

  const events = [];
  const summary = await worker.drainOnce(
    {
      prisma,
      deliver: async () => ({ delivered: true }),
      readStoreTime: async () => pastTtl,
      record: (event, detail) => events.push({ event, detail }),
      runInTransaction: (fn) => prisma.$transaction(fn, { timeout: TX_TIMEOUT_MS }),
    },
    config,
    "w-live-2",
  );

  check(
    "the ladder reached step 2 and performed a withdrawal",
    summary.withdrawn === 1,
    `escalated ${summary.escalated}, withdrawn ${summary.withdrawn}; events ${JSON.stringify(events)}`,
  );

  const commitmentAfter = await prisma.commitment.findUnique({ where: { commitmentId: fixture.commitmentId } });
  check(
    "the commitment is released — the capacity slot is returned",
    commitmentAfter.releasedAt !== null,
    `releasedAt ${commitmentAfter.releasedAt && commitmentAfter.releasedAt.toISOString()}`,
  );

  const legAfter = await prisma.leg.findUnique({ where: { id: fixture.legRowId } });
  check(
    "the Leg returned to QUEUED for the next round to re-plan",
    legAfter.state === offers.LEG_STATE.QUEUED,
    `state ${legAfter.state}, version ${legAfter.version}`,
  );

  const agentAfter = await prisma.agent.findUnique({ where: { id: fixture.agentRowId } });
  check(
    "the agent's fence counter strictly advanced (invariant I6)",
    BigInt(agentAfter.fenceCounter) > BigInt(agentBefore.fenceCounter),
    `${agentBefore.fenceCounter} → ${agentAfter.fenceCounter}`,
  );

  const withdrawRow = await prisma.outbox.findFirst({
    where: { commitmentId: fixture.commitmentId, command: "WITHDRAW" },
  });
  check(
    "a WITHDRAW was dispatched through the outbox, at the advanced fence",
    Boolean(withdrawRow) && BigInt(withdrawRow.fence) === BigInt(agentAfter.fenceCounter),
    withdrawRow ? `fence ${withdrawRow.fence}, state ${withdrawRow.state}` : "(no WITHDRAW row)",
  );

  const offerRow = await prisma.outbox.findFirst({
    where: { commitmentId: fixture.commitmentId, command: "OFFER" },
  });
  check(
    "the unanswered OFFER is terminal as FAILED, carrying the completion marker",
    offerRow.state === outbox.OUTBOX_STATE.FAILED && offerRow.lastError === escalation.WITHDRAWN_MARK,
    `state ${offerRow.state}, lastError ${offerRow.lastError}`,
  );
  check(
    "and it still counts as the agent's step-3 mark — the action did not erase its own evidence",
    escalation.isMarkedUnresponsive(offerRow),
    "",
  );

  const sliAfter = await outbox.readSli(prisma, pastTtl);
  check(
    "the SLI counted the unanswered offer while it was outstanding, and stopped counting once withdrawn",
    sliBefore.depth === 1 && sliAfter.depth === 1,
    `depth ${sliBefore.depth} → ${sliAfter.depth} (the OFFER left the count; the WITHDRAW it authorised entered it)`,
  );

  // Repeated escalation is idempotent: nothing left to withdraw, nothing undone.
  const repeat = await worker.drainOnce(
    {
      prisma,
      deliver: async () => ({ delivered: true }),
      readStoreTime: async () => new Date(pastTtl.getTime() + 60_000),
      runInTransaction: (fn) => prisma.$transaction(fn, { timeout: TX_TIMEOUT_MS }),
    },
    config,
    "w-live-3",
  );
  const commitmentAfterRepeat = await prisma.commitment.findUnique({ where: { commitmentId: fixture.commitmentId } });
  const agentAfterRepeat = await prisma.agent.findUnique({ where: { id: fixture.agentRowId } });
  check(
    "a second escalation pass does not withdraw twice, nor advance the fence again",
    repeat.withdrawn === 0 &&
      commitmentAfterRepeat.releasedAt.getTime() === commitmentAfter.releasedAt.getTime() &&
      BigInt(agentAfterRepeat.fenceCounter) === BigInt(agentAfter.fenceCounter),
    `withdrawn ${repeat.withdrawn}, fence ${agentAfterRepeat.fenceCounter}`,
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   7 — The withdrawal is one transaction or none of it
   ═══════════════════════════════════════════════════════════════════════════ */

async function withdrawalAtomicity(prisma) {
  group("7 — a failed withdrawal leaves no partial state");

  const fixture = await seed(prisma);
  const enqueuedAt = new Date();
  await prisma.$transaction(
    (tx) =>
      offers.enqueueOffer(tx, {
        commitment: fixture.commitment,
        storeTime: enqueuedAt,
        offerTtlSeconds: OFFER_TTL_SECONDS,
        offer: { legId: fixture.legRowId, stopSequence: [] },
        signingKey: SIGNING_KEY,
      }),
    { timeout: TX_TIMEOUT_MS },
  );

  const agentBefore = await prisma.agent.findUnique({ where: { id: fixture.agentRowId } });
  const pastTtl = new Date(enqueuedAt.getTime() + (OFFER_TTL_SECONDS + 5) * 1000);

  // A transaction seam that fails *after* the shipped withdrawal has done its work.
  const summary = await worker.drainOnce(
    {
      prisma,
      deliver: async () => ({ delivered: true }),
      readStoreTime: async () => pastTtl,
      runInTransaction: (fn) =>
        prisma.$transaction(
          async (tx) => {
            await fn(tx);
            throw new Error("the withdrawal transaction fails at the last moment");
          },
          { timeout: TX_TIMEOUT_MS },
        ),
    },
    { retryWindowSeconds: RETRY_WINDOW_SECONDS, offerTtlSeconds: OFFER_TTL_SECONDS, unresponsiveStrikes: UNRESPONSIVE_STRIKES, systemicThreshold: SYSTEMIC_THRESHOLD, maxDeliveryDelaySeconds: MAX_DELIVERY_DELAY_SECONDS, nackCooloffSeconds: NACK_COOLOFF_SECONDS, signingKey: SIGNING_KEY },
    "w-live-4",
  );

  const commitmentAfter = await prisma.commitment.findUnique({ where: { commitmentId: fixture.commitmentId } });
  const legAfter = await prisma.leg.findUnique({ where: { id: fixture.legRowId } });
  const agentAfter = await prisma.agent.findUnique({ where: { id: fixture.agentRowId } });
  const withdrawRow = await prisma.outbox.findFirst({ where: { commitmentId: fixture.commitmentId, command: "WITHDRAW" } });
  const offerRow = await prisma.outbox.findFirst({ where: { commitmentId: fixture.commitmentId, command: "OFFER" } });

  check("the failed withdrawal is reported, not counted as done", summary.withdrawn === 0, `withdrawn ${summary.withdrawn}`);
  check("no fence was advanced", BigInt(agentAfter.fenceCounter) === BigInt(agentBefore.fenceCounter), `${agentBefore.fenceCounter} → ${agentAfter.fenceCounter}`);
  check("the commitment was not released", commitmentAfter.releasedAt === null, "");
  check("the Leg did not move", legAfter.state === offers.LEG_STATE.OFFERED, `state ${legAfter.state}`);
  check("no WITHDRAW escaped into the outbox", withdrawRow === null, "");
  check(
    "the offer stays UNACKNOWLEDGED — outstanding, counted, and retried next pass",
    offerRow.state === outbox.OUTBOX_STATE.UNACKNOWLEDGED && outbox.OUTSTANDING_STATES.includes(offerRow.state),
    `state ${offerRow.state}`,
  );

  // And the retry succeeds, so a transient failure is not a permanent one.
  const retry = await worker.drainOnce(
    {
      prisma,
      deliver: async () => ({ delivered: true }),
      readStoreTime: async () => new Date(pastTtl.getTime() + 1000),
      runInTransaction: (fn) => prisma.$transaction(fn, { timeout: TX_TIMEOUT_MS }),
    },
    { retryWindowSeconds: RETRY_WINDOW_SECONDS, offerTtlSeconds: OFFER_TTL_SECONDS, unresponsiveStrikes: UNRESPONSIVE_STRIKES, systemicThreshold: SYSTEMIC_THRESHOLD, maxDeliveryDelaySeconds: MAX_DELIVERY_DELAY_SECONDS, nackCooloffSeconds: NACK_COOLOFF_SECONDS, signingKey: SIGNING_KEY },
    "w-live-5",
  );
  const commitmentRetried = await prisma.commitment.findUnique({ where: { commitmentId: fixture.commitmentId } });
  check(
    "the next pass performs the withdrawal that failed — retried, never absorbed (§11.3)",
    retry.withdrawn === 1 && commitmentRetried.releasedAt !== null,
    `withdrawn ${retry.withdrawn}`,
  );
}

/* ═══════════════════════════════════════════════════════════════════════════ */

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL must name a DISPOSABLE PostgreSQL instance. Refusing to guess.");
    process.exit(2);
  }
  console.log(`Phase 4 live-database verification against ${process.env.DATABASE_URL.replace(/:[^:@]*@/, ":***@")}`);

  const prisma = new PrismaClient();
  try {
    // Each group starts from a clean slate. Leftovers from an earlier group are other
    // agents' outstanding obligations, and the drain worker is fleet-wide by design —
    // so without this the escalation groups grade themselves on rows they did not set up.
    for (const stage of [
      schemaObjects,
      constraintsBite,
      transactionalInvariant,
      claimRace,
      backoffPacing,
      escalationStepTwo,
      withdrawalAtomicity,
    ]) {
      await reset(prisma);
      await stage(prisma);
    }
  } finally {
    await reset(prisma).catch(() => {});
    await prisma.$disconnect();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${"═".repeat(78)}`);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log("\nFAILED:");
    for (const f of failed) console.log(`  [${f.group}] ${f.label}${f.detail ? ` — ${f.detail}` : ""}`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nHARNESS ERROR:", error);
  process.exit(3);
});

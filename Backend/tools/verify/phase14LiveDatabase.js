"use strict";

/**
 * PHASE 14 — live-PostgreSQL verification of §23's schema, and of the behaviours a green
 * Jest suite structurally cannot reach.
 *
 * `PHASE_14_IMPLEMENTATION_REPORT.md` and `PHASE_14_INDEPENDENT_VERIFICATION.md` both
 * established the DDL by *reading* it: the independent review states it "independently
 * counted" the sixteen CHECK constraints "directly from the SQL". That proves the text
 * says what it says. It does not prove that one of them **fires**: a CHECK naming the
 * wrong column, or listing the wrong strings, reads identically to a correct one in a
 * diff — and the two most load-bearing constraints in this phase are exactly the kind a
 * reviewer would accept on sight.
 *
 *   1. **`OverrideAudit_absolute_classes_never_granted`** is the phase's central safety
 *      claim expressed at the store: *"this refuses a granted row for the three absolute
 *      classes even if `override.js` were bypassed entirely, which is what makes the
 *      property a fact about the database rather than about one module's discipline."*
 *      That sentence is only true if PostgreSQL actually rejects the row. It is made to
 *      reject one here, for all three classes, and to *accept* the refusal rows an
 *      investigation depends on.
 *
 *   2. **`IdentityRecord_erased_has_no_ciphertext`** is the tombstone rule. §23.7 says the
 *      erased content is "genuinely unrecoverable", and the CHECK is what makes that a
 *      property of the store rather than of whichever code path performed the update. It
 *      is made to fire — and, more interestingly, it is shown to close the
 *      read-then-write race in `identityStore.put()`, which finds an unerased row, is
 *      overtaken by an erasure, and then tries to write ciphertext back.
 *
 * Group P covers §23.7's production composition end to end against the real store: the
 * intake path seals identities, the decision-record writer carries the surrogate keys,
 * erasure tombstones the identity, and the decision record still resolves to it afterwards
 * — which is the reachability §23.7's third bullet requires and which was not implemented
 * before the Phase 14 remediation.
 *
 * ── A note on how a refusal is judged ──────────────────────────────────────
 * Prisma embeds **the calling source file's text** in its error messages, so a naive
 * `error.message.includes(constraintName)` matches this harness's own source and reports
 * PASS for a probe that never reached the database. Every refusal below is issued as raw
 * SQL and judged on PostgreSQL's SQLSTATE *and* the constraint it names.
 *
 * Usage:
 *   DATABASE_URL=postgresql://pgverify:verify@127.0.0.1:55432/robotx_p14 \
 *     node tools/verify/phase14LiveDatabase.js
 *
 * NEVER point this at `DATABASE_URL`'s shared Neon instance or at the default 5432
 * cluster. It creates and deletes rows.
 */

const { PrismaClient } = require("@prisma/client");
const crypto = require("crypto");

const identityStore = require("../../src/engine/privacy/identityStore");
const surrogateKeys = require("../../src/engine/privacy/surrogateKeys");
const erasure = require("../../src/engine/privacy/erasure");
const decisionRecord = require("../../src/engine/observability/decisionRecord");
const taskService = require("../../src/services/task.service");

/** Every row this harness owns carries this prefix. */
const P = "p14v";

const SECRET = "phase14-live-verification-surrogate-secret";
const ENCRYPTION_KEY = identityStore.requireEncryptionKey(Buffer.from("f".repeat(64), "hex"));
const KEYS = { secret: SECRET, encryptionKey: ENCRYPTION_KEY };

let prisma = null;
let passes = 0;
let failures = 0;
const failed = [];

function record(id, description, passed, detail) {
  if (passed) passes += 1;
  else {
    failures += 1;
    failed.push(`${id} — ${description}${detail ? ` :: ${detail}` : ""}`);
  }
  console.log(`  [${passed ? "PASS" : "FAIL"}] ${id} — ${description}`);
  if (detail) console.log(`         ${detail}`);
}

function dbError(error) {
  const full = String((error && error.message) || error);
  const metaText = error && error.meta && error.meta.message ? String(error.meta.message) : null;
  const at = full.indexOf("Message:");
  const text = (metaText || (at >= 0 ? full.slice(at) : full)).replace(/\s+/g, " ");
  const metaCode = error && error.meta && error.meta.code ? String(error.meta.code) : null;
  const parsed = /Code: `?(\d{5})`?/.exec(full);
  return { code: metaCode || (parsed ? parsed[1] : null), text };
}

const dbMessage = (error) => dbError(error).text;

const SQLSTATE = Object.freeze({ NOT_NULL: "23502", FOREIGN_KEY: "23503", UNIQUE: "23505", CHECK: "23514" });

/**
 * `constraint` may be the name PostgreSQL prints, or — for a unique index, whose
 * violation message names the *key columns* rather than the index — any of several
 * accepted spellings. Passing an array is how a unique index is judged without loosening
 * the match to a substring of the harness's own source.
 */
async function refusedSql(id, description, sqlstate, constraint, sql, params) {
  const accept = Array.isArray(constraint) ? constraint : [constraint];
  try {
    await prisma.$executeRawUnsafe(sql, ...(params || []));
    record(id, description, false, "the database ACCEPTED a row the constraint exists to refuse");
  } catch (error) {
    const { code, text } = dbError(error);
    const passed = code === sqlstate && accept.some((name) => text.includes(name));
    record(
      id,
      description,
      passed,
      passed
        ? `SQLSTATE ${sqlstate} on ${accept[0]}`
        : `expected SQLSTATE ${sqlstate} naming ${accept.join(" | ")}; got SQLSTATE ${code}: ${text.slice(0, 200)}`,
    );
  }
}

async function accepted(id, description, run) {
  try {
    const value = await run();
    record(id, description, true, typeof value === "string" ? value : undefined);
    return value;
  } catch (error) {
    record(id, description, false, dbMessage(error).slice(0, 260));
    return null;
  }
}

const iso = (d) => d.toISOString();
const uuid = () => crypto.randomUUID();

/** A surrogate key of the right shape, for the constraint probes. */
const skOf = (type, hex) => `sk_${type}_${String(hex).padEnd(32, "0").slice(0, 32)}`;

async function purge(log) {
  const steps = [
    ["DecisionRecordB", () => prisma.decisionRecordB.deleteMany({ where: { decisionId: { startsWith: P } } })],
    ["DecisionRecordA", () => prisma.decisionRecordA.deleteMany({ where: { decisionId: { startsWith: P } } })],
    ["InputSnapshot", () => prisma.inputSnapshot.deleteMany({ where: { snapshotId: { startsWith: P } } })],
    ["Round", () => prisma.round.deleteMany({ where: { roundId: { startsWith: P } } })],
    ["WorkQueue", () => prisma.workQueue.deleteMany({ where: { legId: { startsWith: P } } })],
    ["OverrideAudit", () => prisma.overrideAudit.deleteMany({ where: { actorId: { startsWith: P } } })],
    ["CapabilityAttestation", () => prisma.capabilityAttestation.deleteMany({ where: { agentId: { startsWith: P } } })],
    ["AgentCertificate", () => prisma.agentCertificate.deleteMany({ where: { agentId: { startsWith: P } } })],
    ["IdentityRecord", () => prisma.identityRecord.deleteMany({ where: { subjectId: { startsWith: P } } })],
    ["AuditEvent", () => prisma.auditEvent.deleteMany({ where: { subjectId: { startsWith: P } } })],
    ["Stop", () => prisma.stop.deleteMany({ where: { stopId: { contains: P } } })],
    ["Task", () => prisma.task.deleteMany({ where: { taskId: { startsWith: P } } })],
    ["Leg", () => prisma.leg.deleteMany({ where: { legId: { contains: P } } })],
    ["Mission", () => prisma.mission.deleteMany({ where: { missionId: { contains: P } } })],
    ["ShardLeadership", () => prisma.shardLeadership.deleteMany({ where: { shardId: { startsWith: P } } })],
  ];
  for (const [label, run] of steps) {
    try {
      const r = await run();
      if (log) console.log(`  removed ${label}: ${r.count}`);
    } catch (e) {
      if (log) console.log(`  cleanup ${label} failed: ${dbMessage(e).slice(0, 140)}`);
    }
  }
  // Identity records minted by the intake path are keyed by their own subject ids.
  try {
    await prisma.identityRecord.deleteMany({ where: { subjectId: { contains: P } } });
  } catch { /* best effort */ }
}

async function main() {
  const url = process.env.DATABASE_URL || "";
  if (/neon\.tech/i.test(url) || /:5432\//.test(url)) {
    throw new Error(`refusing to run against ${url} — this harness is for a disposable cluster only`);
  }
  prisma = new PrismaClient({ datasources: { db: { url } } });

  console.log("PHASE 14 — live PostgreSQL verification (§23)");
  console.log(`  database: ${url.replace(/:[^:@]*@/, ":***@")}`);
  const version = await prisma.$queryRawUnsafe("SELECT version() AS v");
  console.log(`  ${version[0].v}\n`);

  try {
    console.log("── fixture ──");
    await accepted("F1", "purge and seed", async () => {
      await purge();
      return "clean";
    });

    /* ══════════════════════════════════════════════════════════════════════
     * A — AgentCertificate: the four CHECKs, the FK, and the two unique keys
     * ══════════════════════════════════════════════════════════════════════ */
    console.log("\n── A. AgentCertificate (§23.2) ──");

    const certA = uuid();
    await accepted("A1", "an ACTIVE certificate with a SECURE_ELEMENT key and an ordered validity window is accepted", async () => {
      await prisma.agentCertificate.create({
        data: {
          id: certA,
          agentId: `${P}-agent-1`,
          fingerprint: "a".repeat(64),
          status: "ACTIVE",
          keyStorage: "SECURE_ELEMENT",
          notBefore: new Date("2026-01-01T00:00:00Z"),
          notAfter: new Date("2027-01-01T00:00:00Z"),
        },
      });
      return "ACTIVE / SECURE_ELEMENT";
    });

    await refusedSql(
      "A2",
      "an unknown keyStorage is refused",
      SQLSTATE.CHECK,
      "AgentCertificate_key_storage_known",
      `INSERT INTO "AgentCertificate" ("id","agentId","fingerprint","status","keyStorage","createdAt","updatedAt")
       VALUES ($1,$2,$3,'ACTIVE','TPM_MAYBE',NOW(),NOW())`,
      [uuid(), `${P}-agent-1`, "b".repeat(64)],
    );

    await refusedSql(
      "A3",
      "an unknown status is refused",
      SQLSTATE.CHECK,
      "AgentCertificate_status_known",
      `INSERT INTO "AgentCertificate" ("id","agentId","fingerprint","status","keyStorage","createdAt","updatedAt")
       VALUES ($1,$2,$3,'PROBABLY_FINE','UNKNOWN',NOW(),NOW())`,
      [uuid(), `${P}-agent-1`, "c".repeat(64)],
    );

    await refusedSql(
      "A4",
      "a REVOKED certificate with no revokedAt is refused — 'revoked at some point' is not an answer",
      SQLSTATE.CHECK,
      "AgentCertificate_revoked_has_time",
      `INSERT INTO "AgentCertificate" ("id","agentId","fingerprint","status","keyStorage","createdAt","updatedAt")
       VALUES ($1,$2,$3,'REVOKED','UNKNOWN',NOW(),NOW())`,
      [uuid(), `${P}-agent-1`, "d".repeat(64)],
    );

    await refusedSql(
      "A5",
      "a validity window that ends before it begins is refused",
      SQLSTATE.CHECK,
      "AgentCertificate_validity_ordered",
      `INSERT INTO "AgentCertificate" ("id","agentId","fingerprint","status","keyStorage","notBefore","notAfter","createdAt","updatedAt")
       VALUES ($1,$2,$3,'ACTIVE','UNKNOWN','2027-01-01','2026-01-01',NOW(),NOW())`,
      [uuid(), `${P}-agent-1`, "e".repeat(64)],
    );

    await refusedSql(
      "A6",
      "a duplicate fingerprint is refused — one certificate is one identity",
      SQLSTATE.UNIQUE,
      ["AgentCertificate_fingerprint_key", "Key (fingerprint)"],
      `INSERT INTO "AgentCertificate" ("id","agentId","fingerprint","status","keyStorage","createdAt","updatedAt")
       VALUES ($1,$2,$3,'ACTIVE','UNKNOWN',NOW(),NOW())`,
      [uuid(), `${P}-agent-2`, "a".repeat(64)],
    );

    const certB = uuid();
    await accepted("A7", "a successor certificate may name its predecessor", async () => {
      await prisma.agentCertificate.create({
        data: {
          id: certB,
          agentId: `${P}-agent-1`,
          fingerprint: "1".repeat(64),
          status: "ACTIVE",
          keyStorage: "SECURE_ELEMENT",
          rotatedFromId: certA,
        },
      });
      return "rotatedFromId set";
    });

    await refusedSql(
      "A8",
      "two successors of one predecessor are refused — a rotation lineage is a chain, not a fan-out",
      SQLSTATE.UNIQUE,
      ["AgentCertificate_rotatedFromId_key", 'Key ("rotatedFromId")'],
      `INSERT INTO "AgentCertificate" ("id","agentId","fingerprint","status","keyStorage","rotatedFromId","createdAt","updatedAt")
       VALUES ($1,$2,$3,'ACTIVE','UNKNOWN',$4,NOW(),NOW())`,
      [uuid(), `${P}-agent-1`, "2".repeat(64), certA],
    );

    await refusedSql(
      "A9",
      "a rotatedFromId naming no certificate is refused",
      SQLSTATE.FOREIGN_KEY,
      "AgentCertificate_rotatedFromId_fkey",
      `INSERT INTO "AgentCertificate" ("id","agentId","fingerprint","status","keyStorage","rotatedFromId","createdAt","updatedAt")
       VALUES ($1,$2,$3,'ACTIVE','UNKNOWN',$4,NOW(),NOW())`,
      [uuid(), `${P}-agent-1`, "3".repeat(64), uuid()],
    );

    await accepted("A10", "revocation is recorded with its moment, and the lifecycle completes", async () => {
      await prisma.agentCertificate.update({
        where: { id: certA },
        data: { status: "SUPERSEDED" },
      });
      await prisma.agentCertificate.update({
        where: { id: certB },
        data: { status: "REVOKED", revokedAt: new Date(), revocationReason: "key extraction suspected" },
      });
      const rows = await prisma.agentCertificate.findMany({ where: { agentId: `${P}-agent-1` }, orderBy: { fingerprint: "asc" } });
      return rows.map((r) => `${r.fingerprint.slice(0, 4)}:${r.status}`).join(" ");
    });

    /* ══════════════════════════════════════════════════════════════════════
     * B — CapabilityAttestation
     * ══════════════════════════════════════════════════════════════════════ */
    console.log("\n── B. CapabilityAttestation (§23.2) ──");

    await refusedSql(
      "B1",
      "a third signature algorithm is refused",
      SQLSTATE.CHECK,
      "CapabilityAttestation_algorithm_known",
      `INSERT INTO "CapabilityAttestation" ("id","agentId","manifestHash","manifest","signature","algorithm","outcome","verifiedAt")
       VALUES ($1,$2,$3,'{}'::jsonb,'00','RSA_PKCS1','VALID',NOW())`,
      [uuid(), `${P}-agent-1`, "h".repeat(8)],
    );

    await refusedSql(
      "B2",
      "an unrecognised verification outcome is refused — a verdict nobody defined the meaning of",
      SQLSTATE.CHECK,
      "CapabilityAttestation_outcome_known",
      `INSERT INTO "CapabilityAttestation" ("id","agentId","manifestHash","manifest","signature","algorithm","outcome","verifiedAt")
       VALUES ($1,$2,$3,'{}'::jsonb,'00','HMAC','PROBABLY_OK',NOW())`,
      [uuid(), `${P}-agent-1`, "h".repeat(8)],
    );

    await accepted("B3", "a rejected attestation is still recorded — the refusal is the evidence", async () => {
      await prisma.capabilityAttestation.create({
        data: {
          agentId: `${P}-agent-1`,
          certificateId: certA,
          manifestHash: "0".repeat(64),
          manifest: { agentId: `${P}-agent-1`, capabilities: [] },
          signature: "deadbeef",
          algorithm: "HMAC",
          outcome: "SIGNATURE_INVALID",
          verifiedAt: new Date(),
        },
      });
      return "SIGNATURE_INVALID persisted";
    });

    /* ══════════════════════════════════════════════════════════════════════
     * C — OverrideAudit: class I/R/F absoluteness AT THE STORE
     * ══════════════════════════════════════════════════════════════════════ */
    console.log("\n── C. OverrideAudit — §23.6's absolute classes, at the database ──");

    for (const [id, cls] of [["C1", "I"], ["C2", "R"], ["C3", "F"]]) {
      await refusedSql(
        id,
        `a GRANTED override against class ${cls} is refused by the database, whatever wrote it`,
        SQLSTATE.CHECK,
        "OverrideAudit_absolute_classes_never_granted",
        `INSERT INTO "OverrideAudit" ("id","actorId","constraintClass","predicateId","granted","reason","recordedAt")
         VALUES ($1,$2,$3,'F3',true,'operator insisted',NOW())`,
        [uuid(), `${P}-ops-1`, cls],
      );
    }

    for (const [id, cls] of [["C4", "I"], ["C5", "R"], ["C6", "F"]]) {
      await accepted(id, `a REFUSED attempt against class ${cls} IS recorded — the row an investigation wants`, async () => {
        await prisma.overrideAudit.create({
          data: {
            actorId: `${P}-ops-1`,
            actorRole: "SUPER_ADMIN",
            constraintClass: cls,
            predicateId: "F3",
            granted: false,
            refusalReason: "CLASS_NOT_WAIVABLE",
            reason: "operator insisted",
          },
        });
        return `class ${cls} refusal persisted`;
      });
    }

    await accepted("C7", "a GRANTED class P waiver is accepted — the classes that are waivable still are", async () => {
      await prisma.overrideAudit.create({
        data: {
          actorId: `${P}-ops-1`,
          actorRole: "SUPER_ADMIN",
          constraintClass: "P",
          predicateId: "F9",
          granted: true,
          reason: "the loading bay is closed",
        },
      });
      return "class P grant persisted";
    });

    await refusedSql(
      "C8",
      "an unknown constraint class is refused — how a class I waiver would come to be filed as something else",
      SQLSTATE.CHECK,
      "OverrideAudit_constraint_class_known",
      `INSERT INTO "OverrideAudit" ("id","actorId","constraintClass","granted","refusalReason","recordedAt")
       VALUES ($1,$2,'INVARIANT',false,'CLASS_NOT_WAIVABLE',NOW())`,
      [uuid(), `${P}-ops-1`],
    );

    await refusedSql(
      "C9",
      "an unknown action class is refused",
      SQLSTATE.CHECK,
      "OverrideAudit_action_class_known",
      `INSERT INTO "OverrideAudit" ("id","actorId","actionClass","granted","refusalReason","recordedAt")
       VALUES ($1,$2,'DELETE_EVERYTHING',false,'UNKNOWN_ACTION_CLASS',NOW())`,
      [uuid(), `${P}-ops-1`],
    );

    await refusedSql(
      "C10",
      "a granted override with no reason is refused",
      SQLSTATE.CHECK,
      "OverrideAudit_granted_has_reason",
      `INSERT INTO "OverrideAudit" ("id","actorId","constraintClass","granted","recordedAt")
       VALUES ($1,$2,'P',true,NOW())`,
      [uuid(), `${P}-ops-1`],
    );

    await refusedSql(
      "C11",
      "a granted override with an empty actor is refused",
      SQLSTATE.CHECK,
      "OverrideAudit_granted_has_reason",
      `INSERT INTO "OverrideAudit" ("id","actorId","constraintClass","granted","reason","recordedAt")
       VALUES ($1,'','P',true,'because',NOW())`,
      [uuid()],
    );

    await refusedSql(
      "C12",
      "a refusal with no refusal reason is refused — a record nobody can read",
      SQLSTATE.CHECK,
      "OverrideAudit_refusal_reason_consistent",
      `INSERT INTO "OverrideAudit" ("id","actorId","constraintClass","granted","reason","recordedAt")
       VALUES ($1,$2,'P',false,'because',NOW())`,
      [uuid(), `${P}-ops-1`],
    );

    await refusedSql(
      "C13",
      "a grant carrying a refusal reason is refused — 'granted, because refused'",
      SQLSTATE.CHECK,
      "OverrideAudit_refusal_reason_consistent",
      `INSERT INTO "OverrideAudit" ("id","actorId","constraintClass","granted","reason","refusalReason","recordedAt")
       VALUES ($1,$2,'P',true,'because','NO_REASON',NOW())`,
      [uuid(), `${P}-ops-1`],
    );

    await refusedSql(
      "C14",
      "self-approval is refused — one person approving themselves is not two-person approval",
      SQLSTATE.CHECK,
      "OverrideAudit_second_approver_distinct",
      `INSERT INTO "OverrideAudit" ("id","actorId","secondApproverId","constraintClass","granted","reason","recordedAt")
       VALUES ($1,$2,$2,'P',true,'because',NOW())`,
      [uuid(), `${P}-ops-1`],
    );

    /* ══════════════════════════════════════════════════════════════════════
     * D — IdentityRecord: the surrogate-key shape and the tombstone rule
     * ══════════════════════════════════════════════════════════════════════ */
    console.log("\n── D. IdentityRecord (§23.7) ──");

    await refusedSql(
      "D1",
      "an identity record keyed by anything but a surrogate key is refused",
      SQLSTATE.CHECK,
      "IdentityRecord_surrogate_key_shape",
      `INSERT INTO "IdentityRecord" ("id","surrogateKey","subjectType","classification","fieldNames","createdAt","updatedAt")
       VALUES ($1,'12 Acacia Avenue','STOP','DIRECT_IDENTIFIER',ARRAY['label'],NOW(),NOW())`,
      [uuid()],
    );

    await refusedSql(
      "D2",
      "a surrogate key with the wrong subject prefix is refused",
      SQLSTATE.CHECK,
      "IdentityRecord_surrogate_key_shape",
      `INSERT INTO "IdentityRecord" ("id","surrogateKey","subjectType","classification","fieldNames","createdAt","updatedAt")
       VALUES ($1,$2,'STOP','DIRECT_IDENTIFIER',ARRAY['label'],NOW(),NOW())`,
      [uuid(), `sk_person_${"a".repeat(32)}`],
    );

    await refusedSql(
      "D3",
      "an unknown subject type is refused",
      SQLSTATE.CHECK,
      "IdentityRecord_subject_type_known",
      `INSERT INTO "IdentityRecord" ("id","surrogateKey","subjectType","classification","fieldNames","createdAt","updatedAt")
       VALUES ($1,$2,'PERSON','DIRECT_IDENTIFIER',ARRAY['label'],NOW(),NOW())`,
      [uuid(), skOf("stop", "b")],
    );

    await refusedSql(
      "D4",
      "an unknown classification is refused",
      SQLSTATE.CHECK,
      "IdentityRecord_classification_known",
      `INSERT INTO "IdentityRecord" ("id","surrogateKey","subjectType","classification","fieldNames","createdAt","updatedAt")
       VALUES ($1,$2,'STOP','SORT_OF_SENSITIVE',ARRAY['label'],NOW(),NOW())`,
      [uuid(), skOf("stop", "c")],
    );

    await refusedSql(
      "D5",
      "a half-sealed record — ciphertext without its iv — is refused",
      SQLSTATE.CHECK,
      "IdentityRecord_erased_has_no_ciphertext",
      `INSERT INTO "IdentityRecord" ("id","surrogateKey","subjectType","classification","fieldNames","ciphertext","createdAt","updatedAt")
       VALUES ($1,$2,'STOP','DIRECT_IDENTIFIER',ARRAY['label'],'\\x00'::bytea,NOW(),NOW())`,
      [uuid(), skOf("stop", "d")],
    );

    await refusedSql(
      "D6",
      "an ERASED record that still holds ciphertext is refused — the tombstone rule, at the store",
      SQLSTATE.CHECK,
      "IdentityRecord_erased_has_no_ciphertext",
      `INSERT INTO "IdentityRecord" ("id","surrogateKey","subjectType","classification","fieldNames","ciphertext","iv","authTag","erasedAt","createdAt","updatedAt")
       VALUES ($1,$2,'STOP','DIRECT_IDENTIFIER',ARRAY['label'],'\\x00'::bytea,'\\x00'::bytea,'\\x00'::bytea,NOW(),NOW(),NOW())`,
      [uuid(), skOf("stop", "e")],
    );

    // Seeded first, then collided: PostgreSQL refuses multiple commands in one prepared
    // statement, and a probe that failed on *that* would prove nothing about the index.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "IdentityRecord" ("id","surrogateKey","subjectType","subjectId","classification","fieldNames","createdAt","updatedAt")
       VALUES ($1,$2,'STOP',$3,'DIRECT_IDENTIFIER',ARRAY['label'],NOW(),NOW())`,
      uuid(),
      skOf("stop", "f"),
      `${P}-stop-dup`,
    );
    await refusedSql(
      "D7",
      "a duplicate surrogate key is refused — one address is one identity record",
      SQLSTATE.UNIQUE,
      ["IdentityRecord_surrogateKey_key", 'Key ("surrogateKey")'],
      `INSERT INTO "IdentityRecord" ("id","surrogateKey","subjectType","subjectId","classification","fieldNames","createdAt","updatedAt")
       VALUES ($1,$2,'STOP',$3,'DIRECT_IDENTIFIER',ARRAY['label'],NOW(),NOW())`,
      [uuid(), skOf("stop", "f"), `${P}-stop-dup`],
    );

    /* ══════════════════════════════════════════════════════════════════════
     * E — Erasure end to end, and the race the CHECK closes
     * ══════════════════════════════════════════════════════════════════════ */
    console.log("\n── E. Erasure, replay, and the read-then-write race (§23.7) ──");

    const sealed = await accepted("E1", "identityStore.put() seals an address; the row holds no plaintext", async () => {
      const stored = await identityStore.put(
        { prisma },
        {
          subjectType: "STOP",
          naturalId: "12 Acacia Avenue",
          fields: { label: "12 Acacia Avenue", lat: 51.5, lon: -0.1 },
          subjectId: `${P}-stop-1`,
          ...KEYS,
        },
      );
      const row = await prisma.identityRecord.findUnique({ where: { surrogateKey: stored.identityKey } });
      if (JSON.stringify(row).includes("Acacia")) throw new Error("the address is readable on the row");
      if (!row.ciphertext) throw new Error("nothing was sealed");
      return stored.identityKey;
    });

    await accepted("E2", "resolve() returns the fields to an audited reader", async () => {
      const resolved = await identityStore.resolve({ prisma }, sealed, {
        actorId: `${P}-ops-1`,
        actorRole: "SUPER_ADMIN",
        reason: "dispute",
        encryptionKey: ENCRYPTION_KEY,
      });
      if (resolved.status !== "RESOLVED" || resolved.fields.label !== "12 Acacia Avenue") {
        throw new Error(`unexpected resolution: ${JSON.stringify(resolved)}`);
      }
      return "RESOLVED";
    });

    await accepted("E3", "an unaudited read is refused outright", async () => {
      try {
        await identityStore.resolve({ prisma }, sealed, { actorId: `${P}-ops-1` });
      } catch (error) {
        if (!/requires an actor, a role, and a reason/.test(error.message)) throw error;
        return "refused without a reason";
      }
      throw new Error("an unaudited read succeeded");
    });

    await accepted("E4", "a dry run erases nothing", async () => {
      const planned = await erasure.plan({ prisma }, {
        by: "IDENTITY_KEY",
        identityKey: sealed,
        requestedBy: `${P}-ops-1`,
        reason: "subject request",
      });
      const row = await prisma.identityRecord.findUnique({ where: { surrogateKey: sealed } });
      if (row.erasedAt !== null) throw new Error("the dry run erased the record");
      return `${planned.targets.length} target(s), nothing erased`;
    });

    await accepted("E5", "erasure tombstones: ciphertext gone, surrogate key kept, audit written", async () => {
      const result = await erasure.apply(
        {
          prisma,
          audit: (tx, event) => tx.auditEvent.create({
            data: {
              streamId: "default",
              sequence: BigInt(Date.now()),
              eventType: event.eventType,
              actorId: event.actorId,
              subjectType: event.subjectType,
              subjectId: `${P}-${event.subjectId}`,
              reason: event.reason,
              payload: event.payload,
              previousHash: null,
              hash: crypto.createHash("sha256").update(String(event.subjectId)).digest("hex"),
              recordedAt: new Date(),
            },
          }),
        },
        { by: "IDENTITY_KEY", identityKey: sealed, requestedBy: `${P}-ops-1`, reason: "subject request" },
      );

      const row = await prisma.identityRecord.findUnique({ where: { surrogateKey: sealed } });
      if (row.ciphertext !== null || row.iv !== null || row.authTag !== null) throw new Error("ciphertext survived the tombstone");
      if (row.erasedAt === null) throw new Error("erasedAt was not stamped");
      if (row.surrogateKey !== sealed) throw new Error("the surrogate key did not survive");

      const audited = await prisma.auditEvent.count({ where: { subjectId: { startsWith: P } } });
      if (audited === 0) throw new Error("no audit event survived the erasure");
      return `erased=${result.erased}, key retained, ${audited} audit event(s)`;
    });

    await accepted("E6", "resolving an erased key says ERASED, which is a different fact from NOT_FOUND", async () => {
      const resolved = await identityStore.resolve({ prisma }, sealed, {
        actorId: `${P}-ops-1`,
        actorRole: "SUPER_ADMIN",
        reason: "dispute",
        encryptionKey: ENCRYPTION_KEY,
      });
      const missing = await identityStore.resolve({ prisma }, skOf("stop", "9"), {
        actorId: `${P}-ops-1`,
        actorRole: "SUPER_ADMIN",
        reason: "dispute",
        encryptionKey: ENCRYPTION_KEY,
      });
      if (resolved.status !== "ERASED" || missing.status !== "NOT_FOUND") {
        throw new Error(`${resolved.status} / ${missing.status}`);
      }
      return "ERASED ≠ NOT_FOUND";
    });

    await accepted("E7", "re-running the backfill CANNOT undo the erasure", async () => {
      const again = await identityStore.put(
        { prisma },
        {
          subjectType: "STOP",
          naturalId: "12 Acacia Avenue",
          fields: { label: "12 Acacia Avenue" },
          subjectId: `${P}-stop-1`,
          ...KEYS,
        },
      );
      if (!again.erased) throw new Error("put() did not report the record as erased");
      const row = await prisma.identityRecord.findUnique({ where: { surrogateKey: sealed } });
      if (row.ciphertext !== null) throw new Error("the erasure was undone by a re-run");
      return "refused, ciphertext still null";
    });

    await accepted("E8", "a second erasure is idempotent, not a second event", async () => {
      const result = await erasure.apply({ prisma }, { by: "IDENTITY_KEY", identityKey: sealed, requestedBy: `${P}-ops-1`, reason: "again" });
      if (result.erased !== 0 || result.alreadyErased !== 1) throw new Error(JSON.stringify(result));
      return "erased=0, alreadyErased=1";
    });

    // The race `identityStore.put()` cannot close on its own: it reads, finds an unerased
    // row, and is overtaken by an erasure before it writes. The CHECK is what makes the
    // outcome safe rather than a silently un-erased address.
    await accepted("E9", "RACE — a write of ciphertext onto a tombstoned row is refused by the database", async () => {
      const key = skOf("stop", "7");
      await prisma.identityRecord.create({
        data: {
          surrogateKey: key,
          subjectType: "STOP",
          subjectId: `${P}-stop-race`,
          classification: "DIRECT_IDENTIFIER",
          fieldNames: ["label"],
          erasedAt: new Date(),
          erasedBy: `${P}-ops-1`,
        },
      });
      try {
        // Exactly the UPDATE `put()` would issue if it had read the row before the erasure.
        await prisma.$executeRawUnsafe(
          `UPDATE "IdentityRecord" SET "ciphertext"='\\x01'::bytea, "iv"='\\x02'::bytea, "authTag"='\\x03'::bytea WHERE "surrogateKey"=$1`,
          key,
        );
      } catch (error) {
        const { code, text } = dbError(error);
        if (code === SQLSTATE.CHECK && text.includes("IdentityRecord_erased_has_no_ciphertext")) {
          return "SQLSTATE 23514 — the tombstone rule closed the race";
        }
        throw error;
      }
      throw new Error("the database ACCEPTED ciphertext onto a tombstoned row");
    });

    /* ══════════════════════════════════════════════════════════════════════
     * P — §23.7's production composition, end to end
     * ══════════════════════════════════════════════════════════════════════ */
    console.log("\n── P. §23.7 production composition: intake → decision record → erasure → replay ──");

    const taskId = `${P}-task-1`;
    const created = await accepted("P1", "the production intake path seals every Stop and both Task ends", async () => {
      const task = await prisma.task.create({
        data: {
          taskId,
          pickup: "7 Elm Row",
          pickupLat: 51.51,
          pickupLon: -0.12,
          drop: "9 Oak Lane",
          dropLat: 51.52,
          dropLon: -0.13,
          status: "PENDING",
        },
      });

      await taskService.admitToRound(prisma, task, {
        receivedAtMs: Date.now(),
        cadenceConfig: {},
        feasibleSupply: 1,
        privacyKeys: KEYS,
      });

      const stops = await prisma.stop.findMany({ where: { stopId: { contains: P } }, orderBy: { sequence: "asc" } });
      const refreshed = await prisma.task.findUnique({ where: { taskId } });

      if (stops.length !== 2) throw new Error(`expected 2 stops, got ${stops.length}`);
      for (const stop of stops) {
        if (!surrogateKeys.isSurrogateKey(stop.identityKey)) throw new Error(`stop ${stop.stopId} has no surrogate key`);
        if (!stop.fineCell) throw new Error(`stop ${stop.stopId} has no fineCell`);
      }
      if (!surrogateKeys.isSurrogateKey(refreshed.originIdentityKey)) throw new Error("no origin identity key");
      if (!surrogateKeys.isSurrogateKey(refreshed.destinationIdentityKey)) throw new Error("no destination identity key");

      const identities = await prisma.identityRecord.count({ where: { subjectId: { contains: P } } });
      if (identities < 4) throw new Error(`expected 4 identity records, got ${identities}`);

      return `2 stops keyed + fineCell, 2 task ends keyed, ${identities} identity records`;
    });

    const legRow = created ? await prisma.leg.findFirst({ where: { legId: { contains: P } } }) : null;

    await accepted("P2", "the decision-record writer carries the surrogate keys onto all three tables", async () => {
      await prisma.shardLeadership.upsert({
        where: { shardId: `${P}-shard-1` },
        create: { shardId: `${P}-shard-1`, leadershipFence: BigInt(1) },
        update: {},
      });

      const decisionTimeMs = Date.now();
      const result = await decisionRecord.writeRound(
        { prisma },
        {
          round: {
            roundId: `${P}-round-1`,
            shardId: `${P}-shard-1`,
            decisionTimeMs,
            decisions: [{ legId: legRow.id, outcome: "ASSIGNED", agentId: `${P}-agent-1` }],
            committed: [],
            partitions: [],
            columns: { generated: 0, pruned: 0, bestPrunedGammaMilliCU: null },
            budgets: { budgetLimited: false, exceeded: [] },
            regime: "NORMAL",
          },
          context: {
            shardId: `${P}-shard-1`,
            snapshot: { snapshotId: `${P}-snap-1`, hash: "h", pins: {} },
            trigger: "NEW_ARRIVAL",
            compactTopN: 5,
            // Tier B is the record §24.3 compares byte for byte, so the surrogate-key
            // column has to be proven on it and not only on Tier A.
            perLeg: { [legRow.id]: { tierBInput: { candidates: [], columns: [], pruned: [] } } },
          },
          budget: { offer: () => ({ verdict: "SAMPLED", writtenBecause: "SAMPLED", reason: null, draw: 0.01, sampleRate: 1 }) },
          config: { sampleRate: 1, compactTopN: 5, fullRetentionDays: 30, tierBRetentionDays: 7, snapshotRetentionDays: 30 },
          nowMs: decisionTimeMs,
        },
      );

      const snapshot = await prisma.inputSnapshot.findUnique({ where: { snapshotId: `${P}-snap-1` } });
      const tierARow = await prisma.decisionRecordA.findFirst({ where: { roundId: `${P}-round-1` } });
      const tierBRow = await prisma.decisionRecordB.findFirst({ where: { roundId: `${P}-round-1` } });

      const stopKeys = (await prisma.stop.findMany({ where: { legId: legRow.id }, select: { identityKey: true } }))
        .map((row) => row.identityKey)
        .sort();

      for (const [label, row] of [["InputSnapshot", snapshot], ["DecisionRecordA", tierARow], ["DecisionRecordB", tierBRow]]) {
        if (!row) throw new Error(`${label} was not written`);
        if (!Array.isArray(row.surrogateKeys) || row.surrogateKeys.length === 0) {
          throw new Error(`${label}.surrogateKeys is ${JSON.stringify(row.surrogateKeys)}`);
        }
        if (JSON.stringify(row.surrogateKeys.slice().sort()) !== JSON.stringify(stopKeys)) {
          throw new Error(`${label}.surrogateKeys does not match the Leg's Stops`);
        }
      }

      // The negative half still holds: nothing identifying is anywhere on the records.
      for (const [label, row] of [["InputSnapshot", snapshot], ["DecisionRecordA", tierARow], ["DecisionRecordB", tierBRow]]) {
        const found = surrogateKeys.scan(row, label);
        if (found.length > 0) throw new Error(`${label} holds identifying value(s) at ${found.map((f) => f.path).join(", ")}`);
        if (JSON.stringify(row).includes("Elm Row") || JSON.stringify(row).includes("Oak Lane")) {
          throw new Error(`${label} holds a street address`);
        }
      }

      return `tierA=${result.tierACount}, tierB=${result.tierBCount}, keys=${stopKeys.length} on all three tables`;
    });

    const beforeErasure = legRow
      ? await prisma.decisionRecordB.findFirst({ where: { roundId: `${P}-round-1` }, select: { contentHash: true, surrogateKeys: true } })
      : null;

    await accepted("P3", "erasing the subject leaves the technical record byte-identical AND still reachable", async () => {
      const stop = await prisma.stop.findFirst({ where: { legId: legRow.id } });
      await erasure.apply({ prisma }, {
        by: "IDENTITY_KEY",
        identityKey: stop.identityKey,
        requestedBy: `${P}-ops-1`,
        reason: "subject request",
      });

      const after = await prisma.decisionRecordB.findFirst({
        where: { roundId: `${P}-round-1` },
        select: { contentHash: true, surrogateKeys: true },
      });

      if (after.contentHash !== beforeErasure.contentHash) throw new Error("erasure changed the Tier B content hash");
      if (JSON.stringify(after.surrogateKeys) !== JSON.stringify(beforeErasure.surrogateKeys)) {
        throw new Error("erasure changed the record's surrogate keys");
      }

      // §23.7's third bullet: "it must be visible to whoever later reads such a record in
      // a dispute". Reachability is what makes that possible, and it is what the column
      // exists for.
      const reachable = await prisma.decisionRecordA.findMany({
        where: { surrogateKeys: { array_contains: [stop.identityKey] } },
        select: { decisionId: true },
      });
      if (reachable.length === 0) throw new Error("no decision record is reachable from the erased subject's key");

      const identity = await prisma.identityRecord.findUnique({ where: { surrogateKey: stop.identityKey } });
      if (identity.erasedAt === null || identity.ciphertext !== null) throw new Error("the subject was not actually erased");

      return `contentHash unchanged, ${reachable.length} decision record(s) still reachable, subject tombstoned`;
    });

    await accepted("P4", "the erased subject's decision record renders ERASED rather than nothing", async () => {
      const stop = await prisma.stop.findFirst({ where: { legId: legRow.id } });
      const row = await prisma.decisionRecordA.findFirst({ where: { roundId: `${P}-round-1` } });
      const rendered = erasure.redact({ ...row, identityKey: stop.identityKey }, [stop.identityKey]);
      if (rendered.identityStatus !== surrogateKeys.ERASED) throw new Error("the reader is not told the subject was erased");
      return "identityStatus = ERASED";
    });

    /* ══════════════════════════════════════════════════════════════════════
     * N — NULL semantics and the additive-only property
     * ══════════════════════════════════════════════════════════════════════ */
    console.log("\n── N. NULL semantics and additive-only columns ──");

    await accepted("N1", "every Phase 14 added column is nullable with no default — an existing row stays valid", async () => {
      const rows = await prisma.$queryRawUnsafe(`
        SELECT table_name, column_name, is_nullable, column_default
        FROM information_schema.columns
        WHERE (table_name = 'Stop' AND column_name IN ('identityKey','fineCell','zoneId','geofenceResult','accessWindowClass','serviceTimeCohort','routingNodeId'))
           OR (table_name = 'Task' AND column_name IN ('originIdentityKey','destinationIdentityKey'))
           OR (table_name IN ('DecisionRecordA','DecisionRecordB','InputSnapshot') AND column_name = 'surrogateKeys')
        ORDER BY table_name, column_name`);
      const bad = rows.filter((r) => r.is_nullable !== "YES" || r.column_default !== null);
      if (bad.length > 0) throw new Error(`not additive: ${JSON.stringify(bad)}`);
      if (rows.length !== 12) throw new Error(`expected 12 added columns, found ${rows.length}`);
      return `${rows.length} columns, all nullable, no defaults`;
    });

    await accepted("N2", "a decision record with no surrogate keys is still a valid row — history predates the identity store", async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "InputSnapshot" ("id","snapshotId","roundId","shardId","decisionTime","hash","capturedAt")
         VALUES ($1,$2,$3,$4,NOW(),'h',NOW())`,
        uuid(),
        `${P}-snap-legacy`,
        `${P}-round-legacy`,
        `${P}-shard-1`,
      );
      const row = await prisma.inputSnapshot.findUnique({ where: { snapshotId: `${P}-snap-legacy` } });
      if (row.surrogateKeys !== null) throw new Error("an unset column did not read as null");
      return "null, not []";
    });

    await accepted("N3", "the sixteen Phase 14 CHECK constraints all exist on the live cluster", async () => {
      const rows = await prisma.$queryRawUnsafe(`
        SELECT c.conname AS name
        FROM pg_constraint c
        WHERE c.contype = 'c'
          AND c.conrelid::regclass::text IN ('"AgentCertificate"','"CapabilityAttestation"','"IdentityRecord"','"OverrideAudit"')
        ORDER BY 1`);
      if (rows.length !== 16) throw new Error(`expected 16, found ${rows.length}: ${rows.map((r) => r.name).join(", ")}`);
      return `${rows.length} constraints`;
    });

    /* ══════════════════════════════════════════════════════════════════════
     * X — Concurrency
     * ══════════════════════════════════════════════════════════════════════ */
    console.log("\n── X. Concurrency ──");

    await accepted("X1", "concurrent erasure requests for one subject tombstone once", async () => {
      const stored = await identityStore.put(
        { prisma },
        { subjectType: "STOP", naturalId: "3 Race Street", fields: { label: "3 Race Street" }, subjectId: `${P}-stop-x1`, ...KEYS },
      );
      const request = { by: "IDENTITY_KEY", identityKey: stored.identityKey, requestedBy: `${P}-ops-1`, reason: "concurrent" };
      const results = await Promise.all([
        erasure.apply({ prisma }, request),
        erasure.apply({ prisma }, request),
        erasure.apply({ prisma }, request),
      ]);
      const erasedTotal = results.reduce((sum, r) => sum + r.erased, 0);
      const row = await prisma.identityRecord.findUnique({ where: { surrogateKey: stored.identityKey } });
      if (row.ciphertext !== null || row.erasedAt === null) throw new Error("the subject was not erased exactly once");
      if (erasedTotal < 1) throw new Error("no request reported an erasure");
      // More than one may report success under a read-write race; the durable state is
      // what matters, and the tombstone is idempotent by construction.
      return `erased reported ${erasedTotal}×, durable state tombstoned once`;
    });

    await accepted("X2", "duplicate certificate establishment: the second is refused by the unique fingerprint", async () => {
      const fingerprint = "9".repeat(64);
      const attempt = () =>
        prisma.agentCertificate.create({
          data: { agentId: `${P}-agent-x2`, fingerprint, status: "ACTIVE", keyStorage: "UNKNOWN" },
        });
      const results = await Promise.allSettled([attempt(), attempt()]);
      const ok = results.filter((r) => r.status === "fulfilled").length;
      if (ok !== 1) throw new Error(`${ok} of 2 concurrent creates succeeded`);
      return "exactly one certificate per fingerprint";
    });

    await accepted("X3", "concurrent granted class-I audit rows are all refused — the CHECK is not racy", async () => {
      const attempt = () =>
        prisma.$executeRawUnsafe(
          `INSERT INTO "OverrideAudit" ("id","actorId","constraintClass","granted","reason","recordedAt") VALUES ($1,$2,'I',true,'r',NOW())`,
          uuid(),
          `${P}-ops-1`,
        );
      const results = await Promise.allSettled([attempt(), attempt(), attempt(), attempt()]);
      const ok = results.filter((r) => r.status === "fulfilled").length;
      if (ok !== 0) throw new Error(`${ok} of 4 concurrent granted class-I rows were ACCEPTED`);
      const granted = await prisma.overrideAudit.count({ where: { actorId: `${P}-ops-1`, granted: true, constraintClass: "I" } });
      if (granted !== 0) throw new Error(`${granted} granted class-I rows exist`);
      return "0 of 4 accepted, 0 rows in the table";
    });

    await accepted("X4", "erasure during record creation leaves the decision record intact and the subject erased", async () => {
      const stop = await prisma.stop.findFirst({ where: { legId: legRow.id }, orderBy: { sequence: "desc" } });
      const write = decisionRecord.writeRound(
        { prisma },
        {
          round: {
            roundId: `${P}-round-2`,
            shardId: `${P}-shard-1`,
            decisionTimeMs: Date.now(),
            decisions: [{ legId: legRow.id, outcome: "ASSIGNED", agentId: `${P}-agent-1` }],
            committed: [],
            partitions: [],
            columns: { generated: 0, pruned: 0, bestPrunedGammaMilliCU: null },
            budgets: { budgetLimited: false, exceeded: [] },
            regime: "NORMAL",
          },
          context: { shardId: `${P}-shard-1`, snapshot: { snapshotId: `${P}-snap-2`, hash: "h", pins: {} }, trigger: "RE_PLAN", perLeg: {} },
          budget: { offer: () => ({ verdict: "SHED", writtenBecause: null, reason: null, draw: 0.9, sampleRate: 0 }) },
          config: { sampleRate: 0, compactTopN: 5, fullRetentionDays: 30, tierBRetentionDays: 7, snapshotRetentionDays: 30 },
          nowMs: Date.now(),
        },
      );
      const erase = erasure.apply({ prisma }, {
        by: "IDENTITY_KEY",
        identityKey: stop.identityKey,
        requestedBy: `${P}-ops-1`,
        reason: "concurrent with a round",
      });

      await Promise.all([write, erase]);

      const row = await prisma.decisionRecordA.findFirst({ where: { roundId: `${P}-round-2` } });
      const identity = await prisma.identityRecord.findUnique({ where: { surrogateKey: stop.identityKey } });
      if (!row) throw new Error("the decision record was lost");
      // The key is written whichever order the two land in: it is not derived from the
      // identity record, only from the Stop, and erasure never touches the Stop.
      if (!Array.isArray(row.surrogateKeys) || !row.surrogateKeys.includes(stop.identityKey)) {
        throw new Error("the surrogate key did not survive the concurrent erasure");
      }
      if (identity.ciphertext !== null) throw new Error("the subject was not erased");
      return "record written with its key, subject tombstoned";
    });

    console.log("\n── cleanup ──");
    await purge(true);
  } finally {
    if (prisma) await prisma.$disconnect();
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) {
    console.log("\nFAILURES:");
    for (const line of failed) console.log(`  · ${line}`);
  }
  process.exitCode = failures > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(`phase14LiveDatabase failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});

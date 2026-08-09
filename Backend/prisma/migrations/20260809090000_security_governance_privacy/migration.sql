-- PHASE 14 — Security, governance, and privacy (§23, and the remaining §22 surface).
--
-- Four new tables and thirteen added columns. **Additive only: no DROP, no ALTER COLUMN,
-- and no existing column changes type, nullability, or default.**
--
-- The additive discipline is load-bearing here in a way it was not in Phase 13, so it is
-- worth stating why the obvious alternative is wrong. §23.7 says decision records and
-- snapshots hold "only surrogate keys and derived non-identifying quantities", and the
-- literal reading is that `Stop.label`, `Stop.lat`, `Stop.lon`, `Task.pickup` and
-- `Task.drop` should be dropped in this migration. They are not, for two reasons the
-- execution plan states itself:
--
--   1. The plan gives Phase 15 the drop — "Drop legacy columns **only after** a full
--      retention window with the new path live" — and the legacy dispatcher, which is
--      still the production path until that cutover, reads every one of them.
--   2. The rule §23.7 makes binding is on the **decision record and snapshot schemas**,
--      and that half lands complete here: `DecisionRecordA`, `DecisionRecordB` and
--      `InputSnapshot` gain `surrogateKeys`, the runtime guard refuses an identifying
--      value in any of the three, and `tools/gates/checkIdentityIsolation.js` proves at
--      build time that no cost term reads an identifying field.
--
-- Every CREATE TABLE, ADD COLUMN, CREATE INDEX and ADD CONSTRAINT ... FOREIGN KEY below
-- is taken verbatim from `prisma migrate diff --from-empty --to-schema-datamodel`, so
-- the hand-written file and `schema.prisma` cannot silently disagree.
-- `tests/engine/securitySchema.test.js` re-runs that diff and asserts the equality, and
-- asserts that the CHECK constraints at the foot of this file — which Prisma cannot
-- express — are absent from Prisma's output, which is what proves they are genuine
-- hand-written additions rather than an echo.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. `AgentCertificate` — §23.2's per-device certificate.
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "AgentCertificate" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "serialNumber" TEXT,
    "subject" TEXT,
    "issuer" TEXT,
    "publicKeyPem" TEXT,
    "notBefore" TIMESTAMP(3),
    "notAfter" TIMESTAMP(3),
    "keyStorage" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "revokedAt" TIMESTAMP(3),
    "revocationReason" TEXT,
    "rotatedFromId" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentCertificate_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. `CapabilityAttestation` — §23.2's signed firmware/hardware manifest.
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "CapabilityAttestation" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "certificateId" TEXT,
    "manifestHash" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "signature" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'HMAC',
    "signerKeyId" TEXT,
    "issuedAt" TIMESTAMP(3),
    "notAfter" TIMESTAMP(3),
    "outcome" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CapabilityAttestation_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. `IdentityRecord` — §23.7's separate, access-controlled identity store.
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "IdentityRecord" (
    "id" TEXT NOT NULL,
    "surrogateKey" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT,
    "classification" TEXT NOT NULL,
    "fieldNames" TEXT[],
    "ciphertext" TEXT,
    "iv" TEXT,
    "authTag" TEXT,
    "erasedAt" TIMESTAMP(3),
    "erasedBy" TEXT,
    "erasureReason" TEXT,
    "retainUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdentityRecord_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. `OverrideAudit` — §23.6's queryable override record.
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "OverrideAudit" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorRole" TEXT,
    "actionClass" TEXT,
    "predicateId" TEXT,
    "constraintClass" TEXT,
    "subjectType" TEXT,
    "subjectId" TEXT,
    "decisionId" TEXT,
    "reason" TEXT,
    "secondApproverId" TEXT,
    "granted" BOOLEAN NOT NULL,
    "refusalReason" TEXT,
    "auditEventHash" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OverrideAudit_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Surrogate-key and derived-quantity columns (§23.7).
--
-- Every column is nullable with no default, so every existing row remains valid and no
-- legacy write path acquires a new requirement — the same treatment Phase 2 and Phase 5
-- gave their additive columns. The backfill (`tools/migrate/backfillIdentities.js`)
-- populates them and is re-runnable.
-- ─────────────────────────────────────────────────────────────────────────────

-- One `ALTER TABLE` per column, rather than the multi-column form Prisma's diff emits.
-- This matches the style Phase 11 used for its own additive columns, and it is what the
-- tree's schema tests read: `domainSchema.test.js` subtracts later-added columns from its
-- generated-SQL comparison by matching `ALTER TABLE "<t>" ADD COLUMN "<c>"`, which sees
-- only the *first* column of a multi-column statement. Writing seven statements instead
-- of one keeps that subtraction honest; writing one would have silently re-broken a
-- comparison three phases old. The DDL is otherwise identical.

-- AlterTable
ALTER TABLE "Stop" ADD COLUMN     "identityKey" TEXT;
ALTER TABLE "Stop" ADD COLUMN     "fineCell" TEXT;
ALTER TABLE "Stop" ADD COLUMN     "zoneId" TEXT;
ALTER TABLE "Stop" ADD COLUMN     "geofenceResult" TEXT;
ALTER TABLE "Stop" ADD COLUMN     "accessWindowClass" TEXT;
ALTER TABLE "Stop" ADD COLUMN     "serviceTimeCohort" TEXT;
ALTER TABLE "Stop" ADD COLUMN     "routingNodeId" TEXT;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "originIdentityKey" TEXT;
ALTER TABLE "Task" ADD COLUMN     "destinationIdentityKey" TEXT;

-- AlterTable
ALTER TABLE "DecisionRecordA" ADD COLUMN     "surrogateKeys" JSONB;

-- AlterTable
ALTER TABLE "DecisionRecordB" ADD COLUMN     "surrogateKeys" JSONB;

-- AlterTable
ALTER TABLE "InputSnapshot" ADD COLUMN     "surrogateKeys" JSONB;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Indexes.
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateIndex
CREATE UNIQUE INDEX "AgentCertificate_fingerprint_key" ON "AgentCertificate"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "AgentCertificate_rotatedFromId_key" ON "AgentCertificate"("rotatedFromId");

-- CreateIndex
CREATE INDEX "AgentCertificate_agentId_status_idx" ON "AgentCertificate"("agentId", "status");

-- CreateIndex
CREATE INDEX "AgentCertificate_status_notAfter_idx" ON "AgentCertificate"("status", "notAfter");

-- CreateIndex
CREATE INDEX "CapabilityAttestation_agentId_verifiedAt_idx" ON "CapabilityAttestation"("agentId", "verifiedAt");

-- CreateIndex
CREATE INDEX "CapabilityAttestation_manifestHash_idx" ON "CapabilityAttestation"("manifestHash");

-- CreateIndex
CREATE INDEX "CapabilityAttestation_outcome_idx" ON "CapabilityAttestation"("outcome");

-- CreateIndex
CREATE UNIQUE INDEX "IdentityRecord_surrogateKey_key" ON "IdentityRecord"("surrogateKey");

-- CreateIndex
CREATE INDEX "IdentityRecord_subjectType_subjectId_idx" ON "IdentityRecord"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "IdentityRecord_erasedAt_idx" ON "IdentityRecord"("erasedAt");

-- CreateIndex
CREATE INDEX "IdentityRecord_retainUntil_idx" ON "IdentityRecord"("retainUntil");

-- CreateIndex
CREATE INDEX "OverrideAudit_actorId_recordedAt_idx" ON "OverrideAudit"("actorId", "recordedAt");

-- CreateIndex
CREATE INDEX "OverrideAudit_predicateId_recordedAt_idx" ON "OverrideAudit"("predicateId", "recordedAt");

-- CreateIndex
CREATE INDEX "OverrideAudit_actionClass_recordedAt_idx" ON "OverrideAudit"("actionClass", "recordedAt");

-- CreateIndex
CREATE INDEX "OverrideAudit_granted_recordedAt_idx" ON "OverrideAudit"("granted", "recordedAt");

-- CreateIndex
CREATE INDEX "Stop_identityKey_idx" ON "Stop"("identityKey");

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Foreign keys.
-- ─────────────────────────────────────────────────────────────────────────────

-- AddForeignKey
ALTER TABLE "AgentCertificate" ADD CONSTRAINT "AgentCertificate_rotatedFromId_fkey" FOREIGN KEY ("rotatedFromId") REFERENCES "AgentCertificate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapabilityAttestation" ADD CONSTRAINT "CapabilityAttestation_certificateId_fkey" FOREIGN KEY ("certificateId") REFERENCES "AgentCertificate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═════════════════════════════════════════════════════════════════════════════
-- 8. CHECK constraints — the rules Prisma cannot express.
--
-- Every one of these is a §23 sentence made a property of the database rather than of
-- every writer's diligence. The same discipline every phase since 3 has followed: where
-- a rule can be enforced at the store, enforcing it only in application code leaves the
-- rule true for exactly as long as one code path remembers it.
-- ═════════════════════════════════════════════════════════════════════════════

-- §23.2 — key storage is one of the three classes the module enumerates. UNKNOWN is a
-- value, not an absence: a device that has not reported its key storage is not the same
-- as one that reported software storage, and collapsing the two would over-report a
-- security posture nobody measured.
ALTER TABLE "AgentCertificate"
  ADD CONSTRAINT "AgentCertificate_key_storage_known"
  CHECK ("keyStorage" IN ('SECURE_ELEMENT', 'SOFTWARE', 'UNKNOWN'));

-- §23.2 — the certificate lifecycle.
ALTER TABLE "AgentCertificate"
  ADD CONSTRAINT "AgentCertificate_status_known"
  CHECK ("status" IN ('ACTIVE', 'SUPERSEDED', 'REVOKED'));

-- A revoked certificate carries the moment it was revoked. Revocation is the event a
-- dispute turns on, and "revoked at some point" is not an answer; without the timestamp
-- the periodic re-check cannot say whether a session established at 14:05 was
-- established before or after the withdrawal.
ALTER TABLE "AgentCertificate"
  ADD CONSTRAINT "AgentCertificate_revoked_has_time"
  CHECK ("status" <> 'REVOKED' OR "revokedAt" IS NOT NULL);

-- A validity window that ends before it begins is not a window. Left as a CHECK rather
-- than trusted to the issuer, because the issuer is an external CA.
ALTER TABLE "AgentCertificate"
  ADD CONSTRAINT "AgentCertificate_validity_ordered"
  CHECK ("notBefore" IS NULL OR "notAfter" IS NULL OR "notBefore" < "notAfter");

-- §23.3 — the two signature schemes, and no third.
ALTER TABLE "CapabilityAttestation"
  ADD CONSTRAINT "CapabilityAttestation_algorithm_known"
  CHECK ("algorithm" IN ('HMAC', 'ED25519'));

-- §23.2 — the verification outcomes. A table that accepted an unrecognised outcome would
-- accept a verdict nobody defined the meaning of, which is the one thing an attestation
-- record may not do.
ALTER TABLE "CapabilityAttestation"
  ADD CONSTRAINT "CapabilityAttestation_outcome_known"
  CHECK ("outcome" IN ('VALID', 'SIGNATURE_INVALID', 'EXPIRED', 'MALFORMED', 'UNKNOWN_SIGNER', 'AGENT_MISMATCH'));

-- §23.7 — the subject types a surrogate key may stand for.
ALTER TABLE "IdentityRecord"
  ADD CONSTRAINT "IdentityRecord_subject_type_known"
  CHECK ("subjectType" IN ('TASK', 'STOP', 'PAYLOAD'));

-- §23.7's field-level classification.
ALTER TABLE "IdentityRecord"
  ADD CONSTRAINT "IdentityRecord_classification_known"
  CHECK ("classification" IN ('DIRECT_IDENTIFIER', 'LOCATION_IDENTIFIER', 'PAYLOAD_DESCRIPTOR'));

-- The surrogate key's shape, enforced at the store. An identity record keyed by anything
-- other than a surrogate key is an identity record keyed by an identifier, which is the
-- one thing §23.7's construction exists to prevent — and a typo in a caller would
-- otherwise produce it silently.
ALTER TABLE "IdentityRecord"
  ADD CONSTRAINT "IdentityRecord_surrogate_key_shape"
  CHECK ("surrogateKey" ~ '^sk_(task|stop|payload)_[0-9a-f]{32}$');

-- **The tombstone rule.** An erased record holds no ciphertext, and an unerased record
-- holds either all three sealed components or none of them. This is the erasure
-- guarantee expressed at the store: "the erased content is genuinely unrecoverable"
-- (§23.7) cannot be left to whichever code path performed the update.
ALTER TABLE "IdentityRecord"
  ADD CONSTRAINT "IdentityRecord_erased_has_no_ciphertext"
  CHECK (
    ("erasedAt" IS NULL AND (("ciphertext" IS NULL AND "iv" IS NULL AND "authTag" IS NULL)
                             OR ("ciphertext" IS NOT NULL AND "iv" IS NOT NULL AND "authTag" IS NOT NULL)))
    OR ("erasedAt" IS NOT NULL AND "ciphertext" IS NULL AND "iv" IS NULL AND "authTag" IS NULL)
  );

-- §7.2's five constraint classes, so an override cannot be recorded against a class
-- nobody defined — which is how a class I waiver would come to be filed as something
-- else.
ALTER TABLE "OverrideAudit"
  ADD CONSTRAINT "OverrideAudit_constraint_class_known"
  CHECK ("constraintClass" IS NULL OR "constraintClass" IN ('I', 'R', 'C', 'P', 'F'));

-- §23.4's four high-privilege action classes.
ALTER TABLE "OverrideAudit"
  ADD CONSTRAINT "OverrideAudit_action_class_known"
  CHECK ("actionClass" IS NULL OR "actionClass" IN (
    'QUARANTINE_OVERRIDE', 'SAFETY_CONFIG_CHANGE', 'BULK_CANCELLATION', 'MANUAL_ASSIGNMENT_AGAINST_POLICY'));

-- **The absolute rule, at the store.** No granted override against a class I, R or F
-- predicate may be recorded at all. §23.6: "Class I, R, and F constraints are never
-- waivable". `override.js` refuses before it looks at the actor; this refuses even if
-- that module is bypassed, which is what makes the rule a property of the system rather
-- than of one module. A refusal row (`granted = false`) against those classes is
-- explicitly permitted, and is exactly the row an investigation wants.
ALTER TABLE "OverrideAudit"
  ADD CONSTRAINT "OverrideAudit_absolute_classes_never_granted"
  CHECK (NOT ("granted" AND "constraintClass" IN ('I', 'R', 'F')));

-- §23.6 — "Every override is audited": a granted override records identity and reason.
ALTER TABLE "OverrideAudit"
  ADD CONSTRAINT "OverrideAudit_granted_has_reason"
  CHECK (NOT "granted" OR ("reason" IS NOT NULL AND "actorId" <> ''));

-- §23.6 — a refusal states why it was refused, and a grant does not carry a refusal
-- reason. Both directions, because a record that could say "granted, because refused"
-- is a record nobody can read.
ALTER TABLE "OverrideAudit"
  ADD CONSTRAINT "OverrideAudit_refusal_reason_consistent"
  CHECK (("granted" AND "refusalReason" IS NULL) OR (NOT "granted" AND "refusalReason" IS NOT NULL));

-- §23.6 — a second approver is a *distinct* identity. One person approving themselves is
-- not two-person approval, and the constraint says so at the store for the same reason
-- §22.3's two-person rule is checked at publish rather than trusted to a UI.
ALTER TABLE "OverrideAudit"
  ADD CONSTRAINT "OverrideAudit_second_approver_distinct"
  CHECK ("secondApproverId" IS NULL OR "secondApproverId" <> "actorId");

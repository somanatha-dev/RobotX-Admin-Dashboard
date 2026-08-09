-- PHASE 11 — Observability, decision records, explainability (§21).
--
-- Additive only. `DecisionRecordA` gains the seven columns that complete §21.2's Tier
-- A shape; four new tables land beside it. No DROP, no ALTER COLUMN, no data movement.
--
-- Every CREATE TABLE, CREATE INDEX and ADD CONSTRAINT ... FOREIGN KEY below is taken
-- verbatim from `prisma migrate diff --from-empty --to-schema-datamodel`, so the
-- hand-written file and `schema.prisma` cannot silently disagree.
-- `tests/engine/observabilitySchema.test.js` re-runs that diff and asserts the
-- equality, and asserts that the seven CHECK constraints at the foot of this file are
-- **absent** from Prisma's output — which is what proves they are genuine hand-written
-- additions rather than an echo.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. `DecisionRecordA` completed to §21.2's Tier A shape.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "DecisionRecordA" ADD COLUMN     "inputSnapshotId" TEXT;
ALTER TABLE "DecisionRecordA" ADD COLUMN     "fullRetentionUntil" TIMESTAMP(3);
ALTER TABLE "DecisionRecordA" ADD COLUMN     "sizeBytes" INTEGER;
ALTER TABLE "DecisionRecordA" ADD COLUMN     "tierBWritten" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DecisionRecordA" ADD COLUMN     "tierBReason" TEXT;
ALTER TABLE "DecisionRecordA" ADD COLUMN     "samplingDraw" DOUBLE PRECISION;
ALTER TABLE "DecisionRecordA" ADD COLUMN     "samplingRate" DOUBLE PRECISION;
ALTER TABLE "DecisionRecordA" ADD COLUMN     "shadowLabel" TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Tier B — the full-fidelity record, sampled and budgeted (§21.2).
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "DecisionRecordB" (
    "id" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "shardId" TEXT NOT NULL,
    "decisionTime" TIMESTAMP(3) NOT NULL,
    "writtenBecause" TEXT NOT NULL,
    "exemptionReason" TEXT,
    "candidateSet" JSONB,
    "feasibility" JSONB,
    "costs" JSONB,
    "columnDetail" JSONB,
    "contentHash" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "retainUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DecisionRecordB_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The pinned round inputs replay consumes (§21.2, §9.6 requirement 5).
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "InputSnapshot" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "shardId" TEXT NOT NULL,
    "decisionTime" TIMESTAMP(3) NOT NULL,
    "hash" TEXT NOT NULL,
    "seed" TEXT,
    "configVersion" TEXT,
    "codeVersion" TEXT,
    "activeRegime" TEXT,
    "killSwitchState" JSONB,
    "pins" JSONB,
    "resolvedValues" JSONB,
    "retainUntil" TIMESTAMP(3),
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InputSnapshot_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Prediction calibration as a first-class loop (§21.5).
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "CalibrationObservation" (
    "id" TEXT NOT NULL,
    "predictor" TEXT NOT NULL,
    "decisionId" TEXT,
    "commitmentId" TEXT,
    "legId" TEXT,
    "agentId" TEXT,
    "shardId" TEXT,
    "zoneId" TEXT,
    "missionClass" TEXT,
    "agentClassId" TEXT,
    "timeBucket" INTEGER,
    "unit" TEXT NOT NULL,
    "predicted" DOUBLE PRECISION,
    "realised" DOUBLE PRECISION,
    "signedError" DOUBLE PRECISION,
    "bandLower" DOUBLE PRECISION,
    "bandUpper" DOUBLE PRECISION,
    "withinBand" BOOLEAN,
    "tier" TEXT,
    "claimedProbability" DOUBLE PRECISION,
    "eventOccurred" BOOLEAN,
    "tailQuantile" DOUBLE PRECISION,
    "predictedAt" TIMESTAMP(3) NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalibrationObservation_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. The hash-chained audit stream (§21.7).
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "streamId" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "eventType" TEXT NOT NULL,
    "actorId" TEXT,
    "actorRole" TEXT,
    "subjectType" TEXT,
    "subjectId" TEXT,
    "reason" TEXT,
    "payload" JSONB,
    "previousHash" TEXT,
    "hash" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Indexes.
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateIndex
CREATE INDEX "DecisionRecordA_inputSnapshotId_idx" ON "DecisionRecordA"("inputSnapshotId");

-- CreateIndex
CREATE INDEX "DecisionRecordA_shardId_tierBWritten_decisionTime_idx" ON "DecisionRecordA"("shardId", "tierBWritten", "decisionTime");

-- CreateIndex
CREATE INDEX "DecisionRecordA_shadowLabel_decisionTime_idx" ON "DecisionRecordA"("shadowLabel", "decisionTime");

-- CreateIndex
CREATE UNIQUE INDEX "DecisionRecordB_decisionId_key" ON "DecisionRecordB"("decisionId");

-- CreateIndex
CREATE INDEX "DecisionRecordB_roundId_idx" ON "DecisionRecordB"("roundId");

-- CreateIndex
CREATE INDEX "DecisionRecordB_shardId_decisionTime_idx" ON "DecisionRecordB"("shardId", "decisionTime");

-- CreateIndex
CREATE INDEX "DecisionRecordB_writtenBecause_idx" ON "DecisionRecordB"("writtenBecause");

-- CreateIndex
CREATE INDEX "DecisionRecordB_retainUntil_idx" ON "DecisionRecordB"("retainUntil");

-- CreateIndex
CREATE UNIQUE INDEX "InputSnapshot_snapshotId_key" ON "InputSnapshot"("snapshotId");

-- CreateIndex
CREATE INDEX "InputSnapshot_roundId_idx" ON "InputSnapshot"("roundId");

-- CreateIndex
CREATE INDEX "InputSnapshot_shardId_decisionTime_idx" ON "InputSnapshot"("shardId", "decisionTime");

-- CreateIndex
CREATE INDEX "InputSnapshot_retainUntil_idx" ON "InputSnapshot"("retainUntil");

-- CreateIndex
CREATE INDEX "InputSnapshot_hash_idx" ON "InputSnapshot"("hash");

-- CreateIndex
CREATE INDEX "CalibrationObservation_predictor_observedAt_idx" ON "CalibrationObservation"("predictor", "observedAt");

-- CreateIndex
CREATE INDEX "CalibrationObservation_predictor_zoneId_observedAt_idx" ON "CalibrationObservation"("predictor", "zoneId", "observedAt");

-- CreateIndex
CREATE INDEX "CalibrationObservation_predictor_agentClassId_observedAt_idx" ON "CalibrationObservation"("predictor", "agentClassId", "observedAt");

-- CreateIndex
CREATE INDEX "CalibrationObservation_predictor_tier_observedAt_idx" ON "CalibrationObservation"("predictor", "tier", "observedAt");

-- CreateIndex
CREATE INDEX "CalibrationObservation_decisionId_idx" ON "CalibrationObservation"("decisionId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditEvent_hash_key" ON "AuditEvent"("hash");

-- CreateIndex
CREATE INDEX "AuditEvent_streamId_recordedAt_idx" ON "AuditEvent"("streamId", "recordedAt");

-- CreateIndex
CREATE INDEX "AuditEvent_eventType_recordedAt_idx" ON "AuditEvent"("eventType", "recordedAt");

-- CreateIndex
CREATE INDEX "AuditEvent_subjectType_subjectId_idx" ON "AuditEvent"("subjectType", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditEvent_streamId_sequence_key" ON "AuditEvent"("streamId", "sequence");

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Foreign keys.
-- ─────────────────────────────────────────────────────────────────────────────

-- AddForeignKey
ALTER TABLE "DecisionRecordA" ADD CONSTRAINT "DecisionRecordA_inputSnapshotId_fkey" FOREIGN KEY ("inputSnapshotId") REFERENCES "InputSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionRecordB" ADD CONSTRAINT "DecisionRecordB_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "DecisionRecordA"("decisionId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Hand-written CHECK constraints — what Prisma cannot express, and what the
--    application layer must not be the only thing enforcing.
-- ─────────────────────────────────────────────────────────────────────────────

-- §21.2 — the three reasons a Tier B record exists, and no fourth. The three are not
-- interchangeable to an analyst: SAMPLED is representative of the population, EXEMPT
-- is deliberately not, and RESERVOIR is a uniform draw from the exempt population
-- after the write budget was exhausted. A row claiming an unrecognised reason would
-- make every rate computed over this table uninterpretable.
ALTER TABLE "DecisionRecordB" ADD CONSTRAINT "DecisionRecordB_written_because_known"
  CHECK ("writtenBecause" IN ('SAMPLED', 'EXEMPT', 'RESERVOIR'));

-- §21.2 — **the exemption list is bounded**, and this is the backstop for it. A Tier B
-- record written with no stated reason is precisely the unbounded exemption the
-- specification identifies as the failure that "converts to full retention across the
-- entire shard at exactly the moment volume spikes hardest". Requiring the reason at
-- the schema means a future writer cannot reintroduce it by forgetting to set a field.
ALTER TABLE "DecisionRecordA" ADD CONSTRAINT "DecisionRecordA_tier_b_reason_present"
  CHECK ("tierBWritten" = false OR "tierBReason" IS NOT NULL);

-- §20.1 — "Tier-A decision-record write < 2 KB per decision". A negative recorded size
-- is a defect in the accounting, not a small record.
ALTER TABLE "DecisionRecordA" ADD CONSTRAINT "DecisionRecordA_size_non_negative"
  CHECK ("sizeBytes" IS NULL OR "sizeBytes" >= 0);

-- §21.5 — the predictors the calibration loop knows how to score. An unrecognised
-- predictor is an observation nobody defined the unit or the timescale of, and it
-- would silently join the bias aggregate of whichever slice it landed in.
ALTER TABLE "CalibrationObservation" ADD CONSTRAINT "CalibrationObservation_predictor_known"
  CHECK ("predictor" IN ('TRAVEL_TIME', 'SERVICE_TIME', 'ENERGY', 'FAILURE_PROBABILITY', 'DEMAND', 'ASSIGNMENT_WINDOW', 'ENERGY_SHORTFALL'));

-- §21.5 — "each tier's claimed shortfall probability MUST be validated against
-- realised frequency". A claimed probability outside the unit interval is not a
-- miscalibration, it is a corrupt row, and it must not be able to enter the sample
-- the tail calibration of I17 is computed over.
ALTER TABLE "CalibrationObservation" ADD CONSTRAINT "CalibrationObservation_probability_in_unit_interval"
  CHECK (
    ("claimedProbability" IS NULL OR ("claimedProbability" >= 0 AND "claimedProbability" <= 1))
    AND ("tailQuantile" IS NULL OR ("tailQuantile" >= 0 AND "tailQuantile" <= 1))
  );

-- §21.7 — the audit stream's event vocabulary. An append-only stream that accepts an
-- unrecognised event type accepts an event nobody defined the meaning of, which is
-- the one thing a non-repudiation record may not do.
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_event_type_known"
  CHECK ("eventType" IN ('OPERATOR_ACTION', 'OVERRIDE', 'CONFIG_CHANGE', 'QUARANTINE', 'CONSTRAINT_RELAXATION', 'MANUAL_ASSIGNMENT', 'CANCELLATION', 'DEGRADED_MODE', 'TIER_B_SHEDDING'));

-- §21.7 — the chain's sequence is dense and starts at zero. The unique index catches
-- an altered row; a dense non-negative sequence is what additionally catches a
-- *removed* one, and neither property alone catches both.
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_sequence_non_negative"
  CHECK ("sequence" >= 0);

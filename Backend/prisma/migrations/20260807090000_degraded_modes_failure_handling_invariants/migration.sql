-- PHASE 12 — Failure handling, degraded modes, invariants (§18, §26).
--
-- Additive only. Three new tables; no existing table gains or loses a column, and
-- `Leg.externalEscalations` is a back-relation, which adds no column to `Leg`.
-- No DROP, no ALTER COLUMN, no data movement.
--
-- Every CREATE TABLE, CREATE INDEX and ADD CONSTRAINT ... FOREIGN KEY below is taken
-- verbatim from `prisma migrate diff --from-empty --to-schema-datamodel`, so the
-- hand-written file and `schema.prisma` cannot silently disagree.
-- `tests/engine/degradedSchema.test.js` re-runs that diff and asserts the equality, and
-- asserts that the eight CHECK constraints at the foot of this file — and the partial
-- unique index, which Prisma also cannot express — are **absent** from Prisma's output,
-- which is what proves they are genuine hand-written additions rather than an echo.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. `DegradedModeEvent` — §18.5 rule 1's entry and exit events.
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "DegradedModeEvent" (
    "id" TEXT NOT NULL,
    "shardId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "cause" TEXT NOT NULL,
    "enteringComponent" TEXT NOT NULL,
    "suspendedInvariants" TEXT[],
    "degradedInvariants" TEXT[],
    "enteredAt" TIMESTAMP(3) NOT NULL,
    "timeBoxExpiresAt" TIMESTAMP(3),
    "exitCriterion" TEXT,
    "envelope" JSONB,
    "detail" JSONB,
    "exitedAt" TIMESTAMP(3),
    "exitReason" TEXT,
    "exitingComponent" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DegradedModeEvent_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. `InvariantStatus` — §26.1's three statuses, plus I6's own high-water marks.
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "InvariantStatus" (
    "id" TEXT NOT NULL,
    "invariantId" TEXT NOT NULL,
    "shardId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL DEFAULT 'SHARD',
    "subjectId" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "violationCount" INTEGER NOT NULL DEFAULT 0,
    "authorisingMode" TEXT,
    "instrument" TEXT,
    "detail" JSONB,
    "highWaterMark" BIGINT,
    "secondaryHighWaterMark" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvariantStatus_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. `ExternalEscalation` — §18.6's five-step chain, one row per step attempt.
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "ExternalEscalation" (
    "id" TEXT NOT NULL,
    "legId" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "obstructionClass" "ObstructionClass",
    "hazardState" TEXT,
    "contactSet" JSONB,
    "disposition" TEXT NOT NULL,
    "operatorId" TEXT,
    "operatorRole" TEXT,
    "detail" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clearedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalEscalation_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Indexes and the foreign key, as Prisma generates them.
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateIndex
CREATE INDEX "DegradedModeEvent_shardId_enteredAt_idx" ON "DegradedModeEvent"("shardId", "enteredAt");

-- CreateIndex
CREATE INDEX "DegradedModeEvent_shardId_exitedAt_idx" ON "DegradedModeEvent"("shardId", "exitedAt");

-- CreateIndex
CREATE INDEX "DegradedModeEvent_mode_idx" ON "DegradedModeEvent"("mode");

-- CreateIndex
CREATE INDEX "InvariantStatus_shardId_status_idx" ON "InvariantStatus"("shardId", "status");

-- CreateIndex
CREATE INDEX "InvariantStatus_status_checkedAt_idx" ON "InvariantStatus"("status", "checkedAt");

-- CreateIndex
CREATE INDEX "InvariantStatus_invariantId_checkedAt_idx" ON "InvariantStatus"("invariantId", "checkedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InvariantStatus_invariantId_shardId_subjectId_key" ON "InvariantStatus"("invariantId", "shardId", "subjectId");

-- CreateIndex
CREATE INDEX "ExternalEscalation_legId_occurredAt_idx" ON "ExternalEscalation"("legId", "occurredAt");

-- CreateIndex
CREATE INDEX "ExternalEscalation_step_idx" ON "ExternalEscalation"("step");

-- CreateIndex
CREATE INDEX "ExternalEscalation_clearedAt_idx" ON "ExternalEscalation"("clearedAt");

-- AddForeignKey
ALTER TABLE "ExternalEscalation" ADD CONSTRAINT "ExternalEscalation_legId_fkey" FOREIGN KEY ("legId") REFERENCES "Leg"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═════════════════════════════════════════════════════════════════════════════
-- HAND-WRITTEN CONSTRAINTS PRISMA CANNOT EXPRESS
--
-- The same treatment Phases 1–11 gave their CHECKs, triggers, and partial indexes:
-- they live here because the ORM has no syntax for them, and their absence from
-- `prisma migrate diff`'s output is asserted by this phase's schema test — which is
-- what distinguishes a genuine hand-written addition from an echo of the generated
-- file.
-- ═════════════════════════════════════════════════════════════════════════════

-- §18.5 — the mode vocabulary is closed at six. "A degraded mode is a **named**,
-- entered, exited, and recorded state of a shard, not an emergent condition"; a
-- seventh mode written by any path would be exactly the emergent condition the
-- section rejects, and it would have no row in the §26.2 matrix, so the Invariant
-- Checker could not say what it means for any invariant.
ALTER TABLE "DegradedModeEvent" ADD CONSTRAINT "DegradedModeEvent_mode_known"
  CHECK ("mode" IN ('RESTRICTED_OPERATION', 'CUSTODIAL_OPERATION', 'UNSUPERVISED_COMMITMENT', 'DEGRADED_ROUTING', 'COLD_INDEX', 'SHED_LOAD'));

-- §18.5 rule 1 — entry and exit are events. An exit with no stated reason is an exit
-- nobody can audit, and §18.5 gives every mode an explicit exit criterion; a row that
-- carried an exit time without the evidence it was taken on would let a mode be closed
-- because it was inconvenient rather than because its criterion was met.
ALTER TABLE "DegradedModeEvent" ADD CONSTRAINT "DegradedModeEvent_exit_is_evidenced"
  CHECK ("exitedAt" IS NULL OR ("exitReason" IS NOT NULL AND "exitingComponent" IS NOT NULL));

-- Entry idempotence, as a partial unique index rather than as application logic. A
-- shard already in Custodial Operation that observes a second Commitment Store failure
-- has not entered a second mode; it is still in the first. Two open rows for one mode
-- would double-count "time spent in each mode" — an SLI (§18.5 rule 1) — and would
-- leave an exit closing an arbitrary one of them.
CREATE UNIQUE INDEX "DegradedModeEvent_one_open_per_shard_mode"
  ON "DegradedModeEvent"("shardId", "mode") WHERE "exitedAt" IS NULL;

-- §26.1 — the twenty-two invariants of the register, and only those. An unknown
-- invariant identifier has no stated behaviour in any degraded mode (§26.2 states its
-- matrix over exactly these), so a status row for one would be a claim nobody defined
-- the response to.
ALTER TABLE "InvariantStatus" ADD CONSTRAINT "InvariantStatus_invariant_known"
  CHECK ("invariantId" IN ('I1','I2','I3','I4','I5','I6','I7','I8','I9','I10','I11','I12','I13','I14','I15','I16','I17','I18','I19','I20','I21','I22'));

-- §26.1 — three statuses, and the third is not a euphemism for the second. A fourth
-- status would be a report with no defined response: ENFORCED is silence, VIOLATED is a
-- page, SUSPENDED is a counted, time-boxed event. Anything else is an alert nobody
-- knows what to do with, which is how a register stops being read.
ALTER TABLE "InvariantStatus" ADD CONSTRAINT "InvariantStatus_status_known"
  CHECK ("status" IN ('ENFORCED', 'VIOLATED', 'SUSPENDED'));

-- §18.5 rule 2 / §26.1 — "No invariant is ever suspended implicitly by a component
-- finding it inconvenient, and **every suspension names the mode that authorised it**."
-- Requiring the mode at the schema means a future writer cannot reintroduce an
-- unauthorised suspension by forgetting a field — and the converse half refuses an
-- authorising mode on a status that is not a suspension, so the column cannot become a
-- general-purpose annotation.
ALTER TABLE "InvariantStatus" ADD CONSTRAINT "InvariantStatus_suspension_names_its_mode"
  CHECK (
    ("status" <> 'SUSPENDED' OR "authorisingMode" IS NOT NULL)
    AND ("status" = 'SUSPENDED' OR "authorisingMode" IS NULL)
  );

-- §26.1 — the violation count is an SLI whose target is exactly zero. A negative count
-- is a defect in the accounting, not a healthier shard.
ALTER TABLE "InvariantStatus" ADD CONSTRAINT "InvariantStatus_violation_count_non_negative"
  CHECK ("violationCount" >= 0);

-- The subject vocabulary: a shard-level status row, or one of I6's per-agent
-- high-water rows.
ALTER TABLE "InvariantStatus" ADD CONSTRAINT "InvariantStatus_subject_type_known"
  CHECK ("subjectType" IN ('SHARD', 'AGENT'));

-- §18.6 — the chain has exactly five steps. A step 0 or a step 6 is a rung nobody
-- specified the action, the timing, or the gating of.
ALTER TABLE "ExternalEscalation" ADD CONSTRAINT "ExternalEscalation_step_in_range"
  CHECK ("step" >= 1 AND "step" <= 5);

-- §18.6 step 4 is **deliberately human-gated**: "automatic calls to emergency services
-- are not an appropriate output of an allocation engine, and a false positive has real
-- external cost". A step-4 row with no operator is a call nobody authorised. The gate
-- is enforced three ways — by the absence of a code path (`openChain` cannot emit step
-- 4), by `confirmEmergencyServices()` refusing without an operator identity, and here,
-- at the schema, so no future writer can reach the table around both.
ALTER TABLE "ExternalEscalation" ADD CONSTRAINT "ExternalEscalation_step_four_is_human_gated"
  CHECK ("step" <> 4 OR "operatorId" IS NOT NULL);

-- The disposition vocabulary, closed so a step's outcome cannot be recorded in a word
-- no consumer switches on.
ALTER TABLE "ExternalEscalation" ADD CONSTRAINT "ExternalEscalation_disposition_known"
  CHECK ("disposition" IN ('EMITTED', 'NO_CONTACT_CONFIGURED', 'CONTACT_SET_UNREVIEWED', 'AWAITING_OPERATOR', 'CONFIRMED_BY_OPERATOR', 'DECLINED_BY_OPERATOR', 'DE_ESCALATED', 'CLEARED'));

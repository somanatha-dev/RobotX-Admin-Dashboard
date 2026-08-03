-- Phase 5 — Supervision and reconciliation.
--
-- §4.2 Task state machine · §4.3 Leg state machine · §4.4 transition table ·
-- §4.5 durable timers · §4.6 cancellation · §4.7 reassignment · §4.9 settlement ·
-- §12 supervision and reconciliation · §26 invariants I3, I4, I7, I8, I12, I13.
--
-- ── What this migration is for ──────────────────────────────────────────────
-- §12.1 states the problem this phase exists to remove:
--
--   > The audit's failure summary contains six distinct entries whose outcome is
--   > "stuck `ASSIGNED`", "stuck `PENDING`", or "silent". They have different
--   > triggers but one shared root cause: **no component is responsible for noticing
--   > that a state has stopped progressing.** Patching each trigger individually
--   > leaves the seventh undiscovered.
--
-- Three tables follow, plus one additive column and seven CHECK constraints.
--
--   (a) `Timer`                — §4.5's durable timer store, DB-authoritative
--   (b) `ReconcilerRepair`     — §12.4's per-category repair counter
--   (c) `VerificationEvidence` — §12.5's graded completion evidence
--   (d) `Task.version`         — §4.1 rule 2's conditional-write counter
--
-- ── Additive only ───────────────────────────────────────────────────────────
-- Nothing is dropped, renamed, or re-typed. `Task` gains one column, defaulted, so
-- every existing row remains valid and no legacy write path acquires a new
-- requirement — the same treatment Phase 2 gave `Zone` and `Task`.
--
-- Every CREATE TABLE, CREATE INDEX, ALTER TABLE … ADD COLUMN, and ALTER TABLE …
-- ADD CONSTRAINT … FOREIGN KEY below is Prisma's own generated SQL for the models in
-- `schema.prisma`, taken verbatim from
-- `prisma migrate diff --from-empty --to-schema-datamodel`, so the hand-written
-- migration and the schema cannot disagree. The hand-written additions are the seven
-- CHECK constraints at the end, each annotated with the § that requires it.

-- ─────────────────────────────────────────────────────────────────────────────
-- (a) THE DURABLE TIMER STORE (§4.5, §3.3)
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "Timer" (
    "id" TEXT NOT NULL,
    "timerKey" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "entityVersion" BIGINT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "handler" TEXT NOT NULL,
    "payload" JSONB,
    "timerState" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "firedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "lastOutcome" TEXT,
    "shardId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Timer_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- (b) THE RECONCILER'S REPAIR LEDGER (§12.4)
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "ReconcilerRepair" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" JSONB,
    "escalated" BOOLEAN NOT NULL DEFAULT false,
    "shardId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconcilerRepair_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- (c) GRADED COMPLETION VERIFICATION (§12.5)
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "VerificationEvidence" (
    "id" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "legId" TEXT NOT NULL,
    "taskId" TEXT,
    "requiredLevel" TEXT NOT NULL,
    "achievedLevel" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "failures" TEXT[],
    "arrivalDistanceM" DOUBLE PRECISION,
    "trackFixCount" INTEGER,
    "legDurationSeconds" DOUBLE PRECISION,
    "fixRatePerMinute" DOUBLE PRECISION,
    "corridorFraction" DOUBLE PRECISION,
    "maxGapSeconds" DOUBLE PRECISION,
    "maxImpliedSpeedMs" DOUBLE PRECISION,
    "physicalEvidence" JSONB,
    "attestation" JSONB,
    "securityEvent" BOOLEAN NOT NULL DEFAULT false,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationEvidence_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- (d) THE TASK'S CONDITIONAL-WRITE COUNTER (§4.1 rule 2, §4.5)
-- ─────────────────────────────────────────────────────────────────────────────

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "Timer_timerKey_key" ON "Timer"("timerKey");

-- CreateIndex
CREATE INDEX "Timer_dueAt_idx" ON "Timer"("dueAt");

-- CreateIndex
CREATE INDEX "Timer_timerState_dueAt_idx" ON "Timer"("timerState", "dueAt");

-- CreateIndex
CREATE INDEX "Timer_entityType_entityId_timerState_idx" ON "Timer"("entityType", "entityId", "timerState");

-- CreateIndex
CREATE INDEX "ReconcilerRepair_category_at_idx" ON "ReconcilerRepair"("category", "at");

-- CreateIndex
CREATE INDEX "ReconcilerRepair_entityType_entityId_idx" ON "ReconcilerRepair"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "ReconcilerRepair_at_idx" ON "ReconcilerRepair"("at");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationEvidence_evidenceId_key" ON "VerificationEvidence"("evidenceId");

-- CreateIndex
CREATE INDEX "VerificationEvidence_legId_idx" ON "VerificationEvidence"("legId");

-- CreateIndex
CREATE INDEX "VerificationEvidence_outcome_idx" ON "VerificationEvidence"("outcome");

-- CreateIndex
CREATE INDEX "VerificationEvidence_createdAt_idx" ON "VerificationEvidence"("createdAt");

-- AddForeignKey
ALTER TABLE "VerificationEvidence" ADD CONSTRAINT "VerificationEvidence_legId_fkey" FOREIGN KEY ("legId") REFERENCES "Leg"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- (e) THE SCHEMA BACKSTOPS
--
-- Backstops in the same sense §10.3.2's are: they hold even when the application
-- logic that should have prevented the write is defective, and they cannot be
-- bypassed by a new call site.
-- ─────────────────────────────────────────────────────────────────────────────

-- §4.5 — a timer belongs to one of the three supervised entity kinds. A timer on
-- anything else would be a deadline with no state machine to attempt a transition on,
-- which is a timer that can only ever fire and do nothing.
ALTER TABLE "Timer"
    ADD CONSTRAINT "Timer_entity_type_known"
    CHECK ("entityType" IN ('LEG', 'TASK', 'COMMITMENT'));

-- §4.5 — the timer's own lifecycle. An unknown value would be a row the due sweep
-- never matches and the cancel sweep never clears: a deadline with no owner, which is
-- precisely the class §12.1 exists to eliminate.
--
--   PENDING   — registered on state entry, awaiting its instant
--   FIRED     — the handler ran and attempted its transition
--   CANCELLED — the state was exited; cancelled atomically with the exit
--   DISCARDED — fired late, and its entity's version had moved on (§4.5)
ALTER TABLE "Timer"
    ADD CONSTRAINT "Timer_state_known"
    CHECK ("timerState" IN ('PENDING', 'FIRED', 'CANCELLED', 'DISCARDED'));

-- §4.5 — *"A Leg timer is keyed `(leg, leg_id, state, leg.version)`; a commitment timer
-- is keyed `(commitment, commitment_id, state, commitment.fence)`."* Both counters are
-- non-negative and monotone. A negative version could only come from an uninitialised
-- read, and a timer keyed on one would be discarded on every fire — supervision that
-- exists in the table and nowhere in effect.
ALTER TABLE "Timer"
    ADD CONSTRAINT "Timer_entity_version_non_negative"
    CHECK ("entityVersion" >= 0);

-- §4.5 — firing is at-least-once, so the attempt counter is what makes a handler that
-- fails repeatedly visible rather than merely slow.
ALTER TABLE "Timer"
    ADD CONSTRAINT "Timer_attempts_non_negative"
    CHECK ("attempts" >= 0);

-- §12.4 — the divergence classes, by name.
--
-- **Ten, not nine.** The execution plan says "all nine divergence classes of §12.4";
-- §12.4's table has ten rows. The plan states its own precedence — "where this plan and
-- the specification appear to disagree, the specification wins and this plan is
-- defective" — so all ten are admitted here and all ten are implemented. Recorded rather
-- than reconciled: the architecture is frozen and this migration is not the place to
-- edit either document.
-- A repair filed under an unknown
-- category would be a repair excluded from every per-category rate, and §12.4 makes
-- those rates the release gate: *"The release gate MUST include a maximum acceptable
-- repair rate per category."* An uncategorised repair is one the gate cannot see.
ALTER TABLE "ReconcilerRepair"
    ADD CONSTRAINT "ReconcilerRepair_category_known"
    CHECK ("category" IN (
        'COMMITMENT_UNKNOWN_TO_AGENT',
        'AGENT_REPORTS_UNKNOWN_COMMITMENT',
        'ORPHAN_LEG',
        'COMMITMENT_ON_TERMINAL_LEG',
        'LEASE_EXPIRED_UNPROCESSED',
        'CUSTODY_HELD_WITHOUT_MISSION',
        'TASK_WAITING_BEYOND_SLA',
        'OUTBOX_UNDELIVERED_PAST_DEADLINE',
        'AGENT_ABSENT_FROM_AVAILABILITY_INDEX',
        'ENERGY_ACCOUNTING_INCONSISTENT'
    ));

-- §12.5 — the four graded levels, and the two outcomes. *"Insufficient evidence sends
-- the Task to `VERIFYING` with an operator queue — not to `COMPLETED`, and not to
-- `FAILED`. Both of those are lies about the physical state."* A third outcome would be
-- somewhere for a lie to live.
ALTER TABLE "VerificationEvidence"
    ADD CONSTRAINT "VerificationEvidence_levels_known"
    CHECK (
        "requiredLevel" IN ('L0', 'L1', 'L2', 'L3')
        AND "achievedLevel" IN ('L0', 'L1', 'L2', 'L3')
    );

ALTER TABLE "VerificationEvidence"
    ADD CONSTRAINT "VerificationEvidence_outcome_known"
    CHECK ("outcome" IN ('SUFFICIENT', 'INSUFFICIENT'));

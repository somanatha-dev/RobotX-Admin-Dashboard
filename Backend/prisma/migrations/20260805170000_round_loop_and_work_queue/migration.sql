-- Phase 10 — Round loop and solve (§3.2, §3.4, §9).
--
-- ── What this migration is for ──────────────────────────────────────────────
-- Two tables, and between them they are what makes §3.4's decoupling of the
-- request path from the round path a *fact* rather than an intention.
--
--   `WorkQueue` — §3.2's "durable priority queue of pending Legs per shard". The
--   baseline's intake creates a PENDING row and detaches the assignment into a
--   `setImmediate` with no owner, no timeout, no retry, and no observability; §5.2
--   item C6 of the execution plan names that line as the root cause of the audit's
--   "stuck at PENDING with no record of the failure". After this migration the
--   request path's last act is a durable row here, and the round path's first act
--   is to read it. A Leg that is waiting has a position, an age, and a state.
--
--   `Round` — one row per round of one shard's coordinator loop, so that a round
--   is an entity rather than an event: it has the identity decision records point
--   at, the pinned snapshot references replay consumes (§9.6 requirement 5), the
--   regime whose guarantee it is entitled to assert (§9.3), the budgets it ran
--   under and which of them bound (§9.4), and an outcome — including the outcome
--   "produced nothing, and here is why".
--
-- ── What this migration deliberately does NOT contain ───────────────────────
-- **No SOFT reservation table, and no provisional-agent column on `WorkQueue`.**
-- §2.6 is categorical — "a SOFT reservation is round-local coordinator state and
-- MUST NOT be written to the Commitment Store … There is no third case" — and
-- invariant I18's schema half is already enforced by `Commitment`'s `kind = 'HARD'`
-- CHECK from Phase 3. A `plannedAgentId` column here would be that same forbidden
-- state under a different table name, and would put the *re-planning* rate inside
-- the durable path, which §3.5's shard-sizing arithmetic depends on it not being.
-- What is durable during planning is the Leg's own state (`Leg.state = PLANNED`),
-- never its provisional binding.
--
-- ── Why `shardId` is a plain, unconstrained column ──────────────────────────
-- The convention `DecisionRecordA`, `RejectionAggregate`, and `AgentCellPosition`
-- already use, ahead of Phase 13's `Shard` table. Adding a foreign key to a table
-- that does not exist yet is not available; adding one when Phase 13 lands is.
--
-- ── Additive only ────────────────────────────────────────────────────────────
-- Two new tables, one new foreign key, no column on any existing table (the
-- `Leg.workQueueEntry` back-relation is a Prisma relation, stored entirely on
-- `WorkQueue.legId`). Nothing existing is dropped, renamed, or re-typed. Rollback
-- removes the two tables and nothing else.
--
-- Every CREATE TABLE, CREATE INDEX, and ADD CONSTRAINT below is Prisma's own
-- generated SQL for these two models in `schema.prisma`, taken verbatim from
-- `prisma migrate diff --from-empty --to-schema-datamodel`, so the hand-written
-- migration and the schema cannot disagree. The hand-written additions are the
-- three CHECK constraints at the end, which Prisma cannot express.

-- CreateTable
CREATE TABLE "WorkQueue" (
    "id" TEXT NOT NULL,
    "legId" TEXT NOT NULL,
    "shardId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "purpose" "LegPurpose" NOT NULL,
    "slaClass" TEXT,
    "tenantId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'QUEUED',
    "availableAt" TIMESTAMP(3),
    "claimedByRoundId" TEXT,
    "claimedAt" TIMESTAMP(3),
    "roundsConsidered" INTEGER NOT NULL DEFAULT 0,
    "consecutiveDeferrals" INTEGER NOT NULL DEFAULT 0,
    "firstDeferredAt" TIMESTAMP(3),
    "predictedWindow" JSONB,
    "version" INTEGER NOT NULL DEFAULT 0,
    "enqueuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Round" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "shardId" TEXT NOT NULL,
    "decisionTime" TIMESTAMP(3) NOT NULL,
    "leadershipFence" BIGINT,
    "coordinatorInstance" TEXT,
    "snapshotRefs" JSONB,
    "seed" TEXT,
    "cadenceRegime" TEXT,
    "windowMs" INTEGER,
    "regime" TEXT NOT NULL,
    "budgets" JSONB,
    "legCount" INTEGER NOT NULL DEFAULT 0,
    "columnCount" INTEGER NOT NULL DEFAULT 0,
    "agentCount" INTEGER NOT NULL DEFAULT 0,
    "outcome" JSONB,
    "searchGapMilliCU" TEXT,
    "lpIpGapMilliCU" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Round_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkQueue_legId_key" ON "WorkQueue"("legId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkQueue_idempotencyKey_key" ON "WorkQueue"("idempotencyKey");

-- CreateIndex
CREATE INDEX "WorkQueue_shardId_state_priority_enqueuedAt_idx" ON "WorkQueue"("shardId", "state", "priority", "enqueuedAt");

-- CreateIndex
CREATE INDEX "WorkQueue_shardId_state_availableAt_idx" ON "WorkQueue"("shardId", "state", "availableAt");

-- CreateIndex
CREATE INDEX "WorkQueue_state_idx" ON "WorkQueue"("state");

-- CreateIndex
CREATE INDEX "WorkQueue_claimedByRoundId_idx" ON "WorkQueue"("claimedByRoundId");

-- CreateIndex
CREATE UNIQUE INDEX "Round_roundId_key" ON "Round"("roundId");

-- CreateIndex
CREATE INDEX "Round_shardId_decisionTime_idx" ON "Round"("shardId", "decisionTime");

-- CreateIndex
CREATE INDEX "Round_shardId_startedAt_idx" ON "Round"("shardId", "startedAt");

-- CreateIndex
CREATE INDEX "Round_regime_idx" ON "Round"("regime");

-- AddForeignKey
ALTER TABLE "WorkQueue" ADD CONSTRAINT "WorkQueue_legId_fkey" FOREIGN KEY ("legId") REFERENCES "Leg"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Hand-written from here down ─────────────────────────────────────────────
-- Prisma cannot express CHECK constraints. Each of the three below closes a way
-- application logic could write a row the specification forbids, independently of
-- whether the application logic is correct — which is the arrangement §10.3.2 asks
-- for throughout the correctness core.

-- §3.2 — the queue entry's lifecycle. An unknown state cannot be written by any
-- path, present or future, which is the same discipline `Outbox_state_known`
-- (Phase 4) applies to the dispatch obligation.
ALTER TABLE "WorkQueue" ADD CONSTRAINT "WorkQueue_state_known"
    CHECK ("state" IN ('QUEUED', 'CLAIMED', 'SOLVED', 'SHED', 'WITHDRAWN'));

-- §9.3 — the regime is a property of the generated column set, is determined per
-- round, and is recorded. "The engine never asserts a guarantee it is not in the
-- regime for": a round claiming an unrecognised regime could claim any guarantee,
-- so the vocabulary is closed at the schema rather than at the writer.
ALTER TABLE "Round" ADD CONSTRAINT "Round_regime_known"
    CHECK ("regime" IN ('SINGLETON', 'COLUMN'));

-- §8.8 — deferral is bounded, and the bound is structural. A negative count would
-- make `assign.max_consecutive_deferrals` unreachable, which is exactly the
-- "indefinite silence" §17.4's ladder exists to make impossible.
ALTER TABLE "WorkQueue" ADD CONSTRAINT "WorkQueue_deferral_counts_non_negative"
    CHECK ("consecutiveDeferrals" >= 0 AND "roundsConsidered" >= 0);

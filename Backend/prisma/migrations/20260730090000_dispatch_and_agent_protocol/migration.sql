-- Phase 4 — Dispatch and the agent protocol.
--
-- §11 Dispatch and Acknowledgement · §4.1 rule 5 · §10.3.1 two fence scopes ·
-- §10.5 idempotency namespaces · §23.3 command integrity · §26 invariants I5, I16,
-- I19, I21.
--
-- ── What this migration is for ──────────────────────────────────────────────
-- §11.1 requires that a commitment and its dispatch obligation be written
-- atomically:
--
--   > The commit transaction writes the Commitment and an **outbox row** atomically
--   > (§10.3 step 5). Either both exist or neither does. There is no window in which
--   > a commitment exists without a pending dispatch obligation.
--
-- and §11.5 requires that an agent's loss of its deduplication state be *detectable*:
--
--   > `dedup_state_generation`, a monotonic counter persisted alongside the state and
--   > **incremented whenever the state is created, cleared, or found corrupt**. This
--   > is what makes a state loss detectable rather than silent.
--
-- Two tables follow, plus four CHECK constraints that are backstops in the same
-- sense §10.3.2's are: they hold even when the application logic that should have
-- prevented the write is defective, and they cannot be bypassed by a new call site.
--
-- ── Additive only ───────────────────────────────────────────────────────────
-- Nothing is dropped, renamed, or re-typed. No pre-existing table gains a column:
-- the relations added to `Agent` and `Commitment` in `schema.prisma` are
-- back-relations, which Prisma resolves without a column. The two foreign keys below
-- are declared on `Outbox` and `AgentDedupState` themselves.
--
-- Every CREATE TABLE, CREATE INDEX, and ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY
-- below is Prisma's own generated SQL for the models in `schema.prisma`, taken
-- verbatim from `prisma migrate diff --from-empty --to-schema-datamodel`, so the
-- hand-written migration and the schema cannot disagree. The hand-written additions
-- are the four CHECK constraints at the end, each annotated with the § that requires
-- it.

-- ─────────────────────────────────────────────────────────────────────────────
-- (a) THE TRANSACTIONAL OUTBOX (§11.1, §4.1 rule 5)
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "Outbox" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "commitmentId" TEXT,
    "commandClass" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "fenceScope" TEXT NOT NULL,
    "fence" BIGINT,
    "authorityEpoch" BIGINT,
    "fenceFloor" BIGINT,
    "sequence" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "notValidAfter" TIMESTAMP(3) NOT NULL,
    "signature" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3),
    "claimExpiresAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "ackedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Outbox_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- (b) THE AGENT'S REPORTED DEDUP HIGH-WATER MARK (§11.5)
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "AgentDedupState" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "dedupStateGeneration" BIGINT NOT NULL DEFAULT 0,
    "authorityEpoch" BIGINT NOT NULL DEFAULT 0,
    "fenceFloor" BIGINT NOT NULL DEFAULT 0,
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentDedupState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Outbox_idempotencyKey_key" ON "Outbox"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Outbox_state_notValidAfter_idx" ON "Outbox"("state", "notValidAfter");

-- CreateIndex
CREATE INDEX "Outbox_agentId_state_idx" ON "Outbox"("agentId", "state");

-- CreateIndex
CREATE INDEX "Outbox_commitmentId_idx" ON "Outbox"("commitmentId");

-- CreateIndex
CREATE INDEX "Outbox_createdAt_idx" ON "Outbox"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentDedupState_agentId_key" ON "AgentDedupState"("agentId");

-- CreateIndex
CREATE INDEX "AgentDedupState_reportedAt_idx" ON "AgentDedupState"("reportedAt");

-- AddForeignKey
ALTER TABLE "Outbox" ADD CONSTRAINT "Outbox_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Outbox" ADD CONSTRAINT "Outbox_commitmentId_fkey" FOREIGN KEY ("commitmentId") REFERENCES "Commitment"("commitmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentDedupState" ADD CONSTRAINT "AgentDedupState_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- (c) THE SCHEMA BACKSTOPS
-- ─────────────────────────────────────────────────────────────────────────────

-- §10.3.1's normative command-class → fence-scope table admits exactly three classes,
-- and queries — *"side-effect-free […] Always answered; never fenced"* — are never
-- enqueued for dispatch. A row whose class is QUERY would be a fenced query, which
-- the table forbids; a row whose class is anything else is a command whose authority
-- nobody decided.
ALTER TABLE "Outbox"
    ADD CONSTRAINT "Outbox_command_class_known"
    CHECK ("commandClass" IN ('MISSION', 'AGENT'));

-- The two scopes are compared differently by the agent — mission at `≤`, per
-- commitment id; agent at `<`, against one high-water value — so a row must carry
-- the columns *its own* scope requires and must not carry the other's. Enforcing this
-- in the schema is what stops a future writer from populating both and leaving the
-- comparison to be chosen at delivery time, which is how a single per-agent maximum
-- would be reintroduced.
--
-- §10.3.1's interaction rule is why an agent row carries `fenceFloor` as well as
-- `authorityEpoch`: without it the agent cannot invalidate the mission authorities the
-- agent-scope command is superseding.
ALTER TABLE "Outbox"
    ADD CONSTRAINT "Outbox_fence_scope_columns"
    CHECK (
        ("fenceScope" = 'COMMITMENT'
            AND "commandClass" = 'MISSION'
            AND "commitmentId" IS NOT NULL
            AND "fence" IS NOT NULL
            AND "authorityEpoch" IS NULL
            AND "fenceFloor" IS NULL)
        OR
        ("fenceScope" = 'AGENT'
            AND "commandClass" = 'AGENT'
            AND "commitmentId" IS NULL
            AND "fence" IS NULL
            AND "authorityEpoch" IS NOT NULL
            AND "fenceFloor" IS NOT NULL)
    );

-- §11.3 — *"Commands carry a per-commitment sequence; the agent applies them in order
-- and ignores out-of-order duplicates."* An ordering counter that could go negative is
-- not an ordering counter.
ALTER TABLE "Outbox"
    ADD CONSTRAINT "Outbox_sequence_non_negative"
    CHECK ("sequence" >= 0);

-- The row's own lifecycle. An unknown state would be a row no sweep matches and no
-- worker claims — a dispatch obligation with no owner, which is exactly the class of
-- defect §12.1 exists to eliminate.
ALTER TABLE "Outbox"
    ADD CONSTRAINT "Outbox_state_known"
    CHECK ("state" IN (
        'PENDING',
        'CLAIMED',
        'DELIVERED',
        'ACKED',
        'UNACKNOWLEDGED',
        'EXPIRED',
        'SUPPRESSED',
        'FAILED'
    ));

-- §11.5 — the generation counter is monotonic, and both fencing counters are
-- non-negative (invariant I6's shape, mirrored on the agent's reported view).
ALTER TABLE "AgentDedupState"
    ADD CONSTRAINT "AgentDedupState_counters_non_negative"
    CHECK (
        "dedupStateGeneration" >= 0
        AND "authorityEpoch" >= 0
        AND "fenceFloor" >= 0
    );

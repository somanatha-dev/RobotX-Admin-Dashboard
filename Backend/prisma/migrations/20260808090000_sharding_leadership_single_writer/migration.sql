-- PHASE 13 — Sharding, leadership, and the single writer (§3.5, §19).
--
-- Additive only. Four new tables; **no existing table gains, loses, or alters a
-- column.** The five relations Phase 13 adds to `Region`, `Site`, `Agent`, `Mission`
-- and `ShardLeadership` are all back-relations, which Prisma resolves without a column.
--
-- `ShardLeadership` in particular is untouched. That is the load-bearing property of
-- this migration: guard G1 reads `"leadershipFence"` from that row inside the commit
-- transaction, and Phase 13's whole job is to replace *how the number gets there* — a
-- manual advance becomes a leader election — without changing the read. A migration that
-- altered the table G1 reads would have made "G1 unchanged" a claim about source rather
-- than about the database.
--
-- Every CREATE TABLE, CREATE INDEX and ADD CONSTRAINT ... FOREIGN KEY below is taken
-- verbatim from `prisma migrate diff --from-empty --to-schema-datamodel`, so the
-- hand-written file and `schema.prisma` cannot silently disagree.
-- `tests/engine/shardSchema.test.js` re-runs that diff and asserts the equality, and
-- asserts that the fourteen CHECK constraints at the foot of this file — and the partial
-- unique index, which Prisma also cannot express — are **absent** from Prisma's output,
-- which is what proves they are genuine hand-written additions rather than an echo.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. `Shard` — §3.5's AssignmentShard, one per OperatingRegion.
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "Shard" (
    "id" TEXT NOT NULL,
    "shardId" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "drainingSince" TIMESTAMP(3),
    "agentCount" INTEGER NOT NULL DEFAULT 0,
    "bindingBound" TEXT NOT NULL DEFAULT 'NEITHER_EVALUATED',
    "sizingDetail" JSONB,
    "sizingCheckedAt" TIMESTAMP(3),
    "lastLeadershipChangeAt" TIMESTAMP(3),
    "lastFailoverAt" TIMESTAMP(3),
    "lastFailoverReconstructedLegs" INTEGER,
    "lastFailoverRecoveredCommitments" INTEGER,
    "roundsResumableAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shard_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. `ShardMembership` — §3.5's transactional handoff, one row per move.
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "ShardMembership" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "shardId" TEXT NOT NULL,
    "fromShardId" TEXT,
    "movedAt" TIMESTAMP(3) NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "authorityEpochBefore" BIGINT NOT NULL,
    "authorityEpochAfter" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "movedBy" TEXT NOT NULL,
    "outboxIdempotencyKey" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShardMembership_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. `CrossRegionSaga` — §19.6's saga, with compensation recorded per step.
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "CrossRegionSaga" (
    "id" TEXT NOT NULL,
    "sagaId" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PLANNED',
    "steps" JSONB NOT NULL,
    "currentStepIndex" INTEGER NOT NULL DEFAULT 0,
    "compensation" JSONB,
    "heldAtTransferPointId" TEXT,
    "heldSince" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrossRegionSaga_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. `TransferPoint` — §19.6's joining Stop, and its mandatory custodian.
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "TransferPoint" (
    "id" TEXT NOT NULL,
    "transferPointId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "upstreamRegionId" TEXT NOT NULL,
    "downstreamRegionId" TEXT NOT NULL,
    "siteId" TEXT,
    "custodianType" TEXT NOT NULL,
    "custodianId" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "securityProperties" JSONB,
    "lat" DOUBLE PRECISION,
    "lon" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransferPoint_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Indexes and foreign keys, as Prisma generates them.
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateIndex
CREATE UNIQUE INDEX "Shard_shardId_key" ON "Shard"("shardId");

-- CreateIndex
CREATE UNIQUE INDEX "Shard_regionId_key" ON "Shard"("regionId");

-- CreateIndex
CREATE INDEX "Shard_state_idx" ON "Shard"("state");

-- CreateIndex
CREATE INDEX "Shard_bindingBound_idx" ON "Shard"("bindingBound");

-- CreateIndex
CREATE INDEX "ShardMembership_shardId_movedAt_idx" ON "ShardMembership"("shardId", "movedAt");

-- CreateIndex
CREATE INDEX "ShardMembership_agentId_movedAt_idx" ON "ShardMembership"("agentId", "movedAt");

-- CreateIndex
CREATE INDEX "ShardMembership_supersededAt_idx" ON "ShardMembership"("supersededAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrossRegionSaga_sagaId_key" ON "CrossRegionSaga"("sagaId");

-- CreateIndex
CREATE UNIQUE INDEX "CrossRegionSaga_missionId_key" ON "CrossRegionSaga"("missionId");

-- CreateIndex
CREATE INDEX "CrossRegionSaga_state_idx" ON "CrossRegionSaga"("state");

-- CreateIndex
CREATE INDEX "CrossRegionSaga_heldAtTransferPointId_idx" ON "CrossRegionSaga"("heldAtTransferPointId");

-- CreateIndex
CREATE INDEX "CrossRegionSaga_openedAt_idx" ON "CrossRegionSaga"("openedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TransferPoint_transferPointId_key" ON "TransferPoint"("transferPointId");

-- CreateIndex
CREATE INDEX "TransferPoint_upstreamRegionId_downstreamRegionId_idx" ON "TransferPoint"("upstreamRegionId", "downstreamRegionId");

-- CreateIndex
CREATE INDEX "TransferPoint_custodianType_idx" ON "TransferPoint"("custodianType");

-- CreateIndex
CREATE INDEX "TransferPoint_siteId_idx" ON "TransferPoint"("siteId");

-- AddForeignKey
ALTER TABLE "Shard" ADD CONSTRAINT "Shard_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shard" ADD CONSTRAINT "Shard_shardId_fkey" FOREIGN KEY ("shardId") REFERENCES "ShardLeadership"("shardId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShardMembership" ADD CONSTRAINT "ShardMembership_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShardMembership" ADD CONSTRAINT "ShardMembership_shardId_fkey" FOREIGN KEY ("shardId") REFERENCES "Shard"("shardId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrossRegionSaga" ADD CONSTRAINT "CrossRegionSaga_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrossRegionSaga" ADD CONSTRAINT "CrossRegionSaga_heldAtTransferPointId_fkey" FOREIGN KEY ("heldAtTransferPointId") REFERENCES "TransferPoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferPoint" ADD CONSTRAINT "TransferPoint_upstreamRegionId_fkey" FOREIGN KEY ("upstreamRegionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferPoint" ADD CONSTRAINT "TransferPoint_downstreamRegionId_fkey" FOREIGN KEY ("downstreamRegionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferPoint" ADD CONSTRAINT "TransferPoint_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═════════════════════════════════════════════════════════════════════════════
-- HAND-WRITTEN CONSTRAINTS PRISMA CANNOT EXPRESS
--
-- The same treatment Phases 1–12 gave their CHECKs, triggers, and partial indexes:
-- they live here because the ORM has no syntax for them, and their absence from
-- `prisma migrate diff`'s output is asserted by this phase's schema test.
-- ═════════════════════════════════════════════════════════════════════════════

-- §3.5 / §19.2 — the shard-state vocabulary is closed. A shard in an unrecognised state
-- is one intake has no rule for: `resolveShard` admits work to ACTIVE and REBALANCING
-- and refuses DRAINING and RETIRED, and a fifth value would fall through that decision
-- silently — routing work to a coordinator nobody decided was serving.
ALTER TABLE "Shard" ADD CONSTRAINT "Shard_state_known"
  CHECK ("state" IN ('ACTIVE', 'REBALANCING', 'DRAINING', 'RETIRED'));

-- §3.5 — the binding bound is one of the two the section derives, or the honest
-- statement that neither has been evaluated yet. "Both bounds are continuously
-- monitored as SLIs, and the *binding* one is reported"; a third value would be a
-- resource nobody sized against.
ALTER TABLE "Shard" ADD CONSTRAINT "Shard_binding_bound_known"
  CHECK ("bindingBound" IN ('ROUND_WALL_CLOCK', 'SERIAL_COMMIT', 'NEITHER_EVALUATED'));

-- A membership count is a cardinality. A negative one is an accounting defect in the
-- handoff, not an emptier shard, and it would make the §3.5 bound-2 evaluation report
-- headroom that does not exist.
ALTER TABLE "Shard" ADD CONSTRAINT "Shard_agent_count_non_negative"
  CHECK ("agentCount" >= 0);

-- §3.5 — a shard is DRAINING from an instant. Without the timestamp a drain that never
-- completes is invisible: it looks exactly like a drain that started a moment ago, and
-- the agents it is trying to give away have nobody counting how long they have waited.
-- The converse half refuses the timestamp on a shard that is not draining, so the column
-- cannot decay into a general-purpose annotation.
ALTER TABLE "Shard" ADD CONSTRAINT "Shard_draining_is_timed"
  CHECK (
    ("state" <> 'DRAINING' OR "drainingSince" IS NOT NULL)
    AND ("state" = 'DRAINING' OR "drainingSince" IS NULL)
  );

-- §3.5 — "Every Agent belongs to exactly one shard at a time." Expressed as a partial
-- unique index over the current rows, which is what makes the sentence a property of the
-- table rather than of the handoff's diligence. Two current memberships would mean two
-- coordinators each believing they may command one physical machine — the precise
-- condition single-writer-per-shard exists to prevent, arrived at from the membership
-- side instead of the leadership side.
CREATE UNIQUE INDEX "ShardMembership_one_current_per_agent"
  ON "ShardMembership"("agentId") WHERE "supersededAt" IS NULL;

-- §19.2 — "migrates agents one at a time, advancing each migrated agent's
-- `authority_epoch`". A migration that did not advance it would leave every mission
-- authority the agent holds valid under the *old* shard's coordinator, which is exactly
-- what §19.2 says migration is "precisely the case the agent-scope fence exists for".
-- The initial placement at commissioning is exempt because it supersedes no authority:
-- there is no previous shard whose commands must stop being honoured.
ALTER TABLE "ShardMembership" ADD CONSTRAINT "ShardMembership_migration_advances_epoch"
  CHECK ("fromShardId" IS NULL OR "authorityEpochAfter" > "authorityEpochBefore");

-- Both epochs are non-negative counters (I6).
ALTER TABLE "ShardMembership" ADD CONSTRAINT "ShardMembership_epochs_non_negative"
  CHECK ("authorityEpochBefore" >= 0 AND "authorityEpochAfter" >= 0);

-- A move from a shard to itself is not a move. Admitting one would burn an
-- `authority_epoch` — invalidating every mission authority the agent holds — for a
-- handoff that changed nothing.
ALTER TABLE "ShardMembership" ADD CONSTRAINT "ShardMembership_move_changes_shard"
  CHECK ("fromShardId" IS NULL OR "fromShardId" <> "shardId");

-- §22.3 makes shard definition a STRUCTURAL change. A membership change with no stated
-- cause is one nobody can audit, and the vocabulary is closed so a cause cannot be
-- recorded in a word no consumer switches on.
ALTER TABLE "ShardMembership" ADD CONSTRAINT "ShardMembership_reason_known"
  CHECK ("reason" IN ('COMMISSIONING', 'REBALANCE_SPLIT', 'REBALANCE_MERGE', 'REDISTRICTING', 'OPERATOR'));

-- §19.6 — the saga's state vocabulary. Closed for the same reason §18.5's mode
-- vocabulary is: an unrecognised state has no defined compensation, and a saga whose
-- compensation is undefined is the improvisation §19.6 opens by rejecting.
ALTER TABLE "CrossRegionSaga" ADD CONSTRAINT "CrossRegionSaga_state_known"
  CHECK ("state" IN ('PLANNED', 'IN_PROGRESS', 'COMPENSATING', 'COMPLETED', 'COMPENSATED', 'FAILED'));

-- §19.6 — "Compensation is explicit per step". A saga that has begun compensating with
-- no recorded compensation plan is improvising one during the incident, which is the
-- state this constraint exists to make unrepresentable.
ALTER TABLE "CrossRegionSaga" ADD CONSTRAINT "CrossRegionSaga_compensation_is_explicit"
  CHECK ("state" NOT IN ('COMPENSATING', 'COMPENSATED') OR "compensation" IS NOT NULL);

-- Goods are held *somewhere from some instant*, or they are not held. A hold with no
-- start time cannot be aged, and the whole point of recording the hold is that a hold
-- nobody is ageing is how "goods stranded at a transfer point" becomes invisible.
ALTER TABLE "CrossRegionSaga" ADD CONSTRAINT "CrossRegionSaga_hold_is_timed"
  CHECK (("heldAtTransferPointId" IS NULL) = ("heldSince" IS NULL));

-- §19.6 — the custodian vocabulary. "A locker, a depot, a staffed counter" are the three
-- the specification names; MODELLED_UNATTENDED is the fourth it conditionally admits,
-- and the next constraint is that condition.
ALTER TABLE "TransferPoint" ADD CONSTRAINT "TransferPoint_custodian_type_known"
  CHECK ("custodianType" IN ('LOCKER', 'DEPOT', 'STAFFED_COUNTER', 'MODELLED_UNATTENDED'));

-- §19.6 — "the saga MUST NOT release custody to an unattended location **unless that
-- location is modelled as a custodian with its own capacity and security properties**."
-- The capacity column is NOT NULL for every kind; this constraint adds the security
-- properties for the one kind the sentence conditions. Without it, MODELLED_UNATTENDED
-- would be a label that turns the prohibition off rather than a modelling obligation
-- that satisfies it.
ALTER TABLE "TransferPoint" ADD CONSTRAINT "TransferPoint_unattended_is_modelled"
  CHECK ("custodianType" <> 'MODELLED_UNATTENDED' OR ("securityProperties" IS NOT NULL AND "capacity" > 0));

-- A custodian with no capacity can hold nothing, so a transfer point with one is a
-- handoff that cannot happen — discovered at the kerb rather than at publish.
ALTER TABLE "TransferPoint" ADD CONSTRAINT "TransferPoint_capacity_positive"
  CHECK ("capacity" > 0);

-- §19.6 — a transfer point joins **two** regions. One whose two regions are the same
-- joins nothing: both its Legs would be owned by the same shard, which needs no saga and
-- no custody handoff, and admitting it would let a same-region mission acquire a
-- cross-region orchestration it does not need.
ALTER TABLE "TransferPoint" ADD CONSTRAINT "TransferPoint_joins_two_regions"
  CHECK ("upstreamRegionId" <> "downstreamRegionId");

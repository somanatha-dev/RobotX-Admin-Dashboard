-- Phase 9 — Candidate generation and the admissible bound (§6).
--
-- §6.2 the Availability Index · §6.3 hierarchical expansion · §6.4 the admissible
-- lower bound and its Ω corrections.
--
-- ── What this migration is for ──────────────────────────────────────────────
-- Almost all of §6 is stateless: `candidates/lowerBound.js`, `omega.js`,
-- `ordering.js`, `expansion.js`, and `clusterShare.js` are pure functions of a
-- config snapshot and the agents an Availability Index lookup returns. The
-- Availability Index's hot-path lookup is Redis (`engine:idx:*`, advisory, §3.3),
-- exactly as §6.2's Redis-changes row states. Exactly one quantity needs a durable
-- table: the index's own current membership, because §6.2 requires the index to be
-- "rebuildable from the observation log" (§18.5 Cold Index, B3), and a rebuild has
-- to read *something* durable to reconstruct a lost Redis from.
--
--   `AgentCellPosition` — one row per agent, the durable mirror
--   `candidates/availabilityIndex.rebuildFromRecords()` both reads to rebuild
--   Redis and is kept in agreement with by `indexMaintainer.worker.js`.
--
-- ── Why one row per agent, not an append-only log ───────────────────────────
-- The append-only history already exists — `Observation` (§2.7, Phase 2). This
-- table is deliberately the *opposite* shape: only an agent's current index
-- placement is ever queried (never "where was agent X at time T"), so a new
-- observation supersedes the row via upsert rather than appending a new one. An
-- append-only mirror here would duplicate `Observation` without adding a query
-- Phase 9 needs.
--
-- ── Why `shardId` is a plain, unconstrained column ──────────────────────────
-- The same convention `DecisionRecordA.shardId` and `RejectionAggregate.shardId`
-- already use, ahead of Phase 13's `Shard` table — see those tables' own
-- migrations (Phase 5, Phase 6) for the precedent. Adding a foreign key to a table
-- that does not exist yet is not available; adding one retroactively when Phase 13
-- lands is.
--
-- ── Additive only ────────────────────────────────────────────────────────────
-- One new table, one new foreign key, one new back-relation column on `Agent`
-- (Prisma relation scalar — no column: the relation is stored entirely on
-- `AgentCellPosition.agentId`). Nothing existing is dropped, renamed, or re-typed.
-- Rollback removes the `AgentCellPosition` table and nothing else.
--
-- Every CREATE TABLE, CREATE INDEX, and ADD CONSTRAINT below is Prisma's own
-- generated SQL for `AgentCellPosition` in `schema.prisma`, taken verbatim from
-- `prisma migrate diff --from-empty --to-schema-datamodel`, so the hand-written
-- migration and the schema cannot disagree. The hand-written additions are the two
-- CHECK constraints at the end.

-- CreateTable
CREATE TABLE "AgentCellPosition" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "shardId" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "fineCellId" TEXT NOT NULL,
    "coarseCellId" TEXT NOT NULL,
    "availabilityClass" TEXT NOT NULL,
    "capabilityClasses" TEXT[],
    "containerClasses" TEXT[],
    "observedAtMs" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentCellPosition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentCellPosition_agentId_key" ON "AgentCellPosition"("agentId");

-- CreateIndex
CREATE INDEX "AgentCellPosition_shardId_fineCellId_availabilityClass_idx" ON "AgentCellPosition"("shardId", "fineCellId", "availabilityClass");

-- CreateIndex
CREATE INDEX "AgentCellPosition_shardId_coarseCellId_availabilityClass_idx" ON "AgentCellPosition"("shardId", "coarseCellId", "availabilityClass");

-- CreateIndex
CREATE INDEX "AgentCellPosition_availabilityClass_idx" ON "AgentCellPosition"("availabilityClass");

-- AddForeignKey
ALTER TABLE "AgentCellPosition" ADD CONSTRAINT "AgentCellPosition_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

--------------------------------------------------------------------------------
-- Hand-written CHECK constraints. Prisma cannot express these, and each guards a
-- property the engine's correctness rests on rather than a data-hygiene preference.
--------------------------------------------------------------------------------

-- §6.2 names exactly four availability classes
-- (`candidates/availabilityIndex.js`'s `AVAILABILITY_CLASS`). A fifth value would
-- be a class the index maintainer or the round loop cannot interpret, and a
-- rebuild that trusted it would place the agent in a Redis key no tier's search
-- ever reads — an agent silently invisible to candidate generation.
ALTER TABLE "AgentCellPosition"
  ADD CONSTRAINT "AgentCellPosition_availability_class_known"
  CHECK ("availabilityClass" IN ('IDLE_READY', 'QUEUE_CAPACITY_AVAILABLE', 'CHARGING_INTERRUPTIBLE', 'FINISHING_SOON'));

-- §6.4's admissible bound is derived from the agent's real position via
-- great-circle distance (`spatial/cells.greatCircleMetres`); a coordinate outside
-- the physical range is not a far-away agent, it is unparseable input that would
-- make every downstream distance computation meaningless rather than merely large.
ALTER TABLE "AgentCellPosition"
  ADD CONSTRAINT "AgentCellPosition_coordinates_in_range"
  CHECK ("lat" >= -90 AND "lat" <= 90 AND "lon" >= -180 AND "lon" <= 180);

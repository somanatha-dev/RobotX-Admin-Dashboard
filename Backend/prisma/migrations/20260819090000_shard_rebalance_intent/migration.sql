-- PHASE 13 REMEDIATION — §19.2's rebalance intent, made durable.
--
-- ── Why this migration belongs to Phase 13 ──────────────────────────────────
-- §19.2: "Shard rebalancing (splitting a hot shard, merging quiet ones) is an explicit,
-- **transactional control-plane operation** that migrates agents one at a time, advancing
-- each migrated agent's `authority_epoch` […] never a bulk reassignment."
--
-- The execution plan splits that one sentence across two Phase 13 components. Its REST row
-- makes `POST /api/shards/:id/rebalance` the control plane ("control plane, elevated
-- role"); its background-worker row makes `shardSupervisor.worker.js` the executor
-- ("membership migration one agent at a time"). A control plane and an executor that are
-- not in the same call stack — and after a restart or a leadership handoff are not even in
-- the same process — need a durable place to meet. There was none.
--
-- What shipped instead: the endpoint moved the source shard to DRAINING or REBALANCING and
-- returned the ordered plan in the HTTP response body, which was the only copy of it that
-- ever existed. `migrationPass` read its plan from a boot-time settings key nothing ever
-- set, so it returned `{ skipped: "NO_PLAN" }` on every tick; `shardModel.setState`'s only
-- caller was the endpoint and it only ever set DRAINING or REBALANCING; and `intake.js` had
-- already stopped routing new Legs to the shard. One elevated-role POST therefore stopped a
-- shard accepting work with no API-level route back. `PHASE_13_REMEDIATION_AND_CLOSURE.md`
-- records it as P13-R4.
--
-- ── Additive, and additive in the strict sense ──────────────────────────────
-- **One new table. No existing table gains, loses, or alters a column, and no applied
-- migration file is edited.** The two relations this adds to `Shard` are back-relations,
-- which Prisma resolves without a column — so `CREATE TABLE "Shard"` in
-- `20260808090000_sharding_leadership_single_writer/migration.sql` stays byte-identical to
-- `prisma migrate diff --from-empty`, which `tests/engine/shardSchema.test.js` asserts, and
-- that migration's Prisma checksum is untouched.
--
-- A column on `Shard` was the other candidate shape and was rejected for exactly that
-- reason: it would have forced either an edit to an applied migration (checksum drift on
-- every environment that has applied it) or a weakening of the byte-equality assertion.
-- A separate table is also the better model — a rebalance has a lifecycle, a plan, a
-- requester and a closing reason, none of which are properties of a shard.
--
-- The CREATE TABLE, the two indexes and the two foreign keys below are taken verbatim from
-- `prisma migrate diff --from-empty --to-schema-datamodel`, so the hand-written file and
-- `schema.prisma` cannot silently disagree. The eight CHECK constraints and the partial
-- unique index at the foot are hand-written — Prisma cannot express either — and
-- `shardSchema.test.js` asserts their **absence** from Prisma's output, which is what
-- proves they are genuine additions rather than an echo.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. `ShardRebalance` — the durable intent.
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "ShardRebalance" (
    "id" TEXT NOT NULL,
    "sourceShardId" TEXT NOT NULL,
    "targetShardId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "restoreState" TEXT NOT NULL,
    "plan" JSONB NOT NULL,
    "plannedMoves" INTEGER NOT NULL,
    "completedMoves" INTEGER NOT NULL DEFAULT 0,
    "blocked" JSONB,
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "lastMoveAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closedReason" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShardRebalance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShardRebalance_sourceShardId_state_idx" ON "ShardRebalance"("sourceShardId", "state");

-- CreateIndex
CREATE INDEX "ShardRebalance_state_idx" ON "ShardRebalance"("state");

-- AddForeignKey
ALTER TABLE "ShardRebalance" ADD CONSTRAINT "ShardRebalance_sourceShardId_fkey" FOREIGN KEY ("sourceShardId") REFERENCES "Shard"("shardId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShardRebalance" ADD CONSTRAINT "ShardRebalance_targetShardId_fkey" FOREIGN KEY ("targetShardId") REFERENCES "Shard"("shardId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The constraints Prisma cannot express.
-- ─────────────────────────────────────────────────────────────────────────────

-- **At most one open intent per source shard.** Two concurrent rebalances of one shard
-- would be two plans over one membership set: the second's ordering would be computed
-- against agents the first is already moving, and their union is precisely the bulk
-- reassignment §19.2 forbids reached by issuing two requests instead of one. A partial
-- index rather than a plain unique one, for the same reason
-- `ShardMembership_one_current_per_agent` is partial: the history must stay, and only
-- *open* is exclusive.
CREATE UNIQUE INDEX "ShardRebalance_one_open_per_source"
  ON "ShardRebalance"("sourceShardId") WHERE "state" IN ('PENDING', 'EXECUTING');

-- The lifecycle vocabulary. Closed for the reason every state vocabulary in this schema is
-- closed: a state outside it has no transition rule, so a row carrying one is a row whose
-- forward path nobody decided (T2 — unknown is never permission).
ALTER TABLE "ShardRebalance" ADD CONSTRAINT "ShardRebalance_state_known"
  CHECK ("state" IN ('PENDING', 'EXECUTING', 'COMPLETED', 'CANCELLED'));

-- §19.2 has no operation that removes an agent from a shard without placing it in another,
-- because §3.5 requires every Agent to belong to exactly one shard at a time. An intent
-- whose source and target are the same shard would burn an `authority_epoch` per agent —
-- invalidating every mission authority each one holds — for a handoff that changed nothing.
ALTER TABLE "ShardRebalance" ADD CONSTRAINT "ShardRebalance_moves_between_two_shards"
  CHECK ("sourceShardId" <> "targetShardId");

-- A rebalance is never a placement. COMMISSIONING is `membership.place()`'s reason and is
-- exempt from advancing `authority_epoch` precisely because it supersedes no authority;
-- admitting it here would let an intent request a move that the
-- `ShardMembership_migration_advances_epoch` CHECK then refuses, one agent at a time,
-- forever.
ALTER TABLE "ShardRebalance" ADD CONSTRAINT "ShardRebalance_reason_known"
  CHECK ("reason" IN ('REBALANCE_SPLIT', 'REBALANCE_MERGE', 'REDISTRICTING', 'OPERATOR'));

-- The state the source shard is restored to must be one that admits new work. This is the
-- constraint that makes "no shard can be stranded" a property of the schema rather than of
-- the executor's diligence: whatever happens to this row — completed, cancelled, abandoned
-- and closed by an operator — the state it names is a serving state.
ALTER TABLE "ShardRebalance" ADD CONSTRAINT "ShardRebalance_restore_state_admits_work"
  CHECK ("restoreState" IN ('ACTIVE', 'REBALANCING'));

-- An intent that plans no move is not an intent. Recording one would move the source shard
-- out of ACTIVE for a plan with nothing in it — which is the stranding P13-R4 describes,
-- arrived at through an empty membership set instead of through a missing executor.
ALTER TABLE "ShardRebalance" ADD CONSTRAINT "ShardRebalance_plan_is_not_empty"
  CHECK ("plannedMoves" > 0);

-- Progress is a count of migrations that committed, so it cannot exceed the plan and cannot
-- go backwards past zero.
ALTER TABLE "ShardRebalance" ADD CONSTRAINT "ShardRebalance_completed_within_plan"
  CHECK ("completedMoves" >= 0 AND "completedMoves" <= "plannedMoves");

-- A closed intent has a closing instant, and an open one does not. Without this, a
-- COMPLETED row with no `closedAt` could not be aged, and an intent nobody is ageing is how
-- "this shard has been rebalancing for three days" becomes invisible — the same reasoning
-- `Shard_draining_is_timed` and `CrossRegionSaga_hold_is_timed` are written from.
ALTER TABLE "ShardRebalance" ADD CONSTRAINT "ShardRebalance_terminal_is_timed"
  CHECK (("state" IN ('COMPLETED', 'CANCELLED')) = ("closedAt" IS NOT NULL));

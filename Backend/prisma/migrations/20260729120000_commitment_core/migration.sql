-- Phase 3 — Commitment core.
--
-- §10 Commitment · §19.3/§19.5 single writer and leadership · §26 invariants
-- I1, I5, I6, I18, I19.
--
-- ── What this migration is for ──────────────────────────────────────────────
-- §10.3.2 requires two schema constraints to exist as **backstops**, "so that even
-- a defective code path cannot violate them silently":
--
--   * a partial unique index (or equivalent) enforcing at most
--     `capacity[agent_class]` active commitments per agent (invariant I1);
--   * a constraint admitting only HARD commitments (invariant I18).
--
-- The second landed with Phase 2 (`Commitment_kind_hard_only`) and is left exactly
-- as it is. This migration lands the first, plus the two tables the plan names:
-- `ShardLeadership` (guard G1's subject) and `AgentFenceAudit` (I6's persisted
-- high-water mark).
--
-- "Application logic and schema constraints are independent lines of defence, and
-- the schema one is the one that cannot be bypassed by a new call site."
--
-- ── Additive only ───────────────────────────────────────────────────────────
-- Nothing is dropped, renamed, or re-typed. The only statement touching a
-- pre-existing object is `ALTER TABLE "Commitment" ADD COLUMN "capacitySlot"`,
-- which is NOT NULL with a default and therefore requires no backfill. The
-- `Commitment` table is empty at the time this runs: nothing has written it since
-- Phase 2 created it.
--
-- Every CREATE TABLE and CREATE INDEX below is Prisma's own generated SQL for the
-- models in `schema.prisma`, taken verbatim from
-- `prisma migrate diff --from-empty --to-schema-datamodel`, so the hand-written
-- migration and the schema cannot disagree. The hand-written additions are the
-- ADD COLUMN, the partial unique index, the CHECK, the slot-bound trigger, and the
-- static shard row — each annotated below with the § that requires it.

-- ─────────────────────────────────────────────────────────────────────────────
-- (a) SHARD LEADERSHIP (§19.3, §19.5) — guard G1's subject
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "ShardLeadership" (
    "id" TEXT NOT NULL,
    "shardId" TEXT NOT NULL,
    "leadershipFence" BIGINT NOT NULL DEFAULT 0,
    "holder" TEXT,
    "leaseExpiry" TIMESTAMP(3),
    "lastAdvancedBy" TEXT,
    "lastAdvancedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShardLeadership_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- (b) AGENT FENCE AUDIT (§26 I6) — the persisted high-water mark
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "AgentFenceAudit" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "fenceHighWater" BIGINT NOT NULL DEFAULT 0,
    "epochHighWater" BIGINT NOT NULL DEFAULT 0,
    "lastFenceSource" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentFenceAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShardLeadership_shardId_key" ON "ShardLeadership"("shardId");

-- CreateIndex
CREATE INDEX "ShardLeadership_leaseExpiry_idx" ON "ShardLeadership"("leaseExpiry");

-- CreateIndex
CREATE UNIQUE INDEX "AgentFenceAudit_agentId_key" ON "AgentFenceAudit"("agentId");

-- CreateIndex
CREATE INDEX "AgentFenceAudit_observedAt_idx" ON "AgentFenceAudit"("observedAt");

-- ─────────────────────────────────────────────────────────────────────────────
-- (c) THE CAPACITY BACKSTOP (§10.3.2, invariant I1)
-- ─────────────────────────────────────────────────────────────────────────────

-- AlterTable
-- The capacity slot an active commitment occupies on its agent: an integer in
-- [0, capacity[agent_class]). NOT NULL with a default, so no backfill is needed and
-- no existing row can be left indeterminate.
ALTER TABLE "Commitment" ADD COLUMN "capacitySlot" INTEGER NOT NULL DEFAULT 0;

-- §10.3.2: "A partial unique index (or equivalent) enforcing at most
-- `capacity[agent_class]` active commitments per agent."
--
-- Keyed on (agent, slot) and predicated on the commitment still being active. Two
-- properties follow, and both are the reason this is an index rather than a
-- count-checking trigger:
--
--   1. It is immune to the interleaving in which two transactions each observe zero
--      active commitments and both insert. That interleaving is exactly the defect
--      §10.2 describes and exactly what a defective code path — one that failed to
--      take the agent row lock — would produce. A trigger that counts inherits the
--      hazard it is meant to catch.
--   2. It generalises to any `capacity` without a migration, which is what Phase 16e
--      needs ("Database migrations: None — schema already supports all of it").
CREATE UNIQUE INDEX "Commitment_agent_capacity_slot_active_key"
    ON "Commitment"("agentId", "capacitySlot")
    WHERE "releasedAt" IS NULL;

-- The slot's lower bound, in the schema rather than in the writer.
ALTER TABLE "Commitment"
    ADD CONSTRAINT "Commitment_capacity_slot_non_negative" CHECK ("capacitySlot" >= 0);

-- The slot's *upper* bound is `capacity[agent_class]`, which the Config Service
-- resolves (§22.2) and which the database therefore cannot read. The durable record
-- an `agent`-scope capacity binding is published from is `Agent.capacityOverride`
-- (Phase 2), and the register's structural default for `capacity` is 1 — the
-- singleton regime of §1.8 rule 3, which is the configuration the Tier 0 + Tier 1
-- engine ships in.
--
-- This trigger is therefore the second half of the backstop: the unique index bounds
-- *concurrency* per slot, and this bounds the *number of slots*. Together they are
-- "at most capacity[agent_class] active commitments per agent", enforced
-- independently of application logic.
--
-- Note what it deliberately does NOT do: it does not count. Counting would reopen
-- the interleaving the index closes. It compares one row's own slot against one
-- agent's own durable capacity, which is a decision no concurrent transaction can
-- invalidate.
CREATE OR REPLACE FUNCTION "commitment_capacity_slot_in_bounds"() RETURNS trigger AS $$
DECLARE
    "effective_capacity" INTEGER;
BEGIN
    IF NEW."releasedAt" IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT COALESCE("capacityOverride", 1) INTO "effective_capacity"
        FROM "Agent" WHERE "id" = NEW."agentId";

    IF "effective_capacity" IS NULL THEN
        RAISE EXCEPTION
            'Commitment % names agent % which does not exist (§10.3.2).',
            NEW."commitmentId", NEW."agentId";
    END IF;

    IF NEW."capacitySlot" >= "effective_capacity" THEN
        RAISE EXCEPTION
            'Commitment % would occupy capacity slot % on agent %, whose durable capacity is % (§10.3.2, invariant I1).',
            NEW."commitmentId", NEW."capacitySlot", NEW."agentId", "effective_capacity";
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Commitment_capacity_slot_in_bounds"
    BEFORE INSERT OR UPDATE ON "Commitment"
    FOR EACH ROW EXECUTE FUNCTION "commitment_capacity_slot_in_bounds"();

-- ─────────────────────────────────────────────────────────────────────────────
-- (d) THE STATIC SHARD ROW (execution plan §3 "PHASE 3", cycle C1)
-- ─────────────────────────────────────────────────────────────────────────────

-- > Phase 3 creates the `ShardLeadership` table with a **single static shard row and
-- > a manually-advanced fence**, and implements G1 against it. Phase 13 replaces the
-- > static row with real leader election. G1's code does not change.
--
-- The fence starts at 1, not 0: a fence of 0 and "no leadership record" would be
-- indistinguishable to a coordinator that read a default, and G1 must be able to
-- tell "the fence has not moved" from "there is no leadership".
INSERT INTO "ShardLeadership" ("id", "shardId", "leadershipFence", "holder", "lastAdvancedBy", "lastAdvancedAt", "createdAt", "updatedAt")
VALUES (
    'shard-leadership-default',
    'default',
    1,
    NULL,
    'migration:20260729120000_commitment_core',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("shardId") DO NOTHING;

-- Phase 6 — Feasibility gate: rejection telemetry (§7.7).
--
-- §7 feasibility · §7.5 the 38-predicate constraint register · §7.6 caching ·
-- §7.7 rejection reporting · §14.5 the F34 shortfall tiers · §26 invariants I9, I14.
--
-- ── What this migration is for ──────────────────────────────────────────────
-- §7.7 states the problem this phase's telemetry exists to remove:
--
--   > Every rejection is *evaluated* as the structured tuple `(agent_id, predicate_id,
--   > observed_value, required_value, input_source, observation_age)`. This is stricter
--   > than logging a message string, and it is what makes "why did the fleet reject this
--   > mission" **queryable rather than grep-able**.
--
-- The baseline's answer was `logger.dtaro`, a formatted allocation report emitted as a
-- log line. Two tables replace it, one per derived SLI:
--
--   (a) `RejectionAggregate` — the binding-constraint distribution per zone, mission
--       class, and Leg purpose, with the F34 binding tier in the key
--   (b) `NearMissSketch`     — the near-miss margin quantile sketch, per predicate and
--       per margin dimension
--
-- ── Exact over 100 % of decisions, and why the schema matters to that ───────
--   > **Aggregation happens at decision time; only the per-candidate rows are sampled.**
--   > … Aggregating first and sampling second is what allows full-fidelity capacity
--   > diagnostics and bounded write volume to hold simultaneously; **sampling first
--   > would degrade the histogram to an estimate and destroy exactly the property that
--   > makes it useful for capacity planning**.
--
-- Neither table is a sampled table. The engine folds tuples into in-memory histograms
-- during the round and the flusher upserts those counts here, so decision volume drives
-- no synchronous write and the counts stay exact. The unique keys below are what make a
-- re-run of a flush idempotent rather than double-counting — an at-least-once flusher
-- against a non-unique key would silently inflate exactly the SLI this table exists to
-- make trustworthy.
--
-- ── Additive only ───────────────────────────────────────────────────────────
-- Two new tables. Nothing is dropped, renamed, or re-typed; no existing column acquires
-- a constraint; no existing write path acquires a requirement. Rollback is `DROP TABLE`
-- on both, with no data loss outside them — the same treatment Phase 5 gave `Timer`,
-- `ReconcilerRepair`, and `VerificationEvidence`.
--
-- Every CREATE TABLE and CREATE INDEX below is Prisma's own generated SQL for the
-- models in `schema.prisma`, taken verbatim from
-- `prisma migrate diff --from-empty --to-schema-datamodel`, so the hand-written
-- migration and the schema cannot disagree. The hand-written additions are the two
-- CHECK constraints at the end, each annotated with the § that requires it.

-- ─────────────────────────────────────────────────────────────────────────────
-- (a) THE BINDING-CONSTRAINT DISTRIBUTION (§7.7 SLI 1)
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "RejectionAggregate" (
    "id" TEXT NOT NULL,
    "shardId" TEXT,
    "zoneId" TEXT,
    "missionClass" TEXT,
    "legPurpose" TEXT,
    "predicateId" TEXT NOT NULL,
    "tier" TEXT,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "bucketEnd" TIMESTAMP(3) NOT NULL,
    "count" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RejectionAggregate_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- (b) NEAR-MISS MARGINS (§7.7 SLI 2)
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "NearMissSketch" (
    "id" TEXT NOT NULL,
    "shardId" TEXT,
    "predicateId" TEXT NOT NULL,
    "marginUnit" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "bucketEnd" TIMESTAMP(3) NOT NULL,
    "buckets" JSONB NOT NULL,
    "total" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NearMissSketch_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateIndex
CREATE INDEX "RejectionAggregate_predicateId_bucketStart_idx" ON "RejectionAggregate"("predicateId", "bucketStart");

-- CreateIndex
CREATE INDEX "RejectionAggregate_zoneId_bucketStart_idx" ON "RejectionAggregate"("zoneId", "bucketStart");

-- CreateIndex
CREATE INDEX "RejectionAggregate_bucketStart_idx" ON "RejectionAggregate"("bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "RejectionAggregate_shardId_zoneId_missionClass_legPurpose_p_key" ON "RejectionAggregate"("shardId", "zoneId", "missionClass", "legPurpose", "predicateId", "tier", "bucketStart");

-- CreateIndex
CREATE INDEX "NearMissSketch_predicateId_bucketStart_idx" ON "NearMissSketch"("predicateId", "bucketStart");

-- CreateIndex
CREATE INDEX "NearMissSketch_bucketStart_idx" ON "NearMissSketch"("bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "NearMissSketch_shardId_predicateId_marginUnit_bucketStart_key" ON "NearMissSketch"("shardId", "predicateId", "marginUnit", "bucketStart");

-- ─────────────────────────────────────────────────────────────────────────────
-- SCHEMA BACKSTOPS
--
-- Both are application invariants first; they are restated here so they hold
-- independently of application logic, on the same argument §2.6's `kind = 'HARD'`
-- CHECK is made on.
-- ─────────────────────────────────────────────────────────────────────────────

-- §7.5 — the register holds exactly 38 predicates, named F1 … F38. A row naming
-- anything else is not a rejection this engine produced, and admitting one would let a
-- typo create a phantom binding constraint that no operator could trace to a predicate.
ALTER TABLE "RejectionAggregate"
    ADD CONSTRAINT "RejectionAggregate_predicateId_is_registered"
    CHECK ("predicateId" ~ '^F([1-9]|[12][0-9]|3[0-8])$');

ALTER TABLE "NearMissSketch"
    ADD CONSTRAINT "NearMissSketch_predicateId_is_registered"
    CHECK ("predicateId" ~ '^F([1-9]|[12][0-9]|3[0-8])$');

-- §7.7 — a margin is only interpretable in its own dimension: "a fleet routinely
-- failing F34 by 3 %" is a probability, and the same sketch fed metres and milliseconds
-- would produce a quantile with no meaning. The unit is therefore constrained to the
-- enumerated set `threeValued.MARGIN_UNIT` publishes, so a sketch cannot be written
-- under an unrecognised dimension.
ALTER TABLE "NearMissSketch"
    ADD CONSTRAINT "NearMissSketch_marginUnit_is_enumerated"
    CHECK ("marginUnit" IN ('count', 'ms', 'm', 'kg', 'Wh', 'prob', 'ratio', 'rank', 'degC'));

-- §7.7 — a bucket window is half-open `[bucketStart, bucketEnd)` and must be non-empty.
-- A zero-width or inverted window would make two flushes for the same dimensions
-- collide on the unique key while describing different periods.
ALTER TABLE "RejectionAggregate"
    ADD CONSTRAINT "RejectionAggregate_bucket_window_is_ordered"
    CHECK ("bucketEnd" > "bucketStart");

ALTER TABLE "NearMissSketch"
    ADD CONSTRAINT "NearMissSketch_bucket_window_is_ordered"
    CHECK ("bucketEnd" > "bucketStart");

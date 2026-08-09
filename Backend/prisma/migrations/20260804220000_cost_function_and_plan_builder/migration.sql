-- Phase 8 — Cost function and plan builder (§8, §13, §20.3 item 2).
--
-- §8.3.1 the λ_zone primitive · §6.4 Ω_terminal published with the surface ·
-- §13.2 the learned service-time model · §9.6 replay by pinned version.
--
-- ── What this migration is for ──────────────────────────────────────────────
-- Phase 8 delivers Φ and the Plan Builder. Almost none of that needs durable state:
-- every cost term is a pure function of a plan and a config snapshot, and the plan
-- itself is a round-local artefact (§13.1). Exactly two quantities are *learned* or
-- *published* rather than computed, and each gets one table:
--
--   (a) `ServiceTimeModel`  — §13.2's dwell distribution, learned per cohort
--   (b) `ZonePriceSnapshot` — §8.3.1's λ_zone surface, with §6.4's Ω_terminal alongside
--
-- ── Why the service-time cohorts are stored at every level ──────────────────
--   > Service time is *learned* per `(site, stop_type, mission_class, hour_of_week)` with
--   > hierarchical shrinkage to broader cohorts when data is sparse.
--
-- The four discriminators are nullable, and that is the hierarchy: a row with
-- `hourOfWeek IS NULL` is the cohort marginalised over the hour. The fitter writes one
-- row per level it can estimate and `plan/timeline.js` walks them broadest-first,
-- shrinking at each step. Storing only leaf cohorts would make the ladder
-- unreconstructable, and `sampleCount` is stored because it is the shrinkage weight's
-- numerator — a cohort fitted from three observations and one fitted from three
-- thousand must not be indistinguishable.
--
-- ── Why the price surface is insert-only ────────────────────────────────────
--   > Omega_terminal ... computed once per round from the same price snapshot the cost
--   > function uses (§8.3), published by the Capacity Pricing Service alongside the
--   > price surface, and recorded in the decision record.
--
-- A round pins `priceSnapshotVersion` and records it. A surface editable after a round
-- consumed it would make that round unreplayable (§9.6, ADR 21), so
-- `ZonePriceSnapshot` carries no `updatedAt` and is written by insert alone — the same
-- treatment Phase 7 gave `ChargerAvailabilityProjection`, and for the same reason.
--
-- `omegaTerminalCu` lives on the row rather than in configuration because §6.4's
-- admissibility argument is about the surface actually in use. A bound stored anywhere
-- it could be updated independently of the prices would eventually be a proof about a
-- surface nobody evaluated — which §6.4 calls "a false guarantee already written into
-- production decision records".
--
-- ── Additive only ───────────────────────────────────────────────────────────
-- Two new tables and two new foreign keys onto existing tables. Nothing is dropped,
-- renamed, or re-typed; no existing column acquires a constraint; no existing write
-- path acquires a requirement. Rollback is `DROP TABLE` on the two, with no data loss
-- outside them — the same treatment Phases 4 through 7 gave their own tables.
--
-- Every CREATE TABLE, CREATE INDEX, and ADD CONSTRAINT below is Prisma's own generated
-- SQL for the models in `schema.prisma`, taken verbatim from
-- `prisma migrate diff --from-empty --to-schema-datamodel`, so the hand-written
-- migration and the schema cannot disagree. The hand-written additions are the four
-- CHECK constraints at the end, each annotated with the section that requires it.

-- CreateTable
CREATE TABLE "ServiceTimeModel" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "siteId" TEXT,
    "stopType" TEXT,
    "missionClass" TEXT,
    "hourOfWeek" INTEGER,
    "meanSeconds" DOUBLE PRECISION NOT NULL,
    "sdSeconds" DOUBLE PRECISION NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "parentCohortKey" TEXT,
    "fittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceTimeModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZonePriceSnapshot" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "zoneId" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "bucketEnd" TIMESTAMP(3) NOT NULL,
    "lambdaCuPerSecond" DOUBLE PRECISION NOT NULL,
    "estimator" TEXT NOT NULL,
    "omegaTerminalCu" DOUBLE PRECISION NOT NULL,
    "forecastVersion" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "publishedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ZonePriceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServiceTimeModel_version_idx" ON "ServiceTimeModel"("version");

-- CreateIndex
CREATE INDEX "ServiceTimeModel_siteId_stopType_idx" ON "ServiceTimeModel"("siteId", "stopType");

-- CreateIndex
CREATE INDEX "ServiceTimeModel_stopType_missionClass_idx" ON "ServiceTimeModel"("stopType", "missionClass");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceTimeModel_version_siteId_stopType_missionClass_hourO_key" ON "ServiceTimeModel"("version", "siteId", "stopType", "missionClass", "hourOfWeek");

-- CreateIndex
CREATE INDEX "ZonePriceSnapshot_version_idx" ON "ZonePriceSnapshot"("version");

-- CreateIndex
CREATE INDEX "ZonePriceSnapshot_zoneId_bucketStart_idx" ON "ZonePriceSnapshot"("zoneId", "bucketStart");

-- CreateIndex
CREATE INDEX "ZonePriceSnapshot_publishedAt_idx" ON "ZonePriceSnapshot"("publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ZonePriceSnapshot_version_zoneId_bucket_key" ON "ZonePriceSnapshot"("version", "zoneId", "bucket");

-- AddForeignKey
ALTER TABLE "ServiceTimeModel" ADD CONSTRAINT "ServiceTimeModel_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZonePriceSnapshot" ADD CONSTRAINT "ZonePriceSnapshot_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

--------------------------------------------------------------------------------
-- Hand-written CHECK constraints. Prisma cannot express these, and each guards a
-- property the engine's correctness rests on rather than a data-hygiene preference.
--------------------------------------------------------------------------------

-- §8.3.3: the unavailability component of C_opportunity is non-negative **because**
-- lambda_zone >= 0, and that is exactly what leaves the whole term bounded below by
-- minus Omega_terminal alone. A negative lambda in the surface would make §6.4's
-- pruning bound inadmissible while the decision record still advertised a proof — the
-- failure mode §6.4 singles out as worse than having no bound at all.
ALTER TABLE "ZonePriceSnapshot"
  ADD CONSTRAINT "ZonePriceSnapshot_lambda_non_negative"
  CHECK ("lambdaCuPerSecond" >= 0);

-- §6.4: Omega_terminal is the *maximum achievable* terminal-value gain, a magnitude. It
-- is subtracted, so a negative value would raise the lower bound instead of lowering
-- it — turning the correction that keeps the bound admissible into one that breaks it.
ALTER TABLE "ZonePriceSnapshot"
  ADD CONSTRAINT "ZonePriceSnapshot_omega_terminal_non_negative"
  CHECK ("omegaTerminalCu" >= 0);

-- §8.3.1 names exactly three estimators and §5.2 requires the degraded one to be
-- flagged rather than inferred. A fourth value would be an estimator nobody specified,
-- and its rows would price the opportunity term by a method the decision record cannot
-- name.
ALTER TABLE "ZonePriceSnapshot"
  ADD CONSTRAINT "ZonePriceSnapshot_estimator_known"
  CHECK ("estimator" IN ('FORECAST_QUEUEING', 'SOLVER_DUAL_CALIBRATION', 'STATIC_PRIOR'));

-- §13.2 / §8.4: a service-time model with no dispersion tells the cost function that
-- every stop in that cohort is perfectly punctual, and p_late is priced from the ETA
-- predictive distribution rather than the point estimate. A negative mean or dispersion
-- is not a fast site — it is a fit that did not converge, and storing one would
-- silently favour every agent routed through it.
ALTER TABLE "ServiceTimeModel"
  ADD CONSTRAINT "ServiceTimeModel_distribution_well_formed"
  CHECK ("meanSeconds" >= 0 AND "sdSeconds" >= 0 AND "sampleCount" >= 0);

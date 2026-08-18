-- Phase 8 remediation — §13.2's shrinkage ladder IS the NULL pattern, so the cohort key
-- must treat an absent discriminator as a value, not as an unknown.
--
-- `ServiceTimeModel`'s unique key spans five columns, four of which are nullable and are
-- NULL by design: a row with `hourOfWeek IS NULL` is the cohort marginalised over the
-- hour, a row with every discriminator NULL is the global cohort. That hierarchy is not
-- incidental — `workers/serviceTimeModel.worker.js` writes one row per level it can
-- estimate and `plan/timeline.serviceTimeFor()` walks them broadest-first, which is what
-- makes §13.2's "hierarchical shrinkage to broader cohorts when data is sparse" work.
--
-- PostgreSQL's UNIQUE default is NULLS DISTINCT, so two rows that both say "every
-- discriminator absent" do not collide. Live verification against PostgreSQL 18.3
-- (`tools/verify/phase8LiveDatabase.js`) confirmed the index as shipped is NULLS
-- DISTINCT and that a duplicate broad cohort is ACCEPTED. The consequence is a §9.6
-- replay defect rather than a tidiness one:
--
--   `loadVersion()` reads a pinned version with `findMany({ where: { version } })` — no
--   ORDER BY — and assigns `models[key] = row` as it goes, so with two rows claiming one
--   cohort key the surviving service-time distribution is whichever row PostgreSQL
--   happened to return last. Two loads of the *same pinned model version* can therefore
--   produce different dwell times, hence a different timeline, a different `Φ`, and a
--   different allocation. §9.6 requirement 6 pins the model version precisely so that
--   this cannot happen, and the pin does not deliver it while the key does not bind.
--
--   The duplicate is reachable: `fit()` takes its `version` from the caller with no
--   check that the version is unused, and its write loop catches a per-row failure and
--   continues, so a retry of a partially-failed fit at the same version re-creates every
--   row — refused by the unique index for the fully-specified cohorts, and silently
--   duplicated for exactly the broad ones the ladder falls back to.
--
-- The key is therefore redeclared NULLS NOT DISTINCT: in this table an absent
-- discriminator is a determinate fact about the cohort ("this row is marginalised over
-- the hour"), not missing information, and two rows that agree on all five belong to one
-- cohort. This is the same defect, and the same repair, that Phase 6 applied to
-- `RejectionAggregate` in `20260817120000_rejection_aggregate_nulls_not_distinct`.
--
-- ── Existing rows ───────────────────────────────────────────────────────────
-- Tightening a unique key fails outright if the table already holds rows the new key
-- considers duplicates, so any duplicate group is reduced first. Unlike Phase 6's
-- counters, two fits of one cohort cannot be folded by summation — a mean and a standard
-- deviation are not additive — so the group's **best-supported** row is kept: the
-- greatest `sampleCount` (§13.2's shrinkage weight is that count, so the largest is the
-- least-shrunk estimate), then the most recent `fittedAt`, then the least `id` as a
-- deterministic final tie-break. Nothing of value is lost: `loadVersion()` was already
-- discarding all but one row of each such group, and this makes the choice deterministic
-- and explicit rather than dependent on physical row order.
--
-- Beyond that reduction this migration is non-destructive: no column is dropped, no
-- table is rewritten, and the unique index is replaced in place by its NULLS NOT
-- DISTINCT equivalent over the identical column list. Requires PostgreSQL 15+.

DELETE FROM "ServiceTimeModel" AS victim
USING (
  SELECT "id",
         ROW_NUMBER() OVER (
           PARTITION BY "version", "siteId", "stopType", "missionClass", "hourOfWeek"
           ORDER BY "sampleCount" DESC, "fittedAt" DESC, "id" ASC
         ) AS ordinal
  FROM "ServiceTimeModel"
) AS ranked
WHERE victim."id" = ranked."id" AND ranked.ordinal > 1;

DROP INDEX IF EXISTS "ServiceTimeModel_version_siteId_stopType_missionClass_hourO_key";

ALTER TABLE "ServiceTimeModel"
  DROP CONSTRAINT IF EXISTS "ServiceTimeModel_version_siteId_stopType_missionClass_hourO_key";

CREATE UNIQUE INDEX "ServiceTimeModel_version_siteId_stopType_missionClass_hourO_key"
  ON "ServiceTimeModel" ("version", "siteId", "stopType", "missionClass", "hourOfWeek")
  NULLS NOT DISTINCT;

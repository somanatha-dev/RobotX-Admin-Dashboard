-- Phase 6 remediation — §7.7's aggregation key must treat an absent dimension as a
-- value, not as an unknown.
--
-- `RejectionAggregate`'s unique key spans seven dimensions, four of which are nullable
-- and are NULL in the common case: only F34 carries a `tier`, and `zoneId`,
-- `missionClass` and `legPurpose` are absent whenever the decision did not supply them.
--
-- PostgreSQL's UNIQUE default is NULLS DISTINCT, so two rows that both say "no zone,
-- no tier" do not collide. That has two consequences, and the second is the defect:
--
--   1. one logical bucket can fragment into many rows, and the constraint that exists
--      to prevent exactly that does not apply to the rows that need it most;
--   2. `rejectionAggregation.worker.js` addresses the row through this key, and a
--      compound-unique lookup containing NULL is refused outright by the client
--      ("Argument `tier` must not be null"). The flush therefore *throws* rather than
--      accumulating, for 37 of the 38 predicates.
--
-- §7.7 requires the two derived SLIs be exact over **100 % of decisions**. A flusher
-- that cannot write the rows for 37 predicates does not satisfy that, so the key is
-- redeclared NULLS NOT DISTINCT: in this table an absent dimension is a determinate
-- fact about the rejection ("this rejection had no zone"), not missing information, and
-- two rejections that agree on all seven dimensions belong in one bucket.
--
-- ── Existing rows ───────────────────────────────────────────────────────────
-- Tightening a unique key fails outright if the table already holds rows that the new
-- key considers duplicates, so the duplicates are folded first. Folding, not deleting:
-- the surviving row takes the SUM of the group's counts and the widest bucket window,
-- which is precisely the row a working flusher would have produced for that group. No
-- count is lost, which is what §7.7's exactness requirement demands even of a repair.
--
-- Beyond that this migration is non-destructive: no column is dropped, no table is
-- rewritten, and the unique index is replaced in place by its NULLS NOT DISTINCT
-- equivalent over the identical column list. Requires PostgreSQL 15+.

WITH grouped AS (
  SELECT
    min("id")            AS keep_id,
    SUM("count")         AS total_count,
    MAX("bucketEnd")     AS widest_bucket_end,
    COUNT(*)             AS group_size
  FROM "RejectionAggregate"
  GROUP BY "shardId", "zoneId", "missionClass", "legPurpose", "predicateId", "tier", "bucketStart"
  HAVING COUNT(*) > 1
)
UPDATE "RejectionAggregate" AS target
SET "count"     = grouped.total_count,
    "bucketEnd" = grouped.widest_bucket_end,
    "updatedAt" = CURRENT_TIMESTAMP
FROM grouped
WHERE target."id" = grouped.keep_id;

DELETE FROM "RejectionAggregate" AS victim
USING (
  SELECT "id",
         ROW_NUMBER() OVER (
           PARTITION BY "shardId", "zoneId", "missionClass", "legPurpose", "predicateId", "tier", "bucketStart"
           ORDER BY "id"
         ) AS ordinal
  FROM "RejectionAggregate"
) AS ranked
WHERE victim."id" = ranked."id" AND ranked.ordinal > 1;

DROP INDEX IF EXISTS "RejectionAggregate_shardId_zoneId_missionClass_legPurpose_p_key";

ALTER TABLE "RejectionAggregate"
  DROP CONSTRAINT IF EXISTS "RejectionAggregate_shardId_zoneId_missionClass_legPurpose_p_key";

CREATE UNIQUE INDEX "RejectionAggregate_shardId_zoneId_missionClass_legPurpose_p_key"
  ON "RejectionAggregate" ("shardId", "zoneId", "missionClass", "legPurpose", "predicateId", "tier", "bucketStart")
  NULLS NOT DISTINCT;

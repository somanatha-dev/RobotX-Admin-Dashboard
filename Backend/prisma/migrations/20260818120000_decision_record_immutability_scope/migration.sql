-- PHASE 11 REMEDIATION — scope `DecisionRecordA`'s immutability to the DECISION,
-- so that §21.2's own retention and sampling paths can execute.
--
-- ── The defect, reproduced on a live PostgreSQL ─────────────────────────────
-- `20260728140000_domain_model_and_spatial_hierarchy` installed
-- `DecisionRecordA_immutable`, a BEFORE UPDATE trigger that refuses **every** UPDATE:
--
--     RAISE EXCEPTION 'DecisionRecordA is immutable (§21.2); % is refused on decision %.'
--
-- That is the right guarantee for §21.2's sentence — "One **immutable** record per
-- decision round, per Leg" — and it was correct when it landed, because nothing updated
-- the table. Phase 11 then added three columns that are, by their own design, written
-- *after* the row exists, and two production paths that write them. Neither path can run:
--
--   1. `workers/tierB.worker.js` `flushReservoir()` marks a decision whose Tier B record
--      the reservoir wrote a window later:
--          decisionRecordA.updateMany({ data: { tierBWritten: true, tierBReason: … } })
--      On a real database this raises P0001 and the whole flush throws. Every exempt
--      Tier B record the reservoir holds is therefore lost, and §21.2's "retention
--      degrades visibly and uniformly rather than by arrival order" degrades invisibly
--      and totally instead.
--
--   2. `DecisionRecordA_inputSnapshotId_fkey` is `ON DELETE SET NULL`, and SET NULL is an
--      UPDATE. Expiring an `InputSnapshot` therefore fails outright rather than leaving
--      the Tier A record standing and visibly unreplayable. §24.3 makes "a decision whose
--      Tier A record is retained but whose input snapshot has expired" a defect that must
--      be *detectable*; this made the state unreachable by making retention impossible,
--      which is not the same thing as making it correct. `observability/decisionRecord.js`
--      computes a `snapshotUntil` for every row, so the retention policy is real and its
--      execution path is blocked.
--
-- Both were invisible to the whole test suite because the in-memory Prisma double has no
-- triggers, and invisible to schema review because the trigger and the two paths are in
-- different migrations written seven phases apart. `tools/verify/phase11LiveDatabase.js`
-- is what reaches them.
--
-- ── What this changes, and what it deliberately does not ────────────────────
-- The immutability guarantee is UNCHANGED for everything that constitutes the decision.
-- What changes is that three named bookkeeping columns become writable under directional
-- guards, and nothing else does.
--
-- The comparison is an ALLOWLIST subtracted from the whole row, not an enumeration of the
-- protected columns, and that direction is the point: a column added to this table in a
-- later phase is immutable by default and has to be named here to become otherwise. The
-- opposite formulation — listing the protected columns — would silently admit every
-- future column.
--
-- The three directional guards are what stop the allowlist from being a hole:
--   · `tierBWritten` may go false → true and never back. Evidence is added, never removed.
--   · `tierBReason` must accompany a written Tier B (the CHECK says so too; a trigger that
--     disagreed with a CHECK would be a second opinion about the same rule).
--   · `inputSnapshotId` may only be cleared. Re-pointing a stored decision at a different
--     snapshot would silently change what it replays against, which is the one edit that
--     would defeat §24.3 while leaving every hash intact.
--
-- DELETE stays outside the trigger, exactly as before: §21.2's retention is a deletion
-- path and the specification attaches no immutability requirement to deletion.

CREATE OR REPLACE FUNCTION "decision_record_is_immutable"() RETURNS trigger AS $$
DECLARE
    -- §21.2's post-write bookkeeping. Everything not named here is the decision.
    mutable text[] := ARRAY['inputSnapshotId', 'tierBWritten', 'tierBReason'];
BEGIN
    IF TG_OP <> 'UPDATE' THEN
        RAISE EXCEPTION
            'DecisionRecordA is immutable (§21.2); % is refused on decision %.',
            TG_OP, COALESCE(OLD."decisionId", NEW."decisionId");
    END IF;

    IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
        RAISE EXCEPTION
            'DecisionRecordA is immutable (§21.2); the decision recorded for % may not be edited. Only %  may be written after the row exists, and this UPDATE changed something else.',
            COALESCE(OLD."decisionId", NEW."decisionId"), array_to_string(mutable, ', ');
    END IF;

    IF OLD."tierBWritten" AND NOT NEW."tierBWritten" THEN
        RAISE EXCEPTION
            'DecisionRecordA.tierBWritten may not be un-set on % (§21.2): a Tier B record that existed cannot be made never to have existed.',
            COALESCE(OLD."decisionId", NEW."decisionId");
    END IF;

    IF NEW."tierBWritten" AND NEW."tierBReason" IS NULL THEN
        RAISE EXCEPTION
            'DecisionRecordA.tierBReason is required whenever tierBWritten on % (§21.2): a shed exempt decision must stay distinguishable from an unsampled one.',
            COALESCE(OLD."decisionId", NEW."decisionId");
    END IF;

    IF NEW."inputSnapshotId" IS NOT NULL AND NEW."inputSnapshotId" IS DISTINCT FROM OLD."inputSnapshotId" THEN
        RAISE EXCEPTION
            'DecisionRecordA.inputSnapshotId may only be CLEARED on % (§24.3): re-pointing a stored decision at different pinned inputs changes what it replays against while every hash still matches.',
            COALESCE(OLD."decisionId", NEW."decisionId");
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

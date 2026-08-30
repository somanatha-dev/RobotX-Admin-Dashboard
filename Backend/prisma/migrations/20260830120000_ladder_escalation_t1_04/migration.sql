-- REMEDIAL PHASE T1-04 — §17.4's anti-starvation escalation ladder, made durable.
--
-- ── Why this migration exists ───────────────────────────────────────────────
-- §17.4 is where §1.8 places the anti-starvation *guarantee* (Tier 1, invariant I13). It
-- states two obligations that no existing table can carry:
--
--   > Ladder steps are each triggered by an elapsed fraction of the SLA budget, each
--   > individually configurable, each **recorded** with what was relaxed and why.
--
--   > Human escalation capacity is modelled explicitly as `ops.escalation_capacity`,
--   > scoped per region — the concurrent escalations the on-call dispatch function can
--   > actually hold — with the current outstanding count as a first-class SLI.
--
-- The *step number* is derivable — §26.1's I13 instrument is literally "queue age audit
-- versus ladder step", and `observability/invariantChecker.js` already computes the queue
-- half from `WorkQueue.enqueuedAt` against `sla.assignment_deadline`. Two things are not
-- derivable, and both are load-bearing:
--
--   1. **What was relaxed and why.** The round is the consumer of a relaxation and needs
--      the published tokens, not a reconstruction.
--   2. **Whether a step-7 escalation ever reached a human.** §17.4 is explicit that this
--      is the difference between an escalation and a false claim of one:
--
--        > A Leg that "reached step 7" without a human ever seeing it has not been
--        > escalated, and recording otherwise would make the ladder's guarantee false in
--        > exactly the conditions it exists for.
--
--      That is why `admittedAt` is nullable and separate from `reachedAt`. A held Leg has
--      reached the rung and has not been escalated, and the schema can say so.
--
-- `src/engine/observability/metrics.js` already declares `outstanding_escalations` and
-- `escalation_saturation_time` as `SOURCE.DURABLE` with producer "escalation ladder", and
-- left them unwired with the reason "`src/engine/fairness/` still holds no ladder". This
-- table is the rows those two readings were always going to be taken from.
--
-- ── Additive, and additive in the strict sense ──────────────────────────────
-- **One new table. No existing table gains, loses, or alters a column, and no applied
-- migration file is edited.** The relation this adds to `Leg` is a back-relation, which
-- Prisma resolves without a column, so `CREATE TABLE "Leg"` in
-- `20260728140000_domain_model_and_spatial_hierarchy/migration.sql` stays byte-identical
-- and that migration's checksum is untouched.
--
-- The CREATE TABLE, the indexes and the foreign key are taken verbatim from
-- `prisma migrate diff --from-empty --to-schema-datamodel`, so the hand-written file and
-- `schema.prisma` cannot silently disagree. The CHECK constraints at the foot are
-- hand-written — Prisma cannot express them — and each is a §17.4 sentence the
-- application layer also enforces. Both halves, deliberately: a schema backstop is the
-- half that survives a bug in the half above it.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. `LadderEscalation` — one row per (Leg, ladder step) reached.
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "LadderEscalation" (
    "id" TEXT NOT NULL,
    "legId" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "relaxations" JSONB NOT NULL,
    "cause" TEXT NOT NULL,
    "queueAgeSeconds" INTEGER NOT NULL,
    "budgetSeconds" INTEGER NOT NULL,
    "elapsedFraction" DOUBLE PRECISION NOT NULL,
    "regionId" TEXT,
    "shardId" TEXT,
    "slaClass" TEXT,
    "reachedAt" TIMESTAMP(3) NOT NULL,
    "humanStep" BOOLEAN NOT NULL DEFAULT false,
    "admittedAt" TIMESTAMP(3),
    "heldReason" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LadderEscalation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LadderEscalation_legId_idx" ON "LadderEscalation"("legId");

-- CreateIndex
CREATE INDEX "LadderEscalation_step_idx" ON "LadderEscalation"("step");

-- CreateIndex
CREATE INDEX "LadderEscalation_regionId_humanStep_resolvedAt_idx" ON "LadderEscalation"("regionId", "humanStep", "resolvedAt");

-- CreateIndex
CREATE INDEX "LadderEscalation_regionId_admittedAt_idx" ON "LadderEscalation"("regionId", "admittedAt");

-- CreateIndex
CREATE INDEX "LadderEscalation_shardId_reachedAt_idx" ON "LadderEscalation"("shardId", "reachedAt");

-- CreateIndex
CREATE UNIQUE INDEX "LadderEscalation_legId_step_key" ON "LadderEscalation"("legId", "step");

-- AddForeignKey
ALTER TABLE "LadderEscalation" ADD CONSTRAINT "LadderEscalation_legId_fkey" FOREIGN KEY ("legId") REFERENCES "Leg"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The CHECK constraints — §17.4's sentences, in the schema.
-- ─────────────────────────────────────────────────────────────────────────────

-- §17.4's table has exactly eight rungs. A ninth is not a configuration choice; it is a
-- ladder the specification does not describe and the round would not know how to consume.
ALTER TABLE "LadderEscalation" ADD CONSTRAINT "LadderEscalation_step_in_range"
  CHECK ("step" >= 1 AND "step" <= 8);

-- The action vocabulary is §17.4's own, and it is closed for the same reason the step
-- range is: the relaxation order is *published configuration* ("operations knows in
-- advance exactly what the system will sacrifice under pressure and in what order"), and
-- a published order that admits an unpublished token is not published.
ALTER TABLE "LadderEscalation" ADD CONSTRAINT "LadderEscalation_action_known"
  CHECK ("action" IN (
    'WIDEN_SEARCH_RADIUS',
    'ADMIT_FINISHING_SOON_AND_CHARGING_INTERRUPTIBLE',
    'RELAX_CLASS_P_SOFT_CONSTRAINTS',
    'PERMIT_PREEMPTION',
    'REQUEST_CROSS_REGION_CANDIDATES',
    'MANUFACTURE_SUPPLY',
    'ESCALATE_TO_HUMAN_DISPATCHER',
    'ALTERNATIVE_MODALITY_OR_DECLINE'
  ));

-- Steps 7 and 8 are the two that "route to people". Marking any other step as human work
-- would inflate the outstanding count that `ops.escalation_capacity` is compared against,
-- which is the one number the ladder's last two rungs are sized by.
ALTER TABLE "LadderEscalation" ADD CONSTRAINT "LadderEscalation_human_steps_are_seven_and_eight"
  CHECK ("humanStep" = ("step" >= 7));

-- §17.4: "Legs waiting to enter it remain on the ladder rather than being deemed to have
-- completed step 7." A row is therefore *either* admitted *or* held with a stated reason,
-- never both and never neither while it is a human step. Steps 1–6 are neither.
ALTER TABLE "LadderEscalation" ADD CONSTRAINT "LadderEscalation_admitted_xor_held"
  CHECK (
    ("humanStep" = false AND "admittedAt" IS NULL AND "heldReason" IS NULL)
    OR ("humanStep" = true AND (("admittedAt" IS NOT NULL) <> ("heldReason" IS NOT NULL)))
  );

-- An escalation cannot stop being outstanding before it started being one. Without this a
-- clock skew or a mis-ordered write produces a negative interval, and every saturation
-- reading taken over that interval is silently wrong rather than visibly absent.
ALTER TABLE "LadderEscalation" ADD CONSTRAINT "LadderEscalation_resolution_follows_admission"
  CHECK ("resolvedAt" IS NULL OR ("admittedAt" IS NOT NULL AND "resolvedAt" >= "admittedAt"));

-- A resolution states how it ended. `resolvedAt` with no outcome is the "closed, cause
-- unknown" row that makes an escalation audit unanswerable.
ALTER TABLE "LadderEscalation" ADD CONSTRAINT "LadderEscalation_resolution_is_explained"
  CHECK (("resolvedAt" IS NULL) = ("outcome" IS NULL));

ALTER TABLE "LadderEscalation" ADD CONSTRAINT "LadderEscalation_outcome_known"
  CHECK ("outcome" IS NULL OR "outcome" IN ('ASSIGNED', 'TERMINAL', 'DECLINED'));

-- The two halves of §26.1's I13 instrument, on the row that reached the rung. A step
-- recorded against a zero or negative budget has no elapsed *fraction* at all, and a
-- fraction that is NaN or infinite is a division that should have refused rather than
-- been stored.
ALTER TABLE "LadderEscalation" ADD CONSTRAINT "LadderEscalation_budget_is_positive"
  CHECK ("budgetSeconds" > 0);

ALTER TABLE "LadderEscalation" ADD CONSTRAINT "LadderEscalation_queue_age_is_not_negative"
  CHECK ("queueAgeSeconds" >= 0);

ALTER TABLE "LadderEscalation" ADD CONSTRAINT "LadderEscalation_elapsed_fraction_is_finite_and_not_negative"
  CHECK (
    "elapsedFraction" >= 0
    AND "elapsedFraction" <> 'NaN'::double precision
    AND "elapsedFraction" <> 'Infinity'::double precision
  );

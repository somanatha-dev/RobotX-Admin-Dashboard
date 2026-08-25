-- PHASE 15 REMEDIATION (P15-C4) — the audit stream admits the events the cutover writes.
--
-- ── The defect ──────────────────────────────────────────────────────────────
-- `src/engine/cutover/stage.js`'s `auditEventFor()` has always emitted two event types:
--
--     CUTOVER_SHARD_ENABLED       when a shard is taken live
--     CUTOVER_SHARD_ROLLED_BACK   when one is rolled back
--
-- and `src/engine/cutover/store.js` has always read them back — `declarationFor()` finds a
-- shard's pre-declared SLI guardrails by querying §21.7's stream for exactly these two
-- types. Neither name was ever added to `auditStream.EVENT_TYPE`, and neither was ever
-- added to this CHECK constraint. Both layers refused every cutover event:
--
--     auditStream.append(...)  -> '"CUTOVER_SHARD_ENABLED" is not one of the audit
--                                  stream's event types'
--     raw INSERT               -> ERROR 23514: new row for relation "AuditEvent" violates
--                                  check constraint "AuditEvent_event_type_known"
--
-- ── Why this is worth a migration rather than a log line ────────────────────
-- The pre-declaration is not decoration. §22.4 item 4 stages by shard "monitored against
-- pre-declared SLI guardrails, with automatic rollback", and the audit stream is where the
-- ordering — declared BEFORE live — is recorded somewhere nobody can edit afterwards.
--
-- With no row able to exist, `store.declarationFor()` returned NULL for every shard, always.
-- `cutover.worker.assessShard()` treats a null declaration as a finding and returns HOLD
-- without assessing:
--
--     "live with no pre-declared guardrails. stage.authoriseEnable refuses this, so the
--      shard was enabled outside the authorised path (§22.4 item 4)."
--
-- So the staged-rollout controller could never assess a single shard, and the automatic
-- rollback could never fire — on a deployment where the publisher, the guardrail evaluator,
-- the controller and its composition were all correct and all wired. Phase 15's previous
-- remediation (P15-R1) fixed the publisher that this controller calls; the controller could
-- never reach it.
--
-- ── Additive, and additive in the strict sense ──────────────────────────────
-- No table is created, dropped or altered. No column changes type, nullability or default.
-- No row is read, written or migrated. One CHECK constraint is replaced by the same
-- constraint with two additional permitted values, which is a strict widening: every row
-- admissible before is admissible after, and `AuditEvent` is append-only so no existing row
-- can be invalidated by it.
--
-- The constraint is kept rather than dropped, for the reason the original migration gives
-- in its own words: "an append-only stream that accepts an unrecognised event type accepts
-- an event nobody defined the meaning of, which is the one thing a non-repudiation record
-- may not do." Widening the vocabulary is the fix; removing the vocabulary is not.
--
-- `tests/engine/phase15EvidenceBindingRemediation.test.js` pins this list to
-- `auditStream.EVENT_TYPE`, so the two cannot drift apart again — which is the actual root
-- cause here, and the reason a third copy of the vocabulary is not being introduced.

ALTER TABLE "AuditEvent" DROP CONSTRAINT "AuditEvent_event_type_known";

ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_event_type_known"
  CHECK ("eventType" IN (
    'OPERATOR_ACTION',
    'OVERRIDE',
    'CONFIG_CHANGE',
    'QUARANTINE',
    'CONSTRAINT_RELAXATION',
    'MANUAL_ASSIGNMENT',
    'CANCELLATION',
    'DEGRADED_MODE',
    'TIER_B_SHEDDING',
    'CUTOVER_SHARD_ENABLED',
    'CUTOVER_SHARD_ROLLED_BACK'
  ));

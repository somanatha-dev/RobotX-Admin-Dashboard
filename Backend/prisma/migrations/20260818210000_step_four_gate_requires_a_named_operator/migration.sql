-- PHASE 12 REMEDIATION — §18.6 step 4's human gate must name a *human*, not a non-empty column.
--
-- `PHASE_12_IMPLEMENTATION_REPORT.md` §5 calls `ExternalEscalation_step_four_is_human_gated`
-- "the third of three independent enforcement points for §18.6's human gate … the one a future
-- writer cannot route around by calling a different function", and
-- `PHASE_12_INDEPENDENT_VERIFICATION.md` §2 confirms it by reading the migration SQL.
--
-- Live execution against a disposable PostgreSQL 18.3 cluster
-- (`tools/verify/phase12LiveDatabase.js`, check G2) found that the constraint as written —
-- `"step" <> 4 OR "operatorId" IS NOT NULL` — **accepts** a step-4 row whose `operatorId` is the
-- empty string. An empty string is not a named operator. So the third enforcement point could in
-- fact be routed around, by any writer that supplied `''`, and the claim that the schema is the
-- layer a future edit cannot evade was true of NULL and not true of absence in general.
--
-- Reading the DDL could not have found this: the constraint's text is correct about NULL, and
-- what is wrong is what NULL does not cover. Only inserting the row settles it.
--
-- §18.6: "automatic calls to emergency services are not an appropriate output of an allocation
-- engine, and a false positive has real external cost." The whole purpose of this row is to make
-- a person accountable for that call afterwards; a row naming '' is a call nobody authorised
-- wearing an authorisation.
--
-- `btrim` is deliberate rather than a bare length check: '   ' names no operator either, and a
-- gate that a space defeats is a gate.
--
-- Additive and idempotent in effect: the constraint is replaced by a strictly stronger one over
-- the same column. Every row the old constraint admitted and the new one refuses is a row §18.6
-- forbids. No column is added, dropped or altered.

ALTER TABLE "ExternalEscalation" DROP CONSTRAINT "ExternalEscalation_step_four_is_human_gated";

ALTER TABLE "ExternalEscalation" ADD CONSTRAINT "ExternalEscalation_step_four_is_human_gated"
  CHECK ("step" <> 4 OR ("operatorId" IS NOT NULL AND btrim("operatorId") <> ''));

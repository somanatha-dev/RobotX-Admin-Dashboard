-- ROLLBACK for migration 20261005180000_schema_cleanup_stage1.
--
-- NOT a migration (deliberately outside prisma/migrations/). Run it by hand, e.g.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/rollback/20261005180000_schema_cleanup_stage1.sql
--
-- ORDER: run this BEFORE rolling application code back. The pre-cleanup build's boot check
-- (src/db/schemaDrift.js) refuses a database without these tables (DATABASE_SCHEMA_BEHIND,
-- 36 columns) — that refusal is the cue to run this first.
--
-- Every statement is copied from the DDL of the migration that first created the object:
--   Decision, DecisionAction ............ 20260402190740_init
--   OperatingRegime, OperatingRegimeState 20260728093000_config_registry_and_governance
--   PackingResultCache (+ its CHECK) .... 20260804180000_energy_and_payload_models
--   each index ........................... the migration that created it
-- The tables come back empty: they held 0 rows in production when stage 1 was approved.
-- Verified on a disposable database: after this script, the schema diff against the
-- pre-cleanup schema.prisma shows only the pre-existing ConfigActiveVersion_version_fkey line,
-- and the pre-cleanup build's boot check passes.
--
-- If the migration ledger is in use (prisma migrate deploy), also remove the stage-1 row so a
-- later deploy re-applies it deliberately rather than believing it is still applied:
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261005180000_schema_cleanup_stage1';

CREATE TYPE "DecisionAction" AS ENUM ('WAIT', 'REROUTE', 'CANCEL');
CREATE TABLE "Decision" (
    "id" TEXT NOT NULL,
    "robotId" TEXT NOT NULL,
    "taskId" TEXT,
    "reason" TEXT NOT NULL,
    "imageUrl" TEXT,
    "action" "DecisionAction",
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Decision_robotId_idx" ON "Decision"("robotId");
CREATE INDEX "Decision_taskId_idx" ON "Decision"("taskId");
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_robotId_fkey" FOREIGN KEY ("robotId") REFERENCES "Robot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TYPE "OperatingRegimeState" AS ENUM ('INACTIVE', 'PROPOSED_ENTRY', 'ACTIVE', 'PROPOSED_EXIT');
CREATE TABLE "OperatingRegime" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "triggerCondition" JSONB NOT NULL,
    "parameterDeltas" JSONB NOT NULL,
    "entryCriteria" TEXT NOT NULL,
    "exitCriteria" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "state" "OperatingRegimeState" NOT NULL DEFAULT 'INACTIVE',
    "calibrationStatus" "CalibrationStatus" NOT NULL DEFAULT 'UNCALIBRATED',
    "proposedAt" TIMESTAMP(3),
    "confirmedBy" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "exitedAt" TIMESTAMP(3),
    "history" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OperatingRegime_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OperatingRegime_name_key" ON "OperatingRegime"("name");
CREATE INDEX "OperatingRegime_state_idx" ON "OperatingRegime"("state");

CREATE TABLE "PackingResultCache" (
    "id" TEXT NOT NULL,
    "containerConfig" TEXT NOT NULL,
    "itemSignature" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "tier" INTEGER,
    "bindingConstraint" TEXT,
    "thermalAssignment" JSONB,
    "compartmentLoads" JSONB,
    "loadingPlan" JSONB,
    "nodesExplored" INTEGER,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    CONSTRAINT "PackingResultCache_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PackingResultCache_expiresAt_idx" ON "PackingResultCache"("expiresAt");
CREATE UNIQUE INDEX "PackingResultCache_containerConfig_itemSignature_key" ON "PackingResultCache"("containerConfig", "itemSignature");
ALTER TABLE "PackingResultCache" ADD CONSTRAINT "PackingResultCache_verdict_decided" CHECK ("verdict" IN ('FEASIBLE', 'INFEASIBLE'));

CREATE INDEX "Robot_locationId_idx" ON "Robot"("locationId");
CREATE INDEX "Compartment_containerModelId_idx" ON "Compartment"("containerModelId");
CREATE INDEX "Capability_bundleId_idx" ON "Capability"("bundleId");
CREATE INDEX "Leg_missionId_idx" ON "Leg"("missionId");
CREATE INDEX "Stop_legId_idx" ON "Stop"("legId");
CREATE INDEX "EnergyModelParams_agentClassId_idx" ON "EnergyModelParams"("agentClassId");
CREATE INDEX "ServiceTimeModel_version_idx" ON "ServiceTimeModel"("version");
CREATE INDEX "ZonePriceSnapshot_version_idx" ON "ZonePriceSnapshot"("version");
CREATE INDEX "LadderEscalation_legId_idx" ON "LadderEscalation"("legId");
CREATE INDEX "Robot_lat_lon_idx" ON "Robot"("lat", "lon");

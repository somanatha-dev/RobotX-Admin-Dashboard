-- Phase 2 — Domain model and schema.
--
-- §2 Domain Model · §3.6 Spatial concepts and their containment ·
-- §4.2 Task state machine · §4.3 Leg state machine · §15 Payload · §21.2 Tier A.
--
-- ── Additive only ───────────────────────────────────────────────────────────
-- Nothing is dropped, renamed, or re-typed. The only statements touching a
-- pre-existing object are:
--
--   * `ALTER TYPE "TaskStatus" ADD VALUE` — eight §4.2 states. Adding an enum
--     value cannot invalidate a stored value or a read path.
--   * `ALTER TABLE "Zone" ADD COLUMN "regionId"` — nullable, no default.
--   * `ALTER TABLE "Task" ADD COLUMN` × 7 — every one nullable or defaulted.
--
-- The legacy dispatcher reads and writes exactly what it read and wrote before
-- this migration, which is the phase's completion criterion "legacy endpoints
-- unchanged in behaviour".
--
-- Every CREATE TABLE, CREATE INDEX, and ADD CONSTRAINT below is Prisma's own
-- generated SQL for the models in `schema.prisma`, taken verbatim from
-- `prisma migrate diff --from-empty --to-schema-datamodel` so that the hand-written
-- migration and the schema cannot disagree.

-- ─────────────────────────────────────────────────────────────────────────────
-- (i) ENUMS (§4.2, §4.3, §2.1, §2.4, §2.5)
-- ─────────────────────────────────────────────────────────────────────────────

-- AlterEnum
-- §4.2 tabulates eleven Task states. Six of them are already carried by the legacy
-- enum under legacy names; these eight are new. `IMPLEMENTATION_EXECUTION_PLAN.md`
-- names five of them — the specification wins where the two disagree, and the plan
-- says so itself.
--
-- This migration adds more than one value to an enum. PostgreSQL 12 or later is
-- required: on 11 and earlier, `ALTER TYPE … ADD VALUE` cannot run inside a
-- transaction block, and the work-around is one migration per added value. None of
-- the added values is *used* in this migration, which is the other restriction PG
-- places on adding an enum value inside a transaction.
ALTER TYPE "TaskStatus" ADD VALUE 'RECEIVED';
ALTER TYPE "TaskStatus" ADD VALUE 'REJECTED';
ALTER TYPE "TaskStatus" ADD VALUE 'PLANNABLE';
ALTER TYPE "TaskStatus" ADD VALUE 'WAITING';
ALTER TYPE "TaskStatus" ADD VALUE 'IN_EXECUTION';
ALTER TYPE "TaskStatus" ADD VALUE 'AT_RISK';
ALTER TYPE "TaskStatus" ADD VALUE 'SUSPENDED';
ALTER TYPE "TaskStatus" ADD VALUE 'VERIFYING';

-- CreateEnum
CREATE TYPE "LifecycleState" AS ENUM ('COMMISSIONED', 'ACTIVE', 'QUARANTINED', 'MAINTENANCE', 'DECOMMISSIONED');

-- CreateEnum
CREATE TYPE "LegPurpose" AS ENUM ('PRIMARY', 'RECOVERY', 'TRANSFER', 'REPOSITION', 'EXERCISE', 'MAINTENANCE_TRANSIT');

-- CreateEnum
CREATE TYPE "LegState" AS ENUM ('QUEUED', 'DEFERRED', 'PLANNED', 'OFFERED', 'ACCEPTED', 'EN_ROUTE_PICKUP', 'AT_PICKUP', 'LOADED', 'EN_ROUTE_DROP', 'AT_DROP', 'RELEASED', 'SETTLED', 'ABORTING', 'STRANDED_SAFE', 'STRANDED_OBSTRUCTING', 'REASSIGNING', 'WITHDRAWN', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "CustodyState" AS ENUM ('NONE', 'PENDING_TRANSFER', 'HELD', 'RELEASED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "ObstructionClass" AS ENUM ('CLEAR', 'RESTRICTIVE', 'BLOCKING_CRITICAL', 'INDETERMINATE');

-- ─────────────────────────────────────────────────────────────────────────────
-- (f) SPATIAL HIERARCHY (§3.6)
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "Region" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Region_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "accessRules" JSONB,
    "graphZones" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CellAssignment" (
    "id" TEXT NOT NULL,
    "cellId" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "zoneId" TEXT,
    "siteId" TEXT,
    "mapVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CellAssignment_pkey" PRIMARY KEY ("id")
);

-- AlterTable
-- §3.6: a zone is contained in exactly one region and MUST NOT straddle a region
-- boundary. Nullable, because an existing zone belongs to no region until a region
-- map is published, and a non-null default would fabricate containment nobody
-- assigned.
ALTER TABLE "Zone" ADD COLUMN     "regionId" TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- (b) AGENT CLASS AND ITS MODELS (§2.1, §2.2, §2.3, §15.2)
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "MobilityModel" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "traversalDomain" TEXT NOT NULL,
    "permissionSet" JSONB,
    "speedModel" JSONB,
    "kinematicLimits" JSONB,
    "envelopeConstraints" JSONB,
    "dimensionalFootprint" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MobilityModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnergyModel" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "packNominalWh" DOUBLE PRECISION,
    "chemistry" TEXT,
    "consumptionCoefficients" JSONB,
    "thermalDeratingCurve" JSONB,
    "chargePowerCurve" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnergyModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContainerModel" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "totalMassLimitKg" DOUBLE PRECISION,
    "totalVolumeLitres" DOUBLE PRECISION,
    "axleMassDistribution" JSONB,
    "cogEnvelope" JSONB,
    "accessConstraints" JSONB,
    "loadingInterface" TEXT,
    "cleanlinessClass" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContainerModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- §15.2: the aperture is modelled separately from the internal dimension because it
-- is a distinct and frequently binding constraint that a volume-based model misses.
CREATE TABLE "Compartment" (
    "id" TEXT NOT NULL,
    "containerModelId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "internalLengthMm" DOUBLE PRECISION,
    "internalWidthMm" DOUBLE PRECISION,
    "internalHeightMm" DOUBLE PRECISION,
    "apertureWidthMm" DOUBLE PRECISION,
    "apertureHeightMm" DOUBLE PRECISION,
    "maxMassKg" DOUBLE PRECISION,
    "thermalClass" TEXT,
    "activeThermal" BOOLEAN NOT NULL DEFAULT false,
    "lockClass" TEXT,
    "tamperSensing" BOOLEAN NOT NULL DEFAULT false,
    "accessSide" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Compartment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapabilityBundle" (
    "id" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CapabilityBundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Capability" (
    "id" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" JSONB,
    "unit" TEXT,
    "issuer" TEXT,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Capability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentClass" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hardwareRevision" TEXT,
    "firmwareVersionSet" JSONB,
    "mobilityModelId" TEXT,
    "energyModelId" TEXT,
    "containerModelId" TEXT,
    "capabilityBundleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentClass_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- (a) AGENT (§2.1)
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "robotDbId" TEXT,
    "fleetId" TEXT,
    "tenantId" TEXT,
    "agentClassId" TEXT,
    "regionId" TEXT,
    "homeDepotId" TEXT,
    "lifecycleState" "LifecycleState" NOT NULL DEFAULT 'COMMISSIONED',
    "authorityEpoch" BIGINT NOT NULL DEFAULT 0,
    "fenceCounter" BIGINT NOT NULL DEFAULT 0,
    "capacityOverride" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- (e) PAYLOAD (§15.1, §15.6)
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "PayloadSpec" (
    "id" TEXT NOT NULL,
    "specId" TEXT NOT NULL,
    "massKg" DOUBLE PRECISION,
    "massToleranceKg" DOUBLE PRECISION,
    "lengthMm" DOUBLE PRECISION,
    "widthMm" DOUBLE PRECISION,
    "heightMm" DOUBLE PRECISION,
    "shapeClass" TEXT,
    "volumeLitres" DOUBLE PRECISION,
    "orientationConstraints" JSONB,
    "stackable" BOOLEAN NOT NULL DEFAULT true,
    "loadBearingLimitKg" DOUBLE PRECISION,
    "fragilityClass" TEXT,
    "thermalMinC" DOUBLE PRECISION,
    "thermalMaxC" DOUBLE PRECISION,
    "thermalMaxExcursionSeconds" INTEGER,
    "securityClass" TEXT,
    "hazardClasses" TEXT[],
    "segregationRules" JSONB,
    "declaredValue" DOUBLE PRECISION,
    "regulatoryClass" TEXT,
    "itemCount" INTEGER,
    "divisible" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayloadSpec_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayloadManifest" (
    "id" TEXT NOT NULL,
    "manifestId" TEXT NOT NULL,
    "legId" TEXT,
    "payloadSpecId" TEXT,
    "items" JSONB,
    "loadingPlan" JSONB,
    "declaredMassKg" DOUBLE PRECISION,
    "observedMassKg" DOUBLE PRECISION,
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayloadManifest_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- (c) WORK: MISSION, LEG, STOP (§2.4)
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "Mission" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "regionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Mission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Leg" (
    "id" TEXT NOT NULL,
    "legId" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "purpose" "LegPurpose" NOT NULL,
    "state" "LegState" NOT NULL DEFAULT 'QUEUED',
    "custodyState" "CustodyState" NOT NULL DEFAULT 'NONE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "cancelRequestedAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "obstructionClass" "ObstructionClass",
    "startNotBefore" TIMESTAMP(3),
    "slaDeadline" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Leg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stop" (
    "id" TEXT NOT NULL,
    "stopId" TEXT NOT NULL,
    "legId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "stopType" TEXT NOT NULL,
    "label" TEXT,
    "lat" DOUBLE PRECISION,
    "lon" DOUBLE PRECISION,
    "siteId" TEXT,
    "serviceTimeModelRef" TEXT,
    "windowStart" TIMESTAMP(3),
    "windowEnd" TIMESTAMP(3),
    "accessConstraints" JSONB,
    "payloadDelta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Stop_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- (d) COMMITMENT (§2.6, §10.3)
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "Commitment" (
    "id" TEXT NOT NULL,
    "commitmentId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "legId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'HARD',
    "fence" BIGINT NOT NULL,
    "leaseExpiry" TIMESTAMP(3) NOT NULL,
    "custodyState" "CustodyState" NOT NULL DEFAULT 'NONE',
    "planSnapshotRef" TEXT,
    "decisionRef" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "Commitment_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- (g) OBSERVATION (§2.7)
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "Observation" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "variance" DOUBLE PRECISION,
    "sequence" BIGINT,
    "deadReckoned" BOOLEAN NOT NULL DEFAULT false,
    "uncertaintyRadiusM" DOUBLE PRECISION,

    CONSTRAINT "Observation_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- (h) DECISION RECORD — TIER A SKELETON (§21.2)
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "DecisionRecordA" (
    "id" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "shardId" TEXT NOT NULL,
    "leadershipFence" BIGINT,
    "coordinatorInstance" TEXT,
    "decisionTime" TIMESTAMP(3) NOT NULL,
    "versions" JSONB,
    "trigger" TEXT,
    "inputSnapshotRefs" JSONB,
    "legId" TEXT,
    "legSummary" JSONB,
    "outcome" JSONB,
    "runnerUpAndTopN" JSONB,
    "costTotals" JSONB,
    "rejectionSummary" JSONB,
    "searchAndSolveBounds" JSONB,
    "degradation" JSONB,
    "deferral" JSONB,
    "overrides" JSONB,
    "predictions" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DecisionRecordA_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- TASK EXTENSIONS (§2.4) AND THE Task ⋈ Mission RELATION (§2.8)
-- ─────────────────────────────────────────────────────────────────────────────

-- AlterTable
-- Every column nullable: no existing row changes and no legacy write path acquires
-- a new requirement.
ALTER TABLE "Task" ADD COLUMN     "tenantId" TEXT,
ADD COLUMN     "slaClass" TEXT,
ADD COLUMN     "businessPriority" INTEGER,
ADD COLUMN     "requirements" JSONB,
ADD COLUMN     "windowStart" TIMESTAMP(3),
ADD COLUMN     "windowEnd" TIMESTAMP(3),
ADD COLUMN     "payloadSpecId" TEXT;

-- CreateTable
-- §2.8 draws `Task >──< Mission`: a Mission may discharge several Tasks and a Task
-- may span several Legs. Prisma's implicit relation table carries the many-to-many
-- exactly as drawn, so no entity is invented for it.
CREATE TABLE "_MissionToTask" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateIndex
CREATE INDEX "Zone_regionId_idx" ON "Zone"("regionId");

-- CreateIndex
CREATE INDEX "Task_tenantId_idx" ON "Task"("tenantId");

-- CreateIndex
CREATE INDEX "Task_payloadSpecId_idx" ON "Task"("payloadSpecId");

-- CreateIndex
CREATE UNIQUE INDEX "Region_regionId_key" ON "Region"("regionId");

-- CreateIndex
CREATE UNIQUE INDEX "Site_siteId_key" ON "Site"("siteId");

-- CreateIndex
CREATE INDEX "Site_regionId_idx" ON "Site"("regionId");

-- CreateIndex
CREATE INDEX "CellAssignment_regionId_idx" ON "CellAssignment"("regionId");

-- CreateIndex
CREATE INDEX "CellAssignment_zoneId_idx" ON "CellAssignment"("zoneId");

-- CreateIndex
CREATE INDEX "CellAssignment_siteId_idx" ON "CellAssignment"("siteId");

-- CreateIndex
CREATE INDEX "CellAssignment_resolution_idx" ON "CellAssignment"("resolution");

-- CreateIndex
CREATE UNIQUE INDEX "CellAssignment_cellId_mapVersion_key" ON "CellAssignment"("cellId", "mapVersion");

-- CreateIndex
CREATE UNIQUE INDEX "MobilityModel_modelId_key" ON "MobilityModel"("modelId");

-- CreateIndex
CREATE UNIQUE INDEX "EnergyModel_modelId_key" ON "EnergyModel"("modelId");

-- CreateIndex
CREATE UNIQUE INDEX "ContainerModel_modelId_key" ON "ContainerModel"("modelId");

-- CreateIndex
CREATE INDEX "Compartment_containerModelId_idx" ON "Compartment"("containerModelId");

-- CreateIndex
CREATE UNIQUE INDEX "Compartment_containerModelId_ordinal_key" ON "Compartment"("containerModelId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "CapabilityBundle_bundleId_key" ON "CapabilityBundle"("bundleId");

-- CreateIndex
CREATE INDEX "Capability_bundleId_idx" ON "Capability"("bundleId");

-- CreateIndex
CREATE UNIQUE INDEX "Capability_bundleId_name_key" ON "Capability"("bundleId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "AgentClass_classId_key" ON "AgentClass"("classId");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_agentId_key" ON "Agent"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_robotDbId_key" ON "Agent"("robotDbId");

-- CreateIndex
CREATE INDEX "Agent_regionId_idx" ON "Agent"("regionId");

-- CreateIndex
CREATE INDEX "Agent_agentClassId_idx" ON "Agent"("agentClassId");

-- CreateIndex
CREATE INDEX "Agent_lifecycleState_idx" ON "Agent"("lifecycleState");

-- CreateIndex
CREATE INDEX "Agent_homeDepotId_idx" ON "Agent"("homeDepotId");

-- CreateIndex
CREATE UNIQUE INDEX "PayloadSpec_specId_key" ON "PayloadSpec"("specId");

-- CreateIndex
CREATE UNIQUE INDEX "PayloadManifest_manifestId_key" ON "PayloadManifest"("manifestId");

-- CreateIndex
CREATE INDEX "PayloadManifest_legId_idx" ON "PayloadManifest"("legId");

-- CreateIndex
CREATE INDEX "PayloadManifest_payloadSpecId_idx" ON "PayloadManifest"("payloadSpecId");

-- CreateIndex
CREATE INDEX "PayloadManifest_state_idx" ON "PayloadManifest"("state");

-- CreateIndex
CREATE UNIQUE INDEX "Mission_missionId_key" ON "Mission"("missionId");

-- CreateIndex
CREATE INDEX "Mission_regionId_idx" ON "Mission"("regionId");

-- CreateIndex
CREATE UNIQUE INDEX "Leg_legId_key" ON "Leg"("legId");

-- CreateIndex
CREATE INDEX "Leg_state_idx" ON "Leg"("state");

-- CreateIndex
CREATE INDEX "Leg_purpose_idx" ON "Leg"("purpose");

-- CreateIndex
CREATE INDEX "Leg_custodyState_idx" ON "Leg"("custodyState");

-- CreateIndex
CREATE INDEX "Leg_missionId_idx" ON "Leg"("missionId");

-- CreateIndex
CREATE UNIQUE INDEX "Leg_missionId_sequence_key" ON "Leg"("missionId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "Stop_stopId_key" ON "Stop"("stopId");

-- CreateIndex
CREATE INDEX "Stop_legId_idx" ON "Stop"("legId");

-- CreateIndex
CREATE INDEX "Stop_siteId_idx" ON "Stop"("siteId");

-- CreateIndex
CREATE INDEX "Stop_stopType_idx" ON "Stop"("stopType");

-- CreateIndex
CREATE UNIQUE INDEX "Stop_legId_sequence_key" ON "Stop"("legId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "Commitment_commitmentId_key" ON "Commitment"("commitmentId");

-- CreateIndex
CREATE INDEX "Commitment_agentId_releasedAt_idx" ON "Commitment"("agentId", "releasedAt");

-- CreateIndex
CREATE INDEX "Commitment_legId_idx" ON "Commitment"("legId");

-- CreateIndex
CREATE INDEX "Commitment_leaseExpiry_idx" ON "Commitment"("leaseExpiry");

-- CreateIndex
CREATE INDEX "Observation_agentId_kind_observedAt_idx" ON "Observation"("agentId", "kind", "observedAt");

-- CreateIndex
CREATE INDEX "Observation_observedAt_idx" ON "Observation"("observedAt");

-- CreateIndex
CREATE INDEX "Observation_agentId_sequence_idx" ON "Observation"("agentId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "DecisionRecordA_decisionId_key" ON "DecisionRecordA"("decisionId");

-- CreateIndex
CREATE INDEX "DecisionRecordA_roundId_idx" ON "DecisionRecordA"("roundId");

-- CreateIndex
CREATE INDEX "DecisionRecordA_shardId_decisionTime_idx" ON "DecisionRecordA"("shardId", "decisionTime");

-- CreateIndex
CREATE INDEX "DecisionRecordA_legId_idx" ON "DecisionRecordA"("legId");

-- CreateIndex
CREATE UNIQUE INDEX "_MissionToTask_AB_unique" ON "_MissionToTask"("A", "B");

-- CreateIndex
CREATE INDEX "_MissionToTask_B_index" ON "_MissionToTask"("B");

-- ─────────────────────────────────────────────────────────────────────────────
-- FOREIGN KEYS
-- ─────────────────────────────────────────────────────────────────────────────

-- AddForeignKey
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_payloadSpecId_fkey" FOREIGN KEY ("payloadSpecId") REFERENCES "PayloadSpec"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CellAssignment" ADD CONSTRAINT "CellAssignment_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CellAssignment" ADD CONSTRAINT "CellAssignment_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CellAssignment" ADD CONSTRAINT "CellAssignment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Compartment" ADD CONSTRAINT "Compartment_containerModelId_fkey" FOREIGN KEY ("containerModelId") REFERENCES "ContainerModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Capability" ADD CONSTRAINT "Capability_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "CapabilityBundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentClass" ADD CONSTRAINT "AgentClass_mobilityModelId_fkey" FOREIGN KEY ("mobilityModelId") REFERENCES "MobilityModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentClass" ADD CONSTRAINT "AgentClass_energyModelId_fkey" FOREIGN KEY ("energyModelId") REFERENCES "EnergyModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentClass" ADD CONSTRAINT "AgentClass_containerModelId_fkey" FOREIGN KEY ("containerModelId") REFERENCES "ContainerModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentClass" ADD CONSTRAINT "AgentClass_capabilityBundleId_fkey" FOREIGN KEY ("capabilityBundleId") REFERENCES "CapabilityBundle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
-- Cascade: decommissioning a Robot through the legacy endpoint must keep working
-- exactly as it did, and an Agent projecting a Robot that no longer exists is an
-- orphan the zero-orphan criterion forbids.
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_robotDbId_fkey" FOREIGN KEY ("robotDbId") REFERENCES "Robot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_agentClassId_fkey" FOREIGN KEY ("agentClassId") REFERENCES "AgentClass"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_homeDepotId_fkey" FOREIGN KEY ("homeDepotId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayloadManifest" ADD CONSTRAINT "PayloadManifest_legId_fkey" FOREIGN KEY ("legId") REFERENCES "Leg"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayloadManifest" ADD CONSTRAINT "PayloadManifest_payloadSpecId_fkey" FOREIGN KEY ("payloadSpecId") REFERENCES "PayloadSpec"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mission" ADD CONSTRAINT "Mission_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Leg" ADD CONSTRAINT "Leg_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stop" ADD CONSTRAINT "Stop_legId_fkey" FOREIGN KEY ("legId") REFERENCES "Leg"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stop" ADD CONSTRAINT "Stop_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
-- Restrict on both sides: a durable commitment is the contract that binds a
-- physical machine to work. It must not be destroyed as a side effect of deleting
-- the rows it references (§2.6, I18).
ALTER TABLE "Commitment" ADD CONSTRAINT "Commitment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commitment" ADD CONSTRAINT "Commitment_legId_fkey" FOREIGN KEY ("legId") REFERENCES "Leg"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_MissionToTask" ADD CONSTRAINT "_MissionToTask_A_fkey" FOREIGN KEY ("A") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_MissionToTask" ADD CONSTRAINT "_MissionToTask_B_fkey" FOREIGN KEY ("B") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- SCHEMA BACKSTOPS
--
-- Three properties the specification states unconditionally, enforced in the
-- database rather than only in application code — the same discipline Phase 1
-- applied to configuration immutability, and the one the commitment core carries
-- forward in Phase 3.
-- ─────────────────────────────────────────────────────────────────────────────

-- §2.6 / invariant I18: "Only HARD commitments exist in the Commitment Store."
-- A SOFT reservation is round-local coordinator state; persisting one would put an
-- entire optimisation loop inside the serialised, exactly-once per-shard section.
-- Phase 3 implements the commit transaction against this constraint; the constraint
-- itself rejects the violation independently of it.
ALTER TABLE "Commitment"
    ADD CONSTRAINT "Commitment_kind_hard_only" CHECK ("kind" = 'HARD');

-- §2.7: an Observation is append-only. A recorded measurement that can be rewritten
-- is not evidence, and every freshness and staleness judgement downstream reads it
-- as though it were.
--
-- UPDATE is refused; DELETE is not, because a high-volume observation log needs a
-- retention path and the specification attaches no immutability requirement to
-- deletion. Stated explicitly so that the asymmetry is a decision on the record
-- rather than an omission.
CREATE OR REPLACE FUNCTION "observation_is_append_only"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'Observation is append-only (§2.7); % is refused. Record a new observation instead of rewriting %.',
        TG_OP, OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Observation_append_only"
    BEFORE UPDATE ON "Observation"
    FOR EACH ROW EXECUTE FUNCTION "observation_is_append_only"();

-- §21.2: "One **immutable** record per decision round, per Leg." A decision record
-- that can be edited after the fact cannot discharge T8, and the safety case (§24.7)
-- is assembled from queries over exactly these rows.
CREATE OR REPLACE FUNCTION "decision_record_is_immutable"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'DecisionRecordA is immutable (§21.2); % is refused on decision %.',
        TG_OP, COALESCE(OLD."decisionId", NEW."decisionId");
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DecisionRecordA_immutable"
    BEFORE UPDATE ON "DecisionRecordA"
    FOR EACH ROW EXECUTE FUNCTION "decision_record_is_immutable"();

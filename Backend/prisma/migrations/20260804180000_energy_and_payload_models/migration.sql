-- Phase 7 — Energy and payload models (§14, §15, §20.3).
--
-- §14.2 consumption · §14.3 usable energy · §14.4 wear · §14.5 layered reserves and the
-- three shortfall tiers · §14.6 charging · §14.7 the Charging Scheduler contract ·
-- §15.2 the container model · §15.3 tiered packing · §20.3 item 3 the charger-
-- reachability cache · invariant I17.
--
-- ── What this migration is for ──────────────────────────────────────────────
-- §14.1 states the problem the whole phase exists to remove:
--
--   > The baseline uses an instantaneous percentage floor: 20 % generally, 30 % to
--   > interrupt charging. As the audit states plainly, a robot at 20.1 % is eligible for
--   > a mission of unbounded length. Four independent defects are present, and no choice
--   > of threshold fixes them.
--
--   > **Decision: energy is modelled in watt-hours, feasibility is a probabilistic
--   > constraint, and reserves are layered and explicit.**
--
-- Watt-hours need a pack, a state of health, a temperature curve, and fitted per-class
-- coefficients. Six tables supply them, one per artefact the frozen specification names:
--
--   (a) `EnergyModelParams`               — §14.2's fitted β coefficients, per agent class
--   (b) `BatteryState`                    — §14.3's SoH and resistance trend, and §14.2's κ(a), per agent
--   (c) `Charger`                         — §5.2's charging infrastructure
--   (d) `ChargerReservation`              — §14.7's reservations, owned by the Charging Scheduler
--   (e) `ChargerAvailabilityProjection`   — §14.5's immutable, versioned projection
--   (f) `PackingResultCache`              — §15.3 tier 4's memo
--
-- ── Two of these tables are read-only to the engine, by contract ────────────
--   > **Neither service may assert the other's field.** The engine never writes a
--   > reservation or a target SoC; the Scheduler never assigns work. Every cross-boundary
--   > influence is a priced, refusable, recorded request.
--
-- `ChargerReservation` and `ChargerAvailabilityProjection` are the Charging Scheduler's
-- (§14.7, blocking decision B2). The engine reads them. `targetSoc` lives on the
-- reservation rather than anywhere the engine writes, which is the schema-level
-- expression of §14.6's ownership decision.
--
-- ── Why the projection is insert-only ───────────────────────────────────────
--   > The projection published from the **previous completed round** is the input to the
--   > current one.
--
-- A round pins the projection by version and records that version in its decision
-- record. A projection that could be edited after a round consumed it would make that
-- round unreplayable (§9.6, ADR 21), so `ChargerAvailabilityProjection` carries no
-- `updatedAt` and is written by insert alone. The uniqueness of `version` is what makes
-- the pin meaningful.
--
-- ── Additive only ───────────────────────────────────────────────────────────
-- Six new tables and six new foreign keys onto existing tables. Nothing is dropped,
-- renamed, or re-typed; no existing column acquires a constraint; no existing write path
-- acquires a requirement. Rollback is `DROP TABLE` on the six, with no data loss outside
-- them — the same treatment Phases 4, 5, and 6 gave their own tables.
--
-- Every CREATE TABLE, CREATE INDEX, and ADD CONSTRAINT below is Prisma's own generated
-- SQL for the models in `schema.prisma`, taken verbatim from
-- `prisma migrate diff --from-empty --to-schema-datamodel`, so the hand-written
-- migration and the schema cannot disagree. The hand-written additions are the five
-- CHECK constraints at the end, each annotated with the § that requires it.

-- ─────────────────────────────────────────────────────────────────────────────
-- (a) THE FITTED CONSUMPTION MODEL (§14.2)
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "EnergyModelParams" (
    "id" TEXT NOT NULL,
    "agentClassId" TEXT NOT NULL,
    "modelVersion" INTEGER NOT NULL DEFAULT 1,
    "betaDist" DOUBLE PRECISION,
    "betaMass" DOUBLE PRECISION,
    "betaClimb" DOUBLE PRECISION,
    "betaRegen" DOUBLE PRECISION,
    "betaMoveTime" DOUBLE PRECISION,
    "betaStopStart" DOUBLE PRECISION,
    "betaDwell" DOUBLE PRECISION,
    "betaAux" DOUBLE PRECISION,
    "etaRegen" DOUBLE PRECISION,
    "betaThermal" JSONB,
    "betaPayloadThermal" JSONB,
    "stressCurves" JSONB,
    "residualCv" DOUBLE PRECISION,
    "fittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnergyModelParams_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- (b) PER-AGENT BATTERY AND EFFICIENCY STATE (§14.2, §14.3)
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "BatteryState" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "soh" DOUBLE PRECISION,
    "internalResistanceMilliOhm" DOUBLE PRECISION,
    "baselineResistanceMilliOhm" DOUBLE PRECISION,
    "resistanceTrendPerCycle" DOUBLE PRECISION,
    "socThroughput" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cycleCount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "kappa" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "kappaSampleCount" INTEGER NOT NULL DEFAULT 0,
    "kappaUpdatedAt" TIMESTAMP(3),
    "lastObservedSoc" DOUBLE PRECISION,
    "lastObservedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BatteryState_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- (c) AND (d) CHARGING INFRASTRUCTURE AND ITS RESERVATIONS (§5.2, §14.7)
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "Charger" (
    "id" TEXT NOT NULL,
    "chargerId" TEXT NOT NULL,
    "siteId" TEXT,
    "regionId" TEXT,
    "cellId" TEXT,
    "chargerClass" TEXT,
    "ratedPowerW" DOUBLE PRECISION,
    "connector" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "isDepot" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Charger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChargerReservation" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "chargerDbId" TEXT,
    "reservedFrom" TIMESTAMP(3) NOT NULL,
    "reservedUntil" TIMESTAMP(3) NOT NULL,
    "targetSoc" DOUBLE PRECISION,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "externalId" TEXT,
    "projectionVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChargerReservation_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- (e) THE PINNED AVAILABILITY PROJECTION (§14.5)
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "ChargerAvailabilityProjection" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "publishedBy" TEXT,
    "horizonEnd" TIMESTAMP(3),
    "regionId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChargerAvailabilityProjection_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- (f) THE TIER-4 PACKING MEMO (§15.3)
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
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

-- ─────────────────────────────────────────────────────────────────────────────
-- INDICES
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateIndex
CREATE INDEX "EnergyModelParams_agentClassId_idx" ON "EnergyModelParams"("agentClassId");

-- CreateIndex
CREATE UNIQUE INDEX "EnergyModelParams_agentClassId_modelVersion_key" ON "EnergyModelParams"("agentClassId", "modelVersion");

-- CreateIndex
CREATE UNIQUE INDEX "BatteryState_agentId_key" ON "BatteryState"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "Charger_chargerId_key" ON "Charger"("chargerId");

-- CreateIndex
CREATE INDEX "Charger_cellId_idx" ON "Charger"("cellId");

-- CreateIndex
CREATE INDEX "Charger_regionId_idx" ON "Charger"("regionId");

-- CreateIndex
CREATE INDEX "Charger_siteId_idx" ON "Charger"("siteId");

-- CreateIndex
CREATE INDEX "Charger_isDepot_idx" ON "Charger"("isDepot");

-- CreateIndex
CREATE UNIQUE INDEX "ChargerReservation_reservationId_key" ON "ChargerReservation"("reservationId");

-- CreateIndex
CREATE INDEX "ChargerReservation_agentId_reservedFrom_idx" ON "ChargerReservation"("agentId", "reservedFrom");

-- CreateIndex
CREATE INDEX "ChargerReservation_chargerDbId_reservedFrom_idx" ON "ChargerReservation"("chargerDbId", "reservedFrom");

-- CreateIndex
CREATE INDEX "ChargerReservation_state_idx" ON "ChargerReservation"("state");

-- CreateIndex
CREATE UNIQUE INDEX "ChargerAvailabilityProjection_version_key" ON "ChargerAvailabilityProjection"("version");

-- CreateIndex
CREATE INDEX "ChargerAvailabilityProjection_publishedAt_idx" ON "ChargerAvailabilityProjection"("publishedAt");

-- CreateIndex
CREATE INDEX "ChargerAvailabilityProjection_regionId_idx" ON "ChargerAvailabilityProjection"("regionId");

-- CreateIndex
CREATE INDEX "PackingResultCache_expiresAt_idx" ON "PackingResultCache"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PackingResultCache_containerConfig_itemSignature_key" ON "PackingResultCache"("containerConfig", "itemSignature");

-- ─────────────────────────────────────────────────────────────────────────────
-- FOREIGN KEYS
-- ─────────────────────────────────────────────────────────────────────────────

-- AddForeignKey
ALTER TABLE "EnergyModelParams" ADD CONSTRAINT "EnergyModelParams_agentClassId_fkey" FOREIGN KEY ("agentClassId") REFERENCES "AgentClass"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatteryState" ADD CONSTRAINT "BatteryState_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Charger" ADD CONSTRAINT "Charger_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Charger" ADD CONSTRAINT "Charger_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargerReservation" ADD CONSTRAINT "ChargerReservation_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargerReservation" ADD CONSTRAINT "ChargerReservation_chargerDbId_fkey" FOREIGN KEY ("chargerDbId") REFERENCES "Charger"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargerAvailabilityProjection" ADD CONSTRAINT "ChargerAvailabilityProjection_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- HAND-WRITTEN CHECK CONSTRAINTS
--
-- Prisma cannot express these. Each is a schema backstop for a property the
-- specification states, enforced independently of application logic — the same
-- discipline §10.3.2 applies to the commitment core's own invariants.
-- ─────────────────────────────────────────────────────────────────────────────

-- §14.3 — state of health is a fraction of nominal capacity. A SoH outside [0, 1] would
-- make `E_usable = C_nominal · SoH · f_temp · SoC · f_derate` claim a pack larger than
-- the one that was built, which is the one direction the reserve model cannot survive.
ALTER TABLE "BatteryState"
  ADD CONSTRAINT "BatteryState_soh_fraction"
  CHECK ("soh" IS NULL OR ("soh" > 0 AND "soh" <= 1));

-- §14.2 — κ(a) is a positive efficiency multiplier. A zero or negative κ would zero or
-- invert every consumption estimate the agent is planned with.
ALTER TABLE "BatteryState"
  ADD CONSTRAINT "BatteryState_kappa_positive"
  CHECK ("kappa" > 0);

-- §14.6 — target SoC is a fraction. It is the Charging Scheduler's field and arrives
-- across a service boundary, which is exactly where a unit confusion (80 rather than
-- 0.8) survives review.
ALTER TABLE "ChargerReservation"
  ADD CONSTRAINT "ChargerReservation_target_soc_fraction"
  CHECK ("targetSoc" IS NULL OR ("targetSoc" >= 0 AND "targetSoc" <= 1));

-- §14.7 — a reservation is an interval. A zero-width or inverted window would make
-- F18's "an agent reserved for charging is not available" unevaluable while still
-- looking like a reservation.
ALTER TABLE "ChargerReservation"
  ADD CONSTRAINT "ChargerReservation_window_ordered"
  CHECK ("reservedUntil" > "reservedFrom");

-- §15.3 — a memo holds a *decided* verdict, and only the two decided verdicts exist.
--
-- The tiered evaluation produces three outcomes; `BUDGET_EXHAUSTED` is deliberately not
-- one this table may hold. "If tier 3 exhausts its budget without a result, the outcome
-- is INDETERMINATE" — the budget may be larger next time, and memoising an indecision
-- would make it permanent for the entry's lifetime, turning a transient resource limit
-- into a standing refusal. `packing.evaluateMemoised()` declines to write one; this
-- constraint is the backstop that holds independently of that code.
ALTER TABLE "PackingResultCache"
  ADD CONSTRAINT "PackingResultCache_verdict_decided"
  CHECK ("verdict" IN ('FEASIBLE', 'INFEASIBLE'));

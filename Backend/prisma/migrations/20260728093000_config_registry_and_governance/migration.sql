-- Phase 1 — Configuration, units, and determinism substrate.
--
-- §22 Configuration and Governance: the versioned, scoped, publish-time-validated
-- configuration store, the parameter register, and the operating-regime declarations.
--
-- Additive only. No existing table, column, index, or constraint is altered or
-- dropped, so the legacy dispatcher's behaviour is untouched.

-- CreateEnum
CREATE TYPE "ConfigChangeClass" AS ENUM ('HOT', 'TUNED', 'POLICY', 'SAFETY', 'STRUCTURAL', 'DERIVED', 'CONTRACTUAL');

-- CreateEnum
CREATE TYPE "CalibrationStatus" AS ENUM ('DERIVED', 'PROVISIONAL', 'UNCALIBRATED');

-- CreateEnum
CREATE TYPE "OperatingRegimeState" AS ENUM ('INACTIVE', 'PROPOSED_ENTRY', 'ACTIVE', 'PROPOSED_EXIT');

-- CreateTable
CREATE TABLE "ConfigVersion" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedBy" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "note" TEXT,
    "approvals" JSONB,
    "safetyClassChanges" TEXT[],
    "launchGateFindings" JSONB,

    CONSTRAINT "ConfigVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfigScopeBinding" (
    "id" TEXT NOT NULL,
    "configVersionId" TEXT NOT NULL,
    "scopeLevel" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL DEFAULT '',
    "parameterName" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfigScopeBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfigActiveVersion" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pinnedBy" TEXT NOT NULL,

    CONSTRAINT "ConfigActiveVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParameterRegisterEntry" (
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "defaultValue" JSONB,
    "range" JSONB,
    "scopes" TEXT[],
    "specScope" TEXT,
    "changeClass" "ConfigChangeClass" NOT NULL,
    "owner" TEXT NOT NULL,
    "blastRadius" TEXT,
    "calibrationStatus" "CalibrationStatus" NOT NULL,
    "awaits" TEXT,
    "section" TEXT,
    "description" TEXT,
    "derivation" JSONB,
    "registerFile" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ParameterRegisterEntry_pkey" PRIMARY KEY ("name")
);

-- CreateTable
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

-- CreateIndex
CREATE UNIQUE INDEX "ConfigVersion_version_key" ON "ConfigVersion"("version");

-- CreateIndex
CREATE INDEX "ConfigVersion_publishedAt_idx" ON "ConfigVersion"("publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ConfigScopeBinding_configVersionId_parameterName_scopeLevel_key" ON "ConfigScopeBinding"("configVersionId", "parameterName", "scopeLevel", "scopeKey");

-- CreateIndex
CREATE INDEX "ConfigScopeBinding_parameterName_idx" ON "ConfigScopeBinding"("parameterName");

-- CreateIndex
CREATE INDEX "ParameterRegisterEntry_changeClass_idx" ON "ParameterRegisterEntry"("changeClass");

-- CreateIndex
CREATE INDEX "ParameterRegisterEntry_calibrationStatus_idx" ON "ParameterRegisterEntry"("calibrationStatus");

-- CreateIndex
CREATE UNIQUE INDEX "OperatingRegime_name_key" ON "OperatingRegime"("name");

-- CreateIndex
CREATE INDEX "OperatingRegime_state_idx" ON "OperatingRegime"("state");

-- AddForeignKey
ALTER TABLE "ConfigScopeBinding" ADD CONSTRAINT "ConfigScopeBinding_configVersionId_fkey" FOREIGN KEY ("configVersionId") REFERENCES "ConfigVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Schema backstops
--
-- §22.1 rule 3: "Configuration is versioned, **immutable once published**, and
-- referenced by version in every decision record." A published version that can be
-- edited in place makes every decision record that cites it unreplayable, and no
-- amount of application discipline prevents an UPDATE issued from a console. The
-- constraint therefore lives in the database, independently of application logic —
-- the same discipline the commitment core's capacity and HARD-only constraints will
-- carry in Phase 3.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION "config_version_is_immutable"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'ConfigVersion is immutable once published (§22.1 rule 3). Publish a new version instead of % on version %.',
        TG_OP, COALESCE(OLD."version", NEW."version");
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ConfigVersion_immutable"
    BEFORE UPDATE OR DELETE ON "ConfigVersion"
    FOR EACH ROW EXECUTE FUNCTION "config_version_is_immutable"();

CREATE OR REPLACE FUNCTION "config_binding_is_immutable"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'ConfigScopeBinding belongs to an immutable published version (§22.1 rule 3); % is refused.',
        TG_OP;
END;
$$ LANGUAGE plpgsql;

-- UPDATE only: a DELETE arrives legitimately via the ON DELETE CASCADE of a
-- ConfigVersion removal, which the ConfigVersion trigger already refuses.
CREATE TRIGGER "ConfigScopeBinding_immutable"
    BEFORE UPDATE ON "ConfigScopeBinding"
    FOR EACH ROW EXECUTE FUNCTION "config_binding_is_immutable"();

-- The active-version pointer is a single row. Two pointers would mean two rounds
-- could observe different versions while both believing they held the pinned one
-- (§22.1 rule 4).
ALTER TABLE "ConfigActiveVersion"
    ADD CONSTRAINT "ConfigActiveVersion_singleton" CHECK ("id" = 'singleton');

ALTER TABLE "ConfigActiveVersion"
    ADD CONSTRAINT "ConfigActiveVersion_version_fkey"
    FOREIGN KEY ("version") REFERENCES "ConfigVersion"("version") ON DELETE RESTRICT ON UPDATE CASCADE;

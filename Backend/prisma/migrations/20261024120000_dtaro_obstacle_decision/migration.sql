-- DTARO operator decisions on reported obstacles (SIMULATED fleet only), behind
-- DTARO_OPERATOR_DECISION_ENABLED. One row per decision: the report's trusted facts, the server's
-- deadline, the committed decision and its outcome. Additive: no existing table or column changes,
-- and nothing reads or writes this table while the feature is off.
CREATE TABLE "DtaroObstacleDecision" (
    "id" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "obstacleId" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "cellId" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "severity" TEXT,
    "reportingRobotId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decision" TEXT,
    "decisionSource" TEXT,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "propagatedAt" TIMESTAMP(3),
    "suppressedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "recipients" JSONB,
    "outcome" JSONB,
    "abandonedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DtaroObstacleDecision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DtaroObstacleDecision_status_check" CHECK ("status" IN (
        'REPORTED', 'AWAITING_OPERATOR_DECISION', 'DECIDED', 'PROPAGATED', 'SUPPRESSED',
        'EXECUTING', 'COMPLETED', 'EXPIRED', 'ABANDONED_ON_RESTART')),
    CONSTRAINT "DtaroObstacleDecision_decision_check" CHECK ("decision" IS NULL OR "decision" IN ('STOP', 'REROUTE', 'REJECT_BROADCAST')),
    CONSTRAINT "DtaroObstacleDecision_source_check" CHECK ("decisionSource" IS NULL OR "decisionSource" IN ('MANUAL', 'DEFAULT_TIMEOUT')),
    -- A decision, its source and its time are written together, or not at all.
    CONSTRAINT "DtaroObstacleDecision_decided_together_check" CHECK (
        ("decision" IS NULL AND "decisionSource" IS NULL AND "decidedAt" IS NULL)
        OR ("decision" IS NOT NULL AND "decisionSource" IS NOT NULL AND "decidedAt" IS NOT NULL)),
    -- A default carries no operator; a manual decision names one.
    CONSTRAINT "DtaroObstacleDecision_operator_check" CHECK (
        "decisionSource" IS NULL
        OR ("decisionSource" = 'DEFAULT_TIMEOUT' AND "decidedByUserId" IS NULL)
        OR ("decisionSource" = 'MANUAL' AND "decidedByUserId" IS NOT NULL)),
    CONSTRAINT "DtaroObstacleDecision_deadline_check" CHECK ("deadlineAt" > "receivedAt")
);

CREATE UNIQUE INDEX "DtaroObstacleDecision_decisionId_key" ON "DtaroObstacleDecision"("decisionId");
CREATE INDEX "DtaroObstacleDecision_status_idx" ON "DtaroObstacleDecision"("status");
CREATE INDEX "DtaroObstacleDecision_regionId_cellId_idx" ON "DtaroObstacleDecision"("regionId", "cellId");
CREATE INDEX "DtaroObstacleDecision_receivedAt_idx" ON "DtaroObstacleDecision"("receivedAt");

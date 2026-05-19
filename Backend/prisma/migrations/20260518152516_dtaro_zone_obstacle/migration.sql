-- AlterTable
ALTER TABLE "Robot" ADD COLUMN     "utilization" DOUBLE PRECISION DEFAULT 0,
ADD COLUMN     "zoneId" TEXT;

-- CreateTable
CREATE TABLE "Zone" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "minLat" DOUBLE PRECISION NOT NULL,
    "maxLat" DOUBLE PRECISION NOT NULL,
    "minLon" DOUBLE PRECISION NOT NULL,
    "maxLon" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Zone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObstacleEvent" (
    "id" TEXT NOT NULL,
    "obstacleId" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "zoneId" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "reportingRobotId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ObstacleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Zone_name_key" ON "Zone"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ObstacleEvent_obstacleId_key" ON "ObstacleEvent"("obstacleId");

-- CreateIndex
CREATE INDEX "ObstacleEvent_zoneId_idx" ON "ObstacleEvent"("zoneId");

-- CreateIndex
CREATE INDEX "ObstacleEvent_expiresAt_idx" ON "ObstacleEvent"("expiresAt");

-- CreateIndex
CREATE INDEX "Robot_zoneId_idx" ON "Robot"("zoneId");

-- AddForeignKey
ALTER TABLE "Robot" ADD CONSTRAINT "Robot_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObstacleEvent" ADD CONSTRAINT "ObstacleEvent_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

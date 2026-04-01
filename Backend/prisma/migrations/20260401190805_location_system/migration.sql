/*
  Warnings:

  - The `status` column on the `Command` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Added the required column `locationId` to the `Robot` table without a default value. This is not possible if the table is not empty.
  - Added the required column `dropLat` to the `Task` table without a default value. This is not possible if the table is not empty.
  - Added the required column `dropLon` to the `Task` table without a default value. This is not possible if the table is not empty.
  - Added the required column `pickupLat` to the `Task` table without a default value. This is not possible if the table is not empty.
  - Added the required column `pickupLon` to the `Task` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "CommandStatus" AS ENUM ('SENT', 'ACK', 'FAILED');

-- CreateEnum
CREATE TYPE "LocationType" AS ENUM ('COUNTRY', 'STATE', 'CITY', 'AREA');

-- AlterEnum
ALTER TYPE "RobotStatus" ADD VALUE 'ISSUES';

-- DropForeignKey
ALTER TABLE "Decision" DROP CONSTRAINT "Decision_robotId_fkey";

-- AlterTable
ALTER TABLE "Command" DROP COLUMN "status",
ADD COLUMN     "status" "CommandStatus" NOT NULL DEFAULT 'SENT';

-- AlterTable
ALTER TABLE "Robot" ADD COLUMN     "campusId" TEXT,
ADD COLUMN     "locationId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "dropLat" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "dropLon" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "pickupLat" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "pickupLon" DOUBLE PRECISION NOT NULL;

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "LocationType" NOT NULL,
    "slug" TEXT,
    "parentId" TEXT,
    "lat" DOUBLE PRECISION,
    "lon" DOUBLE PRECISION,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campus" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "centerLat" DOUBLE PRECISION NOT NULL,
    "centerLon" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Campus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Location_slug_key" ON "Location"("slug");

-- CreateIndex
CREATE INDEX "Location_type_idx" ON "Location"("type");

-- CreateIndex
CREATE INDEX "Location_parentId_idx" ON "Location"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Location_name_parentId_key" ON "Location"("name", "parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Campus_code_key" ON "Campus"("code");

-- CreateIndex
CREATE INDEX "Robot_locationId_idx" ON "Robot"("locationId");

-- CreateIndex
CREATE INDEX "Robot_locationId_isOnline_idx" ON "Robot"("locationId", "isOnline");

-- CreateIndex
CREATE INDEX "Robot_campusId_idx" ON "Robot"("campusId");

-- CreateIndex
CREATE INDEX "Robot_lat_lon_idx" ON "Robot"("lat", "lon");

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Robot" ADD CONSTRAINT "Robot_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Robot" ADD CONSTRAINT "Robot_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_robotId_fkey" FOREIGN KEY ("robotId") REFERENCES "Robot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

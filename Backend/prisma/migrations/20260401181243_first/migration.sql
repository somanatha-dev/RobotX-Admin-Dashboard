/*
  Warnings:

  - The primary key for the `Robot` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `status` column on the `Robot` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `Task` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `status` column on the `Task` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - A unique constraint covering the columns `[currentTaskId]` on the table `Robot` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "RobotStatus" AS ENUM ('IDLE', 'ACTIVE', 'PAUSED', 'OFFLINE', 'ERROR');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CommandType" AS ENUM ('STOP', 'PAUSE', 'RETURN', 'RESUME');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "DecisionAction" AS ENUM ('WAIT', 'REROUTE', 'CANCEL');

-- DropForeignKey
ALTER TABLE "Task" DROP CONSTRAINT "Task_robotId_fkey";

-- AlterTable
ALTER TABLE "Robot" DROP CONSTRAINT "Robot_pkey",
ADD COLUMN     "currentTaskId" TEXT,
ADD COLUMN     "isOnline" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastSeenAt" TIMESTAMP(3),
ADD COLUMN     "lat" DOUBLE PRECISION,
ADD COLUMN     "lon" DOUBLE PRECISION,
ADD COLUMN     "socketId" TEXT,
ADD COLUMN     "speed" DOUBLE PRECISION,
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
DROP COLUMN "status",
ADD COLUMN     "status" "RobotStatus" NOT NULL DEFAULT 'IDLE',
ALTER COLUMN "battery" DROP NOT NULL,
ALTER COLUMN "battery" SET DATA TYPE DOUBLE PRECISION,
ADD CONSTRAINT "Robot_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "Robot_id_seq";

-- AlterTable
ALTER TABLE "Task" DROP CONSTRAINT "Task_pkey",
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "startedAt" TIMESTAMP(3),
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "robotId" DROP NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
ADD CONSTRAINT "Task_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "Task_id_seq";

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'SUPER_ADMIN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Telemetry" (
    "id" TEXT NOT NULL,
    "robotId" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lon" DOUBLE PRECISION,
    "speed" DOUBLE PRECISION,
    "battery" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Telemetry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "robotId" TEXT,
    "taskId" TEXT,
    "type" "EventType" NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Command" (
    "id" TEXT NOT NULL,
    "robotId" TEXT NOT NULL,
    "type" "CommandType" NOT NULL,
    "status" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executedAt" TIMESTAMP(3),

    CONSTRAINT "Command_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Telemetry_robotId_createdAt_idx" ON "Telemetry"("robotId", "createdAt");

-- CreateIndex
CREATE INDEX "Event_robotId_idx" ON "Event"("robotId");

-- CreateIndex
CREATE INDEX "Event_taskId_idx" ON "Event"("taskId");

-- CreateIndex
CREATE INDEX "Event_createdAt_idx" ON "Event"("createdAt");

-- CreateIndex
CREATE INDEX "Command_robotId_idx" ON "Command"("robotId");

-- CreateIndex
CREATE INDEX "Command_issuedAt_idx" ON "Command"("issuedAt");

-- CreateIndex
CREATE INDEX "Decision_robotId_idx" ON "Decision"("robotId");

-- CreateIndex
CREATE INDEX "Decision_taskId_idx" ON "Decision"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "Robot_currentTaskId_key" ON "Robot"("currentTaskId");

-- CreateIndex
CREATE INDEX "Robot_status_idx" ON "Robot"("status");

-- CreateIndex
CREATE INDEX "Robot_isOnline_idx" ON "Robot"("isOnline");

-- CreateIndex
CREATE INDEX "Robot_lastSeenAt_idx" ON "Robot"("lastSeenAt");

-- CreateIndex
CREATE INDEX "Task_robotId_idx" ON "Task"("robotId");

-- CreateIndex
CREATE INDEX "Task_status_idx" ON "Task"("status");

-- AddForeignKey
ALTER TABLE "Robot" ADD CONSTRAINT "Robot_currentTaskId_fkey" FOREIGN KEY ("currentTaskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_robotId_fkey" FOREIGN KEY ("robotId") REFERENCES "Robot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Telemetry" ADD CONSTRAINT "Telemetry_robotId_fkey" FOREIGN KEY ("robotId") REFERENCES "Robot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_robotId_fkey" FOREIGN KEY ("robotId") REFERENCES "Robot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Command" ADD CONSTRAINT "Command_robotId_fkey" FOREIGN KEY ("robotId") REFERENCES "Robot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_robotId_fkey" FOREIGN KEY ("robotId") REFERENCES "Robot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

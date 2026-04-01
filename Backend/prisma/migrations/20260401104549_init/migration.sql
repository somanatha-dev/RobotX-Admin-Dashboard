-- CreateTable
CREATE TABLE "Robot" (
    "id" SERIAL NOT NULL,
    "robotId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "battery" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Robot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" SERIAL NOT NULL,
    "taskId" TEXT NOT NULL,
    "robotId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "pickup" TEXT NOT NULL,
    "drop" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Robot_robotId_key" ON "Robot"("robotId");

-- CreateIndex
CREATE UNIQUE INDEX "Task_taskId_key" ON "Task"("taskId");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_robotId_fkey" FOREIGN KEY ("robotId") REFERENCES "Robot"("robotId") ON DELETE RESTRICT ON UPDATE CASCADE;

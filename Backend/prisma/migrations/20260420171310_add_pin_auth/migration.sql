-- CreateTable
CREATE TABLE "AdminPinAuth" (
    "id" TEXT NOT NULL,
    "pinHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminPinAuth_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminPinAuth_userId_key" ON "AdminPinAuth"("userId");

-- AddForeignKey
ALTER TABLE "AdminPinAuth" ADD CONSTRAINT "AdminPinAuth_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

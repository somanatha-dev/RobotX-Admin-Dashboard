-- C1 (LAN-3): the durable record of a robot's legacy session, so a paired robot survives a
-- backend restart when the KV is process memory (REDIS_ENABLED=false). It holds a SHA-256 of
-- the bearer token, never the token. It is removed with its Robot.
CREATE TABLE "RobotSession" (
    "robotDbId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RobotSession_pkey" PRIMARY KEY ("robotDbId")
);

ALTER TABLE "RobotSession" ADD CONSTRAINT "RobotSession_robotDbId_fkey" FOREIGN KEY ("robotDbId") REFERENCES "Robot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

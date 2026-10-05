"use strict";

// Wipes robot-dependent tables + Redis, then bulk-seeds N Robot rows plus the
// matching Redis session tokens the fake fleet uses to AUTH directly (skips
// the pairing-code REST flow entirely — legitimate for a load-test harness
// seeding its own fleet, same end-state VirtualRobot.commission() produces).

const CHUNK = 1000;
const SESSION_TTL_SEC = 7 * 24 * 3600;

function tokenFor(robotId) {
  return `bench-${robotId}`;
}

function robotIdFor(i) {
  return `BENCH-${String(i).padStart(6, "0")}`;
}

async function resetAndSeed(prisma, redis, count) {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "Telemetry","Command","Event","Task","Robot" RESTART IDENTITY CASCADE;`
  );
  await redis.flushdb();

  const location = await prisma.location.findUnique({ where: { slug: "rr-nagar" } });
  const campus = await prisma.campus.findUnique({ where: { code: "RNSIT" } });
  if (!location) throw new Error("Seed location 'rr-nagar' missing — run prisma/seed.js first");

  const robotIds = Array.from({ length: count }, (_, i) => robotIdFor(i + 1));

  for (let start = 0; start < robotIds.length; start += CHUNK) {
    const slice = robotIds.slice(start, start + CHUNK);
    const rows = slice.map((robotId) => ({
      robotId,
      locationId: location.id,
      campusId: campus ? campus.id : null,
      status: "IDLE",
      battery: 70 + Math.random() * 30,
      isOnline: false,
      lat: 12.9023 + (Math.random() - 0.5) * 0.01,
      lon: 77.5186 + (Math.random() - 0.5) * 0.01,
      speed: 0,
    }));
    await prisma.robot.createMany({ data: rows });

    const pipeline = redis.pipeline();
    for (const robotId of slice) {
      pipeline.set(`session:${robotId}`, tokenFor(robotId), "EX", SESSION_TTL_SEC);
    }
    await pipeline.exec();
  }

  return robotIds;
}

module.exports = { resetAndSeed, robotIdFor, tokenFor };

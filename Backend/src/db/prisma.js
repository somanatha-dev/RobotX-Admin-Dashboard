const { PrismaClient } = require("@prisma/client");

// Neon (and other cloud-hosted PG) can take several seconds to wake from
// suspension.  Patch DATABASE_URL with connect_timeout=30 once at module load
// so every Prisma connection attempt waits up to 30 s before timing out.
// This eliminates the P1001 "Can't reach database" on first startup without
// requiring any .env changes.
(function patchConnectTimeout() {
  const raw = process.env.DATABASE_URL;
  if (!raw || raw.includes("connect_timeout")) return;
  const sep = raw.includes("?") ? "&" : "?";
  process.env.DATABASE_URL = `${raw}${sep}connect_timeout=30`;
})();

let prisma;

function getPrisma() {
  if (!prisma) {
    prisma = new PrismaClient();
  }
  return prisma;
}

async function connectPrisma() {
  const client = getPrisma();
  await client.$connect();
  return client;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectPrismaWithRetry({ retries = 4, delayMs = 3000, logger } = {}) {
  let attempt = 0;
  // Each attempt waits up to 30 s (connect_timeout in DATABASE_URL).
  // With retries=4 and delayMs=3s the max startup wait is ~4×30 + 3×3 = ~2 min.
  // In practice Neon wakes in <10 s so the first or second attempt always wins.
  while (true) {
    try {
      attempt += 1;
      const client = await connectPrisma();
      if (attempt > 1 && logger) {
        logger.info(`Prisma connected (attempt ${attempt})`);
      }
      return client;
    } catch (err) {
      const last = attempt >= retries;
      (logger || console).error("Prisma connect failed", {
        attempt,
        retries,
        errorCode: err?.errorCode,
        message: err?.message?.slice(0, 120),
      });

      if (last) throw err;
      await sleep(delayMs);
    }
  }
}

async function disconnectPrisma() {
  if (!prisma) return;
  await prisma.$disconnect();
  prisma = null;
}

module.exports = {
  getPrisma,
  connectPrisma,
  connectPrismaWithRetry,
  disconnectPrisma,
};

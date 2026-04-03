const { PrismaClient } = require("@prisma/client");

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

async function connectPrismaWithRetry({ retries = 6, delayMs = 1500, logger } = {}) {
  let attempt = 0;
  // Total wait ~ (retries-1) * delayMs (linear) which is fine for dev/boot.
  while (true) {
    try {
      attempt += 1;
      const client = await connectPrisma();
      return client;
    } catch (err) {
      const last = attempt >= retries;
      (logger || console).error("Prisma connect failed", {
        attempt,
        retries,
        errorCode: err && err.errorCode,
        message: err && err.message,
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

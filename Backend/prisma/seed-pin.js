/**
 * Seed the default admin PIN (931100) for every user in the database.
 * Run once:  node prisma/seed-pin.js
 *
 * Safe to re-run — uses upsert so existing records are updated, not duplicated.
 */

require("dotenv").config();
const bcrypt = require("bcrypt");
const { PrismaClient } = require("@prisma/client");

const DEFAULT_PIN = "931100";
const BCRYPT_ROUNDS = 10;

async function main() {
  const prisma = new PrismaClient();

  try {
    console.log("🔐 Seeding default PIN (931100) for all users...\n");

    const pinHash = await bcrypt.hash(DEFAULT_PIN, BCRYPT_ROUNDS);

    const users = await prisma.user.findMany({ select: { id: true, email: true } });

    if (users.length === 0) {
      console.log("⚠️  No users found in the database. Create a user first, then re-run this script.");
      return;
    }

    for (const user of users) {
      await prisma.adminPinAuth.upsert({
        where: { userId: user.id },
        update: { pinHash },
        create: { userId: user.id, pinHash },
      });
      console.log(`  ✅ PIN set for ${user.email}`);
    }

    console.log(`\n✅ Done. ${users.length} user(s) now have PIN: 931100`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("❌ seed-pin failed:", err.message);
  process.exit(1);
});

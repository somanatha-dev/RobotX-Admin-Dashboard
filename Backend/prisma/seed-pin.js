/**
 * Seed the admin step-up PIN for every user in the database.
 *
 * Run once:  SEED_ADMIN_PIN=123456 node prisma/seed-pin.js
 *
 * Reads the PIN to seed from the required SEED_ADMIN_PIN environment
 * variable — there is no hardcoded default. The script refuses to run
 * (exits non-zero) if SEED_ADMIN_PIN is unset, empty, or not a 4-10 digit
 * numeric PIN, so it can never silently apply a weak or accidental value.
 *
 * Safe to re-run — uses upsert so existing records are updated, not duplicated.
 */

require("dotenv").config();
const bcrypt = require("bcrypt");
const { PrismaClient } = require("@prisma/client");

const BCRYPT_ROUNDS = 10;
const PIN_PATTERN = /^\d{4,10}$/;

function readRequiredPin() {
  const pin = process.env.SEED_ADMIN_PIN;

  if (!pin || !pin.trim()) {
    console.error(
      "❌ SEED_ADMIN_PIN is not set. Refusing to seed a PIN.\n" +
        "   Set it before running this script, e.g.:\n" +
        "     SEED_ADMIN_PIN=123456 node prisma/seed-pin.js"
    );
    process.exit(1);
  }

  const trimmed = pin.trim();
  if (!PIN_PATTERN.test(trimmed)) {
    console.error(
      "❌ SEED_ADMIN_PIN must be 4-10 digits. Refusing to seed a PIN."
    );
    process.exit(1);
  }

  return trimmed;
}

async function main() {
  const pin = readRequiredPin();
  const prisma = new PrismaClient();

  try {
    console.log("🔐 Seeding admin PIN from SEED_ADMIN_PIN for all users...\n");

    const pinHash = await bcrypt.hash(pin, BCRYPT_ROUNDS);

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

    console.log(`\n✅ Done. ${users.length} user(s) now have the PIN from SEED_ADMIN_PIN.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("❌ seed-pin failed:", err.message);
  process.exit(1);
});

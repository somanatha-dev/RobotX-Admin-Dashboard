/**
 * Seed the admin step-up PIN for every user in the database.
 *
 * DISABLED UNLESS EXPLICITLY REQUESTED. It overwrites every user's PIN, so it:
 *   - runs only in the LOCAL environment (ROBOTX_ENV=LOCAL, loopback database — see
 *     src/config/environmentGuard.js and docs/runbooks/environments.md);
 *   - is a dry run by default: it names the target and counts the users, and writes nothing;
 *   - writes only with BOTH `--apply` and `--confirm-database <name>` matching the target.
 *
 *   SEED_ADMIN_PIN=<4-10 digits> node prisma/seed-pin.js                                # dry run
 *   SEED_ADMIN_PIN=<4-10 digits> node prisma/seed-pin.js --apply --confirm-database <db>
 *
 * Reads the PIN to seed from the required SEED_ADMIN_PIN environment
 * variable — there is no hardcoded default. The script refuses to run
 * (exits non-zero) if SEED_ADMIN_PIN is unset, empty, or not a 4-10 digit
 * numeric PIN, so it can never silently apply a weak or accidental value.
 *
 * Safe to re-run — uses upsert so existing records are updated, not duplicated.
 */

const path = require("path");

// The backend's own configuration loader, then the write-script guard (LOCAL only).
require(path.join(__dirname, "..", "src", "config", "env"));
const target = require(path.join(__dirname, "..", "src", "config", "environmentGuard")).requireLocalTarget(process.env);

const bcrypt = require("bcrypt");
const { PrismaClient } = require("@prisma/client");

const BCRYPT_ROUNDS = 10;
const PIN_PATTERN = /^\d{4,10}$/;

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const confirmIndex = args.indexOf("--confirm-database");
const CONFIRMED_DATABASE = confirmIndex === -1 ? null : args[confirmIndex + 1] || "";

function readRequiredPin() {
  const pin = process.env.SEED_ADMIN_PIN;

  if (!pin || !pin.trim()) {
    console.error(
      "❌ SEED_ADMIN_PIN is not set. Refusing to seed a PIN.\n" +
        "   Set it before running this script, e.g.:\n" +
        "     SEED_ADMIN_PIN=<4-10 digits> node prisma/seed-pin.js"
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
  const where = `${target.host}:${target.port}/${target.database}`;

  if (APPLY && CONFIRMED_DATABASE !== target.database) {
    console.error(`❌ --apply requires --confirm-database ${target.database} (the target is ${where}). Nothing written.`);
    process.exit(1);
  }

  const prisma = new PrismaClient();

  try {
    const users = await prisma.user.findMany({ select: { id: true, email: true } });

    if (!APPLY) {
      console.log(`🔎 Dry run: would set the PIN from SEED_ADMIN_PIN for ${users.length} user(s) in ${where}. Nothing written.`);
      console.log(`   To write: add --apply --confirm-database ${target.database}`);
      return;
    }

    console.log(`🔐 Seeding admin PIN from SEED_ADMIN_PIN for all users in ${where}...\n`);

    const pinHash = await bcrypt.hash(pin, BCRYPT_ROUNDS);

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

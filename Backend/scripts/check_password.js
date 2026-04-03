const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const bcrypt = require("bcrypt");
const { PrismaClient } = require("@prisma/client");

async function main() {
  const prisma = new PrismaClient();
  try {
    const email = process.argv[2] || "";
    const candidate = process.argv[3] || "";

    if (!email || !candidate) {
      console.error("Usage: node scripts/check_password.js <email> <password>");
      process.exitCode = 2;
      return;
    }

    const user = await prisma.user.findUnique({ where: { email }, select: { password: true } });
    if (!user) {
      console.log(JSON.stringify({ userFound: false }, null, 2));
      return;
    }

    const ok = await bcrypt.compare(candidate, user.password);
    console.log(JSON.stringify({ userFound: true, matches: ok }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("check_password failed:", e?.message || e);
  process.exitCode = 1;
});

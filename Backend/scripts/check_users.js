const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { PrismaClient } = require("@prisma/client");

async function main() {
  const prisma = new PrismaClient();
  try {
    const users = await prisma.user.findMany({
      select: { email: true, role: true, password: true, createdAt: true },
      take: 20,
      orderBy: { createdAt: "asc" },
    });

    console.log(
      "users:",
      users.map((u) => ({
        email: u.email,
        role: u.role,
        createdAt: u.createdAt,
        passwordPrefix: String(u.password || "").slice(0, 4),
      }))
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("DB query failed:", e?.message || e);
  process.exitCode = 1;
});

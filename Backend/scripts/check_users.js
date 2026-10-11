const path = require("path");

// The backend's own configuration loader and LOCAL guard (docs/runbooks/environments.md).
const { loadedFrom } = require(path.join(__dirname, "..", "src", "config", "env"));
require(path.join(__dirname, "..", "src", "config", "environmentGuard")).assertEnvironment(process.env, { loadedFrom });

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
        // Whether a password hash is stored — never any part of the hash itself.
        hasPassword: Boolean(u.password),
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

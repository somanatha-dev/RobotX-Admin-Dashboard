const bcrypt = require("bcrypt");

function getBootstrapCredentials() {
  const email = String(
    process.env.SEED_ADMIN_EMAIL ||
      process.env.ADMIN_EMAIL ||
      process.env.email ||
      ""
  ).trim();

  const password = String(
    process.env.SEED_ADMIN_PASSWORD ||
      process.env.ADMIN_PASSWORD ||
      process.env.password ||
      ""
  );

  if (!email || !password) return null;
  return { email, password };
}

async function ensureAdminUser(prisma, { logger } = {}) {
  const creds = getBootstrapCredentials();
  if (!creds) {
    (logger || console).info(
      "Admin bootstrap skipped (set SEED_ADMIN_EMAIL + SEED_ADMIN_PASSWORD to enable)"
    );
    return { bootstrapped: false, reason: "missing_credentials" };
  }

  const hashedPassword = await bcrypt.hash(creds.password, 10);

  await prisma.user.upsert({
    where: { email: creds.email },
    update: {
      password: hashedPassword,
      role: "SUPER_ADMIN",
    },
    create: {
      email: creds.email,
      password: hashedPassword,
      role: "SUPER_ADMIN",
    },
  });

  (logger || console).info("Admin user ensured", { email: creds.email });
  return { bootstrapped: true, email: creds.email };
}

module.exports = {
  ensureAdminUser,
};

const bcrypt = require("bcrypt");

const PIN_PATTERN = /^\d{4,10}$/;

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

// Gives a freshly created user their starting step-up PIN, hashed from
// DEFAULT_ADMIN_PIN. Deliberately a no-op when the user already has a PIN row:
// the `update: {}` on the upsert means an existing (possibly user-changed) PIN
// is never clobbered by a later bootstrap run. Skipped entirely when
// DEFAULT_ADMIN_PIN is unset or malformed, so an accidental/weak value can
// never be applied silently — the user is simply left at "PIN not configured".
async function ensureDefaultPin(prisma, userId, { logger } = {}) {
  const configured = String(process.env.DEFAULT_ADMIN_PIN || "").trim();
  if (!configured) return { applied: false, reason: "not_configured" };

  if (!PIN_PATTERN.test(configured)) {
    (logger || console).warn(
      "DEFAULT_ADMIN_PIN must be 4-10 digits; skipping default PIN for new user"
    );
    return { applied: false, reason: "malformed" };
  }

  const pinHash = await bcrypt.hash(configured, 10);
  await prisma.adminPinAuth.upsert({
    where: { userId },
    update: {},
    create: { userId, pinHash },
  });

  return { applied: true };
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

  const user = await prisma.user.upsert({
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
    select: { id: true },
  });

  await ensureDefaultPin(prisma, user.id, { logger });

  const logPii = String(process.env.LOG_PII || "").toLowerCase() === "true";
  if (logPii) {
    (logger || console).info("Admin user ensured", { email: creds.email });
  } else {
    (logger || console).info("Admin user ensured");
  }
  return { bootstrapped: true, email: creds.email };
}

module.exports = {
  ensureAdminUser,
  ensureDefaultPin,
};

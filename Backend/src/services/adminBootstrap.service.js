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

// RBAC — the initial SUPER_ADMIN, created once and then left alone.
//
// This used to upsert on every boot, writing the configured password and `role: SUPER_ADMIN`
// over whatever account held the email: a password the owner changed in the dashboard was
// reverted at the next restart, and a regular ADMIN created with that email would have been
// silently promoted to SUPER_ADMIN. Now:
//
//   no account with the email  → created as SUPER_ADMIN (the deterministic first account);
//   an existing SUPER_ADMIN    → unchanged. Its password is re-applied only when the operator
//                                sets SEED_ADMIN_RESET_PASSWORD=true for a lockout recovery,
//                                and that is logged;
//   any other existing account → refused and logged. A role is never raised by configuration.
async function ensureAdminUser(prisma, { logger } = {}) {
  const log = logger || console;
  const creds = getBootstrapCredentials();
  if (!creds) {
    log.info(
      "Admin bootstrap skipped (set SEED_ADMIN_EMAIL + SEED_ADMIN_PASSWORD to enable)"
    );
    return { bootstrapped: false, reason: "missing_credentials" };
  }

  const existing = await prisma.user.findUnique({ where: { email: creds.email }, select: { id: true, role: true } });

  let user = existing;
  if (!existing) {
    try {
      user = await prisma.user.create({
        data: { email: creds.email, password: await bcrypt.hash(creds.password, 10), role: "SUPER_ADMIN" },
        select: { id: true, role: true },
      });
    } catch (error) {
      // Another process booting at the same moment created it first.
      if (error?.code !== "P2002") throw error;
      user = await prisma.user.findUnique({ where: { email: creds.email }, select: { id: true, role: true } });
    }
  } else if (existing.role !== "SUPER_ADMIN") {
    log.warn("Admin bootstrap refused: the configured email belongs to an account that is not a super administrator; its role is left unchanged");
    return { bootstrapped: false, reason: "existing_account_not_super_admin" };
  } else if (String(process.env.SEED_ADMIN_RESET_PASSWORD || "").toLowerCase() === "true") {
    await prisma.user.update({ where: { id: existing.id }, data: { password: await bcrypt.hash(creds.password, 10) } });
    log.warn("Admin bootstrap re-applied the configured password to the super administrator (SEED_ADMIN_RESET_PASSWORD=true); unset it after recovery");
  }

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
  PIN_PATTERN,
  ensureAdminUser,
  ensureDefaultPin,
};

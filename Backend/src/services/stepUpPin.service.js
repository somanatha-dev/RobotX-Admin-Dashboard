"use strict";

/**
 * The signed-in account's step-up PIN — set or changed by the account itself.
 *
 * The dashboard asks for this PIN (or a passkey, whose registration itself requires the PIN)
 * before task creation, cancellation and robot commands. Until now the only writer of a PIN
 * was the boot bootstrap's `DEFAULT_ADMIN_PIN`, applied to the first SUPER_ADMIN alone, so an
 * account a SUPER_ADMIN created could never pass that dialog.
 *
 * Setting or changing it requires the account's current password, re-verified here with
 * bcrypt — a stolen session cookie alone cannot set one. The PIN is stored as a bcrypt hash
 * (cost 10, as `verifyUserPin` and the bootstrap use) and is never returned, logged or put
 * on the audit stream; the change itself is an audited OPERATOR_ACTION.
 *
 * What this does NOT change: the step-up dialog is still enforced in the browser only. A
 * successful `POST /api/auth/pin-auth` returns `{ authorized: true }` and records nothing the
 * action routes check, so a client that skips the dialog reaches the same APIs; every RBAC,
 * campus, §23.4 action-class and reason rule still applies to it.
 */

const bcrypt = require("bcrypt");

const { PIN_PATTERN } = require("./adminBootstrap.service");
const { withAudit } = require("./adminAudit.service");

function fail(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/** @returns {Promise<{ configured: boolean }>} */
async function pinStatus(prisma, userId) {
  const row = await prisma.adminPinAuth.findUnique({ where: { userId }, select: { id: true } });
  return { configured: Boolean(row) };
}

/**
 * @param {object} prisma
 * @param {{ id: string, role: string }} actor the verified session's account
 * @param {{ currentPassword?: string, pin?: string }} body
 * @returns {Promise<{ configured: true, changed: boolean }>}
 */
async function setPin(prisma, actor, body) {
  const source = body && typeof body === "object" ? body : {};
  const currentPassword = typeof source.currentPassword === "string" ? source.currentPassword : "";
  const pin = typeof source.pin === "string" ? source.pin.trim() : "";

  if (!currentPassword) throw fail(400, "PASSWORD_REQUIRED", "Your current password is required to set a PIN");
  if (!PIN_PATTERN.test(pin)) throw fail(400, "INVALID_PIN", "The PIN must be 4 to 10 digits");

  const user = await prisma.user.findUnique({ where: { id: actor.id }, select: { id: true, password: true } });
  if (!user) throw fail(401, "UNAUTHORIZED", "Unauthorized");
  if (!(await bcrypt.compare(currentPassword, user.password))) {
    throw fail(400, "WRONG_PASSWORD", "Current password is incorrect");
  }

  const pinHash = await bcrypt.hash(pin, 10);
  return withAudit(prisma, async (tx) => {
    const existing = await tx.adminPinAuth.findUnique({ where: { userId: user.id }, select: { id: true } });
    await tx.adminPinAuth.upsert({ where: { userId: user.id }, update: { pinHash }, create: { userId: user.id, pinHash } });
    return {
      result: { configured: true, changed: Boolean(existing) },
      event: {
        actorId: actor.id,
        actorRole: actor.role,
        subjectType: "USER",
        subjectId: user.id,
        payload: { action: existing ? "STEP_UP_PIN_CHANGED" : "STEP_UP_PIN_SET" },
      },
    };
  });
}

module.exports = { pinStatus, setPin };

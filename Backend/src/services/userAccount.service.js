"use strict";

/**
 * RBAC — campus administrator accounts, managed by a SUPER_ADMIN (`/api/users`).
 *
 * The caller's identity and authority come from the verified session (`req.user`), never
 * from the request. The role is not an input: this service creates `ADMIN` accounts only and
 * refuses a body that names a role at all, so no request can create or promote a
 * SUPER_ADMIN. Each change is one transaction together with its audit event
 * (`adminAudit.withAudit`), so an account is never left half-made or unrecorded; the
 * `User_role_campus_scope` CHECK holds "ADMIN ⇔ exactly one campus" underneath it.
 *
 * Passwords are hashed with bcrypt (cost 10, as `auth_controller` does) and are never
 * returned, logged or put on the audit stream.
 */

const bcrypt = require("bcrypt");

const { withAudit } = require("./adminAudit.service");

const PASSWORD_MIN_LENGTH = 12;
/** bcrypt reads at most 72 bytes; a longer password would be silently truncated. */
const PASSWORD_MAX_BYTES = 72;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ACCOUNT_SELECT = Object.freeze({
  id: true,
  email: true,
  role: true,
  campusId: true,
  disabledAt: true,
  createdAt: true,
  campus: { select: { id: true, code: true, name: true } },
});

function fail(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function toPublic(row) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    campus: row.campus ? { id: row.campus.id, code: row.campus.code, name: row.campus.name } : null,
    disabled: Boolean(row.disabledAt),
    disabledAt: row.disabledAt || null,
    createdAt: row.createdAt,
  };
}

function rejectUnknownKeys(body, allowed) {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.includes("role")) {
    throw fail(400, "ROLE_NOT_SETTABLE", "The role is not an input: this endpoint manages campus administrator (ADMIN) accounts only.");
  }
  if (unknown.length > 0) throw fail(400, "UNKNOWN_FIELDS", `Unknown field(s): ${unknown.join(", ")}`);
}

async function requireCampus(prisma, campusId) {
  if (typeof campusId !== "string" || !campusId.trim()) {
    throw fail(400, "CAMPUS_REQUIRED", "Exactly one campus is required: campusId must be a single campus id.");
  }
  const campus = await prisma.campus.findUnique({ where: { id: campusId.trim() }, select: { id: true, code: true } });
  if (!campus) throw fail(400, "INVALID_CAMPUS", "campusId does not name a campus");
  return campus;
}

/** @returns {Promise<object[]>} every account, safe fields only */
async function listAccounts(prisma) {
  const rows = await prisma.user.findMany({ select: ACCOUNT_SELECT, orderBy: [{ role: "asc" }, { email: "asc" }] });
  return rows.map(toPublic);
}

/**
 * @param {object} prisma
 * @param {object} body `{ email, password, campusId }`
 * @param {{ id: string, role: string }} actor the verified SUPER_ADMIN
 */
async function createAdmin(prisma, body, actor) {
  const source = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  rejectUnknownKeys(source, ["email", "password", "campusId"]);

  const email = typeof source.email === "string" ? source.email.trim() : "";
  if (!EMAIL_PATTERN.test(email)) throw fail(400, "INVALID_EMAIL", "A valid email address is required");

  const password = typeof source.password === "string" ? source.password : "";
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw fail(400, "WEAK_PASSWORD", `The password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) {
    throw fail(400, "PASSWORD_TOO_LONG", `The password must be at most ${PASSWORD_MAX_BYTES} bytes`);
  }

  const campus = await requireCampus(prisma, source.campusId);

  // Emails are matched exactly at sign-in; refuse one that differs from an existing account
  // only by letter case rather than create a look-alike.
  const clash = await prisma.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } }, select: { id: true } });
  if (clash) throw fail(409, "EMAIL_IN_USE", "An account with this email already exists");

  const hash = await bcrypt.hash(password, 10);
  try {
    return await withAudit(prisma, async (tx) => {
      const created = await tx.user.create({ data: { email, password: hash, role: "ADMIN", campusId: campus.id }, select: ACCOUNT_SELECT });
      return {
        result: toPublic(created),
        event: {
          actorId: actor.id,
          actorRole: actor.role,
          subjectType: "USER",
          subjectId: created.id,
          payload: { action: "ADMIN_CREATED", role: "ADMIN", campusId: campus.id, campusCode: campus.code },
        },
      };
    });
  } catch (error) {
    if (error?.code === "P2002") throw fail(409, "EMAIL_IN_USE", "An account with this email already exists");
    throw error;
  }
}

/**
 * Change a campus administrator's campus, or disable / re-enable it. A SUPER_ADMIN account is
 * not managed here (including the caller's own), and the role is never changed.
 *
 * @param {object} prisma
 * @param {string} userId
 * @param {object} body `{ campusId?, disabled? }`
 * @param {{ id: string, role: string }} actor
 * @returns {Promise<object>} the account after the change
 */
async function updateAdmin(prisma, userId, body, actor) {
  const source = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  rejectUnknownKeys(source, ["campusId", "disabled"]);
  const hasCampus = Object.prototype.hasOwnProperty.call(source, "campusId");
  const hasDisabled = Object.prototype.hasOwnProperty.call(source, "disabled");
  if (!hasCampus && !hasDisabled) throw fail(400, "NOTHING_TO_UPDATE", "Nothing to update: send campusId and/or disabled");
  if (hasDisabled && typeof source.disabled !== "boolean") throw fail(400, "INVALID_DISABLED", "disabled must be true or false");

  const target = await prisma.user.findUnique({ where: { id: String(userId) }, select: ACCOUNT_SELECT });
  if (!target) throw fail(404, "UNKNOWN_USER", "Unknown user");
  if (target.role !== "ADMIN") {
    throw fail(403, "NOT_MANAGEABLE", "Only campus administrator (ADMIN) accounts are managed here; a super administrator account is not.");
  }

  const campus = hasCampus ? await requireCampus(prisma, source.campusId) : null;
  const data = {};
  const actions = [];
  if (campus && campus.id !== target.campusId) {
    data.campusId = campus.id;
    actions.push({ action: "ADMIN_CAMPUS_CHANGED", fromCampusId: target.campusId, toCampusId: campus.id });
  }
  if (hasDisabled && source.disabled !== Boolean(target.disabledAt)) {
    data.disabledAt = source.disabled ? new Date() : null;
    actions.push({ action: source.disabled ? "ADMIN_DISABLED" : "ADMIN_ENABLED" });
  }
  if (actions.length === 0) return { account: toPublic(target), changed: false };

  const account = await withAudit(prisma, async (tx) => {
    const updated = await tx.user.update({ where: { id: target.id }, data, select: ACCOUNT_SELECT });
    return {
      result: toPublic(updated),
      event: {
        actorId: actor.id,
        actorRole: actor.role,
        subjectType: "USER",
        subjectId: target.id,
        payload: actions.length === 1 ? actions[0] : { action: "ADMIN_UPDATED", changes: actions },
      },
    };
  });
  return { account, changed: true };
}

module.exports = {
  PASSWORD_MIN_LENGTH,
  listAccounts,
  createAdmin,
  updateAdmin,
};

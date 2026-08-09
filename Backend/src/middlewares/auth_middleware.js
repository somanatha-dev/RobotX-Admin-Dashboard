const jwt = require("jsonwebtoken");

const { getPrisma } = require("../db/prisma");
// PHASE 14 — §23.4's scoped RBAC/ABAC. The rules live in the engine module that owns
// §23.6's discipline; this file is the transport-layer application of them, so that the
// four high-privilege action classes are gated from one register rather than from four
// independently-remembered decisions in four route files.
const override = require("../engine/security/override");
const auditStream = require("../engine/observability/auditStream");

function isUuid(value) {
  if (typeof value !== "string") return false;
  // Accept UUID v1-v5; Prisma UUID columns require a valid UUID string.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

// Verifies a raw JWT and resolves it to the current user, or null if the
// token is missing/invalid/expired/unknown. Shared by the HTTP `authUser`
// middleware and the Socket.IO dashboard connection gate so both surfaces
// enforce identical rules.
async function verifyUserToken(token) {
  if (!token || !process.env.JWT_SECRET) return null;

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded?.id || !isUuid(decoded.id)) return null;

    const prisma = getPrisma();
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: {
        id: true,
        email: true,
        role: true
      }
    });

    return user || null;
  } catch {
    return null;
  }
}

async function authUser(req, res, next) {
  const cookieToken = req.cookies?.token;
  const header = req.headers.authorization;
  const bearerToken = typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice("Bearer ".length).trim()
    : null;

  const token = cookieToken || bearerToken;

  if (!token) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ message: "Server misconfigured" });
  }

  const user = await verifyUserToken(token);
  if (!user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  // Attach minimal data
  req.user = user;

  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 14 — §23.4 authorisation.
//
//   > Operator actions are gated by scoped RBAC/ABAC: region, fleet, tenant, and action
//   > class.
//
//   > Highest-privilege actions — quarantine override, safety-class config change, bulk
//   > cancellation, manual assignment against a Policy constraint — require elevated role
//   > plus a recorded reason, and where configured a second approver.
//
// ── Why the role list comes from the register ────────────────────────────────
// Before this phase, `config.routes.js` and `shards.routes.js` each carried their own
// `const ELEVATED_ROLES = ["SUPER_ADMIN"]`, with a comment in each saying the other one
// existed. Two copies of an authorisation list is one copy that gets updated. The list is
// now `security.elevated_roles` in the parameter register, resolved here, and the two
// route files read it through this middleware. Its default is exactly the value they
// both held, so nothing changes behaviourally on the day this lands.
//
// ── Why a refused action is still audited ────────────────────────────────────
// §23.6 requires every override to be audited, and a refusal is the record an
// investigation most wants: a stream holding only successes answers "nobody tried" to a
// question whose true answer is "somebody tried eleven times". The append is best-effort
// and never blocks the response — an audit write that failed must not turn a *refusal*
// into a 500 that a caller could retry into a different outcome.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read a configuration value from the process's pinned snapshot, falling back to the
 * register default that `configService.bootstrap()` already resolved.
 *
 * @param {object} req
 * @param {string} name
 * @param {*} fallback
 * @returns {*}
 */
function configValue(req, name, fallback) {
  const values = req.app?.locals?.config?.values;
  const value = values instanceof Map ? values.get(name) : values?.[name];
  return value === undefined || value === null ? fallback : value;
}

/**
 * The policy §23.4 is evaluated against, assembled from the register and from the
 * authenticated user.
 *
 * `scope` is read from the user row where the deployment models one. The `User` table
 * carries no region, fleet or tenant column today, so the scope is undefined and
 * `override.outOfScope()` treats it as unscoped — which is the current behaviour,
 * stated rather than assumed. When those columns land, this is the single place that
 * changes and every gated surface inherits it.
 *
 * @param {object} req
 * @returns {object}
 */
function policyFor(req) {
  return {
    elevatedRoles: configValue(req, "security.elevated_roles", ["SUPER_ADMIN"]),
    requireSecondApproverFor: configValue(req, "security.second_approver_action_classes", []),
    scope: req.user?.scope,
  };
}

/**
 * Gate a route on an elevated role alone, without the full action-class machinery.
 *
 * Used where the surface is a *read* that happens to be privileged — the Config
 * Service's resolution-explain, the shard register — rather than one of §23.4's four
 * named actions.
 *
 * @returns {import("express").RequestHandler}
 */
function requireElevatedRole() {
  return function elevatedRoleGate(req, res, next) {
    const roles = configValue(req, "security.elevated_roles", ["SUPER_ADMIN"]);
    if (!Array.isArray(roles) || !roles.includes(req.user?.role)) {
      return res.status(403).json({
        ok: false,
        error: "Forbidden",
        detail: "this surface requires an elevated role (§23.4)",
      });
    }
    return next();
  };
}

/**
 * Gate a route on one of §23.4's high-privilege action classes.
 *
 * Attaches `req.override` — the granted decision plus the request it decided — so the
 * controller records the same authorisation it was admitted by rather than re-deriving
 * one.
 *
 * @param {string} actionClassId one of `override.ACTION_CLASS`
 * @param {object} [options] `{ subjectFrom }` — extracts `{ regionId, tenantId, fleetId }`
 *   and the subject id from the request, for the ABAC half
 * @returns {import("express").RequestHandler}
 */
function requireActionClass(actionClassId, options) {
  const settings = options || {};

  return async function actionClassGate(req, res, next) {
    const request = {
      actionClass: actionClassId,
      actorId: req.user?.id ?? null,
      actorRole: req.user?.role ?? null,
      // §23.4 — "plus a recorded reason". Accepted from the body or an explicit header,
      // because a DELETE has no body and an operator tool should not have to invent one.
      reason: typeof req.body?.reason === "string" && req.body.reason.trim() ? req.body.reason.trim() : req.get?.("X-Override-Reason") || null,
      secondApproverId:
        (typeof req.body?.secondApproverId === "string" && req.body.secondApproverId.trim())
          ? req.body.secondApproverId.trim()
          : req.get?.("X-Second-Approver") || null,
    };

    const subject = typeof settings.subjectFrom === "function" ? settings.subjectFrom(req) : {};
    const decision = override.authoriseAction(request, policyFor(req), subject);

    await recordAuthorisation(req, decision, request, subject);

    if (!decision.granted) {
      const status = decision.refusal === override.REFUSAL.ROLE_NOT_ELEVATED || decision.refusal === override.REFUSAL.OUT_OF_SCOPE ? 403 : 400;
      return res.status(status).json({ ok: false, error: "Forbidden", refusal: decision.refusal, detail: decision.detail });
    }

    req.override = { decision, request, subject };
    return next();
  };
}

/**
 * Append the authorisation decision to the hash-chained audit stream and to the
 * queryable `OverrideAudit` table.
 *
 * Best-effort: an audit write that failed must not turn a refusal into a 500, because a
 * caller that received a 500 would retry, and a retry that happened to land after the
 * audit recovered would look like a first attempt.
 *
 * @param {object} req
 * @param {object} decision
 * @param {object} request
 * @param {object} subject
 * @returns {Promise<void>}
 */
async function recordAuthorisation(req, decision, request, subject) {
  const prisma = req.app?.locals?.prisma;
  if (!prisma) return;

  const at = new Date();
  try {
    const appended = await auditStream.append(
      { prisma },
      override.toAuditEvent(decision, request, {
        subjectType: subject?.subjectType ?? "OPERATOR_ACTION",
        subjectId: subject?.subjectId ?? null,
        recordedAtMs: at.getTime(),
      }),
    );

    await prisma.overrideAudit.create({
      data: override.toOverrideAuditRow(decision, request, {
        subjectType: subject?.subjectType ?? null,
        subjectId: subject?.subjectId ?? null,
        decisionId: subject?.decisionId ?? null,
        auditEventHash: appended?.event?.hash ?? null,
        at,
      }),
    });
  } catch (error) {
    (req.app?.locals?.logger || console).warn?.("override audit write failed", {
      actionClass: request.actionClass,
      granted: decision.granted,
      message: error?.message,
    });
  }
}

module.exports = {
  authUser,
  verifyUserToken,
  configValue,
  policyFor,
  requireElevatedRole,
  requireActionClass,
  recordAuthorisation,
};

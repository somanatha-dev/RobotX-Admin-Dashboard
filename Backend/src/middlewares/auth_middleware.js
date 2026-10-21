const jwt = require("jsonwebtoken");

const { getPrisma } = require("../db/prisma");
// PHASE 14 — §23.4's scoped RBAC/ABAC. The rules live in the engine module that owns
// §23.6's discipline; this file is the transport-layer application of them, so that the
// four high-privilege action classes are gated from one register rather than from four
// independently-remembered decisions in four route files.
const override = require("../engine/security/override");
const auditStream = require("../engine/observability/auditStream");
const accessScope = require("../services/accessScope.service");

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
//
// RBAC — the role and campus are read from the row on every call, never from the token's
// claims, so a role or campus change applies to the next request. A disabled account
// resolves to null: its unexpired JWT stops working at once.
async function verifyUserToken(token) {
  return (await resolveUserToken(token)).user;
}

/**
 * `verifyUserToken`, with the reason when there is no user: `ACCOUNT_DISABLED` for a valid
 * token whose account a SUPER_ADMIN disabled, so the dashboard can say "access revoked"
 * rather than "session expired". It tells the token's holder only what its own account is.
 *
 * `lookupFailed` is true when the token was valid but the account could not be read (a database
 * error): there is no user to admit, but nothing says the session ended either. `authUser` still
 * refuses such a request; the dashboard socket's periodic re-check keeps the socket and asks
 * again next time rather than ending a session over a transient error.
 *
 * @returns {Promise<{ user: object|null, reason: string|null, lookupFailed?: boolean }>}
 */
async function resolveUserToken(token) {
  if (!token || !process.env.JWT_SECRET) return { user: null, reason: null };

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return { user: null, reason: null };
  }
  if (!decoded?.id || !isUuid(decoded.id)) return { user: null, reason: null };

  let user;
  try {
    const prisma = getPrisma();
    user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: accessScope.USER_SCOPE_SELECT,
    });
  } catch {
    return { user: null, reason: null, lookupFailed: true };
  }

  if (!user) return { user: null, reason: null };
  if (user.disabledAt) return { user: null, reason: "ACCOUNT_DISABLED" };
  return { user, reason: null };
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

  const { user, reason } = await resolveUserToken(token);
  if (!user) {
    return res.status(401).json(reason ? { message: "Your access has been revoked", code: reason } : { message: "Unauthorized" });
  }

  // Attach minimal data
  req.user = user;
  // RBAC — what this account may see, computed once from its own row (see accessScope).
  req.access = accessScope.accessScopeFor(user);

  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// RBAC — role and campus gates.
//
// `requireSuperAdmin` checks the role itself rather than `security.elevated_roles`. That
// register is a publishable configuration value; the platform-administration surfaces
// (accounts, campuses, the simulator, physical commissioning) must not open to a role
// because a configuration version listed it. The §23.4 gates keep reading the register.
//
// Mixed routers declare their ADMIN-capable routes first and then `router.use(
// requireSuperAdmin())`, so a route added below that barrier is SUPER_ADMIN-only by
// construction — default deny, rather than a check each new route must remember.
// ─────────────────────────────────────────────────────────────────────────────

const FORBIDDEN = Object.freeze({ ok: false, error: "Forbidden", detail: "this surface is reserved for a super administrator" });

/** @returns {import("express").RequestHandler} */
function requireSuperAdmin() {
  return function superAdminGate(req, res, next) {
    if (accessScope.isSuperAdmin(req.access ?? accessScope.accessScopeFor(req.user))) return next();
    // A refused attempt is worth a line: account ids and the route only, no personal data.
    const path = `${req.baseUrl || ""}${req.path || ""}`;
    req.app?.locals?.logger?.warn?.("RBAC: super administrator surface refused", {
      userId: req.user?.id ?? null,
      role: req.user?.role ?? null,
      method: req.method,
      path,
    });
    // §23.6's convention — a refused privileged *action* is on the record, like the action-class
    // gate's refusals. Mutating requests only, so a polling read cannot flood the chain; and
    // best-effort, never awaited, so an audit outage cannot turn a 403 into something else.
    const prisma = req.app?.locals?.prisma;
    if (prisma && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      auditStream
        .append(
          { prisma },
          {
            eventType: auditStream.EVENT_TYPE.OPERATOR_ACTION,
            actorId: req.user?.id ?? null,
            actorRole: req.user?.role ?? null,
            subjectType: "ROUTE",
            subjectId: path,
            payload: { action: "RBAC_REFUSED", method: req.method },
            recordedAtMs: Date.now(),
          },
        )
        .catch(() => {});
    }
    return res.status(403).json(FORBIDDEN);
  };
}

/**
 * Admit a SUPER_ADMIN, or an ADMIN with a valid campus assignment. An ADMIN whose campus is
 * missing or unresolvable is refused here — it never reaches a handler as "unscoped".
 *
 * @returns {import("express").RequestHandler}
 */
function requireScopedAccess() {
  return function scopedAccessGate(req, res, next) {
    const scope = req.access ?? accessScope.accessScopeFor(req.user);
    req.access = scope;
    if (scope.kind === accessScope.SCOPE.ALL || scope.kind === accessScope.SCOPE.CAMPUS) return next();
    return res.status(403).json({ ok: false, error: "Forbidden", refusal: "INVALID_SCOPE", detail: scope.reason || "no valid access scope" });
  };
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
    const policy = policyFor(req);
    let decision = override.authoriseAction(request, policy, subject);

    // The second approver is an account, not a string: resolved only once everything else has
    // been granted (an unelevated caller learns nothing about which accounts exist), and refused
    // when the lookup cannot answer — an unverified approver is not an approver.
    if (decision.granted && override.secondApproverRequired(actionClassId, policy)) {
      decision = await verifySecondApprover(request, policy);
    }

    await recordAuthorisation(req, decision, request, subject);

    if (!decision.granted) {
      return res.status(REFUSAL_STATUS[decision.refusal] || 400).json({ ok: false, error: "Forbidden", refusal: decision.refusal, detail: decision.detail });
    }

    req.override = { decision, request, subject };
    return next();
  };
}

/** HTTP status per refusal; any other refusal is a 400. */
const REFUSAL_STATUS = Object.freeze({
  [override.REFUSAL.ROLE_NOT_ELEVATED]: 403,
  [override.REFUSAL.OUT_OF_SCOPE]: 403,
  [override.REFUSAL.SECOND_APPROVER_NOT_ELEVATED]: 403,
  [override.REFUSAL.SECOND_APPROVER_UNVERIFIABLE]: 503,
});

/**
 * Resolve the second approver's identity to its `User` row and judge it
 * (`override.assessSecondApprover`). Read from the same store `authUser` resolves the caller
 * from. An identity that is not a UUID names no account and is refused without a query. Shared
 * by this gate and by `tasks.controller`'s class C waiver, so both apply one check.
 *
 * @param {object} request the request `authoriseAction` (or `authoriseWaiver`) granted
 * @param {object} policy
 * @returns {Promise<object>} the final decision
 */
async function verifySecondApprover(request, policy) {
  let approver = null;
  if (isUuid(request.secondApproverId)) {
    try {
      approver = await getPrisma().user.findUnique({
        where: { id: request.secondApproverId },
        select: { id: true, role: true },
      });
    } catch {
      return {
        granted: false,
        refusal: override.REFUSAL.SECOND_APPROVER_UNVERIFIABLE,
        detail: "the second approver's account could not be read, so the approval cannot be verified",
        actionClass: override.ACTION_CLASS[request.actionClass] || null,
      };
    }
  }
  return override.assessSecondApprover(request, approver, policy);
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
  requireSuperAdmin,
  requireScopedAccess,
  verifyUserToken,
  resolveUserToken,
  configValue,
  policyFor,
  requireElevatedRole,
  requireActionClass,
  verifySecondApprover,
  recordAuthorisation,
};

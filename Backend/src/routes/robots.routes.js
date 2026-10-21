const express = require("express");
const robotsController = require("../controllers/robots.controller");
const { createRateLimiter } = require("../middlewares/rateLimitHttp");
const { authUser, requireActionClass, requireElevatedRole, requireScopedAccess, requireSuperAdmin } = require("../middlewares/auth_middleware");
const { robotParamInScope } = require("../middlewares/campusScope");
// Soft retirement — a retired robot keeps its row, so each per-robot action refuses it by
// name (409 ROBOT_RETIRED). Mounted after the rate limiter and before the override gate.
const { refuseRetiredRobot } = require("../middlewares/refuseRetiredRobot");
// PHASE 14 — §23.4's action-class register.
const override = require("../engine/security/override");

const router = express.Router();

router.use(authUser);

// PHASE 14 — §23.4: "Highest-privilege actions — **quarantine override**, safety-class
// config change, bulk cancellation, manual assignment against a Policy constraint —
// require elevated role plus a recorded reason, and where configured a second approver."
//
// Two routes on this router are quarantine overrides in the specification's sense —
// operator actions that return an agent the system has withdrawn to service:
//
//   * `POST /:robotId/clear-fault` clears `Robot.status = ERROR` and `healthStatus = FAULT`.
//     Those are the two states predicates F3 and F8 read, so clearing them is precisely
//     "returning a quarantined agent to eligibility".
//   * `POST /:robotId/pairing/unlock` clears the F32 brute-force lockout. It is an
//     operator lifting a security control the system applied, which is the same act.
//
// The reason is mandatory and lands in both the hash-chained audit stream and the
// queryable `OverrideAudit` table, and a second approver is required because
// `security.second_approver_action_classes` names QUARANTINE_OVERRIDE by default.
const quarantineOverride = requireActionClass(override.ACTION_CLASS.QUARANTINE_OVERRIDE.id, {
  subjectFrom: (req) => ({ subjectType: "ROBOT", subjectId: req.params?.robotId ? String(req.params.robotId) : null }),
});

const commissionLimiter = createRateLimiter({ windowMs: 60_000, limit: 30, keyPrefix: "commission" });
const commandLimiter = createRateLimiter({ windowMs: 60_000, limit: 60, keyPrefix: "command" });
const retireLimiter = createRateLimiter({ windowMs: 60_000, limit: 10, keyPrefix: "retire" });
const legacyCommissionLimiter = createRateLimiter({ windowMs: 60_000, limit: 30, keyPrefix: "commission_legacy" });
const recommissionLimiter = createRateLimiter({ windowMs: 60_000, limit: 10, keyPrefix: "recommission" });
const notRetired = refuseRetiredRobot();

// Recommissioning returns a withdrawn unit's record to the fleet, so it is gated server-side on
// the elevated role (`security.elevated_roles`), like simulated-robot creation. It is not one of
// §23.4's four action classes — it does not make the unit eligible for work, which stays the
// physical fleet declaration's decision — so it is not routed through `requireActionClass`; the
// service adds the mandatory reason and the typed confirmation, and records the Event.
const elevatedOnly = requireElevatedRole();

// RBAC — `scoped` admits a SUPER_ADMIN or an ADMIN with a valid campus; `superAdminOnly` a
// SUPER_ADMIN alone. Applied per route on the ADMIN-capable and §23.4 routes, and as a
// router-level barrier for everything declared after it.
const scoped = requireScopedAccess();
const superAdminOnly = requireSuperAdmin();

// ── RBAC: ADMIN-capable, scoped to the caller's campus ─────────────────────────
// The lists filter in the controller; a per-robot route checks the robot's campus first, so
// a robot of another campus is the same 404 as one that does not exist.
router.get("/", scoped, robotsController.listRobots);
// Retired units, for the dashboard's "Recommission retired robot" choice. Declared before any
// `/:robotId` route; identity and display fields only. SUPER_ADMIN only: it sits above the
// barrier only to keep that ordering, so it carries its own gate.
router.get("/retired", superAdminOnly, robotsController.listRetiredRobots);
// New: dashboard initial load (DB + Redis live state merge)
router.get("/state", scoped, robotsController.getRobotsState);
// Optional: telemetry history (last 50 snapshots)
router.get("/:robotId/history", scoped, robotParamInScope(), robotsController.getRobotHistory);
// New: command API with ACK tracking (robot must be online to receive immediately). An ADMIN
// may send only the commands that restrict motion (STOP, PAUSE) — enforced in the controller.
router.post("/:robotId/command", commandLimiter, scoped, robotParamInScope(), notRetired, robotsController.sendRobotCommand);

// ── RBAC: §23.4 quarantine overrides — SUPER_ADMIN only, after the action-class gate ────
// The action-class gate runs first, exactly as before, so a refused attempt is decided and
// audited (OverrideAudit and the audit stream) by the one gate §23.6's override rates are read
// from. `superAdminOnly` then holds even if a configuration version ever listed another role
// as elevated. A campus ADMIN is first narrowed to its own campus's robots (404 otherwise).
// Admin override: clear a robot's pairing brute-force lockout (F32) before its TTL elapses.
router.post("/:robotId/pairing/unlock", commandLimiter, robotParamInScope("robotId", { deferInvalid: true }), notRetired, quarantineOverride, superAdminOnly, robotsController.unlockPairing);
// F33: deliberate fault-recovery — clears ERROR/healthStatus:FAULT back to a live state.
router.post("/:robotId/clear-fault", commandLimiter, robotParamInScope("robotId", { deferInvalid: true }), notRetired, quarantineOverride, superAdminOnly, robotsController.clearRobotFault);

// ── RBAC: SUPER_ADMIN only — every route below this line ───────────────────────
router.use(superAdminOnly);

// RBAC — assign a unit to a campus (or clear it). The only writer of `Robot.campusId` after
// commissioning; it is what places an existing robot in a campus administrator's scope.
router.put("/:robotId/campus", commandLimiter, robotsController.assignRobotCampus);
// New: secure pairing/commissioning flow (does not replace existing POST /).
router.post("/commission", commissionLimiter, refuseRetiredRobot({ from: "body" }), robotsController.commissionRobotWithPairing);
// H3: where a robot's enrollment stands (pending code, lockout, enrolled, online). Read-only, and
// it never returns the code. Polled by nothing: the Connect page reads it on load and on refresh,
// and follows robot_online / robot_offline / robot_pairing_rejected after that.
router.get("/:robotId/pairing", robotsController.getPairingStatus);
// Gate 1: operator-declared state of charge for a physical unit (no battery ADC).
router.post("/:robotId/soc-declaration", commandLimiter, notRetired, robotsController.declareStateOfCharge);
// Edit a commissioned unit's configuration — name, chassis family, and the six
// specification values. Observed state and assignment state are deliberately not
// editable; the controller rejects any other field by name rather than ignoring it.
//
// Rate-limited with the command limiter rather than a new bucket: an edit is an ordinary
// operator action at the same cadence as a STOP or a PAUSE, and a fourth limiter for one
// route is a fourth thing to keep in step.
router.patch("/:robotId", commandLimiter, notRetired, robotsController.updateRobot);
// Retire (decommission) a robot. A soft retirement: the rows and their history stay, the
// Agent becomes DECOMMISSIONED — see services/robotRetirement.service.js. Repeating it is
// a success, so this route deliberately has no retired-robot refusal.
router.delete("/:robotId", retireLimiter, robotsController.deleteRobot);
// Recommission a retired robot: the same Robot/Agent rows, DECOMMISSIONED -> COMMISSIONED, old
// credentials revoked — see services/robotRecommission.service.js. Deliberately no
// `notRetired`: a retired unit is the only one this route acts on.
router.post("/:robotId/recommission", recommissionLimiter, elevatedOnly, robotsController.recommissionRobot);
// Put one declared physical unit in service from the loaded physical fleet declaration — the
// write the boot makes, for a unit commissioned or recommissioned after it. Elevated role here;
// the service adds the reason, the typed confirmation and the Event. A retired unit is refused
// (recommission first), so it shares recommissioning's limiter rather than `notRetired`'s 409.
router.post("/:robotId/physical-declaration/apply", recommissionLimiter, elevatedOnly, robotsController.applyPhysicalDeclaration);
router.post("/", legacyCommissionLimiter, robotsController.commissionRobot);

module.exports = router;

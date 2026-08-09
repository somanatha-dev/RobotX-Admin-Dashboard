const express = require("express");
const robotsController = require("../controllers/robots.controller");
const { createRateLimiter } = require("../middlewares/rateLimitHttp");
const { authUser, requireActionClass } = require("../middlewares/auth_middleware");
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

router.get("/", robotsController.listRobots);
// New: dashboard initial load (DB + Redis live state merge)
router.get("/state", robotsController.getRobotsState);
// Optional: telemetry history (last 50 snapshots)
router.get("/:robotId/history", robotsController.getRobotHistory);
// New: secure pairing/commissioning flow (does not replace existing POST /).
router.post("/commission", commissionLimiter, robotsController.commissionRobotWithPairing);
// Admin override: clear a robot's pairing brute-force lockout (F32) before its TTL elapses.
router.post("/:robotId/pairing/unlock", commandLimiter, quarantineOverride, robotsController.unlockPairing);
// New: command API with ACK tracking (robot must be online to receive immediately).
router.post("/:robotId/command", commandLimiter, robotsController.sendRobotCommand);
// F33: deliberate fault-recovery — clears ERROR/healthStatus:FAULT back to a live state.
router.post("/:robotId/clear-fault", commandLimiter, quarantineOverride, robotsController.clearRobotFault);
// Decommission a robot
router.delete("/:robotId", retireLimiter, robotsController.deleteRobot);
router.post("/", legacyCommissionLimiter, robotsController.commissionRobot);

module.exports = router;

const express = require("express");
const robotsController = require("../controllers/robots.controller");
const { createRateLimiter } = require("../middlewares/rateLimitHttp");
const { authUser } = require("../middlewares/auth_middleware");

const router = express.Router();

router.use(authUser);

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
router.post("/:robotId/pairing/unlock", commandLimiter, robotsController.unlockPairing);
// New: command API with ACK tracking (robot must be online to receive immediately).
router.post("/:robotId/command", commandLimiter, robotsController.sendRobotCommand);
// F33: deliberate fault-recovery — clears ERROR/healthStatus:FAULT back to a live state.
router.post("/:robotId/clear-fault", commandLimiter, robotsController.clearRobotFault);
// Decommission a robot
router.delete("/:robotId", retireLimiter, robotsController.deleteRobot);
router.post("/", legacyCommissionLimiter, robotsController.commissionRobot);

module.exports = router;

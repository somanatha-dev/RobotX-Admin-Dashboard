const express = require("express");
const robotsController = require("../controllers/robots.controller");
const { createRateLimiter } = require("../middlewares/rateLimitHttp");

const router = express.Router();

const commissionLimiter = createRateLimiter({ windowMs: 60_000, limit: 30, keyPrefix: "commission" });
const commandLimiter = createRateLimiter({ windowMs: 60_000, limit: 60, keyPrefix: "command" });
const retireLimiter = createRateLimiter({ windowMs: 60_000, limit: 10, keyPrefix: "retire" });

router.get("/", robotsController.listRobots);
// New: dashboard initial load (DB + Redis live state merge)
router.get("/state", robotsController.getRobotsState);
// Optional: telemetry history (last 50 snapshots)
router.get("/:robotId/history", robotsController.getRobotHistory);
// New: secure pairing/commissioning flow (does not replace existing POST /).
router.post("/commission", commissionLimiter, robotsController.commissionRobotWithPairing);
// New: command API with ACK tracking (robot must be online to receive immediately).
router.post("/:robotId/command", commandLimiter, robotsController.sendRobotCommand);
// Decommission a robot
router.delete("/:robotId", retireLimiter, robotsController.deleteRobot);
router.post("/", robotsController.commissionRobot);

module.exports = router;

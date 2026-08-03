const express = require("express");
const legsController = require("../controllers/legs.controller");
const { createRateLimiter } = require("../middlewares/rateLimitHttp");
const { authUser } = require("../middlewares/auth_middleware");

const router = express.Router();

router.use(authUser);

// PHASE 5 — the operator-visibility surface for §4.5's durable timers. Read-only, and
// rate-limited like every other authenticated read: an operator refreshing a stuck Leg
// during an incident should not be able to add load to the store the incident is already
// stressing.
const supervisionLimiter = createRateLimiter({ windowMs: 60_000, limit: 120, keyPrefix: "leg_supervision" });

router.get("/:legId/supervision", supervisionLimiter, legsController.getSupervision);

module.exports = router;

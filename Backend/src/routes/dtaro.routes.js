const express = require("express");
const dtaroController = require("../controllers/dtaro.controller");
const { createRateLimiter } = require("../middlewares/rateLimitHttp");
const { authUser, requireSuperAdmin } = require("../middlewares/auth_middleware");

const router = express.Router();

router.use(authUser);
router.use(requireSuperAdmin());

const zonesLimiter = createRateLimiter({ windowMs: 60_000, limit: 60, keyPrefix: "dtaro_zones" });

// The published zone map, drawn by the dashboard. Read-only; served whether or not obstacle
// alerts are on (`alertsEnabled` reports DTARO_ZONE_ALERTS_ENABLED).
router.get("/zones", zonesLimiter, dtaroController.getZones);

// The DTARO events this process has sent to the dashboard, kept exactly as sent, so a page that
// opens or reconnects after a report can replay them. Read-only.
const activityLimiter = createRateLimiter({ windowMs: 60_000, limit: 60, keyPrefix: "dtaro_activity" });
router.get("/activity", activityLimiter, dtaroController.getActivity);

module.exports = router;

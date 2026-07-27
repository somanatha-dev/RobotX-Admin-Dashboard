const express = require("express");
const configController = require("../controllers/config.controller");
const { createRateLimiter } = require("../middlewares/rateLimitHttp");
const { authUser } = require("../middlewares/auth_middleware");

const router = express.Router();

const HTTP_FORBIDDEN = 403;

// The elevated role the Config Service's surface requires (§22.3, §23.4). The Role
// enum currently has a single member, so this is not yet a partition of the user
// base — it is the check the partition will hang from when Phase 14 lands
// authorisation properly. Stated explicitly rather than left implicit, so adding a
// second role does not silently open configuration publishing to it.
const ELEVATED_ROLES = ["SUPER_ADMIN"];

function requireElevatedRole(req, res, next) {
  if (!ELEVATED_ROLES.includes(req.user?.role)) {
    return res.status(HTTP_FORBIDDEN).json({ ok: false, message: "Forbidden" });
  }
  next();
}

router.use(authUser);
router.use(requireElevatedRole);

const resolveLimiter = createRateLimiter({ windowMs: 60_000, limit: 240, keyPrefix: "config_resolve" });
const publishLimiter = createRateLimiter({ windowMs: 60_000, limit: 10, keyPrefix: "config_publish" });

// §22.2 resolution-explain: which scope level supplied this value, and why.
router.get("/resolve", resolveLimiter, configController.resolveParameter);
router.get("/versions", resolveLimiter, configController.listVersions);

// §22.1 rule 5 + §22.3: validated at publish; Safety-class changes need two people.
router.post("/publish", publishLimiter, configController.publishVersion);

module.exports = router;

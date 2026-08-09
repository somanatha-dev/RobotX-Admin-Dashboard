const express = require("express");
const privacyController = require("../controllers/privacy.controller");
const { createRateLimiter } = require("../middlewares/rateLimitHttp");
const { authUser, requireElevatedRole } = require("../middlewares/auth_middleware");

const router = express.Router();

// PHASE 14 — §23.7's erasure surface.
//
// Authenticated and **elevated**, on the same reasoning §23.4 applies to its four named
// action classes: erasure is irreversible, and an irreversible operation over personal
// data is one an ordinary operator role should not be able to reach. The role list is
// `security.elevated_roles` from the parameter register, resolved by the middleware —
// one list, read by every gated surface, rather than a constant copied per route file.
router.use(authUser);
router.use(requireElevatedRole());

// A deliberately low limit. An erasure request is a human action taken a handful of
// times a day; a caller issuing them at machine rate is either a defect or an attack,
// and neither should be able to walk the identity store's key space through the status
// endpoint either.
const erasureLimiter = createRateLimiter({ windowMs: 60_000, limit: 30, keyPrefix: "privacy_erasure" });

router.post("/erasure", erasureLimiter, privacyController.requestErasure);
router.get("/identity/:identityKey", erasureLimiter, privacyController.identityStatus);

module.exports = router;

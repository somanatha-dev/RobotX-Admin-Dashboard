const express = require("express");
const healthController = require("../controllers/health.controller");
const { createRateLimiter } = require("../middlewares/rateLimitHttp");
const { authUser } = require("../middlewares/auth_middleware");

const router = express.Router();

// PHASE 12 — §26's register and §18.5's mode register, as operator surfaces.
//
// Authenticated, like every other diagnostic read since Phase 5. Deliberately *not*
// mounted on the unauthenticated `/health` route in `app.js`: that route is polled by
// infrastructure and answers "is this process up", while these answer "what is this shard
// currently unable to guarantee" — which names the invariants a shard has suspended and
// the reason it entered a degraded mode. That is operational detail, not a liveness probe.
router.use(authUser);

// A higher limit than the explanation API's: during an incident these two are the pages an
// operator refreshes, and rate-limiting the register at the moment it matters would be the
// observability failure §26.1 warns about, arrived at from the transport layer.
const healthLimiter = createRateLimiter({ windowMs: 60_000, limit: 240, keyPrefix: "health_register" });

router.get("/invariants", healthLimiter, healthController.invariants);
router.get("/modes", healthLimiter, healthController.modes);

// PHASE 15 — which shards the engine owns, what the staging order is, and which §24
// release gates are green. Same limiter and the same argument: this is a page an operator
// refreshes during a staged rollout, and rate-limiting it then would hide the rollout.
router.get("/cutover", healthLimiter, healthController.cutover);

module.exports = router;

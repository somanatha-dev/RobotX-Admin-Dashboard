const express = require("express");
const shardsController = require("../controllers/shards.controller");
const { createRateLimiter } = require("../middlewares/rateLimitHttp");
const { authUser, requireElevatedRole } = require("../middlewares/auth_middleware");

const router = express.Router();

// PHASE 13 — §3.5's shard model and §19.2's rebalancing, as operator surfaces.
//
// The read is authenticated like every other diagnostic read since Phase 5. The write is
// **elevated**: the plan's row calls the rebalance endpoint "control plane, elevated role",
// and §22.3 makes shard definition a STRUCTURAL change class.
//
// PHASE 14 — the local `ELEVATED_ROLES` constant this file carried is retired into
// `security.elevated_roles` in the parameter register, resolved by the shared middleware.
// Its default is the value this file held, so the check is unchanged; what changes is that
// it is now one list rather than a copy here and a copy in `config.routes.js`.
//
// Rebalancing is deliberately **not** one of §23.4's four high-privilege action classes.
// The four are enumerated in the specification and this is not among them — and the
// endpoint records an intent rather than moving an agent, which `shards.controller.js`
// reports as `executed: false`. Adding an action class the specification does not name
// would be this plan redesigning a mechanism.
router.use(authUser);

// A high read limit, for the same reason the invariant register has one: during a
// rebalance or a failover this is the page an operator refreshes, and rate-limiting the
// shard topology at the moment it is changing would be an observability failure arrived at
// from the transport layer.
const readLimiter = createRateLimiter({ windowMs: 60_000, limit: 240, keyPrefix: "shards_read" });

// A low write limit. A rebalance is a STRUCTURAL change (§22.3) and there is no legitimate
// caller that issues one repeatedly — the moves themselves are the supervisor's, paced by
// `shard.migration_min_interval`, and re-posting does not make them happen faster.
const rebalanceLimiter = createRateLimiter({ windowMs: 60_000, limit: 10, keyPrefix: "shards_rebalance" });

router.get("/", readLimiter, shardsController.list);
router.post("/:id/rebalance", rebalanceLimiter, requireElevatedRole(), shardsController.rebalance);

module.exports = router;

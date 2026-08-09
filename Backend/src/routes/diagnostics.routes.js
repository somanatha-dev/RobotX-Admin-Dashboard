const express = require("express");
const diagnosticsController = require("../controllers/diagnostics.controller");
const { createRateLimiter } = require("../middlewares/rateLimitHttp");
const { authUser } = require("../middlewares/auth_middleware");

const router = express.Router();

router.use(authUser);

// PHASE 6 — §7.7's capacity-planning instrument. Read-only, and rate-limited more
// tightly than the supervision endpoint: this one aggregates over a time range, so a
// dashboard polling it hard is a heavier query than an operator reading one Leg.
const rejectionsLimiter = createRateLimiter({ windowMs: 60_000, limit: 60, keyPrefix: "diag_rejections" });

router.get("/rejections", rejectionsLimiter, diagnosticsController.getRejections);

// PHASE 7 — §14.5's reserve breakdown, binding tier, and margin for one agent.
// Rate-limited more loosely than the rejection aggregate: this one is a point read of a
// single agent's state, which an operator investigating a refusal will hit repeatedly.
const energyLimiter = createRateLimiter({ windowMs: 60_000, limit: 120, keyPrefix: "diag_energy" });

router.get("/energy/:agentId", energyLimiter, diagnosticsController.getAgentEnergy);

// PHASE 9 — §6.1's own diagnostic: cells explored, smallest unexplored bound,
// achieved gap in CU, for one Leg. A point read like `/energy/:agentId` above, so
// it carries the same loose rate limit.
const candidatesLimiter = createRateLimiter({ windowMs: 60_000, limit: 120, keyPrefix: "diag_candidates" });

router.get("/candidates/:legId", candidatesLimiter, diagnosticsController.getLegCandidates);

module.exports = router;

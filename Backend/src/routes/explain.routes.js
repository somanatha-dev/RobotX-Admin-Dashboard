const express = require("express");
const explainController = require("../controllers/explain.controller");
const { createRateLimiter } = require("../middlewares/rateLimitHttp");
const { authUser } = require("../middlewares/auth_middleware");

const router = express.Router();

router.use(authUser);

// PHASE 11 — §21.3's Explanation API. Read-only, and rate-limited like the other
// authenticated point reads: an operator investigating a disputed allocation will hit
// one decision repeatedly, which is a cheap query, but an incident dashboard polling it
// across a shard is not.
const explainLimiter = createRateLimiter({ windowMs: 60_000, limit: 120, keyPrefix: "explain_decision" });

// The self-describing index, so a consumer discovers the eight queries rather than
// hard-coding them against the specification.
router.get("/queries", explainLimiter, explainController.listQueries);

// P1.3 — the task's latest decision, for a dashboard that holds a task, not a decision id.
// Declared before `/:decisionId`, which would otherwise capture "task".
router.get("/task/:taskId", explainLimiter, explainController.explainTask);

router.get("/:decisionId", explainLimiter, explainController.explainDecision);

module.exports = router;

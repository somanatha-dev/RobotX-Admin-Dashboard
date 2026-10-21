const express = require("express");
const explainController = require("../controllers/explain.controller");
const { createRateLimiter } = require("../middlewares/rateLimitHttp");
const { authUser, requireScopedAccess, requireSuperAdmin } = require("../middlewares/auth_middleware");
const { taskParamInScope } = require("../middlewares/campusScope");

const router = express.Router();

router.use(authUser);
// RBAC — an ADMIN without a valid campus is refused on every route here.
router.use(requireScopedAccess());

// PHASE 11 — §21.3's Explanation API. Read-only, and rate-limited like the other
// authenticated point reads: an operator investigating a disputed allocation will hit
// one decision repeatedly, which is a cheap query, but an incident dashboard polling it
// across a shard is not.
const explainLimiter = createRateLimiter({ windowMs: 60_000, limit: 120, keyPrefix: "explain_decision" });

// ── RBAC: ADMIN-capable — only the explanation of a task in the caller's campus ──
// P1.3 — the task's latest decision, for a dashboard that holds a task, not a decision id.
// Declared before `/:decisionId`, which would otherwise capture "task".
router.get("/task/:taskId", explainLimiter, taskParamInScope(), explainController.explainTask);

// ── RBAC: SUPER_ADMIN only — every route below this line ───────────────────────
router.use(requireSuperAdmin());

// The self-describing index, so a consumer discovers the eight queries rather than
// hard-coding them against the specification.
router.get("/queries", explainLimiter, explainController.listQueries);


router.get("/:decisionId", explainLimiter, explainController.explainDecision);

module.exports = router;

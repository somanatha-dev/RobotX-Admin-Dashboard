const express = require("express");
const tasksController = require("../controllers/tasks.controller");
const { createRateLimiter } = require("../middlewares/rateLimitHttp");
const { authUser, requireActionClass } = require("../middlewares/auth_middleware");
// PHASE 14 — §23.4's action-class register.
const override = require("../engine/security/override");

const router = express.Router();

router.use(authUser);

const assignLimiter  = createRateLimiter({ windowMs: 60_000, limit: 60,  keyPrefix: "task_assign" });
const cancelLimiter  = createRateLimiter({ windowMs: 60_000, limit: 120, keyPrefix: "task_cancel" });
const rerouteLimiter = createRateLimiter({ windowMs: 60_000, limit: 30,  keyPrefix: "task_reroute" });

// ── PHASE 14 — §23.4's remaining two action classes on this router ───────────
//
// **Manual assignment against a Policy constraint.** An assign request that both names an
// agent and asks to waive a predicate is that action. The gate runs only for that shape,
// so an ordinary assignment — which is every request this endpoint receives today — is
// unaffected.
//
// The conditional form is doing real work rather than anticipating a feature.
// `task.service.assignTask` parses its body with `passthrough()`, so before this phase a
// `waivePredicate` field in an assign request was **silently dropped**: the caller believed
// they had waived a constraint and the server believed nothing had been asked. Turning that
// into an explicit authorisation — which for a class I or R predicate is an explicit
// refusal — is strictly safer than the silence it replaces.
//
// **Bulk cancellation.** No endpoint on this router cancels more than one Task:
// `POST /:taskId/cancel` takes a single id from the path and there is no batch form. The
// action class is nonetheless registered in `override.ACTION_CLASS`, and
// `tests/engine/securityAuthorisation.test.js` asserts both halves — that the four §23.4
// classes are all present in the register, and that no route on this router accepts a
// list of task ids. Inventing a bulk endpoint in order to gate it would be this phase
// adding a capability rather than securing one.
const manualAssignmentGate = requireActionClass(override.ACTION_CLASS.MANUAL_ASSIGNMENT_AGAINST_POLICY.id, {
  subjectFrom: (req) => ({ subjectType: "TASK", subjectId: req.body?.taskId ? String(req.body.taskId) : null }),
});

function gateManualAssignment(req, res, next) {
  const waives = req.body?.waivePredicate;
  const names = req.body?.robotId || req.body?.agentId;
  if (!waives || !names) return next();
  return manualAssignmentGate(req, res, next);
}

router.get("/", tasksController.listTasks);
router.post("/assign", assignLimiter, gateManualAssignment, tasksController.assignTask);
router.post("/:taskId/cancel",  cancelLimiter,  tasksController.cancelTask);
router.post("/:taskId/reroute", rerouteLimiter, tasksController.rerouteTask);

module.exports = router;

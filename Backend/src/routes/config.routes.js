const express = require("express");
const configController = require("../controllers/config.controller");
const { createRateLimiter } = require("../middlewares/rateLimitHttp");
const { authUser, requireElevatedRole, requireActionClass, requireSuperAdmin } = require("../middlewares/auth_middleware");
// PHASE 14 — §23.4. The action-class register, so the publish gate names the same class
// the audit row records rather than a string chosen here.
const override = require("../engine/security/override");

const router = express.Router();

// PHASE 14 — the role list moved into the parameter register.
//
// This file used to carry `const ELEVATED_ROLES = ["SUPER_ADMIN"]` with a comment saying
// it was "the check the partition will hang from when Phase 14 lands authorisation
// properly". This is that landing. The list is now `security.elevated_roles`, resolved by
// the middleware from the pinned configuration, and its default is exactly the value this
// file held — so nothing changes behaviourally, and adding a second role is now one
// Safety-class config change rather than an edit in each of three route files.
router.use(authUser);
router.use(requireElevatedRole());
// RBAC — SUPER_ADMIN only: no route on this router is open to a campus administrator, whatever
// `security.elevated_roles` lists.
router.use(requireSuperAdmin());

const resolveLimiter = createRateLimiter({ windowMs: 60_000, limit: 240, keyPrefix: "config_resolve" });
const publishLimiter = createRateLimiter({ windowMs: 60_000, limit: 10, keyPrefix: "config_publish" });

// §22.2 resolution-explain: which scope level supplied this value, and why.
router.get("/resolve", resolveLimiter, configController.resolveParameter);
router.get("/versions", resolveLimiter, configController.listVersions);

// §22.1 rule 5 + §22.3: validated at publish; Safety-class changes are never automated.
//
// PHASE 14 — §23.4 names "safety-class config change" as one of the four highest-privilege
// actions, so the publish route carries that action class explicitly: an elevated role
// (plus SUPER_ADMIN above), a recorded reason, an audit record, and — only where
// `security.second_approver_action_classes` names SAFETY_CONFIG_CHANGE — a second approver.
// Owner decision 2026-10-23: not named by default (single-owner deployment).
//
// `config/service.js`'s S-rules judge the *published parameter set*: they fire only when
// the publish actually touches a Safety-class parameter, which this gate cannot know before
// the body is validated. §23.4's list is about the *route*, §22.3's rule is about the *change*.
router.post(
  "/publish",
  publishLimiter,
  requireActionClass(override.ACTION_CLASS.SAFETY_CONFIG_CHANGE.id, {
    subjectFrom: (req) => ({ subjectType: "CONFIG_VERSION", subjectId: req.body?.version ? String(req.body.version) : null }),
  }),
  configController.publishVersion,
);

module.exports = router;

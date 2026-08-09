const express = require("express");

const authRoutes      = require("./auth.routes");
const locationsRoutes = require("./locations.routes");
const robotsRoutes    = require("./robots.routes");
const campusesRoutes  = require("./campuses.routes");
const tasksRoutes     = require("./tasks.routes");
const simulatorRoutes = require("./simulator.routes");
const configRoutes    = require("./config.routes");
// PHASE 5 — §4.5 operator visibility: current state, deadline, owning timer.
const legsRoutes      = require("./legs.routes");
// PHASE 6 — §7.7's binding-constraint distribution and near-miss margins.
const diagnosticsRoutes = require("./diagnostics.routes");
// PHASE 11 — §21.3's Explanation API. Explainability is a functional requirement (T8),
// not instrumentation, so it has a route of its own rather than a diagnostics sub-path.
const explainRoutes = require("./explain.routes");
// PHASE 12 — §26's invariant register and §18.5's degraded-mode register. A register that
// is only visible in a metrics pipeline is one the on-call engineer reads for the first
// time while deciding whether to roll back.
const healthRoutes = require("./health.routes");
// PHASE 13 — §3.5's shard model and §19.2's rebalancing. Both §3.5 sizing bounds are
// reported with the binding one named, because a split triggered by the wrong resource is
// the failure the section states both bounds to prevent.
const shardsRoutes = require("./shards.routes");
// PHASE 14 — §23.7's erasure surface. Separate from `/api/config` and `/api/health`
// because it is the only operator surface that destroys data, and a destructive action
// sharing a mount with two read surfaces is one an operator reaches by accident.
const privacyRoutes = require("./privacy.routes");

const router = express.Router();

router.use("/auth",      authRoutes);
router.use("/locations", locationsRoutes);
router.use("/robots",    robotsRoutes);
router.use("/campuses",  campusesRoutes);
router.use("/tasks",     tasksRoutes);
router.use("/simulator", simulatorRoutes);
router.use("/config",    configRoutes);
router.use("/legs",      legsRoutes);
router.use("/diagnostics", diagnosticsRoutes);
router.use("/explain",   explainRoutes);
router.use("/health",    healthRoutes);
router.use("/shards",    shardsRoutes);
router.use("/privacy",   privacyRoutes);

module.exports = router;

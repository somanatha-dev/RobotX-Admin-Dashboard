const express = require("express");

const authRoutes      = require("./auth.routes");
const locationsRoutes = require("./locations.routes");
const robotsRoutes    = require("./robots.routes");
const campusesRoutes  = require("./campuses.routes");
const tasksRoutes     = require("./tasks.routes");
const simulatorRoutes = require("./simulator.routes");

const router = express.Router();

router.use("/auth",      authRoutes);
router.use("/locations", locationsRoutes);
router.use("/robots",    robotsRoutes);
router.use("/campuses",  campusesRoutes);
router.use("/tasks",     tasksRoutes);
router.use("/simulator", simulatorRoutes);

module.exports = router;

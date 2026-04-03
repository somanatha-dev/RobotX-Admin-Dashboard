const express = require("express");

const authRoutes = require("./auth.routes");
const locationsRoutes = require("./locations.routes");
const robotsRoutes = require("./robots.routes");
const campusesRoutes = require("./campuses.routes");

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/locations", locationsRoutes);
router.use("/robots", robotsRoutes);
router.use("/campuses", campusesRoutes);

module.exports = router;

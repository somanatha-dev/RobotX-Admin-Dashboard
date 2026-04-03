const express = require("express");
const robotsController = require("../controllers/robots.controller");

const router = express.Router();

router.get("/", robotsController.listRobots);
router.post("/", robotsController.commissionRobot);

module.exports = router;

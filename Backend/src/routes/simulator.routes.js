const express = require("express");
const ctrl    = require("../controllers/simulator.controller");
const { authUser } = require("../middlewares/auth_middleware");

const router = express.Router();

router.use(authUser);

// GET  /api/simulator/status  — snapshot of all virtual robots
router.get("/status", ctrl.getStatus);

// POST /api/simulator/start   — (re)start all virtual robots
router.post("/start", ctrl.startSimulator);

// POST /api/simulator/stop    — disconnect & pause all virtual robots
router.post("/stop", ctrl.stopSimulator);

// POST /api/simulator/reset   — clear task state on all virtual robots
router.post("/reset", ctrl.resetSimulator);

// PATCH /api/simulator/config — update runtime config (reserved)
router.patch("/config", ctrl.setConfig);

module.exports = router;

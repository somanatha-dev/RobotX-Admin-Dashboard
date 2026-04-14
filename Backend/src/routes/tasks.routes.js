const express = require("express");
const tasksController = require("../controllers/tasks.controller");
const { createRateLimiter } = require("../middlewares/rateLimitHttp");

const router = express.Router();

const assignLimiter = createRateLimiter({ windowMs: 60_000, limit: 60, keyPrefix: "task_assign" });
const cancelLimiter = createRateLimiter({ windowMs: 60_000, limit: 120, keyPrefix: "task_cancel" });

router.get("/", tasksController.listTasks);
router.post("/assign", assignLimiter, tasksController.assignTask);
router.post("/:taskId/cancel", cancelLimiter, tasksController.cancelTask);

module.exports = router;

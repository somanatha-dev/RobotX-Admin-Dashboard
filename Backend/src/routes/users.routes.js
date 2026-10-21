const express = require("express");
const usersController = require("../controllers/users.controller");
const { createRateLimiter } = require("../middlewares/rateLimitHttp");
const { authUser, requireSuperAdmin } = require("../middlewares/auth_middleware");

const router = express.Router();

router.use(authUser);
// RBAC — account management is SUPER_ADMIN only. There is no registration route anywhere: an
// account exists only because a SUPER_ADMIN created it here, or the boot bootstrap created
// the first SUPER_ADMIN.
router.use(requireSuperAdmin());

const writeLimiter = createRateLimiter({ windowMs: 60_000, limit: 20, keyPrefix: "users_write" });

router.get("/", usersController.listUsers);
router.post("/", writeLimiter, usersController.createAdmin);
router.patch("/:id", writeLimiter, usersController.updateAdmin);

module.exports = router;

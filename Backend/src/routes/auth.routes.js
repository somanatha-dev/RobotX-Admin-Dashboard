const express = require("express");
const authControllers = require("../controllers/auth_controller");
const authMiddleware = require("../middlewares/auth_middleware");
const { createRateLimiter } = require("../middlewares/rateLimitHttp");

const router = express.Router();

const loginLimiter = createRateLimiter({ windowMs: 60_000, limit: 10, keyPrefix: "login" });

// Login
router.post("/login", loginLimiter, authControllers.loginUser);
router.post("/google", loginLimiter, authControllers.googleLogin);

// Authenticated routes
router.get("/me", authMiddleware.authUser, authControllers.getMe);
router.post("/change-password", authMiddleware.authUser, authControllers.changePassword);
router.post("/pin-auth", authMiddleware.authUser, authControllers.pinAuth);

// Logout
router.post("/logout", authControllers.logout);

module.exports = router;
const express = require("express");
const authControllers = require("../controllers/auth_controller");
const webauthnControllers = require("../controllers/webauthn_controller");
const authMiddleware = require("../middlewares/auth_middleware");
const { createRateLimiter } = require("../middlewares/rateLimitHttp");

const router = express.Router();

const loginLimiter = createRateLimiter({ windowMs: 60_000, limit: 10, keyPrefix: "login" });
const webauthnLimiter = createRateLimiter({ windowMs: 60_000, limit: 20, keyPrefix: "webauthn" });

// Login
router.post("/login", loginLimiter, authControllers.loginUser);
router.post("/google", loginLimiter, authControllers.googleLogin);

// Authenticated routes
router.get("/me", authMiddleware.authUser, authControllers.getMe);
router.post("/change-password", authMiddleware.authUser, authControllers.changePassword);
router.post("/pin-auth", authMiddleware.authUser, authControllers.pinAuth);

// WebAuthn / passkey step-up (server-verified — see PHASE1_REVIEW.md F31)
router.post("/webauthn/register-options", authMiddleware.authUser, webauthnLimiter, webauthnControllers.registerOptions);
router.post("/webauthn/register", authMiddleware.authUser, webauthnLimiter, webauthnControllers.register);
router.post("/webauthn/auth-options", authMiddleware.authUser, webauthnLimiter, webauthnControllers.authOptions);
router.post("/webauthn/verify", authMiddleware.authUser, webauthnLimiter, webauthnControllers.verify);
router.get("/webauthn/status", authMiddleware.authUser, webauthnControllers.status);

// Logout
router.post("/logout", authControllers.logout);

module.exports = router;
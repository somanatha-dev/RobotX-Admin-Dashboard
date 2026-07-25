const express = require("express");
const authControllers = require("../controllers/auth_controller");
const authMiddleware = require("../middlewares/auth_middleware");

const router = express.Router();

// Login
router.post("/login", authControllers.loginUser);
router.post("/google", authControllers.googleLogin);

// Authenticated routes
router.get("/me", authMiddleware.authUser, authControllers.getMe);
router.post("/change-password", authMiddleware.authUser, authControllers.changePassword);
router.post("/pin-auth", authMiddleware.authUser, authControllers.pinAuth);

// Logout
router.post("/logout", authControllers.logout);

module.exports = router;
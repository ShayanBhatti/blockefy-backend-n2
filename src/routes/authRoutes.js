const express = require("express");
const passport = require("passport");
const authController = require("../controllers/authController");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

// Email/Password Authentication
router.post("/register", authController.register);
router.post("/login", authController.login);

// Google OAuth
router.get(
  "/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);
router.get(
  "/google/callback",
  passport.authenticate("google", { failureRedirect: "/auth/login" }),
  authController.handleOAuthCallback
);

// GitHub OAuth
router.get(
  "/github",
  passport.authenticate("github", { scope: ["user:email"] })
);
router.get(
  "/github/callback",
  passport.authenticate("github", { failureRedirect: "/auth/login" }),
  authController.handleOAuthCallback
);

// Wallet Authentication
router.post("/wallet/nonce", authController.generateNonce);
router.post("/wallet/verify", authController.verifyWalletSignature);

// User Info (protected route example)
router.get("/me", authMiddleware.verifyToken, authController.getCurrentUser);

module.exports = router;

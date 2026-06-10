const express = require("express");
const passport = require("passport");
const jwt = require("jsonwebtoken");
const authController = require("../controllers/authController");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

// Email/Password Authentication
router.post("/register", authController.register);
router.post("/login", authController.login);

// OTP-based Email Verification (NEW)
router.post("/verify-otp", authController.verifyOtp);
router.post("/resend-otp", authController.resendOtp);

// Legacy - kept for backward compatibility
router.get("/verify-email", authController.verifyEmail);

/**
 * Google OAuth 
 * IMPORTANT: session: false is REQUIRED for serverless/stateless JWT auth
 * Redirects to frontend with JWT token in URL query parameter
 */
router.get(
  "/google",
  passport.authenticate("google", { 
    scope: ["profile", "email"], 
    session: false  // ✅ Critical for serverless - prevents session middleware call
  })
);

router.get(
  "/google/callback",
  passport.authenticate("google", { 
    failureRedirect: "/auth/login", 
    session: false
  }),
  async (req, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ msg: "Authentication failed" });
      }

      // Generate JWT token
      const token = require("jsonwebtoken").sign(
        { userId: req.user._id },
        process.env.JWT_SECRET,
        { expiresIn: "1d" }
      );

      // Redirect to frontend with token
      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
      res.redirect(`${frontendUrl}/auth-success?token=${token}`);
    } catch (error) {
      console.error("Google OAuth callback error:", error);
      res.status(500).json({ msg: "OAuth authentication failed" });
    }
  }
);

/**
 * GitHub OAuth
 * IMPORTANT: session: false is REQUIRED for serverless/stateless JWT auth
 * callbackURL must match EXACTLY what's registered in GitHub OAuth app settings
 * Redirects to frontend with JWT token in URL query parameter
 */
router.get(
  "/github",
  passport.authenticate("github", { 
    scope: ["user:email"], 
    session: false  // ✅ Critical for serverless - prevents session middleware call
  })
);

router.get(
  "/github/callback",
  passport.authenticate("github", { 
    failureRedirect: "/auth/login", 
    session: false
  }),
  async (req, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ msg: "Authentication failed" });
      }

      // Generate JWT token
      const token = require("jsonwebtoken").sign(
        { userId: req.user._id },
        process.env.JWT_SECRET,
        { expiresIn: "1d" }
      );

      // Redirect to frontend with token
      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
      res.redirect(`${frontendUrl}/auth-success?token=${token}`);
    } catch (error) {
      console.error("GitHub OAuth callback error:", error);
      res.status(500).json({ msg: "OAuth authentication failed" });
    }
  }
);

// Wallet Authentication
router.post("/wallet/nonce", authController.generateNonce);
router.post("/wallet/verify", authController.verifyWalletSignature);

// User Info (protected route example)
router.get("/me", authMiddleware.verifyToken, authController.getCurrentUser);

module.exports = router;

const express = require("express");
const passport = require("passport");
const crypto = require("crypto");
const authController = require("../controllers/authController");
const authMiddleware = require("../middleware/authMiddleware");
const OAuthCode = require("../models/OAuthCode");
const { createRateLimiter, ipKeyFn } = require("../middleware/rateLimiter");

const router = express.Router();

// ============================================================================
// Auth endpoints were previously unthrottled: an attacker could brute-force
// credentials, OTP values, or wallet signatures at full speed. Per-route
// limits below (in-memory; see F18 for multi-instance caveat).
// ============================================================================
const loginLimiter = createRateLimiter({ windowMs: 60_000, max: 10, keyFn: ipKeyFn });
const registerLimiter = createRateLimiter({ windowMs: 5 * 60_000, max: 10, keyFn: ipKeyFn });
const otpVerifyLimiter = createRateLimiter({ windowMs: 60_000, max: 10, keyFn: ipKeyFn });
const resendOtpLimiter = createRateLimiter({ windowMs: 60_000, max: 3, keyFn: ipKeyFn });
const walletNonceLimiter = createRateLimiter({ windowMs: 60_000, max: 30, keyFn: ipKeyFn });
const walletVerifyLimiter = createRateLimiter({ windowMs: 60_000, max: 10, keyFn: ipKeyFn });
const oauthExchangeLimiter = createRateLimiter({ windowMs: 60_000, max: 30, keyFn: ipKeyFn });

// OAuth code lifetime: short enough that a leaked code (Referer, logs, auto
// screenshot) is worthless by the time anyone reads it, long enough for the
// redirect to complete.
const OAUTH_CODE_TTL_MS = 60_000;

/**
 * Shared OAuth callback: mints a one-time code (NOT a JWT) and redirects to
 * `/auth-success?code=<code>`. The frontend trades the code for a token via
 * POST /auth/exchange. A JWT is never placed in a URL (F1).
 */
const handleOAuthCallback = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ msg: "Authentication failed" });
    }

    const code = crypto.randomBytes(24).toString("hex");
    await OAuthCode.create({
      code,
      userId: req.user._id,
      expiresAt: new Date(Date.now() + OAUTH_CODE_TTL_MS),
    });

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    res.redirect(`${frontendUrl}/auth-success?code=${code}`);
  } catch (error) {
    console.error("OAuth callback error:", error);
    res.status(500).json({ msg: "OAuth authentication failed" });
  }
};

// Email/Password Authentication
router.post("/register", registerLimiter, authController.register);
router.post("/login", loginLimiter, authController.login);

// OTP-based Email Verification (NEW)
router.post("/verify-otp", otpVerifyLimiter, authController.verifyOtp);
router.post("/resend-otp", resendOtpLimiter, authController.resendOtp);

// OAuth one-time-code exchange: trades the short-lived URL code for a JWT in
// the response body. Rate-limited so the endpoint can't be abused as a token
// oracle (F1).
router.post("/exchange", oauthExchangeLimiter, authController.exchangeOAuthCode);

// Legacy - kept for backward compatibility
router.get("/verify-email", authController.verifyEmail);

/**
 * Google OAuth
 * IMPORTANT: session: false is REQUIRED for serverless/stateless JWT auth
 * Redirects to frontend with a one-time code (F1) - the JWT is minted only by
 * POST /auth/exchange, never placed in a URL.
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
  handleOAuthCallback
);

/**
 * GitHub OAuth
 * IMPORTANT: session: false is REQUIRED for serverless/stateless JWT auth
 * callbackURL must match EXACTLY what's registered in GitHub OAuth app settings
 * Redirects to frontend with a one-time code (F1) - the JWT is never in a URL.
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
  handleOAuthCallback
);

// Wallet Authentication
router.post("/wallet/nonce", walletNonceLimiter, authController.generateNonce);
router.post("/wallet/verify", walletVerifyLimiter, authController.verifyWalletSignature);

// User Info (protected route example)
router.get("/me", authMiddleware.verifyToken, authController.getCurrentUser);

module.exports = router;

const express = require("express");
const walletService = require("../services/wallet.service");
const authMiddleware = require("../middleware/authMiddleware");
const { createRateLimiter, userKeyFn } = require("../middleware/rateLimiter");

const router = express.Router();

/**
 * Strict rate limiter for the key-reveal flow: 3 attempts/actions per minute
 * keyed to the authenticated user. This protects brute-forcing the sensitive
 * OTP without interfering with the hourly cap tracked in the User model.
 */
const keyRevealLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 3,
  keyFn: userKeyFn,
});

/**
 * GET /wallet/overview - Live wallet snapshot (read-only).
 */
router.get(
  "/wallet/overview",
  authMiddleware.verifyToken,
  async (req, res, next) => {
    try {
      const overview = await walletService.getOverview(req.authUser._id);
      return res.status(200).json({
        success: true,
        data: overview,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /wallet/transactions - Merged history (Mongo + ChainEvent). Read-only.
 */
router.get(
  "/wallet/transactions",
  authMiddleware.verifyToken,
  async (req, res, next) => {
    try {
      const limit = Number(req.query.limit) || 50;
      const page = Number(req.query.page) || 1;
      const history = await walletService.getHistory({
        userId: req.authUser._id,
        limit,
        page,
      });
      return res.status(200).json({
        success: true,
        data: history,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /wallet/key/reveal-request - Send OTP to authorise revealing the key.
 */
router.post(
  "/wallet/key/reveal-request",
  authMiddleware.verifyToken,
  keyRevealLimiter,
  async (req, res, next) => {
    try {
      const result = await walletService.requestKeyReveal(req.authUser._id);
      return res.status(200).json({
        success: true,
        message: "Confirmation code sent to your email",
        expiresAt: result.expiresAt,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /wallet/key/reveal - Verify OTP and return the private key (once).
 * Key is never logged. Response must never be cached.
 */
router.post(
  "/wallet/key/reveal",
  authMiddleware.verifyToken,
  keyRevealLimiter,
  async (req, res, next) => {
    try {
      const { otp, source } = req.body || {};
      const result = await walletService.revealKey(req.authUser._id, otp, source);
      res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /wallet/key/import - Store the user's own MetaMask key so it can sign
 * new on-chain actions without a browser popup.
 *
 * Strict limiter (5 per 10 minutes): this endpoint accepts a private key, so it
 * must not be brute-forceable or spammable. The custodial pair is retained, so
 * importing is reversible by the user at any time.
 */
const keyImportLimiter = createRateLimiter({
  windowMs: 10 * 60_000,
  max: 5,
  keyFn: userKeyFn,
});

/**
 * POST /wallet/key/import
 */
router.post(
  "/wallet/key/import",
  authMiddleware.verifyToken,
  keyImportLimiter,
  async (req, res, next) => {
    try {
      const { privateKey } = req.body || {};
      const result = await walletService.importExternalKey(req.authUser._id, privateKey);
      return res.status(200).json({
        success: true,
        message: "Wallet imported. New on-chain actions will use this wallet.",
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
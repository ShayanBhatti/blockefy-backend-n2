const express = require("express");
const router = express.Router();
const paymentController = require("../controllers/paymentController");
const { createRateLimiter } = require("../middleware/rateLimiter");

/**
 * Payment routes.
 *
 * The webhook MUST receive the raw request body so the provider signature can
 * be verified against the exact bytes that were signed. It is mounted before
 * the global `express.json()` parser — see index.js.
 */

const webhookLimit = createRateLimiter({ windowMs: 60_000, max: 60, keyFn: (req) => req.ip });

// Raw body for signature verification.
router.post("/webhook", webhookLimit, express.raw({ type: "*/*" }), paymentController.webhook);

// Dev-only helper to sanity check signatures.
router.post("/webhook/dev-verify", express.raw({ type: "*/*" }), paymentController.devVerify);

module.exports = router;

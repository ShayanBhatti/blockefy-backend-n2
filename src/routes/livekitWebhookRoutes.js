const express = require("express");
const router = express.Router();
const webhookController = require("../controllers/webhookController");
const { createRateLimiter } = require("../middleware/rateLimiter");

/**
 * LiveKit webhook route.
 *
 * The raw body is required for `WebhookReceiver.receive` signature
 * verification, so `express.raw` is mounted here — this router MUST be
 * registered before the global `express.json()` parser in index.js.
 *
 * LiveKit reads the signature from the `Authorize` header, not Authorization.
 */

const webhookLimit = createRateLimiter({ windowMs: 60_000, max: 120, keyFn: (req) => req.ip });

router.post("/livekit", webhookLimit, express.raw({ type: "*/*" }), webhookController.livekitWebhook);

module.exports = router;

const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const logger = require("../utils/logger");
const livekitService = require("../services/livekit.service");
const callService = require("../services/call.service");
const WebhookEventLog = require("../models/WebhookEventLog");
/**
 * LiveKit webhook controller.
 *
 * The route is mounted with `express.raw` (wildcard media type) so `req.body`
 * is the exact raw bytes LiveKit signed. `WebhookReceiver.receive` verifies
 * the `Authorize` header plus the sha256 body claim before any state change.
 *
 * Idempotency: each event id is recorded in WebhookEventLog (unique sparse
 * index). Only the first processor of an event id mutates call state.
 */

exports.livekitWebhook = asyncHandler(async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body || "");
  const authHeader = req.headers.authorize || req.headers["authorize"] || "";

  livekitService.assertConfigured();
  // `receiveWebhook` verifies the JWT in the Authorize header against the
  // sha256 of the raw body. A null result means the signature did not match.
  const event = await livekitService.receiveWebhook(rawBody, authHeader);
  if (!event) {
    logger.warn("webhook_signature_rejected", { ip: req.ip });
    return res.status(401).json({
      success: false,
      message: "Webhook signature verification failed",
      code: "UNAUTHORIZED",
    });
  }

  const eventId = String(event.id || event.eventId || event.createdAt || Date.now());
  const roomName = event.room?.name || "";

  logger.info("webhook_accepted", { eventId, event: event.event, roomName });

  // Idempotency guard: only the first processor of this event id proceeds.
  let ledger;
  try {
    ledger = await WebhookEventLog.create({ eventId, event: event.event || "", roomName });
  } catch (error) {
    if (error.code === 11000) {
      logger.info("webhook_duplicate_acknowledged", { eventId, event: event.event, roomName });
      return ok(res, { duplicate: true }, "Duplicate webhook acknowledged", 200);
    }
    throw error;
  }

  const result = await callService.syncFromWebhook(event);

  if (result.ignored) {
    return ok(res, { duplicate: false, ignored: true }, "Webhook acknowledged", 200);
  }

  return ok(res, { duplicate: false, event: result.event, call: result.call }, "Webhook processed");
});

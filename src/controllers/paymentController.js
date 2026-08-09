const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const paymentService = require("../services/payment.service");
const orderService = require("../services/order.service");
const AppError = require("../utils/AppError");

/**
 * Payment controller — webhook only.
 *
 * The webhook route must be mounted with `express.raw` so signature
 * verification operates on the exact raw bytes the provider signed.
 */
exports.webhook = asyncHandler(async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : req.body;
  const signature = req.headers["x-webhook-signature"] || req.headers["x-mock-signature"];

  const result = await paymentService.processWebhook({ rawBody, signature });

  if (result.ignored) {
    return ok(res, null, "Webhook acknowledged", 200);
  }

  const serialized = await orderService.serializeWithTimeline(result.order);
  return ok(res, { order: serialized, duplicate: !!result.duplicate }, "Webhook processed");
});

/**
 * Dev-only: verify that a mock webhook payload is signed correctly.
 * Useful for frontend debugging before real provider integration.
 */
exports.devVerify = asyncHandler(async (req, res) => {
  if (process.env.NODE_ENV === "production") {
    throw new AppError("Not available in production", 404, "NOT_FOUND");
  }
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : req.body;
  const signature = req.headers["x-webhook-signature"] || req.headers["x-mock-signature"];
  paymentService.verifyWebhookSignature(rawBody, signature);
  return ok(res, { verified: true }, "Signature valid");
});

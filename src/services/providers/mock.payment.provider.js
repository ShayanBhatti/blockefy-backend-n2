const { createHmac, timingSafeEqual, randomUUID } = require("crypto");
const config = require("../../config/orderConfig");
const Transaction = require("../../models/Transaction");
const AppError = require("../../utils/AppError");

/**
 * Mock payment provider (development only).
 *
 * Implements the same interface a real provider (Stripe etc.) will: create a
 * payment intent and sign/verify webhook payloads. The order architecture
 * NEVER trusts the frontend — the webhook (with signature + amount + currency
 * + order-reference verification) is the source of truth for payment status.
 *
 * Replace the internals of this file (or add providers/stripe.provider.js)
 * when a real gateway is integrated; payment.service.js and the controllers
 * do not change.
 */

const providerName = "mock";

const createPaymentIntent = async ({ order, buyer, method }) => {
  const intentId = `mockpay_${randomUUID().replace(/-/g, "")}`;

  if (method === "wallet") {
    const balance = await Transaction.getUserBalance(buyer._id);
    if (balance < order.pricing.total) {
      throw new AppError("Insufficient wallet balance", 400, "PAYMENT_NOT_CONFIRMED");
    }
  }

  return {
    providerPaymentId: intentId,
    clientSecret: `${intentId}_secret_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    providerData: { mode: "mock", method },
  };
};

const signPayload = (rawBody) => {
  return createHmac("sha256", config.webhookSecret).update(rawBody).digest("hex");
};

/**
 * Verify the webhook signature header. Constant-time comparison.
 */
const verifySignature = (rawBody, signature) => {
  if (!signature || typeof rawBody !== "string") return false;
  const expected = signPayload(rawBody);
  const provided = String(signature).replace(/^sha256=/, "");

  const bufExpected = Buffer.from(expected, "utf8");
  const bufProvided = Buffer.from(provided, "utf8");
  if (bufExpected.length !== bufProvided.length) return false;
  return timingSafeEqual(bufExpected, bufProvided);
};

/**
 * Build a signed webhook payload for a payment (used by auto-confirm + tests).
 * @param {Object} payment - Payment doc
 * @param {Object} order - Order doc
 */
const buildWebhookPayload = (payment, order) => {
  const payload = {
    eventId: `evt_${randomUUID().replace(/-/g, "")}`,
    type: "payment.succeeded",
    intentId: payment.providerPaymentId,
    orderRef: order.orderNumber,
    amount: order.pricing.totalCents,
    currency: order.pricing.currency,
    timestamp: new Date().toISOString(),
  };
  return {
    raw: JSON.stringify(payload),
    signature: `sha256=${signPayload(JSON.stringify(payload))}`,
    payload,
  };
};

module.exports = {
  providerName,
  createPaymentIntent,
  verifySignature,
  buildWebhookPayload,
};

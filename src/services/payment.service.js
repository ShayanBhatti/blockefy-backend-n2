const config = require("../config/orderConfig");
const Payment = require("../models/Payment");
const Order = require("../models/Order");
const { PAYMENT_STATUS } = require("../constants/order.constants");
const AppError = require("../utils/AppError");
const { audit } = require("./audit.service");
const ledger = require("./ledger.service");
const orderService = require("./order.service");

const PROVIDERS = {
  mock: require("./providers/mock.payment.provider"),
};

/**
 * Payment service.
 *
 * The payment provider is the source of truth for payment state. The frontend
 * can never mark an order as paid — only a verified webhook (or, in dev, the
 * provider's own signed confirmation processed through the same code path) can.
 */

const getProvider = () => {
  const name = config.paymentProvider;
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new AppError(`Payment provider "${name}" is not configured`, 500, "SERVER_ERROR");
  }
  return provider;
};

/**
 * Create a payment intent + Payment record for an order.
 *
 * @param {Object} input { order, buyer, method, idempotencyKey }
 * @returns {Promise<{payment, intent, clientSecret}>}
 */
const createPayment = async ({ order, buyer, method, idempotencyKey }) => {
  const safeMethod = config.supportedPaymentMethods.includes(method) ? method : config.supportedPaymentMethods[0];
  const provider = getProvider();

  const intent = await provider.createPaymentIntent({ order, buyer, method: safeMethod });

  const payment = await Payment.create({
    order: order._id,
    buyer: buyer._id,
    method: safeMethod,
    provider: provider.providerName,
    providerPaymentId: intent.providerPaymentId,
    idempotencyKey: idempotencyKey || null,
    status: PAYMENT_STATUS.PENDING,
    amount: order.pricing.totalCents,
    currency: order.pricing.currency,
    metadata: intent.providerData || {},
  });

  return { payment, intent, clientSecret: intent.clientSecret };
};

/**
 * Verify a webhook signature against the raw body.
 */
const verifyWebhookSignature = (rawBody, signature) => {
  const provider = getProvider();
  if (!provider.verifySignature(rawBody, signature)) {
    throw new AppError("Invalid webhook signature", 401, "INVALID_WEBHOOK_SIGNATURE");
  }
};

/**
 * Process a provider webhook event idempotently.
 *
 * Pipeline (spec §37):
 *  1. verify provider signature
 *  2. verify event id (reject duplicates — unique index on providerEventId)
 *  3. verify payment intent exists
 *  4. verify amount
 *  5. verify currency
 *  6. verify order reference
 *  7. verify payment state (pending)
 *  8. update payment safely (atomic pending→confirmed)
 *  9. activate order (PENDING_PAYMENT → PAID/IN_PROGRESS/REQUIREMENTS_NEEDED)
 * 10. fund escrow + audit + notifications
 *
 * Returns the activated order.
 */
const processWebhook = async ({ rawBody, signature }) => {
  verifyWebhookSignature(rawBody, signature);

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new AppError("Invalid webhook payload", 400, "INVALID_WEBHOOK_EVENT");
  }

  const { eventId, type, intentId, orderRef, amount, currency } = parsed;

  if (type !== "payment.succeeded") {
    // Acknowledge non-payment events silently (no error, no state change).
    audit.webhookProcessed({ eventId, type, intentId, ignored: true });
    return { ignored: true };
  }

  if (!eventId || !intentId) {
    throw new AppError("Webhook payload missing required fields", 400, "INVALID_WEBHOOK_EVENT");
  }

  // Idempotency: the same provider event must not be processed twice.
  const existing = await Payment.findOne({ providerEventId: eventId });
  if (existing) {
    audit.webhookProcessed({ eventId, intentId, duplicate: true });
    const order = await Order.findById(existing.order);
    return { order, duplicate: true };
  }

  const payment = await Payment.findOne({ providerPaymentId: intentId });
  if (!payment) {
    audit.webhookRejected({ eventId, reason: "unknown_intent" });
    throw new AppError("Unknown payment intent", 404, "PAYMENT_NOT_CONFIRMED");
  }

  const order = await Order.findById(payment.order);
  if (!order) {
    throw new AppError("Order not found for payment", 404, "ORDER_NOT_FOUND");
  }

  // Amount + currency verification against server records.
  const expectedAmount = order.pricing.totalCents;
  if (Number(amount) !== expectedAmount) {
    audit.webhookRejected({ eventId, intentId, reason: "amount_mismatch" });
    throw new AppError(
      `Payment amount mismatch: expected ${expectedAmount}, got ${amount}`,
      409,
      "PAYMENT_AMOUNT_MISMATCH"
    );
  }
  if (String(currency).toUpperCase() !== String(order.pricing.currency).toUpperCase()) {
    audit.webhookRejected({ eventId, intentId, reason: "currency_mismatch" });
    throw new AppError("Payment currency mismatch", 409, "PAYMENT_AMOUNT_MISMATCH");
  }
  if (orderRef && String(orderRef) !== order.orderNumber) {
    audit.webhookRejected({ eventId, intentId, reason: "order_ref_mismatch" });
    throw new AppError("Payment order reference mismatch", 409, "PAYMENT_AMOUNT_MISMATCH");
  }

  // Atomic pending → confirmed. If already confirmed, we are idempotent.
  const confirmed = await Payment.findOneAndUpdate(
    { _id: payment._id, status: PAYMENT_STATUS.PENDING },
    {
      status: PAYMENT_STATUS.CONFIRMED,
      providerEventId: eventId,
      paidAt: new Date(),
    },
    { new: true }
  );

  if (!confirmed) {
    // Already confirmed (webhook retry) — return the current order safely.
    const currentOrder = await Order.findById(order._id);
    audit.webhookProcessed({ eventId, intentId, duplicate: true });
    return { order: currentOrder, duplicate: true };
  }

  audit.paymentConfirmed({ orderId: order._id.toString(), orderNumber: order.orderNumber, amount: expectedAmount, currency: order.pricing.currency });

  // Fund escrow (wallet method) after payment confirmation.
  if (order.payment.method === "wallet") {
    await ledger.fundEscrow({
      buyerId: order.buyerId,
      orderId: order._id,
      total: order.pricing.total,
      currency: order.pricing.currency,
    });
  }

  // Activate the order (idempotent: only PENDING_PAYMENT can transition).
  const activated = await orderService.activateOrder(order._id, {
    paymentMethod: order.payment.method || "wallet",
    provider: payment.provider,
    providerPaymentId: payment.providerPaymentId,
  });

  return { order: activated || order, duplicate: false };
};

/**
 * Developer convenience: build a signed webhook payload for the mock provider
 * and process it through the exact same pipeline as a real webhook.
 */
const autoConfirm = async (payment, order) => {
  const provider = getProvider();
  const { raw, signature } = provider.buildWebhookPayload(payment, order);
  return processWebhook({ rawBody: raw, signature });
};

/**
 * Release earnings to the seller (called on COMPLETED).
 */
const releaseEarnings = async (order) => {
  await ledger.releaseEarnings({
    sellerId: order.sellerId,
    orderId: order._id,
    subtotal: order.pricing.subtotal,
    platformFee: order.pricing.platformFee,
    currency: order.pricing.currency,
  });
  audit.earningsReleased({ orderId: order._id.toString(), orderNumber: order.orderNumber, sellerId: order.sellerId.toString() });
};

/**
 * Refund the buyer (called on CANCELLED / dispute refund).
 */
const refund = async (order, amountCents) => {
  const amount = typeof amountCents === "number" ? amountCents / 100 : order.pricing.total;
  await ledger.refundEscrow({
    buyerId: order.buyerId,
    orderId: order._id,
    amount,
    currency: order.pricing.currency,
  });
};

module.exports = {
  getProvider,
  createPayment,
  verifyWebhookSignature,
  processWebhook,
  autoConfirm,
  releaseEarnings,
  refund,
};

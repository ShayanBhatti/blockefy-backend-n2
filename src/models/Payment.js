const mongoose = require("mongoose");
const {
  PAYMENT_STATUS_VALUES,
} = require("../constants/order.constants");

/**
 * Payment — the payment provider's source of truth for a payment attempt.
 *
 * The webhook writes status transitions here; the frontend can never set them.
 * Unique sparse indexes on provider event/payment ids guarantee idempotent
 * webhook handling.
 */
const paymentSchema = new mongoose.Schema(
  {
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
    },
    buyer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    method: { type: String, default: "wallet" },
    provider: { type: String, default: "mock" },
    providerPaymentId: { type: String },
    providerEventId: { type: String },
    idempotencyKey: { type: String },
    status: {
      type: String,
      enum: PAYMENT_STATUS_VALUES,
      default: "pending",
    },
    amount: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "USD" },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    paidAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
    refundedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

paymentSchema.index({ order: 1 });
paymentSchema.index({ providerPaymentId: 1 }, { unique: true, sparse: true });
paymentSchema.index({ providerEventId: 1 }, { unique: true, sparse: true });
paymentSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

const Payment = mongoose.models.Payment || mongoose.model("Payment", paymentSchema);

module.exports = Payment;

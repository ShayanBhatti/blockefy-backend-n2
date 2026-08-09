const mongoose = require("mongoose");
const {
  ORDER_STATUS,
  ORDER_STATUS_VALUES,
  PAYMENT_STATUS,
  PAYMENT_STATUS_VALUES,
} = require("../constants/order.constants");

/**
 * Order model — the centerpiece of the Order Management System.
 *
 * Security rules implemented:
 *  - `buyerId`/`sellerId` are always set by the backend (authenticated buyer,
 *    gig owner). They are never trusted from the client.
 *  - All prices, fees and totals live in `pricing` and are computed server-side
 *    in integer cents. `packageSnapshot`/`extrasSnapshot` preserve the gig
 *    state at purchase time so later gig edits never mutate historical orders.
 *  - `revisions` records the purchased revision allowance; it is only
 *    incremented by backend logic, never overwritten by clients.
 *  - `status` is an enum and may only change through the order state machine.
 *  - `payment` state is only written by the payment service/webhook.
 *
 * Legacy fields (amount, platformFee, sellerEarnings, currency, dueDate,
 * deliveryDate, revisionsAllowed, revisionsUsed, paymentStatus, projectTitle)
 * are kept and kept-in-sync so the existing dashboard endpoints keep working.
 */

const orderSchema = new mongoose.Schema(
  {
    orderNumber: {
      type: String,
      required: true,
    },

    // ---- References (source of truth: backend) ----
    buyerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    gigId: { type: mongoose.Schema.Types.ObjectId, ref: "Gig", required: true },

    // Legacy package key ("basic"|"standard"|"premium") for dashboard compat.
    packageType: { type: String, default: null },

    status: {
      type: String,
      enum: ORDER_STATUS_VALUES,
      default: ORDER_STATUS.PENDING_PAYMENT,
    },

    // ---- Buyer content ----
    projectTitle: { type: String, required: true },
    projectDescription: { type: String, default: null },

    // ---- Historical snapshots ----
    packageSnapshot: {
      packageId: { type: mongoose.Schema.Types.Mixed, default: null },
      name: { type: String, default: "" },
      description: { type: String, default: "" },
      price: { type: Number, default: 0, min: 0 },
      deliveryDays: { type: Number, default: 1, min: 1 },
      revisions: { type: Number, default: 0 },
      features: { type: [String], default: [] },
    },
    extrasSnapshot: [
      {
        extraId: { type: mongoose.Schema.Types.Mixed },
        name: { type: String, default: "" },
        description: { type: String, default: "" },
        price: { type: Number, default: 0, min: 0 },
        deliveryDays: { type: Number, default: 0, min: 0 },
      },
    ],
    buyerRequirements: [
      {
        questionId: { type: mongoose.Schema.Types.Mixed },
        question: { type: String, default: "" },
        type: { type: String },
        required: { type: Boolean, default: false },
        options: { type: [String], default: [] },
        answer: { type: mongoose.Schema.Types.Mixed, default: null },
        files: [
          {
            name: String,
            url: String,
            publicId: String,
            mimeType: String,
            extension: String,
            size: Number,
          },
        ],
      },
    ],
    attachments: [
      {
        name: String,
        url: String,
        publicId: String,
        mimeType: String,
        extension: String,
        size: Number,
      },
    ],

    // ---- Server-computed pricing (integer cents) ----
    pricing: {
      currency: { type: String, default: "USD" },
      packagePrice: { type: Number, default: 0, min: 0 },
      extrasTotal: { type: Number, default: 0, min: 0 },
      subtotal: { type: Number, default: 0, min: 0 },
      platformFee: { type: Number, default: 0, min: 0 },
      discount: { type: Number, default: 0, min: 0 },
      tax: { type: Number, default: 0, min: 0 },
      total: { type: Number, default: 0, min: 0 },
      packagePriceCents: { type: Number, default: 0, min: 0 },
      extrasTotalCents: { type: Number, default: 0, min: 0 },
      subtotalCents: { type: Number, default: 0, min: 0 },
      platformFeeCents: { type: Number, default: 0, min: 0 },
      discountCents: { type: Number, default: 0, min: 0 },
      taxCents: { type: Number, default: 0, min: 0 },
      totalCents: { type: Number, default: 0, min: 0 },
      feeRatePercent: { type: Number, default: 0 },
    },

    // ---- Delivery / deadlines ----
    delivery: {
      days: { type: Number, default: 1, min: 1 },
      dueAt: { type: Date, default: null },
      startedAt: { type: Date, default: null },
      deliveredAt: { type: Date, default: null },
      reviewPeriodEndsAt: { type: Date, default: null },
      autoCompletedAt: { type: Date, default: null },
    },

    // ---- Revisions ----
    revisions: {
      allowed: { type: Number, default: 0, min: 0 },
      used: { type: Number, default: 0, min: 0 },
      unlimited: { type: Boolean, default: false },
    },

    // ---- Payment (only written by payment service/webhook) ----
    payment: {
      status: { type: String, enum: PAYMENT_STATUS_VALUES, default: PAYMENT_STATUS.PENDING },
      method: { type: String, default: null },
      provider: { type: String, default: null },
      providerPaymentId: { type: String },
      providerEventId: { type: String },
      idempotencyKey: { type: String },
      paidAt: { type: Date, default: null },
      refundedAt: { type: Date, default: null },
    },

    // ---- Related records ----
    currentDelivery: { type: mongoose.Schema.Types.ObjectId, ref: "Delivery", default: null },
    cancellation: { type: mongoose.Schema.Types.ObjectId, ref: "Cancellation", default: null },
    dispute: { type: mongoose.Schema.Types.ObjectId, ref: "Dispute", default: null },

    // ---- Legacy synced money fields (dashboard compatibility) ----
    amount: { type: Number, default: 0, min: 0 },
    platformFee: { type: Number, default: 0, min: 0 },
    sellerEarnings: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "USD" },
    dueDate: { type: Date, default: null },
    deliveryDate: { type: Date, default: null },
    revisionsAllowed: { type: Number, default: 0 },
    revisionsUsed: { type: Number, default: 0 },
    paymentStatus: {
      type: String,
      enum: ["unpaid", "paid", "refunded", "partial"],
      default: "unpaid",
    },

    // ---- Metadata ----
    isLate: { type: Boolean, default: false },
    lateReason: { type: String, default: null },
    cancelReason: { type: String, default: null },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    acceptedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/* ------------------------------------------------------------------ */
/* Indexes (based on actual query patterns)                            */
/* ------------------------------------------------------------------ */

orderSchema.index({ buyerId: 1, status: 1, createdAt: -1 });
orderSchema.index({ sellerId: 1, status: 1, createdAt: -1 });
orderSchema.index({ gigId: 1 });
orderSchema.index({ orderNumber: 1 }, { unique: true });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ "delivery.dueAt": 1 });
orderSchema.index({ "delivery.reviewPeriodEndsAt": 1 });
orderSchema.index({ "payment.providerPaymentId": 1 }, { unique: true, sparse: true });
orderSchema.index({ "payment.idempotencyKey": 1 }, { unique: true, sparse: true });
orderSchema.index({ "payment.providerEventId": 1 }, { unique: true, sparse: true });

/* ------------------------------------------------------------------ */
/* Sync legacy fields before save                                      */
/* ------------------------------------------------------------------ */

orderSchema.pre("save", async function () {
  if (this.pricing) {
    this.amount = this.pricing.total;
    this.platformFee = this.pricing.platformFee;
    this.currency = this.pricing.currency;
    this.sellerEarnings = Math.max(0, (this.pricing.subtotal || 0) - (this.pricing.platformFee || 0));
  }
  if (this.delivery) {
    this.dueDate = this.delivery.dueAt || null;
    this.deliveryDate = this.delivery.deliveredAt || null;
  }
  if (this.revisions) {
    this.revisionsAllowed = this.revisions.allowed;
    this.revisionsUsed = this.revisions.used;
  }
  if (this.payment) {
    this.paymentStatus =
      this.payment.status === "confirmed" ? "paid"
      : this.payment.status === "refunded" ? "refunded"
      : "unpaid";
  }
  if (this.packageSnapshot && this.packageSnapshot.packageId) {
    this.packageType = ["basic", "standard", "premium"].includes(String(this.packageSnapshot.packageId))
      ? String(this.packageSnapshot.packageId)
      : null;
  }

  const active = ["IN_PROGRESS", "PAID", "REQUIREMENTS_NEEDED", "DELIVERED", "REVISION_REQUESTED"];
  if (active.includes(this.status) && this.delivery && this.delivery.dueAt) {
    this.isLate = new Date() > this.delivery.dueAt;
  } else if (this.status !== "COMPLETED" && this.status !== "CANCELLED") {
    this.isLate = false;
  }
});

/* ------------------------------------------------------------------ */
/* Statics                                                             */
/* ------------------------------------------------------------------ */

orderSchema.statics.findByNumber = function (orderNumber) {
  return this.findOne({ orderNumber });
};

orderSchema.statics.isAccessibleBy = async function (order, user) {
  if (!order) return false;
  if (user.role === "admin") return true;
  const buyerId = order.buyerId?._id || order.buyerId;
  const sellerId = order.sellerId?._id || order.sellerId;
  return (
    String(buyerId) === String(user._id) ||
    String(sellerId) === String(user._id)
  );
};

const Order = mongoose.models.Order || mongoose.model("Order", orderSchema);

module.exports = Order;

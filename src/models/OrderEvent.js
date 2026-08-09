const mongoose = require("mongoose");
const { ORDER_EVENT_TYPES_VALUES } = require("../constants/order.constants");

/**
 * OrderEvent — immutable audit/timeline trail for an order.
 *
 * Every important lifecycle step (creation, payment, requirements, delivery,
 * revision, completion, cancellation, dispute) appends an event. This powers
 * the order timeline UI and dispute/moderation investigations.
 */
const orderEventSchema = new mongoose.Schema(
  {
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    actorRole: {
      type: String,
      enum: ["buyer", "seller", "admin", "system"],
      default: "system",
    },
    type: {
      type: String,
      enum: ORDER_EVENT_TYPES_VALUES,
      required: true,
    },
    fromStatus: { type: String, default: null },
    toStatus: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

orderEventSchema.index({ order: 1, createdAt: 1 });
orderEventSchema.index({ actor: 1, createdAt: -1 });

const OrderEvent =
  mongoose.models.OrderEvent || mongoose.model("OrderEvent", orderEventSchema);

module.exports = OrderEvent;

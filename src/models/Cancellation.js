const mongoose = require("mongoose");
const { CANCELLATION_STATUS_VALUES } = require("../constants/order.constants");

/**
 * Cancellation — a cancellation request record.
 *
 * Orders are financial/audit records and are NEVER physically deleted. When a
 * cancellation is approved the order transitions to CANCELLED and this record
 * keeps the reasoning + resolution.
 */
const cancellationSchema = new mongoose.Schema(
  {
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    requestedByRole: {
      type: String,
      enum: ["buyer", "seller", "admin"],
      required: true,
    },
    reason: { type: String, trim: true, required: true, maxlength: 2000 },
    status: {
      type: String,
      enum: CANCELLATION_STATUS_VALUES,
      default: "pending",
    },
    // Status the order had when the cancellation was requested (used when the
    // request is rejected so the order resumes from the correct state).
    fromStatus: { type: String, default: null },
    resolution: { type: String, default: null },
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

const Cancellation =
  mongoose.models.Cancellation || mongoose.model("Cancellation", cancellationSchema);

module.exports = Cancellation;

const mongoose = require("mongoose");
const {
  DISPUTE_STATUS_VALUES,
  DISPUTE_RESOLUTIONS_VALUES,
} = require("../constants/order.constants");

/**
 * Dispute — foundation for moderation/disputes.
 *
 * Kept separate from basic order data. Users can open a dispute; only admins
 * can modify the outcome (resolution). Prevents arbitrary user control over
 * dispute outcomes.
 */
const disputeSchema = new mongoose.Schema(
  {
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    openedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    openedByRole: {
      type: String,
      enum: ["buyer", "seller"],
      required: true,
    },
    reason: { type: String, trim: true, required: true, maxlength: 5000 },
    status: {
      type: String,
      enum: DISPUTE_STATUS_VALUES,
      default: "open",
    },
    resolution: {
      type: String,
      enum: DISPUTE_RESOLUTIONS_VALUES,
      default: null,
    },
    resolutionNotes: { type: String, default: null },
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    resolvedAt: { type: Date, default: null },
    messages: [
      {
        author: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        authorRole: { type: String, enum: ["buyer", "seller", "admin"] },
        content: { type: String, trim: true },
        createdAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

const Dispute = mongoose.models.Dispute || mongoose.model("Dispute", disputeSchema);

module.exports = Dispute;

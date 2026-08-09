const mongoose = require("mongoose");

/**
 * Revision — a buyer's revision request.
 *
 * Preserves full revision history (Revision #1, #2, ...) instead of only the
 * latest one. The revision count on the order is incremented by backend logic,
 * never accepted from the client.
 */
const revisionSchema = new mongoose.Schema(
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
    revisionNumber: { type: Number, required: true },
    delivery: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Delivery",
      default: null,
    },
    message: { type: String, trim: true, required: true, maxlength: 5000 },
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
    status: {
      type: String,
      enum: ["requested", "resolved"],
      default: "requested",
    },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

revisionSchema.index({ order: 1, revisionNumber: 1 }, { unique: true });

const Revision = mongoose.models.Revision || mongoose.model("Revision", revisionSchema);

module.exports = Revision;

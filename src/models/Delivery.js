const mongoose = require("mongoose");

/**
 * Delivery — a seller's delivery submission.
 *
 * Delivery HISTORY is preserved: each submission is a separate document so a
 * sequence of delivery → revision → delivery is fully auditable and shown to
 * buyers/sellers/admins.
 */
const deliverySchema = new mongoose.Schema(
  {
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    seller: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    deliveryNumber: { type: Number, required: true },
    message: { type: String, trim: true, maxlength: 5000 },
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
    links: [
      {
        label: { type: String, default: "" },
        url: { type: String },
      },
    ],
    notes: { type: String, default: null, maxlength: 2000 },
  },
  { timestamps: true }
);

deliverySchema.index({ order: 1, deliveryNumber: 1 }, { unique: true });

const Delivery = mongoose.models.Delivery || mongoose.model("Delivery", deliverySchema);

module.exports = Delivery;

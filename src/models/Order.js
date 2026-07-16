const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema({
  orderNumber: {
    type: String,
    unique: true,
    required: true,
  },
  buyerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  gigId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Gig",
    required: true,
  },
  packageType: {
    type: String,
    enum: ["basic", "standard", "premium"],
    required: true,
  },
  status: {
    type: String,
    enum: ["pending", "active", "in_progress", "review", "completed", "cancelled", "disputed"],
    default: "pending",
  },
  requirements: {
    type: String,
    default: null,
  },
  startDate: {
    type: Date,
    default: null,
  },
  dueDate: {
    type: Date,
    required: true,
  },
  deliveryDate: {
    type: Date,
    default: null,
  },
  amount: {
    type: Number,
    required: true,
    min: 0,
  },
  platformFee: {
    type: Number,
    default: 0,
  },
  sellerEarnings: {
    type: Number,
    default: 0,
  },
  currency: {
    type: String,
    default: "USD",
  },
  // Payment tracking
  paymentStatus: {
    type: String,
    enum: ["unpaid", "paid", "refunded", "partial"],
    default: "unpaid",
  },
  escrowId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Transaction",
    default: null,
  },
  // Project context
  projectTitle: {
    type: String,
    required: true,
  },
  projectDescription: {
    type: String,
    default: null,
  },
  // Delivery
  deliverableUrl: {
    type: String,
    default: null,
  },
  deliverableFiles: [{
    name: String,
    url: String,
    publicId: String,
  }],
  // Revisions
  revisionsUsed: {
    type: Number,
    default: 0,
  },
  revisionsAllowed: {
    type: Number,
    default: 3,
  },
  // Metadata
  isLate: {
    type: Boolean,
    default: false,
  },
  lateReason: {
    type: String,
    default: null,
  },
  cancelReason: {
    type: String,
    default: null,
  },
  cancelledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
  },
}, {
  timestamps: true,
});

// Indexes for query performance
orderSchema.index({ buyerId: 1, status: 1 });
orderSchema.index({ sellerId: 1, status: 1 });
orderSchema.index({ gigId: 1 });
orderSchema.index({ orderNumber: 1 });
orderSchema.index({ createdAt: -1 });

// Virtual for checking if overdue
orderSchema.virtual("isOverdue").get(function() {
  if (this.status === "completed" || this.status === "cancelled") return false;
  return new Date() > this.dueDate;
});

// Auto-update isLate before saving
orderSchema.pre("save", function(next) {
  if (this.status !== "completed" && this.status !== "cancelled") {
    this.isLate = new Date() > this.dueDate;
  }
  next();
});

// Generate unique order number
orderSchema.statics.generateOrderNumber = async function() {
  const count = await this.countDocuments();
  const timestamp = Date.now().toString(36).toUpperCase();
  return `ORD-${timestamp}-${(count + 1).toString().padStart(5, "0")}`;
};

const Order = mongoose.models.Order || mongoose.model("Order", orderSchema);

module.exports = Order;
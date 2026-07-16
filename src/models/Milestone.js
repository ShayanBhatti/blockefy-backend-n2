const mongoose = require("mongoose");

const milestoneSchema = new mongoose.Schema({
  milestoneNumber: {
    type: String,
    unique: true,
    required: true,
  },
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Order",
    required: true,
  },
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Project",
    default: null,
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
  // Milestone details
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200,
  },
  description: {
    type: String,
    default: null,
    maxlength: 2000,
  },
  amount: {
    type: Number,
    required: true,
    min: 0,
  },
  dueDate: {
    type: Date,
    required: true,
  },
  // Status
  status: {
    type: String,
    enum: ["pending", "funded", "in_progress", "submitted", "revision_requested", "completed", "cancelled", "disputed"],
    default: "pending",
  },
  // Payment
  paymentStatus: {
    type: String,
    enum: ["unpaid", "paid", "released", "refunded", "disputed"],
    default: "unpaid",
  },
  escrowTxId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Transaction",
    default: null,
  },
  releaseTxId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Transaction",
    default: null,
  },
  // Work submission
  submission: {
    url: String,
    description: String,
    files: [{
      name: String,
      url: String,
      publicId: String,
    }],
    submittedAt: Date,
  },
  // Revision tracking
  revisionRequests: [{
    reason: String,
    requestedAt: Date,
    resolved: {
      type: Boolean,
      default: false,
    },
  }],
  revisionsUsed: {
    type: Number,
    default: 0,
  },
  revisionsAllowed: {
    type: Number,
    default: 2,
  },
  // Completion
  completedAt: {
    type: Date,
    default: null,
  },
  // Cancellation
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

// Indexes
milestoneSchema.index({ orderId: 1 });
milestoneSchema.index({ buyerId: 1, status: 1 });
milestoneSchema.index({ sellerId: 1, status: 1 });
milestoneSchema.index({ createdAt: -1 });

// Generate unique milestone number
milestoneSchema.statics.generateMilestoneNumber = async function() {
  const count = await this.countDocuments();
  const timestamp = Date.now().toString(36).toUpperCase();
  return `MSN-${timestamp}-${(count + 1).toString().padStart(5, "0")}`;
};

const Milestone = mongoose.models.Milestone || mongoose.model("Milestone", milestoneSchema);

module.exports = Milestone;
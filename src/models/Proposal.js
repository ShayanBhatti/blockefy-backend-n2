const mongoose = require("mongoose");

const proposalSchema = new mongoose.Schema({
  proposalNumber: {
    type: String,
    unique: true,
    required: true,
  },
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Project",
    required: true,
  },
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  buyerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  // Proposal details
  coverLetter: {
    type: String,
    required: true,
    maxlength: 5000,
  },
  bidAmount: {
    type: Number,
    required: true,
    min: 0,
  },
  estimatedDuration: {
    type: String,
    required: true,
  },
  // Milestone proposal (if any)
  milestones: [{
    title: {
      type: String,
      required: true,
    },
    description: String,
    amount: Number,
    dueDate: Date,
  }],
  // Timeline
  startDate: {
    type: Date,
    default: null,
  },
  deliveryDays: {
    type: Number,
    required: true,
  },
  // Status
  status: {
    type: String,
    enum: ["pending", "submitted", "viewed", "shortlisted", "accepted", "rejected", "withdrawn", "expired"],
    default: "submitted",
  },
  // Tracking
  submittedAt: {
    type: Date,
    default: Date.now,
  },
  viewedAt: {
    type: Date,
    default: null,
  },
  // Rejection reason
  rejectionReason: {
    type: String,
    default: null,
  },
  // Seller's gig reference (if applying with a specific gig)
  gigId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Gig",
    default: null,
  },
  // Attachments
  attachments: [{
    name: String,
    url: String,
    publicId: String,
  }],
  // Terms acceptance
  termsAccepted: {
    type: Boolean,
    default: false,
  },
  termsAcceptedAt: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true,
});

// Indexes
proposalSchema.index({ projectId: 1, sellerId: 1 }, { unique: true });
proposalSchema.index({ sellerId: 1, status: 1 });
proposalSchema.index({ buyerId: 1, status: 1 });
proposalSchema.index({ projectId: 1, status: 1 });
proposalSchema.index({ createdAt: -1 });

// Generate unique proposal number
proposalSchema.statics.generateProposalNumber = async function() {
  const count = await this.countDocuments();
  const timestamp = Date.now().toString(36).toUpperCase();
  return `PRP-${timestamp}-${(count + 1).toString().padStart(5, "0")}`;
};

const Proposal = mongoose.models.Proposal || mongoose.model("Proposal", proposalSchema);

module.exports = Proposal;
const mongoose = require("mongoose");

const projectSchema = new mongoose.Schema({
  projectNumber: {
    type: String,
    unique: true,
    required: true,
  },
  buyerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200,
  },
  description: {
    type: String,
    required: true,
    maxlength: 5000,
  },
  category: {
    type: String,
    required: true,
    trim: true,
  },
  subcategory: {
    type: String,
    default: null,
  },
  skills: [{
    type: String,
    trim: true,
  }],
  experienceLevel: {
    type: String,
    enum: ["entry", "intermediate", "expert"],
    default: "intermediate",
  },
  projectType: {
    type: String,
    enum: ["fixed", "hourly"],
    default: "fixed",
  },
  budget: {
    min: {
      type: Number,
      required: true,
      min: 0,
    },
    max: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: "USD",
    },
  },
  duration: {
    type: String,
    default: null,
  },
  // Visibility
  status: {
    type: String,
    enum: ["draft", "open", "in_progress", "completed", "cancelled", "paused"],
    default: "draft",
  },
  visibility: {
    type: String,
    enum: ["public", "private", "invite_only"],
    default: "public",
  },
  // Hiring details
  hiredSellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
  },
  hiredAt: {
    type: Date,
    default: null,
  },
  // Attachments
  attachments: [{
    name: String,
    url: String,
    publicId: String,
    type: String,
  }],
  // Milestones (if any)
  milestones: [{
    title: {
      type: String,
      required: true,
    },
    description: String,
    amount: Number,
    dueDate: Date,
    status: {
      type: String,
      enum: ["pending", "in_progress", "completed", "cancelled"],
      default: "pending",
    },
  }],
  // Deadline
  deadline: {
    type: Date,
    default: null,
  },
  // Proposals count
  proposalCount: {
    type: Number,
    default: 0,
  },
  // Selected proposal
  selectedProposalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Proposal",
    default: null,
  },
  // Completion
  completedAt: {
    type: Date,
    default: null,
  },
  cancelReason: {
    type: String,
    default: null,
  },
}, {
  timestamps: true,
});

// Indexes
projectSchema.index({ buyerId: 1, status: 1 });
projectSchema.index({ status: 1, visibility: 1 });
projectSchema.index({ category: 1, skills: 1 });
projectSchema.index({ createdAt: -1 });
projectSchema.index({ title: "text", description: "text" });

// Generate unique project number
projectSchema.statics.generateProjectNumber = async function() {
  const count = await this.countDocuments();
  const timestamp = Date.now().toString(36).toUpperCase();
  return `PRJ-${timestamp}-${(count + 1).toString().padStart(5, "0")}`;
};

const Project = mongoose.models.Project || mongoose.model("Project", projectSchema);

module.exports = Project;
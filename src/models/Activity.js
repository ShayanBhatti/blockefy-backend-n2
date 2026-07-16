const mongoose = require("mongoose");

const activitySchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  // Activity type
  type: {
    type: String,
    enum: [
      // User activities
      "user_registered",
      "user_login",
      "user_logout",
      "profile_updated",
      "email_verified",
      "wallet_connected",
      // Gig activities
      "gig_created",
      "gig_updated",
      "gig_deleted",
      "gig_published",
      "gig_unpublished",
      // Order activities
      "order_created",
      "order_started",
      "order_submitted",
      "order_delivered",
      "order_completed",
      "order_cancelled",
      "order_disputed",
      // Project activities
      "project_created",
      "project_updated",
      "project_published",
      "project_hired",
      "project_completed",
      "project_cancelled",
      // Proposal activities
      "proposal_submitted",
      "proposal_accepted",
      "proposal_rejected",
      "proposal_withdrawn",
      // Milestone activities
      "milestone_funded",
      "milestone_submitted",
      "milestone_approved",
      "milestone_revision_requested",
      // Payment activities
      "payment_made",
      "payment_received",
      "withdrawal_requested",
      "withdrawal_completed",
      "deposit_made",
      // Review activities
      "review_received",
      "review_given",
      // Notification activities
      "notification_sent",
      // System activities
      "system_error",
      "system_warning",
    ],
    required: true,
  },
  // Priority
  priority: {
    type: String,
    enum: ["low", "normal", "high"],
    default: "normal",
  },
  // Description
  description: {
    type: String,
    required: true,
    maxlength: 500,
  },
  // Short description (for dashboard cards)
  shortDescription: {
    type: String,
    maxlength: 100,
  },
  // Related entities
  relatedEntity: {
    type: {
      type: String,
      enum: ["order", "project", "proposal", "milestone", "gig", "review", "user", "transaction", "notification"],
    },
    id: {
      type: mongoose.Schema.Types.ObjectId,
    },
    name: String,
  },
  // Additional metadata
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  // IP address (for security logging)
  ipAddress: {
    type: String,
    default: null,
  },
  // User agent
  userAgent: {
    type: String,
    default: null,
  },
  // Visibility (for dashboard display)
  isVisible: {
    type: Boolean,
    default: true,
  },
  // Importance (for dashboard highlights)
  isImportant: {
    type: Boolean,
    default: false,
  },
  // Category (for filtering)
  category: {
    type: String,
    enum: ["account", "gig", "order", "project", "proposal", "payment", "review", "system"],
    default: "system",
  },
}, {
  timestamps: true,
});

// Indexes
activitySchema.index({ userId: 1, createdAt: -1 });
activitySchema.index({ userId: 1, type: 1 });
activitySchema.index({ userId: 1, category: 1 });
activitySchema.index({ createdAt: -1 });

// TTL index - auto-delete activities older than 90 days
activitySchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

// Static method to log activity
activitySchema.statics.log = async function(data) {
  try {
    const activity = await this.create(data);
    return activity;
  } catch (error) {
    console.error("Failed to log activity:", error);
    return null;
  }
};

// Static method to get recent activities for dashboard
activitySchema.statics.getRecentActivities = async function(userId, limit = 20) {
  return this.find({ userId, isVisible: true })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
};

// Static method to get activities by category
activitySchema.statics.getActivitiesByCategory = async function(userId, category, limit = 20) {
  return this.find({ userId, category, isVisible: true })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
};

// Static method to get activity statistics
activitySchema.statics.getActivityStats = async function(userId, days = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const stats = await this.aggregate([
    {
      $match: {
        userId: userId,
        createdAt: { $gte: startDate },
      },
    },
    {
      $group: {
        _id: "$category",
        count: { $sum: 1 },
      },
    },
  ]);

  return stats.reduce((acc, item) => {
    acc[item._id] = item.count;
    return acc;
  }, {});
};

const Activity = mongoose.models.Activity || mongoose.model("Activity", activitySchema);

module.exports = Activity;
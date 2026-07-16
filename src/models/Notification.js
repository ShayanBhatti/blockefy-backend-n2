const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  // Notification type
  type: {
    type: String,
    enum: [
      // Order notifications
      "order_created",
      "order_started",
      "order_submitted",
      "order_completed",
      "order_cancelled",
      "order_late",
      // Proposal notifications
      "proposal_received",
      "proposal_accepted",
      "proposal_rejected",
      "proposal_withdrawn",
      // Milestone notifications
      "milestone_funded",
      "milestone_submitted",
      "milestone_completed",
      "milestone_revision_requested",
      // Payment notifications
      "payment_received",
      "payment_released",
      "payment_refunded",
      "deposit_completed",
      "withdrawal_completed",
      // Review notifications
      "review_received",
      "review_response_requested",
      // Message notifications
      "message_received",
      // General notifications
      "account_verified",
      "profile_completed",
      "gig_approved",
      "gig_rejected",
      "warning",
      "system",
    ],
    required: true,
  },
  // Priority
  priority: {
    type: String,
    enum: ["low", "normal", "high", "urgent"],
    default: "normal",
  },
  // Title and content
  title: {
    type: String,
    required: true,
    maxlength: 200,
  },
  message: {
    type: String,
    required: true,
    maxlength: 1000,
  },
  // Action URL (where clicking the notification leads)
  actionUrl: {
    type: String,
    default: null,
  },
  // Related entities
  relatedEntity: {
    type: {
      type: String,
      enum: ["order", "project", "proposal", "milestone", "gig", "review", "message", "user", "transaction"],
    },
    id: {
      type: mongoose.Schema.Types.ObjectId,
    },
  },
  // Data payload (additional data)
  data: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  // Read status
  isRead: {
    type: Boolean,
    default: false,
  },
  readAt: {
    type: Date,
    default: null,
  },
  // Dismiss status
  isDismissed: {
    type: Boolean,
    default: false,
  },
  dismissedAt: {
    type: Date,
    default: null,
  },
  // Email notification status
  emailSent: {
    type: Boolean,
    default: false,
  },
  emailSentAt: {
    type: Date,
    default: null,
  },
  // Push notification status
  pushSent: {
    type: Boolean,
    default: false,
  },
  pushSentAt: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true,
});

// Indexes
notificationSchema.index({ userId: 1, isRead: 1 });
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, type: 1 });
notificationSchema.index({ createdAt: -1 });

// Static method to mark as read
notificationSchema.statics.markAsRead = async function(notificationId, userId) {
  return this.findOneAndUpdate(
    { _id: notificationId, userId },
    { isRead: true, readAt: new Date() },
    { new: true }
  );
};

// Static method to mark all as read
notificationSchema.statics.markAllAsRead = async function(userId) {
  return this.updateMany(
    { userId, isRead: false },
    { isRead: true, readAt: new Date() }
  );
};

// Static method to get unread count
notificationSchema.statics.getUnreadCount = async function(userId) {
  return this.countDocuments({ userId, isRead: false, isDismissed: false });
};

// Static method to create and emit (for real-time)
notificationSchema.statics.createNotification = async function(data) {
  const notification = await this.create(data);
  // Emit to socket if needed - handled by controller
  return notification;
};

const Notification = mongoose.models.Notification || mongoose.model("Notification", notificationSchema);

module.exports = Notification;
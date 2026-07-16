const mongoose = require("mongoose");

const reviewSchema = new mongoose.Schema({
  reviewNumber: {
    type: String,
    unique: true,
    required: true,
  },
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Order",
    required: true,
  },
  gigId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Gig",
    default: null,
  },
  // Reviewer (buyer or seller)
  reviewerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  reviewerRole: {
    type: String,
    enum: ["buyer", "seller"],
    required: true,
  },
  // User being reviewed
  revieweeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  revieweeRole: {
    type: String,
    enum: ["buyer", "seller"],
    required: true,
  },
  // Ratings (1-5 stars)
  overallRating: {
    type: Number,
    required: true,
    min: 1,
    max: 5,
  },
  ratingBreakdown: {
    communication: {
      type: Number,
      min: 1,
      max: 5,
      default: null,
    },
    quality: {
      type: Number,
      min: 1,
      max: 5,
      default: null,
    },
    professionalism: {
      type: Number,
      min: 1,
      max: 5,
      default: null,
    },
    timeliness: {
      type: Number,
      min: 1,
      max: 5,
      default: null,
    },
  },
  // Review content
  comment: {
    type: String,
    default: null,
    maxlength: 2000,
  },
  // Tags
  tags: [{
    type: String,
  }],
  // Seller-specific
  wouldRecommend: {
    type: Boolean,
    default: null,
  },
  // Public/Private
  isPublic: {
    type: Boolean,
    default: true,
  },
  // Status
  status: {
    type: String,
    enum: ["pending", "published", "flagged", "removed"],
    default: "pending",
  },
  // Moderation
  flagReason: {
    type: String,
    default: null,
  },
  removedAt: {
    type: Date,
    default: null,
  },
  // Response
  response: {
    content: String,
    respondedAt: Date,
  },
}, {
  timestamps: true,
});

// Indexes
reviewSchema.index({ orderId: 1 }, { unique: true });
reviewSchema.index({ reviewerId: 1, status: 1 });
reviewSchema.index({ revieweeId: 1, status: 1 });
reviewSchema.index({ gigId: 1, status: 1 });
reviewSchema.index({ createdAt: -1 });

// Generate unique review number
reviewSchema.statics.generateReviewNumber = async function() {
  const count = await this.countDocuments();
  const timestamp = Date.now().toString(36).toUpperCase();
  return `REV-${timestamp}-${(count + 1).toString().padStart(5, "0")}`;
};

// Calculate average rating for a user (static method)
reviewSchema.statics.calculateAverageRating = async function(userId) {
  const result = await this.aggregate([
    {
      $match: {
        revieweeId: userId,
        status: "published",
      },
    },
    {
      $group: {
        _id: "$revieweeId",
        avgRating: { $avg: "$overallRating" },
        totalReviews: { $sum: 1 },
      },
    },
  ]);

  return result[0] || { avgRating: 0, totalReviews: 0 };
};

const Review = mongoose.models.Review || mongoose.model("Review", reviewSchema);

module.exports = Review;
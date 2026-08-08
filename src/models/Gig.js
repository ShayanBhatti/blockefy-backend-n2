const mongoose = require("mongoose");

const gigSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    title: {
      type: String,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ["draft", "posted"],
      default: "draft",
    },
    category: {
      type: String,
      trim: true,
    },
    tags: {
      type: [String],
      default: [],
    },
    pricing: {
      basic: {
        type: Number,
        min: 0,
      },
      standard: {
        type: Number,
        min: 0,
      },
      premium: {
        type: Number,
        min: 0,
      },
    },
    deliveryTime: {
      type: Number,
      // in days
    },
    // Image storage - stores Cloudinary URL and publicId
    gigImage: {
      type: String,  // Cloudinary URL
      default: null,
    },
    gigImagePublicId: {
      type: String,  // Cloudinary publicId for deletion
      default: null,
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt fields
  },
);

// Prevent model overwrite in serverless
const Gig = mongoose.models.Gig || mongoose.model("Gig", gigSchema);

module.exports = Gig;

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
      required: true,
      trim: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
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
    images: {
      type: [
        {
          data: {
            type: String,
            required: true,
          },
          contentType: {
            type: String,
            required: true,
          },
          isPrimary: {
            type: Boolean,
            default: false,
          },
        },
      ],
      validate: [(val) => val.length <= 3, "Max 3 images allowed"],
      default: [],
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt fields
  },
);

// Prevent model overwrite in serverless
const Gig = mongoose.models.Gig || mongoose.model("Gig", gigSchema);

module.exports = Gig;

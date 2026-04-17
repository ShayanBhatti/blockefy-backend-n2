import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      unique: true,
      sparse: true, // Allow multiple null values (for wallet-only users)
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      // Optional - only for email/password auth
    },
    role: {
      type: String,
      enum: ["buyer", "seller"],
      default: "buyer",
    },
    authProvider: {
      type: String,
      enum: ["email", "google", "github", "wallet"],
      required: true,
    },
    googleId: {
      type: String,
      sparse: true,
    },
    githubId: {
      type: String,
      sparse: true,
    },
    walletAddress: {
      type: String,
      unique: true,
      sparse: true, // Allow multiple null values
      lowercase: true,
      trim: true,
    },
    walletPrivateKey: {
      type: String,
      // Should be encrypted before storing
      // Never send this in responses
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true, // Adds updatedAt field
  }
);

// Prevent model overwrite in serverless
const User = mongoose.models.User || mongoose.model("User", userSchema);

export default User;

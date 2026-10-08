const mongoose = require("mongoose");

/**
 * One-time wallet-signature challenge.
 *
 * Issued by POST /auth/wallet/nonce and consumed by POST /auth/wallet/verify.
 * Storing the challenge separately (instead of on the User document) means the
 * nonce endpoint performs NO user creation - it can no longer be abused to
 * write unauthenticated user documents for arbitrary addresses.
 *
 * A TTL index deletes expired challenges automatically.
 */
const walletChallengeSchema = new mongoose.Schema(
  {
    walletAddress: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      unique: true,
      index: true,
    },
    nonce: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true }
);

walletChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const WalletChallenge =
  mongoose.models.WalletChallenge ||
  mongoose.model("WalletChallenge", walletChallengeSchema);

module.exports = WalletChallenge;
const mongoose = require("mongoose");

/**
 * One-time, short-lived exchange code returned from an OAuth callback.
 *
 * The callback redirects the browser to the frontend with ONLY this code in
 * the URL (never a JWT). The frontend immediately POSTs it to
 * `POST /auth/exchange` and receives the JWT in the response body. The code
 * is 192 bits of randomness, single-use, and expires after ~60s (TTL index
 * removes it automatically), so even if it leaks via Referer/logs/history it
 * cannot be traded for a session after the fact.
 */
const oauthCodeSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "User",
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true }
);

oauthCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const OAuthCode =
  mongoose.models.OAuthCode || mongoose.model("OAuthCode", oauthCodeSchema);

module.exports = OAuthCode;
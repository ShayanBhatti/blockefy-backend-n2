const mongoose = require("mongoose");

/**
 * Conversation model.
 *
 * Supports:
 *  - direct user-to-user conversations (type: "direct")
 *  - order-scoped conversations (type: "order", tied to an Order)
 *
 * A `conversationKey` (unique, sparse) guarantees a single conversation per
 * participant pair (direct) and a single conversation per order, so callers
 * can safely "get-or-create".
 */
const conversationSchema = new mongoose.Schema(
  {
    participants: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      required: true,
    },
    type: {
      type: String,
      enum: ["direct", "order"],
      default: "direct",
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    lastMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      default: null,
    },
    lastMessageAt: {
      type: Date,
      default: null,
    },
    /**
     * Unique lookup key computed in the pre-validate hook below.
     * MUST be declared in the schema — strict mode drops undeclared paths,
     * which previously made the dedupe/uniqueness guarantees ineffective.
     */
    conversationKey: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

/* ------------------------------------------------------------------ */
/* Indexes (based on actual query patterns)                            */
/* ------------------------------------------------------------------ */

// List conversations a user belongs to, most recent first.
conversationSchema.index({ participants: 1, lastMessageAt: -1 });
conversationSchema.index({ participants: 1, updatedAt: -1 });
// Single conversation per participant pair / per order.
conversationSchema.index({ conversationKey: 1 }, { unique: true, sparse: true });
// Find order conversations quickly.
conversationSchema.index({ type: 1, orderId: 1 });

/* ------------------------------------------------------------------ */
/* Conversation key: dedupe participants + build unique lookup key     */
/* ------------------------------------------------------------------ */

conversationSchema.pre("validate", async function () {
  if (this.participants && Array.isArray(this.participants)) {
    const ids = this.participants.map(String).filter(Boolean);
    this.participants = [...new Set(ids)].map((id) => new mongoose.Types.ObjectId(id));
  }

  if (this.type === "direct") {
    if (!this.participants || this.participants.length !== 2) {
      throw new Error("A direct conversation requires exactly two unique participants");
    }
    this.conversationKey = `d:${this.participants.map(String).sort().join("_")}`;
  } else if (this.type === "order") {
    if (!this.orderId) {
      throw new Error("An order conversation requires an orderId");
    }
    this.conversationKey = `o:${String(this.orderId)}`;
  }
});

const Conversation = mongoose.models.Conversation || mongoose.model("Conversation", conversationSchema);

module.exports = Conversation;

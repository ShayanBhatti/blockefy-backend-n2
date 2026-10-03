const mongoose = require("mongoose");

/**
 * ChainEvent - an audit log of every transaction the backend relays to the
 * escrow contract.
 *
 * Why this is separate from `Transaction`:
 * `Transaction` is the MONEY ledger. `getUserBalance()` aggregates it by type,
 * so appending non-money rows (milestone submitted, revision requested,
 * dispute opened) would corrupt every balance and earnings figure in the app.
 * ChainEvent therefore records contract STATE transitions with no effect on
 * money, giving the wallet page a complete activity timeline.
 *
 * Rows are written from a single hook inside chain.service's relay helpers, so
 * individual call sites never need to remember to log.
 */
const chainEventSchema = new mongoose.Schema(
  {
    /** Transaction hash once broadcast. Absent if the send failed before broadcast. */
    txHash: {
      type: String,
      default: null,
    },
    blockNumber: {
      type: Number,
      default: null,
    },
    chainId: {
      type: Number,
      default: null,
    },
    contractAddress: {
      type: String,
      default: null,
      lowercase: true,
    },
    /** Contract method that was invoked, e.g. "submitMilestone". */
    method: {
      type: String,
      required: true,
    },
    /**
     * Address that signed. For escrow this is always the buyer or freelancer
     * whose key the backend relayed - never an operator or admin key.
     */
    actorAddress: {
      type: String,
      required: true,
      lowercase: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      default: null,
    },
    milestoneId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Milestone",
      default: null,
    },
    proposalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Proposal",
      default: null,
    },
    status: {
      type: String,
      enum: ["confirmed", "failed"],
      default: "confirmed",
    },
    /** Revert reason or transport error, for failed sends. Never a secret. */
    error: {
      type: String,
      default: null,
    },
    /** Wei sent with the call (payable methods only). */
    valueWei: {
      type: String,
      default: null,
    },
    description: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

// One row per broadcast transaction.
chainEventSchema.index(
  { txHash: 1 },
  { unique: true, sparse: true, partialFilterExpression: { txHash: { $type: "string" } } }
);
// Wallet activity timeline.
chainEventSchema.index({ actorAddress: 1, createdAt: -1 });
chainEventSchema.index({ userId: 1, createdAt: -1 });
chainEventSchema.index({ projectId: 1, createdAt: -1 });

module.exports = mongoose.models.ChainEvent || mongoose.model("ChainEvent", chainEventSchema);
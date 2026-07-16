const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema({
  transactionNumber: {
    type: String,
    unique: true,
    required: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  // Transaction type
  type: {
    type: String,
    enum: ["deposit", "withdrawal", "escrow_funded", "escrow_released", "escrow_refunded", "payment", "refund", "platform_fee", "earning", "withdrawal_fee"],
    required: true,
  },
  // Amount
  amount: {
    type: Number,
    required: true,
  },
  currency: {
    type: String,
    default: "USD",
  },
  // Crypto amount (if applicable)
  cryptoAmount: {
    type: Number,
    default: null,
  },
  cryptoCurrency: {
    type: String,
    default: null,
  },
  // Status
  status: {
    type: String,
    enum: ["pending", "processing", "completed", "failed", "cancelled"],
    default: "pending",
  },
  // Related entities
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Order",
    default: null,
  },
  milestoneId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Milestone",
    default: null,
  },
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Project",
    default: null,
  },
  // Payment method
  paymentMethod: {
    type: String,
    enum: ["card", "bank_transfer", "crypto", "wallet"],
    default: "wallet",
  },
  // Blockchain details (for crypto transactions)
  blockchain: {
    type: String,
    default: null,
  },
  txHash: {
    type: String,
    default: null,
  },
  fromAddress: {
    type: String,
    default: null,
  },
  toAddress: {
    type: String,
    default: null,
  },
  // Escrow details
  isEscrow: {
    type: Boolean,
    default: false,
  },
  escrowStatus: {
    type: String,
    enum: ["held", "released", "refunded", "disputed"],
    default: null,
  },
  // Balance after transaction
  balanceAfter: {
    type: Number,
    default: null,
  },
  // Fees
  fee: {
    type: Number,
    default: 0,
  },
  feePercentage: {
    type: Number,
    default: 0,
  },
  // Metadata
  description: {
    type: String,
    default: null,
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  // External reference
  externalRef: {
    type: String,
    default: null,
  },
  // Completion
  completedAt: {
    type: Date,
    default: null,
  },
  failureReason: {
    type: String,
    default: null,
  },
}, {
  timestamps: true,
});

// Indexes
transactionSchema.index({ userId: 1, type: 1 });
transactionSchema.index({ userId: 1, status: 1 });
transactionSchema.index({ orderId: 1 });
transactionSchema.index({ txHash: 1 });
transactionSchema.index({ createdAt: -1 });

// Generate unique transaction number
transactionSchema.statics.generateTransactionNumber = async function() {
  const count = await this.countDocuments();
  const timestamp = Date.now().toString(36).toUpperCase();
  return `TXN-${timestamp}-${(count + 1).toString().padStart(5, "0")}`;
};

// Get user's wallet balance
transactionSchema.statics.getUserBalance = async function(userId) {
  const result = await this.aggregate([
    {
      $match: {
        userId: userId,
        status: "completed",
        type: { $in: ["deposit", "escrow_released", "earning"] },
      },
    },
    {
      $group: {
        _id: "$userId",
        totalCredits: { $sum: "$amount" },
      },
    },
  ]);

  const credits = result[0]?.totalCredits || 0;

  // Subtract debits
  const debits = await this.aggregate([
    {
      $match: {
        userId: userId,
        status: "completed",
        type: { $in: ["withdrawal", "payment", "escrow_funded", "platform_fee", "withdrawal_fee"] },
      },
    },
    {
      $group: {
        _id: "$userId",
        totalDebits: { $sum: "$amount" },
      },
    },
  ]);

  const totalDebits = debits[0]?.totalDebits || 0;
  return credits - totalDebits;
};

const Transaction = mongoose.models.Transaction || mongoose.model("Transaction", transactionSchema);

module.exports = Transaction;
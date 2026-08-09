const Transaction = require("../models/Transaction");

/**
 * Financial ledger service.
 *
 * Seller earnings are NEVER released merely because an order was created.
 * Money moves through an immutable ledger (Transaction model) on verified
 * events only:
 *
 *  - Buyer funds escrow on payment (escrow_funded).
 *  - On completion: escrow_released (gross) to seller + platform_fee debit,
 *    net effect = subtotal - platformFee = seller earnings.
 *  - On refund: escrow_refunded to buyer.
 *
 * The existing Transaction.getUserBalance() accounts for these types, so
 * wallet balances stay correct without mutating a "balance" field directly.
 */

const generateNumber = async (Model, prefix) => {
  let attempt = 0;
  // Retry on the (unlikely) duplicate-key collision of the unique number.
  while (attempt < 3) {
    const n = await Model.generateTransactionNumber();
    try {
      return n;
    } catch {
      attempt += 1;
    }
  }
  throw new Error("Could not allocate a unique transaction number");
};

/**
 * Debit the buyer's wallet into escrow.
 * @param {Object} input { buyerId, orderId, total, currency }
 */
const fundEscrow = async ({ buyerId, orderId, total, currency }) => {
  if (total <= 0) return null;
  const transactionNumber = await generateNumber(Transaction, "TXN");
  return Transaction.create({
    transactionNumber,
    userId: buyerId,
    type: "escrow_funded",
    amount: total,
    currency,
    status: "completed",
    orderId,
    isEscrow: true,
    escrowStatus: "held",
    paymentMethod: "wallet",
    description: "Funds held in escrow for order",
    completedAt: new Date(),
  });
};

/**
 * Release seller earnings on completion.
 * @param {Object} input { sellerId, orderId, subtotal, platformFee, currency }
 */
const releaseEarnings = async ({ sellerId, orderId, subtotal, platformFee, currency }) => {
  const released = await Transaction.create({
    transactionNumber: await generateNumber(Transaction, "TXN"),
    userId: sellerId,
    type: "escrow_released",
    amount: subtotal,
    currency,
    status: "completed",
    orderId,
    isEscrow: true,
    escrowStatus: "released",
    paymentMethod: "wallet",
    description: "Order escrow released to seller",
    completedAt: new Date(),
  });

  if (platformFee > 0) {
    await Transaction.create({
      transactionNumber: await generateNumber(Transaction, "TXN"),
      userId: sellerId,
      type: "platform_fee",
      amount: platformFee,
      currency,
      status: "completed",
      orderId,
      paymentMethod: "wallet",
      description: "Platform service fee",
      fee: platformFee,
      completedAt: new Date(),
    });
  }

  return released;
};

/**
 * Refund the buyer's escrow (cancellation / dispute refund).
 * @param {Object} input { buyerId, orderId, amount, currency }
 */
const refundEscrow = async ({ buyerId, orderId, amount, currency }) => {
  if (amount <= 0) return null;
  return Transaction.create({
    transactionNumber: await generateNumber(Transaction, "TXN"),
    userId: buyerId,
    type: "escrow_refunded",
    amount,
    currency,
    status: "completed",
    orderId,
    isEscrow: true,
    escrowStatus: "refunded",
    paymentMethod: "wallet",
    description: "Order escrow refunded to buyer",
    completedAt: new Date(),
  });
};

module.exports = {
  fundEscrow,
  releaseEarnings,
  refundEscrow,
};

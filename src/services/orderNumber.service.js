const OrderCounter = require("../models/OrderCounter");

/**
 * Collision-safe, human-readable order number generation.
 *
 * Format: BLK-YYYY-NNNNNN (e.g. BLK-2026-000123)
 *
 * Uses an atomic counter collection so concurrent requests never collide and
 * the number is never generated on the frontend.
 */
const generateOrderNumber = async () => {
  const year = new Date().getFullYear();
  const seq = await OrderCounter.nextSequence(`order-${year}`);
  return `BLK-${year}-${String(seq).padStart(6, "0")}`;
};

module.exports = { generateOrderNumber };

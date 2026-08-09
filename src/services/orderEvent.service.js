const OrderEvent = require("../models/OrderEvent");

/**
 * OrderEvent helper — appends immutable timeline entries.
 * Best-effort: an event insert failure must not roll back the order update,
 * so errors are logged and swallowed.
 */
const pushEvent = async ({ orderId, actor = null, actorRole = "system", type, fromStatus = null, toStatus = null, metadata = {} }) => {
  try {
    await OrderEvent.create({
      order: orderId,
      actor: actor || undefined,
      actorRole,
      type,
      fromStatus,
      toStatus,
      metadata,
    });
  } catch (error) {
    console.error("OrderEvent insert failed (non-fatal):", error.message);
  }
};

const getTimeline = async (orderId) => {
  return OrderEvent.find({ order: orderId }).sort({ createdAt: 1 }).lean();
};

module.exports = { pushEvent, getTimeline };

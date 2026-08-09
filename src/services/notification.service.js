const Notification = require("../models/Notification");

/**
 * Notification service.
 *
 * Emits in-app notifications for order events. Later this can fan out to
 * Firebase push / email without touching order controllers — controllers call
 * this service, not the Notification model directly.
 *
 * Notification creation is best-effort: a failure must never break the order
 * transaction, so errors are logged and swallowed.
 */
const createNotification = async ({
  userId,
  type,
  title,
  message,
  priority = "normal",
  actionUrl = null,
  relatedEntity = null,
  data = {},
}) => {
  try {
    if (!userId) return null;
    const doc = {
      userId,
      type,
      title: String(title).slice(0, 200),
      message: String(message).slice(0, 1000),
      priority,
      actionUrl,
      data,
    };
    if (relatedEntity) doc.relatedEntity = relatedEntity;
    return await Notification.create(doc);
  } catch (error) {
    console.error("Notification creation failed (non-fatal):", error.message);
    return null;
  }
};

const orderActionUrl = (orderId) =>
  `${process.env.FRONTEND_URL || "http://localhost:3000"}/orders/${orderId}`;

const orderRelatedEntity = (orderId) => ({ type: "order", id: orderId });

const notify = {
  orderCreated: (userId, orderId, orderNumber) =>
    createNotification({
      userId,
      type: "order_created",
      title: "Order created",
      message: `Your order ${orderNumber} has been created.`,
      actionUrl: orderActionUrl(orderId),
      relatedEntity: orderRelatedEntity(orderId),
    }),
  newOrderToSeller: (userId, orderId, orderNumber) =>
    createNotification({
      userId,
      type: "order_created",
      title: "New order received",
      message: `You received a new order ${orderNumber}.`,
      actionUrl: orderActionUrl(orderId),
      relatedEntity: orderRelatedEntity(orderId),
    }),
  requirementsSubmitted: (userId, orderId) =>
    createNotification({
      userId,
      type: "order_started",
      title: "Requirements submitted",
      message: "Your buyer has submitted the order requirements.",
      actionUrl: orderActionUrl(orderId),
      relatedEntity: orderRelatedEntity(orderId),
    }),
  orderStarted: (userId, orderId, orderNumber) =>
    createNotification({
      userId,
      type: "order_started",
      title: "Order started",
      message: `Work has started on order ${orderNumber}.`,
      actionUrl: orderActionUrl(orderId),
      relatedEntity: orderRelatedEntity(orderId),
    }),
  deliverySubmitted: (userId, orderId) =>
    createNotification({
      userId,
      type: "order_submitted",
      title: "Delivery submitted",
      message: "Your order has been delivered. Please review it.",
      actionUrl: orderActionUrl(orderId),
      relatedEntity: orderRelatedEntity(orderId),
    }),
  revisionRequested: (userId, orderId) =>
    createNotification({
      userId,
      type: "milestone_revision_requested",
      title: "Revision requested",
      message: "Your buyer requested a revision on the delivery.",
      actionUrl: orderActionUrl(orderId),
      relatedEntity: orderRelatedEntity(orderId),
    }),
  orderCompletedToSeller: (userId, orderId, orderNumber) =>
    createNotification({
      userId,
      type: "order_completed",
      title: "Order completed",
      message: `Order ${orderNumber} has been completed.`,
      actionUrl: orderActionUrl(orderId),
      relatedEntity: orderRelatedEntity(orderId),
    }),
  orderCompletedToBuyer: (userId, orderId, orderNumber) =>
    createNotification({
      userId,
      type: "order_completed",
      title: "Order completed — leave a review",
      message: `Order ${orderNumber} is complete. You can now leave a review.`,
      actionUrl: orderActionUrl(orderId),
      relatedEntity: orderRelatedEntity(orderId),
    }),
  cancellationRequested: (userId, orderId) =>
    createNotification({
      userId,
      type: "order_cancelled",
      title: "Cancellation requested",
      message: "The other party requested to cancel this order.",
      actionUrl: orderActionUrl(orderId),
      relatedEntity: orderRelatedEntity(orderId),
    }),
  orderCancelled: (userId, orderId, orderNumber) =>
    createNotification({
      userId,
      type: "order_cancelled",
      title: "Order cancelled",
      message: `Order ${orderNumber} has been cancelled.`,
      actionUrl: orderActionUrl(orderId),
      relatedEntity: orderRelatedEntity(orderId),
    }),
  disputeOpened: (userId, orderId) =>
    createNotification({
      userId,
      type: "warning",
      title: "Dispute opened",
      message: "A dispute has been opened on this order.",
      actionUrl: orderActionUrl(orderId),
      relatedEntity: orderRelatedEntity(orderId),
    }),
  paymentConfirmed: (userId, orderId) =>
    createNotification({
      userId,
      type: "payment_received",
      title: "Payment confirmed",
      message: "Your payment was confirmed.",
      actionUrl: orderActionUrl(orderId),
      relatedEntity: orderRelatedEntity(orderId),
    }),
};

module.exports = {
  createNotification,
  notify,
  orderActionUrl,
  orderRelatedEntity,
};

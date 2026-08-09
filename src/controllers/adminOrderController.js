const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const Order = require("../models/Order");
const orderService = require("../services/order.service");
const paymentService = require("../services/payment.service");
const config = require("../config/orderConfig");
const AppError = require("../utils/AppError");

/**
 * Admin order endpoints — elevated moderation/dispute permissions.
 * All routes behind authenticate + authorizeRole("admin").
 */

exports.getAllOrders = asyncHandler(async (req, res) => {
  const { filter, sort, page, limit, search } = req.query;

  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(config.maxPageLimit, Math.max(1, Number(limit) || config.defaultPageLimit));

  const q = {};
  const allowedFilters = {
    active: ["PAID", "REQUIREMENTS_NEEDED", "IN_PROGRESS", "DELIVERED", "REVISION_REQUESTED"],
    delivered: ["DELIVERED"],
    completed: ["COMPLETED"],
    cancelled: ["CANCELLED", "CANCEL_REQUESTED"],
    revision_requested: ["REVISION_REQUESTED"],
    disputed: ["DISPUTED"],
    pending_payment: ["PENDING_PAYMENT"],
  };
  if (filter) {
    if (!allowedFilters[filter]) throw new AppError("Invalid order filter", 400, "VALIDATION_ERROR");
    q.status = { $in: allowedFilters[filter] };
  }
  if (search) {
    const regex = new RegExp(String(search).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    q.$or = [{ orderNumber: regex }, { projectTitle: regex }];
  }

  const sortMap = { createdAt: "createdAt", updatedAt: "updatedAt", dueAt: "delivery.dueAt" };
  let sortKey = "-createdAt";
  if (sort) {
    const dir = sort.startsWith("-") ? -1 : 1;
    const field = sort.replace(/^-/, "");
    if (!sortMap[field]) throw new AppError("Invalid sort field", 400, "VALIDATION_ERROR");
    sortKey = dir === -1 ? `-${sortMap[field]}` : sortMap[field];
  }

  const [orders, total] = await Promise.all([
    Order.find(q)
      .populate("gigId", "title")
      .populate("buyerId", "username fullName email")
      .populate("sellerId", "username fullName email")
      .sort(sortKey)
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean(),
    Order.countDocuments(q),
  ]);

  return ok(
    res,
    {
      orders: orders.map((o) => orderService.serializeOrder(o)),
      pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
    },
    "Orders retrieved"
  );
});

exports.getOrder = asyncHandler(async (req, res) => {
  const order = await orderService.getOrderById({
    orderId: req.params.orderId,
    user: req.authUser,
  });
  return ok(res, { order: await orderService.serializeWithTimeline(order) }, "Order retrieved");
});

exports.resolveCancellation = asyncHandler(async (req, res) => {
  const order = await orderService.getOrderById({
    orderId: req.params.orderId,
    user: req.authUser,
  });
  const { approve, resolution } = req.body;
  const updated = await orderService.resolveCancellation({
    order,
    admin: req.authUser,
    approve: approve === true || approve === "true",
    resolution,
  });
  return ok(res, { order: orderService.serializeOrder(updated) }, "Cancellation resolved");
});

exports.resolveDispute = asyncHandler(async (req, res) => {
  const order = await orderService.getOrderById({
    orderId: req.params.orderId,
    user: req.authUser,
  });
  const { resolution, notes } = req.body;
  const updated = await orderService.resolveDispute({
    order,
    admin: req.authUser,
    resolution,
    notes,
  });
  return ok(res, { order: orderService.serializeOrder(updated) }, "Dispute resolved");
});

exports.runAutoComplete = asyncHandler(async (req, res) => {
  const completed = await orderService.autoCompleteDeliveredOrders();
  return ok(res, { completed }, "Auto-completion job finished");
});

exports.runReconciliation = asyncHandler(async (req, res) => {
  const cancelled = await orderService.cancelStalePendingOrders();
  return ok(res, { cancelled }, "Payment reconciliation job finished");
});

exports.manualRelease = asyncHandler(async (req, res) => {
  const order = await orderService.getOrderById({
    orderId: req.params.orderId,
    user: req.authUser,
  });
  if (order.status !== "COMPLETED") {
    throw new AppError("Only completed orders can release earnings", 409, "INVALID_ORDER_STATUS");
  }
  await paymentService.releaseEarnings(order);
  return ok(res, null, "Earnings released");
});

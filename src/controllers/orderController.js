const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/apiResponse");
const orderService = require("../services/order.service");
const paymentService = require("../services/payment.service");
const fileService = require("../services/file.service");
const eventService = require("../services/orderEvent.service");
const config = require("../config/orderConfig");
const AppError = require("../utils/AppError");

/**
 * Order controller — thin. All business logic lives in services.
 */

/* ------------------------------------------------------------------ */
/* Checkout preview (stateless)                                        */
/* ------------------------------------------------------------------ */
exports.previewCheckout = asyncHandler(async (req, res) => {
  const { gigId, packageId, extraIds } = req.body;
  const preview = await orderService.previewCheckout({
    buyer: req.authUser,
    gigId,
    packageId,
    extraIds,
  });
  return ok(res, preview, "Checkout preview generated");
});

/* ------------------------------------------------------------------ */
/* Shared: place order + create payment intent                         */
/* ------------------------------------------------------------------ */
const placeOrderWithPayment = async (req, { autoConfirm }) => {
  const { gigId, packageId, extraIds, projectDescription, requirements, attachments, idempotencyKey, paymentMethod } = req.body;

  const { order, duplicate } = await orderService.placeOrder({
    buyer: req.authUser,
    gigId,
    packageId,
    extraIds,
    projectDescription,
    requirements,
    attachments,
    idempotencyKey,
  });

  let payment = null;
  let intent = null;
  let clientSecret = null;
  let devWebhook = null;

  const pendingPayment = await paymentService.getProvider();

  if (order.payment?.providerPaymentId) {
    // Existing order already has a payment intent — reuse it.
    intent = { providerPaymentId: order.payment.providerPaymentId };
    payment = { _id: order.payment.providerPaymentId };
  } else {
    const created = await paymentService.createPayment({
      order,
      buyer: req.authUser,
      method: paymentMethod || "wallet",
      idempotencyKey,
    });
    payment = created.payment;
    intent = created.intent;
    clientSecret = created.clientSecret;

    if (!autoConfirm && pendingPayment.providerName === "mock") {
      const payload = pendingPayment.buildWebhookPayload(payment, order);
      devWebhook = { raw: payload.raw, signature: payload.signature };
    }
  }

  let resultOrder = order;
  if (autoConfirm && config.mockAutoConfirm) {
    if (!order.payment?.providerPaymentId) {
      const out = await paymentService.autoConfirm(payment, order);
      resultOrder = out.order;
    } else {
      resultOrder = await orderService.activateOrder(order._id, {
        paymentMethod: order.payment.method,
        provider: order.payment.provider,
        providerPaymentId: order.payment.providerPaymentId,
      });
    }
  }

  return { order: resultOrder, duplicate, payment, intent, clientSecret, devWebhook };
};

/**
 * POST /api/orders/create-payment
 * Creates the pending order + payment intent (no auto-confirmation).
 */
exports.createPayment = asyncHandler(async (req, res) => {
  const result = await placeOrderWithPayment(req, { autoConfirm: false });
  return created(res, result, "Payment intent created");
});

/**
 * POST /api/orders
 * Places the order; in dev (mock auto-confirm) the order is activated after
 * the provider's signed confirmation is processed through the webhook path.
 */
exports.createOrder = asyncHandler(async (req, res) => {
  const result = await placeOrderWithPayment(req, { autoConfirm: true });
  return created(res, result, result.order.status === "PENDING_PAYMENT"
    ? "Order placed — complete your payment"
    : "Order created successfully");
});

/* ------------------------------------------------------------------ */
/* Listing / detail                                                    */
/* ------------------------------------------------------------------ */
exports.getOrders = asyncHandler(async (req, res) => {
  const { filter, sort, page, limit } = req.query;
  const result = await orderService.getOrders({
    user: req.authUser,
    filter,
    sort,
    page,
    limit,
  });
  return ok(res, result.orders, "Orders retrieved", 200);
});

exports.getOrderById = asyncHandler(async (req, res) => {
  const order = await orderService.getOrderById({
    orderId: req.params.orderId,
    user: req.authUser,
  });
  const serialized = await orderService.serializeWithTimeline(order);
  return ok(res, { order: serialized }, "Order retrieved");
});

exports.getOrderByNumber = asyncHandler(async (req, res) => {
  const order = await orderService.getOrderByNumber({
    orderNumber: req.params.orderNumber,
    user: req.authUser,
  });
  const serialized = await orderService.serializeWithTimeline(order);
  return ok(res, { order: serialized }, "Order retrieved");
});

/* ------------------------------------------------------------------ */
/* Requirements                                                        */
/* ------------------------------------------------------------------ */
exports.submitRequirements = asyncHandler(async (req, res) => {
  const order = await orderService.getOrderById({
    orderId: req.params.orderId,
    user: req.authUser,
  });
  if (String(order.buyerId._id || order.buyerId) !== String(req.authUser._id)) {
    throw new AppError("Only the buyer can submit requirements", 403, "ORDER_ACCESS_DENIED");
  }
  const updated = await orderService.submitRequirements({
    order,
    buyer: req.authUser,
    projectDescription: req.body.projectDescription,
    requirements: req.body.requirements,
    attachments: req.body.attachments,
  });
  return ok(res, { order: orderService.serializeOrder(updated) }, "Requirements submitted");
});

/* ------------------------------------------------------------------ */
/* Delivery                                                            */
/* ------------------------------------------------------------------ */
exports.submitDelivery = asyncHandler(async (req, res) => {
  const order = await orderService.getOrderById({
    orderId: req.params.orderId,
    user: req.authUser,
  });
  if (String(order.sellerId._id || order.sellerId) !== String(req.authUser._id)) {
    throw new AppError("Only the seller can submit a delivery", 403, "ORDER_ACCESS_DENIED");
  }
  const updated = await orderService.submitDelivery({
    order,
    seller: req.authUser,
    message: req.body.message,
    files: req.body.files,
    links: req.body.links,
    notes: req.body.notes,
  });
  return ok(res, { order: orderService.serializeOrder(updated) }, "Delivery submitted");
});

/* ------------------------------------------------------------------ */
/* Revision                                                            */
/* ------------------------------------------------------------------ */
exports.requestRevision = asyncHandler(async (req, res) => {
  const order = await orderService.getOrderById({
    orderId: req.params.orderId,
    user: req.authUser,
  });
  if (String(order.buyerId._id || order.buyerId) !== String(req.authUser._id)) {
    throw new AppError("Only the buyer can request a revision", 403, "ORDER_ACCESS_DENIED");
  }
  const updated = await orderService.requestRevision({
    order,
    buyer: req.authUser,
    message: req.body.message,
    attachments: req.body.attachments,
  });
  return ok(res, { order: orderService.serializeOrder(updated) }, "Revision requested");
});

/* ------------------------------------------------------------------ */
/* Accept delivery                                                     */
/* ------------------------------------------------------------------ */
exports.acceptDelivery = asyncHandler(async (req, res) => {
  const order = await orderService.getOrderById({
    orderId: req.params.orderId,
    user: req.authUser,
  });
  if (String(order.buyerId._id || order.buyerId) !== String(req.authUser._id)) {
    throw new AppError("Only the buyer can accept a delivery", 403, "ORDER_ACCESS_DENIED");
  }
  const updated = await orderService.acceptDelivery({
    order,
    buyer: req.authUser,
    paymentService,
  });
  return ok(res, { order: orderService.serializeOrder(updated) }, "Delivery accepted — order completed");
});

/* ------------------------------------------------------------------ */
/* Cancellation                                                        */
/* ------------------------------------------------------------------ */
exports.requestCancellation = asyncHandler(async (req, res) => {
  const order = await orderService.getOrderById({
    orderId: req.params.orderId,
    user: req.authUser,
  });
  const isBuyer = String(order.buyerId._id || order.buyerId) === String(req.authUser._id);
  const isSeller = String(order.sellerId._id || order.sellerId) === String(req.authUser._id);
  if (!isBuyer && !isSeller) {
    throw new AppError("You are not part of this order", 403, "ORDER_ACCESS_DENIED");
  }
  const updated = await orderService.requestCancellation({
    order,
    actor: req.authUser,
    actorRole: isBuyer ? "buyer" : "seller",
    reason: req.body.reason,
  });
  return ok(res, { order: orderService.serializeOrder(updated) }, "Cancellation requested");
});

/* ------------------------------------------------------------------ */
/* Dispute                                                             */
/* ------------------------------------------------------------------ */
exports.requestDispute = asyncHandler(async (req, res) => {
  const order = await orderService.getOrderById({
    orderId: req.params.orderId,
    user: req.authUser,
  });
  const isBuyer = String(order.buyerId._id || order.buyerId) === String(req.authUser._id);
  const isSeller = String(order.sellerId._id || order.sellerId) === String(req.authUser._id);
  if (!isBuyer && !isSeller) {
    throw new AppError("You are not part of this order", 403, "ORDER_ACCESS_DENIED");
  }
  const updated = await orderService.requestDispute({
    order,
    actor: req.authUser,
    actorRole: isBuyer ? "buyer" : "seller",
    reason: req.body.reason,
  });
  return ok(res, { order: orderService.serializeOrder(updated) }, "Dispute opened");
});

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

/**
 * POST /api/orders/upload — upload order/delivery files (Cloudinary).
 * Any authenticated user may upload; metadata is bound to orders on submit.
 */
exports.uploadFiles = asyncHandler(async (req, res) => {
  if (!req.files || req.files.length === 0) {
    throw new AppError("No files were uploaded", 400, "INVALID_FILE");
  }
  if (req.files.length > config.maxAttachments) {
    throw new AppError("Too many files", 400, "INVALID_FILE");
  }
  const files = await fileService.uploadOrderFiles(req.files);
  return created(res, { files }, "Files uploaded");
});

/**
 * GET /api/orders/:orderId/files — list files attached to an order.
 */
exports.getOrderFiles = asyncHandler(async (req, res) => {
  const order = await orderService.getOrderById({
    orderId: req.params.orderId,
    user: req.authUser,
  });
  const files = {
    attachments: order.attachments || [],
    requirements: (order.buyerRequirements || []).reduce((acc, r) => {
      if (Array.isArray(r.files) && r.files.length > 0) acc.push(...r.files);
      return acc;
    }, []),
  };
  return ok(res, files, "Order files retrieved");
});

/* ------------------------------------------------------------------ */
/* Timeline                                                            */
/* ------------------------------------------------------------------ */
exports.getTimeline = asyncHandler(async (req, res) => {
  const order = await orderService.getOrderById({
    orderId: req.params.orderId,
    user: req.authUser,
  });
  const timeline = await eventService.getTimeline(order._id);
  return ok(res, { timeline }, "Order timeline retrieved");
});

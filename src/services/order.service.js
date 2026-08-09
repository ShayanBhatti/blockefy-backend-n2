const Gig = require("../models/Gig");
const User = require("../models/User");
const Order = require("../models/Order");
const OrderCounter = require("../models/OrderCounter");
const Delivery = require("../models/Delivery");
const Revision = require("../models/Revision");
const Cancellation = require("../models/Cancellation");
const Dispute = require("../models/Dispute");
const { generateOrderNumber } = require("./orderNumber.service");
const pricingService = require("./orderPricing.service");
const requirementService = require("./orderRequirement.service");
const stateService = require("./orderState.service");
const eventService = require("./orderEvent.service");
const notificationService = require("./notification.service");
const { audit } = require("./audit.service");
const config = require("../config/orderConfig");
const {
  ORDER_STATUS,
  ORDER_EVENT_TYPES,
  PAYMENT_STATUS,
  REVISION_LIMIT_UNLIMITED,
} = require("../constants/order.constants");
const AppError = require("../utils/AppError");
const { sanitizeText, requireNonEmpty } = require("../utils/sanitize");

const sanitizeRequired = (value, max, field) => {
  try {
    return requireNonEmpty(value, { max, field });
  } catch (e) {
    throw new AppError(e.message, 400, "VALIDATION_ERROR");
  }
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const requireAccess = async (order, user) => {
  if (!order) throw new AppError("Order not found", 404, "ORDER_NOT_FOUND");
  const allowed = await Order.isAccessibleBy(order, user);
  if (!allowed) {
    throw new AppError("You are not authorized to access this order", 403, "ORDER_ACCESS_DENIED");
  }
};

const hasCompleteRequirements = (order) => {
  if (!order.projectDescription || order.projectDescription.trim().length === 0) return false;
  const requiredQuestions = (order.buyerRequirements || []).filter((r) => r.required);
  if (requiredQuestions.length === 0) return true;
  return requiredQuestions.every((r) => {
    const a = r.answer;
    if (a === undefined || a === null) return false;
    if (typeof a === "string") return a.trim().length > 0;
    if (Array.isArray(a)) return a.length > 0;
    return false;
  });
};

const nextSequence = async (key) => OrderCounter.nextSequence(key);

const validateGigForOrder = async ({ buyerId, gigId, packageId, extraIds }) => {
  const gig = await Gig.findById(gigId);
  if (!gig) throw new AppError("Gig not found", 404, "GIG_NOT_AVAILABLE");
  if (gig.status !== "posted") throw new AppError("This gig is not available for ordering", 409, "GIG_NOT_AVAILABLE");

  const seller = await User.findById(gig.userId);
  if (!seller || seller.isSuspended) {
    throw new AppError("This gig is not available for ordering", 409, "GIG_NOT_AVAILABLE");
  }
  if (String(gig.userId) === String(buyerId)) {
    throw new AppError("You cannot order your own gig", 409, "CANNOT_ORDER_OWN_GIG");
  }

  const pkg = Gig.resolvePackage(gig, packageId);
  if (!pkg) throw new AppError("Selected package is not available", 400, "INVALID_PACKAGE");

  const extras = Gig.resolveExtras(gig, extraIds || []);

  return { gig, seller, pkg, extras };
};

const buildOrderData = ({ gig, seller, pkg, extras, projectDescription, buyerRequirements, attachments, pricing, deliveryDays }) => {
  return {
    buyerId: null, // set by caller
    sellerId: seller._id,
    gigId: gig._id,
    projectTitle: gig.title || "Untitled gig",
    projectDescription,
    packageSnapshot: {
      packageId: pkg.packageId,
      name: pkg.name,
      description: pkg.description,
      price: pkg.price,
      deliveryDays: pkg.deliveryDays,
      revisions: pkg.revisions,
      features: pkg.features || [],
    },
    extrasSnapshot: extras.map((e) => ({
      extraId: e.extraId,
      name: e.name,
      description: e.description,
      price: e.price,
      deliveryDays: e.deliveryDays,
    })),
    buyerRequirements,
    attachments,
    pricing,
    delivery: { days: deliveryDays },
    revisions: {
      allowed: pkg.revisions === -1 ? REVISION_LIMIT_UNLIMITED : pkg.revisions,
      unlimited: pkg.revisions === -1,
    },
    status: ORDER_STATUS.PENDING_PAYMENT,
    payment: { status: PAYMENT_STATUS.PENDING },
  };
};

/* ------------------------------------------------------------------ */
/* Checkout preview (stateless)                                        */
/* ------------------------------------------------------------------ */

const previewCheckout = async ({ buyer, gigId, packageId, extraIds }) => {
  const { gig, seller, pkg, extras } = await validateGigForOrder({
    buyerId: buyer._id,
    gigId,
    packageId,
    extraIds,
  });

  const pricing = pricingService.calculateOrderPricing({
    pkg,
    extras,
    currency: config.currency,
  });
  const deliveryDays = pricingService.calculateDeliveryDays(pkg, extras);
  const dueAt = pricingService.calculateDueAt(new Date(), deliveryDays);

  return {
    gig: {
      id: gig._id,
      title: gig.title,
      sellerId: gig.userId,
    },
    seller: {
      id: seller._id,
      username: seller.username,
      fullName: seller.fullName,
    },
    package: pkg,
    extras,
    pricing,
    delivery: {
      days: deliveryDays,
      estimatedDueAt: dueAt,
    },
    requirements: (gig.requirements || [])
      .filter((r) => r.isActive !== false)
      .map((r) => ({
        questionId: r._id,
        question: r.question,
        type: r.type,
        required: r.required,
        options: r.options || [],
      })),
  };
};

/* ------------------------------------------------------------------ */
/* Place order (pending payment) — idempotent                          */
/* ------------------------------------------------------------------ */

const placeOrder = async ({
  buyer,
  gigId,
  packageId,
  extraIds,
  projectDescription,
  requirements,
  attachments,
  idempotencyKey,
}) => {
  const { gig, seller, pkg, extras } = await validateGigForOrder({
    buyerId: buyer._id,
    gigId,
    packageId,
    extraIds,
  });

  // Validate all buyer content BEFORE touching the database.
  const sanitizedDescription = requirementService.validateProjectDescription(projectDescription);
  const { snapshot: buyerRequirements } = requirementService.validateRequirements(
    gig.requirements || [],
    requirements
  );
  const sanitizedAttachments = requirementService.validateAttachments(attachments);

  const pricing = pricingService.calculateOrderPricing({
    pkg,
    extras,
    currency: config.currency,
  });
  const deliveryDays = pricingService.calculateDeliveryDays(pkg, extras);

  // Idempotency: reusing the same key returns the existing order.
  if (idempotencyKey) {
    const existing = await Order.findOne({ "payment.idempotencyKey": idempotencyKey }).lean();
    if (existing) return { order: existing, duplicate: true };
  }

  const orderData = buildOrderData({
    gig,
    seller,
    pkg,
    extras,
    projectDescription: sanitizedDescription,
    buyerRequirements,
    attachments: sanitizedAttachments,
    pricing,
    deliveryDays,
  });
  orderData.buyerId = buyer._id;

  try {
    const orderNumber = await generateOrderNumber();
    const order = await Order.create({ ...orderData, orderNumber });
    if (idempotencyKey) {
      order.payment.idempotencyKey = idempotencyKey;
      await order.save();
    }
    await eventService.pushEvent({
      orderId: order._id,
      actor: buyer._id,
      actorRole: "buyer",
      type: ORDER_EVENT_TYPES.ORDER_CREATED,
      fromStatus: null,
      toStatus: ORDER_STATUS.PENDING_PAYMENT,
    });
    await notificationService.notify.orderCreated(buyer._id, order._id, order.orderNumber);
    audit.orderCreated({ orderId: order._id.toString(), orderNumber: order.orderNumber });
    return { order, duplicate: false };
  } catch (error) {
    // Duplicate idempotency key (concurrent request) → return existing order.
    if (error.code === 11000 && idempotencyKey) {
      const existing = await Order.findOne({ "payment.idempotencyKey": idempotencyKey }).lean();
      if (existing) return { order: existing, duplicate: true };
    }
    throw error;
  }
};

/* ------------------------------------------------------------------ */
/* Activate order after verified payment                               */
/* ------------------------------------------------------------------ */

const activateOrder = async (orderId, { paymentMethod, provider, providerPaymentId }) => {
  const order = await Order.findById(orderId);
  if (!order) throw new AppError("Order not found", 404, "ORDER_NOT_FOUND");
  if (order.status !== ORDER_STATUS.PENDING_PAYMENT) {
    // Already activated (webhook retry / duplicate processing) — idempotent.
    return order;
  }

  const requirementsComplete = hasCompleteRequirements(order);
  const targetStatus = requirementsComplete
    ? ORDER_STATUS.IN_PROGRESS
    : ORDER_STATUS.REQUIREMENTS_NEEDED;

  const now = new Date();
  const update = {
    $set: {
      status: targetStatus,
      "payment.status": PAYMENT_STATUS.CONFIRMED,
      "payment.method": paymentMethod || order.payment.method || "wallet",
      "payment.provider": provider || order.payment.provider || config.paymentProvider,
      "payment.providerPaymentId": providerPaymentId || order.payment.providerPaymentId,
      "payment.paidAt": now,
    },
  };

  if (targetStatus === ORDER_STATUS.IN_PROGRESS) {
    update.$set["delivery.startedAt"] = now;
    update.$set["delivery.days"] = order.delivery.days;
    update.$set["delivery.dueAt"] = pricingService.calculateDueAt(now, order.delivery.days);
  }

  const activated = await Order.findOneAndUpdate(
    { _id: orderId, status: ORDER_STATUS.PENDING_PAYMENT },
    update,
    { new: true }
  );

  const result = activated || order;

  await eventService.pushEvent({
    orderId: result._id,
    actorRole: "system",
    type: ORDER_EVENT_TYPES.PAYMENT_CONFIRMED,
    fromStatus: ORDER_STATUS.PENDING_PAYMENT,
    toStatus: result.status,
  });

  if (result.status === ORDER_STATUS.IN_PROGRESS) {
    await eventService.pushEvent({
      orderId: result._id,
      actorRole: "system",
      type: ORDER_EVENT_TYPES.ORDER_STARTED,
      fromStatus: null,
      toStatus: ORDER_STATUS.IN_PROGRESS,
    });
  }

  await notificationService.notify.paymentConfirmed(result.buyerId, result._id);
  await notificationService.notify.newOrderToSeller(result.sellerId, result._id, result.orderNumber);
  audit.paymentConfirmed({
    orderId: result._id.toString(),
    orderNumber: result.orderNumber,
    status: result.status,
  });

  return result;
};

/* ------------------------------------------------------------------ */
/* Requirements submission                                             */
/* ------------------------------------------------------------------ */

const submitRequirements = async ({ order, buyer, projectDescription, requirements, attachments }) => {
  stateService.assertTransition(order.status, ORDER_STATUS.IN_PROGRESS);

  // Only allow while the order is waiting for requirements.
  if (![ORDER_STATUS.PAID, ORDER_STATUS.REQUIREMENTS_NEEDED].includes(order.status)) {
    throw new AppError(
      `Requirements can only be submitted while the order is in ${ORDER_STATUS.REQUIREMENTS_NEEDED}`,
      409,
      "INVALID_ORDER_STATUS"
    );
  }

  const gig = await Gig.findById(order.gigId);
  const gigRequirements = gig ? gig.requirements : [];
  const sanitizedDescription = requirementService.validateProjectDescription(projectDescription);
  const { snapshot: buyerRequirements } = requirementService.validateRequirements(gigRequirements, requirements);
  const sanitizedAttachments = requirementService.validateAttachments(attachments);

  const now = new Date();
  const updated = await Order.findOneAndUpdate(
    { _id: order._id, status: { $in: [ORDER_STATUS.PAID, ORDER_STATUS.REQUIREMENTS_NEEDED] } },
    {
      $set: {
        projectDescription: sanitizedDescription,
        buyerRequirements,
        attachments: sanitizedAttachments,
        status: ORDER_STATUS.IN_PROGRESS,
        "delivery.startedAt": now,
        "delivery.dueAt": pricingService.calculateDueAt(now, order.delivery.days),
      },
    },
    { new: true }
  );

  if (!updated) throw new AppError("Order status changed; please refresh", 409, "INVALID_ORDER_STATUS");

  await eventService.pushEvent({
    orderId: updated._id,
    actor: buyer._id,
    actorRole: "buyer",
    type: ORDER_EVENT_TYPES.REQUIREMENTS_SUBMITTED,
    fromStatus: order.status,
    toStatus: ORDER_STATUS.IN_PROGRESS,
  });
  await eventService.pushEvent({
    orderId: updated._id,
    actor: buyer._id,
    actorRole: "buyer",
    type: ORDER_EVENT_TYPES.ORDER_STARTED,
    fromStatus: null,
    toStatus: ORDER_STATUS.IN_PROGRESS,
  });
  await notificationService.notify.requirementsSubmitted(updated.sellerId, updated._id);

  return updated;
};

/* ------------------------------------------------------------------ */
/* Delivery submission                                                 */
/* ------------------------------------------------------------------ */

const submitDelivery = async ({ order, seller, message, files, links, notes }) => {
  if (![ORDER_STATUS.IN_PROGRESS, ORDER_STATUS.REVISION_REQUESTED].includes(order.status)) {
    throw new AppError(
      "Delivery can only be submitted while the order is in progress",
      409,
      "DELIVERY_NOT_ALLOWED"
    );
  }

  const sanitizedMessage = message && message.trim().length > 0
    ? sanitizeText(message, { max: config.maxDeliveryMessageLength, field: "Delivery message" })
    : null;
  const sanitizedLinks = Array.isArray(links)
    ? links
        .filter((l) => l && l.url)
        .map((l) => ({ label: String(l.label || "").slice(0, 120), url: String(l.url).slice(0, 2048) }))
        .slice(0, 5)
    : [];
  if (sanitizedLinks.some((l) => !/^https?:\/\//i.test(l.url))) {
    throw new AppError("Delivery links must be valid http(s) URLs", 400, "VALIDATION_ERROR");
  }
  const sanitizedFiles = (files || []).map(requirementService.validateFileMetadata);

  const deliveryNumber = await nextSequence(`delivery-${order._id}`);
  const delivery = await Delivery.create({
    order: order._id,
    seller: seller._id,
    deliveryNumber,
    message: sanitizedMessage,
    files: sanitizedFiles,
    links: sanitizedLinks,
    notes: notes ? String(notes).slice(0, 2000) : null,
  });

  const now = new Date();
  const reviewPeriodEndsAt = new Date(now.getTime() + config.orderReviewPeriodHours * 60 * 60 * 1000);

  // IN_PROGRESS or REVISION_REQUESTED → DELIVERED (atomic, race-safe).
  const updated = await Order.findOneAndUpdate(
    {
      _id: order._id,
      status: { $in: [ORDER_STATUS.IN_PROGRESS, ORDER_STATUS.REVISION_REQUESTED] },
    },
    {
      $set: {
        status: ORDER_STATUS.DELIVERED,
        currentDelivery: delivery._id,
        "delivery.deliveredAt": now,
        "delivery.reviewPeriodEndsAt": reviewPeriodEndsAt,
        "delivery.autoCompletedAt": null,
      },
    },
    { new: true }
  );

  if (!updated) {
    // Compensate the delivery record if the status update failed.
    await Delivery.deleteOne({ _id: delivery._id });
    throw new AppError("Order status changed; please refresh", 409, "INVALID_ORDER_STATUS");
  }

  const eventType =
    order.status === ORDER_STATUS.REVISION_REQUESTED
      ? ORDER_EVENT_TYPES.DELIVERY_RESUBMITTED
      : ORDER_EVENT_TYPES.DELIVERY_SUBMITTED;
  await eventService.pushEvent({
    orderId: updated._id,
    actor: seller._id,
    actorRole: "seller",
    type: eventType,
    fromStatus: order.status,
    toStatus: ORDER_STATUS.DELIVERED,
    metadata: { deliveryNumber },
  });
  await notificationService.notify.deliverySubmitted(updated.buyerId, updated._id);
  audit.deliverySubmitted({
    orderId: updated._id.toString(),
    deliveryNumber,
    sellerId: seller._id.toString(),
  });

  return updated;
};

/* ------------------------------------------------------------------ */
/* Revision request                                                    */
/* ------------------------------------------------------------------ */

const requestRevision = async ({ order, buyer, message, attachments }) => {
  if (order.status !== ORDER_STATUS.DELIVERED) {
    throw new AppError("Revision can only be requested on a delivered order", 409, "INVALID_ORDER_STATUS");
  }

  const { allowed, used, unlimited } = order.revisions;
  if (!unlimited && used >= allowed) {
    throw new AppError("Revision limit reached", 409, "REVISION_LIMIT_REACHED");
  }

  const sanitizedMessage = sanitizeRequired(message, config.maxRevisionMessageLength, "Revision message");
  const sanitizedAttachments = (attachments || []).map(requirementService.validateFileMetadata);

  const revisionNumber = await nextSequence(`revision-${order._id}`);

  // Atomic: only DELIVERED orders may move; revision counter increments once.
  const updated = await Order.findOneAndUpdate(
    {
      _id: order._id,
      status: ORDER_STATUS.DELIVERED,
      $expr: {
        $or: [
          { $eq: ["$revisions.unlimited", true] },
          { $lt: ["$revisions.used", "$revisions.allowed"] },
        ],
      },
    },
    {
      $set: { status: ORDER_STATUS.REVISION_REQUESTED, "delivery.reviewPeriodEndsAt": null },
      $inc: { "revisions.used": 1 },
    },
    { new: true }
  );

  if (!updated) {
    throw new AppError("Revision could not be requested; the order may have been accepted or the revision limit reached", 409, "REVISION_LIMIT_REACHED");
  }

  await Revision.create({
    order: order._id,
    requestedBy: buyer._id,
    revisionNumber,
    delivery: order.currentDelivery,
    message: sanitizedMessage,
    attachments: sanitizedAttachments,
    status: "requested",
  });

  await eventService.pushEvent({
    orderId: updated._id,
    actor: buyer._id,
    actorRole: "buyer",
    type: ORDER_EVENT_TYPES.REVISION_REQUESTED,
    fromStatus: ORDER_STATUS.DELIVERED,
    toStatus: ORDER_STATUS.REVISION_REQUESTED,
    metadata: { revisionNumber },
  });
  await notificationService.notify.revisionRequested(updated.sellerId, updated._id);
  audit.revisionRequested({
    orderId: updated._id.toString(),
    revisionNumber,
    buyerId: buyer._id.toString(),
    used: updated.revisions.used,
  });

  return updated;
};

/* ------------------------------------------------------------------ */
/* Accept delivery (completion)                                        */
/* ------------------------------------------------------------------ */

const acceptDelivery = async ({ order, buyer, paymentService }) => {
  if (order.status !== ORDER_STATUS.DELIVERED) {
    throw new AppError("Only a delivered order can be accepted", 409, "INVALID_ORDER_STATUS");
  }

  const now = new Date();
  const updated = await Order.findOneAndUpdate(
    { _id: order._id, status: ORDER_STATUS.DELIVERED },
    {
      $set: {
        status: ORDER_STATUS.COMPLETED,
        completedAt: now,
        acceptedAt: now,
        "delivery.reviewPeriodEndsAt": null,
      },
    },
    { new: true }
  );

  if (!updated) {
    throw new AppError("Order status changed; please refresh", 409, "ORDER_ALREADY_COMPLETED");
  }

  // Release earnings AFTER the completed transition (idempotent: guarded by
  // the atomic status update above — a duplicate accept cannot pass twice).
  await paymentService.releaseEarnings(updated);

  await eventService.pushEvent({
    orderId: updated._id,
    actor: buyer._id,
    actorRole: "buyer",
    type: ORDER_EVENT_TYPES.ORDER_COMPLETED,
    fromStatus: ORDER_STATUS.DELIVERED,
    toStatus: ORDER_STATUS.COMPLETED,
  });
  await notificationService.notify.orderCompletedToSeller(updated.sellerId, updated._id, updated.orderNumber);
  await notificationService.notify.orderCompletedToBuyer(updated.buyerId, updated._id, updated.orderNumber);
  audit.orderCompleted({ orderId: updated._id.toString(), orderNumber: updated.orderNumber });

  return updated;
};

/* ------------------------------------------------------------------ */
/* Cancellation                                                        */
/* ------------------------------------------------------------------ */

const canRequestCancellation = (order) => {
  const allowed = [
    ORDER_STATUS.PAID,
    ORDER_STATUS.REQUIREMENTS_NEEDED,
    ORDER_STATUS.IN_PROGRESS,
    ORDER_STATUS.DELIVERED,
    ORDER_STATUS.REVISION_REQUESTED,
  ];
  return allowed.includes(order.status);
};

const requestCancellation = async ({ order, actor, actorRole, reason }) => {
  if (!canRequestCancellation(order)) {
    throw new AppError("Cancellation is not allowed in the current order status", 409, "INVALID_ORDER_STATUS");
  }

  const sanitizedReason = sanitizeRequired(reason, config.maxCancellationReasonLength, "Cancellation reason");

  const cancellation = await Cancellation.create({
    order: order._id,
    requestedBy: actor._id,
    requestedByRole: actorRole,
    reason: sanitizedReason,
    fromStatus: order.status,
    status: "pending",
  });

  const updated = await Order.findOneAndUpdate(
    { _id: order._id, status: order.status },
    { $set: { status: ORDER_STATUS.CANCEL_REQUESTED, cancellation: cancellation._id, cancelReason: sanitizedReason, cancelledBy: actor._id } },
    { new: true }
  );

  if (!updated) throw new AppError("Order status changed; please refresh", 409, "INVALID_ORDER_STATUS");

  await eventService.pushEvent({
    orderId: updated._id,
    actor: actor._id,
    actorRole,
    type: ORDER_EVENT_TYPES.CANCELLATION_REQUESTED,
    fromStatus: order.status,
    toStatus: ORDER_STATUS.CANCEL_REQUESTED,
    metadata: { cancellationId: cancellation._id },
  });
  const otherParty = actorRole === "buyer" ? updated.sellerId : updated.buyerId;
  await notificationService.notify.cancellationRequested(otherParty, updated._id);
  audit.cancellationRequested({ orderId: updated._id.toString(), requestedBy: actor._id.toString(), actorRole });

  return updated;
};

const resolveCancellation = async ({ order, admin, approve, resolution }) => {
  if (!order.cancellation) throw new AppError("No cancellation request found", 404, "NOT_FOUND");
  const cancellation = await Cancellation.findById(order.cancellation);
  if (!cancellation) throw new AppError("Cancellation request not found", 404, "NOT_FOUND");

  if (approve) {
    const now = new Date();
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, status: ORDER_STATUS.CANCEL_REQUESTED },
      {
        $set: { status: ORDER_STATUS.CANCELLED, cancelledAt: now, cancelReason: cancellation.reason },
      },
      { new: true }
    );
    if (!updated) throw new AppError("Order is not pending cancellation", 409, "INVALID_ORDER_STATUS");

    await Cancellation.findByIdAndUpdate(cancellation._id, {
      status: "approved",
      resolution: resolution || "cancelled",
      resolvedBy: admin._id,
      resolvedAt: now,
    });

    // Refund escrow if funds were held.
    await require("./ledger.service").refundEscrow({
      buyerId: updated.buyerId,
      orderId: updated._id,
      amount: updated.pricing.total,
      currency: updated.pricing.currency,
    });

    await eventService.pushEvent({
      orderId: updated._id,
      actor: admin._id,
      actorRole: "admin",
      type: ORDER_EVENT_TYPES.ORDER_CANCELLED,
      fromStatus: ORDER_STATUS.CANCEL_REQUESTED,
      toStatus: ORDER_STATUS.CANCELLED,
    });
    await notificationService.notify.orderCancelled(updated.buyerId, updated._id, updated.orderNumber);
    await notificationService.notify.orderCancelled(updated.sellerId, updated._id, updated.orderNumber);
    audit.orderCancelled({ orderId: updated._id.toString(), orderNumber: updated.orderNumber, approvedBy: admin._id.toString() });
    return updated;
  }

  // Reject → resume from the status before the request.
  const resumeStatus = cancellation.fromStatus || ORDER_STATUS.IN_PROGRESS;
  const updated = await Order.findOneAndUpdate(
    { _id: order._id, status: ORDER_STATUS.CANCEL_REQUESTED },
    { $set: { status: resumeStatus, cancelReason: null, cancelledBy: null } },
    { new: true }
  );
  if (!updated) throw new AppError("Order is not pending cancellation", 409, "INVALID_ORDER_STATUS");

  await Cancellation.findByIdAndUpdate(cancellation._id, {
    status: "rejected",
    resolution: resolution || "rejected",
    resolvedBy: admin._id,
    resolvedAt: new Date(),
  });

  await eventService.pushEvent({
    orderId: updated._id,
    actor: admin._id,
    actorRole: "admin",
    type: ORDER_EVENT_TYPES.ORDER_STARTED,
    fromStatus: ORDER_STATUS.CANCEL_REQUESTED,
    toStatus: updated.status,
    metadata: { note: "Cancellation rejected" },
  });

  return updated;
};

/* ------------------------------------------------------------------ */
/* Disputes                                                            */
/* ------------------------------------------------------------------ */

const requestDispute = async ({ order, actor, actorRole, reason }) => {
  if (!stateService.canDispute(order.status)) {
    throw new AppError("Disputes cannot be opened on this order", 409, "INVALID_ORDER_STATUS");
  }

  const sanitizedReason = sanitizeRequired(reason, config.maxCancellationReasonLength, "Dispute reason");

  const dispute = await Dispute.create({
    order: order._id,
    openedBy: actor._id,
    openedByRole: actorRole,
    reason: sanitizedReason,
    status: "open",
  });

  const updated = await Order.findOneAndUpdate(
    { _id: order._id, status: order.status },
    { $set: { status: ORDER_STATUS.DISPUTED, dispute: dispute._id } },
    { new: true }
  );
  if (!updated) throw new AppError("Order status changed; please refresh", 409, "INVALID_ORDER_STATUS");

  await eventService.pushEvent({
    orderId: updated._id,
    actor: actor._id,
    actorRole,
    type: ORDER_EVENT_TYPES.DISPUTE_OPENED,
    fromStatus: order.status,
    toStatus: ORDER_STATUS.DISPUTED,
    metadata: { disputeId: dispute._id },
  });
  await notificationService.notify.disputeOpened(updated.buyerId, updated._id);
  await notificationService.notify.disputeOpened(updated.sellerId, updated._id);
  audit.disputeOpened({ orderId: updated._id.toString(), openedBy: actor._id.toString() });

  return updated;
};

const resolveDispute = async ({ order, admin, resolution, notes }) => {
  if (!order.dispute) throw new AppError("No dispute found", 404, "NOT_FOUND");

  const now = new Date();

  if (resolution === "refund_buyer" || resolution === "cancelled") {
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, status: ORDER_STATUS.DISPUTED },
      { $set: { status: ORDER_STATUS.CANCELLED, cancelledAt: now } },
      { new: true }
    );
    if (!updated) throw new AppError("Order is not disputed", 409, "INVALID_ORDER_STATUS");
    await require("./ledger.service").refundEscrow({
      buyerId: updated.buyerId,
      orderId: updated._id,
      amount: updated.pricing.total,
      currency: updated.pricing.currency,
    });
  } else if (resolution === "release_seller") {
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, status: ORDER_STATUS.DISPUTED },
      { $set: { status: ORDER_STATUS.COMPLETED, completedAt: now } },
      { new: true }
    );
    if (!updated) throw new AppError("Order is not disputed", 409, "INVALID_ORDER_STATUS");
    await require("./ledger.service").releaseEarnings({
      sellerId: updated.sellerId,
      orderId: updated._id,
      subtotal: updated.pricing.subtotal,
      platformFee: updated.pricing.platformFee,
      currency: updated.pricing.currency,
    });
  } else {
    throw new AppError("Invalid dispute resolution", 400, "VALIDATION_ERROR");
  }

  await Dispute.findByIdAndUpdate(order.dispute, {
    status: "resolved",
    resolution,
    resolutionNotes: notes ? String(notes).slice(0, 2000) : null,
    resolvedBy: admin._id,
    resolvedAt: now,
  });

  const target = resolution === "release_seller" ? ORDER_STATUS.COMPLETED : ORDER_STATUS.CANCELLED;
  await eventService.pushEvent({
    orderId: order._id,
    actor: admin._id,
    actorRole: "admin",
    type: ORDER_EVENT_TYPES.ORDER_CANCELLED,
    fromStatus: ORDER_STATUS.DISPUTED,
    toStatus: target,
    metadata: { resolution },
  });

  return Order.findById(order._id);
};

/* ------------------------------------------------------------------ */
/* Auto-completion job                                                 */
/* ------------------------------------------------------------------ */

const autoCompleteDeliveredOrders = async () => {
  const cutoff = new Date(Date.now() - config.orderReviewPeriodHours * 60 * 60 * 1000);
  const candidates = await Order.find({
    status: ORDER_STATUS.DELIVERED,
    "delivery.reviewPeriodEndsAt": { $lte: new Date() },
    "delivery.deliveredAt": { $lte: cutoff },
  })
    .select("_id")
    .lean();

  let completed = 0;
  for (const c of candidates) {
    try {
      const now = new Date();
      const updated = await Order.findOneAndUpdate(
        { _id: c._id, status: ORDER_STATUS.DELIVERED },
        {
          $set: {
            status: ORDER_STATUS.COMPLETED,
            completedAt: now,
            acceptedAt: now,
            "delivery.reviewPeriodEndsAt": null,
            "delivery.autoCompletedAt": now,
          },
        },
        { new: true }
      );
      if (!updated) continue; // another job instance already completed it

      await require("./payment.service").releaseEarnings(updated);
      await eventService.pushEvent({
        orderId: updated._id,
        actorRole: "system",
        type: ORDER_EVENT_TYPES.ORDER_COMPLETED,
        fromStatus: ORDER_STATUS.DELIVERED,
        toStatus: ORDER_STATUS.COMPLETED,
        metadata: { autoCompleted: true },
      });
      await notificationService.notify.orderCompletedToSeller(updated.sellerId, updated._id, updated.orderNumber);
      await notificationService.notify.orderCompletedToBuyer(updated.buyerId, updated._id, updated.orderNumber);
      completed += 1;
    } catch (error) {
      console.error("Auto-complete failed for order", c._id, error.message);
    }
  }
  return completed;
};

/* ------------------------------------------------------------------ */
/* Payment reconciliation job                                          */
/* ------------------------------------------------------------------ */

const cancelStalePendingOrders = async () => {
  const cutoff = new Date(Date.now() - config.pendingPaymentTtlMinutes * 60 * 1000);
  const stale = await Order.find({
    status: ORDER_STATUS.PENDING_PAYMENT,
    createdAt: { $lte: cutoff },
  })
    .select("_id")
    .lean();

  let cancelled = 0;
  for (const c of stale) {
    try {
      const updated = await Order.findOneAndUpdate(
        { _id: c._id, status: ORDER_STATUS.PENDING_PAYMENT },
        { $set: { status: ORDER_STATUS.CANCELLED, cancelledAt: new Date(), cancelReason: "Payment not completed in time" } },
        { new: true }
      );
      if (!updated) continue;
      await eventService.pushEvent({
        orderId: updated._id,
        actorRole: "system",
        type: ORDER_EVENT_TYPES.ORDER_CANCELLED,
        fromStatus: ORDER_STATUS.PENDING_PAYMENT,
        toStatus: ORDER_STATUS.CANCELLED,
        metadata: { reason: "stale_pending_payment" },
      });
      cancelled += 1;
    } catch (error) {
      console.error("Stale order cancellation failed", c._id, error.message);
    }
  }
  return cancelled;
};

/* ------------------------------------------------------------------ */
/* Querying                                                            */
/* ------------------------------------------------------------------ */

const ORDER_FILTERS = {
  buyer: {
    active: ["PAID", "REQUIREMENTS_NEEDED", "IN_PROGRESS", "DELIVERED", "REVISION_REQUESTED"],
    delivered: ["DELIVERED"],
    completed: ["COMPLETED"],
    cancelled: ["CANCELLED", "CANCEL_REQUESTED"],
    revision_requested: ["REVISION_REQUESTED"],
  },
  seller: {
    new: ["REQUIREMENTS_NEEDED", "PAID"],
    active: ["IN_PROGRESS", "REVISION_REQUESTED"],
    delivered: ["DELIVERED"],
    revision_requested: ["REVISION_REQUESTED"],
    completed: ["COMPLETED"],
    cancelled: ["CANCELLED", "CANCEL_REQUESTED"],
  },
  admin: {
    active: ["PAID", "REQUIREMENTS_NEEDED", "IN_PROGRESS", "DELIVERED", "REVISION_REQUESTED"],
    delivered: ["DELIVERED"],
    completed: ["COMPLETED"],
    cancelled: ["CANCELLED", "CANCEL_REQUESTED"],
    revision_requested: ["REVISION_REQUESTED"],
    disputed: ["DISPUTED"],
    pending_payment: ["PENDING_PAYMENT"],
  },
};

const ORDER_SORTS = {
  createdAt: "createdAt",
  updatedAt: "updatedAt",
  dueAt: "delivery.dueAt",
};

const getOrders = async ({ user, filter, sort, page, limit }) => {
  const query = {};
  if (user.role === "buyer") query.buyerId = user._id;
  else if (user.role === "seller") query.sellerId = user._id;

  const filterMap = ORDER_FILTERS[user.role] || ORDER_FILTERS.admin;
  if (filter) {
    if (!filterMap[filter]) throw new AppError("Invalid order filter", 400, "VALIDATION_ERROR");
    query.status = { $in: filterMap[filter] };
  }

  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(config.maxPageLimit, Math.max(1, Number(limit) || config.defaultPageLimit));
  const skip = (pageNum - 1) * limitNum;

  let sortKey = "-createdAt";
  if (sort) {
    const dir = sort.startsWith("-") ? -1 : 1;
    const field = sort.replace(/^-/, "");
    if (!ORDER_SORTS[field]) throw new AppError("Invalid sort field", 400, "VALIDATION_ERROR");
    sortKey = dir === -1 ? `-${ORDER_SORTS[field]}` : ORDER_SORTS[field];
  }

  const [orders, total] = await Promise.all([
    Order.find(query)
      .populate("gigId", "title gigImage")
      .populate("buyerId", "fullName username profileImage")
      .populate("sellerId", "fullName username profileImage")
      .sort(sortKey)
      .skip(skip)
      .limit(limitNum)
      .lean(),
    Order.countDocuments(query),
  ]);

  return {
    orders: orders.map((o) => serializeOrder(o)),
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.ceil(total / limitNum),
    },
  };
};

const getOrderById = async ({ orderId, user }) => {
  const order = await Order.findById(orderId)
    .populate("gigId", "title gigImage")
    .populate("buyerId", "fullName username profileImage")
    .populate("sellerId", "fullName username profileImage");
  await requireAccess(order, user);
  return order;
};

const getOrderByNumber = async ({ orderNumber, user }) => {
  const order = await Order.findByNumber(orderNumber)
    .populate("gigId", "title gigImage")
    .populate("buyerId", "fullName username profileImage")
    .populate("sellerId", "fullName username profileImage");
  await requireAccess(order, user);
  return order;
};

/* ------------------------------------------------------------------ */
/* Serialization (DTO)                                                 */
/* ------------------------------------------------------------------ */

const serializeOrder = (order) => {
  if (!order) return null;
  const o = order.toObject ? order.toObject() : order;

  const revisionAllowed =
    o.revisions && o.revisions.unlimited ? REVISION_LIMIT_UNLIMITED : o.revisions?.allowed ?? 0;

  return {
    id: o._id,
    orderNumber: o.orderNumber,
    status: o.status,
    gig: {
      id: o.gigId?._id || o.gigId,
      title: o.gigId?.title || null,
      image: o.gigId?.gigImage || null,
    },
    buyer: {
      id: o.buyerId?._id || o.buyerId,
      username: o.buyerId?.username || null,
      fullName: o.buyerId?.fullName || null,
      avatar: o.buyerId?.profileImage?.url || null,
    },
    seller: {
      id: o.sellerId?._id || o.sellerId,
      username: o.sellerId?.username || null,
      fullName: o.sellerId?.fullName || null,
      avatar: o.sellerId?.profileImage?.url || null,
    },
    package: o.packageSnapshot
      ? {
          packageId: o.packageSnapshot.packageId,
          name: o.packageSnapshot.name,
          description: o.packageSnapshot.description,
          price: o.packageSnapshot.price,
          deliveryDays: o.packageSnapshot.deliveryDays,
          revisions: o.packageSnapshot.revisions,
          features: o.packageSnapshot.features,
        }
      : null,
    extras: o.extrasSnapshot || [],
    pricing: o.pricing
      ? {
          currency: o.pricing.currency,
          packagePrice: o.pricing.packagePrice,
          extrasTotal: o.pricing.extrasTotal,
          subtotal: o.pricing.subtotal,
          platformFee: o.pricing.platformFee,
          discount: o.pricing.discount,
          tax: o.pricing.tax,
          total: o.pricing.total,
        }
      : null,
    projectDescription: o.projectDescription,
    requirements: o.buyerRequirements || [],
    attachments: o.attachments || [],
    delivery: {
      days: o.delivery?.days ?? null,
      dueAt: o.delivery?.dueAt ?? null,
      startedAt: o.delivery?.startedAt ?? null,
      deliveredAt: o.delivery?.deliveredAt ?? null,
      reviewPeriodEndsAt: o.delivery?.reviewPeriodEndsAt ?? null,
      isLate: o.isLate,
    },
    revisions: {
      allowed: revisionAllowed,
      used: o.revisions?.used ?? 0,
      unlimited: o.revisions?.unlimited ?? false,
    },
    payment: {
      status: o.payment?.status ?? "pending",
      method: o.payment?.method ?? null,
      provider: o.payment?.provider ?? null,
      paidAt: o.payment?.paidAt ?? null,
    },
    cancellation: o.cancellation ? { id: o.cancellation } : null,
    dispute: o.dispute ? { id: o.dispute } : null,
    completedAt: o.completedAt ?? null,
    cancelledAt: o.cancelledAt ?? null,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
};

const serializeWithTimeline = async (order) => {
  const serialized = serializeOrder(order);
  const orderId = order._id ? order._id : order.id;
  serialized.timeline = await eventService.getTimeline(orderId);
  return serialized;
};

module.exports = {
  previewCheckout,
  placeOrder,
  activateOrder,
  submitRequirements,
  submitDelivery,
  requestRevision,
  acceptDelivery,
  requestCancellation,
  resolveCancellation,
  requestDispute,
  resolveDispute,
  autoCompleteDeliveredOrders,
  cancelStalePendingOrders,
  getOrders,
  getOrderById,
  getOrderByNumber,
  serializeOrder,
  serializeWithTimeline,
  hasCompleteRequirements,
  requireAccess,
};

const express = require("express");
const router = express.Router();
const orderController = require("../controllers/orderController");
const authenticate = require("../middleware/authenticate");
const authorizeRole = require("../middleware/authorizeRole");
const validateObjectId = require("../middleware/validateObjectId");
const validate = require("../middleware/validate");
const { s } = require("../utils/validate");
const { createRateLimiter } = require("../middleware/rateLimiter");
const { uploadOrderFiles } = require("../middleware/uploadOrderFiles");
const { handleUploadError } = require("../middleware/uploadMiddleware");
const config = require("../config/orderConfig");

/**
 * Order routes.
 *
 * Layered middleware pattern:
 *   authenticate → authorizeRole → rate limit → validate → controller
 * Role is ALWAYS derived from the authenticated user, never the body.
 */

const fileMeta = () =>
  s.object({
    name: s.string(),
    url: s.string(),
    publicId: s.string(),
    mimeType: s.string(),
    extension: s.string(),
    size: s.number(),
  });

const requirementsItem = () =>
  s.object({
    questionId: s.required(s.string()),
    answer: s.optional(s.custom(() => true)),
    files: s.optional(s.arrayOf(fileMeta()).max(5)),
  });

const baseOrderSchema = {
  gigId: s.required(s.objectId()),
  packageId: s.required(s.string()),
  extraIds: s.optional(s.arrayOf(s.string()).max(config.maxExtrasPerOrder)),
  projectDescription: s.required(s.string()),
  requirements: s.optional(s.arrayOf(requirementsItem()).max(config.maxRequirementsAnswers)),
  attachments: s.optional(s.arrayOf(fileMeta()).max(config.maxAttachments)),
  idempotencyKey: s.required(s.string()),
  paymentMethod: s.optional(s.enum(["wallet", "card"])),
};

const checkoutPreviewSchema = {
  gigId: s.required(s.objectId()),
  packageId: s.required(s.string()),
  extraIds: s.optional(s.arrayOf(s.string()).max(config.maxExtrasPerOrder)),
};

const requirementsSchema = {
  projectDescription: s.required(s.string()),
  requirements: s.optional(s.arrayOf(requirementsItem()).max(config.maxRequirementsAnswers)),
  attachments: s.optional(s.arrayOf(fileMeta()).max(config.maxAttachments)),
};

const deliverySchema = {
  message: s.optional(s.string().max(config.maxDeliveryMessageLength)),
  files: s.optional(s.arrayOf(fileMeta()).max(config.maxDeliveryFiles)),
  links: s.optional(s.arrayOf(s.object({ label: s.optional(s.string()), url: s.required(s.url()) })).max(5)),
  notes: s.optional(s.string().max(2000)),
};

const revisionSchema = {
  message: s.required(s.string()),
  attachments: s.optional(s.arrayOf(fileMeta()).max(5)),
};

const reasonSchema = {
  reason: s.required(s.string()),
};

const listQuerySchema = {
  filter: s.optional(s.string()),
  sort: s.optional(s.string()),
  page: s.optional(s.integer({ min: 1 })),
  limit: s.optional(s.integer({ min: 1, max: config.maxPageLimit })),
};

// Sensitive-action rate limits (per user).
const strictLimit = createRateLimiter({ windowMs: 60_000, max: 10 });
const paymentLimit = createRateLimiter({ windowMs: 60_000, max: 5 });

/* =============================================== */
/* Checkout & payment                               */
/* =============================================== */

// Stateless checkout preview.
router.post(
  "/checkout-preview",
  authenticate,
  authorizeRole("buyer"),
  strictLimit,
  validate(checkoutPreviewSchema),
  orderController.previewCheckout
);

// Create pending order + payment intent (no auto-confirmation).
router.post(
  "/create-payment",
  authenticate,
  authorizeRole("buyer"),
  paymentLimit,
  validate(baseOrderSchema),
  orderController.createPayment
);

// Place order (auto-confirms in dev mock mode).
router.post(
  "/",
  authenticate,
  authorizeRole("buyer"),
  paymentLimit,
  validate(baseOrderSchema),
  orderController.createOrder
);

// Upload order/delivery files (any authenticated user; ownership checked at submit).
router.post(
  "/upload",
  authenticate,
  strictLimit,
  uploadOrderFiles.array("files", config.maxAttachments),
  handleUploadError,
  orderController.uploadFiles
);

/* =============================================== */
/* Listing & detail                                 */
/* =============================================== */

router.get(
  "/",
  authenticate,
  validate(listQuerySchema, { body: false, params: false, query: true }),
  orderController.getOrders
);

router.get("/number/:orderNumber", authenticate, orderController.getOrderByNumber);

router.get("/:orderId", authenticate, validateObjectId("orderId"), orderController.getOrderById);

router.get("/:orderId/files", authenticate, validateObjectId("orderId"), orderController.getOrderFiles);

router.get("/:orderId/timeline", authenticate, validateObjectId("orderId"), orderController.getTimeline);

/* =============================================== */
/* Action-specific endpoints (no generic PATCH)     */
/* =============================================== */

router.post(
  "/:orderId/requirements",
  authenticate,
  authorizeRole("buyer"),
  strictLimit,
  validateObjectId("orderId"),
  validate(requirementsSchema),
  orderController.submitRequirements
);

router.post(
  "/:orderId/delivery",
  authenticate,
  authorizeRole("seller"),
  strictLimit,
  validateObjectId("orderId"),
  validate(deliverySchema),
  orderController.submitDelivery
);

router.post(
  "/:orderId/revision",
  authenticate,
  authorizeRole("buyer"),
  strictLimit,
  validateObjectId("orderId"),
  validate(revisionSchema),
  orderController.requestRevision
);

router.post(
  "/:orderId/accept",
  authenticate,
  authorizeRole("buyer"),
  strictLimit,
  validateObjectId("orderId"),
  orderController.acceptDelivery
);

router.post(
  "/:orderId/cancel-request",
  authenticate,
  strictLimit,
  validateObjectId("orderId"),
  validate(reasonSchema),
  orderController.requestCancellation
);

router.post(
  "/:orderId/dispute",
  authenticate,
  strictLimit,
  validateObjectId("orderId"),
  validate(reasonSchema),
  orderController.requestDispute
);

module.exports = router;

const express = require("express");
const router = express.Router();
const adminOrderController = require("../controllers/adminOrderController");
const authenticate = require("../middleware/authenticate");
const authorizeRole = require("../middleware/authorizeRole");
const validateObjectId = require("../middleware/validateObjectId");
const validate = require("../middleware/validate");
const { s } = require("../utils/validate");

/**
 * Admin order routes — only for `admin` role users.
 * Never exposed to buyers/sellers.
 */

const resolveCancellationSchema = {
  approve: s.required(s.boolean()),
  resolution: s.optional(s.string()),
};

const resolveDisputeSchema = {
  resolution: s.required(s.enum(["refund_buyer", "release_seller", "cancelled"])),
  notes: s.optional(s.string()),
};

const listQuerySchema = {
  filter: s.optional(s.string()),
  sort: s.optional(s.string()),
  search: s.optional(s.string()),
  page: s.optional(s.integer({ min: 1 })),
  limit: s.optional(s.integer({ min: 1, max: 50 })),
};

router.use(authenticate, authorizeRole("admin"));

router.get("/", validate(listQuerySchema, { body: false, params: false, query: true }), adminOrderController.getAllOrders);
router.get("/:orderId", validateObjectId("orderId"), adminOrderController.getOrder);

router.post(
  "/:orderId/cancellation/resolve",
  validateObjectId("orderId"),
  validate(resolveCancellationSchema),
  adminOrderController.resolveCancellation
);

router.post(
  "/:orderId/dispute/resolve",
  validateObjectId("orderId"),
  validate(resolveDisputeSchema),
  adminOrderController.resolveDispute
);

// Manual job triggers (also run via cron — see src/jobs).
router.post("/jobs/auto-complete", adminOrderController.runAutoComplete);
router.post("/jobs/reconcile-payments", adminOrderController.runReconciliation);
router.post("/:orderId/earnings/release", validateObjectId("orderId"), adminOrderController.manualRelease);

module.exports = router;

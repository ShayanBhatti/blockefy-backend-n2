/**
 * Centralized order-system configuration.
 *
 * Every business rule that affects money, deadlines, revisions or review
 * periods MUST come from here (or from environment variables resolved here).
 * Controllers and services must never hard-code these values.
 *
 * This satisfies the specification rule:
 *   "The exact fee percentage/configuration should come from a centralized
 *    configuration/database/admin setting rather than hard-coded in multiple
 *    controllers."
 */
const config = {
  currency: process.env.ORDER_CURRENCY || "USD",

  /**
   * Platform fee expressed as a percentage of the subtotal.
   * e.g. 10 => 10%.
   */
  platformFeePercent: Number(process.env.PLATFORM_FEE_PERCENT || 10),

  /**
   * Tax rate expressed as a percentage. 0 disables tax.
   */
  taxPercent: Number(process.env.ORDER_TAX_PERCENT || 0),

  /**
   * Maximum allowed length for the buyer project description.
   */
  projectDescriptionMaxLength: 5000,

  /**
   * Validation limits.
   */
  maxExtrasPerOrder: 20,
  maxRequirementsAnswers: 50,
  maxAttachments: 10,
  maxFileSizeBytes: 10 * 1024 * 1024, // 10 MB
  maxDeliveryFiles: 10,
  maxDeliveryMessageLength: 5000,
  maxRevisionMessageLength: 5000,
  maxCancellationReasonLength: 2000,

  /**
   * Delivery / revision rules.
   */
  minimumDeliveryDays: 1,
  maximumDeliveryDays: 120,

  /**
   * A value representing "unlimited" revisions inside the purchased snapshot.
   * Never sent to the client as a raw number; serializers convert it to
   * `unlimited: true`.
   */
  unlimitedRevisions: 999999,

  /**
   * How long a DELIVERED order may wait before it is auto-completed.
   * Centralized here (spec: "Do NOT hard-code this value throughout the code").
   */
  orderReviewPeriodHours: Number(process.env.ORDER_REVIEW_PERIOD_HOURS || 72),

  /**
   * How long a PENDING_PAYMENT order may exist before the reconciliation job
   * cancels it.
   */
  pendingPaymentTtlMinutes: Number(process.env.PENDING_PAYMENT_TTL_MINUTES || 60),

  /**
   * Payment provider. "mock" is a development provider used until a real one
   * (Stripe/... ) is integrated. The order architecture never trusts the
   * frontend: money always flows through the provider + webhook.
   */
  paymentProvider: process.env.PAYMENT_PROVIDER || "mock",

  /**
   * In development, the mock provider can confirm payment immediately after
   * `create-payment` so the frontend can exercise the full flow without a
   * real payment provider. Set to "false" to force the webhook path.
   */
  mockAutoConfirm: String(process.env.PAYMENT_MOCK_AUTO_CONFIRM || "true") === "true",

  /**
   * Shared secret used to sign/verify mock webhook payloads.
   * A real provider uses its own signature verification.
   */
  webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET || "blockefy-dev-webhook-secret-change-me",

  /**
   * Payment methods the mock provider accepts.
   */
  supportedPaymentMethods: ["wallet", "card"],

  /**
   * Pagination caps.
   */
  maxPageLimit: 50,
  defaultPageLimit: 20,

  /**
   * Order statuses that count as "active" for dashboards.
   */
  activeStatuses: ["PAID", "REQUIREMENTS_NEEDED", "IN_PROGRESS", "DELIVERED", "REVISION_REQUESTED"],
};

module.exports = config;

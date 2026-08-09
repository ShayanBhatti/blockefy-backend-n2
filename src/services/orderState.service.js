const { ORDER_STATUS } = require("../constants/order.constants");
const AppError = require("../utils/AppError");

/**
 * Centralized order state machine.
 *
 * Controllers/services must NEVER do `order.status = req.body.status`. Every
 * status change flows through this module. Invalid transitions throw
 * INVALID_ORDER_STATUS.
 *
 * Race-condition safety: callers persist transitions with conditional atomic
 * updates (e.g. findOneAndUpdate with `status: <expectedFrom>`), never blind
 * find+save.
 */

const TRANSITIONS = {
  // Payment confirmed activates the order.
  [ORDER_STATUS.PENDING_PAYMENT]: [
    ORDER_STATUS.PAID,
    ORDER_STATUS.CANCELLED, // reconciliation/refund of stale pending payments
    ORDER_STATUS.DISPUTED,
  ],

  // After payment: requirements may already be complete (IN_PROGRESS) or not.
  [ORDER_STATUS.PAID]: [
    ORDER_STATUS.REQUIREMENTS_NEEDED,
    ORDER_STATUS.IN_PROGRESS,
    ORDER_STATUS.CANCEL_REQUESTED,
    ORDER_STATUS.CANCELLED,
    ORDER_STATUS.DISPUTED,
  ],

  [ORDER_STATUS.REQUIREMENTS_NEEDED]: [
    ORDER_STATUS.IN_PROGRESS,
    ORDER_STATUS.CANCEL_REQUESTED,
    ORDER_STATUS.CANCELLED,
    ORDER_STATUS.DISPUTED,
  ],

  [ORDER_STATUS.IN_PROGRESS]: [
    ORDER_STATUS.DELIVERED,
    ORDER_STATUS.CANCEL_REQUESTED,
    ORDER_STATUS.CANCELLED,
    ORDER_STATUS.DISPUTED,
  ],

  [ORDER_STATUS.DELIVERED]: [
    ORDER_STATUS.COMPLETED,
    ORDER_STATUS.REVISION_REQUESTED,
    ORDER_STATUS.CANCEL_REQUESTED,
    ORDER_STATUS.CANCELLED,
    ORDER_STATUS.DISPUTED,
  ],

  [ORDER_STATUS.REVISION_REQUESTED]: [
    ORDER_STATUS.IN_PROGRESS,
    ORDER_STATUS.CANCEL_REQUESTED,
    ORDER_STATUS.CANCELLED,
    ORDER_STATUS.DISPUTED,
  ],

  [ORDER_STATUS.CANCEL_REQUESTED]: [
    ORDER_STATUS.CANCELLED,
    ORDER_STATUS.IN_PROGRESS, // cancellation rejected -> resume
    ORDER_STATUS.DISPUTED,
  ],

  // Terminal states.
  [ORDER_STATUS.COMPLETED]: [],
  [ORDER_STATUS.CANCELLED]: [],
  [ORDER_STATUS.DISPUTED]: [ORDER_STATUS.CANCELLED, ORDER_STATUS.COMPLETED], // admin resolution
};

const TERMINAL_STATUSES = new Set([
  ORDER_STATUS.COMPLETED,
  ORDER_STATUS.CANCELLED,
]);

/**
 * True when `to` is a legal destination from `from`.
 */
const canTransition = (from, to) => {
  if (!TRANSITIONS[from]) return false;
  return TRANSITIONS[from].includes(to);
};

/**
 * Throw when `from -> to` is not allowed.
 */
const assertTransition = (from, to) => {
  if (to === from) {
    throw new AppError(`Order is already in status ${from}`, 409, "INVALID_ORDER_STATUS");
  }
  if (!canTransition(from, to)) {
    throw new AppError(
      `Cannot transition order from ${from} to ${to}`,
      409,
      "INVALID_ORDER_STATUS"
    );
  }
};

/**
 * Transition any valid status to DISPUTED (spec: ANY_VALID_STATE → DISPUTED).
 */
const canDispute = (from) => {
  return from !== ORDER_STATUS.COMPLETED && from !== ORDER_STATUS.CANCELLED && from !== ORDER_STATUS.DISPUTED;
};

/**
 * True when the order is in an active working state (counts as "active").
 */
const isActiveStatus = (status) =>
  [
    ORDER_STATUS.PAID,
    ORDER_STATUS.REQUIREMENTS_NEEDED,
    ORDER_STATUS.IN_PROGRESS,
    ORDER_STATUS.DELIVERED,
    ORDER_STATUS.REVISION_REQUESTED,
  ].includes(status);

module.exports = {
  TRANSITIONS,
  TERMINAL_STATUSES,
  canTransition,
  assertTransition,
  canDispute,
  isActiveStatus,
};

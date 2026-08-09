const { test } = require("node:test");
const assert = require("node:assert/strict");

const { ORDER_STATUS } = require("../src/constants/order.constants");
const {
  canTransition,
  assertTransition,
  canDispute,
  isActiveStatus,
  TERMINAL_STATUSES,
} = require("../src/services/orderState.service");

const { PAID, REQUIREMENTS_NEEDED, IN_PROGRESS, DELIVERED, REVISION_REQUESTED, COMPLETED, CANCELLED, DISPUTED, PENDING_PAYMENT, CANCEL_REQUESTED } = ORDER_STATUS;

test("valid forward transitions", () => {
  assert.equal(canTransition(PAID, REQUIREMENTS_NEEDED), true);
  assert.equal(canTransition(REQUIREMENTS_NEEDED, IN_PROGRESS), true);
  assert.equal(canTransition(IN_PROGRESS, DELIVERED), true);
  assert.equal(canTransition(DELIVERED, COMPLETED), true);
  assert.equal(canTransition(DELIVERED, REVISION_REQUESTED), true);
  assert.equal(canTransition(REVISION_REQUESTED, IN_PROGRESS), true);
});

test("cancel requested can resolve to cancelled or resume", () => {
  assert.equal(canTransition(CANCEL_REQUESTED, CANCELLED), true);
  assert.equal(canTransition(CANCEL_REQUESTED, IN_PROGRESS), true);
});

test("terminal states allow no further transitions", () => {
  assert.equal(canTransition(COMPLETED, DISPUTED), false);
  assert.equal(canTransition(CANCELLED, IN_PROGRESS), false);
});

test("disputed is admin-resolved only", () => {
  assert.equal(canTransition(DISPUTED, COMPLETED), true);
  assert.equal(canTransition(DISPUTED, CANCELLED), true);
  assert.equal(canTransition(DISPUTED, IN_PROGRESS), false);
});

test("assertTransition throws with stable code", () => {
  assert.throws(() => assertTransition(IN_PROGRESS, COMPLETED), (e) => e.code === "INVALID_ORDER_STATUS");
  assert.throws(() => assertTransition(DELIVERED, DELIVERED), (e) => e.message.includes("already"));
});

test("any active state can escalate to dispute", () => {
  assert.equal(canDispute(IN_PROGRESS), true);
  assert.equal(canDispute(PENDING_PAYMENT), true);
  assert.equal(canDispute(COMPLETED), false);
  assert.equal(canDispute(CANCELLED), false);
  assert.equal(canDispute(DISPUTED), false);
});

test("isActiveStatus covers working states", () => {
  assert.equal(isActiveStatus(IN_PROGRESS), true);
  assert.equal(isActiveStatus(DELIVERED), true);
  assert.equal(isActiveStatus(REVISION_REQUESTED), true);
  assert.equal(isActiveStatus(COMPLETED), false);
  assert.equal(isActiveStatus(PENDING_PAYMENT), false);
});

test("TERMINAL_STATUSES are exactly completed and cancelled", () => {
  assert.deepEqual([...TERMINAL_STATUSES].sort(), [CANCELLED, COMPLETED]);
});

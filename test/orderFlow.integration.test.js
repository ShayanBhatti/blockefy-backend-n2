/**
 * End-to-end order flow test. Requires a live MongoDB and a funded wallet.
 *
 *   $env:TEST_MONGODB_URI="mongodb://127.0.0.1:27017/blockefy_test"
 *   $env:WALLET_DEPOSIT="100"
 *   npm test
 *
 * Skips cleanly when TEST_MONGODB_URI is not set.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const URI = process.env.TEST_MONGODB_URI;
const skip = URI ? false : true;

const User = require("../src/models/User");
const Gig = require("../src/models/Gig");
const Order = require("../src/models/Order");
const Transaction = require("../src/models/Transaction");
const orderService = require("../src/services/order.service");
const paymentService = require("../src/services/payment.service");

let buyer, seller, gig, order;

before(async () => {
  if (skip) return;
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([
    User.deleteMany({}),
    Gig.deleteMany({}),
    Order.deleteMany({}),
    Transaction.deleteMany({}),
    require("../src/models/OrderCounter").deleteMany({}),
  ]);
  buyer = await User.create({
    username: "buyer1",
    email: `buyer${Date.now()}@test.com`,
    password: "testpass123",
    role: "buyer",
    isEmailVerified: true,
  });
  seller = await User.create({
    username: "seller1",
    email: `seller${Date.now()}@test.com`,
    password: "testpass123",
    role: "seller",
    isEmailVerified: true,
  });
  gig = await Gig.create({
    userId: seller._id,
    title: "Build a landing page",
    description: "Modern responsive landing page",
    status: "posted",
    category: "web-development",
    tags: ["react"],
    pricing: {
      basic: { price: 100, deliveryTime: 5 },
    },
    packages: [
      { packageId: "basic", name: "Basic", price: 100, deliveryDays: 5, revisions: 2, features: ["1 page"] },
    ],
  });
  // Fund the buyer wallet.
  await Transaction.create({
    transactionNumber: `TXN-TEST-${Date.now()}`,
    userId: buyer._id,
    type: "deposit",
    amount: Number(process.env.WALLET_DEPOSIT || 100),
    currency: "USD",
    status: "completed",
    paymentMethod: "wallet",
    description: "test deposit",
  });
});

after(async () => {
  if (skip) return;
  await mongoose.connection.close();
});

const it = (name, fn) =>
  test(name, { skip }, async (t) => {
    try {
      await fn(t);
    } catch (error) {
      assert.fail(error.message);
    }
  });

it("full order lifecycle: place → pay → requirements → deliver → revise → accept", async () => {
  const placed = await orderService.placeOrder({
    buyer,
    gigId: gig._id,
    packageId: "basic",
    extraIds: [],
    projectDescription: "I need a modern landing page for my startup.",
    requirements: [],
    attachments: [],
    idempotencyKey: `idem-${Date.now()}`,
  });
  assert.equal(placed.order.status, "PENDING_PAYMENT");
  assert.equal(placed.duplicate, false);
  order = placed.order;

  // Idempotent re-placement returns the same order.
  const again = await orderService.placeOrder({
    buyer,
    gigId: gig._id,
    packageId: "basic",
    extraIds: [],
    projectDescription: "I need a modern landing page for my startup.",
    requirements: [],
    attachments: [],
    idempotencyKey: placed.order.payment.idempotencyKey,
  });
  assert.equal(again.duplicate, true);
  assert.equal(String(again.order._id), String(order._id));

  // Create payment (wallet) and auto-confirm via the webhook pipeline.
  const { payment } = await paymentService.createPayment({
    order,
    buyer,
    method: "wallet",
    idempotencyKey: `pay-${Date.now()}`,
  });
  const confirmed = await paymentService.autoConfirm(payment, order);
  assert.equal(confirmed.order.status, "IN_PROGRESS");
  assert.equal(confirmed.order.payment.status, "CONFIRMED");

  const active = await Order.findById(order._id);
  assert.equal(active.status, "IN_PROGRESS");
  assert.ok(active.pricing.totalCents > 0);

  // Submit requirements is a no-op change here (already in progress).
  await assert.rejects(
    orderService.submitRequirements({
      order: active,
      buyer,
      projectDescription: "new desc",
      requirements: [],
      attachments: [],
    }),
    (e) => e.code === "INVALID_ORDER_STATUS"
  );

  // Delivery.
  const delivered = await orderService.submitDelivery({
    order: active,
    seller,
    message: "Here is the landing page.",
    files: [],
    links: [{ label: "Preview", url: "https://preview.example.com" }],
    notes: "Built with React",
  });
  assert.equal(delivered.status, "DELIVERED");
  assert.ok(delivered.currentDelivery);

  // Revision request (allowed 2).
  const revised = await orderService.requestRevision({
    order: delivered,
    buyer,
    message: "Please adjust the hero section.",
  });
  assert.equal(revised.status, "REVISION_REQUESTED");
  assert.equal(revised.revisions.used, 1);

  // Redelivery.
  const redelivered = await orderService.submitDelivery({
    order: revised,
    seller,
    message: "Adjusted hero.",
  });
  assert.equal(redelivered.status, "DELIVERED");

  // Accept → completed + earnings released.
  const completed = await orderService.acceptDelivery({
    order: redelivered,
    buyer,
    paymentService,
  });
  assert.equal(completed.status, "COMPLETED");
  assert.ok(completed.completedAt);

  const buyerBalance = await Transaction.getUserBalance(buyer._id);
  const sellerBalance = await Transaction.getUserBalance(seller._id);
  assert.equal(sellerBalance, completed.pricing.subtotal - completed.pricing.platformFee);
  assert.ok(buyerBalance > 0);
});

it("rejects ordering your own gig", async () => {
  await assert.rejects(
    orderService.placeOrder({
      buyer: seller,
      gigId: gig._id,
      packageId: "basic",
      extraIds: [],
      projectDescription: "x",
      requirements: [],
      attachments: [],
    }),
    (e) => e.code === "CANNOT_ORDER_OWN_GIG"
  );
});

it("lists orders for the buyer with correct filters", async () => {
  const result = await orderService.getOrders({ user: buyer, filter: "completed", sort: "createdAt", page: 1, limit: 10 });
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].status, "COMPLETED");
  assert.equal(result.pagination.total, 1);
});

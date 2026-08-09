const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("crypto");

const config = require("../src/config/orderConfig");
const provider = require("../src/services/providers/mock.payment.provider");

test("verifySignature accepts a correctly signed payload", () => {
  const raw = JSON.stringify({ type: "payment.succeeded", amount: 5000 });
  const expected = createHmac("sha256", config.webhookSecret).update(raw).digest("hex");
  assert.equal(provider.verifySignature(raw, `sha256=${expected}`), true);
  assert.equal(provider.verifySignature(raw, expected), true);
});

test("verifySignature rejects tampered payloads", () => {
  const raw = JSON.stringify({ type: "payment.succeeded", amount: 5000 });
  const expected = createHmac("sha256", config.webhookSecret).update(raw).digest("hex");
  const tampered = JSON.stringify({ type: "payment.succeeded", amount: 9999 });
  assert.equal(provider.verifySignature(tampered, `sha256=${expected}`), false);
});

test("verifySignature rejects wrong secret signatures", () => {
  const raw = JSON.stringify({ type: "payment.succeeded" });
  const wrong = createHmac("sha256", "wrong-secret").update(raw).digest("hex");
  assert.equal(provider.verifySignature(raw, `sha256=${wrong}`), false);
});

test("verifySignature rejects missing or malformed inputs", () => {
  assert.equal(provider.verifySignature(JSON.stringify({}), undefined), false);
  assert.equal(provider.verifySignature(JSON.stringify({}), null), false);
  assert.equal(provider.verifySignature("", "sha256=abc"), false);
});

test("buildWebhookPayload produces a payload that verifies", () => {
  const payment = { providerPaymentId: "mockpay_123" };
  const order = { orderNumber: "BLK-2026-000001", pricing: { totalCents: 5500, currency: "USD" } };
  const { raw, signature } = provider.buildWebhookPayload(payment, order);
  assert.equal(provider.verifySignature(raw, signature), true);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.type, "payment.succeeded");
  assert.equal(parsed.intentId, "mockpay_123");
  assert.equal(parsed.orderRef, "BLK-2026-000001");
  assert.equal(parsed.amount, 5500);
  assert.equal(parsed.currency, "USD");
});

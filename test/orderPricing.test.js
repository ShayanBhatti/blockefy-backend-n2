const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  calculateOrderPricing,
  calculateDeliveryDays,
  calculateDueAt,
} = require("../src/services/orderPricing.service");

test("pricing: package only", () => {
  const p = calculateOrderPricing({
    pkg: { price: 50 },
    extras: [],
    currency: "USD",
  });
  assert.equal(p.subtotalCents, 5000);
  assert.equal(p.platformFeeCents, 500); // 10% default
  assert.equal(p.totalCents, 5500);
  assert.equal(p.total, 55);
});

test("pricing: package + extras with fractional prices", () => {
  const p = calculateOrderPricing({
    pkg: { price: 25.99 },
    extras: [{ name: "Logo", price: 9.99 }, { name: "Source", price: 0.01 }],
    currency: "USD",
  });
  assert.equal(p.packagePriceCents, 2599);
  assert.equal(p.extrasTotalCents, 1000);
  assert.equal(p.subtotalCents, 3599);
  assert.equal(p.platformFeeCents, 360);
  assert.equal(p.totalCents, 3959);
});

test("pricing: admin fee overrides win over config", () => {
  const p = calculateOrderPricing({
    pkg: { price: 100 },
    extras: [],
    currency: "USD",
    overrides: { platformFeePercent: 5, taxPercent: 2 },
  });
  assert.equal(p.platformFeeCents, 500);
  assert.equal(p.taxCents, 200);
  assert.equal(p.totalCents, 10700);
});

test("pricing: invalid package price throws", () => {
  assert.throws(() => calculateOrderPricing({ pkg: { price: "abc" }, extras: [], currency: "USD" }));
});

test("delivery days: additive extra-days model, capped", () => {
  assert.equal(calculateDeliveryDays({ deliveryDays: 5 }, []), 5);
  assert.equal(calculateDeliveryDays({ deliveryDays: 5 }, [{ deliveryDays: 2 }, { deliveryDays: 1 }]), 8);
  assert.equal(calculateDeliveryDays({ deliveryDays: 2 }, []), 2); // min enforced
  assert.equal(calculateDeliveryDays({ deliveryDays: 200 }, []), 120); // max enforced
});

test("calculateDueAt is deterministic from a start date", () => {
  const start = new Date("2026-01-01T00:00:00.000Z");
  const due = calculateDueAt(start, 3);
  assert.equal(due.toISOString(), "2026-01-04T00:00:00.000Z");
});

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { toCents, fromCents, add, percentOfCents, buildPricing } = require("../src/utils/money");

test("toCents converts major units to integer cents", () => {
  assert.equal(toCents(5), 500);
  assert.equal(toCents("5.00"), 500);
  assert.equal(toCents(0.1), 10);
  assert.equal(toCents(19.99), 1999);
  assert.equal(toCents(100), 10000);
});

test("toCents rejects invalid input", () => {
  assert.equal(toCents(undefined), null);
  assert.equal(toCents(null), null);
  assert.equal(toCents(""), null);
  assert.equal(toCents("abc"), null);
  assert.equal(toCents(NaN), null);
});

test("fromCents converts back to 2-decimal major units", () => {
  assert.equal(fromCents(1999), 19.99);
  assert.equal(fromCents(500), 5);
  assert.equal(fromCents(1), 0.01);
});

test("add is integer-safe", () => {
  assert.equal(add(100, 200, 50), 350);
  assert.equal(add(0.1, 0.2), 0.30000000000000004 + 0); // raw float, caller must pass cents
});

test("percentOfCents rounds half-up", () => {
  assert.equal(percentOfCents(1000, 10), 100);
  assert.equal(percentOfCents(1, 10), 0);
  assert.equal(percentOfCents(15, 33), 5);
});

test("buildPricing computes a full breakdown in cents", () => {
  const p = buildPricing({
    packagePriceCents: 2500,
    extrasTotalCents: 500,
    discountCents: 0,
    taxPercent: 0,
    platformFeePercent: 10,
    currency: "USD",
  });
  assert.equal(p.subtotalCents, 3000);
  assert.equal(p.platformFeeCents, 300);
  assert.equal(p.totalCents, 3300);
  assert.equal(p.total, 33);
  assert.equal(p.currency, "USD");
});

test("buildPricing rejects negative totals", () => {
  assert.throws(() =>
    buildPricing({
      packagePriceCents: 1000,
      extrasTotalCents: 0,
      discountCents: 5000,
      taxPercent: 0,
      platformFeePercent: 10,
      currency: "USD",
    })
  );
});

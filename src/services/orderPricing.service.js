const config = require("../config/orderConfig");
const { toCents, buildPricing } = require("../utils/money");

/**
 * Pricing service.
 *
 * All monetary values are computed HERE from database records + centralized
 * configuration. Controllers never accept prices from the client. Fee logic
 * lives only in this service (spec: "The fee logic must NOT be duplicated
 * inside controllers").
 */

/**
 * Calculate the pricing breakdown for a package + extras snapshot.
 *
 * @param {Object} input
 * @param {Object} input.package - resolved package snapshot { price, ... }
 * @param {Array}  input.extras   - resolved extras snapshot [{ price }]
 * @param {String} input.currency
 * @param {Object} [input.overrides] - optional fee rate override (admin settings)
 * @returns pricing breakdown
 */
const calculateOrderPricing = ({ pkg, extras, currency, overrides }) => {
  const packagePriceCents = toCents(pkg.price);
  if (packagePriceCents === null || packagePriceCents < 0) {
    throw new Error("Invalid package price in pricing calculation");
  }

  let extrasTotalCents = 0;
  for (const extra of extras || []) {
    const cents = toCents(extra.price);
    if (cents === null || cents < 0) {
      throw new Error(`Invalid extra price for "${extra.name}"`);
    }
    extrasTotalCents += cents;
  }

  const platformFeePercent = overrides?.platformFeePercent ?? config.platformFeePercent;
  const taxPercent = overrides?.taxPercent ?? config.taxPercent;

  return buildPricing({
    packagePriceCents,
    extrasTotalCents,
    discountCents: 0,
    taxPercent,
    platformFeePercent,
    currency: currency || config.currency,
  });
};

/**
 * Pure helper: total delivery days for a package + extras.
 * Uses the additive delivery-extension model:
 *   deliveryDays = max(minimum, package.deliveryDays + sum(extra.deliveryDays))
 */
const calculateDeliveryDays = (pkg, extras = []) => {
  const base = Number(pkg.deliveryDays) || 1;
  const extraDays = (extras || []).reduce(
    (sum, extra) => sum + (Number(extra.deliveryDays) || 0),
    0
  );
  const days = Math.max(config.minimumDeliveryDays, Math.min(base + extraDays, config.maximumDeliveryDays));
  return days;
};

/**
 * Compute the delivery due date starting from a given date.
 * @param {Date|String} start - purchase/start timestamp
 * @param {Number} days - delivery days
 */
const calculateDueAt = (start, days) => {
  const base = start ? new Date(start) : new Date();
  const due = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  return due;
};

module.exports = {
  calculateOrderPricing,
  calculateDeliveryDays,
  calculateDueAt,
};

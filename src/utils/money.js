/**
 * Money arithmetic helpers.
 *
 * The order system never trusts numeric values sent by the frontend and never
 * performs "careless" floating point math on money. All monetary computation
 * is done in integer minor units (cents). Decimal values are derived only for
 * storage/display.
 */

const CENTS_PER_UNIT = 100;

/**
 * Convert a numeric (or numeric string) amount in major units to integer cents.
 * Returns null when the input is not a valid finite number.
 */
const toCents = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * CENTS_PER_UNIT);
};

/**
 * Convert integer cents back to a major-units number rounded to 2 decimals.
 */
const fromCents = (cents) => {
  const n = Number(cents);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n / CENTS_PER_UNIT) * 100) / 100;
};

/**
 * Integer-safe addition. Inputs may be in cents.
 */
const add = (...values) => values.reduce((sum, v) => sum + Number(v || 0), 0);

/**
 * Compute a percentage of a cent amount, rounded half-up.
 * @param {number} cents - integer cents
 * @param {number} percent - percentage (e.g. 10 for 10%)
 */
const percentOfCents = (cents, percent) => {
  const c = Number(cents) || 0;
  const p = Number(percent) || 0;
  return Math.round((c * p) / 100);
};

/**
 * Build a full pricing breakdown from integer-cent values.
 * @param {Object} breakdown { packagePriceCents, extrasTotalCents, discountCents, taxPercent, platformFeePercent, currency }
 * @returns {Object} pricing object with decimal fields + integer-cents fields
 */
const buildPricing = ({
  packagePriceCents,
  extrasTotalCents,
  discountCents = 0,
  taxPercent = 0,
  platformFeePercent,
  currency,
}) => {
  const subtotalCents = add(packagePriceCents, extrasTotalCents);
  const platformFeeCents = percentOfCents(subtotalCents, platformFeePercent);
  const taxCents = percentOfCents(subtotalCents, taxPercent);
  const totalCents = add(subtotalCents, platformFeeCents, taxCents, -discountCents);

  if (totalCents < 0) {
    throw new Error("Pricing produced a negative total");
  }

  return {
    currency,
    packagePrice: fromCents(packagePriceCents),
    extrasTotal: fromCents(extrasTotalCents),
    subtotal: fromCents(subtotalCents),
    platformFee: fromCents(platformFeeCents),
    discount: fromCents(discountCents),
    tax: fromCents(taxCents),
    total: fromCents(totalCents),
    // Exact integer-cents representation (source of truth).
    packagePriceCents,
    extrasTotalCents,
    subtotalCents,
    platformFeeCents,
    discountCents,
    taxCents,
    totalCents,
  };
};

module.exports = {
  toCents,
  fromCents,
  add,
  percentOfCents,
  buildPricing,
};

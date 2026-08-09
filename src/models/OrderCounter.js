const mongoose = require("mongoose");

/**
 * OrderCounter — atomic counter used to generate collision-safe human readable
 * order numbers (e.g. BLK-2026-000123).
 *
 * `findOneAndUpdate` with `$inc` + upsert is atomic, so two concurrent requests
 * can never receive the same sequence number (unlike countDocuments-based
 * generation).
 */
const orderCounterSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  seq: { type: Number, default: 0 },
});

/**
 * Atomically get the next sequence for a counter key.
 * @param {String} key - counter name
 * @returns {Promise<Number>} next sequence
 */
orderCounterSchema.statics.nextSequence = async function (key) {
  const counter = await this.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return counter.seq;
};

const OrderCounter =
  mongoose.models.OrderCounter || mongoose.model("OrderCounter", orderCounterSchema);

module.exports = OrderCounter;

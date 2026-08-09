/**
 * Validation middleware re-export.
 * Usage: router.post("/", authenticate, validate(schema), controller)
 */
const { makeValidator } = require("../utils/validate");

module.exports = makeValidator;

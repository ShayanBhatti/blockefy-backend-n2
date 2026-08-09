const mongoose = require("mongoose");
const AppError = require("../utils/AppError");

/**
 * Validates that a route parameter is a well-formed MongoDB ObjectId.
 * Prevents malformed ids from reaching queries (NoSQL/injection hardening).
 *
 * Usage: router.get("/:orderId", authenticate, validateObjectId("orderId"), controller)
 */
const validateObjectId = (paramName) => {
  return (req, res, next) => {
    const value = req.params[paramName];
    if (!mongoose.Types.ObjectId.isValid(value)) {
      return next(new AppError("Invalid resource id", 400, "INVALID_ID"));
    }
    next();
  };
};

module.exports = validateObjectId;

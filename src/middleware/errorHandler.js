const { ERROR_CODES } = require("../constants/order.constants");
const config = require("../config/orderConfig");

/**
 * Central error handler.
 *
 * - Maps AppError instances to their code + status.
 * - Maps Mongoose validation/cast errors to 400.
 * - Maps duplicate-key errors to 409.
 * - Never leaks stack traces / internals in production.
 */
const errorHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  let status = err.statusCode || err.status || 500;
  let message = err.message || "Server error";
  let code = err.code || ERROR_CODES.SERVER_ERROR;
  let details = err.details;

  if (err.name === "ValidationError") {
    status = 400;
    code = ERROR_CODES.VALIDATION_ERROR;
    details = Object.values(err.errors || {}).map((e) => e.message);
    message = "Validation failed";
  } else if (err.name === "CastError") {
    status = 400;
    code = ERROR_CODES.INVALID_ID;
    message = "Invalid identifier format";
  } else if (err.code === 11000) {
    status = 409;
    code = ERROR_CODES.CONFLICT;
    message = "A record with the same unique value already exists";
  } else if (err.name === "MulterError") {
    status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    code = err.code === "LIMIT_FILE_SIZE" ? ERROR_CODES.FILE_TOO_LARGE : ERROR_CODES.INVALID_FILE;
    message = err.code === "LIMIT_FILE_SIZE" ? "File too large" : `Upload error: ${err.message}`;
  }

  if (status >= 500) {
    console.error("Unhandled error:", err);
  }

  const body = { success: false, message, code };
  if (details !== undefined) body.details = details;
  if (process.env.NODE_ENV !== "production" && status >= 500) body.stack = err.stack;

  res.status(status).json(body);
};

module.exports = errorHandler;

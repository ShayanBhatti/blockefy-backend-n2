/**
 * Application error with a stable machine-readable code and an HTTP status.
 * All business errors thrown by services should use this class so the central
 * error handler can map them to proper responses (never bare 500s).
 */
class AppError extends Error {
  constructor(message, statusCode = 500, code = "SERVER_ERROR", details = undefined) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
  }
}

module.exports = AppError;

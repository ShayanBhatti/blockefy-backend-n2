/**
 * Input sanitization helpers.
 *
 * The backend never trusts user supplied text. These helpers strip HTML,
 * control characters and reject inputs that are too long. They are used before
 * any user string is persisted, reducing stored-XSS and payload-abuse risk.
 */

const DEFAULT_MAX = 5000;

/**
 * Remove/neutralize HTML and dangerous control characters.
 * - Strips `<...>` tags
 * - Escapes remaining special characters
 * - Removes null bytes and non-printable control chars
 */
const stripHtml = (input) => {
  if (typeof input !== "string") return input;
  return input
    .replace(/\u0000/g, "") // null bytes
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

/**
 * Normalize + validate a free-text field.
 * - requires a string
 * - trims
 * - enforces maximum length
 * - strips HTML/control characters
 * Returns the sanitized string, or throws with a message when invalid.
 */
const sanitizeText = (input, { max = DEFAULT_MAX, field = "text" } = {}) => {
  if (typeof input !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const cleaned = stripHtml(input).trim();
  if (cleaned.length > max) {
    throw new Error(`${field} exceeds maximum length of ${max} characters`);
  }
  return cleaned;
};

/**
 * Validate that a string is not empty/whitespace-only.
 */
const requireNonEmpty = (value, { max = DEFAULT_MAX, field = "text" } = {}) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return sanitizeText(value, { max, field });
};

/**
 * Strict URL validation (http/https only). Used for requirement url answers
 * and delivery links.
 */
const isValidUrl = (value) => {
  if (typeof value !== "string") return false;
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

module.exports = {
  stripHtml,
  sanitizeText,
  requireNonEmpty,
  isValidUrl,
};

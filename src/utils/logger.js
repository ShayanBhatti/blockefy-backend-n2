/**
 * Project-aligned logging helper.
 *
 * Wraps console.* with a consistent prefix and redacts high-sensitivity values
 * before they reach logs: JWTs, LiveKit secrets, access tokens, passwords,
 * private message content, and authorization headers.
 *
 * Usage:
 *   const logger = require("../utils/logger");
 *   logger.info("call_started", { callId, roomName, callerId });
 *   logger.error("call_failed", err, { callId });
 */

const REDACT_KEYS = [
  /secret/i,
  /token/i,
  /jwt/i,
  /password/i,
  /auth/i,
  /content$/i,
  /message$/i,
  /authorization/i,
];

const isSensitiveKey = (key) =>
  typeof key === "string" && REDACT_KEYS.some((pattern) => pattern.test(key));

const redact = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.length <= 8) return "[REDACTED]";
    return value.slice(0, 2) + "***" + value.slice(-2);
  }
  if (typeof value === "object") {
    if (Array.isArray(value)) return value.map(redact);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) ? "[REDACTED]" : redact(v);
    }
    return out;
  }
  return value;
};

const cleanMeta = (meta) => {
  if (!meta || typeof meta !== "object") return meta;
  const out = {};
  for (const [key, value] of Object.entries(meta)) {
    out[key] = isSensitiveKey(key) ? redact(value) : value;
  }
  return out;
};

const log = (level, message, meta, error) => {
  const safeMeta = cleanMeta(meta);
  const parts = [`[${level}] ${message}`];
  if (safeMeta && Object.keys(safeMeta).length) parts.push(JSON.stringify(safeMeta));
  if (error && error.message) parts.push(`err=${error.message}`);

  const line = parts.join(" ");
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
};

module.exports = {
  info: (message, meta) => log("info", message, meta),
  warn: (message, meta, error) => log("warn", message, meta, error),
  error: (message, error, meta) => log("error", message, meta, error),
  debug: (message, meta) => {
    if (process.env.DEBUG || process.env.LOG_LEVEL === "debug") {
      log("debug", message, meta);
    }
  },
  redact,
};

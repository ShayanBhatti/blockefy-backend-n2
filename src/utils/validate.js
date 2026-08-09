/**
 * Lightweight schema validation used by the `validate` middleware.
 *
 * The project did not previously ship a schema validation library, so this
 * minimal validator keeps zero new runtime dependencies while still rejecting
 * malformed payloads, bad ObjectIds, unknown enum values, oversized arrays,
 * invalid URLs and unexpected extra fields.
 *
 * Usage:
 *   const validate = require("../middleware/validate"); // returns middleware
 *   const { s } = require("../utils/validate");
 *   const schema = { gigId: s.required(s.objectId()), extraIds: s.arrayOf(s.objectId()).max(5) };
 *   router.post("/x", authenticate, validate(schema, { body: true }), handler);
 */

const mongoose = require("mongoose");

class ValidationError extends Error {
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.name = "ValidationError";
    this.field = field;
    this.validationMessage = message;
  }
}

/* ------------------------------------------------------------------ */
/* Validator primitives                                                */
/* ------------------------------------------------------------------ */

const pass = (value) => ({ valid: true, value });

const fail = (message) => ({ valid: false, message });

const validateString = (value, opts = {}) => {
  if (typeof value !== "string") return fail("must be a string");
  if (value.length === 0 && opts.empty === false) return fail("must not be empty");
  if (opts.max && value.length > opts.max) return fail(`must not exceed ${opts.max} characters`);
  return pass(value.trim());
};

const validateNumber = (value, opts = {}) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fail("must be a number");
  if (opts.min !== undefined && value < opts.min) return fail(`must be at least ${opts.min}`);
  if (opts.max !== undefined && value > opts.max) return fail(`must be at most ${opts.max}`);
  return pass(value);
};

const validateInteger = (value, opts = {}) => {
  if (typeof value !== "number" || !Number.isInteger(value)) return fail("must be an integer");
  if (opts.min !== undefined && value < opts.min) return fail(`must be at least ${opts.min}`);
  if (opts.max !== undefined && value > opts.max) return fail(`must be at most ${opts.max}`);
  return pass(value);
};

const validateBoolean = (value) => {
  if (typeof value !== "boolean") return fail("must be a boolean");
  return pass(value);
};

const validateObjectId = (value) => {
  if (typeof value !== "string" || !mongoose.Types.ObjectId.isValid(value)) {
    return fail("must be a valid ObjectId");
  }
  return pass(value);
};

const validateEnum = (value, allowed) => {
  if (!Array.isArray(allowed) || !allowed.includes(value)) {
    return fail(`must be one of: ${allowed.join(", ")}`);
  }
  return pass(value);
};

const validateUrl = (value) => {
  if (typeof value !== "string" || value.length > 2048) return fail("must be a valid URL");
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return fail("must be http(s)");
    return pass(value);
  } catch {
    return fail("must be a valid URL");
  }
};

const validateArrayOf = (value, itemValidator, opts = {}) => {
  if (!Array.isArray(value)) return fail("must be an array");
  if (opts.max !== undefined && value.length > opts.max) return fail(`must not exceed ${opts.max} items`);
  for (let i = 0; i < value.length; i++) {
    const r = itemValidator(value[i]);
    if (!r.valid) return fail(`item ${i} ${r.message}`);
  }
  return pass(value);
};

const validateObject = (value, shape) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail("must be an object");
  for (const [key, v] of Object.entries(value)) {
    const rule = shape[key];
    if (!rule) return fail(`unexpected field "${key}"`);
    const r = rule(v);
    if (!r.valid) return fail(`field "${key}" ${r.message}`);
  }
  return pass(value);
};

const validateCustom = (value, fn) => {
  const r = fn(value);
  if (r === true) return pass(value);
  if (r === false) return fail("failed custom validation");
  if (r && typeof r === "object") return r;
  return fail("failed custom validation");
};

/* ------------------------------------------------------------------ */
/* Rule builders                                                       */
/* ------------------------------------------------------------------ */

const required = (validator) => (value) => {
  if (value === undefined || value === null || value === "") return fail("is required");
  return validator(value);
};

const optional = (validator) => (value) => {
  if (value === undefined || value === null || value === "") return pass(value);
  return validator(value);
};

const withOpts = (raw) => (opts = {}) => {
  const fn = raw(opts);
  fn.min = (min) => withOpts(raw)({ ...opts, min });
  fn.max = (max) => withOpts(raw)({ ...opts, max });
  return fn;
};

const s = {
  string: withOpts((opts) => (value) => validateString(value, opts)),
  number: withOpts((opts) => (value) => validateNumber(value, opts)),
  integer: withOpts((opts) => (value) => validateInteger(value, opts)),
  boolean: (value) => validateBoolean(value),
  objectId: () => (value) => validateObjectId(value),
  enum: (allowed) => (value) => validateEnum(value, allowed),
  url: () => (value) => validateUrl(value),
  arrayOf: (item) => {
    const build = (opts) => (value) => validateArrayOf(value, item, opts);
    build.max = (max) => build({ max });
    return build;
  },
  object: (shape) => (value) => validateObject(value, shape),
  custom: (fn) => (value) => validateCustom(value, fn),
  required,
  optional,
};

/* ------------------------------------------------------------------ */
/* Validate middleware                                                 */
/* ------------------------------------------------------------------ */

/**
 * Build an Express middleware that validates `req.body` (and optionally
 * req.params / req.query) against a schema.
 *
 * The schema may be an object of rules (each field validated) OR a single
 * rule applied to the whole payload. When `stripUnknown` is true (default),
 * unknown fields are removed from the validated object so the controller
 * never receives fields the backend does not expect.
 *
 * @param {Object} schema - { fieldName: rule } map
 * @param {Object} options - { body: true, params: false, query: false, stripUnknown: true }
 */
const makeValidator = (schema, options = {}) => {
  const { body = true, params = false, query = false, stripUnknown = true } = options;
  return (req, res, next) => {
    const errors = [];
    const sources = [];
    if (body) sources.push(["body", req.body]);
    if (params) sources.push(["params", req.params]);
    if (query) sources.push(["query", req.query]);

    for (const [sourceName, source] of sources) {
      const cleaned = {};
      for (const [field, rule] of Object.entries(schema)) {
        const value = source[field];
        if (value === undefined) {
          // If the rule is marked required, validate it (it will fail);
          // otherwise skip.
          if (isRequiredRule(rule)) {
            const r = rule(value);
            if (!r.valid) errors.push(`${sourceName}.${field}: ${r.message}`);
          }
          continue;
        }
        try {
          const r = rule(value);
          if (!r.valid) {
            errors.push(`${sourceName}.${field}: ${r.message}`);
          } else {
            cleaned[field] = r.value;
          }
        } catch (e) {
          errors.push(`${sourceName}.${field}: ${e.validationMessage || e.message}`);
        }
      }

      if (stripUnknown) {
        // Remove unknown top-level keys from the source object.
        for (const key of Object.keys(source)) {
          if (!(key in schema)) delete source[key];
        }
      }
      Object.assign(source, cleaned);
    }

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        code: "VALIDATION_ERROR",
        details: errors,
      });
    }
    next();
  };
};

function isRequiredRule(rule) {
  // Cheap heuristic: wrap the field with s.required() and test undefined.
  try {
    const r = rule(undefined);
    return !r.valid && r.message === "is required";
  } catch {
    return false;
  }
}

module.exports = {
  s,
  makeValidator,
  ValidationError,
};

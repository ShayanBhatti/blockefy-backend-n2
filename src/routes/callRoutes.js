const express = require("express");
const router = express.Router();
const callController = require("../controllers/callController");
const authenticate = require("../middleware/authenticate");
const validateObjectId = require("../middleware/validateObjectId");
const validate = require("../middleware/validate");
const { createRateLimiter, userKeyFn } = require("../middleware/rateLimiter");
const { s } = require("../utils/validate");
const config = require("../config/communicationConfig");

/**
 * Call routes.
 *
 * callType is validated against the config allowlist. Status transitions are
 * whitelisted in the call service — arbitrary PATCH bodies are not allowed.
 * Token minting and call creation are rate limited per authenticated user.
 */

/* Media tokens are expensive to mint — strict per-user cap. */
const tokenLimiter = createRateLimiter({ windowMs: 60_000, max: 30, keyFn: userKeyFn });
const callActionLimiter = createRateLimiter({ windowMs: 60_000, max: 120, keyFn: userKeyFn });

/* Query-string integer rule: coerce "3" -> 3 before bounds checks. */
const queryInt = (opts = {}) =>
  s.custom((raw) => {
    if (raw === undefined || raw === null || raw === "") return { valid: true, value: undefined };
    const n = Number(raw);
    if (!Number.isInteger(n)) return false;
    if (opts.min !== undefined && n < opts.min) return false;
    if (opts.max !== undefined && n > opts.max) return false;
    return { valid: true, value: n };
  });

const createCallSchema = {
  callType: s.required(s.enum(config.callTypes)),
  receiverId: s.optional(s.objectId()),
  conversationId: s.optional(s.objectId()),
  orderId: s.optional(s.objectId()),
};

const updateStatusSchema = {
  status: s.required(s.enum(["accepted", "rejected", "cancelled", "missed", "ended"])),
};

/* Spec-shaped token request: { callId, callType } in the body. */
const bodyTokenSchema = {
  callId: s.required(s.objectId()),
  callType: s.optional(s.enum(config.callTypes)),
};

const listQuerySchema = {
  page: s.optional(queryInt({ min: 1 })),
  limit: s.optional(queryInt({ min: 1, max: config.maxPageLimit })),
  callType: s.optional(s.enum(config.callTypes)),
  status: s.optional(s.enum(config.callStatuses)),
  conversationId: s.optional(s.objectId()),
  orderId: s.optional(s.objectId()),
};

router.post("/", authenticate, callActionLimiter, validate(createCallSchema), callController.createCall);

/* Spec-shaped token endpoint: POST /api/calls/token { callId, callType }. */
router.post("/token", authenticate, tokenLimiter, validate(bodyTokenSchema), callController.getCallToken);

router.get("/", authenticate, validate(listQuerySchema, { body: false, params: false, query: true }), callController.listCalls);

router.get("/:callId", authenticate, validateObjectId("callId"), callController.getCallById);

/* Dedicated action endpoints — must be mounted BEFORE the generic :callId/status route. */
router.post("/:callId/accept", authenticate, callActionLimiter, validateObjectId("callId"), callController.acceptCall);
router.post("/:callId/reject", authenticate, callActionLimiter, validateObjectId("callId"), callController.rejectCall);
router.post("/:callId/cancel", authenticate, callActionLimiter, validateObjectId("callId"), callController.cancelCall);
router.post("/:callId/end", authenticate, callActionLimiter, validateObjectId("callId"), callController.endCall);

router.post("/:callId/status", authenticate, callActionLimiter, validateObjectId("callId"), validate(updateStatusSchema), callController.updateCallStatus);

router.post("/:callId/token", authenticate, tokenLimiter, validateObjectId("callId"), callController.getCallToken);

module.exports = router;

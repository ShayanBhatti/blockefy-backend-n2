const express = require("express");
const router = express.Router();
const communicationController = require("../controllers/communicationController");
const authenticate = require("../middleware/authenticate");
const validateObjectId = require("../middleware/validateObjectId");
const validate = require("../middleware/validate");
const { createRateLimiter, userKeyFn } = require("../middleware/rateLimiter");
const { s } = require("../utils/validate");
const config = require("../config/communicationConfig");

/**
 * Communication routes — conversations and messages.
 *
 * Identity is always the authenticated user (req.authUser). receiverId/userId
 * in bodies is only used as a target reference, never as an authority.
 */

/* Message sending is the most abuse-prone write path — stricter per-user cap. */
const sendMessageLimiter = createRateLimiter({ windowMs: 60_000, max: 120, keyFn: userKeyFn });

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

const directConversationSchema = {
  userId: s.required(s.objectId()),
};

const orderConversationSchema = {
  orderId: s.required(s.objectId()),
};

const typingSchema = {
  isTyping: s.optional(s.boolean),
};

const listQuerySchema = {
  page: s.optional(queryInt({ min: 1 })),
  limit: s.optional(queryInt({ min: 1, max: config.maxPageLimit })),
};

const messageListQuerySchema = {
  page: s.optional(queryInt({ min: 1 })),
  limit: s.optional(queryInt({ min: 1, max: config.maxPageLimit })),
};

/* REST message creation (spec: POST /api/conversations/:id/messages). */
const createMessageSchema = {
  type: s.optional(s.enum(["text", "image", "file"])),
  content: s.optional(s.string().max(config.messageMaxLength)),
  attachments: s.optional(s.arrayOf(s.object({
    name: s.optional(s.string().max(255)),
    url: s.required(s.url()),
    publicId: s.optional(s.string().max(255)),
    mimeType: s.optional(s.string().max(100)),
    extension: s.optional(s.string().max(20)),
    size: s.optional(s.number().min(0)),
  })).max(config.maxMessageAttachments)),
};

/* --------------------------- Conversations --------------------------- */

/**
 * Generic get-or-create endpoint (spec: POST /api/conversations).
 * Body: { userId } for direct conversations or { orderId } for order ones.
 * Exactly one of the two must be provided.
 */
const createConversationSchema = {
  userId: s.optional(s.objectId()),
  orderId: s.optional(s.objectId()),
};

router.post(
  "/conversations",
  authenticate,
  validate(createConversationSchema),
  communicationController.createConversation
);

router.post(
  "/conversations/direct",
  authenticate,
  validate(directConversationSchema),
  communicationController.findOrCreateDirect
);

router.post(
  "/conversations/order",
  authenticate,
  validate(orderConversationSchema),
  communicationController.findOrCreateOrder
);

router.get(
  "/conversations",
  authenticate,
  validate(listQuerySchema, { body: false, params: false, query: true }),
  communicationController.listConversations
);

router.get(
  "/conversations/:conversationId",
  authenticate,
  validateObjectId("conversationId"),
  communicationController.getConversationById
);

/* ------------------------------ Messages ----------------------------- */

router.post(
  "/conversations/:conversationId/messages",
  authenticate,
  validateObjectId("conversationId"),
  sendMessageLimiter,
  validate(createMessageSchema),
  communicationController.createMessage
);

router.get(
  "/conversations/:conversationId/messages",
  authenticate,
  validateObjectId("conversationId"),
  validate(messageListQuerySchema, { body: false, params: false, query: true }),
  communicationController.getMessages
);

router.patch(
  "/messages/:messageId/read",
  authenticate,
  validateObjectId("messageId"),
  communicationController.markRead
);

router.post(
  "/messages/:messageId/read",
  authenticate,
  validateObjectId("messageId"),
  communicationController.markRead
);

/* Typing indicator — realtime feedback only (broadcast via Socket.IO). */
router.post(
  "/conversations/:conversationId/typing",
  authenticate,
  validateObjectId("conversationId"),
  validate(typingSchema),
  communicationController.typing
);

module.exports = router;

const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/apiResponse");
const AppError = require("../utils/AppError");
const conversationService = require("../services/conversation.service");
const messageService = require("../services/message.service");
const communicationService = require("../services/communication.service");
const realtimeService = require("../services/realtime.service");

/**
 * Communication controller — conversations and messages.
 *
 * Identity is always `req.authUser` (lean user doc) populated by
 * `authenticate`; the JWT payload's `userId` is used via that middleware.
 */

/* --------------------------- Conversations --------------------------- */

/**
 * Generic get-or-create: `{ userId }` opens/returns a direct conversation,
 * `{ orderId }` opens/returns the order conversation (order parties only).
 */
exports.createConversation = asyncHandler(async (req, res) => {
  const { userId, orderId } = req.body;
  if (!userId && !orderId) {
    throw new AppError("Either userId or orderId is required", 400, "VALIDATION_ERROR");
  }
  if (userId && orderId) {
    throw new AppError("Provide either userId or orderId, not both", 400, "VALIDATION_ERROR");
  }
  const conversation = userId
    ? await conversationService.findOrCreateDirectConversation({ user: req.authUser, otherUserId: userId })
    : await conversationService.findOrCreateOrderConversation({ user: req.authUser, orderId });
  return ok(res, { conversation: communicationService.serializeConversation(conversation, { currentUserId: req.authUser._id }) }, "Conversation ready");
});

exports.findOrCreateDirect = asyncHandler(async (req, res) => {
  const { userId } = req.body;
  const conversation = await conversationService.findOrCreateDirectConversation({
    user: req.authUser,
    otherUserId: userId,
  });
  return ok(res, { conversation: communicationService.serializeConversation(conversation, { currentUserId: req.authUser._id }) }, "Conversation ready");
});

exports.findOrCreateOrder = asyncHandler(async (req, res) => {
  const { orderId } = req.body;
  const conversation = await conversationService.findOrCreateOrderConversation({
    user: req.authUser,
    orderId,
  });
  return ok(res, { conversation: communicationService.serializeConversation(conversation, { currentUserId: req.authUser._id }) }, "Conversation ready");
});

exports.listConversations = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  const result = await conversationService.listConversations({
    user: req.authUser,
    page,
    limit,
  });
  const conversations = result.conversations.map((c) =>
    communicationService.serializeConversation(c, { currentUserId: req.authUser._id })
  );
  return ok(res, { conversations, pagination: result.pagination }, "Conversations fetched");
});

exports.getConversationById = asyncHandler(async (req, res) => {
  const conversation = await conversationService.getConversationById({
    conversationId: req.params.conversationId,
    userId: req.authUser._id,
  });
  return ok(res, { conversation: communicationService.serializeConversation(conversation, { currentUserId: req.authUser._id }) }, "Conversation fetched");
});

/* ----------------------------- Messages ----------------------------- */

/**
 * REST message creation. senderId is derived from req.authUser — never from
 * the body. Realtime clients receive the same message via `message:new`.
 */
exports.createMessage = asyncHandler(async (req, res) => {
  const { type, content, attachments } = req.body;
  const message = await messageService.sendMessage({
    conversationId: req.params.conversationId,
    sender: req.authUser,
    type,
    content,
    attachments,
  });

  const payload = {
    conversationId: String(message.conversationId),
    message: communicationService.serializeMessage(message),
  };
  realtimeService.emitToConversation(message.conversationId, "message:new", payload);
  realtimeService.emitToConversation(message.conversationId, "conversation:updated", {
    conversationId: String(message.conversationId),
  });

  return created(res, payload, "Message sent");
});

exports.getMessages = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  const result = await messageService.getMessages({
    conversationId: req.params.conversationId,
    user: req.authUser,
    page,
    limit,
  });
  return ok(res, {
    messages: result.messages.map((m) => communicationService.serializeMessage(m)),
    pagination: result.pagination,
  }, "Messages fetched");
});

exports.markRead = asyncHandler(async (req, res) => {
  const message = await messageService.markRead({
    messageId: req.params.messageId,
    user: req.authUser,
  });
  return ok(res, { message: communicationService.serializeMessage(message) }, "Message marked as read");
});

/**
 * Broadcast a typing indicator to the conversation room. Nothing is stored.
 * The remote peers receive `typing:start` / `typing:stop` over Socket.IO.
 * `isTyping` defaults to true; callers send `{ isTyping: false }` to stop.
 */
exports.typing = asyncHandler(async (req, res) => {
  const conversationId = req.params.conversationId;
  const isTyping = req.body.isTyping !== false;

  // Re-assert membership before relaying the event to the room.
  await communicationService.assertConversationAccessById(conversationId, req.authUser._id);

  const event = isTyping ? "typing:start" : "typing:stop";
  realtimeService.emitToConversation(conversationId, event, {
    conversationId,
    user: communicationService.profileSummary(req.authUser),
  });

  return ok(res, { conversationId, isTyping }, isTyping ? "Typing started" : "Typing stopped");
});

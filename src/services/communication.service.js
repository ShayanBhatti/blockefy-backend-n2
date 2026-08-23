const AppError = require("../utils/AppError");
const { sanitizeText } = require("../utils/sanitize");
const config = require("../config/communicationConfig");
const Order = require("../models/Order");
const Conversation = require("../models/Conversation");

/**
 * Communication authorization + serialization service.
 *
 * Reusable guards used by both the REST controllers and the socket handlers so
 * a user can NEVER:
 *   - read another user's private conversations
 *   - send messages into another user's conversation
 *   - join an unrelated call
 *   - access another user's call history
 *   - mint LiveKit tokens for arbitrary rooms
 *
 * Identity is always derived from the authenticated request/socket — never
 * from client-supplied senderId / callerId / userId.
 */

/* ------------------------------------------------------------------ */
/* Conversation guards                                                 */
/* ------------------------------------------------------------------ */

const isParticipant = (conversation, userId) => {
  if (!conversation || !conversation.participants || !userId) return false;
  const myId = String(userId);
  return conversation.participants.some(
    (p) => String(p?._id || p) === myId
  );
};

const assertConversationAccess = (conversation, userId) => {
  if (!conversation) throw new AppError("Conversation not found", 404, "CONVERSATION_NOT_FOUND");
  if (!isParticipant(conversation, userId)) {
    throw new AppError("You are not a participant of this conversation", 403, "CONVERSATION_ACCESS_DENIED");
  }
};

const assertConversationAccessById = async (conversationId, userId) => {
  const conversation = await Conversation.findById(conversationId).select("participants").lean();
  assertConversationAccess(conversation, userId);
  return conversation;
};

/* ------------------------------------------------------------------ */
/* Message guards                                                      */
/* ------------------------------------------------------------------ */

const assertMessageAccess = (message, userId) => {
  if (!message) throw new AppError("Message not found", 404, "MESSAGE_NOT_FOUND");
  const myId = String(userId);
  const isSender = String(message.senderId?._id || message.senderId) === myId;
  const isReceiver = String(message.receiverId?._id || message.receiverId) === myId;
  if (!isSender && !isReceiver) {
    throw new AppError("You are not authorized to access this message", 403, "MESSAGE_ACCESS_DENIED");
  }
};

/* ------------------------------------------------------------------ */
/* Call guards                                                         */
/* ------------------------------------------------------------------ */

const assertCallAccess = (call, userId) => {
  if (!call) throw new AppError("Call not found", 404, "CALL_NOT_FOUND");
  const myId = String(userId);
  const isCaller = String(call.callerId?._id || call.callerId) === myId;
  const isReceiver = String(call.receiverId?._id || call.receiverId) === myId;
  if (!isCaller && !isReceiver) {
    throw new AppError("You are not a participant of this call", 403, "CALL_ACCESS_DENIED");
  }
};

/**
 * Verify an authenticated user belongs to the order (reuses the existing
 * Order.isAccessibleBy rule — no duplicated business logic).
 */
const assertOrderAccess = async (order, user) => {
  if (!order) throw new AppError("Order not found", 404, "ORDER_NOT_FOUND");
  const allowed = await Order.isAccessibleBy(order, user);
  if (!allowed) {
    throw new AppError("You are not authorized to access this order", 403, "ORDER_ACCESS_DENIED");
  }
};

/* ------------------------------------------------------------------ */
/* Content sanitization                                                */
/* ------------------------------------------------------------------ */

const sanitizeMessageContent = (content, { max = config.messageMaxLength } = {}) => {
  try {
    return sanitizeText(content, { max, field: "Message content" });
  } catch (error) {
    throw new AppError(error.message, 400, "VALIDATION_ERROR");
  }
};

/* ------------------------------------------------------------------ */
/* Serialization (DTOs — never leak sensitive fields)                  */
/* ------------------------------------------------------------------ */

const profileSummary = (user) => {
  if (!user) return null;
  return {
    id: user._id || user.id,
    fullName: user.fullName || null,
    username: user.username || null,
    avatar: user.profileImage?.url || user.profile?.avatar || null,
  };
};

const serializeConversation = (conversation, { currentUserId } = {}) => {
  if (!conversation) return null;
  const c = conversation.toObject ? conversation.toObject() : conversation;

  const participants = (c.participants || []).map((p) => profileSummary(p)).filter(Boolean);
  const lastMessage = c.lastMessageId
    ? {
        id: c.lastMessageId._id || c.lastMessageId,
        type: c.lastMessageId.type || "text",
        senderId: c.lastMessageId.senderId?._id || c.lastMessageId.senderId || null,
        content: c.lastMessageId.content || "",
        createdAt: c.lastMessageId.createdAt || null,
        readAt: c.lastMessageId.readAt || null,
      }
    : null;

  let otherParticipant = null;
  if (currentUserId && c.type === "direct") {
    otherParticipant =
      participants.find((p) => String(p.id) !== String(currentUserId)) || null;
  }

  return {
    id: c._id,
    type: c.type,
    orderId: c.orderId || null,
    lastMessageId: lastMessage ? lastMessage.id : null,
    lastMessageAt: c.lastMessageAt || null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    participants,
    otherParticipant,
    lastMessage,
  };
};

const serializeMessage = (message) => {
  if (!message) return null;
  const m = message.toObject ? message.toObject() : message;
  return {
    id: m._id,
    conversationId: m.conversationId,
    senderId: m.senderId?._id || m.senderId,
    receiverId: m.receiverId?._id || m.receiverId || null,
    type: m.type,
    content: m.content,
    attachments: m.attachments || [],
    readAt: m.readAt || null,
    deliveredAt: m.deliveredAt || null,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
};

const serializeCall = (call) => {
  if (!call) return null;
  const c = call.toObject ? call.toObject() : call;
  return {
    id: c._id,
    caller: c.callerId ? profileSummary(c.callerId._id ? c.callerId : { _id: c.callerId }) : null,
    receiver: c.receiverId ? profileSummary(c.receiverId._id ? c.receiverId : { _id: c.receiverId }) : null,
    conversationId: c.conversationId || null,
    orderId: c.orderId || null,
    roomName: c.roomName,
    callType: c.callType,
    status: c.status,
    startedAt: c.startedAt || null,
    answeredAt: c.answeredAt || null,
    endedAt: c.endedAt || null,
    duration: c.duration || 0,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
};

module.exports = {
  isParticipant,
  assertConversationAccess,
  assertConversationAccessById,
  assertMessageAccess,
  assertCallAccess,
  assertOrderAccess,
  sanitizeMessageContent,
  profileSummary,
  serializeConversation,
  serializeMessage,
  serializeCall,
};

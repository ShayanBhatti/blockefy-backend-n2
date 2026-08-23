const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const communicationService = require("./communication.service");
const notificationService = require("./notification.service");
const AppError = require("../utils/AppError");
const config = require("../config/communicationConfig");
const { isValidUrl } = require("../utils/sanitize");

/**
 * Message service — sending, listing (paged), read receipts.
 *
 * senderId is ALWAYS set from the authenticated user; it is never read from
 * the payload. Text content is sanitized before persistence.
 */

const normalizePage = (page, limit) => ({
  page: Math.max(1, Number(page) || 1),
  limit: Math.min(config.maxPageLimit, Math.max(1, Number(limit) || config.defaultPageLimit)),
});

const validateAttachments = (attachments) => {
  if (!Array.isArray(attachments)) return [];
  if (attachments.length > config.maxMessageAttachments) {
    throw new AppError(`A message may contain at most ${config.maxMessageAttachments} attachments`, 400, "VALIDATION_ERROR");
  }
  return attachments.map((a) => {
    if (!a || typeof a !== "object") {
      throw new AppError("Invalid attachment", 400, "VALIDATION_ERROR");
    }
    if (!a.url || !isValidUrl(a.url)) {
      throw new AppError("Attachment url must be a valid http(s) URL", 400, "VALIDATION_ERROR");
    }
    return {
      name: String(a.name || "").slice(0, 255),
      url: String(a.url).slice(0, 2048),
      publicId: String(a.publicId || "").slice(0, 255),
      mimeType: String(a.mimeType || "").slice(0, 100),
      extension: String(a.extension || "").slice(0, 20),
      size: Number(a.size) > 0 ? Number(a.size) : 0,
    };
  });
};

const resolveOtherParticipant = (conversation, userId) => {
  const others = (conversation.participants || []).filter(
    (p) => String(p?._id || p) !== String(userId)
  );
  const other = others[0];
  return other ? other._id || other : null;
};

/**
 * Persist a message and update the conversation's last-message pointer.
 *
 * @param {Object} params
 * @param {ObjectId} [params.conversationId]
 * @param {Object} [params.conversation] - preloaded (lean) conversation, avoids a query
 * @param {Object} params.sender - authenticated lean user
 * @param {string} [params.type]
 * @param {string} [params.content]
 * @param {Array} [params.attachments]
 */
const sendMessage = async ({ conversationId, conversation, sender, type = "text", content, attachments }) => {
  const conv = conversation || (conversationId ? await Conversation.findById(conversationId).lean() : null);
  communicationService.assertConversationAccess(conv, sender._id);

  if (!["text", "image", "file"].includes(type)) {
    throw new AppError("Invalid message type", 400, "VALIDATION_ERROR");
  }

  let cleanedContent = "";
  if (type === "text") {
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new AppError("Message content is required", 400, "VALIDATION_ERROR");
    }
    cleanedContent = communicationService.sanitizeMessageContent(content);
  } else {
    cleanedContent = typeof content === "string" && content.trim().length > 0
      ? communicationService.sanitizeMessageContent(content)
      : "";
    if (!Array.isArray(attachments) || attachments.length === 0) {
      throw new AppError("Attachments are required for media messages", 400, "VALIDATION_ERROR");
    }
  }

  const cleanAttachments = validateAttachments(attachments);

  const receiverId = resolveOtherParticipant(conv, sender._id);

  const message = await Message.create({
    conversationId: conv._id,
    senderId: sender._id,
    receiverId,
    type,
    content: cleanedContent,
    attachments: cleanAttachments,
    deliveredAt: new Date(),
  });

  await Conversation.updateOne(
    { _id: conv._id },
    { $set: { lastMessageId: message._id, lastMessageAt: message.createdAt } }
  );

  // Best-effort in-app notification (must never break the send).
  if (receiverId) {
    await notificationService.createNotification({
      userId: receiverId,
      type: "message_received",
      title: "New message",
      message: `You have a new message from ${sender.fullName || sender.username || "a user"}`,
      actionUrl: null,
      data: { conversationId: String(conv._id) },
    });
  }

  return message;
};

const getMessages = async ({ conversationId, user, page, limit }) => {
  const conversation = await Conversation.findById(conversationId).lean();
  communicationService.assertConversationAccess(conversation, user._id);

  const { page: pageNum, limit: limitNum } = normalizePage(page, limit);
  const skip = (pageNum - 1) * limitNum;

  const [rows, total] = await Promise.all([
    Message.find({ conversationId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate("senderId", "fullName username profileImage")
      .lean(),
    Message.countDocuments({ conversationId }),
  ]);

  return {
    messages: rows,
    pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
  };
};

const markRead = async ({ messageId, user }) => {
  const message = await Message.findById(messageId);
  if (!message) throw new AppError("Message not found", 404, "MESSAGE_NOT_FOUND");

  const myId = String(user._id);
  const isReceiver = String(message.receiverId?._id || message.receiverId) === myId;
  const isSender = String(message.senderId?._id || message.senderId) === myId;
  if (!isReceiver && !isSender) {
    throw new AppError("You are not authorized to access this message", 403, "MESSAGE_ACCESS_DENIED");
  }
  // Only the recipient's read marks the read receipt.
  if (!isReceiver) {
    throw new AppError("Only the recipient can mark this message as read", 403, "MESSAGE_ACCESS_DENIED");
  }

  if (!message.readAt) {
    message.readAt = new Date();
    await message.save();
  }
  return message;
};

module.exports = {
  sendMessage,
  getMessages,
  markRead,
  validateAttachments,
};

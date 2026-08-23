const Conversation = require("../models/Conversation");
const User = require("../models/User");
const Order = require("../models/Order");
const communicationService = require("./communication.service");
const AppError = require("../utils/AppError");
const config = require("../config/communicationConfig");

/**
 * Conversation service — creation + retrieval.
 *
 * Direct conversations are unique per participant pair and order conversations
 * are unique per order (enforced by the unique `conversationKey`). All lookups
 * are race-safe: a duplicate-key error falls back to fetching the existing
 * record.
 */

const normalizePage = (page, limit) => ({
  page: Math.max(1, Number(page) || 1),
  limit: Math.min(config.maxPageLimit, Math.max(1, Number(limit) || config.defaultPageLimit)),
});

const findOrCreateDirectConversation = async ({ user, otherUserId }) => {
  if (String(user._id) === String(otherUserId)) {
    throw new AppError("You cannot start a conversation with yourself", 400, "VALIDATION_ERROR");
  }

  const recipient = await User.findById(otherUserId).lean();
  if (!recipient) {
    throw new AppError("Recipient not found", 404, "USER_NOT_FOUND");
  }

  const existing = await Conversation.findOne({
    type: "direct",
    participants: { $all: [user._id, otherUserId], $size: 2 },
  }).lean();
  if (existing) return existing;

  try {
    return await Conversation.create({
      type: "direct",
      participants: [user._id, otherUserId],
    });
  } catch (error) {
    if (error.code === 11000) {
      const again = await Conversation.findOne({
        type: "direct",
        participants: { $all: [user._id, otherUserId], $size: 2 },
      }).lean();
      if (again) return again;
    }
    throw error;
  }
};

const findOrCreateOrderConversation = async ({ user, orderId }) => {
  const order = await Order.findById(orderId).lean();
  await communicationService.assertOrderAccess(order, user);

  const buyerId = order.buyerId?._id || order.buyerId;
  const sellerId = order.sellerId?._id || order.sellerId;
  const key = `o:${String(orderId)}`;

  const existing = await Conversation.findOne({ conversationKey: key }).lean();
  if (existing) return existing;

  try {
    return await Conversation.create({
      type: "order",
      orderId,
      participants: [buyerId, sellerId],
    });
  } catch (error) {
    if (error.code === 11000) {
      const again = await Conversation.findOne({ conversationKey: key }).lean();
      if (again) return again;
    }
    throw error;
  }
};

const listConversations = async ({ user, page, limit }) => {
  const { page: pageNum, limit: limitNum } = normalizePage(page, limit);
  const skip = (pageNum - 1) * limitNum;
  const query = { participants: user._id };

  const [rows, total] = await Promise.all([
    Conversation.find(query)
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate("participants", "fullName username profileImage")
      .populate("lastMessageId", "content type senderId createdAt readAt")
      .lean(),
    Conversation.countDocuments(query),
  ]);

  return {
    conversations: rows,
    pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
  };
};

const getConversationById = async ({ conversationId, userId }) => {
  const conversation = await Conversation.findById(conversationId)
    .populate("participants", "fullName username profileImage")
    .populate("lastMessageId", "content type senderId createdAt readAt")
    .lean();
  communicationService.assertConversationAccess(conversation, userId);
  return conversation;
};

module.exports = {
  findOrCreateDirectConversation,
  findOrCreateOrderConversation,
  listConversations,
  getConversationById,
};

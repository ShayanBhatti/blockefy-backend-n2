const mongoose = require("mongoose");

/**
 * Message model.
 *
 * Messages always belong to an existing Conversation and are written by an
 * authenticated participant (senderId is set server-side, never trusted from
 * the client). Text content is sanitized by message.service before it is
 * persisted. Only metadata/pointers are stored — file bytes live on Cloudinary.
 */
const messageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    receiverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    type: {
      type: String,
      enum: ["text", "image", "file", "system"],
      default: "text",
    },
    content: {
      type: String,
      default: "",
    },
    attachments: [
      {
        name: { type: String, default: "" },
        url: { type: String, default: "" },
        publicId: { type: String, default: "" },
        mimeType: { type: String, default: "" },
        extension: { type: String, default: "" },
        size: { type: Number, default: 0 },
      },
    ],
    readAt: {
      type: Date,
      default: null,
    },
    deliveredAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

/* ------------------------------------------------------------------ */
/* Indexes (based on actual query patterns)                            */
/* ------------------------------------------------------------------ */

// Timeline pagination: newest messages of a conversation first.
messageSchema.index({ conversationId: 1, createdAt: -1 });
// Per-sender listing.
messageSchema.index({ conversationId: 1, senderId: 1, createdAt: -1 });
// Unread counts per receiver.
messageSchema.index({ receiverId: 1, readAt: 1, conversationId: 1 });

const Message = mongoose.models.Message || mongoose.model("Message", messageSchema);

module.exports = Message;

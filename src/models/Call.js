const mongoose = require("mongoose");
const { callStatuses, callTypes } = require("../config/communicationConfig");

/**
 * Call model — metadata only.
 *
 * The actual audio/video stream is transported by LiveKit Cloud. MongoDB only
 * records the call lifecycle: participants, room, status transitions, timings
 * and duration. roomName must match the LiveKit room the access token grants.
 */
const callSchema = new mongoose.Schema(
  {
    callerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    receiverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      default: null,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    roomName: {
      type: String,
      required: true,
    },
    callType: {
      type: String,
      enum: callTypes,
      required: true,
    },
    status: {
      type: String,
      enum: callStatuses,
      default: "ringing",
    },
    startedAt: {
      type: Date,
      default: null,
    },
    answeredAt: {
      type: Date,
      default: null,
    },
    endedAt: {
      type: Date,
      default: null,
    },
    duration: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

/* ------------------------------------------------------------------ */
/* Indexes (based on actual query patterns)                            */
/* ------------------------------------------------------------------ */

callSchema.index({ callerId: 1, createdAt: -1 });
callSchema.index({ receiverId: 1, createdAt: -1 });
callSchema.index({ conversationId: 1, createdAt: -1 });
callSchema.index({ roomName: 1 }, { unique: true });
callSchema.index({ status: 1, createdAt: -1 });

const Call = mongoose.models.Call || mongoose.model("Call", callSchema);

module.exports = Call;

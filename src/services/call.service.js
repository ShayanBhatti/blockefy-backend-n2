const mongoose = require("mongoose");
const Call = require("../models/Call");
const Conversation = require("../models/Conversation");
const Order = require("../models/Order");
const User = require("../models/User");
const communicationService = require("./communication.service");
const livekitService = require("./livekit.service");
const realtimeService = require("./realtime.service");
const notificationService = require("./notification.service");
const AppError = require("../utils/AppError");
const config = require("../config/communicationConfig");
const logger = require("../utils/logger");

/**
 * Call service — call lifecycle.
 *
 * Call state machine (guarded transitions):
 *   ringing  -> accepted (receiver) | rejected (receiver) | cancelled (caller)
 *            -> missed (system/any) | ended (caller)
 *   accepted -> active (webhook: participant_joined) | ended (either party)
 *   active   -> ended (either party)
 *
 * LiveKit webhooks drive the "active" and "ended" transitions and are made
 * idempotent by the caller (webhookController) via the WebhookEventLog ledger
 * plus atomic status-guarded updates below.
 */

const CALLER = "caller";
const RECEIVER = "receiver";

const TRANSITIONS = {
  ringing: {
    accepted: RECEIVER,
    rejected: RECEIVER,
    cancelled: CALLER,
    missed: "any",
    ended: CALLER,
  },
  accepted: {
    active: "system",
    ended: "any",
  },
  active: {
    ended: "any",
  },
};

const JOINABLE_STATUSES = ["ringing", "accepted", "active"];
const TERMINAL_STATUSES = ["rejected", "cancelled", "missed", "ended", "failed"];

/**
 * Reusable state-machine helpers exported for controllers/tests/other services.
 */
const getAllowedTransitions = (status) => TRANSITIONS[status] || {};

const canTransition = (currentStatus, nextStatus, actor) => {
  const allowed = getAllowedTransitions(currentStatus);
  if (!allowed || !allowed[nextStatus]) return { allowed: false, reason: "transition_not_allowed" };
  const required = allowed[nextStatus];
  if (required !== "any" && required !== actor) {
    return { allowed: false, reason: "actor_not_authorized" };
  }
  return { allowed: true, requiredActor: required };
};

const isJoinableStatus = (status) => JOINABLE_STATUSES.includes(status);

const isTerminalStatus = (status) => TERMINAL_STATUSES.includes(status);

const populateCall = (call) =>
  Call.populate(call, [
    { path: "callerId", select: "fullName username profileImage" },
    { path: "receiverId", select: "fullName username profileImage" },
  ]);

const computeDuration = (call, endedAt) => {
  if (!call) return 0;
  const start = call.answeredAt || call.startedAt || call.createdAt;
  if (!start || !endedAt) return 0;
  const ms = new Date(endedAt).getTime() - new Date(start).getTime();
  return ms > 0 ? Math.round(ms / 1000) : 0;
};

const getActor = (call, user) => {
  if (String(call.callerId?._id || call.callerId) === String(user._id)) return CALLER;
  if (String(call.receiverId?._id || call.receiverId) === String(user._id)) return RECEIVER;
  return null;
};

const assertParticipant = (call, user) => {
  if (!getActor(call, user)) {
    throw new AppError("You are not a participant of this call", 403, "CALL_ACCESS_DENIED");
  }
};

/**
 * Atomically apply a validated transition and emit the matching event.
 * The status guard in the query prevents races (e.g. double-accept).
 */
const applyTransition = async (call, status, user) => {
  const now = new Date();
  const set = { status };
  if (status === "accepted") {
    set.answeredAt = now;
  } else if (status === "ended") {
    set.endedAt = now;
    set.duration = computeDuration(call, now);
  } else if (["rejected", "cancelled", "missed"].includes(status)) {
    set.endedAt = now;
    set.duration = 0;
  }

  const updated = await Call.findOneAndUpdate(
    { _id: call._id, status: call.status },
    { $set: set },
    { new: true }
  );
  if (!updated) throw new AppError("Call status changed; please refresh", 409, "INVALID_CALL_STATUS");

  const populated = await populateCall(updated);
  const payload = { call: communicationService.serializeCall(populated) };

  if (status === "accepted") emitCallEvent(populated, "call:accepted", payload);
  else if (status === "rejected") emitCallEvent(populated, "call:rejected", payload);
  else if (status === "cancelled") emitCallEvent(populated, "call:cancelled", payload);
  else if (status === "missed") emitCallEvent(populated, "call:missed", payload);
  else if (status === "ended") emitCallEvent(populated, "call:ended", payload);

  return populated;
};

const emitCallEvent = (call, event, payload) => {
  const participants = [call.callerId?._id || call.callerId, call.receiverId?._id || call.receiverId]
    .filter(Boolean)
    .map(String);
  for (const userId of participants) {
    realtimeService.emitToUser(userId, event, payload);
  }
};

/* ------------------------------------------------------------------ */
/* Creation                                                            */
/* ------------------------------------------------------------------ */

const createCall = async ({ caller, receiverId, conversationId, orderId, callType }) => {
  if (!config.callTypes.includes(callType)) {
    throw new AppError("Invalid call type", 400, "VALIDATION_ERROR");
  }

  let conversation = null;
  let receiver = null;

  if (conversationId) {
    conversation = await Conversation.findById(conversationId).lean();
    communicationService.assertConversationAccess(conversation, caller._id);
    const otherId = (conversation.participants || []).find(
      (p) => String(p?._id || p) !== String(caller._id)
    );
    receiver = otherId ? await User.findById(otherId._id || otherId).lean() : null;
  } else {
    if (!receiverId) {
      throw new AppError("receiverId is required", 400, "VALIDATION_ERROR");
    }
    receiver = await User.findById(receiverId).lean();
  }

  if (!receiver) throw new AppError("Receiver not found", 404, "USER_NOT_FOUND");
  if (String(receiver._id) === String(caller._id)) {
    throw new AppError("You cannot call yourself", 400, "VALIDATION_ERROR");
  }
  if (receiver.isSuspended) {
    throw new AppError("This user is not available to take calls", 409, "FORBIDDEN");
  }

  if (orderId) {
    const order = await Order.findById(orderId).lean();
    await communicationService.assertOrderAccess(order, caller);
    if (conversation && (conversation.type !== "order" || String(conversation.orderId) !== String(orderId))) {
      throw new AppError("Conversation is not associated with this order", 403, "CALL_ACCESS_DENIED");
    }
    const buyerId = String(order.buyerId?._id || order.buyerId);
    const sellerId = String(order.sellerId?._id || order.sellerId);
    if (![buyerId, sellerId].includes(String(receiver._id))) {
      throw new AppError("Receiver is not a party of this order", 403, "CALL_ACCESS_DENIED");
    }
  }

  const callId = new mongoose.Types.ObjectId();
  const roomName = livekitService.createRoomName({ callId });
  const call = await Call.create({
    _id: callId,
    callerId: caller._id,
    receiverId: receiver._id,
    conversationId: conversation ? conversation._id : null,
    orderId: orderId || null,
    roomName,
    callType,
    status: "ringing",
    startedAt: new Date(),
  });

  logger.info("call_initiated", {
    callId: String(call._id),
    roomName,
    callType,
    callerId: String(caller._id),
    receiverId: String(receiver._id),
    conversationId: conversation ? String(conversation._id) : null,
    orderId: orderId ? String(orderId) : null,
  });

  await notificationService.createNotification({
    userId: receiver._id,
    type: "incoming_call",
    title: `${callType === "video" ? "Video" : "Voice"} call`,
    message: `${caller.fullName || caller.username || "Someone"} is calling you`,
    data: { callId: String(call._id), callType },
  });

  const populated = await populateCall(call.toObject());
  const payload = { call: communicationService.serializeCall(populated) };
  realtimeService.emitToUser(receiver._id, "call:incoming", payload);
  realtimeService.emitToUser(caller._id, "call:ringing", payload);

  return populated;
};

/* ------------------------------------------------------------------ */
/* Querying                                                            */
/* ------------------------------------------------------------------ */

const getCallById = async ({ callId, user }) => {
  const call = await Call.findById(callId);
  communicationService.assertCallAccess(call, user._id);
  return populateCall(call);
};

const listCalls = async ({ user, page, limit, filters = {} }) => {
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(config.maxPageLimit, Math.max(1, Number(limit) || config.defaultPageLimit));
  const skip = (pageNum - 1) * limitNum;

  // Caller/receiver guard is the foundation: users only see their own calls.
  const query = {
    $or: [{ callerId: user._id }, { receiverId: user._id }],
  };

  const { callType, status, conversationId, orderId } = filters;
  if (callType) query.callType = callType;
  if (status) query.status = status;
  if (conversationId) query.conversationId = new mongoose.Types.ObjectId(conversationId);
  if (orderId) query.orderId = new mongoose.Types.ObjectId(orderId);

  const [rows, total] = await Promise.all([
    Call.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate("callerId", "fullName username profileImage")
      .populate("receiverId", "fullName username profileImage")
      .lean(),
    Call.countDocuments(query),
  ]);

  logger.debug("call_list_fetched", {
    userId: String(user._id),
    filters: { callType, status, conversationId, orderId },
    total,
    page: pageNum,
    limit: limitNum,
  });

  return {
    calls: rows,
    pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
  };
};

/* ------------------------------------------------------------------ */
/* State transitions (client-initiated)                                */
/* ------------------------------------------------------------------ */

const updateCallStatus = async ({ callId, user, status }) => {
  const call = await Call.findById(callId);
  if (!call) throw new AppError("Call not found", 404, "CALL_NOT_FOUND");

  assertParticipant(call, user);
  const actor = getActor(call, user);
  const transition = canTransition(call.status, status, actor);
  if (!transition.allowed) {
    if (transition.reason === "actor_not_authorized") {
      throw new AppError("You are not authorized to perform this action", 403, "CALL_ACCESS_DENIED");
    }
    throw new AppError("Invalid call status transition", 409, "INVALID_CALL_STATUS");
  }

  const result = await applyTransition(call, status, user);
  logger.info("call_status_changed", {
    callId: String(call._id),
    roomName: call.roomName,
    fromStatus: call.status,
    toStatus: status,
    actor,
    userId: String(user._id),
  });
  return result;
};

/* Convenience wrappers for dedicated endpoints. */
const acceptCall = (params) => updateCallStatus({ ...params, status: "accepted" });
const rejectCall = (params) => updateCallStatus({ ...params, status: "rejected" });
const cancelCall = (params) => updateCallStatus({ ...params, status: "cancelled" });
const endCall = (params) => updateCallStatus({ ...params, status: "ended" });

/* ------------------------------------------------------------------ */
/* LiveKit token (short-lived room join)                               */
/* ------------------------------------------------------------------ */

const getCallToken = async ({ callId, user, callType }) => {
  const call = await Call.findById(callId);
  communicationService.assertCallAccess(call, user._id);

  if (!isJoinableStatus(call.status)) {
    throw new AppError("This call is no longer joinable", 409, "INVALID_CALL_STATUS");
  }
  if (callType && callType !== call.callType) {
    throw new AppError("Call type does not match this call", 400, "VALIDATION_ERROR");
  }

  const token = await livekitService.generateParticipantToken({
    identity: user._id,
    name: user.fullName || user.username,
    room: call.roomName,
    metadata: JSON.stringify({ callId: String(call._id), callType: call.callType, userId: String(user._id) }),
  });

  logger.info("call_token_issued", {
    callId: String(call._id),
    roomName: call.roomName,
    userId: String(user._id),
    status: call.status,
  });

  return {
    token,
    serverUrl: livekitService.getLiveKitUrl(),
    roomName: call.roomName,
    callId: call._id,
    callType: call.callType,
  };
};

/* ------------------------------------------------------------------ */
/* LiveKit webhook sync (idempotent)                                   */
/* ------------------------------------------------------------------ */

/**
 * @param {Object} event - LiveKit WebhookEvent (from WebhookReceiver)
 */
const syncFromWebhook = async (event) => {
  const eventName = event?.event || "";
  const roomName = event?.room?.name || "";
  if (!roomName || !config.livekitEvents.includes(eventName)) {
    logger.debug("webhook_ignored", { event: eventName, roomName, reason: "unsupported_or_missing_room" });
    return { ignored: true };
  }

  const call = await Call.findOne({ roomName });
  if (!call) {
    logger.debug("webhook_room_not_found", { event: eventName, roomName });
    return { ignored: true, reason: "room_not_found" };
  }

  logger.info("webhook_received", {
    event: eventName,
    roomName,
    callId: String(call._id),
    callStatus: call.status,
  });

  let changed = null;
  const now = new Date();

  if (eventName === "room_started") {
    // A participant actually entered the room → the call is live.
    if (call.status === "ringing" || call.status === "accepted") {
      changed = await Call.findOneAndUpdate(
        { _id: call._id, status: { $in: ["ringing", "accepted"] } },
        { $set: { status: "active", answeredAt: call.answeredAt || now } },
        { new: true }
      );
    }
  } else if (eventName === "participant_joined") {
    if (call.status === "ringing") {
      changed = await Call.findOneAndUpdate(
        { _id: call._id, status: "ringing" },
        { $set: { status: "active", answeredAt: now } },
        { new: true }
      );
    } else if (call.status === "accepted") {
      changed = await Call.findOneAndUpdate(
        { _id: call._id, status: "accepted" },
        { $set: { answeredAt: call.answeredAt || now } },
        { new: true }
      );
    }
  } else if (eventName === "room_finished") {
    if (["active", "accepted"].includes(call.status) && call.answeredAt) {
      changed = await Call.findOneAndUpdate(
        { _id: call._id, status: { $in: ["active", "accepted"] } },
        { $set: { status: "ended", endedAt: now, duration: computeDuration(call, now) } },
        { new: true }
      );
    } else if (call.status === "ringing" || call.status === "accepted") {
      // Never answered → missed call.
      changed = await Call.findOneAndUpdate(
        { _id: call._id, status: { $in: ["ringing", "accepted"] } },
        { $set: { status: "missed", endedAt: now, duration: 0 } },
        { new: true }
      );
    }
  } else if (eventName === "participant_left" || eventName === "participant_connection_aborted") {
    // Presence bookkeeping only; room_finished decides the terminal state.
    return { ignored: true, reason: "participant_departure" };
  }

  if (changed) {
    const populated = await populateCall(changed);
    const payload = { call: communicationService.serializeCall(populated) };
    if (changed.status === "ended") {
      emitCallEvent(populated, "call:ended", payload);
    } else if (changed.status === "missed") {
      emitCallEvent(populated, "call:missed", payload);
    } else if (changed.status === "active") {
      emitCallEvent(populated, "call:accepted", payload);
    }
    logger.info("webhook_call_synced", {
      event: eventName,
      roomName,
      callId: String(call._id),
      fromStatus: call.status,
      toStatus: changed.status,
      duration: changed.duration,
    });
    return { call: communicationService.serializeCall(populated), event: eventName };
  }

  logger.debug("webhook_no_state_change", { event: eventName, roomName, callId: String(call._id), callStatus: call.status });
  return { ignored: true, reason: "no_state_change" };
};

module.exports = {
  createCall,
  getCallById,
  listCalls,
  updateCallStatus,
  acceptCall,
  rejectCall,
  cancelCall,
  endCall,
  getCallToken,
  syncFromWebhook,
  computeDuration,
  canTransition,
  getAllowedTransitions,
  isJoinableStatus,
  isTerminalStatus,
  CALLER,
  RECEIVER,
};

const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Conversation = require("../models/Conversation");
const messageService = require("./message.service");
const communicationService = require("./communication.service");
const logger = require("../utils/logger");

/**
 * Realtime service (Socket.IO).
 *
 * - Authenticated via the same JWT used by the REST API (handshake.auth.token
 *   or Authorization header). The socket identity is ALWAYS taken from the
 *   verified token, never from the client payload.
 * - Rooms: `user:<userId>` (per-user inbox) and `conversation:<id>` (chat room).
 * - Server->client events:
 *     message:new, message:delivered, message:read, conversation:updated
 *     typing:start, typing:stop
 *     call:incoming, call:ringing, call:accepted, call:rejected,
 *     call:cancelled, call:ended, call:missed
 * - Client->server events:
 *     conversation:join, conversation:leave, typing:start, typing:stop,
 *     message:send, message:read
 */

let io = null;

const init = (server) => {
  if (io) return io;

  io = new Server(server, {
    cors: {
      origin: process.env.FRONTEND_URL || true,
      credentials: true,
    },
    maxHttpBufferSize: 1e6,
  });

  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        (socket.handshake.headers?.authorization || "").replace(/^Bearer\s+/i, "");
      if (!token) return next(new Error("No token provided"));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.userId).lean();
      if (!user) return next(new Error("User no longer exists"));
      if (user.isSuspended) return next(new Error("Account suspended"));

      socket.user = {
        _id: user._id,
        userId: user._id,
        fullName: user.fullName,
        username: user.username,
      };
      logger.info("socket_connected", { userId: String(user._id), socketId: socket.id });
      next();
    } catch (error) {
      logger.warn("socket_auth_failed", { socketId: socket.id, reason: error.message });
      return next(new Error("Unauthorized"));
    }
  });

  io.on("connection", async (socket) => {
    const userId = String(socket.user._id);
    socket.join(`user:${userId}`);

    // Auto-join every conversation the user participates in so message:new /
    // message:read / typing events reach them regardless of the active view.
    // Authorization is implicit: only conversations listing this user are joined.
    try {
      const memberships = await Conversation.find({ participants: socket.user._id })
        .select("_id")
        .lean();
      for (const membership of memberships) {
        socket.join(`conversation:${String(membership._id)}`);
      }
    } catch (error) {
      // Non-fatal: the client can still join rooms explicitly via
      // conversation:join (which re-checks participation).
    }

    socket.on("conversation:join", async ({ conversationId }, ack) => {
      try {
        const conversation = await Conversation.findById(conversationId).lean();
        communicationService.assertConversationAccess(conversation, socket.user._id);
        socket.join(`conversation:${conversationId}`);
        if (typeof ack === "function") ack({ success: true });
      } catch (error) {
        if (typeof ack === "function") ack({ success: false, message: error.message });
      }
    });

    socket.on("conversation:leave", ({ conversationId }, ack) => {
      socket.leave(`conversation:${conversationId}`);
      if (typeof ack === "function") ack({ success: true });
    });

    socket.on("typing:start", async ({ conversationId }, ack) => {
      try {
        const conversation = await Conversation.findById(conversationId).lean();
        communicationService.assertConversationAccess(conversation, socket.user._id);
        socket.to(`conversation:${conversationId}`).emit("typing:start", {
          conversationId,
          user: communicationService.profileSummary(socket.user),
        });
        if (typeof ack === "function") ack({ success: true });
      } catch (error) {
        if (typeof ack === "function") ack({ success: false, message: error.message });
      }
    });

    socket.on("typing:stop", async ({ conversationId }, ack) => {
      try {
        const conversation = await Conversation.findById(conversationId).lean();
        communicationService.assertConversationAccess(conversation, socket.user._id);
        socket.to(`conversation:${conversationId}`).emit("typing:stop", {
          conversationId,
          user: communicationService.profileSummary(socket.user),
        });
        if (typeof ack === "function") ack({ success: true });
      } catch (error) {
        if (typeof ack === "function") ack({ success: false, message: error.message });
      }
    });

    socket.on("message:send", async ({ conversationId, type, content, attachments }, ack) => {
      try {
        const message = await messageService.sendMessage({
          conversationId,
          sender: socket.user,
          type,
          content,
          attachments,
        });
        const payload = { conversationId, message: communicationService.serializeMessage(message) };
        io.to(`conversation:${conversationId}`).emit("message:new", payload);
        socket.emit("message:delivered", payload);
        io.to(`user:${userId}`).emit("conversation:updated", { conversationId });
        if (typeof ack === "function") ack({ success: true, message: payload.message });
      } catch (error) {
        if (typeof ack === "function") ack({ success: false, message: error.message });
      }
    });

    socket.on("message:read", async ({ messageId }, ack) => {
      try {
        const message = await messageService.markRead({ messageId, user: socket.user });
        const payload = {
          messageId: String(message._id),
          conversationId: String(message.conversationId),
          readAt: message.readAt,
        };
        io.to(`conversation:${message.conversationId}`).emit("message:read", payload);
        if (typeof ack === "function") ack({ success: true, ...payload });
      } catch (error) {
        if (typeof ack === "function") ack({ success: false, message: error.message });
      }
    });

    const handleCallAction = (action) => async ({ callId } = {}, ack) => {
      try {
        if (!callId) throw new Error("callId is required");
        const callService = require("./call.service");
        const call = await callService[action]({ callId, user: socket.user });
        if (typeof ack === "function") ack({
          success: true,
          call: communicationService.serializeCall(call),
        });
      } catch (error) {
        if (typeof ack === "function") ack({
          success: false,
          message: error.message,
          code: error.code,
        });
      }
    };

    socket.on("call:accepted", handleCallAction("acceptCall"));
    socket.on("call:rejected", handleCallAction("rejectCall"));
    socket.on("call:cancelled", handleCallAction("cancelCall"));
    socket.on("call:ended", handleCallAction("endCall"));

    socket.on("disconnect", () => {
      logger.info("socket_disconnected", { userId: String(socket.user._id), socketId: socket.id });
      socket.leave(`user:${userId}`);
    });
  });

  return io;
};

const getIo = () => io;

const emitToUser = (userId, event, payload) => {
  if (!io) return;
  io.to(`user:${String(userId)}`).emit(event, payload);
};

const emitToConversation = (conversationId, event, payload) => {
  if (!io) return;
  io.to(`conversation:${String(conversationId)}`).emit(event, payload);
};

module.exports = {
  init,
  getIo,
  emitToUser,
  emitToConversation,
};

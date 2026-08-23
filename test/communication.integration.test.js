/**
 * Communication module tests: conversations, messages, calls, webhooks.
 *
 * Requires a live MongoDB (like orderFlow.integration.test.js):
 *
 *   $env:TEST_MONGODB_URI="mongodb://127.0.0.1:27017/blockefy_test"
 *   npm test
 *
 * Skips cleanly when TEST_MONGODB_URI is not set. LiveKit credentials are
 * mocked (dev key/secret) so token generation and webhook verification run
 * without contacting LiveKit Cloud.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const URI = process.env.TEST_MONGODB_URI;
const skip = URI ? false : true;

// Mock LiveKit config so token + webhook paths run locally.
const LIVEKIT_API_KEY = "devkey";
const LIVEKIT_API_SECRET = "devsecret";
if (!skip) {
  process.env.LIVEKIT_API_KEY = LIVEKIT_API_KEY;
  process.env.LIVEKIT_API_SECRET = LIVEKIT_API_SECRET;
  process.env.LIVEKIT_URL = "wss://dev.livekit.cloud";
}

const User = require("../src/models/User");
const Order = require("../src/models/Order");
const Conversation = require("../src/models/Conversation");
const Message = require("../src/models/Message");
const Call = require("../src/models/Call");
const WebhookEventLog = require("../src/models/WebhookEventLog");
const Notification = require("../src/models/Notification");
const conversationService = require("../src/services/conversation.service");
const messageService = require("../src/services/message.service");
const callService = require("../src/services/call.service");
const livekitService = require("../src/services/livekit.service");
const communicationService = require("../src/services/communication.service");
const { markExpiredMissedCalls } = require("../src/jobs/call.job");
const config = require("../src/config/communicationConfig");

const express = require("express");
const communicationRoutes = require("../src/routes/communicationRoutes");
const callRoutes = require("../src/routes/callRoutes");
const livekitWebhookRoutes = require("../src/routes/livekitWebhookRoutes");
const webhookController = require("../src/controllers/webhookController");
const errorHandler = require("../src/middleware/errorHandler");
const { Server } = require("socket.io");
const { io: Client } = require("socket.io-client");
const http = require("http");

let buyer, seller, outsider, order, conversation, app, server, baseUrl;
let httpServer = null; // Socket.IO test server

const it = (name, fn) =>
  test(name, { skip }, async (t) => {
    try {
      await fn(t);
    } catch (error) {
      assert.fail(error.message);
    }
  });

before(async () => {
  if (skip) return;

  await mongoose.connect(URI, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([
    User.deleteMany({}),
    Order.deleteMany({}),
    Conversation.deleteMany({}),
    Message.deleteMany({}),
    Call.deleteMany({}),
    WebhookEventLog.deleteMany({}),
    Notification.deleteMany({}),
    require("../src/models/OrderCounter").deleteMany({}),
  ]);

  buyer = await User.create({
    username: "buyer_comm",
    email: `buyer_comm${Date.now()}@test.com`,
    password: "testpass123",
    role: "buyer",
    isEmailVerified: true,
  });
  seller = await User.create({
    username: "seller_comm",
    email: `seller_comm${Date.now()}@test.com`,
    password: "testpass123",
    role: "seller",
    isEmailVerified: true,
  });
  outsider = await User.create({
    username: "outsider_comm",
    email: `outsider_comm${Date.now()}@test.com`,
    password: "testpass123",
    role: "buyer",
    isEmailVerified: true,
  });

  order = await Order.create({
    orderNumber: `BLK-TEST-${Date.now()}`,
    buyerId: buyer._id,
    sellerId: seller._id,
    gigId: new mongoose.Types.ObjectId(),
    status: "IN_PROGRESS",
    projectTitle: "Communication test order",
    packageSnapshot: {
      name: "Basic",
      price: 100,
      deliveryDays: 5,
      revisions: 1,
      features: [],
    },
    pricing: {
      currency: "USD",
      packagePriceCents: 10000,
      subtotalCents: 10000,
      platformFeeCents: 1000,
      totalCents: 11000,
    },
    payment: { method: "wallet", provider: "mock", status: "confirmed", paidAt: new Date() },
  });

  conversation = await conversationService.findOrCreateDirectConversation({
    user: buyer,
    otherUserId: seller._id,
  });

  // Express app with the real routes for HTTP-level tests.
  // IMPORTANT: webhook routes are mounted BEFORE the JSON parser so the raw
  // signed body survives — same ordering as index.js.
  app = express();
  app.use("/api/webhooks", livekitWebhookRoutes);
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", communicationRoutes);
  app.use("/api/calls", callRoutes);
  app.use(errorHandler);
  app.use((req, res) => res.status(404).json({ success: false, message: "Not found" }));

  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (skip) return;
  if (server) await new Promise((resolve) => server.close(resolve));
  if (httpServer) {
    const ioInstance = require("../src/services/realtime.service").getIo();
    if (ioInstance) ioInstance.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
  await mongoose.connection.close();
});

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

const tokenFor = (user) => jwt.sign({ userId: String(user._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });

const authHeaders = (user) => ({ Authorization: `Bearer ${tokenFor(user)}` });

const signWebhookHeader = (bodyString) => {
  const sha256 = crypto.createHash("sha256").update(bodyString).digest("base64");
  return jwt.sign(
    { sha256, iss: LIVEKIT_API_KEY },
    LIVEKIT_API_SECRET,
    { algorithm: "HS256", expiresIn: "10m" }
  );
};

const makeWebhookBody = (eventName, call) =>
  JSON.stringify({
    id: `${eventName}-${Date.now()}`,
    event: eventName,
    createdAt: Math.floor(Date.now() / 1000),
    room: { name: call.roomName },
  });

/* ============================ Auth ============================= */

it("call token endpoint rejects unauthenticated requests (401)", async () => {
  const call = await callService.createCall({
    caller: buyer,
    conversationId: conversation._id,
    callType: "voice",
  });
  const res = await fetch(`${baseUrl}/api/calls/${call._id}/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
});

/* ====================== Conversation access ===================== */

it("rejects access to a conversation the user is not part of (403)", async () => {
  await assert.rejects(
    conversationService.getConversationById({ conversationId: conversation._id, userId: outsider._id }),
    (err) => err.code === "CONVERSATION_ACCESS_DENIED"
  );
});

it("rejects sending a message into a conversation the user is not part of (403)", async () => {
  await assert.rejects(
    messageService.sendMessage({
      conversationId: conversation._id,
      sender: outsider,
      content: "intrusion",
    }),
    (err) => err.code === "CONVERSATION_ACCESS_DENIED"
  );
});

/* ========================= Messages ============================= */

it("creates a message and updates the conversation last-message pointer", async () => {
  const message = await messageService.sendMessage({
    conversationId: conversation._id,
    sender: buyer,
    content: "Hello seller!",
  });
  assert.ok(message._id);
  assert.equal(String(message.senderId), String(buyer._id));
  assert.equal(String(message.receiverId), String(seller._id));
  assert.equal(message.content, "Hello seller!");
  assert.ok(message.deliveredAt);

  const updated = await Conversation.findById(conversation._id).lean();
  assert.equal(String(updated.lastMessageId), String(message._id));
  assert.ok(updated.lastMessageAt);
});

it("rejects empty text messages and over-long messages", async () => {
  await assert.rejects(
    messageService.sendMessage({ conversationId: conversation._id, sender: buyer, content: "   " }),
    (err) => err.code === "VALIDATION_ERROR"
  );
  await assert.rejects(
    messageService.sendMessage({
      conversationId: conversation._id,
      sender: buyer,
      content: "x".repeat(6000),
    }),
    (err) => err.code === "VALIDATION_ERROR"
  );
});

it("sanitizes HTML out of message content", async () => {
  const message = await messageService.sendMessage({
    conversationId: conversation._id,
    sender: buyer,
    content: "Hello <script>alert(1)</script> world",
  });
  // Tags must be gone (no executable markup may survive).
  assert.equal(message.content.includes("<script>"), false);
  assert.equal(message.content.includes("</script>"), false);
  assert.ok(!/[<>]/.test(message.content), "no raw angle brackets should remain");
});

it("paginates messages", async () => {
  for (let i = 0; i < 5; i += 1) {
    await messageService.sendMessage({ conversationId: conversation._id, sender: seller, content: `msg ${i}` });
  }
  const page1 = await messageService.getMessages({ conversationId: conversation._id, user: buyer, page: 1, limit: 2 });
  assert.equal(page1.messages.length, 2);
  assert.equal(page1.pagination.totalPages, Math.ceil(page1.pagination.total / 2));
  assert.ok(page1.pagination.total >= 7);
  // Newest first.
  const first = page1.messages[0];
  const second = page1.messages[1];
  assert.ok(new Date(first.createdAt) >= new Date(second.createdAt));

  // Page 2 returns a different, older slice without overlap.
  const page2 = await messageService.getMessages({ conversationId: conversation._id, user: buyer, page: 2, limit: 2 });
  assert.equal(page2.messages.length, 2);
  assert.notEqual(String(page1.messages[0]._id), String(page2.messages[0]._id));
});

it("marks a message read only for the recipient (read receipt)", async () => {
  const message = await messageService.sendMessage({ conversationId: conversation._id, sender: buyer, content: "read me" });

  // Sender cannot mark read.
  await assert.rejects(
    messageService.markRead({ messageId: message._id, user: buyer }),
    (err) => err.code === "MESSAGE_ACCESS_DENIED"
  );

  const read = await messageService.markRead({ messageId: message._id, user: seller });
  assert.ok(read.readAt);
});

/* ============================ Calls ============================= */

it("creates a ringing call between participants", async () => {
  const call = await callService.createCall({
    caller: buyer,
    conversationId: conversation._id,
    callType: "video",
  });
  assert.equal(call.status, "ringing");
  assert.ok(call.roomName.startsWith("call_"));
  assert.equal(String(call.callerId._id), String(buyer._id));
  assert.equal(String(call.receiverId._id), String(seller._id));

  const listing = await callService.listCalls({ user: buyer });
  assert.ok(listing.calls.length >= 1);
});

it("rejects non-participant access to a call (403)", async () => {
  const call = await callService.createCall({
    caller: buyer,
    conversationId: conversation._id,
    callType: "voice",
  });
  await assert.rejects(
    callService.getCallToken({ callId: call._id, user: outsider }),
    (err) => err.code === "CALL_ACCESS_DENIED"
  );
});

it("rejects invalid call type and self-calls", async () => {
  await assert.rejects(
    callService.createCall({ caller: buyer, receiverId: buyer._id, callType: "voice" }),
    (err) => err.code === "VALIDATION_ERROR"
  );
  await assert.rejects(
    callService.createCall({ caller: buyer, receiverId: seller._id, callType: "hologram" }),
    (err) => err.code === "VALIDATION_ERROR"
  );
});

it("generates a short-lived LiveKit join token for an authorized participant", async () => {
  const call = await callService.createCall({
    caller: buyer,
    conversationId: conversation._id,
    callType: "voice",
  });
  const result = await callService.getCallToken({ callId: call._id, user: seller });
  assert.ok(result.token);
  assert.equal(result.roomName, call.roomName);
  assert.equal(result.serverUrl, "wss://dev.livekit.cloud");

  const claims = jwt.decode(result.token);
  assert.equal(claims.iss, LIVEKIT_API_KEY);
  assert.equal(claims.sub, String(seller._id));
  assert.ok(claims.video.roomJoin);
  assert.equal(claims.video.room, call.roomName);
});

it("enforces call status transitions and actor permissions", async () => {
  const call = await callService.createCall({
    caller: buyer,
    conversationId: conversation._id,
    callType: "voice",
  });

  // Receiver cannot cancel (only caller).
  await assert.rejects(
    callService.updateCallStatus({ callId: call._id, user: seller, status: "cancelled" }),
    (err) => err.code === "CALL_ACCESS_DENIED"
  );

  // Invalid transition ringing -> ended-by-missed is not caller-only (any) but still guarded:
  await assert.rejects(
    callService.updateCallStatus({ callId: call._id, user: outsider, status: "missed" }),
    (err) => err.code === "CALL_ACCESS_DENIED"
  );

  const accepted = await callService.updateCallStatus({ callId: call._id, user: seller, status: "accepted" });
  assert.equal(accepted.status, "accepted");
  assert.ok(accepted.answeredAt);

  const ended = await callService.updateCallStatus({ callId: call._id, user: buyer, status: "ended" });
  assert.equal(ended.status, "ended");
  assert.ok(ended.endedAt);
  assert.ok(Number.isInteger(ended.duration));

  // Terminal state is locked.
  await assert.rejects(
    callService.updateCallStatus({ callId: call._id, user: buyer, status: "accepted" }),
    (err) => err.code === "INVALID_CALL_STATUS"
  );
});

/* =========================== Webhooks =========================== */

it("ignores a webhook with an invalid signature (returns null)", async () => {
  const call = await callService.createCall({
    caller: buyer,
    conversationId: conversation._id,
    callType: "voice",
  });
  const body = makeWebhookBody("room_started", call);
  const event = await livekitService.receiveWebhook(body, "garbage.signature.value");
  assert.equal(event, null);
});

it("processes a valid webhook: room_started activates the call", async () => {
  const call = await callService.createCall({
    caller: buyer,
    conversationId: conversation._id,
    callType: "voice",
  });
  const body = makeWebhookBody("room_started", call);
  const header = signWebhookHeader(body);

  const res = await fetch(`${baseUrl}/api/webhooks/livekit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorize: header },
    body,
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.data.duplicate, false);
  assert.equal(json.data.call.status, "active");

  const persisted = await Call.findById(call._id).lean();
  assert.equal(persisted.status, "active");
});

it("acknowledges duplicate webhook deliveries without reprocessing", async () => {
  const call = await callService.createCall({
    caller: buyer,
    conversationId: conversation._id,
    callType: "voice",
  });
  const body = makeWebhookBody("room_started", call);
  const header = signWebhookHeader(body);

  const first = await (await fetch(`${baseUrl}/api/webhooks/livekit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorize: header },
    body,
  })).json();

  // Same event id → second delivery is a duplicate.
  const second = await (await fetch(`${baseUrl}/api/webhooks/livekit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorize: header },
    body,
  })).json();

  assert.equal(first.data.duplicate, false);
  assert.equal(second.data.duplicate, true);
  assert.equal(await Call.countDocuments({ _id: call._id, status: "active" }), 1);
});

it("marks an unanswered call as missed on room_finished", async () => {
  const call = await callService.createCall({
    caller: buyer,
    conversationId: conversation._id,
    callType: "voice",
  });
  const body = makeWebhookBody("room_finished", call);
  const header = signWebhookHeader(body);

  const res = await fetch(`${baseUrl}/api/webhooks/livekit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorize: header },
    body,
  });
  const json = await res.json();
  assert.equal(json.data.call.status, "missed");
});

it("creates an incoming-call notification for the receiver", async () => {
  const call = await callService.createCall({
    caller: buyer,
    conversationId: conversation._id,
    callType: "voice",
  });
  const notification = await Notification.findOne({
    userId: seller._id,
    type: "incoming_call",
    "data.callId": String(call._id),
  });
  assert.ok(notification, "notification for this exact call should exist");
  assert.equal(notification.data.callType, "voice");
});

it("creates order-scoped conversations and enforces order access", async () => {
  const orderConv = await conversationService.findOrCreateOrderConversation({
    user: buyer,
    orderId: order._id,
  });
  assert.equal(orderConv.type, "order");
  assert.equal(String(orderConv.orderId), String(order._id));

  // Same order returns the same conversation (idempotent).
  const again = await conversationService.findOrCreateOrderConversation({
    user: buyer,
    orderId: order._id,
  });
  assert.equal(String(again._id), String(orderConv._id));

  // Outsider is not a party of the order.
  await assert.rejects(
    conversationService.findOrCreateOrderConversation({ user: outsider, orderId: order._id }),
    (err) => err.code === "ORDER_ACCESS_DENIED" || err.code === "ORDER_NOT_FOUND"
  );
});

it("serializes communication DTOs without leaking sensitive fields", async () => {
  const call = await callService.createCall({
    caller: buyer,
    conversationId: conversation._id,
    callType: "voice",
  });
  const serialized = communicationService.serializeCall(call);
  assert.equal(String(serialized.caller.id), String(buyer._id));
  assert.equal(serialized.callType, "voice");
  assert.equal("email" in serialized.caller, false);
});

/* ================== Spec-shaped endpoints & security ================== */

it("conversation list rejects unauthenticated requests (401)", async () => {
  const res = await fetch(`${baseUrl}/api/conversations`);
  assert.equal(res.status, 401);
});

it("generic POST /api/conversations get-or-create (direct/order) with validation", async () => {
  // Direct: returns the existing conversation for the same pair.
  const direct = await fetch(`${baseUrl}/api/conversations`, {
    method: "POST",
    headers: { ...authHeaders(buyer), "Content-Type": "application/json" },
    body: JSON.stringify({ userId: String(seller._id) }),
  });
  assert.equal(direct.status, 200);
  const dj = await direct.json();
  assert.equal(String(dj.data.conversation.id), String(conversation._id));

  // Order-scoped.
  const orderConvRes = await fetch(`${baseUrl}/api/conversations`, {
    method: "POST",
    headers: { ...authHeaders(seller), "Content-Type": "application/json" },
    body: JSON.stringify({ orderId: String(order._id) }),
  });
  assert.equal(orderConvRes.status, 200);
  const oj = await orderConvRes.json();
  assert.equal(oj.data.conversation.type, "order");

  // Both targets provided -> 400.
  const both = await fetch(`${baseUrl}/api/conversations`, {
    method: "POST",
    headers: { ...authHeaders(buyer), "Content-Type": "application/json" },
    body: JSON.stringify({ userId: String(seller._id), orderId: String(order._id) }),
  });
  assert.equal(both.status, 400);

  // Neither target provided -> 400.
  const neither = await fetch(`${baseUrl}/api/conversations`, {
    method: "POST",
    headers: { ...authHeaders(buyer), "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(neither.status, 400);

  // Unauthenticated -> 401.
  const unauth = await fetch(`${baseUrl}/api/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: String(seller._id) }),
  });
  assert.equal(unauth.status, 401);
});

it("REST message send works for participants and rejects outsiders (403)", async () => {
  const res = await fetch(`${baseUrl}/api/conversations/${conversation._id}/messages`, {
    method: "POST",
    headers: { ...authHeaders(buyer), "Content-Type": "application/json" },
    body: JSON.stringify({ type: "text", content: "rest hello <b>bold</b>" }),
  });
  assert.equal(res.status, 201);
  const json = await res.json();
  assert.ok(json.data.message.id);
  assert.equal(json.data.message.content.includes("<b>"), false);

  const denied = await fetch(`${baseUrl}/api/conversations/${conversation._id}/messages`, {
    method: "POST",
    headers: { ...authHeaders(outsider), "Content-Type": "application/json" },
    body: JSON.stringify({ type: "text", content: "intrusion rest" }),
  });
  assert.equal(denied.status, 403);
});

it("POST /api/calls/token accepts the spec-shaped body { callId, callType }", async () => {
  const call = await callService.createCall({
    caller: buyer,
    conversationId: conversation._id,
    callType: "video",
  });
  const res = await fetch(`${baseUrl}/api/calls/token`, {
    method: "POST",
    headers: { ...authHeaders(seller), "Content-Type": "application/json" },
    body: JSON.stringify({ callId: String(call._id), callType: "video" }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(json.data.token);
  assert.equal(json.data.callType, "video");
  assert.equal(json.data.roomName, call.roomName);
  assert.equal(json.data.serverUrl, process.env.LIVEKIT_URL);
  assert.equal("secret" in json.data, false);
});

it("rejects an invalid-signature LiveKit webhook over HTTP with 401", async () => {
  const res = await fetch(`${baseUrl}/api/webhooks/livekit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorize: "garbage.signature.value" },
    body: JSON.stringify({ event: "room_started", room: { name: "whatever" } }),
  });
  assert.equal(res.status, 401);
});

/* ============================ Socket.IO ============================== */

it("socket.io authenticates via JWT, delivers call:incoming, rejects bad tokens", async () => {
  httpServer = http.createServer();
  const realtime = require("../src/services/realtime.service");
  realtime.init(httpServer);
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const url = `http://127.0.0.1:${httpServer.address().port}`;

  // Receiver connects with a valid Blockefy JWT.
  const receiverClient = Client(url, { auth: { token: tokenFor(seller) }, transports: ["websocket"] });
  await new Promise((resolve, reject) => {
    receiverClient.on("connect", resolve);
    receiverClient.on("connect_error", reject);
    setTimeout(() => reject(new Error("receiver connect timeout")), 8000);
  });

  const incomingPromise = new Promise((resolve) => {
    let settled = false;
    const handler = (payload) => {
      if (settled) return;
      settled = true;
      receiverClient.off("call:incoming", handler);
      resolve(payload);
    };
    receiverClient.on("call:incoming", handler);
    setTimeout(() => {
      if (!settled) {
        settled = true;
        receiverClient.off("call:incoming", handler);
        resolve(null);
      }
    }, 8000);
  });

  const call = await callService.createCall({
    caller: buyer,
    conversationId: conversation._id,
    callType: "voice",
  });

  const payload = await incomingPromise;
  assert.ok(payload && payload.call, "receiver should receive call:incoming");
  assert.equal(payload.call.status, "ringing");
  assert.equal(String(payload.call.receiver.id), String(seller._id));
  receiverClient.disconnect();

  // Invalid token must never connect.
  const badClient = Client(url, { auth: { token: "not-a-valid-jwt" }, transports: ["websocket"] });
  const connectError = await new Promise((resolve) => {
    badClient.on("connect_error", (err) => resolve(err));
    setTimeout(() => resolve(null), 8000);
  });
  assert.ok(connectError, "invalid token should cause connect_error");
  badClient.disconnect();
});

/* ====================== Production-grade call lifecycle ==================== */

it("exposes reusable state-machine helpers", () => {
  assert.equal(callService.canTransition("ringing", "accepted", "receiver").allowed, true);
  assert.equal(callService.canTransition("ringing", "accepted", "caller").allowed, false);
  assert.equal(callService.canTransition("ended", "active", "receiver").allowed, false);
  assert.equal(callService.canTransition("ringing", "missed", "any").allowed, true);
  assert.equal(callService.isJoinableStatus("active"), true);
  assert.equal(callService.isJoinableStatus("ended"), false);
  assert.equal(callService.isTerminalStatus("rejected"), true);
});

it("supports dedicated accept/reject/cancel/end endpoints", async () => {
  const call = await callService.createCall({
    caller: buyer,
    conversationId: conversation._id,
    callType: "voice",
  });

  // Receiver accepts.
  const acceptRes = await fetch(`${baseUrl}/api/calls/${call._id}/accept`, {
    method: "POST",
    headers: authHeaders(seller),
  });
  assert.equal(acceptRes.status, 200);
  const accepted = await acceptRes.json();
  assert.equal(accepted.data.call.status, "accepted");
  assert.ok(accepted.data.call.answeredAt);

  // Caller ends.
  const endRes = await fetch(`${baseUrl}/api/calls/${call._id}/end`, {
    method: "POST",
    headers: authHeaders(buyer),
  });
  assert.equal(endRes.status, 200);
  const ended = await endRes.json();
  assert.equal(ended.data.call.status, "ended");
  assert.ok(Number.isInteger(ended.data.call.duration));

  // New reject after end is rejected.
  const lateReject = await fetch(`${baseUrl}/api/calls/${call._id}/reject`, {
    method: "POST",
    headers: authHeaders(seller),
  });
  assert.equal(lateReject.status, 409);

  // Caller cannot accept a fresh ringing call.
  const freshRinging = await callService.createCall({
    caller: buyer,
    conversationId: conversation._id,
    callType: "voice",
  });
  const callerAccept = await fetch(`${baseUrl}/api/calls/${freshRinging._id}/accept`, {
    method: "POST",
    headers: authHeaders(buyer),
  });
  assert.equal(callerAccept.status, 403);

  // Receiver rejects a fresh ringing call.
  const toReject = await callService.createCall({
    caller: buyer,
    conversationId: conversation._id,
    callType: "voice",
  });
  const rejectRes = await fetch(`${baseUrl}/api/calls/${toReject._id}/reject`, {
    method: "POST",
    headers: authHeaders(seller),
  });
  assert.equal(rejectRes.status, 200);
  assert.equal((await rejectRes.json()).data.call.status, "rejected");

  // Cancel a fresh ringing call (caller only).
  const toCancel = await callService.createCall({
    caller: buyer,
    conversationId: conversation._id,
    callType: "voice",
  });
  const cancelRes = await fetch(`${baseUrl}/api/calls/${toCancel._id}/cancel`, {
    method: "POST",
    headers: authHeaders(buyer),
  });
  assert.equal(cancelRes.status, 200);
  assert.equal((await cancelRes.json()).data.call.status, "cancelled");

  // Receiver cannot cancel caller's call.
  const fresh2 = await callService.createCall({
    caller: buyer,
    conversationId: conversation._id,
    callType: "voice",
  });
  const receiverCancel = await fetch(`${baseUrl}/api/calls/${fresh2._id}/cancel`, {
    method: "POST",
    headers: authHeaders(seller),
  });
  assert.equal(receiverCancel.status, 403);
});

it("rejects calls to suspended/unavailable receivers", async () => {
  await User.findByIdAndUpdate(seller._id, { isSuspended: true });
  await assert.rejects(
    callService.createCall({ caller: buyer, conversationId: conversation._id, callType: "voice" }),
    (err) => err.statusCode === 409
  );
  await User.findByIdAndUpdate(seller._id, { isSuspended: false });
});

it("marks ringing calls as missed after the configured timeout", async () => {
  const originalTimeout = config.callRingingTimeoutMs;
  config.callRingingTimeoutMs = 300; // 300ms window for the test

  const call = await callService.createCall({
    caller: buyer,
    conversationId: conversation._id,
    callType: "voice",
  });

  await new Promise((r) => setTimeout(r, 400));
  const result = await markExpiredMissedCalls();
  assert.ok(result.updated >= 1);

  const updated = await Call.findById(call._id).lean();
  assert.equal(updated.status, "missed");
  assert.ok(updated.endedAt);

  config.callRingingTimeoutMs = originalTimeout;
});

it("filters call history by type, status, conversationId and orderId", async () => {
  const orderCall = await callService.createCall({
    caller: buyer,
    receiverId: seller._id,
    orderId: order._id,
    callType: "video",
  });

  const directCall = await callService.createCall({
    caller: buyer,
    conversationId: conversation._id,
    callType: "voice",
  });

  // Filter by callType.
  const videoRes = await fetch(`${baseUrl}/api/calls?callType=video`, { headers: authHeaders(buyer) });
  const videoJson = await videoRes.json();
  assert.ok(videoJson.data.calls.some((c) => String(c.id) === String(orderCall._id)));
  assert.equal(videoJson.data.calls.every((c) => c.callType === "video"), true);

  // Filter by status ringing.
  const ringingRes = await fetch(`${baseUrl}/api/calls?status=ringing`, { headers: authHeaders(buyer) });
  const ringingJson = await ringingRes.json();
  assert.ok(ringingJson.data.calls.some((c) => String(c.id) === String(directCall._id)));

  // Filter by conversationId.
  const convRes = await fetch(`${baseUrl}/api/calls?conversationId=${conversation._id}`, { headers: authHeaders(buyer) });
  const convJson = await convRes.json();
  assert.ok(convJson.data.calls.some((c) => String(c.id) === String(directCall._id)));

  // Filter by orderId.
  const ordRes = await fetch(`${baseUrl}/api/calls?orderId=${order._id}`, { headers: authHeaders(buyer) });
  const ordJson = await ordRes.json();
  assert.ok(ordJson.data.calls.some((c) => String(c.id) === String(orderCall._id)));

  // Outsiders never see others' history.
  const outsiderRes = await fetch(`${baseUrl}/api/calls`, { headers: authHeaders(outsider) });
  const outsiderJson = await outsiderRes.json();
  assert.equal(outsiderJson.data.calls.some((c) => [String(orderCall._id), String(directCall._id)].includes(String(c.id))), false);
});

it("refuses tokens for calls that are no longer joinable", async () => {
  const call = await callService.createCall({
    caller: buyer,
    conversationId: conversation._id,
    callType: "voice",
  });
  await callService.rejectCall({ callId: call._id, user: seller });

  await assert.rejects(
    callService.getCallToken({ callId: call._id, user: buyer }),
    (err) => err.code === "INVALID_CALL_STATUS"
  );
});

it("ends an active call via LiveKit room_finished and records duration", async () => {
  const call = await callService.createCall({
    caller: buyer,
    conversationId: conversation._id,
    callType: "video",
  });
  await callService.acceptCall({ callId: call._id, user: seller });
  await new Promise((r) => setTimeout(r, 100));

  const body = makeWebhookBody("room_finished", call);
  const header = signWebhookHeader(body);
  const res = await fetch(`${baseUrl}/api/webhooks/livekit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorize: header },
    body,
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.data.call.status, "ended");
  assert.ok(json.data.call.duration >= 0);
});

it("handles concurrent accept safely (only one succeeds)", async () => {
  const call = await callService.createCall({
    caller: buyer,
    conversationId: conversation._id,
    callType: "voice",
  });

  const accept = () => fetch(`${baseUrl}/api/calls/${call._id}/accept`, {
    method: "POST",
    headers: authHeaders(seller),
  });
  const [a, b] = await Promise.all([accept(), accept()]);
  const statuses = [a.status, b.status];
  assert.ok(statuses.includes(200), "one accept should succeed");
  assert.ok(statuses.includes(409), "the concurrent accept should be rejected");

  const persisted = await Call.findById(call._id).lean();
  assert.equal(persisted.status, "accepted");
});

it("handles concurrent end safely (only one succeeds)", async () => {
  const call = await callService.createCall({
    caller: buyer,
    conversationId: conversation._id,
    callType: "voice",
  });
  await callService.acceptCall({ callId: call._id, user: seller });
  await new Promise((r) => setTimeout(r, 50));

  const end = (user) => () => fetch(`${baseUrl}/api/calls/${call._id}/end`, {
    method: "POST",
    headers: authHeaders(user),
  });
  const [a, b] = await Promise.all([end(buyer)(), end(seller)()]);
  const statuses = [a.status, b.status];
  assert.ok(statuses.includes(200), "one end should succeed");
  assert.ok(statuses.includes(409), "the concurrent end should be rejected");

  const persisted = await Call.findById(call._id).lean();
  assert.equal(persisted.status, "ended");
});

it("allows fetching up to 100 messages per page", async () => {
  await Promise.all(
    Array.from({ length: 60 }, (_, i) =>
      messageService.sendMessage({
        conversationId: conversation._id,
        sender: buyer,
        type: "text",
        content: `bulk message ${i}`,
      })
    )
  );

  const res = await fetch(`${baseUrl}/api/conversations/${conversation._id}/messages?limit=100`, {
    headers: authHeaders(buyer),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.data.messages.length <= 100);
  assert.ok(body.data.messages.length >= 50, "should return more than the old 50 cap");
});

it("broadcasts typing status and rejects outsiders", async () => {
  const startTyping = await fetch(`${baseUrl}/api/conversations/${conversation._id}/typing`, {
    method: "POST",
    headers: { ...authHeaders(buyer), "Content-Type": "application/json" },
    body: JSON.stringify({ isTyping: true }),
  });
  assert.equal(startTyping.status, 200);
  const started = await startTyping.json();
  assert.equal(started.data.isTyping, true);

  const stopTyping = await fetch(`${baseUrl}/api/conversations/${conversation._id}/typing`, {
    method: "POST",
    headers: { ...authHeaders(buyer), "Content-Type": "application/json" },
    body: JSON.stringify({ isTyping: false }),
  });
  assert.equal(stopTyping.status, 200);
  const stopped = await stopTyping.json();
  assert.equal(stopped.data.isTyping, false);

  const outsiderTyping = await fetch(`${baseUrl}/api/conversations/${conversation._id}/typing`, {
    method: "POST",
    headers: { ...authHeaders(outsider), "Content-Type": "application/json" },
    body: JSON.stringify({ isTyping: true }),
  });
  assert.equal(outsiderTyping.status, 403);
});

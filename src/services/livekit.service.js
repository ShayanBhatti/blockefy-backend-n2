const { AccessToken, RoomServiceClient, WebhookReceiver } = require("livekit-server-sdk");
const config = require("../config/communicationConfig");
const AppError = require("../utils/AppError");

/**
 * LiveKit service — the ONLY place that talks to the LiveKit Cloud SDK.
 *
 * - Generates short-lived room-join tokens (v2 AccessToken API).
 * - Builds room names.
 * - Optionally lists/removes participants via RoomServiceClient.
 *
 * API secrets are read from environment variables and never returned to the
 * client. Route files never import the SDK directly.
 */

const LIVEKIT_API_KEY = () => process.env.LIVEKIT_API_KEY || "";
const LIVEKIT_API_SECRET = () => process.env.LIVEKIT_API_SECRET || "";
const LIVEKIT_URL = () => process.env.LIVEKIT_URL || "";

const assertConfigured = () => {
  if (!LIVEKIT_API_KEY() || !LIVEKIT_API_SECRET()) {
    throw new AppError("LiveKit is not configured on the server", 500, "SERVER_ERROR");
  }
};

/**
 * Generate a JWT that lets a participant join `room` in LiveKit Cloud.
 *
 * @param {Object} params
 * @param {string} params.identity  - Blockefy user id (participant identity)
 * @param {string} params.room      - room name (must match the Call.roomName)
 * @param {string} [params.name]    - display name for the participant
 * @param {string} [params.metadata]- arbitrary JSON string carried to the room
 * @param {number} [params.ttlSeconds] - token lifetime
 * @returns {Promise<string>} JWT
 */
const generateParticipantToken = async ({ identity, room, name, metadata, ttlSeconds }) => {
  assertConfigured();

  const at = new AccessToken(LIVEKIT_API_KEY(), LIVEKIT_API_SECRET(), {
    identity: String(identity),
    name: name ? String(name).slice(0, 100) : undefined,
    ttl: ttlSeconds || config.callTokenTtlSeconds,
  });
  if (metadata) at.metadata = String(metadata).slice(0, 1000);

  // Join a specific room only; publish/subscribe + data enabled.
  at.addGrant({
    room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  return at.toJwt();
};

// Alias matching the spec naming (createParticipantToken === generateParticipantToken).
const createParticipantToken = generateParticipantToken;

/**
 * Room names are derived from the persisted Call id so a token can never be
 * minted for an arbitrary room — the room always maps back to a Call record.
 */
const createRoomName = ({ callId }) => `call_${callId}`;

const getRoomServiceClient = () => {
  assertConfigured();
  if (!LIVEKIT_URL()) {
    throw new AppError("LIVEKIT_URL is not configured on the server", 500, "SERVER_ERROR");
  }
  return new RoomServiceClient(LIVEKIT_URL(), LIVEKIT_API_KEY(), LIVEKIT_API_SECRET());
};

/**
 * List current participants in a room (for admin/observability use later).
 */
const listParticipants = async (roomName) => {
  const client = getRoomServiceClient();
  return client.listParticipants(roomName);
};

/**
 * Remove a participant from a room (used to enforce leave/cancel).
 */
const removeParticipant = async (roomName, identity) => {
  const client = getRoomServiceClient();
  return client.removeParticipant(roomName, identity);
};

/**
 * Verify + decode a LiveKit webhook.
 *
 * @param {string} rawBody - exact raw request body as received
 * @param {string} authHeader - value of the `Authorize` header
 * @returns {Promise<object|null>} decoded WebhookEvent, or null on bad signature
 */
const receiveWebhook = async (rawBody, authHeader) => {
  const receiver = new WebhookReceiver(LIVEKIT_API_KEY(), LIVEKIT_API_SECRET());
  try {
    return await receiver.receive(rawBody, authHeader, false);
  } catch {
    return null;
  }
};

module.exports = {
  assertConfigured,
  generateParticipantToken,
  createParticipantToken,
  createRoomName,
  listParticipants,
  removeParticipant,
  receiveWebhook,
  getLiveKitUrl: LIVEKIT_URL,
};

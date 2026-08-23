/**
 * Centralized communication-system configuration.
 *
 * Every limit, pagination cap or LiveKit setting that affects conversations,
 * messages, calls or media tokens MUST come from here (or from environment
 * variables resolved here). Controllers and services must never hard-code
 * these values.
 */
const config = {
  /**
   * Free-text message content limits.
   */
  messageMaxLength: Number(process.env.MESSAGE_MAX_LENGTH || 5000),
  maxMessageAttachments: 10,

  /**
   * Pagination caps (mirrors the order-system caps).
   */
  maxPageLimit: Number(process.env.COMM_MAX_PAGE_LIMIT || 100),
  defaultPageLimit: Number(process.env.COMM_DEFAULT_PAGE_LIMIT || 30),

  /**
   * How long a LiveKit room-join token is valid for (in seconds).
   * Short-lived: a participant re-fetches a token when joining.
   */
  callTokenTtlSeconds: Number(process.env.LIVEKIT_TOKEN_TTL_SECONDS || 60 * 60 * 2),

  /**
   * How long a "ringing" call may remain unanswered before it is marked
   * missed by the background job (milliseconds). Configurable via env so
   * tests can use a short window.
   */
  callRingingTimeoutMs: Number(process.env.CALL_RINGING_TIMEOUT_MS || 30_000),

  /**
   * Call types supported by the media layer.
   */
  callTypes: ["voice", "video"],

  /**
   * All legal call statuses. Transitions are enforced by call.service.
   */
  callStatuses: ["ringing", "accepted", "rejected", "missed", "cancelled", "active", "ended", "failed"],

  /**
   * LiveKit webhook events the backend reacts to.
   */
  livekitEvents: [
    "room_started",
    "room_finished",
    "participant_joined",
    "participant_left",
    "participant_connection_aborted",
  ],
};

module.exports = config;

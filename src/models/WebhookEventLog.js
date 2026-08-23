const mongoose = require("mongoose");

/**
 * WebhookEventLog model — idempotency ledger for inbound webhooks.
 *
 * LiveKit does not guarantee exactly-once delivery, so every webhook event is
 * recorded here (unique per event id) and the first processor wins. Duplicate
 * deliveries of the same event id are acknowledged without side effects.
 */
const webhookEventLogSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      required: true,
    },
    event: {
      type: String,
      default: "",
    },
    roomName: {
      type: String,
      default: "",
    },
    provider: {
      type: String,
      default: "livekit",
    },
    processedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

webhookEventLogSchema.index({ eventId: 1 }, { unique: true, sparse: true });
webhookEventLogSchema.index({ roomName: 1, processedAt: -1 });

const WebhookEventLog =
  mongoose.models.WebhookEventLog || mongoose.model("WebhookEventLog", webhookEventLogSchema);

module.exports = WebhookEventLog;

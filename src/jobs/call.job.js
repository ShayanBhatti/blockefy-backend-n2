const Call = require("../models/Call");
const callService = require("../services/call.service");
const config = require("../config/communicationConfig");
const logger = require("../utils/logger");

/**
 * Background job: mark long-ringing calls as missed.
 *
 * Scans calls stuck in "ringing" whose updatedAt is older than the configured
 * timeout and atomically transitions them to "missed". Each change emits the
 * call:missed event to both parties. This is intentionally not done with
 * setTimeout in request handlers.
 */
const markExpiredMissedCalls = async () => {
  const cutoff = new Date(Date.now() - config.callRingingTimeoutMs);
  const expired = await Call.find({
    status: "ringing",
    updatedAt: { $lte: cutoff },
  })
    .sort({ updatedAt: 1 })
    .lean();

  let updated = 0;
  for (const call of expired) {
    try {
      await callService.updateCallStatus({
        callId: call._id,
        user: { _id: call.receiverId },
        status: "missed",
      });
      updated += 1;
      logger.info("call_marked_missed", {
        callId: String(call._id),
        roomName: call.roomName,
        callerId: String(call.callerId),
        receiverId: String(call.receiverId),
      });
    } catch (error) {
      // Race: another process may have already moved the call.
      if (error.code === "INVALID_CALL_STATUS") {
        logger.debug("call_missed_race_skipped", { callId: String(call._id) });
      } else {
        logger.error("call_missed_job_failed", error, { callId: String(call._id) });
      }
    }
  }
  return { scanned: expired.length, updated };
};

module.exports = { markExpiredMissedCalls };

const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/apiResponse");
const callService = require("../services/call.service");
const communicationService = require("../services/communication.service");

/**
 * Call controller.
 *
 * Identity is always `req.authUser` (lean user doc) populated by
 * `authenticate`; callers/receivers are never taken from the body.
 */

exports.createCall = asyncHandler(async (req, res) => {
  const { receiverId, conversationId, orderId, callType } = req.body;
  const call = await callService.createCall({
    caller: req.authUser,
    receiverId,
    conversationId,
    orderId,
    callType,
  });
  return created(res, { call: communicationService.serializeCall(call) }, "Call created");
});

exports.getCallById = asyncHandler(async (req, res) => {
  const call = await callService.getCallById({
    callId: req.params.callId,
    user: req.authUser,
  });
  return ok(res, { call: communicationService.serializeCall(call) }, "Call fetched");
});

exports.listCalls = asyncHandler(async (req, res) => {
  const { page, limit, callType, status, conversationId, orderId } = req.query;
  const result = await callService.listCalls({
    user: req.authUser,
    page,
    limit,
    filters: { callType, status, conversationId, orderId },
  });
  return ok(res, {
    calls: result.calls.map((c) => communicationService.serializeCall(c)),
    pagination: result.pagination,
  }, "Calls fetched");
});

exports.updateCallStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  const call = await callService.updateCallStatus({
    callId: req.params.callId,
    user: req.authUser,
    status,
  });
  return ok(res, { call: communicationService.serializeCall(call) }, "Call updated");
});

exports.acceptCall = asyncHandler(async (req, res) => {
  const call = await callService.acceptCall({
    callId: req.params.callId,
    user: req.authUser,
  });
  return ok(res, { call: communicationService.serializeCall(call) }, "Call accepted");
});

exports.rejectCall = asyncHandler(async (req, res) => {
  const call = await callService.rejectCall({
    callId: req.params.callId,
    user: req.authUser,
  });
  return ok(res, { call: communicationService.serializeCall(call) }, "Call rejected");
});

exports.cancelCall = asyncHandler(async (req, res) => {
  const call = await callService.cancelCall({
    callId: req.params.callId,
    user: req.authUser,
  });
  return ok(res, { call: communicationService.serializeCall(call) }, "Call cancelled");
});

exports.endCall = asyncHandler(async (req, res) => {
  const call = await callService.endCall({
    callId: req.params.callId,
    user: req.authUser,
  });
  return ok(res, { call: communicationService.serializeCall(call) }, "Call ended");
});

exports.getCallToken = asyncHandler(async (req, res) => {
  const { callType } = req.body || {};
  // callId may arrive via the path (/calls/:id/token) or the body
  // (/calls/token — the spec-shaped endpoint). Never from an unvalidated field.
  const callId = req.params.callId || (req.body || {}).callId;
  const result = await callService.getCallToken({
    callId,
    user: req.authUser,
    callType,
  });
  return ok(res, result, "Token generated");
});

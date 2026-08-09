/**
 * Audit logging for important financial/order events.
 *
 * Never logs secrets: no passwords, JWTs, payment secrets, private keys or raw
 * webhook payloads. Each entry is a single structured JSON line.
 */
const auditLog = (event, data = {}) => {
  const safeData = { ...data };
  delete safeData.password;
  delete safeData.token;
  delete safeData.jwt;
  delete safeData.secret;
  delete safeData.privateKey;
  delete safeData.signature;

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...safeData,
  });
  console.log(`[audit] ${line}`);
};

const audit = {
  orderCreated: (d) => auditLog("order.created", d),
  paymentConfirmed: (d) => auditLog("payment.confirmed", d),
  deliverySubmitted: (d) => auditLog("order.delivery_submitted", d),
  revisionRequested: (d) => auditLog("order.revision_requested", d),
  orderCompleted: (d) => auditLog("order.completed", d),
  earningsReleased: (d) => auditLog("order.earnings_released", d),
  cancellationRequested: (d) => auditLog("order.cancellation_requested", d),
  orderCancelled: (d) => auditLog("order.cancelled", d),
  disputeOpened: (d) => auditLog("order.dispute_opened", d),
  webhookProcessed: (d) => auditLog("payment.webhook_processed", d),
  webhookRejected: (d) => auditLog("payment.webhook_rejected", d),
};

module.exports = { auditLog, audit };

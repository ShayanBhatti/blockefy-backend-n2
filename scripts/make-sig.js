process.env.NODE_ENV = "test";
const { createHmac } = require("crypto");
const config = require("../src/config/orderConfig");

const payload = {
  type: "payment.succeeded",
  eventId: "evt_smoke_1",
  intentId: "mockpay_smoke_1",
  orderRef: "BLK-2026-000001",
  amount: 100,
  currency: "USD",
  timestamp: new Date().toISOString(),
};
const raw = JSON.stringify(payload);
const sig = `sha256=${createHmac("sha256", config.webhookSecret).update(raw).digest("hex")}`;
console.log(JSON.stringify({ raw, sig }));

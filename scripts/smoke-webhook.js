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

const app = require("../index");

const server = app.listen(0, async () => {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const r1 = await fetch(`${base}/api/payments/webhook/dev-verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-mock-signature": sig },
    body: raw,
  });
  console.log("dev-verify valid sig:", r1.status, await r1.text());

  const r2 = await fetch(`${base}/api/payments/webhook/dev-verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-mock-signature": "sha256=deadbeef" },
    body: raw,
  });
  console.log("dev-verify bad sig:", r2.status, await r2.text());

  // Valid signature, unknown intent -> should reach intent lookup (404), proving signature passed.
  const r3 = await fetch(`${base}/api/payments/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-mock-signature": sig },
    body: raw,
  });
  console.log("webhook valid sig, unknown intent:", r3.status, await r3.text());

  server.close(() => process.exit(0));
});

const config = require("../config/orderConfig");
const orderService = require("../services/order.service");

/**
 * Background jobs for the order system.
 *
 * These run on a lightweight in-process scheduler for development/long-running
 * deployments. On serverless (Vercel), trigger them via a cron hitting the
 * admin job endpoints (`/api/admin/orders/jobs/...`).
 *
 * Deadlines are NEVER implemented with setTimeout in request handlers.
 */

let running = false;

const runSafe = async (name, fn) => {
  if (running) return;
  running = true;
  try {
    console.log(`[job] ${name} starting`);
    const result = await fn();
    console.log(`[job] ${name} finished`, result ?? "");
  } catch (error) {
    console.error(`[job] ${name} failed:`, error.message);
  } finally {
    running = false;
  }
};

const autoCompleteOrders = () =>
  runSafe("auto-complete-orders", () => orderService.autoCompleteDeliveredOrders());

const reconcilePayments = () =>
  runSafe("reconcile-payments", () => orderService.cancelStalePendingOrders());

/**
 * Start the in-process scheduler.
 */
const startScheduler = () => {
  if (startScheduler.started) return;
  startScheduler.started = true;

  const REVIEW_INTERVAL_MS = 10 * 60 * 1000; // every 10 minutes
  const RECONCILE_INTERVAL_MS = 30 * 60 * 1000; // every 30 minutes

  const autoCompleteTimer = setInterval(autoCompleteOrders, REVIEW_INTERVAL_MS);
  const reconcileTimer = setInterval(reconcilePayments, RECONCILE_INTERVAL_MS);
  if (autoCompleteTimer.unref) autoCompleteTimer.unref();
  if (reconcileTimer.unref) reconcileTimer.unref();

  // Kick off once shortly after boot.
  const bootTimer = setTimeout(() => {
    autoCompleteOrders();
    reconcilePayments();
  }, 5000);
  if (bootTimer.unref) bootTimer.unref();

  console.log("[jobs] order scheduler started");
};

/**
 * Run all jobs once and exit (for cron/CI).
 */
const runOnce = async () => {
  await autoCompleteOrders();
  await reconcilePayments();
};

module.exports = { startScheduler, runOnce, autoCompleteOrders, reconcilePayments };

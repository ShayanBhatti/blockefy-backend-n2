/**
 * One-shot run of order background jobs (cron/CI):
 *   node src/jobs/run-once.js
 */
require("dotenv").config();
const connectDB = require("../config/db");
const jobs = require("./index");

(async () => {
  try {
    await connectDB();
    await jobs.runOnce();
    console.log("[jobs] run-once complete");
    process.exit(0);
  } catch (error) {
    console.error("[jobs] run-once failed:", error.message);
    process.exit(1);
  }
})();

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const passport = require("passport");
const connectDB = require("./src/config/db");
const authRoutes = require("./src/routes/authRoutes");
const gigRoutes = require("./src/routes/gigRoutes");
const onboardingRoutes = require("./src/routes/onboardingRoutes");
const profileRoutes = require("./src/routes/profileRoutes");
const uploadRoutes = require("./src/routes/uploadRoutes");
const dashboardRoutes = require("./src/routes/dashboardRoutes");
const orderRoutes = require("./src/routes/orderRoutes");
const paymentRoutes = require("./src/routes/paymentRoutes");
const adminOrderRoutes = require("./src/routes/adminOrderRoutes");
const sellerRoutes = require("./src/routes/sellerRoutes");
const communicationRoutes = require("./src/routes/communicationRoutes");
const callRoutes = require("./src/routes/callRoutes");
const livekitWebhookRoutes = require("./src/routes/livekitWebhookRoutes");
const realtimeService = require("./src/services/realtime.service");
const errorHandler = require("./src/middleware/errorHandler");
const { createRateLimiter } = require("./src/middleware/rateLimiter");
const jobs = require("./src/jobs");

const app = express();

// Security headers (helmet)
app.use(helmet());

// CORS
app.use(cors({
  origin: process.env.FRONTEND_URL || true,
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
}));

// Database connection on first request
let dbConnected = false;
app.use(async (req, res, next) => {
  if (!dbConnected) {
    try {
      console.log("Attempting database connection...");
      await connectDB();
      dbConnected = true;
      console.log("Database connected successfully");
    } catch (error) {
      console.error("Database connection failed:", error);
      return res.status(500).json({ error: "Database connection failed" });
    }
  }
  next();
});

// =====================================================================
// Payment webhooks MUST be mounted BEFORE the global body parsers so the
// raw request body is available for signature verification.
// =====================================================================
app.use("/api/payments", paymentRoutes);

// LiveKit webhooks MUST also receive the raw body (LiveKit signs the exact
// bytes + uses the `Authorize` header). Mounted before the global parsers.
app.use("/api/webhooks", livekitWebhookRoutes);

// Body parsers (size-capped to reject oversized payloads)
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// Initialize Passport (without session - JWT based)
app.use(passport.initialize());

// Initialize Passport strategies
require("./src/config/passport");

// Health check endpoint
app.get("/", (req, res) => {
  res.status(200).json({ message: "Blockefy Backend is running!" });
});

// Global permissive rate limit (specific endpoints have stricter limits)
app.use("/api/", createRateLimiter({ windowMs: 60_000, max: 600, keyFn: (req) => req.ip }));

// Mount routes
app.use("/auth", authRoutes);
app.use("/gigs", gigRoutes);
app.use("/onboarding", onboardingRoutes);
app.use("/profile", profileRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/orders", orderRoutes);
app.use("/api/admin/orders", adminOrderRoutes);
app.use("/api/seller", sellerRoutes);
app.use("/api", communicationRoutes);
app.use("/api/calls", callRoutes);

// 404 for unknown API routes
app.use("/api", (req, res) => {
  res.status(404).json({ success: false, message: "Endpoint not found", code: "NOT_FOUND" });
});

// Central error handler (no stack leaks in production)
app.use(errorHandler);

// Start background jobs in long-running (non-serverless) processes.
// Only when index.js is the entrypoint (not when required by tests/tools).
if (require.main === module && process.env.NODE_ENV !== "production") {
  // Ensure the DB is connected BEFORE the scheduler's first run so the jobs
  // don't hit mongoose's buffering timeout.
  connectDB()
    .then(() => jobs.startScheduler())
    .catch((error) => {
      console.error("Scheduler not started, DB unavailable:", error.message);
    });
}

// Local development server (NO app.listen for Vercel)
if (require.main === module && process.env.NODE_ENV !== "production") {
  const port = process.env.PORT || 7980;
  const server = app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
  // Realtime (Socket.IO) binds to the same HTTP server.
  realtimeService.init(server);
}

// Export for Vercel
module.exports = app;

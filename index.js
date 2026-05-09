require("dotenv").config();
const express = require("express");
const cors = require("cors");
const passport = require("passport");
const connectDB = require("./src/config/db");
const authRoutes = require("./src/routes/authRoutes");
const gigRoutes = require("./src/routes/gigRoutes");
const onboardingRoutes = require("./src/routes/onboardingRoutes");
const profileRoutes = require("./src/routes/profileRoutes");
const uploadRoutes = require("./src/routes/uploadRoutes");

const app = express();

// Middleware
app.use(cors({ 
  origin: "*",
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization"],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Passport (without session - JWT based)
app.use(passport.initialize());

// Initialize Passport strategies
require("./src/config/passport");

// Health check endpoint
app.get("/", (req, res) => {
  res.status(200).json({ message: "Blockefy Backend is running!" });
});

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

// Mount routes
app.use("/auth", authRoutes);
app.use("/gigs", gigRoutes);
app.use("/onboarding", onboardingRoutes);
app.use("/profile", profileRoutes);
app.use("/api/upload", uploadRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Error:", err.message);
  res.status(err.status || 500).json({ error: err.message });
});

// Local development server (NO app.listen for Vercel)
if (process.env.NODE_ENV !== "production") {
  const port = process.env.PORT || 7980;
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}

// Export for Vercel
module.exports = app;

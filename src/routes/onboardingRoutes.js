const express = require("express");
const onboardingController = require("../controllers/onboardingController");
const authMiddleware = require("../middleware/authMiddleware");
const { checkEmailVerified } = require("../middleware/onboardingMiddleware");

const router = express.Router();

// 🆕 STEP 0: Add email for wallet users (protected route)
router.post(
  "/add-email",
  authMiddleware.verifyToken,
  onboardingController.addEmail
);

// Get onboarding status (protected route)
router.get("/status", authMiddleware.verifyToken, onboardingController.getStatus);

// Verify phone number (temporary - placeholder for Twilio)
router.post(
  "/verify-phone",
  authMiddleware.verifyToken,
  onboardingController.verifyPhone
);

// Update onboarding step (protected route)
// ✅ Requires email verification before progressing
router.post(
  "/update",
  authMiddleware.verifyToken,
  checkEmailVerified,
  onboardingController.updateOnboarding
);

module.exports = router;

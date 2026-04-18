const express = require("express");
const onboardingController = require("../controllers/onboardingController");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

// Get onboarding status (protected route)
router.get("/status", authMiddleware.verifyToken, onboardingController.getStatus);

// Update onboarding step (protected route)
router.post("/update", authMiddleware.verifyToken, onboardingController.updateOnboarding);

module.exports = router;

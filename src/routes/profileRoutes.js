const express = require("express");
const profileController = require("../controllers/profileController");
const authMiddleware = require("../middleware/authMiddleware");
const { checkOnboardingCompleted } = require("../middleware/onboardingMiddleware");
const uploadProfileImages = require("../middleware/upload");

const router = express.Router();

/**
 * All profile routes require:
 * 1. Authentication (authMiddleware)
 * 2. Onboarding completion (onboardingMiddleware)
 */

// GET /profile/me - Retrieve full user profile
router.get(
  "/me",
  authMiddleware.verifyToken,
  checkOnboardingCompleted,
  profileController.getMyProfile
);

// PUT /profile/update-basic - Update basic profile fields
router.put(
  "/update-basic",
  authMiddleware.verifyToken,
  checkOnboardingCompleted,
  profileController.updateBasicProfile
);

// PUT /profile/update-seller - Update seller-specific profile (sellers only)
router.put(
  "/update-seller",
  authMiddleware.verifyToken,
  checkOnboardingCompleted,
  profileController.updateSellerProfile
);

// PUT /profile/update-buyer - Update buyer-specific profile (buyers only)
router.put(
  "/update-buyer",
  authMiddleware.verifyToken,
  checkOnboardingCompleted,
  profileController.updateBuyerProfile
);

// POST /profile/upload-images - Upload avatar and/or cover photo
router.post(
  "/upload-images",
  authMiddleware.verifyToken,
  checkOnboardingCompleted,
  uploadProfileImages.fields([
    { name: "avatar", maxCount: 1 },
    { name: "coverPhoto", maxCount: 1 },
  ]),
  profileController.uploadProfileImages
);

module.exports = router;

const express = require("express");
const router = express.Router();
const uploadController = require("../controllers/uploadController");
const { uploadImage, handleUploadError } = require("../middleware/uploadMiddleware");
const { verifyToken } = require("../middleware/authMiddleware");

/**
 * Upload Routes
 * All routes require authentication via JWT
 * Uses memory storage for serverless environments
 */

/**
 * POST /api/upload/profile-image
 * Upload user profile image
 * Returns: { success, data: { url, publicId, ... } }
 */
router.post(
  "/profile-image",
  verifyToken,
  uploadImage.single("image"),
  handleUploadError,
  uploadController.uploadProfileImage
);

/**
 * POST /api/upload/cover-image
 * Upload user cover image
 * Returns: { success, data: { url, publicId, ... } }
 */
router.post(
  "/cover-image",
  verifyToken,
  uploadImage.single("image"),
  handleUploadError,
  uploadController.uploadCoverImage
);

/**
 * POST /api/upload/gig-image
 * Upload gig/service image
 * Returns: { success, data: { url, publicId, ... } }
 */
router.post(
  "/gig-image",
  verifyToken,
  uploadImage.single("image"),
  handleUploadError,
  uploadController.uploadGigImage
);

/**
 * DELETE /api/upload/:publicId
 * Delete image by public ID
 * Only allows deletion if image belongs to authenticated user
 * Returns: { success, data: { publicId, removed } }
 */
router.delete("/:publicId", verifyToken, uploadController.deleteUploadedImage);

module.exports = router;

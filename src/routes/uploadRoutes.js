const express = require("express");
const router = express.Router();
const uploadController = require("../controllers/uploadController");
const {
  uploadImage,
  handleUploadError,
} = require("../middleware/uploadMiddleware");
const { verifyToken } = require("../middleware/authMiddleware");

/**
 * Upload Routes
 * All routes require authentication via JWT
 * Only two endpoints: /cover-image and /gig-image
 * Returns: { url, publicId }
 */

/**
 * POST /api/upload/cover-image
 * Upload cover image
 * Returns: { url, publicId }
 */
router.post(
  "/cover-image",
  verifyToken,
  uploadImage.single("coverImage"),
  handleUploadError,
  uploadController.uploadCoverImage,
);

/**
 * POST /api/upload/gig-image
 * Upload gig image
 * Returns: { url, publicId }
 */
router.post(
  "/gig-image",
  verifyToken,
  uploadImage.single("gigImage"),
  handleUploadError,
  uploadController.uploadGigImage,
);

module.exports = router;
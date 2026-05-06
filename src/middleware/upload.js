const multer = require("multer");

/**
 * Multer memory storage for serverless environments
 * Files are stored in memory and uploaded to Cloudinary
 */
const storage = multer.memoryStorage();

/**
 * File filter to accept only image files
 */
const fileFilter = (req, file, cb) => {
  // Accept only image mime types
  const allowedMimes = ["image/jpeg", "image/png", "image/gif", "image/webp"];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new Error(
        `Invalid file type: ${file.mimetype}. Only JPEG, PNG, GIF, and WebP images are allowed.`
      ),
      false
    );
  }
};

/**
 * Multer middleware for profile image uploads
 * - Memory storage (for serverless)
 * - Max 2MB per file
 * - Image files only
 */
const uploadProfileImages = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 2 * 1024 * 1024, // 2MB
  },
});

module.exports = uploadProfileImages;

const multer = require("multer");

/**
 * Multer Configuration for Image Uploads
 * Uses memory storage for serverless environments
 * Prevents disk I/O and improves scalability
 */

// Memory storage - suitable for serverless/cloud deployments
const storage = multer.memoryStorage();

/**
 * File filter to accept only image files
 * Whitelist approach for security
 */
const fileFilter = (req, file, cb) => {
  // Allowed MIME types
  const allowedMimes = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif", // gif support for animated profiles
  ];

  // File extension whitelist
  const allowedExtensions = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
  const fileExtension = file.originalname
    .toLowerCase()
    .slice(file.originalname.lastIndexOf("."));

  // Validate MIME type
  if (!allowedMimes.includes(file.mimetype)) {
    return cb(
      new Error(
        `Invalid file type: ${file.mimetype}. Allowed types: JPEG, PNG, WebP, GIF`
      ),
      false
    );
  }

  // Validate extension
  if (!allowedExtensions.includes(fileExtension)) {
    return cb(
      new Error(
        `Invalid file extension: ${fileExtension}. Allowed: .jpg, .jpeg, .png, .webp, .gif`
      ),
      false
    );
  }

  cb(null, true);
};

/**
 * Main upload middleware
 * - Memory storage only
 * - 5MB file size limit per image
 * - Single file upload
 * - Image files only
 */
const uploadImage = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
});

/**
 * Middleware for handling multer errors
 * Converts multer errors to readable API responses
 */
const handleUploadError = (error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "FILE_TOO_LARGE") {
      return res.status(413).json({
        success: false,
        message: "File size exceeds 5MB limit",
        error: "FILE_TOO_LARGE",
      });
    }

    if (error.code === "LIMIT_FILE_COUNT") {
      return res.status(400).json({
        success: false,
        message: "Only single file upload is allowed",
        error: "LIMIT_FILE_COUNT",
      });
    }

    return res.status(400).json({
      success: false,
      message: `Upload error: ${error.message}`,
      error: error.code,
    });
  }

  if (error) {
    return res.status(400).json({
      success: false,
      message: error.message,
      error: "UPLOAD_ERROR",
    });
  }

  next();
};

module.exports = {
  uploadImage,
  handleUploadError,
};

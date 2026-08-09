const multer = require("multer");
const config = require("../config/orderConfig");

/**
 * Multer configuration for ORDER/DELIVERY file uploads.
 *
 * Files are held in memory (serverless-friendly) then uploaded to Cloudinary,
 * so no client-controlled path is ever used for storage — this eliminates
 * path-traversal and arbitrary-write risk.
 *
 * Security:
 *  - whitelist MIME types AND extensions
 *  - server-side size cap
 *  - original filenames are never used as storage names (see file.service)
 */

const storage = multer.memoryStorage();

const ALLOWED_MIME_TYPES = [
  // Documents
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/rtf",
  // Images
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  // Archives
  "application/zip",
  "application/x-zip-compressed",
  "application/gzip",
];

const ALLOWED_EXTENSIONS = [
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv", ".rtf",
  ".jpg", ".jpeg", ".png", ".webp", ".gif",
  ".zip", ".gz",
];

const getExtension = (name = "") => {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx).toLowerCase() : "";
};

const fileFilter = (req, file, cb) => {
  const ext = getExtension(file.originalname);
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(new Error(`Invalid file type: ${file.mimetype}. Allowed: PDF, Office docs, images, text, zip/gz.`), false);
  }
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return cb(new Error(`Invalid file extension: ${ext}`), false);
  }
  cb(null, true);
};

const uploadOrderFiles = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: config.maxFileSizeBytes,
    files: config.maxAttachments + config.maxDeliveryFiles,
  },
});

module.exports = {
  uploadOrderFiles,
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  getExtension,
};

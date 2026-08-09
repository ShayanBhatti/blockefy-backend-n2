const { randomUUID } = require("crypto");
const cloudinaryUtils = require("../utils/cloudinary");
const config = require("../config/orderConfig");
const { getExtension, ALLOWED_MIME_TYPES } = require("../middleware/uploadOrderFiles");
const AppError = require("../utils/AppError");

/**
 * Order-file service.
 *
 * Security model:
 *  - multer already validated MIME + extension + size server-side.
 *  - Storage is Cloudinary (remote), so no client-controlled local path ever
 *    touches the filesystem → path traversal / arbitrary-write is impossible.
 *  - Storage names are generated server-side: `blockefy/order-files/<uuid>-<safe>`.
 *    Original filenames are never used as storage identifiers.
 *  - `publicId` regex in orderRequirement.service.validateFileMetadata ensures
 *    only this service's public ids can be referenced on orders.
 */

const FOLDER = "blockefy/order-files";

const sanitizeName = (name = "file") => {
  const base = name.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80);
  return base || "file";
};

/**
 * Upload a single validated multer file to Cloudinary.
 * @param {Object} file - multer file { buffer, mimetype, originalname, size }
 * @returns {Promise<Object>} file metadata
 */
const uploadOrderFile = async (file) => {
  if (!file || !file.buffer) {
    throw new AppError("File buffer is missing", 400, "INVALID_FILE");
  }
  if (file.size > config.maxFileSizeBytes) {
    throw new AppError("File too large", 413, "FILE_TOO_LARGE");
  }
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    throw new AppError(`File type ${file.mimetype} is not allowed`, 400, "INVALID_FILE");
  }

  const extension = getExtension(file.originalname);
  const publicId = `${randomUUID()}-${sanitizeName(file.originalname)}`;

  const result = await cloudinaryUtils.uploadToCloudinary(file.buffer, FOLDER, publicId);
  if (!result || !result.public_id || !result.secure_url) {
    throw new AppError("Upload failed", 500, "SERVER_ERROR");
  }

  return {
    name: file.originalname.slice(0, 255),
    url: result.secure_url,
    publicId: result.public_id,
    mimeType: file.mimetype,
    extension,
    size: file.size,
  };
};

/**
 * Upload multiple files (multer `files` array).
 */
const uploadOrderFiles = async (files) => {
  if (!Array.isArray(files) || files.length === 0) return [];
  return Promise.all(files.map((f) => uploadOrderFile(f)));
};

/**
 * Delete an order file from Cloudinary by publicId.
 */
const deleteOrderFile = async (publicId) => {
  if (!publicId || typeof publicId !== "string") return null;
  if (!/^blockefy\/order-files\//i.test(publicId)) {
    throw new AppError("Invalid file public id", 400, "INVALID_FILE");
  }
  return cloudinaryUtils.deleteFromCloudinary(publicId);
};

module.exports = {
  uploadOrderFile,
  uploadOrderFiles,
  deleteOrderFile,
};

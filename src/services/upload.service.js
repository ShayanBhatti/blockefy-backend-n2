const cloudinaryUtils = require("../utils/cloudinary");

/**
 * Upload Service for Cloudinary Integration
 * Handles all image upload/delete operations with validation
 * Follows production-ready patterns with error handling
 */

/**
 * Snapshots a file's first bytes against known image signatures. Asserting MAGIC
 * BYTES (not the client-declared MIME/extension) is what makes the upload
 * server-authoritative: MIME sniffing alone lets an attacker upload arbitrary
 * content under an `image/png` label and have it later processed/served as an
 * image (F16).
 */
const detectImageType = (buffer) => {
  if (!buffer || buffer.length < 12) return null;
  const bytes = [...new Uint8Array(buffer.subarray(0, 12))];

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
    bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a &&
    bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "png";
  }
  // GIF: 47 49 46 38 ('GIF8')
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "gif";
  // WebP: 'RIFF'....'WEBP'
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "webp";
  }
  return null;
};

/**
 * Upload image to Cloudinary
 * @param {Object} file - Multer file object with buffer property
 * @param {String} folder - Cloudinary folder path (e.g., 'blockefy/profile-images')
 * @returns {Promise<Object>} { url, publicId, width, height, format }
 * @throws {Error} If upload fails or file is invalid
 */
const uploadImage = async (file, folder) => {
  try {
    // Validate inputs
    if (!file) {
      throw new Error("File is required for upload");
    }

    if (!file.buffer) {
      throw new Error("File buffer is missing");
    }

    if (!folder) {
      throw new Error("Folder path is required");
    }

    // Sanitize folder name (prevent injection)
    const sanitizedFolder = folder
      .replace(/[^a-zA-Z0-9\-_/]/g, "")
      .toLowerCase();

    if (!sanitizedFolder.includes("blockefy")) {
      throw new Error("Invalid folder path");
    }

    // Enforce real image content for anything that is NOT the order-files folder
    // (order files legitimately carry PDF/ZIP attachments). The folder is the
    // caller-controlled requirement, so only exact match opts out.
    if (sanitizedFolder !== "blockefy/order-files") {
      const detected = detectImageType(file.buffer);
      if (!detected) {
        throw new Error(
          "Uploaded content is not a recognized image (JPEG/PNG/GIF/WebP)"
        );
      }
    }

    // Upload to Cloudinary
    const result = await cloudinaryUtils.uploadToCloudinary(
      file.buffer,
      sanitizedFolder
    );

    // Validate response
    if (!result || !result.public_id || !result.secure_url) {
      throw new Error("Invalid Cloudinary response");
    }

    // Return standardized response
    return {
      url: result.secure_url,
      publicId: result.public_id,
      width: result.width,
      height: result.height,
      format: result.format,
      size: result.bytes,
    };
  } catch (error) {
    console.error("Upload service error:", error);
    throw new Error(`Image upload failed: ${error.message}`);
  }
};

/**
 * Delete image from Cloudinary
 * @param {String} publicId - Cloudinary public ID
 * @returns {Promise<Object>} Deletion result
 * @throws {Error} If deletion fails
 */
const deleteImage = async (publicId) => {
  try {
    // Validate input
    if (!publicId) {
      throw new Error("Public ID is required for deletion");
    }

    // Ensure public ID is a string
    const sanitizedPublicId = String(publicId).trim();

    if (!sanitizedPublicId) {
      throw new Error("Public ID cannot be empty");
    }

    // Delete from Cloudinary
    const result = await cloudinaryUtils.deleteFromCloudinary(
      sanitizedPublicId
    );

    // Validate response
    if (!result) {
      throw new Error("Invalid Cloudinary delete response");
    }

    return {
      success: result.result === "ok",
      message: result.result === "ok" ? "Image deleted successfully" : "Delete operation completed",
      result: result.result,
    };
  } catch (error) {
    console.error("Delete service error:", error);
    throw new Error(`Image deletion failed: ${error.message}`);
  }
};

/**
 * Replace image (delete old, upload new)
 * @param {Object} file - New file to upload
 * @param {String} folder - Cloudinary folder
 * @param {String} oldPublicId - Public ID of image to delete (optional)
 * @returns {Promise<Object>} New image metadata
 */
const replaceImage = async (file, folder, oldPublicId = null) => {
  try {
    // Delete old image if provided
    if (oldPublicId) {
      await deleteImage(oldPublicId);
    }

    // Upload new image
    const newImage = await uploadImage(file, folder);

    return newImage;
  } catch (error) {
    console.error("Replace image error:", error);
    throw new Error(`Image replacement failed: ${error.message}`);
  }
};

/**
 * Validate image metadata structure
 * @param {Object} imageMetadata - { url, publicId }
 * @returns {Boolean} True if valid
 */
const validateImageMetadata = (imageMetadata) => {
  if (!imageMetadata || typeof imageMetadata !== "object") {
    return false;
  }

  if (typeof imageMetadata.url !== "string" || !imageMetadata.url.trim()) {
    return false;
  }

  if (
    typeof imageMetadata.publicId !== "string" ||
    !imageMetadata.publicId.trim()
  ) {
    return false;
  }

  // Validate URL is HTTPS
  if (!imageMetadata.url.startsWith("https://")) {
    return false;
  }

  return true;
};

module.exports = {
  uploadImage,
  deleteImage,
  replaceImage,
  validateImageMetadata,
};

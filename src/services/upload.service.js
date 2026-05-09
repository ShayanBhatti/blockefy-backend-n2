const cloudinaryUtils = require("../utils/cloudinary");

/**
 * Upload Service for Cloudinary Integration
 * Handles all image upload/delete operations with validation
 * Follows production-ready patterns with error handling
 */

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

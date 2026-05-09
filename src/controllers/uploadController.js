const uploadService = require("../services/upload.service");
const User = require("../models/User");

/**
 * Upload Controller for Image Management
 * Handles upload/delete operations with proper error handling
 * All responses follow standardized format
 */

/**
 * Upload profile image
 * POST /api/upload/profile-image
 */
const uploadProfileImage = async (req, res) => {
  try {
    // Validate file exists
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No file provided. Please upload an image.",
        error: "NO_FILE",
      });
    }

    // Upload to Cloudinary
    const imageData = await uploadService.uploadImage(
      req.file,
      "blockefy/profile-images"
    );

    // Return success response
    return res.status(200).json({
      success: true,
      message: "Profile image uploaded successfully",
      data: {
        url: imageData.url,
        publicId: imageData.publicId,
        width: imageData.width,
        height: imageData.height,
        format: imageData.format,
        size: imageData.size,
      },
    });
  } catch (error) {
    console.error("Upload profile image error:", error);

    // Determine error type and status code
    let statusCode = 500;
    let errorMessage = "Profile image upload failed";

    if (error.message.includes("Invalid file type")) {
      statusCode = 415;
      errorMessage = error.message;
    } else if (error.message.includes("File size")) {
      statusCode = 413;
      errorMessage = error.message;
    }

    return res.status(statusCode).json({
      success: false,
      message: errorMessage,
      error: "UPLOAD_FAILED",
    });
  }
};

/**
 * Upload cover image
 * POST /api/upload/cover-image
 */
const uploadCoverImage = async (req, res) => {
  try {
    // Validate file exists
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No file provided. Please upload an image.",
        error: "NO_FILE",
      });
    }

    // Upload to Cloudinary
    const imageData = await uploadService.uploadImage(
      req.file,
      "blockefy/cover-images"
    );

    // Return success response
    return res.status(200).json({
      success: true,
      message: "Cover image uploaded successfully",
      data: {
        url: imageData.url,
        publicId: imageData.publicId,
        width: imageData.width,
        height: imageData.height,
        format: imageData.format,
        size: imageData.size,
      },
    });
  } catch (error) {
    console.error("Upload cover image error:", error);

    let statusCode = 500;
    let errorMessage = "Cover image upload failed";

    if (error.message.includes("Invalid file type")) {
      statusCode = 415;
      errorMessage = error.message;
    } else if (error.message.includes("File size")) {
      statusCode = 413;
      errorMessage = error.message;
    }

    return res.status(statusCode).json({
      success: false,
      message: errorMessage,
      error: "UPLOAD_FAILED",
    });
  }
};

/**
 * Upload gig image
 * POST /api/upload/gig-image
 */
const uploadGigImage = async (req, res) => {
  try {
    // Validate file exists
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No file provided. Please upload an image.",
        error: "NO_FILE",
      });
    }

    // Upload to Cloudinary
    const imageData = await uploadService.uploadImage(
      req.file,
      "blockefy/gig-images"
    );

    // Return success response
    return res.status(200).json({
      success: true,
      message: "Gig image uploaded successfully",
      data: {
        url: imageData.url,
        publicId: imageData.publicId,
        width: imageData.width,
        height: imageData.height,
        format: imageData.format,
        size: imageData.size,
      },
    });
  } catch (error) {
    console.error("Upload gig image error:", error);

    let statusCode = 500;
    let errorMessage = "Gig image upload failed";

    if (error.message.includes("Invalid file type")) {
      statusCode = 415;
      errorMessage = error.message;
    } else if (error.message.includes("File size")) {
      statusCode = 413;
      errorMessage = error.message;
    }

    return res.status(statusCode).json({
      success: false,
      message: errorMessage,
      error: "UPLOAD_FAILED",
    });
  }
};

/**
 * Delete uploaded image from Cloudinary
 * DELETE /api/upload/:publicId
 * Only delete if image belongs to authenticated user
 */
const deleteUploadedImage = async (req, res) => {
  try {
    const { publicId } = req.params;
    const userId = req.user.userId;

    // Validate publicId
    if (!publicId) {
      return res.status(400).json({
        success: false,
        message: "Public ID is required",
        error: "MISSING_PUBLIC_ID",
      });
    }

    // Get user to verify ownership
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
        error: "USER_NOT_FOUND",
      });
    }

    // Verify ownership - image must belong to this user
    const belongsToUser =
      (user.profileImage?.publicId === publicId) ||
      (user.coverImage?.publicId === publicId);

    if (!belongsToUser) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to delete this image",
        error: "UNAUTHORIZED_DELETE",
      });
    }

    // Delete from Cloudinary
    const deleteResult = await uploadService.deleteImage(publicId);

    if (!deleteResult.success) {
      return res.status(500).json({
        success: false,
        message: "Failed to delete image from storage",
        error: "DELETE_FAILED",
      });
    }

    // Remove from user document
    if (user.profileImage?.publicId === publicId) {
      user.profileImage = { url: null, publicId: null };
    }
    if (user.coverImage?.publicId === publicId) {
      user.coverImage = { url: null, publicId: null };
    }
    await user.save();

    return res.status(200).json({
      success: true,
      message: "Image deleted successfully",
      data: {
        publicId: publicId,
        removed: true,
      },
    });
  } catch (error) {
    console.error("Delete image error:", error);

    return res.status(500).json({
      success: false,
      message: "Image deletion failed",
      error: "DELETE_ERROR",
    });
  }
};

module.exports = {
  uploadProfileImage,
  uploadCoverImage,
  uploadGigImage,
  deleteUploadedImage,
};

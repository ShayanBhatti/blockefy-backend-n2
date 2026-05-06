const cloudinary = require("cloudinary").v2;
const streamifier = require("streamifier");

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload file to Cloudinary from memory buffer
 * @param {Buffer} fileBuffer - File buffer from multer
 * @param {String} folder - Cloudinary folder path
 * @param {String} publicId - Custom public ID (optional)
 * @returns {Promise} Cloudinary upload response with URL
 */
exports.uploadToCloudinary = (fileBuffer, folder, publicId = null) => {
  return new Promise((resolve, reject) => {
    // Create upload stream
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: folder,
        public_id: publicId,
        resource_type: "auto",
        overwrite: true, // Replace if already exists
      },
      (error, result) => {
        if (error) {
          reject(new Error(`Cloudinary upload failed: ${error.message}`));
        } else {
          resolve(result);
        }
      }
    );

    // Convert buffer to stream and pipe to Cloudinary
    streamifier.createReadStream(fileBuffer).pipe(uploadStream);
  });
};

/**
 * Delete file from Cloudinary
 * @param {String} publicId - Cloudinary public ID
 * @returns {Promise} Cloudinary delete response
 */
exports.deleteFromCloudinary = async (publicId) => {
  try {
    const result = await cloudinary.uploader.destroy(publicId);
    return result;
  } catch (error) {
    console.error("Cloudinary delete error:", error);
    throw new Error(`Failed to delete image: ${error.message}`);
  }
};

module.exports = exports;

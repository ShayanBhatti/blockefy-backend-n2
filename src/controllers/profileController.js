const User = require("../models/User");
const { uploadToCloudinary } = require("../utils/cloudinary");

/**
 * GET /profile/me
 * Return full user profile based on role
 */
exports.getMyProfile = async (req, res) => {
  try {
    const userId = req.user.id;

    // Find user and select all profile fields
    const user = await User.findById(userId).select(
      "email fullName username role avatar profile sellerProfile buyerProfile description createdAt updatedAt"
    );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Build response based on role
    const response = {
      id: user._id,
      email: user.email,
      fullName: user.fullName,
      username: user.username,
      role: user.role,
      profile: user.profile || {},
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };

    if (user.role === "seller") {
      response.sellerProfile = user.sellerProfile || {
        skills: [],
        experience: [],
        education: [],
        portfolio: [],
        languages: [],
      };
    } else if (user.role === "buyer") {
      response.buyerProfile = user.buyerProfile || {
        company: null,
        interests: [],
        budgetRange: { min: null, max: null },
        preferredCategories: [],
      };
    }

    res.json({ success: true, data: response });
  } catch (error) {
    console.error("Error fetching profile:", error);
    res.status(500).json({ message: "Failed to fetch profile", error: error.message });
  }
};

/**
 * PUT /profile/update-basic
 * Update basic profile fields (avatar, coverPhoto, headline, tagline, about)
 */
exports.updateBasicProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const { avatar, coverPhoto, headline, tagline, about } = req.body;

    // Validate inputs - only allow if provided
    const updateData = {};
    if (avatar !== undefined) updateData["profile.avatar"] = avatar;
    if (coverPhoto !== undefined) updateData["profile.coverPhoto"] = coverPhoto;
    if (headline !== undefined) updateData["profile.headline"] = headline;
    if (tagline !== undefined) updateData["profile.tagline"] = tagline;
    if (about !== undefined) updateData["profile.about"] = about;

    // If no fields provided, return error
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        message: "No fields to update. Provide at least one of: avatar, coverPhoto, headline, tagline, about",
      });
    }

    // Update user
    const user = await User.findByIdAndUpdate(userId, { $set: updateData }, { new: true });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({
      success: true,
      message: "Profile updated successfully",
      data: {
        profile: user.profile,
      },
    });
  } catch (error) {
    console.error("Error updating basic profile:", error);
    res.status(500).json({ message: "Failed to update profile", error: error.message });
  }
};

/**
 * PUT /profile/update-seller
 * Update seller-specific profile fields
 * Only accessible by sellers
 */
exports.updateSellerProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const { skills, experience, education, portfolio, languages } = req.body;

    // Check if user is a seller
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.role !== "seller") {
      return res.status(403).json({
        message: "Only sellers can update seller profile",
      });
    }

    // Validate and prepare update data
    const updateData = {};

    if (skills !== undefined) {
      // Validate skills is array
      if (!Array.isArray(skills)) {
        return res.status(400).json({ message: "skills must be an array" });
      }
      updateData["sellerProfile.skills"] = skills;
    }

    if (experience !== undefined) {
      // Validate experience is array
      if (!Array.isArray(experience)) {
        return res.status(400).json({ message: "experience must be an array" });
      }
      // Validate experience items have required fields
      for (const exp of experience) {
        if (!exp.title || !exp.company || !exp.startDate) {
          return res.status(400).json({
            message: "Each experience must have title, company, and startDate",
          });
        }
      }
      updateData["sellerProfile.experience"] = experience;
    }

    if (education !== undefined) {
      // Validate education is array
      if (!Array.isArray(education)) {
        return res.status(400).json({ message: "education must be an array" });
      }
      // Validate education items have required fields
      for (const edu of education) {
        if (!edu.school || !edu.degree || edu.startYear === undefined) {
          return res.status(400).json({
            message: "Each education must have school, degree, and startYear",
          });
        }
      }
      updateData["sellerProfile.education"] = education;
    }

    if (portfolio !== undefined) {
      // Validate portfolio is array
      if (!Array.isArray(portfolio)) {
        return res.status(400).json({ message: "portfolio must be an array" });
      }
      // Validate portfolio items have required title
      for (const item of portfolio) {
        if (!item.title) {
          return res.status(400).json({
            message: "Each portfolio item must have a title",
          });
        }
      }
      updateData["sellerProfile.portfolio"] = portfolio;
    }

    if (languages !== undefined) {
      // Validate languages is array
      if (!Array.isArray(languages)) {
        return res.status(400).json({ message: "languages must be an array" });
      }
      updateData["sellerProfile.languages"] = languages;
    }

    // If no fields provided, return error
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        message: "No fields to update. Provide at least one of: skills, experience, education, portfolio, languages",
      });
    }

    // Update user
    const updatedUser = await User.findByIdAndUpdate(userId, { $set: updateData }, { new: true });

    res.json({
      success: true,
      message: "Seller profile updated successfully",
      data: {
        sellerProfile: updatedUser.sellerProfile,
      },
    });
  } catch (error) {
    console.error("Error updating seller profile:", error);
    res.status(500).json({ message: "Failed to update seller profile", error: error.message });
  }
};

/**
 * PUT /profile/update-buyer
 * Update buyer-specific profile fields
 * Only accessible by buyers
 */
exports.updateBuyerProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const { company, interests, budgetRange, preferredCategories } = req.body;

    // Check if user is a buyer
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.role !== "buyer") {
      return res.status(403).json({
        message: "Only buyers can update buyer profile",
      });
    }

    // Validate and prepare update data
    const updateData = {};

    if (company !== undefined) {
      // Validate company is string or null
      if (company !== null && typeof company !== "string") {
        return res.status(400).json({ message: "company must be a string or null" });
      }
      updateData["buyerProfile.company"] = company;
    }

    if (interests !== undefined) {
      // Validate interests is array
      if (!Array.isArray(interests)) {
        return res.status(400).json({ message: "interests must be an array" });
      }
      updateData["buyerProfile.interests"] = interests;
    }

    if (budgetRange !== undefined) {
      // Validate budgetRange object
      if (typeof budgetRange !== "object" || budgetRange === null) {
        return res.status(400).json({ message: "budgetRange must be an object" });
      }

      const { min, max } = budgetRange;
      // Allow null values or valid numbers
      if (
        (min !== null && typeof min !== "number") ||
        (max !== null && typeof max !== "number")
      ) {
        return res.status(400).json({
          message: "budgetRange.min and budgetRange.max must be numbers or null",
        });
      }

      // Validate min <= max if both provided
      if (min !== null && max !== null && min > max) {
        return res.status(400).json({
          message: "budgetRange.min cannot be greater than budgetRange.max",
        });
      }

      updateData["buyerProfile.budgetRange.min"] = min;
      updateData["buyerProfile.budgetRange.max"] = max;
    }

    if (preferredCategories !== undefined) {
      // Validate preferredCategories is array
      if (!Array.isArray(preferredCategories)) {
        return res.status(400).json({ message: "preferredCategories must be an array" });
      }
      updateData["buyerProfile.preferredCategories"] = preferredCategories;
    }

    // If no fields provided, return error
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        message: "No fields to update. Provide at least one of: company, interests, budgetRange, preferredCategories",
      });
    }

    // Update user
    const updatedUser = await User.findByIdAndUpdate(userId, { $set: updateData }, { new: true });

    res.json({
      success: true,
      message: "Buyer profile updated successfully",
      data: {
        buyerProfile: updatedUser.buyerProfile,
      },
    });
  } catch (error) {
    console.error("Error updating buyer profile:", error);
    res.status(500).json({ message: "Failed to update buyer profile", error: error.message });
  }
};

/**
 * POST /profile/upload-images
 * Upload profile avatar and/or cover photo to Cloudinary
 */
exports.uploadProfileImages = async (req, res) => {
  try {
    const userId = req.user.id;

    // Check if user exists
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Check if files were uploaded
    if (!req.files || Object.keys(req.files).length === 0) {
      return res.status(400).json({
        message: "No files uploaded. Please provide at least avatar or coverPhoto",
      });
    }

    const uploadedUrls = {};

    try {
      // Handle avatar upload
      if (req.files.avatar && req.files.avatar.length > 0) {
        const avatarFile = req.files.avatar[0];

        console.log(`Uploading avatar for user ${userId}...`);
        const avatarResult = await uploadToCloudinary(
          avatarFile.buffer,
          "blockefy/avatars",
          `avatar_${userId}`
        );

        user.profile.avatar = avatarResult.secure_url;
        uploadedUrls.avatar = avatarResult.secure_url;
        console.log(`Avatar uploaded successfully: ${avatarResult.secure_url}`);
      }

      // Handle cover photo upload
      if (req.files.coverPhoto && req.files.coverPhoto.length > 0) {
        const coverPhotoFile = req.files.coverPhoto[0];

        console.log(`Uploading cover photo for user ${userId}...`);
        const coverPhotoResult = await uploadToCloudinary(
          coverPhotoFile.buffer,
          "blockefy/cover-photos",
          `cover_${userId}`
        );

        user.profile.coverPhoto = coverPhotoResult.secure_url;
        uploadedUrls.coverPhoto = coverPhotoResult.secure_url;
        console.log(`Cover photo uploaded successfully: ${coverPhotoResult.secure_url}`);
      }

      // Save user with updated profile URLs
      await user.save();

      res.json({
        success: true,
        message: "Profile images uploaded successfully",
        data: {
          profile: {
            avatar: user.profile.avatar,
            coverPhoto: user.profile.coverPhoto,
          },
        },
      });
    } catch (uploadError) {
      console.error("Image upload to Cloudinary failed:", uploadError);
      res.status(500).json({
        message: "Failed to upload images to storage",
        error: uploadError.message,
      });
    }
  } catch (error) {
    console.error("Error in uploadProfileImages:", error);
    res.status(500).json({
      message: "Failed to upload profile images",
      error: error.message,
    });
  }
};

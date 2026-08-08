const User = require("../models/User");
const Gig = require("../models/Gig");

// ============================================
// HELPER: Validate gig for posting
// ============================================
const validateGigForPosting = (gigData) => {
  const errors = [];

  if (!gigData.title || gigData.title.trim().length === 0) {
    errors.push("Title is required");
  }
  if (!gigData.description || gigData.description.trim().length === 0) {
    errors.push("Description is required");
  }
  if (!gigData.category) {
    errors.push("Category is required");
  }
  if (!gigData.pricing || !gigData.pricing.basic) {
    errors.push("Basic pricing is required");
  }

  return errors;
};

// ============================================
// HELPER: Check seller eligibility
// ============================================
const checkSellerEligibility = async (userId) => {
  const user = await User.findById(userId);

  if (!user) {
    return { eligible: false, error: "User not found", user: null };
  }

  if (user.role !== "seller") {
    return { eligible: false, error: "Only sellers can create gigs", user };
  }

  if (user.onboardingStep < 4) {
    return {
      eligible: false,
      error: "Complete your seller profile (Step 4) before posting gigs",
      user,
      requiresProfileCompletion: true,
    };
  }

  return { eligible: true, user };
};

// ============================================
// CREATE GIG (Draft or Posted)
// ============================================
exports.createGig = async (req, res) => {
  try {
    const userId = req.user.userId;
    const {
      title,
      gigImage,
      gigImagePublicId,
      description,
      category,
      tags,
      pricing,
      deliveryTime,
      saveAsDraft,
    } = req.body;

    const isDraft = saveAsDraft === true || saveAsDraft === "true";

    // Get user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(403).json({ error: "User not found" });
    }

    // ✅ ENFORCE: User must be a seller (both for draft and posted)
    if (user.role !== "seller") {
      return res.status(403).json({
        error: "Only sellers can create gigs",
        role: user.role,
      });
    }

    // Determine status
    const gigStatus = isDraft ? "draft" : "posted";

    // If posting (not saving as draft), validate required fields
    if (!isDraft) {
      const validationErrors = validateGigForPosting(req.body);
      if (validationErrors.length > 0) {
        return res.status(400).json({
          error: "Validation failed",
          details: validationErrors,
        });
      }

      // Check seller profile completion for posted gigs
      if (user.onboardingStep < 4) {
        return res.status(403).json({
          error: "Complete your seller profile (Step 4) before posting gigs",
          currentStep: user.onboardingStep,
          requiredStep: 4,
        });
      }
    }

    // Create gig
    const gig = await Gig.create({
      userId,
      gigImage: gigImage || null,
      gigImagePublicId: gigImagePublicId || null,
      title: title ? title.trim() : null,
      description: description ? description.trim() : null,
      category: category ? category.trim() : null,
      tags: tags || [],
      pricing: pricing || {},
      deliveryTime: deliveryTime || null,
      status: gigStatus,
    });

    res.status(201).json({
      message: isDraft ? "Gig saved as draft" : "Gig posted successfully",
      gig,
    });
  } catch (error) {
    console.error("Gig creation error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// Get all gigs of the user
exports.getAllUserGigs = async (req, res) => {
  try {
    const userId = req.user.userId;

    // Get all gigs for the user with user details
    const gigs = await Gig.find({ userId })
      .populate("userId", "firstName lastName email role profilePicture")
      .sort({ createdAt: -1 });

    if (!gigs || gigs.length === 0) {
      return res.status(200).json({
        message: "No gigs found for this user",
        gigs: [],
      });
    }

    res.status(200).json({
      message: "Gigs retrieved successfully",
      totalGigs: gigs.length,
      gigs: gigs,
    });
  } catch (error) {
    console.error("Error fetching user gigs:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// ============================================
// GET DRAFT GIGS
// ============================================
exports.getDraftGigs = async (req, res) => {
  try {
    const userId = req.user.userId;

    const drafts = await Gig.find({ userId, status: "draft" })
      .populate("userId", "firstName lastName email role profilePicture")
      .sort({ updatedAt: -1 }); // Show recently updated first

    res.status(200).json({
      message: "Draft gigs retrieved successfully",
      totalDrafts: drafts.length,
      gigs: drafts,
    });
  } catch (error) {
    console.error("Error fetching draft gigs:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// ============================================
// GET POSTED GIGS
// ============================================
exports.getPostedGigs = async (req, res) => {
  try {
    const userId = req.user.userId;

    const postedGigs = await Gig.find({ userId, status: "posted" })
      .populate("userId", "firstName lastName email role profilePicture")
      .sort({ createdAt: -1 });

    res.status(200).json({
      message: "Posted gigs retrieved successfully",
      totalPosted: postedGigs.length,
      gigs: postedGigs,
    });
  } catch (error) {
    console.error("Error fetching posted gigs:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// ============================================
// SAVE DRAFT GIG (Create or Update)
// ============================================
exports.saveDraftGig = async (req, res) => {
  try {
    const userId = req.user.userId;
    const {
      gigId, // If provided, update existing draft; otherwise create new
      title,
      gigImage,
      gigImagePublicId,
      description,
      category,
      tags,
      pricing,
      deliveryTime,
    } = req.body;

    // Get user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(403).json({ error: "User not found" });
    }

    // User must be a seller
    if (user.role !== "seller") {
      return res.status(403).json({
        error: "Only sellers can create gigs",
        role: user.role,
      });
    }

    let gig;

    if (gigId) {
      // Update existing draft
      gig = await Gig.findOne({ _id: gigId, userId, status: "draft" });

      if (!gig) {
        return res.status(404).json({
          error: "Draft gig not found or already published",
        });
      }

      // Update fields (only provided ones)
      if (title !== undefined) gig.title = title.trim() || null;
      if (description !== undefined) gig.description = description.trim() || null;
      if (category !== undefined) gig.category = category ? category.trim() : null;
      if (tags !== undefined) gig.tags = tags;
      if (pricing !== undefined) gig.pricing = pricing;
      if (deliveryTime !== undefined) gig.deliveryTime = deliveryTime;
      if (gigImage !== undefined) gig.gigImage = gigImage;

      await gig.save();
    } else {
      // Create new draft
      gig = await Gig.create({
        userId,
        gigImage: gigImage || null,
        title: title ? title.trim() : null,
        description: description ? description.trim() : null,
        category: category ? category.trim() : null,
        tags: tags || [],
        pricing: pricing || {},
        deliveryTime: deliveryTime || null,
        status: "draft",
      });
    }

    res.status(201).json({
      message: "Draft saved successfully",
      gig,
    });
  } catch (error) {
    console.error("Save draft error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// ============================================
// PUBLISH GIG (Convert Draft to Posted)
// ============================================
exports.publishGig = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { gigId } = req.params;

    if (!gigId) {
      return res.status(400).json({ error: "Gig ID is required" });
    }

    // Get user and check eligibility
    const user = await User.findById(userId);
    if (!user) {
      return res.status(403).json({ error: "User not found" });
    }

    // User must be a seller
    if (user.role !== "seller") {
      return res.status(403).json({
        error: "Only sellers can publish gigs",
        role: user.role,
      });
    }

    // Check seller profile completion
    if (user.onboardingStep < 4) {
      return res.status(403).json({
        error: "Complete your seller profile (Step 4) before publishing gigs",
        currentStep: user.onboardingStep,
        requiredStep: 4,
      });
    }

    // Find the draft gig
    const gig = await Gig.findOne({ _id: gigId, userId, status: "draft" });

    if (!gig) {
      return res.status(404).json({
        error: "Draft gig not found or already published",
      });
    }

    // Validate required fields for posting
    const validationErrors = validateGigForPosting({
      title: gig.title,
      description: gig.description,
      category: gig.category,
      pricing: gig.pricing,
    });

    if (validationErrors.length > 0) {
      return res.status(400).json({
        error: "Cannot publish - missing required fields",
        details: validationErrors,
        gig: gig, // Return the gig so frontend can show what's missing
      });
    }

    // Publish the gig
    gig.status = "posted";
    await gig.save();

    res.status(200).json({
      message: "Gig published successfully",
      gig,
    });
  } catch (error) {
    console.error("Publish gig error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// ============================================
// UPDATE GIG (Both Draft and Posted)
// ============================================
exports.updateGig = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { gigId } = req.params;
    const {
      title,
      gigImage,
      description,
      category,
      tags,
      pricing,
      deliveryTime,
      saveAsDraft,
    } = req.body;

    if (!gigId) {
      return res.status(400).json({ error: "Gig ID is required" });
    }

    // Find the gig
    const gig = await Gig.findOne({ _id: gigId, userId });

    if (!gig) {
      return res.status(404).json({ error: "Gig not found" });
    }

    // Get user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(403).json({ error: "User not found" });
    }

    const isDraft = gig.status === "draft";
    const wantsToSaveAsDraft = saveAsDraft === true || saveAsDraft === "true";

    // If converting to posted or updating posted gig, validate
    if (!isDraft && !wantsToSaveAsDraft) {
      // This is an update to a posted gig - keep it posted but validate
      const validationErrors = validateGigForPosting({
        title: title ?? gig.title,
        description: description ?? gig.description,
        category: category ?? gig.category,
        pricing: pricing ?? gig.pricing,
      });

      if (validationErrors.length > 0) {
        return res.status(400).json({
          error: "Validation failed",
          details: validationErrors,
        });
      }
    }

    // If saving as draft, no validation needed
    if (wantsToSaveAsDraft) {
      gig.status = "draft";
    }

    // Update fields
    if (title !== undefined) gig.title = title.trim() || null;
    if (description !== undefined) gig.description = description.trim() || null;
    if (category !== undefined) gig.category = category ? category.trim() : null;
    if (tags !== undefined) gig.tags = tags;
    if (pricing !== undefined) gig.pricing = pricing;
    if (deliveryTime !== undefined) gig.deliveryTime = deliveryTime;
    if (gigImage !== undefined) gig.gigImage = gigImage;

    await gig.save();

    res.status(200).json({
      message: wantsToSaveAsDraft ? "Gig saved as draft" : "Gig updated successfully",
      gig,
    });
  } catch (error) {
    console.error("Update gig error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// ============================================
// DELETE GIG
// ============================================
exports.deleteGig = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { gigId } = req.params;

    if (!gigId) {
      return res.status(400).json({ error: "Gig ID is required" });
    }

    const gig = await Gig.findOne({ _id: gigId, userId });

    if (!gig) {
      return res.status(404).json({ error: "Gig not found" });
    }

    await Gig.findByIdAndDelete(gigId);

    res.status(200).json({
      message: "Gig deleted successfully",
    });
  } catch (error) {
    console.error("Delete gig error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// ============================================
// UNPUBLISH GIG (Convert Posted to Draft)
// ============================================
exports.unpublishGig = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { gigId } = req.params;

    if (!gigId) {
      return res.status(400).json({ error: "Gig ID is required" });
    }

    const gig = await Gig.findOne({ _id: gigId, userId, status: "posted" });

    if (!gig) {
      return res.status(404).json({
        error: "Posted gig not found or already a draft",
      });
    }

    // Convert to draft
    gig.status = "draft";
    await gig.save();

    res.status(200).json({
      message: "Gig unpublished - saved as draft",
      gig,
    });
  } catch (error) {
    console.error("Unpublish gig error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// Get detailed information of a specific gig by ID
exports.getGigDetails = async (req, res) => {
  try {
    const { gigId } = req.params;

    // Validate gigId
    if (!gigId) {
      return res.status(400).json({ error: "Gig ID is required" });
    }

    // Find the gig with populated user details
    const gig = await Gig.findById(gigId).populate(
      "userId",
      "firstName lastName email role profilePicture phone bio rating totalReviews"
    );

    if (!gig) {
      return res.status(404).json({ error: "Gig not found" });
    }

    res.status(200).json({
      message: "Gig details retrieved successfully",
      gig: gig,
    });
  } catch (error) {
    console.error("Error fetching gig details:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// Get all gigs from all sellers (for buyers to browse)
exports.getAllGigs = async (req, res) => {
  try {
    const { category, tags, sortBy } = req.query;

    // Build filter
    let filter = {};
    if (category) {
      filter.category = category;
    }
    if (tags) {
      const tagArray = tags.split(",");
      filter.tags = { $in: tagArray };
    }

    // Get all gigs with user details
    let query = Gig.find(filter).populate(
      "userId",
      "firstName lastName profilePicture role rating"
    );

    // Apply sorting
    if (sortBy === "newest") {
      query = query.sort({ createdAt: -1 });
    } else if (sortBy === "price-low") {
      query = query.sort({ "pricing.basic": 1 });
    } else if (sortBy === "price-high") {
      query = query.sort({ "pricing.basic": -1 });
    } else {
      query = query.sort({ createdAt: -1 }); // Default: newest
    }

    const gigs = await query;

    if (!gigs || gigs.length === 0) {
      return res.status(200).json({
        message: "No gigs found",
        totalGigs: 0,
        gigs: [],
      });
    }

    res.status(200).json({
      message: "All gigs retrieved successfully",
      totalGigs: gigs.length,
      gigs: gigs,
    });
  } catch (error) {
    console.error("Error fetching all gigs:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// Get all sellers/freelancers (for buyers to browse - card view)
exports.getAllSellers = async (req, res) => {
  try {
    const { sortBy, page = 1, limit = 12, skill } = req.query;

    // ============================================
    // FILTER
    // ============================================

    const filter = {
      role: "seller",
      onboardingCompleted: true,
    };

    // Optional skill filter
    if (skill) {
      filter["sellerProfile.skills"] = {
        $regex: skill,
        $options: "i",
      };
    }

    // ============================================
    // QUERY
    // ============================================

    let query = User.find(filter).select(`
      fullName
      username
      role
      profileImage
      profile.headline
      profile.tagline
      profile.about
      sellerProfile.skills
      sellerProfile.languages
      createdAt
    `);

    // ============================================
    // SORTING
    // ============================================

    switch (sortBy) {
      case "newest":
        query = query.sort({ createdAt: -1 });
        break;

      case "oldest":
        query = query.sort({ createdAt: 1 });
        break;

      case "name":
        query = query.sort({ fullName: 1 });
        break;

      default:
        query = query.sort({ createdAt: -1 });
    }

    // ============================================
    // PAGINATION
    // ============================================

    const pageNumber = parseInt(page);
    const limitNumber = parseInt(limit);

    const skip = (pageNumber - 1) * limitNumber;

    const totalSellers = await User.countDocuments(filter);

    const sellers = await query
      .skip(skip)
      .limit(limitNumber)
      .lean();

    // ============================================
    // FORMAT RESPONSE
    // ============================================

    const formattedSellers = sellers.map((seller) => ({
      _id: seller._id,

      fullName: seller.fullName || "Unnamed Seller",

      username: seller.username || null,

      role: seller.role,

      headline: seller.profile?.headline || "",

      tagline: seller.profile?.tagline || "",

      about: seller.profile?.about || "",

      profileImage:
        seller.profileImage?.url || null,

      skills:
        seller.sellerProfile?.skills || [],

      languages:
        seller.sellerProfile?.languages || [],

      joinedAt: seller.createdAt,
    }));

    // ============================================
    // RESPONSE
    // ============================================

    return res.status(200).json({
      success: true,

      message: "Sellers retrieved successfully",

      pagination: {
        total: totalSellers,
        page: pageNumber,
        limit: limitNumber,
        totalPages: Math.ceil(totalSellers / limitNumber),
      },

      sellers: formattedSellers,
    });

  } catch (error) {
    console.error("Error fetching sellers:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch sellers",
    });
  }
};

// Get detailed profile of a specific seller with all their gigs
exports.getSellerDetails = async (req, res) => {
  try {
    const { sellerId } = req.params;

    // Validate sellerId
    if (!sellerId) {
      return res.status(400).json({ error: "Seller ID is required" });
    }

    // Find the seller
    const seller = await User.findById(sellerId).select(
      "firstName lastName email profilePicture phone bio role rating totalReviews category createdAt onboardingStep"
    );

    if (!seller) {
      return res.status(404).json({ error: "Seller not found" });
    }

    // Verify seller role
    if (seller.role !== "seller") {
      return res.status(400).json({ error: "User is not a seller" });
    }

    // Get all gigs for this seller
    const gigs = await Gig.find({ userId: sellerId }).sort({ createdAt: -1 });

    res.status(200).json({
      message: "Seller details retrieved successfully",
      seller: {
        ...seller.toObject(),
        totalGigs: gigs.length,
        gigs: gigs,
      },
    });
  } catch (error) {
    console.error("Error fetching seller details:", error);
    res.status(500).json({ error: "Server error" });
  }
};

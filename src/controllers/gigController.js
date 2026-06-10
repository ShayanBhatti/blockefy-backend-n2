const User = require("../models/User");
const Gig = require("../models/Gig");

exports.createGig = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { title, gigImage, description, category, tags, pricing, deliveryTime } = req.body;

    // Validate required fields
    if (!title || !description) {
      return res.status(400).json({ error: "Title and description are required" });
    }

    // Get user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(403).json({ error: "User not found" });
    }

    // ✅ ENFORCE: User must be a seller
    if (user.role !== "seller") {
      return res.status(403).json({
        error: "Only sellers can create gigs",
        role: user.role,
      });
    }

    // ✅ ENFORCE: Seller must have completed profile foundation (at least Step 4)
    // Step 4 = Profile Foundation (headline, about, skills, avatar)
    // Sellers can create gigs once profile is complete
    if (user.onboardingStep < 4) {
      return res.status(403).json({
        error: "Complete your seller profile (Step 4) before creating gigs",
        currentStep: user.onboardingStep,
        requiredStep: 4,
      });
    }

    // Create gig
    const gig = await Gig.create({
      userId,
      gigImage: gigImage || null,
      title: title.trim(),
      description: description.trim(),
      category: category ? category.trim() : null,
      tags: tags || [],
      pricing: pricing || {},
      deliveryTime: deliveryTime || null,
    });

    res.status(201).json(gig);
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

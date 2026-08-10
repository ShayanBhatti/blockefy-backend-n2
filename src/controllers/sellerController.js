const mongoose = require("mongoose");
const User = require("../models/User");
const Gig = require("../models/Gig");
const AppError = require("../utils/AppError");

/**
 * Sanitize a user document into a public profile payload.
 * Never exposes passwords, OTPs, private keys, email or wallet address.
 * @param {Object} user - lean user document
 * @returns {Object} public profile
 */
const toPublicProfile = (user) => {
  return {
    id: user._id,
    fullName: user.fullName || null,
    username: user.username || null,
    role: user.role || null,
    profileImage: user.profileImage?.url || null,
    coverImage: user.coverImage?.url || null,
    description: user.description || null,
    profile: {
      avatar: user.profile?.avatar || null,
      coverPhoto: user.profile?.coverPhoto || null,
      headline: user.profile?.headline || null,
      tagline: user.profile?.tagline || null,
      about: user.profile?.about || null,
    },
    sellerProfile: user.sellerProfile
      ? {
          bio: user.sellerProfile.bio || null,
          skills: user.sellerProfile.skills || [],
          languages: user.sellerProfile.languages || [],
          experience: user.sellerProfile.experience || [],
          education: user.sellerProfile.education || [],
          portfolio: user.sellerProfile.portfolio || [],
        }
      : null,
    buyerProfile: user.buyerProfile
      ? {
          company: user.buyerProfile.company || null,
          interests: user.buyerProfile.interests || [],
        }
      : null,
    joinedAt: user.createdAt || null,
  };
};

/**
 * Resolve the target user from either a :profileId path param or a
 * ?userId= query param.
 */
const resolveTargetId = (req) => {
  const profileId = req.params.profileId;
  const userId = req.query.userId;
  const target = profileId || userId;

  if (!target) {
    throw new AppError("profileId or userId is required", 400, "INVALID_ID");
  }
  if (!mongoose.Types.ObjectId.isValid(target)) {
    throw new AppError("Invalid resource id", 400, "INVALID_ID");
  }
  return target;
};

/**
 * GET /api/seller/:profileId  (or GET /api/seller?userId=...)
 * Returns a public profile of any user by id.
 */
exports.getSellerProfile = async (req, res) => {
  const targetId = resolveTargetId(req);

  const user = await User.findById(targetId).lean();
  if (!user) {
    throw new AppError("User not found", 404, "USER_NOT_FOUND");
  }

  const profile = toPublicProfile(user);

  let gigs = [];
  if (user.role === "seller") {
    gigs = await Gig.find({ userId: targetId })
      .sort({ createdAt: -1 })
      .lean();
    profile.totalGigs = gigs.length;
    profile.gigs = gigs.map((gig) => ({
      id: gig._id,
      title: gig.title,
      description: gig.description,
      category: gig.category,
      tags: gig.tags || [],
      status: gig.status,
      pricing: gig.pricing,
      deliveryTime: gig.deliveryTime,
      gigImage: gig.gigImage || null,
      createdAt: gig.createdAt,
    }));
  }

  res.json({ success: true, data: { profile } });
};

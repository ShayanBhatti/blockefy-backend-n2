const User = require("../models/User");

/**
 * Check if user has completed onboarding
 * Returns 403 if onboardingCompleted === false
 */
const checkOnboardingCompleted = async (req, res, next) => {
  try {
    const userId = req.user.userId;

    // Get user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(403).json({ error: "User not found" });
    }

    // Check if onboarding is completed
    if (!user.onboardingCompleted) {
      return res.status(403).json({ error: "Complete onboarding first" });
    }

    next();
  } catch (error) {
    console.error("Onboarding check error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

module.exports = {
  checkOnboardingCompleted,
};

const User = require("../models/User");

/**
 * ✅ Check email verification status
 * Returns 403 if emailVerified === false for onboarding attempts
 * Prevents users from progressing without verified email
 */
const checkEmailVerified = async (req, res, next) => {
  try {
    const userId = req.user.userId;

    // Get user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(403).json({ error: "User not found" });
    }

    // ✅ BLOCK if email not verified
    if (!user.emailVerified) {
      return res.status(403).json({
        error: "Email verification required",
        emailVerified: false,
      });
    }

    next();
  } catch (error) {
    console.error("Email verification check error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

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

    // Check if email is verified (prerequisite)
    if (!user.emailVerified) {
      return res.status(403).json({
        error: "Email verification required",
        emailVerified: false,
      });
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
  checkEmailVerified,
  checkOnboardingCompleted,
};

const User = require("../models/User");

exports.updateOnboarding = async (req, res) => {
  try {
    const userId = req.user.id;
    const { step, data } = req.body;

    // Validate step input
    if (!step || typeof step !== "number") {
      return res.status(400).json({ error: "Step is required and must be a number" });
    }

    // Get user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(403).json({ error: "User not found" });
    }

    // Validate step progression - step must equal user.onboardingStep + 1
    if (step !== user.onboardingStep + 1) {
      return res.status(400).json({ error: "Invalid step progression" });
    }

    // Process based on step
    switch (step) {
      case 1:
        // Require username, set username, set isEmailVerified = true
        if (!data || !data.username || typeof data.username !== "string") {
          return res.status(400).json({ error: "Username is required" });
        }
        user.username = data.username.toLowerCase().trim();
        user.isEmailVerified = true;
        break;

      case 2:
        // Set role = "seller"
        user.role = "seller";
        break;

      case 3:
        // Set fullName, description, skills
        if (!data || !data.fullName || !data.description || !Array.isArray(data.skills)) {
          return res.status(400).json({ error: "fullName, description, and skills are required" });
        }
        user.fullName = data.fullName.trim();
        user.description = data.description.trim();
        user.skills = data.skills;
        break;

      case 4:
        // Set isPhoneVerified = true
        user.isPhoneVerified = true;
        break;

      case 6:
        // Set isIdVerified = true
        user.isIdVerified = true;
        break;

      default:
        return res.status(400).json({ error: "Invalid step" });
    }

    // Update onboardingStep
    user.onboardingStep = step;

    // Check if onboarding is complete (step 6)
    if (step === 6) {
      user.onboardingCompleted = true;
    }

    // Save user
    await user.save();

    res.json({
      msg: "Step completed",
      step: user.onboardingStep,
    });
  } catch (error) {
    console.error("Onboarding error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

exports.getStatus = async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(403).json({ error: "User not found" });
    }

    res.json({
      completed: user.onboardingCompleted,
      step: user.onboardingStep,
    });
  } catch (error) {
    console.error("Get onboarding status error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

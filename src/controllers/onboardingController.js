const User = require("../models/User");

exports.updateOnboarding = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { step, data } = req.body;

    // Validate step input
    if (!step || typeof step !== "number") {
      return res
        .status(400)
        .json({ error: "Step is required and must be a number" });
    }

    // Get user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(403).json({ error: "User not found" });
    }

    // ✅ ENFORCE EMAIL VERIFICATION BEFORE ANY ONBOARDING PROGRESSION
    // Email must be verified before progressing to Step 1
    if (step >= 1 && !user.emailVerified) {
      return res.status(403).json({
        error: "Email verification required before onboarding",
        emailVerified: false,
      });
    }

    // Validate step progression - step must equal user.onboardingStep + 1
    if (step !== user.onboardingStep + 1) {
      return res.status(400).json({ error: "Invalid step progression" });
    }

    // Process based on step
    switch (step) {
      case 1:
        // STEP 1: Request phone number for verification
        if (!data || !data.phoneNumber || typeof data.phoneNumber !== "string") {
          return res.status(400).json({ error: "Phone number is required" });
        }
        // Store phone number (not verified yet)
        user.phoneNumber = data.phoneNumber.trim();
        // TODO: Send OTP to phone in production
        break;

      case 2:
        // STEP 2: Verify phone + select role
        if (!data || !data.role || !data.username) {
          return res.status(400).json({
            error: "Role (buyer/seller) and username are required",
          });
        }

        // Validate role
        const validRoles = ["buyer", "seller"];
        if (!validRoles.includes(data.role)) {
          return res.status(400).json({ error: "Role must be 'buyer' or 'seller'" });
        }

        // Set username
        user.username = data.username.toLowerCase().trim();

        // Mark phone as verified
        user.isPhoneVerified = true;

        // Set role
        user.role = data.role;

        // ✅ If buyer, mark onboarding as complete here
        if (data.role === "buyer") {
          user.onboardingCompleted = true;
        }
        break;

      case 3:
        // STEP 3: Seller profile (fullName, description, skills)
        // Only sellers proceed beyond Step 2
        if (user.role !== "seller") {
          return res.status(403).json({
            error: "Only sellers can proceed to Step 3",
          });
        }

        if (
          !data ||
          !data.fullName ||
          !data.description ||
          !Array.isArray(data.skills)
        ) {
          return res.status(400).json({
            error: "fullName, description, and skills are required",
          });
        }

        user.fullName = data.fullName.trim();
        user.description = data.description.trim();
        user.skills = data.skills;
        break;

      case 4:
        // STEP 4: Additional verification (placeholder)
        if (user.role !== "seller") {
          return res.status(403).json({
            error: "Only sellers can proceed to Step 4",
          });
        }
        break;

      case 5:
        // STEP 5: Additional verification (placeholder)
        if (user.role !== "seller") {
          return res.status(403).json({
            error: "Only sellers can proceed to Step 5",
          });
        }
        break;

      case 6:
        // STEP 6: ID verification (sellers only)
        if (user.role !== "seller") {
          return res.status(403).json({
            error: "Only sellers can proceed to Step 6",
          });
        }

        user.isIdVerified = true;
        user.onboardingCompleted = true;
        break;

      default:
        return res.status(400).json({ error: "Invalid step" });
    }

    // Update onboardingStep
    user.onboardingStep = step;

    // Save user
    await user.save();

    res.json({
      msg: "Step completed",
      step: user.onboardingStep,
      completed: user.onboardingCompleted,
    });
  } catch (error) {
    console.error("Onboarding error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

exports.getStatus = async (req, res) => {
  try {
    const userId = req.user.userId;

    // Get user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(403).json({ error: "User not found" });
    }

    res.json({
      completed: user.onboardingCompleted,
      step: user.onboardingStep,
      emailVerified: user.emailVerified,
      phoneVerified: user.isPhoneVerified,
      role: user.role,
    });
  } catch (error) {
    console.error("Get onboarding status error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

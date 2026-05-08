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
    console.log("User onboarding step:", user);
    // Validate step progression - step must equal user.onboardingStep + 1
    if (step !== user.onboardingStep + 1) {
      return res.status(400).json({ error: "Invalid step progression" });
    }

    // Process based on step
    switch (step) {
      case 1:
        // STEP 1: Request phone number for verification
        if (
          !data ||
          !data.phoneNumber ||
          typeof data.phoneNumber !== "string"
        ) {
          return res.status(400).json({ error: "Phone number is required" });
        }
        // Store phone number (not verified yet)
        user.phoneNumber = data.phoneNumber.trim();
        // TODO: Send OTP to phone in production
        break;

      case 2:
        if (!data || !data.role || !data.username) {
          return res.status(400).json({
            error: "Role (buyer/seller) and username are required",
          });
        }

        // Validate role
        const validRoles = ["buyer", "seller"];
        if (!validRoles.includes(data.role)) {
          return res
            .status(400)
            .json({ error: "Role must be 'buyer' or 'seller'" });
        }

        // Set username
        user.username = data.username.toLowerCase().trim();

        // Mark phone as verified
        user.isPhoneVerified = true;

        // Set role
        user.role = data.role;

        // ✅ If buyer, mark onboarding as complete here (MAX STEP = 2)
        if (data.role === "buyer") {
          user.onboardingCompleted = true;
        }
        // ✅ If seller, continue to Step 3
        break;

      case 3:
        // STEP 3: Seller profile (fullName, description, skills)
        // ✅ ENFORCE: Only sellers can proceed beyond step 2
        if (user.role !== "seller") {
          return res.status(403).json({
            error:
              "Only sellers can proceed to Step 3. Buyers complete at Step 2.",
          });
        }

        if (
          !data ||
          !data.fullName ||
          !data.description
          // !Array.isArray(data.skills)
        ) {
          return res.status(400).json({
            error: "fullName, description, and skills are required",
          });
        }

        user.fullName = data.fullName.trim();
        user.description = data.description.trim();
        // user.skills = data.skills;
        break;

      case 4:
        // STEP 4: Complete Seller Profile
        // ✅ ENFORCE: Sellers only
        if (user.role !== "seller") {
          return res.status(403).json({
            error: "Only sellers can proceed to Step 4",
          });
        }
        const {
          headline,
          about,
          tagline,
          avatar, // base64 string or URL
          coverPhoto, // base64 string or URL
          skills: incomingSkills,
        } = req.body.data || {};

        // ---------- Required Fields Validation ----------
        // Priority: incoming payload > existing DB value > null
      
        const finalHeadline =
          headline !== undefined ? headline : user.profile?.headline;
        if (!finalHeadline || finalHeadline.trim() === "") {
          return res.status(400).json({
            error: "Profile headline is required to complete Step 4",
            missingFields: ["headline"],
          });
        }

        const finalAbout = about !== undefined ? about : user.profile?.about;
        if (!finalAbout || finalAbout.trim() === "") {
          return res.status(400).json({
            error: "Profile about/bio is required to complete Step 4",
            missingFields: ["about"],
          });
        }

        let finalSkills =
          incomingSkills !== undefined
            ? incomingSkills
            : user.sellerProfile?.skills;
        if (!Array.isArray(finalSkills) || finalSkills.length === 0) {
          return res.status(400).json({
            error: "At least one skill is required to complete Step 4",
            missingFields: ["skills"],
          });
        }

        // Optional: length validations (add if needed)
        if (finalHeadline.length < 5) {
          return res.status(400).json({
            error: "Headline must be at least 5 characters",
          });
        }
        if (finalAbout.length < 10 || finalAbout.length > 500) {
          return res.status(400).json({
            error: "About must be between 10 and 500 characters",
          });
        }
        if (tagline && tagline.length > 100) {
          return res.status(400).json({
            error: "Tagline must be less than 100 characters",
          });
        }
        // ---------- Prepare Updates ----------
        const profileUpdate = {};
        if (headline !== undefined) profileUpdate.headline = finalHeadline;
        if (about !== undefined) profileUpdate.about = finalAbout;
        if (tagline !== undefined) profileUpdate.tagline = tagline;
        if (avatar !== undefined) profileUpdate.avatar = avatar; // save base64 or URL
        if (coverPhoto !== undefined) profileUpdate.coverPhoto = coverPhoto;

        const sellerProfileUpdate = {};
        if (incomingSkills !== undefined)
          sellerProfileUpdate.skills = finalSkills;
        // ---------- Apply Updates ----------
        user.profile = {
          ...user.profile,
          ...profileUpdate,
        };
        user.sellerProfile = {
          ...user.sellerProfile,
          ...sellerProfileUpdate,
        };
        break;
      case 5:
        // STEP 5: Additional verification / Gig deployment
        // ✅ ENFORCE: Sellers only
        if (user.role !== "seller") {
          return res.status(403).json({
            error: "Only sellers can proceed to Step 5",
          });
        }
        // TODO: Validation for step 5
        break;

      case 6:
        // STEP 6: ID verification - final seller step
        // ✅ ENFORCE: Sellers only
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

    // ✅ Track completed and verified step
    if (!user.completedSteps.includes(step)) {
      user.completedSteps.push(step);
      user.completedSteps.sort((a, b) => a - b); // Keep sorted
    }

    // Save user
    await user.save();

    // ✅ Calculate next step based on role
    let nextStep = null;
    if (user.role === "buyer" && step === 2) {
      // Buyers end at step 2
      nextStep = null;
    } else if (user.role === "seller") {
      // Sellers: 1 -> 2 -> 3 -> 4 -> 5 -> 6
      if (step < 6) {
        nextStep = step + 1;
      } else {
        nextStep = null; // All steps complete
      }
    } else {
      // Default progression
      nextStep = step + 1;
    }

    res.json({
      msg: "Step completed successfully and verified",
      completedStep: step,
      completedSteps: user.completedSteps,
      nextStep: nextStep,
      onboardingCompleted: user.onboardingCompleted,
      role: user.role,
      status: "verified",
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

    // ✅ Calculate next step based on role
    let nextStep = null;
    if (user.role === "buyer" && user.onboardingStep === 2) {
      nextStep = null; // Buyers end at step 2
    } else if (user.role === "seller") {
      if (user.onboardingStep < 6) {
        nextStep = user.onboardingStep + 1;
      } else {
        nextStep = null;
      }
    } else {
      if (user.onboardingStep < 6) {
        nextStep = user.onboardingStep + 1;
      }
    }

    res.json({
      onboardingCompleted: user.onboardingCompleted,
      currentStep: user.onboardingStep,
      onboardingStep: user.onboardingStep,
      provider: user.authProvider,
      completedSteps: user.completedSteps || [],
      nextStep: nextStep,
      email:user.email || null,
      emailVerified: user.emailVerified,
      phoneVerified: user.isPhoneVerified,
      role: user.role,
    });
  } catch (error) {
    console.error("Get onboarding status error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * Verify phone number (temporary placeholder for Twilio)
 * POST /onboarding/verify-phone
 *
 * In production, this would validate OTP sent to phone
 * For now, it's a simple verification endpoint
 */
exports.verifyPhone = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { otp } = req.body; // Placeholder: in production, verify OTP validity

    // Get user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(403).json({ error: "User not found" });
    }

    // Ensure email is verified first
    if (!user.emailVerified) {
      return res.status(403).json({
        error: "Email must be verified before phone verification",
      });
    }

    // Ensure user has provided a phone number (Step 1)
    if (!user.phoneNumber) {
      return res.status(400).json({
        error: "Phone number not provided. Complete Step 1 first",
      });
    }

    // Ensure phone hasn't already been verified
    if (user.phoneVerified) {
      return res.status(400).json({
        error: "Phone already verified",
      });
    }

    // TODO: In production, validate OTP here
    // For now, accept any OTP (temporary placeholder)
    if (!otp) {
      return res.status(400).json({
        error: "OTP is required",
      });
    }

    // Mark phone as verified
    user.phoneVerified = true;

    // Save user
    await user.save();

    res.json({
      msg: "Phone verified successfully",
      phoneVerified: true,
    });
  } catch (error) {
    console.error("Phone verification error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * STEP 0: Add email for wallet users
 * POST /onboarding/add-email
 *
 * Wallet users collect email during onboarding Step 0
 * This endpoint:
 * - Validates email doesn't already exist
 * - Saves email to user
 * - Generates verification token
 * - Sends verification email
 * - DO NOT advance to next step (user must verify email)
 */
exports.addEmail = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { email } = req.body;

    // Validation
    if (!email) {
      return res.status(400).json({
        error: "Email is required",
      });
    }

    // Get user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(403).json({ error: "User not found" });
    }

    // ✅ ENFORCE: Only wallet users at Step 0 can add email
    if (user.authProvider !== "wallet") {
      return res.status(403).json({
        error: "Only wallet users can use this endpoint",
      });
    }

    if (user.onboardingStep !== 0) {
      return res.status(403).json({
        error:
          "Email can only be added at Step 0. Current step: " +
          user.onboardingStep,
      });
    }

    // ✅ Prevent overwriting existing email
    if (user.email) {
      return res.status(400).json({
        error: "User already has an email address",
      });
    }

    // ✅ Prevent duplicate emails (check unique constraint)
    const normalizedEmail = email.toLowerCase().trim();
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(409).json({
        error: "This email is already registered",
      });
    }

    // ✅ Generate OTP for email verification (same as register flow)
    const { generateOtp } = require("../utils/generateOtp");
    const { otp, expiresAt } = generateOtp();

    // Save email and OTP to user
    user.email = normalizedEmail;
    user.emailOtp = otp;
    user.emailOtpExpires = expiresAt;
    user.emailOtpAttempts = 0;
    user.emailVerified = false;
    user.lastOtpSentAt = new Date(); // Record OTP send time for cooldown

    await user.save();

    // Send OTP email (reuse existing logic)
    try {
      const { sendOtpEmail } = require("../utils/email");
      await sendOtpEmail(user, otp);

      // ✅ Record attempt for rate limiting
      const ONE_HOUR = 60 * 60 * 1000;
      const recentAttempts = (user.otpSendAttempts || []).filter(
        (attempt) => Date.now() - new Date(attempt).getTime() < ONE_HOUR,
      );
      recentAttempts.push(new Date());
      user.otpSendAttempts = recentAttempts;
      await user.save();

      res.status(200).json({
        msg: "OTP sent to your email. Please check your inbox.",
        email: normalizedEmail,
        step: 0,
        nextAction: "Enter OTP to verify email and proceed to Step 1",
      });
    } catch (emailError) {
      console.error("Failed to send OTP email:", emailError.message);
      // Remove email and OTP if email sending fails
      user.email = null;
      user.emailOtp = null;
      user.emailOtpExpires = null;
      await user.save();

      res.status(500).json({
        error: "Failed to send OTP email. Please try again.",
      });
    }
  } catch (error) {
    console.error("Add email error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

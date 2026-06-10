const User = require("../models/User");

/**
 * Helper: Generate unique username
 * Tries base, then base + 123, base + 456, etc.
 */
const generateUniqueUsername = async (baseUsername) => {
  if (!baseUsername || typeof baseUsername !== "string") {
    throw new Error("Base username is required");
  }

  const normalized = baseUsername.toLowerCase().trim();

  // Check if base username is available
  let existingUser = await User.findOne({ username: normalized });
  if (!existingUser) {
    return normalized; // Base username is available
  }

  // Try variations: base123, base456, etc.
  for (let i = 1; i <= 100; i++) {
    const variation = `${normalized}${Math.floor(Math.random() * 1000)}`;
    existingUser = await User.findOne({ username: variation });
    if (!existingUser) {
      return variation; // Found available variation
    }
  }

  throw new Error("Unable to generate unique username after multiple attempts");
};

/**
 * Helper: Get missing identity fields based on auth provider
 * Returns array of fields that need to be collected
 */
const getMissingFields = (user) => {
  const missing = [];

  if (!user) return ["email", "fullName", "username"];

  const provider = user.authProvider;

  // Email auth: requires fullName and username
  if (provider === "email" || !provider) {
    if (!user.fullName) missing.push("fullName");
    if (!user.username) missing.push("username");
    return missing;
  }

  // Google auth: provides displayName and picture
  // Should auto-generate username
  if (provider === "google") {
    if (!user.fullName) missing.push("fullName");
    if (!user.username) missing.push("username");
    return missing;
  }

  // GitHub auth: provides name and login
  // Should use login as username
  if (provider === "github") {
    if (!user.fullName) missing.push("fullName");
    if (!user.username) missing.push("username");
    return missing;
  }

  // Wallet auth: requires email, fullName, username
  if (provider === "wallet") {
    if (!user.email) missing.push("email");
    if (!user.fullName) missing.push("fullName");
    if (!user.username) missing.push("username");
    return missing;
  }

  return missing;
};

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
        // STEP 2: Role selection
        // ✅ ALL USERS (buyers and sellers) continue through full 6-step process
        // Role selection only determines profile/gig features, not onboarding completion
        if (!data || !data.role) {
          return res.status(400).json({
            error: "Role (buyer/seller) is required",
          });
        }

        // Validate role
        const validRoles = ["buyer", "seller"];
        if (!validRoles.includes(data.role)) {
          return res
            .status(400)
            .json({ error: "Role must be 'buyer' or 'seller'" });
        }

        // ✅ ENFORCE: Identity must be complete before proceeding
        if (!user.fullName || !user.username) {
          return res.status(400).json({
            error:
              "Identity information (fullName, username) must be completed first",
            missingFields: getMissingFields(user),
          });
        }

        // Mark phone as verified
        user.isPhoneVerified = true;

        // Set role
        user.role = data.role;

        // ✅ IMPORTANT: Both buyers and sellers continue to Step 3+
        // Frontend will decide what profile features to show based on role
        // Do NOT mark as complete - all users go through full 6-step process
        break;

      case 3:
        // STEP 3: Profile description
        // ✅ ALL USERS provide description (buyers and sellers)
        // Both roles collect this data for comprehensive profile information
        if (!data || !data.sellerIntro.bio) {
          return res.status(400).json({
            error: "seller Bio  is required",
          });
        }

        user.sellerProfile.bio = data?.sellerIntro.bio.trim();
        break;

      case 4:
        // STEP 4: Profile Foundation (Universal - all users)
        // Collect headline, tagline, about, avatar, coverPhoto
        // ✅ ALL USERS provide profile information (buyers and sellers)
        // Frontend decides how to use this data based on role
        const {
          headline,
          bio,
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

        const finalAbout = bio !== undefined ? bio : user.profile?.about;
        if (!finalAbout || finalAbout.trim() === "") {
          return res.status(400).json({
            error: "Profile about/bio is required to complete Step 4",
            missingFields: ["bio"],
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
        if (bio !== undefined) profileUpdate.about = finalAbout;
        if (tagline !== undefined) profileUpdate.tagline = tagline;
        if (avatar !== undefined) profileUpdate.avatar = avatar; // save base64 or URL
        if (coverPhoto !== undefined) profileUpdate.coverPhoto = coverPhoto;

        const sellerProfileUpdate = {};
        if (incomingSkills !== undefined)
          sellerProfileUpdate.skills = finalSkills;
        user.profileImage = {
          url: avatar || user.profileImage?.url || null,
          publicId: user.profileImage?.publicId || null,
        };
        user.coverImage = {
          url: coverPhoto || user.coverImage?.url || null,
          publicId: user.coverImage?.publicId || null,
        };
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
        if (!data || !data.documentType) {
          return res.status(400).json({ error: "documentType required" });
        }
        if (!data.image || !data.image.url) {
          return res.status(400).json({ error: "image.url required" });
        }

        // Ensure verificationDocument exists as an object
        if (
          !user.verificationDocument ||
          typeof user.verificationDocument === "string"
        ) {
          user.verificationDocument = { image: {} };
        }
        if (!user.verificationDocument.image) {
          user.verificationDocument.image = {};
        }

        user.verificationDocument.type = data.documentType;
        user.verificationDocument.image.url = data.image.url;
        user.verificationDocument.image.publicId = data.image.publicId || null;

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

    // ✅ Calculate next step - ALL users follow same path: 1 -> 2 -> 3 -> 4 -> 5 -> 6
    let nextStep = null;
    if (step < 6) {
      nextStep = step + 1;
    } else {
      nextStep = null; // All steps complete
    }

    res.json({
      msg: "Step completed successfully and verified",
      completedStep: step,
      user: user,
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

    // ✅ Calculate next step - ALL users follow same path: 1 -> 2 -> 3 -> 4 -> 5 -> 6
    let nextStep = null;
    if (user.onboardingStep < 6) {
      nextStep = user.onboardingStep + 1;
    } else {
      nextStep = null; // All steps complete
    }

    res.json({
      onboardingCompleted: user.onboardingCompleted,
      currentStep: user.onboardingStep,
      onboardingStep: user.onboardingStep,
      provider: user.authProvider,
      completedSteps: user.completedSteps || [],
      nextStep: nextStep,
      email: user.email || null,
      emailVerified: user.emailVerified,
      phoneVerified: user.isPhoneVerified,
      role: user.role,
      fullName: user.fullName || null,
      username: user.username || null,
      missingFields: getMissingFields(user),
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
 * STEP 0: Setup Identity for Wallet Users
 * POST /onboarding/setup-identity
 *
 * Wallet users collect email, fullName, and username during Step 0
 * This endpoint:
 * - Validates all three identity fields
 * - Ensures email uniqueness
 * - Generates unique username
 * - Generates OTP for email verification
 * - Sends verification email
 * - DO NOT advance onboardingStep (user must verify email first)
 */
exports.setupIdentity = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { email, fullName, username } = req.body;

    // Validation
    if (!email || !fullName || !username) {
      return res.status(400).json({
        error: "email, fullName, and username are all required",
        missingFields: [],
      });
    }

    // Get user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(403).json({ error: "User not found" });
    }

    // ✅ ENFORCE: Only wallet users at Step 0 can setup identity
    if (user.authProvider !== "wallet") {
      return res.status(403).json({
        error: "Only wallet users can use this endpoint",
      });
    }

    if (user.onboardingStep !== 0) {
      return res.status(403).json({
        error:
          "Identity can only be set at Step 0. Current step: " +
          user.onboardingStep,
      });
    }

    // ✅ Normalize inputs
    const normalizedEmail = email.toLowerCase().trim();
    const normalizedFullName = fullName.trim();
    const normalizedUsername = username.toLowerCase().trim();

    // ✅ Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      return res.status(400).json({
        error: "Invalid email format",
      });
    }

    // ✅ Validate fullName (minimum 3 characters)
    if (normalizedFullName.length < 3) {
      return res.status(400).json({
        error: "Full name must be at least 3 characters",
      });
    }

    // ✅ Validate username (minimum 3 characters)
    if (normalizedUsername.length < 3) {
      return res.status(400).json({
        error: "Username must be at least 3 characters",
      });
    }

    // ✅ Prevent duplicate emails
    const existingUserByEmail = await User.findOne({
      email: normalizedEmail,
    });
    if (existingUserByEmail) {
      return res.status(409).json({
        error: "This email is already registered",
      });
    }

    // ✅ Check if username is available, or generate unique variation
    let finalUsername = normalizedUsername;
    const existingUserByUsername = await User.findOne({
      username: normalizedUsername,
    });
    if (existingUserByUsername) {
      // Generate unique variation
      finalUsername = await generateUniqueUsername(normalizedUsername);
    }

    // ✅ Generate OTP for email verification
    const { generateOtp } = require("../utils/generateOtp");
    const { otp, expiresAt } = generateOtp();

    // Save identity and OTP to user
    user.email = normalizedEmail;
    user.fullName = normalizedFullName;
    user.username = finalUsername;
    user.emailOtp = otp;
    user.emailOtpExpires = expiresAt;
    user.emailOtpAttempts = 0;
    user.emailVerified = false;
    user.lastOtpSentAt = new Date();

    await user.save();

    // Send OTP email
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
        msg: "Identity setup successful. OTP sent to your email.",
        email: normalizedEmail,
        fullName: normalizedFullName,
        username: finalUsername,
        step: 0,
        nextAction: "Verify email with OTP to proceed to Step 1",
      });
    } catch (emailError) {
      console.error("Failed to send OTP email:", emailError.message);
      // Remove identity and OTP if email sending fails
      user.email = null;
      user.fullName = null;
      user.username = null;
      user.emailOtp = null;
      user.emailOtpExpires = null;
      await user.save();

      res.status(500).json({
        error: "Failed to send OTP email. Please try again.",
      });
    }
  } catch (error) {
    console.error("Setup identity error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * LEGACY: Add email for wallet users (deprecated)
 * Use setupIdentity instead
 * Kept for backward compatibility
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

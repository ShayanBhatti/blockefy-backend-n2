const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const User = require("../models/User");
const {
  generateWallet,
  generateNonce,
  verifySignature,
  isValidAddress,
} = require("../utils/wallet");
const { sendOtpEmail } = require("../utils/email");
const { generateOtp } = require("../utils/generateOtp");

/**
 * ✅ Rate limiting helper - check if user can send another OTP
 * Limit: 3 OTP sends per hour
 */
const canSendOtp = (user) => {
  const ONE_HOUR = 60 * 60 * 1000; // milliseconds
  const MAX_ATTEMPTS = 3;

  if (!user.otpSendAttempts || user.otpSendAttempts.length === 0) {
    return true;
  }

  // Filter attempts from last hour
  const recentAttempts = user.otpSendAttempts.filter(
    (attempt) => Date.now() - new Date(attempt).getTime() < ONE_HOUR,
  );

  // Check if exceeded limit
  return recentAttempts.length < MAX_ATTEMPTS;
};

/**
 * Record OTP send attempt for rate limiting
 */
const recordOtpAttempt = async (user) => {
  const ONE_HOUR = 60 * 60 * 1000;

  // Remove attempts older than 1 hour
  const recentAttempts = (user.otpSendAttempts || []).filter(
    (attempt) => Date.now() - new Date(attempt).getTime() < ONE_HOUR,
  );

  // Add current attempt
  recentAttempts.push(new Date());
  user.otpSendAttempts = recentAttempts;

  await user.save();
};

/**
 * Generate JWT token
 */
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });
};
const register = async (req, res) => {
  try {
    const { email, password, fullName, username } = req.body;

    // Validation
    if (!email || !password || !fullName || !username) {
      return res.status(400).json({
        msg: "email, password, fullName, and username are required",
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [
        { email: email.toLowerCase() },
        { username: username.toLowerCase() },
      ],
    });

    if (existingUser) {
      return res.status(409).json({
        msg: "Email or username already exists",
      });
    }

    // Generate wallet
    const wallet = generateWallet();

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // ✅ Generate OTP for email verification
    const { otp, expiresAt } = generateOtp();

    // Create user
    const user = new User({
      email: email.toLowerCase(),
      password: hashedPassword,
      fullName,
      username: username.toLowerCase(),
      walletAddress: wallet.address,
      walletPrivateKey: wallet.privateKey,
      onboardingStep: 0,
      onboardingCompleted: false,
      role: "buyer",
      authProvider: "email",
      emailVerified: false,
      emailOtp: otp,
      emailOtpExpires: expiresAt,
      lastOtpSentAt: new Date(), // Record OTP send time for cooldown
    });

    await user.save();

    // Send OTP email
    try {
      await sendOtpEmail(user, otp);
      // ✅ Record attempt for rate limiting
      await recordOtpAttempt(user);
    } catch (emailError) {
      console.error("Failed to send OTP email:", emailError.message);
      // Don't fail registration if email sending fails, but log it
    }

    // Generate JWT token
    const token = generateToken(user._id);

    // Return user (excluding sensitive data)
    const userResponse = {
      _id: user._id,
      email: user.email,
      fullName: user.fullName,
      username: user.username,
      role: user.role,
      walletAddress: user.walletAddress,
      onboardingStep: user.onboardingStep,
      onboardingCompleted: user.onboardingCompleted,
      authProvider: user.authProvider,
    };

    res.status(201).json({
      msg: "User registered successfully. OTP sent to email.",
      token,
      user: userResponse,
      emailVerificationRequired: true,
    });
  } catch (error) {
    console.error("Register error:", error.message);
    res.status(500).json({ msg: "Registration failed" });
  }
};

/**
 * Login with email/password
 * POST /auth/login
 */
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({
        msg: "email and password are required",
      });
    }

    // Find user
    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      return res.status(401).json({
        msg: "Invalid email or password",
      });
    }

    // Check password
    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      return res.status(401).json({
        msg: "Invalid email or password",
      });
    }

    // Generate token
    const token = generateToken(user._id);

    // Return user (excluding sensitive data)
    const userResponse = {
      _id: user._id,
      email: user.email,
      fullName: user.fullName,
      username: user.username,
      role: user.role,
      walletAddress: user.walletAddress,
      onboardingStep: user.onboardingStep,
      onboardingCompleted: user.onboardingCompleted,
      authProvider: user.authProvider,
    };

    res.status(200).json({
      msg: "Login successful",
      token,
      user: userResponse,
    });
  } catch (error) {
    console.error("Login error:", error.message);
    res.status(500).json({ msg: "Login failed" });
  }
};

/**
 * Generate wallet nonce for signature verification
 * POST /auth/wallet/nonce
 * ✅ Stores nonce in MongoDB instead of memory
 */
const generateNonceController = async (req, res) => {
  try {
    console.log("Generating nonce for wallet authentication...");
    console.log("Request body:", req.body);
    const { address } = req.body;
    const walletAddress = address;

    // Validation
    if (!walletAddress) {
      return res.status(400).json({
        msg: "walletAddress is required",
      });
    }

    // Validate address format
    if (!isValidAddress(walletAddress)) {
      return res.status(400).json({
        msg: "Invalid wallet address",
      });
    }

    // Generate nonce
    const { nonce, expiresAt, message } = generateNonce();

    // Find or create wallet user to store nonce
    let user = await User.findOne({
      walletAddress: walletAddress.toLowerCase(),
    });

    if (!user) {
      // Create temporary document just for nonce storage
      user = new User({
        walletAddress: walletAddress.toLowerCase(),
        authProvider: "wallet",
        role: "buyer",
        onboardingStep: 0,
        onboardingCompleted: false,
      });
    }

    // Store nonce in database (15 minutes expiry)
    user.walletNonce = nonce;
    user.walletNonceExpires = expiresAt;
    await user.save();

    res.status(200).json({
      msg: "Nonce generated successfully",
      nonce,
      message,
      expiresAt,
    });
  } catch (error) {
    console.error("Generate nonce error:", error.message);
    res.status(500).json({ msg: "Failed to generate nonce" });
  }
};

/**
 * Verify wallet signature and authenticate
 * POST /auth/wallet/verify
 * ✅ Uses nonce from MongoDB
 */
const verifyWalletSignature = async (req, res) => {
  try {
    const { address, signature, message } = req.body;
    const walletAddress = address;
    // Validation
    if (!walletAddress || !signature || !message) {
      return res.status(400).json({
        msg: "walletAddress, signature, and message are required",
      });
    }

    // Validate address format
    if (!isValidAddress(walletAddress)) {
      return res.status(400).json({
        msg: "Invalid wallet address",
      });
    }

    // Verify signature
    let recoveredAddress;
    try {
      recoveredAddress = verifySignature(message, signature);
    } catch (error) {
      return res.status(401).json({
        msg: "Invalid signature",
      });
    }

    // Check if recovered address matches
    if (recoveredAddress.toLowerCase() !== walletAddress.toLowerCase()) {
      return res.status(401).json({
        msg: "Signature does not match wallet address",
      });
    }

    // Find user and check nonce from database
    let user = await User.findOne({
      walletAddress: walletAddress.toLowerCase(),
    });

    if (!user || !user.walletNonce) {
      return res.status(401).json({
        msg: "Nonce not found. Generate a nonce first.",
      });
    }

    // Check nonce expiration
    if (!user.walletNonceExpires || Date.now() > user.walletNonceExpires) {
      // Clear expired nonce
      user.walletNonce = null;
      user.walletNonceExpires = null;
      await user.save();

      return res.status(401).json({
        msg: "Nonce expired. Please generate a new one.",
      });
    }

    // Clear used nonce
    user.walletNonce = null;
    user.walletNonceExpires = null;

    // ✅ DO NOT auto-advance onboarding for wallet users
    // Wallet users stay at Step 0 until they verify email
    // Email remains null until Step 0 (add-email) completes
    // emailVerified remains false until email verification

    await user.save();

    // Generate JWT token
    const token = generateToken(user._id);

    // Return user (excluding sensitive data)
    const userResponse = {
      _id: user._id,
      email: user.email,
      fullName: user.fullName,
      username: user.username,
      role: user.role,
      walletAddress: user.walletAddress,
      onboardingStep: user.onboardingStep,
      onboardingCompleted: user.onboardingCompleted,
      authProvider: user.authProvider,
    };

    res.status(200).json({
      msg: "Wallet verification successful",
      token,
      user: userResponse,
    });
  } catch (error) {
    console.error("Wallet verification error:", error.message);
    res.status(500).json({ msg: "Wallet verification failed" });
  }
};

/**
 * Resend OTP for email verification
 * POST /auth/resend-otp
 * ✅ Rate limited to 3 attempts per hour
 */
const resendOtp = async (req, res) => {
  try {
    const { email } = req.body;

    // Validation
    if (!email) {
      return res.status(400).json({
        msg: "Email is required",
      });
    }

    // Find user
    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      // Don't reveal if email exists (security)
      return res.status(400).json({
        msg: "If this email is registered, an OTP will be sent.",
      });
    }

    // Check if already verified
    if (user.emailVerified) {
      return res.status(200).json({
        msg: "Email already verified",
      });
    }

    // ✅ COOLDOWN CHECK: 60-second delay between OTP sends
    const COOLDOWN_SECONDS = 60;
    if (user.lastOtpSentAt) {
      const timeSinceLastSend = Date.now() - new Date(user.lastOtpSentAt).getTime();
      const cooldownMillis = COOLDOWN_SECONDS * 1000;

      if (timeSinceLastSend < cooldownMillis) {
        const retryAfterSeconds = Math.ceil((cooldownMillis - timeSinceLastSend) / 1000);
        return res.status(429).json({
          success: false,
          msg: "Please wait before requesting another OTP.",
          retryAfter: retryAfterSeconds,
          retryAfterSeconds: retryAfterSeconds, // Explicit field for frontend
        });
      }
    }

    // ✅ RATE LIMIT CHECK: max 3 OTP sends per hour
    if (!canSendOtp(user)) {
      return res.status(429).json({
        success: false,
        msg: "Too many OTP requests. Please try again in 1 hour.",
        retryAfter: 3600, // 1 hour in seconds
        retryAfterSeconds: 3600,
      });
    }

    // ✅ Generate new OTP (invalidates previous OTP)
    const { otp, expiresAt } = generateOtp();

    // Update user with new OTP
    user.emailOtp = otp;
    user.emailOtpExpires = expiresAt;
    user.emailOtpAttempts = 0; // Reset failed attempts on new OTP
    user.lastOtpSentAt = new Date(); // Record send timestamp for cooldown

    // Send OTP email
    try {
      await sendOtpEmail(user, otp);
      // Record attempt for hourly rate limiting
      await recordOtpAttempt(user);

      res.status(200).json({
        success: true,
        msg: "OTP sent successfully. Check your inbox.",
        expiresIn: 900, // 15 minutes in seconds
      });
    } catch (emailError) {
      console.error("Failed to send OTP email:", emailError.message);
      // Reset tracking if email send fails
      user.lastOtpSentAt = null;
      await user.save();

      res.status(500).json({
        success: false,
        msg: "Failed to send OTP. Please try again.",
      });
    }
  } catch (error) {
    console.error("Resend OTP error:", error.message);
    res.status(500).json({ msg: "Server error" });
  }

    console.error("Resend OTP error:", error.message);
    res.status(500).json({ msg: "Server error" });
};  

/**
 * Verify OTP for email verification
 * POST /auth/verify-otp
 *
 * Request body:
 * {
 *   "email": "user@example.com",
 *   "otp": "483921"
 * }
 */
const verifyOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;

    // Validation
    if (!email || !otp) {
      return res.status(400).json({
        msg: "Email and OTP are required",
      });
    }

    // Find user by email
    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      return res.status(400).json({
        msg: "User not found",
      });
    }

    // Check if already verified
    if (user.emailVerified) {
      return res.status(200).json({
        msg: "Email already verified",
      });
    }

    // Check if OTP exists
    if (!user.emailOtp) {
      return res.status(400).json({
        msg: "No OTP found. Please request a new OTP.",
      });
    }

    // ✅ Check if OTP is expired
    if (!user.emailOtpExpires || Date.now() > user.emailOtpExpires) {
      user.emailOtp = null;
      user.emailOtpExpires = null;
      user.emailOtpAttempts = 0;
      await user.save();

      return res.status(400).json({
        msg: "OTP expired. Please request a new OTP.",
        expired: true,
      });
    }

    // ✅ Compare OTP
    if (user.emailOtp !== otp.trim()) {
      user.emailOtpAttempts = (user.emailOtpAttempts || 0) + 1;
      await user.save();

      return res.status(400).json({
        msg: "Invalid OTP",
        attempts: user.emailOtpAttempts,
      });
    }

    // ✅ OTP is valid - mark email as verified
    user.emailVerified = true;
    user.emailOtp = null;
    user.emailOtpExpires = null;
    user.emailOtpAttempts = 0;

    // ✅ For wallet users at Step 0, advance to Step 1 after email verification
    if (user.authProvider === "wallet" && user.onboardingStep === 0) {
      user.onboardingStep = 0;
    }

    await user.save();

    res.status(200).json({
      msg: "Email verified successfully",
      emailVerified: true,
      onboardingStep: user.onboardingStep,
    });
  } catch (error) {
    console.error("OTP verification error:", error.message);
    res.status(500).json({ msg: "OTP verification failed" });
  }
};

/**
 * Verify user email with token (deprecated - kept for backward compatibility)
 * GET /auth/verify-email?token=...
 * ✅ This endpoint is deprecated. Use /auth/verify-otp instead.
 */
const verifyEmail = async (req, res) => {
  try {
    const { token } = req.query;

    // Validation
    if (!token) {
      return res.status(400).json({
        msg: "Verification token is required",
      });
    }

    // Hash the token to compare with stored hash
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    // Find user with matching token
    const user = await User.findOne({
      emailVerificationToken: tokenHash,
    });

    if (!user) {
      return res.status(400).json({
        msg: "Invalid verification token",
      });
    }

    // ✅ Check if token is expired
    if (
      !user.emailVerificationExpires ||
      Date.now() > user.emailVerificationExpires
    ) {
      return res.status(400).json({
        msg: "Verification token expired. Please request a new one.",
        expired: true,
      });
    }

    // Check if already verified
    if (user.emailVerified) {
      return res.status(200).json({
        msg: "Email already verified",
      });
    }

    // Mark email as verified and remove token
    user.emailVerified = true;
    user.emailVerificationToken = null;
    user.emailVerificationExpires = null;

    // ✅ For wallet users at Step 0, advance to Step 1 after email verification
    if (user.authProvider === "wallet" && user.onboardingStep === 0) {
      user.onboardingStep = 1;
    }

    await user.save();

    res.status(200).json({
      msg: "Email verified successfully",
      emailVerified: true,
      onboardingStep: user.onboardingStep,
    });
  } catch (error) {
    console.error("Email verification error:", error.message);
    res.status(500).json({ msg: "Email verification failed" });
  }
};

/**
 * Handle OAuth callback (Google/GitHub)
 * Google/GitHub users are automatically verified
 * GET /auth/google/callback or /auth/github/callback
 */
const handleOAuthCallback = async (req, res) => {
  try {
    const user = req.user;

    if (!user) {
      return res.status(401).json({ msg: "Authentication failed" });
    }

    // Generate token
    const token = generateToken(user._id);

    // Return user (excluding sensitive data)
    const userResponse = {
      _id: user._id,
      email: user.email,
      fullName: user.fullName,
      username: user.username,
      role: user.role,
      walletAddress: user.walletAddress,
      onboardingStep: user.onboardingStep,
      onboardingCompleted: user.onboardingCompleted,
      authProvider: user.authProvider,
    };

    // Redirect to frontend with token (or return JSON)
    // For API: return JSON
    res.status(200).json({
      msg: "OAuth authentication successful",
      token,
      user: userResponse,
    });
  } catch (error) {
    console.error("OAuth callback error:", error.message);
    res.status(500).json({ msg: "OAuth authentication failed" });
  }
};

/**
 * Get current user info (protected route)
 * GET /auth/me
 */
const getCurrentUser = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);

    if (!user) {
      return res.status(404).json({ msg: "User not found" });
    }

    // Return user (excluding sensitive data)
    const userResponse = {
      _id: user._id,
      email: user.email,
      fullName: user.fullName,
      username: user.username,
      role: user.role,
      walletAddress: user.walletAddress,
      onboardingStep: user.onboardingStep,
      onboardingCompleted: user.onboardingCompleted,
      authProvider: user.authProvider,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };

    res.status(200).json({
      msg: "User info retrieved",
      user: userResponse,
    });
  } catch (error) {
    console.error("Get current user error:", error.message);
    res.status(500).json({ msg: "Failed to retrieve user info" });
  }
};

module.exports = {
  register,
  login,
  verifyEmail,
  verifyOtp,
  resendOtp,
  generateNonce: generateNonceController,
  verifyWalletSignature,
  handleOAuthCallback,
  getCurrentUser,
};

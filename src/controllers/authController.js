const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const User = require("../models/User");
const authService = require("../services/authService");
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
/**
 * Register with Email/Password
 * POST /auth/register
 * 
 * NEW BEHAVIOR (Provider Linking):
 * - If email exists with another provider (Google, GitHub):
 *   → Add Email provider to existing account
 * - If email exists with Email provider:
 *   → Reject (duplicate account)
 * - If email doesn't exist:
 *   → Create new account with Email provider
 */
const register = async (req, res) => {
  try {
    const { email, password, fullName, username } = req.body;

    // Validation
    if (!email || !password || !fullName || !username) {
      return res.status(400).json({
        msg: "email, password, fullName, and username are required",
      });
    }

    // Normalize inputs
    const normalizedEmail = email.toLowerCase();
    const normalizedUsername = username.toLowerCase();

    // ============================================================================
    // STEP 1: Check if user exists by email
    // ============================================================================
    let user = await authService.findUserByEmail(normalizedEmail);

    if (user) {
      // User exists - check email provider status
      const emailProviderConnected =
        user.authProviders?.email?.connected ?? false;

      if (emailProviderConnected) {
        // Email provider already connected - this is a duplicate account attempt
        authService.logAuthEvent("Email registration rejected - email already has email provider", {
          email: normalizedEmail,
          reason: "duplicate_email_with_email_provider",
        });

        return res.status(409).json({
          msg: "This email is already registered. Please use a different email or try logging in.",
          code: "EMAIL_ALREADY_REGISTERED",
        });
      }

      // Email provider not connected, but user exists with another provider
      // Case: User signed up with Google, now wants to add Email/Password
      authService.logAuthEvent("Adding Email provider to existing OAuth account", {
        userId: user._id,
        email: normalizedEmail,
        existingProviders: authService.getConnectedProviders(user),
      });

      try {
        // Hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Use service to add email provider
        user = await authService.addEmailProvider(
          user,
          normalizedEmail,
          hashedPassword
        );

        // Generate OTP for email verification
        const { otp, expiresAt } = generateOtp();
        user.emailOtp = otp;
        user.emailOtpExpires = expiresAt;
        user.lastOtpSentAt = new Date();
        await user.save();

        // Send OTP email
        try {
          await sendOtpEmail(user, otp);
          await recordOtpAttempt(user);
        } catch (emailError) {
          console.error("Failed to send OTP email:", emailError.message);
        }

        // Generate JWT token
        const token = generateToken(user._id);

        return res.status(201).json({
          msg: "Email provider added successfully. OTP sent to email.",
          code: "PROVIDER_LINKED",
          token,
          user: authService.buildUserResponse(user),
          emailVerificationRequired: true,
          isNewUser: false,
          providerLinked: true,
        });
      } catch (error) {
        if (error.code === "EMAIL_ALREADY_IN_USE") {
          return res.status(409).json({
            msg: "Email is already in use",
            code: "EMAIL_ALREADY_IN_USE",
          });
        }
        throw error;
      }
    }

    // ============================================================================
    // STEP 2: User doesn't exist - create new account with Email provider
    // ============================================================================

    // Check if username is already taken
    const existingUsername = await User.findOne({
      username: normalizedUsername,
    });

    if (existingUsername) {
      return res.status(409).json({
        msg: "Username already exists",
        code: "USERNAME_ALREADY_EXISTS",
      });
    }

    // Generate wallet
    const wallet = generateWallet();

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Generate OTP for email verification
    const { otp, expiresAt } = generateOtp();

    // Create new user with Email provider
    user = new User({
      email: normalizedEmail,
      password: hashedPassword,
      fullName,
      username: normalizedUsername,
      walletAddress: wallet.address,
      walletPrivateKey: wallet.privateKey,
      onboardingStep: 0,
      onboardingCompleted: false,
      role: "buyer",
      emailVerified: false,
      emailOtp: otp,
      emailOtpExpires: expiresAt,
      lastOtpSentAt: new Date(),

      // Initialize authProviders
      authProviders: {
        email: {
          connected: true,
          connectedAt: new Date(),
        },
        google: { connected: false },
        github: { connected: false },
        wallet: { connected: false },
      },

      // Backward compat
      authProvider: "email",
    });

    await user.save();

    // Send OTP email
    try {
      await sendOtpEmail(user, otp);
      await recordOtpAttempt(user);
    } catch (emailError) {
      console.error("Failed to send OTP email:", emailError.message);
    }

    // Generate JWT token
    const token = generateToken(user._id);

    authService.logAuthEvent("New account created via Email registration", {
      userId: user._id,
      email: user.email,
    });

    return res.status(201).json({
      msg: "User registered successfully. OTP sent to email.",
      code: "USER_CREATED",
      token,
      user: authService.buildUserResponse(user),
      emailVerificationRequired: true,
      isNewUser: true,
      providerLinked: true,
    });
  } catch (error) {
    authService.logAuthEvent("Email registration error", {
      error: error.message,
    });
    console.error("Register error:", error.message);
    res.status(500).json({
      msg: "Registration failed",
      code: "REGISTRATION_FAILED",
    });
  }
};

/**
 * Login with Email/Password
 * POST /auth/login
 * 
 * NEW BEHAVIOR (Provider Linking):
 * - Email can be associated with multiple providers
 * - Only login if Email provider is connected
 * - Password must match
 */
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({
        msg: "email and password are required",
        code: "MISSING_CREDENTIALS",
      });
    }

    // Find user by email
    const user = await authService.findUserByEmail(email);

    if (!user) {
      authService.logAuthEvent("Email login failed - user not found", {
        email: email.toLowerCase(),
      });

      return res.status(401).json({
        msg: "Invalid email or password",
        code: "INVALID_CREDENTIALS",
      });
    }

    // Check if Email provider is connected
    const emailProviderConnected =
      user.authProviders?.email?.connected ?? false;

    if (!emailProviderConnected) {
      authService.logAuthEvent("Email login failed - email provider not connected", {
        userId: user._id,
        email: user.email,
        connectedProviders: authService.getConnectedProviders(user),
      });

      // Provide helpful message
      const connectedProviders = authService.getConnectedProviders(user);
      return res.status(403).json({
        msg: `Email login is not enabled for this account. Try logging in with: ${connectedProviders.join(", ")}`,
        code: "EMAIL_PROVIDER_NOT_CONNECTED",
        connectedProviders,
      });
    }

    // Verify password
    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      authService.logAuthEvent("Email login failed - invalid password", {
        userId: user._id,
        email: user.email,
      });

      return res.status(401).json({
        msg: "Invalid email or password",
        code: "INVALID_CREDENTIALS",
      });
    }

    // Login successful
    const token = generateToken(user._id);

    authService.logAuthEvent("Email login successful", {
      userId: user._id,
      email: user.email,
    });

    res.status(200).json({
      msg: "Login successful",
      code: "LOGIN_SUCCESS",
      token,
      user: authService.buildUserResponse(user),
    });
  } catch (error) {
    authService.logAuthEvent("Email login error", {
      error: error.message,
    });
    console.error("Login error:", error.message);
    res.status(500).json({
      msg: "Login failed",
      code: "LOGIN_FAILED",
    });
  }
};

/**
 * Generate wallet nonce for signature verification
 * POST /auth/wallet/nonce
 * 
 * NEW BEHAVIOR (Provider Linking):
 * - Generate nonce for wallet signature verification
 * - Check if wallet user exists
 * - Check if wallet email conflicts with existing email account
 * - Prepare for account linking if needed
 */
const generateNonceController = async (req, res) => {
  try {
    authService.logAuthEvent("Wallet nonce generation initiated", {
      address: req.body.address,
    });

    const { address } = req.body;
    const walletAddress = address;

    // Validation
    if (!walletAddress) {
      return res.status(400).json({
        msg: "walletAddress is required",
        code: "MISSING_WALLET_ADDRESS",
      });
    }

    // Validate address format
    if (!isValidAddress(walletAddress)) {
      return res.status(400).json({
        msg: "Invalid wallet address",
        code: "INVALID_WALLET_ADDRESS",
      });
    }

    // Generate nonce
    const { nonce, expiresAt, message } = generateNonce();

    // Find or create wallet user for nonce storage
    let user = await User.findOne({
      "authProviders.wallet.walletAddress": walletAddress.toLowerCase(),
    });

    if (!user) {
      // Wallet not found, create temporary document for nonce storage
      user = new User({
        walletAddress: walletAddress.toLowerCase(),
        authProviders: {
          email: { connected: false },
          google: { connected: false },
          github: { connected: false },
          wallet: {
            connected: false,
            walletAddress: walletAddress.toLowerCase(),
          },
        },
        role: "buyer",
        onboardingStep: 0,
        onboardingCompleted: false,
      });
    }

    // Store nonce in database (15 minutes expiry)
    user.walletNonce = nonce;
    user.walletNonceExpires = expiresAt;
    await user.save();

    authService.logAuthEvent("Wallet nonce generated", {
      walletAddress: walletAddress.toLowerCase(),
      userId: user._id,
    });

    res.status(200).json({
      msg: "Nonce generated successfully",
      code: "NONCE_GENERATED",
      nonce,
      message,
      expiresAt,
    });
  } catch (error) {
    authService.logAuthEvent("Generate nonce error", {
      error: error.message,
    });
    console.error("Generate nonce error:", error.message);
    res.status(500).json({
      msg: "Failed to generate nonce",
      code: "NONCE_GENERATION_FAILED",
    });
  }
};

/**
 * Verify wallet signature and authenticate
 * POST /auth/wallet/verify
 * 
 * NEW BEHAVIOR (Provider Linking):
 * - Verify wallet signature
 * - Link wallet provider to existing user if email matches
 * - Create new wallet-only user if no email
 * - Support provider linking (email + wallet, OAuth + wallet)
 */
const verifyWalletSignature = async (req, res) => {
  try {
    const { address, signature, message } = req.body;
    const walletAddress = address;

    // Validation
    if (!walletAddress || !signature || !message) {
      return res.status(400).json({
        msg: "walletAddress, signature, and message are required",
        code: "MISSING_SIGNATURE_DATA",
      });
    }

    // Validate address format
    if (!isValidAddress(walletAddress)) {
      return res.status(400).json({
        msg: "Invalid wallet address",
        code: "INVALID_WALLET_ADDRESS",
      });
    }

    // Verify signature
    let recoveredAddress;
    try {
      recoveredAddress = verifySignature(message, signature);
    } catch (error) {
      return res.status(401).json({
        msg: "Invalid signature",
        code: "INVALID_SIGNATURE",
      });
    }

    // Check if recovered address matches
    if (recoveredAddress.toLowerCase() !== walletAddress.toLowerCase()) {
      return res.status(401).json({
        msg: "Signature does not match wallet address",
        code: "SIGNATURE_MISMATCH",
      });
    }

    // ============================================================================
    // STEP 1: Find user by wallet address
    // ============================================================================
    let user = await User.findOne({
      "authProviders.wallet.walletAddress": walletAddress.toLowerCase(),
    });

    // Also check legacy walletAddress field for backward compat
    if (!user) {
      user = await User.findOne({
        walletAddress: walletAddress.toLowerCase(),
      });
    }

    // ============================================================================
    // STEP 2: Verify nonce
    // ============================================================================
    if (!user || !user.walletNonce) {
      authService.logAuthEvent("Wallet verification failed - nonce not found", {
        walletAddress: walletAddress.toLowerCase(),
      });

      return res.status(401).json({
        msg: "Nonce not found. Generate a nonce first.",
        code: "NONCE_NOT_FOUND",
      });
    }

    // Check nonce expiration
    if (!user.walletNonceExpires || Date.now() > user.walletNonceExpires) {
      // Clear expired nonce
      user.walletNonce = null;
      user.walletNonceExpires = null;
      await user.save();

      authService.logAuthEvent("Wallet verification failed - nonce expired", {
        walletAddress: walletAddress.toLowerCase(),
      });

      return res.status(401).json({
        msg: "Nonce expired. Please generate a new one.",
        code: "NONCE_EXPIRED",
      });
    }

    // ============================================================================
    // STEP 3: Link wallet provider (if not already linked)
    // ============================================================================
    const walletConnected =
      user.authProviders?.wallet?.connected ?? false;

    if (!walletConnected) {
      // Link wallet provider to existing user
      user.authProviders = user.authProviders || {};
      user.authProviders.wallet = {
        connected: true,
        walletAddress: walletAddress.toLowerCase(),
        connectedAt: new Date(),
      };

      // Backward compat
      user.walletAddress = walletAddress.toLowerCase();
      user.authProvider = authService.getPrimaryProvider(user.authProviders);

      authService.logAuthEvent("Wallet provider linked to existing account", {
        userId: user._id,
        walletAddress: walletAddress.toLowerCase(),
      });
    } else {
      authService.logAuthEvent("Wallet provider already linked", {
        userId: user._id,
        walletAddress: walletAddress.toLowerCase(),
      });
    }

    // ============================================================================
    // STEP 4: Clear used nonce and save
    // ============================================================================
    user.walletNonce = null;
    user.walletNonceExpires = null;
    await user.save();

    // ============================================================================
    // STEP 5: Generate JWT token and return
    // ============================================================================
    const token = generateToken(user._id);

    res.status(200).json({
      msg: "Wallet verification successful",
      code: "WALLET_VERIFIED",
      token,
      user: authService.buildUserResponse(user),
    });
  } catch (error) {
    authService.logAuthEvent("Wallet verification error", {
      error: error.message,
    });
    console.error("Wallet verification error:", error.message);
    res.status(500).json({
      msg: "Wallet verification failed",
      code: "WALLET_VERIFICATION_FAILED",
    });
  }
};

/**
 * Resend OTP for email verification
 * POST /auth/resend-otp
 * 
 * NEW BEHAVIOR (Provider Linking):
 * - Rate limited to 3 attempts per hour
 * - 60-second cooldown between requests
 * - Support resend on any account with email provider
 */
const resendOtp = async (req, res) => {
  try {
    const { email } = req.body;

    // Validation
    if (!email) {
      return res.status(400).json({
        msg: "Email is required",
        code: "MISSING_EMAIL",
      });
    }

    // Find user
    const user = await authService.findUserByEmail(email);

    if (!user) {
      // Don't reveal if email exists (security)
      authService.logAuthEvent("Resend OTP - user not found", {
        email: email.toLowerCase(),
      });

      return res.status(400).json({
        msg: "If this email is registered, an OTP will be sent.",
        code: "OTP_SEND_PENDING",
      });
    }

    // Check if already verified
    if (user.emailVerified) {
      authService.logAuthEvent("Resend OTP - email already verified", {
        userId: user._id,
        email: user.email,
      });

      return res.status(200).json({
        msg: "Email already verified",
        code: "EMAIL_ALREADY_VERIFIED",
      });
    }

    // Check if email provider is enabled
    const emailProviderConnected =
      user.authProviders?.email?.connected ?? false;
    if (!emailProviderConnected) {
      authService.logAuthEvent("Resend OTP - email provider not connected", {
        userId: user._id,
        email: user.email,
      });

      return res.status(403).json({
        msg: "Email provider is not enabled for this account",
        code: "EMAIL_PROVIDER_NOT_CONNECTED",
      });
    }

    // ✅ COOLDOWN CHECK: 60-second delay between OTP sends
    const COOLDOWN_SECONDS = 60;
    if (user.lastOtpSentAt) {
      const timeSinceLastSend =
        Date.now() - new Date(user.lastOtpSentAt).getTime();
      const cooldownMillis = COOLDOWN_SECONDS * 1000;

      if (timeSinceLastSend < cooldownMillis) {
        const retryAfterSeconds = Math.ceil(
          (cooldownMillis - timeSinceLastSend) / 1000
        );

        authService.logAuthEvent("Resend OTP - cooldown active", {
          userId: user._id,
          email: user.email,
          retryAfter: retryAfterSeconds,
        });

        return res.status(429).json({
          success: false,
          msg: "Please wait before requesting another OTP.",
          code: "OTP_COOLDOWN",
          retryAfter: retryAfterSeconds,
          retryAfterSeconds: retryAfterSeconds,
        });
      }
    }

    // ✅ RATE LIMIT CHECK: max 3 OTP sends per hour
    if (!canSendOtp(user)) {
      authService.logAuthEvent("Resend OTP - rate limit exceeded", {
        userId: user._id,
        email: user.email,
      });

      return res.status(429).json({
        success: false,
        msg: "Too many OTP requests. Please try again in 1 hour.",
        code: "OTP_RATE_LIMIT",
        retryAfter: 3600,
        retryAfterSeconds: 3600,
      });
    }

    // ✅ Generate new OTP (invalidates previous OTP)
    const { otp, expiresAt } = generateOtp();

    // Update user with new OTP
    user.emailOtp = otp;
    user.emailOtpExpires = expiresAt;
    user.emailOtpAttempts = 0;
    user.lastOtpSentAt = new Date();

    // Send OTP email
    try {
      await sendOtpEmail(user, otp);
      await recordOtpAttempt(user);

      authService.logAuthEvent("OTP resent successfully", {
        userId: user._id,
        email: user.email,
      });

      res.status(200).json({
        success: true,
        msg: "OTP sent successfully. Check your inbox.",
        code: "OTP_SENT",
        expiresIn: 900,
      });
    } catch (emailError) {
      console.error("Failed to send OTP email:", emailError.message);
      user.lastOtpSentAt = null;
      await user.save();

      authService.logAuthEvent("Resend OTP - email send failed", {
        userId: user._id,
        email: user.email,
        error: emailError.message,
      });

      res.status(500).json({
        success: false,
        msg: "Failed to send OTP. Please try again.",
        code: "OTP_SEND_FAILED",
      });
    }
  } catch (error) {
    authService.logAuthEvent("Resend OTP error", {
      error: error.message,
    });
    console.error("Resend OTP error:", error.message);
    res.status(500).json({
      msg: "Server error",
      code: "RESEND_OTP_ERROR",
    });
  }
};  

/**
 * Verify OTP for email verification
 * POST /auth/verify-otp
 * 
 * NEW BEHAVIOR (Provider Linking):
 * - Verify OTP for email
 * - Support email verification on accounts with multiple providers
 * - Enable email-based login after verification
 */
const verifyOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;

    // Validation
    if (!email || !otp) {
      return res.status(400).json({
        msg: "Email and OTP are required",
        code: "MISSING_VERIFICATION_DATA",
      });
    }

    // Find user by email
    const user = await authService.findUserByEmail(email);

    if (!user) {
      authService.logAuthEvent("OTP verification failed - user not found", {
        email: email.toLowerCase(),
      });

      return res.status(400).json({
        msg: "User not found",
        code: "USER_NOT_FOUND",
      });
    }

    // Check if already verified
    if (user.emailVerified) {
      return res.status(200).json({
        msg: "Email already verified",
        code: "EMAIL_ALREADY_VERIFIED",
        user: authService.buildUserResponse(user),
      });
    }

    // Check if OTP exists
    if (!user.emailOtp) {
      return res.status(400).json({
        msg: "No OTP found. Please request a new OTP.",
        code: "OTP_NOT_FOUND",
      });
    }

    // Check if OTP is expired
    if (!user.emailOtpExpires || Date.now() > user.emailOtpExpires) {
      user.emailOtp = null;
      user.emailOtpExpires = null;
      user.emailOtpAttempts = 0;
      await user.save();

      authService.logAuthEvent("OTP verification failed - OTP expired", {
        userId: user._id,
        email: user.email,
      });

      return res.status(400).json({
        msg: "OTP expired. Please request a new OTP.",
        code: "OTP_EXPIRED",
        expired: true,
      });
    }

    // Compare OTP
    if (user.emailOtp !== otp.trim()) {
      user.emailOtpAttempts = (user.emailOtpAttempts || 0) + 1;
      await user.save();

      authService.logAuthEvent("OTP verification failed - invalid OTP", {
        userId: user._id,
        email: user.email,
        attempts: user.emailOtpAttempts,
      });

      return res.status(400).json({
        msg: "Invalid OTP",
        code: "INVALID_OTP",
        attempts: user.emailOtpAttempts,
      });
    }

    // OTP is valid - mark email as verified
    user.emailVerified = true;
    user.emailOtp = null;
    user.emailOtpExpires = null;
    user.emailOtpAttempts = 0;

    await user.save();

    authService.logAuthEvent("Email verified successfully", {
      userId: user._id,
      email: user.email,
      providers: authService.getConnectedProviders(user),
    });

    res.status(200).json({
      msg: "Email verified successfully",
      code: "EMAIL_VERIFIED",
      emailVerified: true,
      onboardingStep: user.onboardingStep,
      user: authService.buildUserResponse(user),
    });
  } catch (error) {
    authService.logAuthEvent("OTP verification error", {
      error: error.message,
    });
    console.error("OTP verification error:", error.message);
    res.status(500).json({
      msg: "OTP verification failed",
      code: "OTP_VERIFICATION_FAILED",
    });
  }
};

/**
 * Verify user email with token (DEPRECATED)
 * GET /auth/verify-email?token=...
 * 
 * DEPRECATED: Use /auth/verify-otp instead
 * Kept for backward compatibility
 */
const verifyEmail = async (req, res) => {
  try {
    const { token } = req.query;

    // Validation
    if (!token) {
      return res.status(400).json({
        msg: "Verification token is required",
        code: "MISSING_TOKEN",
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
        code: "INVALID_TOKEN",
      });
    }

    // Check if token is expired
    if (
      !user.emailVerificationExpires ||
      Date.now() > user.emailVerificationExpires
    ) {
      return res.status(400).json({
        msg: "Verification token expired. Please request a new one.",
        code: "TOKEN_EXPIRED",
        expired: true,
      });
    }

    // Check if already verified
    if (user.emailVerified) {
      return res.status(200).json({
        msg: "Email already verified",
        code: "EMAIL_ALREADY_VERIFIED",
        user: authService.buildUserResponse(user),
      });
    }

    // Mark email as verified and remove token
    user.emailVerified = true;
    user.emailVerificationToken = null;
    user.emailVerificationExpires = null;

    await user.save();

    authService.logAuthEvent("Email verified via legacy token", {
      userId: user._id,
      email: user.email,
    });

    res.status(200).json({
      msg: "Email verified successfully",
      code: "EMAIL_VERIFIED",
      emailVerified: true,
      onboardingStep: user.onboardingStep,
      user: authService.buildUserResponse(user),
    });
  } catch (error) {
    authService.logAuthEvent("Email verification error", {
      error: error.message,
    });
    console.error("Email verification error:", error.message);
    res.status(500).json({
      msg: "Email verification failed",
      code: "EMAIL_VERIFICATION_FAILED",
    });
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
 * 
 * NEW: Returns provider information
 */
const getCurrentUser = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);

    if (!user) {
      return res.status(404).json({
        msg: "User not found",
        code: "USER_NOT_FOUND",
      });
    }

    authService.logAuthEvent("Current user retrieved", {
      userId: user._id,
      email: user.email,
    });

    res.status(200).json({
      msg: "User info retrieved",
      code: "USER_INFO_RETRIEVED",
      user: authService.buildUserResponse(user),
    });
  } catch (error) {
    authService.logAuthEvent("Get current user error", {
      error: error.message,
    });
    console.error("Get current user error:", error.message);
    res.status(500).json({
      msg: "Failed to retrieve user info",
      code: "GET_USER_FAILED",
    });
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

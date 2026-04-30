const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const User = require("../models/User");
const { generateWallet, generateNonce, verifySignature, isValidAddress } = require("../utils/wallet");
const { sendVerificationEmail } = require("../utils/email");

/**
 * Generate JWT token
 */
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });
};

/**
 * Register new user with email/password and auto-generated wallet
 * POST /auth/register
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

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ email: email.toLowerCase() }, { username: username.toLowerCase() }],
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

    // Generate email verification token
    const emailVerificationToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto
      .createHash("sha256")
      .update(emailVerificationToken)
      .digest("hex");

    // Create user
    const user = new User({
      email: email.toLowerCase(),
      password: hashedPassword,
      fullName,
      username: username.toLowerCase(),
      walletAddress: wallet.address,
      walletPrivateKey: wallet.privateKey,
      onboardingStep: 1,
      onboardingCompleted: false,
      role: "buyer",
      authProvider: "email",
      emailVerified: false,
      emailVerificationToken: tokenHash,
      emailVerificationExpires: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
    });

    await user.save();

    // Send verification email
    try {
      await sendVerificationEmail(user, emailVerificationToken);
    } catch (emailError) {
      console.error("Failed to send verification email:", emailError.message);
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
      msg: "User registered successfully. Please verify your email.",
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
 */
const generateNonceController = async (req, res) => {
  try {
    const { walletAddress } = req.body;

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

    // Store nonce in memory/cache for verification
    // In production, use Redis: await redis.setex(walletAddress, 900, nonce);
    if (!global.nonceCache) {
      global.nonceCache = {};
    }
    global.nonceCache[walletAddress] = {
      nonce,
      expiresAt,
    };

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
 */
const verifyWalletSignature = async (req, res) => {
  try {
    const { walletAddress, signature, message } = req.body;

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

    // Check nonce expiration
    if (!global.nonceCache || !global.nonceCache[walletAddress]) {
      return res.status(401).json({
        msg: "Nonce expired or not found",
      });
    }

    const { expiresAt } = global.nonceCache[walletAddress];
    if (Date.now() > expiresAt) {
      delete global.nonceCache[walletAddress];
      return res.status(401).json({
        msg: "Nonce expired",
      });
    }

    // Clear used nonce
    delete global.nonceCache[walletAddress];

    // Find or create user
    let user = await User.findOne({ walletAddress: walletAddress.toLowerCase() });

    if (!user) {
      // Create new wallet user
      user = new User({
        walletAddress: walletAddress.toLowerCase(),
        authProvider: "wallet",
        role: "buyer",
        onboardingStep: 1,
        onboardingCompleted: false,
      });
      await user.save();
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
 * Verify user email with token
 * GET /auth/verify-email?token=...
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
    const tokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    // Find user with matching token and check expiry
    const user = await User.findOne({
      emailVerificationToken: tokenHash,
      emailVerificationExpires: { $gt: new Date() }, // Token not expired
    });

    if (!user) {
      return res.status(400).json({
        msg: "Invalid or expired verification token",
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

    await user.save();

    res.status(200).json({
      msg: "Email verified successfully",
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
  generateNonce: generateNonceController,
  verifyWalletSignature,
  handleOAuthCallback,
  getCurrentUser,
};

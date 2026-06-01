/**
 * Centralized Authentication Service
 * Handles unified provider linking logic
 * Prevents duplicate accounts when same email exists across different providers
 * 
 * Responsibilities:
 * - Find or create users by email
 * - Link authentication providers
 * - Update provider metadata
 * - Validate provider information
 * - Generate unified response structure
 */

const User = require("../models/User");
const bcrypt = require("bcryptjs");

/**
 * Log authentication events (without sensitive data)
 */
const logAuthEvent = (event, data) => {
  const sanitized = {
    ...data,
    password: data.password ? "***" : undefined,
    accessToken: data.accessToken ? "***" : undefined,
    refreshToken: data.refreshToken ? "***" : undefined,
    otp: data.otp ? "***" : undefined,
    signature: data.signature ? "***" : undefined,
  };
  console.log(`[AUTH] ${event}`, sanitized);
};

/**
 * Get the primary connected provider(s) for a user
 * Used for backward compatibility with single authProvider field
 */
const getPrimaryProvider = (authProviders) => {
  if (!authProviders) return null;

  // Priority order for display purposes
  if (authProviders.email?.connected) return "email";
  if (authProviders.google?.connected) return "google";
  if (authProviders.github?.connected) return "github";
  if (authProviders.wallet?.connected) return "wallet";

  return null;
};

/**
 * Build unified provider response object
 */
const getProviderStatus = (authProviders) => {
  return {
    email: authProviders?.email?.connected ?? false,
    google: authProviders?.google?.connected ?? false,
    github: authProviders?.github?.connected ?? false,
    wallet: authProviders?.wallet?.connected ?? false,
  };
};

/**
 * CORE SERVICE: Handle provider login (OAuth or email)
 * 
 * Flow:
 * 1. Search for user by email (primary identifier)
 * 2. If user exists:
 *    a. Check if provider already linked
 *    b. If linked: return user (normal login)
 *    c. If not linked: link provider and return user
 * 3. If user doesn't exist:
 *    a. Create new user
 *    b. Link provider
 *    c. Return user
 * 
 * @param {Object} providerData - Provider information
 * @param {string} providerData.provider - Provider name (email, google, github, wallet)
 * @param {string} providerData.email - Verified email address
 * @param {string} providerData.googleId - Google ID (for google provider)
 * @param {string} providerData.githubId - GitHub ID (for github provider)
 * @param {string} providerData.walletAddress - Wallet address (for wallet provider)
 * @param {string} providerData.fullName - Display name
 * @param {string} providerData.username - Username (optional for OAuth)
 * 
 * @returns {Object} {user, isNewUser, providerLinked, providers}
 */
const handleProviderLogin = async (providerData) => {
  const {
    provider,
    email,
    googleId,
    githubId,
    walletAddress,
    fullName,
    username,
  } = providerData;

  // Validation
  if (!provider) {
    throw new Error("Provider is required");
  }

  if (!email && !walletAddress) {
    throw new Error("Email or wallet address is required");
  }

  // Normalize email
  const normalizedEmail = email ? email.toLowerCase() : null;

  try {
    // Step 1: Search for existing user by email (primary identifier)
    let user = null;
    if (normalizedEmail) {
      user = await User.findOne({ email: normalizedEmail });
    }

    const isNewUser = !user;

    // Step 2a: User exists - check provider linking
    if (user) {
      const providers = user.authProviders || {};
      const providerConnected = providers[provider]?.connected ?? false;

      if (providerConnected) {
        // Provider already linked - normal login
        logAuthEvent(`${provider.toUpperCase()} login - existing provider`, {
          userId: user._id,
          email: user.email,
          provider,
        });

        return {
          user,
          isNewUser: false,
          providerLinked: true,
          providers: getProviderStatus(user.authProviders),
        };
      } else {
        // Provider not linked - link it now
        logAuthEvent(`Linking ${provider} to existing account`, {
          userId: user._id,
          email: user.email,
          provider,
        });

        // Link provider to existing account
        user.authProviders = user.authProviders || {};
        user.authProviders[provider] = {
          connected: true,
          connectedAt: new Date(),
        };

        // Update provider-specific IDs
        if (provider === "google" && googleId) {
          user.authProviders.google.googleId = googleId;
          user.googleId = googleId; // Backward compat
        }
        if (provider === "github" && githubId) {
          user.authProviders.github.githubId = githubId;
          user.githubId = githubId; // Backward compat
        }
        if (provider === "wallet" && walletAddress) {
          user.authProviders.wallet.walletAddress = walletAddress.toLowerCase();
          user.walletAddress = walletAddress.toLowerCase(); // Backward compat
        }

        // Update legacy authProvider field for backward compatibility
        user.authProvider = getPrimaryProvider(user.authProviders);

        // Mark email as verified for OAuth providers
        if (provider === "google" || provider === "github") {
          user.emailVerified = true;
        }

        // Update user info if not set
        if (fullName && !user.fullName) {
          user.fullName = fullName;
        }

        await user.save();

        logAuthEvent(`${provider.toUpperCase()} linked successfully`, {
          userId: user._id,
          email: user.email,
          provider,
        });

        return {
          user,
          isNewUser: false,
          providerLinked: true,
          providers: getProviderStatus(user.authProviders),
        };
      }
    }

    // Step 2b: User doesn't exist - create new user
    logAuthEvent(`Creating new account via ${provider}`, {
      email: normalizedEmail || walletAddress,
      provider,
    });

    // Generate username if not provided
    let generatedUsername = username;
    if (!generatedUsername && normalizedEmail) {
      generatedUsername = `${normalizedEmail.split("@")[0]}_${Date.now()}`;
    } else if (!generatedUsername && walletAddress) {
      generatedUsername = `wallet_${walletAddress.slice(-6)}_${Date.now()}`;
    }

    // Create new user
    user = new User({
      email: normalizedEmail,
      fullName: fullName || "User",
      username: generatedUsername?.toLowerCase(),
      role: "buyer",
      onboardingStep: 0,
      onboardingCompleted: false,

      // Initialize authProviders object with first provider
      authProviders: {
        email: { connected: false },
        google: { connected: false },
        github: { connected: false },
        wallet: { connected: false },
      },

      // Mark email as verified for OAuth providers (trusted)
      emailVerified: provider === "google" || provider === "github",
    });

    // Set provider-specific information
    if (provider === "email") {
      user.authProviders.email.connected = true;
      user.authProviders.email.connectedAt = new Date();
    } else if (provider === "google") {
      user.authProviders.google.connected = true;
      user.authProviders.google.googleId = googleId;
      user.authProviders.google.connectedAt = new Date();
      user.googleId = googleId; // Backward compat
    } else if (provider === "github") {
      user.authProviders.github.connected = true;
      user.authProviders.github.githubId = githubId;
      user.authProviders.github.connectedAt = new Date();
      user.githubId = githubId; // Backward compat
    } else if (provider === "wallet") {
      user.authProviders.wallet.connected = true;
      user.authProviders.wallet.walletAddress = walletAddress.toLowerCase();
      user.authProviders.wallet.connectedAt = new Date();
      user.walletAddress = walletAddress.toLowerCase(); // Backward compat
    }

    // Update legacy authProvider field for backward compatibility
    user.authProvider = provider;

    await user.save();

    logAuthEvent(`New account created via ${provider}`, {
      userId: user._id,
      email: user.email,
      provider,
    });

    return {
      user,
      isNewUser: true,
      providerLinked: true,
      providers: getProviderStatus(user.authProviders),
    };
  } catch (error) {
    logAuthEvent(`Provider login failed - ${provider}`, {
      error: error.message,
      email: normalizedEmail || walletAddress,
      provider,
    });
    throw error;
  }
};

/**
 * Add email provider to existing user (for email registration on OAuth account)
 * 
 * Used when user:
 * - Signs up with Google/GitHub/Wallet
 * - Later wants to add Email/Password login
 * 
 * @param {Object} user - User document
 * @param {string} email - Email address
 * @param {string} password - Password (hashed)
 * @returns {Object} Updated user
 */
const addEmailProvider = async (user, email, hashedPassword) => {
  if (!user) {
    throw new Error("User is required");
  }

  if (!email || !hashedPassword) {
    throw new Error("Email and hashed password are required");
  }

  const normalizedEmail = email.toLowerCase();

  // Check if email already in use
  const emailExists = await User.findOne({
    email: normalizedEmail,
    _id: { $ne: user._id },
  });

  if (emailExists) {
    const error = new Error("Email already in use");
    error.code = "EMAIL_ALREADY_IN_USE";
    throw error;
  }

  // Update user
  user.email = normalizedEmail;
  user.password = hashedPassword;

  user.authProviders = user.authProviders || {};
  user.authProviders.email = {
    connected: true,
    connectedAt: new Date(),
  };

  // Update legacy authProvider field
  user.authProvider = getPrimaryProvider(user.authProviders);

  await user.save();

  logAuthEvent("Email provider added to existing account", {
    userId: user._id,
    email: user.email,
  });

  return user;
};

/**
 * Find user by email (primary identifier)
 */
const findUserByEmail = async (email) => {
  if (!email) {
    throw new Error("Email is required");
  }

  return User.findOne({ email: email.toLowerCase() });
};

/**
 * Find user by provider identifier
 * Used for legacy lookups or direct provider ID searches
 */
const findUserByProviderId = async (provider, providerId) => {
  if (!provider || !providerId) {
    throw new Error("Provider and provider ID are required");
  }

  if (provider === "google") {
    return User.findOne({ "authProviders.google.googleId": providerId });
  } else if (provider === "github") {
    return User.findOne({ "authProviders.github.githubId": providerId });
  } else if (provider === "wallet") {
    return User.findOne({
      "authProviders.wallet.walletAddress": providerId.toLowerCase(),
    });
  }

  return null;
};

/**
 * Check if user has provider linked
 */
const hasProvider = (user, provider) => {
  if (!user || !user.authProviders) {
    return false;
  }
  return user.authProviders[provider]?.connected ?? false;
};

/**
 * Get connected providers for user
 */
const getConnectedProviders = (user) => {
  if (!user || !user.authProviders) {
    return [];
  }

  return Object.keys(user.authProviders).filter(
    (provider) => user.authProviders[provider]?.connected ?? false
  );
};

/**
 * Build unified user response with provider information
 */
const buildUserResponse = (user, includeProviders = true) => {
  const response = {
    _id: user._id,
    email: user.email,
    fullName: user.fullName,
    username: user.username,
    role: user.role,
    walletAddress: user.walletAddress || null,
    onboardingStep: user.onboardingStep,
    onboardingCompleted: user.onboardingCompleted,
    emailVerified: user.emailVerified,
  };

  if (includeProviders) {
    response.providers = getProviderStatus(user.authProviders);
    response.connectedProviders = getConnectedProviders(user);
  }

  return response;
};

module.exports = {
  handleProviderLogin,
  addEmailProvider,
  findUserByEmail,
  findUserByProviderId,
  hasProvider,
  getConnectedProviders,
  buildUserResponse,
  getPrimaryProvider,
  getProviderStatus,
  logAuthEvent,
};

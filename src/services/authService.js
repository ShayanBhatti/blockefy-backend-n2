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
 *
 * Wallet rule: a wallet signup keeps the address it signed for in
 * `walletAddress`. Only email / Google / GitHub signups are issued a custodial
 * wallet, because only those arrive without an address of their own.
 */

const User = require("../models/User");
const bcrypt = require("bcryptjs");
const { ethers } = require("ethers");

/**
 * Give an account that signed up WITHOUT a wallet one the backend can sign with.
 *
 * Only for email / Google / GitHub signups. Those users arrive with no address of
 * their own, and the contract gates every relayed call on the CALLER
 * (onlyClient / onlyFreelancer), so the backend has to hold a key for them.
 *
 * Must never run for a wallet signup: that user brought their own address and
 * minting a second one would publish their projects from an address they do not
 * control. See useConnectedWallet.
 *
 * @param {Object} user mongoose user document
 * @returns {{ address: string|null, changed: boolean }}
 */
const ensureCustodialWallet = (user) => {
  const address = user.walletAddress ? String(user.walletAddress) : null;
  const key = user.walletPrivateKey ? String(user.walletPrivateKey) : null;

  // Connected with MetaMask: the user owns this address, so leave it alone.
  if (user.walletMode === "external") return { address, changed: false };

  let derived = null;
  if (key) {
    try {
      derived = new ethers.Wallet(key).address;
    } catch (_) {
      derived = null; // unusable key, mint a replacement below
    }
  }

  if (derived && address && derived.toLowerCase() === address.toLowerCase()) {
    if (!user.walletMode) {
      user.walletMode = "custodial";
      return { address, changed: true };
    }
    return { address, changed: false };
  }

  const wallet = ethers.Wallet.createRandom();
  user.walletAddress = wallet.address;
  user.walletPrivateKey = wallet.privateKey;
  user.walletMode = "custodial";
  return { address: wallet.address, changed: true };
};

/**
 * Adopt the address a user connected, ONLY if they do not already own a wallet.
 *
 * An account created from email / Google / GitHub is issued a custodial wallet by
 * the backend, and that address stays theirs for good: connecting a browser
 * wallet records the identity link but never replaces `walletAddress`. Swapping
 * it would leave `walletPrivateKey` pointing at an address the user no longer
 * uses, which makes every relay fail.
 *
 * A wallet-primary signup (no wallet yet) adopts the connected address as-is.
 *
 * @param {Object} user mongoose user document
 * @returns {{ address: string|null, changed: boolean }}
 */
const useConnectedWallet = (user, walletAddress) => {
  const next = walletAddress ? String(walletAddress).toLowerCase() : null;
  if (!next) return { address: user.walletAddress || null, changed: false };

  const hasStoredKey = Boolean(user.walletPrivateKey) || Boolean(user.externalWallet?.privateKey);
  if (user.walletAddress && hasStoredKey) {
    // Already owns a wallet (custodial pair, or a wallet they imported a key
    // for). Keep it - the connected address is an identity link only.
    return { address: user.walletAddress, changed: false };
  }

  const current = user.walletAddress ? String(user.walletAddress).toLowerCase() : null;
  if (current === next) return { address: current, changed: false };

  user.walletAddress = next;
  user.walletMode = "external";
  return { address: next, changed: true };
};

/**
 * True when the backend can relay on-chain actions for this user.
 */
const canRelayOnChain = (user) => {
  try {
    const derived = new ethers.Wallet(String(user?.walletPrivateKey || "")).address;
    return Boolean(user?.walletAddress) && derived.toLowerCase() === String(user.walletAddress).toLowerCase();
  } catch (_) {
    return false;
  }
};

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

    // A wallet login often has no email. Without this, every reconnect would
    // create a brand new account for the same person.
    if (!user && provider === "wallet" && walletAddress) {
      user = await User.findOne({
        "authProviders.wallet.walletAddress": String(walletAddress).toLowerCase(),
      });
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

        // Repair accounts that predate custodial wallet provisioning, so a
        // returning Google/GitHub user can start a project right away. A wallet
        // login keeps the address it came in with and never mints one.
        if (provider !== "wallet" && ensureCustodialWallet(user).changed) {
          await user.save();
          logAuthEvent("Custodial wallet provisioned on repeat login", {
            userId: user._id,
            provider,
          });
        }

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
          // The connected address IS the user's wallet, so it becomes
          // user.walletAddress. Any custodial address this account was issued
          // earlier is dropped in favour of the one the user controls.
          useConnectedWallet(user, walletAddress);
          user.authProviders.wallet = {
            ...(user.authProviders.wallet || {}),
            connected: true,
            walletAddress: walletAddress.toLowerCase(),
            connectedAt: new Date(),
          };
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

      // A Google/GitHub login still needs a custodial key pair for the relay. A
      // wallet login already stored its own address above, so minting here
      // would replace the wallet the user actually controls.
      if (provider !== "wallet" && ensureCustodialWallet(user).changed) {
        logAuthEvent("Custodial wallet provisioned for existing account", {
          userId: user._id,
          provider,
        });
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

    // Create new user. A wallet login may have no email, and `email` carries a
    // sparse unique index. Sparse skips documents where the field is ABSENT, not
    // where it is null, so storing an explicit null would make the second
    // wallet-only signup fail with E11000. Leave the field out instead.
    user = new User({
      ...(normalizedEmail ? { email: normalizedEmail } : {}),
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
      // Wallet signup: the connected address becomes user.walletAddress as-is.
      // Nothing is generated - this is the address the user already controls.
      useConnectedWallet(user, walletAddress);
      user.authProviders.wallet.connected = true;
      user.authProviders.wallet.walletAddress = walletAddress.toLowerCase();
      user.authProviders.wallet.connectedAt = new Date();
    }

    // Email, Google and GitHub signups arrive with no wallet of their own, so
    // the backend issues them a custodial pair it can relay with.
    if (provider !== "wallet") {
      ensureCustodialWallet(user);
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
   // Lets the UI tell "no wallet linked yet" apart from "the backend cannot
   // relay yet". Everything on-chain is relayed by us, so this being true is
   // all the user needs - no wallet popup is required to start a project.
   canRelayOnChain: canRelayOnChain(user),
   walletMode: user.walletMode || (user.walletAddress ? "custodial" : null),
   linkedWalletAddress: user.authProviders?.wallet?.walletAddress || null,
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
ensureCustodialWallet,
useConnectedWallet,
canRelayOnChain,
  logAuthEvent,
};

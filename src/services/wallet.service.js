const mongoose = require("mongoose");
const { ethers } = require("ethers");
const User = require("../models/User");
const Transaction = require("../models/Transaction");
const ChainEvent = require("../models/ChainEvent");
const AppError = require("../utils/AppError");
const chainService = require("./chain.service");
const { generateOtp } = require("../utils/generateOtp");
// Held as a module (not destructured) so tests can stub the send without
// reaching into the email transport.
const emailUtils = require("../utils/email");

/**
 * Mongoose projection rules for this file - verified empirically, do not "tidy".
 *
 * 1. Any explicit projection switches the query to INCLUSION mode: only listed
 *    paths come back, so every field the code reads must be listed.
 * 2. Put `+`-prefixed paths LAST. If a `+` path is followed by a plain name,
 *    Mongoose silently drops the plain ones (`+a b` returned neither a nor b).
 * 3. `walletPrivateKey` must be listed PLAIN, not as `+walletPrivateKey`; it is
 *    not `select: false`, and a trailing `+walletPrivateKey` is ignored.
 * 4. `externalWallet.privateKey` IS `select: false`, so it needs `+`. But you
 *    cannot list a parent path and its child together - `externalWallet` +
 *    `+externalWallet.privateKey` throws Mongo code 31249 "Path collision".
 *    Select `externalWallet.address` (leaf) alongside `+externalWallet.privateKey`.
 *
 * Verified pattern:
 *   "<plain fields...> externalWallet.address +externalWallet.privateKey"
 */
const SENSITIVE_COOLDOWN_MS = 60 * 1000; // 60 seconds between requests
const MAX_SENSITIVE_ATTEMPTS = 3;
// Window the per-hour caps and the retry-after are measured over.
const ONE_HOUR = 60 * 60 * 1000;

/**
 * Track sensitive OTP send for rate limiting. Mirrors the shape used by the
 * auth controller so the same UX is enforced here.
 */
const recordSensitiveOtpSend = async (user) => {
  const recent = (user.sensitiveOtpSendAttempts || []).filter(
    (attempt) => Date.now() - new Date(attempt).getTime() < ONE_HOUR
  );
  recent.push(new Date());
  user.sensitiveOtpSendAttempts = recent;
  user.lastSensitiveOtpSentAt = new Date();
  await user.save();
};

/** Can the user request another sensitive action OTP? */
const canSendSensitiveOtp = (user) => {
  const attempts = (user.sensitiveOtpSendAttempts || []).filter(
    (attempt) => Date.now() - new Date(attempt).getTime() < ONE_HOUR
  );
  if (attempts.length >= MAX_SENSITIVE_ATTEMPTS) return false;

  // Enforce a short cooldown between requests, even if under the hourly cap.
  if (user.lastSensitiveOtpSentAt) {
    const last = new Date(user.lastSensitiveOtpSentAt).getTime();
    if (Date.now() - last < SENSITIVE_COOLDOWN_MS) return false;
  }
  return true;
};

/** Reveal key cooldown, expressed in seconds. */
const getSensitiveCooldownSeconds = (user) => {
  if (!user.lastSensitiveOtpSentAt) return 0;
  const elapsed = Date.now() - new Date(user.lastSensitiveOtpSentAt).getTime();
  const left = SENSITIVE_COOLDOWN_MS - elapsed;
  if (left <= 0) return 0;
  return Math.ceil(left / 1000);
};

/** Hourly retry-after for the sensitive OTP rate limit. */
const getSensitiveRetryAfterSeconds = (user) => {
  const attempts = (user.sensitiveOtpSendAttempts || []).filter(
    (attempt) => Date.now() - new Date(attempt).getTime() < ONE_HOUR
  );
  if (attempts.length === 0) return 0;
  const oldest = new Date(attempts[0]).getTime();
  const when = oldest + ONE_HOUR;
  const left = when - Date.now();
  if (left <= 0) return 0;
  return Math.ceil(left / 1000);
};

/** Derive the address that controls the stored private key. */
const deriveKeyAddress = (privateKey) => {
  try {
    return new ethers.Wallet(privateKey).address.toLowerCase();
  } catch (err) {
    throw new AppError("Stored wallet key is invalid", 500, "WALLET_KEY_INVALID");
  }
};

/**
 * Get the custodial wallet address. If the stored pair is misaligned, the user
 * has an "external" mode record with an unusable key and no fallback custodial
 * address — throw early.
 */
const getCustodialAddress = (user) => {
  if (user.walletAddress && user.walletPrivateKey) {
    const derived = deriveKeyAddress(user.walletPrivateKey);
    if (derived === String(user.walletAddress).toLowerCase()) {
      return user.walletAddress;
    }
    throw new AppError("Wallet address/key pair is misaligned", 500, "WALLET_MISMATCH");
  }

  // No usable pair.
  throw new AppError("No custodial wallet configured for this account", 409, "NO_WALLET");
};

/**
 * Wallet overview - read-only, chain-native balance.
 */
const getOverview = async (userId) => {
  const user = await User.findById(userId).select(
    "walletAddress walletPrivateKey walletMode authProviders lastKeyRevealedAt externalWallet.address +externalWallet.privateKey"
  );
  if (!user) throw new AppError("User not found", 404, "NOT_FOUND");

  let address = null;
  let canRelay = false;
  let hasUsableKey = false;

  try {
    address = getCustodialAddress(user);
    hasUsableKey = true;
    canRelay = chainService.canRelayOnChain
      ? chainService.canRelayOnChain(user)
      : (() => {
          try {
            deriveKeyAddress(user.walletPrivateKey);
            return true;
          } catch (_) {
            return false;
          }
        })();
  } catch (_) {
    hasUsableKey = false;
    canRelay = false;
  }

  const escrowTotalWei = await chainService
    .getTotalEscrowed()
    .catch((err) => {
      console.warn(`[WALLET] getTotalEscrowed failed: ${err.message}`);
      return 0n;
    });

  const linkedWalletAddress = user.authProviders?.wallet?.walletAddress || null;
  const externalAddress = user.externalWallet?.address || null;
  const hasExternalKey = Boolean(externalAddress && user.externalWallet?.privateKey);

  // Balance of the wallet that will actually sign new actions.
  const activeAddress = user.walletMode === "external" && hasExternalKey ? externalAddress : address;
  const activeBalanceWei = activeAddress
    ? await chainService.getNativeBalance(activeAddress).catch((err) => {
        console.warn(`[WALLET] getNativeBalance failed for ${activeAddress}: ${err.message}`);
        return 0n;
      })
    : 0n;

  // Balance of the custodial wallet, kept separate because projects published
  // before any import are still locked to it on-chain.
  const custodialBalanceWei =
    address && address !== activeAddress
      ? await chainService.getNativeBalance(address).catch(() => 0n)
      : 0n;

  return {
    address,
    hasUsableKey,
    canRelayOnChain: Boolean(canRelay),
    walletMode: user.walletMode || (hasUsableKey ? "custodial" : null),
    activeAddress,
    activeBalanceWei: activeBalanceWei.toString(),
    activeBalanceEth: ethers.formatEther(activeBalanceWei),
    custodialAddress: address,
    custodialBalanceWei: custodialBalanceWei.toString(),
    custodialBalanceEth: ethers.formatEther(custodialBalanceWei),
    externalAddress,
    hasExternalKey,
    balanceWei: activeBalanceWei.toString(),
    balanceEth: ethers.formatEther(activeBalanceWei),
    escrowTotalWei: escrowTotalWei.toString(),
    escrowTotalEth: ethers.formatEther(escrowTotalWei),
    linkedWalletAddress,
    hasCustodialKey: hasUsableKey,
    hasAnyKey: hasUsableKey || hasExternalKey,
    // Prompt for a key import only when the connected wallet IS this account's
    // wallet and no key for it is stored yet. An account issued a custodial
    // wallet signs with that instead, so its connected address is an identity
    // link only and must never be nagged about.
    linkedWalletNeedsImport: Boolean(
      linkedWalletAddress &&
        !hasUsableKey &&
        !hasExternalKey &&
        String(linkedWalletAddress).toLowerCase() ===
          String(activeAddress || user.walletAddress || "").toLowerCase()
    ),
    lastKeyRevealedAt: user.lastKeyRevealedAt || null,
  };
};

/**
 * Merge Mongo Transaction (money ledger) + ChainEvent (contract activity).
 * Read-only view for the wallet page; does not mutate balances.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {number} [params.limit]
 * @param {number} [params.page]
 */
const getHistory = async ({ userId, limit = 50, page = 1 }) => {
  const user = await User.findById(userId).select(
    "walletAddress walletPrivateKey walletMode authProviders lastKeyRevealedAt externalWallet.address +externalWallet.privateKey"
  );
  if (!user) throw new AppError("User not found", 404, "NOT_FOUND");

  // Report whichever address this account actually signs with. A wallet-signup
  // account has no custodial pair, so reporting only the custodial address would
  // show a misleading `null` next to its own activity.
  let address = null;
  try {
    address = getCustodialAddress(user);
  } catch (_) {
    address = user.externalWallet?.address || user.walletAddress || null;
  }

  const safeLimit = Math.max(1, Math.min(limit, 200));
  const safePage = Math.max(1, page);
  const skip = (safePage - 1) * safeLimit;

  const [transactions, events, totalTx, totalEv] = await Promise.all([
    Transaction.find({ userId })
      .select("-__v")
      .sort({ createdAt: -1, _id: -1 })
      .lean(),
    ChainEvent.find({ userId })
      .select("-__v")
      .sort({ createdAt: -1, _id: -1 })
      .lean(),
    Transaction.countDocuments({ userId }),
    ChainEvent.countDocuments({ userId }),
  ]);

  // Normalise to a unified view.
  const items = [];

  for (const t of transactions) {
    items.push({
      id: t._id.toString(),
      kind: "money",
      type: t.type,
      status: t.status,
      amount: t.amount,
      currency: t.currency,
      cryptoAmount: t.cryptoAmount,
      cryptoCurrency: t.cryptoCurrency,
      txHash: t.txHash || null,
      projectId: t.projectId ? t.projectId.toString() : null,
      milestoneId: t.milestoneId ? t.milestoneId.toString() : null,
      orderId: t.orderId ? t.orderId.toString() : null,
      description: t.description || null,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    });
  }

  for (const e of events) {
    items.push({
      id: e._id.toString(),
      kind: "contract",
      method: e.method,
      status: e.status,
      txHash: e.txHash || null,
      blockNumber: e.blockNumber || null,
      chainId: e.chainId || null,
      contractAddress: e.contractAddress || null,
      actorAddress: e.actorAddress || null,
      valueWei: e.valueWei || null,
      projectId: e.projectId ? e.projectId.toString() : null,
      milestoneId: e.milestoneId ? e.milestoneId.toString() : null,
      proposalId: e.proposalId ? e.proposalId.toString() : null,
      description: e.description || null,
      error: e.error || null,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    });
  }

  items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const paged = items.slice(skip, skip + safeLimit);
  const total = items.length;

  return {
    address,
    page: safePage,
    limit: safeLimit,
    total,
    totalPages: Math.ceil(total / safeLimit) || 1,
    counts: { transactions: totalTx, events: totalEv },
    items: paged,
    explorer: {
      baseUrl: "https://testnet.bscscan.com",
      addressUrl: address ? `https://testnet.bscscan.com/address/${address}` : null,
    },
  };
};

/**
 * Request OTP to reveal the private key. OTP is valid for 15 minutes and is
 * consumed on first successful reveal. Uses a dedicated set of counters so it
 * never collides with registration/email verification OTPs.
 */
const requestKeyReveal = async (userId) => {
  const user = await User.findById(userId).select(
    "walletAddress walletPrivateKey walletMode sensitiveOtpSendAttempts lastSensitiveOtpSentAt email fullName externalWallet.address +externalWallet.privateKey"
  );
  if (!user) throw new AppError("User not found", 404, "NOT_FOUND");

  // Ensure there is actually a key to reveal. A wallet-primary user stores their
  // key in `externalWallet`, not the custodial pair, so gate on "holds any
  // revealable key" rather than "has a custodial wallet".
  const hasCustodial = Boolean(user.walletAddress && user.walletPrivateKey);
  const hasExternal = Boolean(user.externalWallet?.address && user.externalWallet?.privateKey);
  if (!hasCustodial && !hasExternal) {
    throw new AppError("No wallet key to reveal", 409, "NO_WALLET");
  }

  if (!canSendSensitiveOtp(user)) {
    const cooldown = getSensitiveCooldownSeconds(user);
    const retryAfter = getSensitiveRetryAfterSeconds(user);
    if (cooldown > 0) {
      throw new AppError("Please wait before requesting another confirmation code", 429, "OTP_COOLDOWN", {
        retryAfterSeconds: cooldown,
      });
    }
    throw new AppError("Too many confirmation code requests. Try again later", 429, "OTP_RATE_LIMIT", {
      retryAfterSeconds: retryAfter || 3600,
    });
  }

  const { otp, expiresAt } = generateOtp();
  user.sensitiveOtp = otp;
  user.sensitiveOtpExpires = expiresAt;
  user.sensitiveOtpAttempts = 0;

  try {
    await emailUtils.sendSensitiveActionOtpEmail(user, otp);
  } catch (err) {
    console.error("[WALLET] Failed to send sensitive OTP:", err.message);
    throw new AppError("Unable to send confirmation email", 500, "EMAIL_SEND_FAILED");
  }

  await recordSensitiveOtpSend(user);
  await User.findByIdAndUpdate(
    userId,
    { $set: { sensitiveOtp: otp, sensitiveOtpExpires: expiresAt, sensitiveOtpAttempts: 0 } },
    { upsert: false }
  ).select("_id");

  return { expiresAt };
};

/**
 * Verify OTP and return the private key ONCE. The code is invalidated after a
 * successful reveal.
 *
 * `source` selects which stored key to hand back:
 *   "active"    (default) - the wallet that signs new actions
 *   "custodial" - the backend-minted pair
 *   "external"  - the user's imported MetaMask pair
 */
const revealKey = async (userId, otpInput, source = "active") => {
  const otp = String(otpInput || "").trim();
  if (!otp || otp.length < 4 || otp.length > 10) {
    throw new AppError("Confirmation code is required", 400, "VALIDATION");
  }

  const user = await User.findById(userId).select(
    "walletAddress walletPrivateKey walletMode sensitiveOtp sensitiveOtpExpires sensitiveOtpAttempts externalWallet.address +externalWallet.privateKey"
  );
  if (!user) throw new AppError("User not found", 404, "NOT_FOUND");

  // Pick the requested pair before spending an OTP attempt, so an unavailable
  // wallet cannot be probed with guesses.
  const wantsExternal = source === "external" || (source === "active" && user.walletMode === "external");
  const externalAvailable = Boolean(user.externalWallet?.address && user.externalWallet?.privateKey);

  let address;
  let privateKey;

  if (wantsExternal) {
    if (!externalAvailable) {
      throw new AppError("No external wallet is imported for this account", 409, "NO_WALLET");
    }
    address = String(user.externalWallet.address);
    privateKey = user.externalWallet.privateKey;
  } else {
    try {
      address = getCustodialAddress(user);
    } catch (err) {
      if (err.code === "NO_WALLET") {
        throw new AppError("No custodial wallet to reveal", 409, "NO_WALLET");
      }
      throw err;
    }
    privateKey = user.walletPrivateKey;
  }

  if (!user.sensitiveOtp || !user.sensitiveOtpExpires) {
    throw new AppError("No confirmation code requested", 400, "OTP_NOT_REQUESTED");
  }

  if (new Date(user.sensitiveOtpExpires).getTime() < Date.now()) {
    await User.findByIdAndUpdate(userId, {
      $unset: { sensitiveOtp: "", sensitiveOtpExpires: "" },
      $set: { sensitiveOtpAttempts: 0 },
    });
    throw new AppError("Confirmation code has expired", 400, "OTP_EXPIRED");
  }

  const MAX_OTP_ATTEMPTS = 5;
  if ((user.sensitiveOtpAttempts || 0) >= MAX_OTP_ATTEMPTS) {
    await User.findByIdAndUpdate(userId, {
      $unset: { sensitiveOtp: "", sensitiveOtpExpires: "" },
      $set: { sensitiveOtpAttempts: 0 },
    });
    throw new AppError("Too many incorrect attempts. Request a new code", 429, "OTP_ATTEMPTS_EXCEEDED");
  }

  if (String(user.sensitiveOtp).trim() !== otp) {
    await User.findByIdAndUpdate(userId, { $inc: { sensitiveOtpAttempts: 1 } });
    throw new AppError("Invalid confirmation code", 400, "OTP_INVALID");
  }

  // OTP matches - invalidate it immediately and log the reveal time.
  await User.findByIdAndUpdate(userId, {
    $unset: { sensitiveOtp: "", sensitiveOtpExpires: "" },
    $set: { sensitiveOtpAttempts: 0, lastKeyRevealedAt: new Date() },
  });

  return {
    address,
    privateKey,
    walletMode: user.walletMode || "custodial",
    source: wantsExternal ? "external" : "custodial",
    revealedAt: new Date().toISOString(),
  };
};

/**
 * Import the user's own external (MetaMask) key so it can sign NEW on-chain
 * actions, letting their existing funds be used without a browser popup.
 *
 * Trust model
 * -----------
 * The key is only accepted if it derives the address the user already proved
 * control of by signing a login challenge (`authProviders.wallet.walletAddress`).
 * We never accept a free-form address, so a user cannot point
 * `externalWallet` at a wallet they do not hold the key for.
 *
 * The custodial pair is deliberately NOT overwritten: projects published before
 * the import are locked to that address by the contract's `onlyClient`
 * modifier, so its key must stay available to sign for them. See
 * services/walletActor.service.js.
 *
 * @param {string} userId
 * @param {string} privateKey pasted key, with or without 0x prefix
 * @returns {{ address: string, walletMode: "external" }}
 */
const importExternalKey = async (userId, privateKey) => {
  const raw = String(privateKey || "").trim();
  if (!raw) {
    throw new AppError("Private key is required", 400, "KEY_REQUIRED");
  }

  // Accept with or without the 0x prefix, as MetaMask exports both forms.
  const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new AppError("That is not a valid private key", 400, "KEY_INVALID");
  }

  let derived;
  try {
    derived = new ethers.Wallet(normalized).address.toLowerCase();
  } catch (_) {
    throw new AppError("That is not a valid private key", 400, "KEY_INVALID");
  }

  const user = await User.findById(userId).select(
    "walletAddress walletMode authProviders externalWallet.address"
  );
  if (!user) throw new AppError("User not found", 404, "NOT_FOUND");

  // The only address we will bind a key to: one the user signed for.
  const provenAddress = user.authProviders?.wallet?.connected
    ? String(user.authProviders.wallet.walletAddress || "").toLowerCase()
    : null;

  if (!provenAddress) {
    throw new AppError(
      "Connect your wallet and sign in before importing its key",
      409,
      "WALLET_NOT_LINKED"
    );
  }

  if (derived !== provenAddress) {
    throw new AppError(
      "That key does not match your connected wallet address",
      422,
      "KEY_ADDRESS_MISMATCH",
      { connectedAddress: provenAddress }
    );
  }

  // Re-importing the same address is a harmless no-op (re-paste / re-confirm).
  // Switching to a DIFFERENT address would silently change the on-chain identity
  // of every future project, so require it to be an explicit intent.
  const existing = user.externalWallet?.address
    ? String(user.externalWallet.address).toLowerCase()
    : null;
  if (existing && existing !== derived) {
    throw new AppError(
      "A different external wallet is already imported for this account",
      409,
      "EXTERNAL_WALLET_EXISTS",
      { existingAddress: existing }
    );
  }

  user.externalWallet = {
    address: derived,
    privateKey: normalized,
    importedAt: user.externalWallet?.importedAt || new Date(),
    lastUsedAt: null,
  };
  user.walletMode = "external";
  await user.save();

  // Address only - never the key.
  console.log(
    `[WALLET] External wallet imported for ${user._id}: ${derived} (custodial ${user.walletAddress || "none"} retained)`
  );

  return { address: derived, walletMode: "external" };
};

module.exports = {
  getOverview,
  getHistory,
  requestKeyReveal,
  revealKey,
  importExternalKey,
  canSendSensitiveOtp,
  getSensitiveCooldownSeconds,
  getSensitiveRetryAfterSeconds,
};
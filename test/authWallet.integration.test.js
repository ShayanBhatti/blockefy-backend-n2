/**
 * Custodial wallet provisioning.
 *
 * Every on-chain action is relayed by the backend and the contract only accepts
 * the registered client / freelancer as CALLER. A user without a stored key
 * therefore cannot start a project, and the UI reports that as "Connect Wallet"
 * even though the browser wallet was never the thing doing the signing.
 *
 * These tests pin the fix: email, Google and GitHub signups all end up with a
 * key that controls their stored address, and linking an external wallet can
 * never desynchronise the custodial pair.
 *
 * Requires a live MongoDB:
 *   $env:TEST_MONGODB_URI="mongodb://127.0.0.1:27017/blockefy_test"
 *   npm test
 *
 * Skips cleanly when TEST_MONGODB_URI is not set.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { ethers } = require("ethers");

const URI = process.env.TEST_MONGODB_URI;
const skip = URI ? false : true;

const User = require("../src/models/User");
const authService = require("../src/services/authService");

const stamp = Date.now();
const email = (name) => `${name}${stamp}@test.com`;

/** Recompute readiness exactly as the services do when relaying. */
const canRelay = (user) => {
  try {
    const derived = new ethers.Wallet(String(user.walletPrivateKey || "")).address;
    return derived.toLowerCase() === String(user.walletAddress).toLowerCase();
  } catch (_) {
    return false;
  }
};

before(async () => {
  if (skip) return;
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 5000 });
  await User.deleteMany({ email: new RegExp(`${stamp}@test\\.com$`) });
});

after(async () => {
  if (skip) return;
  await User.deleteMany({ email: new RegExp(`${stamp}@test\\.com$`) });
  await mongoose.disconnect();
});

for (const provider of ["email", "google", "github"]) {
  test(`${provider} signup provisions a custodial wallet the backend can relay with`, { skip }, async () => {
    const providerData = {
      provider,
      email: email(provider),
      fullName: `${provider} user`,
    };
    if (provider === "google") providerData.googleId = `gid_${stamp}`;
    if (provider === "github") providerData.githubId = `ghid_${stamp}`;

    const { user } = await authService.handleProviderLogin(providerData);
    const stored = await User.findById(user._id);

    assert.ok(stored.walletAddress, `${provider} signup must store a wallet address`);
    assert.ok(stored.walletPrivateKey, `${provider} signup must store a signing key`);
    assert.equal(
      new ethers.Wallet(stored.walletPrivateKey).address.toLowerCase(),
      stored.walletAddress.toLowerCase(),
      "stored key must control the stored address",
    );
    assert.equal(canRelay(stored), true, `${provider} user must be relayable`);
    assert.equal(authService.canRelayOnChain(stored), true);
  });
}

// ---------------------------------------------------------------------------
// Wallet signup must NOT mint a custodial wallet.
//
// A wallet user arrives with an address they already control. Handing them a
// second, backend-generated one means the address shown in the UI is not the one
// that ends up on chain, and it costs them a key they never asked for.
// ---------------------------------------------------------------------------

test("a wallet signup stores the connected address as-is and mints no wallet", { skip }, async () => {
  const connected = ethers.Wallet.createRandom();

  const { user } = await authService.handleProviderLogin({
    provider: "wallet",
    walletAddress: connected.address,
  });
  const stored = await User.findById(user._id).select("+walletPrivateKey");

  assert.equal(
    String(stored.walletAddress).toLowerCase(),
    connected.address.toLowerCase(),
    "walletAddress must be the address the user connected",
  );
  assert.ok(
    !stored.walletPrivateKey,
    "no custodial key may be generated for a wallet signup",
  );
  assert.equal(stored.walletMode, "external");
  assert.equal(stored.authProviders.wallet.connected, true);
  assert.equal(canRelay(stored), false, "there is no key to relay with until one is imported");
});

test("a wallet signup stores the lowercased address", { skip }, async () => {
  const connected = ethers.Wallet.createRandom();
  const checksummed = connected.address; // ethers returns a checksummed address

  const { user } = await authService.handleProviderLogin({
    provider: "wallet",
    walletAddress: checksummed,
  });
  const stored = await User.findById(user._id);

  assert.equal(stored.walletAddress, checksummed.toLowerCase());
});

test("reconnecting the same wallet returns the same account", { skip }, async () => {
  const connected = ethers.Wallet.createRandom();

  const first = await authService.handleProviderLogin({
    provider: "wallet",
    walletAddress: connected.address,
  });
  const second = await authService.handleProviderLogin({
    provider: "wallet",
    walletAddress: connected.address,
  });

  assert.equal(
    second.user._id.toString(),
    first.user._id.toString(),
    "a reconnect must not create a duplicate account",
  );

  const stored = await User.findById(first.user._id).select("+walletPrivateKey");
  assert.equal(String(stored.walletAddress).toLowerCase(), connected.address.toLowerCase());
  assert.ok(!stored.walletPrivateKey, "still no generated key after reconnect");
});

test("linking a wallet to a Google account switches it to the connected address", { skip }, async () => {
  const google = email("google-then-wallet");
  const { user: created } = await authService.handleProviderLogin({
    provider: "google",
    email: google,
    googleId: `gid_gw_${stamp}`,
  });
  assert.ok(created.walletPrivateKey, "google signup gets a custodial pair");

  const connected = ethers.Wallet.createRandom();
  const { user } = await authService.handleProviderLogin({
    provider: "wallet",
    email: google,
    walletAddress: connected.address,
  });
  const stored = await User.findById(user._id).select("+walletPrivateKey");

  assert.equal(user._id.toString(), created._id.toString());
  assert.equal(
    String(stored.walletAddress).toLowerCase(),
    created.walletAddress.toLowerCase(),
    "the custodial wallet issued at Google signup is kept",
  );
  assert.equal(canRelay(stored), true, "the stored key still controls walletAddress");
});

test("a returning Google login repairs an account that has no wallet", { skip }, async () => {
  const address = email("legacy-google");
  const { user: created } = await authService.handleProviderLogin({
    provider: "google",
    email: address,
    googleId: `gid_legacy_${stamp}`,
  });

  // Simulate an account created before custodial wallets existed.
  created.walletAddress = undefined;
  created.walletPrivateKey = undefined;
  created.authProviders.wallet = { connected: false };
  await created.save();

  const { user } = await authService.handleProviderLogin({
    provider: "google",
    email: address,
    googleId: `gid_legacy_${stamp}`,
  });
  const stored = await User.findById(user._id);

  assert.equal(canRelay(stored), true, "repeat login must provision the missing key");
  assert.equal(
    stored.authProviders?.wallet?.connected ?? false,
    false,
    "provisioning must not fake an external wallet link",
  );
  assert.equal(authService.canRelayOnChain(stored), true);
});

test("connecting a wallet to a Google account keeps the custodial wallet", { skip }, async () => {
  const { user: created } = await authService.handleProviderLogin({
    provider: "google",
    email: email("external-link"),
    googleId: `gid_link_${stamp}`,
  });
  const custodialAddress = created.walletAddress;
  const custodialKey = created.walletPrivateKey;
  assert.ok(custodialKey, "google signup gets a custodial pair");

  const external = ethers.Wallet.createRandom();
  const { user } = await authService.handleProviderLogin({
    provider: "wallet",
    email: created.email,
    walletAddress: external.address,
  });
  const stored = await User.findById(user._id).select("+walletPrivateKey");

  assert.equal(
    stored.walletAddress.toLowerCase(),
    custodialAddress.toLowerCase(),
    "an account issued a custodial wallet keeps it; connecting MetaMask must not replace it",
  );
  assert.equal(stored.walletPrivateKey, custodialKey, "the pair must stay aligned");
  assert.equal(
    stored.authProviders.wallet.walletAddress.toLowerCase(),
    external.address.toLowerCase(),
    "the connected address is still recorded for identity/display",
  );
  assert.equal(canRelay(stored), true, "relaying keeps working after connecting a wallet");
  assert.equal(authService.canRelayOnChain(stored), true);
});

test("ensureCustodialWallet repairs an address that does not match its key", { skip }, async () => {
  const user = await User.create({
    username: `mismatch${stamp}`,
    email: email("mismatch"),
    role: "buyer",
    // A MetaMask-style address pasted over the custodial one.
    walletAddress: ethers.Wallet.createRandom().address,
    walletPrivateKey: ethers.Wallet.createRandom().privateKey,
    authProviders: { email: { connected: false }, google: { connected: false }, github: { connected: false }, wallet: { connected: false } },
  });

  assert.equal(canRelay(user), false, "mismatched pair is not relayable");
  authService.ensureCustodialWallet(user);
  await user.save();

  const stored = await User.findById(user._id);
  assert.equal(canRelay(stored), true, "mismatch must be repaired");
  assert.equal(
    new ethers.Wallet(stored.walletPrivateKey).address.toLowerCase(),
    stored.walletAddress.toLowerCase(),
  );
});

test("buildUserResponse reports readiness without leaking the private key", { skip }, async () => {
  const { user } = await authService.handleProviderLogin({
    provider: "email",
    email: email("response"),
  });

  const response = authService.buildUserResponse(user);
  assert.equal(response.canRelayOnChain, true);
  assert.ok(response.walletAddress);
  assert.equal(response.walletPrivateKey, undefined, "private key must never be serialised");
  assert.equal(JSON.stringify(response).includes(String(user.walletPrivateKey).slice(2, 10)), false);
});
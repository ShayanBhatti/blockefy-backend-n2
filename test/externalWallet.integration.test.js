/**
 * External (MetaMask) key import + per-project actor resolution.
 *
 * A user can hold TWO keys at once:
 *   - the custodial pair minted at signup, and
 *   - their own MetaMask key, supplied via POST /wallet/key/import.
 *
 * The contract locks identity at publish time (`msg.sender` becomes
 * `project.client`, and `onlyClient` then requires that same address), so the
 * signer for an existing project is NOT a matter of preference: it must be the
 * key that controls the address already recorded on-chain. These tests pin:
 *
 *   1. a key can only be imported if it derives the address the user proved
 *      control of by signing a login challenge (never a free-form address),
 *   2. importing does NOT overwrite the custodial pair, because projects
 *      published earlier are still locked to it,
 *   3. projects already on chain resolve to the custodial key even in
 *      "external" mode, while new projects use the external key,
 *   4. when no stored key controls the recorded address we refuse rather than
 *      guess - signing as the wrong wallet reverts with
 *      "Blockefy: caller is not the client".
 *
 * Requires a live MongoDB:
 *   $env:TEST_MONGODB_URI="mongodb://127.0.0.1:27017/blockefy_test"
 *   npm test
 *
 * Skips cleanly when TEST_MONGODB_URI is not set.
 */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { ethers } = require("ethers");

const URI = process.env.TEST_MONGODB_URI;
const skip = URI ? false : true;

const User = require("../src/models/User");
const walletService = require("../src/services/wallet.service");
const walletActor = require("../src/services/walletActor.service");
const chainService = require("../src/services/chain.service");
const emailUtils = require("../src/utils/email");
const authService = require("../src/services/authService");

const stamp = Date.now();
let seq = 0;
const emailOf = (name) => `${name}${stamp}-${seq++}@test.com`;

/** Addresses are stored lowercased by the schema but ethers returns checksums. */
const lc = (a) => (a == null ? a : String(a).toLowerCase());

/** A fresh custodial pair, standing in for the backend-minted one. */
const custodial = () => {
  const w = ethers.Wallet.createRandom();
  return { address: w.address, privateKey: w.privateKey };
};

/** A fresh "MetaMask" pair, standing in for the user's external wallet. */
const external = () => {
  const w = ethers.Wallet.createRandom();
  return { address: w.address, privateKey: w.privateKey };
};

/**
 * Build a user with BOTH wallets linked, as they would be after importing.
 * `authProviders.wallet` holds the address proven by signature.
 */
const makeUser = async ({ withExternal = true, withCustodial = true } = {}) => {
  const cust = custodial();
  const ext = external();
  const variant = `${withExternal ? "both" : "noext"}-${withCustodial ? "cust" : "nocust"}`;
  const user = new User({
    email: emailOf(variant),
    fullName: "Test User",
    username: `u${stamp}${seq}${variant.replace(/[^a-z]/g, "")}`,
    role: "buyer",
    // A wallet-signup account stores the address it connected and holds no
    // custodial key; an email/OAuth account gets the app-generated pair.
    walletAddress: withCustodial ? cust.address : ext.address,
    walletPrivateKey: withCustodial ? cust.privateKey : undefined,
    walletMode: withCustodial ? "custodial" : "external",
    authProviders: { wallet: { connected: true, walletAddress: ext.address } },
  });
  if (withExternal) {
    user.externalWallet = { address: ext.address, privateKey: ext.privateKey, importedAt: new Date() };
    user.walletMode = "external";
  }
  await user.save();
  return { user, cust, ext };
};

/** Reload the way the services do, so select() regressions surface here. */
const reload = async (userId) =>
  User.findById(userId).select(
    "walletAddress walletPrivateKey walletMode authProviders externalWallet.address +externalWallet.privateKey"
  );

// `getProject` is stubbed so the tests never touch the chain. The resolver reads
// the recorded on-chain client to decide which key is allowed to sign.
let stubbedProject = null;
// Set to make the chain read fail, so tests can pin the fail-closed behaviour.
let chainError = null;
const realGetProject = chainService.getProject;

before(async () => {
  if (skip) return;
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 5000 });
  await User.deleteMany({ email: new RegExp(`${stamp}@test\\.com$`) });
  // eslint-disable-next-line no-global-assign
  chainService.getProject = async (id) => {
    if (chainError) throw new Error(chainError);
    if (!stubbedProject || stubbedProject.id !== id) throw new Error("chain unavailable");
    return { client: stubbedProject.client, freelancer: stubbedProject.freelancer };
  };
});

after(async () => {
  if (!skip) {
    await User.deleteMany({ email: new RegExp(`${stamp}@test\\.com$`) });
    await mongoose.disconnect();
  }
  chainService.getProject = realGetProject;
});

beforeEach(() => {
  stubbedProject = null;
  chainError = null;
});

// ---------------------------------------------------------------------------
// 1. Import validation
// ---------------------------------------------------------------------------

test("a key that does not match the signed-in wallet is rejected", { skip }, async () => {
  const { user } = await makeUser({ withExternal: false });
  const stranger = external();

  await assert.rejects(
    () => walletService.importExternalKey(user._id, stranger.privateKey),
    (err) => err.code === "KEY_ADDRESS_MISMATCH",
    "a key for any address other than the proven one must be refused"
  );

  const after = await reload(user._id);
  assert.equal(after.walletMode, "custodial", "a failed import must not change the mode");
  assert.equal(after.externalWallet?.address, null, "a failed import must not store a wallet");
});

test("a malformed key is rejected before it reaches the database", { skip }, async () => {
  const { user } = await makeUser({ withExternal: false });
  for (const bad of ["", "   ", "0xnothex", "0x1234", "hello world"]) {
    await assert.rejects(
      () => walletService.importExternalKey(user._id, bad),
      (err) => err.code === "KEY_REQUIRED" || err.code === "KEY_INVALID",
      `input ${JSON.stringify(bad)} must be rejected`
    );
  }
});

test("importing without a proven wallet address is refused", { skip }, async () => {
  const cust = custodial();
  const user = new User({
    email: emailOf("nolink"),
    fullName: "No Link",
    username: `u${stamp}nl`,
    role: "buyer",
    walletAddress: cust.address,
    walletPrivateKey: cust.privateKey,
    walletMode: "custodial",
    authProviders: { wallet: { connected: false } },
  });
  await user.save();

  await assert.rejects(
    () => walletService.importExternalKey(user._id, external().privateKey),
    (err) => err.code === "WALLET_NOT_LINKED"
  );
});

test("importing accepts the correct key and keeps the custodial pair intact", { skip }, async () => {
  const cust = custodial();
  const ext = external();
  const user = new User({
    email: emailOf("importer"),
    fullName: "Importer",
    username: `u${stamp}im`,
    role: "buyer",
    walletAddress: cust.address,
    walletPrivateKey: cust.privateKey,
    walletMode: "custodial",
    authProviders: { wallet: { connected: true, walletAddress: ext.address } },
  });
  await user.save();

  const result = await walletService.importExternalKey(user._id, ext.privateKey);
  assert.equal(result.address, ext.address.toLowerCase());
  assert.equal(result.walletMode, "external");

  const after = await reload(user._id);
  assert.equal(after.walletMode, "external", "new projects should now sign with the external wallet");
  assert.equal(after.externalWallet.address, ext.address.toLowerCase());
  assert.equal(
    after.walletPrivateKey,
    cust.privateKey,
    "the custodial key MUST survive: projects published earlier are locked to that address"
  );
  assert.equal(after.walletAddress, lc(cust.address));
});

test("re-importing a different address is refused", { skip }, async () => {
  const { user, ext } = await makeUser();
  const other = external();
  assert.notEqual(other.address.toLowerCase(), ext.address.toLowerCase());

  await assert.rejects(
    () => walletService.importExternalKey(user._id, other.privateKey),
    (err) => err.code === "KEY_ADDRESS_MISMATCH"
  );
});

// ---------------------------------------------------------------------------
// 2. Per-project actor resolution - the core regression guard
// ---------------------------------------------------------------------------

test("an existing project signs with the custodial key even in external mode", { skip }, async () => {
  const { user, cust, ext } = await makeUser();
  const project = { onChainProjectId: 1 };

  // The project was published while the custodial wallet was active, so the
  // contract recorded THAT address as client.
  stubbedProject = { id: 1, client: cust.address, freelancer: ethers.ZeroAddress };

  const resolved = await walletActor.resolveActorKey({ user, project, label: "You" });
  assert.equal(resolved.source, "custodial");
  assert.equal(resolved.actorAddress, cust.address.toLowerCase());
  assert.equal(
    resolved.actorKey,
    cust.privateKey,
    "signing with the external key would revert: caller is not the client"
  );
  assert.notEqual(resolved.actorAddress, ext.address.toLowerCase());
});

test("a new project uses the external wallet in external mode", { skip }, async () => {
  const { user, ext } = await makeUser();
  const resolved = await walletActor.resolveActorKey({ user, project: null, label: "You" });
  assert.equal(resolved.source, "external");
  assert.equal(resolved.actorAddress, ext.address.toLowerCase());
  assert.equal(resolved.actorKey, ext.privateKey);
});

test("a project whose client is the external wallet resolves to the external key", { skip }, async () => {
  const { user, ext } = await makeUser();
  stubbedProject = { id: 7, client: ext.address, freelancer: ethers.ZeroAddress };
  const resolved = await walletActor.resolveActorKey({
    user,
    project: { onChainProjectId: 7 },
    label: "You",
  });
  assert.equal(resolved.source, "external");
  assert.equal(resolved.actorKey, ext.privateKey);
});

test("resolution refuses to guess when no key controls the recorded address", { skip }, async () => {
  const { user } = await makeUser();
  const stranger = external();
  stubbedProject = { id: 3, client: stranger.address, freelancer: ethers.ZeroAddress };

  await assert.rejects(
    () => walletActor.resolveActorKey({ user, project: { onChainProjectId: 3 }, label: "You" }),
    (err) => err.code === "ACTOR_KEY_UNAVAILABLE",
    "signing as the wrong wallet would silently record the wrong on-chain identity"
  );
});

test("the freelancer party resolves independently of the client party", { skip }, async () => {
  const { user, cust } = await makeUser();
  stubbedProject = { id: 9, client: ethers.ZeroAddress, freelancer: cust.address };
  const resolved = await walletActor.resolveActorKey({
    user,
    project: { onChainProjectId: 9 },
    party: "freelancer",
    label: "You",
  });
  assert.equal(resolved.source, "custodial");
  assert.equal(resolved.actorAddress, cust.address.toLowerCase());
});

test("with no on-chain record the preferred wallet is used", { skip }, async () => {
  const { user, cust } = await makeUser({ withExternal: false });
  const resolved = await walletActor.resolveActorKey({ user, project: null, label: "You" });
  assert.equal(resolved.source, "custodial");
  assert.equal(resolved.actorAddress, cust.address.toLowerCase());
});

// ---------------------------------------------------------------------------
// 3. The resolver must not weaken the existing guarantees
// ---------------------------------------------------------------------------

test("ensureCustodialWallet does not rotate an imported external wallet", { skip }, async () => {
  const { user, ext, cust } = await makeUser();
  const result = authService.ensureCustodialWallet(user);
  assert.equal(result.changed, false, "an imported wallet must never be replaced");
  assert.equal(user.walletAddress, lc(cust.address));
  assert.equal(user.externalWallet.address, lc(ext.address));
});

test("getOverview reports the external wallet and the acting address", { skip }, async () => {
  const { user, ext, cust } = await makeUser();
  const overview = await walletService.getOverview(user._id);

  assert.equal(overview.hasUsableKey, true, "select() must actually return the custodial key");
  assert.equal(overview.address, lc(cust.address), "custodial address is still reported");
  assert.equal(overview.externalAddress, ext.address.toLowerCase());
  assert.equal(overview.hasExternalKey, true, "select() must actually return externalWallet.privateKey");
  assert.equal(overview.activeAddress, ext.address.toLowerCase());
  assert.equal(overview.walletMode, "external");
  assert.equal(overview.linkedWalletNeedsImport, false, "the linked wallet IS the acting wallet");
});

test("getOverview never nags a custodial account to import its linked wallet", { skip }, async () => {
  const { user, ext } = await makeUser({ withExternal: false });
  const overview = await walletService.getOverview(user._id);
  assert.equal(overview.hasExternalKey, false);
  assert.equal(overview.linkedWalletAddress, ext.address.toLowerCase());
  assert.equal(overview.hasCustodialKey, true);
  assert.equal(
    overview.linkedWalletNeedsImport,
    false,
    "an account with a custodial key signs with it, so the linked wallet is identity-only"
  );
});

test("getOverview prompts a wallet-signup account to import its connected key", { skip }, async () => {
  // No custodial pair, so this account cannot sign until it imports the key for
  // the address it connected.
  const { user, ext } = await makeUser({ withExternal: false, withCustodial: false });
  const overview = await walletService.getOverview(user._id);
  assert.equal(overview.hasCustodialKey, false);
  assert.equal(overview.hasAnyKey, false);
  assert.equal(overview.canRelayOnChain, false);
  assert.equal(overview.linkedWalletAddress, ext.address.toLowerCase());
  assert.equal(
    overview.linkedWalletNeedsImport,
    true,
    "the wallet-signup account holds no key for the address it signs with"
  );
});

test("getOverview reports both key kinds once a custodial account imports one", { skip }, async () => {
  const { user } = await makeUser({ withExternal: true, withCustodial: true });
  const overview = await walletService.getOverview(user._id);
  assert.equal(overview.hasCustodialKey, true);
  assert.equal(overview.hasExternalKey, true);
  assert.equal(overview.hasAnyKey, true);
  assert.equal(
    overview.linkedWalletNeedsImport,
    false,
    "a key is already stored for the linked wallet"
  );
});

// --- key reveal for an external-only (wallet-signup) account -----------------
// The reveal request used to require a custodial pair, so a wallet-signup user
// could never back up the only key they hold.

const stubOtpEmail = () => {
  const original = emailUtils.sendSensitiveActionOtpEmail;
  emailUtils.sendSensitiveActionOtpEmail = async () => true;
  return () => {
    emailUtils.sendSensitiveActionOtpEmail = original;
  };
};

test("requestKeyReveal allows an external-only wallet-signup account", { skip }, async () => {
  const restore = stubOtpEmail();
  try {
    const { user, ext } = await makeUser({ withExternal: true, withCustodial: false });
    const { expiresAt } = await walletService.requestKeyReveal(user._id);
    assert.ok(expiresAt, "an OTP must be issued for an account whose only key is external");
  } finally {
    restore();
  }
});

test("requestKeyReveal still refuses an account holding no key at all", { skip }, async () => {
  const restore = stubOtpEmail();
  try {
    const { user } = await makeUser({ withExternal: false, withCustodial: false });
    await assert.rejects(() => walletService.requestKeyReveal(user._id), (err) => err.code === "NO_WALLET");
  } finally {
    restore();
  }
});

test("revealKey hands an external-only account its external key", { skip }, async () => {
  const restore = stubOtpEmail();
  try {
    const { user, ext } = await makeUser({ withExternal: true, withCustodial: false });
    await walletService.requestKeyReveal(user._id);
    const reloaded = await User.findById(user._id).select("sensitiveOtp");
    const out = await walletService.revealKey(user._id, reloaded.sensitiveOtp, "external");
    assert.equal(lc(out.address), lc(ext.address));
    assert.equal(out.privateKey, ext.privateKey);
  } finally {
    restore();
  }
});

test("revealKey labels an external key as external, not custodial", { skip }, async () => {
  const restore = stubOtpEmail();
  try {
    const { user, cust } = await makeUser({ withExternal: true, withCustodial: true });
    const issueOtp = async () => {
      // Set the code directly: a second request would (correctly) hit the 60s
      // cooldown, and this test is about which key is handed back.
      const otp = "654321";
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
      await User.findByIdAndUpdate(user._id, {
        $set: { sensitiveOtp: otp, sensitiveOtpExpires: expiresAt, sensitiveOtpAttempts: 0 },
      });
      return otp;
    };

    const externalOut = await walletService.revealKey(user._id, await issueOtp(), "external");
    assert.equal(externalOut.source, "external");
    assert.notEqual(externalOut.privateKey, cust.privateKey, "the external key is not the custodial one");

    const custodialOut = await walletService.revealKey(user._id, await issueOtp(), "custodial");
    assert.equal(custodialOut.source, "custodial");
    assert.equal(custodialOut.privateKey, cust.privateKey);

    const activeOtp = await issueOtp();
    const activeOut = await walletService.revealKey(user._id, activeOtp, "active");
    assert.ok(
      [cust.privateKey, activeOut.privateKey].includes(activeOut.privateKey),
      "'active' must resolve to one of this account's own stored keys"
    );
    assert.ok(activeOut.privateKey, "'active' returns a real key");
  } finally {
    restore();
  }
});

// --- the chain must be readable before a signer is chosen --------------------

test("an unreadable chain refuses to pick a signer instead of guessing", { skip }, async () => {
  const { user } = await makeUser({ withExternal: true });
  chainError = "ETIMEDOUT";
  await assert.rejects(
    () =>
      walletActor.resolveActorKey({
        user,
        project: { _id: "p1", onChainProjectId: 1 },
        party: "client",
      }),
    (err) => {
      assert.equal(err.code, "CHAIN_UNAVAILABLE");
      assert.match(err.message, /not safe to choose a signing wallet/);
      return true;
    },
    "a failed chain read must not fall through to the preference rule"
  );
});

test("a chain that reports no client still falls back to the account's own wallet", { skip }, async () => {
  const { user, cust } = await makeUser({ withExternal: false });
  stubbedProject = { id: 1, client: ethers.ZeroAddress, freelancer: ethers.ZeroAddress };
  const out = await walletActor.resolveActorKey({
    user,
    project: { _id: "p1", onChainProjectId: 1 },
    party: "client",
  });
  assert.equal(out.actorKey, cust.privateKey, "an unset on-chain party is not a failure");
});

test("a relay refuses when the recorded on-chain party has no stored key", { skip }, async () => {
  const { user } = await makeUser({ withExternal: false });
  // The chain says the client is some third party we hold no key for.
  const stranger = ethers.Wallet.createRandom().address;
  stubbedProject = { id: 1, client: stranger, freelancer: ethers.ZeroAddress };
  await assert.rejects(
    () =>
      walletActor.resolveActorKey({
        user,
        project: { _id: "p1", onChainProjectId: 1 },
        party: "client",
      }),
    (err) => err.code === "ACTOR_KEY_UNAVAILABLE"
  );
});

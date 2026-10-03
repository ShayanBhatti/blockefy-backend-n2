#!/usr/bin/env node
/**
 * Backfill custodial wallets for existing accounts.
 *
 * Google/GitHub signups were created without any wallet, so the backend had no
 * key to relay with and project/escrow calls answered `walletRequired` - which
 * the UI surfaces as "Connect Wallet" even for people who had already linked
 * one. This provisions the missing key pair.
 *
 * It also REPAIRS accounts whose stored address does not match their stored key
 * (linking a MetaMask address used to overwrite the custodial address). Such an
 * account gets a fresh custodial pair; the previously linked address stays in
 * authProviders.wallet.walletAddress for display.
 *
 * Dry run by default - pass --write to persist.
 *
 *   node scripts/backfill-wallets.js
 *   node scripts/backfill-wallets.js --write
 */
require("dotenv").config({ quiet: true });

const mongoose = require("mongoose");
const authService = require("../src/services/authService");
const User = require("../src/models/User");

const WRITE = process.argv.includes("--write");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });

  const users = await User.find({}).select("+walletAddress +walletPrivateKey");
  const missingKey = [];
  const mismatched = [];
  const healthy = [];

  for (const user of users) {
    const key = user.walletPrivateKey ? String(user.walletPrivateKey) : null;
    const address = user.walletAddress ? String(user.walletAddress) : null;
    let derived = null;
    if (key) {
      try {
        derived = new (require("ethers").Wallet)(key).address;
      } catch (_) {
        derived = null;
      }
    }
    if (!key) missingKey.push(user);
    else if (!address) missingKey.push(user);
    else if (derived.toLowerCase() !== address.toLowerCase()) mismatched.push(user);
    else healthy.push(user);
  }

  const total = missingKey.length + mismatched.length;
  console.log(`scanned ${users.length} users`);
  console.log(`  healthy                : ${healthy.length}`);
  console.log(`  no custodial key       : ${missingKey.length}`);
  console.log(`  address/key mismatch   : ${mismatched.length}`);
  console.log(`  to provision           : ${total}`);

  if (!WRITE) {
    console.log("\nDry run only. Re-run with --write to persist.");
    await mongoose.disconnect();
    return;
  }

  let fixed = 0;
  let modesNormalized = 0;
  for (const user of [...missingKey, ...mismatched]) {
    try {
      // `changed` is false for wallet users: their address is the one they
      // connected, so there is nothing to repair and nothing to write.
      if (!authService.ensureCustodialWallet(user).changed) continue;
      await user.save();
      fixed++;
    } catch (err) {
      console.error(`  FAILED ${user.email}: ${err.message}`);
    }
  }

  // Accounts predating the `walletMode` field have a valid key pair but no mode,
  // which made the UI guess at call sites. Normalise them to "custodial".
  // `ensureCustodialWallet` reports `changed` for exactly this case.
  for (const user of healthy) {
    if (user.walletMode) continue;
    try {
      const result = authService.ensureCustodialWallet(user);
      if (result.changed) {
        await user.save();
        modesNormalized++;
      }
    } catch (err) {
      console.error(`  FAILED (mode) ${user.email}: ${err.message}`);
    }
  }

  const relayable = await User.find({ walletPrivateKey: { $exists: true, $ne: "" } }).countDocuments();
  console.log(`\nprovisioned ${fixed} custodial wallet(s)`);
  console.log(`normalised ${modesNormalized} walletMode value(s)`);
  console.log(`users now holding a key: ${relayable}/${users.length}`);

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
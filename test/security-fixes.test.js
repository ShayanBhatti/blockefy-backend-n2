/**
 * Unit coverage for the Phase-1 security fixes.
 *
 * Runs WITHOUT a database: these tests assert pure logic — encryption
 * round-trips, the password policy, the verified-email gate, and the
 * wallet nonce → message → signature binding contract.
 *
 * MongoDB-backed behaviours (WalletChallenge one-time use, OAuth code
 * exchange, rate limits) are integration-level and are exercised in
 * e2e/manual runs — see FIX-REPORT.md.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

// --- F6: at-rest secret encryption ----------------------------------------
test("secretEncryption round-trips a private key with a configured key", () => {
  process.env.WALLET_ENC_KEY = "unit-test-encryption-key-0123456789";
  delete require.cache[require.resolve("../src/utils/secretEncryption")];
  const { encrypt, decrypt, isEncrypted } =
    require("../src/utils/secretEncryption");

  const plain = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const stored = encrypt(plain);
  assert.ok(isEncrypted(stored), "stored value must carry the v1 envelope");
  assert.ok(!stored.includes(plain), "ciphertext must not contain the plaintext");
  assert.equal(decrypt(stored), plain, "round-trip must recover the key");
});

test("secretEncryption passes legacy plaintext through and never throws on tamper", () => {
  process.env.WALLET_ENC_KEY = "unit-test-encryption-key-0123456789";
  delete require.cache[require.resolve("../src/utils/secretEncryption")];
  const { encrypt, decrypt, isEncrypted } =
    require("../src/utils/secretEncryption");

  const legacy = "0xdeadbeef";
  assert.equal(isEncrypted(legacy), false, "legacy plaintext has no envelope");
  assert.equal(decrypt(legacy), legacy, "legacy values pass through unchanged");
  assert.equal(encrypt(legacy).startsWith("v1."), true, "re-saving encrypts legacy rows");

  // Tampered / truncated ciphertext must not throw - it degrades to passthrough.
  assert.doesNotThrow(() => decrypt("v1.broken"));
  assert.equal(decrypt("v1.broken"), "v1.broken");
  assert.doesNotThrow(() => decrypt("v1.aa.bb.cc"));
  assert.doesNotThrow(() => decrypt(undefined));
  assert.equal(decrypt(""), "");
});

test("secretEncryption is a no-op when WALLET_ENC_KEY is unset (dev fallback)", () => {
  delete process.env.WALLET_ENC_KEY;
  delete require.cache[require.resolve("../src/utils/secretEncryption")];
  const { encrypt, decrypt, isEncrypted } =
    require("../src/utils/secretEncryption");

  const plain = "dev-key";
  assert.equal(encrypt(plain), plain, "no key -> stored as-is (warns once)");
  assert.equal(decrypt(plain), plain);
  assert.equal(isEncrypted(plain), false);
});

// --- F5: password policy --------------------------------------------------
test("password policy enforces length, letter and number", () => {
  const { validatePasswordStrength } = require("../src/utils/passwordPolicy");

  assert.match(validatePasswordStrength("short1"), /at least 8/);
  assert.match(validatePasswordStrength("aaaaaaaaaa"), /one number/);
  assert.match(validatePasswordStrength("1234567890"), /one letter/);
  assert.equal(validatePasswordStrength(null), "Password must be at least 8 characters long");
  assert.equal(validatePasswordStrength(undefined), "Password must be at least 8 characters long");

  assert.equal(validatePasswordStrength("legitPass1"), null);
  assert.equal(validatePasswordStrength("8chars+num2"), null);
});

// --- F9: verified-email gate ----------------------------------------------
test("requireVerifiedEmail blocks unverified email users, passes the rest", () => {
  const requireVerifiedEmail =
    require("../src/middleware/requireVerifiedEmail");

  const run = (authUser) => {
    let status = null;
    let body = null;
    let calledNext = false;
    const res = {
      status(c) { status = c; return this; },
      json(b) { body = b; return this; },
    };
    const next = () => { calledNext = true; };
    requireVerifiedEmail({ authUser }, res, next);
    return { status, body, calledNext };
  };

  // Unverified email -> 403 EMAIL_NOT_VERIFIED
  const blocked = run({ email: "a@b.com", emailVerified: false });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, "EMAIL_NOT_VERIFIED");
  assert.equal(blocked.calledNext, false);

  // Verified email -> pass
  const okVerified = run({ email: "a@b.com", emailVerified: true });
  assert.equal(okVerified.calledNext, true);

  // Wallet-primary account (no email) -> pass
  const okWallet = run({ email: null, emailVerified: false });
  assert.equal(okWallet.calledNext, true);

  // User without any auth context still passes through (gate is additive)
  assert.equal(run({}).calledNext, true);
});

// --- F2: wallet nonce -> message -> signature binding ---------------------
test("wallet message is derived from the nonce and verifies against the signature", async () => {
  const { generateNonce, buildAuthMessage, verifySignature } =
    require("../src/utils/wallet");
  const ethers = require("ethers");

  const signer = ethers.Wallet.createRandom();
  const { nonce, message } = generateNonce();

  // The issued message MUST equal the canonical build from the nonce.
  assert.equal(message, buildAuthMessage(nonce));
  assert.ok(message.includes(nonce), "message must embed the nonce");

  const signature = await signer.signMessage(message);
  const recovered = verifySignature(message, signature);
  assert.equal(recovered.toLowerCase(), signer.address.toLowerCase());

  // A signature over a version of the message the server never issued must not
  // satisfy the issued nonce: buildAuthMessage is deterministic per nonce, so a
  // mismatch is always detectable by the controller's equality check (F2).
  const signedWrongMessage = await signer.signMessage(
    buildAuthMessage("0x" + "00".repeat(32))
  );
  assert.notEqual(buildAuthMessage("0x" + "00".repeat(32)), message);
  // Correct crypto: the recovered address still matches the signer...
  assert.equal(
    verifySignature(buildAuthMessage("0x" + "00".repeat(32)), signedWrongMessage).toLowerCase(),
    signer.address.toLowerCase()
  );
  // ...but the binding check in the controller (message !== buildAuthMessage(nonce))
  // rejects it, which is what the unit assertion above pins at the message layer.
});
/**
 * At-rest encryption for wallet private keys stored in the User document.
 *
 * Uses AES-256-GCM with a key derived from `WALLET_ENC_KEY`. Stored envelope:
 *   v1.<iv-b64>.<auth-tag-b64>.<ciphertext-b64>
 *
 * Transparent for callers:
 *  - values that do not start with `v1.` are treated as legacy PLAINTEXT and
 *    passed through unchanged (they are re-encrypted on the next save), so
 *    existing rows keep working without a migration;
 *  - if `WALLET_ENC_KEY` is not set the helper degrades to a no-op and warns,
 *    so local/dev environments keep working; production MUST set it.
 */
const crypto = require("crypto");

const ALGO = "aes-256-gcm";
const PREFIX = "v1.";
const IV_LEN = 12;

let warned = false;

const deriveKey = () => {
  const env = process.env.WALLET_ENC_KEY;
  if (!env) {
    if (!warned) {
      console.warn("[secret-encryption] WALLET_ENC_KEY is not set - wallet keys are stored unencrypted");
      warned = true;
    }
    return null;
  }
  return crypto.createHash("sha256").update(String(env)).digest();
};

const encrypt = (plain) => {
  if (typeof plain !== "string" || !plain) return plain;
  if (plain.startsWith(PREFIX)) return plain;
  const key = deriveKey();
  if (!key) return plain;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`;
};

const decrypt = (stored) => {
  if (typeof stored !== "string" || !stored) return stored;
  if (!stored.startsWith(PREFIX)) return stored;
  const key = deriveKey();
  if (!key) return stored;
  try {
    const [ivB64, tagB64, ctB64] = stored.slice(PREFIX.length).split(".");
    if (!ivB64 || !tagB64 || !ctB64) return stored;
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (err) {
    console.error("[secret-encryption] failed to decrypt wallet key:", err.message);
    return stored;
  }
};

const isEncrypted = (value) => typeof value === "string" && value.startsWith(PREFIX);

module.exports = { encrypt, decrypt, isEncrypted };
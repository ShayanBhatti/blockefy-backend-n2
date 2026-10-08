const { ethers } = require("ethers");

/**
 * Generate a new Ethereum wallet
 * Returns: { address, privateKey }
 */
const generateWallet = () => {
  try {
    const wallet = ethers.Wallet.createRandom();

    return {
      address: wallet.address,
      privateKey: wallet.privateKey,
    };
  } catch (error) {
    console.error("Wallet generation failed:", error.message);
    throw new Error("Failed to generate wallet");
  }
};

/**
 * Build the canonical sign-in message for a nonce.
 *
 * Single source of truth: BOTH `generateNonce` (issuing) and the wallet-verify
 * controller (validating) must derive the expected message from this function
 * so a submitted signature can be bound to the exact nonce the server issued.
 */
const buildAuthMessage = (nonce) =>
  `Sign this message to authenticate:\n\nNonce: ${nonce}`;

/**
 * Generate a nonce for wallet signature verification
 * Used for message signing authentication
 */
const generateNonce = () => {
  // Create a random nonce (32 bytes = 64 hex characters)
  const nonce = ethers.hexlify(ethers.randomBytes(32));
  const expiresAt = Date.now() + 15 * 60 * 1000; // Valid for 15 minutes

  return {
    nonce,
    expiresAt,
    message: buildAuthMessage(nonce),
  };
};

/**
 * Verify wallet signature
 * Recovers wallet address from signature and message
 *
 * @param {string} message - Original message that was signed
 * @param {string} signature - EIP-191 signature
 * @returns {string} - Recovered Ethereum address
 */
const verifySignature = (message, signature) => {
  try {
    // Recover address from signature
    const recoveredAddress = ethers.verifyMessage(message, signature);

    if (!recoveredAddress) {
      throw new Error("Could not recover address from signature");
    }

    // Return checksummed address
    return ethers.getAddress(recoveredAddress);
  } catch (error) {
    console.error("Signature verification failed:", error.message);
    throw new Error("Invalid signature");
  }
};

/**
 * Validate wallet address format
 *
 * @param {string} address - Ethereum address
 * @returns {boolean} - True if valid
 */
const isValidAddress = (address) => {
  try {
    return ethers.isAddress(address);
  } catch (error) {
    return false;
  }
};

module.exports = {
  generateWallet,
  generateNonce,
  verifySignature,
  isValidAddress,
  buildAuthMessage,
};

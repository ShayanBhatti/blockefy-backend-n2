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
    message: `Sign this message to authenticate:\n\nNonce: ${nonce}`,
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
};

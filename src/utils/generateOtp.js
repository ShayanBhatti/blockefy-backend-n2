/**
 * Generate a secure 6-digit OTP
 * OTP expires in 15 minutes
 * @returns {Object} { otp: "483921", expiresAt: Date }
 */
const crypto = require("crypto");

const generateOtp = () => {
  // Cryptographically random 6-digit number (avoids Math.random bias/predictability)
  const otp = String(crypto.randomInt(0, 1000000)).padStart(6, "0");

  // Expiry: 15 minutes from now
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  return {
    otp,
    expiresAt,
  };
};

module.exports = { generateOtp };
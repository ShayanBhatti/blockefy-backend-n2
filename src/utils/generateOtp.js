/**
 * Generate a secure 6-digit OTP
 * OTP expires in 15 minutes
 * @returns {Object} { otp: "483921", expiresAt: Date }
 */
const generateOtp = () => {
  // Generate random 6-digit number
  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  // Expiry: 15 minutes from now
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  return {
    otp,
    expiresAt,
  };
};

module.exports = { generateOtp };

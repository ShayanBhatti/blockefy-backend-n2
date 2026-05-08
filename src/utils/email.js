const nodemailer = require("nodemailer");

/**
 * Initialize Nodemailer transporter for Gmail SMTP
 * Uses environment variables: EMAIL_USER, EMAIL_PASS
 */
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

/**
 * Send email verification link to user
 * @param {Object} user - User object with email and emailVerificationToken
 * @param {String} verificationToken - Token for verification
 * @returns {Promise} Result of email sending
 */
const sendVerificationEmail = async (user, verificationToken) => {
  try {
    // Build verification link
    const verificationLink = `${process.env.FRONTEND_URL || "http://localhost:3000"}/verify-email?token=${verificationToken}`;

    const mailOptions = {
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: user.email,
      subject: "Verify Your Email - Blockefy",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Welcome to Blockefy!</h2>
          <p>Hi ${user.fullName || "User"},</p>
          <p>Thank you for registering. Please verify your email address by clicking the button below:</p>
          <a href="${verificationLink}" style="display: inline-block; background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin: 20px 0;">Verify Email</a>
          <p>Or copy this link: <a href="${verificationLink}">${verificationLink}</a></p>
          <p>This link expires in 10 minutes.</p>
          <hr />
          <p>If you didn't create this account, please ignore this email.</p>
          <p>Best regards,<br/>Blockefy Team</p>
        </div>
      `,
      text: `
        Welcome to Blockefy!
        
        Hi ${user.fullName || "User"},
        
        Please verify your email by visiting this link:
        ${verificationLink}
        
        This link expires in 10 minutes.
        
        If you didn't create this account, please ignore this email.
        
        Best regards,
        Blockefy Team
      `,
    };

    const result = await transporter.sendMail(mailOptions);
    console.log("Verification email sent:", result.messageId);
    return result;
  } catch (error) {
    console.error("Error sending verification email:", error);
    throw error;
  }
};

/**
 * Send OTP email for verification
 * @param {Object} user - User object with email and fullName
 * @param {String} otp - 6-digit OTP to send
 * @returns {Promise} Result of email sending
 */
const sendOtpEmail = async (user, otp) => {
  try {
    const mailOptions = {
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: user.email,
      subject: "Verify Your Blockefy Account",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Email Verification Code</h2>
          <p>Hi ${user.fullName || "User"},</p>
          <p>Your verification code is:</p>
          <div style="background-color: #f5f5f5; padding: 20px; text-align: center; border-radius: 5px; margin: 20px 0;">
            <h1 style="letter-spacing: 5px; color: #007bff; margin: 0;">${otp}</h1>
          </div>
          <p>This code expires in <strong>15 minutes</strong>.</p>
          <p>Do not share this code with anyone.</p>
          <hr />
          <p>If you didn't request this code, please ignore this email.</p>
          <p>Best regards,<br/>Blockefy Team</p>
        </div>
      `,
      text: `
        Email Verification Code
        
        Hi ${user.fullName || "User"},
        
        Your verification code is:
        ${otp}
        
        This code expires in 15 minutes.
        
        Do not share this code with anyone.
        
        If you didn't request this code, please ignore this email.
        
        Best regards,
        Blockefy Team
      `,
    };

    const result = await transporter.sendMail(mailOptions);
    console.log("OTP email sent:", result.messageId);
    return result;
  } catch (error) {
    console.error("Error sending OTP email:", error);
    throw error;
  }
};

/**
 * Send password reset email
 * @param {Object} user - User object with email
 * @param {String} resetToken - Token for password reset
 * @returns {Promise} Result of email sending
 */
const sendPasswordResetEmail = async (user, resetToken) => {
  try {
    const resetLink = `${process.env.FRONTEND_URL || "http://localhost:3000"}/reset-password?token=${resetToken}`;

    const mailOptions = {
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: user.email,
      subject: "Reset Your Password - Blockefy",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Password Reset Request</h2>
          <p>Hi ${user.fullName || "User"},</p>
          <p>We received a request to reset your password. Click the button below to proceed:</p>
          <a href="${resetLink}" style="display: inline-block; background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin: 20px 0;">Reset Password</a>
          <p>Or copy this link: <a href="${resetLink}">${resetLink}</a></p>
          <p>This link expires in 1 hour.</p>
          <hr />
          <p>If you didn't request this, please ignore this email.</p>
          <p>Best regards,<br/>Blockefy Team</p>
        </div>
      `,
      text: `
        Password Reset Request
        
        Hi ${user.fullName || "User"},
        
        Please reset your password by visiting this link:
        ${resetLink}
        
        This link expires in 1 hour.
        
        If you didn't request this, please ignore this email.
        
        Best regards,
        Blockefy Team
      `,
    };

    const result = await transporter.sendMail(mailOptions);
    console.log("Password reset email sent:", result.messageId);
    return result;
  } catch (error) {
    console.error("Error sending password reset email:", error);
    throw error;
  }
};

module.exports = {
  transporter,
  sendVerificationEmail,
  sendOtpEmail,
  sendPasswordResetEmail,
};

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
 * HTML Email Template Base
 */
const getEmailTemplate = (content) => {
  return `<!DOCTYPE html>
<html lang="en" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:v="urn:schemas-microsoft-com:vml">
<head>
<meta charset="utf-8"/>
<meta content="width=device-width, initial-scale=1.0" name="viewport"/>
<meta name="x-apple-disable-message-reformatting"/>
<meta content="IE=edge" http-equiv="X-UA-Compatible"/>
<title>${content.title}</title>
<style>
body { margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; background-color: #f5f7fb; }
table { border-spacing: 0 !important; border-collapse: collapse !important; table-layout: fixed !important; margin: 0 auto !important; }
img { -ms-interpolation-mode: bicubic; border: 0; }
.content-table { width: 100%; max-width: 600px !important; }
@media screen and (max-width: 600px) {
  .responsive-padding { padding: 24px !important; }
  .otp-text { font-size: 36px !important; }
}
</style>
</head>
<body class="bg-[#f5f7fb]">
<div aria-label="${content.title}" aria-roledescription="email" lang="en" role="article">
<!-- Top Bar -->
<table align="center" border="0" cellpadding="0" cellspacing="0" class="content-table" style="margin-top: 32px; background-color: #ffffff;">
<tbody><tr>
<td align="center" class="py-6 px-4">
<h1 style="margin: 0; color: #4f378a; font-size: 24px; font-weight: bold;">BLOCKEFY</h1>
</td>
</tr>
</tbody></table>

<!-- Main Content -->
<table align="center" border="0" cellpadding="0" cellspacing="0" class="content-table" style="background-color: #ffffff;">
<tbody><tr>
<td align="center" class="responsive-padding" style="padding: 40px;">
${content.body}
</td>
</tr>
</tbody></table>

<!-- Footer -->
<table align="center" border="0" cellpadding="0" cellspacing="0" class="content-table" style="background-color: #f8f2fa; margin-bottom: 32px;">
<tbody><tr>
<td align="center" class="py-8 px-6">
<div style="font-weight: bold; color: #4f378a; margin-bottom: 8px;">BLOCKEFY</div>
<p style="margin: 0; color: #494551; font-size: 14px;">Connecting freelancers and clients worldwide.</p>
<div style="margin-top: 16px; font-size: 12px;">
<a href="#" style="color: #4b4263; text-decoration: underline; margin: 0 8px;">Support Center</a>
<span style="color: #cbc4d2;">•</span>
<a href="#" style="color: #4b4263; text-decoration: underline; margin: 0 8px;">Privacy Policy</a>
</div>
<p style="margin: 16px 0 0 0; font-size: 11px; color: #7a7582;">
© 2024 Blockefy. All rights reserved. <br/>
<a href="mailto:support@blockefy.com" style="color: #4f378a; text-decoration: none;">support@blockefy.com</a>
</p>
</td>
</tr>
</tbody></table>
</div>
</body>
</html>`;
};

/**
 * Send OTP email for verification
 * @param {Object} user - User object with email and fullName
 * @param {String} otp - 6-digit OTP to send
 * @returns {Promise} Result of email sending
 */
const sendOtpEmail = async (user, otp) => {
  try {
    const body = `
<h1 style="margin: 0 0 16px 0; color: #1d1b20; font-size: 32px; font-weight: bold;">Verify Your Email Address</h1>
<p style="margin: 0 0 32px 0; color: #494551; font-size: 16px; line-height: 1.5;">
Welcome to Blockefy, <strong>${user.fullName || "User"}</strong>. Use the verification code below to continue creating your account and start working without limits.
</p>

<!-- OTP Card -->
<table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #eff6ff; border-radius: 12px; margin-bottom: 32px;">
<tbody><tr>
<td align="center" style="padding: 32px;">
<div class="otp-text" style="color: #4f378a; letter-spacing: 0.2em; font-size: 48px; font-weight: bold; margin: 0; font-family: monospace;">
${otp}
</div>
</td>
</tr>
</tbody></table>

<!-- Security Reminder -->
<table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f8f2fa; border: 1px solid #cbc4d2; border-radius: 8px; margin-bottom: 32px;">
<tbody><tr>
<td style="padding: 20px;">
<p style="margin: 0 0 12px 0; color: #1d1b20; font-weight: bold; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">🔒 Security Reminder</p>
<ul style="margin: 0; padding: 0; list-style: none;">
<li style="color: #494551; font-size: 14px; margin-bottom: 8px;">• This code expires in <strong>15 minutes</strong>.</li>
<li style="color: #494551; font-size: 14px; margin-bottom: 8px;">• Never share this verification code with anyone.</li>
<li style="color: #494551; font-size: 14px;">• Blockefy staff will <strong>never</strong> ask for this code.</li>
</ul>
</td>
</tr>
</tbody></table>

<p style="margin: 0; color: #7a7582; font-size: 14px; line-height: 1.5;">
If you did not request this verification code, you can safely ignore this email. No action is required and your account remains secure.
</p>
    `;

    const htmlContent = getEmailTemplate({
      title: "Verify Your Email - Blockefy",
      body: body,
    });

    const mailOptions = {
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: user.email,
      subject: "Verify Your Blockefy Account",
      html: htmlContent,
      text: `Verify Your Email Address\n\nWelcome to Blockefy, ${user.fullName || "User"}.\n\nYour verification code is:\n${otp}\n\nThis code expires in 15 minutes.\n\nDo not share this code with anyone.\n\nIf you didn't request this code, please ignore this email.\n\nBest regards,\nBlockefy Team`,
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
 * Send email verification link to user
 * @param {Object} user - User object with email and fullName
 * @param {String} verificationToken - Token for verification
 * @returns {Promise} Result of email sending
 */
const sendVerificationEmail = async (user, verificationToken) => {
  try {
    const verificationLink = `${process.env.FRONTEND_URL || "http://localhost:3000"}/verify-email?token=${verificationToken}`;

    const body = `
<h1 style="margin: 0 0 16px 0; color: #1d1b20; font-size: 32px; font-weight: bold;">Verify Your Email Address</h1>
<p style="margin: 0 0 32px 0; color: #494551; font-size: 16px; line-height: 1.5;">
Welcome to Blockefy, <strong>${user.fullName || "User"}</strong>. Click the button below to verify your email and activate your account.
</p>

<!-- CTA Button -->
<table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 32px;">
<tbody><tr>
<td align="center">
<a href="${verificationLink}" style="display: inline-block; background-color: #4f378a; color: white; padding: 12px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px;">Verify Email</a>
</td>
</tr>
</tbody></table>

<p style="margin: 0 0 16px 0; color: #7a7582; font-size: 14px;">Or copy this link:</p>
<p style="margin: 0 0 32px 0; color: #4f378a; font-size: 14px; word-break: break-all;">
<a href="${verificationLink}" style="color: #4f378a; text-decoration: underline;">${verificationLink}</a>
</p>

<!-- Security Info -->
<table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f8f2fa; border: 1px solid #cbc4d2; border-radius: 8px; margin-bottom: 32px;">
<tbody><tr>
<td style="padding: 20px;">
<p style="margin: 0 0 12px 0; color: #1d1b20; font-weight: bold; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">🔒 Security Info</p>
<ul style="margin: 0; padding: 0; list-style: none;">
<li style="color: #494551; font-size: 14px; margin-bottom: 8px;">• This link expires in <strong>10 minutes</strong>.</li>
<li style="color: #494551; font-size: 14px;">• If you didn't create this account, please ignore this email.</li>
</ul>
</td>
</tr>
</tbody></table>
    `;

    const htmlContent = getEmailTemplate({
      title: "Verify Your Email - Blockefy",
      body: body,
    });

    const mailOptions = {
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: user.email,
      subject: "Verify Your Email - Blockefy",
      html: htmlContent,
      text: `Welcome to Blockefy!\n\nHi ${user.fullName || "User"},\n\nPlease verify your email by visiting this link:\n${verificationLink}\n\nThis link expires in 10 minutes.\n\nIf you didn't create this account, please ignore this email.\n\nBest regards,\nBlockefy Team`,
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
 * Send password reset email
 * @param {Object} user - User object with email and fullName
 * @param {String} resetToken - Token for password reset
 * @returns {Promise} Result of email sending
 */
const sendPasswordResetEmail = async (user, resetToken) => {
  try {
    const resetLink = `${process.env.FRONTEND_URL || "http://localhost:3000"}/reset-password?token=${resetToken}`;

    const body = `
<h1 style="margin: 0 0 16px 0; color: #1d1b20; font-size: 32px; font-weight: bold;">Reset Your Password</h1>
<p style="margin: 0 0 32px 0; color: #494551; font-size: 16px; line-height: 1.5;">
Hi <strong>${user.fullName || "User"}</strong>, we received a request to reset your password. Click the button below to proceed.
</p>

<!-- CTA Button -->
<table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 32px;">
<tbody><tr>
<td align="center">
<a href="${resetLink}" style="display: inline-block; background-color: #4f378a; color: white; padding: 12px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px;">Reset Password</a>
</td>
</tr>
</tbody></table>

<p style="margin: 0 0 16px 0; color: #7a7582; font-size: 14px;">Or copy this link:</p>
<p style="margin: 0 0 32px 0; color: #4f378a; font-size: 14px; word-break: break-all;">
<a href="${resetLink}" style="color: #4f378a; text-decoration: underline;">${resetLink}</a>
</p>

<!-- Security Info -->
<table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f8f2fa; border: 1px solid #cbc4d2; border-radius: 8px; margin-bottom: 32px;">
<tbody><tr>
<td style="padding: 20px;">
<p style="margin: 0 0 12px 0; color: #1d1b20; font-weight: bold; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">🔒 Security Info</p>
<ul style="margin: 0; padding: 0; list-style: none;">
<li style="color: #494551; font-size: 14px; margin-bottom: 8px;">• This link expires in <strong>1 hour</strong>.</li>
<li style="color: #494551; font-size: 14px;">• If you didn't request this, please ignore this email.</li>
</ul>
</td>
</tr>
</tbody></table>
    `;

    const htmlContent = getEmailTemplate({
      title: "Reset Your Password - Blockefy",
      body: body,
    });

    const mailOptions = {
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: user.email,
      subject: "Reset Your Password - Blockefy",
      html: htmlContent,
      text: `Password Reset Request\n\nHi ${user.fullName || "User"},\n\nPlease reset your password by visiting this link:\n${resetLink}\n\nThis link expires in 1 hour.\n\nIf you didn't request this, please ignore this email.\n\nBest regards,\nBlockefy Team`,
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

/**
 * Gate for money-movement / sensitive endpoints: accounts that HAVE an email
 * must have verified it before entering funds or revealing keys. Accounts that
 * changed their phone/relay only (email absent, e.g. wallet-primary) are not
 * blocked - there is no inbox to verify.
 *
 * Place AFTER `authenticate` so `req.authUser` is populated.
 */
const requireVerifiedEmail = (req, res, next) => {
  const user = req.authUser;
  if (user && user.email && !user.emailVerified) {
    return res.status(403).json({
      success: false,
      message: "Please verify your email address before proceeding",
      code: "EMAIL_NOT_VERIFIED",
    });
  }
  next();
};

module.exports = requireVerifiedEmail;
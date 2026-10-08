const { verifyToken } = require("./authMiddleware");
const User = require("../models/User");
const { decrypt } = require("../utils/secretEncryption");

/**
 * Authentication middleware (order-system flavour).
 *
 * 1. Verifies the JWT (existing verifyToken behaviour).
 * 2. Loads the full user document into `req.authUser`.
 * 3. Rejects suspended accounts and accounts that no longer exist.
 *
 * `req.authUser` is the authoritative user used for role + ownership checks.
 * The role is NEVER read from the request body.
 */
const authenticate = async (req, res, next) => {
  try {
    verifyToken(req, res, async (err) => {
      if (err) return next(err);
      try {
        // `+externalWallet.privateKey` is required: it is `select: false` on the
        // schema (so never serialised into a response), and on-chain relaying
        // needs it. Keep this projection `+`-only. Mixing `+`-prefixed fields
        // with plain field names makes Mongoose silently drop ALL of them - see
        // the note in services/wallet.service.js.
        const user = await User.findById(req.user.userId)
          .select("+walletPrivateKey +externalWallet.privateKey")
          .lean();
        if (!user) {
          return res.status(401).json({ success: false, message: "User no longer exists", code: "UNAUTHORIZED" });
        }
        if (user.isSuspended) {
          return res.status(403).json({ success: false, message: "Account suspended", code: "FORBIDDEN" });
        }
        // `lean()` skips the schema init hook that decrypts key fields, so the
        // encrypted-at-rest values must be decrypted here before any relay use.
        user.walletPrivateKey = user.walletPrivateKey
          ? decrypt(user.walletPrivateKey)
          : user.walletPrivateKey;
        if (user.externalWallet?.privateKey) {
          user.externalWallet = {
            ...user.externalWallet,
            privateKey: decrypt(user.externalWallet.privateKey),
          };
        }
        req.authUser = user;
        next();
      } catch (error) {
        next(error);
      }
    });
  } catch (error) {
    next(error);
  }
};

module.exports = authenticate;

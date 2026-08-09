const { verifyToken } = require("./authMiddleware");
const User = require("../models/User");

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
        const user = await User.findById(req.user.userId).lean();
        if (!user) {
          return res.status(401).json({ success: false, message: "User no longer exists", code: "UNAUTHORIZED" });
        }
        if (user.isSuspended) {
          return res.status(403).json({ success: false, message: "Account suspended", code: "FORBIDDEN" });
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

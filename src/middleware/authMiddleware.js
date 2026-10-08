const jwt = require("jsonwebtoken");
const User = require("../models/User");

/**
 * Verify JWT token from Authorization header
 * Attaches decoded payload to req.user and the live user document to
 * req.authUser if valid.
 *
 * Security notes:
 *  - algorithm is pinned to HS256 (prevents algorithm-confusion tokens)
 *  - the JWT identity is re-resolved against the database on EVERY request,
 *    so deleted accounts are rejected (401) and suspended accounts are
 *    rejected (403) on every route regardless of which auth middleware a
 *    router mounted. This unifies behaviour across the legacy (verifyToken)
 *    and Web3 (authenticate) stacks.
 */
const verifyToken = async (req, res, next) => {
  try {
    // Extract token from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ msg: "No authorization header" });
    }

    // Expected format: "Bearer <token>"
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : authHeader;

    if (!token) {
      return res.status(401).json({ msg: "No token provided" });
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ["HS256"],
    });
    req.user = decoded;

    // F11: resolve the live user so suspension / account-existence is enforced
    // on every route, not only the Web3 stack using `authenticate`. Key fields
    // are excluded (F6): legacy routes never need them; the Web3 stack selects
    // them explicitly (`+walletPrivateKey`) and decrypts.
    const user = await User.findById(req.user.userId)
      .select("-walletPrivateKey -externalWallet.privateKey")
      .lean();
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User no longer exists",
        code: "UNAUTHORIZED",
      });
    }
    if (user.isSuspended) {
      return res.status(403).json({
        success: false,
        message: "Account suspended",
        code: "FORBIDDEN",
      });
    }
    req.authUser = user;
    next();
  } catch (error) {
    console.error("Token verification failed:", error.message);

    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ msg: "Token expired" });
    }

    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({ msg: "Invalid token" });
    }

    return res.status(401).json({ msg: "Token verification failed" });
  }
};

module.exports = {
  verifyToken,
};
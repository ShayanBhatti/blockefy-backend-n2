/**
 * Role-based authorization middleware.
 *
 * Checks `req.authUser.role` (set by the `authenticate` middleware from the
 * database). Never trusts `req.body.role` or anything from the client.
 *
 * Usage: authenticate, authorizeRole("buyer")
 */
const authorizeRole = (...allowedRoles) => {
  return (req, res, next) => {
    const user = req.authUser;
    if (!user) {
      return res.status(401).json({ success: false, message: "Authentication required", code: "UNAUTHORIZED" });
    }
    if (!allowedRoles.includes(user.role)) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to perform this action",
        code: "FORBIDDEN",
      });
    }
    next();
  };
};

module.exports = authorizeRole;

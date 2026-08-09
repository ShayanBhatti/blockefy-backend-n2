/**
 * In-memory fixed-window rate limiter (no external dependency).
 *
 * Suitable for a single-instance deployment / development. For a multi-instance
 * or Vercel deployment, replace with a distributed store (Redis) or
 * express-rate-limit + external store — the rest of the code does not change
 * because this module exposes a drop-in Express middleware factory.
 *
 * Usage:
 *   const strict = createRateLimiter({ windowMs: 60_000, max: 10 });
 *   router.post("/create-payment", authenticate, strict, controller);
 */
const createRateLimiter = ({ windowMs = 60_000, max = 100, keyFn } = {}) => {
  const buckets = new Map();
  const message = "Too many requests, please try again later.";

  // Periodic cleanup of stale buckets so the map never grows unbounded.
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of buckets) {
      if (now - entry.resetAt > windowMs) buckets.delete(key);
    }
  }, Math.max(windowMs, 60_000));
  if (timer.unref) timer.unref();

  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : (req.authUser?._id?.toString() || req.ip || "anonymous");
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (bucket.count >= max) {
      res.set("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({
        success: false,
        message,
        code: "RATE_LIMITED",
      });
    }

    bucket.count += 1;
    next();
  };
};

/**
 * Rate limit keyed by authenticated user id (falls back to IP).
 */
const userKeyFn = (req) => req.authUser?._id?.toString() || req.ip || "anonymous";

module.exports = { createRateLimiter, userKeyFn };

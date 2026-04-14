function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.trim()) return xf.split(",")[0].trim();
  return req.ip || req.connection?.remoteAddress || "unknown";
}

function createRateLimiter({ windowMs = 60_000, limit = 60, keyPrefix = "rl" } = {}) {
  const hits = new Map();

  return function rateLimit(req, res, next) {
    const ip = getClientIp(req);
    const key = `${keyPrefix}:${ip}:${req.method}:${req.baseUrl || ""}${req.path || ""}`;
    const now = Date.now();

    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return next();
    }

    entry.count += 1;
    if (entry.count > limit) {
      res.status(429).json({ ok: false, error: "Rate limit exceeded" });
      return;
    }

    // Opportunistic cleanup
    if (hits.size > 50_000) {
      for (const [k, v] of hits) {
        if (now - v.start > windowMs * 2) hits.delete(k);
      }
    }

    next();
  };
}

module.exports = {
  createRateLimiter,
};

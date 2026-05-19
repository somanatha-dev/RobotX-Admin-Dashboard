const logger = require("../config/logger");

function errorHandler(err, req, res, _next) {
  const status = Number(err?.status) || 500;
  const message = status === 500 ? "Internal Server Error" : (err?.message || "Error");

  // Pick the first meaningful stack frame (skip node internals).
  const frames = (err?.stack || "").split("\n").slice(1);
  const frame  = frames.find((l) => l.includes("/src/") || l.includes("\\src\\")) || frames[1] || "";

  logger.error(`[${req.method} ${req.originalUrl}] ${message}`, {
    status,
    at: frame.trim(),
    ...(status === 500 && err?.stack ? { stack: err.stack.split("\n").slice(0, 4).join(" | ") } : {}),
  });

  res.status(status).json({ message });
}

module.exports = errorHandler;

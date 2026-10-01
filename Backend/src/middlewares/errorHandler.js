const logger = require("../config/logger");

function errorHandler(err, req, res, _next) {
  const status = Number(err?.status) || 500;
  const message = status === 500 ? "Internal Server Error" : (err?.message || "Error");

  // Pick the first meaningful stack frame (skip node internals).
  const frames = (err?.stack || "").split("\n").slice(1);
  const frame  = frames.find((l) => l.includes("/src/") || l.includes("\\src\\")) || frames[1] || "";

  // `code` and `meta` are how a database error says what it is. Without them a Prisma
  // P2022 ("column `Robot.massKg` does not exist") logged as four stack lines that all read
  // "Invalid … invocation" at the Robot insert — the cause was on a line this handler dropped,
  // so schema drift presented as a bug in the service. Logged only; the response is unchanged.
  logger.error(`[${req.method} ${req.originalUrl}] ${message}`, {
    status,
    ...(err?.code ? { code: String(err.code) } : {}),
    ...(err?.meta && typeof err.meta === "object" ? { meta: err.meta } : {}),
    at: frame.trim(),
    ...(status === 500 && err?.stack ? { stack: err.stack.split("\n").slice(0, 4).join(" | ") } : {}),
  });

  res.status(status).json({ message });
}

module.exports = errorHandler;

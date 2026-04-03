const logger = require("../config/logger");

function errorHandler(err, req, res, _next) {
  const status = Number(err && err.status) || 500;
  const message = status === 500 ? "Internal Server Error" : (err.message || "Error");

  logger.error(message, {
    status,
    path: req.originalUrl,
    method: req.method,
    stack: err && err.stack,
  });

  res.status(status).json({ message });
}

module.exports = errorHandler;

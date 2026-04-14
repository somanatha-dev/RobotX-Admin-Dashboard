const pino = require("pino");

const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";

const base = pino({
  level: process.env.LOG_LEVEL || (isProd ? "info" : "debug"),
  // Use standard keys so log ingestion is straightforward.
  timestamp: pino.stdTimeFunctions.isoTime,
});

function log(level, a, b) {
  // Compatibility wrapper to support existing winston-like calls:
  // - logger.info("msg")
  // - logger.info("msg", { meta })
  // - logger.error("msg", err)
  // - logger.error({ meta }, "msg")
  try {
    if (typeof a === "string") {
      const msg = a;
      if (b && typeof b === "object") {
        if (b instanceof Error) return base[level]({ err: b }, msg);
        return base[level](b, msg);
      }
      if (b !== undefined) return base[level]({ meta: b }, msg);
      return base[level](msg);
    }

    if (a instanceof Error) {
      return base[level]({ err: a }, a.message);
    }

    if (a && typeof a === "object") {
      if (typeof b === "string") return base[level](a, b);
      return base[level](a);
    }

    return base[level](String(a));
  } catch {
    // Last resort: never crash the process due to logging.
  }
}

const logger = {
  info: (a, b) => log("info", a, b),
  warn: (a, b) => log("warn", a, b),
  error: (a, b) => log("error", a, b),
  debug: (a, b) => log("debug", a, b),
};

module.exports = logger;

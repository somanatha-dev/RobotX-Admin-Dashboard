// Test-only stand-in for src/config/logger.js. Mapped in via jest.config.js
// `moduleNameMapper` so test runs stay quiet (no ANSI-colored dev-console
// noise from code paths that are *supposed* to log — e.g. a deliberately
// failed task assignment) without touching the real logger's production
// behavior. No test asserts on logger output, so a no-op stand-in is safe.
const noop = () => {};

const logger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  http: noop,
  httpEnd: noop,
  socket: noop,
  socketIn: noop,
  socketOut: noop,
  dtaro: noop,
  startup: noop,
  simulation: noop,
  obstacle: noop,
  child: () => logger,
};

module.exports = logger;

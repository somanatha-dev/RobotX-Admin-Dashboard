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

// PHASE 11 — §21.7's structured engine emitters. The real logger enforces log-volume
// discipline by *throwing* outside production when handed per-candidate detail; the
// stand-in must not silently accept what the real one refuses, or a test would pass
// against a payload production would reject. So these delegate to the real
// implementations of the discipline and drop only the rendering.
const real = jest.requireActual("../../src/config/logger");

logger.TRACE_FIELDS = real.TRACE_FIELDS;
logger.PER_CANDIDATE_FIELDS = real.PER_CANDIDATE_FIELDS;
logger.LogVolumeDisciplineError = real.LogVolumeDisciplineError;
logger.withoutPerCandidateDetail = real.withoutPerCandidateDetail;
logger.missingTraceFields = real.missingTraceFields;

logger.round = (summary = {}) => {
  const { removed } = real.withoutPerCandidateDetail(summary);
  if (removed.length > 0) throw new real.LogVolumeDisciplineError(removed);
  return { kind: "round", ...summary };
};

logger.anomaly = (kind, meta = {}) => {
  const { removed } = real.withoutPerCandidateDetail(meta);
  if (removed.length > 0) throw new real.LogVolumeDisciplineError(removed);
  return { kind: `anomaly.${kind}`, ...meta };
};

module.exports = logger;

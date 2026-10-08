/**
 * RobotX Logger
 *
 * Development : colourised, emoji-prefixed, human-readable timeline.
 * Production  : newline-delimited JSON (pino) — pipe to any log aggregator.
 *
 * API (backward-compatible with existing calls):
 *   logger.info(msg, meta?)
 *   logger.warn(msg, meta?)
 *   logger.error(msg, err | meta?)
 *   logger.debug(msg, meta?)
 *
 * Extended API:
 *   logger.child(moduleName)           → child logger that prefixes every line
 *   logger.http(req)                   → log incoming HTTP request
 *   logger.httpEnd(res, durationMs)    → log HTTP response + timing
 *   logger.socket(event, meta)         → log socket connect/disconnect
 *   logger.socketIn(event, meta)       → log inbound socket event
 *   logger.socketOut(event, meta)      → log outbound socket emit
 *   logger.dtaro(report)               → log full DTARO allocation decision
 *   logger.startup(info)               → print startup banner
 *   logger.simulation(meta)            → log VirtualRobot state tick
 *   logger.obstacle(meta)              → log obstacle report
 */

"use strict";

const pino = require("pino");

const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";

// ─── Colours (safe ANSI, works in any terminal) ───────────────────────────────

const c = (() => {
  const ESC = "\x1b[";
  const R = "\x1b[0m";
  const mk = (code) => (s) => `${ESC}${code}m${s}${R}`;

  return {
    reset:   R,
    bold:    mk("1"),
    dim:     mk("2"),
    red:     mk("31"),
    green:   mk("32"),
    yellow:  mk("33"),
    blue:    mk("34"),
    magenta: mk("35"),
    cyan:    mk("36"),
    white:   mk("37"),
    gray:    mk("90"),
    bgRed:   mk("41"),
    // Bright variants
    bRed:    mk("91"),
    bGreen:  mk("92"),
    bYellow: mk("93"),
    bBlue:   mk("94"),
    bMagenta:mk("95"),
    bCyan:   mk("96"),
    bWhite:  mk("97"),
  };
})();

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Matched against the lower-cased key. H7 — `pairingCode` is a credential for its 300 s life:
// whoever presents it with the robotId becomes that robot. Redacted wherever it appears (a
// request body, a query string, log metadata), even though no request carries it today.
const SENSITIVE = new Set(["password", "token", "secret", "authorization", "cookie", "pin", "pairingcode"]);

function sanitise(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 3) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SENSITIVE.has(k.toLowerCase()) ? "[redacted]" : sanitise(v, depth + 1);
  }
  return out;
}

function truncate(s, max = 160) {
  const str = typeof s === "string" ? s : JSON.stringify(s);
  if (!str || str.length <= max) return str;
  return str.slice(0, max) + c.dim(`…+${str.length - max}`);
}

function metaLine(meta, indent = "  ") {
  if (!meta || typeof meta !== "object" || !Object.keys(meta).length) return "";
  const clean = sanitise(meta);
  const pairs = Object.entries(clean)
    .map(([k, v]) => `${c.dim(k)}=${truncate(typeof v === "object" ? JSON.stringify(v) : String(v), 100)}`)
    .join("  ");
  return `\n${indent}${pairs}`;
}

function ts() {
  return c.dim(new Date().toLocaleTimeString("en-IN", { hour12: false }));
}

function pad(s, len) {
  return String(s).padEnd(len);
}

// ─── Level formatters ─────────────────────────────────────────────────────────

const LEVEL = {
  info:  { icon: c.bCyan("●"),   label: c.cyan(pad("INFO",  5)) },
  warn:  { icon: c.bYellow("▲"), label: c.yellow(pad("WARN",  5)) },
  error: { icon: c.bRed("✕"),    label: c.red(pad("ERROR", 5)) },
  debug: { icon: c.gray("◌"),    label: c.gray(pad("DEBUG", 5)) },
};

function printLine(level, module, msg, meta) {
  const lv = LEVEL[level] || LEVEL.info;
  const mod = module ? c.dim(`[${module}] `) : "";
  const line = `${ts()} ${lv.icon} ${lv.label} ${mod}${msg}${metaLine(meta)}`;
  if (level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

// ─── Production logger (structured JSON) ─────────────────────────────────────

const pinoBase = pino({
  level: process.env.LOG_LEVEL || (isProd ? "info" : "debug"),
  timestamp: pino.stdTimeFunctions.isoTime,
});

function pinoLog(level, module, msg, meta) {
  if (meta instanceof Error) {
    pinoBase[level]({ err: meta, module }, msg);
    return;
  }
  // H7 — the production path redacts with the same rule as the dev printer. It used to hand
  // `meta` to pino as given, so a credential-named key was redacted in development and
  // written out on Render.
  const clean = meta && typeof meta === "object" ? sanitise(meta) : meta;
  const obj = module ? { module, ...(clean || {}) } : (clean || {});
  pinoBase[level](obj, msg);
}

// ─── Dev-path level gating ─────────────────────────────────────────────────
// The pino `level` option above only ever applied to the prod JSON path
// (pinoLog) — the dev printLine path had no filtering at all, so .debug()
// calls were indistinguishable from .info() in dev/benchmark runs regardless
// of LOG_LEVEL. Same default as pino (debug in dev, info in prod) so default
// local-dev behavior is unchanged; this only starts filtering when LOG_LEVEL
// is explicitly raised.
const LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40 };
const minDevLevel = LEVEL_RANK[process.env.LOG_LEVEL] ?? LEVEL_RANK[isProd ? "info" : "debug"];
function devLevelEnabled(level) {
  return (LEVEL_RANK[level] ?? LEVEL_RANK.info) >= minDevLevel;
}

// ─── Core logger factory ──────────────────────────────────────────────────────

function makeLogger(module) {
  function log(level, a, b) {
    if (isProd) {
      const msg = typeof a === "string" ? a : (a instanceof Error ? a.message : JSON.stringify(a));
      const meta = b !== undefined ? b : (typeof a === "object" && !(a instanceof Error) ? a : undefined);
      pinoLog(level, module, msg, meta);
      return;
    }

    // Dev path
    if (!devLevelEnabled(level)) return;
    try {
      if (typeof a === "string") {
        printLine(level, module, a, b && typeof b === "object" ? sanitise(b) : undefined);
      } else if (a instanceof Error) {
        printLine(level, module, a.message, { stack: a.stack?.split("\n")[1]?.trim() });
      } else if (a && typeof a === "object") {
        const msg = typeof b === "string" ? b : "";
        printLine(level, module, msg, sanitise(a));
      }
    } catch {
      /* never crash the process due to logging */
    }
  }

  return {
    info:  (a, b) => log("info",  a, b),
    warn:  (a, b) => log("warn",  a, b),
    error: (a, b) => log("error", a, b),
    debug: (a, b) => log("debug", a, b),

    child: (name) => makeLogger(name),
  };
}

const rootLogger = makeLogger(null);

// ─── HTTP request / response ──────────────────────────────────────────────────

const SKIP_PATHS = new Set(["/health", "/favicon.ico"]);

const METHOD_COLOR = {
  GET:    c.bGreen,
  POST:   c.bBlue,
  PUT:    c.bYellow,
  PATCH:  c.bYellow,
  DELETE: c.bRed,
};

// H7 — the path without its query string. The query is printed on its own line, redacted; printed
// inside the URL as well, a credential in it would reach the log however the query line treated it.
function pathOnly(req) {
  return String(req.originalUrl || req.url || "").split("?")[0];
}

rootLogger.http = function logRequest(req) {
  if (SKIP_PATHS.has(req.path)) return;
  const method = (METHOD_COLOR[req.method] || c.white)(pad(req.method, 6));
  const url = c.bWhite(pathOnly(req));
  const lines = [`${ts()} ${c.cyan("→")} ${method} ${url}`];

  const q = req.query && Object.keys(req.query).length ? sanitise(req.query) : null;
  const b = req.body  && Object.keys(req.body).length  ? sanitise(req.body) : null;
  if (q) lines.push(`  ${c.dim("query:")} ${truncate(JSON.stringify(q))}`);
  if (b) lines.push(`  ${c.dim("body: ")} ${truncate(JSON.stringify(b))}`);

  process.stdout.write(lines.join("\n") + "\n");
};

rootLogger.httpEnd = function logResponse(req, res, ms) {
  if (SKIP_PATHS.has(req.path)) return;
  const code = res.statusCode;
  const statusColor = code >= 500 ? c.bRed : code >= 400 ? c.bYellow : c.bGreen;
  const dur = code >= 400 ? c.bYellow(`${ms}ms`) : c.dim(`${ms}ms`);
  process.stdout.write(
    `${ts()} ${c.cyan("←")} ${statusColor(String(code))} ${c.dim(req.method)} ${c.dim(pathOnly(req))}  ${dur}\n`
  );
};

// ─── Socket.IO events ─────────────────────────────────────────────────────────

rootLogger.socket = function logSocket(event, meta = {}) {
  const evMap = {
    connect:    { icon: c.bGreen("⬆"),  label: c.bGreen("CONNECTED   ") },
    disconnect: { icon: c.bRed("⬇"),    label: c.bRed("DISCONNECTED") },
    join:       { icon: c.cyan("⤷"),    label: c.cyan("ROOM JOIN   ") },
  };
  const ev = evMap[event] || { icon: c.magenta("◈"), label: c.magenta(pad(event, 12)) };
  const sid = meta.socketId ? c.dim(meta.socketId.slice(0, 8)) : "";
  const extra = meta.room ? c.dim(` → ${meta.room}`) : (meta.robotId ? c.dim(` robot=${meta.robotId}`) : "");
  process.stdout.write(`${ts()} ${ev.icon} SOCKET  ${ev.label}  ${sid}${extra}\n`);
};

rootLogger.socketIn = function logSocketIn(event, meta = {}) {
  const robotId = meta.robotId ? c.bCyan(meta.robotId) : "";
  const evt = c.bMagenta(pad(event, 18));
  process.stdout.write(`${ts()} ${c.magenta("⇢")} SOCKET  ${evt}  ${robotId}\n`);
};

rootLogger.socketOut = function logSocketOut(event, target, meta = {}) {
  const room = target ? c.dim(`→ ${target}`) : "";
  const evt = c.magenta(pad(event, 18));
  const robotId = meta.robotId ? c.dim(` robot=${meta.robotId}`) : "";
  process.stdout.write(`${ts()} ${c.magenta("⇠")} SOCKET  ${evt}  ${room}${robotId}\n`);
};

// ─── DTARO allocation report ──────────────────────────────────────────────────
//
// SUPERSEDED BY PHASE 6 — retires with the legacy dispatcher at Phase 15.
//
// §7.7 replaces this with structured rejection telemetry
// (`src/engine/feasibility/rejectionTelemetry.js`), for a reason it states directly:
// a rejection is evaluated as the tuple `(agent_id, predicate_id, observed_value,
// required_value, input_source, observation_age)`, which "is stricter than logging a
// message string, and it is what makes 'why did the fleet reject this mission'
// queryable rather than grep-able".
//
// Two properties this function cannot have, and the engine's telemetry does:
//   - the **binding-constraint distribution** per zone, mission class, and Leg purpose,
//     exact over 100 % of decisions because tuples are aggregated before sampling;
//   - **near-miss margins** as a quantile sketch, so "failing F34 by 3 %" and "failing
//     by 60 %" are distinguishable — one is a config change, the other is capital spend.
//
// Left in place and unchanged: the legacy dispatcher still calls it, and no engine
// module does.
rootLogger.dtaro = function logDtaro({ candidates = [], results = [], rejected = [], winner } = {}) {
  if (isProd) {
    pinoBase.info({ winner: winner?.robotId, candidateCount: candidates.length }, "DTARO allocation");
    return;
  }

  const lines = [
    `${ts()} ${c.bBlue("🧠")} ${c.bold(c.bBlue("DTARO ALLOCATION"))}`,
    `  ${c.dim("Candidates :")} ${candidates.length}   ${c.dim("Eligible :")} ${results.length}   ${c.dim("Rejected :")} ${rejected.length}`,
  ];

  for (const r of results) {
    const comp = r.components || {};
    const bar  = "█".repeat(Math.round((1 - r.cost) * 10)).padEnd(10, "░");
    lines.push(
      `  ${c.bGreen("├")} ${c.bWhite(pad(r.robotId, 12))}` +
      `  cost=${c.bCyan(r.cost.toFixed(3))}` +
      `  ${c.dim(`D=${(comp.D||0).toFixed(2)} B=${(comp.B||0).toFixed(2)} U=${(comp.U||0).toFixed(2)} T=${(comp.T||0).toFixed(2)} Z=${(comp.Z||0).toFixed(2)}`)}` +
      `  ${c.dim(bar)}`
    );
  }

  for (const { robotId, reason } of rejected) {
    lines.push(`  ${c.bRed("├")} ${c.dim(pad(robotId, 12))}  ${c.red("✗")} ${c.dim(reason)}`);
  }

  if (winner) {
    lines.push(`  ${c.bGreen("└")} ${c.bold("Selected:")} ${c.bGreen(winner.robotId)}  cost=${c.bCyan(winner.cost?.toFixed(3) || "?")}`);
  } else {
    lines.push(`  ${c.bRed("└")} ${c.red("No eligible robot found")}`);
  }

  process.stdout.write(lines.join("\n") + "\n");
};

// ─── PHASE 11 — §21.7 tracing, structured logging, and log-volume discipline ──
//
// §21.7 states three rules, and the third is the one that has to be enforced by code
// rather than by review:
//
//   - **One trace per Task**, spanning intake → queue → round → commit → dispatch →
//     execution → settlement. `TRACE_FIELDS` is the correlation set that makes that
//     one trace assemblable from lines emitted by six different subsystems.
//   - **Structured logs only**, "with decision id, commitment id, mission id, agent id,
//     and shard id as mandatory fields. Free-text messages are for humans reading a
//     specific incident, never the primary carrier of information."
//   - **Log volume discipline.** *"Per-candidate detail belongs in the decision record,
//     not in the log stream; emitting full candidate sets to logs at fleet scale is a
//     self-inflicted outage. Logs carry the round summary and anomalies."*
//
// `logger.round()` and `logger.anomaly()` are the engine's only log entry points, and
// both **refuse** a payload carrying per-candidate detail. The refusal is loud in
// development and test — where the mistake is made — and a silent drop of the offending
// field in production, where throwing inside a logger would turn a logging defect into
// an outage. That asymmetry is deliberate: the rule exists to prevent an outage, so
// enforcing it must not cause one.

/**
 * The correlation fields §21.7 makes mandatory on every structured engine log line.
 */
const TRACE_FIELDS = ["traceId", "decisionId", "commitmentId", "missionId", "agentId", "shardId"];

/**
 * Field names that carry per-candidate detail. A payload containing any of these, with
 * an array value, belongs in the decision record (Tier B, §21.2) and not in the log
 * stream.
 */
const PER_CANDIDATE_FIELDS = new Set([
  "candidates",
  "candidateSet",
  "rejected",
  "rejections",
  "predicates",
  "predicateResults",
  "costs",
  "columns",
  "columnDetail",
  "feasibility",
]);

/**
 * Strip per-candidate detail from a log payload, returning what was removed.
 *
 * Arrays only: a scalar `candidates: 47` is a *count*, which is exactly the round
 * summary §21.7 says logs should carry, and removing it would be enforcing the opposite
 * of the rule.
 */
function withoutPerCandidateDetail(meta) {
  if (!meta || typeof meta !== "object") return { kept: meta, removed: [] };
  const kept = {};
  const removed = [];
  for (const [key, value] of Object.entries(meta)) {
    if (PER_CANDIDATE_FIELDS.has(key) && Array.isArray(value)) {
      removed.push({ field: key, length: value.length });
      // The count survives; the rows do not. An operator still sees that 200 candidates
      // were evaluated, and the 200 rows are in Tier B where they can be queried.
      kept[`${key}Count`] = value.length;
      continue;
    }
    kept[key] = value;
  }
  return { kept, removed };
}

class LogVolumeDisciplineError extends Error {
  constructor(removed) {
    super(
      `per-candidate detail (${removed.map((row) => `${row.field}[${row.length}]`).join(", ")}) was passed to the ` +
        "log stream. §21.7: per-candidate detail belongs in the decision record, not in the log stream — " +
        "emitting full candidate sets to logs at fleet scale is a self-inflicted outage. Write it to Tier B " +
        "(src/engine/observability/tierB.js) instead.",
    );
    this.name = "LogVolumeDisciplineError";
    this.removed = removed;
  }
}

function emitStructured(level, kind, meta) {
  const { kept, removed } = withoutPerCandidateDetail(meta);

  if (removed.length > 0 && !isProd) throw new LogVolumeDisciplineError(removed);

  const line = { kind, ...kept };
  if (removed.length > 0) line.perCandidateDetailOmitted = removed;

  if (isProd) {
    pinoLog(level, "engine", kind, line);
    return line;
  }

  printLine(level, "engine", kind, sanitise(line));
  return line;
}

/**
 * The round summary — one line per round, never one per candidate.
 */
rootLogger.round = function logRound(summary = {}) {
  return emitStructured("info", "round", summary);
};

/**
 * An anomaly. §21.7: "Logs carry the round summary and anomalies."
 */
rootLogger.anomaly = function logAnomaly(kind, meta = {}) {
  return emitStructured("warn", `anomaly.${kind}`, meta);
};

/**
 * Which mandatory correlation fields a payload is missing (§21.7). Returned rather than
 * thrown: a line missing `agentId` because the event has no agent is correct, and only
 * the caller knows which of the six apply to it.
 */
rootLogger.missingTraceFields = function missingTraceFields(meta = {}) {
  return TRACE_FIELDS.filter((field) => meta[field] === undefined || meta[field] === null);
};

rootLogger.TRACE_FIELDS = TRACE_FIELDS;
rootLogger.PER_CANDIDATE_FIELDS = PER_CANDIDATE_FIELDS;
rootLogger.LogVolumeDisciplineError = LogVolumeDisciplineError;
rootLogger.withoutPerCandidateDetail = withoutPerCandidateDetail;

// ─── Simulation tick ─────────────────────────────────────────────────────────

// Throttle: don't print same-status robot more than once per 10 s in dev.
const _simThrottle = new Map();

rootLogger.simulation = function logSimulation({ robotId, battery, status, phase, lat, lon } = {}) {
  if (isProd) return; // too chatty for prod JSON

  const key = `${robotId}:${status}:${phase}`;
  const now = Date.now();
  const last = _simThrottle.get(key) || 0;
  if (now - last < 10_000) return;
  _simThrottle.set(key, now);

  const batColor = battery < 20 ? c.bRed : battery < 50 ? c.bYellow : c.bGreen;
  const bat = battery !== undefined ? batColor(`${battery.toFixed(1)}%`) : "";
  const pos = (lat !== undefined && lon !== undefined)
    ? c.dim(` @ ${lat.toFixed(4)},${lon.toFixed(4)}`)
    : "";
  const ph  = phase ? c.dim(`[${phase}]`) : "";

  process.stdout.write(
    `${ts()} ${c.bYellow("🔋")} SIM     ${c.bCyan(pad(robotId, 12))}  ${c.dim(pad(status || "?", 10))}  ${bat}${pos}  ${ph}\n`
  );
};

// ─── Obstacle / alert ─────────────────────────────────────────────────────────

rootLogger.obstacle = function logObstacle({ reportingRobotId, lat, lon, severity, zoneId, affectedRobots = [] } = {}) {
  if (isProd) {
    pinoBase.warn({ reportingRobotId, lat, lon, severity, zoneId, affectedCount: affectedRobots.length }, "Obstacle detected");
    return;
  }

  const sevColor = severity === "CRITICAL" || severity === "HIGH" ? c.bRed
    : severity === "MEDIUM" ? c.bYellow : c.bCyan;

  const lines = [
    `${ts()} ${c.bRed("⚠")} ${c.bold(c.bRed("OBSTACLE DETECTED"))}`,
    `  ${c.dim("Reporter  :")} ${c.bCyan(reportingRobotId || "?")}`,
    `  ${c.dim("Location  :")} ${lat?.toFixed(5)}, ${lon?.toFixed(5)}`,
    `  ${c.dim("Severity  :")} ${sevColor(severity || "MEDIUM")}`,
    `  ${c.dim("Zone      :")} ${zoneId || "—"}`,
  ];
  if (affectedRobots.length) {
    lines.push(`  ${c.dim("Affected  :")} ${affectedRobots.map(c.bYellow).join(", ")}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
};

// ─── Startup banner ───────────────────────────────────────────────────────────

rootLogger.startup = function logStartup({ env, port, db, redis, simulator } = {}) {
  if (isProd) {
    pinoBase.info({ env, port, db, redis }, "Server started");
    return;
  }

  const tick  = c.bGreen("✓");
  const cross = c.bRed("✗");
  const ok    = (v) => (v ? tick : cross);

  const W = 52;
  const line = "─".repeat(W);
  const row = (label, value) => {
    const lbl = c.dim(label.padEnd(12));
    return `│  ${lbl}  ${value}`;
  };

  const banner = [
    `┌${line}┐`,
    `│  ${c.bold(c.bCyan("🚀  RobotX Backend"))}${" ".repeat(W - 20)}│`,
    `├${line}┤`,
    row("Environment", env === "production" ? c.bRed("production") : c.bGreen(env || "development")),
    row("Port",        c.bWhite(String(port))),
    row("Database",    `${ok(db)}  ${db ? c.bGreen("PostgreSQL connected") : c.bRed("FAILED")}`),
    row("Redis",       `${ok(redis)}  ${redis ? c.bGreen("connected") : c.bYellow("in-memory fallback")}`),
    row("Simulator",   `${tick}  ${c.bGreen(simulator || "Ready")}`),
    `└${line}┘`,
  ].join("\n");

  process.stdout.write("\n" + banner + "\n\n");
};

// ─── Export ───────────────────────────────────────────────────────────────────

module.exports = rootLogger;

/**
 * LOCAL environment guard (docs/runbooks/environments.md).
 *
 * A process that declares `ROBOTX_ENV=LOCAL` may only reach loopback services: its database
 * and its Redis (KV and Socket.IO adapter) must be on this machine. Anything else is refused
 * before Prisma or Redis is ever contacted, so a stray process-level `DATABASE_URL`, a copied
 * worktree `.env`, or a hosted `REDIS_URL` cannot connect local development to the cloud.
 *
 * Without `ROBOTX_ENV` the guard does nothing: a deployment (Render) and the test suite do not
 * set it, and keep their existing behaviour. No other value is defined; an unknown one is
 * refused rather than guessed at — and so is an EMPTY one. dotenv never overrides a variable
 * already present in the process, so a process-level `ROBOTX_ENV=` (set but empty) would
 * otherwise switch the guard off while the LOCAL file still loaded its database.
 *
 * Messages name the variable and the kind of host only — never a URL, user or password.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function hostOf(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function describeHost(host) {
  return /\.neon\.tech$/.test(host) ? "a Neon host" : "a non-loopback host";
}

/**
 * @param {object} env the process environment (after the configuration file has loaded)
 * @returns {{ active: boolean, problems: string[], summary: string|null }}
 */
function checkEnvironment(env = process.env) {
  // Absent is the only "not LOCAL". Present-but-empty is a refusal, not an absence.
  if (env.ROBOTX_ENV === undefined) return { active: false, problems: [], summary: null };
  const mode = typeof env.ROBOTX_ENV === "string" ? env.ROBOTX_ENV.trim() : "";
  if (!mode) {
    return { active: true, problems: ["ROBOTX_ENV is set but empty; unset it, or set it to LOCAL"], summary: null };
  }

  if (mode.toUpperCase() !== "LOCAL") {
    return { active: true, problems: [`ROBOTX_ENV must be LOCAL or unset (got an unknown value)`], summary: null };
  }

  const problems = [];
  let summary = null;

  const databaseUrl = typeof env.DATABASE_URL === "string" ? env.DATABASE_URL.trim() : "";
  if (!databaseUrl) {
    problems.push("DATABASE_URL is not set; LOCAL never falls back to another database");
  } else {
    const host = hostOf(databaseUrl);
    if (!host) {
      problems.push("DATABASE_URL is not a valid URL");
    } else if (!LOOPBACK_HOSTS.has(host)) {
      problems.push(`DATABASE_URL points at ${describeHost(host)}; LOCAL accepts a loopback database only`);
    } else {
      const u = new URL(databaseUrl);
      summary = `database ${host}:${u.port || "5432"}${u.pathname}`;
    }
  }

  // Checked whether or not REDIS_ENABLED is false: a hosted REDIS_URL has no place in LOCAL, and
  // the same variable feeds both the KV and the Socket.IO adapter.
  const redisUrl = typeof env.REDIS_URL === "string" ? env.REDIS_URL.trim() : "";
  if (redisUrl) {
    const host = hostOf(redisUrl);
    if (!host) problems.push("REDIS_URL is not a valid URL");
    else if (!LOOPBACK_HOSTS.has(host)) problems.push(`REDIS_URL points at ${describeHost(host)}; LOCAL accepts a loopback Redis only`);
  }
  const redisOn = String(env.REDIS_ENABLED || "").toLowerCase() !== "false" && redisUrl !== "";
  if (summary) summary += redisOn ? ", Redis loopback" : ", Redis off";

  return { active: true, problems, summary };
}

/**
 * Exits the process (code 78, configuration error) when the LOCAL rules are broken.
 * @param {object} [env]
 * @param {{ loadedFrom?: string|null, log?: Function, error?: Function, exit?: Function }} [io]
 */
function assertEnvironment(env = process.env, io = {}) {
  const log = io.log || ((m) => console.log(m));
  const error = io.error || ((m) => console.error(m));
  const exit = io.exit || ((code) => process.exit(code));
  const result = checkEnvironment(env);
  if (!result.active) return result;
  if (result.problems.length > 0) {
    error("[env] REFUSED to start the LOCAL environment:");
    for (const p of result.problems) error(`[env]   - ${p}`);
    error("[env] Fix the LOCAL configuration file or remove the overriding process variable (docs/runbooks/environments.md).");
    exit(78);
    return result;
  }
  log(`[env] LOCAL: ${result.summary}${io.loadedFrom ? `; configuration from ${io.loadedFrom}` : ""}`);
  return result;
}

/**
 * For scripts that WRITE to a database: unlike `assertEnvironment`, an absent ROBOTX_ENV is a
 * refusal, not a pass — a write is allowed only in an explicitly declared LOCAL environment whose
 * checks pass. Returns the validated target (host, port, database — never a credential).
 * @param {object} [env]
 * @param {{ error?: Function, exit?: Function }} [io]
 * @returns {{ host: string, port: string, database: string }|null}
 */
function requireLocalTarget(env = process.env, io = {}) {
  const error = io.error || ((m) => console.error(m));
  const exit = io.exit || ((code) => process.exit(code));
  const result = checkEnvironment(env);
  const problems = result.active ? result.problems : ["ROBOTX_ENV is not LOCAL; this script writes to a database and runs only in the LOCAL environment"];
  if (problems.length > 0) {
    error("[env] REFUSED: this script writes to a database.");
    for (const p of problems) error(`[env]   - ${p}`);
    exit(78);
    return null;
  }
  const u = new URL(env.DATABASE_URL.trim());
  return { host: u.hostname.toLowerCase(), port: u.port || "5432", database: decodeURIComponent(u.pathname.replace(/^\//, "")) };
}

/** host:port/database with every loopback spelling folded together, or null. */
function databaseIdentity(value) {
  try {
    const u = new URL(String(value).trim());
    const host = u.hostname.toLowerCase();
    return {
      loopback: LOOPBACK_HOSTS.has(host),
      key: `${LOOPBACK_HOSTS.has(host) ? "loopback" : host}:${u.port || "5432"}/${decodeURIComponent(u.pathname.replace(/^\//, ""))}`,
      database: decodeURIComponent(u.pathname.replace(/^\//, "")),
    };
  } catch {
    return null;
  }
}

/**
 * The canonical LOCAL database, read from the LOCAL file without loading it into the process.
 * @returns {string[]} zero or one URL
 */
function canonicalLocalDatabaseUrls() {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { LOCAL_ENV_FILE } = require("./envFile");
  const file = path.join(os.homedir(), LOCAL_ENV_FILE);
  if (!fs.existsSync(file)) return [];
  const url = require("dotenv").parse(fs.readFileSync(file)).DATABASE_URL;
  return url ? [url] : [];
}

/**
 * For tools that DESTROY or overwrite data in a database of their own — the benchmark's
 * `TRUNCATE … CASCADE` (benchmark/dbReset.js). Unlike `requireLocalTarget`, which admits the
 * canonical LOCAL database because LOCAL scripts legitimately write there, this admits only a
 * disposable one: loopback, and never the database the LOCAL file names. A deployment database
 * is non-loopback and so refused as well. Returns the target (never a credential).
 * @param {object} [env]
 * @param {{ canonicalUrls?: string[], error?: Function, exit?: Function }} [io]
 * @returns {{ database: string }|null}
 */
function requireDisposableTarget(env = process.env, io = {}) {
  const error = io.error || ((m) => console.error(m));
  const exit = io.exit || ((code) => process.exit(code));
  const canonical = (io.canonicalUrls || canonicalLocalDatabaseUrls()).map(databaseIdentity).filter(Boolean);

  const problems = [];
  const raw = typeof env.DATABASE_URL === "string" ? env.DATABASE_URL.trim() : "";
  const target = raw ? databaseIdentity(raw) : null;
  if (!raw) problems.push("DATABASE_URL is not set");
  else if (!target) problems.push("DATABASE_URL is not a valid URL");
  else if (!target.loopback) problems.push(`DATABASE_URL points at ${describeHost(new URL(raw).hostname.toLowerCase())}; this tool runs only against a disposable loopback database`);
  else if (canonical.some((c) => c.key === target.key)) problems.push("DATABASE_URL is the canonical LOCAL database; this tool destroys data and runs only against a disposable one");

  if (problems.length > 0) {
    error("[env] REFUSED: this tool destroys data in its target database.");
    for (const p of problems) error(`[env]   - ${p}`);
    exit(78);
    return null;
  }
  return { database: target.database };
}

module.exports = { checkEnvironment, assertEnvironment, requireLocalTarget, requireDisposableTarget, LOOPBACK_HOSTS };

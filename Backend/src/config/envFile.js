const fs = require("fs");
const os = require("os");
const path = require("path");

// Which file supplies this process's configuration (docs/runbooks/environments.md). Pure: it
// names the file and loads nothing — `src/config/env.js` loads it; tools that need only a few
// values from it (tools/verify/b1/httpEndToEnd.js) parse it without loading the rest.
//
//   1. ROBOTX_ENV_FILE — an explicit path. A missing file is an error, never a silent fallback.
//   2. Backend/.env — the historical location; older worktrees still use it.
//   3. ~/robotx-secrets/robotx-local.env — the LOCAL environment's file, kept outside the
//      repository and OneDrive because it holds local secrets.
//
// A test process (NODE_ENV=test, which Jest sets itself) never falls back to 2 or 3: those
// files name the canonical LOCAL database. It loads only an explicit ROBOTX_ENV_FILE —
// tests/setup/env.js names an empty one — or nothing.
const BACKEND_ENV_FILE = path.join(__dirname, "..", "..", ".env");
const LOCAL_ENV_FILE = path.join("robotx-secrets", "robotx-local.env");

function resolveEnvFile({ env = process.env, exists = fs.existsSync, homedir = os.homedir() } = {}) {
  const explicit = typeof env.ROBOTX_ENV_FILE === "string" ? env.ROBOTX_ENV_FILE.trim() : "";
  if (explicit) {
    if (!exists(explicit)) {
      throw new Error(`ROBOTX_ENV_FILE names a file that does not exist: ${explicit}`);
    }
    return explicit;
  }
  if (env.NODE_ENV === "test") return null;
  if (exists(BACKEND_ENV_FILE)) return BACKEND_ENV_FILE;
  const local = path.join(homedir, LOCAL_ENV_FILE);
  if (exists(local)) return local;
  return null;
}

module.exports = { resolveEnvFile, BACKEND_ENV_FILE, LOCAL_ENV_FILE };

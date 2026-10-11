const dotenv = require("dotenv");
const { resolveEnvFile, BACKEND_ENV_FILE, LOCAL_ENV_FILE } = require("./envFile");

// Loads this process's configuration file (see ./envFile.js for which one). dotenv never
// overrides a variable already set in the process environment — so a deployment (Render),
// which sets everything in its dashboard and has none of these files, is unaffected.
const loadedFrom = resolveEnvFile();
if (loadedFrom) dotenv.config({ path: loadedFrom });

// Side-effect module: requiring it loads the configuration. `loadedFrom` is a path, never a value.
module.exports = { loadedFrom, resolveEnvFile, BACKEND_ENV_FILE, LOCAL_ENV_FILE };

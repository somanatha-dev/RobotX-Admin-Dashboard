// The two values that keep an automated test away from every real database
// (docs/runbooks/environments.md). Named in one place so `env.js` applies them and
// `tests/unit/config/testIsolation.test.js` asserts them without restating either.
const path = require("path");

// An empty, tracked configuration file. Naming it in ROBOTX_ENV_FILE means
// `src/config/envFile.js` never falls back to Backend/.env or the LOCAL secrets file.
const ISOLATED_ENV_FILE = path.join(__dirname, "..", "fixtures", "environment", "isolated-test.dotenv");

// Loopback port 1 is never a PostgreSQL server: a client that was not mocked fails at
// once with a connection refusal instead of reaching the canonical `robotx` database.
// connect_timeout is set so `src/db/prisma.js` does not append its 30 s default.
const UNREACHABLE_DATABASE_URL = "postgresql://robotx-test-isolation@127.0.0.1:1/robotx_test_unreachable?connect_timeout=2";

module.exports = { ISOLATED_ENV_FILE, UNREACHABLE_DATABASE_URL };

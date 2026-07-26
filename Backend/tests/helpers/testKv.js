const { initKv } = require("../../src/cache/kv");

// Real `kv` facade running in its in-memory fallback mode (no REDIS_URL is
// set anywhere in the test environment — see tests/setup/env.js). This
// exercises the actual TTL/reservation/mget logic instead of a hand-rolled
// stand-in, while remaining fully deterministic and offline.
async function createTestKv() {
  const silentLogger = { info() {}, warn() {}, error() {} };
  const { kv, close } = await initKv({ logger: silentLogger });
  return { kv, close };
}

module.exports = { createTestKv };

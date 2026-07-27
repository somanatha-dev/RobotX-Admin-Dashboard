"use strict";

// Runs the existing tier orchestrator once per Prisma pool size, so the
// only variable between runs is connection_limit on DATABASE_URL (see
// BENCH_POOL_SIZE handling in orchestrator.js). Each pool size gets its own
// results/pool-<n>/ directory via BENCH_STAGE, using the same tier-*.json
// shape the baseline/optimized runs already produce.
//
// Usage: node benchmark/poolSweep.js [poolSizes] [tiers]
//   node benchmark/poolSweep.js 20,40,60,80,100 500,1000

const path = require("path");
const { spawnSync } = require("child_process");

const POOL_SIZES = (process.argv[2] || "20,40,60,80,100").split(",").map(Number);
const TIERS = process.argv[3] || "500,1000";
const BACKEND_DIR = path.join(__dirname, "..");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

for (const poolSize of POOL_SIZES) {
  const stage = `pool-${poolSize}`;
  log(`=== POOL SIZE ${poolSize} (stage=${stage}, tiers=${TIERS}) ===`);
  const res = spawnSync(process.execPath, [path.join(__dirname, "orchestrator.js"), TIERS], {
    cwd: BACKEND_DIR,
    env: { ...process.env, BENCH_STAGE: stage, BENCH_POOL_SIZE: String(poolSize) },
    stdio: "inherit",
  });
  if (res.status !== 0) {
    log(`POOL SIZE ${poolSize} exited with code ${res.status} — continuing with remaining sizes`);
  }
}

log("Pool sweep complete.");

"use strict";

// Compares direct-Postgres pool runs against PgBouncer (transaction-pooling)
// runs for the same tiers. Run after poolSweep.js (stage pool-100) and the
// pgbouncer-100 / pgbouncer-200 orchestrator runs:
//   node benchmark/pgbouncerReport.js

const fs = require("fs");
const path = require("path");

const RESULTS_DIR = path.join(__dirname, "results");
const TIERS = [500, 1000];
const STAGES = ["pool-100", "pgbouncer-100", "pgbouncer-200"];

function loadStage(stage, tier) {
  const p = path.join(RESULTS_DIR, stage, `tier-${tier}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const rows = [];
for (const tier of TIERS) {
  for (const stage of STAGES) {
    const r = loadStage(stage, tier);
    if (!r || r.error) continue;
    rows.push({
      tier,
      stage,
      authRatio: (r.connection.authRatio * 100).toFixed(1) + "%",
      rampUpS: (r.connection.rampUpMs / 1000).toFixed(1),
      assignP50: r.latency.assignmentEndToEndMs.p50,
      assignP95: r.latency.assignmentEndToEndMs.p95,
      assignOK: r.counts.taskAssignSucceeded,
      assignAtt: r.counts.taskAssignAttempts,
      cpuAvg: r.resources.serverProcess.cpuPercentAvg,
      poolBusyAvg: r.resources.prismaPool.connectionsBusyAvg,
      waitAvgMs: r.resources.prismaPool.queriesWaitAvgMs,
      waitMaxMs: r.resources.prismaPool.queriesWaitMaxMs,
      loopP95: r.resources.eventLoop.p95MsAvg,
    });
  }
}

const cols = [
  ["tier", "tier"],
  ["stage", "stage"],
  ["authRatio", "auth%"],
  ["rampUpS", "ramp(s)"],
  ["assignP50", "assignP50"],
  ["assignP95", "assignP95"],
  ["assignOK", "assignOK"],
  ["assignAtt", "assignAtt"],
  ["cpuAvg", "cpu%"],
  ["poolBusyAvg", "poolBusy"],
  ["waitAvgMs", "waitAvgMs"],
  ["waitMaxMs", "waitMaxMs"],
  ["loopP95", "loopP95"],
];

const widths = cols.map(([key, label]) =>
  Math.max(label.length, ...rows.map((r) => String(r[key] ?? "-").length))
);

function fmtRow(vals) {
  return vals.map((v, i) => String(v).padStart(widths[i])).join("  ");
}

console.log(fmtRow(cols.map(([, label]) => label)));
console.log(widths.map((w) => "-".repeat(w)).join("  "));
for (const row of rows) {
  console.log(fmtRow(cols.map(([key]) => row[key] ?? "-")));
}

fs.writeFileSync(path.join(RESULTS_DIR, "pgbouncer-comparison.json"), JSON.stringify(rows, null, 2));
console.log(`\nWritten to ${path.join(RESULTS_DIR, "pgbouncer-comparison.json")}`);

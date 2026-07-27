"use strict";

// Collects benchmark/results/pool-*/tier-*.json (written by poolSweep.js)
// into one comparison table across pool sizes, per tier. Run after
// poolSweep.js finishes: node benchmark/poolSweepReport.js [tiers]

const fs = require("fs");
const path = require("path");

const RESULTS_DIR = path.join(__dirname, "results");
const TIERS = (process.argv[2] || "500,1000").split(",").map(Number);

function loadStage(stage, tier) {
  const p = path.join(RESULTS_DIR, stage, `tier-${tier}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const stages = fs
  .readdirSync(RESULTS_DIR)
  .filter((d) => /^pool-\d+$/.test(d))
  .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));

if (stages.length === 0) {
  console.error(`No pool-* result directories found under ${RESULTS_DIR}`);
  process.exit(1);
}

const rows = [];
for (const tier of TIERS) {
  for (const stage of stages) {
    const r = loadStage(stage, tier);
    if (!r || r.error) continue;
    rows.push({
      tier,
      poolSize: r.poolSize,
      authRatio: (r.connection.authRatio * 100).toFixed(1) + "%",
      rampUpS: (r.connection.rampUpMs / 1000).toFixed(1),
      assignP50: r.latency.assignmentEndToEndMs.p50,
      assignP95: r.latency.assignmentEndToEndMs.p95,
      assignAttempted: r.counts.taskAssignAttempts,
      assignSucceeded: r.counts.taskAssignSucceeded,
      cpuAvg: r.resources.serverProcess.cpuPercentAvg,
      poolBusyAvg: r.resources.prismaPool.connectionsBusyAvg,
      poolWaitAvgMs: r.resources.prismaPool.queriesWaitAvgMs,
      poolWaitMaxMs: r.resources.prismaPool.queriesWaitMaxMs,
      eventLoopP95: r.resources.eventLoop.p95MsAvg,
    });
  }
}

const cols = [
  ["tier", "tier"],
  ["poolSize", "pool"],
  ["authRatio", "auth%"],
  ["rampUpS", "ramp(s)"],
  ["assignP50", "assignP50"],
  ["assignP95", "assignP95"],
  ["assignSucceeded", "assignOK"],
  ["assignAttempted", "assignAtt"],
  ["cpuAvg", "cpu%"],
  ["poolBusyAvg", "poolBusy"],
  ["poolWaitAvgMs", "waitAvgMs"],
  ["poolWaitMaxMs", "waitMaxMs"],
  ["eventLoopP95", "loopP95"],
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

fs.writeFileSync(path.join(RESULTS_DIR, "pool-sweep-summary.json"), JSON.stringify(rows, null, 2));
console.log(`\nWritten to ${path.join(RESULTS_DIR, "pool-sweep-summary.json")}`);

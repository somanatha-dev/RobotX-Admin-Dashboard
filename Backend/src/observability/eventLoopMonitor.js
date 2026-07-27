"use strict";

// Lightweight always-on event-loop lag tracker. Cheap (perf_hooks native
// histogram, no per-tick app code involved) — safe to run permanently, not
// just during benchmarking, so it stays useful for diagnosing production
// slowdowns after this file ships.
const { monitorEventLoopDelay } = require("perf_hooks");

let histogram = null;

function start() {
  if (histogram) return histogram;
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  return histogram;
}

function snapshot() {
  if (!histogram) return null;
  const toMs = (ns) => Math.round((ns / 1e6) * 100) / 100;
  return {
    minMs: toMs(histogram.min),
    meanMs: toMs(histogram.mean),
    p50Ms: toMs(histogram.percentile(50)),
    p95Ms: toMs(histogram.percentile(95)),
    p99Ms: toMs(histogram.percentile(99)),
    maxMs: toMs(histogram.max),
  };
}

module.exports = { start, snapshot };

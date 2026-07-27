"use strict";

const pidusage = require("pidusage");

async function sampleProcess(pid) {
  try {
    const stats = await pidusage(pid);
    return { cpuPercent: stats.cpu, memoryBytes: stats.memory };
  } catch (e) {
    if (process.env.BENCH_DEBUG_SAMPLE) console.error(`sampleProcess(${pid}) failed: ${e?.message}`);
    return null;
  }
}

function parseInfo(text) {
  const map = {};
  for (const line of text.split("\r\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) map[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return map;
}

async function sampleRedis(redis) {
  try {
    const info = await redis.info("stats");
    const map = parseInfo(info);
    return {
      totalCommandsProcessed: Number(map.total_commands_processed || 0),
      instantaneousOpsPerSec: Number(map.instantaneous_ops_per_sec || 0),
    };
  } catch {
    return null;
  }
}

async function sampleHealth(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/health`);
    if (!res.ok) return null;
    const body = await res.json();
    return { eventLoopDelay: body.eventLoopDelay || null, prismaPool: body.prismaPool || null };
  } catch {
    return null;
  }
}

async function samplePostgres(prisma) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT xact_commit, tup_inserted, tup_updated, tup_deleted, numbackends
       FROM pg_stat_database WHERE datname = current_database()`
    );
    const r = rows[0];
    return {
      xactCommit: Number(r.xact_commit),
      tupInserted: Number(r.tup_inserted),
      tupUpdated: Number(r.tup_updated),
      tupDeleted: Number(r.tup_deleted),
      numBackends: Number(r.numbackends),
    };
  } catch {
    return null;
  }
}

function percentile(arr, p) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summarize(arr) {
  if (!arr || arr.length === 0) return { count: 0, avg: null, p50: null, p95: null, max: null };
  const sum = arr.reduce((a, b) => a + b, 0);
  return {
    count: arr.length,
    avg: Math.round((sum / arr.length) * 100) / 100,
    p50: percentile(arr, 50),
    p95: percentile(arr, 95),
    max: Math.max(...arr),
  };
}

module.exports = { sampleProcess, sampleRedis, samplePostgres, sampleHealth, percentile, summarize };

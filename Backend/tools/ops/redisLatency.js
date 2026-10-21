#!/usr/bin/env node
"use strict";

/**
 * Redis round-trip latency, measured from wherever this runs — run it in the backend's own
 * runtime (a Render shell, or a one-off job with the service's environment) to measure what the
 * telemetry path would actually pay. READ-ONLY by default.
 *
 *   node tools/ops/redisLatency.js [--url <redis-url>] [--samples 200] [--write] [--json]
 *
 * The URL comes from `--url` or `REDIS_URL`; `REDIS_ENABLED` is not consulted, so a service can be
 * measured before the backend is pointed at it. Credentials in the URL are never printed.
 *
 * What it measures, each as median / p95 / p99 / max over `--samples` runs:
 *   · tcp        — a bare TCP connect to the host and port (no Redis protocol)
 *   · tls        — the TLS handshake, for a `rediss://` URL (protocol, cipher, certificate verdict)
 *   · ready      — a fresh client to `ready`, with the KV facade's own connection options
 *   · ping       — PING on one connection
 *   · get        — GET of a key that does not exist
 *   · readBatch  — one pipeline of 6 GETs on keys that do not exist: the telemetry read pipeline
 *   · frame      — (only with --write) the telemetry write path's round trips in sequence: the
 *                  6-GET read pipeline, a 5-SET write pipeline, then two single SETs (stop latch,
 *                  readiness) — what one physical-unit frame costs in Redis time
 *
 * It also reads INFO (server, memory, stats, clients, keyspace) for the version, `maxmemory`,
 * `maxmemory_policy`, `evicted_keys` and key counts — read-only, and reported as unavailable where
 * a managed service restricts it.
 *
 * Writes: none, unless `--write`. With `--write` it writes only keys under
 * `robotx:diag:latency:<pid>:<time>:` with a 60 s expiry, and deletes them before it exits.
 */

const net = require("net");
const tls = require("tls");
const path = require("path");

const Redis = require(path.join(__dirname, "..", "..", "node_modules", "ioredis"));

function parseArgs(argv) {
  const out = { url: process.env.REDIS_URL || "", samples: 200, write: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") out.url = argv[++i] || "";
    else if (arg === "--samples") out.samples = Math.max(10, Number(argv[++i]) || 200);
    else if (arg === "--write") out.write = true;
    else if (arg === "--json") out.json = true;
  }
  return out;
}

/** The URL with any username or password removed — the only form of it that is ever printed. */
function describeTarget(url) {
  const u = new URL(url);
  return {
    scheme: u.protocol.replace(":", ""),
    host: u.hostname,
    port: Number(u.port || 6379),
    db: u.pathname && u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    tls: u.protocol === "rediss:",
    auth: u.password ? "password present" : u.username ? "username only" : "none",
  };
}

function summarise(values) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  const round = (v) => Math.round(v * 1000) / 1000;
  return { n: sorted.length, p50: round(rank(0.5)), p95: round(rank(0.95)), p99: round(rank(0.99)), max: round(sorted[sorted.length - 1]) };
}

const nowMs = () => Number(process.hrtime.bigint()) / 1e6;

async function timed(fn) {
  const t0 = nowMs();
  await fn();
  return nowMs() - t0;
}

function tcpConnect(target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: target.host, port: target.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("tcp connect timed out"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function tlsHandshake(target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: target.host, port: target.port, servername: target.host });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("tls handshake timed out"));
    }, timeoutMs);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const detail = { protocol: socket.getProtocol(), cipher: socket.getCipher()?.name || null, authorized: socket.authorized, authorizationError: socket.authorizationError ? String(socket.authorizationError) : null };
      socket.destroy();
      resolve(detail);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** The KV facade's connection options (src/cache/kv.js), so `ready` is what the backend pays. */
function facadeClient(url, connectTimeoutMs) {
  return new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    connectTimeout: connectTimeoutMs,
  });
}

function infoFields(text, names) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx);
    if (names.includes(key) || /^db\d+$/.test(key)) out[key] = line.slice(idx + 1);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    console.error("No Redis URL: pass --url or set REDIS_URL. Nothing was measured.");
    process.exit(2);
  }
  const target = describeTarget(args.url);
  const connectTimeoutMs = Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 5000);
  const report = { measuredAt: new Date().toISOString(), runtime: { node: process.version, platform: process.platform, hostname: require("os").hostname() }, target, samples: args.samples, write: args.write };

  // Connection setup: fewer samples, each opens and closes a connection.
  const setupSamples = Math.min(30, args.samples);
  const tcp = [];
  const tlsTimes = [];
  const ready = [];
  for (let i = 0; i < setupSamples; i += 1) {
    tcp.push(await timed(() => tcpConnect(target, connectTimeoutMs)));
    if (target.tls) {
      let detail;
      tlsTimes.push(await timed(async () => (detail = await tlsHandshake(target, connectTimeoutMs))));
      report.tlsDetail = detail;
    }
    const client = facadeClient(args.url, connectTimeoutMs);
    client.on("error", () => {});
    ready.push(await timed(() => client.connect()));
    client.disconnect();
  }
  report.tcp = summarise(tcp);
  if (target.tls) report.tls = summarise(tlsTimes);
  report.ready = summarise(ready);

  const client = facadeClient(args.url, connectTimeoutMs);
  client.on("error", () => {});
  await client.connect();

  const missing = `robotx:diag:latency:absent:${process.pid}:${Date.now()}`;
  const ping = [];
  const get = [];
  const readBatch = [];
  for (let i = 0; i < args.samples; i += 1) {
    ping.push(await timed(() => client.ping()));
    get.push(await timed(() => client.get(missing)));
    readBatch.push(await timed(() => {
      const p = client.pipeline();
      for (let k = 0; k < 6; k += 1) p.get(`${missing}:${k}`);
      return p.exec();
    }));
  }
  report.ping = summarise(ping);
  report.get = summarise(get);
  report.readBatch = summarise(readBatch);

  if (args.write) {
    const prefix = `robotx:diag:latency:${process.pid}:${Date.now()}:`;
    const frame = [];
    try {
      for (let i = 0; i < args.samples; i += 1) {
        frame.push(await timed(async () => {
          const read = client.pipeline();
          for (let k = 0; k < 6; k += 1) read.get(`${prefix}r${k}`);
          await read.exec();
          const write = client.pipeline();
          for (let k = 0; k < 5; k += 1) write.set(`${prefix}w${k}`, "x".repeat(200), "EX", 60);
          await write.exec();
          await client.set(`${prefix}latch`, "x", "EX", 60);
          await client.set(`${prefix}readiness`, "x", "EX", 60);
        }));
      }
    } finally {
      const keys = [...Array.from({ length: 5 }, (_, k) => `${prefix}w${k}`), `${prefix}latch`, `${prefix}readiness`];
      report.cleanup = { deleted: await client.del(...keys) };
    }
    report.frame = summarise(frame);
  }

  for (const section of ["server", "memory", "stats", "clients", "keyspace"]) {
    try {
      const text = await client.info(section);
      Object.assign((report.info = report.info || {}), infoFields(text, ["redis_version", "maxmemory", "maxmemory_human", "maxmemory_policy", "used_memory_human", "evicted_keys", "expired_keys", "connected_clients", "tcp_port"]));
    } catch (e) {
      (report.infoUnavailable = report.infoUnavailable || []).push(`${section}: ${e.message}`);
    }
  }

  client.disconnect();

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Redis latency from ${report.runtime.hostname} (${report.runtime.platform}, node ${report.runtime.node}) at ${report.measuredAt}`);
    console.log(`Target: ${target.scheme}://${target.host}:${target.port}/${target.db}  tls=${target.tls}  auth=${target.auth}`);
    if (report.tlsDetail) console.log(`TLS: ${report.tlsDetail.protocol} ${report.tlsDetail.cipher} certificate ${report.tlsDetail.authorized ? "verified" : `NOT verified (${report.tlsDetail.authorizationError})`}`);
    const row = (name, s) => s && console.log(`  ${name.padEnd(10)} n=${String(s.n).padEnd(5)} p50=${s.p50}ms  p95=${s.p95}ms  p99=${s.p99}ms  max=${s.max}ms`);
    for (const name of ["tcp", "tls", "ready", "ping", "get", "readBatch", "frame"]) row(name, report[name]);
    if (report.info) console.log("INFO:", JSON.stringify(report.info));
    if (report.infoUnavailable) console.log("INFO unavailable:", report.infoUnavailable.join("; "));
    if (report.cleanup) console.log(`Deleted ${report.cleanup.deleted} diagnostic key(s).`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(`Redis latency check failed: ${e.code || ""} ${e.message}`);
  process.exit(1);
});

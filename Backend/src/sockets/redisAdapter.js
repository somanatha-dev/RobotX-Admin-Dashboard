"use strict";

/**
 * The Socket.IO Redis adapter, attached when Redis is configured (`kv.redisSettings`).
 *
 * The attach waits for both clients' `ready`, bounded as the KV facade bounds its own connect:
 * connect timeout plus command timeout. ioredis's `connectTimeout` covers only the TCP connect;
 * against a half-open server (it accepts the socket and answers nothing) the ready check never
 * completes and never errors, so an unbounded wait held `server.js` before `listen` for good
 * (reproduced 2026-10-21: still pending after 15 s). On timeout or error both clients are
 * disconnected — a failed attach must not leave them reconnecting for the life of the process —
 * and the caller stays on the default single-process adapter.
 */

const Redis = require("ioredis");
const { createAdapter } = require("@socket.io/redis-adapter");

/**
 * @param {object} io the Socket.IO server
 * @param {{ url: string, connectTimeoutMs: number, commandTimeoutMs: number, keepAliveMs: number }} settings
 * @param {object} logger
 * @param {{ Redis?: Function, createAdapter?: Function }} [deps] test seam
 * @returns {Promise<{ pubClient: object, subClient: object } | null>} the attached clients, or
 *   null when the adapter could not be attached
 */
async function attachRedisAdapter(io, settings, logger, deps = {}) {
  const RedisClient = deps.Redis || Redis;
  const makeAdapter = deps.createAdapter || createAdapter;
  const log = logger || console;
  let pubClient = null;
  let subClient = null;
  let deadline = null;
  try {
    // The facade's keepalive, so an idle dead socket is noticed. Not its command timeout: the
    // adapter publishes without awaiting, and a timed-out publish would be an unhandled rejection.
    pubClient = new RedisClient(settings.url, { connectTimeout: settings.connectTimeoutMs, keepAlive: settings.keepAliveMs });
    subClient = pubClient.duplicate();
    const boundMs = settings.connectTimeoutMs + settings.commandTimeoutMs;
    await Promise.race([
      Promise.all([
        new Promise((resolve, reject) => { pubClient.once("ready", resolve); pubClient.once("error", reject); }),
        new Promise((resolve, reject) => { subClient.once("ready", resolve); subClient.once("error", reject); }),
      ]),
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error(`Redis adapter not ready within ${boundMs} ms`)), boundMs);
      }),
    ]);
    clearTimeout(deadline);
    // ioredis reconnects an attached client itself (at most every 2 s). Without a standing
    // `error` listener each failed attempt during an outage is an unhandled-error line, so
    // the outage is logged once per client and the recovery once.
    for (const [role, client] of [["pub", pubClient], ["sub", subClient]]) {
      let down = false;
      client.on("error", (err) => {
        if (down) return;
        down = true;
        log.warn("Socket.IO Redis adapter connection lost — cross-process broadcasts paused until it reconnects", { role, code: err?.code });
      });
      client.on("ready", () => {
        if (!down) return;
        down = false;
        log.info("Socket.IO Redis adapter connection restored", { role });
      });
    }
    io.adapter(makeAdapter(pubClient, subClient));
    log.info("Socket.IO Redis adapter attached — broadcasts fan out across worker processes");
    return { pubClient, subClient };
  } catch (e) {
    clearTimeout(deadline);
    // A failed attach must not leave both clients reconnecting for the life of the process.
    for (const client of [pubClient, subClient]) {
      try { client?.disconnect(); } catch { /* ignore */ }
    }
    log.warn(
      "Socket.IO Redis adapter unavailable — falling back to the default single-process adapter. " +
      "If this process is one of several workers behind a load balancer, dashboard broadcasts from " +
      "other workers will NOT reach clients connected here.",
      { message: e?.message }
    );
    return null;
  }
}

module.exports = { attachRedisAdapter };

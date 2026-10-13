"use strict";

/**
 * Close the HTTP server and the Socket.IO server attached to it, for shutdown.
 *
 * `server.close()` stops new connections and waits for every open one to end. A Socket.IO
 * websocket is an upgraded connection that never ends by itself, so with one dashboard or
 * robot connected `await server.close()` waited until that client went away (measured locally:
 * about 4 minutes), and nothing after it in the shutdown ran — `io.close()`, the KV close and
 * `disconnectPrisma()`. A platform's stop grace period ends that with a kill.
 *
 * `io.close()` disconnects every socket, closes the engine and then closes the HTTP server, so
 * the order is Socket.IO first. A plain HTTP request still in flight gets `graceMs` to finish;
 * after that its connection is closed rather than allowed to hold the shutdown.
 *
 * @param {{ server: import("http").Server, io: { close: Function }, graceMs?: number }} input
 * @returns {Promise<{ forced: boolean }>} `forced` when connections had to be cut after the grace
 */
async function closeHttpAndSockets(input) {
  const { server, io } = input;
  const graceMs = Number.isFinite(input.graceMs) && input.graceMs >= 0 ? input.graceMs : DEFAULT_GRACE_MS;

  // `io.close` closes `server` too; its callback (and promise) settle once the server has.
  const closed = new Promise((resolve) => {
    try {
      Promise.resolve(io.close(() => resolve())).catch(() => resolve());
    } catch {
      resolve();
    }
  });

  let timer = null;
  const graceOver = new Promise((resolve) => {
    timer = setTimeout(() => resolve("GRACE_OVER"), graceMs);
    if (typeof timer.unref === "function") timer.unref();
  });

  const first = await Promise.race([closed.then(() => "CLOSED"), graceOver]);
  clearTimeout(timer);
  if (first === "CLOSED") return { forced: false };

  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  await closed;
  return { forced: true };
}

/** How long an in-flight HTTP request may hold the shutdown. @structural */
const DEFAULT_GRACE_MS = 5000;

module.exports = { closeHttpAndSockets, DEFAULT_GRACE_MS };

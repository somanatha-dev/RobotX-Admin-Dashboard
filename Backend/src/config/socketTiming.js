"use strict";

/**
 * **How fast a silent robot link is noticed** — the Engine.IO heartbeat, made explicit (Y4).
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * A link that dies without a FIN or an RST (Wi-Fi gone, a NAT that forgot the flow) is noticed
 * only by the Engine.IO heartbeat: the server pings every `pingInterval` and drops a client whose
 * pong has not come back within `pingTimeout`. The client — the Pi's python-engineio — takes both
 * values from this server's handshake and gives up on a link that has carried nothing for
 * `pingInterval + pingTimeout`. So that sum bounds silent-loss detection at **both** ends.
 *
 * It used to be the library's default (25 s + 20 s = 45 s), and Y4 showed what that costs: the
 * Pi pauses its mission `backend_loss_grace_s` after it notices the loss, while the commitment's
 * lease (`lease.duration` 60 s, renewed once half has run out) can expire about 28 s after the
 * loss and be reassigned. With 45 s of detection the original robot could still be driving a Leg
 * the engine had already given to another.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 * Defaults 10 000 ms and 5 000 ms: detection ≤ 15 s, and with the Pi's 10 s grace and its 0.1 s
 * control tick the robot pauses ≤ 25.1 s after a silent loss — before the earliest lease expiry.
 * Each may be set (`SOCKET_PING_INTERVAL_MS`, `SOCKET_PING_TIMEOUT_MS`) as a plain positive integer
 * of milliseconds, but never so that their sum exceeds `MAX_DETECTION_MS`: a longer heartbeat is
 * refused at boot rather than allowed to undo that bound quietly.
 */

/** @structural Y4's detection bound (`lease.duration`/2 − heartbeat − grace − tick, rounded down) */
const MAX_DETECTION_MS = 15_000;

/** @structural the deployment's defaults for the Engine.IO heartbeat */
const DEFAULTS = Object.freeze({ pingInterval: 10_000, pingTimeout: 5_000 });

/** @structural the variables that may override them */
const ENV = Object.freeze({ pingInterval: "SOCKET_PING_INTERVAL_MS", pingTimeout: "SOCKET_PING_TIMEOUT_MS" });

/** @structural a plain positive integer of milliseconds */
const PLAIN_INTEGER = /^[0-9]+$/;

/**
 * The effective heartbeat, or the problems that make it unusable.
 *
 * @param {object} [env]
 * @returns {{ timing: { pingInterval: number, pingTimeout: number }|null, problems: string[] }}
 */
function evaluate(env) {
  const source = env || process.env;
  const problems = [];
  const timing = {};
  for (const key of Object.keys(DEFAULTS)) {
    const raw = source[ENV[key]];
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      timing[key] = DEFAULTS[key];
      continue;
    }
    const text = String(raw);
    const value = PLAIN_INTEGER.test(text) ? Number(text) : NaN;
    if (!Number.isSafeInteger(value) || value <= 0) {
      problems.push(`${ENV[key]} must be a plain positive integer of milliseconds.`);
      continue;
    }
    timing[key] = value;
  }
  if (problems.length === 0 && timing.pingInterval + timing.pingTimeout > MAX_DETECTION_MS) {
    problems.push(
      `${ENV.pingInterval} + ${ENV.pingTimeout} must not exceed ${MAX_DETECTION_MS} ms: that sum is how long a ` +
        "silent robot link can go unnoticed, and the robot must pause before its lease can be reassigned (Y4).",
    );
  }
  return problems.length > 0 ? { timing: null, problems } : { timing, problems };
}

/**
 * @param {object} [env]
 * @returns {{ pingInterval: number, pingTimeout: number }} the Socket.IO server options
 * @throws {Error} listing every problem
 */
function resolve(env) {
  const { timing, problems } = evaluate(env);
  if (!timing) {
    const error = new Error(`Socket.IO heartbeat timing is not usable: ${problems.join(" ")}`);
    error.code = "SOCKET_TIMING_INVALID";
    throw error;
  }
  return Object.freeze(timing);
}

module.exports = { MAX_DETECTION_MS, DEFAULTS, ENV, evaluate, resolve };

"use strict";

/**
 * B1 measurement tooling — a TCP proxy that adds a one-way delay in each direction, so a
 * loopback PostgreSQL behaves like a remote one (RTT ≈ 2 × the delay). **Test-only.**
 * Nothing in `src/` requires it.
 *
 * Order-preserving: every chunk in one direction is delayed by the same amount, so the byte
 * stream is never reordered. The one-way delay is read from a control file every 50 ms and
 * may only rise, which lets a harness seed a world at 0 ms and then raise the latency for the
 * rounds it measures.
 *
 * Windows timer granularity rounds the delay up (a nominal 10 ms one-way measures ≈ 15.6 ms),
 * so a harness reports the **effective** RTT it calibrates with `SELECT 1`, never the nominal.
 *
 * Usage: node tools/verify/b1/latencyProxy.js <listenPort> <targetPort> <controlFile>
 */

const net = require("net");
const fs = require("fs");

const [listen, target] = process.argv.slice(2, 4).map(Number);
const controlFile = process.argv[4];
let oneWay = 0;

const poll = () => {
  try {
    const value = Number(fs.readFileSync(controlFile, "utf8").trim());
    if (Number.isFinite(value) && value >= oneWay) oneWay = value;
  } catch {
    // No control file yet: the delay stays where it is.
  }
};
poll();
setInterval(poll, 50);

function pipeDelayed(from, to) {
  from.on("data", (chunk) => {
    if (oneWay === 0) {
      if (!to.destroyed) to.write(chunk);
    } else {
      setTimeout(() => {
        if (!to.destroyed) to.write(chunk);
      }, oneWay);
    }
  });
  from.on("end", () => setTimeout(() => to.end(), oneWay));
  from.on("error", () => to.destroy());
}

net
  .createServer((client) => {
    const upstream = net.connect(target, "127.0.0.1");
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    pipeDelayed(client, upstream);
    pipeDelayed(upstream, client);
  })
  .listen(listen, "127.0.0.1", () => console.log(`proxy ${listen} -> ${target} ctl ${controlFile}`));

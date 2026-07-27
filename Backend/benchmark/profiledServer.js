"use strict";

// Runs server.js under an in-process CPU profiler and guarantees the
// .cpuprofile file gets written even though server.js's SIGTERM handler
// calls process.exit(0) directly (see src near the bottom of server.js).
//
// Node's --cpu-prof CLI flag does NOT reliably survive an explicit
// process.exit() call from inside a signal handler — Profiler.stop is async
// (an inspector round-trip) and process.exit() tears the process down before
// that resolves, so the file silently never gets written. Confirmed by repro:
// a bare `process.on('SIGTERM', () => process.exit(0))` script started with
// --cpu-prof produced no file at all when sent SIGTERM.
//
// Fix: profile in-process via the `inspector` module (no CDP/WebSocket hop
// needed — Session talks to the local isolate directly) and monkey-patch
// process.exit BEFORE requiring server.js, so whenever shutdown() calls it,
// we flush the profile to disk first and only then let the real exit happen.

const fs = require("fs");
const path = require("path");
const inspector = require("inspector");

const outFile = process.env.CPU_PROF_OUT;
if (!outFile) {
  console.error("CPU_PROF_OUT not set");
  process.exit(1);
}

const DEBUG_TRACE = outFile + ".trace.log";
function trace(msg) {
  try { fs.appendFileSync(DEBUG_TRACE, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* ignore */ }
}
trace("profiledServer.js starting");

const session = new inspector.Session();
session.connect();

session.post("Profiler.enable", (enableErr) => {
  trace(`Profiler.enable callback, err=${enableErr}`);
  if (enableErr) {
    console.error("Profiler.enable failed", enableErr);
    process.exit(1);
    return;
  }
  session.post("Profiler.start", (startErr) => {
    trace(`Profiler.start callback, err=${startErr}`);
    if (startErr) {
      console.error("Profiler.start failed", startErr);
      process.exit(1);
      return;
    }

    const realExit = process.exit.bind(process);
    let flushed = false;
    process.exit = (code) => {
      trace(`patched process.exit(${code}) called, flushed=${flushed}`);
      if (flushed) { realExit(code); return; }
      flushed = true;
      session.post("Profiler.stop", (stopErr, result) => {
        trace(`Profiler.stop callback, err=${stopErr}, hasProfile=${!!result?.profile}`);
        if (!stopErr && result?.profile) {
          try {
            fs.mkdirSync(path.dirname(outFile), { recursive: true });
            fs.writeFileSync(outFile, JSON.stringify(result.profile));
            trace(`wrote profile to ${outFile}`);
            console.log(`CPU profile written: ${outFile}`);
          } catch (e) {
            trace(`write failed: ${e?.stack || e}`);
            console.error("Failed to write cpuprofile", e);
          }
        } else if (stopErr) {
          trace(`Profiler.stop error detail: ${stopErr?.stack || JSON.stringify(stopErr)}`);
          console.error("Profiler.stop failed", stopErr);
        }
        trace(`calling realExit(${code})`);
        realExit(code);
      });
    };

    trace("requiring server.js");
    require(path.join(__dirname, "..", "server.js"));
  });
});

// child.kill("SIGTERM") on Windows is an abrupt TerminateProcess(), not a
// real signal delivery — server.js's SIGTERM handler never runs, so the
// orchestrator instead sends an IPC "shutdown" message (see stdio "ipc" in
// startServer()) and we turn that into a synthetic in-process SIGTERM emit,
// which server.js's own process.on("SIGTERM", ...) handler responds to
// exactly as if a real signal had arrived, letting shutdown() → process.exit()
// run inside the live event loop where our patched exit above can flush.
process.on("message", (msg) => {
  trace(`IPC message received: ${JSON.stringify(msg)}`);
  if (msg?.type === "shutdown") process.emit("SIGTERM");
});
process.on("SIGTERM", () => trace("raw SIGTERM observed by profiledServer.js listener"));
process.on("exit", (code) => trace(`process 'exit' event fired, code=${code}`));

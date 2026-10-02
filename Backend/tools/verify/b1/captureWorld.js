"use strict";

/**
 * B1 measurement tooling — a preload (`node -r`) for `tools/demo/runV1Assignment.js` that
 * captures a **frozen world**: a disposable database in which the fleet is commissioned,
 * online and indexed, and the run's tasks are queued, but **no coordinator round has run**.
 * **Test-only.** Nothing in `src/` requires it.
 *
 * It holds the coordinator by replacing `coordinator.worker.start` (the export `leaderWorkers`
 * calls) with a no-op, so every other worker still runs exactly as the runner composes it.
 * Once `B1_CAPTURE_TASKS` WorkQueue rows are QUEUED and `B1_CAPTURE_AGENTS` agents are placed
 * with their robots online, it waits for the index maintainer's next sweep, writes a sidecar
 * `{ capturedAtMs, shardId, ... }` to `B1_CAPTURE_OUT`, and exits — closing every connection,
 * so the database can be used as a `CREATE DATABASE … TEMPLATE`.
 *
 * It writes nothing to the database.
 */

const Module = require("module");
const fs = require("fs");

const OUT = process.env.B1_CAPTURE_OUT;
const EXPECT_TASKS = Number(process.env.B1_CAPTURE_TASKS || 1);
const EXPECT_AGENTS = Number(process.env.B1_CAPTURE_AGENTS || 1);
if (!OUT) throw new Error("captureWorld: B1_CAPTURE_OUT is required");

const origLoad = Module._load;
let held = false;
Module._load = function load(request, parent, isMain) {
  // eslint-disable-next-line prefer-rest-params
  const exp = origLoad.apply(this, arguments);
  let file;
  try {
    file = Module._resolveFilename(request, parent, isMain);
  } catch {
    return exp;
  }
  const norm = file.split(String.fromCharCode(92)).join("/");
  if (!held && /Backend\/src\/workers\/coordinator\.worker\.js$|src\/workers\/coordinator\.worker\.js$/.test(norm) && exp && exp.start) {
    held = true;
    exp.start = () => ({ stop() {} });
    startWatching();
  }
  return exp;
};

function startWatching() {
  // Loaded lazily: by the time the coordinator module loads, the runner has set DATABASE_URL.
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  let stableSince = null;
  const timer = setInterval(async () => {
    try {
      const queued = await prisma.workQueue.count({ where: { state: "QUEUED" } });
      const placed = await prisma.agentCellPosition.findMany({ select: { shardId: true, agent: { select: { robot: { select: { isOnline: true } } } } } });
      const online = placed.filter((row) => row.agent && row.agent.robot && row.agent.robot.isOnline).length;
      if (queued >= EXPECT_TASKS && online >= EXPECT_AGENTS) {
        // One more index-maintainer sweep (2 s cadence) after the last task, so the mirror
        // reflects the queued state the round will see.
        if (stableSince === null) stableSince = Date.now();
        if (Date.now() - stableSince < 4500) return;
        clearInterval(timer);
        const shardId = placed[0] ? placed[0].shardId : null;
        fs.writeFileSync(
          OUT,
          JSON.stringify({ capturedAtMs: Date.now(), shardId, queued, agentsPlaced: placed.length, agentsOnline: online }, null, 1),
        );
        process.stdout.write(`[b1-capture] captured: ${queued} queued, ${online}/${placed.length} agents online\n`);
        await prisma.$disconnect();
        process.exit(0);
      }
    } catch (error) {
      process.stdout.write(`[b1-capture] poll failed: ${error.message}\n`);
    }
  }, 500);
}

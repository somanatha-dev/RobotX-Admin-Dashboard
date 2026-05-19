/**
 * Virtual Robot Simulation Engine
 *
 * Manages the lifecycle of virtual robots created through the Commission Robot
 * workflow.  Robots are never spawned automatically — they exist only after a
 * user commissions them through the frontend.
 *
 *   start()             — mark the engine as running (call once after server.listen)
 *   stop()              — disconnect all robots and clear tick timers
 *   reset()             — clear task/charging state without disconnecting
 *   addRobot(config)    — connect and start a robot that was just commissioned
 *   removeRobot(id)     — stop and remove a robot (called on decommission)
 *   getStatus()         — snapshot of every robot's current state
 *   setConfig()         — reserved for future runtime config changes
 */

const VirtualRobot = require("./VirtualRobot");

function createVirtualRobotSimulator({ prisma, kv, serverUrl, logger } = {}) {
  const log   = logger || console;
  let robots  = [];
  let started = false;

  // ── Engine lifecycle ────────────────────────────────────────────────────────

  function start() {
    if (started) return;
    started = true;
    log.info("[VR] Simulator ready — waiting for commissioned robots");
  }

  function stop() {
    started = false;
    for (const vr of robots) {
      try { vr.stop(); } catch { /* ignore */ }
    }
    log.info("[VR] Simulator stopped");
  }

  function reset() {
    for (const vr of robots) {
      try { vr.reset(); } catch { /* ignore */ }
    }
    log.info("[VR] All virtual robots reset");
  }

  // ── Dynamic robot management ────────────────────────────────────────────────

  /**
   * Attach a simulation instance to a robot that was just commissioned via the
   * Commission Robot API.  The robot already exists in the DB at this point;
   * commission() only seeds the Redis session and live-state keys.
   *
   * @param {{ robotId: string, lat: number|null, lon: number|null }} config
   */
  async function addRobot({ robotId, lat, lon } = {}) {
    if (!robotId) return;

    // Idempotent — skip if already managed.
    if (robots.find((r) => r.robotId === robotId)) {
      log.info(`[VR] addRobot: ${robotId} already managed — skipping`);
      return;
    }

    const spawnLat = typeof lat === "number" ? lat : 12.9023;
    const spawnLon = typeof lon === "number" ? lon : 77.5183;

    const vr = new VirtualRobot({ robotId, lat: spawnLat, lon: spawnLon, logger: log });

    try {
      await vr.commission(kv);
    } catch (e) {
      log.error(`[VR] addRobot session seed failed for ${robotId}`, { message: e?.message });
      // Non-fatal — robot may still connect via AUTH flow on next tick.
    }

    robots.push(vr);

    if (started) {
      vr.connect(serverUrl);
      vr.start();
      log.info(`[VR] ${robotId} virtual robot started`);
    } else {
      log.warn(`[VR] ${robotId} queued — engine not started yet`);
    }
  }

  /**
   * Stop and remove a commissioned robot (called by the retire/decommission flow).
   * @param {string} robotId
   */
  function removeRobot(robotId) {
    const idx = robots.findIndex((r) => r.robotId === robotId);
    if (idx < 0) return;
    try { robots[idx].stop(); } catch { /* ignore */ }
    robots.splice(idx, 1);
    log.info(`[VR] ${robotId} virtual robot removed`);
  }

  // ── Introspection ───────────────────────────────────────────────────────────

  function getStatus() {
    return {
      started,
      serverUrl,
      robotCount: robots.length,
      robots:     robots.map((vr) => vr.getStatus()),
    };
  }

  // eslint-disable-next-line no-unused-vars
  function setConfig(_config) {
    // Reserved for future runtime configuration (telemetry interval, obstacle rate, etc.)
  }

  return { start, stop, reset, addRobot, removeRobot, getStatus, setConfig };
}

module.exports = { createVirtualRobotSimulator };

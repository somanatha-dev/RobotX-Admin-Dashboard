/**
 * Boot re-hydration for simulated robots.
 *
 * ── Why this is a module and not eight lines inside `server.listen` ─────────
 * It used to be those eight lines, and they did two things a boot has no business doing:
 * they marked **every** `Robot` row `isOnline: true` because a process had started, and
 * they spawned an in-process VirtualRobot for every row, physical hardware included. Both
 * were unreachable from a test — `server.js` has no export and boots a listener — so the
 * only way to state what a boot must *not* do was to grep the file.
 *
 * Here, the boot decision is a function of a Prisma client and a simulator, and a test can
 * run it. That is the whole reason for the module: the properties this file is responsible
 * for are the ones Step 1 exists to guarantee, and a guarantee nothing can execute is a
 * comment.
 *
 * ── What a boot may and may not do ─────────────────────────────────────────
 *   MAY  spawn a VirtualRobot for a row with `simulated = true`, when the simulator is
 *        enabled for this process.
 *   MUST NOT write liveness. Not for physical robots, not for simulated ones. `isOnline`
 *        is established by a session — AUTH sets it, disconnect clears it, the staleness
 *        sweeper retires the rest — and a boot has observed no session. A simulated agent
 *        earns its online state the same way hardware does, by connecting.
 *   MUST NOT read or spawn anything at all when the simulator is disabled.
 */

const simulationPolicy = require("./simulationPolicy");

/**
 * Re-hydrate the simulated half of the fleet.
 *
 * @param {object} deps
 * @param {object} deps.prisma
 * @param {{ addRobot: Function }} deps.simulator
 * @param {object} [deps.logger]
 * @param {boolean} [deps.enabled] process-level posture; defaults to the environment
 * @returns {Promise<{ enabled: boolean, considered: number, spawned: number, refused: Array<{robotId: string, reason: string}> }>}
 */
async function rehydrateSimulatedRobots({ prisma, simulator, logger, enabled } = {}) {
  const log = logger || console;
  const simulatorEnabled =
    typeof enabled === "boolean" ? enabled : simulationPolicy.isSimulatorEnabled();

  const outcome = { enabled: simulatorEnabled, considered: 0, spawned: 0, refused: [] };

  if (!simulatorEnabled) {
    log.info(
      `[VR] Re-hydration skipped — simulator disabled (${simulationPolicy.SIMULATOR_ENV_VAR} is not true)`,
    );
    return outcome;
  }
  if (!prisma || !simulator || typeof simulator.addRobot !== "function") return outcome;

  // The filter is the guarantee. A physical row is never returned by this query, so it is
  // never passed to `addRobot` — and `addRobot` re-checks the row anyway, because the
  // property is worth holding at both ends.
  const rows = await prisma.robot.findMany({
    where: { simulated: true },
    select: { robotId: true, lat: true, lon: true, simulated: true },
  });

  outcome.considered = rows.length;

  for (const row of rows) {
    try {
      const result = await simulator.addRobot({
        robotId: row.robotId,
        lat: row.lat,
        lon: row.lon,
        simulated: row.simulated,
      });
      // `addRobot` returns a verdict; a spawn that was refused is not a spawn, and is
      // reported rather than counted.
      if (result && result.started === true) outcome.spawned += 1;
      else outcome.refused.push({ robotId: row.robotId, reason: result?.reason || "UNKNOWN" });
    } catch (e) {
      log.warn(`[VR] Re-hydration failed for ${row.robotId}`, { message: e?.message });
      outcome.refused.push({ robotId: row.robotId, reason: "THREW" });
    }
  }

  log.info(`[VR] Re-hydrated ${outcome.spawned} of ${outcome.considered} simulated robot(s) from DB`);
  return outcome;
}

module.exports = { rehydrateSimulatedRobots };

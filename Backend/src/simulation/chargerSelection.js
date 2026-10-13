"use strict";

/**
 * Phase B (charging lifecycle) — which charging station a simulated robot should go to.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *   1. Only stations REACHABLE over the campus sidewalk network, inside the delivery domain, are
 *      candidates (a refused route excludes the station, by name). Straight-line proximity is
 *      never used.
 *   2. Among the stations the robot can reach KEEPING ITS RESERVE (`energyPolicy.feasibility`),
 *      the one where current would start flowing soonest:
 *          cost = travel time + max(0, expected wait − travel time)
 *      — waiting overlaps the drive, so a queue shorter than the trip costs nothing.
 *   3. URGENCY: when no station can be reached with the reserve intact, energy dominates waiting:
 *      the reachable station that costs the least energy to get to, whatever its queue.
 *   Ties break on network distance, then on charger id, so the choice is total and reproducible.
 *
 * ── Expected wait ───────────────────────────────────────────────────────────
 * A robot joins the back of the station's FIFO queue. With `plugCount` plugs, `active` sessions
 * (each with its remaining charge time, when known) and `queued` robots ahead, it waits until
 * the (queued − free + 1)-th plug frees; that is the matching remaining time of the active
 * sessions, sorted. Beyond what the active sessions say, the wait is unknown (null), and an
 * unknown wait ranks after every known one rather than being guessed.
 *
 * Pure: no clock, no I/O.
 */

const energyPolicy = require("./energyPolicy");

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * @param {{ plugCount: number, activeRemainingS: (number|null)[], queued: number }} load
 * @returns {number|null} seconds, 0 when a plug is free for this robot, null when unknown
 */
function expectedWaitSeconds(load) {
  const source = load || {};
  const plugs = Number.isInteger(source.plugCount) ? source.plugCount : 0;
  const remaining = Array.isArray(source.activeRemainingS) ? source.activeRemainingS : [];
  const queued = Number.isInteger(source.queued) && source.queued > 0 ? source.queued : 0;
  const free = plugs - remaining.length;
  if (free > queued) return 0;
  // 0-based: which of the active sessions, in finishing order, frees the plug this robot gets.
  const index = queued - Math.max(0, free);
  if (remaining.some((value) => !isNumber(value))) return null;
  const sorted = [...remaining].sort((a, b) => a - b);
  return index < sorted.length ? sorted[index] : null;
}

/**
 * @param {object} input
 * @param {{ chargerId: string, distanceM?: number, refusal?: string, reason?: string,
 *           plugCount?: number, activeRemainingS?: (number|null)[], queued?: number }[]} input.candidates
 * @param {{ speedMps: number, whPerMetre: number|null, availableWh: number|null, reserveWh: number|null }} input.robot
 * @returns {{ chosen: object|null, urgent: boolean, ranked: object[], excluded: { chargerId: string, reason: string }[] }}
 */
function selectStation(input) {
  const source = input || {};
  const robot = source.robot || {};
  const excluded = [];
  const evaluated = [];
  for (const candidate of Array.isArray(source.candidates) ? source.candidates : []) {
    if (!candidate || typeof candidate.chargerId !== "string") continue;
    if (candidate.refusal || !isNumber(candidate.distanceM)) {
      excluded.push({ chargerId: candidate.chargerId, reason: candidate.refusal ? `${candidate.refusal}: ${candidate.reason || ""}`.trim() : "no route" });
      continue;
    }
    if (!isNumber(robot.speedMps) || robot.speedMps <= 0) {
      excluded.push({ chargerId: candidate.chargerId, reason: "the robot's speed is unknown, so no travel time can be stated" });
      continue;
    }
    const travelS = candidate.distanceM / robot.speedMps;
    const tripWh = isNumber(robot.whPerMetre) ? candidate.distanceM * robot.whPerMetre : null;
    const keepsReserve = tripWh === null || !isNumber(robot.availableWh) || !isNumber(robot.reserveWh)
      ? true
      : energyPolicy.feasibility({ availableWh: robot.availableWh, deliveryWh: 0, chargerTripWh: tripWh, reserveWh: robot.reserveWh }).feasible;
    const waitS = expectedWaitSeconds({ plugCount: candidate.plugCount, activeRemainingS: candidate.activeRemainingS, queued: candidate.queued });
    const costS = isNumber(waitS) ? travelS + Math.max(0, waitS - travelS) : Infinity;
    evaluated.push({ chargerId: candidate.chargerId, distanceM: candidate.distanceM, travelS, tripWh, keepsReserve, waitS, costS });
  }
  const order = (a, b) => (a.costS - b.costS) || (a.distanceM - b.distanceM) || (a.chargerId < b.chargerId ? -1 : a.chargerId > b.chargerId ? 1 : 0);
  const safe = evaluated.filter((entry) => entry.keepsReserve).sort(order);
  if (safe.length > 0) return { chosen: safe[0], urgent: false, ranked: [...safe, ...evaluated.filter((e) => !e.keepsReserve).sort(order)], excluded };
  const byEnergy = [...evaluated].sort((a, b) => (a.distanceM - b.distanceM) || order(a, b));
  return { chosen: byEnergy[0] || null, urgent: byEnergy.length > 0, ranked: byEnergy, excluded };
}

module.exports = { expectedWaitSeconds, selectStation };

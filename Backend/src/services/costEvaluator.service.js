/**
 * Cost Evaluator Service — DTARO
 *
 * Implements the DTARO multi-criteria cost function:
 *
 *   C(r) = w1·D(r) + w2·(1−B(r)) + w3·U(r) + w4·T(r)
 *
 *   D(r) — Normalized distance from robot to pickup point  (0–1)
 *   B(r) — Normalized battery level, inverted              (0–1, higher cost = lower battery)
 *   U(r) — Utilization ratio                               (0–1, higher = busier = worse)
 *   T(r) — Normalized travel time / ETA                    (0–1)
 *
 * Default weights per DTARO spec:
 *   w1 = 0.50, w2 = 0.30, w3 = 0.15, w4 = 0.05
 */

const { getRobotState } = require("./robotRegistry.service");

/** @type {{ w1: number, w2: number, w3: number, w4: number }} */
const DEFAULT_WEIGHTS = { w1: 0.50, w2: 0.30, w3: 0.15, w4: 0.05 };

/**
 * Min-max normalize an array of numbers to [0, 1].
 * Returns uniform 0.5 when all values are equal (avoids division by zero).
 * @param {number[]} values
 * @returns {number[]}
 */
function normalize(values) {
  if (!values.length) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (!range) return values.map(() => 0.5);
  return values.map((v) => (v - min) / range);
}

/**
 * Compute DTARO allocation cost for each candidate robot.
 *
 * @param {object} kv
 * @param {Array<{
 *   robotId: string,
 *   distanceM: number,
 *   durationSec: number|null,
 *   battery?: number
 * }>} candidates
 * @param {object} [weights] - Override default weights
 * @returns {Promise<Array<{
 *   robotId: string,
 *   cost: number,
 *   components: { D: number, B: number, U: number, T: number },
 *   distanceM: number,
 *   durationSec: number,
 *   battery: number,
 *   utilization: number
 * }>>}
 */
async function computeCosts(kv, candidates, weights = DEFAULT_WEIGHTS) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  const w = { ...DEFAULT_WEIGHTS, ...weights };

  // Pull live registry state for all candidates in parallel
  const liveStates = await Promise.all(candidates.map((c) => getRobotState(kv, c.robotId)));

  // Raw D vector (meters)
  const distances = candidates.map((c) => (typeof c.distanceM === "number" ? c.distanceM : 0));

  // Raw T vector (seconds)
  const durations = candidates.map((c) => (typeof c.durationSec === "number" ? c.durationSec : 0));

  // B(r) — live battery (%) or fallback to candidate's DB value
  const batteries = liveStates.map((s, i) => {
    const b =
      typeof s?.battery === "number"
        ? s.battery
        : typeof candidates[i].battery === "number"
          ? candidates[i].battery
          : 100;
    return Math.max(0, Math.min(100, b));
  });

  // U(r) — utilization ratio from registry (0–1)
  const utilizations = liveStates.map((s) => {
    const u = typeof s?.utilization === "number" ? s.utilization : 0;
    return Math.max(0, Math.min(1, u));
  });

  // Normalize D and T across the candidate set
  const normD = normalize(distances);
  const normT = normalize(durations);

  // Battery cost: invert so low battery = high cost  (1 − battery/100)
  const batteryComponents = batteries.map((b) => 1 - b / 100);

  return candidates.map((c, i) => {
    const cost =
      w.w1 * normD[i] +
      w.w2 * batteryComponents[i] +
      w.w3 * utilizations[i] +
      w.w4 * normT[i];

    return {
      robotId: c.robotId,
      cost: Number(cost.toFixed(6)),
      components: {
        D: Number(normD[i].toFixed(4)),
        B: Number(batteryComponents[i].toFixed(4)),
        U: Number(utilizations[i].toFixed(4)),
        T: Number(normT[i].toFixed(4)),
      },
      distanceM: distances[i],
      durationSec: durations[i],
      battery: batteries[i],
      utilization: utilizations[i],
    };
  });
}

module.exports = {
  computeCosts,
};

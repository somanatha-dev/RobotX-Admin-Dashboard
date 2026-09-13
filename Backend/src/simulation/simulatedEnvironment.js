"use strict";

/**
 * The simulated thermal environment — ambient air and pack temperature.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 * §14.2's consumption equation has a `β_thermal(T_ambient, T_pack)` term, and
 * `energy/consumption.legEnergyWh` requires both temperatures as profile inputs. The
 * DEVELOPMENT simulation had neither: `constants.js` carried a single
 * `CHARGE_PACK_TEMPERATURE_C = 20` used only when integrating the charge curve, and
 * nothing produced an ambient at all. A simulator that reported a temperature on a
 * dashboard while its energy model remained temperature-independent would be a display,
 * not a model, so the two temperatures produced here are the same two the simulator's
 * energy call consumes.
 *
 * ── WHAT THIS IS NOT: a physical measurement, or a calibrated thermal model ──
 * Every number below is a **declared DEVELOPMENT simulation figure**. Nothing here was
 * measured on a vehicle, fitted to a dataset, or supplied by a vendor. It is a plausible
 * shape for a development environment to exercise a temperature-dependent code path
 * with, and it carries **no evidentiary weight of any kind**:
 *
 *   * it is not physical evidence, and no verification may cite it as such;
 *   * it does not calibrate `β_thermal` — that coefficient remains unfitted and
 *     `legEnergyWh` still refuses without it;
 *   * it is not a fidelity claim: `sim:fidelity` remains `UNVALIDATABLE`, and a
 *     simulated temperature is not a step toward validating one.
 *
 * The **ambient band** is the one owner-declared quantity here: 25–35 °C, varying with
 * simulated time. Everything else — the diurnal shape, the thermal time constant, the
 * self-heating rate — is simulation scaffolding chosen to produce the behaviour the
 * milestone asks for (a pack that is warmer than ambient under load and relaxes toward
 * ambient at rest), and is marked as such.
 *
 * ── Determinism ─────────────────────────────────────────────────────────────
 * No `Math.random()`. Each instance draws from `random.js`'s seeded stream, forked on the
 * robot's own identifier, so one robot's trace is reproducible and is unaffected by how
 * many other robots share the process. Two robots at one site see the *same* diurnal
 * ambient — they are in the same air, and giving them independent weather would be less
 * physical, not more — plus a small per-robot offset standing for sensor placement and
 * local microclimate.
 */

const { createRandom, forkSeed } = require("./random");

/* ═══════════════════════════════════════════════════════════════════════════
   The owner-declared ambient band
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The ambient range the DEVELOPMENT simulation runs in, in °C.
 * @structural an owner-declared DEVELOPMENT simulation band
 */
const AMBIENT_MIN_C = 25;
const AMBIENT_MAX_C = 35;

/** The midpoint and half-range the diurnal curve swings about. */
const AMBIENT_MID_C = (AMBIENT_MIN_C + AMBIENT_MAX_C) / 2;
const AMBIENT_HALF_RANGE_C = (AMBIENT_MAX_C - AMBIENT_MIN_C) / 2;

/**
 * The period of the ambient cycle, in milliseconds — one simulated day.
 *
 * A day, rather than something shorter that would make the variation obvious in a
 * two-minute demo, because compressing the clock to make an effect visible is the same
 * class of move as compressing charge time to make a test pass. The variation is real and
 * slow; a run that wants to see the whole curve advances the clock it passes in.
 *
 * @structural 24 hours in milliseconds
 */
const AMBIENT_PERIOD_MS = 24 * 60 * 60 * 1000;

/**
 * How far one robot's reading may sit from the site's, in °C.
 *
 * Sensor placement and local microclimate, not weather. Small on purpose: a robot two
 * metres away reading three degrees differently would be a broken sensor, not a
 * microclimate.
 *
 * @structural a DEVELOPMENT simulation figure, not a measurement
 */
const AMBIENT_PER_ROBOT_SPREAD_C = 0.6;

/* ═══════════════════════════════════════════════════════════════════════════
   Pack thermal behaviour — DEVELOPMENT simulation scaffolding
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The pack's thermal time constant toward ambient, in seconds.
 *
 * Newton's law of cooling with τ = 20 min: a pack 8 °C above ambient falls to about 3 °C
 * above it after twenty minutes at rest. Chosen to be slow enough that a pack does not
 * snap to ambient between ticks — which would make the whole term indistinguishable from
 * ambient and defeat the requirement that the two differ.
 *
 * @structural a DEVELOPMENT simulation figure, not a measured thermal mass
 */
const PACK_TIME_CONSTANT_SECONDS = 1200;

/**
 * Pack self-heating, in °C per second at full modelled load.
 *
 * Scaled by the load fraction below, so a stationary pack self-heats not at all and one
 * working hard approaches a steady state a few degrees above ambient. The steady-state
 * rise is `rate × τ`, which at these figures is about 6 °C.
 *
 * @structural a DEVELOPMENT simulation figure, not a measured I²R loss
 */
const PACK_SELF_HEATING_C_PER_SECOND = 0.005;

/**
 * The speed, in m/s, treated as full load for self-heating.
 *
 * The declared presets cruise at 1.0–1.5 m/s, so this is a little above the fastest of
 * them: a HEAVY unit at its nominal speed sits at roughly two-thirds load rather than
 * pinned at the top of the scale.
 *
 * @structural a DEVELOPMENT simulation figure
 */
const PACK_FULL_LOAD_SPEED_MPS = 1.6;

/**
 * Load attributed to a charging pack.
 *
 * Charging warms a pack — that is why `chargeCurve` derates on temperature at all — so a
 * docked pack is not simply an idle one. Held below the moving figure because the
 * simulator's charge power is modest.
 *
 * @structural a DEVELOPMENT simulation figure
 */
const PACK_CHARGING_LOAD_FRACTION = 0.45;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {number} value
 * @param {number} low
 * @param {number} high
 * @returns {number}
 */
function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

/**
 * The site's ambient temperature at an instant, before any per-robot offset.
 *
 * A cosine through the declared band, coldest at midnight and warmest in mid-afternoon,
 * evaluated against the absolute clock so every robot in the process — and every restart
 * of the process — agrees about what time of day it is. That agreement is what makes the
 * value shared rather than per instance.
 *
 * Exported so a test can assert the band and the variation without constructing a robot.
 *
 * @param {number} nowMs
 * @returns {number|null} °C, or null when the instant is unusable
 */
function siteAmbientC(nowMs) {
  if (!isNumber(nowMs)) return null;
  // Phase measured from the period's start; the −cos shape puts the minimum at phase 0.
  const phase = ((nowMs % AMBIENT_PERIOD_MS) + AMBIENT_PERIOD_MS) % AMBIENT_PERIOD_MS;
  const radians = (phase / AMBIENT_PERIOD_MS) * 2 * Math.PI;
  return AMBIENT_MID_C - AMBIENT_HALF_RANGE_C * Math.cos(radians);
}

/**
 * One robot's view of its thermal environment.
 *
 * Stateful in exactly one quantity — the pack temperature — because that is the one that
 * genuinely integrates over time. Ambient is a pure function of the clock and is not
 * stored, so it cannot drift out of the declared band no matter how the simulation is
 * driven.
 *
 * @param {object} input
 * @param {string} input.robotId the robot whose stream this is forked from
 * @param {number} [input.seed] an explicit run seed; the id alone is used without one
 * @param {number} [input.startedAtMs] the instant the pack's initial temperature is taken at
 * @returns {object}
 */
function createSimulatedEnvironment(input) {
  const source = input || {};
  const robotId = String(source.robotId ?? "");

  // The same seeding discipline `VirtualRobot` uses for speed and obstacles: forked from
  // the robot's own basis so this stream cannot shift the others, and vice versa.
  const seedBasis = isNumber(source.seed) ? source.seed : robotId;
  const random = createRandom(forkSeed(seedBasis, "environment"));

  // Drawn once, at construction: a sensor's offset is a property of the installation, not
  // something that is re-rolled every tick. Centred on zero.
  const ambientOffsetC = (random() - 0.5) * 2 * AMBIENT_PER_ROBOT_SPREAD_C;

  // A pack that has been sitting is at ambient. This is the one honest initial condition:
  // it asserts no stored heat from work nobody has simulated.
  const startedAtMs = isNumber(source.startedAtMs) ? source.startedAtMs : Date.now();
  let packC = clamp(
    (siteAmbientC(startedAtMs) ?? AMBIENT_MID_C) + ambientOffsetC,
    AMBIENT_MIN_C,
    AMBIENT_MAX_C,
  );
  let lastStepMs = startedAtMs;

  /**
   * This robot's ambient reading at an instant, inside the declared band.
   *
   * @param {number} nowMs
   * @returns {number}
   */
  function ambientCAt(nowMs) {
    const site = siteAmbientC(nowMs);
    if (site === null) return clamp(AMBIENT_MID_C + ambientOffsetC, AMBIENT_MIN_C, AMBIENT_MAX_C);
    // Clamped, so the per-robot offset can never carry a reading outside the band the
    // owner declared. The band is the declaration; the offset is detail within it.
    return clamp(site + ambientOffsetC, AMBIENT_MIN_C, AMBIENT_MAX_C);
  }

  /**
   * Advance the pack temperature to `nowMs`.
   *
   * Two effects, composed in the order they physically occur: the pack relaxes toward
   * ambient over the elapsed interval, and the work done over that interval adds heat.
   * The relaxation uses the exponential form rather than a linear step so the result does
   * not depend on how finely the caller ticks — a 2 s tick and a 4 s tick reach the same
   * temperature after the same elapsed time, which a linear approximation does not give
   * and which matters because the tick period is configurable.
   *
   * @param {object} step
   * @param {number} step.nowMs
   * @param {number} [step.speedMps] the agent's current speed
   * @param {boolean} [step.charging] whether current is flowing into the pack
   * @returns {{ ambientC: number, packC: number, elapsedSeconds: number }}
   */
  function advance(step) {
    const settings = step || {};
    const nowMs = isNumber(settings.nowMs) ? settings.nowMs : lastStepMs;
    const elapsedSeconds = Math.max(0, (nowMs - lastStepMs) / 1000);
    lastStepMs = nowMs;

    const ambientC = ambientCAt(nowMs);

    if (elapsedSeconds > 0) {
      // Relaxation toward ambient.
      const decay = Math.exp(-elapsedSeconds / PACK_TIME_CONSTANT_SECONDS);
      packC = ambientC + (packC - ambientC) * decay;

      // Self-heating from the work actually being done this interval.
      const speed = isNumber(settings.speedMps) ? Math.max(0, settings.speedMps) : 0;
      const movingLoad = clamp(speed / PACK_FULL_LOAD_SPEED_MPS, 0, 1);
      const load = settings.charging === true ? Math.max(movingLoad, PACK_CHARGING_LOAD_FRACTION) : movingLoad;
      packC += PACK_SELF_HEATING_C_PER_SECOND * load * elapsedSeconds;
    }

    return { ambientC, packC, elapsedSeconds };
  }

  /**
   * The current pair, without advancing anything. Safe to call from a status reader.
   *
   * @param {number} [nowMs]
   * @returns {{ ambientC: number, packC: number }}
   */
  function snapshot(nowMs) {
    return {
      ambientC: ambientCAt(isNumber(nowMs) ? nowMs : lastStepMs),
      packC,
    };
  }

  return {
    robotId,
    ambientCAt,
    advance,
    snapshot,
    /** The per-robot sensor offset, exposed so a test can prove it is deterministic. */
    ambientOffsetC,
  };
}

module.exports = {
  AMBIENT_MIN_C,
  AMBIENT_MAX_C,
  AMBIENT_PERIOD_MS,
  AMBIENT_PER_ROBOT_SPREAD_C,
  PACK_TIME_CONSTANT_SECONDS,
  PACK_SELF_HEATING_C_PER_SECOND,
  PACK_FULL_LOAD_SPEED_MPS,
  PACK_CHARGING_LOAD_FRACTION,
  siteAmbientC,
  createSimulatedEnvironment,
};

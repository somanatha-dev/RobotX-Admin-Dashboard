/**
 * DTARO battery thresholds — **compatibility shim, retiring in Phase 7.**
 *
 * These two values used to be declared here as compile-time constants. Phase 1
 * (§22) moves every behavioural constant into the versioned parameter register, so
 * this file no longer *holds* them: it resolves them through the Config Service and
 * re-exports them under their existing names, so `robotValidator.service.js` and
 * `simulation/constants.js` keep working unchanged until their own phases land.
 *
 * The values are unchanged. Phase 1 moves where they live, not what they are.
 *
 * Register entries:
 *   legacy.dtaro.battery_threshold_pct           (was BATTERY_THRESHOLD)
 *   legacy.dtaro.charging_interrupt_battery_pct  (was CHARGING_INTERRUPT_BATTERY)
 *
 * **Why they are registered under `legacy.` and marked UNCALIBRATED.** §14.1 states
 * that percentage-based floors are inadequate: a percentage cannot express a tail
 * requirement, and the same percentage means a different number of watt-hours on
 * every pack and at every state of health. §14.5 replaces them with Wh-denominated
 * layered reserves and the three-tier F34 constraint, whose targets derive from a
 * governed fleet-year event budget. They are replaced in Phase 7, not re-tuned.
 */

const { defaultSnapshot } = require("../engine/config/service");

const snapshot = defaultSnapshot();

// A legacy consumer reads a plain number, not an explanation. Resolution failure is
// fatal here rather than defaulted: silently substituting a battery floor is exactly
// the class of failure the register exists to prevent.
function required(name) {
  const explanation = snapshot.explain(name);
  if (explanation.value === null || explanation.value === undefined) {
    throw new Error(
      `legacy constant "${name}" did not resolve through the Config Service ` +
        `(source: ${explanation.source}). Every behavioural constant is configuration (§22.1 rule 1).`,
    );
  }
  return explanation.value;
}

/** Minimum battery % a robot must have to be DTARO-eligible for a new task
 *  (also the floor used when deciding if a charging robot may be assigned one). */
const BATTERY_THRESHOLD = required("legacy.dtaro.battery_threshold_pct");

/** Minimum battery % a charging VirtualRobot needs before it will interrupt
 *  charging to start an already-assigned task, rather than deferring it. */
const CHARGING_INTERRUPT_BATTERY = required("legacy.dtaro.charging_interrupt_battery_pct");

module.exports = {
  BATTERY_THRESHOLD,
  CHARGING_INTERRUPT_BATTERY,
};

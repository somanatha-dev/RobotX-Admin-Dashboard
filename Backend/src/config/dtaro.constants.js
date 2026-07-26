/**
 * Shared DTARO battery-threshold configuration.
 *
 * Single source of truth for the battery cutoffs previously hardcoded
 * independently in robotValidator.service.js and simulation/constants.js
 * (PHASE1_REVIEW F25) — keep both defined here so a future change to one
 * is made with visibility of the other.
 */

/** Minimum battery % a robot must have to be DTARO-eligible for a new task
 *  (also the floor used when deciding if a charging robot may be assigned one). */
const BATTERY_THRESHOLD = 20;

/** Minimum battery % a charging VirtualRobot needs before it will interrupt
 *  charging to start an already-assigned task, rather than deferring it. */
const CHARGING_INTERRUPT_BATTERY = 30;

module.exports = {
  BATTERY_THRESHOLD,
  CHARGING_INTERRUPT_BATTERY,
};

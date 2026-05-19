const TELEMETRY_INTERVAL_MS   = 2000;
const MOVE_STEP_METERS         = 12;
const ARRIVE_THRESHOLD_METERS  = 3;

const BATTERY_DRAIN_ACTIVE     = 0.10;  // % per tick when ACTIVE
const BATTERY_DRAIN_IDLE       = 0.02;  // % per tick baseline drain
const BATTERY_RECHARGE_IDLE    = 0.05;  // % per tick added when IDLE and battery < 95
const BATTERY_WARN_THRESHOLD     = 20;
const BATTERY_CRITICAL_THRESHOLD = 10;  // at or below this → enter CHARGING
const BATTERY_MIN                = 5;   // floor — virtual robots never fully die

// Charging model (compressed for demo)
// WAITING phase: robot sits idle before charging starts (demo: 30 s ≈ 20 min real)
const CHARGING_WAIT_MS           = 30_000;
// Rate of charge per tick during the CHARGING phase (%/tick)
// 2.0%/tick × 2 s/tick × 45 ticks ≈ 90 s to full — representative of a fast-charge session
const CHARGING_RATE_PER_TICK     = 2.0;
// Minimum battery to accept a task when currently charging (reserve for the run + 10% buffer)
const CHARGING_INTERRUPT_BATTERY = 20;

const OBSTACLE_PROBABILITY     = 0.002; // per tick while ACTIVE
const PICKUP_WAIT_MS           = 30_000;
const DROP_WAIT_MS             = 30_000;

const SESSION_TTL_SEC          = 604_800; // 7 days — survives server restarts
const RECONNECT_DELAY_MS       = 3_000;

module.exports = {
  TELEMETRY_INTERVAL_MS,
  MOVE_STEP_METERS,
  ARRIVE_THRESHOLD_METERS,
  BATTERY_DRAIN_ACTIVE,
  BATTERY_DRAIN_IDLE,
  BATTERY_RECHARGE_IDLE,
  BATTERY_WARN_THRESHOLD,
  BATTERY_CRITICAL_THRESHOLD,
  BATTERY_MIN,
  CHARGING_WAIT_MS,
  CHARGING_RATE_PER_TICK,
  CHARGING_INTERRUPT_BATTERY,
  OBSTACLE_PROBABILITY,
  PICKUP_WAIT_MS,
  DROP_WAIT_MS,
  SESSION_TTL_SEC,
  RECONNECT_DELAY_MS,
};

// ─── Tick timing ─────────────────────────────────────────────────────────────
const TELEMETRY_INTERVAL_MS   = 2000;       // 2 s per tick

// ─── Movement ────────────────────────────────────────────────────────────────
// At 20 km/h (5.56 m/s) with a 2-second tick the robot travels ~11 m per tick.
// MOVE_STEP_METERS is a hard ceiling guard against GPS teleports.
const MOVE_STEP_METERS         = 40;         // hard cap (generous for 20–30 km/h range)

// Speed model — smooth EMA at delivery-bot speed (20–30 km/h / 5.6–8.3 m/s)
const SPEED_BASE_MS            = 5.56;       // m/s ≈ 20 km/h  (minimum visible movement)
const SPEED_JITTER             = 1.5;        // ±jitter: target ∈ [4.8, 6.3] m/s
const SPEED_EMA_ALPHA          = 0.20;       // EMA coefficient — snappy acceleration
const SPEED_MIN_MS             = 5.0;        // floor  ≈ 18 km/h
const SPEED_MAX_MS             = 8.33;       // ceiling ≈ 30 km/h

// ─── Battery — real-time rates ───────────────────────────────────────────────
//   ACTIVE:  100 % → 20 % in 1 hour  → 80 % ÷ 1800 ticks = 0.0444 %/tick
//   IDLE:    100 % → 20 % in 5 hours → 80 % ÷ 9000 ticks = 0.0089 %/tick
//   CHARGING: 10 % → 100 % in 30 min → 90 % ÷ 900 ticks  = 0.100  %/tick
const BATTERY_DRAIN_ACTIVE     = 0.0444;     // %/tick while ACTIVE
const BATTERY_DRAIN_IDLE       = 0.0089;     // %/tick while IDLE / PAUSED / ISSUES
const BATTERY_WARN_THRESHOLD   = 20;         // %  → status → ISSUES
const BATTERY_CRITICAL_THRESHOLD = 10;       // %  → enter CHARGING state
const BATTERY_MIN              = 5;          // %  floor
const CHARGING_RATE_PER_TICK   = 0.10;       // %/tick while CHARGING
const CHARGING_INTERRUPT_BATTERY = 30;       // min battery to accept task while charging

// ─── Charging wait before current begins to flow ─────────────────────────────
const CHARGING_WAIT_MS         = 30_000;     // 30 s docking delay

// ─── Battery persistence interval ────────────────────────────────────────────
const BATTERY_PERSIST_TICKS    = 60;         // 60 × 2 s = 2 min

// ─── Task / obstacle behaviour ───────────────────────────────────────────────
const OBSTACLE_PROBABILITY     = 0.002;      // per tick while ACTIVE
const PICKUP_WAIT_MS           = 10_000;     // 10 s wait at pickup location
const DROP_WAIT_MS             = 8_000;      // 8 s wait at drop location

// ─── Socket / session ────────────────────────────────────────────────────────
const SESSION_TTL_SEC          = 604_800;    // 7 days
const RECONNECT_DELAY_MS       = 3_000;

module.exports = {
  TELEMETRY_INTERVAL_MS,
  MOVE_STEP_METERS,
  SPEED_BASE_MS,
  SPEED_JITTER,
  SPEED_EMA_ALPHA,
  SPEED_MIN_MS,
  SPEED_MAX_MS,
  BATTERY_DRAIN_ACTIVE,
  BATTERY_DRAIN_IDLE,
  BATTERY_WARN_THRESHOLD,
  BATTERY_CRITICAL_THRESHOLD,
  BATTERY_MIN,
  CHARGING_RATE_PER_TICK,
  CHARGING_INTERRUPT_BATTERY,
  CHARGING_WAIT_MS,
  BATTERY_PERSIST_TICKS,
  OBSTACLE_PROBABILITY,
  PICKUP_WAIT_MS,
  DROP_WAIT_MS,
  SESSION_TTL_SEC,
  RECONNECT_DELAY_MS,
};

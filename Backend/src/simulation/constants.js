const { CHARGING_INTERRUPT_BATTERY } = require("../config/dtaro.constants");

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
const BATTERY_DRAIN_ACTIVE     = 0.0444;     // %/tick while ACTIVE
const BATTERY_DRAIN_IDLE       = 0.0089;     // %/tick while IDLE / PAUSED / ISSUES
const BATTERY_WARN_THRESHOLD   = 20;         // %  → status → ISSUES
const BATTERY_CRITICAL_THRESHOLD = 10;       // %  → enter CHARGING state
const BATTERY_MIN              = 5;          // %  floor
const CHARGING_RATE_PER_TICK   = 0.10;       // %/tick — LEGACY linear rate, see below
// CHARGING_INTERRUPT_BATTERY sourced from ../config/dtaro.constants (shared with robotValidator.service.js)

// ─── PHASE 7 — the modelled pack (§14.6) ─────────────────────────────────────
//
// §14.6 states the defect the linear rate above is an instance of:
//
//   > **Charge duration is nonlinear.** Li-ion charging is constant-current to roughly
//   > 80 % and then constant-voltage with a decaying current, so the last 20 % can take
//   > as long as the first 60 %. A linear rate — as the baseline's simulation uses —
//   > will systematically underestimate time to full and overestimate fleet
//   > availability.
//
// `CHARGING_RATE_PER_TICK` is that linear rate. It is retained because the legacy
// dispatcher's simulation still runs on it until the Phase 15 cutover, and removing it
// now would change behaviour Phase 7 was not asked to change. It is **not** used when a
// modelled pack is available: `VirtualRobot` integrates `CHARGE_POWER_CURVE` through the
// same `engine/energy/chargeCurve.js` the server plans with.
//
// That shared module is the point. §14.6:
//
//   > the *agent* receives the reserve parameters and the target SoC as part of the
//   > offer, so the two sides reason from identical inputs by construction rather than
//   > by a shared constant that a future edit could desynchronise.
//
// One curve, one integrator, one set of reserve parameters carried on the wire. A
// simulator that modelled the taper differently from the server would agree with it
// about every charging plan only by coincidence, and §24.4's fidelity gate would be
// measuring the difference between two models rather than between a model and reality.

/** Nominal pack capacity of the simulated class, in watt-hours. */
const PACK_NOMINAL_WH          = 1000;

/**
 * `P_charge(SoC, T, charger_class)` in the shape `engine/energy/chargeCurve.js` reads.
 *
 * The SoC curve is constant-current to 80 % and then a decaying constant-voltage tail,
 * which is the shape §14.6 describes. At 1 000 Wh nominal it charges 10 % → 80 % in
 * about 21 minutes and 80 % → 100 % in about another 24 — the "last 20 % takes as long
 * as the first 60 %" behaviour a linear rate cannot produce.
 */
const CHARGE_POWER_CURVE = Object.freeze({
  byChargerClass: {
    STANDARD: {
      socCurve: [
        { x: 0.0,  y: 2000 },
        { x: 0.8,  y: 2000 },
        { x: 0.9,  y: 900 },
        { x: 0.95, y: 400 },
        { x: 1.0,  y: 120 },
      ],
    },
  },
  temperatureDerating: [
    { x: -10, y: 0.35 },
    { x: 0,   y: 0.6 },
    { x: 15,  y: 1.0 },
    { x: 35,  y: 1.0 },
    { x: 45,  y: 0.7 },
  ],
});

/** The charger class a docked simulated agent is assumed to be on. */
const CHARGE_CHARGER_CLASS     = "STANDARD";

/** Pack temperature the simulator charges at, in °C. */
const CHARGE_PACK_TEMPERATURE_C = 20;

/**
 * Sub-intervals per integration. Matches `energy.charge_curve_integration_steps`'s
 * seeded default; the register entry is the authority and the server resolves it, while
 * the simulator carries the same value so an unconfigured simulator does not silently
 * integrate more coarsely than the server it is being checked against.
 */
const CHARGE_CURVE_INTEGRATION_STEPS = 64;

/**
 * Target state of charge used only when the Charging Scheduler has published none.
 *
 * Matches `energy.target_soc_fallback`'s seeded default. §14.6 assigns the target to
 * the Scheduler and the engine consumes it; the simulator consumes it too, off the
 * offer's `targetSoc` field, and falls back to this class default for exactly the same
 * reason the server does — computing a substitute would transfer ownership of the
 * decision at the moment the owning service cannot contest it.
 */
const TARGET_SOC_FALLBACK      = 0.8;

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
  // PHASE 7 — the modelled pack, shared with the server's own charge model.
  PACK_NOMINAL_WH,
  CHARGE_POWER_CURVE,
  CHARGE_CHARGER_CLASS,
  CHARGE_PACK_TEMPERATURE_C,
  CHARGE_CURVE_INTEGRATION_STEPS,
  TARGET_SOC_FALLBACK,
};

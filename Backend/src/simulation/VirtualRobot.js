/**
 * VirtualRobot
 *
 * Behaves identically to a physical robot:
 *   - Connects as a Socket.IO client (same AUTH / TELEMETRY flow as real hardware)
 *   - Receives TASK_ASSIGN → navigates path → emits TASK_COMPLETE
 *   - Battery drains at real-time rates; level is persisted to Redis every 2 min
 *   - On server restart the last-known battery is restored from Redis (or DB fallback)
 *   - Speed uses an EMA-smoothed model: realistic 1.4 m/s ± jitter (no per-tick random jumps)
 *
 * ── PHASE 4: the agent-side protocol contract (§10.3.1, §11.5, §23.3) ────────
 *
 * The execution plan makes this file the **reference implementation and the
 * conformance fixture** for the agent protocol: "real-robot firmware must implement
 * the same contract. Mitigation: VirtualRobot is the reference implementation and the
 * conformance fixture." What firmware must implement is therefore what is implemented
 * here, and the four obligations are:
 *
 *   1. **Durable deduplication state, written before any externally observable
 *      effect** (§11.5). "Committed to non-volatile storage **before** the command's
 *      effect becomes externally observable — before motion, before a compartment
 *      actuates, before an ACK is sent. Acting first and recording after reopens the
 *      exact window the state exists to close."
 *   2. **Two fence scopes, compared differently** (§10.3.1). A mission command is
 *      rejected at `fence ≤ highest_seen[commitment_id]` — *per commitment id*, never
 *      against a maximum across the agent's commitments — or at `fence ≤ fence_floor`.
 *      An agent command is rejected at `authority_epoch < highest_seen_authority`.
 *   3. **Queries are never fenced** (§10.3.1 row 3). "Always answered."
 *   4. **A bounded autonomous continuation limit** (§18.5). An agent that loses
 *      supervision continues for at most `agent.autonomous_continuation_limit` and
 *      then halts at the safest reachable location.
 *
 * The rejection rules are not restated here: they are imported from
 * `engine/commitment/fencing.js`, which is where §10.3.1 was written once in Phase 3
 * precisely so that the server and the agent could not drift apart. A firmware author
 * porting this file ports that module's three predicates.
 *
 * The legacy `TASK_ASSIGN` / `COMMAND` / `STOP` path below is untouched and stays live
 * until the Phase 15 cutover.
 *
 * ── STEP 4: known limitations, found and deliberately NOT fixed ──────────────
 *
 * Recorded here rather than in a report nobody re-reads, because each is a real behaviour
 * somebody will eventually meet and wonder about. None is a Step 4 regression; each was
 * either pre-existing or is out of Step 4's scope, and none is needed for the runtime
 * behaviour Step 4 is about.
 *
 *   1. **A server-initiated disconnect is not recovered from.** Reconnection here is
 *      socket.io-client's, and it deliberately does *not* retry when the server sends a
 *      namespace-disconnect packet — the client reports `io server disconnect` and stops.
 *      `robot.handler.js` takes that path on an AUTH refusal and on session supersession, so
 *      a simulated agent dismissed that way stays down until the engine restarts it. An
 *      involuntary transport drop — the field failure — *is* recovered from, and
 *      `tools/verify/step4SimulationBehaviour.js` proves it against the real library.
 *      Fixing the other case means deciding a retry policy for an agent the server has just
 *      refused, which is a protocol decision and not a simulator one.
 *   2. **A robot with an active task never docks.** `_tick` enters charging only when
 *      `phase === null`, so an agent mid-mission drives on at `BATTERY_MIN` (5 %) instead of
 *      charging. Asserted as a test so the behaviour is deliberate and visible.
 *   3. **`dedup.tombstones` is never pruned**, though its own comment says it is retained for
 *      `agent.dedup_retention` and then pruned. It grows with the number of settled
 *      commitments for the life of the process. (Step 4's own `_appliedCommands` map *is*
 *      pruned, on the same window — see `_pruneAppliedCommands`.)
 *   4. **§18.5's continuation limit never fires on the legacy path.** `_lastSupervisedAt` is
 *      set only when a §10.3.1 command is applied, so an agent driving a legacy
 *      `TASK_ASSIGN` has no supervision timestamp and is never halted by the limit. That is
 *      the documented meaning of `null` ("not yet supervised"), not an oversight, but it
 *      means the bound is inert for exactly the path still in production use.
 *   5. **Battery persistence is counted in ticks, not seconds.** `BATTERY_PERSIST_TICKS` is
 *      60, which is two minutes only at the default cadence; a configured tick period
 *      changes the wall-clock snapshot interval with it. Harmless, and worth knowing before
 *      reading the "every 2 minutes" comment as a guarantee.
 *   6. **`/api/simulator/start|stop|reset` remain fleet-wide** and are gated by `authUser`
 *      alone — a pre-existing Step 2/3 limitation, unchanged here and documented in
 *      `routes/simulator.routes.js`.
 */

const { io: ioClient } = require("socket.io-client");
const crypto = require("crypto");
const rootLogger = require("../config/logger");
const { haversineMeters } = require("../utils/distance");

const {
  SESSION_TTL_SEC,
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
  CHARGING_WAIT_MS,
  CHARGING_RATE_PER_TICK,
  CHARGING_INTERRUPT_BATTERY,
  BATTERY_PERSIST_TICKS,
  OBSTACLE_PROBABILITY,
  PICKUP_WAIT_MS,
  DROP_WAIT_MS,
  RECONNECT_DELAY_MS,
  // PHASE 7 — §14.6's modelled pack.
  PACK_NOMINAL_WH,
  CHARGE_POWER_CURVE,
  CHARGE_CHARGER_CLASS,
  CHARGE_PACK_TEMPERATURE_C,
  CHARGE_CURVE_INTEGRATION_STEPS,
  TARGET_SOC_FALLBACK,
} = require("./constants");

const simulationPolicy = require("./simulationPolicy");
// STEP 4 — the simulated thermal environment. Ambient inside the owner's declared
// 25–35 °C band, and a pack temperature that responds to load and relaxes toward ambient.
const { createSimulatedEnvironment } = require("./simulatedEnvironment");
// STEP 5 — consumption through §14.2's model. This module holds no energy equation; it
// builds the leg profile and calls the same `legEnergyWh` the assignment engine calls.
const simulatedEnergy = require("./simulatedEnergy");
// STEP 4 — one deterministic pseudo-random stream per robot, so a run is reproducible and
// two robots are not coupled through a shared generator. See `random.js` for why the
// global `Math.random()` was a correctness problem and not merely an aesthetic one.
const { createRandom, forkSeed } = require("./random");

const fencing = require("../engine/commitment/fencing");
const sequence = require("../engine/dispatch/sequence");
const commandSigning = require("../engine/security/commandSigning");

// PHASE 7 — §14.6 requires both sides to reason from identical inputs. The simulator
// therefore integrates the **same module** the server plans charge durations with,
// rather than a second implementation of the same curve that a future edit could
// desynchronise. Importing it is the point, not an optimisation.
const chargeCurve = require("../engine/energy/chargeCurve");

// Redis key for persisting battery across restarts (separate from live-state key)
const batteryKey = (robotId) => `vr:battery:${robotId}`;
const BATTERY_KEY_TTL = 48 * 3600; // 48 h — survives overnight / weekend downtime

// PHASE 4 — the agent's **non-volatile** deduplication store (§11.5).
//
// Redis stands in for the agent's flash. The distinction that matters is not the
// technology but the property: this key survives the process, so a power cycle that
// wipes the in-memory table but leaves this key intact is a *reconnect*, and one that
// loses both is a *reset* — which the generation counter is what makes detectable.
//
// Retention is `agent.dedup_retention` (default 30 min, validated at publish to be at
// least `dispatch.offer_ttl + dispatch.max_delivery_delay`): "Below the sum of offer
// TTL and maximum delivery delay, a redelivered command outlives the state that would
// reject it."
const dedupKey = (robotId) => `vr:dedup:${robotId}`;
const DEDUP_KEY_TTL = 1800; // agent.dedup_retention, Appendix A default (30 min)

// §18.5 — `agent.autonomous_continuation_limit`, Appendix A default (15 min). The
// on-agent bound that carries safety while the Commitment Store is unreachable and
// invariant I2 is explicitly suspended. Overridable per instance.
const AUTONOMOUS_CONTINUATION_LIMIT_SEC = 900;

/**
 * Speed jitter for a commissioned unit, as a fraction of its own nominal speed.
 *
 * `SPEED_JITTER` is ±1.5 m/s, which is larger than the entire declared speed of every
 * simulation preset (1.0–1.5 m/s) and would swamp it. Ten per cent of nominal keeps the
 * trace recognisably that unit's.
 *
 * @structural a DEVELOPMENT simulation figure, not a measured speed variance
 */
const SPEED_JITTER_FRACTION_OF_NOMINAL = 0.1;

/**
 * Is this path something the agent can actually traverse?
 *
 * Two waypoints is the floor, and it is not an arbitrary one: `_advanceTask` ends a
 * phase at `pathIndex >= activePath.length - 1`, which a zero- or one-point path
 * satisfies on the *first* tick. Such a path does not describe a short journey; it
 * describes no journey at all, and the phase machine walks straight through
 * TO_PICKUP → WAIT_PICKUP → TO_DROP → WAIT_DROP and emits `TASK_COMPLETE` for a
 * mission during which the robot never moved.
 *
 * @param {unknown} path
 * @returns {boolean}
 */
function isTraversablePath(path) {
  if (!Array.isArray(path) || path.length < 2) return false;
  return path.every(
    (point) =>
      point !== null &&
      typeof point === "object" &&
      Number.isFinite(point.lat) &&
      Number.isFinite(point.lon),
  );
}

/**
 * The dwell an agent holds at a stop, by stop type.
 *
 * `CHARGE` is present because §14.6's Charging Scheduler can insert one into a plan, and
 * an agent that did not know the type would drive to it and leave immediately. The dwell
 * used is the existing docking delay.
 *
 * **No charge is delivered at a CHARGE stop by this batch.** The Charging Scheduler is
 * out of scope here, and simulating a charge session against a target SoC nobody
 * published would be inventing the Scheduler's decision. The stop is *executed* — driven
 * to, dwelt at, departed from — and `_chargeStopsVisited` records that it happened, so
 * the gap is visible rather than silently absorbed.
 *
 * @structural the per-stop-type dwell, in milliseconds
 */
const STOP_DWELL_MS = Object.freeze({
  PICKUP: PICKUP_WAIT_MS,
  DROP: DROP_WAIT_MS,
  CHARGE: CHARGING_WAIT_MS,
});

/**
 * The phase names a stop of each type presents while travelling to it and while waiting
 * at it.
 *
 * The existing four names are preserved exactly. `getStatus().phase` is read by the
 * dashboard and asserted by several suites, and a generalisation that renamed
 * `TO_PICKUP` to something uniform would be a gratuitous break — the phase vocabulary is
 * part of this file's observable contract, not an implementation detail.
 *
 * @structural the phase vocabulary
 */
const STOP_PHASES = Object.freeze({
  PICKUP: Object.freeze({ moving: "TO_PICKUP", waiting: "WAIT_PICKUP" }),
  DROP: Object.freeze({ moving: "TO_DROP", waiting: "WAIT_DROP" }),
  CHARGE: Object.freeze({ moving: "TO_CHARGE", waiting: "WAIT_CHARGE" }),
});

/** The phases used for a stop whose type the offer did not state. */
const UNTYPED_STOP_PHASES = Object.freeze({ moving: "TO_STOP", waiting: "WAIT_STOP" });

/**
 * @param {string|null|undefined} stopType
 * @returns {{ moving: string, waiting: string }}
 */
function phasesForStopType(stopType) {
  return STOP_PHASES[stopType] || UNTYPED_STOP_PHASES;
}

/**
 * Can this mission be executed, or would accepting it be a claim the agent cannot honour?
 *
 * The agent is the authority on its own physical condition (§11.2), and "I was handed
 * no route to drive" is a condition it is the authority on. Naming *which* part of the
 * mission is missing is deliberate: a missing producer must be diagnosable from the
 * refusal alone, because the whole point of failing closed here is that no downstream
 * evidence of the mission is ever produced.
 *
 * ── STEP 8: every stop is checked, not the first two ────────────────────────
 * This took a `{ pathToPickup, pathToDrop }` pair and therefore could not see a third
 * stop at all. It now takes the whole sequence, so a plan with a charging stop inserted
 * between pickup and drop is validated in full — and a plan whose *third* stop has no
 * route is refused rather than accepted and silently truncated.
 *
 * Each stop carries the `label` the refusal names it by. A two-stop mission keeps the
 * exact strings the previous implementation produced (`pathToPickup`, `pathToDrop`), so
 * every existing assertion on `NO_EXECUTABLE_PATH:…` still holds; a longer mission names
 * the offending stops by sequence and type.
 *
 * @param {Array<{ path: unknown, label: string }>} stops
 * @returns {{ executable: boolean, reason: string|null }}
 */
function assessExecutability(stops) {
  const sequence = Array.isArray(stops) ? stops : [];

  // A mission with no stops is not a short mission; it is not a mission. Refused by name
  // rather than treated as trivially executable — the phase machine would otherwise run
  // straight to completion and report a delivery that never happened.
  if (sequence.length === 0) {
    return { executable: false, reason: "NO_EXECUTABLE_PATH:noStops" };
  }

  const missing = [];
  for (const stop of sequence) {
    if (!isTraversablePath(stop.path)) missing.push(stop.label);
  }

  if (missing.length === 0) return { executable: true, reason: null };
  return { executable: false, reason: `NO_EXECUTABLE_PATH:${missing.join(",")}` };
}

/**
 * The internal stop sequence for a mission, from whichever form the mission arrived in.
 *
 * Two producers, one shape:
 *
 *   * An **offer** carries `stopSequence` — the plan's stops, each with its own
 *     `stopType` and its own `path` from `executionGeometry.attachStopPaths`. Any length.
 *   * A legacy **`TASK_ASSIGN`** carries `pathToPickup` / `pathToDrop`, which is exactly a
 *     two-stop PICKUP→DROP mission and is normalised to one here.
 *
 * Normalising at the boundary is what lets the phase machine below have a single
 * implementation. The legacy labels are preserved for the two-stop case so refusal
 * strings do not move.
 *
 * @param {object} input
 * @returns {Array<{ sequence: number, stopType: string|null, path: object[], label: string,
 *                   dwellMs: number }>}
 */
function buildStopSequence(input) {
  const source = input || {};

  if (Array.isArray(source.stopSequence) && source.stopSequence.length > 0) {
    const sequence = source.stopSequence;
    // ── Why a two-stop plan keeps the legacy labels ───────────────────────────
    // A two-stop mission *is* the pickup→drop mission the previous implementation
    // assumed, and `NO_EXECUTABLE_PATH:pathToPickup,pathToDrop` is a string the server
    // side, the tests and the operator-facing logs all already read. Generalising the
    // labels for that case would have renamed a refusal without changing its meaning,
    // which is churn with a compatibility cost and no benefit. Longer plans — the ones
    // that could not previously be expressed at all — get precise per-stop labels.
    const legacyShape = sequence.length === 2;
    return sequence.map((stop, index) => {
      const stopType = typeof stop?.stopType === "string" ? stop.stopType.toUpperCase() : null;
      const ordinal = Number.isFinite(stop?.sequence) ? stop.sequence : index;
      return {
        sequence: ordinal,
        stopType,
        path: Array.isArray(stop?.path) ? stop.path : [],
        label: legacyShape
          ? (index === 0 ? "pathToPickup" : "pathToDrop")
          : `stop${ordinal}:${stopType || "UNTYPED"}`,
        dwellMs: STOP_DWELL_MS[stopType] ?? DROP_WAIT_MS,
      };
    });
  }

  // The legacy two-path form. Both stops are always produced, even when a path is empty,
  // so `assessExecutability` can name the missing half exactly as it always did.
  return [
    {
      sequence: 0,
      stopType: "PICKUP",
      path: Array.isArray(source.pathToPickup) ? source.pathToPickup : [],
      label: "pathToPickup",
      dwellMs: PICKUP_WAIT_MS,
    },
    {
      sequence: 1,
      stopType: "DROP",
      path: Array.isArray(source.pathToDrop) ? source.pathToDrop : [],
      label: "pathToDrop",
      dwellMs: DROP_WAIT_MS,
    },
  ];
}

class VirtualRobot {
  constructor({
    robotId,
    lat,
    lon,
    logger,
    kv,
    dbBattery,
    // PHASE 4 — the agent-side protocol's two deployment inputs. Both are injected
    // rather than read from the environment: firmware receives them at commissioning,
    // and a simulator that read `process.env` could not model two fleets with
    // different keys in one process.
    commandSigningKey,
    autonomousContinuationLimitSeconds,
    // STEP 1 — the target row's simulation discriminator, carried explicitly.
    //
    // Not defaulted to `true` "because this is a simulator". The instance is constructed
    // *for* a `Robot` row, and whether that row is a simulated unit is a fact about the
    // row, not about the class. Undefined therefore means "not established", which
    // `simulationPolicy.isSimulatedRobot` reads as physical and `commission()` refuses.
    simulated,
    // STEP 4 — the tunables from `simulationConfig`. Each falls back to the module
    // constant, so an unconfigured instance behaves exactly as it did before Step 4 and
    // the constants file remains the statement of the default fixture.
    telemetryIntervalMs,
    speedBaseMs,
    speedJitter,
    obstacleProbability,
    initialBattery,
    randomSeed,
    // ── STEP 3: the unit's own commissioned specification ─────────────────────
    //
    // The single most important argument in this constructor. Before it, every simulated
    // robot moved at `SPEED_BASE_MS` (5.56 m/s) and drained a pack of `PACK_NOMINAL_WH`
    // (1000 Wh) regardless of what it had been commissioned as — so a unit specified at
    // 1.2 m/s with a 3 kg payload limit drove at four and a half times its declared speed,
    // and the specification the operator entered was decoration.
    //
    // Supplied by `SimulationEngine.addRobot` from the persisted rows: `Robot.massKg`,
    // `MobilityModel.speedModel.nominalSpeedMps`, `MobilityModel.kinematicLimits.maxSpeedMps`,
    // `EnergyModel.packNominalWh`, `ContainerModel.totalMassLimitKg`. There is deliberately
    // no simulator-side copy of any of them: this object is read, never written.
    //
    // `null`/absent means "not commissioned", and each field then falls back to the module
    // constant it always used. A fallback never overrides a value that IS present — see
    // `_resolveSpecification`.
    specification,
    // ── STEP 3: the unit's persisted pack state (`BatteryState`) ──────────────
    // κ and its sample count, and the last state of charge. Read, never invented: κ is 1
    // with a sample count of 0 for an uncalibrated unit, which is what
    // `agentEnergyProvisioning` writes and what this reads back.
    batteryState,
    // ── STEP 5: the class's §14.2 coefficients (`EnergyModelParams`) ──────────
    // In `legEnergyWh`'s own naming, as `domain/mappers/decisionInputs` produces them.
    // Null — or a row whose coefficients are all null, which is what this deployment
    // actually has — makes the model refuse, which is the correct fail-closed outcome.
    energyModelParams,
  } = {}) {
    this.robotId = robotId;
    this.lat = lat;
    this.lon = lon;
    this.simulated = simulated;

    // ── STEP 3: resolve the specification before anything reads a speed ───────
    // Done first because the movement and energy fields below are derived from it.
    this._specification = this._resolveSpecification(specification);
    this._batteryState = batteryState && typeof batteryState === "object" ? batteryState : null;
    this._energyModelParams =
      energyModelParams && typeof energyModelParams === "object" ? energyModelParams : null;

    // ── STEP 4: the tick period and the movement/obstacle model, per instance ──
    // Held on the instance rather than read from the module so that two robots in one
    // process can be configured differently — which is what makes a mixed-cadence demo
    // possible — and so a test can drive a robot without a two-second wall-clock wait.
    this._telemetryIntervalMs =
      Number.isFinite(telemetryIntervalMs) && telemetryIntervalMs > 0
        ? telemetryIntervalMs
        : TELEMETRY_INTERVAL_MS;
    // ── STEP 3: the speed envelope, commissioned value first ──────────────────
    //
    // Precedence is explicit and is the whole fix: an operator-configured tunable, then
    // the unit's **commissioned** nominal speed, then the fleet constant. The middle term
    // is new; without it `SPEED_BASE_MS` won unconditionally.
    //
    // The clamps matter as much as the base, and this is the part that is easy to miss.
    // `SPEED_MIN_MS` is 5.0 m/s — a floor that exists so a demo robot is visibly moving —
    // and applying it to a unit commissioned at 1.2 m/s would drag it back up to 5.0 on
    // every tick, leaving the base correct and the actual speed wrong. So a commissioned
    // unit's envelope is derived from its own two declared speeds: the ceiling is its
    // kinematic limit (`maxSpeedMps`, which commissioning requires), and the floor is its
    // nominal less the jitter, never below zero.
    const commissionedSpeed = this._specification.normalSpeedMps;
    const commissionedMaxSpeed = this._specification.maxSpeedMps;

    this._speedBaseMs = Number.isFinite(speedBaseMs) && speedBaseMs >= 0
      ? speedBaseMs
      : commissionedSpeed !== null
        ? commissionedSpeed
        : SPEED_BASE_MS;

    // The fleet jitter (±1.5 m/s) is larger than the entire declared speed of every
    // simulation preset, so a commissioned unit uses a jitter proportional to its own
    // nominal speed instead. A configured jitter still wins, and an uncommissioned unit
    // still gets the constant.
    this._speedJitter = Number.isFinite(speedJitter) && speedJitter >= 0
      ? speedJitter
      : commissionedSpeed !== null
        ? commissionedSpeed * SPEED_JITTER_FRACTION_OF_NOMINAL
        : SPEED_JITTER;

    if (commissionedSpeed !== null) {
      this._speedMaxMs = commissionedMaxSpeed !== null
        ? commissionedMaxSpeed
        : this._speedBaseMs + this._speedJitter;
      this._speedMinMs = Math.max(0, this._speedBaseMs - this._speedJitter);
    } else {
      this._speedMaxMs = SPEED_MAX_MS;
      this._speedMinMs = SPEED_MIN_MS;
    }
    this._obstacleProbability =
      Number.isFinite(obstacleProbability) && obstacleProbability >= 0
        ? obstacleProbability
        : OBSTACLE_PROBABILITY;

    // ── STEP 4: two independent deterministic streams ─────────────────────────
    // Seeded from the robot's own identifier unless a seed is supplied, so SIM-A's numbers
    // are the same whether it runs alone or beside four others. Two streams, not one:
    // sharing would make the speed trace depend on whether an obstacle was reported.
    this._randomSeed = Number.isFinite(randomSeed) ? randomSeed >>> 0 : null;
    const seedBasis = this._randomSeed === null ? String(robotId) : this._randomSeed;
    this._speedRandom = createRandom(forkSeed(seedBasis, "speed"));
    this._obstacleRandom = createRandom(forkSeed(seedBasis, "obstacle"));

    // ── STEP 4: this robot's thermal environment ──────────────────────────────
    // A third independent stream, forked from the same basis, so the ambient sensor
    // offset does not shift the speed or obstacle traces and vice versa. Ambient stays
    // inside the owner's declared 25–35 °C band by construction; pack temperature is
    // integrated per tick from load.
    this._environment = createSimulatedEnvironment({
      robotId,
      seed: this._randomSeed === null ? undefined : this._randomSeed,
    });
    this._ambientC = null;
    this._packC = null;

    // ── STEP 5: the energy accounting this tick's consumption is computed from ──
    // Each is a quantity the simulator genuinely observes about itself. `_stopStartCycles`
    // counts stop-and-move transitions, which is §14.2's `n_stop_start_cycles` measured by
    // the thing doing the stopping. The three second counters are wall-clock over the
    // instance's own ticks.
    this._energyBasis = null;
    this._energyMissing = [];
    this._lastTickWh = null;
    this._cumulativeWh = 0;
    this._stopStartCycles = 0;
    this._movingSeconds = 0;
    this._dwellSeconds = 0;
    this._totalSeconds = 0;
    this._wasMovingLastTick = false;

    // ── STEP 4: the telemetry frame counter ───────────────────────────────────
    // Monotonic, per robot, starting at 1 for the first frame of the process. It makes a
    // dropped or duplicated frame visible to anything reading the stream, and it is the
    // simulator's own counter — nothing on the server consumes it, and it is not evidence
    // of anything beyond how many frames this instance has emitted.
    this._telemetrySequence = 0;

    // ── STEP 4: legacy operator-command idempotency ───────────────────────────
    // `commandId` → the moment it was applied. The §10.3.1 command surface has its own
    // durable deduplication; the legacy `COMMAND` path had none, so a redelivery applied
    // the effect twice. See `_onCommand`.
    this._appliedCommands = new Map();

    // Battery starts at the last persisted level once commission() runs.
    // dbBattery is the DB fallback passed in by SimulationEngine.
    //
    // ── STEP 4: where a configured `initialBattery` sits in that order ─────────
    // **Last**, not first. The restore order is Redis → DB → configured → 100, so a
    // configured value replaces the hard-coded 100 and nothing else. The alternative —
    // letting configuration win — would make a restart reset the pack to its starting level
    // and so break the persistence §6 requires; a robot that recharged itself every time
    // the process restarted would also be the second time this programme had a simulator
    // assert a battery level nothing measured. So it is the *fresh robot's* starting
    // level, which is the case a demo actually needs to pin.
    this.battery = 100;
    this._dbBattery = typeof dbBattery === "number" ? dbBattery : null;
    this._initialBattery =
      Number.isFinite(initialBattery) && initialBattery >= 1 && initialBattery <= 100
        ? initialBattery
        : null;

    this.speed  = 0;
    this.status = "IDLE";
    this.log    = logger || console;

    // ── Battery persistence ────────────────────────────────────────────────
    // kv is stored so _tick() can write the periodic battery snapshot.
    this.kv = kv || null;
    this._batteryPersistTicks = 0;

    // ── Speed model ────────────────────────────────────────────────────────
    // EMA-smoothed speed — starts at rest, ramps up as robot begins moving.
    this._targetSpeed = this._speedBaseMs;

    // ── Task navigation ────────────────────────────────────────────────────
    this.task        = null;   // { taskId, stops[], payloadMassKg }
    // STEP 8 — phase names are derived from the current stop's type, so an ordinary
    // pickup→drop mission still shows TO_PICKUP | WAIT_PICKUP | TO_DROP | WAIT_DROP, and a
    // charging stop adds TO_CHARGE | WAIT_CHARGE.
    this.phase       = null;
    // Which stop of the mission sequence is being executed.
    this.stopIndex   = 0;
    // Whether a pickup has completed and no drop has yet — the custody state the energy
    // model's payload mass term reads.
    this._carryingPayload = false;
    this._chargeStopsVisited = 0;
    this.pathIndex   = 0;
    this.waitUntil   = null;
    this.activePath  = null;
    this.distanceTravelled = 0;
    this._heading    = null;   // degrees clockwise from north (for marker rotation)

    // ── Charging ───────────────────────────────────────────────────────────
    this._chargingPhase    = null;   // null | 'WAITING' | 'CHARGING'
    this._chargeWaitUntil  = null;
    this._pendingResume    = null;   // TASK_ASSIGN payload deferred while charging on low battery

    // ── PHASE 7: §14.6's inputs, as the agent receives them ────────────────
    // Both arrive on the offer and neither is computed here. §14.6: "the *agent*
    // receives the reserve parameters and the target SoC as part of the offer, so the
    // two sides reason from identical inputs by construction rather than by a shared
    // constant that a future edit could desynchronise." Null until an offer supplies
    // them, which is what makes the legacy path's behaviour unchanged.
    this._publishedTargetSoc     = null;
    this._energyReserveParams    = null;

    // ── Socket ────────────────────────────────────────────────────────────
    this.socket             = null;
    this.sessionToken       = null;
    this.connected          = false;
    this._handlersRegistered = false;
    // ── STEP 4: *which* socket the handlers are attached to ───────────────────
    // The boolean above cannot answer the question that matters. socket.io-client reuses
    // one `Socket` object across reconnections, so "have I registered?" has to mean "have
    // I registered **on this socket**" — see `_registerHandlers` for the duplicate-delivery
    // defect that reading it as a bare boolean produced.
    this._handlerSocket     = null;
    // How many distinct socket objects this instance has had. A reconnection that reuses the
    // existing `Socket` does not advance it; `connect()` does. It is what lets a verification
    // tool distinguish "socket.io reconnected on the same emitter" from "a new emitter was
    // built", which is the premise the registration fix rests on.
    this._socketGeneration  = 0;
    this._timer             = null;

    // ── PHASE 4: the agent-side protocol state (§10.3.1, §11.5) ───────────
    //
    // Two scopes, held separately, because §10.3.1 compares them differently. The
    // per-commitment table is a Map keyed by commitment id — never reduced to a
    // maximum, which is the defect §10.3.1 was revised to remove.
    this.dedup = {
      dedupStateGeneration: 0n,
      authorityEpoch: 0n,
      fenceFloor: 0n,
      /** commitmentId → { fence, sequence } */
      highWaterMarks: new Map(),
      /** Settled commitments, retained for `agent.dedup_retention` then pruned. */
      tombstones: new Map(),
    };
    this._dedupLoaded = false;
    // §11.5 — the dedup state is read, decided against, written, and persisted as one
    // indivisible step. Commands arrive as independent socket events, so two of them can
    // be in flight across the `await` on the durable write; this promise chain is what
    // makes that impossible. See `_withDedupLock`.
    this._dedupCriticalSection = Promise.resolve();
    this.commandSigningKey = commandSigningKey || null;
    this.offers = new Map();
    // §18.5 — the last moment supervision was observed. `null` means "not yet
    // supervised", which is the state a freshly-commissioned agent is in and is not a
    // reason to halt.
    this._lastSupervisedAt = null;
    this._autonomousContinuationLimitSeconds =
      autonomousContinuationLimitSeconds || AUTONOMOUS_CONTINUATION_LIMIT_SEC;
    this.protocolRejections = [];
  }

  /**
   * STEP 3 — normalise the commissioned specification into the five values this agent
   * actually reads.
   *
   * ── Absence is `null`, and `null` never overrides ───────────────────────────
   * Each field is `null` when the unit has no commissioned value for it, and every reader
   * treats `null` as "fall back to the module constant". The asymmetry is the point: a
   * fallback fills a gap, and a *present* commissioned value is never replaced by one. A
   * simulator that let a constant win over a persisted row would be the same defect this
   * step exists to remove, one layer down.
   *
   * There is no second source of truth here. Nothing in this object is written anywhere,
   * no simulator-side model persists it, and the accessor is called once in the
   * constructor — so a specification edit takes effect by rebuilding the agent, which is
   * what `SimulationEngine.removeRobot`/`addRobot` already does.
   *
   * @param {object|null|undefined} specification
   * @returns {{ massKg: number|null, normalSpeedMps: number|null, maxSpeedMps: number|null,
   *             packNominalWh: number|null, payloadCapacityKg: number|null }}
   */
  _resolveSpecification(specification) {
    const source = specification && typeof specification === "object" ? specification : {};
    const number = (value) => (Number.isFinite(value) && value > 0 ? value : null);
    return {
      massKg: number(source.massKg),
      normalSpeedMps: number(source.normalSpeedMps),
      maxSpeedMps: number(source.maxSpeedMps),
      packNominalWh: number(source.packNominalWh),
      payloadCapacityKg:
        Number.isFinite(source.payloadCapacityKg) && source.payloadCapacityKg >= 0
          ? source.payloadCapacityKg
          : null,
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Seed Redis with session token and restore the last-known battery level.
   *
   * Priority:  Redis vr:battery key  →  DB value  →  100 % (full charge)
   *
   * The robot record in PostgreSQL was already created by the Commission API
   * before addRobot() is called — do NOT touch DB here.
   *
   * ── STEP 1: this method may only run for an explicitly simulated unit ──────
   *
   * What it writes is the reason. `session:{robotId}` is the credential a robot presents
   * at AUTH; minting a fresh one here **overwrites** whatever the physical unit holds, so
   * calling this for a physical robot silently substitutes simulator-generated credentials
   * for the real ones and severs the hardware's ability to authenticate. `robot:{robotId}`
   * and the `robots:all` set are the live-state surface the dashboard and DTARO read, so
   * writing them asserts a position, a battery and an `IDLE` status for a unit nobody has
   * heard from.
   *
   * Both are legitimate for a simulated agent — it *is* the robot, so its session and its
   * telemetry are the real ones — and both are fabrications for a physical one. The guard
   * is therefore on the target's identity, not on the caller's intent, and it **throws**
   * rather than returning quietly: a caller that got here with a physical robot has a
   * defect, and the loudest safe outcome is to refuse before the first `kv.set`.
   */
  async commission(kv) {
    if (!simulationPolicy.isSimulatedRobot(this)) {
      const err = new Error(
        `Refusing to run simulator session setup for ${this.robotId}: the target Robot is not ` +
          "marked simulated=true. A VirtualRobot mints session:{robotId} and writes the live-state " +
          "key, which for a physical unit would replace its credentials and fabricate its telemetry.",
      );
      err.code = "ROBOT_NOT_SIMULATED";
      throw err;
    }

    this.kv           = kv;
    this.sessionToken = crypto.randomUUID();

    // 1) Session token (enables AUTH on connect)
    await kv.set(`session:${this.robotId}`, this.sessionToken, { ex: SESSION_TTL_SEC });

    // 2) Restore battery
    let source = "default (100%)";
    let restoredBattery = null;

    try {
      const raw = await kv.get(batteryKey(this.robotId));
      if (raw !== null && raw !== undefined) {
        const v = parseFloat(raw);
        if (Number.isFinite(v) && v >= 1 && v <= 100) {
          restoredBattery = v;
          source = `Redis (${v.toFixed(1)}%)`;
        }
      }
    } catch { /* Redis unavailable — fall through */ }

    if (restoredBattery === null && this._dbBattery !== null) {
      restoredBattery = this._dbBattery;
      source = `DB (${this._dbBattery.toFixed(1)}%)`;
    }

    // STEP 4 — a configured `initialBattery` is the *last* fallback, replacing the
    // hard-coded 100 %. It never overrides a persisted level: see the constructor for why
    // letting it do so would break the restart persistence §6 requires.
    if (restoredBattery === null && this._initialBattery !== null) {
      restoredBattery = this._initialBattery;
      source = `configured initialBattery (${this._initialBattery.toFixed(1)}%)`;
    }

    this.battery = restoredBattery !== null ? restoredBattery : 100;

    // 3) Seed live-state key so DTARO / dashboard see the robot immediately
    await Promise.all([
      kv.set(
        `robot:${this.robotId}`,
        JSON.stringify({
          lat:        this.lat,
          lon:        this.lon,
          battery:    Math.round(this.battery),
          status:     "IDLE",
          speed:      0,
          lastSeenAt: Date.now(),
        }),
        { ex: 30 }
      ),
      typeof kv.sadd === "function"
        ? kv.sadd("robots:all", this.robotId)
        : Promise.resolve(),
    ]);

    this.log.info(`[VR] ${this.robotId} commissioned — battery restored from ${source}`);
  }

  connect(serverUrl) {
    // A fresh `Socket` carries none of the previous one's listeners, so the registration
    // record is cleared here rather than on disconnect. Clearing it on *disconnect* was the
    // defect `_registerHandlers` documents.
    this._handlerSocket = null;
    this._handlersRegistered = false;
    this._socketGeneration += 1;

    this.socket = ioClient(serverUrl, {
      reconnection:         true,
      reconnectionDelay:    RECONNECT_DELAY_MS,
      reconnectionDelayMax: 10_000,
      reconnectionAttempts: Infinity,
      transports:           ["websocket"],
    });

    this.socket.on("connect", () => {
      this.connected = true;
      this.log.info(`[VR] ${this.robotId} connected — sending AUTH`);
      // §11.5 — the dedup high-water mark rides on AUTH, on **every** session
      // establishment. The state is loaded from non-volatile storage first: a session
      // that reported an in-memory table would report a table it had just lost.
      this._authWithDedupReport().catch((e) => this.log.error(`[VR] ${this.robotId} AUTH failed`, e?.message));
    });

    this.socket.on("disconnect", (reason) => {
      this.connected = false;
      // The registration record is deliberately NOT cleared. The listeners are still
      // attached to this same `Socket` object and will serve the next session on it; saying
      // otherwise is what made the agent register a second copy of every handler on
      // reconnect. See `_registerHandlers`.
      this.log.info(`[VR] ${this.robotId} disconnected (${reason})`);
    });

    this.socket.on("AUTH_SUCCESS", ({ token, dedup } = {}) => {
      if (token) this.sessionToken = token;
      this.log.info(`[VR] ${this.robotId} AUTH_SUCCESS`);
      // Adopt the server's handshake outcome **before** registering handlers, so no
      // command can be applied under an authority the server has already superseded.
      // Both steps are synchronous, which is what keeps registration on the same tick
      // as it was before Phase 4 — an await here would defer registration by a
      // microtask and drop any event that arrived inside it.
      this.adoptDedupAcknowledgement(dedup);
      this._registerHandlers();
      this.persistDedupState().catch(() => {});
    });

    // Backward-compatible alias. The server emits AUTH_SUCCESS *and* AUTH_OK for the same
    // handshake, so this guard is what keeps one session from adopting the acknowledgement
    // twice — and it has to ask about this socket, for the reason above.
    this.socket.on("AUTH_OK", ({ token, dedup } = {}) => {
      if (token && this._handlerSocket !== this.socket) {
        this.sessionToken = token;
        this.adoptDedupAcknowledgement(dedup);
        this._registerHandlers();
        this.persistDedupState().catch(() => {});
      }
    });

    this.socket.on("AUTH_REQUIRED", () => {
      this._authWithDedupReport().catch(() => {});
    });
  }

  /**
   * AUTH, carrying §11.5's deduplication high-water mark.
   *
   * The state is loaded from non-volatile storage on the first call — which is where a
   * power cycle becomes visible: a wiped store means `loadDedupState` creates a fresh
   * one and advances the generation, and the report the server receives therefore
   * carries a generation it has not seen before.
   */
  async _authWithDedupReport() {
    if (!this._dedupLoaded) await this.loadDedupState();

    // ── STEP 4: the socket may be gone by the time the load resolves ───────────
    // `loadDedupState` awaits non-volatile storage, and an agent can be stopped inside that
    // await — a shutdown, a decommission, an operator pressing stop. `stop()` nulls the
    // socket, so the emit below then threw a TypeError that surfaced as
    // "AUTH failed: Cannot read properties of null (reading 'emit')": an alarming message
    // for an ordinary, correct shutdown. Nothing was broken by it, but an error log that
    // cries wolf during normal operation is how a real one gets ignored.
    if (!this.socket) {
      this.log.info(`[VR] ${this.robotId} AUTH abandoned — the agent was stopped while loading dedup state`);
      return;
    }

    this.socket.emit("AUTH", {
      robotId: this.robotId,
      token: this.sessionToken,
      dedupState: this.dedupReport(),
    });
  }

  /**
   * Attach the command and task listeners — **once per socket**.
   *
   * ── STEP 4: the reconnect duplicate-delivery defect ─────────────────────────
   * This used to guard on a bare `_handlersRegistered` boolean that the `disconnect`
   * handler set back to `false`. The reasoning was that a disconnected agent has no
   * handlers, and it is wrong about how socket.io-client works: `ioClient()` returns one
   * `Socket` object that *survives* reconnection and re-emits `connect` on the same
   * emitter. So the sequence
   *
   *   connect → AUTH_SUCCESS → register → disconnect → reconnect → AUTH_SUCCESS → register
   *
   * left two copies of every listener on one emitter, three after two drops, and so on.
   * One delivered `COMMAND` was then applied twice and acknowledged twice; one
   * `TASK_ASSIGN` was processed twice; one query answered twice. The §10.3.1 surface
   * absorbed most of it — the duplicate loses on `sequence`, so it is *rejected* rather
   * than applied, which is why this never showed up as a fencing failure — but it inflated
   * the §23.3 rejection counters with self-inflicted rejections, and the legacy operator
   * path had no deduplication at all to absorb anything.
   *
   * Keying the record to the socket instance states the real invariant: these listeners
   * belong to that emitter, for as long as it exists. `connect()` clears it because it
   * creates a new one; `stop()` clears it because it discards one.
   */
  _registerHandlers() {
    if (this._handlerSocket === this.socket) return;
    this._handlerSocket = this.socket;
    this._handlersRegistered = true;

    // ── PHASE 4: the §10.3.1 command surface ────────────────────────────────
    // Each command is its own wire event, so an agent subscribes to the commands it
    // implements and a command it has never heard of is simply not delivered to a
    // handler — rather than arriving inside one opaque envelope whose type field an
    // implementation could forget to switch on.
    for (const command of fencing.MISSION_COMMANDS) {
      this.socket.on(command, (envelope) => this._onMissionCommand(command, envelope));
    }
    for (const command of fencing.AGENT_COMMANDS) {
      this.socket.on(command, (envelope) => this._onAgentCommand(command, envelope));
    }
    for (const command of fencing.QUERY_COMMANDS) {
      this.socket.on(command, (envelope) => this._onQuery(command, envelope));
    }

    this.socket.on("TASK_ASSIGN", (payload) => this._onTaskAssign(payload));
    this.socket.on("REROUTE_ALERT", (payload) => this._onRerouteAlert(payload));

    // Operator commands. The server persists a Command row and dispatches
    // "COMMAND" with the row's id; acknowledging it with COMMAND_ACK is what
    // moves that row from SENT to ACK. Without this listener every operator
    // command against a virtual robot went unanswered and was marked FAILED
    // by the reliability scheduler ~15s later.
    this.socket.on("COMMAND", (payload) => this._onCommand(payload));

    // Direct task-lifecycle stop (task cancellation) — not a tracked Command,
    // no ACK expected.
    this.socket.on("STOP", () => this._applyStop("STOP"));

    // Retained for robots/tooling that still speak the older direct event.
    this.socket.on("RETURN_TO_BASE", () => this._applyReturnToBase("RETURN_TO_BASE"));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 4 — the agent-side protocol contract (§10.3.1, §11.2, §11.5, §23.3)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Load the durable dedup state, or create it and advance the generation.
   *
   * §11.5: the generation is "incremented whenever the state is created, cleared, or
   * found corrupt". All three cases land here, and all three advance it — which is what
   * turns a silent state loss into a signal the server acts on at the next handshake.
   *
   * A *corrupt* record is treated exactly as an absent one, deliberately: an agent that
   * cannot parse its own dedup state cannot assert what it has applied, and salvaging
   * the parseable half would produce a table that is wrong in an unknown way rather
   * than absent in a known one.
   */
  async loadDedupState(kv) {
    const store = kv || this.kv;
    this._dedupLoaded = true;

    let raw = null;
    try {
      raw = store ? await store.get(dedupKey(this.robotId)) : null;
    } catch {
      raw = null;
    }

    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        this.dedup = {
          dedupStateGeneration: BigInt(parsed.dedupStateGeneration),
          authorityEpoch: BigInt(parsed.authorityEpoch),
          fenceFloor: BigInt(parsed.fenceFloor),
          highWaterMarks: new Map(
            Object.entries(parsed.highWaterMarks || {}).map(([id, mark]) => [
              id,
              { fence: BigInt(mark.fence), sequence: mark.sequence },
            ]),
          ),
          tombstones: new Map(Object.entries(parsed.tombstones || {})),
        };
        return this.dedup;
      } catch {
        this.log.warn(`[VR] ${this.robotId} dedup state unreadable — treated as absent (§11.5)`);
      }
    }

    // Created or cleared or corrupt: advance the generation.
    this.dedup = {
      dedupStateGeneration: BigInt(this.dedup.dedupStateGeneration) + 1n,
      authorityEpoch: 0n,
      fenceFloor: 0n,
      highWaterMarks: new Map(),
      tombstones: new Map(),
    };
    await this.persistDedupState();
    this.log.warn(
      `[VR] ${this.robotId} dedup state (re)created — generation ${this.dedup.dedupStateGeneration} (§11.5)`,
    );
    return this.dedup;
  }

  /**
   * Commit the dedup state to non-volatile storage.
   *
   * Awaited by every caller **before** the command's effect becomes observable. That
   * ordering is the requirement, not an optimisation: "Acting first and recording after
   * reopens the exact window the state exists to close."
   */
  async persistDedupState() {
    if (!this.kv) return false;
    const serialised = JSON.stringify({
      dedupStateGeneration: String(this.dedup.dedupStateGeneration),
      authorityEpoch: String(this.dedup.authorityEpoch),
      fenceFloor: String(this.dedup.fenceFloor),
      highWaterMarks: Object.fromEntries(
        [...this.dedup.highWaterMarks].map(([id, mark]) => [id, { fence: String(mark.fence), sequence: mark.sequence }]),
      ),
      tombstones: Object.fromEntries(this.dedup.tombstones),
    });
    try {
      await this.kv.set(dedupKey(this.robotId), serialised, { ex: DEDUP_KEY_TTL });
      return true;
    } catch {
      // A write that failed is a state that is not durable, and the agent must not
      // pretend otherwise: the caller refuses to apply the command.
      return false;
    }
  }

  /** The §11.5 report the agent sends at AUTH. */
  dedupReport() {
    return {
      dedupStateGeneration: String(this.dedup.dedupStateGeneration),
      authorityEpoch: String(this.dedup.authorityEpoch),
      fenceFloor: String(this.dedup.fenceFloor),
      highWaterMarks: Object.fromEntries(
        [...this.dedup.highWaterMarks].map(([id, mark]) => [id, { fence: String(mark.fence), sequence: mark.sequence }]),
      ),
    };
  }

  /**
   * Adopt the server's handshake acknowledgement, **synchronously**.
   *
   * On the reset path the server has advanced the agent's `authority_epoch` and told it
   * the current `fence_floor`; adopting both is §10.3.1's interaction rule applied to a
   * session, and it is what makes a stale offer that escapes server-side suppression
   * still get rejected here.
   *
   * Synchronous on purpose. The in-memory adoption happens before this function
   * returns, so there is no window in which command handlers are live and the agent is
   * still judging fences against the superseded authority — and no window in which
   * handler registration is deferred behind an await, which would drop an event
   * arriving in between. The durable write follows; a command that arrives before it
   * completes is judged against the adopted floor either way, and the write is retried
   * on the next command that touches the state.
   *
   * @returns {boolean} whether an acknowledgement was present to adopt
   */
  adoptDedupAcknowledgement(ack) {
    if (!ack || ack.path === undefined || ack.path === null) return false;
    if (ack.authorityEpoch !== undefined && ack.authorityEpoch !== null) {
      this.dedup.authorityEpoch = BigInt(ack.authorityEpoch);
    }
    if (ack.fenceFloor !== undefined && ack.fenceFloor !== null) {
      this.dedup.fenceFloor = BigInt(ack.fenceFloor);
      // (c) of §10.3.1's interaction rule — discard the per-commitment authority table.
      if (ack.redeliverySuppressed) this.dedup.highWaterMarks = new Map();
    }
    return true;
  }

  /** Adopt and then commit to non-volatile storage. */
  async applyDedupAcknowledgement(ack) {
    if (!this.adoptDedupAcknowledgement(ack)) return false;
    await this.persistDedupState();
    return true;
  }

  /**
   * Run `fn` with exclusive access to the deduplication state.
   *
   * ── Why one lock and not one per commitment id ──────────────────────────────
   * A per-key lock would be enough for mission commands, which touch one entry of
   * `highWaterMarks`. It is **not** enough for agent commands: §10.3.1's interaction
   * rule has an agent-scope command *discard the whole per-commitment table* and adopt a
   * new `fence_floor`, so an agent command and a mission command that overlap are two
   * writers of the same object. One lock over the whole state is the honest scope of the
   * critical section, and a simulated agent has no throughput argument against it.
   *
   * ── What this fixes ────────────────────────────────────────────────────────
   * §11.5 requires the state to be durable *before* any externally observable effect,
   * so each handler writes the state, awaits the persist, and reverts on failure. The
   * revert was the hazard: with two commands in flight, the second one's revert restored
   * a snapshot taken before the first one's write, resurrecting a superseded authority —
   * reproduced as a stale `OFFER` being re-admitted and re-applied, which is exactly the
   * double-application invariant I21 forbids. Serialising the section removes the
   * interleaving that makes a revert wrong, rather than trying to make the revert clever
   * enough to survive it.
   *
   * Rejections are values, not exceptions, on every path through the handlers, so the
   * chain cannot be poisoned by one command's failure; the `catch` is belt and braces
   * for a defect that would otherwise wedge the agent permanently.
   *
   * @param {() => Promise<*>} fn
   * @returns {Promise<*>}
   */
  _withDedupLock(fn) {
    const result = this._dedupCriticalSection.then(fn, fn);
    this._dedupCriticalSection = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Record a protocol rejection. §23.3: "Every rejection is reported and counted, by
   * scope." Kept in memory and exposed on `getStatus()`; a firmware implementation
   * would emit it as a counter.
   */
  _rejectCommand(command, envelope, reason, scope) {
    this.protocolRejections.push({ command, scope, reason, at: Date.now() });
    this.log.warn(`[VR] ${this.robotId} rejected ${command} — ${reason} (${scope} scope, §23.3)`);
    return { applied: false, reason };
  }

  /**
   * The envelope checks §23.3 applies before any fence is compared: signature,
   * addressee, expiry.
   *
   * Signature verification is skipped only when no key is configured, and that is
   * logged rather than silent — a fleet running unsigned is a deployment defect, not a
   * mode.
   */
  _admitEnvelope(envelope) {
    if (!envelope || typeof envelope !== "object") return { accepted: false, reason: "MALFORMED_ENVELOPE" };
    if (envelope.agentId !== undefined && envelope.agentId !== this.robotId) {
      return { accepted: false, reason: "ADDRESSED_TO_ANOTHER_AGENT" };
    }
    if (envelope.notValidAfter !== undefined && envelope.notValidAfter !== null) {
      if (new Date(envelope.notValidAfter).getTime() <= Date.now()) {
        return { accepted: false, reason: "NOT_VALID_AFTER_PASSED" };
      }
    }
    if (this.commandSigningKey) {
      const verified = commandSigning.verify(
        {
          agentId: envelope.agentId,
          command: envelope.command,
          commandClass: envelope.commandClass,
          fenceScope: envelope.fenceScope,
          commitmentId: envelope.commitmentId === undefined ? null : envelope.commitmentId,
          fence: envelope.fence === null || envelope.fence === undefined ? null : BigInt(envelope.fence),
          authorityEpoch:
            envelope.authorityEpoch === null || envelope.authorityEpoch === undefined
              ? null
              : BigInt(envelope.authorityEpoch),
          fenceFloor:
            envelope.fenceFloor === null || envelope.fenceFloor === undefined ? null : BigInt(envelope.fenceFloor),
          sequence: envelope.sequence,
          notValidAfter: new Date(envelope.notValidAfter),
          payload: envelope.payload,
        },
        envelope.signature,
        this.commandSigningKey,
      );
      if (!verified) return { accepted: false, reason: "SIGNATURE_INVALID" };
    }
    return { accepted: true, reason: null };
  }

  /**
   * A mission command (§10.3.1 row 1).
   *
   * Order of checks is the order §23.3 states them, and it matters: the envelope is
   * admitted first (an unsigned or misaddressed command is rejected before its fence is
   * even read), then the fence per commitment id and against the floor, then the
   * sequence, and only then is the state persisted and the effect applied.
   */
  async _onMissionCommand(command, envelope) {
    const admitted = this._admitEnvelope(envelope);
    if (!admitted.accepted) return this._rejectCommand(command, envelope, admitted.reason, "commitment");

    const commitmentId = envelope.commitmentId;
    if (typeof commitmentId !== "string" || commitmentId === "") {
      return this._rejectCommand(command, envelope, "MISSION_COMMAND_WITHOUT_COMMITMENT_ID", "commitment");
    }

    // The envelope checks above read nothing mutable, so they stay outside the lock.
    // Everything from the fence comparison onwards reads and writes the dedup state and
    // is therefore one critical section (§11.5).
    return this._withDedupLock(() => this._applyMissionCommandExclusively(command, envelope, commitmentId));
  }

  /**
   * The mission command's critical section. Called only under `_withDedupLock`.
   */
  async _applyMissionCommandExclusively(command, envelope, commitmentId) {
    // §10.3.1 / §23.3 — compared **per commitment id**, and against `fence_floor`.
    // §23.3's clarification is why an unknown commitment is not admitted for lack of
    // history: "A mission command for an unknown commitment id is **not** admitted on
    // the grounds that no prior fence is recorded for it: the `fence_floor` check
    // governs that case, which is what makes a STAND_DOWN_ALL durable against a
    // subsequently redelivered stale offer."
    const verdict = fencing.acceptsMissionCommand(
      { commitmentId, fence: envelope.fence },
      new Map([...this.dedup.highWaterMarks].map(([id, mark]) => [id, mark.fence])),
      this.dedup.fenceFloor,
    );
    if (!verdict.accepted) return this._rejectCommand(command, envelope, verdict.reason, "commitment");

    const mark = this.dedup.highWaterMarks.get(commitmentId);
    const ordering = sequence.disposition(envelope, mark ? mark.sequence : null);
    if (ordering.disposition !== sequence.ORDERING_DISPOSITION.APPLY) {
      return this._rejectCommand(command, envelope, ordering.disposition, "commitment");
    }

    // §11.5 — durable **before** the effect. A failed persist means the agent cannot
    // guarantee it will reject a redelivery, so it does not apply the command at all.
    this.dedup.highWaterMarks.set(commitmentId, { fence: BigInt(envelope.fence), sequence: envelope.sequence });
    const persisted = await this.persistDedupState();
    if (!persisted) {
      // Restore, and *delete* when there was no prior mark. Writing a zero-valued mark
      // instead would leave the agent asserting a history for a commitment it has
      // never applied anything for — which §23.3 specifically distinguishes from
      // "unknown commitment", and which would make the `fence_floor` rule the wrong
      // one to govern the next delivery.
      //
      // Compare-and-restore, not overwrite. The lock already excludes another *command*
      // from having moved this entry, but `adoptDedupAcknowledgement` is synchronous and
      // unlocked by design (§11.5's AUTH path must leave no window in which handlers are
      // live under a superseded authority), so a session handshake can land inside this
      // await. Restoring blindly over it would reinstate an authority the server has
      // just told this agent to abandon.
      const current = this.dedup.highWaterMarks.get(commitmentId);
      const stillOurs =
        current && current.fence === BigInt(envelope.fence) && current.sequence === envelope.sequence;
      if (stillOurs) {
        if (mark) this.dedup.highWaterMarks.set(commitmentId, mark);
        else this.dedup.highWaterMarks.delete(commitmentId);
      }
      return this._rejectCommand(command, envelope, "DEDUP_STATE_NOT_DURABLE", "commitment");
    }

    this._applyMissionEffect(command, envelope);
    this._acknowledge(envelope);
    this._lastSupervisedAt = Date.now();
    return { applied: true, reason: null };
  }

  /**
   * An agent command (§10.3.1 row 2).
   *
   * Note the asymmetry with the mission rule, which is in the specification: mission
   * commands are rejected at `≤`, agent commands at `<`. An agent-scope command may
   * legitimately be re-sent at the same epoch — a redelivered `QUARANTINE` — and dedup
   * on `(agent_id, sequence, authority_epoch)` is what makes that harmless.
   */
  async _onAgentCommand(command, envelope) {
    const admitted = this._admitEnvelope(envelope);
    if (!admitted.accepted) return this._rejectCommand(command, envelope, admitted.reason, "agent");

    return this._withDedupLock(() => this._applyAgentCommandExclusively(command, envelope));
  }

  /**
   * The agent command's critical section. Called only under `_withDedupLock`.
   */
  async _applyAgentCommandExclusively(command, envelope) {
    const verdict = fencing.acceptsAgentCommand(
      { authorityEpoch: envelope.authorityEpoch },
      this.dedup.authorityEpoch,
    );
    if (!verdict.accepted) return this._rejectCommand(command, envelope, verdict.reason, "agent");

    const ordering = sequence.disposition(envelope, this._agentSequenceHighWater());
    if (ordering.disposition !== sequence.ORDERING_DISPOSITION.APPLY) {
      return this._rejectCommand(command, envelope, ordering.disposition, "agent");
    }

    // §10.3.1's interaction rule, in full: record the epoch, adopt the carried floor,
    // and **discard the per-commitment authority table** — which is what makes one
    // STAND_DOWN_ALL fence every commitment without enumerating them.
    const previous = { ...this.dedup, highWaterMarks: new Map(this.dedup.highWaterMarks) };
    const previousAgentSequence = this._agentSequence;
    const applied = fencing.applyAgentCommand({
      authorityEpoch: envelope.authorityEpoch,
      fenceFloor: envelope.fenceFloor,
    });
    this.dedup.authorityEpoch = applied.highestSeenAuthority;
    this.dedup.fenceFloor = applied.fenceFloor;
    this.dedup.highWaterMarks = applied.highestSeenPerCommitment;
    this._agentSequence = envelope.sequence;

    const persisted = await this.persistDedupState();
    if (!persisted) {
      // Compare-and-restore, for the same reason the mission path does it: the lock
      // excludes another command, not a synchronous handshake adoption landing inside
      // this await. Reverting only what this call actually wrote means a newer authority
      // survives a failed persist of an older one.
      const unchanged =
        this.dedup.authorityEpoch === applied.highestSeenAuthority &&
        this.dedup.fenceFloor === applied.fenceFloor &&
        this._agentSequence === envelope.sequence;
      if (unchanged) {
        this.dedup = previous;
        this._agentSequence = previousAgentSequence;
      }
      return this._rejectCommand(command, envelope, "DEDUP_STATE_NOT_DURABLE", "agent");
    }

    this._applyAgentEffect(command, envelope);
    this._acknowledge(envelope);
    this._lastSupervisedAt = Date.now();
    return { applied: true, reason: null };
  }

  _agentSequenceHighWater() {
    return this._agentSequence === undefined ? null : this._agentSequence;
  }

  /**
   * A query (§10.3.1 row 3) — *"side-effect-free. Always answered; never fenced."*
   *
   * No fence, no sequence, no dedup write: a query that could be rejected by a fence
   * would make an agent under a superseded authority unobservable, which is exactly
   * when the server most needs to observe it.
   */
  _onQuery(command, envelope) {
    const answer = {
      command,
      robotId: this.robotId,
      correlationId: envelope?.correlationId || null,
      status: this.getStatus(),
      dedup: this.dedupReport(),
    };
    try {
      this.socket.emit(`${command}_RESULT`, answer);
    } catch { /* ignore */ }
    return { applied: true, answer };
  }

  /** §11.1 item 2 — the acknowledgement that closes the outbox row. */
  _acknowledge(envelope) {
    if (!envelope?.outboxId) return;
    try {
      this.socket.emit("COMMAND_ACK", {
        outboxId: envelope.outboxId,
        robotId: this.robotId,
        fence: envelope.fence === undefined ? null : envelope.fence,
        authorityEpoch: envelope.authorityEpoch === undefined ? null : envelope.authorityEpoch,
        timestamp: Date.now(),
      });
    } catch { /* ignore */ }
  }

  /**
   * The physical effect of an admitted mission command.
   *
   * `OFFER` answers with `ACCEPT` / `REJECT` / `DEFER` per §11.2 — and the simulator's
   * refusal condition is deliberately the one §11.2 calls out as the important case:
   * an agent too low on charge to start says so, rather than accepting and stranding.
   */
  _applyMissionEffect(command, envelope) {
    switch (command) {
      case "OFFER": {
        this.offers.set(envelope.commitmentId, envelope);
        this._respondToOffer(envelope);
        break;
      }
      case "WITHDRAW":
      case "RECALL":
      case "ABORT_MISSION": {
        this.offers.delete(envelope.commitmentId);
        // A withdrawn or recalled mission is over: the commitment is tombstoned so a
        // redelivery of any of its commands is recognised as belonging to a retired
        // authority rather than as a new one.
        this.dedup.tombstones.set(envelope.commitmentId, Date.now());
        this._applyStop(command);
        break;
      }
      case "REROUTE":
      case "RESEQUENCE": {
        if (envelope.payload?.newPath) this._onRerouteAlert({ newPath: envelope.payload.newPath });
        break;
      }
      case "RESUME": {
        this._applyResume();
        break;
      }
      case "TRANSFER_CUSTODY": {
        // Custody transfer is §4.7's, and `custody_transfer_capable` defaults false —
        // "most fleets are human-mediated". The simulator records the instruction and
        // does not simulate a handover it has no model for.
        this.log.info(`[VR] ${this.robotId} TRANSFER_CUSTODY recorded (custody_transfer_capable defaults false, §2.3)`);
        break;
      }
      default:
        break;
    }
  }

  /** The physical effect of an admitted agent command. */
  _applyAgentEffect(command) {
    switch (command) {
      case "STAND_DOWN_ALL":
      case "QUARANTINE": {
        this.offers.clear();
        this._applyReturnToBase(command);
        break;
      }
      case "RELEASE_QUARANTINE":
      case "ESTOP_CLEAR": {
        this.status = "IDLE";
        break;
      }
      case "SHARD_MIGRATE":
      case "SESSION_REKEY":
      case "PARAMETER_PUSH": {
        // Control-plane commands with no physical effect on this simulator. Accepting
        // and acknowledging them is still the contract: an agent that ignored them
        // would leave the server's authority epoch and the agent's out of step.
        break;
      }
      default:
        break;
    }
  }

  /**
   * §11.2 — the agent's response to an offer.
   *
   * > A `REJECT` is an important safety signal, not merely a scheduling event. The
   * > agent is the authority on its own physical condition, and it may know something
   * > the server does not.
   */
  _respondToOffer(envelope) {
    const respond = (event, extra) => {
      try {
        this.socket.emit(event, {
          commitmentId: envelope.commitmentId,
          fence: envelope.fence,
          robotId: this.robotId,
          ...extra,
        });
      } catch { /* ignore */ }
    };

    // PHASE 7 — §14.6. Adopt the offer's published inputs *before* deciding, so the
    // decision is taken on the same numbers the server planned with.
    this._adoptEnergyInputs(envelope.payload);

    const energy = this._assessOfferEnergy();

    if (this.status === "CHARGING" && energy.belowInterruptCondition) {
      // The case §11.2 names: "the one deferral it can perform — holding an assignment
      // while charging — is invisible to the server". It is now visible, priced, and
      // re-optimised against alternatives next round.
      respond("OFFER_DEFER", {
        until: new Date(Date.now() + CHARGING_WAIT_MS).toISOString(),
        reason: energy.interruptReason,
      });
      return;
    }

    if (energy.belowFloor) {
      respond("OFFER_REJECT", { reason: energy.floorReason });
      return;
    }

    // The mission the offer describes, as this agent would execute it. Built *before*
    // the response, because whether it can be executed is part of what is being
    // answered — §11.2's ACCEPT is "plan received, validated **locally**, and
    // accepted", and this is that local validation.
    const plan = envelope.payload || {};
    // STEP 8 — the **whole** stop sequence. This used to take `stops[0]` and `stops[1]`
    // and drop everything after them, so a plan with a charging stop inserted between
    // pickup and drop was accepted and then executed as pickup→charge: the agent reported
    // `TASK_COMPLETE` having never visited the drop. The truncation was silent in both
    // directions — the offer was accepted, and the missing stops left no trace.
    const stops = buildStopSequence(plan);
    const assignment = {
      // §2.4 — the **Task**, which is the unit of customer-visible work and the identifier
      // completion is reported against. `dtaro.handler`'s `TASK_COMPLETE` matches on
      // `Task.taskId`; reporting `legId` matched no Task row, so a mission the agent
      // finished left its Task open, its robot bound to it, and the dashboard showing an
      // assignment that had already been driven.
      //
      // The fall-backs are retained and ordered by how much they claim. `legId` is what a
      // server not yet supplying `taskId` sends, and the commitment id is what an offer
      // with neither carries; both keep the agent executing a mission it was legitimately
      // offered, and the server-side resolution in `dtaro.handler` closes the loop for the
      // first of them.
      taskId: plan.taskId || plan.legId || envelope.commitmentId,
      // The authoritative mission: every stop, in order.
      stops,
      // §15.1's *expectation*, carried so the energy model can charge the mass term over
      // the legs the payload is actually aboard for. Absent when the offer declares none,
      // and absent means the model refuses rather than assuming an empty vehicle.
      payloadMassKg: Number.isFinite(plan.payloadMassKg) ? plan.payloadMassKg : null,
    };

    const executability = assessExecutability(stops);
    if (!executability.executable) {
      // Fail closed. An offer carrying no route is not a mission this agent can
      // perform, and §11.2's disposition for that is REJECT, not silence and not a
      // hopeful ACCEPT: rejecting releases the commitment, returns the Leg to QUEUED,
      // and — the part that matters here — records the reason as a *feasibility
      // observation* to be reconciled against the server's model. §11.2 says exactly
      // what that reconciliation is for: "if an agent rejects ... while the server
      // believed it feasible, that is a discrepancy between the server's model and the
      // agent's — a calibration defect worth alerting on."
      //
      // A missing route producer is precisely such a discrepancy, so the protocol's
      // own channel carries it. Accepting instead would make the agent claim a
      // commitment it cannot discharge, and — because the phase machine treats an
      // empty path as an already-finished one — would emit `TASK_COMPLETE` for a
      // delivery that never happened. A false completion is worse than no assignment:
      // it retires the Leg, satisfies the task, and leaves the payload where it was.
      this.log.warn(
        `[VR] ${this.robotId} OFFER ${envelope.commitmentId} rejected — ${executability.reason} (§11.2)`,
      );
      respond("OFFER_REJECT", { reason: executability.reason });
      return;
    }

    respond("OFFER_ACCEPT", {});
    this._onTaskAssign(assignment);
  }

  /**
   * §18.5 — the on-agent bound that carries safety while supervision is absent.
   *
   * > agents continue autonomously for at most `agent.autonomous_continuation_limit`
   * > and then halt at the safest reachable location.
   *
   * The limit is enforced by the *agent*, not by the server, which is the whole point:
   * it is the property that still holds when the server is the thing that is gone.
   */
  _enforceAutonomousContinuationLimit(nowMs) {
    if (this._lastSupervisedAt === null) return false;
    if (!this.task || !this.phase) return false;

    const elapsedSeconds = (nowMs - this._lastSupervisedAt) / 1000;
    if (elapsedSeconds < this._autonomousContinuationLimitSeconds) return false;

    this.log.warn(
      `[VR] ${this.robotId} autonomous continuation limit reached (${Math.round(elapsedSeconds)}s ` +
        `≥ ${this._autonomousContinuationLimitSeconds}s) — halting at the safest reachable location (§18.5)`,
    );
    this._applyStop("AUTONOMOUS_CONTINUATION_LIMIT");
    return true;
  }

  // ── Operator commands ──────────────────────────────────────────────────────

  /**
   * Handle a COMMAND from the operator console and acknowledge it.
   * Types mirror the Prisma CommandType enum: STOP | PAUSE | RETURN | RESUME.
   *
   * ── STEP 4: applied at most once per command id ─────────────────────────────
   * The §10.3.1 command surface has durable, fenced deduplication (§11.5). This legacy path
   * had none at all, and it is a path that genuinely sees redeliveries: the reliability
   * scheduler re-sends a `Command` row it has not seen acknowledged after ~15 s, and the
   * reconnect defect `_registerHandlers` documents delivered every command twice on its own.
   *
   * Applying twice is not harmless here. `RETURN` clears the task, so a redelivered `RETURN`
   * arriving after a *new* assignment had been accepted would abandon that new mission —
   * the operator's one instruction cancelling a task it was never about. Each duplicate also
   * wrote a second `Event` row and burned the server's `COMMAND_ACK` rate-limit budget
   * (20/min), so a few duplicates could silence the acknowledgements that were not
   * duplicates.
   *
   * The duplicate is **re-acknowledged without being re-applied**. Both halves matter: not
   * re-applying is the point, and still answering is why the redelivery happened — the thing
   * that went missing was very likely the acknowledgement, and a silent agent would be
   * re-sent the command until the ladder marked it FAILED.
   *
   * Retention matches the §11.5 dedup window (`agent.dedup_retention`, 30 min), which is
   * validated to exceed offer TTL plus maximum delivery delay: below that, "a redelivered
   * command outlives the state that would reject it". Entries are pruned on arrival, so the
   * map is bounded by the commands actually issued inside the window rather than by uptime.
   */
  _onCommand(payload) {
    const commandId = payload?.commandId;
    const type = typeof payload?.type === "string" ? payload.type.toUpperCase() : null;

    if (commandId) {
      this._pruneAppliedCommands();
      const previous = this._appliedCommands.get(commandId);
      if (previous) {
        this.log.info(
          `[VR] ${this.robotId} COMMAND ${commandId} (${previous.type}) already applied — ` +
            "re-acknowledged, not re-applied",
        );
        this._emitCommandAck(commandId);
        return;
      }
    }

    switch (type) {
      case "STOP":
      case "PAUSE":
        this._applyStop(type);
        break;
      case "RETURN":
        this._applyReturnToBase(type);
        break;
      case "RESUME":
        this._applyResume();
        break;
      default:
        this.log.warn(`[VR] ${this.robotId} ignoring unknown COMMAND type ${type}`);
        // Unknown type — deliberately not acknowledged, and deliberately **not recorded**
        // as applied: nothing was applied, so a redelivery of it must reach the same
        // refusal rather than being answered from the dedup table.
        return;
    }

    if (commandId) {
      // Recorded *before* the acknowledgement. The ACK is the externally observable
      // effect that makes the command settled on the server, and §11.5's ordering rule —
      // "committed before the command's effect becomes externally observable" — is the
      // right one here too, even though this path's record is in memory rather than in
      // flash. (It is in memory because the legacy `Command` row is re-driven by the
      // server's own reliability scheduler, not by an agent-side replay across a power
      // cycle; the honest scope of this guard is the session, and `getStatus` reports it.)
      this._appliedCommands.set(commandId, { type, at: Date.now() });
      this._emitCommandAck(commandId);
    }
  }

  /** The legacy operator-command acknowledgement. One emitter, so both paths agree. */
  _emitCommandAck(commandId) {
    try {
      this.socket.emit("COMMAND_ACK", { commandId, robotId: this.robotId, timestamp: Date.now() });
    } catch { /* ignore */ }
  }

  /**
   * Drop applied-command records older than the deduplication window.
   *
   * Bounded by the commands issued inside the window, not by uptime. An unbounded map here
   * would be the same slow leak `dedup.tombstones` still has (recorded as a known
   * limitation rather than fixed silently in a step that is not about it).
   */
  _pruneAppliedCommands() {
    if (this._appliedCommands.size === 0) return;
    // @structural seconds to milliseconds
    const horizon = Date.now() - DEDUP_KEY_TTL * 1000;
    for (const [id, record] of this._appliedCommands) {
      if (record.at < horizon) this._appliedCommands.delete(id);
    }
  }

  /** Halt movement. The task is retained so RESUME can pick it back up. */
  _applyStop(label) {
    if (this.status !== "CHARGING") this.status = "PAUSED";
    this.speed = 0;
    this.log.info(`[VR] ${this.robotId} ${label}`);
  }

  /** Abandon the current task entirely and go idle. */
  _applyReturnToBase(label) {
    this._clearTask();
    this._clearCharging();
    this._pendingResume = null;
    this.status = "IDLE";
    this.speed  = 0;
    this.log.info(`[VR] ${this.robotId} ${label}`);
  }

  /** Resume a task halted by STOP/PAUSE; otherwise just return to IDLE. */
  _applyResume() {
    if (this.status === "CHARGING") {
      this.log.info(`[VR] ${this.robotId} RESUME ignored — still charging`);
      return;
    }
    this.status = this.task && this.phase ? "ACTIVE" : "IDLE";
    this.log.info(`[VR] ${this.robotId} RESUME → ${this.status}`);
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), this._telemetryIntervalMs);
    if (typeof this._timer.unref === "function") this._timer.unref();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    try { this.socket?.disconnect(); } catch { /* ignore */ }
    this.socket             = null;
    this.connected          = false;
    this._handlersRegistered = false;
    this._handlerSocket     = null;
    this.log.info(`[VR] ${this.robotId} stopped`);
  }

  /**
   * Is this instance actually ticking?
   *
   * STEP 4. The distinction between "the engine holds an instance for this robot" and "that
   * instance is running" had no accessor, so `getStatus()` could not report it and the
   * frontend inferred RUNNING from the engine's own `started` flag. The timer is the honest
   * witness: no timer, no telemetry, no movement, no battery drain.
   *
   * @returns {boolean}
   */
  isRunning() {
    return this._timer !== null;
  }

  /**
   * Change the tick period on a robot that is already running (STEP 4, a `LIVE` parameter).
   *
   * The interval is replaced rather than the timer left alone, because `setInterval`'s
   * period is fixed at creation: a configuration change that did not restart the timer
   * would be accepted and have no effect, which is the failure mode the whole config
   * change exists to remove.
   *
   * @param {number} intervalMs
   * @returns {boolean} whether the period changed
   */
  setTelemetryInterval(intervalMs) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return false;
    if (intervalMs === this._telemetryIntervalMs) return false;
    this._telemetryIntervalMs = intervalMs;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = setInterval(() => this._tick(), this._telemetryIntervalMs);
      if (typeof this._timer.unref === "function") this._timer.unref();
    }
    return true;
  }

  /**
   * Transport-level observation, for `tools/verify/step4SimulationBehaviour.js` (STEP 4).
   *
   * Counts and identities, never the socket. The listener counts are the property the
   * reconnect fix is about: one delivered event must reach one handler, and the only way to
   * see that directly is to count the handlers on the emitter. `socketGeneration` says how
   * many distinct socket objects this instance has built, so a verifier can establish that a
   * reconnection reused the existing one rather than assuming it.
   *
   * `socket.listeners(event)` is socket.io-client's own accessor; where the socket is a test
   * double without it, the count is reported as `null` rather than guessed at.
   *
   * @returns {{ robotId: string, running: boolean, connected: boolean, socketId: string|null,
   *             socketGeneration: number, listeners: Record<string, number|null> }}
   */
  inspectTransport() {
    const countFor = (event) => {
      try {
        if (typeof this.socket?.listeners === "function") return this.socket.listeners(event).length;
        if (typeof this.socket?.listenerCount === "function") return this.socket.listenerCount(event);
      } catch { /* fall through */ }
      return null;
    };

    return {
      robotId: this.robotId,
      running: this.isRunning(),
      connected: this.connected === true,
      socketId: this.socket?.id || null,
      socketGeneration: this._socketGeneration,
      listeners: {
        COMMAND: countFor("COMMAND"),
        TASK_ASSIGN: countFor("TASK_ASSIGN"),
        OFFER: countFor("OFFER"),
        STOP: countFor("STOP"),
        TELEMETRY: countFor("TELEMETRY"),
      },
    };
  }

  /**
   * Change the obstacle report rate on a running robot (STEP 4, a `LIVE` parameter).
   *
   * @param {number} probability per-tick probability while ACTIVE
   * @returns {boolean}
   */
  setObstacleProbability(probability) {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) return false;
    this._obstacleProbability = probability;
    return true;
  }

  reset() {
    this._clearTask();
    this._clearCharging();
    this._pendingResume = null;
    this.status = "IDLE";
    this.speed  = 0;
    this.log.info(`[VR] ${this.robotId} reset`);
  }

  getStatus() {
    return {
      robotId:       this.robotId,
      lat:           this.lat,
      lon:           this.lon,
      battery:       Math.round(this.battery * 10) / 10,
      speed:         Math.round(this.speed * 100) / 100,
      status:        this.status,
      phase:         this.phase,
      taskId:        this.task?.taskId || null,
      connected:     this.connected,
      // STEP 4 — `running` is the tick timer, `connected` is the socket, and they are
      // genuinely different states: a robot whose timer was stopped keeps its socket open
      // until `stop()` closes it, and one that has been added but never started has
      // neither. Reporting only `connected` is what let a stopped fleet read as RUNNING.
      running:       this.isRunning(),
      heading:       this._heading !== null ? Math.round(this._heading) : null,
      chargingPhase: this._chargingPhase,
      pendingResumeTaskId: this._pendingResume?.taskId || null,

      // ── STEP 8: where in the mission this agent actually is ────────────────
      // Reported so "it completed" can be checked against "it executed every stop",
      // which a `phase` alone cannot answer for a plan longer than two stops.
      stopIndex:      this.task ? this.stopIndex : null,
      stopCount:      this.task?.stops?.length ?? null,
      stopTypes:      this.task?.stops?.map((s) => s.stopType || "UNTYPED") ?? null,
      carryingPayload: this._carryingPayload === true,
      chargeStopsVisited: this._chargeStopsVisited,

      // ── STEP 3: the specification this agent is actually running on ────────
      // Exposed so a verifier can establish that the agent read its commissioned row
      // rather than a fleet constant — the whole claim of Step 3 — instead of inferring
      // it from observed speed.
      specification: {
        massKg:            this._specification.massKg,
        normalSpeedMps:    this._specification.normalSpeedMps,
        maxSpeedMps:       this._specification.maxSpeedMps,
        packNominalWh:     this._specification.packNominalWh,
        payloadCapacityKg: this._specification.payloadCapacityKg,
      },
      speedEnvelope: {
        baseMs: this._speedBaseMs,
        minMs:  this._speedMinMs,
        maxMs:  this._speedMaxMs,
        jitter: this._speedJitter,
      },

      // ── STEP 4 / STEP 5: the environment, and how energy was computed ──────
      //
      // `energyBasis` is the honesty surface. `MODELLED_WH` means §14.2's model produced
      // the discharge; `LEGACY_PERCENTAGE` means it refused and a flat development rate
      // did, and `energyMissing` names exactly which owner declarations are absent. A
      // reader can therefore never mistake a fallback tick for a modelled one.
      ambientC: this._ambientC === null ? null : Math.round(this._ambientC * 10) / 10,
      packC:    this._packC === null ? null : Math.round(this._packC * 10) / 10,
      energyBasis:   this._energyBasis,
      energyMissing: this._energyMissing,
      lastTickWh:    this._lastTickWh,
      cumulativeWh:  Math.round(this._cumulativeWh * 1000) / 1000,
      kappa:            this._kappa(),
      kappaSampleCount: this._batteryState?.kappaSampleCount ?? null,
      // STEP 4 — the simulation surface, so `GET /api/simulator/status` can show what a
      // robot is configured to do and how much of it it has done.
      simulated:     this.simulated === true,
      telemetryIntervalMs: this._telemetryIntervalMs,
      telemetrySequence: this._telemetrySequence,
      randomSeed:    this._randomSeed,
      appliedCommandCount: this._appliedCommands.size,
      // PHASE 4 — the protocol surface, for the conformance fixture and for §23.3's
      // "every rejection is reported and counted, by scope".
      dedupStateGeneration: String(this.dedup.dedupStateGeneration),
      authorityEpoch: String(this.dedup.authorityEpoch),
      fenceFloor: String(this.dedup.fenceFloor),
      heldCommitments: [...this.dedup.highWaterMarks.keys()],
      protocolRejectionCount: this.protocolRejections.length,
    };
  }

  // ── Task handlers ──────────────────────────────────────────────────────────

  _onTaskAssign(payload) {
    const { taskId } = payload || {};
    if (!taskId) return;

    // STEP 8 — normalise whichever form the mission arrived in into one stop sequence.
    // An offer supplies `stops` (any length, already built by `_respondToOffer`); a
    // legacy `TASK_ASSIGN` supplies `pathToPickup`/`pathToDrop`, which is a two-stop
    // PICKUP→DROP mission. From here down there is one code path for both.
    const stops = Array.isArray(payload.stops) && payload.stops.length > 0
      ? payload.stops
      : buildStopSequence(payload);

    // The single seam where a task becomes executable — this is the only assignment to
    // `this.task` in the file — so it is the one place the fail-closed rule has to
    // hold, whatever the producer.
    //
    // Refused *before* the charging branch below, deliberately: stashing an
    // unexecutable assignment in `_pendingResume` would only replay the same refusal
    // once the pack filled, and would hold a slot for a mission that can never run.
    const executability = assessExecutability(stops);
    if (!executability.executable) {
      this.log.error(
        `[VR] ${this.robotId} TASK_ASSIGN ${taskId} refused — ${executability.reason}. ` +
          "The robot stays IDLE and no TASK_COMPLETE is emitted: a mission with no route " +
          "is not executed, and must not be reported as if it were.",
      );
      return;
    }

    if (this.status === "CHARGING") {
      if (this.battery < CHARGING_INTERRUPT_BATTERY) {
        // Too low to interrupt charging — defer the assignment instead of
        // discarding it. Without this, a task recovered after a restart
        // (redispatched while the robot has already auto-docked on a
        // critically low persisted battery) would be silently dropped
        // forever, leaving the DB task stuck at ASSIGNED with no robot
        // ever picking it back up.
        // The whole mission is deferred, not the first two stops of it.
        this._pendingResume = { taskId, stops, payloadMassKg: payload.payloadMassKg ?? null };
        this.log.warn(
          `[VR] ${this.robotId} TASK_ASSIGN ${taskId} deferred — battery ${this.battery.toFixed(1)}% too low, will resume once fully charged`
        );
        return;
      }
      this._clearCharging();
      this.log.info(`[VR] ${this.robotId} charging interrupted by TASK_ASSIGN`);
    }

    // A fresh, real assignment supersedes anything that was only queued.
    this._pendingResume = null;

    this.task = {
      taskId,
      // STEP 8 — the authoritative mission sequence. Every stop, in order, however many.
      stops,
      // §15.1's payload expectation, for the energy model's mass term. Null when the
      // mission declared none.
      payloadMassKg: Number.isFinite(payload.payloadMassKg) ? payload.payloadMassKg : null,
      // Retained so the two legacy readers — `_onRerouteAlert`'s `segment` handling and
      // anything reading `task.pathToPickup` — keep working unchanged. They are views of
      // the first PICKUP and first DROP stop, not a second source of truth: the phase
      // machine walks `stops` and never reads these.
      get pathToPickup() {
        return (this.stops.find((s) => s.stopType === "PICKUP") || this.stops[0] || {}).path || [];
      },
      get pathToDrop() {
        return (this.stops.find((s) => s.stopType === "DROP") || this.stops[this.stops.length - 1] || {}).path || [];
      },
    };

    // STEP 8 — start at the first stop, whatever type it is, rather than assuming PICKUP.
    this.stopIndex         = 0;
    this._carryingPayload  = false;
    this._chargeStopsVisited = 0;
    this.phase             = phasesForStopType(stops[0].stopType).moving;
    this.waitUntil         = null;
    this.activePath        = stops[0].path;
    this.status            = "ACTIVE";
    this.distanceTravelled = 0;

    // Snap to nearest point on the path.
    //
    // Two scenarios handled by the same algorithm:
    //   A) Fresh assignment — robot is inside campus (off-road).
    //      path[0] is Mapbox-snapped to the nearest road.
    //      → robot teleports to path[0] (on-road) and starts moving.
    //
    //   B) Restart resume — robot's last DB position is somewhere along the route.
    //      recoverActiveTasks re-computes a fresh route from that position,
    //      so path[0] IS the robot's current road position.
    //      → robot resumes from where it left off (no backtrack to route start).
    const firstPath = stops[0].path;
    const snapIdx = this._findNearestPathIndex(firstPath, this.lat, this.lon);
    this.pathIndex = snapIdx;
    const snapPt = firstPath[snapIdx];
    if (snapPt && typeof snapPt.lat === "number") {
      this.lat = snapPt.lat;
      this.lon = snapPt.lon;
    }

    this.log.info(
      `[VR] ${this.robotId} TASK_ASSIGN ${taskId} — ${stops.length} stop(s) ` +
        `(${stops.map((s) => s.stopType || "UNTYPED").join(" → ")}), ` +
        `snapped to path[${snapIdx}]/${firstPath.length}`,
    );
  }

  /** Find the index of the path waypoint closest to (lat, lon). */
  _findNearestPathIndex(path, lat, lon) {
    if (!Array.isArray(path) || path.length === 0) return 0;
    if (typeof lat !== "number" || typeof lon !== "number") return 0;
    let minDist = Infinity;
    let minIdx  = 0;
    for (let i = 0; i < path.length; i++) {
      const pt = path[i];
      if (typeof pt?.lat !== "number" || typeof pt?.lon !== "number") continue;
      const d = haversineMeters(lat, lon, pt.lat, pt.lon);
      if (d < minDist) { minDist = d; minIdx = i; }
    }
    return minIdx;
  }

  _onRerouteAlert(payload) {
    // If backend computed a fresh Mapbox path, replace activePath entirely
    if (Array.isArray(payload?.newPath) && payload.newPath.length > 1) {
      const segment = payload.segment || "toPickup";
      this.activePath = payload.newPath;
      this.pathIndex  = 0;
      // STEP 8 — the reroute replaces the path of the stop currently being driven to,
      // which is the stop the agent is actually on. Writing it back to `pathToPickup` or
      // `pathToDrop` — as this did — could not name a third stop at all, so a reroute
      // during a charging leg silently rewrote the pickup's path instead of the leg the
      // agent was on.
      //
      // The `segment` hint is still honoured when it names a stop *type*, because a server
      // that sends `toDrop` is naming the drop and may be rerouting a leg the agent has
      // not started yet.
      if (this.task && Array.isArray(this.task.stops)) {
        const targetType = segment === "toDrop" ? "DROP" : segment === "toPickup" ? "PICKUP" : null;
        const target = targetType === null
          ? this.task.stops[this.stopIndex]
          : this.task.stops.find((s) => s.stopType === targetType) || this.task.stops[this.stopIndex];
        if (target) target.path = payload.newPath;
      }
      this.log.info(`[VR] ${this.robotId} REROUTE → full path (${payload.newPath.length} pts, ${segment})`);
      return;
    }

    // Fallback: skip ahead past the obstacle in the current path
    if (!this.activePath || !payload?.obstacleLocation) return;
    const obs      = payload.obstacleLocation;
    const SKIP_DEG = 0.0003;
    let idx = this.pathIndex;
    while (
      idx < this.activePath.length - 1 &&
      Math.abs((this.activePath[idx]?.lat || 0) - obs.lat) < SKIP_DEG &&
      Math.abs((this.activePath[idx]?.lon || 0) - obs.lon) < SKIP_DEG
    ) { idx++; }
    if (idx > this.pathIndex) {
      this.pathIndex = idx;
      this.log.info(`[VR] ${this.robotId} REROUTE fallback → skip to index ${idx}`);
    }
  }

  _clearTask() {
    this.task       = null;
    this.phase      = null;
    this.pathIndex  = 0;
    this.waitUntil  = null;
    this.activePath = null;
    // STEP 8 — the mission cursor and the custody flag belong to the mission, so they are
    // cleared with it. A stale `stopIndex` surviving into the next mission would have it
    // start partway through its own sequence.
    this.stopIndex  = 0;
    this._carryingPayload = false;
  }

  _clearCharging() {
    this._chargingPhase   = null;
    this._chargeWaitUntil = null;
  }

  // ── Charging state machine ────────────────────────────────────────────────

  _enterCharging() {
    this.status          = "CHARGING";
    this._chargingPhase  = "WAITING";
    this._chargeWaitUntil = Date.now() + CHARGING_WAIT_MS;
    this.speed           = 0;
    this.log.info(
      `[VR] ${this.robotId} battery critical (${this.battery.toFixed(1)}%) — docking to charge`
    );
  }

  _handleCharging(nowMs) {
    if (this.status !== "CHARGING") return;

    if (this._chargingPhase === "WAITING") {
      if (nowMs >= (this._chargeWaitUntil || 0)) {
        this._chargingPhase = "CHARGING";
        this.log.info(`[VR] ${this.robotId} charging current flowing`);
      }
      return;
    }

    if (this._chargingPhase === "CHARGING") {
      const targetPercent = this._targetSocPercent();

      // ── STEP 4: charging can never *lower* the battery ────────────────────────
      // This was `Math.min(targetPercent, battery + step)`, with no floor at the current
      // level. The target is not a constant — §14.6 assigns it to the Charging Scheduler and
      // the agent adopts whatever an offer published — so a target below the pack's present
      // state of charge is a reachable input, and the expression above answered it by
      // *discharging* to the target in a single tick. A pack that lost ten points while
      // docked, attributed to charging, is an incoherent telemetry stream in the most
      // literal sense: the battery moved the opposite way from the process reporting it.
      //
      // A charge session tops up or it finishes. The ceiling is what says so: it is the
      // target, or the present level when that is already higher — never below where the
      // pack is. And the step is floored at zero, so a curve that returned a negative
      // increment cannot discharge the pack either.
      const ceiling = Math.max(targetPercent, this.battery);
      this.battery = Math.min(ceiling, this.battery + Math.max(0, this._chargeStepPercent()));

      if (this.battery >= targetPercent) {
        // Already at or above the target — complete the session at the level actually
        // reached, not at the target. Snapping down to `targetPercent` is the same
        // fabrication one line up.
        this.battery = Math.max(this.battery, targetPercent);
        this.status  = "IDLE";
        this._clearCharging();

        const pending = this._pendingResume;
        this._pendingResume = null;
        if (pending) {
          this.log.info(
            `[VR] ${this.robotId} reached target SoC ${targetPercent.toFixed(0)}% → resuming deferred task ${pending.taskId}`
          );
          this._onTaskAssign(pending);
        } else {
          this.log.info(`[VR] ${this.robotId} reached target SoC ${targetPercent.toFixed(0)}% → IDLE`);
        }
      }
    }
  }

  /**
   * PHASE 7 — §11.2 / §14.6. Adopt the reserve parameters and target SoC an offer
   * carries.
   *
   * Both are inputs the agent did not choose. `energyReserveParams` is the server's own
   * `reserves.compose()` stack in watt-hours, and `targetSoc` is the Charging
   * Scheduler's published value. Adopting them is what replaces the shared 30 %
   * constant: §14.6 preserves the baseline's threshold-sharing "in spirit and
   * strengthens it" by putting the numbers on the wire rather than in a module both
   * sides happen to import.
   *
   * An offer that carries neither leaves the previous values in place, so a legacy
   * `TASK_ASSIGN` path continues to behave exactly as it did.
   *
   * @param {object} payload the OFFER payload
   */
  _adoptEnergyInputs(payload) {
    if (!payload || typeof payload !== "object") return;
    if (payload.energyReserveParams && typeof payload.energyReserveParams === "object") {
      this._energyReserveParams = payload.energyReserveParams;
    }
    if (Number.isFinite(payload.targetSoc)) {
      this._publishedTargetSoc = payload.targetSoc;
    }
  }

  /**
   * PHASE 7 — §14.1 / §14.5. The agent's own energy judgement about an offer.
   *
   * Where the server has supplied a reserve stack in **watt-hours**, the agent reasons
   * in watt-hours: `E_floor` is the hardware protection floor and `E_floor + E_return`
   * is the point below which finishing the mission strands it. That is the model §14.1
   * replaced the percentage floor with, and an agent still comparing percentages would
   * be the "shared constant that a future edit could desynchronise" §14.6 removes.
   *
   * Where no reserve stack has been published — every legacy `TASK_ASSIGN`, and any
   * offer from a server not yet supplying them — it falls back to the legacy percentage
   * thresholds unchanged. The fallback is stated rather than implicit: an agent that
   * silently invented watt-hours from a percentage would be asserting a pack capacity
   * nobody gave it.
   *
   * The two conditions carry **their own** reasons rather than one shared string,
   * because they are answers to different questions and reach the server through
   * different dispositions: a deferral says "not now, ask again", a rejection says "this
   * agent cannot do this at all", and §11.2 reconciles the second against the server's
   * energy model as a possible calibration defect. Collapsing them would report a
   * charging agent's ordinary wait as a safety refusal.
   *
   * @returns {{ belowInterruptCondition: boolean, belowFloor: boolean,
   *             interruptReason: string, floorReason: string, basis: string }}
   */
  _assessOfferEnergy() {
    const params = this._energyReserveParams;
    const packWh = params && Number.isFinite(params.packNominalWh) ? params.packNominalWh : null;
    const floorWh = params && Number.isFinite(params.floorWh) ? params.floorWh : null;
    const returnWh = params && Number.isFinite(params.returnWh) ? params.returnWh : null;

    if (packWh !== null && packWh > 0 && floorWh !== null) {
      // @structural percentage to fraction
      const availableWh = (this.battery / 100) * packWh;
      const floorPlusReturn = floorWh + (returnWh === null ? 0 : returnWh);
      return {
        basis: "MODELLED_WH",
        belowFloor: availableWh <= floorWh,
        // Interrupting a charge is permitted only above the layer that keeps a return
        // viable; §14.6's full three-condition test is the server's, and the agent
        // enforces the half it is the authority on — its own remaining energy.
        belowInterruptCondition: availableWh < floorPlusReturn,
        interruptReason: `BELOW_E_FLOOR_PLUS_E_RETURN:${availableWh.toFixed(0)}Wh<${floorPlusReturn}Wh`,
        floorReason: `BELOW_E_FLOOR:${availableWh.toFixed(0)}Wh<${floorWh}Wh`,
      };
    }

    return {
      basis: "LEGACY_PERCENTAGE",
      belowFloor: this.battery <= BATTERY_CRITICAL_THRESHOLD,
      belowInterruptCondition: this.battery < CHARGING_INTERRUPT_BATTERY,
      interruptReason: `CHARGING_BELOW_INTERRUPT_THRESHOLD:${this.battery.toFixed(1)}%`,
      floorReason: `BATTERY_CRITICAL:${this.battery.toFixed(1)}%`,
    };
  }

  /**
   * PHASE 7 — §14.6. The state of charge this session is charging **to**.
   *
   * > **Decision: the Charging Scheduler owns and publishes target SoC. The assignment
   * > engine treats the published value as an input constraint.**
   *
   * The agent is one more consumer of that decision, and it consumes it the same way:
   * off the offer's `targetSoc` field where one was published, and off the class default
   * where none was. It never computes one — a simulator that charged to a target it
   * chose itself would be a third scheduler, and §14.6 exists because two were already
   * one too many.
   *
   * @returns {number} target state of charge as a percentage
   */
  _targetSocPercent() {
    const published = this._publishedTargetSoc;
    const fraction = Number.isFinite(published) ? published : TARGET_SOC_FALLBACK;
    return Math.max(0, Math.min(1, fraction)) * 100;
  }

  /**
   * PHASE 7 — §14.6. Percentage points gained in one tick, from the **nonlinear** curve.
   *
   * > A linear rate — as the baseline's simulation uses — will systematically
   * > underestimate time to full and overestimate fleet availability.
   *
   * The step is derived by inverting the same integral the server plans with: ask
   * `chargeCurve` how long a small SoC increment takes at the current state of charge,
   * and scale it to the tick. Near 100 % the curve's tail makes that increment take far
   * longer than it does at 40 %, which is the behaviour a flat `%/tick` cannot produce
   * and the reason `CHARGING_RATE_PER_TICK` is now only the legacy path's rate.
   *
   * If the curve cannot be evaluated the simulator falls back to the legacy linear rate
   * rather than stalling: a simulator that stopped charging on a configuration gap would
   * fail the run for a reason unrelated to what the run is testing.
   *
   * ── STEP 3 / STEP 4: whose pack, and at what temperature ────────────────────
   * `chargeCurve.js` is **untouched** — the CC/CV shape, the temperature derating table
   * and the integrator are exactly as Phase 7 wrote them. What changed is only which
   * inputs are handed to it:
   *
   *   * `packUsableWh` is the unit's **commissioned** `EnergyModel.packNominalWh`, with
   *     `PACK_NOMINAL_WH` (1000 Wh) as the fallback for a unit that has none. A robot
   *     commissioned with a smaller pack previously charged as though it had a 1000 Wh
   *     one, which is the same class of defect as driving at a fleet-constant speed.
   *   * `tempC` is the **simulated pack temperature** rather than the fixed
   *     `CHARGE_PACK_TEMPERATURE_C` (20 °C). The curve has always carried a temperature
   *     derating table; with a constant input it could never fire, so the derating was
   *     present in the model and inert in the simulation. It is now a live term.
   *
   * Neither is a change to the charging *model*. Charge duration still comes from the
   * same integral, and no simulator-only charging equation exists.
   *
   * @returns {number} percentage points
   */
  _chargeStepPercent() {
    const soc = Math.max(0, Math.min(1, this.battery / 100));
    // @structural a probe increment small enough that the curve is locally flat over it
    const probe = 0.01;
    const to = Math.min(1, soc + probe);
    if (to <= soc) return 0;

    // STEP 3 / STEP 4 — same curve, this unit's pack and this unit's temperature.
    const integrated = chargeCurve.timeToChargeSeconds({
      curve: CHARGE_POWER_CURVE,
      fromSoc: soc,
      toSoc: to,
      tempC: this._packC === null ? CHARGE_PACK_TEMPERATURE_C : this._packC,
      chargerClass: CHARGE_CHARGER_CLASS,
      packUsableWh:
        this._specification.packNominalWh !== null
          ? this._specification.packNominalWh
          : PACK_NOMINAL_WH,
      steps: CHARGE_CURVE_INTEGRATION_STEPS,
    });

    if (!integrated.ok || !(integrated.seconds > 0)) return CHARGING_RATE_PER_TICK;

    // @structural milliseconds per second — the instance's period, for the same reason
    // `_stepAlongPath` uses it: the charge gained in a tick is the charge gained in that
    // tick's duration, not in the class default's.
    const tickSeconds = this._telemetryIntervalMs / 1000;
    const socGain = (to - soc) * (tickSeconds / integrated.seconds);
    // @structural fraction to percentage
    return socGain * 100;
  }

  // ── Per-tick simulation ────────────────────────────────────────────────────

  _tick() {
    if (!this.connected || !this.socket?.connected) return;

    const nowMs = Date.now();

    // 0) STEP 4 — advance the thermal environment first, so the two temperatures the
    //    energy model reads in step 5 describe *this* tick rather than the previous one.
    //    Ambient comes from the clock; pack temperature integrates this tick's load.
    const thermal = this._environment.advance({
      nowMs,
      speedMps: this.speed,
      charging: this.status === "CHARGING",
    });
    this._ambientC = thermal.ambientC;
    this._packC = thermal.packC;

    // 1) Update EMA speed target — only when actually moving
    this._updateSpeed();

    // 2) Charging (highest priority)
    this._handleCharging(nowMs);

    // 3) Task navigation (only when not charging), bounded by §18.5's on-agent
    //    autonomous-continuation limit. Checked before advancing rather than after, so
    //    the limit halts the agent instead of being noticed one tick into the breach.
    if (this.status !== "CHARGING" && !this._enforceAutonomousContinuationLimit(nowMs)) {
      this._advanceTask(nowMs);
    }

    // 4) Enter charging if battery critically low and no active task
    if (
      this.battery <= BATTERY_CRITICAL_THRESHOLD &&
      this.status !== "CHARGING" &&
      this.phase === null
    ) {
      this._enterCharging();
    }

    // 5) Battery drain (skipped during charging — handled by _handleCharging)
    if (this.status !== "CHARGING") {
      this._applyBattery();
    }

    // 6) Obstacle report (while moving)
    this._maybeReportObstacle();

    // 7) Keep server offline-detector happy
    try { this.socket.emit("HEARTBEAT"); } catch { /* ignore */ }

    // 8) Emit telemetry, stamped with this tick's instant
    this._emitTelemetry(nowMs);

    // 9) Periodic battery persistence to Redis (every 2 minutes)
    this._maybePersistBattery();

    // 10) Optional simulation snapshot log
    if (typeof rootLogger.simulation === "function") {
      rootLogger.simulation({
        robotId: this.robotId,
        battery: Math.round(this.battery * 10) / 10,
        status:  this.status,
        phase:   this.phase,
        lat:     this.lat,
        lon:     this.lon,
        speed:   Math.round(this.speed * 100) / 100,
      });
    }
  }

  // ── Speed model ──────────────────────────────────────────────────────────

  _updateSpeed() {
    // ISSUES means "navigating on critically low battery", not "stopped" —
    // it's set by _applyBattery() while the robot is still under way. Treating
    // it like a halted state here would decelerate the robot to 0 m/s on the
    // very next tick and strand it mid-route until the battery (never
    // recovers on its own) or task state changes, even though the task stays
    // ASSIGNED/IN_PROGRESS in the DB the whole time.
    const isNavigating = (this.status === "ACTIVE" || this.status === "ISSUES") && this.phase && this.task;
    if (isNavigating) {
      // Target speed varies slightly around the base (smooth with EMA).
      //
      // STEP 4 — drawn from this robot's own seeded stream, not the process-wide
      // `Math.random()`. Same distribution, same visible behaviour; what changes is that
      // the trace is reproducible and that a second robot's draws no longer shift this
      // robot's. The base and jitter are the instance's configured values.
      this._targetSpeed =
        this._speedBaseMs + (this._speedRandom() - 0.5) * this._speedJitter;
      this.speed =
        this.speed * (1 - SPEED_EMA_ALPHA) +
        this._targetSpeed * SPEED_EMA_ALPHA;
      // STEP 3 — the instance's own envelope, derived from its commissioned speeds where
      // it has them. Reading the module constants here was what pinned a 1.2 m/s unit to
      // the 5.0 m/s fleet floor no matter what the constructor resolved.
      this.speed = Math.max(this._speedMinMs, Math.min(this._speedMaxMs, this.speed));
    } else if (this.status !== "CHARGING") {
      // Decelerate smoothly to zero
      this.speed = this.speed * 0.5;
      if (this.speed < 0.05) this.speed = 0;
    }
    // During CHARGING speed is always 0 (set in _enterCharging)
  }

  // ── Task advancement ───────────────────────────────────────────────────────

  _advanceTask(nowMs) {
    if (!this.task || !this.phase) {
      if (this.status === "ACTIVE") this.status = "IDLE";
      return;
    }

    // ── STEP 8: one loop over the authoritative mission sequence ──────────────
    //
    // What this replaced was a four-case switch hard-wired to PICKUP→DROP. It could not
    // express a third stop, so a plan with a charging stop inserted by §14.6's scheduler
    // was executed as its first two stops and then reported `TASK_COMPLETE` — a delivery
    // claimed for a payload still aboard.
    //
    // The model is now literally "for every stop in the sequence, execute the stop": two
    // phases per stop, driven by `stopIndex`, with the phase *names* derived from the
    // stop's own type so `TO_PICKUP` / `WAIT_PICKUP` / `TO_DROP` / `WAIT_DROP` still
    // appear exactly where they always did for an ordinary two-stop mission. Nothing here
    // knows how many stops there are, so nothing here can truncate.
    const stop = this.task.stops?.[this.stopIndex];
    if (!stop) {
      // The index walked past the end without completion being emitted. That is a defect
      // rather than an ordinary state, and it is made loud instead of silently completing
      // a mission whose stops were not all executed.
      this.log.error(
        `[VR] ${this.robotId} stop index ${this.stopIndex} is past the end of a ` +
          `${this.task.stops?.length ?? 0}-stop mission — halting rather than reporting completion`,
      );
      this._applyStop("STOP_SEQUENCE_EXHAUSTED");
      return;
    }

    const phases = phasesForStopType(stop.stopType);

    if (this.phase === phases.moving) {
      this._stepAlongPath();
      const atEnd = this.pathIndex >= (this.activePath?.length || 0) - 1;
      if (atEnd) {
        const last = this.activePath?.[this.activePath.length - 1];
        if (last) { this.lat = last.lat; this.lon = last.lon; }
        this.phase     = phases.waiting;
        this.waitUntil = nowMs + stop.dwellMs;
        this.speed     = 0;
        this.log.info(
          `[VR] ${this.robotId} reached stop ${this.stopIndex + 1}/${this.task.stops.length} ` +
            `(${stop.stopType || "UNTYPED"}) — waiting ${stop.dwellMs / 1000}s`,
        );
      }
      return;
    }

    if (this.phase === phases.waiting) {
      this.speed = 0;
      if (nowMs < (this.waitUntil || 0)) return;

      // The stop's work is done. Custody changes here, which is what makes the payload
      // mass term in the energy model track the mission rather than the whole trip.
      if (stop.stopType === "PICKUP") this._carryingPayload = true;
      if (stop.stopType === "DROP") this._carryingPayload = false;
      if (stop.stopType === "CHARGE") {
        // Recorded, not simulated. See `STOP_DWELL_MS`: delivering charge here would mean
        // inventing the Charging Scheduler's published target, and that is a later batch.
        this._chargeStopsVisited += 1;
        this.log.info(
          `[VR] ${this.robotId} visited CHARGE stop ${this.stopIndex + 1} — no charge delivered ` +
            "(the Charging Scheduler is not part of this batch; the stop was executed, not simulated as a session)",
        );
      }

      const nextIndex = this.stopIndex + 1;

      // More stops to go: advance and keep driving. This is the branch whose absence was
      // the defect.
      if (nextIndex < this.task.stops.length) {
        const next = this.task.stops[nextIndex];
        this.stopIndex  = nextIndex;
        this.pathIndex  = 0;
        this.activePath = next.path;
        this.waitUntil  = null;
        this.phase      = phasesForStopType(next.stopType).moving;
        this.log.info(
          `[VR] ${this.robotId} stop ${nextIndex}/${this.task.stops.length} done — ` +
            `heading to stop ${nextIndex + 1} (${next.stopType || "UNTYPED"})`,
        );
        return;
      }

      // Every stop has been executed. Only now is the mission complete.
      const completedTaskId = this.task.taskId;
      const executed = this.task.stops.length;
      this._clearTask();
      this.status = "IDLE";
      this.speed  = 0;
      this.log.info(`[VR] ${this.robotId} task ${completedTaskId} COMPLETE — ${executed} stop(s) executed`);
      try {
        this.socket.emit("TASK_COMPLETE", { taskId: completedTaskId, timestamp: nowMs });
      } catch { /* ignore */ }
      return;
    }

    // A phase that belongs to no stop in this mission — for instance one left over from a
    // mission that was replaced. Resynchronise onto the current stop rather than stalling.
    this.phase = phases.moving;
  }

  _stepAlongPath() {
    if (!this.activePath || this.activePath.length === 0) return;

    // Total distance budget for this tick (metres).
    // speed (m/s) × tick_interval (s) = real displacement, capped at MOVE_STEP_METERS
    // to guard against GPS teleports in edge cases.
    // STEP 4 — the *instance's* tick period, not the module constant. A configured tick of
    // 4 s that still budgeted 2 s of travel would make the robot cover half the ground its
    // own reported speed claims, so speed, position and timestamp would disagree with each
    // other in the telemetry stream. One period drives the timer and the physics.
    let budgetM = Math.min(
      this.speed * (this._telemetryIntervalMs / 1000),
      MOVE_STEP_METERS
    );

    const path   = this.activePath;
    let   idx    = this.pathIndex;
    let   curLat = this.lat;
    let   curLon = this.lon;

    // Remember where we started (used to compute heading after movement)
    const startLat = curLat;
    const startLon = curLon;

    // Advance through multiple waypoints in a single tick so the robot moves
    // at the correct speed regardless of how densely the path is sampled.
    while (budgetM > 0.001 && idx < path.length) {
      const target = path[idx];
      if (!target || typeof target.lat !== "number") break;

      const dist = haversineMeters(curLat, curLon, target.lat, target.lon);

      if (dist < 0.01) {
        // Already on this waypoint — advance without consuming budget
        if (idx < path.length - 1) { idx++; continue; }
        break;
      }

      if (dist <= budgetM) {
        // Enough budget to reach this waypoint
        this.distanceTravelled += dist;
        budgetM -= dist;
        curLat = target.lat;
        curLon = target.lon;
        if (idx < path.length - 1) idx++;
        else break;
      } else {
        // Move partially toward this waypoint
        const t = budgetM / dist;
        this.distanceTravelled += budgetM;
        curLat = curLat + (target.lat - curLat) * t;
        curLon = curLon + (target.lon - curLon) * t;
        budgetM = 0;
      }
    }

    this.pathIndex = Math.min(idx, path.length - 1);

    // Compute heading clockwise from north.
    // Primary: direction of actual movement this tick (follows road shape exactly).
    // Fallback: direction toward the next upcoming waypoint (when movement was tiny).
    // Both go through wrap-aware EMA so the marker rotates smoothly.
    const dLatMov = curLat - startLat;
    const dLonMov = curLon - startLon;
    let rawHeading = null;

    if (Math.abs(dLatMov) > 1e-8 || Math.abs(dLonMov) > 1e-8) {
      // Use actual movement vector (most accurate)
      rawHeading = ((Math.atan2(dLonMov, dLatMov) * 180) / Math.PI + 360) % 360;
    } else {
      // Too little movement — point toward the next waypoint on the path
      const nextWp = path[Math.min(this.pathIndex, path.length - 1)];
      if (nextWp) {
        const dLat = nextWp.lat - curLat;
        const dLon = nextWp.lon - curLon;
        if (Math.abs(dLat) > 1e-8 || Math.abs(dLon) > 1e-8) {
          rawHeading = ((Math.atan2(dLon, dLat) * 180) / Math.PI + 360) % 360;
        }
      }
    }

    if (rawHeading !== null) {
      if (this._heading !== null) {
        // Wrap-aware EMA: interpolate along the shorter arc to avoid 359°→1° flip
        let delta = rawHeading - this._heading;
        while (delta > 180)  delta -= 360;
        while (delta < -180) delta += 360;
        this._heading = (this._heading + delta * 0.45 + 360) % 360;
      } else {
        this._heading = rawHeading;
      }
    }

    this.lat = curLat;
    this.lon = curLon;
  }

  // ── Battery drain (real-time rates) ───────────────────────────────────────

  /**
   * STEP 5 — one tick's discharge, through §14.2's consumption model.
   *
   * ── What changed, and why it is not a new equation ──────────────────────────
   * This method used to *be* the simulator's energy model: a flat `%/tick` that knew
   * nothing about mass, payload, gradient, duration or temperature, while the assignment
   * engine predicted the same leg with `energy/consumption.legEnergyWh`. Two models, one
   * system, guaranteed to disagree.
   *
   * It now assembles §14.2's leg profile from this agent's own state and calls **that
   * same function**, via `simulatedEnergy`. No equation lives here or there.
   *
   * ── The model refuses today, and that is the correct outcome ────────────────
   * `legEnergyWh` requires every β coefficient, both thermal curves and every profile
   * field. This deployment has declared **no** coefficients — the `EnergyModelParams` row
   * exists with all of them null precisely so the refusal names them — and has **no**
   * terrain source, so climb and descent are absent too. The refusal therefore fires, and
   * consumption falls back to the legacy percentage rate.
   *
   * That fallback is **labelled, never silent**: `_energyBasis` is `LEGACY_PERCENTAGE`,
   * `_energyMissing` carries the exact list of what is undeclared, and `getStatus()`
   * reports both on every read. A `LEGACY_PERCENTAGE` tick is not calibrated, not
   * physical, and is not evidence of anything.
   *
   * When coefficients and terrain *are* supplied, the basis becomes `MODELLED_WH` and the
   * discharge is whatever §14.2 says it is — including the payload, mass, gradient and
   * temperature terms. That path is exercised by test rather than by assumption.
   */
  _applyBattery() {
    if (this.status === "CHARGING") return; // handled by _handleCharging

    const ratePerTick = this.status === "ACTIVE"
      ? BATTERY_DRAIN_ACTIVE   // 100%→20% in 1 h of movement
      : BATTERY_DRAIN_IDLE;    // 100%→20% in 5 h at rest

    // STEP 4 — scaled to this instance's tick period. The two constants above are
    // documented in `constants.js` as wall-clock durations ("100 % → 20 % in 1 hour"),
    // which they only are at the default 2-second tick. An instance configured to tick
    // every 4 seconds and still draining a full tick's worth would deplete at half the
    // documented rate, so the constants' own stated meaning is what fixes the scaling.
    // Exactly 1.0 at the default, so no unconfigured robot's drain changes.
    const legacyPercent = ratePerTick * (this._telemetryIntervalMs / TELEMETRY_INTERVAL_MS);

    const outcome = simulatedEnergy.tickEnergy({
      model: this._energyModelParams,
      profile: this._legProfileForTick(),
      kappa: this._kappa(),
      // The **commissioned** pack, not the fleet constant. `PACK_NOMINAL_WH` (1000 Wh) is
      // the fallback for a unit that has no `EnergyModel.packNominalWh`, and it never
      // overrides one that does.
      packNominalWh:
        this._specification.packNominalWh !== null
          ? this._specification.packNominalWh
          : PACK_NOMINAL_WH,
      legacyPercent,
    });

    this._energyBasis = outcome.basis;
    this._energyMissing = outcome.missing;
    this._lastTickWh = outcome.wh;
    if (Number.isFinite(outcome.wh)) this._cumulativeWh += outcome.wh;

    this.battery = Math.max(BATTERY_MIN, this.battery - outcome.socDeltaPercent);

    // Warn when battery drops below threshold while working
    if (this.battery < BATTERY_WARN_THRESHOLD && this.status === "ACTIVE") {
      this.status = "ISSUES";
    }
  }

  /**
   * STEP 5 — §14.2's leg profile for the interval just elapsed.
   *
   * Every field is measured by this agent about itself, or it is **absent**. Absence is
   * what makes `legEnergyWh` refuse by name, and refusing is the correct answer to an
   * input nobody has supplied — so nothing here is defaulted to make the model succeed.
   *
   * `climbM` / `descentM` are the clearest case: there is no elevation source anywhere in
   * this deployment, so no terrain is passed and the model reports both as missing.
   * Passing `0` would assert a flat campus, which is unknown and, where it is wrong, wrong
   * in the direction that strands a vehicle.
   *
   * @returns {object}
   */
  _legProfileForTick() {
    // @structural milliseconds to seconds
    const tickSeconds = this._telemetryIntervalMs / 1000;
    const moving = this.speed > 0;

    this._totalSeconds += tickSeconds;
    if (moving) this._movingSeconds += tickSeconds;
    else this._dwellSeconds += tickSeconds;

    // §14.2's `n_stop_start_cycles`, counted at the transition rather than sampled: a
    // cycle is a move that follows a stop, which is a fact this agent observes directly.
    if (moving && !this._wasMovingLastTick) this._stopStartCycles += 1;
    this._wasMovingLastTick = moving;

    return simulatedEnergy.buildLegProfile({
      distanceM: this.distanceTravelled,
      movingSeconds: this._movingSeconds,
      dwellSeconds: this._dwellSeconds,
      totalSeconds: this._totalSeconds,
      stopStartCycles: this._stopStartCycles,
      // The commissioned vehicle mass — `Robot.massKg`, read, never invented. Absent for
      // an uncommissioned unit, and the model then refuses rather than guessing a mass.
      vehicleMassKg: this._specification.massKg === null ? undefined : this._specification.massKg,
      payloadMassKg: this._payloadMassKgNow(),
      ambientC: this._ambientC === null ? undefined : this._ambientC,
      packC: this._packC === null ? undefined : this._packC,
      // No elevation source exists. Deliberately not supplied; see the method comment.
      terrain: null,
      compartmentOccupancy: [],
    });
  }

  /**
   * The payload mass this agent is carrying **right now**, in kilograms.
   *
   * Zero is returned only when the agent is provably carrying nothing — it has not yet
   * completed a pickup, or has already made its drop. That zero is a *known* mass, not a
   * default. When it is carrying and the mission declared no mass, the answer is
   * `undefined`, which makes the energy model refuse: an unstated payload is unknown, and
   * §15.1 is explicit that an unknown load is not an absent one.
   *
   * @returns {number|undefined}
   */
  _payloadMassKgNow() {
    if (!this.task || !this._carryingPayload) return 0;
    const declared = this.task.payloadMassKg;
    return Number.isFinite(declared) ? declared : undefined;
  }

  /**
   * κ(a) for this agent, from its persisted `BatteryState`.
   *
   * Falls back to the §14.2 identity when there is no row, which is the same value an
   * uncalibrated row carries. Note what is *not* done here: the sample count is never
   * consulted to decide whether κ is trustworthy, because κ is an input to the model and
   * its trustworthiness is `kappaSampleCount`'s job to report, not this agent's to judge.
   *
   * @returns {number}
   */
  _kappa() {
    const stored = this._batteryState && this._batteryState.kappa;
    return Number.isFinite(stored) && stored > 0 ? stored : 1;
  }

  // ── Battery persistence (every 2 minutes) ────────────────────────────────

  _maybePersistBattery() {
    this._batteryPersistTicks++;
    if (this._batteryPersistTicks < BATTERY_PERSIST_TICKS) return;
    this._batteryPersistTicks = 0;

    if (!this.kv) return;
    const snapshot = Math.round(this.battery * 10) / 10;
    // Fire-and-forget: non-blocking, errors are silently swallowed
    this.kv
      .set(batteryKey(this.robotId), String(snapshot), { ex: BATTERY_KEY_TTL })
      .catch(() => {});
    this.log.debug?.(`[VR] ${this.robotId} battery snapshot saved: ${snapshot}%`);
  }

  // ── Obstacle simulation ───────────────────────────────────────────────────

  _maybeReportObstacle() {
    if (this.status !== "ACTIVE") return;
    // STEP 4 — this robot's own obstacle stream, separate from its speed stream, and the
    // configured rate. Setting `obstacleProbability` to 0 turns obstacle reports off
    // entirely, which is what makes a movement demo repeatable without also making the
    // obstacle path untestable: it is a configured rate, not a removed feature.
    if (this._obstacleRandom() >= this._obstacleProbability) return;

    const obLat   = this.lat + (this._obstacleRandom() - 0.5) * 0.0002;
    const obLon   = this.lon + (this._obstacleRandom() - 0.5) * 0.0002;
    const severity = this._obstacleRandom() < 0.3 ? "HIGH" : "MEDIUM";

    try {
      this.socket.emit("OBSTACLE_REPORT", { lat: obLat, lon: obLon, severity });
      if (typeof rootLogger.obstacle === "function") {
        rootLogger.obstacle({ reportingRobotId: this.robotId, lat: obLat, lon: obLon, severity });
      } else {
        this.log.warn(`[VR] ${this.robotId} obstacle detected (${severity})`);
      }
    } catch { /* ignore */ }
  }

  // ── Telemetry emit ────────────────────────────────────────────────────────

  /**
   * Emit one telemetry frame.
   *
   * ── STEP 4: the frame carries its own instant and its own ordinal ────────────
   * `timestamp` is the instant the *rest of the frame describes* — the same `nowMs` that
   * advanced the route and the charge this tick — and not `Date.now()` read again here.
   * Read again, it would be a few milliseconds after the position it is stamping, and the
   * whole point of a timestamp on a frame is that the reader can treat the values as
   * simultaneous.
   *
   * `sequence` is a per-robot monotonic ordinal, starting at 1 for this instance's first
   * frame. It makes a dropped frame visible as a gap and a duplicated one visible as a
   * repeat, which is the property §4 asks for and which a timestamp alone does not give —
   * two frames in the same millisecond are indistinguishable by time. It is consumed by the
   * *attempt*, so a frame lost in the transport leaves a gap rather than silently
   * renumbering the stream.
   *
   * Neither field is consumed by the server: the telemetry schema is `passthrough()`, so
   * they travel and are stored in neither the live-state key nor the `Telemetry` table. They
   * describe this simulator's own output. Nothing here is, or becomes, physical evidence.
   *
   * @param {number} nowMs the tick instant the frame's values were computed at
   */
  _emitTelemetry(nowMs) {
    if (!this.socket?.connected) return;
    const at = Number.isFinite(nowMs) ? nowMs : Date.now();
    this._telemetrySequence += 1;
    try {
      this.socket.emit("TELEMETRY", {
        robotId:           this.robotId,
        lat:               this.lat,
        lon:               this.lon,
        battery:           Math.round(this.battery * 10) / 10,
        speed:             Math.round(this.speed * 100) / 100,
        status:            this.status,
        distanceTravelled: Math.round(this.distanceTravelled),
        heading:           this._heading !== null ? Math.round(this._heading) : null,
        timestamp:         at,
        sequence:          this._telemetrySequence,
      });
    } catch { /* ignore */ }
  }
}

module.exports = VirtualRobot;

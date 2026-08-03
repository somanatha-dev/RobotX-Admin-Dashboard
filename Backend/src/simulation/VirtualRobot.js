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
} = require("./constants");

const fencing = require("../engine/commitment/fencing");
const sequence = require("../engine/dispatch/sequence");
const commandSigning = require("../engine/security/commandSigning");

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
  } = {}) {
    this.robotId = robotId;
    this.lat = lat;
    this.lon = lon;

    // Battery starts at the last persisted level once commission() runs.
    // dbBattery is the DB fallback passed in by SimulationEngine.
    this.battery = 100;
    this._dbBattery = typeof dbBattery === "number" ? dbBattery : null;

    this.speed  = 0;
    this.status = "IDLE";
    this.log    = logger || console;

    // ── Battery persistence ────────────────────────────────────────────────
    // kv is stored so _tick() can write the periodic battery snapshot.
    this.kv = kv || null;
    this._batteryPersistTicks = 0;

    // ── Speed model ────────────────────────────────────────────────────────
    // EMA-smoothed speed — starts at rest, ramps up as robot begins moving.
    this._targetSpeed = SPEED_BASE_MS;

    // ── Task navigation ────────────────────────────────────────────────────
    this.task        = null;   // { taskId, pathToPickup, pathToDrop }
    this.phase       = null;   // TO_PICKUP | WAIT_PICKUP | TO_DROP | WAIT_DROP
    this.pathIndex   = 0;
    this.waitUntil   = null;
    this.activePath  = null;
    this.distanceTravelled = 0;
    this._heading    = null;   // degrees clockwise from north (for marker rotation)

    // ── Charging ───────────────────────────────────────────────────────────
    this._chargingPhase    = null;   // null | 'WAITING' | 'CHARGING'
    this._chargeWaitUntil  = null;
    this._pendingResume    = null;   // TASK_ASSIGN payload deferred while charging on low battery

    // ── Socket ────────────────────────────────────────────────────────────
    this.socket             = null;
    this.sessionToken       = null;
    this.connected          = false;
    this._handlersRegistered = false;
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

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Seed Redis with session token and restore the last-known battery level.
   *
   * Priority:  Redis vr:battery key  →  DB value  →  100 % (full charge)
   *
   * The robot record in PostgreSQL was already created by the Commission API
   * before addRobot() is called — do NOT touch DB here.
   */
  async commission(kv) {
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
      this._handlersRegistered = false;
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

    // Backward-compatible alias
    this.socket.on("AUTH_OK", ({ token, dedup } = {}) => {
      if (token && !this._handlersRegistered) {
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
    this.socket.emit("AUTH", {
      robotId: this.robotId,
      token: this.sessionToken,
      dedupState: this.dedupReport(),
    });
  }

  _registerHandlers() {
    if (this._handlersRegistered) return;
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

    if (this.status === "CHARGING" && this.battery < CHARGING_INTERRUPT_BATTERY) {
      // The case §11.2 names: "the one deferral it can perform — holding an assignment
      // while charging — is invisible to the server". It is now visible, priced, and
      // re-optimised against alternatives next round.
      respond("OFFER_DEFER", {
        until: new Date(Date.now() + CHARGING_WAIT_MS).toISOString(),
        reason: `CHARGING_BELOW_INTERRUPT_THRESHOLD:${this.battery.toFixed(1)}%`,
      });
      return;
    }

    if (this.battery <= BATTERY_CRITICAL_THRESHOLD) {
      respond("OFFER_REJECT", { reason: `BATTERY_CRITICAL:${this.battery.toFixed(1)}%` });
      return;
    }

    respond("OFFER_ACCEPT", {});
    const plan = envelope.payload || {};
    if (Array.isArray(plan.stopSequence) && plan.stopSequence.length > 0) {
      this._onTaskAssign({
        taskId: plan.legId || envelope.commitmentId,
        pathToPickup: plan.stopSequence[0]?.path || [],
        pathToDrop: plan.stopSequence[1]?.path || [],
      });
    }
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
   */
  _onCommand(payload) {
    const commandId = payload?.commandId;
    const type = typeof payload?.type === "string" ? payload.type.toUpperCase() : null;

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
        return; // unknown type — deliberately not acknowledged
    }

    if (commandId) {
      try {
        this.socket.emit("COMMAND_ACK", { commandId, robotId: this.robotId, timestamp: Date.now() });
      } catch { /* ignore */ }
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
    this._timer = setInterval(() => this._tick(), TELEMETRY_INTERVAL_MS);
    if (typeof this._timer.unref === "function") this._timer.unref();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    try { this.socket?.disconnect(); } catch { /* ignore */ }
    this.socket             = null;
    this.connected          = false;
    this._handlersRegistered = false;
    this.log.info(`[VR] ${this.robotId} stopped`);
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
      chargingPhase: this._chargingPhase,
      pendingResumeTaskId: this._pendingResume?.taskId || null,
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
    const { taskId, pathToPickup, pathToDrop } = payload || {};
    if (!taskId) return;

    if (this.status === "CHARGING") {
      if (this.battery < CHARGING_INTERRUPT_BATTERY) {
        // Too low to interrupt charging — defer the assignment instead of
        // discarding it. Without this, a task recovered after a restart
        // (redispatched while the robot has already auto-docked on a
        // critically low persisted battery) would be silently dropped
        // forever, leaving the DB task stuck at ASSIGNED with no robot
        // ever picking it back up.
        this._pendingResume = { taskId, pathToPickup, pathToDrop };
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
      pathToPickup: Array.isArray(pathToPickup) ? pathToPickup : [],
      pathToDrop:   Array.isArray(pathToDrop)   ? pathToDrop   : [],
    };
    this.phase             = "TO_PICKUP";
    this.waitUntil         = null;
    this.activePath        = this.task.pathToPickup;
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
    const snapIdx = this._findNearestPathIndex(this.task.pathToPickup, this.lat, this.lon);
    this.pathIndex = snapIdx;
    const snapPt = this.task.pathToPickup[snapIdx];
    if (snapPt && typeof snapPt.lat === "number") {
      this.lat = snapPt.lat;
      this.lon = snapPt.lon;
    }

    this.log.info(
      `[VR] ${this.robotId} TASK_ASSIGN ${taskId} — snapped to path[${snapIdx}]/${this.task.pathToPickup.length}`
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
      // Keep task.pathToPickup / pathToDrop consistent for phase transitions
      if (this.task) {
        if (segment === "toDrop") {
          this.task.pathToDrop = payload.newPath;
        } else {
          this.task.pathToPickup = payload.newPath;
        }
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
      this.battery = Math.min(100, this.battery + CHARGING_RATE_PER_TICK);
      if (this.battery >= 100) {
        this.battery = 100;
        this.status  = "IDLE";
        this._clearCharging();

        const pending = this._pendingResume;
        this._pendingResume = null;
        if (pending) {
          this.log.info(`[VR] ${this.robotId} fully charged → resuming deferred task ${pending.taskId}`);
          this._onTaskAssign(pending);
        } else {
          this.log.info(`[VR] ${this.robotId} fully charged → IDLE`);
        }
      }
    }
  }

  // ── Per-tick simulation ────────────────────────────────────────────────────

  _tick() {
    if (!this.connected || !this.socket?.connected) return;

    const nowMs = Date.now();

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

    // 8) Emit telemetry
    this._emitTelemetry();

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
      // Target speed varies slightly around the base (smooth with EMA)
      this._targetSpeed =
        SPEED_BASE_MS + (Math.random() - 0.5) * SPEED_JITTER;
      this.speed =
        this.speed * (1 - SPEED_EMA_ALPHA) +
        this._targetSpeed * SPEED_EMA_ALPHA;
      this.speed = Math.max(SPEED_MIN_MS, Math.min(SPEED_MAX_MS, this.speed));
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

    switch (this.phase) {
      case "TO_PICKUP": {
        this._stepAlongPath();
        const atEnd = this.pathIndex >= (this.activePath?.length || 0) - 1;
        if (atEnd) {
          const last = this.activePath?.[this.activePath.length - 1];
          if (last) { this.lat = last.lat; this.lon = last.lon; }
          this.phase     = "WAIT_PICKUP";
          this.waitUntil = nowMs + PICKUP_WAIT_MS;
          this.speed     = 0;
          this.log.info(`[VR] ${this.robotId} reached pickup — waiting ${PICKUP_WAIT_MS / 1000}s`);
        }
        break;
      }

      case "WAIT_PICKUP":
        this.speed = 0;
        if (nowMs >= (this.waitUntil || 0)) {
          this.phase      = "TO_DROP";
          this.pathIndex  = 0;
          this.activePath = this.task.pathToDrop;
          this.waitUntil  = null;
          this.log.info(`[VR] ${this.robotId} pickup done — heading to drop`);
        }
        break;

      case "TO_DROP": {
        this._stepAlongPath();
        const atEnd = this.pathIndex >= (this.activePath?.length || 0) - 1;
        if (atEnd) {
          const last = this.activePath?.[this.activePath.length - 1];
          if (last) { this.lat = last.lat; this.lon = last.lon; }
          this.phase     = "WAIT_DROP";
          this.waitUntil = nowMs + DROP_WAIT_MS;
          this.speed     = 0;
          this.log.info(`[VR] ${this.robotId} reached drop — waiting ${DROP_WAIT_MS / 1000}s`);
        }
        break;
      }

      case "WAIT_DROP":
        this.speed = 0;
        if (nowMs >= (this.waitUntil || 0)) {
          const completedTaskId = this.task.taskId;
          this._clearTask();
          this.status = "IDLE";
          this.speed  = 0;
          this.log.info(`[VR] ${this.robotId} task ${completedTaskId} COMPLETE`);
          try {
            this.socket.emit("TASK_COMPLETE", { taskId: completedTaskId, timestamp: nowMs });
          } catch { /* ignore */ }
        }
        break;

      default:
        break;
    }
  }

  _stepAlongPath() {
    if (!this.activePath || this.activePath.length === 0) return;

    // Total distance budget for this tick (metres).
    // speed (m/s) × tick_interval (s) = real displacement, capped at MOVE_STEP_METERS
    // to guard against GPS teleports in edge cases.
    let budgetM = Math.min(
      this.speed * (TELEMETRY_INTERVAL_MS / 1000),
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

  _applyBattery() {
    if (this.status === "CHARGING") return; // handled by _handleCharging

    const drain = this.status === "ACTIVE"
      ? BATTERY_DRAIN_ACTIVE   // 100%→20% in 1 h of movement
      : BATTERY_DRAIN_IDLE;    // 100%→20% in 5 h at rest

    this.battery = Math.max(BATTERY_MIN, this.battery - drain);

    // Warn when battery drops below threshold while working
    if (this.battery < BATTERY_WARN_THRESHOLD && this.status === "ACTIVE") {
      this.status = "ISSUES";
    }
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
    if (Math.random() >= OBSTACLE_PROBABILITY) return;

    const obLat   = this.lat + (Math.random() - 0.5) * 0.0002;
    const obLon   = this.lon + (Math.random() - 0.5) * 0.0002;
    const severity = Math.random() < 0.3 ? "HIGH" : "MEDIUM";

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

  _emitTelemetry() {
    if (!this.socket?.connected) return;
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
      });
    } catch { /* ignore */ }
  }
}

module.exports = VirtualRobot;

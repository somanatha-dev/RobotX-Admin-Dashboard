const { toNumberOrNull, toStringOrNull } = require("../../utils/parse");
const telemetryService = require("../../services/telemetry.service");
const { allow } = require("../rateLimit");
const { z } = require("zod");
const { registryKey, buildMergedRegistryState, REGISTRY_TTL: REGISTRY_TTL_SEC } = require("../../services/robotRegistry.service");
const { getZoneForCoordinates, applyZoneChangeSideEffects } = require("../../services/zoneManager.service");
const { haversineMeters } = require("../../utils/distance");
const robotStateCache = require("../../cache/robotStateCache");
// PHASE 5 (§12.3) — progress supervision. The handler *feeds* it; it does not act on it.
const progress = require("../../engine/supervision/progress");
// PHASE 14 (§23.5) — agent reports are untrusted input, validated before use.
const attestation = require("../../engine/security/attestation");
const trustBoundaries = require("../../engine/security/trustBoundaries");
// PHASE 15 remediation (D-6) — the cutover switch is a conjunction; this handler now reads
// both halves through the module that owns the question.
const agentGate = require("../../engine/cutover/agentGate");
// §4.4 execution progress — departure and arrival established from this Observation log.
const legProgress = require("../../services/legProgress.service");
// STEP 5 — the position Observation writer. This handler is the canonical telemetry
// ingestion path, and it is where §2.7's position fact enters the record that
// `indexMaintainer.worker.js` turns into `AgentCellPosition` and the Assignment Engine
// reads. See the module header for why the agent's own timestamp is mandatory.
const positionObservation = require("../../services/positionObservation.service");
// The reported state of charge → `BatteryState.lastObservedSoc`, update-only (see module).
const batteryObservation = require("../../services/batteryObservation.service");
// Gate 1 — the Pi's software stop-latch report (F7 under SOFTWARE_STOP_LATCH).
const stopLatchObservation = require("../../services/stopLatchObservation.service");

// §23.5 — "Persistent implausibility triggers quarantine and a security event."
//
// A single refused report is noise; a sustained pattern is evidence, and the two need
// opposite responses. The counter is per-process and in-memory, bounded by fleet size —
// the same pattern `lastDbFlushAt` and `sockets/rateLimit.js` use — because the *decision*
// it feeds (quarantine) is a durable write that the engine's own quarantine path owns.
// A counter that had to be durable would put a write on the telemetry hot path to
// measure something whose action is taken at most once per agent.
const implausibleReportCounts = new Map();

/**
 * Count one refused report, and report whether the agent has crossed the threshold.
 *
 * @param {string} robotId
 * @param {number} [threshold] `security.implausible_report_quarantine_threshold`
 * @returns {{ count: number, quarantine: boolean, securityEvent: boolean, reason: string|null }}
 */
function recordImplausibleReport(robotId, threshold) {
  const count = (implausibleReportCounts.get(robotId) || 0) + 1;
  implausibleReportCounts.set(robotId, count);
  return { count, ...trustBoundaries.persistentImplausibility({ agentId: robotId, rejections: count, threshold }) };
}

/**
 * Forget an agent's refusal history. Called when a report is accepted: §23.5's threshold
 * is about *persistent* implausibility, and a counter that never decayed would quarantine
 * every long-lived agent eventually.
 *
 * @param {string} robotId
 */
function clearImplausibleReports(robotId) {
  if (implausibleReportCounts.has(robotId)) implausibleReportCounts.delete(robotId);
}

/**
 * Agents for which the unconfigured-threshold warning has already been issued.
 *
 * Logged once per agent rather than once per refused frame: the condition is a
 * deployment-level configuration defect, and a line per telemetry tick would bury it.
 */
const thresholdWarningIssued = new Set();

/**
 * §23.5 — "Persistent implausibility triggers quarantine and a security event."
 *
 * PHASE 14 remediation (P14-R2). One emitter for both refusal paths (the capability
 * claim and the position/energy verdict), because before this only the second one could
 * ever raise the event and the first counted a refusal that nothing ever read.
 *
 * It also states the case §23.5 has no rule for: a threshold that did not resolve. The
 * control is then *off*, and an operator who has never seen this line has no way to tell
 * "no agent has misbehaved" from "the check cannot fire".
 *
 * @param {object} io
 * @param {object} log
 * @param {object} input `{ robotId, escalation, atMs }`
 */
function emitPersistentImplausibility(io, log, input) {
  const source = input || {};
  const escalation = source.escalation || {};

  if (escalation.thresholdConfigured === false) {
    if (!thresholdWarningIssued.has(source.robotId)) {
      thresholdWarningIssued.add(source.robotId);
      log.error?.(
        "SECURITY CONTROL OFF: security.implausible_report_quarantine_threshold did not resolve, so persistent " +
          "implausibility cannot trigger quarantine or a security event (§23.5). Reports are still refused; the " +
          "escalation is not.",
        { robotId: source.robotId, consecutive: escalation.count },
      );
    }
    return;
  }

  if (!escalation.quarantine) return;

  // The event is emitted here; the quarantine itself is the engine's own path
  // (`QUARANTINE`, an agent-scope command), which this handler does not own.
  log.error?.("SECURITY: persistent implausibility", { robotId: source.robotId, detail: escalation.reason });
  io.to("dashboard").emit("SECURITY_EVENT", {
    kind: "PERSISTENT_IMPLAUSIBILITY",
    robotId: source.robotId,
    consecutive: escalation.count,
    reason: escalation.reason,
    timestamp: source.atMs,
  });
}

/**
 * The health tier a legacy `Robot.status` stands for — PHASE 14 remediation (P14-R15).
 *
 * `trustBoundaries.direction()` compares two tiers and calls a *rise* an expansion. The
 * legacy status enum is not a tier, so it is mapped onto one here rather than the module
 * being taught the legacy vocabulary: §23.5's rule is about the direction of the change,
 * and the mapping is the smallest thing that makes the direction computable.
 *
 * Ordered by how much work the agent may be given, not by severity: `ERROR` and `OFFLINE`
 * admit none, `ISSUES` and `PAUSED` admit reduced work, `IDLE`, `ACTIVE` and `CHARGING`
 * are the unrestricted states. A move *up* this scale is the agent declaring itself fitter
 * than the server believes it to be, which is the case §23.5 refuses.
 * @structural the legacy status → §16.4 health-tier ordering
 */
const HEALTH_TIER = Object.freeze({
  OFFLINE: 0,
  ERROR: 0,
  ISSUES: 1,
  PAUSED: 1,
  CHARGING: 2,
  IDLE: 2,
  ACTIVE: 2,
});

/**
 * @param {string} status
 * @returns {number|null} null for a status outside the enum, which `direction()` reads as
 *   NEUTRAL — unknown is never an expansion *or* a restriction.
 */
function healthTierOf(status) {
  const tier = HEALTH_TIER[String(status || "").toUpperCase()];
  return Number.isFinite(tier) ? tier : null;
}

/** When the last accepted fix for each agent was taken, for the kinematic check. */
const lastAcceptedFixAt = new Map();

/**
 * Read a configuration value from the process's pinned snapshot.
 *
 * @param {object} config
 * @param {string} name
 * @param {*} fallback
 * @returns {*}
 */
function configValue(config, name, fallback) {
  const values = config?.values;
  const value = values instanceof Map ? values.get(name) : values?.[name];
  return value === undefined || value === null ? fallback : value;
}

/**
 * Apply §23.5's position and energy rows to one telemetry frame.
 *
 * The **ceiling** for the kinematic check is the agent's MobilityModel maximum speed
 * (§2.2). Where the projected `Agent` carries no mobility model — which is every legacy
 * `Robot` until Phase 2's backfill has run for it — the check reports `INDETERMINATE` and
 * the frame is not refused: an absent ceiling is a missing input, not evidence of a
 * spoof, and refusing on it would take the whole legacy fleet offline. That is §7.3's
 * three-valued discipline applied one layer out.
 *
 * @param {object} input `{ robotId, existing, reported, charging, config, socket }`
 *   `socket` carries the session's resolved shard identity; `enforced` is a per-shard fact
 *   after the D-6 remediation, so a caller that supplies none gets `enforced: false` — the
 *   same fail-closed direction every other reader of the switch takes.
 * @returns {{ refused: boolean, enforced: boolean, reasons: string[], measured: object,
 *             quarantineThreshold: number|undefined }}
 */
function assessAgentReport(input) {
  const source = input || {};
  const reported = source.reported || {};
  const existing = source.existing || {};
  const config = source.config;

  const reasons = [];
  let measured = {};

  const previousAtMs = lastAcceptedFixAt.get(source.robotId) ?? null;

  if (Number.isFinite(reported.lat) && Number.isFinite(reported.lon)) {
    const position = trustBoundaries.validatePosition({
      last:
        Number.isFinite(existing.lat) && Number.isFinite(existing.lon) && previousAtMs !== null
          ? { lat: existing.lat, lon: existing.lon, atMs: previousAtMs }
          : null,
      reported: { lat: reported.lat, lon: reported.lon, atMs: reported.atMs },
      // §2.2's ceiling, where the projection carries one. `maxSpeedMps` is absent on a
      // legacy `Robot` row, which yields INDETERMINATE rather than a refusal.
      maxSpeedMps: existing.maxSpeedMps,
      tolerance: configValue(config, "security.position_plausibility_tolerance", undefined),
    });
    measured = { ...measured, position: position.measured };
    if (position.verdict === trustBoundaries.VERDICT.REJECTED) reasons.push(...position.reasons);
  }

  if (Number.isFinite(reported.battery) && Number.isFinite(existing.battery)) {
    /** @structural percent to ratio */
    const PERCENT = 100;
    const energy = trustBoundaries.validateEnergy({
      lastSoc: existing.battery / PERCENT,
      reportedSoc: reported.battery / PERCENT,
      charging: source.charging === true,
      rateTolerance: configValue(config, "security.energy_rate_tolerance", undefined),
    });
    measured = { ...measured, energy: energy.measured };
    if (energy.verdict === trustBoundaries.VERDICT.REJECTED) reasons.push(...energy.reasons);
  }

  const refused = reasons.length > 0;
  if (!refused && Number.isFinite(reported.lat) && Number.isFinite(reported.lon)) {
    lastAcceptedFixAt.set(source.robotId, reported.atMs);
    // Bounded by fleet size, swept on the same opportunistic schedule as the flush gate.
    if (lastAcceptedFixAt.size > 50_000) {
      for (const [id, at] of lastAcceptedFixAt) {
        if (reported.atMs - at > DB_FLUSH_INTERVAL_MS * 10) lastAcceptedFixAt.delete(id);
      }
    }
  }

  return {
    refused,
    // Enforced only where the engine is the decision path **for this agent's shard**. Off,
    // the verdict is computed and logged so the refusal rate is observable before it is
    // load-bearing (§21.6's shadow discipline applied to a security control). D-6: the
    // shard half is asked here too, so a staged rollout does not begin enforcing on shards
    // it has not reached.
    enforced: engineEnabled(source.socket, config),
    reasons,
    measured,
    quarantineThreshold: configValue(config, "security.implausible_report_quarantine_threshold", undefined),
  };
}

// DB-safe statuses (must map to the RobotStatus Prisma enum)
const ROBOT_STATUS = new Set(["IDLE", "ACTIVE", "PAUSED", "OFFLINE", "ERROR", "ISSUES"]);
// Wider set accepted from robots (RETURNING and CHARGING are virtual-only labels)
const INCOMING_STATUS = new Set(["IDLE", "ACTIVE", "PAUSED", "OFFLINE", "ERROR", "ISSUES", "RETURNING", "CHARGING"]);

const TRANSITIONS = {
  IDLE:     new Set(["ACTIVE", "PAUSED", "ERROR", "ISSUES", "OFFLINE", "CHARGING"]),
  ACTIVE:   new Set(["PAUSED", "IDLE", "ERROR", "ISSUES", "OFFLINE"]),
  PAUSED:   new Set(["ACTIVE", "IDLE", "ERROR", "ISSUES", "OFFLINE", "CHARGING"]),
  CHARGING: new Set(["IDLE", "ACTIVE", "PAUSED", "ERROR", "OFFLINE"]),
  ISSUES:   new Set(["ACTIVE", "PAUSED", "IDLE", "ERROR", "OFFLINE", "CHARGING"]),
  ERROR:    new Set(["IDLE", "ACTIVE", "OFFLINE", "ISSUES"]),
  OFFLINE:  new Set(["IDLE", "ACTIVE", "ERROR", "ISSUES", "PAUSED", "CHARGING"]),
};

// F10: dirty-state/time-based Postgres flush gate for the telemetry pipeline.
// Per-process, in-memory (same pattern as sockets/rateLimit.js) — bounded by
// fleet size (one entry per robotId ever seen live), not per-tick.
//
// The interval is shared with robot.handler.js's HEARTBEAT gate and paired
// with the offline sweep's cutoff — see config/liveness.constants.js for the
// invariant between them.
const { DB_FLUSH_INTERVAL_MS } = require("../../config/liveness.constants");
const lastDbFlushAt = new Map();

// Per-robot sample throttle for the DEBUG-level telemetry log (same
// per-process, bounded-by-fleet-size pattern as lastDbFlushAt above). Default
// gives a once-per-10s-per-robot heartbeat when LOG_LEVEL=debug — enough to
// eyeball the live stream without reproducing full per-tick log volume.
const TELEMETRY_LOG_SAMPLE_MS = Number(process.env.TELEMETRY_LOG_SAMPLE_MS || 10_000);
const lastTelemetryLogAt = new Map();

function mapIncomingStatusToDb(status) {
  // RETURNING is displayed as ACTIVE in the DB (robot is in transit).
  if (status === "RETURNING") return "ACTIVE";
  // CHARGING is not in the Prisma enum — store as PAUSED (robot is stationary).
  // The raw "CHARGING" value is preserved in Redis and broadcast to the dashboard.
  if (status === "CHARGING") return "PAUSED";
  return status;
}


// Pure — builds the value to SET under snapshotState:{robotId}. Split from
// the write itself so the telemetry hot path can queue it into a batched
// pipeline instead of awaiting its own round trip (see handleTelemetry).
function buildSnapshotStateValue({ lat, lon, battery }) {
  return {
    t: Date.now(),
    lat: typeof lat === "number" ? lat : null,
    lon: typeof lon === "number" ? lon : null,
    battery: typeof battery === "number" ? battery : null,
  };
}

// Pure — same decision logic as before, just fed the already-fetched raw
// snapshotState value (from the batched read) instead of doing its own GET.
function computeSnapshotDecision(
  rawPrev,
  { lat, lon, battery },
  { maxSeconds = 15, moveDegreesThreshold = 0.0001, batteryDelta = 2 } = {}
) {
  const now = Date.now();
  let prev = null;
  try {
    prev = rawPrev ? JSON.parse(rawPrev) : null;
  } catch {
    prev = null;
  }

  if (!prev || typeof prev !== "object") return true;

  const prevT = typeof prev.t === "number" ? prev.t : 0;
  if (prevT && now - prevT >= maxSeconds * 1000) return true;

  const pLat = typeof prev.lat === "number" ? prev.lat : null;
  const pLon = typeof prev.lon === "number" ? prev.lon : null;
  const pBat = typeof prev.battery === "number" ? prev.battery : null;

  if (
    pLat !== null &&
    pLon !== null &&
    typeof lat === "number" &&
    typeof lon === "number" &&
    (Math.abs(lat - pLat) > moveDegreesThreshold || Math.abs(lon - pLon) > moveDegreesThreshold)
  )
    return true;

  if (pBat !== null && typeof battery === "number") {
    if (Math.abs(battery - pBat) >= batteryDelta) return true;
  }

  return false;
}

function registerTelemetryHandlers(io, socket, { prisma, kv, logger, appLocals }) {
  const log = logger || console;

  // PHASE 14 remediation (P14-R1) — the pinned configuration snapshot.
  //
  // This handler previously read `socket?.request?.app?.locals?.config`. `socket.request`
  // is the raw HTTP upgrade request; it never passes through the express app, so it has
  // no `app` property and the expression was `undefined` in every deployment. The three
  // §23.5 parameters below therefore never reached `trustBoundaries.js`, and the most
  // consequential of them — `security.implausible_report_quarantine_threshold` — defaults
  // to `Infinity` inside `persistentImplausibility()`, so **persistent implausibility
  // could never trigger quarantine or a security event**, which is the control §23.5
  // names in its own closing sentence.
  const configOf = () => appLocals?.config ?? socket?.request?.app?.locals?.config ?? null;

  const bufferedLimit = Number(process.env.SOCKET_BUFFER_LIMIT_BYTES || 1_000_000);

  function shouldDropForBackpressure() {
    try {
      const ws = socket?.conn?.transport?.ws;
      const amount = ws && typeof ws.bufferedAmount === "number" ? ws.bufferedAmount : null;
      if (amount !== null && Number.isFinite(bufferedLimit) && bufferedLimit > 0) {
        return amount > bufferedLimit;
      }
    } catch {
      // ignore
    }
    return false;
  }

  const numOpt = z.preprocess((v) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (typeof v === "string") {
      const t = v.trim();
      if (!t) return null;
      const n = Number(t);
      return Number.isFinite(n) ? n : null;
    }
    return v;
  }, z.number().nullable().optional());

  const telemetrySchema = z
    .object({
      robotId: z.union([z.string(), z.number()]).optional().transform((v) => (v === undefined ? v : String(v))),
      lat: numOpt,
      lon: numOpt,
      speed: numOpt,
      battery: numOpt,
      status: z.union([z.string(), z.number()]).optional().nullable().transform((v) => (v === null || v === undefined ? v : String(v))),
      distanceTravelled: numOpt,
      // STEP 5 — the agent's own measurement instant and its per-frame ordinal. Declared
      // rather than left to `passthrough()` so the wire contract is stated where a reader
      // looks for it: `timestamp` is epoch milliseconds measured **by the agent**, and
      // §2.7 forbids the server substituting its own receipt time for it. Both were
      // already on the wire — `VirtualRobot._emitTelemetry` has sent them since Step 4 —
      // and physical firmware sends the same two fields. One contract, not one per kind
      // of agent. Optional in the schema because a frame without them is still a valid
      // legacy telemetry frame; it simply produces no position Observation.
      timestamp: numOpt,
      sequence: numOpt,
    })
    .passthrough();

  async function handleTelemetry(data) {
    try {
      // Drop frames under transport backpressure (flood protection)
      if (shouldDropForBackpressure()) return;

      if (!allow(socket, "TELEMETRY", { limit: 50, windowMs: 5_000, minIntervalMs: 100 })) return;

      const parsed = telemetrySchema.safeParse(data || {});
      if (!parsed.success) return;
      const payload = parsed.data;

      // F26: every TELEMETRY frame requires a successful AUTH first. Only
      // robot.handler.js's AUTH success path may bind socket.data.robotId —
      // no first-telemetry binding, no unauthenticated fallback.
      if (!socket.data.isAuthed || !socket.data.robotId) {
        socket.emit("AUTH_REQUIRED", { robotId: toStringOrNull(payload?.robotId) });
        return;
      }

      const robotId = toStringOrNull(socket.data.robotId);
      if (!robotId) return;

      // ── PHASE 14 — §23.2 / §23.5: capability is rejected entirely ───────────
      //
      //   > | Capability | Rejected entirely; see §23.2 |
      //
      // The telemetry schema is `passthrough()` by design — an agent may report fields
      // the server does not model — which is exactly the gap a capability claim would
      // arrive through. §23.5's table gives capability one word where every other field
      // gets a validation rule, and the asymmetry is the point: position can be
      // sanity-checked against physics, but a capability claim has nothing to check it
      // against, because the claim *is* the fact.
      //
      // The frame is **dropped**, not stripped. Stripping would let an agent that is
      // trying to escalate carry on reporting position as though nothing had happened,
      // and the security event would be the only trace; dropping makes the attempt cost
      // the attacker their telemetry, which is the correct incentive.
      // P14-R2: the threshold is resolved once per frame and reused, so the capability
      // path below counts against the same §23.5 threshold the position/energy path does.
      // It previously called `recordImplausibleReport(robotId)` with no threshold at all,
      // which meant an agent could send capability claims without limit and never reach
      // quarantine even in a deployment where the threshold *was* resolvable.
      const quarantineThreshold = configValue(configOf(), "security.implausible_report_quarantine_threshold", undefined);

      const capabilityClaims = attestation.findCapabilityClaims(payload);
      if (capabilityClaims.length > 0) {
        log.warn("TELEMETRY carrying a capability claim — frame rejected entirely (§23.2, §23.5)", {
          robotId,
          paths: capabilityClaims.map((claim) => claim.path),
          detail:
            "capabilities derive from the commissioning record plus a signed firmware/hardware attestation, never " +
            "from agent telemetry. A compromised agent claiming hazmat_certified must not thereby become eligible " +
            "for hazmat work.",
        });
        const claimEscalation = recordImplausibleReport(robotId, quarantineThreshold);
        emitPersistentImplausibility(io, log, { robotId, escalation: claimEscalation, atMs: Date.now() });
        return;
      }

      const nowMs = Date.now();
      const now = new Date(nowMs);
      const lat = toNumberOrNull(payload?.lat);
      const lon = toNumberOrNull(payload?.lon);
      const speed = toNumberOrNull(payload?.speed);
      const battery = toNumberOrNull(payload?.battery);
      const status = toStringOrNull(payload?.status);
      const headingIn = toNumberOrNull(payload?.heading);
      // VirtualRobots send distanceTravelled directly; real robots get it accumulated below.
      const distanceTravelledIn = toNumberOrNull(payload?.distanceTravelled);

      const statusRaw = status && INCOMING_STATUS.has(status) ? status : null;
      const statusDb = statusRaw ? mapIncomingStatusToDb(statusRaw) : null;

      // "existing" used to be a fresh `prisma.robot.findUnique` on every
      // single TELEMETRY frame — the dominant per-tick DB cost (confirmed by
      // benchmark: REST latency jumped 77ms -> 21s between 100 and 500
      // concurrently-active robots, tracking Postgres pool contention from
      // this exact read). It's now served from robotStateCache, seeded once
      // at AUTH and kept in sync by every writer of Robot.status/isOnline
      // (see cache/robotStateCache.js for the full list). Falls back to a
      // one-time DB read only on a cache miss, which should be rare.
      let existing = robotStateCache.get(robotId);
      if (!existing) {
        const row = await prisma.robot.findUnique({
          where: { robotId },
          select: { id: true, status: true, lat: true, lon: true, speed: true, battery: true, isOnline: true },
        });
        if (!row) {
          io.to("dashboard").emit("robot_unregistered", { robotId });
          return;
        }
        existing = row;
        robotStateCache.set(robotId, existing);
      }

      // ── PHASE 14 — §23.5's position and energy trust boundaries ────────────
      //
      //   > Position | Kinematic plausibility against the last accepted fix … **A jump
      //   > exceeding achievable speed is rejected, not smoothed.**
      //   > Energy | Monotonicity except while charging; rate-of-change bounds …
      //
      // Rejected, not smoothed, and the frame is dropped rather than partially applied.
      // A smoothed jump is a position that is *plausible and wrong*, and every downstream
      // consumer — feasibility, cost, verification, the availability index — would treat
      // it as measured. Dropping leaves the last accepted fix standing, which is stale and
      // *known* to be stale, and staleness is a condition §2.7 and §7.3 already handle
      // correctly.
      //
      // Gated on `ENGINE_ENABLED` for the same reason every engine behaviour since Phase 4
      // has been: the legacy dispatcher is still the production path, its telemetry
      // contract predates the MobilityModel this check reads a ceiling from, and Phase 15
      // stages the flag. When the flag is off the checks are computed and **logged**, never
      // enforced — so the refusal rate is observable before it is load-bearing.
      const trustVerdict = assessAgentReport({
        robotId,
        existing,
        reported: { lat, lon, battery, atMs: nowMs },
        charging: statusRaw === "CHARGING",
        config: configOf(),
        // D-6: `enforced` is resolved per shard, so the assessment needs the session whose
        // shard identity was bound at AUTH.
        socket,
      });

      if (trustVerdict.refused) {
        const escalation = recordImplausibleReport(robotId, trustVerdict.quarantineThreshold);
        log.warn("TELEMETRY refused by the §23.5 trust boundaries", {
          robotId,
          reasons: trustVerdict.reasons,
          measured: trustVerdict.measured,
          consecutive: escalation.count,
          enforced: trustVerdict.enforced,
        });
        emitPersistentImplausibility(io, log, { robotId, escalation, atMs: nowMs });
        if (trustVerdict.enforced) return;
      } else {
        // §23.5's threshold is about *persistent* implausibility; a counter that never
        // decayed would quarantine every long-lived agent eventually.
        clearImplausibleReports(robotId);
      }

      let statusUpdate = {};
      if (statusDb && ROBOT_STATUS.has(statusDb)) {
        const cur = String(existing.status || "");
        const allowed = TRANSITIONS[cur];
        if (!allowed || allowed.has(statusDb) || cur === statusDb) {
          // ── PHASE 14 remediation (P14-R15) — §23.5 row 4, the asymmetric health rule ──
          //
          //   > | Health / self-report | Accepted for **restricting** the agent (an agent
          //   > may always declare itself unfit) but never for **expanding** eligibility |
          //
          //   > The asymmetry in the health row is deliberate and important: self-reported
          //   > degradation is trusted because a false positive costs one agent-shift,
          //   > while self-reported fitness is not trusted because a false positive risks
          //   > an incident. **This asymmetric trust rule applies to every agent-reported
          //   > field.**
          //
          // The transition table alone is symmetric: `TRANSITIONS.ERROR` admits `IDLE` and
          // `ACTIVE`, so an agent in a fault state could clear its own fault by reporting
          // itself healthy — a self-report expanding its own eligibility, which is exactly
          // the sentence above forbidding it. `trustBoundaries.validateHealth()` was
          // written for this row and, until this remediation, had no production caller.
          //
          // Staged exactly as §23.5's position and energy rows already are: computed and
          // **logged** while `ENGINE_ENABLED` is false so the rate is observable before it
          // is load-bearing, enforced at the same cutover. Returning to service is an
          // operator action — `POST /api/robots/:id/clear-fault`, gated as a
          // `QUARANTINE_OVERRIDE` — not something the agent grants itself.
          const health = trustBoundaries.validateHealth({
            reportedTier: healthTierOf(statusDb),
            currentTier: healthTierOf(cur),
          });

          if (health.applied || !engineEnabled(socket, configOf())) {
            if (!health.applied) {
              log.warn("Self-reported health would expand eligibility — recorded, not applied when enforced (§23.5)", {
                robotId,
                from: cur,
                to: statusDb,
                reasons: health.reasons,
                enforced: false,
              });
            }
            statusUpdate = { status: statusDb };
          } else {
            log.warn("Self-reported health refused: an agent may declare itself unfit, never fit (§23.5)", {
              robotId,
              from: cur,
              to: statusDb,
              reasons: health.reasons,
            });
          }
        } else {
          log.warn("Invalid robot status transition", { robotId, from: cur, to: statusDb, raw: statusRaw });
        }
      }

      // 1) Build full state (enrich minimal payload)
      //
      // Every Redis read this handler needs — live state, snapshot-throttle
      // state, registry state, battery-persist gate — is keyed only by
      // robotId, with no dependency on each other, so they're fetched in one
      // pipelined round trip instead of 4 sequential ones (was: ~4 GET + ~2
      // SET = ~6 round trips/event; benchmark-profiled as ~17% of all CPU
      // samples going into ioredis's per-command socket write). The writes
      // below are similarly queued into one pipeline and flushed once at the
      // end of the handler instead of individually awaited.
      const robotKey = `robot:${robotId}`;
      const snapshotKey = `snapshotState:${robotId}`;
      const registryKeyStr = registryKey(robotId);
      const batteryPersistKey = `vr:batteryPersistAt:${robotId}`;

      const [rawPrevState, rawSnapshotPrev, rawRegistryExisting, rawLastPersist] = await kv
        .pipeline()
        .get(robotKey)
        .get(snapshotKey)
        .get(registryKeyStr)
        .get(batteryPersistKey)
        .exec();

      const writes = kv.pipeline();

      let prevState = null;
      try {
        if (rawPrevState) prevState = JSON.parse(rawPrevState);
      } catch {
        prevState = null;
      }

      const fullState = {
        robotId,
        lat:
          typeof lat === "number"
            ? lat
            : typeof prevState?.lat === "number"
              ? prevState.lat
              : typeof existing.lat === "number"
                ? existing.lat
                : null,
        lon:
          typeof lon === "number"
            ? lon
            : typeof prevState?.lon === "number"
              ? prevState.lon
              : typeof existing.lon === "number"
                ? existing.lon
                : null,
        battery:
          typeof battery === "number"
            ? battery
            : typeof prevState?.battery === "number"
              ? prevState.battery
              : typeof existing.battery === "number"
                ? existing.battery
                : null,
        // Use the RAW incoming status (e.g. "CHARGING") for Redis + socket broadcast.
        // statusDb (e.g. "PAUSED") is used only for the DB write below.
        status:
          statusRaw ||
          (typeof prevState?.status === "string" ? prevState.status : null) ||
          (existing.status ? String(existing.status) : "IDLE"),
        speed:
          typeof speed === "number"
            ? speed
            : typeof prevState?.speed === "number"
              ? prevState.speed
              : typeof existing.speed === "number"
                ? existing.speed
                : 0,
        isOnline: true,
        lastSeenAt: nowMs,
        heading: typeof headingIn === "number" && Number.isFinite(headingIn) ? headingIn : null,
      };

      // distanceTravelled: VirtualRobots send it directly; for real robots we
      // accumulate haversine distance from the previous stored position.
      let distanceTravelled = typeof prevState?.distanceTravelled === "number"
        ? prevState.distanceTravelled
        : 0;

      if (typeof distanceTravelledIn === "number") {
        // VirtualRobot — trust the value it sends.
        distanceTravelled = distanceTravelledIn;
      } else if (
        typeof prevState?.lat === "number" && typeof prevState?.lon === "number" &&
        typeof fullState.lat === "number" && typeof fullState.lon === "number"
      ) {
        // Real robot — accumulate from position delta.
        const moved = haversineMeters(prevState.lat, prevState.lon, fullState.lat, fullState.lon);
        if (Number.isFinite(moved) && moved < 500) { // sanity: ignore GPS jumps > 500 m
          distanceTravelled += moved;
        }
      }

      fullState.distanceTravelled = Math.round(distanceTravelled);

      // 2) Store in Redis (final format) — queued, flushed with the rest of
      // this tick's writes at the end of the handler (see `writes.exec()`).
      writes.set(
        robotKey,
        JSON.stringify({
          lat: fullState.lat,
          lon: fullState.lon,
          battery: fullState.battery,
          status: fullState.status,
          speed: fullState.speed,
          lastSeenAt: fullState.lastSeenAt,
          distanceTravelled: fullState.distanceTravelled,
        }),
        { ex: 15 }
      );

      // 3) F10: Postgres is no longer written on every tick. Redis (steps 2/6/7 below)
      // remains the live source for the dashboard, DTARO, and REST reads — the DB row
      // only needs to be durable enough to survive a restart and to keep the DTARO
      // candidate query (which filters on DB status/isOnline) correct. We flush when:
      //   - status actually transitions (a DB-visible field DTARO's candidate query
      //     filters on), or
      //   - the robot just came back online (isOnline false->true), or
      //   - a dirty-state battery swing (>=2%, matches BATTERY_THRESHOLD-adjacent
      //     eligibility checks) happened since the last flush, or
      //   - DB_FLUSH_INTERVAL_MS has elapsed since the last flush for this robot
      //     (time-based catch-all so the row never goes stale by more than that).
      // Note: movement alone does NOT force a flush — position live-ness is carried
      // by Redis every tick regardless, so gating on distance-since-last-DB-write
      // would defeat the point (a moving robot covers >10m almost every 2s tick).
      // lastSeenAt-based offline detection is unaffected: robot.handler.js's HEARTBEAT
      // path already updates lastSeenAt every ~2s independently of this write.
      const statusChanged =
        Object.prototype.hasOwnProperty.call(statusUpdate, "status") &&
        statusUpdate.status !== String(existing.status || "");
      const reconnected = existing.isOnline === false;
      const batteryChanged =
        typeof fullState.battery === "number" &&
        typeof existing.battery === "number" &&
        Math.abs(fullState.battery - existing.battery) >= 2;
      const lastDbFlush = lastDbFlushAt.get(robotId) || 0;
      const timeDue = nowMs - lastDbFlush >= DB_FLUSH_INTERVAL_MS;

      let superseded = false;
      if (statusChanged || reconnected || batteryChanged || timeDue) {
        try {
          const data = {
            ...(typeof fullState.lat === "number" ? { lat: fullState.lat } : {}),
            ...(typeof fullState.lon === "number" ? { lon: fullState.lon } : {}),
            ...(typeof fullState.battery === "number" ? { battery: fullState.battery } : {}),
            lastSeenAt: now,
            isOnline: true,
            ...statusUpdate,
          };
          if (Object.prototype.hasOwnProperty.call(statusUpdate, "status")) {
            // Stale-write guard. The status was validated above against `existing.status`, the
            // cached value read at the top of this frame, and the frame has awaited since. A
            // newer writer may have changed the row in between: ROBOT_FAULT's ERROR, the
            // disconnect's OFFLINE, an operator's clear-fault. An unconditional write would put
            // this frame's status over it; ERROR → ACTIVE erased a blocking fault and defeated
            // §23.5 (reproduced: TELEMETRY then ROBOT_FAULT back-to-back). So the write applies
            // only while the row still holds the status the transition was validated against
            // (the same compare-and-set as `taskCompletion.recordInTx`). On no match nothing is
            // written: the cache is dropped so the next frame reads the row and validates
            // against it, and the flush is not recorded, so that frame flushes again.
            const validatedFrom = existing.status;
            const written = ROBOT_STATUS.has(validatedFrom)
              ? await prisma.robot.updateMany({ where: { robotId, status: validatedFrom }, data })
              : null;
            if (!written || written.count !== 1) {
              superseded = true;
              robotStateCache.del(robotId);
              // The row may be gone rather than changed (decommission mid-session), which the
              // unconditional update reported as P2025: tell the dashboard the same way.
              const row = await prisma.robot.findUnique({ where: { robotId }, select: { status: true } });
              if (!row) {
                io.to("dashboard").emit("robot_unregistered", { robotId });
                return;
              }
              log.warn?.("Telemetry status not written: the robot's status changed after this frame validated it", {
                robotId,
                validatedFrom: validatedFrom ?? null,
                attempted: statusUpdate.status,
                current: row.status,
              });
            }
          } else {
            await prisma.robot.update({ where: { robotId }, data });
          }
          if (!superseded) {
            lastDbFlushAt.set(robotId, nowMs);
            robotStateCache.set(robotId, {
              status: statusUpdate.status || existing.status,
              isOnline: true,
              lat: typeof fullState.lat === "number" ? fullState.lat : existing.lat,
              lon: typeof fullState.lon === "number" ? fullState.lon : existing.lon,
              battery: typeof fullState.battery === "number" ? fullState.battery : existing.battery,
            });
          }
        } catch (e) {
          if (e?.code === "P2025") {
            // Robot was deleted from DB while still connected (admin
            // decommission mid-session) — self-heal: same signal the old
            // per-tick findUnique gave every tick, now surfaced on the
            // write that actually discovers it instead.
            robotStateCache.del(robotId);
            io.to("dashboard").emit("robot_unregistered", { robotId });
            return;
          }
          throw e;
        }
      }

      // 4) Snapshot (optional: time OR movement OR battery delta) — unchanged, still
      // its own independent throttle for the Telemetry history table. Decision
      // uses the batched-read snapshotState value; the write (if due) is
      // queued below instead of its own round trip.
      const shouldSnapshot = computeSnapshotDecision(
        rawSnapshotPrev,
        { lat: fullState.lat, lon: fullState.lon, battery: fullState.battery },
        { maxSeconds: 15, moveDegreesThreshold: 10 / 111320, batteryDelta: 2 }
      );
      if (shouldSnapshot) {
        await telemetryService.saveTelemetry(prisma, existing.id, { lat: fullState.lat, lon: fullState.lon, speed: fullState.speed, battery: fullState.battery }, now);
        writes.set(
          snapshotKey,
          JSON.stringify(buildSnapshotStateValue({ lat: fullState.lat, lon: fullState.lon, battery: fullState.battery })),
          { ex: 86400 }
        );

        // ── STEP 5 — the canonical position Observation (§2.7) ─────────────
        //
        // Here, and not earlier, for three reasons that are each load-bearing:
        //
        //   1. **After acceptance.** Every refusal above has already returned or been
        //      recorded: an unauthenticated frame never reaches this line (F26), a frame
        //      carrying a capability claim was dropped whole (§23.2), and a frame the
        //      §23.5 trust boundaries refused is skipped below. An Observation is the
        //      durable record of a fact about the physical world; writing one from a frame
        //      the server has just called implausible would put a known-bad position into
        //      the evidence log and, through the index, into candidate search.
        //   2. **Every accepted frame — not the history table's throttle.** This used
        //      to share `shouldSnapshot` (15 s, or 10 m, or a 2 % battery swing) on the
        //      grounds that index lag costs search quality, never correctness. That missed
        //      the readers that judge this row's *age*: F16 holds it to
        //      `connectivity.max_heartbeat_age` (10 s) and §12.5's completion verification
        //      requires a fix rate and a maximum gap. At a 15 s cadence every idle agent
        //      was stale a third of the time and no delivery could ever verify (measured
        //      on the V1 demonstration path, 2026-09-23: 2 fixes in a 26 s mission). The
        //      evidence log's cadence is now the agent's own reporting cadence; the
        //      `Telemetry` history keeps its throttle.
        //   3. **The reported position, never `fullState`.** `fullState.lat/lon` fall back
        //      to the previous tick's or the DB row's values, and pairing one of those
        //      with this frame's agent timestamp would manufacture a measurement that was
        //      never taken. `recordPositionObservation` refuses a frame with no reported
        //      position of its own.
        //
        // Not gated on the cutover switch. An Observation is a *measurement*, in the same
        // category as the `Telemetry` row written one line above, and recording what an
        // agent reported is not the engine acting as the decision path. The gate belongs
        // where a decision is taken — `offer.handler.js` and the coordinator — and it is
        // untouched there.
      }

      // STEP 5 — the canonical position Observation (§2.7); see the note above.
      if (!trustVerdict.refused) {
        await writePositionObservation({
          prisma,
          log,
          robotId,
          lat,
          lon,
          payload,
          snapshot: configOf(),
        });

        // §14 — the charge the energy decision plans from is the charge the agent just
        // reported, not the one it was commissioned with. Update-only, contained: a failed
        // write costs the engine a fresher SoC, never the telemetry frame.
        try {
          await batteryObservation.recordReportedSoc(prisma, {
            robotId,
            batteryPct: battery,
            agentTimestampMs: positionObservation.agentTimestampFrom(payload),
            // P2B-2 — a physical unit's SoC is written only with a declared measurement
            // basis (`energy.socMethod`); provenance from the same binding the position
            // writer uses.
            provenance: typeof battery === "number" ? await positionObservation.provenanceOf(prisma, robotId) : null,
            socMethod: payload && payload.energy && typeof payload.energy === "object" ? payload.energy.socMethod : undefined,
          });
        } catch (e) {
          log.warn?.("reported state of charge not recorded", { robotId, message: e?.message });
        }

        // §4.4 — the fix just recorded is the evidence for a departure or an arrival on
        // the agent's live Leg (engine path only). Contained: progress bookkeeping must not
        // cost a telemetry frame.
        if (engineEnabled(socket, configOf())) {
          try {
            const agentRow = await prisma.agent.findUnique({ where: { agentId: robotId }, select: { id: true } });
            if (agentRow) {
              // `io`/`kv`: a held custody release applied at this arrival can settle the Leg and
              // complete its Task (C5).
              const advanced = await legProgress.onPositionFix({ prisma, agentRowId: agentRow.id, snapshot: configOf(), io, kv });
              if (advanced && advanced.outcome) {
                log.info?.("leg progress", { robotId, outcome: advanced.outcome, from: advanced.from, to: advanced.to, reason: advanced.reason || null, detail: advanced.detail || null });
              }
            }
          } catch (e) {
            log.warn?.("leg progress failed", { robotId, message: e?.message });
          }
        }
      }

      // DTARO: telemetry fields + utilization EMA + zone membership, merged
      // into a single registry read-modify-write — computed here (pure) from
      // the batched-read registry value and queued into the same write
      // pipeline as everything else this tick, instead of mergeRobotState's
      // own independent GET+SET. Zone lookup itself (getZoneForCoordinates)
      // is a separate, cheap, in-process-cached call — not a per-tick Redis
      // hit (see zoneManager.service.js's 3-tier cache).
      let zoneChangeInfo = null;
      try {
        const zone =
          typeof fullState.lat === "number" && typeof fullState.lon === "number"
            ? await getZoneForCoordinates(prisma, kv, fullState.lat, fullState.lon)
            : null;
        // undefined = "position unknown this tick, don't touch zoneId" —
        // distinct from null, which means "known position, outside all zones".
        const newZoneId = zone?.id ?? (zone === null && typeof fullState.lat === "number" ? null : undefined);

        const mergedRegistry = buildMergedRegistryState(robotId, rawRegistryExisting, (existing) => {
          const prevUtil = typeof existing.utilization === "number" ? existing.utilization : 0;
          const alpha = 0.05;
          const isActive = fullState.status === "ACTIVE" ? 1 : 0;
          const nextUtil = Math.max(0, Math.min(1, prevUtil + alpha * (isActive - prevUtil)));

          const prevZoneId = existing.zoneId ?? null;
          const resolvedZoneId = newZoneId !== undefined ? newZoneId : prevZoneId;
          if (newZoneId !== undefined && newZoneId !== prevZoneId) {
            zoneChangeInfo = { oldZoneId: prevZoneId, newZoneId, zoneName: zone?.name || null };
          }

          return {
            lat: fullState.lat,
            lon: fullState.lon,
            battery: fullState.battery,
            status: fullState.status,
            speed: fullState.speed,
            lastHeartbeat: nowMs,
            utilization: nextUtil,
            zoneId: resolvedZoneId,
          };
        });
        writes.set(registryKeyStr, JSON.stringify(mergedRegistry), { ex: REGISTRY_TTL_SEC });
      } catch {
        // registry update is non-critical
      }

      if (zoneChangeInfo) {
        try {
          await applyZoneChangeSideEffects(
            prisma, io, robotId,
            zoneChangeInfo.oldZoneId, zoneChangeInfo.newZoneId, zoneChangeInfo.zoneName,
            socket
          );
        } catch {
          // zone side-effects are non-critical
        }
      }

      // Persist battery level every ~2 minutes so real robots also survive
      // server restarts with correct battery (mirrors VirtualRobot behaviour).
      // Only write when battery is a valid number and 120-second window
      // elapsed. Gate check uses the batched-read value; writes (if due) are
      // queued below instead of their own Promise.all round trip.
      try {
        if (typeof fullState.battery === "number" && Number.isFinite(fullState.battery)) {
          const persistKey = `vr:battery:${robotId}`;
          const lastPersist = rawLastPersist ? Number(rawLastPersist) : 0;
          if (nowMs - lastPersist >= 120_000) {
            const snap = Math.round(fullState.battery * 10) / 10;
            writes.set(persistKey, String(snap), { ex: 48 * 3600 });
            writes.set(batteryPersistKey, String(nowMs), { ex: 48 * 3600 });
          }
        }
      } catch { /* non-critical */ }

      // Flush this tick's Redis writes — robot:*, registry:*, and whichever
      // of snapshotState:*/vr:battery* were queued above — as one pipelined
      // round trip instead of up to 4 individually-awaited SETs.
      try {
        await writes.exec();
      } catch { /* non-critical — same degrade-gracefully policy as before */ }

      // Gate 1 — the rover's software stop latch (F7 under the physical fleet declaration).
      // Recorded to its own key (`stopLatch:{robotId}`), which no registry write touches, newest
      // report first and bound to this socket (see `stopLatchObservation.service`). Only from an
      // accepted frame. Contained: a failed write costs F7 a fresh reading, never the frame.
      if (!trustVerdict.refused) {
        try {
          await stopLatchObservation.recordStopLatch({ prisma, kv, robotId, payload, snapshot: configOf(), socket });
        } catch (e) {
          log.warn?.("stop latch not recorded", { robotId, message: e?.message });
        }
      }

      // Sampled DEBUG-level telemetry log. Unconditional INFO-level logging
      // here was measured (2026-07-26 CPU profile) to be a meaningful share
      // of runtime cost for negligible operational value at fleet scale.
      // debug level means it's silent by default in production
      // (LOG_LEVEL=info); the once-per-robot-per-interval sample keeps a live
      // heartbeat available for local debugging (LOG_LEVEL=debug) without
      // reproducing full per-tick volume even then.
      const lastLogAt = lastTelemetryLogAt.get(robotId) || 0;
      if (nowMs - lastLogAt >= TELEMETRY_LOG_SAMPLE_MS) {
        lastTelemetryLogAt.set(robotId, nowMs);
        log.debug(`[ROBOT ${robotId}] TELEMETRY`, { lat, lon, speed, battery, status });
      }

      // 5) Emit live state to dashboard clients.
      // Single canonical event — frontend subscribes only to "robot:update".
      // "ROBOT_UPDATE" and "robot_update" were legacy aliases; removed to
      // eliminate 2 redundant socket emissions and 1 DB query per tick.
      // Was a global io.emit (every connected socket, including every OTHER
      // robot, which have no use for this event) — an O(N²) fan-out pattern
      // at fleet scale, flagged in docs/history/legacy-system-reference.md
      // §16. Scoped to the dashboard
      // room, which only browser dashboard clients join.
      io.to("dashboard").emit("robot:update", fullState);

      // PHASE 5 (§12.3) — feed progress supervision.
      //
      // > Lease renewal proves liveness; it does not prove *progress*. An agent can
      // > heartbeat happily while stationary behind an obstacle.
      //
      // The telemetry stream is where the five §12.3 signals get their inputs, so this
      // is where they are measured. It is deliberately a *measurement*: the responses
      // §12.3 prescribes — probe, re-project, divert, quarantine — are transitions, and
      // transitions belong to the timer handlers and the reconciler, which take them
      // under the §4.4 guards and the conditional-write discipline. A socket handler
      // that acted directly would be a second, unguarded supervisor.
      //
      // Inert while `ENGINE_ENABLED` is false, and cheap when it is: `assessAll` is pure
      // and allocates one small object per tick.
      feedProgressSupervision({ robotId, log, io, state: fullState, nowMs, socket, snapshot: configOf() });
    } catch (e) {
      log.error("TELEMETRY handler failed", e);
    }
  }

  socket.on("TELEMETRY", handleTelemetry);
  // Backward compatible alias.
  socket.on("telemetry", handleTelemetry);
}

/**
 * STEP 5 — the last position-observation outcome logged for each robot.
 *
 * Logged on *change* rather than per frame, and per robot rather than per process, because
 * the two outcomes an operator needs are opposite in shape. `NO_AGENT_TIMESTAMP` is a
 * deployment-level condition — this unit's firmware does not send the field, so it will
 * never be indexed and will never be a candidate — and it is true of every frame until
 * somebody changes the agent. A line per tick would bury it; a line the first time, and
 * again whenever the answer changes, is what makes it findable. `STALE_SEQUENCE` and
 * `STALE_OBSERVED_AT`, by contrast, are ordinary and expected on a reconnect.
 *
 * Per-process and bounded by fleet size, exactly like `lastDbFlushAt` and
 * `thresholdWarningIssued` above it.
 */
const lastPositionOutcome = new Map();

/**
 * Append one accepted telemetry position to the §2.7 Observation log.
 *
 * ── Contained, and deliberately not silent ──────────────────────────────────
 * A failure here must not take down the telemetry pipeline: the live state, the dashboard
 * and the legacy read model do not depend on the engine's evidence log, and turning an
 * insert failure into a thrown handler would trade a missing index entry for a lost
 * telemetry frame. But it is logged at `error`, not swallowed — a pipeline that quietly
 * stopped producing observations would present as "the Assignment Engine has no
 * candidates", which is the hardest possible place to diagnose it from.
 *
 * @param {object} input `{ prisma, log, robotId, lat, lon, payload }`
 * @returns {Promise<object|null>} the writer's result, or null when it threw
 */
async function writePositionObservation(input) {
  const { prisma, log, robotId, lat, lon, payload, snapshot } = input;
  try {
    const result = await positionObservation.recordPositionObservation(prisma, {
      robotId,
      lat,
      lon,
      agentTimestampMs: positionObservation.agentTimestampFrom(payload),
      sequence: positionObservation.sequenceFrom(payload),
      // P2B-2 — §10.6's bound on the agent's clock, and the contract's optional fix block.
      maxClockSkewMs: positionObservation.maxClockSkewMsFrom(snapshot || null),
      // C4 — passed as sent: a malformed block must reach the writer to be refused, not be
      // mistaken for an absent one.
      fix: payload && payload.position !== undefined ? payload.position : null,
    });

    if (lastPositionOutcome.get(robotId) !== result.outcome) {
      lastPositionOutcome.set(robotId, result.outcome);
      if (result.written) {
        log.debug?.("position Observation recorded (§2.7)", {
          robotId,
          provenance: result.provenance,
          observedAtMs: result.observedAtMs,
        });
      } else {
        log.warn("no position Observation recorded for this telemetry frame (§2.7)", {
          robotId,
          outcome: result.outcome,
          detail: result.detail,
          consequence:
            "this agent produces no AgentCellPosition row and is therefore not a candidate for assignment " +
            "until the outcome changes",
        });
      }
    }

    if (lastPositionOutcome.size > 50_000) lastPositionOutcome.clear();
    return result;
  } catch (e) {
    log.error("position Observation write failed", { robotId, message: e?.message });
    return null;
  }
}

/**
 * PHASE 5 (§12.3) — the progress-supervision feed.
 *
 * Per-process, bounded-by-fleet-size, exactly like `lastDbFlushAt` above: one entry per
 * robot ever seen live. It holds the last position and the instant at which route
 * progress was last observed, which is what §12.3 row 1 measures against
 * `supervise.stall_time`.
 *
 * ── What is measured here, and what is not ──────────────────────────────────
 * Row 1 (stall) is measurable from the telemetry stream alone. Rows 2, 3 and 5 need the
 * *committed plan* — a projected ETA, a predicted Wh figure, a route corridor — which
 * the engine holds and the legacy telemetry path does not. Those are assessed by the
 * supervisor against the commitment, using the same pure functions; feeding them a
 * fabricated projection here would produce a signal about a plan nobody made.
 *
 * So this measures what it can see and says so, rather than inventing the rest. The
 * alternative — a partial signal presented as the whole — is worse than an explicit gap,
 * because it looks like coverage.
 */
const lastRouteProgressAt = new Map();
const lastKnownPosition = new Map();

/** @structural the movement below which a position report is not route progress, in metres */
const PROGRESS_EPSILON_M = 1;

/**
 * PHASE 15 remediation (D-6) — both halves of the cutover switch.
 *
 * This handler's two uses are *read*-side: whether §23.5's trust-boundary verdict is
 * **enforced** rather than merely logged, and whether a self-reported health expansion is
 * refused. Neither writes an engine row, which is why they were the lower-severity half of
 * the finding — but "enforced" is a per-shard fact for the same reason everything else in
 * the cutover is: a shard the staging order has not reached is not one whose agents should
 * find a new refusal appearing on their telemetry.
 *
 * The socket is required, so a caller that cannot name a session gets `false` — the same
 * disposition `enabled.forShard()` gives a caller that cannot name a shard.
 *
 * @param {object} socket
 * @param {object|null} snapshot
 * @returns {boolean}
 */
function engineEnabled(socket, snapshot) {
  return agentGate.mayAct({ socket, snapshot, nowMs: Date.now() });
}

/**
 * @param {object} input
 * @param {string} input.robotId
 * @param {object} input.log
 * @param {object} input.io
 * @param {object} input.state the merged live state this tick
 * @param {number} input.nowMs
 * @returns {object|null} the assessment, or null when the engine is off
 */
function feedProgressSupervision({ robotId, log, io, state, nowMs, socket, snapshot }) {
  // D-6: both halves. Progress supervision feeds §12.3 for the shard that owns this agent,
  // and a shard the staging order has not reached has no supervisor to feed.
  if (!engineEnabled(socket, snapshot)) return null;

  try {
    const previous = lastKnownPosition.get(robotId);
    const lat = typeof state?.lat === "number" ? state.lat : null;
    const lon = typeof state?.lon === "number" ? state.lon : null;

    if (lat === null || lon === null) return null;

    const movedMetres = previous ? haversineMeters(previous.lat, previous.lon, lat, lon) : Infinity;
    if (movedMetres > PROGRESS_EPSILON_M) {
      lastRouteProgressAt.set(robotId, nowMs);
      lastKnownPosition.set(robotId, { lat, lon });
    } else if (!lastRouteProgressAt.has(robotId)) {
      lastRouteProgressAt.set(robotId, nowMs);
    }

    const stallTimeSeconds = Number(process.env.SUPERVISE_STALL_TIME_SECONDS);
    // No resolved configuration, no assessment. §22.1: a threshold that is not resolved
    // from the register is not a threshold, and defaulting one here would put a
    // behavioural constant outside the register.
    if (!Number.isFinite(stallTimeSeconds) || stallTimeSeconds <= 0) return null;

    const assessment = progress.assessStall({
      secondsSinceRouteProgress: (nowMs - (lastRouteProgressAt.get(robotId) || nowMs)) / 1000,
      stallTimeSeconds,
    });

    if (assessment.fired) {
      // Reported, not acted on. The response belongs to the supervisor.
      log.warn("progress supervision: stall signal", {
        robotId,
        signal: assessment.signal,
        reason: assessment.reason,
        response: assessment.response,
        measured: assessment.measured,
      });
      io.to("dashboard").emit("SUPERVISION_SIGNAL", {
        robotId,
        signal: assessment.signal,
        response: assessment.response,
        at: nowMs,
      });
    }

    return assessment;
  } catch {
    // Supervision is a safety net; a defect in the net must not take down the telemetry
    // pipeline it hangs under.
    return null;
  }
}

/** Test seam — the two per-process maps are module state, and a test needs them clean. */
function resetProgressSupervisionState() {
  lastRouteProgressAt.clear();
  lastKnownPosition.clear();
}

/**
 * PHASE 14 — clear the per-process §23.5 state between tests, matching
 * `resetProgressSupervisionState`'s purpose. Both maps are per-process caches whose
 * survival across tests would make one test's refusals another test's quarantine.
 */
function resetTrustBoundaryState() {
  implausibleReportCounts.clear();
  lastAcceptedFixAt.clear();
}

/**
 * STEP 5 — clear the per-process outcome-log gate, for the same reason as the two above:
 * one test's first frame must not be another test's "outcome unchanged, do not log".
 */
function resetPositionObservationLogState() {
  lastPositionOutcome.clear();
}

module.exports = {
  registerTelemetryHandlers,
  feedProgressSupervision,
  resetProgressSupervisionState,
  assessAgentReport,
  recordImplausibleReport,
  resetTrustBoundaryState,
  resetPositionObservationLogState,
};

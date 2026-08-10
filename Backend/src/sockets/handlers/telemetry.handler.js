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
 * @param {object} input `{ robotId, existing, reported, charging, config }`
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
    // Enforced only when the engine is on. Off, the verdict is computed and logged so the
    // refusal rate is observable before it is load-bearing (§21.6's shadow discipline
    // applied to a security control).
    enforced: engineEnabled(),
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

function registerTelemetryHandlers(io, socket, { prisma, kv, logger }) {
  const log = logger || console;

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
        recordImplausibleReport(robotId);
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
        config: socket?.request?.app?.locals?.config,
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
        if (escalation.quarantine) {
          // §23.5 — "Persistent implausibility triggers quarantine and a security event."
          // The event is emitted here; the quarantine itself is the engine's own path
          // (`QUARANTINE`, an agent-scope command), which this handler does not own.
          log.error?.("SECURITY: persistent implausibility", { robotId, detail: escalation.reason });
          io.to("dashboard").emit("SECURITY_EVENT", {
            kind: "PERSISTENT_IMPLAUSIBILITY",
            robotId,
            consecutive: escalation.count,
            reason: escalation.reason,
            timestamp: nowMs,
          });
        }
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
          statusUpdate = { status: statusDb };
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

      if (statusChanged || reconnected || batteryChanged || timeDue) {
        try {
          await prisma.robot.update({
            where: { robotId },
            data: {
              ...(typeof fullState.lat === "number" ? { lat: fullState.lat } : {}),
              ...(typeof fullState.lon === "number" ? { lon: fullState.lon } : {}),
              ...(typeof fullState.battery === "number" ? { battery: fullState.battery } : {}),
              lastSeenAt: now,
              isOnline: true,
              ...statusUpdate,
            },
          });
          lastDbFlushAt.set(robotId, nowMs);
          robotStateCache.set(robotId, {
            status: statusUpdate.status || existing.status,
            isOnline: true,
            lat: typeof fullState.lat === "number" ? fullState.lat : existing.lat,
            lon: typeof fullState.lon === "number" ? fullState.lon : existing.lon,
            battery: typeof fullState.battery === "number" ? fullState.battery : existing.battery,
          });
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
      feedProgressSupervision({ robotId, log, io, state: fullState, nowMs });
    } catch (e) {
      log.error("TELEMETRY handler failed", e);
    }
  }

  socket.on("TELEMETRY", handleTelemetry);
  // Backward compatible alias.
  socket.on("telemetry", handleTelemetry);
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

function engineEnabled() {
  return process.env.ENGINE_ENABLED === "true";
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
function feedProgressSupervision({ robotId, log, io, state, nowMs }) {
  if (!engineEnabled()) return null;

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

module.exports = {
  registerTelemetryHandlers,
  feedProgressSupervision,
  resetProgressSupervisionState,
  assessAgentReport,
  recordImplausibleReport,
  resetTrustBoundaryState,
};

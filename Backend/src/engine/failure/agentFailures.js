"use strict";

/**
 * The agent-level failure catalogue (§18.2) — **Tier 0**.
 *
 * > 1. **Every failure has a detector with a bounded detection latency.** An undetected
 * >    failure is the worst kind; the audit lists nine baseline failure modes whose
 * >    detection is "No."
 * > 2. **Every failure has a defined automatic response and a defined escalation.**
 * >    Undefined behaviour under failure is a design defect, not an operational surprise.
 * > 3. **Responses are custody-aware** (§2.5).
 * > 4. **Degradation reduces the envelope, never the safety margin** (T3).
 * > 5. **Every automatic response is counted and alerted** (T10).
 *
 * The twenty rows of §18.2 are transcribed here as data, with each of the four columns
 * the table gives — detection, latency, response, escalation — as a required field.
 * `catalogue.js` refuses a row missing any of them, which is principles 1 and 2 expressed
 * as a build-time property rather than as a review habit.
 *
 * ── Custody-awareness is a field, not a paragraph ───────────────────────────
 * Principle 3 splits the response of half these rows in two: *"Before custody, software
 * recovers. After custody, physical logistics recovers, and software's job is to route the
 * physical response quickly and accurately."* Where §18.2 states both halves — A1, A5, A14
 * — the row carries `preCustody` and `postCustody` separately, so a caller cannot apply
 * the wrong one by reading past a comma.
 *
 * ── The one mechanism in this module that is more than a table ──────────────
 * A3's bounded dead-zone lease extension. §18.2 spends more words on it than on any other
 * row, because it is the one automatic response that grants *immunity from supervision*
 * during the window when the agent is least observable. `deadZoneExtension()` and
 * `supervisionRestoration()` implement the three properties that make that safe: the
 * extension is derived from a **p95** and refuses any other statistic, it is **capped**,
 * and it is closed by a **corroborated exit** rather than by elapsing.
 *
 * ── No clock, no store ──────────────────────────────────────────────────────
 * Time is supplied. Every function here is pure, so a recovery decision replays.
 */

const modeRegister = require("../degraded/modeRegister");

/**
 * §2.5 — which side of custody a response applies to.
 * @structural the custody partition of §18.1 principle 3
 */
const CUSTODY_PHASE = Object.freeze({
  PRE_CUSTODY: "PRE_CUSTODY",
  POST_CUSTODY: "POST_CUSTODY",
  EITHER: "EITHER",
});

/**
 * The escalation dispositions §18.2's last column uses.
 * @structural the escalation vocabulary of §18.2
 */
const ESCALATION = Object.freeze({
  NONE: "NONE",
  ALERT: "ALERT",
  PAGE: "PAGE",
  ALWAYS_PAGE: "ALWAYS_PAGE",
  MAINTENANCE_TICKET: "MAINTENANCE_TICKET",
  OPERATOR_QUEUE: "OPERATOR_QUEUE",
  SECURITY_EVENT: "SECURITY_EVENT",
  EXTERNAL_CHAIN: "EXTERNAL_CHAIN",
  FLEET_WIDE_ALERT: "FLEET_WIDE_ALERT",
  DISPUTE_PROCESS: "DISPUTE_PROCESS",
  SYSTEMIC_CHECK: "SYSTEMIC_CHECK",
});

/**
 * How a detector establishes the failure. Recorded per row because principle 1's
 * "bounded detection latency" is only meaningful next to the thing doing the detecting.
 * @structural the detection vocabulary of §18.2
 */
const DETECTION = Object.freeze({
  SESSION_CLOSE: "SESSION_CLOSE",
  HEARTBEAT_MISS: "HEARTBEAT_MISS",
  MAPPED_ZONE_ENTRY: "MAPPED_ZONE_ENTRY",
  AGENT_REPORT: "AGENT_REPORT",
  SELF_TEST: "SELF_TEST",
  HEALTH_MONITOR: "HEALTH_MONITOR",
  COVARIANCE_BREACH: "COVARIANCE_BREACH",
  PROGRESS_SUPERVISION: "PROGRESS_SUPERVISION",
  ENERGY_COMPARISON: "ENERGY_COMPARISON",
  ENERGY_PROJECTION: "ENERGY_PROJECTION",
  ACK_TIMEOUT: "ACK_TIMEOUT",
  NACK: "NACK",
  PLAUSIBILITY_CHECK: "PLAUSIBILITY_CHECK",
  TIMELINE_SUPERVISION: "TIMELINE_SUPERVISION",
  VERIFICATION: "VERIFICATION",
  MANIFEST_RECONCILIATION: "MANIFEST_RECONCILIATION",
  CUSTODY_AND_PROGRESS: "CUSTODY_AND_PROGRESS",
  DEDUP_GENERATION_ADVANCE: "DEDUP_GENERATION_ADVANCE",
  FEASIBILITY_PREDICATE: "FEASIBILITY_PREDICATE",
  TIMESTAMP_COMPARISON: "TIMESTAMP_COMPARISON",
});

/**
 * Detection latency, as §18.2's own third column states it. `latencyParameter` names the
 * register entry where the row's latency is a configured bound; `latencyClass` carries the
 * rows whose latency is a kind rather than a number.
 * @structural §18.2's own latency vocabulary
 */
const LATENCY_CLASS = Object.freeze({
  IMMEDIATE: "IMMEDIATE",
  PREDICTIVE: "PREDICTIVE",
  SECONDS: "SECONDS",
  CONTINUOUS: "CONTINUOUS",
  PER_OBSERVATION: "PER_OBSERVATION",
  AT_EVENT: "AT_EVENT",
  BOUNDED_BY_PARAMETER: "BOUNDED_BY_PARAMETER",
});

/**
 * §18.2's twenty rows, in the specification's own order — including A20 sitting between
 * A17 and A18, which is where the table puts it.
 */
const AGENT_FAILURES = Object.freeze([
  Object.freeze({
    id: "A1",
    failure: "Graceful disconnect",
    detection: DETECTION.SESSION_CLOSE,
    latencyClass: LATENCY_CLASS.IMMEDIATE,
    latencyParameter: null,
    custodyAware: true,
    response: Object.freeze({
      [CUSTODY_PHASE.PRE_CUSTODY]: "reassign after connectivity.grace",
      [CUSTODY_PHASE.POST_CUSTODY]: "monitor for reconnect, then the §4.7 recovery protocol",
    }),
    responseParameters: Object.freeze(["connectivity.grace"]),
    escalation: ESCALATION.OPERATOR_QUEUE,
    escalationDetail:
      "STRANDED_SAFE or STRANDED_OBSTRUCTING by obstruction class if unreachable past the window",
    classifiesStranding: true,
  }),
  Object.freeze({
    id: "A2",
    failure: "Ungraceful disconnect / link loss",
    detection: DETECTION.HEARTBEAT_MISS,
    latencyClass: LATENCY_CLASS.BOUNDED_BY_PARAMETER,
    latencyParameter: "connectivity.max_heartbeat_age",
    custodyAware: true,
    response: Object.freeze({
      [CUSTODY_PHASE.EITHER]:
        "remove from the availability index immediately; the lease continues until expiry to allow " +
        "reconnect; then the §4.7 recovery protocol",
    }),
    // The one row whose custody branch is **delegated rather than stated inline**, and the
    // delegation is the specification's own: §18.2 words A2's response as "… then §4.7" and
    // its escalation as "as A1", and §4.7 is where the custody-NONE and custody-HELD
    // protocols diverge. Restating the branch here would be a second copy of §4.7's
    // three lawful outcomes, which is exactly the drift `supervision/leases.assessRecovery`
    // exists to prevent by being the only implementation of them.
    custodyResolvedBy: "§4.7's recovery protocol, evaluated by supervision/leases.assessRecovery",
    responseParameters: Object.freeze(["connectivity.max_heartbeat_age"]),
    escalation: ESCALATION.OPERATOR_QUEUE,
    escalationDetail: "as A1",
    classifiesStranding: true,
  }),
  Object.freeze({
    id: "A3",
    failure: "Known dead zone en route",
    detection: DETECTION.MAPPED_ZONE_ENTRY,
    latencyClass: LATENCY_CLASS.PREDICTIVE,
    latencyParameter: null,
    custodyAware: false,
    response: Object.freeze({
      [CUSTODY_PHASE.EITHER]:
        "suppress recovery; extend the lease by the 95th percentile of that zone's historical transit " +
        "time for the agent's mobility profile, capped at connectivity.max_deadzone_extension — never " +
        "by a mean or a nominal figure. Normal supervision is restored only on corroborated exit",
    }),
    responseParameters: Object.freeze(["connectivity.max_deadzone_extension"]),
    escalation: ESCALATION.ALERT,
    escalationDetail:
      "alert on every extension that reaches its cap; extension frequency per zone and per agent is a " +
      "monitored signal, since a zone whose extensions routinely run to the cap is mismapped or the " +
      "agent is failing inside it",
    classifiesStranding: false,
  }),
  Object.freeze({
    id: "A4",
    failure: "Emergency stop engaged",
    detection: DETECTION.AGENT_REPORT,
    latencyClass: LATENCY_CLASS.IMMEDIATE,
    latencyParameter: null,
    custodyAware: false,
    response: Object.freeze({
      [CUSTODY_PHASE.EITHER]:
        "mission suspended; no reassignment until cleared by a human; area safety check",
    }),
    responseParameters: Object.freeze([]),
    escalation: ESCALATION.ALWAYS_PAGE,
    escalationDetail: "always page",
    classifiesStranding: false,
    requiresHumanClearance: true,
  }),
  Object.freeze({
    id: "A5",
    failure: "Blocking hardware fault",
    detection: DETECTION.SELF_TEST,
    latencyClass: LATENCY_CLASS.IMMEDIATE,
    latencyParameter: null,
    custodyAware: true,
    response: Object.freeze({
      [CUSTODY_PHASE.PRE_CUSTODY]: "abort and reassign",
      [CUSTODY_PHASE.POST_CUSTODY]: "transfer or recovery mission",
    }),
    responseParameters: Object.freeze([]),
    escalation: ESCALATION.MAINTENANCE_TICKET,
    escalationDetail: "maintenance ticket, auto-quarantine",
    classifiesStranding: false,
    autoQuarantine: true,
  }),
  Object.freeze({
    id: "A6",
    failure: "Non-blocking degradation",
    detection: DETECTION.HEALTH_MONITOR,
    latencyClass: LATENCY_CLASS.SECONDS,
    latencyParameter: null,
    custodyAware: false,
    response: Object.freeze({
      [CUSTODY_PHASE.EITHER]: "continue; tier drops; excluded from future high-value work",
    }),
    responseParameters: Object.freeze([]),
    escalation: ESCALATION.MAINTENANCE_TICKET,
    escalationDetail: "maintenance ticket",
    classifiesStranding: false,
  }),
  Object.freeze({
    id: "A7",
    failure: "Localisation loss",
    detection: DETECTION.COVARIANCE_BREACH,
    latencyClass: LATENCY_CLASS.SECONDS,
    latencyParameter: null,
    custodyAware: false,
    response: Object.freeze({
      [CUSTODY_PHASE.EITHER]:
        "halt in place; attempt recovery; if unresolved, teleop or on-site assistance",
    }),
    responseParameters: Object.freeze([]),
    escalation: ESCALATION.PAGE,
    escalationDetail: "page if in traffic",
    classifiesStranding: false,
  }),
  Object.freeze({
    id: "A8",
    failure: "Navigation stall / blocked",
    detection: DETECTION.PROGRESS_SUPERVISION,
    latencyClass: LATENCY_CLASS.BOUNDED_BY_PARAMETER,
    latencyParameter: "supervise.stall_time",
    custodyAware: false,
    response: Object.freeze({
      [CUSTODY_PHASE.EITHER]:
        "local replan; then global reroute; then obstacle report to the knowledge base and reroute of " +
        "other affected missions",
    }),
    responseParameters: Object.freeze(["supervise.stall_time"]),
    escalation: ESCALATION.OPERATOR_QUEUE,
    escalationDetail: "operator after n failed replans",
    classifiesStranding: false,
  }),
  Object.freeze({
    id: "A9",
    failure: "Energy divergence",
    detection: DETECTION.ENERGY_COMPARISON,
    latencyClass: LATENCY_CLASS.CONTINUOUS,
    latencyParameter: null,
    custodyAware: false,
    response: Object.freeze({ [CUSTODY_PHASE.EITHER]: "the §14.8 mid-mission energy ladder" }),
    responseParameters: Object.freeze([]),
    escalation: ESCALATION.PAGE,
    escalationDetail: "page before immobilisation, never after",
    classifiesStranding: false,
  }),
  Object.freeze({
    id: "A10",
    failure: "Battery below floor projected",
    detection: DETECTION.ENERGY_PROJECTION,
    latencyClass: LATENCY_CLASS.PREDICTIVE,
    latencyParameter: null,
    custodyAware: false,
    response: Object.freeze({
      [CUSTODY_PHASE.EITHER]:
        "controlled stop at the lowest obstruction class reachable — the choice of stopping location is " +
        "made against the map's obstruction classification, not merely against distance (§4.3, §14.8); " +
        "counted as a T3 event (§14.5)",
    }),
    responseParameters: Object.freeze([]),
    escalation: ESCALATION.ALWAYS_PAGE,
    escalationDetail:
      "always page; external escalation if the reachable set contains only BLOCKING_CRITICAL locations (§18.6)",
    classifiesStranding: true,
    externalEscalationWhenOnlyBlockingCriticalReachable: true,
  }),
  Object.freeze({
    id: "A11",
    failure: "Offer unacknowledged",
    detection: DETECTION.ACK_TIMEOUT,
    latencyClass: LATENCY_CLASS.BOUNDED_BY_PARAMETER,
    latencyParameter: "dispatch.offer_ttl",
    custodyAware: false,
    response: Object.freeze({ [CUSTODY_PHASE.EITHER]: "the §11.4 escalation ladder" }),
    responseParameters: Object.freeze(["dispatch.offer_ttl"]),
    escalation: ESCALATION.SYSTEMIC_CHECK,
    escalationDetail: "systemic check at threshold",
    classifiesStranding: false,
  }),
  Object.freeze({
    id: "A12",
    failure: "Agent rejects offer",
    detection: DETECTION.NACK,
    latencyClass: LATENCY_CLASS.IMMEDIATE,
    latencyParameter: null,
    custodyAware: false,
    response: Object.freeze({
      [CUSTODY_PHASE.EITHER]:
        "requeue; cooloff; reconcile the server-versus-agent feasibility disagreement",
    }),
    responseParameters: Object.freeze([]),
    escalation: ESCALATION.ALERT,
    escalationDetail: "alert on repeated or systemic rejects",
    classifiesStranding: false,
  }),
  Object.freeze({
    id: "A13",
    failure: "Agent reports implausible state",
    detection: DETECTION.PLAUSIBILITY_CHECK,
    latencyClass: LATENCY_CLASS.PER_OBSERVATION,
    latencyParameter: null,
    custodyAware: false,
    response: Object.freeze({
      [CUSTODY_PHASE.EITHER]:
        "reject the observation; mark state indeterminate; quarantine on repetition",
    }),
    responseParameters: Object.freeze([]),
    escalation: ESCALATION.SECURITY_EVENT,
    escalationDetail: "security event (§23.5)",
    classifiesStranding: false,
  }),
  Object.freeze({
    id: "A14",
    failure: "Mission overdue",
    detection: DETECTION.TIMELINE_SUPERVISION,
    latencyClass: LATENCY_CLASS.CONTINUOUS,
    latencyParameter: null,
    custodyAware: true,
    response: Object.freeze({
      [CUSTODY_PHASE.PRE_CUSTODY]: "re-project; Task AT_RISK; customer notification; reassign",
      [CUSTODY_PHASE.POST_CUSTODY]: "re-project; Task AT_RISK; customer notification; no reassignment",
    }),
    responseParameters: Object.freeze([]),
    escalation: ESCALATION.OPERATOR_QUEUE,
    escalationDetail: "operator at breach",
    classifiesStranding: false,
  }),
  Object.freeze({
    id: "A15",
    failure: "Completion claim unverifiable",
    detection: DETECTION.VERIFICATION,
    latencyClass: LATENCY_CLASS.AT_EVENT,
    latencyParameter: null,
    custodyAware: false,
    response: Object.freeze({ [CUSTODY_PHASE.EITHER]: "Task → VERIFYING; operator queue" }),
    responseParameters: Object.freeze([]),
    escalation: ESCALATION.DISPUTE_PROCESS,
    escalationDetail: "dispute process",
    classifiesStranding: false,
  }),
  Object.freeze({
    id: "A16",
    failure: "Payload discrepancy",
    detection: DETECTION.MANIFEST_RECONCILIATION,
    latencyClass: LATENCY_CLASS.AT_EVENT,
    latencyParameter: null,
    custodyAware: false,
    response: Object.freeze({
      [CUSTODY_PHASE.EITHER]: "hold; do not release the agent; investigate",
    }),
    responseParameters: Object.freeze([]),
    escalation: ESCALATION.ALWAYS_PAGE,
    escalationDetail: "always, potential theft or mis-ship",
    classifiesStranding: false,
    // I7's counterpart in the failure catalogue: an agent under investigation is not
    // returned to the pool, and the row says so rather than leaving it to the reader.
    blocksPoolReturn: true,
  }),
  Object.freeze({
    id: "A17",
    failure: "Agent immobilised with custody",
    detection: DETECTION.CUSTODY_AND_PROGRESS,
    latencyClass: LATENCY_CLASS.BOUNDED_BY_PARAMETER,
    latencyParameter: "supervise.stall_time",
    custodyAware: true,
    response: Object.freeze({
      [CUSTODY_PHASE.POST_CUSTODY]:
        "a TRANSFER or RECOVERY Leg is generated (§2.4, §4.7); the Leg moves to the STRANDED_* state " +
        "matching the obstruction class",
    }),
    responseParameters: Object.freeze(["supervise.stall_time"]),
    escalation: ESCALATION.EXTERNAL_CHAIN,
    escalationDetail:
      "always page with manifest and access details; the §18.6 chain if obstructing",
    classifiesStranding: true,
  }),
  Object.freeze({
    id: "A20",
    failure: "Agent deduplication state reset",
    detection: DETECTION.DEDUP_GENERATION_ADVANCE,
    latencyClass: LATENCY_CLASS.AT_EVENT,
    latencyParameter: null,
    custodyAware: false,
    response: Object.freeze({
      [CUSTODY_PHASE.EITHER]:
        "suppress redelivery; advance authority_epoch; reconcile custody and physical state; re-offer " +
        "fresh (§11.5)",
    }),
    responseParameters: Object.freeze([]),
    escalation: ESCALATION.ALERT,
    escalationDetail:
      "alert per occurrence; page if the rate across an agent class exceeds threshold, which indicates " +
      "non-durable storage",
    classifiesStranding: false,
  }),
  Object.freeze({
    id: "A18",
    failure: "Firmware/version mismatch after update",
    detection: DETECTION.FEASIBILITY_PREDICATE,
    latencyClass: LATENCY_CLASS.AT_EVENT,
    latencyParameter: null,
    custodyAware: false,
    response: Object.freeze({
      [CUSTODY_PHASE.EITHER]: "the agent is excluded from affected mission types (F5)",
    }),
    responseParameters: Object.freeze([]),
    escalation: ESCALATION.FLEET_WIDE_ALERT,
    escalationDetail: "fleet-wide alert if widespread",
    classifiesStranding: false,
  }),
  Object.freeze({
    id: "A19",
    failure: "Clock skew on agent",
    detection: DETECTION.TIMESTAMP_COMPARISON,
    latencyClass: LATENCY_CLASS.PER_OBSERVATION,
    latencyParameter: null,
    custodyAware: false,
    response: Object.freeze({
      [CUSTODY_PHASE.EITHER]:
        "reject affected observations; require resync; fencing prevents stale-command execution " +
        "regardless, since both fences are counters rather than timestamps (§10.3.1)",
    }),
    responseParameters: Object.freeze([]),
    escalation: ESCALATION.ALERT,
    escalationDetail: "alert",
    classifiesStranding: false,
  }),
]);

const AGENT_FAILURE_IDS = Object.freeze(AGENT_FAILURES.map((row) => row.id));

const BY_ID = Object.freeze(
  AGENT_FAILURES.reduce((index, row) => Object.assign(index, { [row.id]: row }), Object.create(null)),
);

/**
 * One row.
 *
 * @param {string} id
 * @returns {object|null}
 */
function agentFailure(id) {
  return BY_ID[id] || null;
}

/**
 * The response for one row on the applicable side of custody (§18.1 principle 3).
 *
 * @param {string} id
 * @param {string} custodyPhase one of `CUSTODY_PHASE`
 * @returns {{ id: string, custodyPhase: string, response: string|null, escalation: string }}
 */
function responseFor(id, custodyPhase) {
  const row = agentFailure(id);
  if (!row) throw new TypeError(`"${String(id)}" is not a §18.2 agent failure`);

  const phase = custodyPhase || CUSTODY_PHASE.EITHER;
  const response =
    row.response[phase] ??
    row.response[CUSTODY_PHASE.EITHER] ??
    // A custody-aware row asked for the phase it does not define is a caller error worth
    // surfacing rather than silently answering with the other half: applying a
    // pre-custody "abort and reassign" to an agent holding goods is the exact mistake
    // §2.5 exists to prevent.
    null;

  return { id: row.id, custodyPhase: phase, response, escalation: row.escalation };
}

/* ═══════════════════════════════════════════════════════════════════════════
   A3 — the bounded dead-zone lease extension
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The statistic §18.2 A3 requires, and the two it names and refuses.
 *
 * > extend the lease by the **95th percentile of that zone's historical transit time**
 * > for the agent's mobility profile […] **never by a mean or a nominal figure**.
 * @structural the statistic vocabulary of §18.2 A3
 */
const TRANSIT_STATISTIC = Object.freeze({
  P95: "P95",
  MEAN: "MEAN",
  NOMINAL: "NOMINAL",
});

/**
 * Why an extension was refused.
 * @structural refusal reasons for A3
 */
const EXTENSION_REFUSAL = Object.freeze({
  NO_ZONE_STATISTIC: "NO_ZONE_STATISTIC",
  WRONG_STATISTIC: "WRONG_STATISTIC",
  NO_MOBILITY_PROFILE_MATCH: "NO_MOBILITY_PROFILE_MATCH",
  NO_CAP_CONFIGURED: "NO_CAP_CONFIGURED",
});

/**
 * §18.2 A3 — compute the bounded lease extension for a mapped dead zone.
 *
 * Three properties, and each one is a refusal rather than a preference:
 *
 *   1. **The statistic must be the p95 of that zone's historical transit time for the
 *      agent's own mobility profile.** A mean is refused by name. A pedestrian-speed
 *      profile's transit time through a rail underpass is not a road vehicle's, and
 *      extending a lease by the wrong profile's figure grants immunity for a window that
 *      was never measured for this agent.
 *   2. **The extension is capped** at `connectivity.max_deadzone_extension`, and reaching
 *      the cap raises an alert on *every* occurrence — because a zone whose extensions
 *      routinely run to the cap is mismapped, or the agent is failing inside it, and both
 *      are findings rather than noise.
 *   3. **The extension is not itself an exit.** `supervisionRestoration()` is the only
 *      way normal supervision returns, and it requires a position fix outside the zone.
 *
 * Without a resolvable cap the extension is **refused**, not defaulted: an uncapped
 * suppression of recovery is unbounded immunity from supervision, which is the failure
 * this row's own prose warns about.
 *
 * @param {object} input
 * @param {string} input.zoneId
 * @param {string} input.mobilityProfile the agent's profile (§2.2)
 * @param {{ statistic: string, seconds: number, mobilityProfile: string, sampleCount?: number }} input.zoneStatistic
 * @param {number} input.capSeconds `connectivity.max_deadzone_extension`
 * @param {number} input.leaseExpiryMs the lease's current expiry
 * @returns {object}
 */
function deadZoneExtension(input) {
  const source = input || {};
  const statistic = source.zoneStatistic || null;

  const refuse = (reason, detail) =>
    Object.freeze({
      extended: false,
      reason,
      detail,
      extensionSeconds: 0,
      cappedAtLimit: false,
      alert: null,
      newLeaseExpiryMs: Number.isFinite(source.leaseExpiryMs) ? source.leaseExpiryMs : null,
      supervisionSuppressed: false,
    });

  if (!statistic || !Number.isFinite(statistic.seconds) || statistic.seconds < 0) {
    return refuse(
      EXTENSION_REFUSAL.NO_ZONE_STATISTIC,
      "no historical transit statistic for this zone. §18.2 A3's extension is derived from measured " +
        "transit time; with none measured there is no basis for suppressing recovery, and normal " +
        "supervision continues.",
    );
  }

  if (statistic.statistic !== TRANSIT_STATISTIC.P95) {
    return refuse(
      EXTENSION_REFUSAL.WRONG_STATISTIC,
      `the supplied statistic is "${String(statistic.statistic)}". §18.2 A3 requires the 95th percentile ` +
        'and states "never by a mean or a nominal figure": a mean suppresses recovery for less than half ' +
        "the transits that legitimately take longer, and would restore supervision on an agent that is " +
        "still in the zone.",
    );
  }

  if (statistic.mobilityProfile !== undefined && statistic.mobilityProfile !== source.mobilityProfile) {
    return refuse(
      EXTENSION_REFUSAL.NO_MOBILITY_PROFILE_MATCH,
      `the statistic is for mobility profile "${String(statistic.mobilityProfile)}" and the agent's is ` +
        `"${String(source.mobilityProfile)}". §18.2 A3 measures the p95 "for the agent's mobility profile".`,
    );
  }

  if (!Number.isFinite(source.capSeconds) || source.capSeconds <= 0) {
    return refuse(
      EXTENSION_REFUSAL.NO_CAP_CONFIGURED,
      "connectivity.max_deadzone_extension is unresolved. An uncapped extension is unbounded immunity " +
        "from supervision during the window when the agent is least observable, which is precisely what " +
        "§18.2 A3 bounds.",
    );
  }

  const cappedAtLimit = statistic.seconds >= source.capSeconds;
  const extensionSeconds = Math.min(statistic.seconds, source.capSeconds);

  return Object.freeze({
    extended: true,
    reason: null,
    detail: null,
    zoneId: source.zoneId ?? null,
    mobilityProfile: source.mobilityProfile ?? null,
    statistic: TRANSIT_STATISTIC.P95,
    measuredSeconds: statistic.seconds,
    capSeconds: source.capSeconds,
    extensionSeconds,
    cappedAtLimit,
    // §18.2 A3: "Alert on every extension that reaches its cap".
    alert: cappedAtLimit
      ? Object.freeze({
          code: "DEADZONE_EXTENSION_AT_CAP",
          zoneId: source.zoneId ?? null,
          detail:
            "this extension was clamped to connectivity.max_deadzone_extension. A zone whose extensions " +
            "routinely run to the cap is mismapped, or the agent is failing inside it.",
        })
      : null,
    newLeaseExpiryMs: Number.isFinite(source.leaseExpiryMs)
      ? source.leaseExpiryMs + extensionSeconds * MS_PER_SECOND
      : null,
    // Planned silence must not trigger recovery — but the suppression is a state with an
    // exit condition, recorded so the exit can be required rather than assumed.
    supervisionSuppressed: true,
    supervisionRestoredBy: "CORROBORATED_EXIT",
  });
}

/** @structural milliseconds per second */
const MS_PER_SECOND = 1000;

/**
 * §18.2 A3 — normal supervision is restored **only on corroborated exit**.
 *
 * > an extension granted on a prediction is immunity from supervision during the window
 * > when the agent is *least* observable: an agent that entered the zone and then stopped,
 * > turned back, or suffered an unrelated fault looks identical to one transiting normally.
 * > **Normal supervision is restored only on corroborated exit** — an accepted position fix
 * > outside the zone — not on the extension elapsing.
 *
 * The elapsing of the extension is therefore *not* a restoration; it is a **failure to
 * corroborate**, which is a different and more serious event, and this function
 * distinguishes them by name.
 *
 * @param {object} input
 * @param {boolean} [input.acceptedPositionFixOutsideZone] a fix the plausibility check accepted (A13)
 * @param {boolean} [input.extensionElapsed]
 * @returns {{ restored: boolean, outcome: string, reason: string, escalate: boolean }}
 */
function supervisionRestoration(input) {
  const source = input || {};

  if (source.acceptedPositionFixOutsideZone === true) {
    return {
      restored: true,
      outcome: "CORROBORATED_EXIT",
      reason: "an accepted position fix outside the zone; normal supervision resumes (§18.2 A3)",
      escalate: false,
    };
  }

  if (source.extensionElapsed === true) {
    return {
      restored: false,
      outcome: "UNCORROBORATED_EXPIRY",
      reason:
        "the extension elapsed without a corroborated exit. §18.2 A3 restores supervision on a position " +
        "fix outside the zone and not on elapsing, so this is a supervision event rather than a return " +
        "to normal: the agent may have stopped, turned back, or suffered an unrelated fault inside the zone.",
      escalate: true,
    };
  }

  return {
    restored: false,
    outcome: "STILL_IN_WINDOW",
    reason: "the extension is still running and no corroborating fix has arrived",
    escalate: false,
  };
}

module.exports = {
  CUSTODY_PHASE,
  ESCALATION,
  DETECTION,
  LATENCY_CLASS,
  AGENT_FAILURES,
  AGENT_FAILURE_IDS,
  TRANSIT_STATISTIC,
  EXTENSION_REFUSAL,
  agentFailure,
  responseFor,
  deadZoneExtension,
  supervisionRestoration,
  // Re-exported so a caller that has an agent failure in hand can reach the mode its
  // escalation names without a second import that could resolve to a different register.
  MODE: modeRegister.MODE,
};

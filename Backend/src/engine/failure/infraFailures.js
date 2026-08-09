"use strict";

/**
 * The infrastructure failure catalogue and envelope reductions (§18.3) — **Tier 0**.
 *
 * §18.3's table has four columns and every one of them is load-bearing: what detects the
 * failure, what the engine does automatically, and — the column that distinguishes this
 * table from a list of error handlers — **what the operating envelope shrinks to**.
 *
 * > 4. **Degradation reduces the envelope, never the safety margin** (T3).
 *
 * Each row therefore carries an `envelopeReduction` and, where §18.3 names one, the
 * degraded mode the row causes the shard to enter. `catalogue.js` asserts that every named
 * mode is one of §18.5's six, so a row cannot invent a seventh.
 *
 * ── The two rows §18.3 itself singles out ───────────────────────────────────
 * > B16 and B20 deserve note. B16 states an ordering: observability is important but never
 * > more important than the operation, so a logging outage must not stop deliveries —
 * > while a *decision* that cannot be logged is still recorded as unlogged, so the gap is
 * > known. B20 is the poison-pill defence: without it, one malformed mission can crash
 * > every round and take down an entire shard, which is a total-outage failure mode from a
 * > single bad input.
 *
 * Both are more than table rows here. `bufferPriority()` implements B16's ordering as a
 * function that will not return "shed Tier A before Tier B", and `quarantineDecision()`
 * implements B20's per-mission crash correlation with its bound.
 *
 * ── §18.4, stated as a property rather than as prose ────────────────────────
 * > In this design, **infrastructure failure never fails customer work.**
 *
 * `assertNoRowFailsCustomerWork()` proves no row in this table produces a task failure:
 * a task reaches `FAILED` only through the §17.4 ladder. The distinction is between
 * *"we could not process this right now"* and *"this cannot be done"*, and conflating them
 * destroys both customer trust and operational visibility.
 */

const modeRegister = require("../degraded/modeRegister");

/**
 * How an infrastructure failure is detected.
 * @structural the detection vocabulary of §18.3
 */
const DETECTION = Object.freeze({
  HEALTH_CHECK: "HEALTH_CHECK",
  WRITE_FAILURE: "WRITE_FAILURE",
  LATENCY_SLI: "LATENCY_SLI",
  CONNECTION_FAILURE: "CONNECTION_FAILURE",
  TIMEOUT: "TIMEOUT",
  PER_REQUEST_ERRORS: "PER_REQUEST_ERRORS",
  VERSION_CHECK: "VERSION_CHECK",
  LEASE_LOSS: "LEASE_LOSS",
  LEASE_RENEWAL_FAILURE: "LEASE_RENEWAL_FAILURE",
  DELIVERY_FAILURE_RATE: "DELIVERY_FAILURE_RATE",
  SKEW_MONITOR: "SKEW_MONITOR",
  QUEUE_DEPTH_AND_ROUND_TIME: "QUEUE_DEPTH_AND_ROUND_TIME",
  CRASH_CORRELATION: "CRASH_CORRELATION",
});

/**
 * §18.3's twenty rows.
 *
 * `entersMode` is null where §18.3 names no mode — most rows narrow the envelope without
 * a shard-level state change, and inventing a mode for each would make the six-mode
 * register meaningless.
 */
const INFRA_FAILURES = Object.freeze([
  Object.freeze({
    id: "B1",
    failure: "Commitment Store unavailable",
    detection: DETECTION.HEALTH_CHECK,
    response:
      "enter Custodial Operation (§18.5): stop committing, stop issuing commands, suspend I2 explicitly; " +
      "continue intake and queueing; publish honest ETAs; drain on recovery",
    envelopeReduction:
      "no new commitments; **no new commands to any agent**; in-flight missions continue under on-agent " +
      "self-supervision within their autonomy limit; **no task is failed for this reason**",
    entersMode: modeRegister.MODE.CUSTODIAL_OPERATION,
    failsCustomerWork: false,
  }),
  Object.freeze({
    id: "B2",
    failure: "Commitment Store degraded (high latency)",
    detection: DETECTION.LATENCY_SLI,
    response: "reduce round rate; increase batch window; shed low-priority rounds",
    envelopeReduction: "fewer, larger, more valuable commitments",
    entersMode: null,
    failsCustomerWork: false,
  }),
  Object.freeze({
    id: "B3",
    failure: "Cache tier lost entirely",
    detection: DETECTION.CONNECTION_FAILURE,
    response:
      "enter Cold Index (§18.5): continue on the durable path; rebuild the index from the observation log " +
      "and next heartbeats",
    envelopeReduction:
      "higher latency; candidate search narrower until the index warms; **correctness unaffected** (§3.3, I16)",
    entersMode: modeRegister.MODE.COLD_INDEX,
    failsCustomerWork: false,
  }),
  Object.freeze({
    id: "B4",
    failure: "Timer store unavailable",
    detection: DETECTION.HEALTH_CHECK,
    response:
      "enter Unsupervised Commitment (§18.5): stop hardening new commitments; the reconciler's periodic " +
      "sweep becomes the supervision mechanism at reduced frequency",
    envelopeReduction:
      "supervision latency degrades; commitment rate reduced accordingly; **I4 explicitly suspended**, " +
      "I2 degraded to sweep granularity",
    entersMode: modeRegister.MODE.UNSUPERVISED_COMMITMENT,
    failsCustomerWork: false,
  }),
  Object.freeze({
    id: "B5",
    failure: "Routing Service unavailable",
    detection: DETECTION.TIMEOUT,
    response: "enter Degraded Routing (§18.5): cached matrices; then geometric bound × detour factor",
    envelopeReduction:
      "route.degraded_max_radius; reserves × route.degraded_reserve_factor; only pre-surveyed corridors " +
      "hardened; reported optimality gaps widen and carry a degradation flag",
    entersMode: modeRegister.MODE.DEGRADED_ROUTING,
    failsCustomerWork: false,
  }),
  Object.freeze({
    id: "B6",
    failure: "Routing Service partially failing",
    detection: DETECTION.PER_REQUEST_ERRORS,
    response:
      "**uniform treatment**: if any candidate's route is unavailable, *all* candidates in that decision " +
      "use the degraded estimator",
    envelopeReduction:
      "this specifically prevents the baseline's partial-failure bias, where candidates in a failed batch " +
      "received the best possible travel-time score purely because their data was missing",
    entersMode: modeRegister.MODE.DEGRADED_ROUTING,
    failsCustomerWork: false,
    uniformTreatment: true,
  }),
  Object.freeze({
    id: "B7",
    failure: "Map service stale or unavailable",
    detection: DETECTION.VERSION_CHECK,
    response: "pinned last-known-good snapshot",
    envelopeReduction: "recently changed areas excluded from routing",
    entersMode: null,
    failsCustomerWork: false,
  }),
  Object.freeze({
    id: "B8",
    failure: "Forecast unavailable",
    detection: DETECTION.TIMEOUT,
    response: "last good forecast → seasonal prior → flat",
    envelopeReduction: "the opportunity term shrinks toward prior; recorded as degraded",
    entersMode: null,
    failsCustomerWork: false,
  }),
  Object.freeze({
    id: "B9",
    failure: "Reliability Service unavailable",
    detection: DETECTION.TIMEOUT,
    response: "cohort priors",
    envelopeReduction: "agents without a tier barred from critical-class work",
    entersMode: null,
    failsCustomerWork: false,
  }),
  Object.freeze({
    id: "B10",
    failure: "Energy Model Service unavailable",
    detection: DETECTION.TIMEOUT,
    response: "class model without per-agent calibration",
    envelopeReduction: "reserves × energy.uncalibrated_reserve_factor",
    entersMode: null,
    failsCustomerWork: false,
  }),
  Object.freeze({
    id: "B11",
    failure: "Agent State Service unavailable",
    detection: DETECTION.TIMEOUT,
    response: "rebuild from the durable log",
    envelopeReduction: "indeterminate agents ineligible; the §7.4 systemic guard applies",
    // §7.4's guard is what enters Restricted Operation, and it does so on the measured
    // indeterminacy fraction rather than on this row firing — which is why this row names
    // the guard and not the mode.
    entersMode: null,
    failsCustomerWork: false,
  }),
  Object.freeze({
    id: "B12",
    failure: "Config Service unavailable",
    detection: DETECTION.TIMEOUT,
    response: "pinned last-known-good version",
    envelopeReduction: "no config changes take effect; alert",
    entersMode: null,
    failsCustomerWork: false,
  }),
  Object.freeze({
    id: "B13",
    failure: "Coordinator crash",
    detection: DETECTION.LEASE_LOSS,
    response:
      "a standby acquires leadership, advances shard.leadership_fence, recovers durable commitments and " +
      "reconstructs SOFT reservations (§19.5) before resuming rounds",
    envelopeReduction:
      "brief pause in round processing; **no HARD commitment loss**; Legs in PLANNED are re-planned in the " +
      "first round",
    entersMode: null,
    failsCustomerWork: false,
    // The mechanism is Phase 13's; the catalogue row is §18.3's and belongs here.
    implementedBy: "Phase 13 — shard/failover.js",
  }),
  Object.freeze({
    id: "B14",
    failure: "Network partition, coordinator isolated",
    detection: DETECTION.LEASE_RENEWAL_FAILURE,
    response:
      "the isolated coordinator **stops committing immediately**; the majority side elects a new leader and " +
      "advances the leadership fence; guard G1 (§10.3.2) causes the isolated side's late commits to abort at " +
      "the store even if it has not yet noticed its own isolation",
    envelopeReduction: "availability sacrificed for exclusivity on the commit path only",
    entersMode: null,
    failsCustomerWork: false,
    implementedBy: "Phase 3 — commitment/guards.js G1; Phase 13 — shard/election.js",
  }),
  Object.freeze({
    id: "B15",
    failure: "Message bus / dispatch transport failure",
    detection: DETECTION.DELIVERY_FAILURE_RATE,
    response: "alternate channel if available; §11.4 step 4",
    envelopeReduction: "no new hardening; existing missions continue autonomously",
    entersMode: null,
    failsCustomerWork: false,
    stopNewHardening: true,
  }),
  Object.freeze({
    id: "B16",
    failure: "Analytical or Decision Log store unavailable",
    detection: DETECTION.WRITE_FAILURE,
    response:
      "buffer locally with bounded spill, **prioritising Tier A over Tier B** — Tier B is reconstructible by " +
      "replay while Tier A is not (§21.2); **never block a decision on logging**",
    envelopeReduction:
      "Tier B writes shed first and the shedding is counted; a decision whose Tier A record cannot be written " +
      "is itself recorded as unlogged; decisions continue",
    entersMode: null,
    failsCustomerWork: false,
    neverBlocksDecision: true,
  }),
  Object.freeze({
    id: "B17",
    failure: "Charging Scheduler unavailable",
    detection: DETECTION.TIMEOUT,
    response: "no charge interruptions permitted; in-progress charges complete",
    envelopeReduction: "reduced availability; conservative",
    entersMode: null,
    failsCustomerWork: false,
  }),
  Object.freeze({
    id: "B18",
    failure: "Clock source failure / excessive skew",
    detection: DETECTION.SKEW_MONITOR,
    response: "the node removes itself from leadership eligibility",
    envelopeReduction: "fewer eligible coordinators; correctness preserved by fencing",
    entersMode: null,
    failsCustomerWork: false,
  }),
  Object.freeze({
    id: "B19",
    failure: "Overload (arrival rate > capacity)",
    detection: DETECTION.QUEUE_DEPTH_AND_ROUND_TIME,
    response:
      "enter Shed Load (§18.5): admission control shedding by Leg purpose then class (§20.5); publish honest " +
      "ETAs; alert",
    envelopeReduction:
      "speculative purposes shed first, then low-priority classes, **never custodial_purposes**; declines are " +
      "explicit, never silent",
    entersMode: modeRegister.MODE.SHED_LOAD,
    failsCustomerWork: false,
  }),
  Object.freeze({
    id: "B20",
    failure: "Poison input (a mission that crashes evaluation)",
    detection: DETECTION.CRASH_CORRELATION,
    response: "quarantine that mission after n failures; continue the round without it",
    envelopeReduction: "one task blocked, fleet unaffected; always alert",
    entersMode: null,
    // A quarantined mission is **blocked**, not failed: it leaves the round and waits for
    // a human, which is a §17.4 ladder step rather than a terminal decision.
    failsCustomerWork: false,
  }),
]);

const INFRA_FAILURE_IDS = Object.freeze(INFRA_FAILURES.map((row) => row.id));

const BY_ID = Object.freeze(
  INFRA_FAILURES.reduce((index, row) => Object.assign(index, { [row.id]: row }), Object.create(null)),
);

/**
 * @param {string} id
 * @returns {object|null}
 */
function infraFailure(id) {
  return BY_ID[id] || null;
}

/**
 * The degraded mode a row causes, or null.
 *
 * @param {string} id
 * @returns {string|null}
 */
function modeFor(id) {
  const row = infraFailure(id);
  return row ? row.entersMode : null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   B16 — the buffering order, as a function that cannot get it backwards
   ═══════════════════════════════════════════════════════════════════════════ */

/** What B16's bounded spill holds, most-important first. @structural B16's own ordering */
const BUFFER_PRIORITY = Object.freeze(["TIER_A", "TIER_B"]);

/**
 * §18.3 B16 — which record class sheds first when the Decision Log store is unavailable
 * and the local spill is bounded.
 *
 * The ordering is not a preference. Tier B is *reconstructible by replay* and Tier A is
 * not, so shedding Tier A to keep Tier B would discard the only irreplaceable half. And
 * neither may block the decision: a logging outage that stopped deliveries would have
 * inverted the whole ordering §18.3 states.
 *
 * @param {object} input `{ spillRemaining, pending }`
 * @returns {object}
 */
function bufferPriority(input) {
  const source = input || {};
  const spillRemaining = Number.isFinite(source.spillRemaining) ? source.spillRemaining : null;

  return Object.freeze({
    order: BUFFER_PRIORITY,
    shedFirst: BUFFER_PRIORITY[BUFFER_PRIORITY.length - 1],
    retainLongest: BUFFER_PRIORITY[0],
    spillRemaining,
    spillExhausted: spillRemaining !== null && spillRemaining <= 0,
    // The property that outranks both: never block a decision on logging.
    blocksDecision: false,
    // "A decision whose Tier A record cannot be written is itself recorded as unlogged."
    unloggedDecisionIsRecorded: true,
    reason:
      "Tier B is reconstructible by replay while Tier A is not (§21.2), so Tier B sheds first and the " +
      "shedding is counted. Observability is important but never more important than the operation.",
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   B20 — the poison-pill defence
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * How many evaluation crashes correlated to one mission id before that mission is
 * quarantined.
 *
 * §18.3 B20 words the bound as "after `n` failures" without fixing `n`, and Appendix A
 * tabulates no entry for it. Three is the smallest value that distinguishes a genuinely
 * poisonous input from a transient — one crash can be an unrelated fault in the round, two
 * can be the same transient recurring — while still bounding the damage to three rounds.
 * Registered as `failure.poison_quarantine_threshold` rather than sitting here as a bare
 * constant, per §22.1 rule 1.
 * @param failure.poison_quarantine_threshold
 */
const DEFAULT_QUARANTINE_THRESHOLD = 3;

/**
 * §18.3 B20 — should this mission be quarantined out of the round?
 *
 * > Quarantine that mission after `n` failures; continue the round without it. […] One
 * > task blocked, fleet unaffected; always alert.
 *
 * "Continue the round without it" is the half that matters: a round that aborts because
 * one mission crashed evaluation has converted a single bad input into a shard outage,
 * which §18.3 names as the failure mode this row exists to prevent.
 *
 * @param {object} input
 * @param {string} input.missionId
 * @param {number} input.crashCount crashes correlated to this mission id
 * @param {number} [input.threshold] `failure.poison_quarantine_threshold`
 * @returns {object}
 */
function quarantineDecision(input) {
  const source = input || {};
  const threshold = Number.isFinite(source.threshold) && source.threshold > 0 ? source.threshold : DEFAULT_QUARANTINE_THRESHOLD;
  const crashCount = Number.isFinite(source.crashCount) ? source.crashCount : 0;
  const quarantine = crashCount >= threshold;

  return Object.freeze({
    missionId: source.missionId ?? null,
    crashCount,
    threshold,
    quarantine,
    continueRoundWithoutIt: true,
    // §18.3: "always alert". Not conditional on severity — a mission that crashes
    // evaluation is a defect in the engine as much as in the input.
    alert: Object.freeze({
      code: "POISON_MISSION_QUARANTINED",
      raised: quarantine,
      detail: quarantine
        ? `mission ${String(source.missionId)} crashed evaluation ${crashCount} times and is quarantined out ` +
          "of the round. One task blocked, fleet unaffected — but a mission that crashes evaluation is a " +
          "defect worth reading, not merely worth excluding."
        : null,
    }),
    // A quarantined mission is blocked and escalated, never failed (§18.4).
    taskOutcome: quarantine ? "BLOCKED_PENDING_INVESTIGATION" : "UNCHANGED",
  });
}

/**
 * §18.4, as an assertion over the table: **infrastructure failure never fails customer
 * work.**
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
function assertNoRowFailsCustomerWork() {
  const problems = INFRA_FAILURES.filter((row) => row.failsCustomerWork !== false).map(
    (row) =>
      `${row.id} "${row.failure}" is declared as failing customer work. §18.4: infrastructure failure means ` +
      "the queue drains more slowly or not at all, with honest ETAs and loud alerts. A task reaches FAILED " +
      "only through the §17.4 ladder.",
  );
  return { ok: problems.length === 0, problems };
}

module.exports = {
  DETECTION,
  INFRA_FAILURES,
  INFRA_FAILURE_IDS,
  BUFFER_PRIORITY,
  DEFAULT_QUARANTINE_THRESHOLD,
  infraFailure,
  modeFor,
  bufferPriority,
  quarantineDecision,
  assertNoRowFailsCustomerWork,
};

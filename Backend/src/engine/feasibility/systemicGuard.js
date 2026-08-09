"use strict";

/**
 * The systemic-indeterminacy guard (§7.4) — **Tier 0**, mechanism T0-02.
 *
 * > Strict `DENY` on unknown data has a failure mode of its own: a telemetry or
 * > state-service outage would render the whole fleet infeasible and halt the
 * > operation. **Fixing the baseline's fail-open behaviour by naive fail-closed would
 * > trade a safety bug for an availability outage.**
 *
 * That sentence is the entire justification for this module, and it is worth stating
 * why it is not a compromise. The guard does not make an unsafe fleet assignable. It
 * distinguishes two situations that produce identical rejection counts and require
 * opposite responses:
 *
 *   - *the agents are unfit* — the rejections are real, and the fleet should stop;
 *   - *the observability of the agents has failed* — the rejections are an artefact,
 *     and stopping the fleet is a self-inflicted outage.
 *
 * The signal that separates them is the **fraction of candidates rejected solely due
 * to `INDETERMINATE`**. A fleet that is genuinely unfit produces `VIOLATED`; a fleet
 * whose telemetry has failed produces `INDETERMINATE`. Three-valued evaluation is what
 * makes the distinction observable at all.
 *
 * ── The four steps of §7.4, implemented literally ──────────────────────────
 * 1. Per round, compute the fraction of candidates rejected solely due to
 *    `INDETERMINATE`.
 * 2. If that fraction exceeds `feasibility.systemic_indeterminacy_threshold`
 *    (default 0.30), the cause is systemic — an infrastructure fault — not a property
 *    of the agents.
 * 3. On that determination the shard enters **Restricted Operation**, which
 *    **suspends no invariant**:
 *      (a) raise a high-severity alert immediately
 *      (b) restrict new commitments to `degraded.max_mission_scope`
 *      (c) multiply energy reserves by `degraded.reserve_factor`
 *      (d) permit only agents whose *last known good* observation is within
 *          `degraded.max_last_known_age` **and is corroborated by an independent
 *          signal**
 *      (e) record every such commitment as degraded-mode for later review
 * 4. Restricted Operation is time-boxed by `degraded.max_duration`, after which the
 *    shard stops issuing new commitments and requires explicit operator
 *    acknowledgement.
 *
 * ── What this module must never do, and how that is enforced ───────────────
 * > It does not relax any class I or R predicate.
 *
 * `assertRelaxesNothing()` proves it structurally: the restrictions this module emits
 * are all *additional* constraints, and it exposes no mechanism for changing a
 * predicate's outcome, its policy, or its class. The guard's output is an operating
 * envelope, never a verdict override — which is what T3 means by "the response to lost
 * information is a smaller operating envelope with louder alarms, never a lowered
 * safety margin".
 *
 * Note (d) in particular: Restricted Operation *tightens* admission by requiring
 * independent corroboration of the last known good observation. It is strictly harder
 * to be admitted under Restricted Operation than under normal operation.
 *
 * ── No clock ────────────────────────────────────────────────────────────────
 * Time is supplied (T6, §9.6). The time box is evaluated against the pinned decision
 * time, so a replay of a round that was in Restricted Operation reaches the same
 * conclusion about whether the box had expired.
 */

const { readParameter, isNumber, secondsToMs } = require("./threeValued");

/**
 * The named degraded mode §18.5 registers for this condition.
 * @structural the specification's own mode name
 */
const MODE_NAME = "RESTRICTED_OPERATION";

/**
 * §7.4 step 4's terminal condition: the box expired and no operator has acknowledged.
 * @structural mode-state labels
 */
const GUARD_STATE = Object.freeze({
  NORMAL: "NORMAL",
  RESTRICTED: "RESTRICTED",
  HALTED_AWAITING_ACKNOWLEDGEMENT: "HALTED_AWAITING_ACKNOWLEDGEMENT",
});

/** §7.4 step 3(a). @structural the specification's own severity for this alert */
const ALERT_SEVERITY = "HIGH";

/**
 * Compute §7.4 step 1's fraction: candidates rejected **solely** because of
 * indeterminacy, over all candidates evaluated.
 *
 * "Solely" is load-bearing. A candidate that was both `VIOLATED` on F8 and
 * `INDETERMINATE` on F16 is unfit regardless of the telemetry outage, and counting it
 * would let a genuinely broken fleet trip the guard into a *more permissive*
 * assignment envelope. The evaluator therefore records `deniedForIndeterminacyOnly`
 * per candidate, and this function counts only those.
 *
 * @param {{ evaluated: number, deniedForIndeterminacyOnly: number }} tally
 * @returns {number|null} the fraction, or null when nothing was evaluated
 */
function indeterminacyFraction(tally) {
  const evaluated = tally && tally.evaluated;
  if (!isNumber(evaluated) || evaluated <= 0) return null;
  const solely = tally.deniedForIndeterminacyOnly;
  if (!isNumber(solely) || solely < 0) return null;
  return solely / evaluated;
}

/**
 * §7.4 steps 1–2: has the round's indeterminacy become systemic?
 *
 * @param {{ evaluated: number, deniedForIndeterminacyOnly: number }} tally
 * @param {object} config
 * @returns {{ tripped: boolean, fraction: number|null, threshold: number|null, reason: string }}
 */
function assess(tally, config) {
  const threshold = readParameter(config, "feasibility.systemic_indeterminacy_threshold");
  if (!isNumber(threshold)) {
    // Without the threshold the guard cannot fire — and must not fire, because firing
    // changes the operating envelope. Normal operation with every class I and R
    // predicate still denying on unknown is the safe fallback; the cost is
    // availability, which is the cost §7.4 exists to bound rather than to eliminate.
    return {
      tripped: false,
      fraction: indeterminacyFraction(tally),
      threshold: null,
      reason:
        "feasibility.systemic_indeterminacy_threshold is unresolved; the guard cannot determine that " +
        "indeterminacy is systemic, and no envelope change is made",
    };
  }

  const fraction = indeterminacyFraction(tally);
  if (fraction === null) {
    return { tripped: false, fraction: null, threshold, reason: "no candidates were evaluated this round" };
  }

  if (fraction > threshold) {
    return {
      tripped: true,
      fraction,
      threshold,
      reason:
        `${(fraction * 100).toFixed(1)} % of candidates were rejected solely for indeterminacy, ` +
        `above the ${(threshold * 100).toFixed(1)} % threshold. The cause is systemic — an ` +
        "infrastructure fault — not a property of the agents (§7.4 step 2)",
    };
  }

  return {
    tripped: false,
    fraction,
    threshold,
    reason: `indeterminacy fraction ${fraction.toFixed(3)} is within the ${threshold} threshold`,
  };
}

/**
 * §7.4 step 3: the Restricted Operation envelope.
 *
 * Every field is an **additional** constraint. There is deliberately no field by which
 * a predicate outcome, policy, or class can be altered, and `assertRelaxesNothing()`
 * checks that the shape has not acquired one.
 *
 * @param {object} config
 * @param {{ enteredAtMs: number }} state
 * @returns {object} the restrictions in force
 */
function restrictions(config, state) {
  const maxMissionScope = readParameter(config, "degraded.max_mission_scope");
  const reserveFactor = readParameter(config, "degraded.reserve_factor");
  const maxLastKnownAgeSeconds = readParameter(config, "degraded.max_last_known_age");
  const maxDurationSeconds = readParameter(config, "degraded.max_duration");

  return Object.freeze({
    mode: MODE_NAME,
    // (a) — raised immediately, by the caller, from this descriptor.
    alert: Object.freeze({
      severity: ALERT_SEVERITY,
      immediate: true,
      summary: "Feasibility indeterminacy is systemic; the shard has entered Restricted Operation (§7.4)",
    }),
    // (b) — new commitments restricted to missions within this scope.
    maxMissionScope: maxMissionScope === undefined ? null : maxMissionScope,
    // (c) — energy reserves multiplied. A multiplier ≥ 1 only ever enlarges reserves;
    // `assertRelaxesNothing` refuses anything below 1.
    energyReserveMultiplier: isNumber(reserveFactor) ? reserveFactor : null,
    // (d) — last-known-good admission, *and* independent corroboration. Both, never
    // either: an unmonitored agent vouching for itself is what §23.5 forbids.
    lastKnownGood: Object.freeze({
      maxAgeMs: isNumber(maxLastKnownAgeSeconds) ? secondsToMs(maxLastKnownAgeSeconds) : null,
      requiresIndependentCorroboration: true,
    }),
    // (e) — every commitment taken under this mode is marked for later review.
    recordCommitmentsAsDegraded: true,
    // 4 — the time box.
    timeBox: Object.freeze({
      enteredAtMs: state && state.enteredAtMs !== undefined ? state.enteredAtMs : null,
      maxDurationMs: isNumber(maxDurationSeconds) ? secondsToMs(maxDurationSeconds) : null,
    }),
  });
}

/**
 * §7.4 step 4: evaluate the time box against the pinned decision time.
 *
 * > Restricted Operation is time-boxed by `degraded.max_duration`, after which the
 * > shard **stops issuing new commitments** and requires explicit operator
 * > acknowledgement to continue.
 *
 * @param {object} envelope from `restrictions()`
 * @param {number} nowMs the round's pinned decision time
 * @param {{ acknowledgedAtMs?: number }} [acknowledgement]
 * @returns {{ state: string, expired: boolean, remainingMs: number|null, reason: string }}
 */
function evaluateTimeBox(envelope, nowMs, acknowledgement) {
  const box = envelope && envelope.timeBox;
  const enteredAtMs = box && box.enteredAtMs;
  const maxDurationMs = box && box.maxDurationMs;

  if (!isNumber(enteredAtMs) || !isNumber(maxDurationMs) || !isNumber(nowMs)) {
    // §18.5: "every suspension of an invariant is explicit, named, and **expires**". A
    // box whose expiry cannot be computed is treated as expired, because an
    // unbounded degraded mode is the thing §18.5 forbids.
    return {
      state: GUARD_STATE.HALTED_AWAITING_ACKNOWLEDGEMENT,
      expired: true,
      remainingMs: null,
      reason:
        "the Restricted Operation time box cannot be evaluated. §18.5 requires every degraded mode " +
        "to expire; a box with no computable expiry is treated as expired",
    };
  }

  const elapsedMs = nowMs - enteredAtMs;
  const remainingMs = maxDurationMs - elapsedMs;

  if (remainingMs > 0) {
    return { state: GUARD_STATE.RESTRICTED, expired: false, remainingMs, reason: "within the time box" };
  }

  const acknowledgedAtMs = acknowledgement && acknowledgement.acknowledgedAtMs;
  if (isNumber(acknowledgedAtMs) && acknowledgedAtMs >= enteredAtMs) {
    return {
      state: GUARD_STATE.RESTRICTED,
      expired: true,
      remainingMs,
      reason: "the time box expired and an operator has explicitly acknowledged continuation (§7.4 step 4)",
    };
  }

  return {
    state: GUARD_STATE.HALTED_AWAITING_ACKNOWLEDGEMENT,
    expired: true,
    remainingMs,
    reason:
      "the Restricted Operation time box has expired without operator acknowledgement; the shard " +
      "stops issuing new commitments (§7.4 step 4)",
  };
}

/**
 * Prove that the guard relaxes nothing (§7.4 step 3: "which suspends no invariant …
 * It does not relax any class I or R predicate").
 *
 * Two properties are checked:
 *
 *   1. **Shape.** The envelope exposes no field capable of altering a predicate's
 *      outcome, policy, or class. The forbidden names are enumerated, so a future
 *      field called `predicateOverrides` or `relaxedPredicates` fails the check rather
 *      than quietly working.
 *   2. **Direction.** Where the envelope carries a numeric knob, it is checked to move
 *      in the tightening direction — the reserve multiplier enlarges reserves, so it
 *      may not be below 1.
 *
 * @param {object} envelope from `restrictions()`
 * @returns {{ ok: boolean, problems: string[] }}
 */
function assertRelaxesNothing(envelope) {
  const problems = [];
  if (!envelope || typeof envelope !== "object") return { ok: false, problems: ["no envelope supplied"] };

  const forbidden = [
    "predicateOverrides",
    "relaxedPredicates",
    "waivedPredicates",
    "suspendedInvariants",
    "policyOverrides",
    "classOverrides",
    "skipPredicates",
  ];
  for (const name of forbidden) {
    if (Object.prototype.hasOwnProperty.call(envelope, name)) {
      problems.push(
        `the Restricted Operation envelope exposes "${name}". §7.4 step 3 states the mode "suspends ` +
          'no invariant" and "does not relax any class I or R predicate"; a field that could is a defect',
      );
    }
  }

  // A multiplier below 1 would shrink reserves, which is a relaxation wearing a
  // tightening name.
  if (envelope.energyReserveMultiplier !== null && isNumber(envelope.energyReserveMultiplier)) {
    if (envelope.energyReserveMultiplier < 1) {
      problems.push(
        `degraded.reserve_factor is ${envelope.energyReserveMultiplier}, below 1. §7.4 step 3(c) ` +
          "multiplies energy reserves; a factor below 1 shrinks them, which is a relaxation",
      );
    }
  }

  if (envelope.lastKnownGood && envelope.lastKnownGood.requiresIndependentCorroboration !== true) {
    problems.push(
      "Restricted Operation admits last-known-good observations without requiring independent " +
        "corroboration. §7.4 step 3(d) requires both, and §23.5 forbids an unmonitored agent " +
        "vouching for itself",
    );
  }

  return { ok: problems.length === 0, problems };
}

module.exports = {
  MODE_NAME,
  GUARD_STATE,
  ALERT_SEVERITY,
  indeterminacyFraction,
  assess,
  restrictions,
  evaluateTimeBox,
  assertRelaxesNothing,
};

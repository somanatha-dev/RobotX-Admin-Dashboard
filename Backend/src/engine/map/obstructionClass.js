"use strict";

/**
 * Obstruction classification (§4.3, §5.2) — **Tier 0**, mechanism T0-10. Invariant I22.
 *
 * > The distinction is **derived automatically, never operator-entered**, from the Map
 * > service (§5.2). `INDETERMINATE` resolves to `STRANDED_OBSTRUCTING` under DENY
 * > semantics: an unknown stopping location is treated as the more serious case, because
 * > the cost of over-escalating a safe stranding is an unnecessary callout and the cost of
 * > under-escalating an obstructing one is an incident.
 *
 * ── Why "never operator-entered" is a shape and not a policy ────────────────
 * `classify()` takes map hazard data and a position. It takes no operator field, no
 * override, and no "declared class" — so there is no argument by which a human can assert
 * that a robot standing on a tram crossing is `CLEAR`. An override facility for this one
 * value would be indistinguishable in the data from a correct classification, and the
 * whole escalation chain of §18.6 hangs off it.
 *
 * ── The three ways a class becomes INDETERMINATE ───────────────────────────
 * §4.3 gives `INDETERMINATE` the meaning "unavailable or stale beyond its budget", and
 * this module produces it in exactly three situations, each named in the result:
 *
 *   1. the Map service returned nothing for the position (`UNAVAILABLE`);
 *   2. the hazard data it returned is older than `map.obstruction_class_max_age`
 *      (`STALE`);
 *   3. the data names a class this build does not recognise (`UNRECOGNISED`) — an
 *      unknown label is not a fourth class to be treated leniently, it is data whose
 *      meaning this build cannot establish.
 *
 * All three resolve to `STRANDED_OBSTRUCTING`, and all three are distinguished in the
 * record, because they call for different fixes: a gap in map coverage, a stale
 * publication pipeline, and a version skew are three different defects that produce one
 * identical operational symptom.
 *
 * ── A10's "lowest obstruction class reachable" ──────────────────────────────
 * > Controlled stop at the **lowest obstruction class reachable** — the choice of
 * > stopping location is made against the map's obstruction classification, not merely
 * > against distance.
 *
 * `lowestReachable()` is that choice, and it returns the §18.6 escalation flag when the
 * reachable set contains only `BLOCKING_CRITICAL` locations — the case §18.2 A10 singles
 * out, where the agent has no safe place to stop and the chain must open before the stop
 * rather than after it.
 *
 * ── §18.6 step 5 ────────────────────────────────────────────────────────────
 * > Continuous until cleared — re-evaluate obstruction class as position or map data
 * > changes; de-escalate to `STRANDED_SAFE` if the agent is moved clear.
 *
 * `reclassify()` is that step. De-escalation is permitted and escalation is permitted;
 * what is not permitted is de-escalating on *absent* data, because absent data is
 * `INDETERMINATE`, which resolves the other way.
 *
 * No clock: freshness is judged against a supplied time, exactly as
 * `domain/observation.js` judges its own (T6, §9.6).
 */

const work = require("../domain/work");
const legMachine = require("../lifecycle/legMachine");

/**
 * The four classes of §4.3, re-exported from the domain model rather than restated.
 * A second enumeration of the same four values is a second thing that can be wrong.
 */
const OBSTRUCTION_CLASS = Object.freeze(
  work.OBSTRUCTION_CLASS_NAMES.reduce((names, name) => Object.assign(names, { [name]: name }), Object.create(null)),
);

/**
 * Why a classification came out `INDETERMINATE`.
 * @structural the three indeterminacy causes of §4.3
 */
const INDETERMINACY_CAUSE = Object.freeze({
  UNAVAILABLE: "UNAVAILABLE",
  STALE: "STALE",
  UNRECOGNISED: "UNRECOGNISED",
});

/** @structural milliseconds per second */
const MS_PER_SECOND = 1000;

/**
 * Is this a class this build recognises?
 *
 * @param {*} name
 * @returns {boolean}
 */
function isObstructionClass(name) {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(OBSTRUCTION_CLASS, name);
}

/**
 * The §4.3 severity order, lowest first. `INDETERMINATE` sits at the top with
 * `BLOCKING_CRITICAL` because that is where its resolution puts it: a location whose class
 * cannot be established is treated as the more serious case, so it must not sort below one
 * that is known to be merely restrictive.
 * @structural the severity order of §4.3
 */
const SEVERITY_ORDER = Object.freeze([
  OBSTRUCTION_CLASS.CLEAR,
  OBSTRUCTION_CLASS.RESTRICTIVE,
  OBSTRUCTION_CLASS.BLOCKING_CRITICAL,
  OBSTRUCTION_CLASS.INDETERMINATE,
]);

/**
 * Rank one class in the severity order; an unrecognised label ranks at the top.
 *
 * @param {string} name
 * @returns {number}
 */
function severityOf(name) {
  const index = SEVERITY_ORDER.indexOf(name);
  return index === -1 ? SEVERITY_ORDER.length : index;
}

/**
 * Build the full disposition for a class: the Leg state, the response-target parameter,
 * and whether the §18.6 chain opens.
 *
 * Delegates to `lifecycle/legMachine.strandingStateFor`, which is where §4.3's mapping
 * already lives. Restating the mapping here would give the classifier and the state
 * machine two chances to disagree about what `INDETERMINATE` means, which is the one
 * disagreement I22 cannot tolerate.
 *
 * @param {string} obstructionClass
 * @returns {object}
 */
function dispositionFor(obstructionClass) {
  const stranding = legMachine.strandingStateFor(obstructionClass);
  const row = work.OBSTRUCTION_CLASSES[stranding.obstructionClass];
  return Object.freeze({
    obstructionClass: stranding.obstructionClass,
    legState: stranding.state,
    responseTargetParameter: stranding.responseTargetParameter,
    externalEscalation: stranding.externalEscalation,
    meaning: row ? row.meaning : null,
    escalationRoute: row ? row.escalation : null,
  });
}

/**
 * Classify a stopping location.
 *
 * @param {object} input
 * @param {{ obstructionClass?: string, observedAtMs?: number, source?: string }|null} input.hazardData
 *   what the Map service returned for this position
 * @param {number} input.nowMs the supplied evaluation time
 * @param {number} input.maxAgeSeconds `map.obstruction_class_max_age`
 * @param {{ lat?: number, lon?: number }} [input.position]
 * @returns {object} the classification, its disposition, and — when indeterminate — why
 */
function classify(input) {
  const source = input || {};
  const hazard = source.hazardData || null;

  const indeterminate = (cause, detail) =>
    Object.freeze({
      ...dispositionFor(OBSTRUCTION_CLASS.INDETERMINATE),
      determined: false,
      indeterminacyCause: cause,
      detail,
      reportedClass: hazard ? hazard.obstructionClass ?? null : null,
      ageSeconds: null,
      position: source.position || null,
      operatorEntered: false,
    });

  if (!hazard || hazard.obstructionClass === undefined || hazard.obstructionClass === null) {
    return indeterminate(
      INDETERMINACY_CAUSE.UNAVAILABLE,
      "the Map service returned no obstruction class for this position. §4.3 makes an unavailable class " +
        "INDETERMINATE, which resolves to STRANDED_OBSTRUCTING under DENY semantics (T2, §7.3).",
    );
  }

  if (!isObstructionClass(hazard.obstructionClass)) {
    return indeterminate(
      INDETERMINACY_CAUSE.UNRECOGNISED,
      `the Map service reported class "${String(hazard.obstructionClass)}", which this build does not ` +
        "recognise. An unknown label is not a fourth class to be treated leniently; it is data whose " +
        "meaning cannot be established, which is what INDETERMINATE means.",
    );
  }

  // §4.3's "stale beyond its budget". Judged against a supplied time.
  if (Number.isFinite(source.maxAgeSeconds) && source.maxAgeSeconds > 0) {
    if (!Number.isFinite(hazard.observedAtMs) || !Number.isFinite(source.nowMs)) {
      return indeterminate(
        INDETERMINACY_CAUSE.STALE,
        "the hazard data carries no usable observation time, so its freshness cannot be established. " +
          "Unknown freshness is not fresh (§2.7).",
      );
    }
    const ageSeconds = (source.nowMs - hazard.observedAtMs) / MS_PER_SECOND;
    if (ageSeconds > source.maxAgeSeconds) {
      return Object.freeze({
        ...indeterminate(
          INDETERMINACY_CAUSE.STALE,
          `the hazard data is ${ageSeconds.toFixed(1)} s old, beyond the ${source.maxAgeSeconds} s budget ` +
            "(map.obstruction_class_max_age). §4.3 makes a class stale beyond its budget INDETERMINATE.",
        ),
        ageSeconds,
      });
    }
  }

  const ageSeconds =
    Number.isFinite(hazard.observedAtMs) && Number.isFinite(source.nowMs)
      ? (source.nowMs - hazard.observedAtMs) / MS_PER_SECOND
      : null;

  return Object.freeze({
    ...dispositionFor(hazard.obstructionClass),
    determined: true,
    indeterminacyCause: null,
    detail: null,
    reportedClass: hazard.obstructionClass,
    ageSeconds,
    mapSource: hazard.source ?? null,
    position: source.position || null,
    // §4.3: "derived automatically, never operator-entered". Recorded on every result so
    // that an audit of I22 can establish provenance from the record alone.
    operatorEntered: false,
  });
}

/**
 * §18.2 A10 — the controlled stop goes to the **lowest obstruction class reachable**.
 *
 * The reachable set arrives from the energy projection (§14.8): these are the locations
 * the agent can still reach on the energy it has. This function chooses among them on
 * obstruction class first and distance second — which is the ordering §18.2 A10 states and
 * the inversion of what a naive "nearest safe stop" would do.
 *
 * When every reachable location is `BLOCKING_CRITICAL`, there is no safe stop, and the
 * §18.6 chain opens *before* the stop rather than after it: the operator's response time
 * starts running while the agent is still moving, which is the only part of the timeline
 * anyone can still spend.
 *
 * @param {object} input
 * @param {Array<{ locationId: string, hazardData: object, distanceM: number }>} input.reachable
 * @param {number} input.nowMs
 * @param {number} input.maxAgeSeconds
 * @returns {object}
 */
function lowestReachable(input) {
  const source = input || {};
  const candidates = Array.isArray(source.reachable) ? source.reachable : [];

  const classified = candidates.map((location) => ({
    locationId: location.locationId ?? null,
    distanceM: Number.isFinite(location.distanceM) ? location.distanceM : null,
    classification: classify({
      hazardData: location.hazardData,
      nowMs: source.nowMs,
      maxAgeSeconds: source.maxAgeSeconds,
      position: location.position,
    }),
  }));

  if (classified.length === 0) {
    return Object.freeze({
      chosen: null,
      onlyBlockingCriticalReachable: false,
      externalEscalation: true,
      classified,
      reason:
        "no reachable stopping location was supplied. §18.2 A10's choice is made against the map's " +
        "classification, and with no candidates there is no safe stop to choose — which is the escalating " +
        "case, not the benign one.",
    });
  }

  const sorted = [...classified].sort((a, b) => {
    const bySeverity = severityOf(a.classification.obstructionClass) - severityOf(b.classification.obstructionClass);
    if (bySeverity !== 0) return bySeverity;
    // Distance is the tie-break and never the primary key. A missing distance sorts last
    // so an unmeasured option never displaces a measured one at equal severity.
    const aDistance = a.distanceM === null ? Number.POSITIVE_INFINITY : a.distanceM;
    const bDistance = b.distanceM === null ? Number.POSITIVE_INFINITY : b.distanceM;
    if (aDistance !== bDistance) return aDistance - bDistance;
    return String(a.locationId).localeCompare(String(b.locationId));
  });

  const chosen = sorted[0];
  // "Only BLOCKING_CRITICAL reachable" includes the INDETERMINATE case: a location whose
  // class cannot be established resolves to STRANDED_OBSTRUCTING, so a reachable set of
  // nothing but unknowns is not a set with a safe option in it.
  const onlyBlockingCritical = sorted.every(
    (row) => row.classification.legState === legMachine.LEG_STATE.STRANDED_OBSTRUCTING,
  );

  return Object.freeze({
    chosen,
    onlyBlockingCriticalReachable: onlyBlockingCritical,
    // §18.2 A10: "external escalation if the reachable set contains only BLOCKING_CRITICAL
    // locations (§18.6)".
    externalEscalation: onlyBlockingCritical,
    classified: sorted,
    reason: onlyBlockingCritical
      ? "every reachable stopping location obstructs. The §18.6 chain opens before the stop rather than " +
        "after it, because the operator's response time is the only part of this timeline still spendable."
      : `the lowest reachable obstruction class is ${chosen.classification.obstructionClass}`,
  });
}

/**
 * §18.6 step 5 — re-evaluate as position or map data changes.
 *
 * Returns the transition rather than performing it: the Leg state change belongs to
 * `lifecycle/transitions.js`, and a classifier that moved Leg states would be a second
 * state machine.
 *
 * @param {object} input
 * @param {string} input.currentClass
 * @param {object} input.hazardData the fresh data
 * @param {number} input.nowMs
 * @param {number} input.maxAgeSeconds
 * @returns {object}
 */
function reclassify(input) {
  const source = input || {};
  const before = dispositionFor(source.currentClass);
  const after = classify(source);

  const changed = after.obstructionClass !== before.obstructionClass;
  const deEscalated = changed && severityOf(after.obstructionClass) < severityOf(before.obstructionClass);
  const escalated = changed && severityOf(after.obstructionClass) > severityOf(before.obstructionClass);

  return Object.freeze({
    before,
    after,
    changed,
    deEscalated,
    escalated,
    // §18.6 step 5: "de-escalate to STRANDED_SAFE if the agent is moved clear (§4.4)".
    legStateChange: changed ? { from: before.legState, to: after.legState } : null,
    // De-escalation on *absent* data is structurally impossible: absent data classifies as
    // INDETERMINATE, which is the top of the severity order, so it can only ever escalate.
    // Stated here because it is the property a reviewer should check rather than trust.
    deEscalationRequiresPositiveEvidence: true,
    reason: changed
      ? `${before.obstructionClass} → ${after.obstructionClass}` +
        (deEscalated ? " (de-escalated; the chain closes when the Leg leaves STRANDED_OBSTRUCTING)" : "")
      : "the classification is unchanged; the chain continues (§18.6 step 5)",
  });
}

/**
 * Invariant I22's first half, as a query: does this `STRANDED_*` Leg carry a
 * classification, and does its state match it?
 *
 * > Every `STRANDED_*` Leg carries an obstruction classification, and no obstructing
 * > stranding is held in the ordinary operations queue.
 *
 * A Leg in a `STRANDED_*` state with a null class is a violation of the first clause; a
 * Leg whose state does not match its class is a violation of the second, because it is the
 * state that routes the Leg to a queue or to the chain.
 *
 * @param {{ legId: string, state: string, obstructionClass: string|null }} leg
 * @returns {{ ok: boolean, legId: string, problem: string|null, expectedState: string|null }}
 */
function auditLegClassification(leg) {
  const row = leg || {};
  if (!legMachine.LEG_STATE[row.state] || !isStrandedState(row.state)) {
    return { ok: true, legId: row.legId ?? null, problem: null, expectedState: null };
  }

  if (!row.obstructionClass) {
    return {
      ok: false,
      legId: row.legId ?? null,
      problem:
        "a STRANDED_* Leg with no obstruction classification. I22 requires every one to carry one; " +
        "without it there is no response target and no escalation path to match against.",
      expectedState: legMachine.LEG_STATE.STRANDED_OBSTRUCTING,
    };
  }

  const expected = legMachine.strandingStateFor(row.obstructionClass).state;
  if (expected !== row.state) {
    return {
      ok: false,
      legId: row.legId ?? null,
      problem:
        `this Leg is ${row.state} but its obstruction class ${row.obstructionClass} produces ${expected}. ` +
        "I22's second clause — no obstructing stranding held in the ordinary operations queue — is " +
        "enforced by the state, so a mismatch routes it to the wrong queue.",
      expectedState: expected,
    };
  }

  return { ok: true, legId: row.legId ?? null, problem: null, expectedState: expected };
}

/**
 * @param {string} state
 * @returns {boolean}
 */
function isStrandedState(state) {
  return state === legMachine.LEG_STATE.STRANDED_SAFE || state === legMachine.LEG_STATE.STRANDED_OBSTRUCTING;
}

module.exports = {
  OBSTRUCTION_CLASS,
  INDETERMINACY_CAUSE,
  SEVERITY_ORDER,
  isObstructionClass,
  isStrandedState,
  severityOf,
  dispositionFor,
  classify,
  lowestReachable,
  reclassify,
  auditLegClassification,
};

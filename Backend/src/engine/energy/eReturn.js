"use strict";

/**
 * `E_return` and the availability circularity (§14.5) — **Tier 0**.
 *
 * > `E_return` uses the nearest charger that is *available or reservable* at the
 * > projected time, not merely the nearest one geographically. A charger with a
 * > 25-minute queue is not a viable reserve destination, and treating it as one
 * > reintroduces the stranding risk the reserve exists to prevent.
 *
 * ── The circularity, and why this module does not iterate ───────────────────
 * That definition is circular: charger availability at a future time depends on the
 * charging schedule implied by other agents' plans, and those plans depend on the
 * outcome of the round now being computed.
 *
 * > **The circularity is broken by construction, not by iteration.** … The projection
 * > published from the **previous completed round** is the input to the current one.
 *
 * So this module takes a **pinned, versioned projection** as an input and never
 * consults a live view. A fixed-point iteration would be neither bounded in time nor
 * deterministic, and both are disqualifying (§9.6). The version travels with the
 * verdict because F35 refuses a verdict that cannot name the projection it was computed
 * against — a verdict that cannot name its projection cannot be replayed.
 *
 * ── Four properties §14.5 requires, and where each one lives here ───────────
 * 1. **Determinism and replayability** — the projection arrives pinned; `projectionVersion`
 *    is carried on every verdict.
 * 2. **It is an approximation, and is labelled as one** — `energy.charger_availability_margin`
 *    inflates the result and is a Safety-class parameter compensating for staleness.
 * 3. **Staleness is measured, not assumed** — `staleness()` reports the age against
 *    `energy.charger_projection_max_age`, and `settlementObservation()` produces the
 *    realised-versus-projected tuple §21.5's calibration loop consumes.
 * 4. **Degradation is defined** — beyond the max age the basis falls back to
 *    **depot-only** targets and `energy.uncalibrated_reserve_factor` is applied. The
 *    envelope shrinks to what can still be established; the constraint is not relaxed.
 *
 * ── A feasibility reserve, not a booking ────────────────────────────────────
 * > The engine does not reserve the charger it plans against.
 *
 * Nothing here writes a reservation. Reservations are the Charging Scheduler's to grant
 * (§14.7), and `chargingSchedulerClient.js` is the only module that talks to it — as a
 * priced, refusable request.
 *
 * Tier 0 (T0-03). Invariant I17. Decision path (T6): no clock, no randomness, no store.
 */

/**
 * The two bases a reachability verdict may be computed against. Kept identical to
 * `feasibility/predicates/f35.js`'s own `BASIS`, and asserted equal by test: a verdict
 * whose basis the predicate does not recognise is `INDETERMINATE`, so a drift between
 * the two would deny every candidate silently.
 * @structural the specification's own reachability bases
 */
const BASIS = Object.freeze({
  PINNED_PROJECTION: "PINNED_PROJECTION",
  DEPOT_ONLY: "DEPOT_ONLY",
});

/**
 * The intervals a projection may report a charger in. Only the first two are
 * destinations `E_return` may plan against.
 * @structural the specification's own availability states
 */
const AVAILABILITY = Object.freeze({
  FREE: "FREE",
  RESERVABLE: "RESERVABLE",
  OCCUPIED: "OCCUPIED",
  OUT_OF_SERVICE: "OUT_OF_SERVICE",
});

const VIABLE_AVAILABILITY = Object.freeze([AVAILABILITY.FREE, AVAILABILITY.RESERVABLE]);

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Is the pinned projection fresh enough to plan against?
 *
 * @param {object} projection
 * @param {number} decisionTimeMs the round's pinned time — never a clock read
 * @param {number} maxAgeSeconds `energy.charger_projection_max_age`
 * @returns {{ fresh: boolean, ageSeconds: number|null, reason: string|null }}
 */
function staleness(projection, decisionTimeMs, maxAgeSeconds) {
  if (!projection || typeof projection !== "object") {
    return { fresh: false, ageSeconds: null, reason: "no charger availability projection is pinned into this round" };
  }
  const publishedAtMs =
    projection.publishedAt instanceof Date ? projection.publishedAt.getTime() : projection.publishedAtMs;
  if (!isNumber(publishedAtMs) || !isNumber(decisionTimeMs)) {
    return { fresh: false, ageSeconds: null, reason: "the projection does not state when it was published" };
  }
  if (!isNumber(maxAgeSeconds) || maxAgeSeconds <= 0) {
    return { fresh: false, ageSeconds: null, reason: "energy.charger_projection_max_age is unresolved" };
  }

  // @structural milliseconds per second
  const ageSeconds = (decisionTimeMs - publishedAtMs) / 1000;
  if (ageSeconds < 0) {
    // A projection published in this round's future is not a fresh projection; it is a
    // clock disagreement, and §10.6's discipline is to refuse rather than to trust it.
    return { fresh: false, ageSeconds, reason: "the projection is dated after the round's decision time (§10.6)" };
  }
  return {
    fresh: ageSeconds <= maxAgeSeconds,
    ageSeconds,
    reason: ageSeconds <= maxAgeSeconds ? null : `the projection is ${ageSeconds} s old, beyond energy.charger_projection_max_age`,
  };
}

/**
 * Does the projection show this charger free or reservable at the projected arrival?
 *
 * @param {object} projection
 * @param {string} chargerId
 * @param {number} arrivalMs
 * @returns {{ viable: boolean, state: string|null, reason: string|null }}
 */
function availabilityAt(projection, chargerId, arrivalMs) {
  const chargers = projection && projection.chargers;
  if (!Array.isArray(chargers)) return { viable: false, state: null, reason: "the projection lists no chargers" };

  const row = chargers.find((entry) => entry && entry.chargerId === chargerId);
  if (!row) return { viable: false, state: null, reason: "the projection does not cover this charger" };
  if (!Array.isArray(row.intervals)) return { viable: false, state: null, reason: "the projection states no intervals for this charger" };

  const interval = row.intervals.find(
    (window) => window && isNumber(window.fromMs) && isNumber(window.untilMs) && arrivalMs >= window.fromMs && arrivalMs < window.untilMs,
  );

  if (!interval) {
    // The horizon ran out before the projected arrival. That is not availability; a
    // charger whose state at the arrival time is unknown is not a viable reserve
    // destination, for the same reason a 25-minute queue is not one.
    return { viable: false, state: null, reason: "the projection horizon does not cover the projected arrival time" };
  }

  return {
    viable: VIABLE_AVAILABILITY.includes(interval.state),
    state: interval.state === undefined ? null : interval.state,
    reason: VIABLE_AVAILABILITY.includes(interval.state) ? null : `the charger is ${String(interval.state)} at the projected arrival`,
  };
}

/**
 * Compute `E_return` and the reachability verdict F35 consumes.
 *
 * @param {object} input
 * @param {Array<object>} input.candidates ordered nearest-k entries from the
 *   charger-reachability cache: `{ chargerId, energyWh, travelSeconds, isDepot }`
 * @param {object|null} input.projection the **pinned** charger availability projection
 * @param {number} input.decisionTimeMs the round's pinned time
 * @param {number} input.projectedEndMs the plan's projected mission-end time
 * @param {number} input.usableWh `E_usable(a)`
 * @param {number} input.missionWh the deterministic `E_mission`
 * @param {number} input.floorWh `E_floor`
 * @param {number} input.availabilityMargin `energy.charger_availability_margin`
 * @param {number} input.projectionMaxAgeSeconds `energy.charger_projection_max_age`
 * @param {number} input.uncalibratedReserveFactor `energy.uncalibrated_reserve_factor`
 * @returns {{ ok: boolean, verdict: object|null, basis: string|null,
 *             degradation: object|null, problems: string[] }}
 */
function evaluate(input) {
  const source = input || {};
  const problems = [];

  for (const [name, value] of [
    ["usableWh", source.usableWh],
    ["missionWh", source.missionWh],
    ["floorWh", source.floorWh],
    ["projectedEndMs", source.projectedEndMs],
    ["energy.charger_availability_margin", source.availabilityMargin],
    ["energy.uncalibrated_reserve_factor", source.uncalibratedReserveFactor],
  ]) {
    if (!isNumber(value)) problems.push(`${name} is unresolved`);
  }
  if (isNumber(source.availabilityMargin) && source.availabilityMargin < 1) {
    problems.push("energy.charger_availability_margin is a conservatism factor and may not be below 1 (§14.3)");
  }
  if (!Array.isArray(source.candidates)) problems.push("no charger-reachability candidates were supplied");

  if (problems.length > 0) return { ok: false, verdict: null, basis: null, degradation: null, problems };

  const freshness = staleness(source.projection, source.decisionTimeMs, source.projectionMaxAgeSeconds);
  const usePinned = freshness.fresh;

  const basis = usePinned ? BASIS.PINNED_PROJECTION : BASIS.DEPOT_ONLY;
  const degradation = usePinned
    ? null
    : Object.freeze({
        mode: "DEPOT_ONLY_RETURN_TARGETS",
        reason: freshness.reason,
        ageSeconds: freshness.ageSeconds,
        // §14.5: the fallback is depot-only *plus* the uncalibrated reserve factor. The
        // envelope shrinks to what can still be established rather than the constraint
        // being relaxed — this is T3 in its usual form.
        appliedFactor: source.uncalibratedReserveFactor,
      });

  // Depot-only means the fixed infrastructure whose availability does not depend on any
  // round's output. A candidate list with no depot in it under this basis is a genuine
  // "no viable destination", not an occasion to fall back further.
  const admissible = usePinned ? source.candidates : source.candidates.filter((entry) => entry && entry.isDepot === true);

  const considered = [];
  let chosen = null;

  for (const candidate of admissible) {
    if (!candidate || typeof candidate.chargerId !== "string" || !isNumber(candidate.energyWh) || !isNumber(candidate.travelSeconds)) {
      considered.push({ chargerId: candidate ? candidate.chargerId ?? null : null, admitted: false, reason: "candidate is unreadable" });
      continue;
    }

    // @structural milliseconds per second
    const arrivalMs = source.projectedEndMs + candidate.travelSeconds * 1000;

    if (usePinned) {
      const available = availabilityAt(source.projection, candidate.chargerId, arrivalMs);
      if (!available.viable) {
        considered.push({ chargerId: candidate.chargerId, admitted: false, reason: available.reason, state: available.state });
        continue;
      }
    }

    const inflation = usePinned ? source.availabilityMargin : source.availabilityMargin * source.uncalibratedReserveFactor;
    const eReturnWh = candidate.energyWh * inflation;

    considered.push({ chargerId: candidate.chargerId, admitted: true, eReturnWh, arrivalMs });

    // Ordered nearest-first by the cache, so the first admitted candidate is the
    // nearest *available or reservable* one — which is the definition §14.5 gives, not
    // the nearest one geographically.
    if (chosen === null) chosen = { chargerId: candidate.chargerId, eReturnWh, arrivalMs, isDepot: candidate.isDepot === true };
  }

  if (chosen === null) {
    return {
      ok: true,
      basis,
      degradation,
      verdict: Object.freeze({
        reachable: false,
        basis,
        projectionVersion: usePinned && source.projection ? source.projection.version ?? null : null,
        chargerId: null,
        eReturnWh: null,
        surplusWh: null,
        considered: Object.freeze(considered),
      }),
      problems: [],
    };
  }

  // The deterministic balance F35 asks about: after doing the mission and keeping the
  // hardware floor intact, is there enough left to reach the destination? F34's tiers
  // bound the *probability* of breaching a reserve; F35 asks whether a viable
  // destination exists at all, and the two are not the same question (§14.5).
  const surplusWh = source.usableWh - source.missionWh - source.floorWh - chosen.eReturnWh;

  return {
    ok: true,
    basis,
    degradation,
    verdict: Object.freeze({
      reachable: surplusWh >= 0,
      basis,
      projectionVersion: usePinned && source.projection ? source.projection.version ?? null : null,
      chargerId: chosen.chargerId,
      eReturnWh: chosen.eReturnWh,
      surplusWh,
      considered: Object.freeze(considered),
    }),
    problems: [],
  };
}

/**
 * The `E_return` layer of the reserve stack, taken from a verdict.
 *
 * A verdict with no reachable charger supplies no return reserve — and a plan with no
 * return reserve is one `reserves.compose()` refuses, which is the correct outcome:
 * "no viable destination" is not "zero energy needed to reach one".
 *
 * @param {object} verdict
 * @returns {{ ok: boolean, returnWh: number|null, reason: string|null }}
 */
function returnLayerWh(verdict) {
  if (!verdict || verdict.reachable !== true || !isNumber(verdict.eReturnWh)) {
    return {
      ok: false,
      returnWh: null,
      reason: "no charger is reachable from the projected mission end; there is no E_return to compose (§14.5)",
    };
  }
  return { ok: true, returnWh: verdict.eReturnWh, reason: null };
}

/**
 * §14.5's third property — staleness is measured, not assumed.
 *
 * > The realised availability of the charger each plan selected is compared at
 * > settlement against what the projection claimed, and the error distribution is a
 * > calibration SLI (§21.5). A systematic optimism in the projection shows up as a
 * > margin that must widen, and is alertable before it shows up as a T2 event.
 *
 * This produces the tuple that comparison needs. It does **not** widen the margin:
 * `energy.charger_availability_margin` is Safety-class, and a module that adjusted it
 * from its own error measurements would be a calibration loop that never reached a
 * human (§22.4).
 *
 * @param {object} input
 * @returns {object}
 */
function settlementObservation(input) {
  const source = input || {};
  return Object.freeze({
    kind: "charger_projection_accuracy",
    chargerId: source.chargerId ?? null,
    projectionVersion: source.projectionVersion ?? null,
    projectedState: source.projectedState ?? null,
    realisedState: source.realisedState ?? null,
    projectedWaitSeconds: isNumber(source.projectedWaitSeconds) ? source.projectedWaitSeconds : null,
    realisedWaitSeconds: isNumber(source.realisedWaitSeconds) ? source.realisedWaitSeconds : null,
    optimistic:
      isNumber(source.projectedWaitSeconds) && isNumber(source.realisedWaitSeconds)
        ? source.realisedWaitSeconds > source.projectedWaitSeconds
        : null,
    observedAt: source.observedAt ?? null,
  });
}

module.exports = {
  BASIS,
  AVAILABILITY,
  VIABLE_AVAILABILITY,
  staleness,
  availabilityAt,
  evaluate,
  returnLayerWh,
  settlementObservation,
};

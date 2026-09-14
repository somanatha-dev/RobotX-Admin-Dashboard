"use strict";

/**
 * The **V1 deterministic campus travel-time model** — owner-declared, 2026-09-13.
 *
 * ── What this module is ────────────────────────────────────────────────────
 * The arithmetic that turns a routed **distance** into the `travelSeconds` and
 * `travelSdSeconds` the RobotX route contract requires. It is the owner's declared V1
 * model for a low-traffic campus, stated once, in one place, so that no caller can
 * assemble a travel time some other way and no reader has to guess which of two
 * formulas produced a number.
 *
 * > **Owner decision, 2026-09-13.** RNSIT is the first production campus and is treated
 * > as a low-traffic campus for V1. Expected travel time is a deterministic function of
 * > routed distance and the profile's own speed, plus a fixed operational allowance of
 * > **15 seconds per 100 metres** of route distance. No live-traffic dependency is
 * > required for V1.
 *
 *       travelSeconds = distanceM / speedMetresPerSecond      (base)
 *                     + distanceM × 15 / 100                  (operational buffer)
 *
 * ── What the buffer is, and the four things it is not ──────────────────────
 * The buffer is a **conservative campus operational allowance** covering pedestrians,
 * minor obstructions, turns, ordinary stop/start behaviour, speed variation, operational
 * hesitation, and small routing-model inaccuracy. It is:
 *
 *   * **not live traffic** — nothing here reads a traffic feed, and V1 declares none;
 *   * **not Google, Mapbox or any other provider's traffic data** — no such data is read
 *     anywhere in this repository, and §5.2/ADR-11 forbid a metered external API in the
 *     hot path regardless;
 *   * **not a statistically measured figure** — no campus travel-time study exists, and
 *     this module does not claim one. Its provenance is `PRODUCTION_DECLARED`, which is
 *     the whole point of having a provenance vocabulary at all;
 *   * **not a substitute for the routing engine's own duration** — the engine's duration
 *     is a *different* number, computed from the engine's own profile speeds, and §9 of
 *     the owner's decision says RobotX's answer is this model's, not the engine's. The
 *     router records that it overrode, so the two can never be confused after the fact.
 *
 * ── Why the engine's duration is deliberately discarded ────────────────────
 * OSRM's `foot` profile walks at its own configured speed, which is a pedestrian's, not a
 * delivery robot's, and it is a property of the *deployment's* Lua profile rather than of
 * the fleet. Using it would make RobotX's ETA a function of a file nobody in this
 * programme owns. The distance is the engine's measurement and is kept; the *time* is the
 * fleet's model and is computed here. That split is the reason `distanceM` and
 * `travelSeconds` have different provenances in the route contract.
 *
 * ── The spread (N29), and why it introduces no new number ──────────────────
 * `cellPairCache.buildEntry` requires a finite non-negative `travelSdSeconds`, and §8.4
 * prices `p_late` *"from the ETA predictive distribution, not the point estimate"*. No
 * shortlisted engine returns a spread, and N29 records that turning that silence into `0`
 * asserts *"this ETA is certain"* — the optimistic direction.
 *
 * So V1 declares one, and it is **derived from the operational buffer rather than from a
 * second invented constant**: the buffer is precisely the allowance for the disturbances
 * that make a campus traversal uncertain, so the same quantity is taken as the one-sigma
 * spread.
 *
 *       travelSdSeconds = operationalBufferSeconds × route.declared_travel_sd_buffer_multiple
 *
 * The multiple is registered with a seeded default of 1, so the shipped model adds no
 * number that was not already in the owner's decision. The direction is the conservative
 * one: a larger spread raises `p_late` and prices a route as *less* punctual, so an
 * over-stated uncertainty costs search quality and an under-stated one ships a promise the
 * fleet cannot keep. That asymmetry is the same argument `cellPairCache` makes about the
 * intra-cell offset, and it is why the multiple's floor is not zero.
 *
 * This is **not** a measured traffic standard deviation, and nothing here may be reported
 * as one. Its declared source name is `DECLARED_V1_OPERATIONAL_UNCERTAINTY`.
 *
 * ── What this module refuses ───────────────────────────────────────────────
 * A missing or non-positive speed, a missing or negative distance, a missing buffer and a
 * missing multiple are each a refusal with a named reason. Nothing is defaulted to zero
 * and nothing is guessed: the speed in particular is **D3's** (Product + Fleet
 * Engineering) for a physical fleet, and this module will not invent one to produce an
 * answer — see `routingProvenance.js` for which speeds are admissible in which mode.
 *
 * ── Determinism (R10, §9.6) ───────────────────────────────────────────────
 * No clock, no randomness, no `Math.random`, no locale-sensitive comparison, no hidden
 * state. The same inputs produce a bit-identical result on every host and every run,
 * which is what lets a route be replayed and a cache entry be trusted across workers.
 */

/**
 * Resolve one register entry against a snapshot, treating any failure as unresolved.
 *
 * The snapshot's own `resolve(name, context)` method is used rather than the module-level
 * `resolver.resolve(snapshot, name, …)`, because that is the form the composed solve path
 * already uses (`workers/coordinatorPipeline.js:120-127`). Two ways of asking the register
 * the same question is how the two halves of a system start disagreeing about what is
 * configured.
 *
 * @param {object|null|undefined} snapshot
 * @param {string} name
 * @param {object} scope
 * @returns {*} the resolved value, or `undefined`
 */
function resolveFrom(snapshot, name, scope) {
  if (!snapshot || typeof snapshot.resolve !== "function") return undefined;
  try {
    return snapshot.resolve(name, scope);
  } catch {
    return undefined;
  }
}

/**
 * The owner's declared V1 buffer denominator: the buffer is stated *per 100 metres*, so
 * the distance is divided by this before the per-unit allowance is applied. It is the
 * unit the decision is written in, not a tunable quantity — changing it would change what
 * the registered parameter *means* rather than what it is set to.
 * @structural the denominator of the owner's "seconds per 100 metres" statement
 */
const BUFFER_DISTANCE_UNIT_M = 100;

/**
 * The declared source name every `travelSdSeconds` this module produces is attributed to
 * (N29, §32.4 R7). It is carried into the adapter's `travelTimeSpread.source`, where
 * `contract.normaliseSpread` requires a **named** source and refuses a placeholder.
 * @structural the declared provenance name, not a tunable value
 */
const DECLARED_SPREAD_SOURCE = "DECLARED_V1_OPERATIONAL_UNCERTAINTY";

/**
 * A human-readable statement of what that name means, carried beside it so that a reader
 * who meets the name in a description, a decision record or a log does not have to come
 * back here to find out whether it is a measurement.
 * @structural the declared provenance's own explanation
 */
const DECLARED_SPREAD_BASIS =
  "RobotX V1 declared campus operational uncertainty. Derived from the owner-declared " +
  "operational travel-time buffer (route.campus_operational_buffer_s_per_100m), NOT measured, NOT " +
  "traffic-derived, and NOT sourced from any external provider. It is a declared modelling " +
  "policy under §8.4's requirement for a predictive distribution, and it must never be " +
  "reported as a calibrated or observed travel-time standard deviation.";

/** @param {unknown} value @returns {boolean} */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Read the two registered values this model is a function of.
 *
 * They are resolved through the register rather than stated here because both are
 * behavioural (§22.1 rule 2): the buffer is an operational allowance an operator may need
 * to change per region without a code change, and the multiple is the V1 uncertainty
 * policy's one dial. A bare constant for either would be exactly the thirteenth structural
 * limitation §1.7 names, reintroduced.
 *
 * @param {object|null} snapshot the register snapshot; `null` resolves seeded defaults
 * @param {object} [scope] §22.2 resolution scope, e.g. `{ region }`
 * @returns {{ ok: boolean, bufferSecondsPer100m: number|null, sdBufferMultiple: number|null,
 *             problems: string[] }}
 */
function resolveModelParameters(snapshot, scope) {
  const problems = [];
  const at = scope || {};

  const bufferValue = resolveFrom(snapshot, "route.campus_operational_buffer_s_per_100m", at);
  const multipleValue = resolveFrom(snapshot, "route.declared_travel_sd_buffer_multiple", at);

  if (!isFiniteNumber(bufferValue) || bufferValue < 0) {
    problems.push(
      "route.campus_operational_buffer_s_per_100m does not resolve to a finite non-negative number. It is the " +
        "owner's declared V1 campus operational travel-time allowance (15 s per 100 m at RNSIT); without it this " +
        "model has no buffer term and would report a bare distance/speed quotient as though it were an " +
        "operational estimate",
    );
  }
  if (!isFiniteNumber(multipleValue) || multipleValue <= 0) {
    problems.push(
      "route.declared_travel_sd_buffer_multiple does not resolve to a finite positive number. N29: no shortlisted " +
        "engine returns a travel-time spread, and defaulting it to 0 asserts 'this ETA is certain' in the " +
        "optimistic direction. The floor is exclusive of zero for exactly that reason",
    );
  }

  return {
    ok: problems.length === 0,
    bufferSecondsPer100m: problems.length === 0 ? bufferValue : null,
    sdBufferMultiple: problems.length === 0 ? multipleValue : null,
    problems,
  };
}

/**
 * The owner's V1 travel-time model over one routed distance.
 *
 * Every returned number is accompanied by the terms it was built from, because a caller
 * that wants to show *why* an ETA is what it is — §24's explanation surface, a decision
 * record, an operator asking why a 400 m delivery is quoted at eleven minutes — must not
 * have to re-derive the split from the total.
 *
 * @param {object} input `{ distanceM, speedMetresPerSecond, bufferSecondsPer100m,
 *   sdBufferMultiple }`
 * @returns {{ ok: boolean, travelSeconds: number|null, travelSdSeconds: number|null,
 *             terms: object|null, problems: string[] }}
 */
function travelTimeFor(input) {
  const source = input || {};
  const problems = [];

  if (!isFiniteNumber(source.distanceM) || source.distanceM < 0) {
    problems.push(
      `distanceM must be a finite non-negative number of metres, received ${JSON.stringify(source.distanceM)}. ` +
        "It is the routing engine's measured path length and is never substituted with a straight-line " +
        "estimate, a cell-centre separation or a constant",
    );
  }
  if (!isFiniteNumber(source.speedMetresPerSecond) || source.speedMetresPerSecond <= 0) {
    problems.push(
      `speedMetresPerSecond must be a finite positive number, received ${JSON.stringify(source.speedMetresPerSecond)}. ` +
        "For a physical fleet this is decision D3 (Product + Fleet Engineering) and no value is invented here; " +
        "for a simulated agent it comes from the simulator's own commissioned specification and carries " +
        "simulation provenance",
    );
  }
  if (!isFiniteNumber(source.bufferSecondsPer100m) || source.bufferSecondsPer100m < 0) {
    problems.push("bufferSecondsPer100m must be a finite non-negative number (route.campus_operational_buffer_s_per_100m)");
  }
  if (!isFiniteNumber(source.sdBufferMultiple) || source.sdBufferMultiple <= 0) {
    problems.push("sdBufferMultiple must be a finite positive number (route.declared_travel_sd_buffer_multiple)");
  }

  if (problems.length > 0) {
    return { ok: false, travelSeconds: null, travelSdSeconds: null, terms: null, problems };
  }

  const baseTravelSeconds = source.distanceM / source.speedMetresPerSecond;
  const operationalBufferSeconds = (source.distanceM * source.bufferSecondsPer100m) / BUFFER_DISTANCE_UNIT_M;
  const travelSeconds = baseTravelSeconds + operationalBufferSeconds;
  const travelSdSeconds = operationalBufferSeconds * source.sdBufferMultiple;

  return {
    ok: true,
    travelSeconds,
    travelSdSeconds,
    terms: Object.freeze({
      distanceM: source.distanceM,
      speedMetresPerSecond: source.speedMetresPerSecond,
      baseTravelSeconds,
      operationalBufferSeconds,
      bufferSecondsPer100m: source.bufferSecondsPer100m,
      bufferDistanceUnitM: BUFFER_DISTANCE_UNIT_M,
      sdBufferMultiple: source.sdBufferMultiple,
      spreadSource: DECLARED_SPREAD_SOURCE,
      spreadBasis: DECLARED_SPREAD_BASIS,
      // Stated explicitly so that a reader of a persisted route never has to infer it:
      // the engine answered with a duration and RobotX did not use it.
      engineDurationUsed: false,
    }),
    problems: [],
  };
}

module.exports = {
  BUFFER_DISTANCE_UNIT_M,
  DECLARED_SPREAD_SOURCE,
  DECLARED_SPREAD_BASIS,
  resolveModelParameters,
  travelTimeFor,
};

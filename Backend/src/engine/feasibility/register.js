"use strict";

/**
 * The constraint register (§7.5) — **Tier 0**, mechanism T0-01.
 *
 * The 38 predicates as data: id, the §7.2 class that governs it, the §7.3
 * indeterminate policy it declares, the §7.6 cache tier it belongs to, whether it is
 * in the §10.3.2 step-3 volatile subset, and the module that evaluates it.
 *
 * ── Why the register is data and not a switch statement ─────────────────────
 * Three properties §7 states are checkable only against a table:
 *
 *   1. §7.3 — "`DENY` … **Mandatory** for all class I and R predicates". Checked by
 *      `assertRegister()` over every row, so a permissive policy cannot be introduced
 *      by editing the predicate that carries it.
 *   2. §10.3.2 step 3 — "The volatile subset is an **enumerated, machine-checkable
 *      list**, not a prose description … A predicate is either on this list or it is
 *      not, and **adding a predicate to the constraint register requires classifying
 *      it**." A row with no `volatile` field fails the register assertion, which is
 *      what makes that last sentence true rather than aspirational.
 *   3. §7.5 — "the result is order-independent because every predicate is a pure
 *      function of the snapshot". The ordering below is therefore a performance
 *      property only, and `EVALUATION_ORDER` says so in one place instead of being
 *      implicit in the order of a chain of `if`s.
 *
 * ── Ordering ────────────────────────────────────────────────────────────────
 * > Evaluated in the order shown. Ordering is by *evaluation cost*, cheapest first,
 * > so that expensive computed predicates run only on candidates that survive cheap
 * > ones.
 *
 * The register's own order is that order: identity and lifecycle first (local,
 * sub-microsecond), computed mission feasibility last (a plan projection each).
 *
 * ── Dual classes ────────────────────────────────────────────────────────────
 * §7.5 gives three predicates two classes — F25 `C/R`, F27 `R/P`, F37 `F/C`. A
 * predicate has one governing class for the purpose of §7.3's mandatory-DENY rule,
 * and it is the **stricter** of the two, because the looser one cannot license an
 * override the stricter one forbids. `declaredClass` preserves the specification's own
 * string so a reviewer can check the choice rather than take it on trust.
 */

const {
  CONSTRAINT_CLASS,
  POLICY,
  assertPolicyLawful,
} = require("./threeValued");

/**
 * §7.6's three caching levels, each with the invalidation rule §7.6 states for it.
 * `NONE` is the third level — "not cached but … ordered last and short-circuit
 * early" — named rather than left as an absence so that every row classifies itself.
 * @structural the specification's own caching levels
 */
const CACHE_TIER = Object.freeze({
  /** §7.6 (1) — depends only on agent state; invalidated by any change to lifecycle,
   *  health, capability, firmware, or certification. */
  AGENT: "AGENT",
  /** §7.6 (2) — keyed `(agent_class, mission_class, zone)`; invalidated by config or
   *  map version change. */
  CLASS: "CLASS",
  /** §7.6 (3) — mission-specific; not cached. */
  NONE: "NONE",
});

/**
 * §7.5's seven groups, carried so rejection telemetry can aggregate by group without
 * re-deriving the grouping from predicate numbers.
 * @structural the specification's own group headings
 */
const GROUP = Object.freeze({
  IDENTITY_AND_LIFECYCLE: "IDENTITY_AND_LIFECYCLE",
  SAFETY_AND_HEALTH: "SAFETY_AND_HEALTH",
  CONNECTIVITY_AND_COMMANDABILITY: "CONNECTIVITY_AND_COMMANDABILITY",
  COMMITMENT_AND_AVAILABILITY: "COMMITMENT_AND_AVAILABILITY",
  CAPABILITY_AND_PAYLOAD: "CAPABILITY_AND_PAYLOAD",
  SPATIAL_TEMPORAL_REGULATORY: "SPATIAL_TEMPORAL_REGULATORY",
  COMPUTED_MISSION_FEASIBILITY: "COMPUTED_MISSION_FEASIBILITY",
});

const C = CONSTRAINT_CLASS;
const P = POLICY;
const T = CACHE_TIER;
const G = GROUP;

/**
 * The register. One row per predicate, in §7.5's evaluation order.
 *
 * `evaluate` is the module's exported function, required eagerly: the gate runs on
 * every candidate of every round, and a lazy require inside the hot path would put a
 * module-resolution cache lookup on it for no benefit.
 */
const PREDICATES = Object.freeze([
  // ── Group 1 — Identity and lifecycle (local, sub-microsecond) ─────────────
  row("F1", "Agent exists and is commissioned", C.INVARIANT, "I", P.DENY, T.AGENT, false, G.IDENTITY_AND_LIFECYCLE, "f01"),
  row("F2", "Lifecycle state is active", C.POLICY, "P", P.DENY, T.AGENT, false, G.IDENTITY_AND_LIFECYCLE, "f02"),
  row("F3", "Not under operator hold or quarantine", C.POLICY, "P", P.DENY, T.AGENT, false, G.IDENTITY_AND_LIFECYCLE, "f03"),
  row("F4", "Tenant and fleet scope permit this mission", C.CONTRACTUAL, "C", P.DENY, T.AGENT, false, G.IDENTITY_AND_LIFECYCLE, "f04"),
  row("F5", "Software/firmware version is in the supported set for this mission type", C.INVARIANT, "I", P.DENY, T.AGENT, false, G.IDENTITY_AND_LIFECYCLE, "f05"),
  row("F6", "Calibration and certification valid at projected mission end", C.REGULATORY, "R", P.DENY, T.AGENT, false, G.IDENTITY_AND_LIFECYCLE, "f06"),

  // ── Group 2 — Safety and health (local, cached) ───────────────────────────
  row("F7", "Emergency stop not engaged", C.INVARIANT, "I", P.DENY, T.AGENT, true, G.SAFETY_AND_HEALTH, "f07"),
  row("F8", "No active fault of severity >= blocking", C.INVARIANT, "I", P.DENY, T.AGENT, true, G.SAFETY_AND_HEALTH, "f08"),
  row("F9", "Health tier >= tier required by the mission's SLA class", C.POLICY, "P", P.DENY, T.AGENT, false, G.SAFETY_AND_HEALTH, "f09"),
  row("F10", "Localisation confidence >= threshold, corroborated independently of the localisation stack", C.INVARIANT, "I", P.DENY, T.AGENT, true, G.SAFETY_AND_HEALTH, "f10"),
  row("F11", "Reliability estimate within acceptable bound for the mission class", C.POLICY, "P", P.ADMIT_WITH_PENALTY, T.AGENT, false, G.SAFETY_AND_HEALTH, "f11"),
  row("F12", "No safety-relevant recall or advisory outstanding against this agent class", C.REGULATORY, "R", P.DENY, T.AGENT, false, G.SAFETY_AND_HEALTH, "f12"),

  // ── Group 3 — Connectivity and commandability (live state) ────────────────
  row("F13", "Live session exists and heartbeat is within connectivity.max_heartbeat_age", C.INVARIANT, "I", P.DENY, T.NONE, true, G.CONNECTIVITY_AND_COMMANDABILITY, "f13"),
  row("F14", "Command path proven: a recent command round-trip or heartbeat ACK succeeded", C.INVARIANT, "I", P.DENY, T.NONE, true, G.CONNECTIVITY_AND_COMMANDABILITY, "f14"),
  row("F15", "Link quality sufficient for the mission's supervision requirement", C.POLICY, "P", P.ADMIT_WITH_PENALTY, T.NONE, false, G.CONNECTIVITY_AND_COMMANDABILITY, "f15"),
  row("F16", "Observation freshness within the budget for every safety-relevant input", C.INVARIANT, "I", P.DENY, T.NONE, true, G.CONNECTIVITY_AND_COMMANDABILITY, "f16"),

  // ── Group 4 — Commitment and availability ─────────────────────────────────
  row("F17", "The candidate plan holds no more than capacity[agent_class] concurrent commitments and extends no further than plan.commitment_horizon", C.INVARIANT, "I", P.DENY, T.NONE, true, G.COMMITMENT_AND_AVAILABILITY, "f17"),
  row("F18", "No conflicting reservation held by another subsystem", C.INVARIANT, "I", P.DENY, T.NONE, true, G.COMMITMENT_AND_AVAILABILITY, "f18"),
  row("F19", "Projected availability time <= mission's latest feasible start", C.FEASIBILITY, "F", P.DENY, T.NONE, false, G.COMMITMENT_AND_AVAILABILITY, "f19"),
  row("F20", "Not excluded for this Leg by cooloff, incumbent penalty, or NACK cooloff", C.POLICY, "P", P.DENY, T.NONE, true, G.COMMITMENT_AND_AVAILABILITY, "f20"),

  // ── Group 5 — Capability and payload ──────────────────────────────────────
  row("F21", "RequirementSet(m) subset of CapabilityBundle(a) under the typed algebra of §2.3", C.INVARIANT, "I", P.DENY, T.CLASS, false, G.CAPABILITY_AND_PAYLOAD, "f21"),
  row("F22", "Total payload mass <= rated capacity x payload.safety_factor at every point in the plan", C.INVARIANT, "I", P.DENY, T.NONE, false, G.CAPABILITY_AND_PAYLOAD, "f22"),
  row("F23", "Dimensional and volumetric packing feasible", C.INVARIANT, "I", P.DENY, T.NONE, false, G.CAPABILITY_AND_PAYLOAD, "f23"),
  row("F24", "Centre-of-gravity envelope satisfied for every loading state", C.INVARIANT, "I", P.DENY, T.NONE, false, G.CAPABILITY_AND_PAYLOAD, "f24"),
  row("F25", "Thermal class of an assigned compartment covers the payload's required range for the projected duration", C.REGULATORY, "C/R", P.DENY, T.CLASS, false, G.CAPABILITY_AND_PAYLOAD, "f25"),
  row("F26", "Hazmat, security, and segregation rules satisfied for the combined load", C.REGULATORY, "R", P.DENY, T.CLASS, false, G.CAPABILITY_AND_PAYLOAD, "f26"),

  // ── Group 6 — Spatial, temporal, and regulatory permission ────────────────
  row("F27", "Agent authorised in every zone the planned route traverses", C.REGULATORY, "R/P", P.DENY, T.NONE, false, G.SPATIAL_TEMPORAL_REGULATORY, "f27"),
  row("F28", "Route uses only road/surface classes the MobilityModel permits", C.INVARIANT, "I", P.DENY, T.CLASS, false, G.SPATIAL_TEMPORAL_REGULATORY, "f28"),
  row("F29", "Dimensional passage feasible along the route", C.INVARIANT, "I", P.DENY, T.CLASS, false, G.SPATIAL_TEMPORAL_REGULATORY, "f29"),
  row("F30", "Time-of-day, day-of-week, and event restrictions satisfied for the projected traversal window", C.REGULATORY, "R", P.DENY, T.NONE, false, G.SPATIAL_TEMPORAL_REGULATORY, "f30"),
  row("F31", "Environmental envelope satisfied over the projected mission window using forecast conditions", C.INVARIANT, "I", P.DENY, T.NONE, false, G.SPATIAL_TEMPORAL_REGULATORY, "f31"),
  row("F32", "Site access prerequisites obtainable", C.FEASIBILITY, "F", P.DENY_UNLESS_ENVELOPE, T.NONE, false, G.SPATIAL_TEMPORAL_REGULATORY, "f32"),
  row("F33", "Geofence: origin and destination inside the serviceable region", C.CONTRACTUAL, "C", P.DENY, T.NONE, false, G.SPATIAL_TEMPORAL_REGULATORY, "f33"),

  // ── Group 7 — Computed mission feasibility ────────────────────────────────
  row("F34", "Energy feasibility with layered reserves at the configured confidence, evaluated at all three shortfall tiers", C.INVARIANT, "I", P.DENY, T.NONE, true, G.COMPUTED_MISSION_FEASIBILITY, "f34"),
  row("F35", "Charger reachable from the projected mission end with reserve intact", C.INVARIANT, "I", P.DENY, T.NONE, true, G.COMPUTED_MISSION_FEASIBILITY, "f35"),
  row("F36", "Maintenance interval not exceeded before projected mission end", C.POLICY, "P", P.DENY, T.NONE, false, G.COMPUTED_MISSION_FEASIBILITY, "f36"),
  row("F37", "Deadline feasibility: earliest feasible completion <= hard deadline", C.CONTRACTUAL, "F/C", P.DENY, T.NONE, false, G.COMPUTED_MISSION_FEASIBILITY, "f37"),
  row("F38", "Plan validity: a complete, executable plan exists with all stops sequenced within their time windows", C.FEASIBILITY, "F", P.DENY, T.NONE, false, G.COMPUTED_MISSION_FEASIBILITY, "f38"),
]);

/**
 * Build one register row.
 *
 * @param {string} id `F1` … `F38`
 * @param {string} name §7.5's own Predicate column, abbreviated to one line
 * @param {string} constraintClass the **governing** class (the stricter, where §7.5
 *   gives two)
 * @param {string} declaredClass §7.5's own Class column, verbatim
 * @param {string} policy §7.5's own Indeterminate column
 * @param {string} cacheTier §7.6's caching level
 * @param {boolean} volatile membership of the §10.3.2 step-3 enumerated subset
 * @param {string} group §7.5's group heading
 * @param {string} moduleName the file under `predicates/`
 * @returns {object} a frozen row
 */
function row(id, name, constraintClass, declaredClass, policy, cacheTier, volatile, group, moduleName) {
  return Object.freeze({
    id,
    name,
    constraintClass,
    declaredClass,
    policy,
    cacheTier,
    volatile,
    group,
    module: moduleName,
    // eslint-disable-next-line global-require
    evaluate: require(`./predicates/${moduleName}`).evaluate,
  });
}

/** The §7.5 evaluation order — cheapest first. A performance property only. */
const EVALUATION_ORDER = Object.freeze(PREDICATES.map((predicate) => predicate.id));

const BY_ID = Object.freeze(
  PREDICATES.reduce((index, predicate) => {
    index[predicate.id] = predicate;
    return index;
  }, Object.create(null)),
);

/**
 * §7.5: "**Total: 38 predicates against the baseline's effective 8**".
 * @structural the specification's own predicate count
 */
const PREDICATE_COUNT = 38;

/**
 * @param {string} id
 * @returns {object|null}
 */
function predicate(id) {
  return BY_ID[id] || null;
}

/**
 * Every predicate of a given §7.2 class.
 *
 * @param {string} constraintClass
 * @returns {object[]}
 */
function predicatesOfClass(constraintClass) {
  return PREDICATES.filter((entry) => entry.constraintClass === constraintClass);
}

/**
 * Every predicate at a given §7.6 cache tier.
 *
 * @param {string} cacheTier
 * @returns {object[]}
 */
function predicatesAtCacheTier(cacheTier) {
  return PREDICATES.filter((entry) => entry.cacheTier === cacheTier);
}

/**
 * Prove the register's own coherence. Run by the engine test lane and by
 * `evaluate.js` at module load, because a gate reading from an incoherent register
 * proves nothing — the same argument `tierAssertions.js` makes for the tier table.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
function assertRegister() {
  const problems = [];

  if (PREDICATES.length !== PREDICATE_COUNT) {
    problems.push(`the register holds ${PREDICATES.length} predicates; §7.5 states ${PREDICATE_COUNT}`);
  }

  const seen = new Set();
  for (const entry of PREDICATES) {
    if (seen.has(entry.id)) problems.push(`predicate "${entry.id}" appears twice`);
    seen.add(entry.id);

    // §7.3's mandatory-DENY rule, and the Permitted-for column beneath it.
    problems.push(
      ...assertPolicyLawful(entry.constraintClass, entry.policy).map(
        (problem) => `${entry.id}: ${problem}`,
      ),
    );

    if (typeof entry.volatile !== "boolean") {
      problems.push(
        `${entry.id} does not classify itself against the §10.3.2 step-3 volatile subset. ` +
          "Adding a predicate to the constraint register requires classifying it",
      );
    }

    if (!Object.values(CACHE_TIER).includes(entry.cacheTier)) {
      problems.push(`${entry.id} declares cache tier "${String(entry.cacheTier)}", which is not a §7.6 level`);
    }

    if (typeof entry.evaluate !== "function") {
      problems.push(`${entry.id} names module "${entry.module}", which exports no evaluate()`);
    }

    // The governing class must be at least as strict as every class §7.5 declares.
    // "Stricter" here means: if R or I appears in the declared string, the governing
    // class must be one of them, or the mandatory-DENY rule could be evaded by
    // recording the looser half.
    const declaresNeverOverridable = /\b[IR]\b/.test(entry.declaredClass.replace(/\//g, " "));
    const governedNeverOverridable =
      entry.constraintClass === CONSTRAINT_CLASS.INVARIANT ||
      entry.constraintClass === CONSTRAINT_CLASS.REGULATORY;
    if (declaresNeverOverridable && !governedNeverOverridable) {
      problems.push(
        `${entry.id} declares class "${entry.declaredClass}" but is governed as class ` +
          `"${entry.constraintClass}". Where §7.5 gives two classes the governing one must be ` +
          "the stricter, or §7.3's mandatory DENY could be evaded by recording the looser half",
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

module.exports = {
  CACHE_TIER,
  GROUP,
  PREDICATES,
  PREDICATE_COUNT,
  EVALUATION_ORDER,
  predicate,
  predicatesOfClass,
  predicatesAtCacheTier,
  assertRegister,
};

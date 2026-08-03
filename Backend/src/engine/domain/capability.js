"use strict";

/**
 * CapabilityBundle and requirement matching (§2.3) — **Tier 0**, mechanism T0-04.
 *
 * > Capabilities are typed, not string tags, because untyped tags cannot express
 * > thresholds and degrade into a taxonomy nobody maintains.
 *
 * A mission carries a **RequirementSet** in the same algebra, and matching is
 * set-and-threshold containment evaluated as a hard constraint (§7.5). This module
 * is that algebra. It is a pure function of its arguments: no clock, no store, no
 * configuration — the mission end time is an *input*, because §2.3 requires
 * certified capabilities to be checked against mission end and a module that read
 * the wall clock would check them against decision time instead.
 *
 * ── What this module deliberately does not do ────────────────────────────────
 * It does not decide feasibility. Phase 6 owns the 38-predicate register, the
 * three-valued evaluation of §7.3, and the per-predicate indeterminate policy; F21
 * consumes the result shape below and maps `INDETERMINATE` through the policy that
 * predicate declares. What is settled here is that an absent or unreadable
 * capability is **never** reported as satisfied (T2: unknown is never permission).
 *
 * ── Trust ────────────────────────────────────────────────────────────────────
 * §2.1 and §23.5: **capabilities are attested, never self-declared at runtime.**
 * The authoritative set comes from the commissioning record, the installed hardware
 * manifest, and a signed firmware attestation. This module matches against whatever
 * bundle it is handed; enforcing where that bundle came from is Phase 14's
 * `security/attestation.js`, and `assertAttested()` below is the seam it fills.
 */

/**
 * The five capability representations of §2.3.
 * @structural these are the specification's own kind labels, not tunable values
 */
const CAPABILITY_KIND = Object.freeze({
  BOOLEAN: "BOOLEAN",
  GRADED: "GRADED",
  QUANTITATIVE: "QUANTITATIVE",
  ENUMERATED: "ENUMERATED",
  CERTIFIED: "CERTIFIED",
});

const CAPABILITY_KINDS = Object.freeze(Object.values(CAPABILITY_KIND));

/**
 * The comparison a requirement asks for. §2.3's examples are
 * `autonomy_level ≥ 3`, `max_payload_mass ≥ 12 kg`, `cold_chain_min_temp ≤ 2 °C`,
 * and `hazmat_classes ⊇ {UN3480}`.
 * @structural operator labels, not values
 */
const COMPARATOR = Object.freeze({
  PRESENT: "PRESENT",
  AT_LEAST: "AT_LEAST",
  AT_MOST: "AT_MOST",
  EQUALS: "EQUALS",
  SUPERSET_OF: "SUPERSET_OF",
});

/**
 * The three outcomes a single requirement match can have. These deliberately mirror
 * §7.3's vocabulary so Phase 6 can lift them without translation.
 * @structural outcome labels
 */
const MATCH = Object.freeze({
  SATISFIED: "SATISFIED",
  VIOLATED: "VIOLATED",
  INDETERMINATE: "INDETERMINATE",
});

/**
 * §2.3: **`custody_transfer_capable` defaults to `false`, and the default is the
 * realistic case.** Agent-to-agent physical transfer requires a manipulator, a
 * mutually accessible compartment interface, or a docking-compatible pair. Most
 * sidewalk delivery robots have none of these, so for most fleets the `Transfer`
 * recovery outcome of §4.7 collapses into human-mediated retrieval. Modelling the
 * capability explicitly, and defaulting it off, is what prevents the recovery
 * machinery from selecting a physically impossible outcome.
 */
const CUSTODY_TRANSFER_CAPABLE = "custody_transfer_capable";

/**
 * Boolean capabilities whose absence means `false` rather than "unknown".
 *
 * The list is deliberately short and deliberately explicit. Every other absent
 * capability is `INDETERMINATE`, because "we have no record of this capability" and
 * "this agent definitely lacks it" are different facts and only one of them is
 * safe to act on.
 */
const DEFAULT_FALSE_CAPABILITIES = Object.freeze([CUSTODY_TRANSFER_CAPABLE]);

/**
 * Index a bundle's capabilities by name.
 *
 * @param {{ capabilities?: Array<object> }|Array<object>|null|undefined} bundle
 * @returns {Map<string, object>}
 */
function indexBundle(bundle) {
  const list = Array.isArray(bundle) ? bundle : (bundle && bundle.capabilities) || [];
  const index = new Map();
  for (const capability of list) {
    if (!capability || typeof capability.name !== "string") continue;
    index.set(capability.name, capability);
  }
  return index;
}

/**
 * @param {unknown} kind
 * @returns {boolean}
 */
function isCapabilityKind(kind) {
  return typeof kind === "string" && CAPABILITY_KINDS.includes(kind);
}

/**
 * A structured outcome, so a caller never has to infer *why* from a bare boolean —
 * the rejection tuple of §7.7 needs the observed value, the required value, and the
 * reason.
 *
 * @param {string} outcome
 * @param {object} detail
 * @returns {object}
 */
function result(outcome, detail) {
  return Object.freeze({ outcome, ...detail });
}

/**
 * Is a certified capability valid at the moment it must be (§2.3)?
 *
 * > Certified capabilities MUST be checked against *mission end time*, not decision
 * > time — a certification expiring mid-mission is a compliance breach, and this is
 * > a class of defect that only an explicit temporal check catches.
 *
 * @param {object} capability
 * @param {number} missionEndEpochMs the pinned mission end, supplied by the caller
 * @returns {string} one of MATCH
 */
function validityAt(capability, missionEndEpochMs) {
  if (typeof missionEndEpochMs !== "number" || !Number.isFinite(missionEndEpochMs)) {
    return MATCH.INDETERMINATE;
  }
  const from = capability.validFrom === undefined || capability.validFrom === null
    ? null
    : new Date(capability.validFrom).getTime();
  const until = capability.validUntil === undefined || capability.validUntil === null
    ? null
    : new Date(capability.validUntil).getTime();

  // A certified capability with no stated validity window is not "valid forever";
  // it is a record whose expiry nobody wrote down.
  if (until === null) return MATCH.INDETERMINATE;
  if (from !== null && Number.isFinite(from) && missionEndEpochMs < from) return MATCH.VIOLATED;
  if (!Number.isFinite(until)) return MATCH.INDETERMINATE;
  return missionEndEpochMs <= until ? MATCH.SATISFIED : MATCH.VIOLATED;
}

/**
 * Compare one requirement against one held capability value.
 *
 * @param {string} comparator one of COMPARATOR
 * @param {*} held
 * @param {*} required
 * @returns {string} one of MATCH
 */
function compareValues(comparator, held, required) {
  switch (comparator) {
    case COMPARATOR.PRESENT:
      return held === true || (held !== null && held !== undefined && held !== false)
        ? MATCH.SATISFIED
        : MATCH.VIOLATED;

    case COMPARATOR.EQUALS:
      return held === required ? MATCH.SATISFIED : MATCH.VIOLATED;

    case COMPARATOR.AT_LEAST: {
      if (typeof held !== "number" || typeof required !== "number") return MATCH.INDETERMINATE;
      if (!Number.isFinite(held) || !Number.isFinite(required)) return MATCH.INDETERMINATE;
      return held >= required ? MATCH.SATISFIED : MATCH.VIOLATED;
    }

    case COMPARATOR.AT_MOST: {
      if (typeof held !== "number" || typeof required !== "number") return MATCH.INDETERMINATE;
      if (!Number.isFinite(held) || !Number.isFinite(required)) return MATCH.INDETERMINATE;
      return held <= required ? MATCH.SATISFIED : MATCH.VIOLATED;
    }

    case COMPARATOR.SUPERSET_OF: {
      if (!Array.isArray(held) || !Array.isArray(required)) return MATCH.INDETERMINATE;
      const heldSet = new Set(held);
      return required.every((member) => heldSet.has(member)) ? MATCH.SATISFIED : MATCH.VIOLATED;
    }

    default:
      // An unrecognised comparator is not a permissive one.
      return MATCH.INDETERMINATE;
  }
}

/**
 * Match one requirement against a bundle.
 *
 * @param {Map<string, object>} index from `indexBundle`
 * @param {{ name: string, comparator?: string, value?: *, kind?: string }} requirement
 * @param {{ missionEndEpochMs?: number }} [context]
 * @returns {object} `{ outcome, name, comparator, required, observed, reason }`
 */
function matchOne(index, requirement, context) {
  const name = requirement && requirement.name;
  if (typeof name !== "string" || name.length === 0) {
    return result(MATCH.INDETERMINATE, { name: String(name), reason: "requirement has no capability name" });
  }

  const comparator = requirement.comparator || COMPARATOR.PRESENT;
  const required = requirement.value;
  const held = index.get(name);

  if (!held) {
    // The one enumerated exception: §2.3 states this capability's default.
    if (DEFAULT_FALSE_CAPABILITIES.includes(name)) {
      const outcome = compareValues(comparator, false, required);
      return result(outcome, {
        name,
        comparator,
        required,
        observed: false,
        reason: `${name} is absent and defaults to false (§2.3)`,
      });
    }
    return result(MATCH.INDETERMINATE, {
      name,
      comparator,
      required,
      observed: null,
      reason:
        "the bundle records no such capability. Absence is INDETERMINATE, never a satisfied " +
        "or a violated match: unknown is never permission (T2), and it is also not evidence of lack",
    });
  }

  if (held.kind === CAPABILITY_KIND.CERTIFIED) {
    const validity = validityAt(held, context && context.missionEndEpochMs);
    if (validity !== MATCH.SATISFIED) {
      return result(validity, {
        name,
        comparator,
        required,
        observed: held.value === undefined ? null : held.value,
        validUntil: held.validUntil || null,
        reason:
          validity === MATCH.VIOLATED
            ? "certification is not valid at mission end (§2.3)"
            : "certification validity cannot be established at mission end (§2.3)",
      });
    }
  }

  const observed = held.value === undefined ? null : held.value;
  const outcome = compareValues(comparator, observed, required);
  return result(outcome, { name, comparator, required, observed, kind: held.kind || null });
}

/**
 * Match a RequirementSet against a CapabilityBundle (§2.3).
 *
 * Set-and-threshold containment: every requirement must be satisfied. The result
 * carries every individual outcome, because §7.7's rejection tuple reports the
 * *binding* requirement rather than "capability mismatch".
 *
 * @param {object|Array<object>} bundle the agent's CapabilityBundle
 * @param {Array<object>} requirements the mission's RequirementSet
 * @param {{ missionEndEpochMs?: number }} [context]
 * @returns {{ outcome: string, matches: object[], binding: object|null }}
 */
function matchRequirements(bundle, requirements, context) {
  const index = indexBundle(bundle);
  const list = Array.isArray(requirements) ? requirements : [];
  const matches = list.map((requirement) => matchOne(index, requirement, context));

  const violated = matches.find((match) => match.outcome === MATCH.VIOLATED) || null;
  if (violated) return { outcome: MATCH.VIOLATED, matches, binding: violated };

  const indeterminate = matches.find((match) => match.outcome === MATCH.INDETERMINATE) || null;
  if (indeterminate) return { outcome: MATCH.INDETERMINATE, matches, binding: indeterminate };

  return { outcome: MATCH.SATISFIED, matches, binding: null };
}

/**
 * `custody_transfer_capable` for one agent (§2.3, §4.7).
 *
 * Absent means false, which is the realistic case and the one that keeps the
 * recovery machinery from selecting a physically impossible outcome.
 *
 * @param {object|Array<object>} bundle
 * @returns {boolean}
 */
function isCustodyTransferCapable(bundle) {
  const held = indexBundle(bundle).get(CUSTODY_TRANSFER_CAPABLE);
  return Boolean(held && held.value === true);
}

/**
 * §2.1, §23.5: an agent's claim about its own capability is untrusted input. A
 * capability whose `source` is an agent report is not admissible into the
 * authoritative bundle.
 *
 * Phase 14 replaces the source check with signature verification against the
 * commissioning record and the firmware attestation. The seam exists here so that
 * Phase 2's bundle loader already refuses the telemetry path rather than acquiring
 * the refusal later.
 *
 * @param {object} capability
 * @returns {boolean}
 */
function isAttested(capability) {
  if (!capability || typeof capability !== "object") return false;
  const source = capability.source;
  return source === "COMMISSIONING_RECORD" || source === "HARDWARE_MANIFEST" || source === "FIRMWARE_ATTESTATION";
}

/**
 * Throw unless every capability in the bundle came from an admissible source.
 *
 * @param {object|Array<object>} bundle
 * @throws {Error} naming the capability that arrived by an untrusted path
 */
function assertAttested(bundle) {
  for (const capability of indexBundle(bundle).values()) {
    if (!isAttested(capability)) {
      throw new Error(
        `capability "${capability.name}" carries source "${String(capability.source)}", which is not an ` +
          "attested origin. Capabilities are derived from the commissioning record, the installed " +
          "hardware manifest, and a signed firmware attestation — never self-declared at runtime " +
          "(§2.1, §23.2, §23.5).",
      );
    }
  }
}

module.exports = {
  CAPABILITY_KIND,
  CAPABILITY_KINDS,
  COMPARATOR,
  MATCH,
  CUSTODY_TRANSFER_CAPABLE,
  DEFAULT_FALSE_CAPABILITIES,
  indexBundle,
  isCapabilityKind,
  validityAt,
  compareValues,
  matchOne,
  matchRequirements,
  isCustodyTransferCapable,
  isAttested,
  assertAttested,
};

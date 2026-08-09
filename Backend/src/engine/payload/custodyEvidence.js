"use strict";

/**
 * Custody, evidence, and manifest reconciliation (§15.6) — **Tier 0**.
 *
 * §15.6 states three rules and one invariant, and this module is those three rules:
 *
 * > - Custody transitions require evidence proportionate to value (§12.5): compartment
 * >   sensing, mass delta, scan, or attestation.
 * > - The payload manifest is reconciled at every custody event. A mass delta
 * >   inconsistent with the manifest is a discrepancy event, not a rounding error — it
 * >   may mean a wrong item, a missing item, or tampering.
 * > - An agent MUST NOT be returned to the available pool while any compartment is
 * >   non-empty against an open manifest (§26 invariant I7). **This single invariant
 * >   prevents an entire class of lost-goods incidents, and it is the reason custody
 * >   release must precede commitment release in settlement (§4.9).**
 *
 * ── Why the evidence ladder is imported rather than restated ───────────────
 * The four evidence kinds §15.6 names are the same evidence §12.5 grades L0–L3, and
 * `supervision/verification.js` already implements that ladder. Restating it here would
 * give the fleet two definitions of "sufficient evidence" — one for completing a leg
 * and one for taking custody of the goods on it — which is exactly the kind of near-
 * duplicate that drifts. `requiredLevelFor()` is re-exported through this module so a
 * caller reasoning about custody reads the same table.
 *
 * ── Why the mass-delta band is Safety-class ───────────────────────────────
 * `payload.mass_discrepancy_tolerance_kg` is a property of the scale, not a policy
 * allowance. Widening it is how a tampering signal would be tuned away, which is why
 * the register entry names Safety as its owner. Zero tolerance is not the safe default
 * either: a scale with ±200 g of noise would raise a discrepancy on every custody
 * event, and an alarm that always fires is an alarm nobody reads.
 *
 * ── The I7 check is a refusal, not a warning ──────────────────────────────
 * `assertReleasable()` returns a refusal that `lifecycle/settlement.js` is expected to
 * honour by aborting the release. Phase 5 built settlement with custody release
 * strictly before commitment release; this supplies the payload-side precondition that
 * ordering exists to protect.
 *
 * Tier 0 (T0-07). Invariants I7, I8. Decision path (T6): no clock, no randomness, no store.
 */

const verification = require("../supervision/verification");

/**
 * The four evidence kinds §15.6 names, with the §12.5 level each one can establish on
 * its own. A stronger kind may of course be offered where a weaker one would do.
 * @structural the specification's own evidence kinds
 */
const EVIDENCE_KIND = Object.freeze({
  COMPARTMENT_SENSING: "COMPARTMENT_SENSING",
  MASS_DELTA: "MASS_DELTA",
  SCAN: "SCAN",
  ATTESTATION: "ATTESTATION",
});

/**
 * Which §12.5 level each evidence kind establishes.
 *
 * `ATTESTATION` is L3 because §12.5 puts a countersigned handover at the top of the
 * ladder; `SCAN` is L2 because it identifies the specific item; `COMPARTMENT_SENSING`
 * and `MASS_DELTA` are L1 because they establish that *something* of about the right
 * size moved, which is a physical event rather than an identification.
 * @structural the mapping from §15.6's evidence kinds onto §12.5's ladder
 */
const EVIDENCE_LEVEL = Object.freeze({
  [EVIDENCE_KIND.COMPARTMENT_SENSING]: verification.LEVEL.L1,
  [EVIDENCE_KIND.MASS_DELTA]: verification.LEVEL.L1,
  [EVIDENCE_KIND.SCAN]: verification.LEVEL.L2,
  [EVIDENCE_KIND.ATTESTATION]: verification.LEVEL.L3,
});

/**
 * The discrepancy classes §15.6 names.
 * @structural the specification's own discrepancy interpretations
 */
const DISCREPANCY = Object.freeze({
  MASS_DELTA_INCONSISTENT: "MASS_DELTA_INCONSISTENT",
  COMPARTMENT_UNEXPECTEDLY_OCCUPIED: "COMPARTMENT_UNEXPECTEDLY_OCCUPIED",
  COMPARTMENT_UNEXPECTEDLY_EMPTY: "COMPARTMENT_UNEXPECTEDLY_EMPTY",
  ITEM_NOT_SCANNED: "ITEM_NOT_SCANNED",
  UNDECLARED_ITEM: "UNDECLARED_ITEM",
});

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The strongest level a set of offered evidence establishes.
 *
 * @param {Array<{kind: string}>} evidence
 * @returns {{ level: string, kinds: string[] }}
 */
function establishedLevel(evidence) {
  const kinds = (Array.isArray(evidence) ? evidence : [])
    .map((entry) => entry && entry.kind)
    .filter((kind) => Object.prototype.hasOwnProperty.call(EVIDENCE_LEVEL, kind));

  let best = verification.LEVEL.L0;
  for (const kind of kinds) {
    if (verification.meets(EVIDENCE_LEVEL[kind], best)) best = EVIDENCE_LEVEL[kind];
  }
  return { level: best, kinds };
}

/**
 * Is the offered evidence sufficient for this custody transition?
 *
 * @param {object} input
 * @param {Array<{kind: string}>} input.evidence
 * @param {string} input.missionClass
 * @param {object} input.levelsByMissionClass `verify.level_by_mission_class`
 * @returns {{ ok: boolean, required: string, established: string, kinds: string[],
 *             reason: string|null }}
 */
function sufficientForTransition(input) {
  const source = input || {};
  const required = verification.requiredLevelFor(source.missionClass, source.levelsByMissionClass);
  const { level, kinds } = establishedLevel(source.evidence);

  if (verification.meets(level, required)) return { ok: true, required, established: level, kinds, reason: null };

  return {
    ok: false,
    required,
    established: level,
    kinds,
    reason:
      `custody evidence at ${level} does not meet the ${required} this mission class requires. ` +
      `Offered: ${kinds.length > 0 ? kinds.join(", ") : "none"} (§15.6, §12.5)`,
  };
}

/**
 * Reconcile the manifest at a custody event.
 *
 * Three independent comparisons, each producing its own discrepancy class, because they
 * fail for different reasons and an operator responding to them does different things:
 * a mass delta outside the band suggests a wrong or missing item, an unexpectedly
 * occupied compartment suggests goods left behind, and an unscanned item on a class
 * requiring scans suggests a step was skipped.
 *
 * @param {object} input
 * @param {object} input.manifest `{ manifestId, state, items: [...] }`
 * @param {number|null} input.expectedMassDeltaKg what the manifest says should move
 * @param {number|null} input.observedMassDeltaKg what the scale measured
 * @param {number} input.toleranceKg `payload.mass_discrepancy_tolerance_kg`
 * @param {Array<{compartmentId: string, occupied: boolean}>} [input.compartmentSensors]
 * @param {Array<{compartmentId: string, expectedOccupied: boolean}>} [input.expectedOccupancy]
 * @param {string[]} [input.scannedItemIds]
 * @param {string[]} [input.expectedItemIds]
 * @returns {{ ok: boolean, discrepancies: object[], measured: object }}
 */
function reconcile(input) {
  const source = input || {};
  const discrepancies = [];

  // (i) Mass delta.
  if (isNumber(source.expectedMassDeltaKg) && isNumber(source.observedMassDeltaKg)) {
    if (!isNumber(source.toleranceKg) || source.toleranceKg < 0) {
      discrepancies.push({
        kind: DISCREPANCY.MASS_DELTA_INCONSISTENT,
        reason: "payload.mass_discrepancy_tolerance_kg is unresolved, so a mass delta cannot be judged (§15.6)",
      });
    } else {
      const delta = source.observedMassDeltaKg - source.expectedMassDeltaKg;
      if (Math.abs(delta) > source.toleranceKg) {
        discrepancies.push({
          kind: DISCREPANCY.MASS_DELTA_INCONSISTENT,
          expectedKg: source.expectedMassDeltaKg,
          observedKg: source.observedMassDeltaKg,
          deltaKg: delta,
          toleranceKg: source.toleranceKg,
          reason:
            `the observed mass delta differs from the manifest by ${delta} kg, beyond the ${source.toleranceKg} kg ` +
            "instrument band. This is a discrepancy event, not a rounding error — it may mean a wrong item, a " +
            "missing item, or tampering (§15.6)",
        });
      }
    }
  }

  // (ii) Compartment sensing.
  const sensors = new Map((source.compartmentSensors || []).map((row) => [row.compartmentId, row.occupied === true]));
  for (const expected of source.expectedOccupancy || []) {
    if (!sensors.has(expected.compartmentId)) continue;
    const observed = sensors.get(expected.compartmentId);
    if (observed === expected.expectedOccupied) continue;
    discrepancies.push({
      kind: observed ? DISCREPANCY.COMPARTMENT_UNEXPECTEDLY_OCCUPIED : DISCREPANCY.COMPARTMENT_UNEXPECTEDLY_EMPTY,
      compartmentId: expected.compartmentId,
      reason: `compartment ${String(expected.compartmentId)} reads ${observed ? "occupied" : "empty"} where the manifest expects ${expected.expectedOccupied ? "occupied" : "empty"}`,
    });
  }

  // (iii) Scans.
  if (Array.isArray(source.scannedItemIds) && Array.isArray(source.expectedItemIds)) {
    const scanned = new Set(source.scannedItemIds);
    for (const itemId of source.expectedItemIds) {
      if (!scanned.has(itemId)) {
        discrepancies.push({ kind: DISCREPANCY.ITEM_NOT_SCANNED, itemId, reason: `manifest item "${String(itemId)}" was not scanned` });
      }
    }
    const expected = new Set(source.expectedItemIds);
    for (const itemId of source.scannedItemIds) {
      if (!expected.has(itemId)) {
        discrepancies.push({ kind: DISCREPANCY.UNDECLARED_ITEM, itemId, reason: `item "${String(itemId)}" was scanned but is not on the manifest` });
      }
    }
  }

  return {
    ok: discrepancies.length === 0,
    discrepancies: Object.freeze(discrepancies),
    measured: Object.freeze({
      expectedMassDeltaKg: isNumber(source.expectedMassDeltaKg) ? source.expectedMassDeltaKg : null,
      observedMassDeltaKg: isNumber(source.observedMassDeltaKg) ? source.observedMassDeltaKg : null,
      toleranceKg: isNumber(source.toleranceKg) ? source.toleranceKg : null,
    }),
  };
}

/**
 * Invariant I7's payload-side precondition.
 *
 * > An agent MUST NOT be returned to the available pool while any compartment is
 * > non-empty against an open manifest.
 *
 * Two conditions, and an unknown fails both: a compartment whose sensor did not report
 * is not an empty compartment. Returning an agent to the pool on the strength of a
 * missing reading is precisely the lost-goods incident the invariant exists to prevent.
 *
 * @param {object} input
 * @param {object[]} input.manifests every manifest attached to the leg
 * @param {Array<{compartmentId: string, occupied: boolean|null}>} input.compartmentSensors
 * @returns {{ releasable: boolean, problems: string[] }}
 */
function assertReleasable(input) {
  const source = input || {};
  const problems = [];

  const open = (source.manifests || []).filter((manifest) => manifest && manifest.state === "OPEN");
  if (open.length === 0) return { releasable: true, problems: [] };

  for (const sensor of source.compartmentSensors || []) {
    if (sensor.occupied === true) {
      problems.push(
        `compartment ${String(sensor.compartmentId)} is non-empty against ${open.length} open manifest(s). ` +
          "An agent may not be returned to the available pool in this state (§15.6, invariant I7)",
      );
    } else if (sensor.occupied !== false) {
      problems.push(
        `compartment ${String(sensor.compartmentId)} did not report its occupancy. An unreported compartment ` +
          "is not an empty one, and unknown is never permission (§15.6, T2, invariant I7)",
      );
    }
  }

  if ((source.compartmentSensors || []).length === 0) {
    problems.push(
      `${open.length} manifest(s) are OPEN and no compartment reported its occupancy, so emptiness cannot be ` +
        "established (§15.6, invariant I7)",
    );
  }

  return { releasable: problems.length === 0, problems };
}

/**
 * The custody-event record a caller persists, carrying its evidence and any
 * discrepancies so the two are never separated.
 *
 * @param {object} input
 * @returns {object}
 */
function custodyEvent(input) {
  const source = input || {};
  const sufficiency = sufficientForTransition(source);
  const reconciliation = reconcile(source);
  return Object.freeze({
    kind: "custody_event",
    legId: source.legId ?? null,
    manifestId: source.manifest ? source.manifest.manifestId ?? null : null,
    transition: source.transition ?? null,
    evidenceKinds: Object.freeze(sufficiency.kinds),
    establishedLevel: sufficiency.established,
    requiredLevel: sufficiency.required,
    evidenceSufficient: sufficiency.ok,
    discrepancies: reconciliation.discrepancies,
    measured: reconciliation.measured,
    observedAt: source.observedAt ?? null,
  });
}

module.exports = {
  EVIDENCE_KIND,
  EVIDENCE_LEVEL,
  DISCREPANCY,
  LEVEL: verification.LEVEL,
  requiredLevelFor: verification.requiredLevelFor,
  establishedLevel,
  sufficientForTransition,
  reconcile,
  assertReleasable,
  custodyEvent,
};

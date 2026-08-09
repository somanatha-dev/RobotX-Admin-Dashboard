"use strict";

/**
 * The agent-side container model (§15.2) — **Tier 0**.
 *
 * > A capacity scalar is insufficient: a 20 kg limit tells you nothing about whether two
 * > 40 cm boxes fit through a 30 cm hatch.
 *
 * ── The aperture is the point of this module ───────────────────────────────
 * > The **aperture** dimension is modelled separately from the internal dimension
 * > because it is a distinct and frequently binding constraint that a volume-based model
 * > misses entirely.
 *
 * `fitsAperture()` and `fitsInternal()` are therefore two functions, not one. A
 * compartment can be large inside and small at the mouth, and the failure mode of
 * conflating them is a loading plan that cannot physically be executed — discovered by
 * a human at the pickup, after the commitment was made.
 *
 * ── Six elements, all of them constraints ──────────────────────────────────
 * §15.2's table is compartments, aggregate limits, the CoG envelope, access
 * constraints, the loading interface, and the cleanliness/contamination class. The last
 * is easy to dismiss and is not decorative: "food after chemicals requires a cleaning
 * cycle — a genuine constraint in mixed-use fleets", and it binds a *sequence* of
 * missions rather than one, which is why it is modelled on the compartment rather than
 * derived per plan.
 *
 * Tier 0 (T0-04). Decision path (T6): no clock, no randomness, no store.
 */

/**
 * The six elements of §15.2's table.
 * @structural the specification's own container model elements
 */
const ELEMENTS = Object.freeze([
  "compartments",
  "aggregateLimits",
  "cogEnvelope",
  "accessConstraints",
  "loadingInterface",
  "cleanlinessClass",
]);

/**
 * The three axis-aligned orientations of a rectangular item. Rotations about the
 * vertical are covered because the pair test below is order-insensitive.
 * @structural the axis permutations of a rectangular solid
 */
const ORIENTATIONS = Object.freeze([
  Object.freeze(["lengthMm", "widthMm", "heightMm"]),
  Object.freeze(["widthMm", "heightMm", "lengthMm"]),
  Object.freeze(["heightMm", "lengthMm", "widthMm"]),
]);

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Normalise a `ContainerModel` row and its compartments.
 *
 * Compartments keep their `ordinal`, because §15.2's "ordered list" is what access
 * ordering (§15.4) is defined against: "if item A must be removed before item B is
 * reachable, then B's drop cannot precede A's".
 *
 * @param {object} raw
 * @returns {{ ok: boolean, container: object|null, problems: string[] }}
 */
function normalise(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, container: null, problems: ["no container model supplied"] };

  const problems = [];
  const compartments = (Array.isArray(raw.compartments) ? raw.compartments : [])
    .map((compartment) =>
      Object.freeze({
        compartmentId: compartment.compartmentId ?? compartment.id ?? null,
        ordinal: Number.isInteger(compartment.ordinal) ? compartment.ordinal : null,
        internalLengthMm: isNumber(compartment.internalLengthMm) ? compartment.internalLengthMm : null,
        internalWidthMm: isNumber(compartment.internalWidthMm) ? compartment.internalWidthMm : null,
        internalHeightMm: isNumber(compartment.internalHeightMm) ? compartment.internalHeightMm : null,
        apertureWidthMm: isNumber(compartment.apertureWidthMm) ? compartment.apertureWidthMm : null,
        apertureHeightMm: isNumber(compartment.apertureHeightMm) ? compartment.apertureHeightMm : null,
        maxMassKg: isNumber(compartment.maxMassKg) ? compartment.maxMassKg : null,
        thermalClass: compartment.thermalClass ?? null,
        thermalMinC: isNumber(compartment.thermalMinC) ? compartment.thermalMinC : null,
        thermalMaxC: isNumber(compartment.thermalMaxC) ? compartment.thermalMaxC : null,
        thermalHoldSeconds: isNumber(compartment.thermalHoldSeconds) ? compartment.thermalHoldSeconds : null,
        activeThermal: compartment.activeThermal === true,
        lockClass: compartment.lockClass ?? null,
        tamperSensing: compartment.tamperSensing === true,
        accessSide: compartment.accessSide ?? null,
        cleanlinessClass: compartment.cleanlinessClass ?? null,
        // Which compartments must be opened, or emptied, to reach this one (§15.2).
        blockedBy: Object.freeze(Array.isArray(compartment.blockedBy) ? [...compartment.blockedBy] : []),
      }),
    )
    .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));

  if (compartments.length === 0) problems.push("the container model declares no compartments (§15.2)");

  return {
    ok: problems.length === 0,
    container: Object.freeze({
      modelId: raw.modelId ?? null,
      compartments: Object.freeze(compartments),
      aggregateLimits: Object.freeze({
        totalMassLimitKg: isNumber(raw.totalMassLimitKg) ? raw.totalMassLimitKg : null,
        totalVolumeLitres: isNumber(raw.totalVolumeLitres) ? raw.totalVolumeLitres : null,
        axleMassDistribution: raw.axleMassDistribution ?? null,
      }),
      cogEnvelope: raw.cogEnvelope ?? null,
      accessConstraints: raw.accessConstraints ?? null,
      loadingInterface: raw.loadingInterface ?? null,
      cleanlinessClass: raw.cleanlinessClass ?? null,
    }),
    problems,
  };
}

/**
 * Does the item pass through the compartment's **aperture** in some orientation?
 *
 * The test is on the two smallest dimensions against the aperture's two, in both
 * pairings — an item may be turned on its side to go through a hatch.
 *
 * An unstated aperture is **not** an unlimited one. A compartment whose mouth nobody
 * measured is a compartment through which nothing can be shown to pass, and the answer
 * is `null` (unknown) rather than `true`.
 *
 * @param {object} item
 * @param {object} compartment
 * @returns {{ fits: boolean|null, reason: string|null }}
 */
function fitsAperture(item, compartment) {
  if (!item || !compartment) return { fits: null, reason: "item or compartment missing" };
  if (!isNumber(compartment.apertureWidthMm) || !isNumber(compartment.apertureHeightMm)) {
    return {
      fits: null,
      reason:
        `compartment ${String(compartment.compartmentId)} states no aperture dimensions. §15.2 models the ` +
        "aperture separately because it is a distinct and frequently binding constraint; an unmeasured " +
        "aperture is unknown, never unlimited",
    };
  }

  const dimensions = [item.lengthMm, item.widthMm, item.heightMm];
  if (dimensions.some((value) => !isNumber(value))) return { fits: null, reason: "the item states no dimensions" };

  const sorted = [...dimensions].sort((a, b) => a - b);
  const [smallest, middle] = sorted;
  const width = compartment.apertureWidthMm;
  const height = compartment.apertureHeightMm;

  const passes = (smallest <= width && middle <= height) || (smallest <= height && middle <= width);
  return {
    fits: passes,
    reason: passes
      ? null
      : `the item's smallest cross-section ${smallest}×${middle} mm does not pass the ${width}×${height} mm aperture of compartment ${String(compartment.compartmentId)}`,
  };
}

/**
 * Does the item fit *inside* the compartment in some axis-aligned orientation,
 * respecting any stated orientation constraint?
 *
 * > Orientation constraints: "This way up", fragile stacking limits.
 *
 * An item declaring `thisWayUp` may only be placed in its declared orientation, so only
 * the identity permutation is tried.
 *
 * @param {object} item
 * @param {object} compartment
 * @returns {{ fits: boolean|null, orientation: readonly string[]|null, reason: string|null }}
 */
function fitsInternal(item, compartment) {
  if (!item || !compartment) return { fits: null, orientation: null, reason: "item or compartment missing" };
  const bounds = [compartment.internalLengthMm, compartment.internalWidthMm, compartment.internalHeightMm];
  if (bounds.some((value) => !isNumber(value))) {
    return { fits: null, orientation: null, reason: `compartment ${String(compartment.compartmentId)} states no internal dimensions` };
  }
  if (![item.lengthMm, item.widthMm, item.heightMm].every(isNumber)) {
    return { fits: null, orientation: null, reason: "the item states no dimensions" };
  }

  const thisWayUp = Boolean(item.orientationConstraints && item.orientationConstraints.thisWayUp);
  const candidates = thisWayUp ? [ORIENTATIONS[0]] : ORIENTATIONS;

  const [boundLength, boundWidth, boundHeight] = bounds;
  for (const orientation of candidates) {
    const [a, b, c] = orientation.map((axis) => item[axis]);
    if (a <= boundLength && b <= boundWidth && c <= boundHeight) {
      return { fits: true, orientation, reason: null };
    }
  }

  return {
    fits: false,
    orientation: null,
    reason: thisWayUp
      ? `the item must remain upright and does not fit compartment ${String(compartment.compartmentId)} in that orientation`
      : `the item does not fit compartment ${String(compartment.compartmentId)} in any axis-aligned orientation`,
  };
}

/**
 * Can this compartment hold the item's thermal range?
 *
 * F25 is the predicate that gates this; the check lives here because the compartment
 * model is where the thermal class is declared, and F25 consumes the *assignment* this
 * module's caller produces.
 *
 * @param {object} item
 * @param {object} compartment
 * @returns {{ ok: boolean|null, reason: string|null }}
 */
function coversThermalRange(item, compartment) {
  if (!item || !compartment) return { ok: null, reason: "item or compartment missing" };
  const needsMin = isNumber(item.thermalMinC) ? item.thermalMinC : null;
  const needsMax = isNumber(item.thermalMaxC) ? item.thermalMaxC : null;
  if (needsMin === null && needsMax === null) return { ok: true, reason: null };

  if (!isNumber(compartment.thermalMinC) || !isNumber(compartment.thermalMaxC)) {
    return { ok: null, reason: `compartment ${String(compartment.compartmentId)} states no thermal class bounds` };
  }
  const covers =
    (needsMin === null || compartment.thermalMinC <= needsMin) && (needsMax === null || compartment.thermalMaxC >= needsMax);
  return {
    ok: covers,
    reason: covers
      ? null
      : `compartment ${String(compartment.compartmentId)} holds ${compartment.thermalMinC}..${compartment.thermalMaxC} °C, which does not cover ${String(needsMin)}..${String(needsMax)} °C`,
  };
}

/**
 * Does this compartment satisfy the item's security class?
 *
 * > Security class: Requires a lockable compartment, tamper evidence, or chain of
 * > custody.
 *
 * A named class must be *matched*, not merely present: F26 refuses a compartment
 * carrying some other lock class, because "naming a specific class and accepting any
 * would make the requirement decorative".
 *
 * @param {object} item
 * @param {object} compartment
 * @returns {{ ok: boolean, reason: string|null }}
 */
function satisfiesSecurityClass(item, compartment) {
  if (!item || !compartment) return { ok: false, reason: "item or compartment missing" };
  if (!item.securityClass) return { ok: true, reason: null };
  if (!compartment.lockClass) {
    return { ok: false, reason: `compartment ${String(compartment.compartmentId)} has no lock class` };
  }
  if (compartment.lockClass !== item.securityClass) {
    return {
      ok: false,
      reason: `item requires lock class "${String(item.securityClass)}"; compartment carries "${String(compartment.lockClass)}"`,
    };
  }
  return { ok: true, reason: null };
}

/**
 * Are two items lawful in the same compartment?
 *
 * > Hazard class and segregation rules: Regulatory; incompatible goods must not share a
 * > compartment.
 *
 * Symmetric by construction: either item declaring the other's class incompatible is
 * enough. A regulatory segregation rule stated on one side of a pair is still the rule.
 *
 * @param {object} a
 * @param {object} b
 * @returns {{ ok: boolean, reason: string|null }}
 */
function segregationCompatible(a, b) {
  if (!a || !b) return { ok: false, reason: "item missing" };
  const forbids = (one, other) =>
    (one.segregation && Array.isArray(one.segregation.incompatibleHazardClasses) ? one.segregation.incompatibleHazardClasses : []).some(
      (hazard) => (Array.isArray(other.hazardClasses) ? other.hazardClasses : []).includes(hazard),
    );

  if (forbids(a, b) || forbids(b, a)) {
    return {
      ok: false,
      reason: `items "${String(a.itemId)}" and "${String(b.itemId)}" declare incompatible hazard classes and must not share a compartment (§15.2)`,
    };
  }
  return { ok: true, reason: null };
}

/**
 * The contamination constraint §15.2 names.
 *
 * > Cleanliness/contamination class: Food after chemicals requires a cleaning cycle — a
 * > genuine constraint in mixed-use fleets.
 *
 * Reported as a required cleaning cycle rather than as an outright refusal, because
 * that is what it is: the compartment becomes usable again after the cycle, and a plan
 * that schedules one is feasible. Whether the plan can afford the cycle is a cost
 * question, not a feasibility one.
 *
 * @param {object} item
 * @param {object} compartment
 * @returns {{ ok: boolean, cleaningRequired: boolean, reason: string|null }}
 */
function cleanlinessCompatible(item, compartment) {
  if (!item || !compartment) return { ok: false, cleaningRequired: false, reason: "item or compartment missing" };
  const required = item.cleanlinessClass ?? null;
  const current = compartment.cleanlinessClass ?? null;
  if (required === null) return { ok: true, cleaningRequired: false, reason: null };
  if (current === null) {
    return { ok: false, cleaningRequired: false, reason: `compartment ${String(compartment.compartmentId)} states no cleanliness class` };
  }
  if (current === required) return { ok: true, cleaningRequired: false, reason: null };
  return {
    ok: true,
    cleaningRequired: true,
    reason: `compartment ${String(compartment.compartmentId)} is at cleanliness class "${current}" and requires a cleaning cycle before class "${required}"`,
  };
}

/**
 * Every compartment in which the item is admissible, in the container's own order.
 *
 * The order matters: §15.3 tier 2's greedy pass walks compartments in order, and a
 * deterministic order is what makes its output reproducible on replay (§9.6).
 *
 * @param {object} item
 * @param {object} container
 * @returns {{ compartments: object[], rejections: object[] }}
 */
function admissibleCompartments(item, container) {
  const compartments = [];
  const rejections = [];

  for (const compartment of (container && container.compartments) || []) {
    const checks = [
      ["aperture", fitsAperture(item, compartment)],
      ["internal", fitsInternal(item, compartment)],
      ["thermal", coversThermalRange(item, compartment)],
      ["security", satisfiesSecurityClass(item, compartment)],
      ["cleanliness", cleanlinessCompatible(item, compartment)],
    ];

    const failure = checks.find(([, result]) => result.fits === false || result.ok === false);
    const unknown = checks.find(([, result]) => result.fits === null || result.ok === null);

    if (failure) {
      rejections.push({ compartmentId: compartment.compartmentId, check: failure[0], outcome: "VIOLATED", reason: failure[1].reason });
      continue;
    }
    if (unknown) {
      // Unknown is never permission (T2): an undeterminable fit is reported as such and
      // the packing tier that consumes it resolves to INDETERMINATE, which denies.
      rejections.push({ compartmentId: compartment.compartmentId, check: unknown[0], outcome: "INDETERMINATE", reason: unknown[1].reason });
      continue;
    }
    compartments.push(compartment);
  }

  return { compartments, rejections };
}

module.exports = {
  ELEMENTS,
  ORIENTATIONS,
  normalise,
  fitsAperture,
  fitsInternal,
  coversThermalRange,
  satisfiesSecurityClass,
  segregationCompatible,
  cleanlinessCompatible,
  admissibleCompartments,
};

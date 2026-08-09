"use strict";

/**
 * Task-side payload specification (§15.1) — **Tier 0**.
 *
 * > The baseline has no payload concept whatsoever — the audit verifies by exhaustive
 * > search that no mass, volume, or capacity field exists in schema or code. The model
 * > must therefore be built from first principles.
 *
 * The twelve attributes of §15.1's table are the whole model, and every one of them is
 * consumed by something: F22 reads mass, F23 dimensions and shape, F24 mass
 * distribution, F25 the thermal requirement, F26 hazard and security classes, §12.5's
 * verification level reads value, and §8.4's `C_failure` reads it too.
 *
 * ── The one rule that is easy to get wrong ─────────────────────────────────
 * > Mass is specified with a **tolerance**, because declared masses are frequently
 * > wrong. Feasibility uses the upper bound of the tolerance; energy estimation uses the
 * > expectation.
 *
 * Two functions, `massForFeasibilityKg()` and `massForEnergyKg()`, and no third. They
 * are separate functions rather than one with a flag because the flag is exactly the
 * thing that gets passed wrong: using the expectation for feasibility admits an
 * over-mass load, and using the upper bound for energy over-predicts every mission and
 * quietly shrinks the fleet's usable range. `assertNotSubstituted()` is available for a
 * caller that wants the substitution refused rather than merely documented.
 *
 * > Realised mass, where the agent can measure it, is fed back to correct the
 * > declaration source — a systematically under-declaring merchant is an operational
 * > problem worth surfacing.
 *
 * `declarationFeedback()` produces that tuple. It corrects nothing itself: the
 * declaration source is outside the engine (§1.6), and an engine that silently rewrote
 * a merchant's declared masses would be making a commercial decision.
 *
 * Tier 0 (T0-04). Decision path (T6): no clock, no randomness, no store.
 */

/**
 * §15.1's attribute table, as data. Present so a reviewer can check the model against
 * the specification's own list rather than against the fields this module happens to
 * read, and so `missingAttributes()` can report by purpose rather than by field name.
 * @structural the specification's own payload attribute table
 */
const ATTRIBUTES = Object.freeze([
  Object.freeze({ field: "massKg", purpose: "Capacity, energy, braking, stability", required: true }),
  Object.freeze({ field: "massToleranceKg", purpose: "Feasibility uses the upper bound; energy uses the expectation", required: true }),
  Object.freeze({ field: "dimensionsMm", purpose: "Packing feasibility, compartment fit", required: true }),
  Object.freeze({ field: "volumeLitres", purpose: "Fast necessary-condition check", required: true }),
  Object.freeze({ field: "orientationConstraints", purpose: "This way up, fragile stacking limits", required: false }),
  Object.freeze({ field: "stackable", purpose: "Whether other items may rest on it", required: false }),
  Object.freeze({ field: "loadBearingLimitKg", purpose: "How much may rest on it", required: false }),
  Object.freeze({ field: "fragilityClass", purpose: "Route smoothness preference, speed and acceleration limits", required: false }),
  Object.freeze({ field: "thermal", purpose: "Cold chain and hot-food integrity", required: false }),
  Object.freeze({ field: "securityClass", purpose: "Lockable compartment, tamper evidence, chain of custody", required: false }),
  Object.freeze({ field: "hazardClasses", purpose: "Regulatory; incompatible goods must not share a compartment", required: false }),
  Object.freeze({ field: "declaredValue", purpose: "Sets verification level (§12.5) and C_failure (§8.4)", required: false }),
  Object.freeze({ field: "regulatoryClass", purpose: "Age-restricted, prescription, controlled — attestation requirements", required: false }),
  Object.freeze({ field: "itemCount", purpose: "Whether the consignment may be split across compartments or missions", required: false }),
]);

/**
 * The two lawful readings of a declared mass.
 * @structural the specification's own mass-reading split
 */
const MASS_READING = Object.freeze({
  FEASIBILITY: "FEASIBILITY",
  ENERGY: "ENERGY",
});

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Normalise one item out of a manifest row or a single-item consignment.
 *
 * @param {object} raw
 * @returns {object|null}
 */
function normaliseItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  return Object.freeze({
    itemId: raw.itemId ?? null,
    massKg: isNumber(raw.massKg) ? raw.massKg : null,
    massToleranceKg: isNumber(raw.massToleranceKg) ? raw.massToleranceKg : null,
    lengthMm: isNumber(raw.lengthMm) ? raw.lengthMm : null,
    widthMm: isNumber(raw.widthMm) ? raw.widthMm : null,
    heightMm: isNumber(raw.heightMm) ? raw.heightMm : null,
    shapeClass: raw.shapeClass ?? null,
    volumeLitres: isNumber(raw.volumeLitres) ? raw.volumeLitres : null,
    orientationConstraints: raw.orientationConstraints ?? null,
    // §15.1 defaults an unstated stackability to *not* stackable rather than to
    // stackable: "whether other items may rest on it" is a property of the goods, and
    // assuming an unstated one bears load is how a crushed parcel becomes a packing
    // plan's fault rather than a declaration's.
    stackable: raw.stackable === true,
    loadBearingLimitKg: isNumber(raw.loadBearingLimitKg) ? raw.loadBearingLimitKg : null,
    fragilityClass: raw.fragilityClass ?? null,
    thermalMinC: isNumber(raw.thermalMinC) ? raw.thermalMinC : null,
    thermalMaxC: isNumber(raw.thermalMaxC) ? raw.thermalMaxC : null,
    thermalMaxExcursionSeconds: isNumber(raw.thermalMaxExcursionSeconds) ? raw.thermalMaxExcursionSeconds : null,
    securityClass: raw.securityClass ?? null,
    hazardClasses: Object.freeze(Array.isArray(raw.hazardClasses) ? [...raw.hazardClasses] : []),
    segregation: Object.freeze({
      incompatibleHazardClasses: Object.freeze(
        raw.segregation && Array.isArray(raw.segregation.incompatibleHazardClasses)
          ? [...raw.segregation.incompatibleHazardClasses]
          : [],
      ),
    }),
    declaredValue: isNumber(raw.declaredValue) ? raw.declaredValue : null,
    regulatoryClass: raw.regulatoryClass ?? null,
  });
}

/**
 * Normalise a task-side payload specification into a consignment of items.
 *
 * A spec that states an `itemCount` but no per-item rows is expanded into that many
 * identical items. A spec that carries explicit rows uses them. The two are kept
 * distinguishable on the result (`itemsAreDerived`) because a derived expansion is an
 * assumption of uniformity, and a packing verdict computed on assumed-uniform items is
 * weaker evidence than one computed on declared rows.
 *
 * @param {object} raw a `PayloadSpec` row or its API-shaped equivalent
 * @returns {{ ok: boolean, consignment: object|null, problems: string[] }}
 */
function normalise(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, consignment: null, problems: ["no payload specification supplied"] };

  const problems = [];
  let items;
  let derived = false;

  if (Array.isArray(raw.items) && raw.items.length > 0) {
    items = raw.items.map(normaliseItem).filter((item) => item !== null);
    if (items.length !== raw.items.length) problems.push("one or more manifest item rows are unreadable");
  } else {
    const count = Number.isInteger(raw.itemCount) && raw.itemCount > 0 ? raw.itemCount : 1;
    derived = true;
    const single = normaliseItem({
      ...raw,
      itemId: raw.specId ? `${raw.specId}#1` : null,
      // An item-level mass split evenly across a stated count. Where the declaration
      // gives only a consignment mass this is the only reading available, and it is
      // reported as derived so a packing verdict does not overstate its own evidence.
      massKg: isNumber(raw.massKg) ? raw.massKg / count : null,
      massToleranceKg: isNumber(raw.massToleranceKg) ? raw.massToleranceKg / count : null,
      volumeLitres: isNumber(raw.volumeLitres) ? raw.volumeLitres / count : null,
    });
    items = Array.from({ length: count }, (unused, index) =>
      Object.freeze({ ...single, itemId: raw.specId ? `${raw.specId}#${index + 1}` : `item#${index + 1}` }),
    );
  }

  if (items.length === 0) problems.push("the consignment contains no items");

  return {
    ok: problems.length === 0,
    consignment: Object.freeze({
      specId: raw.specId ?? null,
      items: Object.freeze(items),
      itemsAreDerived: derived,
      divisible: raw.divisible === true,
      declaredValue: isNumber(raw.declaredValue) ? raw.declaredValue : null,
      regulatoryClass: raw.regulatoryClass ?? null,
    }),
    problems,
  };
}

/**
 * The mass feasibility must use: the **upper bound** of the declared tolerance.
 *
 * An item with no stated tolerance returns `null`, not its nominal mass. §15.1 makes
 * the tolerance part of the declaration precisely because declared masses are
 * frequently wrong, and treating an absent tolerance as zero asserts a precision the
 * declaration never claimed.
 *
 * @param {object} item
 * @returns {number|null}
 */
function itemMassForFeasibilityKg(item) {
  if (!item || !isNumber(item.massKg) || !isNumber(item.massToleranceKg)) return null;
  return item.massKg + Math.abs(item.massToleranceKg);
}

/**
 * The mass energy estimation must use: the **expectation**.
 *
 * @param {object} item
 * @returns {number|null}
 */
function itemMassForEnergyKg(item) {
  if (!item || !isNumber(item.massKg)) return null;
  return item.massKg;
}

/**
 * The consignment's total mass under one of the two readings.
 *
 * @param {object} consignment
 * @param {string} reading one of `MASS_READING`
 * @returns {{ ok: boolean, massKg: number|null, reading: string, missing: string[] }}
 */
function totalMassKg(consignment, reading) {
  if (!consignment || !Array.isArray(consignment.items)) {
    return { ok: false, massKg: null, reading, missing: ["consignment"] };
  }
  const read = reading === MASS_READING.ENERGY ? itemMassForEnergyKg : itemMassForFeasibilityKg;
  const missing = [];
  let total = 0;

  for (const item of consignment.items) {
    const mass = read(item);
    if (mass === null) {
      missing.push(`${item && item.itemId ? item.itemId : "item"}.mass`);
      continue;
    }
    total += mass;
  }

  if (missing.length > 0) return { ok: false, massKg: null, reading, missing };
  return { ok: true, massKg: total, reading, missing: [] };
}

/**
 * Refuse the substitution §15.1 forbids.
 *
 * Offered as an explicit assertion rather than only as a comment, so a caller that has
 * a reason to be strict — the feasibility path, which may not see an expectation — can
 * be strict structurally.
 *
 * @param {string} required one of `MASS_READING`
 * @param {string} supplied one of `MASS_READING`
 * @returns {{ ok: boolean, reason: string|null }}
 */
function assertNotSubstituted(required, supplied) {
  if (required === supplied) return { ok: true, reason: null };
  return {
    ok: false,
    reason:
      `a ${String(supplied)} mass reading was supplied where a ${String(required)} reading is required. ` +
      "§15.1 assigns the upper bound of the tolerance to feasibility and the expectation to energy " +
      "estimation; substituting one for the other either admits an over-mass load or shrinks the fleet's " +
      "modelled range",
  };
}

/**
 * The smallest cross-section of an item — the §15.3 tier-1 aperture test's input.
 *
 * The smallest of the three face areas' *pairs*: an item passes an aperture if some
 * pair of its dimensions fits, so the binding pair is the two smallest.
 *
 * @param {object} item
 * @returns {{ ok: boolean, aMm: number|null, bMm: number|null }}
 */
function smallestCrossSectionMm(item) {
  if (!item || !isNumber(item.lengthMm) || !isNumber(item.widthMm) || !isNumber(item.heightMm)) {
    return { ok: false, aMm: null, bMm: null };
  }
  const sorted = [item.lengthMm, item.widthMm, item.heightMm].sort((a, b) => a - b);
  return { ok: true, aMm: sorted[0], bMm: sorted[1] };
}

/**
 * The declaration-accuracy tuple §15.1 asks to be fed back.
 *
 * @param {object} input
 * @returns {object}
 */
function declarationFeedback(input) {
  const source = input || {};
  const declared = isNumber(source.declaredMassKg) ? source.declaredMassKg : null;
  const realised = isNumber(source.realisedMassKg) ? source.realisedMassKg : null;
  return Object.freeze({
    kind: "payload_mass_declaration",
    specId: source.specId ?? null,
    declarationSource: source.declarationSource ?? null,
    declaredMassKg: declared,
    realisedMassKg: realised,
    deltaKg: declared !== null && realised !== null ? realised - declared : null,
    underDeclared: declared !== null && realised !== null ? realised > declared : null,
    observedAt: source.observedAt ?? null,
  });
}

module.exports = {
  ATTRIBUTES,
  MASS_READING,
  normaliseItem,
  normalise,
  itemMassForFeasibilityKg,
  itemMassForEnergyKg,
  totalMassKg,
  assertNotSubstituted,
  smallestCrossSectionMm,
  declarationFeedback,
};

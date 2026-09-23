"use strict";

/**
 * The **V1_DEMONSTRATION mission profile** — the mission-side facts §7.5 reads that no
 * Task column carries, declared once for the V1 demonstration deployment.
 *
 * ── Why a profile and not a column ─────────────────────────────────────────
 * F5 (mission type), F11 (mission class), F15 (supervision requirement), F9/F10 (the
 * mission's required health tier and localisation confidence), F37 (whether a deadline is
 * contractually hard) and F32 (a stop's access prerequisites) all read mission attributes
 * that `Task`, `Leg` and `Stop` either do not carry or that the dashboard never sends. Each
 * is class DENY when absent, so every V1 task was infeasible for every robot.
 *
 * These are **statements about the demonstration's work**, not about any robot, so they
 * apply identically to a simulated robot and to the physical RobotX. Each is a requirement
 * the predicates still enforce: a MARGINAL robot fails `requiredHealthTier: NOMINAL`, a
 * robot below 0.9 localisation confidence fails F10, and so on.
 *
 * ── Precedence ─────────────────────────────────────────────────────────────
 * A value stated on the Task/Stop row always wins; the profile fills only what nobody
 * stated. That keeps F4's isolation meaningful: a Task naming another tenant is still
 * refused.
 *
 * ── What replaces it ───────────────────────────────────────────────────────
 * A production deployment states these per Task (mission type and supervision at
 * submission, hardness in the contract, access prerequisites per site) and per SLA class
 * in the register (`health.required_tier`, `localisation.min_confidence`, both Safety
 * rows). When those exist the profile is simply not composed.
 *
 * Enabled only by `V1_DEMONSTRATION_COMPOSITION=true` (see
 * `v1DemonstrationComposition.js`).
 */

/** The provenance label on every value this profile supplies. @structural */
const PROVENANCE = "V1_DEMONSTRATION";

/**
 * The single tenant of a V1 demonstration deployment. A value, not a default: F4 compares
 * a Task's tenant with an agent's, and in a single-tenant deployment both are this one.
 * @structural V1 declaration
 */
const DEMONSTRATION_TENANT_ID = "robotx-v1-demonstration";

const MISSION_PROFILE = Object.freeze({
  // F5 / F11 — every V1 task is a campus delivery.
  missionType: "DELIVERY",
  missionClass: "DELIVERY",
  // F15 — the RobotX campus robot drives autonomously; there is no teleoperation link to
  // budget in V1. A dead zone on the route would still require certification (F15 reads
  // `plan.route.deadZoneExtentM` before it reads this).
  supervisionRequirement: "AUTONOMOUS",
  // F9 — NOMINAL, not FULL: a healthy robot passes and a robot reporting ISSUES/PAUSED
  // (MARGINAL) or ERROR/OFFLINE (QUARANTINED) does not.
  requiredHealthTier: "NOMINAL",
  // F10 — the robot must know where it is to 90 %.
  requiredLocalisationConfidence: 0.9,
  environment: "CAMPUS",
  // F37 — V1 demonstration tasks carry SLA targets, not contractual deadlines, so lateness
  // is priced by C_delay (§8.7) rather than gated.
  deadlineIsContractuallyHard: false,
  tenantId: DEMONSTRATION_TENANT_ID,
  // F21 — a V1 task states no capability requirement unless its submission states one
  // (a requested chassis class or a payload mass, which `task.service` turns into a
  // RequirementSet). Payload and container fit are still checked by F22–F24.
  requirements: Object.freeze([]),
  // F25 — V1 tasks carry no temperature-controlled payload unless their submission names a
  // payload specification.
  payload: null,
  provenance: PROVENANCE,
});

/**
 * F32 — the campus's delivery points are open-access kerbside points: no gate, lift, door
 * code or dock. Applied only to a Stop whose `accessConstraints` column nobody populated.
 * @structural V1 declaration
 */
const STOP_ACCESS_PREREQUISITES = Object.freeze([]);

/**
 * **The V1 service envelope** (F22–F24, §15) — a V1_DEMONSTRATION *service definition*, not
 * a measurement: "RobotX V1 carries one parcel per trip, up to this size and mass".
 *
 * Why it exists: §15's packing proof needs item and compartment geometry, and V1 has none
 * anywhere — a task declares mass (and a tolerance) only, commissioning declares a mass
 * limit only, and no document records the physical RobotX's cargo box. Unknown geometry is
 * INDETERMINATE and F23 denied every task.
 *
 * What stays real: **mass**. A task's declared mass (upper bound with tolerance) is placed
 * against the compartment's mass limit, and a task whose parcel exceeds it is rejected; a
 * task that declared nothing is taken at the envelope's maximum mass (the conservative
 * direction). A task that declares real dimensions (`PayloadSpec.lengthMm` ...) keeps them.
 *
 * Replaced by: the physical RobotX's measured compartment (commissioned as a `Compartment`
 * row) and per-task parcel dimensions from the order.
 * @structural V1 declaration
 */
const SERVICE_ENVELOPE = Object.freeze({
  compartment: Object.freeze({
    ordinal: 1,
    internalLengthMm: 400,
    internalWidthMm: 300,
    internalHeightMm: 250,
    apertureWidthMm: 300,
    apertureHeightMm: 250,
    thermalClass: null,
    activeThermal: false,
  }),
  // `maxMassKg` 2.5: an undeclared parcel is taken at this mass, so it must be one every
  // simulation preset can carry *after* F22's safety factor — the LIGHT preset's 3 kg × 0.9
  // = 2.7 kg, rounded down to the half-kilogram. (5 kg was measured to fail F22 on a
  // STANDARD unit: 5 kg > 5 kg × 0.9.) A task declaring more still goes only to a robot
  // rated for it.
  parcel: Object.freeze({ lengthMm: 300, widthMm: 200, heightMm: 150, maxMassKg: 2.5, massToleranceKg: 0 }),
});

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * The consignment for a Leg whose manifests itemise nothing: one parcel, with the Task's
 * declared payload where it stated one and the service envelope where it did not.
 *
 * @param {object|null|undefined} payloadSpec the Task's `PayloadSpec` row, if any
 * @returns {{ items: object[], massKg: number, provenance: string }}
 */
function consignmentFor(payloadSpec) {
  const spec = payloadSpec || {};
  const parcel = SERVICE_ENVELOPE.parcel;
  const declaredMass = isNumber(spec.massKg);
  const lengthMm = isNumber(spec.lengthMm) ? spec.lengthMm : parcel.lengthMm;
  const widthMm = isNumber(spec.widthMm) ? spec.widthMm : parcel.widthMm;
  const heightMm = isNumber(spec.heightMm) ? spec.heightMm : parcel.heightMm;
  const item = {
    itemId: "v1-parcel-1",
    massKg: declaredMass ? spec.massKg : parcel.maxMassKg,
    massToleranceKg: declaredMass && isNumber(spec.massToleranceKg) ? spec.massToleranceKg : parcel.massToleranceKg,
    lengthMm,
    widthMm,
    heightMm,
    // Stated, or derived from the three dimensions — never independent of them.
    volumeLitres: isNumber(spec.volumeLitres) ? spec.volumeLitres : (lengthMm * widthMm * heightMm) / 1e6,
    orientationConstraints: spec.orientationConstraints ?? null,
    stackable: spec.stackable !== false,
    loadBearingLimitKg: isNumber(spec.loadBearingLimitKg) ? spec.loadBearingLimitKg : null,
    fragilityClass: spec.fragilityClass ?? null,
    thermalMinC: isNumber(spec.thermalMinC) ? spec.thermalMinC : null,
    thermalMaxC: isNumber(spec.thermalMaxC) ? spec.thermalMaxC : null,
    thermalMaxExcursionSeconds: isNumber(spec.thermalMaxExcursionSeconds) ? spec.thermalMaxExcursionSeconds : null,
    securityClass: spec.securityClass ?? null,
    hazardClasses: Array.isArray(spec.hazardClasses) ? spec.hazardClasses : [],
    segregation: { incompatibleHazardClasses: [] },
    provenance: declaredMass ? "TASK_DECLARED_MASS" : PROVENANCE,
  };
  return { items: [item], massKg: item.massKg + (item.massToleranceKg || 0), provenance: PROVENANCE };
}

/**
 * F30 — no time-of-day, day-of-week or event restriction is declared for any zone of the
 * demonstration campus.
 *
 * @param {string} zoneId
 * @returns {object[]}
 */
function zoneRestrictionsFor(zoneId) {
  return zoneId ? [] : undefined;
}

/**
 * The §7.5 mission, with the profile filling only what the Task did not state.
 *
 * @param {object} mission the mission `coordinatorSolvePath.missionFor` built
 * @returns {object}
 */
function applyMissionProfile(mission) {
  const source = mission || {};
  const filled = { ...source };
  for (const [key, value] of Object.entries(MISSION_PROFILE)) {
    if (key === "provenance") continue;
    if (filled[key] === undefined || filled[key] === null) filled[key] = Array.isArray(value) ? [...value] : value;
  }
  filled.profileProvenance = PROVENANCE;
  return filled;
}

module.exports = {
  PROVENANCE,
  DEMONSTRATION_TENANT_ID,
  MISSION_PROFILE,
  STOP_ACCESS_PREREQUISITES,
  SERVICE_ENVELOPE,
  consignmentFor,
  zoneRestrictionsFor,
  applyMissionProfile,
};

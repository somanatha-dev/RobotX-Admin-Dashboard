"use strict";

/**
 * Trust boundaries for agent-reported data (§23.5) — **Tier 1**.
 *
 * > Agent reports are **untrusted input** and validated before use.
 *
 * The section's table has six rows and this module has six validators, one per row, in
 * the section's own order. The table is carried as data (`REPORTS`) so a reviewer can
 * check the six against the specification without reading six functions, and so that
 * `assertCoverage()` can fail a future edit that quietly drops one.
 *
 * ── The asymmetry, which is the section's most important sentence ───────────
 * > Health / self-report: accepted for **restricting** the agent (an agent may always
 * > declare itself unfit) but never for **expanding** eligibility.
 *
 * > The asymmetry in the health row is deliberate and important: self-reported
 * > degradation is trusted because a false positive costs one agent-shift, while
 * > self-reported fitness is not trusted because a false positive risks an incident.
 * > **This asymmetric trust rule applies to every agent-reported field and should be the
 * > default reasoning pattern.**
 *
 * That last clause is why `direction()` is a general helper rather than a branch inside
 * the health validator: the rule is stated as a general one, and expressing it once is
 * what lets a later field inherit it instead of re-deriving it.
 *
 * ── Rejected, not smoothed ──────────────────────────────────────────────────
 * > A jump exceeding achievable speed is rejected, not smoothed.
 *
 * A filter that smoothed the jump would produce a position that is *plausible and
 * wrong*, and the whole downstream stack — feasibility, cost, verification — would
 * consume it as though it had been measured. Rejection keeps the last accepted fix,
 * which is stale and known to be stale, and staleness is a condition §2.7 and §7.3
 * already handle correctly.
 *
 * ── Why this is a security control and not a data-quality one ───────────────
 * > A compromised agent's most valuable capability is to appear healthy and
 * > well-positioned, so plausibility checking is a security control, not merely a
 * > data-quality one.
 *
 * Hence `persistentImplausibility()`: a single rejected fix is noise, and a sustained
 * pattern is evidence. It returns a quarantine recommendation *and* a security event,
 * because those go to different places and both are required.
 */

const capability = require("../domain/capability");
const attestation = require("./attestation");

/** The verdicts a validation can return. */
const VERDICT = Object.freeze({
  ACCEPTED: "ACCEPTED",
  /** The value is refused. The last accepted value stands and ages normally. */
  REJECTED: "REJECTED",
  /** Accepted, but only in the restricting direction (§23.5's health row). */
  ACCEPTED_RESTRICTING_ONLY: "ACCEPTED_RESTRICTING_ONLY",
  /** Could not be evaluated — no baseline, no corroboration available. §7.3's third value. */
  INDETERMINATE: "INDETERMINATE",
});

/**
 * The direction a reported change moves the agent's eligibility in.
 * @structural the asymmetric-trust vocabulary
 */
const DIRECTION = Object.freeze({
  RESTRICTING: "RESTRICTING",
  EXPANDING: "EXPANDING",
  NEUTRAL: "NEUTRAL",
});

/**
 * §23.5's table, as data. `row` is the specification's own Report column.
 * @structural the specification's own table
 */
const REPORTS = Object.freeze([
  Object.freeze({
    row: "POSITION",
    validation: "Kinematic plausibility against the last accepted fix; map-network consistency; corroboration where an independent signal exists. A jump exceeding achievable speed is rejected, not smoothed",
    validator: "validatePosition",
  }),
  Object.freeze({
    row: "ENERGY",
    validation: "Monotonicity except while charging; rate-of-change bounds; consistency with distance travelled and the energy model",
    validator: "validateEnergy",
  }),
  Object.freeze({
    row: "COMPLETION",
    validation: "Graded verification (§12.5); track plausibility; evidence corroboration",
    validator: "validateCompletion",
  }),
  Object.freeze({
    row: "HEALTH",
    validation: "Accepted for restricting the agent (an agent may always declare itself unfit) but never for expanding eligibility",
    validator: "validateHealth",
  }),
  Object.freeze({
    row: "CAPABILITY",
    validation: "Rejected entirely; see §23.2",
    validator: "validateCapability",
  }),
  Object.freeze({
    row: "CUSTODY",
    validation: "Corroborated with compartment sensing and mass delta where available",
    validator: "validateCustody",
  }),
]);

/**
 * The asymmetric trust rule, stated once (§23.5).
 *
 * @param {string} direction one of `DIRECTION`
 * @returns {{ trusted: boolean, why: string }}
 */
function trustsSelfReport(direction) {
  if (direction === DIRECTION.RESTRICTING) {
    return { trusted: true, why: "self-reported degradation is trusted because a false positive costs one agent-shift (§23.5)" };
  }
  if (direction === DIRECTION.EXPANDING) {
    return { trusted: false, why: "self-reported fitness is not trusted because a false positive risks an incident (§23.5)" };
  }
  return { trusted: true, why: "the report changes no eligibility" };
}

/**
 * Great-circle distance in metres. Local to this module rather than imported from the
 * spatial layer: this is a *bound* on how far the agent could have moved, and it must
 * hold regardless of which routing or projection the spatial layer is configured with.
 *
 * @param {{ lat: number, lon: number }} a
 * @param {{ lat: number, lon: number }} b
 * @returns {number}
 */
function metresBetween(a, b) {
  /** @structural the mean Earth radius in metres, WGS-84 */
  const EARTH_RADIUS_M = 6371008.8;
  /** @structural degrees to radians */
  const DEG = Math.PI / 180;
  /** @structural the haversine's half-angle factor */
  const HALF = 2;

  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const h =
    Math.sin(dLat / HALF) ** HALF +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / HALF) ** HALF;
  return HALF * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * §23.5 row 1 — position.
 *
 * @param {object} input
 * @param {{ lat: number, lon: number, atMs: number }} [input.last] the last **accepted** fix
 * @param {{ lat: number, lon: number, atMs: number }} input.reported
 * @param {number} input.maxSpeedMps from the agent's MobilityModel (§2.2)
 * @param {number} input.tolerance `security.position_plausibility_tolerance`
 * @param {boolean|null} [input.onMapNetwork] map-network consistency, where the map service answered
 * @param {boolean|null} [input.corroborated] an independent signal agreed, where one exists
 * @returns {{ verdict: string, reasons: string[], measured: object, securityEvent: boolean }}
 */
function validatePosition(input) {
  const source = input || {};
  const reported = source.reported || {};
  const reasons = [];
  const measured = {};
  let securityEvent = false;

  if (!Number.isFinite(reported.lat) || !Number.isFinite(reported.lon)) {
    return { verdict: VERDICT.REJECTED, reasons: ["the report carries no usable coordinate"], measured, securityEvent };
  }
  if (!source.last || !Number.isFinite(source.last.lat) || !Number.isFinite(source.last.lon)) {
    // No baseline: kinematic plausibility is undefined, not satisfied. §7.3's third value
    // rather than a permissive accept — the first fix after a reboot is exactly when a
    // spoofed position would be introduced.
    return { verdict: VERDICT.INDETERMINATE, reasons: ["no accepted prior fix to measure against"], measured, securityEvent };
  }

  const elapsedMs = Number(reported.atMs) - Number(source.last.atMs);
  const distanceM = metresBetween(source.last, reported);
  /** @structural milliseconds per second */
  const MS_PER_SECOND = 1000;
  const elapsedS = elapsedMs / MS_PER_SECOND;
  measured.distanceM = distanceM;
  measured.elapsedS = elapsedS;

  if (!Number.isFinite(elapsedS) || elapsedS <= 0) {
    // A fix stamped at or before the last accepted one. Time does not run backwards on a
    // healthy device, and a reordered fix cannot be distinguished from a replayed one.
    reasons.push("the fix is not newer than the last accepted one");
    securityEvent = true;
    return { verdict: VERDICT.REJECTED, reasons, measured, securityEvent };
  }

  const impliedSpeed = distanceM / elapsedS;
  measured.impliedSpeedMps = impliedSpeed;

  const tolerance = Number.isFinite(source.tolerance) ? Number(source.tolerance) : 1;
  const ceiling = Number.isFinite(source.maxSpeedMps) ? Number(source.maxSpeedMps) * tolerance : null;
  measured.ceilingMps = ceiling;

  if (ceiling === null) {
    return { verdict: VERDICT.INDETERMINATE, reasons: ["the agent's MobilityModel states no maximum speed"], measured, securityEvent };
  }
  if (impliedSpeed > ceiling) {
    reasons.push(
      `the fix implies ${impliedSpeed.toFixed(1)} m·s⁻¹ against a ceiling of ${ceiling.toFixed(1)} m·s⁻¹. ` +
        "A jump exceeding achievable speed is rejected, not smoothed: a smoothed jump is a position that is " +
        "plausible and wrong, and the whole downstream stack would consume it as measured (§23.5).",
    );
    securityEvent = true;
  }
  if (source.onMapNetwork === false) {
    reasons.push("the fix is not on the map network");
    securityEvent = true;
  }
  if (source.corroborated === false) {
    reasons.push("an independent signal disagrees with this fix");
    securityEvent = true;
  }

  return { verdict: reasons.length === 0 ? VERDICT.ACCEPTED : VERDICT.REJECTED, reasons, measured, securityEvent };
}

/**
 * §23.5 row 2 — energy.
 *
 * @param {object} input
 * @param {number} [input.lastSoc] 0–1
 * @param {number} input.reportedSoc 0–1
 * @param {boolean} [input.charging]
 * @param {number} [input.elapsedS]
 * @param {number} [input.distanceM]
 * @param {number} [input.predictedConsumptionWh] from `energy/consumption.js`
 * @param {number} [input.usableCapacityWh]
 * @param {number} input.rateTolerance `security.energy_rate_tolerance`
 * @returns {{ verdict: string, reasons: string[], measured: object, securityEvent: boolean }}
 */
function validateEnergy(input) {
  const source = input || {};
  const reasons = [];
  const measured = {};

  if (!Number.isFinite(source.reportedSoc)) {
    return { verdict: VERDICT.REJECTED, reasons: ["the report carries no usable state of charge"], measured, securityEvent: false };
  }
  if (!Number.isFinite(source.lastSoc)) {
    return { verdict: VERDICT.INDETERMINATE, reasons: ["no accepted prior state of charge to measure against"], measured, securityEvent: false };
  }

  const delta = Number(source.reportedSoc) - Number(source.lastSoc);
  measured.deltaSoc = delta;

  // Monotonicity except while charging. A rising SoC on a discharging agent is either a
  // defective gauge or a fabricated report; both must stop the value being used, and
  // §14 has no model under which it could be true.
  if (delta > 0 && !source.charging) {
    reasons.push("state of charge rose while not charging; energy is monotone except while charging (§23.5)");
  }

  // Rate-of-change bound and consistency with the energy model. Both are only checkable
  // when the caller supplied the model's own prediction — this module never re-derives
  // consumption, because two implementations of §14.2 would eventually disagree and the
  // disagreement would present as a security event.
  if (Number.isFinite(source.predictedConsumptionWh) && Number.isFinite(source.usableCapacityWh) && source.usableCapacityWh > 0) {
    const observedWh = -delta * Number(source.usableCapacityWh);
    const tolerance = Number.isFinite(source.rateTolerance) ? Number(source.rateTolerance) : 1;
    measured.observedWh = observedWh;
    measured.predictedWh = source.predictedConsumptionWh;
    if (observedWh > Number(source.predictedConsumptionWh) * tolerance) {
      reasons.push(
        `the reported drop of ${observedWh.toFixed(1)} Wh exceeds the model's ${Number(source.predictedConsumptionWh).toFixed(1)} Wh ` +
          "by more than security.energy_rate_tolerance; the reading is inconsistent with the distance travelled (§23.5)",
      );
    }
  }

  return { verdict: reasons.length === 0 ? VERDICT.ACCEPTED : VERDICT.REJECTED, reasons, measured, securityEvent: reasons.length > 0 };
}

/**
 * §23.5 row 3 — completion.
 *
 * The graded verification of §12.5 is Phase 5's and is **not** restated here. What this
 * adds is the security consequence the earlier phase could not draw: a completion claim
 * from a position the agent could not kinematically have reached is not a failed
 * verification, it is a security event.
 *
 * @param {object} input
 * @param {object} input.verification the `supervision/verification.js` outcome
 * @param {object} [input.positionCheck] a `validatePosition` result for the claimed position
 * @returns {{ verdict: string, reasons: string[], securityEvent: boolean }}
 */
function validateCompletion(input) {
  const source = input || {};
  const reasons = [];
  let securityEvent = false;

  const verification = source.verification || {};
  if (verification.verified === false) {
    reasons.push(...(verification.failures || ["graded verification did not pass"]));
  }
  if (verification.securityEvent === true) securityEvent = true;

  if (source.positionCheck && source.positionCheck.verdict === VERDICT.REJECTED) {
    reasons.push(
      "the completion was claimed from a position that fails kinematic plausibility. A completion claim from a " +
        "kinematically unreachable position is a security event, not a verification failure (§23.5).",
    );
    securityEvent = true;
  }

  return { verdict: reasons.length === 0 ? VERDICT.ACCEPTED : VERDICT.REJECTED, reasons, securityEvent };
}

/**
 * Which direction does a health report move eligibility in?
 *
 * @param {object} input `{ reportedTier, currentTier, declaresUnfit }`
 * @returns {string} one of `DIRECTION`
 */
function direction(input) {
  const source = input || {};
  if (source.declaresUnfit === true) return DIRECTION.RESTRICTING;
  if (Number.isFinite(source.reportedTier) && Number.isFinite(source.currentTier)) {
    if (Number(source.reportedTier) < Number(source.currentTier)) return DIRECTION.RESTRICTING;
    if (Number(source.reportedTier) > Number(source.currentTier)) return DIRECTION.EXPANDING;
  }
  return DIRECTION.NEUTRAL;
}

/**
 * §23.5 row 4 — health, with the asymmetry.
 *
 * Health tiers are ordered so that a **lower** number is a worse tier (§16.4), which is
 * why `direction()` reads a decrease as restricting.
 *
 * @param {object} input `{ reportedTier, currentTier, declaresUnfit }`
 * @returns {{ verdict: string, direction: string, applied: boolean, reasons: string[] }}
 */
function validateHealth(input) {
  const moved = direction(input);
  const trust = trustsSelfReport(moved);

  if (moved === DIRECTION.EXPANDING) {
    return {
      verdict: VERDICT.ACCEPTED_RESTRICTING_ONLY,
      direction: moved,
      applied: false,
      reasons: [
        `${trust.why}. The report is recorded and does not expand eligibility; only an independent health assessment ` +
          "or a maintenance action does that (§16.4, §23.5).",
      ],
    };
  }

  return { verdict: VERDICT.ACCEPTED, direction: moved, applied: true, reasons: [trust.why] };
}

/**
 * §23.5 row 5 — capability. Rejected entirely, always.
 *
 * @param {object} claim `{ name }`
 * @returns {{ verdict: string, reasons: string[], securityEvent: boolean }}
 */
function validateCapability(claim) {
  const verdict = attestation.admitClaim({ name: claim && claim.name, origin: "TELEMETRY" });
  return { verdict: VERDICT.REJECTED, reasons: [verdict.reason], securityEvent: true };
}

/**
 * §23.5 row 6 — custody events.
 *
 * "Where available" is load-bearing: an agent with no compartment sensing and no mass
 * sensor produces an **uncorroborated** custody event, which is `INDETERMINATE` rather
 * than accepted. §2.5 makes custody a first-class state and §15.6 makes its evidence a
 * reconciliation input; admitting an uncorroborated transfer as fact would put a parcel
 * in a compartment the system has no reason to believe it is in.
 *
 * @param {object} input
 * @param {string} input.event the claimed custody transition
 * @param {boolean|null} [input.compartmentOccupied] compartment sensing, where fitted
 * @param {number|null} [input.massDeltaKg] measured mass change, where fitted
 * @param {number|null} [input.expectedMassKg] the manifest's mass for this transition
 * @param {number} [input.massToleranceKg]
 * @returns {{ verdict: string, reasons: string[], corroboration: string[] }}
 */
function validateCustody(input) {
  const source = input || {};
  const reasons = [];
  const corroboration = [];

  const hasSensing = source.compartmentOccupied !== undefined && source.compartmentOccupied !== null;
  const hasMass = Number.isFinite(source.massDeltaKg) && Number.isFinite(source.expectedMassKg);

  if (hasSensing) {
    corroboration.push("COMPARTMENT_SENSING");
    const expectOccupied = /LOAD|PICK|ACQUIRE|RECEIVE/i.test(String(source.event));
    if (Boolean(source.compartmentOccupied) !== expectOccupied) {
      reasons.push(`compartment sensing disagrees with the claimed "${String(source.event)}"`);
    }
  }
  if (hasMass) {
    corroboration.push("MASS_DELTA");
    const tolerance = Number.isFinite(source.massToleranceKg) ? Number(source.massToleranceKg) : 0;
    if (Math.abs(Number(source.massDeltaKg) - Number(source.expectedMassKg)) > tolerance) {
      reasons.push(
        `the measured mass delta ${Number(source.massDeltaKg).toFixed(2)} kg differs from the manifest's ` +
          `${Number(source.expectedMassKg).toFixed(2)} kg by more than its tolerance`,
      );
    }
  }

  if (corroboration.length === 0) {
    return {
      verdict: VERDICT.INDETERMINATE,
      reasons: ["no compartment sensing and no mass measurement are available to corroborate this custody event (§23.5)"],
      corroboration,
    };
  }

  return { verdict: reasons.length === 0 ? VERDICT.ACCEPTED : VERDICT.REJECTED, reasons, corroboration };
}

/**
 * > Persistent implausibility triggers quarantine and a security event.
 *
 * A single rejected report is noise — a GPS multipath, a dropped packet, a gauge that
 * settled. A sustained pattern is evidence, and the two need opposite responses, so the
 * threshold is a registered parameter rather than a number chosen inside a handler.
 *
 * @param {object} input `{ rejections, threshold, agentId }`
 * @returns {{ quarantine: boolean, securityEvent: boolean, reason: string|null }}
 */
function persistentImplausibility(input) {
  const source = input || {};
  const rejections = Number.isFinite(source.rejections) ? Number(source.rejections) : 0;
  // PHASE 14 remediation (P14-R2) — an unresolved threshold is reported, not hidden.
  //
  // `Infinity` is retained as the value, because with no threshold there is no definition
  // of "persistent" and quarantining on the first refused report would be a different and
  // worse rule. What is *not* retained is the silence: an unconfigured threshold means
  // §23.5's closing control — "persistent implausibility triggers quarantine and a
  // security event" — is switched off, and before this the only symptom was that it never
  // fired. `thresholdConfigured` is what lets the caller say so out loud.
  const configured = Number.isFinite(source.threshold);
  const threshold = configured ? Number(source.threshold) : Infinity;

  if (rejections < threshold) return { quarantine: false, securityEvent: false, reason: null, thresholdConfigured: configured };

  return {
    quarantine: true,
    securityEvent: true,
    thresholdConfigured: configured,
    reason:
      `agent ${String(source.agentId)} has had ${rejections} report(s) refused by the §23.5 trust boundaries, at or ` +
      "beyond security.implausible_report_quarantine_threshold. A compromised agent's most valuable capability is to " +
      "appear healthy and well-positioned, so this is a security control and not merely a data-quality one.",
  };
}

/**
 * Every §23.5 row has a validator, and every validator is exported.
 *
 * @param {object} exported the module's own exports
 * @throws {Error} naming the missing row
 */
function assertCoverage(exported) {
  for (const report of REPORTS) {
    if (typeof exported[report.validator] !== "function") {
      throw new Error(`§23.5 row "${report.row}" declares validator "${report.validator}", which this module does not export`);
    }
  }
}

const exported = {
  VERDICT,
  DIRECTION,
  REPORTS,
  trustsSelfReport,
  metresBetween,
  validatePosition,
  validateEnergy,
  validateCompletion,
  direction,
  validateHealth,
  validateCapability,
  validateCustody,
  persistentImplausibility,
  assertCoverage,
  // Re-exported so a caller enforcing the capability row has one import, not two. The
  // rule lives in `capability.js` (Tier 0) and `attestation.js`; this is a reference.
  isAttestedCapability: capability.isAttested,
};

assertCoverage(exported);

module.exports = exported;

"use strict";

/**
 * Engine lane — Phase 14: trust boundaries for agent-reported data (§23.5).
 *
 * The plan's testing requirements for this phase name three of these explicitly:
 *
 *   * "capability claimed via telemetry is rejected entirely (§23.2)";
 *   * "self-reported health accepted for restricting but never for expanding eligibility";
 *   * "a completion claim from a kinematically unreachable position is rejected and raises
 *     a security event".
 *
 * The other three rows are tested here for the same reason the register exists: a table of
 * six with three tested is a table of three.
 */

const trustBoundaries = require("../../src/engine/security/trustBoundaries");
const { assessAgentReport, recordImplausibleReport, resetTrustBoundaryState } = require("../../src/sockets/handlers/telemetry.handler");

const { VERDICT, DIRECTION } = trustBoundaries;

beforeEach(() => resetTrustBoundaryState());

describe("§23.5 — the table has six rows and six validators", () => {
  test("every row names a validator this module exports", () => {
    expect(trustBoundaries.REPORTS.map((row) => row.row)).toEqual([
      "POSITION",
      "ENERGY",
      "COMPLETION",
      "HEALTH",
      "CAPABILITY",
      "CUSTODY",
    ]);
    // `assertCoverage` runs at require time; calling it here is what makes the failure
    // legible if a future edit drops a row.
    expect(() => trustBoundaries.assertCoverage(trustBoundaries)).not.toThrow();
  });
});

describe("§23.5 row 1 — position: rejected, not smoothed", () => {
  const last = { lat: 51.5000, lon: -0.1000, atMs: 0 };

  test("a plausible move is accepted", () => {
    // ~7 m in 10 s at a 5 m·s⁻¹ ceiling.
    const result = trustBoundaries.validatePosition({
      last,
      reported: { lat: 51.50006, lon: -0.1, atMs: 10_000 },
      maxSpeedMps: 5,
      tolerance: 1.2,
    });
    expect(result.verdict).toBe(VERDICT.ACCEPTED);
  });

  test("a jump exceeding achievable speed is REJECTED and is a security event", () => {
    const result = trustBoundaries.validatePosition({
      last,
      // ~11 km in 10 s.
      reported: { lat: 51.6, lon: -0.1, atMs: 10_000 },
      maxSpeedMps: 5,
      tolerance: 1.2,
    });

    expect(result.verdict).toBe(VERDICT.REJECTED);
    expect(result.securityEvent).toBe(true);
    // The sentence that matters: a smoothed jump is a position that is plausible and
    // wrong, and every downstream consumer would treat it as measured.
    expect(result.reasons.join(" ")).toMatch(/rejected, not smoothed/);
  });

  test("no prior fix is INDETERMINATE, not accepted — the first fix after a reboot is when a spoof arrives", () => {
    const result = trustBoundaries.validatePosition({ last: null, reported: { lat: 51.5, lon: -0.1, atMs: 1 }, maxSpeedMps: 5 });
    expect(result.verdict).toBe(VERDICT.INDETERMINATE);
  });

  test("no stated maximum speed is INDETERMINATE, not a refusal", () => {
    // An absent ceiling is a missing input, not evidence of a spoof; refusing on it would
    // take a whole un-backfilled fleet offline.
    const result = trustBoundaries.validatePosition({ last, reported: { lat: 51.5, lon: -0.1, atMs: 10_000 } });
    expect(result.verdict).toBe(VERDICT.INDETERMINATE);
  });

  test("a fix that is not newer than the last accepted one is refused", () => {
    const result = trustBoundaries.validatePosition({ last, reported: { lat: 51.5, lon: -0.1, atMs: 0 }, maxSpeedMps: 5 });
    expect(result.verdict).toBe(VERDICT.REJECTED);
    expect(result.securityEvent).toBe(true);
  });

  test("map-network inconsistency and failed corroboration each refuse on their own", () => {
    const base = { last, reported: { lat: 51.50006, lon: -0.1, atMs: 10_000 }, maxSpeedMps: 5, tolerance: 1.2 };
    expect(trustBoundaries.validatePosition({ ...base, onMapNetwork: false }).verdict).toBe(VERDICT.REJECTED);
    expect(trustBoundaries.validatePosition({ ...base, corroborated: false }).verdict).toBe(VERDICT.REJECTED);
  });
});

describe("§23.5 row 2 — energy", () => {
  test("a rising state of charge while not charging is refused", () => {
    const result = trustBoundaries.validateEnergy({ lastSoc: 0.5, reportedSoc: 0.6, charging: false });
    expect(result.verdict).toBe(VERDICT.REJECTED);
    expect(result.reasons.join(" ")).toMatch(/monotone except while charging/);
  });

  test("the same rise while charging is accepted", () => {
    expect(trustBoundaries.validateEnergy({ lastSoc: 0.5, reportedSoc: 0.6, charging: true }).verdict).toBe(VERDICT.ACCEPTED);
  });

  test("a drop the energy model cannot explain is refused", () => {
    const result = trustBoundaries.validateEnergy({
      lastSoc: 0.5,
      reportedSoc: 0.2,
      usableCapacityWh: 1000,
      // §14.2 predicted 50 Wh; the agent reports 300 Wh gone.
      predictedConsumptionWh: 50,
      rateTolerance: 1.5,
    });
    expect(result.verdict).toBe(VERDICT.REJECTED);
    expect(result.reasons.join(" ")).toMatch(/inconsistent with the distance travelled/);
  });

  test("no prior reading is INDETERMINATE", () => {
    expect(trustBoundaries.validateEnergy({ reportedSoc: 0.5 }).verdict).toBe(VERDICT.INDETERMINATE);
  });
});

describe("§23.5 row 3 — completion", () => {
  test("a completion claimed from a kinematically unreachable position is refused AND raises a security event", () => {
    const positionCheck = trustBoundaries.validatePosition({
      last: { lat: 51.5, lon: -0.1, atMs: 0 },
      reported: { lat: 51.6, lon: -0.1, atMs: 10_000 },
      maxSpeedMps: 5,
      tolerance: 1.2,
    });

    const result = trustBoundaries.validateCompletion({ verification: { verified: true }, positionCheck });

    expect(result.verdict).toBe(VERDICT.REJECTED);
    expect(result.securityEvent).toBe(true);
    // The distinction the plan's testing requirement turns on: this is not a failed
    // verification, it is a security event.
    expect(result.reasons.join(" ")).toMatch(/security event, not a verification failure/);
  });

  test("a failed graded verification is refused without inventing a security event", () => {
    const result = trustBoundaries.validateCompletion({ verification: { verified: false, failures: ["arrival radius"] } });
    expect(result).toMatchObject({ verdict: VERDICT.REJECTED, securityEvent: false });
  });

  test("a clean verification passes through", () => {
    expect(trustBoundaries.validateCompletion({ verification: { verified: true } }).verdict).toBe(VERDICT.ACCEPTED);
  });
});

describe("§23.5 row 4 — health, and the asymmetry", () => {
  test("an agent may always declare itself unfit", () => {
    const result = trustBoundaries.validateHealth({ declaresUnfit: true });
    expect(result).toMatchObject({ verdict: VERDICT.ACCEPTED, direction: DIRECTION.RESTRICTING, applied: true });
    expect(result.reasons.join(" ")).toMatch(/costs one agent-shift/);
  });

  test("an agent may never declare itself fitter than it is recorded", () => {
    const result = trustBoundaries.validateHealth({ reportedTier: 3, currentTier: 1 });
    expect(result).toMatchObject({ verdict: VERDICT.ACCEPTED_RESTRICTING_ONLY, direction: DIRECTION.EXPANDING, applied: false });
    expect(result.reasons.join(" ")).toMatch(/risks an incident/);
  });

  test("a downgrade is applied; a no-change report is neutral", () => {
    expect(trustBoundaries.validateHealth({ reportedTier: 1, currentTier: 3 }).applied).toBe(true);
    expect(trustBoundaries.validateHealth({ reportedTier: 2, currentTier: 2 }).direction).toBe(DIRECTION.NEUTRAL);
  });

  test("the asymmetric rule is stated once and applies to any field", () => {
    expect(trustBoundaries.trustsSelfReport(DIRECTION.RESTRICTING).trusted).toBe(true);
    expect(trustBoundaries.trustsSelfReport(DIRECTION.EXPANDING).trusted).toBe(false);
  });
});

describe("§23.5 row 5 — capability", () => {
  test("it is always refused, whatever is claimed", () => {
    const result = trustBoundaries.validateCapability({ name: "hazmat_certified" });
    expect(result).toMatchObject({ verdict: VERDICT.REJECTED, securityEvent: true });
  });
});

describe("§23.5 row 6 — custody", () => {
  test("compartment sensing that disagrees with the claim refuses it", () => {
    const result = trustBoundaries.validateCustody({ event: "LOAD", compartmentOccupied: false });
    expect(result.verdict).toBe(VERDICT.REJECTED);
    expect(result.corroboration).toEqual(["COMPARTMENT_SENSING"]);
  });

  test("a mass delta outside tolerance refuses it", () => {
    const result = trustBoundaries.validateCustody({ event: "LOAD", massDeltaKg: 12, expectedMassKg: 3, massToleranceKg: 0.5 });
    expect(result.verdict).toBe(VERDICT.REJECTED);
  });

  test("an agent with neither sensor produces an INDETERMINATE custody event, never an accepted one", () => {
    // Admitting an uncorroborated transfer as fact would put a parcel in a compartment
    // the system has no reason to believe it is in (§2.5, §15.6).
    const result = trustBoundaries.validateCustody({ event: "LOAD" });
    expect(result).toMatchObject({ verdict: VERDICT.INDETERMINATE, corroboration: [] });
  });

  test("both sensors agreeing accepts, and names both corroborations", () => {
    const result = trustBoundaries.validateCustody({
      event: "LOAD",
      compartmentOccupied: true,
      massDeltaKg: 3.1,
      expectedMassKg: 3,
      massToleranceKg: 0.5,
    });
    expect(result).toMatchObject({ verdict: VERDICT.ACCEPTED, corroboration: ["COMPARTMENT_SENSING", "MASS_DELTA"] });
  });
});

describe("§23.5 — persistent implausibility", () => {
  test("one refusal is noise; the threshold is evidence", () => {
    expect(trustBoundaries.persistentImplausibility({ agentId: "AGT-1", rejections: 2, threshold: 3 }).quarantine).toBe(false);
    const crossed = trustBoundaries.persistentImplausibility({ agentId: "AGT-1", rejections: 3, threshold: 3 });
    expect(crossed).toMatchObject({ quarantine: true, securityEvent: true });
    expect(crossed.reason).toMatch(/security control and not merely a data-quality one/);
  });

  test("an unset threshold never quarantines — unknown is never a reason to act, either", () => {
    expect(trustBoundaries.persistentImplausibility({ agentId: "AGT-1", rejections: 1000 }).quarantine).toBe(false);
  });
});

describe("§23.5 — the telemetry handler's application of the two hot-path rows", () => {
  test("an implausible fix is refused and counted; an acceptable one clears the count", () => {
    const existing = { lat: 51.5, lon: -0.1, battery: 80, maxSpeedMps: 5 };

    const first = assessAgentReport({
      robotId: "AGT-1",
      existing,
      reported: { lat: 51.5, lon: -0.1, battery: 80, atMs: 1_000 },
      config: null,
    });
    // No prior *accepted* fix time yet, so the kinematic check is INDETERMINATE and the
    // frame stands.
    expect(first.refused).toBe(false);

    const jumped = assessAgentReport({
      robotId: "AGT-1",
      existing,
      reported: { lat: 51.9, lon: -0.1, battery: 80, atMs: 2_000 },
      config: null,
    });
    expect(jumped.refused).toBe(true);
    expect(recordImplausibleReport("AGT-1", 3).count).toBe(1);
  });

  test("a rising battery on a discharging agent is refused", () => {
    const verdict = assessAgentReport({
      robotId: "AGT-2",
      existing: { lat: 51.5, lon: -0.1, battery: 50 },
      reported: { lat: 51.5, lon: -0.1, battery: 70, atMs: 1_000 },
      charging: false,
      config: null,
    });
    expect(verdict.refused).toBe(true);
    expect(verdict.reasons.join(" ")).toMatch(/monotone except while charging/);
  });

  test("the verdict is computed but not enforced while ENGINE_ENABLED is false", () => {
    // §21.6's shadow discipline, applied to a security control: the refusal rate is
    // observable before it is load-bearing.
    const verdict = assessAgentReport({
      robotId: "AGT-3",
      existing: { lat: 51.5, lon: -0.1, battery: 50 },
      reported: { lat: 51.5, lon: -0.1, battery: 70, atMs: 1_000 },
      config: null,
    });
    expect({ refused: verdict.refused, enforced: verdict.enforced }).toEqual({ refused: true, enforced: false });
  });
});

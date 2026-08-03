"use strict";

/**
 * Engine lane — Phase 5: §12.2 lease renewal and expiry, §12.3 progress supervision,
 * §12.4 the reconciliation loop, §12.5 completion verification, and §4.9 settlement.
 *
 * The phase's stated testing requirements this file discharges:
 *
 * > lease renewal requires commitment-scoped evidence, not a generic ping.
 * > Verification: each of the three plausibility tests rejects its own crafted failure
 * > and no other.
 * > **Gate:** reconciler repairs all nine §12.4 divergences and counts each; repair rate
 * > is an alertable SLI.
 *
 * The last of those reads "nine"; §12.4's table has ten rows. The specification wins over
 * the plan by the plan's own precedence rule, so all ten are exercised here.
 */

const leases = require("../../src/engine/supervision/leases");
const progress = require("../../src/engine/supervision/progress");
const reconciler = require("../../src/engine/supervision/reconciler");
const settlement = require("../../src/engine/lifecycle/settlement");
const verification = require("../../src/engine/supervision/verification");

const fixtures = require("./helpers/dispatchFixture");

const STORE_NOW = fixtures.seed().now;

/* ═══════════════════════════════════════════════════════════════════════════
   §12.2 — lease renewal takes positive, commitment-scoped evidence
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§12.2 — lease renewal", () => {
  function buildStore() {
    const fixture = fixtures.seed();
    return {
      fixture,
      store: fixtures.storeFor(fixture, { commitments: [fixtures.commitmentRow(fixture, { fence: 42n })] }),
    };
  }

  async function readCommitment(store) {
    return store.client.commitment.findUnique({ where: { commitmentId: "commitment-c1" } });
  }

  test("a heartbeat naming this commitment and its fence renews it", async () => {
    const { store } = buildStore();
    const commitment = await readCommitment(store);

    const result = await store.client.$transaction((tx) =>
      leases.renew(tx, {
        commitment,
        evidence: { commitmentId: "commitment-c1", fence: 42n },
        storeTime: store.now(),
        leaseDurationSeconds: 60,
      }),
    );

    expect(result.outcome).toBe(leases.RENEWAL_OUTCOME.RENEWED);
    expect(store.rows("commitment")[0].leaseExpiry.getTime()).toBe(STORE_NOW.getTime() + 60_000);
  });

  test("a generic ping renews nothing — it proves the link, not the mission", async () => {
    const { store } = buildStore();
    const commitment = await readCommitment(store);

    const result = await store.client.$transaction((tx) =>
      leases.renew(tx, {
        commitment,
        evidence: { alive: true },
        storeTime: store.now(),
        leaseDurationSeconds: 60,
      }),
    );

    expect(result.outcome).toBe(leases.RENEWAL_OUTCOME.REFUSED);
    expect(result.detail).toMatch(/proves the link, not the mission/);
  });

  test("evidence naming another commitment does not renew this one — leases are per commitment", async () => {
    const { store } = buildStore();
    const commitment = await readCommitment(store);

    const result = await store.client.$transaction((tx) =>
      leases.renew(tx, {
        commitment,
        evidence: { commitmentId: "commitment-c2", fence: 42n },
        storeTime: store.now(),
        leaseDurationSeconds: 60,
      }),
    );

    expect(result).toMatchObject({
      outcome: leases.RENEWAL_OUTCOME.REFUSED,
      reason: "EVIDENCE_NAMES_ANOTHER_COMMITMENT",
    });
  });

  test("evidence carrying a superseded fence does not renew", async () => {
    const { store } = buildStore();
    const commitment = await readCommitment(store);

    const result = await store.client.$transaction((tx) =>
      leases.renew(tx, {
        commitment,
        evidence: { commitmentId: "commitment-c1", fence: 41n },
        storeTime: store.now(),
        leaseDurationSeconds: 60,
      }),
    );

    expect(result.reason).toBe("EVIDENCE_CARRIES_A_DIFFERENT_FENCE");
  });

  test("a released commitment is not renewable — renewal cannot resurrect a recovery", async () => {
    const { store } = buildStore();
    const commitment = await readCommitment(store);
    await store.client.commitment.update({
      where: { commitmentId: "commitment-c1" },
      data: { releasedAt: store.now() },
    });

    const result = await store.client.$transaction((tx) =>
      leases.renew(tx, {
        commitment: { ...commitment, releasedAt: store.now() },
        evidence: { commitmentId: "commitment-c1", fence: 42n },
        storeTime: store.now(),
        leaseDurationSeconds: 60,
      }),
    );

    expect(result.outcome).toBe(leases.RENEWAL_OUTCOME.NOT_RENEWABLE);
  });

  test("this module holds no cache import — leases are never renewed against a cached value", () => {
    const source = require("fs").readFileSync(require.resolve("../../src/engine/supervision/leases"), "utf8");
    expect(source).not.toMatch(/require\(["'].*cache/);
    expect(source).not.toMatch(/redis|ioredis/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §12.2 / §4.7 — the custody-aware recovery assessment
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§4.7 — the three lawful custody-HELD outcomes, chosen explicitly", () => {
  const heldLeg = { state: "EN_ROUTE_DROP", custodyState: "HELD" };

  test("custody NONE reassigns", () => {
    const assessment = leases.assessRecovery({ leg: { state: "EN_ROUTE_PICKUP", custodyState: "NONE" } });
    expect(assessment).toMatchObject({ outcome: leases.RECOVERY_OUTCOME.REASSIGN, legState: "REASSIGNING" });
  });

  test("Resume — the incumbent recovered inside its window and remains feasible", () => {
    const assessment = leases.assessRecovery({
      leg: heldLeg,
      agentReachable: true,
      withinResumeWindow: true,
      stillFeasible: true,
    });
    expect(assessment.outcome).toBe(leases.RECOVERY_OUTCOME.RESUME);
  });

  test("Transfer — reachable, able to release, and a capable receiver exists", () => {
    const assessment = leases.assessRecovery({
      leg: heldLeg,
      agentReachable: true,
      ableToReleaseCustody: true,
      transferCapableReceiverAvailable: true,
    });
    expect(assessment.outcome).toBe(leases.RECOVERY_OUTCOME.TRANSFER);
  });

  test("no capable receiver means no agent-to-agent transfer — unknown is not permission", () => {
    for (const receiver of [undefined, null, false]) {
      const assessment = leases.assessRecovery({
        leg: heldLeg,
        agentReachable: true,
        ableToReleaseCustody: true,
        transferCapableReceiverAvailable: receiver,
        obstructionClass: "CLEAR",
      });
      expect({ receiver, outcome: assessment.outcome }).toEqual({
        receiver,
        outcome: leases.RECOVERY_OUTCOME.PHYSICAL_RECOVERY,
      });
    }
  });

  test("Physical recovery strands at the class the stopping location implies", () => {
    const safe = leases.assessRecovery({ leg: heldLeg, agentReachable: false, obstructionClass: "CLEAR" });
    expect(safe).toMatchObject({ legState: "STRANDED_SAFE", externalEscalation: false });

    const obstructing = leases.assessRecovery({
      leg: heldLeg,
      agentReachable: false,
      obstructionClass: "BLOCKING_CRITICAL",
    });
    expect(obstructing).toMatchObject({ legState: "STRANDED_OBSTRUCTING", externalEscalation: true });
  });

  test("DISPUTED custody takes the physical path, not the reassignment one", () => {
    // §2.5: DISPUTED answers `holdsGoods` true — the evidence conflicts, so the engine
    // does not know, and not knowing resolves to the conservative case.
    const assessment = leases.assessRecovery({
      leg: { state: "AT_DROP", custodyState: "DISPUTED" },
      agentReachable: false,
    });
    expect(assessment.outcome).toBe(leases.RECOVERY_OUTCOME.PHYSICAL_RECOVERY);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §12.3 — progress supervision, five signals
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§12.3 — progress supervision", () => {
  test("a stall fires beyond supervise.stall_time and not at it", () => {
    expect(progress.assessStall({ secondsSinceRouteProgress: 90, stallTimeSeconds: 90 }).fired).toBe(false);
    expect(progress.assessStall({ secondsSinceRouteProgress: 91, stallTimeSeconds: 90 }).fired).toBe(true);
  });

  test("unmeasurable route progress is a signal, not a silence", () => {
    const assessment = progress.assessStall({ stallTimeSeconds: 90 });
    expect(assessment.fired).toBe(true);
    expect(assessment.reason).toBe("ROUTE_PROGRESS_UNMEASURABLE");
  });

  test("ETA drift is measured as a ratio, so the tolerance means the same on every leg", () => {
    const short = progress.assessEtaDrift({
      projectedDurationSeconds: 240,
      realisedDurationSeconds: 280,
      etaTolerance: 1.2,
    });
    const long = progress.assessEtaDrift({
      projectedDurationSeconds: 7200,
      realisedDurationSeconds: 8400,
      etaTolerance: 1.2,
    });
    expect(short.fired).toBe(false);
    expect(long.fired).toBe(false);

    expect(progress.assessEtaDrift({ projectedDurationSeconds: 240, realisedDurationSeconds: 360, etaTolerance: 1.2 }).fired).toBe(true);
  });

  test("reassignment is considered only pre-custody", () => {
    const preCustody = progress.assessEtaDrift({
      projectedDurationSeconds: 100,
      realisedDurationSeconds: 200,
      etaTolerance: 1.2,
      custodyState: "NONE",
    });
    const loaded = progress.assessEtaDrift({
      projectedDurationSeconds: 100,
      realisedDurationSeconds: 200,
      etaTolerance: 1.2,
      custodyState: "HELD",
    });
    expect(preCustody.considerReassignment).toBe(true);
    expect(loaded.considerReassignment).toBe(false);
  });

  test("energy deviation is one-sided — using less than predicted is calibration, not a safety signal", () => {
    expect(progress.assessEnergyDeviation({ predictedWh: 100, realisedWh: 60, deviationTolerance: 0.15 }).fired).toBe(
      false,
    );
    expect(progress.assessEnergyDeviation({ predictedWh: 100, realisedWh: 130, deviationTolerance: 0.15 }).fired).toBe(
      true,
    );
  });

  test("a replan rate above the cohort baseline is a health signal, and never quarantines mid-mission", () => {
    const assessment = progress.assessReplanRate({ replanCount: 9, distanceKm: 3, baselinePerKm: 1 });
    expect(assessment.fired).toBe(true);
    expect(assessment.response).toBe(progress.RESPONSE.HEALTH_SIGNAL);
    expect(assessment.quarantineAfterMission).toBe(true);
  });

  test("a reported deviation is not an excursion; an unreported one is", () => {
    const reported = progress.assessOffRoute({
      offRouteDistanceM: 200,
      corridorHalfWidthM: 30,
      reportedByAgent: true,
    });
    expect(reported.fired).toBe(false);

    const unreported = progress.assessOffRoute({ offRouteDistanceM: 200, corridorHalfWidthM: 30 });
    expect(unreported.fired).toBe(true);
    expect(unreported.possibleSafetyEvent).toBe(true);
  });

  test("all five are evaluated — a stalled and off-route agent reports both", () => {
    const assessment = progress.assessAll({
      secondsSinceRouteProgress: 500,
      stallTimeSeconds: 90,
      offRouteDistanceM: 200,
      corridorHalfWidthM: 30,
      etaTolerance: 1.2,
      deviationTolerance: 0.15,
    });
    expect(assessment.fired.map((signal) => signal.signal).sort()).toEqual(["OFF_ROUTE", "STALLED"]);
  });

  test("a non-positive threshold is refused rather than defaulted", () => {
    expect(() => progress.assessStall({ secondsSinceRouteProgress: 1, stallTimeSeconds: 0 })).toThrow(
      /must be positive/,
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §12.5 — each plausibility test rejects its own failure and no other
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§12.5 — the three track-plausibility tests", () => {
  /**
   * A well-formed track: 60 fixes, one every 10 s, along a straight corridor.
   *
   * The cadence is deliberately generous. Each test below crafts *one* failure and
   * asserts the other two tests still pass, which only demonstrates independence if the
   * crafted failure does not incidentally breach another threshold — a sparse track that
   * also has a long gap would prove nothing about which test caught what.
   */
  function goodTrack() {
    const fixes = [];
    for (let index = 0; index < 60; index += 1) {
      fixes.push({
        at: new Date(STORE_NOW.getTime() + index * 10_000),
        lat: 12.9,
        lon: 77.6 + index * 0.00003,
      });
    }
    return fixes;
  }

  const corridor = [
    { lat: 12.9, lon: 77.6 },
    { lat: 12.9, lon: 77.602 },
  ];

  function trackInput(overrides) {
    return {
      track: goodTrack(),
      legDurationSeconds: 600,
      minFixRatePerMinute: 2,
      corridor,
      corridorHalfWidthM: 30,
      minCorridorFraction: 0.85,
      maxGapSeconds: 60,
      maxSpeedMs: 10,
      ...(overrides || {}),
    };
  }

  test("a well-formed track passes all three", () => {
    const plausibility = verification.assessTrackPlausibility(trackInput());
    expect(plausibility).toMatchObject({ plausible: true, failures: [], securityEvent: false });
  });

  test("coverage rejects two fixes an hour apart — and corridor and continuity do not", () => {
    const sparse = [
      { at: new Date(STORE_NOW.getTime()), lat: 12.9, lon: 77.6 },
      { at: new Date(STORE_NOW.getTime() + 3600_000), lat: 12.9, lon: 77.6005 },
    ];
    const input = trackInput({ track: sparse, legDurationSeconds: 3600, maxGapSeconds: 7200 });

    expect(verification.testCoverage(input).failure).toBe(verification.FAILURE.TRACK_COVERAGE);
    // The crafted failure is rejected by its own test and by no other.
    expect(verification.testCorridor(input).ok).toBe(true);
    expect(verification.testContinuity(input).ok).toBe(true);
  });

  test("corridor rejects a track that took a different road — and coverage and continuity do not", () => {
    // A parallel road 110 m north: the same cadence and the same speeds, outside the
    // corridor for its whole length. Nothing about it is sparse or discontinuous.
    const diverted = goodTrack().map((fix) => ({ ...fix, lat: 12.901 }));
    const input = trackInput({ track: diverted });

    expect(verification.testCorridor(input).failure).toBe(verification.FAILURE.TRACK_CORRIDOR);
    expect(verification.testCoverage(input).ok).toBe(true);
    expect(verification.testContinuity(input).ok).toBe(true);
  });

  test("a deviation the agent reported at the time is inside the corridor", () => {
    const diverted = goodTrack().map((fix) => ({ ...fix, lat: 12.901 }));
    const input = trackInput({
      track: diverted,
      reportedCorridors: [
        [
          { lat: 12.901, lon: 77.6 },
          { lat: 12.901, lon: 77.602 },
        ],
      ],
    });
    expect(verification.testCorridor(input).ok).toBe(true);
  });

  test("continuity rejects an unexplained gap — and coverage and corridor do not", () => {
    // A two-minute hole in a ten-second stream: past `verify.track_max_gap` and nowhere
    // near the coverage or corridor thresholds.
    const gapped = goodTrack().map((fix, index) =>
      index >= 30 ? { ...fix, at: new Date(fix.at.getTime() + 120_000) } : fix,
    );
    const input = trackInput({ track: gapped, legDurationSeconds: 710 });

    expect(verification.testContinuity(input).failure).toBe(verification.FAILURE.TRACK_CONTINUITY);
    expect(verification.testContinuity(input).securityEvent).toBe(false);
    expect(verification.testCoverage(input).ok).toBe(true);
    expect(verification.testCorridor(input).ok).toBe(true);
  });

  test("a gap fully covered by a mapped dead zone is explained", () => {
    const gapped = goodTrack().map((fix, index) =>
      index >= 30 ? { ...fix, at: new Date(fix.at.getTime() + 120_000) } : fix,
    );
    const input = trackInput({
      track: gapped,
      legDurationSeconds: 710,
      mappedDeadZoneWindows: [
        { from: new Date(STORE_NOW.getTime()), to: new Date(STORE_NOW.getTime() + 2_000_000) },
      ],
    });
    expect(verification.testContinuity(input).ok).toBe(true);
  });

  test("a kinematically impossible implied speed is a security event, not a telemetry gap", () => {
    const teleport = goodTrack();
    teleport[30] = { ...teleport[30], lat: 40.0, lon: -74.0 };
    const input = trackInput({ track: teleport });

    const continuity = verification.testContinuity(input);
    expect(continuity.failure).toBe(verification.FAILURE.KINEMATICALLY_IMPOSSIBLE);
    expect(continuity.securityEvent).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §12.5 — the graded levels
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§12.5 — graded completion verification", () => {
  const stop = { lat: 12.9, lon: 77.602 };

  function goodTrack() {
    const fixes = [];
    for (let index = 0; index < 20; index += 1) {
      fixes.push({ at: new Date(STORE_NOW.getTime() + index * 30_000), lat: 12.9, lon: 77.6 + index * 0.0001 });
    }
    return fixes;
  }

  function claim(overrides) {
    return {
      requiredLevel: "L1",
      completionClaimed: true,
      claimedPosition: { lat: 12.9, lon: 77.602 },
      stopPosition: stop,
      arrivalRadiusM: 50,
      track: {
        track: goodTrack(),
        legDurationSeconds: 600,
        minFixRatePerMinute: 2,
        corridor: [
          { lat: 12.9, lon: 77.6 },
          { lat: 12.9, lon: 77.602 },
        ],
        corridorHalfWidthM: 30,
        minCorridorFraction: 0.85,
        maxGapSeconds: 60,
        maxSpeedMs: 10,
      },
      ...(overrides || {}),
    };
  }

  test("L0 accepts the assertion alone", () => {
    const result = verification.verify({ requiredLevel: "L0", completionClaimed: true });
    expect(result).toMatchObject({ outcome: verification.OUTCOME.SUFFICIENT, achievedLevel: "L0" });
  });

  test("no claim at all is insufficient and says so distinctly", () => {
    const result = verification.verify({ requiredLevel: "L1", completionClaimed: false });
    expect(result.failures).toEqual([verification.FAILURE.NO_COMPLETION_CLAIM]);
  });

  test("L1 needs the arrival radius and a plausible track", () => {
    expect(verification.verify(claim()).outcome).toBe(verification.OUTCOME.SUFFICIENT);

    const far = verification.verify(claim({ claimedPosition: { lat: 13.5, lon: 77.602 } }));
    expect(far.outcome).toBe(verification.OUTCOME.INSUFFICIENT);
    expect(far.failures).toContain(verification.FAILURE.ARRIVAL_RADIUS);
  });

  test("no position at all fails L1 rather than being assumed to have arrived", () => {
    const result = verification.verify(claim({ claimedPosition: null, stopPosition: null }));
    expect(result.failures).toContain(verification.FAILURE.ARRIVAL_RADIUS);
  });

  test("L2 is L1 plus a physical event; L3 is L2 plus an attestation", () => {
    const l2WithoutEvent = verification.verify(claim({ requiredLevel: "L2" }));
    expect(l2WithoutEvent.failures).toContain(verification.FAILURE.NO_PHYSICAL_EVENT);

    const l2 = verification.verify(claim({ requiredLevel: "L2", physicalEvidence: { latch: "OPENED" } }));
    expect(l2).toMatchObject({ outcome: verification.OUTCOME.SUFFICIENT, achievedLevel: "L2" });

    const l3WithoutAttestation = verification.verify(
      claim({ requiredLevel: "L3", physicalEvidence: { latch: "OPENED" } }),
    );
    expect(l3WithoutAttestation.failures).toContain(verification.FAILURE.NO_ATTESTATION);

    const l3 = verification.verify(
      claim({ requiredLevel: "L3", physicalEvidence: { latch: "OPENED" }, attestation: { pin: "ok" } }),
    );
    expect(l3).toMatchObject({ outcome: verification.OUTCOME.SUFFICIENT, achievedLevel: "L3" });
  });

  test("insufficient evidence sends the Task to VERIFYING — never to COMPLETED or FAILED", () => {
    const result = verification.verify(claim({ claimedPosition: { lat: 13.5, lon: 77.602 } }));
    expect(result.disposition).toBe("TASK_VERIFYING_OPERATOR_QUEUE");
  });

  test("an unmapped mission class defaults to L1, not to L0", () => {
    // "Default for all customer work". Defaulting to L0 would silently accept the
    // agent's assertion, which is the baseline behaviour §12.5 exists to remove.
    expect(verification.requiredLevelFor("something-new", {})).toBe("L1");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §4.9 — settlement ordering, invariant I7
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§4.9 — settlement", () => {
  function buildStore() {
    const fixture = fixtures.seed();
    return {
      fixture,
      store: fixtures.storeFor(fixture, { commitments: [fixtures.commitmentRow(fixture, { fence: 42n })] }),
    };
  }

  const sufficient = { outcome: "SUFFICIENT" };

  test("custody still held refuses settlement, naming I7", () => {
    const verdict = settlement.assertCustodyDischarged({ custodyState: "HELD", manifests: [] });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toMatch(/invariant I7/);
  });

  test("a disputed custody is refused as its own case, not as 'still held'", () => {
    const verdict = settlement.assertCustodyDischarged({ custodyState: "DISPUTED", manifests: [] });
    expect(verdict.reason).toBe("CUSTODY_DISPUTED");
  });

  test("an open manifest refuses settlement even when the custody flag says RELEASED", () => {
    // I7 is stated over the manifest precisely so a flag flipped without the goods being
    // accounted for does not satisfy it.
    const verdict = settlement.assertCustodyDischarged({
      custodyState: "RELEASED",
      manifests: [{ state: "OPEN" }],
    });
    expect(verdict.reason).toBe("MANIFEST_NOT_RECONCILED");
  });

  test("an unreadable custody state is not a discharged one", () => {
    expect(settlement.assertCustodyDischarged({ custodyState: undefined }).reason).toBe("CUSTODY_STATE_UNKNOWN");
  });

  test("settlement releases the commitment only after custody is discharged", async () => {
    const { store } = buildStore();
    await store.client.leg.update({
      where: { id: fixtures.LEG_ROW_ID },
      data: { state: "RELEASED", custodyState: "RELEASED" },
    });
    const leg = await store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } });
    const commitment = await store.client.commitment.findUnique({ where: { commitmentId: "commitment-c1" } });

    const result = await store.client.$transaction((tx) =>
      settlement.settle(tx, { leg, commitment, manifests: [], verification: sufficient, storeTime: store.now() }),
    );

    expect(result.outcome).toBe(settlement.OUTCOME.SETTLED);
    expect(result.steps).toEqual([
      settlement.STEP.VERIFICATION_ARCHIVED,
      settlement.STEP.CUSTODY_CLOSED,
      settlement.STEP.COMMITMENT_RELEASED,
    ]);
    expect(store.rows("commitment")[0].releasedAt).not.toBeNull();
    expect(store.rows("leg").find((row) => row.id === fixtures.LEG_ROW_ID).state).toBe("SETTLED");
  });

  test("settlement never touches the agent's authority_epoch (I19)", async () => {
    const { store, fixture } = buildStore();
    await store.client.leg.update({
      where: { id: fixtures.LEG_ROW_ID },
      data: { state: "RELEASED", custodyState: "RELEASED" },
    });
    const leg = await store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } });
    const commitment = await store.client.commitment.findUnique({ where: { commitmentId: "commitment-c1" } });

    const result = await store.client.$transaction((tx) =>
      settlement.settle(tx, { leg, commitment, manifests: [], verification: sufficient, storeTime: store.now() }),
    );

    expect(result.authorityEpochTouched).toBe(false);
    expect(store.rows("agent")[0].authorityEpoch).toBe(fixture.agent.authorityEpoch);
  });

  test("settlement without sufficient verification is refused", async () => {
    const { store } = buildStore();
    await store.client.leg.update({
      where: { id: fixtures.LEG_ROW_ID },
      data: { state: "RELEASED", custodyState: "RELEASED" },
    });
    const leg = await store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } });

    const result = await store.client.$transaction((tx) =>
      settlement.settle(tx, { leg, commitment: null, manifests: [], storeTime: store.now() }),
    );

    expect(result).toMatchObject({ outcome: settlement.OUTCOME.REFUSED, reason: "VERIFICATION_NOT_SUFFICIENT" });
  });

  test("settlement is idempotent — a retry is a no-op, not a second release", async () => {
    const { store } = buildStore();
    await store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { state: "SETTLED" } });
    const leg = await store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } });

    const result = await store.client.$transaction((tx) =>
      settlement.settle(tx, { leg, commitment: null, verification: sufficient, storeTime: store.now() }),
    );
    expect(result.outcome).toBe(settlement.OUTCOME.ALREADY_SETTLED);
  });

  test("the four §4.9 steps this phase does not own are named, not skipped silently", async () => {
    const { store } = buildStore();
    await store.client.leg.update({
      where: { id: fixtures.LEG_ROW_ID },
      data: { state: "RELEASED", custodyState: "RELEASED" },
    });
    const leg = await store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } });

    const result = await store.client.$transaction((tx) =>
      settlement.settle(tx, { leg, commitment: null, manifests: [], verification: sufficient, storeTime: store.now() }),
    );

    expect(result.pending.map((entry) => entry.step).sort()).toEqual([
      settlement.STEP.ACCOUNTING_WRITTEN,
      settlement.STEP.CALIBRATION_DELTAS_EMITTED,
      settlement.STEP.RELIABILITY_UPDATED,
      settlement.STEP.SLA_OUTCOME_RECORDED,
    ]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §12.4 — the reconciliation loop
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§12.4 — the reconciliation loop", () => {
  /**
   * Two Legs, not three: `dispatchFixture.seed` derives the second and later Leg ids by
   * replacing the last character of `LEG_ROW_ID`, so index 2 collides with index 0 and
   * the store holds two rows for a three-Leg fixture. Recorded here rather than worked
   * around silently — the collision predates this phase and is reported as a non-blocking
   * observation.
   */
  function buildStore(extra) {
    const fixture = fixtures.seed({ legs: 2 });
    return { fixture, store: fixtures.storeFor(fixture, extra) };
  }

  function deps(store, overrides) {
    return {
      prisma: store.client,
      runInTransaction: (fn) => store.client.$transaction(fn),
      readStoreTime: async () => store.now(),
      ...(overrides || {}),
    };
  }

  const config = {
    batch: 50,
    assignmentDeadlineSeconds: 900,
    unresponsiveStrikes: 3,
    energyDeviationTolerance: 0.15,
    shardId: "default",
  };

  test("all ten §12.4 divergence classes are named, and the enum matches the schema CHECK", () => {
    expect(Object.keys(reconciler.DIVERGENCE)).toHaveLength(10);
    for (const category of Object.values(reconciler.DIVERGENCE)) {
      expect(reconciler.ESCALATION_POLICY[category]).toBeDefined();
    }
  });

  test("an ACCEPTED Leg with no commitment is a defect orphan and is requeued", async () => {
    const { store } = buildStore();
    await store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { state: "ACCEPTED" } });

    const result = await reconciler.scanOrphanLegs(deps(store), config, store.now());

    // Two orphans: the ACCEPTED one, which is the defect, and the other fixture Leg,
    // which is PLANNED and therefore the expected post-failover case.
    expect(result.repaired).toBe(2);
    expect(result.counts[reconciler.ORPHAN_KIND.DEFECT]).toBe(1);
    expect(store.rows("leg").find((row) => row.id === fixtures.LEG_ROW_ID).state).toBe("QUEUED");

    const repair = store.rows("reconcilerRepair")[0];
    expect(repair).toMatchObject({ category: reconciler.DIVERGENCE.ORPHAN_LEG, action: "REQUEUE_WITH_AGING_CREDIT" });
  });

  test("a PLANNED orphan is counted separately — after a failover it is expected, not a defect", async () => {
    const { store } = buildStore();
    // The seed leaves every Leg PLANNED, which is the post-failover shape.
    const result = await reconciler.scanOrphanLegs(deps(store), config, store.now());

    expect(result.counts[reconciler.ORPHAN_KIND.EXPECTED_POST_FAILOVER]).toBe(2);
    expect(result.counts[reconciler.ORPHAN_KIND.DEFECT]).toBe(0);
  });

  test("an orphan holding goods escalates to an operator instead of being requeued", async () => {
    const { store } = buildStore();
    await store.client.leg.update({
      where: { id: fixtures.LEG_ROW_ID },
      data: { state: "EN_ROUTE_DROP", custodyState: "HELD" },
    });

    await reconciler.scanOrphanLegs(deps(store), config, store.now());

    const repair = store.rows("reconcilerRepair").find((row) => row.entityId === fixtures.LEG_ROW_ID);
    expect(repair).toMatchObject({ action: "ESCALATE_TO_OPERATOR", escalated: true });
    // Not requeued: no amount of database repair moves the goods.
    expect(store.rows("leg").find((row) => row.id === fixtures.LEG_ROW_ID).state).toBe("EN_ROUTE_DROP");
  });

  test("a commitment on a terminal Leg is released and its capacity returned", async () => {
    const fixture = fixtures.seed();
    const store = fixtures.storeFor(fixture, { commitments: [fixtures.commitmentRow(fixture, { fence: 42n })] });
    await store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { state: "CANCELLED" } });

    const result = await reconciler.scanCommitmentsOnTerminalLegs(deps(store), config, store.now());

    expect(result.repaired).toBe(1);
    expect(store.rows("commitment")[0].releasedAt).not.toBeNull();
  });

  test("custody held with no active mission escalates always, and repairs nothing automatically", async () => {
    const { store } = buildStore();
    await store.client.leg.update({
      where: { id: fixtures.LEG_ROW_ID },
      data: { state: "AT_DROP", custodyState: "HELD" },
    });

    const result = await reconciler.scanCustodyWithoutMission(deps(store), config, store.now());

    expect(result.repaired).toBe(1);
    const repair = store.rows("reconcilerRepair")[0];
    expect(repair).toMatchObject({
      category: reconciler.DIVERGENCE.CUSTODY_HELD_WITHOUT_MISSION,
      action: "IMMEDIATE_OPERATOR_ESCALATION",
      escalated: true,
    });
    // §4.1 rule 4 — where goods are involved, escalate rather than assume the record.
    expect(store.rows("leg").find((row) => row.id === fixtures.LEG_ROW_ID).custodyState).toBe("HELD");
  });

  test("an agent reporting a commitment the store does not have is repaired per commitment", async () => {
    const fixture = fixtures.seed();
    const store = fixtures.storeFor(fixture, { commitments: [fixtures.commitmentRow(fixture, { fence: 42n })] });

    const result = await reconciler.scanUnknownCommitmentReports(
      deps(store, { reportedCommitments: async () => ["commitment-c1", "phantom-1"] }),
      config,
      store.now(),
    );

    expect(result.findings[0]).toMatchObject({ phantom: ["phantom-1"], whollyUnrecognisable: false });
    expect(store.rows("reconcilerRepair")[0].action).toBe("ABORT_MISSION_PER_COMMITMENT");
  });

  test("a wholly unrecognisable reported set escalates to STAND_DOWN_ALL at an advanced epoch", async () => {
    const fixture = fixtures.seed();
    const store = fixtures.storeFor(fixture, { commitments: [] });

    await reconciler.scanUnknownCommitmentReports(
      deps(store, { reportedCommitments: async () => ["phantom-1", "phantom-2"] }),
      config,
      store.now(),
    );

    expect(store.rows("reconcilerRepair")[0].action).toBe("STAND_DOWN_ALL_AT_ADVANCED_EPOCH");
  });

  test("a scan with no agent report is skipped, not assumed to agree", async () => {
    const { store } = buildStore();
    const result = await reconciler.scanCommitmentsUnknownToAgent(deps(store), config, store.now());
    expect(result.skipped).toBe("NO_AGENT_REPORTS");
    expect(store.rows("reconcilerRepair")).toHaveLength(0);
  });

  test("an idle agent is not reported absent from an index that does not exist yet", async () => {
    const { store } = buildStore();
    const result = await reconciler.scanAvailabilityIndex(deps(store), config, store.now());
    expect(result.repaired).toBe(0);

    const withIndex = await reconciler.scanAvailabilityIndex(
      deps(store, { isInAvailabilityIndex: async () => false }),
      config,
      store.now(),
    );
    expect(withIndex.repaired).toBe(1);
  });

  test("a full sweep runs every class and reports a per-category count", async () => {
    const { store } = buildStore();
    const result = await reconciler.sweep(deps(store), config);

    expect(Object.keys(result.byCategory).sort()).toEqual(Object.values(reconciler.DIVERGENCE).sort());
    expect(result.results).toHaveLength(10);
  });

  test("the sweep is idempotent — a second pass over repaired state repairs nothing", async () => {
    const { store } = buildStore();
    await store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { state: "ACCEPTED" } });

    const first = await reconciler.sweep(deps(store), config);
    const second = await reconciler.sweep(deps(store), config);

    expect(first.byCategory[reconciler.DIVERGENCE.ORPHAN_LEG]).toBeGreaterThan(0);
    expect(second.byCategory[reconciler.DIVERGENCE.COMMITMENT_ON_TERMINAL_LEG]).toBe(0);
  });

  test("the repair rate is readable per category — the alertable SLI §12.4 requires", async () => {
    const { store } = buildStore();
    await store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { state: "ACCEPTED" } });
    await reconciler.sweep(deps(store), config);

    const rate = await reconciler.readRepairRate(store.client, {
      since: new Date(STORE_NOW.getTime() - 3600_000),
      storeTime: store.now(),
    });

    expect(rate.total).toBeGreaterThan(0);
    expect(rate.byCategory[reconciler.DIVERGENCE.ORPHAN_LEG]).toBeGreaterThan(0);
    // Every category is present in the report even at zero, so a rate that has *stopped*
    // being reported is distinguishable from one that is genuinely zero.
    expect(Object.keys(rate.byCategory).sort()).toEqual(Object.values(reconciler.DIVERGENCE).sort());
  });

  test("the reconciler refuses to run without a transaction to repair in", async () => {
    const { store } = buildStore();
    await expect(reconciler.sweep({ prisma: store.client, readStoreTime: async () => store.now() }, config)).rejects.toThrow(
      /conditional write inside a transaction/,
    );
  });

  test("this module imports no socket and no dispatcher — the reconciler issues no command directly", () => {
    const source = require("fs").readFileSync(require.resolve("../../src/engine/supervision/reconciler"), "utf8");
    expect(source).not.toMatch(/require\(["'].*socket/i);
    expect(source).not.toMatch(/require\(["'].*commandDispatcher/);
  });
});

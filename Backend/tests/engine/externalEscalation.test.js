"use strict";

/**
 * Engine lane — Phase 12: §18.6's external escalation chain.
 *
 * The plan's completion criterion is "external escalation chain implemented with **step 4
 * human-gated**", and that is where most of this file's weight sits. A gate that is a
 * boolean somebody can set is not a gate, so the tests check the stronger property: step 4
 * is unreachable from the automatic path, `confirmEmergencyServices()` refuses without a
 * named operator, and the eligibility check — which automation *is* entitled to run —
 * cannot itself place the call.
 */

const externalEscalation = require("../../src/engine/failure/externalEscalation");
const legMachine = require("../../src/engine/lifecycle/legMachine");

const NOW = 1770000000000;

const obstructingLeg = {
  legId: "LEG-1",
  state: legMachine.LEG_STATE.STRANDED_OBSTRUCTING,
  obstructionClass: "BLOCKING_CRITICAL",
};

const contactSet = externalEscalation.resolveContactSet({
  contacts: {
    "region-1": {
      owner: "Network Operations Manager, South",
      contacts: [{ kind: "HIGHWAYS", endpoint: "https://incidents.example/api" }],
      reviewedAtMs: NOW - 86400000,
    },
  },
  regionId: "region-1",
  nowMs: NOW,
  reviewPeriodSeconds: 7776000,
});

describe("§18.6 — the five steps", () => {
  test("the chain has exactly five steps, with §18.6's timings", () => {
    expect(externalEscalation.STEPS.map((row) => row.step)).toEqual([1, 2, 3, 4, 5]);
    expect(externalEscalation.STEPS.map((row) => row.timing)).toEqual([
      "IMMEDIATE_AUTOMATIC",
      "IMMEDIATE_AUTOMATIC",
      "IMMEDIATE_AUTOMATIC",
      "ON_OPERATOR_CONFIRMATION",
      "CONTINUOUS_UNTIL_CLEARED",
    ]);
  });

  test("steps 1–3 are emitted together, because §18.6 marks all three \"Immediate, automatic\"", () => {
    const outcome = externalEscalation.openChain({ leg: obstructingLeg, context: {}, contactSet, atMs: NOW });
    expect(outcome.opened).toBe(true);
    expect(outcome.steps.map((row) => row.step)).toEqual([1, 2, 3]);
    // A chain that performed them in sequence with a gap would have invented a delay the
    // specification does not have.
    expect(new Set(outcome.steps.map((row) => row.atMs))).toEqual(new Set([NOW]));
  });

  test("step 1 carries every field §18.6 enumerates, and names the ones it could not fill", () => {
    const complete = externalEscalation.openChain({
      leg: obstructingLeg,
      contactSet,
      atMs: NOW,
      context: {
        position: { lat: 51.5, lon: -0.1 },
        custodyManifest: { items: 2 },
        agentCondition: "IMMOBILISED",
        hazardState: externalEscalation.HAZARD_STATE.SEVERE,
        physicalAccessInstructions: "Service gate 4, keypad 8812",
      },
    });
    expect(complete.steps[0].missingFields).toEqual([]);

    // A page that omits the custody manifest sends a responder to goods they were not told
    // about; one that omits access instructions sends them to a locked compound. Both are
    // reported rather than silently absent.
    const thin = externalEscalation.openChain({ leg: obstructingLeg, contactSet, atMs: NOW, context: {} });
    expect(thin.steps[0].missingFields.sort()).toEqual(
      ["agentCondition", "custodyManifest", "physicalAccessInstructions", "position"].sort(),
    );
  });

  test("step 2 writes the obstacle to the knowledge base, which is what re-plans other missions", () => {
    const outcome = externalEscalation.openChain({
      leg: obstructingLeg,
      contactSet,
      atMs: NOW,
      context: { segmentId: "SEG-9", affectedMissionIds: ["MSN-2", "MSN-3"] },
    });
    expect(outcome.steps[1].payload.writeObstacleToKnowledgeBase).toBe(true);
    expect(outcome.steps[1].payload.affectedMissionIds).toEqual(["MSN-2", "MSN-3"]);
  });

  test("the chain refuses to open for a Leg that is not STRANDED_OBSTRUCTING", () => {
    // Paging a responder and notifying an infrastructure operator about an agent on a verge
    // is the false positive that erodes the path before the real incident arrives.
    const outcome = externalEscalation.openChain({
      leg: { ...obstructingLeg, state: legMachine.LEG_STATE.STRANDED_SAFE },
      contactSet,
      atMs: NOW,
      context: {},
    });
    expect(outcome.opened).toBe(false);
    expect(outcome.steps).toEqual([]);
    expect(outcome.reason).toMatch(/erodes the path before the real incident arrives/);
  });

  test("opening the chain produces the dashboard event, marked as emergency-services-gated", () => {
    const outcome = externalEscalation.openChain({ leg: obstructingLeg, contactSet, atMs: NOW, context: {} });
    expect(outcome.socket.event).toBe("STRANDING_ESCALATED");
    expect(outcome.socket.payload.stepsEmitted).toEqual([1, 2, 3]);
    expect(outcome.socket.payload.emergencyServicesGated).toBe(true);
  });
});

describe("§18.6 step 4 — the human gate", () => {
  const threshold = { obstructionClasses: ["BLOCKING_CRITICAL"], hazardStates: ["SEVERE"] };

  test("step 4 is unreachable from the automatic path, structurally", () => {
    expect(externalEscalation.assertStepFourIsUnreachable()).toEqual({ ok: true, problems: [] });
    expect(externalEscalation.AUTOMATIC_STEPS).not.toContain(externalEscalation.STEP.CONTACT_EMERGENCY_SERVICES);
  });

  test("no argument to openChain can produce step 4", () => {
    // Threshold met, hazard severe, contact set configured — everything that would justify
    // the call — and the automatic chain still stops at step 3.
    const outcome = externalEscalation.openChain({
      leg: obstructingLeg,
      contactSet,
      atMs: NOW,
      context: { hazardState: externalEscalation.HAZARD_STATE.SEVERE, force: true, autoEscalate: true, threshold },
    });
    expect(outcome.steps.map((row) => row.step)).not.toContain(4);
  });

  test("eligibility requires both the obstruction class and the hazard state", () => {
    // §18.6: "where the obstruction class **and** hazard state meet the configured
    // threshold". Both, not either.
    expect(
      externalEscalation.emergencyServicesEligible({ obstructionClass: "BLOCKING_CRITICAL", hazardState: "SEVERE", threshold }).eligible,
    ).toBe(true);
    expect(
      externalEscalation.emergencyServicesEligible({ obstructionClass: "RESTRICTIVE", hazardState: "SEVERE", threshold }).eligible,
    ).toBe(false);
    expect(
      externalEscalation.emergencyServicesEligible({ obstructionClass: "BLOCKING_CRITICAL", hazardState: "NONE", threshold }).eligible,
    ).toBe(false);
  });

  test("an unknown hazard state alongside a qualifying class resolves toward offering the step", () => {
    // The same asymmetry §4.3 applies to an unknown obstruction class: the cost of
    // over-offering is one declined prompt; the cost of under-offering is the incident.
    const outcome = externalEscalation.emergencyServicesEligible({
      obstructionClass: "BLOCKING_CRITICAL",
      hazardState: externalEscalation.HAZARD_STATE.UNKNOWN,
      threshold,
    });
    expect(outcome.eligible).toBe(true);
    expect(outcome.disposition).toBe(externalEscalation.DISPOSITION.AWAITING_OPERATOR);
  });

  test("with no configured threshold, nothing is offered automatically", () => {
    const outcome = externalEscalation.emergencyServicesEligible({ obstructionClass: "BLOCKING_CRITICAL", hazardState: "SEVERE", threshold: null });
    expect(outcome.eligible).toBe(false);
    expect(outcome.reason).toMatch(/The operator may still escalate/);
  });

  test("confirming without a named operator throws — a call with no confirming human has no gate", () => {
    expect(() =>
      externalEscalation.confirmEmergencyServices({ operator: {}, confirmed: true, atMs: NOW }),
    ).toThrow(/requires a named operator/);
    expect(() =>
      externalEscalation.confirmEmergencyServices({ confirmed: true, atMs: NOW }),
    ).toThrow(/deliberately human-gated/);
  });

  test("an operator's confirmation contacts, and their refusal is recorded rather than discarded", () => {
    const eligibility = externalEscalation.emergencyServicesEligible({ obstructionClass: "BLOCKING_CRITICAL", hazardState: "SEVERE", threshold });

    const confirmed = externalEscalation.confirmEmergencyServices({
      operator: { operatorId: "OPS-14", role: "DUTY_MANAGER" },
      eligibility,
      confirmed: true,
      atMs: NOW,
      reason: "vehicle on the tram crossing, service suspended",
    });
    expect(confirmed.contacted).toBe(true);
    expect(confirmed.disposition).toBe(externalEscalation.DISPOSITION.CONFIRMED_BY_OPERATOR);
    expect(confirmed.operatorId).toBe("OPS-14");
    expect(confirmed.metConfiguredThreshold).toBe(true);

    const declined = externalEscalation.confirmEmergencyServices({
      operator: { operatorId: "OPS-14" },
      eligibility,
      confirmed: false,
      atMs: NOW,
      reason: "site security is already on scene",
    });
    expect(declined.contacted).toBe(false);
    expect(declined.disposition).toBe(externalEscalation.DISPOSITION.DECLINED_BY_OPERATOR);
    expect(declined.reason).toMatch(/site security/);
  });

  test("an operator may escalate past a threshold that did not anticipate the situation", () => {
    // And the divergence between the automatic judgement and the human one is recorded,
    // because it is a signal about the threshold rather than an error.
    const outcome = externalEscalation.confirmEmergencyServices({
      operator: { operatorId: "OPS-14" },
      eligibility: { eligible: false },
      confirmed: true,
      atMs: NOW,
    });
    expect(outcome.contacted).toBe(true);
    expect(outcome.metConfiguredThreshold).toBe(false);
  });
});

describe("§18.6 — the contact set and its review state", () => {
  test("a configured, recently reviewed set emits with its named owner", () => {
    expect(contactSet.configured).toBe(true);
    expect(contactSet.ownerNamed).toBe(true);
    expect(contactSet.reviewed).toBe(true);
    expect(contactSet.disposition).toBe(externalEscalation.DISPOSITION.EMITTED);
  });

  test("an unreviewed set still emits, and the staleness is recorded beside it", () => {
    // "An unreviewed contact list is the most common way a correctly-designed escalation
    // path fails in practice." Reporting success into a list nobody has checked is worse
    // than reporting the staleness.
    const stale = externalEscalation.resolveContactSet({
      contacts: { "region-1": { owner: "Ops", contacts: [], reviewedAtMs: NOW - 400 * 86400000 } },
      regionId: "region-1",
      nowMs: NOW,
      reviewPeriodSeconds: 7776000,
    });
    expect(stale.reviewed).toBe(false);
    expect(stale.disposition).toBe(externalEscalation.DISPOSITION.CONTACT_SET_UNREVIEWED);
    expect(stale.detail).toMatch(/most common way a correctly-designed escalation path fails/);

    const outcome = externalEscalation.openChain({ leg: obstructingLeg, contactSet: stale, atMs: NOW, context: {} });
    expect(outcome.steps[2].disposition).toBe(externalEscalation.DISPOSITION.CONTACT_SET_UNREVIEWED);
    expect(outcome.steps[2].payload.contactSetReviewed).toBe(false);
  });

  test("an unconfigured region records the absence rather than silently doing nothing", () => {
    const absent = externalEscalation.resolveContactSet({ contacts: null, regionId: "region-9", nowMs: NOW });
    expect(absent.configured).toBe(false);
    expect(absent.disposition).toBe(externalEscalation.DISPOSITION.NO_CONTACT_CONFIGURED);

    const outcome = externalEscalation.openChain({ leg: obstructingLeg, contactSet: absent, atMs: NOW, context: {} });
    // Steps 1 and 2 still run: the responder is still paged and the other missions are
    // still re-planned. Only step 3 has nowhere to go, and it says so.
    expect(outcome.steps[0].disposition).toBe(externalEscalation.DISPOSITION.EMITTED);
    expect(outcome.steps[2].disposition).toBe(externalEscalation.DISPOSITION.NO_CONTACT_CONFIGURED);
  });

  test("a set with no named owner is reported as such", () => {
    const unowned = externalEscalation.resolveContactSet({
      contacts: { "region-1": { contacts: [], reviewedAtMs: NOW } },
      regionId: "region-1",
      nowMs: NOW,
    });
    expect(unowned.ownerNamed).toBe(false);
    expect(unowned.owner).toBeNull();
  });
});

describe("§18.6 step 5 — continuous until cleared", () => {
  test("a de-escalation closes the chain and moves the response target with the class", () => {
    const outcome = externalEscalation.reEvaluate({
      legId: "LEG-1",
      currentClass: "BLOCKING_CRITICAL",
      hazardData: { obstructionClass: "CLEAR", observedAtMs: NOW - 100 },
      nowMs: NOW,
      maxAgeSeconds: 300,
      atMs: NOW,
    });
    expect(outcome.chainContinues).toBe(false);
    expect(outcome.disposition).toBe(externalEscalation.DISPOSITION.DE_ESCALATED);
    expect(outcome.responseTargetParameter).toBe("ops.stranded_safe_response_target");
  });

  test("an unchanged obstructing class keeps the chain open", () => {
    const outcome = externalEscalation.reEvaluate({
      legId: "LEG-1",
      currentClass: "BLOCKING_CRITICAL",
      hazardData: { obstructionClass: "BLOCKING_CRITICAL", observedAtMs: NOW - 100 },
      nowMs: NOW,
      maxAgeSeconds: 300,
      atMs: NOW,
    });
    expect(outcome.chainContinues).toBe(true);
    expect(outcome.disposition).toBe(externalEscalation.DISPOSITION.EMITTED);
  });

  test("losing map data mid-incident does not close the chain", () => {
    const outcome = externalEscalation.reEvaluate({
      legId: "LEG-1",
      currentClass: "BLOCKING_CRITICAL",
      hazardData: null,
      nowMs: NOW,
      maxAgeSeconds: 300,
      atMs: NOW,
    });
    expect(outcome.chainContinues).toBe(true);
  });
});

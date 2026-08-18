"use strict";

/**
 * External escalation for obstructing strandings (§18.6) — **Tier 0**, mechanism T0-10.
 * Invariant I22.
 *
 * > `STRANDED_OBSTRUCTING` (§4.3) is the one state in this design whose response chain
 * > extends **outside the operator**. It therefore has its own specified path, because a
 * > chain that is improvised during a live carriageway blockage is not a chain.
 *
 * The five steps are declared as data with their timing, and `openChain()` emits the three
 * automatic ones together — because §18.6 marks steps 1, 2 and 3 "Immediate, automatic",
 * and a chain that performed them in sequence with a gap between each would have invented
 * a delay the specification does not have.
 *
 * ── Step 4 is human-gated, and the gate is structural ──────────────────────
 * > **This step is deliberately human-gated**: automatic calls to emergency services are
 * > not an appropriate output of an allocation engine, and a false positive has real
 * > external cost.
 *
 * `openChain()` cannot produce step 4. It is unreachable from that function — not
 * defaulted off, not behind a flag, not conditional on a threshold. The *only* way to
 * reach it is `confirmEmergencyServices()`, which requires a named operator, and which
 * refuses without one. A flag would be a gate somebody can set; an absent code path is
 * not.
 *
 * The configured threshold does not open step 4 either. It decides whether step 4 is
 * *offered* to the operator — `emergencyServicesEligible()` — which is the part automation
 * is entitled to do: noticing that the situation qualifies, and putting the decision in
 * front of a person quickly.
 *
 * ── The contact set is configuration with an owner, and its absence is a finding ─
 * > The escalation contact set is per-region configuration with a named owner, reviewed on
 * > the same cadence as the safety case (§24.7). **An unreviewed contact list is the most
 * > common way a correctly-designed escalation path fails in practice.**
 *
 * `resolveContactSet()` therefore returns the contacts *and* the review state, and step 3
 * records `contactSetUnreviewed` rather than silently emitting into a list nobody has
 * checked since commissioning. A chain that reported success into a disconnected number is
 * worse than one that reported it could not find a contact.
 *
 * ── Step 5 is a loop, not a step ────────────────────────────────────────────
 * "Continuous until cleared" is implemented as `reEvaluate()`, driven by the invariant
 * worker's sweep, delegating the classification itself to `map/obstructionClass.js`.
 *
 * No clock: every step's time is supplied.
 */

const obstructionClass = require("../map/obstructionClass");
const legMachine = require("../lifecycle/legMachine");

/**
 * The dashboard-facing socket event for an escalation (plan row "Socket.IO changes").
 * @structural the wire event name
 */
const SOCKET_EVENT = "STRANDING_ESCALATED";

/**
 * §18.6's five steps.
 * @structural the specification's own step ordinals
 */
const STEP = Object.freeze({
  PAGE_RESPONDER: 1,
  NOTIFY_AFFECTED_MISSIONS: 2, // @structural §18.6's own step ordinal
  NOTIFY_INFRASTRUCTURE_OPERATOR: 3, // @structural §18.6's own step ordinal
  CONTACT_EMERGENCY_SERVICES: 4, // @structural §18.6's own step ordinal
  RE_EVALUATE: 5, // @structural §18.6's own step ordinal
});

/**
 * The timing column of §18.6, per step.
 * @structural §18.6's own timing vocabulary
 */
const TIMING = Object.freeze({
  IMMEDIATE_AUTOMATIC: "IMMEDIATE_AUTOMATIC",
  ON_OPERATOR_CONFIRMATION: "ON_OPERATOR_CONFIRMATION",
  CONTINUOUS_UNTIL_CLEARED: "CONTINUOUS_UNTIL_CLEARED",
});

/**
 * The five rows, with the property that matters most on each: which are automatic.
 */
const STEPS = Object.freeze([
  Object.freeze({
    step: STEP.PAGE_RESPONDER,
    timing: TIMING.IMMEDIATE_AUTOMATIC,
    automatic: true,
    humanGated: false,
    action:
      "page the on-call operations responder with position, obstruction class, custody manifest, agent " +
      "condition, hazard state, and physical access instructions",
  }),
  Object.freeze({
    step: STEP.NOTIFY_AFFECTED_MISSIONS,
    timing: TIMING.IMMEDIATE_AUTOMATIC,
    automatic: true,
    humanGated: false,
    action:
      "notify every other mission routed through the affected segment; the obstacle is written to the " +
      "knowledge base so the router avoids it and other agents are re-planned (§18.2 A8)",
  }),
  Object.freeze({
    step: STEP.NOTIFY_INFRASTRUCTURE_OPERATOR,
    timing: TIMING.IMMEDIATE_AUTOMATIC,
    automatic: true,
    humanGated: false,
    action:
      "where the site or jurisdiction is configured with one, emit a machine-readable incident " +
      "notification to the responsible infrastructure operator — rail, tram, highways, or site security",
  }),
  Object.freeze({
    step: STEP.CONTACT_EMERGENCY_SERVICES,
    timing: TIMING.ON_OPERATOR_CONFIRMATION,
    automatic: false,
    humanGated: true,
    action:
      "contact emergency services where the obstruction class and hazard state meet the configured " +
      "threshold. This step is deliberately human-gated: automatic calls to emergency services are not an " +
      "appropriate output of an allocation engine, and a false positive has real external cost",
  }),
  Object.freeze({
    step: STEP.RE_EVALUATE,
    timing: TIMING.CONTINUOUS_UNTIL_CLEARED,
    automatic: true,
    humanGated: false,
    action:
      "re-evaluate obstruction class as position or map data changes; de-escalate to STRANDED_SAFE if the " +
      "agent is moved clear (§4.4)",
  }),
]);

/**
 * The steps `openChain()` performs. Step 4 is absent by construction, and
 * `assertStepFourIsUnreachable()` proves the absence rather than asserting the intent.
 * @structural the automatic prefix of §18.6
 */
const AUTOMATIC_STEPS = Object.freeze([
  STEP.PAGE_RESPONDER,
  STEP.NOTIFY_AFFECTED_MISSIONS,
  STEP.NOTIFY_INFRASTRUCTURE_OPERATOR,
]);

/**
 * How a step's attempt ended, as recorded on the `ExternalEscalation` row.
 * @structural disposition labels
 */
const DISPOSITION = Object.freeze({
  EMITTED: "EMITTED",
  NO_CONTACT_CONFIGURED: "NO_CONTACT_CONFIGURED",
  CONTACT_SET_UNREVIEWED: "CONTACT_SET_UNREVIEWED",
  AWAITING_OPERATOR: "AWAITING_OPERATOR",
  CONFIRMED_BY_OPERATOR: "CONFIRMED_BY_OPERATOR",
  DECLINED_BY_OPERATOR: "DECLINED_BY_OPERATOR",
  DE_ESCALATED: "DE_ESCALATED",
  CLEARED: "CLEARED",
});

/**
 * The hazard states §18.6 step 4's threshold is expressed over. `UNKNOWN` is a real value
 * and resolves toward eligibility, matching §4.3's treatment of an unknown obstruction
 * class: the cost of over-offering step 4 to an operator is one declined prompt.
 * @structural the hazard vocabulary §18.6 step 4's threshold is stated over
 */
const HAZARD_STATE = Object.freeze({
  NONE: "NONE",
  ELEVATED: "ELEVATED",
  SEVERE: "SEVERE",
  UNKNOWN: "UNKNOWN",
});

/**
 * Resolve the per-region contact set, and report its review state.
 *
 * @param {object} input
 * @param {object|null} input.contacts the resolved `ops.external_escalation_contacts` map
 * @param {string} input.regionId
 * @param {number} [input.nowMs]
 * @param {number} [input.reviewPeriodSeconds] `ops.escalation_contact_review_period`
 * @returns {object}
 */
function resolveContactSet(input) {
  const source = input || {};
  const all = source.contacts && typeof source.contacts === "object" ? source.contacts : null;
  const region = all ? all[String(source.regionId)] : null;

  if (!region) {
    return Object.freeze({
      configured: false,
      regionId: source.regionId ?? null,
      owner: null,
      contacts: [],
      reviewedAtMs: null,
      reviewed: false,
      disposition: DISPOSITION.NO_CONTACT_CONFIGURED,
      detail:
        "no external escalation contact set is configured for this region. §18.6 step 3 emits only " +
        "\"where the site or jurisdiction is configured with one\"; the absence is recorded so it is a " +
        "finding rather than a silent no-op.",
    });
  }

  const reviewedAtMs = Number.isFinite(region.reviewedAtMs) ? region.reviewedAtMs : null;
  const stale =
    Number.isFinite(source.reviewPeriodSeconds) &&
    source.reviewPeriodSeconds > 0 &&
    Number.isFinite(source.nowMs) &&
    (reviewedAtMs === null || source.nowMs - reviewedAtMs > source.reviewPeriodSeconds * MS_PER_SECOND);

  return Object.freeze({
    configured: true,
    regionId: String(source.regionId),
    // §18.6 requires a *named* owner. An owner-less contact set is the unreviewed list the
    // section closes by warning about, already halfway to failing.
    owner: region.owner ?? null,
    contacts: Array.isArray(region.contacts) ? [...region.contacts] : [],
    reviewedAtMs,
    reviewed: !stale,
    disposition: stale ? DISPOSITION.CONTACT_SET_UNREVIEWED : DISPOSITION.EMITTED,
    detail: stale
      ? "the contact set has not been reviewed within ops.escalation_contact_review_period. §18.6: \"An " +
        "unreviewed contact list is the most common way a correctly-designed escalation path fails in " +
        "practice.\" The notification is still emitted; the staleness is recorded beside it."
      : null,
    ownerNamed: Boolean(region.owner),
  });
}

/** @structural milliseconds per second */
const MS_PER_SECOND = 1000;

/**
 * §18.6 steps 1–3 — the automatic chain, emitted together.
 *
 * Refuses to open for a Leg that is not `STRANDED_OBSTRUCTING`. §18.6 is the response
 * chain for one state, and opening it for a `STRANDED_SAFE` Leg would page a responder and
 * notify an infrastructure operator about an agent standing on a verge — which is exactly
 * the false positive that erodes an escalation path's credibility before the real one
 * arrives.
 *
 * @param {object} input
 * @param {{ legId: string, state: string, obstructionClass: string }} input.leg
 * @param {object} input.context position, custody manifest, agent condition, hazard state, access instructions
 * @param {object} input.contactSet from `resolveContactSet()`
 * @param {number} input.atMs
 * @returns {{ opened: boolean, reason: string|null, steps: object[], socket: object|null }}
 */
function openChain(input) {
  const source = input || {};
  const leg = source.leg || {};

  if (leg.state !== legMachine.LEG_STATE.STRANDED_OBSTRUCTING) {
    return {
      opened: false,
      reason:
        `the §18.6 chain opens for STRANDED_OBSTRUCTING and this Leg is ${String(leg.state)}. Paging a ` +
        "responder and notifying an infrastructure operator about a stranding that obstructs nothing is " +
        "the false positive that erodes the path before the real incident arrives.",
      steps: [],
      socket: null,
    };
  }

  const context = source.context || {};
  const contactSet = source.contactSet || { configured: false, contacts: [], disposition: DISPOSITION.NO_CONTACT_CONFIGURED };

  const steps = [
    {
      step: STEP.PAGE_RESPONDER,
      atMs: source.atMs,
      disposition: DISPOSITION.EMITTED,
      // Every field §18.6 step 1 enumerates, carried explicitly. A page that omits the
      // custody manifest sends a responder to goods they were not told about, and one that
      // omits access instructions sends them to a locked compound.
      payload: {
        position: context.position ?? null,
        obstructionClass: leg.obstructionClass ?? null,
        custodyManifest: context.custodyManifest ?? null,
        agentCondition: context.agentCondition ?? null,
        hazardState: context.hazardState ?? HAZARD_STATE.UNKNOWN,
        physicalAccessInstructions: context.physicalAccessInstructions ?? null,
      },
      missingFields: [
        ["position", context.position],
        ["custodyManifest", context.custodyManifest],
        ["agentCondition", context.agentCondition],
        ["physicalAccessInstructions", context.physicalAccessInstructions],
      ]
        .filter(([, value]) => value === undefined || value === null)
        .map(([name]) => name),
    },
    {
      step: STEP.NOTIFY_AFFECTED_MISSIONS,
      atMs: source.atMs,
      disposition: DISPOSITION.EMITTED,
      payload: {
        segmentId: context.segmentId ?? null,
        affectedMissionIds: Array.isArray(context.affectedMissionIds) ? [...context.affectedMissionIds] : [],
        // §18.2 A8's second half: the obstacle enters the knowledge base so the router
        // avoids it, which is what re-plans the other missions rather than merely warning
        // about them.
        writeObstacleToKnowledgeBase: true,
      },
    },
    {
      step: STEP.NOTIFY_INFRASTRUCTURE_OPERATOR,
      atMs: source.atMs,
      disposition: contactSet.configured
        ? contactSet.disposition
        : DISPOSITION.NO_CONTACT_CONFIGURED,
      payload: {
        regionId: contactSet.regionId ?? null,
        owner: contactSet.owner ?? null,
        contacts: contactSet.contacts ?? [],
        contactSetReviewed: contactSet.reviewed === true,
      },
      detail: contactSet.detail ?? null,
    },
  ];

  return {
    opened: true,
    reason: null,
    steps,
    socket: {
      event: SOCKET_EVENT,
      payload: {
        legId: leg.legId ?? null,
        obstructionClass: leg.obstructionClass ?? null,
        legState: leg.state,
        hazardState: context.hazardState ?? HAZARD_STATE.UNKNOWN,
        stepsEmitted: AUTOMATIC_STEPS,
        emergencyServicesGated: true,
        at: source.atMs,
      },
    },
  };
}

/**
 * §18.6 step 4's threshold — is the situation *eligible* for emergency services?
 *
 * Eligibility is not confirmation. This function decides whether to put the decision in
 * front of a person; only `confirmEmergencyServices()` acts on it.
 *
 * @param {object} input
 * @param {string} input.obstructionClass
 * @param {string} input.hazardState
 * @param {{ obstructionClasses?: string[], hazardStates?: string[] }|null} input.threshold
 *   the resolved `ops.emergency_services_hazard_threshold`
 * @returns {{ eligible: boolean, reason: string, disposition: string }}
 */
function emergencyServicesEligible(input) {
  const source = input || {};
  const threshold = source.threshold || null;

  if (!threshold) {
    return {
      eligible: false,
      disposition: DISPOSITION.NO_CONTACT_CONFIGURED,
      reason:
        "ops.emergency_services_hazard_threshold is unconfigured, so no situation meets \"the configured " +
        "threshold\". The operator may still escalate; what is absent is the automatic offer.",
    };
  }

  const classes = Array.isArray(threshold.obstructionClasses) ? threshold.obstructionClasses : [];
  const hazards = Array.isArray(threshold.hazardStates) ? threshold.hazardStates : [];

  // §18.6 states the threshold over *both* — "where the obstruction class **and** hazard
  // state meet the configured threshold" — so both must be met, not either.
  const classMet = classes.includes(source.obstructionClass);
  const hazardMet =
    hazards.includes(source.hazardState) ||
    // An unknown hazard state alongside a qualifying obstruction class resolves toward
    // offering the step, matching §4.3's treatment of an unknown class. The cost of
    // over-offering is one declined prompt; the cost of under-offering is the incident.
    (source.hazardState === HAZARD_STATE.UNKNOWN && hazards.length > 0);

  const eligible = classMet && hazardMet;

  return {
    eligible,
    disposition: eligible ? DISPOSITION.AWAITING_OPERATOR : DISPOSITION.EMITTED,
    reason: eligible
      ? "the obstruction class and hazard state meet the configured threshold; step 4 is offered to the " +
        "on-call operator for confirmation (§18.6)"
      : `not eligible: obstruction class ${classMet ? "meets" : "does not meet"} the threshold and hazard ` +
        `state ${hazardMet ? "meets" : "does not meet"} it. §18.6 requires both.`,
  };
}

/**
 * §18.6 step 4 — the human-gated call, performed only on an operator's confirmation.
 *
 * The gate is the signature of this function: it takes an operator identity and refuses
 * without one. There is no `force`, no `auto`, and no threshold argument that could reach
 * the emitting branch.
 *
 * @param {object} input
 * @param {{ operatorId: string, role?: string }} input.operator
 * @param {object} input.eligibility from `emergencyServicesEligible()`
 * @param {boolean} input.confirmed the operator's decision
 * @param {string} [input.reason] the operator's stated reason
 * @param {number} input.atMs
 * @returns {object}
 */
function confirmEmergencyServices(input) {
  const source = input || {};
  const operator = source.operator || {};

  // Presence, not truthiness. `!operator.operatorId` also rejected a legitimate numeric id of
  // `0`; that failed closed — an over-refusal, never an unauthorised call — but a gate that
  // refuses a valid operator is a gate somebody works around under pressure, which is the one
  // way this particular gate fails.
  if (operator.operatorId === undefined || operator.operatorId === null || operator.operatorId === "") {
    throw new TypeError(
      "§18.6 step 4 requires a named operator. Automatic calls to emergency services are not an appropriate " +
        "output of an allocation engine, and a false positive has real external cost. This step is " +
        "deliberately human-gated; a call with no confirming human has no gate.",
    );
  }

  if (source.confirmed !== true) {
    return Object.freeze({
      step: STEP.CONTACT_EMERGENCY_SERVICES,
      contacted: false,
      disposition: DISPOSITION.DECLINED_BY_OPERATOR,
      operatorId: operator.operatorId,
      operatorRole: operator.role ?? null,
      atMs: source.atMs,
      reason: source.reason ?? "the operator did not confirm emergency services",
    });
  }

  return Object.freeze({
    step: STEP.CONTACT_EMERGENCY_SERVICES,
    contacted: true,
    disposition: DISPOSITION.CONFIRMED_BY_OPERATOR,
    operatorId: operator.operatorId,
    operatorRole: operator.role ?? null,
    atMs: source.atMs,
    // Recorded even when the automatic eligibility said no: an operator is entitled to
    // escalate a situation the threshold did not anticipate, and the divergence between
    // the two is a signal about the threshold.
    metConfiguredThreshold: Boolean(source.eligibility && source.eligibility.eligible),
    reason: source.reason ?? "operator-confirmed emergency services contact (§18.6 step 4)",
  });
}

/**
 * §18.6 step 5 — re-evaluate, and close the chain if the agent is moved clear.
 *
 * @param {object} input as `map/obstructionClass.reclassify`, plus `{ legId, atMs }`
 * @returns {object}
 */
function reEvaluate(input) {
  const source = input || {};
  const result = obstructionClass.reclassify(source);

  const cleared = result.after.legState === legMachine.LEG_STATE.STRANDED_SAFE;

  return Object.freeze({
    step: STEP.RE_EVALUATE,
    legId: source.legId ?? null,
    atMs: source.atMs ?? null,
    reclassification: result,
    chainContinues: !cleared,
    disposition: cleared
      ? result.deEscalated
        ? DISPOSITION.DE_ESCALATED
        : DISPOSITION.CLEARED
      : DISPOSITION.EMITTED,
    // The response target moves with the class: a de-escalated stranding is answered on
    // the operations queue's target rather than the obstructing one's (§4.3).
    responseTargetParameter: result.after.responseTargetParameter,
    reason: result.reason,
  });
}

/**
 * Prove step 4 is unreachable from the automatic path.
 *
 * A test could assert that `openChain()` happens not to emit step 4 today. This asserts
 * the stronger property: the automatic step list does not contain it, so a future edit
 * that added it would fail here rather than quietly shipping an engine that calls
 * emergency services on its own judgement.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
function assertStepFourIsUnreachable() {
  const problems = [];

  if (AUTOMATIC_STEPS.includes(STEP.CONTACT_EMERGENCY_SERVICES)) {
    problems.push(
      "step 4 appears in the automatic step list. §18.6 makes it \"deliberately human-gated\"; an automatic " +
        "call to emergency services is not an appropriate output of an allocation engine.",
    );
  }

  const declared = STEPS.find((row) => row.step === STEP.CONTACT_EMERGENCY_SERVICES);
  if (!declared || declared.humanGated !== true || declared.automatic !== false) {
    problems.push("§18.6 step 4 is not declared human-gated in the step table");
  }

  for (const step of AUTOMATIC_STEPS) {
    const row = STEPS.find((entry) => entry.step === step);
    if (!row || row.timing !== TIMING.IMMEDIATE_AUTOMATIC) {
      problems.push(`step ${step} is in the automatic list but is not declared "Immediate, automatic"`);
    }
  }

  return { ok: problems.length === 0, problems };
}

module.exports = {
  SOCKET_EVENT,
  STEP,
  STEPS,
  TIMING,
  AUTOMATIC_STEPS,
  DISPOSITION,
  HAZARD_STATE,
  resolveContactSet,
  openChain,
  emergencyServicesEligible,
  confirmEmergencyServices,
  reEvaluate,
  assertStepFourIsUnreachable,
};

"use strict";

/**
 * Engine lane — Phase 5: §4.5's expiry semantics (`supervision/expiryActions.js`).
 *
 * ── The defect these exist for ─────────────────────────────────────────────
 * Seventeen "on expiry" actions are declared across §4.3's and §4.2's deadline columns.
 * Until this remediation **none had an implementation anywhere under `src/`**: the timer
 * store registered them, the timer worker selected them when they came due, and the
 * handler map the worker requires had no producer, so the worker was refused composition
 * and no shard had a supervisor.
 *
 * The suite is organised around the three properties the module promises, because those
 * are the ones a future edit can quietly break:
 *
 *   1. every declared action has a handler, **derived** from the machines rather than
 *      listed, so a new §4.3 state cannot arrive with a deadline nobody owns;
 *   2. a transition is *attempted* through §4.4's table and its guards, never written;
 *   3. an absent collaborator refuses **by name** and never resolves into a default —
 *      most sharply for the §17.4 ladder, where the wrong default fails a customer's Leg.
 *
 * The end-to-end proof — a deadline passing against real PostgreSQL and a real state
 * change following — is `tools/verify/phase5ExpirySemantics.js`, 97 checks. These pin the
 * decisions; that proves the path.
 */

const custody = require("../../src/engine/domain/custody");
const expiryActions = require("../../src/engine/supervision/expiryActions");
const legMachine = require("../../src/engine/lifecycle/legMachine");
const taskMachine = require("../../src/engine/lifecycle/taskMachine");
const timers = require("../../src/engine/supervision/timers");
const transitions = require("../../src/engine/lifecycle/transitions");

const fixtures = require("./helpers/dispatchFixture");

const STORE_NOW = fixtures.seed().now;

/** The config the production composer builds, with every deadline resolvable. */
const CONFIG = Object.freeze({
  deadlineSecondsFor: (entityType, state) => {
    const spec = entityType === "TASK" ? taskMachine.deadlineFor(state) : legMachine.deadlineFor(state);
    if (!spec || spec.projected === true) return undefined;
    return 600;
  },
  maxReassignmentsPerLeg: 3,
  incumbentCooloffSeconds: 300,
  reassignBudgetSeconds: 600,
  maxDeliveryDelaySeconds: 5,
  nackCooloffSeconds: 60,
  etaTolerance: 1.3,
  signingKey: "phase5-unit-test-signing-key-0123456789ab",
  regionId: "region-1",
});

/** A due timer row, as the store would have written it. */
function timerFor(leg, overrides) {
  const spec = legMachine.deadlineFor(leg.state);
  return {
    id: `timer-${leg.state}`,
    timerKey: `LEG:${leg.id}:${leg.state}:${leg.version}:${spec.onExpiry}`,
    entityType: "LEG",
    entityId: leg.id,
    state: leg.state,
    entityVersion: BigInt(leg.version),
    dueAt: new Date(STORE_NOW.getTime() - 1000),
    createdAt: new Date(STORE_NOW.getTime() - 601_000),
    handler: spec.onExpiry,
    payload: { armedSeconds: 600 },
    timerState: "PENDING",
    attempts: 0,
    shardId: "shard-1",
    ...(overrides || {}),
  };
}

/** Run one handler inside a real transaction against the store model. */
async function fire(store, leg, options) {
  const settings = options || {};
  const map = expiryActions.handlers(settings.deps || {});
  const timer = timerFor(leg, settings.timer);
  const events = [];

  const result = await store.client.$transaction((tx) =>
    map[timer.handler]({
      tx,
      prisma: store.client,
      timer,
      entity: leg,
      storeTime: store.now(),
      config: { ...CONFIG, ...(settings.config || {}) },
      record: (event, detail) => events.push({ event, detail }),
    }),
  );

  return { result, events, after: await store.client.leg.findUnique({ where: { id: leg.id } }) };
}

async function legIn(store, state, overrides) {
  await store.client.leg.update({
    where: { id: fixtures.LEG_ROW_ID },
    data: { state, ...(overrides || {}) },
  });
  return store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } });
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. Completeness — derived from the machines, never listed
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§4.5 — every declared expiry action has an implementation", () => {
  test("the declared set is derived from §4.2's and §4.3's own deadline tables", () => {
    const declared = expiryActions.declaredActions();

    // Not a hand-written list: every Leg state with a deadline, every Task state with one,
    // and the commitment lease. A state added later appears here without anyone editing
    // this module, which is the property that makes the completeness check meaningful.
    for (const [state, deadline] of Object.entries(legMachine.LEG_DEADLINES)) {
      if (!deadline) continue;
      expect(declared).toContainEqual({
        entityType: "LEG",
        state,
        action: deadline.onExpiry,
        parameter: deadline.parameter,
      });
    }
    for (const [state, deadline] of Object.entries(taskMachine.TASK_DEADLINES)) {
      if (!deadline) continue;
      expect(declared).toContainEqual({
        entityType: "TASK",
        state,
        action: deadline.onExpiry,
        parameter: deadline.parameter,
      });
    }
    expect(declared).toContainEqual({
      entityType: "COMMITMENT",
      state: "*",
      action: "LEASE_EXPIRY_RECOVERY",
      parameter: "lease.duration",
    });
  });

  test("the handler map covers every one of them, and declares none they do not", () => {
    expect(expiryActions.assertComplete(expiryActions.handlers({}))).toEqual({
      ok: true,
      missing: [],
      unexpected: [],
    });
  });

  test("the seventeen are named, so a change to the count is a change to this test", () => {
    // The number is not magic: it is what §4.3's twelve distinct actions, §4.2's four that
    // §4.3 does not also declare, and the commitment lease come to. Pinned because the
    // finding this module answers was stated as a count, and a silent drift in it would be
    // the same finding returning.
    expect(expiryActions.declaredActionNames()).toEqual([
      "DECOMPOSITION_STALLED",
      "ESCALATE",
      "ESCALATION_LADDER",
      "FORCE_STRANDED",
      "FORCE_WIDEN_AND_ESCALATE",
      "HARDEN_OR_REPLAN",
      "LEASE_EXPIRY_RECOVERY",
      "OPERATOR_ALERT",
      "OPERATOR_REVIEW",
      "PAGE_OPERATIONS",
      "PAGE_OPERATIONS_AND_EXTERNAL_ESCALATION",
      "PROBE_THEN_REASSIGN",
      "PROGRESS_PROBE",
      "REJECT_OR_ESCALATE",
      "REPROJECT_TIMELINE",
      "VERIFICATION_ESCALATION",
      "WITHDRAW_EXCLUDE_REPLAN",
    ]);
  });

  test("PLANTED — a §4.3 state added with a new expiry action is missing from the map", () => {
    // Simulated at the boundary the check actually reads, because the machines are frozen
    // objects: a map built for today's actions is measured against a declared set with one
    // more in it. The composer refuses on exactly this, so the gap is a red build rather
    // than a due timer returning HANDLER_NOT_REGISTERED in production.
    const map = { ...expiryActions.handlers({}) };
    delete map.FORCE_STRANDED;
    const verdict = expiryActions.assertComplete(map);
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toEqual(["FORCE_STRANDED"]);
  });

  test("PLANTED — a handler for an action no machine declares is dead code that reads as coverage", () => {
    const verdict = expiryActions.assertComplete({ ...expiryActions.handlers({}), RETIRED_ACTION: () => {} });
    expect(verdict.ok).toBe(false);
    expect(verdict.unexpected).toEqual(["RETIRED_ACTION"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. The §17.4 ladder — the refusal that matters most
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§4.3 QUEUED — ESCALATION_LADDER refuses rather than inventing a decision", () => {
  test("with no ladder injected it names the missing collaborator and does not move the Leg", async () => {
    const store = fixtures.storeFor(fixtures.seed());
    const leg = await legIn(store, "QUEUED");
    const { result, after } = await fire(store, leg);

    expect(result.disposition).toBe(expiryActions.DISPOSITION.DEPENDENCY_UNAVAILABLE);
    expect(result.outcome).toBe("LADDER_NOT_IMPLEMENTED");
    expect(after.state).toBe("QUEUED");
    expect(after.version).toBe(leg.version);
  });

  test("REGRESSION — it never reads an unimplemented ladder as an exhausted one", async () => {
    // §4.4's second row is `ladder exhausted → FAILED`. Taking it here would terminate a
    // customer's Leg because `src/engine/fairness/` is empty — §4.1 rule 3's prohibition in
    // its most expensive form. The Leg must stay QUEUED, whatever else happens.
    const store = fixtures.storeFor(fixtures.seed());
    const leg = await legIn(store, "QUEUED");
    const { after } = await fire(store, leg);

    expect(after.state).not.toBe("FAILED");
    expect(after.state).toBe("QUEUED");
  });

  test("with a ladder that has a step, it attempts §4.4's relaxation row", async () => {
    const store = fixtures.storeFor(fixtures.seed());
    const leg = await legIn(store, "QUEUED");
    const { result, after } = await fire(store, leg, {
      deps: { ladder: { nextStep: async () => ({ available: true, step: 3 }) } },
    });

    expect(result.disposition).toBe(expiryActions.DISPOSITION.TRANSITIONED);
    expect(result.outcome).toBe("QUEUED→QUEUED");
    // The self-transition bumps the version, which re-arms supervision at the new version.
    expect(after.version).toBe(leg.version + 1);
    expect(after.state).toBe("QUEUED");
  });

  test("with a ladder that reports exhaustion, §4.4's terminal row applies — and only then", async () => {
    const store = fixtures.storeFor(fixtures.seed());
    const leg = await legIn(store, "QUEUED");
    const { result, after } = await fire(store, leg, {
      deps: { ladder: { nextStep: async () => ({ available: false }) } },
    });

    expect(result.disposition).toBe(expiryActions.DISPOSITION.TRANSITIONED);
    expect(after.state).toBe("FAILED");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. Actions that transition, actions that do not
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§4.3 — the actions that attempt a §4.4 transition", () => {
  test("DEFERRED · FORCE_WIDEN_AND_ESCALATE ends the deferral and emits the widening directive", async () => {
    const store = fixtures.storeFor(fixtures.seed());
    const leg = await legIn(store, "DEFERRED");
    const { result, after, events } = await fire(store, leg);

    expect(result.disposition).toBe(expiryActions.DISPOSITION.TRANSITIONED);
    expect(after.state).toBe("QUEUED");
    // §17.4's widening is the ladder's; naming it is what stops a second ladder appearing.
    const directive = events.find((entry) => entry.event === "timer.widen_directive");
    expect(directive.detail.widen).toEqual(["SEARCH_RADIUS", "ADMIT_FINISHING_SOON_AND_CHARGING_INTERRUPTIBLE"]);
    expect(directive.detail.ownedBy).toMatch(/T1-04/);
  });

  test("PLANNED · HARDEN_OR_REPLAN re-plans when nobody asserts the commit guards", async () => {
    const store = fixtures.storeFor(fixtures.seed());
    const leg = await legIn(store, "PLANNED");
    const { result, after } = await fire(store, leg);

    // The SOFT reservation lives in the coordinator's in-memory plan state (§2.6) and a
    // timer cannot see it. A hardening deadline that passed with nobody hardening it is
    // exactly the case §4.3 wrote "or re-plan" for.
    expect(result.disposition).toBe(expiryActions.DISPOSITION.TRANSITIONED);
    expect(after.state).toBe("QUEUED");
  });

  test("PLANNED · HARDEN_OR_REPLAN hardens when the guards are positively asserted", async () => {
    const store = fixtures.storeFor(fixtures.seed());
    const leg = await legIn(store, "PLANNED");
    const { result, after } = await fire(store, leg, {
      deps: { commitGuardsPassFor: async () => true },
    });

    expect(result.disposition).toBe(expiryActions.DISPOSITION.TRANSITIONED);
    expect(after.state).toBe("OFFERED");
  });

  test("PLANNED · a refused hardening falls through to the re-plan half rather than waiting", async () => {
    // "harden **or** re-plan", not "harden, or try hardening again next time". A Leg that
    // sat in PLANNED re-attempting a hardening its guards refuse is the stuck state §12.1
    // opens by naming.
    const store = fixtures.storeFor(fixtures.seed());
    const leg = await legIn(store, "PLANNED");
    const { after } = await fire(store, leg, { deps: { commitGuardsPassFor: async () => false } });
    expect(after.state).toBe("QUEUED");
  });

  test("RELEASED · VERIFICATION_ESCALATION applies §4.4's evidence-insufficient row", async () => {
    const store = fixtures.storeFor(fixtures.seed());
    const leg = await legIn(store, "RELEASED", { custodyState: "RELEASED" });
    const { result, after, events } = await fire(store, leg);

    expect(result.disposition).toBe(expiryActions.DISPOSITION.TRANSITIONED);
    expect(after.state).toBe("RELEASED");
    expect(after.version).toBe(leg.version + 1);
    const escalation = events.find((entry) => entry.event === "timer.verification_escalation");
    expect(escalation.detail.operatorQueue).toBe(true);
    // The Task half of §4.4's row is not available before the cutover, and the record says
    // so rather than reporting a half-effect as a whole one.
    expect(escalation.detail.taskVerifying).toMatch(/Phase 15/);
  });
});

describe("§4.3 — the actions that act without transitioning, and why", () => {
  test.each([
    ["AT_PICKUP", "NONE"],
    ["AT_DROP", "HELD"],
  ])("%s · OPERATOR_ALERT alerts, leaves the Leg where it is, and counts the repeat", async (state, custodyState) => {
    const store = fixtures.storeFor(fixtures.seed());
    const leg = await legIn(store, state, { custodyState });
    const { result, after, events } = await fire(store, leg, { timer: { attempts: 4 } });

    expect(result.disposition).toBe(expiryActions.DISPOSITION.ACTED_WITHOUT_TRANSITION);
    expect(after.state).toBe(state);
    expect(after.version).toBe(leg.version);

    const alert = events.find((entry) => entry.event === "timer.operator_alert");
    expect(alert.detail.parameter).toBe("stop.service_time_limit");
    // The count is what turns a repeated alert into a severity.
    expect(alert.detail.consecutiveExpiries).toBe(5);
  });

  test("REASSIGNING · ESCALATE escalates in place — §4.3 gives the Leg no SUSPENDED state", async () => {
    const store = fixtures.storeFor(fixtures.seed());
    const leg = await legIn(store, "REASSIGNING");
    const { result, after, events } = await fire(store, leg);

    expect(result.disposition).toBe(expiryActions.DISPOSITION.ACTED_WITHOUT_TRANSITION);
    expect(after.state).toBe("REASSIGNING");
    // §4.7 says "the Leg goes to SUSPENDED"; §4.3's nineteen states do not include one.
    // `lifecycle/reassignment.js` resolved that first — the Leg freezes, the Task suspends —
    // and this follows that precedent rather than setting a second one.
    const escalated = events.find((entry) => entry.event === "timer.reassignment_escalated");
    expect(escalated.detail.taskState).toBe("SUSPENDED");
    expect(legMachine.LEG_STATE.SUSPENDED).toBeUndefined();
  });

  test("STRANDED_SAFE · PAGE_OPERATIONS pages and opens no external chain", async () => {
    const store = fixtures.storeFor(fixtures.seed());
    const leg = await legIn(store, "STRANDED_SAFE", { custodyState: "HELD", obstructionClass: "CLEAR" });
    const { result, after, events } = await fire(store, leg);

    expect(result.outcome).toBe("OPERATIONS_PAGED");
    expect(after.state).toBe("STRANDED_SAFE");
    const missed = events.find((entry) => entry.event === "timer.stranding_response_target_missed");
    expect(missed.detail.responseTargetParameter).toBe("ops.stranded_safe_response_target");
    // §18.6 opens for STRANDED_OBSTRUCTING only. Paging a responder and notifying an
    // infrastructure operator about an agent on a verge is the false positive §18.6 warns
    // erodes the path before the real incident arrives.
    expect(missed.detail.externalEscalation).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. Guards, absence, and the §4.3-sourced rows
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§4.4's guards govern an expiry exactly as they govern any other transition", () => {
  test("ACCEPTED with custody HELD is refused — the row is guarded on `no custody`", async () => {
    const store = fixtures.storeFor(fixtures.seed());
    const leg = await legIn(store, "ACCEPTED", { custodyState: "HELD" });
    const { result, after } = await fire(store, leg);

    expect(result.disposition).toBe(expiryActions.DISPOSITION.REFUSED);
    expect(result.outcome).toMatch(/^CUSTODY_NOT_NONE/);
    expect(after.state).toBe("ACCEPTED");
    expect(after.version).toBe(leg.version);
  });

  test.each(["HELD", "DISPUTED", "PENDING_TRANSFER", "RELEASED"])(
    "REGRESSION — custody %s refuses: §4.4's guard is evaluated, not restated as `holdsGoods`",
    async (custodyState) => {
      // The defect this pins is one this remediation introduced and then found: the first
      // version restated the guard as `custody.holdsGoods(...)`, which answers **false** for
      // `PENDING_TRANSFER` — custody mid-handoff — and for `RELEASED`. §4.4's guard reads
      // `custodyState === "NONE"`, so the restatement was laxer than the specification and
      // would have reassigned a Leg whose goods were being handed between two parties.
      expect(custody.holdsGoods("PENDING_TRANSFER")).toBe(false); // the trap, stated
      const store = fixtures.storeFor(fixtures.seed());
      const leg = await legIn(store, "ACCEPTED", { custodyState });
      const { result, after } = await fire(store, leg);
      expect(result.disposition).toBe(expiryActions.DISPOSITION.REFUSED);
      expect(result.outcome).toBe(`CUSTODY_NOT_NONE:${custodyState}`);
      expect(after.state).toBe("ACCEPTED");
    },
  );

  test("an unresolvable target deadline refuses the transition rather than throwing", async () => {
    // `transitions.apply` refuses to enter a timer-requiring state without a deadline, and
    // is right to. A handler that let it throw would report `HANDLER_THREW` and leave the
    // Leg wherever it was; refusing names the parameter that did not resolve.
    const store = fixtures.storeFor(fixtures.seed());
    const leg = await legIn(store, "DEFERRED");
    const { result, after } = await fire(store, leg, { config: { deadlineSecondsFor: () => undefined } });

    expect(result.disposition).toBe(expiryActions.DISPOSITION.DEPENDENCY_UNAVAILABLE);
    expect(result.outcome).toBe("DEADLINE_UNRESOLVED:sla.assignment_deadline");
    expect(after.state).toBe("DEFERRED");
  });

  test("a command-writing action refuses without a signing key rather than emitting an unsigned command", async () => {
    const store = fixtures.storeFor(fixtures.seed(), { commitments: [fixtures.commitmentRow(fixtures.seed())] });
    const leg = await legIn(store, "OFFERED");
    const { result } = await fire(store, leg, { config: { signingKey: "" } });

    expect(result.disposition).toBe(expiryActions.DISPOSITION.DEPENDENCY_UNAVAILABLE);
    expect(result.outcome).toBe("NO_SIGNING_KEY");
  });

  test("REGRESSION — a command-writing action names an unresolved duration rather than throwing on it", async () => {
    // Found live: the first version of `WITHDRAW_EXCLUDE_REPLAN` omitted `nackCooloffSeconds`
    // from the call to `offers.withdrawExpiredOffer`, which computes the exclusion window
    // from it — every withdrawal threw, was rolled back, and was reported as HANDLER_THREW
    // rather than as the missing parameter it was.
    const store = fixtures.storeFor(fixtures.seed(), { commitments: [fixtures.commitmentRow(fixtures.seed())] });
    const leg = await legIn(store, "OFFERED");
    const { result } = await fire(store, leg, { config: { nackCooloffSeconds: undefined } });

    expect(result.disposition).toBe(expiryActions.DISPOSITION.DEPENDENCY_UNAVAILABLE);
    expect(result.outcome).toBe("PARAMETER_UNRESOLVED:dispatch.nack_cooloff");
  });
});

describe("§4.3-sourced rows — the three §4.4 does not contain", () => {
  test("they are enumerable, and the set is exactly the three §4.3 names in its own words", () => {
    expect(transitions.sectionFourThreeSourcedRows()).toEqual([
      { from: "PLANNED", event: "HARDENING_DEADLINE_ELAPSED", source: "§4.3" },
      { from: "EN_ROUTE_DROP", event: "ETA_BREACH", source: "§4.3" },
      { from: "ABORTING", event: "ABORT_BUDGET_EXPIRY", source: "§4.3" },
    ]);
  });

  test("REGRESSION — ABORTING now has an outgoing row; before, its deadline was undischargeable", () => {
    // §4.4 gave ABORTING no outgoing row at all, so its timer fired, `find` returned
    // nothing, and §4.3's "force to the applicable STRANDED_* state" could never happen.
    expect(transitions.find("ABORTING", transitions.EVENT.ABORT_BUDGET_EXPIRY)).not.toBeNull();
    expect(transitions.find("EN_ROUTE_DROP", transitions.EVENT.ETA_BREACH)).not.toBeNull();
    expect(transitions.find("PLANNED", transitions.EVENT.HARDENING_DEADLINE_ELAPSED)).not.toBeNull();
  });

  test("only REASSIGNING now lacks a dedicated row, and that is correct", () => {
    // §4.3 names an action for it and no target state, and §4.7's answer — SUSPENDED — is
    // the Task's state. The distinction between "acts without transitioning" and "cannot
    // act at all" is what this query exists to keep visible.
    expect(transitions.statesWhoseExpiryHasNoDedicatedRow()).toEqual(["REASSIGNING"]);
  });

  test.each([
    ["CLEAR", "STRANDED_SAFE"],
    ["RESTRICTIVE", "STRANDED_SAFE"],
    ["BLOCKING_CRITICAL", "STRANDED_OBSTRUCTING"],
    [null, "STRANDED_OBSTRUCTING"],
  ])("ABORTING · FORCE_STRANDED with obstruction %s forces %s (I22)", async (obstructionClass, expected) => {
    const store = fixtures.storeFor(fixtures.seed());
    const leg = await legIn(store, "ABORTING", { custodyState: "HELD", obstructionClass });
    const { result, after } = await fire(store, leg);

    expect(result.disposition).toBe(expiryActions.DISPOSITION.TRANSITIONED);
    expect(after.state).toBe(expected);
  });

  test("an unclassifiable stopping location resolves to the more serious case, never the permissive one", async () => {
    // I22's first half, at the one place it would be easiest to reintroduce §2.7's
    // registry-expiry cliff: absence resolving to CLEAR.
    const store = fixtures.storeFor(fixtures.seed());
    const leg = await legIn(store, "ABORTING", { custodyState: "HELD", obstructionClass: null });
    const { after } = await fire(store, leg);
    expect(after.state).toBe("STRANDED_OBSTRUCTING");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. The §4.2 handlers, and the honest statement of what they cannot do
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§4.2 — the Task actions record the deadline and decline to invent a transition", () => {
  test.each([
    ["RECEIVED", "REJECT_OR_ESCALATE"],
    ["PLANNABLE", "DECOMPOSITION_STALLED"],
    ["IN_EXECUTION", "REPROJECT_TIMELINE"],
    ["SUSPENDED", "OPERATOR_REVIEW"],
  ])("%s · %s reports the breach and names who owns the write", async (state, action) => {
    const store = fixtures.storeFor(fixtures.seed());
    const map = expiryActions.handlers({});
    const events = [];

    const result = await map[action]({
      tx: {},
      prisma: store.client,
      timer: {
        id: "t",
        entityType: "TASK",
        entityId: "task-1",
        state,
        dueAt: new Date(STORE_NOW.getTime() - 1000),
        attempts: 0,
      },
      entity: { id: "task-1", version: 0, status: state },
      storeTime: store.now(),
      config: CONFIG,
      record: (event, detail) => events.push({ event, detail }),
    });

    expect(result.disposition).toBe(expiryActions.DISPOSITION.ACTED_WITHOUT_TRANSITION);
    expect(result.outcome).toBe(action);

    const passed = events.find((entry) => entry.event === "timer.task_deadline_passed");
    expect(passed.detail.parameter).toBe(taskMachine.TASK_DEADLINES[state].parameter);
    expect(passed.detail.operatorQueue).toBe(true);
    // §4.2 has no transition table anywhere in the specification. Writing one here would
    // be inventing the customer-visible contract's semantics.
    expect(passed.detail.transitionOwner).toMatch(/declares no transition table/);
  });

  test("REJECT_OR_ESCALATE takes the escalate branch and never the reject one", async () => {
    // §4.3's other disjunctions ("harden or re-plan") are decided by evidence a timer has.
    // This one is not: rejecting a Task is terminal and customer-visible, and §4.2 supplies
    // no rule for choosing. Escalating is the branch that can be taken without inventing one.
    const store = fixtures.storeFor(fixtures.seed());
    const events = [];
    const result = await expiryActions.handlers({}).REJECT_OR_ESCALATE({
      tx: {},
      prisma: store.client,
      timer: { id: "t", entityType: "TASK", entityId: "task-1", state: "RECEIVED", dueAt: STORE_NOW, attempts: 0 },
      entity: { id: "task-1", version: 0 },
      storeTime: store.now(),
      config: CONFIG,
      record: (event, detail) => events.push({ event, detail }),
    });

    expect(result.outcome).toBe("REJECT_OR_ESCALATE");
    expect(events[0].detail.operatorQueue).toBe(true);
    // Nothing was rejected: no state write was attempted at all.
    expect(events[0].detail.awaiting).toBe("intake validation");
  });
});

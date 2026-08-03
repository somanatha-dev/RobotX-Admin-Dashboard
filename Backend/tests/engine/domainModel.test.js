"use strict";

/**
 * Phase 2 — the §2 domain model as code.
 *
 * Every assertion here is checked against the specification's own tables, not
 * against the implementation's convenience: where §2.4 tabulates six purposes, the
 * test asserts six by name; where §2.5 tabulates five custody states, the test
 * asserts five by name. A module that quietly grew a seventh purpose would fail.
 */

const agent = require("../../src/engine/domain/agent");
const capability = require("../../src/engine/domain/capability");
const custody = require("../../src/engine/domain/custody");
const mobilityModel = require("../../src/engine/domain/mobilityModel");
const observation = require("../../src/engine/domain/observation");
const purpose = require("../../src/engine/domain/purpose");
const work = require("../../src/engine/domain/work");

describe("§2.4 — Leg purpose", () => {
  test("the six purposes are exactly the ones §2.4 tabulates", () => {
    expect(purpose.PURPOSE_NAMES).toEqual([
      "PRIMARY",
      "RECOVERY",
      "TRANSFER",
      "REPOSITION",
      "EXERCISE",
      "MAINTENANCE_TRANSIT",
    ]);
  });

  test("custodial_purposes = {RECOVERY, TRANSFER}", () => {
    expect([...purpose.CUSTODIAL_PURPOSES].sort()).toEqual(["RECOVERY", "TRANSFER"]);
  });

  test("speculative_purposes = {REPOSITION, EXERCISE}", () => {
    expect([...purpose.SPECULATIVE_PURPOSES].sort()).toEqual(["EXERCISE", "REPOSITION"]);
  });

  test("the derived sets are derived, not restated — every member agrees with its own row", () => {
    for (const name of purpose.PURPOSE_NAMES) {
      expect(purpose.isCustodial(name)).toBe(purpose.CUSTODIAL_PURPOSES.includes(name));
      expect(purpose.isSpeculative(name)).toBe(purpose.SPECULATIVE_PURPOSES.includes(name));
    }
  });

  test("§4.8 — custodial purposes are never preemptible", () => {
    for (const name of purpose.CUSTODIAL_PURPOSES) {
      expect(purpose.isPreemptible(name)).toBe(false);
    }
    expect(purpose.isPreemptible("REPOSITION")).toBe(true);
    expect(purpose.isPreemptible("PRIMARY")).toBe(true);
  });

  test("§20.5 — custodial purposes are never shed", () => {
    for (const name of purpose.CUSTODIAL_PURPOSES) {
      expect(purpose.isSheddable(name)).toBe(false);
    }
    for (const name of purpose.SPECULATIVE_PURPOSES) {
      expect(purpose.isSheddable(name)).toBe(true);
    }
  });

  test("§4.6 — only PRIMARY is cancellable by the requester", () => {
    const cancellable = purpose.PURPOSE_NAMES.filter(purpose.isCancellableByRequester);
    expect(cancellable).toEqual(["PRIMARY"]);
  });

  test("an unknown purpose throws rather than defaulting permissively", () => {
    expect(() => purpose.isCustodial("SOMETHING_ELSE")).toThrow(/unknown Leg purpose/);
    expect(purpose.isPurpose("SOMETHING_ELSE")).toBe(false);
  });
});

describe("§2.5 — custody", () => {
  test("the five states are exactly the ones §2.5 tabulates", () => {
    expect(custody.CUSTODY_STATE_NAMES).toEqual([
      "NONE",
      "PENDING_TRANSFER",
      "HELD",
      "RELEASED",
      "DISPUTED",
    ]);
  });

  test("HELD holds goods and cannot be reassigned without physical recovery", () => {
    expect(custody.holdsGoods("HELD")).toBe(true);
    expect(custody.isReassignableWithoutIntervention("HELD")).toBe(false);
  });

  test("DISPUTED resolves conservatively — conflicting evidence is not read as 'not holding'", () => {
    expect(custody.holdsGoods("DISPUTED")).toBe(true);
    expect(custody.isReassignableWithoutIntervention("DISPUTED")).toBe(false);
    expect(custody.isRequeueable("DISPUTED")).toBe(false);
  });

  test("I7 — a Task is never requeueable while custody is HELD", () => {
    expect(custody.isRequeueable("HELD")).toBe(false);
    expect(custody.isRequeueable("NONE")).toBe(true);
    expect(custody.isRequeueable("PENDING_TRANSFER")).toBe(true);
  });

  test("custody is discharged only by NONE or RELEASED", () => {
    const discharged = custody.CUSTODY_STATE_NAMES.filter(custody.isDischarged);
    expect(discharged.sort()).toEqual(["NONE", "RELEASED"]);
  });

  test("an unknown custody state is never read as NONE", () => {
    expect(() => custody.holdsGoods("UNKNOWN")).toThrow(/never treated as NONE/);
  });
});

describe("§2.3 — capability matching", () => {
  const bundle = {
    capabilities: [
      { name: "secure_locker", kind: "BOOLEAN", value: true, source: "COMMISSIONING_RECORD" },
      { name: "autonomy_level", kind: "GRADED", value: 3, source: "COMMISSIONING_RECORD" },
      { name: "max_payload_mass", kind: "QUANTITATIVE", value: 20, unit: "kg", source: "HARDWARE_MANIFEST" },
      { name: "cold_chain_min_temp", kind: "QUANTITATIVE", value: -2, unit: "C", source: "HARDWARE_MANIFEST" },
      { name: "hazmat_classes", kind: "ENUMERATED", value: ["UN3480", "UN3481"], source: "COMMISSIONING_RECORD" },
      {
        name: "food_handling_cert",
        kind: "CERTIFIED",
        value: true,
        issuer: "council",
        validUntil: new Date("2027-01-01T00:00:00Z").toISOString(),
        source: "COMMISSIONING_RECORD",
      },
    ],
  };

  test("threshold containment — the four §2.3 comparators", () => {
    expect(capability.matchRequirements(bundle, [{ name: "autonomy_level", comparator: "AT_LEAST", value: 3 }]).outcome)
      .toBe("SATISFIED");
    expect(capability.matchRequirements(bundle, [{ name: "autonomy_level", comparator: "AT_LEAST", value: 4 }]).outcome)
      .toBe("VIOLATED");
    expect(capability.matchRequirements(bundle, [{ name: "cold_chain_min_temp", comparator: "AT_MOST", value: 2 }]).outcome)
      .toBe("SATISFIED");
    expect(capability.matchRequirements(bundle, [{ name: "hazmat_classes", comparator: "SUPERSET_OF", value: ["UN3480"] }]).outcome)
      .toBe("SATISFIED");
    expect(capability.matchRequirements(bundle, [{ name: "hazmat_classes", comparator: "SUPERSET_OF", value: ["UN1234"] }]).outcome)
      .toBe("VIOLATED");
  });

  test("an absent capability is INDETERMINATE, never satisfied and never violated", () => {
    const verdict = capability.matchRequirements(bundle, [{ name: "stair_climb", comparator: "PRESENT" }]);
    expect(verdict.outcome).toBe("INDETERMINATE");
    expect(verdict.binding.reason).toMatch(/unknown is never permission/);
  });

  test("custody_transfer_capable is the one enumerated default-false capability (§2.3)", () => {
    expect(capability.DEFAULT_FALSE_CAPABILITIES).toEqual(["custody_transfer_capable"]);
    // Absent, so it defaults to false — and a requirement for it is therefore
    // VIOLATED rather than INDETERMINATE.
    const verdict = capability.matchRequirements(bundle, [
      { name: "custody_transfer_capable", comparator: "PRESENT" },
    ]);
    expect(verdict.outcome).toBe("VIOLATED");
    expect(capability.isCustodyTransferCapable(bundle)).toBe(false);
  });

  test("a certification is checked against mission end, not decision time", () => {
    const beforeExpiry = new Date("2026-12-01T00:00:00Z").getTime();
    const afterExpiry = new Date("2027-06-01T00:00:00Z").getTime();
    const requirement = [{ name: "food_handling_cert", comparator: "PRESENT" }];

    expect(capability.matchRequirements(bundle, requirement, { missionEndEpochMs: beforeExpiry }).outcome)
      .toBe("SATISFIED");
    // The same decision, the same agent, a mission that ends after the cert lapses.
    expect(capability.matchRequirements(bundle, requirement, { missionEndEpochMs: afterExpiry }).outcome)
      .toBe("VIOLATED");
  });

  test("a certification with no stated expiry is INDETERMINATE, not valid forever", () => {
    const openEnded = { capabilities: [{ name: "cert", kind: "CERTIFIED", value: true, source: "COMMISSIONING_RECORD" }] };
    const verdict = capability.matchRequirements(openEnded, [{ name: "cert", comparator: "PRESENT" }], {
      missionEndEpochMs: Date.parse("2026-12-01T00:00:00Z"),
    });
    expect(verdict.outcome).toBe("INDETERMINATE");
  });

  test("a violated requirement outranks an indeterminate one as the binding reason", () => {
    const verdict = capability.matchRequirements(bundle, [
      { name: "stair_climb", comparator: "PRESENT" },
      { name: "autonomy_level", comparator: "AT_LEAST", value: 5 },
    ]);
    expect(verdict.outcome).toBe("VIOLATED");
    expect(verdict.binding.name).toBe("autonomy_level");
  });

  test("§23.5 — a telemetry-sourced capability is refused, never admitted", () => {
    const selfDeclared = {
      capabilities: [{ name: "stair_climb", kind: "BOOLEAN", value: true, source: "AGENT_TELEMETRY" }],
    };
    expect(() => capability.assertAttested(selfDeclared)).toThrow(/never self-declared at runtime/);
    expect(capability.isAttested(selfDeclared.capabilities[0])).toBe(false);
  });
});

describe("§4.2 / §4.3 — state vocabularies", () => {
  test("§4.2 tabulates eleven Task states and all eleven are present", () => {
    expect(work.TASK_STATE_NAMES).toEqual([
      "RECEIVED",
      "REJECTED",
      "PLANNABLE",
      "WAITING",
      "IN_EXECUTION",
      "AT_RISK",
      "SUSPENDED",
      "VERIFYING",
      "COMPLETED",
      "CANCELLED",
      "FAILED",
    ]);
  });

  test("§4.2's four terminal Task states", () => {
    const terminal = work.TASK_STATE_NAMES.filter(work.isTerminalTaskState);
    expect(terminal.sort()).toEqual(["CANCELLED", "COMPLETED", "FAILED", "REJECTED"]);
  });

  test("§4.3 tabulates nineteen Leg states and all nineteen are present", () => {
    expect(work.LEG_STATE_NAMES).toHaveLength(19);
    for (const required of [
      "QUEUED", "DEFERRED", "PLANNED", "OFFERED", "ACCEPTED",
      "EN_ROUTE_PICKUP", "AT_PICKUP", "LOADED", "EN_ROUTE_DROP", "AT_DROP",
      "RELEASED", "SETTLED", "ABORTING", "STRANDED_SAFE", "STRANDED_OBSTRUCTING",
      "REASSIGNING", "WITHDRAWN", "CANCELLED", "FAILED",
    ]) {
      expect(work.LEG_STATE_NAMES).toContain(required);
    }
  });

  test("OFFERED, ACCEPTED, and EN_ROUTE_PICKUP are three distinct states", () => {
    // The baseline conflates all three into ASSIGNED. Keeping them distinct is the
    // whole reason §4.3 exists, so the property is asserted rather than assumed.
    const distinct = new Set(["OFFERED", "ACCEPTED", "EN_ROUTE_PICKUP"].map((name) => work.LEG_STATES[name].meaning));
    expect(distinct.size).toBe(3);
  });

  test("every non-terminal Leg state except LOADED registers a deadline (§4.1 rule 1)", () => {
    expect(work.nonTerminalLegStatesWithoutDeadline()).toEqual(["LOADED"]);
  });

  test("§4.3 — obstruction class derives the stranding state, and INDETERMINATE takes the serious branch", () => {
    expect(work.strandedStateFor("CLEAR")).toBe("STRANDED_SAFE");
    expect(work.strandedStateFor("RESTRICTIVE")).toBe("STRANDED_SAFE");
    expect(work.strandedStateFor("BLOCKING_CRITICAL")).toBe("STRANDED_OBSTRUCTING");
    expect(work.strandedStateFor("INDETERMINATE")).toBe("STRANDED_OBSTRUCTING");
    // An absent class is INDETERMINATE by §4.3, not a permissive default.
    expect(work.strandedStateFor(null)).toBe("STRANDED_OBSTRUCTING");
    expect(work.strandedStateFor(undefined)).toBe("STRANDED_OBSTRUCTING");
  });

  test("RESTRICTIVE is STRANDED_SAFE but on its own, shorter response target", () => {
    expect(work.OBSTRUCTION_CLASSES.RESTRICTIVE.legState).toBe("STRANDED_SAFE");
    expect(work.OBSTRUCTION_CLASSES.RESTRICTIVE.responseTargetParameter)
      .not.toBe(work.OBSTRUCTION_CLASSES.CLEAR.responseTargetParameter);
  });

  test("§2.4's seven stop types", () => {
    expect(work.STOP_TYPES).toEqual(["PICKUP", "DROP", "WAIT", "CHARGE", "INSPECT", "TRANSFER", "REPOSITION"]);
  });

  test("deadlines are named register parameters, never literal durations", () => {
    for (const name of work.LEG_STATE_NAMES) {
      const deadline = work.LEG_STATES[name].deadline;
      expect(typeof deadline === "string" || deadline === null).toBe(true);
    }
  });
});

describe("§2.4 — Mission / Leg / Stop structure", () => {
  const wellFormed = {
    missionId: "MSN-1",
    legs: [
      {
        legId: "LEG-1",
        sequence: 0,
        purpose: "PRIMARY",
        state: "QUEUED",
        custodyState: "NONE",
        stops: [
          { stopId: "S1", sequence: 0, stopType: "PICKUP" },
          { stopId: "S2", sequence: 1, stopType: "DROP" },
        ],
      },
    ],
  };

  test("a well-formed point-to-point Mission validates clean", () => {
    expect(work.validateMission(wellFormed)).toEqual([]);
    expect(work.isPointToPointMission(wellFormed)).toBe(true);
  });

  test("a Leg with an unrecognised purpose is rejected", () => {
    const bad = { ...wellFormed, legs: [{ ...wellFormed.legs[0], purpose: "ERRAND" }] };
    expect(work.validateMission(bad).join(" ")).toMatch(/purpose "ERRAND"/);
  });

  test("a Leg with one Stop is rejected — a Leg is a sequence of Stops", () => {
    const bad = { ...wellFormed, legs: [{ ...wellFormed.legs[0], stops: [{ stopId: "S1", sequence: 0, stopType: "PICKUP" }] }] };
    expect(work.validateMission(bad).join(" ")).toMatch(/sequence of Stops/);
  });

  test("two Stops at the same sequence are rejected", () => {
    const bad = {
      ...wellFormed,
      legs: [
        {
          ...wellFormed.legs[0],
          stops: [
            { stopId: "S1", sequence: 0, stopType: "PICKUP" },
            { stopId: "S2", sequence: 0, stopType: "DROP" },
          ],
        },
      ],
    };
    expect(work.validateMission(bad).join(" ")).toMatch(/two Stops at sequence/);
  });

  test("a RECOVERY Leg is not a point-to-point Mission", () => {
    const recovery = { ...wellFormed, legs: [{ ...wellFormed.legs[0], purpose: "RECOVERY" }] };
    expect(work.isPointToPointMission(recovery)).toBe(false);
  });
});

describe("§2.1 — Agent", () => {
  test("the five lifecycle states, and only ACTIVE admits assignment", () => {
    expect(agent.LIFECYCLE_STATE_NAMES).toEqual([
      "COMMISSIONED",
      "ACTIVE",
      "QUARANTINED",
      "MAINTENANCE",
      "DECOMMISSIONED",
    ]);
    const eligible = agent.LIFECYCLE_STATE_NAMES.filter(agent.isLifecycleEligible);
    expect(eligible).toEqual(["ACTIVE"]);
  });

  test("an unknown lifecycle state is never read as in-service", () => {
    expect(() => agent.isLifecycleEligible("RUNNING")).toThrow(/never treated as in-service/);
  });

  test("the five orthogonal concerns are returned as five, not collapsed", () => {
    const described = agent.describeState({
      lifecycleState: "ACTIVE",
      activity: "CHARGING",
      commitmentState: "NONE",
      connectivity: "ONLINE",
      healthTier: "GREEN",
    });
    // §2.1's own worked example: a charging agent is lifecycle=active,
    // activity=charging, commitment=none.
    expect(described).toEqual({
      lifecycle: "ACTIVE",
      commitment: "NONE",
      activity: "CHARGING",
      connectivity: "ONLINE",
      health: "GREEN",
    });
  });

  test("an unreported concern reads UNKNOWN, never a permissive default", () => {
    expect(agent.describeState({ lifecycleState: "ACTIVE" })).toEqual({
      lifecycle: "ACTIVE",
      commitment: "UNKNOWN",
      activity: "UNKNOWN",
      connectivity: "UNKNOWN",
      health: "UNKNOWN",
    });
  });

  test("both fencing counters are monotone (I6)", () => {
    expect(agent.isMonotoneAdvance(BigInt(4), BigInt(5))).toBe(true);
    expect(agent.isMonotoneAdvance(BigInt(5), BigInt(5))).toBe(true);
    expect(agent.isMonotoneAdvance(BigInt(5), BigInt(4))).toBe(false);
  });

  test("the commitment fence is compared per commitment id, never as a per-agent maximum", () => {
    // Two concurrent commitments on one agent. Commitment B's fence is lower than
    // A's; a per-agent-maximum comparison would wrongly reject B's command, which
    // is the defect §10.3's P0-1 revision removed and which makes a capacity > 1
    // agent uncommandable.
    const highestSeen = { "cmt-A": BigInt(9), "cmt-B": BigInt(2) };
    expect(agent.isCommandAuthorityCurrent({ commitmentId: "cmt-B", fence: BigInt(3) }, highestSeen)).toBe(true);
    expect(agent.isCommandAuthorityCurrent({ commitmentId: "cmt-B", fence: BigInt(2) }, highestSeen)).toBe(false);
    expect(agent.isCommandAuthorityCurrent({ commitmentId: "cmt-A", fence: BigInt(3) }, highestSeen)).toBe(false);
  });

  test("an agent-scope fence_floor invalidates every commitment authority below it", () => {
    const highestSeen = { "cmt-A": BigInt(1) };
    expect(agent.isCommandAuthorityCurrent({ commitmentId: "cmt-A", fence: BigInt(5) }, highestSeen, BigInt(7))).toBe(false);
    expect(agent.isCommandAuthorityCurrent({ commitmentId: "cmt-A", fence: BigInt(8) }, highestSeen, BigInt(7))).toBe(true);
  });

  test("an unknown commitment id is judged against fence_floor, not admitted for lack of history", () => {
    expect(agent.isCommandAuthorityCurrent({ commitmentId: "cmt-new", fence: BigInt(3) }, {}, BigInt(9))).toBe(false);
    expect(agent.isCommandAuthorityCurrent({ commitmentId: "cmt-new", fence: BigInt(10) }, {}, BigInt(9))).toBe(true);
  });

  test("a runtime capability self-declaration is refused", () => {
    expect(() => agent.refuseSelfDeclaredCapability({ name: "stair_climb" }))
      .toThrow(/not through a telemetry field/);
  });

  test("an agent missing a fencing counter fails validation", () => {
    const problems = agent.validateAgent({ agentId: "A1", lifecycleState: "ACTIVE", authorityEpoch: BigInt(0) });
    expect(problems.join(" ")).toMatch(/no fenceCounter/);
  });
});

describe("§2.2 — MobilityModel", () => {
  const model = {
    modelId: "MOB-1",
    traversalDomain: "SIDEWALK_GRAPH",
    permissionSet: {},
    speedModel: {},
    kinematicLimits: {},
    envelopeConstraints: {},
    dimensionalFootprint: {},
  };

  test("all six §2.2 elements must be declared", () => {
    expect(mobilityModel.validateModel(model)).toEqual([]);
    const missing = { ...model };
    delete missing.envelopeConstraints;
    expect(mobilityModel.validateModel(missing).join(" ")).toMatch(/does not declare "envelopeConstraints"/);
  });

  test("a composition of traversal domains is canonically ordered, so the profile key is stable", () => {
    const a = mobilityModel.routingProfileKey({ modelId: "M", traversalDomain: ["ROAD_GRAPH", "SIDEWALK_GRAPH"] });
    const b = mobilityModel.routingProfileKey({ modelId: "M", traversalDomain: ["SIDEWALK_GRAPH", "ROAD_GRAPH"] });
    expect(a).toBe(b);
  });

  test("loaded and unloaded are different routing profiles (§15.5)", () => {
    expect(mobilityModel.routingProfileKey(model, { loaded: true }))
      .not.toBe(mobilityModel.routingProfileKey(model, { loaded: false }));
  });
});

describe("§2.7 — Observations and freshness", () => {
  const observedAt = new Date("2026-07-28T10:00:00Z");

  test("observedAt is mandatory and is never defaulted to receipt time", () => {
    expect(() =>
      observation.createObservation({ agentId: "A", kind: "soc", value: 0.5, source: "SENSOR" }),
    ).toThrow(/observedAt/);
  });

  test("a dead-reckoned position must carry its uncertainty radius", () => {
    expect(() =>
      observation.createObservation({
        agentId: "A",
        kind: "position",
        value: { lat: 0, lon: 0 },
        observedAt,
        source: "INFERRED",
        deadReckoned: true,
      }),
    ).toThrow(/uncertainty radius/);
  });

  test("within budget is FRESH; beyond budget is INDETERMINATE, not absent", () => {
    const record = observation.createObservation({
      agentId: "A", kind: "soc", value: 0.5, observedAt, source: "SENSOR",
    });
    const atEpochMs = observedAt.getTime() + 5000;

    expect(observation.assess(record, { stalenessBudgetMs: 10000, atEpochMs }).freshness).toBe("FRESH");
    const stale = observation.assess(record, { stalenessBudgetMs: 1000, atEpochMs });
    expect(stale.freshness).toBe("INDETERMINATE");
    expect(stale.value).toBe(0.5);
  });

  test("ABSENT and INDETERMINATE are distinct outcomes — the registry-expiry cliff", () => {
    const absent = observation.assess(null, { stalenessBudgetMs: 1000, atEpochMs: observedAt.getTime() });
    expect(absent.freshness).toBe("ABSENT");
    expect(absent.freshness).not.toBe("INDETERMINATE");
  });

  test("a consumer that declares no staleness budget gets INDETERMINATE, not a default", () => {
    const record = observation.createObservation({
      agentId: "A", kind: "soc", value: 0.5, observedAt, source: "SENSOR",
    });
    expect(observation.assess(record, { atEpochMs: observedAt.getTime() }).freshness).toBe("INDETERMINATE");
  });

  test("a future-stamped observation is a clock disagreement, not freshness", () => {
    const record = observation.createObservation({
      agentId: "A", kind: "soc", value: 0.5, observedAt, source: "SENSOR",
    });
    const verdict = observation.assess(record, {
      stalenessBudgetMs: 10000,
      atEpochMs: observedAt.getTime() - 5000,
    });
    expect(verdict.freshness).toBe("INDETERMINATE");
    expect(verdict.reason).toMatch(/clock skew/);
  });

  test("assess reads no clock — the same inputs always give the same verdict", () => {
    const record = observation.createObservation({
      agentId: "A", kind: "soc", value: 0.5, observedAt, source: "SENSOR",
    });
    const options = { stalenessBudgetMs: 10000, atEpochMs: observedAt.getTime() + 1000 };
    expect(observation.assess(record, options)).toEqual(observation.assess(record, options));
  });

  test("extrapolation is admissible for cost estimation and prohibited for safety constraints", () => {
    const extrapolated = observation.createObservation({
      agentId: "A",
      kind: "position",
      value: { lat: 0, lon: 0 },
      observedAt,
      source: "INFERRED",
      deadReckoned: true,
      uncertaintyRadiusM: 12,
    });
    expect(observation.isAdmissibleFor(extrapolated, { purpose: "COST_ESTIMATION" })).toBe(true);
    expect(observation.isAdmissibleFor(extrapolated, { purpose: "SAFETY_CONSTRAINT" })).toBe(false);
  });

  test("a repeated or regressing sequence does not advance the agent's high-water mark", () => {
    const at = (sequence) => ({ sequence: BigInt(sequence) });
    expect(observation.advancesSequence(at(5), at(4))).toBe(true);
    expect(observation.advancesSequence(at(4), at(4))).toBe(false);
    expect(observation.advancesSequence(at(3), at(4))).toBe(false);
    expect(observation.advancesSequence(at(1), null)).toBe(true);
  });
});

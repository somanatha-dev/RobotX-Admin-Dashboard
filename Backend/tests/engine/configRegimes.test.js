"use strict";

/**
 * Engine lane — operating regimes (§22.2).
 *
 * A regime is a time-windowed override with two extra properties: it is **named**, so
 * its entry and exit are events, and it is **forecast-triggerable**, so it can be
 * entered on a *correct* forecast rather than discovered. The failure it prevents is
 * a genuine regime change — first snowfall moving consumption, service times, travel
 * times and intervention rates together — presenting as a simultaneous drift alarm on
 * every predictor and an unexplained spike in T1 energy events.
 */

const service = require("../../src/engine/config/service");
const regimes = require("../../src/engine/config/regimes");

const { REGIME_STATE, TRANSITION_ACTOR } = regimes;
const entries = service.loadRegister().entries;

const WINTER = {
  name: "first-snowfall",
  description: "Sustained sub-zero surfaces; the calibrated coefficient set was not fitted on them.",
  triggerCondition: { forecast: "surface_temp_c < 0 for 6h" },
  entryCriteria: "forecast confidence ≥ 0.8 over the next 12 h",
  exitCriteria: "48 h above 2 °C",
  owner: "Fleet Ops",
  calibrationStatus: "PROVISIONAL",
  state: REGIME_STATE.INACTIVE,
  parameterDeltas: [
    { name: "execute.eta_tolerance", value: 1.8 },
    { name: "candidate.finishing_soon_horizon", value: 600 },
  ],
};

describe("a regime declaration", () => {
  test("is well-formed when it declares trigger, deltas, entry and exit criteria, owner and status", () => {
    expect(regimes.validateDeclaration(WINTER, entries)).toEqual([]);
  });

  test.each([
    ["name", "regime has no name"],
    ["triggerCondition", "declares no trigger condition"],
    ["entryCriteria", "declares no entry criteria"],
    ["exitCriteria", "declares no exit criteria"],
    ["owner", "declares no owner"],
    ["calibrationStatus", "carries no calibration status"],
  ])("is rejected when %s is missing", (field, message) => {
    const problems = regimes.validateDeclaration({ ...WINTER, [field]: undefined }, entries);
    expect(problems.join(" ")).toContain(message);
  });

  test("is rejected when it changes nothing", () => {
    expect(regimes.validateDeclaration({ ...WINTER, parameterDeltas: [] }, entries).join(" ")).toMatch(
      /a regime that changes nothing is not a regime/,
    );
  });

  test("is rejected when it sets a parameter absent from the register", () => {
    const problems = regimes.validateDeclaration(
      { ...WINTER, parameterDeltas: [{ name: "cost.winter_fudge", value: 2 }] },
      entries,
    );
    expect(problems.join(" ")).toMatch(/not in the parameter register/);
  });

  test("is rejected when it sets a derived parameter — a regime is not an exception to rule 6", () => {
    const problems = regimes.validateDeclaration(
      { ...WINTER, parameterDeltas: [{ name: "energy.contingency_quantile", value: 0.999 }] },
      entries,
    );
    expect(problems.join(" ")).toMatch(/never hand-entered — a regime is not an exception/);
  });

  test("names the Safety-class deltas it carries, which keep their §22.3 approval", () => {
    const safety = regimes.safetyClassDeltas(
      { ...WINTER, parameterDeltas: [...WINTER.parameterDeltas, { name: "energy.uncalibrated_reserve_factor", value: 1.4 }] },
      entries,
    );
    expect(safety).toEqual(["energy.uncalibrated_reserve_factor"]);
  });
});

describe("the lifecycle requires operator confirmation in both directions", () => {
  test("the forecast may propose entry", () => {
    const proposed = regimes.transition(WINTER, REGIME_STATE.PROPOSED_ENTRY, { actor: TRANSITION_ACTOR.FORECAST });
    expect(proposed.state).toBe(REGIME_STATE.PROPOSED_ENTRY);
  });

  test("the forecast may NOT confirm entry — a fleet-wide behavioural shift belongs to a person", () => {
    const proposed = regimes.transition(WINTER, REGIME_STATE.PROPOSED_ENTRY, { actor: TRANSITION_ACTOR.FORECAST });
    expect(() => regimes.transition(proposed, REGIME_STATE.ACTIVE, { actor: TRANSITION_ACTOR.FORECAST })).toThrow(
      /requires operator confirmation/,
    );
  });

  test("an operator confirms entry, and again confirms exit", () => {
    let regime = regimes.transition(WINTER, REGIME_STATE.PROPOSED_ENTRY, { actor: TRANSITION_ACTOR.FORECAST });
    regime = regimes.transition(regime, REGIME_STATE.ACTIVE, { actor: TRANSITION_ACTOR.OPERATOR, actorId: "ops-1" });
    expect(regime.state).toBe(REGIME_STATE.ACTIVE);

    regime = regimes.transition(regime, REGIME_STATE.PROPOSED_EXIT, { actor: TRANSITION_ACTOR.FORECAST });
    expect(() => regimes.transition(regime, REGIME_STATE.INACTIVE, { actor: TRANSITION_ACTOR.FORECAST })).toThrow(
      /requires operator confirmation/,
    );
    regime = regimes.transition(regime, REGIME_STATE.INACTIVE, { actor: TRANSITION_ACTOR.OPERATOR, actorId: "ops-1" });
    expect(regime.state).toBe(REGIME_STATE.INACTIVE);
  });

  test("an illegal jump is refused and lists what is legal", () => {
    expect(() => regimes.transition(WINTER, REGIME_STATE.ACTIVE, { actor: TRANSITION_ACTOR.OPERATOR })).toThrow(
      /INACTIVE → ACTIVE is not a legal transition/,
    );
  });

  test("every transition is recorded with its actor, so the proposal and its confirmation are reconstructable", () => {
    let regime = regimes.transition(WINTER, REGIME_STATE.PROPOSED_ENTRY, { actor: TRANSITION_ACTOR.FORECAST });
    regime = regimes.transition(regime, REGIME_STATE.ACTIVE, { actor: TRANSITION_ACTOR.OPERATOR, actorId: "ops-1" });
    expect(regime.history.map((step) => step.actor)).toEqual([TRANSITION_ACTOR.FORECAST, TRANSITION_ACTOR.OPERATOR]);
    expect(regime.history[1].actorId).toBe("ops-1");
  });
});

describe("an active regime's deltas", () => {
  const active = { ...WINTER, state: REGIME_STATE.ACTIVE };

  test("bind at time_window, the most specific level, so they win over every other binding", () => {
    const snapshot = service.buildSnapshot({
      bindings: [{ level: "agent_class", key: "porter-2", name: "execute.eta_tolerance", value: 1.1 }],
      regimes: [active],
    });
    const explanation = snapshot.explain("execute.eta_tolerance", {
      agent_class: "porter-2",
      time_window: `regime:${active.name}`,
    });
    expect(explanation.value).toBe(1.8);
    expect(explanation.level).toBe("time_window");
  });

  test("do not apply while the regime is merely proposed", () => {
    const snapshot = service.buildSnapshot({ regimes: [{ ...WINTER, state: REGIME_STATE.PROPOSED_ENTRY }] });
    expect(regimes.bindingsFor({ ...WINTER, state: REGIME_STATE.PROPOSED_ENTRY })).toEqual([]);
    expect(snapshot.activeRegime).toBeNull();
  });

  test("are pinned by name on the snapshot, so a decision taken under a winter regime replays under it", () => {
    const snapshot = service.buildSnapshot({ regimes: [active] });
    expect(snapshot.activeRegime).toBe("first-snowfall");
  });
});

describe("only one regime may be active", () => {
  test("two simultaneously active regimes are refused — the pinned active regime would be ambiguous", () => {
    expect(() =>
      regimes.activeRegime([
        { ...WINTER, state: REGIME_STATE.ACTIVE },
        { ...WINTER, name: "heatwave", state: REGIME_STATE.ACTIVE },
      ]),
    ).toThrow(/two would make a decision unreplayable/);
  });
});

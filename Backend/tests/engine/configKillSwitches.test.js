"use strict";

/**
 * Engine lane — kill switches and the supported ladder (§22.5, §1.8).
 */

const killSwitches = require("../../src/engine/config/killSwitches");
const tierAssertions = require("../../src/engine/guards/tierAssertions");

const { KILL_SWITCH_LADDER, KILL_SWITCHES_OFF_LADDER, COMBINATION_STATUS } = killSwitches;

/** Throw the first `n` switches of the ladder; leave the rest enabled. */
function ladderPrefix(n) {
  const state = Object.fromEntries(killSwitches.KILL_SWITCH_NAMES.map((name) => [name, false]));
  for (const name of KILL_SWITCH_LADDER.slice(0, n)) state[name] = true;
  return state;
}

describe("the switch set", () => {
  test("is the nine §22.5 switches in the ladder order the specification prints", () => {
    expect(KILL_SWITCH_LADDER).toEqual([
      "reposition_injection",
      "preemption",
      "deferral",
      "cross_region_candidacy",
      "chaining",
      "multi_leg_columns",
      "reliability_based_gating",
      "batch_solving",
      "opportunity_cost_term",
    ]);
  });

  test("agrees with the Phase 0 tier registry in both directions", () => {
    expect(KILL_SWITCH_LADDER).toEqual(tierAssertions.KILL_SWITCH_LADDER);
    expect(KILL_SWITCHES_OFF_LADDER).toEqual(tierAssertions.KILL_SWITCHES_OFF_LADDER);
    expect(killSwitches.KILL_SWITCH_NAMES).toEqual(tierAssertions.KILL_SWITCHES);
  });

  test("the register file and the switch table agree in both directions", () => {
    const service = require("../../src/engine/config/service");
    const generated = killSwitches.registerEntries();
    const entries = service.loadRegister().entries;

    for (const entry of generated) {
      expect({ name: entry.name, registered: entries.has(entry.name) }).toEqual({ name: entry.name, registered: true });
      const { registerFile, ...stored } = entries.get(entry.name);
      expect(stored).toEqual(entry);
    }

    const registeredSwitches = [...entries.keys()].filter((name) => name.startsWith("killswitch."));
    expect(registeredSwitches.sort()).toEqual(generated.map((entry) => entry.name).sort());
  });

  test("every Tier 2 mechanism the registry names has a switch here (§1.8 rule 1)", () => {
    const mechanisms = tierAssertions.mechanismsAtTier(tierAssertions.TIER.ALLOCATION_QUALITY);
    for (const mechanism of mechanisms) {
      expect({ id: mechanism.id, known: killSwitches.isKnownSwitch(mechanism.killSwitch) }).toEqual({
        id: mechanism.id,
        known: true,
      });
    }
  });

  test("every switch states what it degrades to, and the multi-Leg switch degrades to a stronger guarantee", () => {
    for (const name of killSwitches.KILL_SWITCH_NAMES) {
      expect(killSwitches.KILL_SWITCHES[name].degradesTo).toBeTruthy();
    }
    expect(killSwitches.KILL_SWITCHES.multi_leg_columns.degradesTo).toMatch(/integral and exact/);
  });

  test("an unrecognised switch name is refused rather than silently ignored", () => {
    expect(() => killSwitches.normaliseState({ turbo_mode: true })).toThrow(/not recognised/);
    expect(() => killSwitches.isEnabled({}, "turbo_mode")).toThrow(/not recognised/);
  });
});

describe("the default state is the §1.8 rule 3 launch engine", () => {
  test("every switch ships thrown — Tier 0 plus Tier 1 is the complete, safe, shippable engine", () => {
    const state = killSwitches.defaultState();
    expect(Object.values(state).every(Boolean)).toBe(true);
    expect(killSwitches.classify(state).status).toBe(COMBINATION_STATUS.TIER_ONE_BASELINE);
  });

  test("the launch state does not alert, so the mandated ship configuration is not perpetually unrehearsed", () => {
    expect(killSwitches.classify(killSwitches.defaultState()).acknowledgementRequired).toBe(false);
  });

  test("no Tier 2 mechanism is enabled at launch", () => {
    const state = killSwitches.defaultState();
    for (const name of killSwitches.KILL_SWITCH_NAMES) {
      expect({ name, enabled: killSwitches.isEnabled(state, name) }).toEqual({ name, enabled: false });
    }
  });
});

describe("§22.5 rule 2 — the supported set is the prefixes of the ladder", () => {
  test.each(KILL_SWITCH_LADDER.map((_, index) => index + 1))("prefix of length %i is rehearsed", (length) => {
    const classification = killSwitches.classify(ladderPrefix(length));
    if (length === KILL_SWITCH_LADDER.length) {
      // Every ladder switch thrown but the three off-ladder ones still enabled: a
      // full ladder prefix, and rehearsed.
      expect(classification.status).toBe(COMBINATION_STATUS.REHEARSED);
    } else {
      expect(classification.status).toBe(COMBINATION_STATUS.REHEARSED);
    }
    expect(classification.acknowledgementRequired).toBe(false);
    expect(classification.ladderPrefixLength).toBe(length);
  });

  test("a non-prefix combination is permitted, but recorded as unrehearsed and needs acknowledgement", () => {
    const state = ladderPrefix(0);
    state.batch_solving = true; // eighth on the ladder, thrown on its own
    const classification = killSwitches.classify(state);
    expect(classification.status).toBe(COMBINATION_STATUS.UNREHEARSED);
    expect(classification.acknowledgementRequired).toBe(true);
    // Permitted: an operator must never be blocked from disabling a specific
    // misbehaving mechanism.
    expect(classification.thrown).toEqual(["batch_solving"]);
  });

  test("throwing an off-ladder switch on its own is unrehearsed, and says why", () => {
    const state = ladderPrefix(0);
    state.churn_pricing = true;
    const classification = killSwitches.classify(state);
    expect(classification.status).toBe(COMBINATION_STATUS.UNREHEARSED);
    expect(classification.notes.join(" ")).toMatch(/recorded discrepancy, Phase 0/);
  });
});

describe("§22.5 rule 3 — the order-dependent pairs", () => {
  test("disabling multi-Leg columns while chaining is still enabled is called out by name", () => {
    const state = ladderPrefix(0);
    state.multi_leg_columns = true;
    const classification = killSwitches.classify(state);
    expect(classification.orderingWarnings.join(" ")).toMatch(/chaining is \*before\* multi-Leg columns|disabled \*before\* multi-Leg columns/);
    expect(classification.status).toBe(COMBINATION_STATUS.UNREHEARSED);
  });

  test("disabling chaining before multi-Leg columns is the rehearsed direction", () => {
    const classification = killSwitches.classify(ladderPrefix(KILL_SWITCH_LADDER.indexOf("chaining") + 1));
    expect(classification.orderingWarnings).toEqual([]);
    expect(classification.status).toBe(COMBINATION_STATUS.REHEARSED);
  });

  test("the opportunity-cost term is last on the ladder, and degrades to static priors rather than to zero", () => {
    expect(KILL_SWITCH_LADDER[KILL_SWITCH_LADDER.length - 1]).toBe("opportunity_cost_term");
    expect(killSwitches.KILL_SWITCHES.opportunity_cost_term.degradesTo).toMatch(/static per-zone, per-bucket priors/);
  });
});

describe("§22.5 rule 4 — switch state is part of the replay input", () => {
  const { captureSnapshot } = require("../../src/engine/determinism/snapshot");

  test("a pinned snapshot carries every switch state, so a decision replays under the thrown switch", () => {
    const state = ladderPrefix(3);
    const snapshot = captureSnapshot({
      roundId: "r-1",
      decisionTime: 1,
      configVersion: 1,
      codeVersion: "test",
      killSwitchState: state,
    });
    expect(snapshot.killSwitchState).toEqual(state);
  });

  test("two rounds differing only in a switch state produce different snapshot hashes", () => {
    const base = {
      roundId: "r-1",
      decisionTime: 1,
      configVersion: 1,
      codeVersion: "test",
    };
    const a = captureSnapshot({ ...base, killSwitchState: ladderPrefix(3) });
    const b = captureSnapshot({ ...base, killSwitchState: ladderPrefix(4) });
    expect(a.hash).not.toBe(b.hash);
  });
});

"use strict";

/**
 * Engine lane — Phase 6: the 38-predicate constraint register (§7.5).
 *
 * §24.1's requirement for this phase, quoted by the execution plan:
 *
 * > Unit: **each of the 38 predicates tested exhaustively at its boundaries, all three
 * > outcomes, and its declared indeterminate policy** (§24.1).
 *
 * The table below is that test. Every predicate gets three cases driven from one
 * fixture in which all 38 are satisfied, so a rejection is attributable to the single
 * input the case mutated rather than to whatever else happened to be missing:
 *
 *   - **SATISFIED**     — the unmutated fixture.
 *   - **VIOLATED**      — a measured fact that fails. This is the *boundary* case: the
 *     mutation moves one input across its threshold and no further.
 *   - **INDETERMINATE** — the input removed. Absence, not a falsy value, because §7.3
 *     keeps "could not be evaluated" apart from "evaluated to false" and the whole
 *     register turns on that distinction.
 *
 * Predicates are evaluated **directly**, not through the gate. The gate short-circuits
 * on the first denial, so a mutation for F34 would be masked by F1 in a context that
 * was incomplete for both; calling the module isolates it.
 *
 * A separate block then asserts the property §7.3 makes mandatory — every class I and R
 * predicate resolves `INDETERMINATE` to a denial — by running the declared policy over
 * the actual result, rather than by re-reading the register's own claim about itself.
 */

const fx = require("./helpers/feasibilityFixture");
const { OUTCOME, POLICY, CONSTRAINT_CLASS, applyPolicy } = require("../../src/engine/feasibility/threeValued");
const { PREDICATES, predicate } = require("../../src/engine/feasibility/register");

const R = fx.REMOVE;
const AFTER_END = new Date(fx.PLAN_END_MS + 60 * fx.MINUTE_MS);
const BEFORE_END = new Date(fx.PLAN_END_MS - 10 * fx.MINUTE_MS);

/**
 * One row per predicate: the patch that makes it VIOLATED, and the patch that makes it
 * INDETERMINATE. `satisfiedPatch` is for the two predicates whose satisfied baseline is
 * vacuous (F25 with no thermal payload) and which therefore need a non-vacuous
 * satisfied case of their own.
 */
const CASES = Object.freeze({
  F1: {
    violated: { agentSnapshot: { commissioning: { commissioned: false } } },
    indeterminate: { agentSnapshot: { commissioning: R } },
  },
  F2: {
    violated: { agentSnapshot: { lifecycleState: "MAINTENANCE" } },
    indeterminate: { agentSnapshot: { lifecycleState: R } },
  },
  F3: {
    violated: { agentSnapshot: { operatorHold: { held: true, reason: "investigation" } } },
    indeterminate: { agentSnapshot: { operatorHold: R } },
  },
  F4: {
    violated: { mission: { tenantId: "tenant-b" } },
    indeterminate: { mission: { tenantId: "tenant-b" }, agentSnapshot: { permittedTenants: R } },
  },
  F5: {
    violated: { agentSnapshot: { firmwareVersion: "9.9.9" } },
    indeterminate: { agentSnapshot: { firmwareVersion: R } },
  },
  F6: {
    violated: { agentSnapshot: { calibrations: [{ name: "lidar", validUntil: BEFORE_END }] } },
    indeterminate: { agentSnapshot: { calibrations: [{ name: "lidar", validUntil: null }] } },
  },
  F7: {
    violated: { agentSnapshot: { emergencyStop: { value: true } } },
    indeterminate: { agentSnapshot: { emergencyStop: R } },
  },
  F8: {
    violated: { agentSnapshot: { faults: [{ code: "drive-fault", severity: "BLOCKING", active: true }] } },
    indeterminate: { agentSnapshot: { faults: R } },
  },
  F9: {
    violated: { agentSnapshot: { healthTier: "MARGINAL" } },
    indeterminate: { agentSnapshot: { healthTier: R } },
  },
  F10: {
    // Boundary: threshold is 0.85, so 0.84 fails by the smallest meaningful step.
    violated: { agentSnapshot: { localisation: { confidence: 0.84 } } },
    // Corroboration unavailable is INDETERMINATE, not satisfied — §7.5 F10 says so
    // explicitly, and it is the case a high self-reported confidence must not rescue.
    indeterminate: { agentSnapshot: { localisation: { corroborations: R } } },
  },
  F11: {
    violated: { agentSnapshot: { reliability: { interventionRate: 0.5 } } },
    indeterminate: { agentSnapshot: { reliability: { interventionRate: R } } },
  },
  F12: {
    violated: {
      agentSnapshot: { advisories: [{ advisoryId: "SR-2026-04", agentClassId: "SIDEWALK_V2", safetyRelevant: true }] },
    },
    indeterminate: { agentSnapshot: { advisories: R } },
  },
  F13: {
    violated: { agentSnapshot: { session: { lastHeartbeatAt: new Date(fx.DECISION_TIME_MS - 60_000) } } },
    indeterminate: { agentSnapshot: { session: R } },
  },
  F14: {
    violated: {
      agentSnapshot: {
        session: {
          lastCommandRoundTripAt: new Date(fx.DECISION_TIME_MS - 60_000),
          lastHeartbeatAckAt: new Date(fx.DECISION_TIME_MS - 60_000),
        },
      },
    },
    indeterminate: { agentSnapshot: { session: { lastCommandRoundTripAt: R, lastHeartbeatAckAt: R } } },
  },
  F15: {
    violated: { agentSnapshot: { session: { linkQuality: 0.1 } } },
    indeterminate: { agentSnapshot: { session: { linkQuality: R } } },
  },
  F16: {
    violated: {
      agentSnapshot: {
        safetyRelevantObservations: {
          position: { observation: { deadReckoned: true, uncertaintyRadiusM: 12 } },
        },
      },
    },
    indeterminate: { agentSnapshot: { safetyRelevantObservations: R } },
  },
  F17: {
    // Boundary: capacity is 2, so 3 is the first infeasible count.
    violated: { plan: { concurrentCommitments: 3 } },
    indeterminate: { config: { capacity: R } },
  },
  F18: {
    violated: {
      agentSnapshot: {
        reservations: [
          { subsystem: "MAINTENANCE", from: new Date(fx.PLAN_START_MS + fx.MINUTE_MS), until: new Date(fx.PLAN_END_MS) },
        ],
      },
    },
    indeterminate: { agentSnapshot: { reservations: R } },
  },
  F19: {
    violated: { agentSnapshot: { projectedAvailableAtMs: fx.PLAN_START_MS + fx.MINUTE_MS } },
    indeterminate: { agentSnapshot: { projectedAvailableAtMs: R } },
  },
  F20: {
    violated: { agentSnapshot: { legExclusions: { nackCooloffUntil: new Date(fx.DECISION_TIME_MS + 5 * fx.MINUTE_MS) } } },
    indeterminate: { agentSnapshot: { legExclusions: R } },
  },
  F21: {
    violated: { mission: { requirements: [{ name: "max_payload_mass", comparator: "AT_LEAST", value: 50 }] } },
    indeterminate: { mission: { requirements: [{ name: "cold_chain", comparator: "PRESENT" }] } },
  },
  F22: {
    // Boundary: 20 kg rated x 0.9 safety factor = 18 kg. 18.1 is the first failure.
    violated: { plan: { loadState: [{ sequence: 1, massUpperBoundKg: 18.1, cog: { withinEnvelope: true, envelopeMarginMm: 10 } }] } },
    indeterminate: { plan: { loadState: R } },
  },
  F23: {
    violated: { plan: { packing: { verdict: "INFEASIBLE", bindingConstraint: "aperture" } } },
    // §15.3 tier-3 budget exhaustion is INDETERMINATE, not INFEASIBLE.
    indeterminate: { plan: { packing: { verdict: "BUDGET_EXHAUSTED", tier: 3 } } },
  },
  F24: {
    violated: {
      plan: { loadState: [{ sequence: 1, massUpperBoundKg: 8, cog: { withinEnvelope: false, envelopeMarginMm: -12 } }] },
    },
    indeterminate: { plan: { loadState: [{ sequence: 1, massUpperBoundKg: 8, cog: R }] } },
  },
  F25: {
    satisfiedPatch: {
      mission: { payload: { thermalMinC: 2, thermalMaxC: 8, thermalMaxExcursionSeconds: 600 } },
      plan: {
        packing: {
          thermalAssignment: { compartmentId: "c1", thermalMinC: 0, thermalMaxC: 10, activeThermal: true },
        },
      },
    },
    violated: {
      mission: { payload: { thermalMinC: -20, thermalMaxC: -10 } },
      plan: {
        packing: {
          thermalAssignment: { compartmentId: "c1", thermalMinC: 0, thermalMaxC: 10, activeThermal: true },
        },
      },
    },
    indeterminate: { mission: { payload: { thermalMinC: 2, thermalMaxC: 8 } }, plan: { packing: { thermalAssignment: R } } },
  },
  F26: {
    violated: {
      plan: {
        packing: {
          compartmentLoads: [
            {
              compartmentId: "c1",
              lockClass: null,
              items: [
                { itemId: "oxidiser", hazardClasses: ["UN1479"], segregation: { incompatibleHazardClasses: ["UN1263"] } },
                { itemId: "paint", hazardClasses: ["UN1263"], segregation: { incompatibleHazardClasses: [] } },
              ],
            },
          ],
        },
      },
    },
    indeterminate: {
      plan: {
        packing: {
          compartmentLoads: [{ compartmentId: "c1", lockClass: null, items: [{ itemId: "unknown", hazardClasses: R }] }],
        },
      },
    },
  },
  F27: {
    violated: { plan: { route: { zonesTraversed: ["zone-1", "zone-9"] } } },
    indeterminate: { agentSnapshot: { authorisedZoneIds: R } },
  },
  F28: {
    violated: { plan: { route: { surfaceClasses: ["FOOTWAY", "CARRIAGEWAY"] } } },
    // A route computed under a different profile: its surfaces may be fine, but they
    // were selected against different constraints.
    indeterminate: { plan: { route: { profileKey: "drone-v1:AIRSPACE_VOLUME:loaded" } } },
  },
  F29: {
    // Boundary: the agent is 700 mm wide, so a 699 mm constriction is the first failure.
    violated: { plan: { route: { constrictions: [{ at: "alley-3", widthMm: 699 }] } } },
    indeterminate: { agentSnapshot: { mobilityModel: { dimensionalFootprint: { widthMm: R } } } },
  },
  F30: {
    violated: {
      plan: {
        route: {
          zoneTraversals: [
            {
              zoneId: "zone-1",
              enterMs: fx.PLAN_START_MS,
              exitMs: fx.PLAN_END_MS,
              restrictions: [{ kind: "CURFEW", closedFromMs: fx.PLAN_START_MS, closedUntilMs: fx.PLAN_END_MS }],
            },
          ],
        },
      },
    },
    indeterminate: {
      plan: {
        route: {
          zoneTraversals: [{ zoneId: "zone-1", enterMs: fx.PLAN_START_MS, exitMs: fx.PLAN_END_MS, restrictions: R }],
        },
      },
    },
  },
  F31: {
    // Boundary: the envelope maximum is 40 kph, so 41 is the first failure.
    violated: { plan: { environmentForecast: { variables: { windGustKph: { worstCase: 41 } } } } },
    indeterminate: { plan: { environmentForecast: R } },
  },
  F32: {
    violated: { plan: { stops: [{ accessPrerequisites: [{ kind: "LIFT", availability: "UNOBTAINABLE" }] }] } },
    indeterminate: { plan: { stops: [{ accessPrerequisites: [{ kind: "LIFT", availability: "UNKNOWN" }] }] } },
  },
  F33: {
    violated: { plan: { stops: [{ lat: 200 }] } },
    indeterminate: { plan: { stops: [{ serviceable: R }] } },
  },
  F34: {
    // Boundary: alpha[T3] is 1e-7, so 1.1e-7 is the first failure, and T3 binds
    // because T1 and T2 remain comfortably inside their own targets.
    violated: { plan: { energy: { tierProbabilities: { T3: 1.1e-7 } } } },
    indeterminate: { plan: { energy: R } },
  },
  F35: {
    violated: { plan: { energy: { chargerReachability: { reachable: false, surplusWh: -40 } } } },
    indeterminate: { plan: { energy: { chargerReachability: R } } },
  },
  F36: {
    violated: { agentSnapshot: { maintenance: { serviceDueAt: BEFORE_END } } },
    indeterminate: { agentSnapshot: { maintenance: R } },
  },
  F37: {
    violated: { mission: { deadlineMs: BEFORE_END.getTime(), deadlineIsContractuallyHard: true } },
    indeterminate: { mission: { deadlineIsContractuallyHard: R } },
  },
  F38: {
    // A duplicate sequence: the plan is neither executable nor orderable.
    violated: { plan: { stops: [{ sequence: 2 }, { sequence: 2 }] } },
    indeterminate: { plan: { stops: [{ projectedArrivalMs: R }, {}] } },
  },
});

/**
 * @param {string} id
 * @param {object|undefined} patch
 * @returns {object} the predicate's result under the patched fixture
 */
function evaluate(id, patch) {
  return predicate(id).evaluate(patch ? fx.withPatch(patch) : fx.context());
}

/* ═══════════════════════════════════════════════════════════════════════════
   The fixture itself
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the all-satisfied fixture", () => {
  test("every one of the 38 predicates is SATISFIED", () => {
    // The precondition every case below relies on. If this fails, no VIOLATED case can
    // be attributed to the input it mutated.
    const unsatisfied = PREDICATES.filter((entry) => entry.evaluate(fx.context()).outcome !== OUTCOME.SATISFIED).map(
      (entry) => `${entry.id}: ${entry.evaluate(fx.context()).outcome} — ${entry.evaluate(fx.context()).reason}`,
    );
    expect(unsatisfied).toEqual([]);
  });

  test("the case table covers all 38 predicates", () => {
    expect(Object.keys(CASES).sort()).toEqual(PREDICATES.map((entry) => entry.id).sort());
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §24.1 — every predicate, all three outcomes, at its boundary
   ═══════════════════════════════════════════════════════════════════════════ */

describe.each(PREDICATES.map((entry) => [entry.id, entry]))("%s", (id, entry) => {
  const testCase = CASES[id];

  test(`is SATISFIED on the complete fixture — ${entry.name}`, () => {
    const result = evaluate(id, testCase.satisfiedPatch);
    expect(result.outcome).toBe(OUTCOME.SATISFIED);
  });

  test("is VIOLATED at its boundary, and reports observed and required", () => {
    const result = evaluate(id, testCase.violated);
    expect(result.outcome).toBe(OUTCOME.VIOLATED);
    // §7.7's tuple: a rejection that cannot say what it saw and what it wanted is a
    // log line, which is what this phase replaces.
    expect(result.observed).not.toBeNull();
    expect(result.required).not.toBeNull();
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  test("is INDETERMINATE when its input is absent, never SATISFIED", () => {
    const result = evaluate(id, testCase.indeterminate);
    expect(result.outcome).toBe(OUTCOME.INDETERMINATE);
    // T2: unknown is never permission. Stated as its own assertion because this is the
    // exact inversion §7.3 describes in the baseline.
    expect(result.outcome).not.toBe(OUTCOME.SATISFIED);
  });

  test("a margin, where one is reported, carries its unit", () => {
    // §7.7's near-miss sketch buckets on the unit; a margin without one is not
    // recordable, and pooling dimensions would make the quantile meaningless.
    for (const patch of [undefined, testCase.violated, testCase.indeterminate]) {
      const result = evaluate(id, patch);
      if (result.margin !== null) expect(result.marginUnit).not.toBeNull();
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §7.3 — the declared indeterminate policy, applied to the actual result
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§7.3 — declared indeterminate policies", () => {
  test("every class I and R predicate DENIES on indeterminate", () => {
    // The mandatory rule, checked against the *resolution* rather than against the
    // register's own claim: applyPolicy is what the gate actually calls.
    const admitted = [];
    for (const entry of PREDICATES) {
      if (entry.constraintClass !== CONSTRAINT_CLASS.INVARIANT && entry.constraintClass !== CONSTRAINT_CLASS.REGULATORY) {
        continue;
      }
      const result = evaluate(entry.id, CASES[entry.id].indeterminate);
      const resolution = applyPolicy(result, entry, {
        // Offered deliberately: neither may rescue a class I or R predicate.
        envelopeFeasible: true,
        uncertaintyPenaltyMilliCu: 1000,
      });
      if (resolution.admitted) admitted.push(`${entry.id} (class ${entry.constraintClass}) admitted on INDETERMINATE`);
    }
    expect(admitted).toEqual([]);
  });

  test("the three non-DENY predicates are exactly F11, F15, and F32", () => {
    // §7.5's Indeterminate column. Any fourth is a relaxation that must be argued for
    // against the specification, not introduced by editing one predicate.
    const nonDeny = PREDICATES.filter((entry) => entry.policy !== POLICY.DENY).map((entry) => `${entry.id}:${entry.policy}`);
    expect(nonDeny).toEqual([
      `F11:${POLICY.ADMIT_WITH_PENALTY}`,
      `F15:${POLICY.ADMIT_WITH_PENALTY}`,
      `F32:${POLICY.DENY_UNLESS_ENVELOPE}`,
    ]);
  });

  test("F11 admits on indeterminate with the penalty, and denies without it", () => {
    const result = evaluate("F11", CASES.F11.indeterminate);
    const entry = predicate("F11");

    const withPenalty = applyPolicy(result, entry, { uncertaintyPenaltyMilliCu: 500 });
    expect(withPenalty.admitted).toBe(true);
    expect(withPenalty.penaltyMilliCu).toBe(500);
    expect(withPenalty.envelopeReduced).toBe(true);

    // Admitting without the penalty would silently downgrade ADMIT_WITH_PENALTY to
    // ADMIT, which is a different policy and one F11 does not declare.
    const withoutPenalty = applyPolicy(result, entry, {});
    expect(withoutPenalty.admitted).toBe(false);
  });

  test("F11's indeterminate result carries the cohort prior it stands in for", () => {
    // §7.5 F11: "ADMIT_WITH_PENALTY using the cohort prior". The prior travels in the
    // tuple so a reviewer can see whether the prior itself was near the bound.
    const result = evaluate("F11", CASES.F11.indeterminate);
    expect(result.observed.cohortPrior).toBe(0.05);
  });

  test("F32 denies on indeterminate unless a reduced envelope is established", () => {
    const result = evaluate("F32", CASES.F32.indeterminate);
    const entry = predicate("F32");

    // The policy's name read literally: absent an answer, it denies.
    expect(applyPolicy(result, entry, {}).admitted).toBe(false);
    expect(applyPolicy(result, entry, { envelopeFeasible: false }).admitted).toBe(false);

    const withEnvelope = applyPolicy(result, entry, { envelopeFeasible: true });
    expect(withEnvelope.admitted).toBe(true);
    expect(withEnvelope.envelopeReduced).toBe(true);
  });

  test("no policy admits a VIOLATED outcome, whatever is offered", () => {
    // T1: safety constraints are absolute and never priced. A measured violation is
    // not a policy question.
    for (const entry of PREDICATES) {
      const result = evaluate(entry.id, CASES[entry.id].violated);
      const resolution = applyPolicy(result, entry, { envelopeFeasible: true, uncertaintyPenaltyMilliCu: 1 });
      expect(resolution.admitted).toBe(false);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Predicate-specific properties the register cannot express
   ═══════════════════════════════════════════════════════════════════════════ */

describe("F10 — independent corroboration (§7.5 F10, §23.5)", () => {
  test("high confidence alone does not satisfy: corroboration is required", () => {
    // The predicate's whole point. A localisation stack that has failed reports high
    // confidence in a wrong pose, so its own opinion cannot be the sole basis.
    const result = evaluate("F10", { agentSnapshot: { localisation: { confidence: 0.99, corroborations: [] } } });
    expect(result.outcome).toBe(OUTCOME.INDETERMINATE);
  });

  test("a disagreeing corroborator VIOLATES even at maximum reported confidence", () => {
    const result = evaluate("F10", {
      agentSnapshot: {
        localisation: {
          confidence: 1,
          corroborations: [{ kind: "INDEPENDENT_FIX", available: true, divergenceM: 40 }],
        },
      },
    });
    expect(result.outcome).toBe(OUTCOME.VIOLATED);
    expect(result.observed.divergenceM).toBe(40);
  });

  test("an unavailable corroborator is INDETERMINATE, not ignored", () => {
    const result = evaluate("F10", {
      agentSnapshot: { localisation: { corroborations: [{ kind: "MAP_MATCH", available: false }] } },
    });
    expect(result.outcome).toBe(OUTCOME.INDETERMINATE);
  });

  test("the divergence bound is the boundary", () => {
    const at = evaluate("F10", {
      agentSnapshot: { localisation: { corroborations: [{ kind: "ODOMETRY", available: true, divergenceM: 5 }] } },
    });
    const past = evaluate("F10", {
      agentSnapshot: { localisation: { corroborations: [{ kind: "ODOMETRY", available: true, divergenceM: 5.01 }] } },
    });
    expect(at.outcome).toBe(OUTCOME.SATISFIED);
    expect(past.outcome).toBe(OUTCOME.VIOLATED);
  });
});

describe("F34 — all three tiers, with the binding tier recorded (§14.5, §7.7)", () => {
  test("all three tier probabilities are evaluated, not just the strictest", () => {
    const result = evaluate("F34");
    expect(result.observed.tiers.map((row) => row.tier)).toEqual(["T1", "T2", "T3"]);
  });

  test("each tier can bind independently, and the binding tier is reported", () => {
    for (const [tier, probability] of [["T1", 2e-2], ["T2", 2e-5], ["T3", 2e-7]]) {
      const result = evaluate("F34", { plan: { energy: { tierProbabilities: { [tier]: probability } } } });
      expect(result.outcome).toBe(OUTCOME.VIOLATED);
      expect(result.observed.bindingTier).toBe(tier);
      // §14.5's consequence column travels with it: "this mission failed on
      // immobilisation risk" and "on divert-to-charge risk" need different responses.
      expect(typeof result.observed.consequence).toBe("string");
    }
  });

  test("where more than one tier fails, the tightest margin binds", () => {
    // T1 fails by 1e-2 of headroom, T3 by 1e-7. T3 is the condition that must move
    // furthest in relative terms and is the one an operator must act on.
    const result = evaluate("F34", { plan: { energy: { tierProbabilities: { T1: 2e-2, T3: 1e-3 } } } });
    expect(result.outcome).toBe(OUTCOME.VIOLATED);
    expect(result.observed.bindingTier).toBe("T3");
  });

  test("the margin is a probability, so the near-miss sketch is interpretable", () => {
    const result = evaluate("F34", CASES.F34.violated);
    expect(result.marginUnit).toBe("prob");
  });

  test("a missing alpha[tier] is INDETERMINATE, never a hand-set fallback", () => {
    // §14.5: the composed fleet-year budget is the governed parameter and alpha is
    // derived from it. An unresolved derivation is not a licence to invent one.
    const result = evaluate("F34", { config: { "energy.shortfall_probability": R } });
    expect(result.outcome).toBe(OUTCOME.INDETERMINATE);
  });

  test("a tier with no projected probability is INDETERMINATE, not skipped", () => {
    const result = evaluate("F34", { plan: { energy: { tierProbabilities: { T2: R } } } });
    expect(result.outcome).toBe(OUTCOME.INDETERMINATE);
  });
});

describe("F35 — replayability of the charger-reachability verdict (§14.5, ADR 21)", () => {
  test("a pinned-projection verdict without a projection version is INDETERMINATE", () => {
    // A verdict that cannot name its projection cannot be replayed (T6, §9.6).
    const result = evaluate("F35", { plan: { energy: { chargerReachability: { projectionVersion: R } } } });
    expect(result.outcome).toBe(OUTCOME.INDETERMINATE);
  });

  test("the depot-only degraded basis is admissible and is recorded", () => {
    const result = evaluate("F35", {
      plan: { energy: { chargerReachability: { basis: "DEPOT_ONLY", projectionVersion: R } } },
    });
    expect(result.outcome).toBe(OUTCOME.SATISFIED);
    expect(result.observed.basis).toBe("DEPOT_ONLY");
  });
});

describe("F17 — a property of the plan, not of the agent (§13.3, §9.3)", () => {
  test("capacity binds at the plan's concurrent-commitment count", () => {
    expect(evaluate("F17", { plan: { concurrentCommitments: 2 } }).outcome).toBe(OUTCOME.SATISFIED);
    expect(evaluate("F17", { plan: { concurrentCommitments: 3 } }).outcome).toBe(OUTCOME.VIOLATED);
  });

  test("with no plan it is INDETERMINATE — it never falls back to an agent property", () => {
    // Falling back would couple this candidate to the solver's other provisional
    // choices, making the assignment problem non-separable (§9.3).
    const result = evaluate("F17", { plan: R });
    expect(result.outcome).toBe(OUTCOME.INDETERMINATE);
    expect(result.reason).toMatch(/property of the plan/i);
  });

  test("capacity 1 reproduces the strict one-mission-per-agent rule exactly", () => {
    const patch = { config: { capacity: { SIDEWALK_V2: 1 } } };
    expect(evaluate("F17", { ...patch, plan: { concurrentCommitments: 1 } }).outcome).toBe(OUTCOME.SATISFIED);
    expect(evaluate("F17", { ...patch, plan: { concurrentCommitments: 2 } }).outcome).toBe(OUTCOME.VIOLATED);
  });

  test("the commitment horizon binds independently of the count", () => {
    const result = evaluate("F17", { plan: { horizonEndMs: fx.DECISION_TIME_MS + 3 * 3_600_000 } });
    expect(result.outcome).toBe(OUTCOME.VIOLATED);
    expect(result.marginUnit).toBe("ms");
  });
});

describe("F37 — soft deadlines are priced, not gated (§7.5 F37, §8.7)", () => {
  test("a missed soft deadline is SATISFIED, with the shortfall reported", () => {
    // Refusing to serve a late task is usually worse than serving it late.
    const result = evaluate("F37", {
      mission: { deadlineMs: BEFORE_END.getTime(), deadlineIsContractuallyHard: false },
    });
    expect(result.outcome).toBe(OUTCOME.SATISFIED);
    expect(result.observed.shortfallMs).toBeGreaterThan(0);
  });

  test("the same deadline gates when it is contractually hard", () => {
    const result = evaluate("F37", {
      mission: { deadlineMs: BEFORE_END.getTime(), deadlineIsContractuallyHard: true },
    });
    expect(result.outcome).toBe(OUTCOME.VIOLATED);
  });

  test("hardness is never inferred — an unstated hardness is INDETERMINATE", () => {
    const result = evaluate("F37", { mission: { deadlineIsContractuallyHard: R } });
    expect(result.outcome).toBe(OUTCOME.INDETERMINATE);
  });
});

describe("F33 — malformed coordinates are VIOLATED, not out-of-area (§7.5 F33)", () => {
  test.each([
    ["latitude beyond +90", { lat: 91 }],
    ["latitude beyond -90", { lat: -90.5 }],
    ["longitude beyond +180", { lon: 181 }],
    ["a non-numeric latitude", { lat: "51.5" }],
    ["a null longitude", { lon: null }],
  ])("%s is VIOLATED", (_label, patch) => {
    const result = evaluate("F33", { plan: { stops: [patch] } });
    expect(result.outcome).toBe(OUTCOME.VIOLATED);
    expect(result.reason).toMatch(/malformed coordinate/);
  });

  test("an unassigned serviceability is INDETERMINATE, not out-of-area", () => {
    // Containment is by assignment, not geometry (§3.6).
    expect(evaluate("F33", { plan: { stops: [{ serviceable: R }] } }).outcome).toBe(OUTCOME.INDETERMINATE);
  });
});

describe("F7 — an unparseable emergency-stop reading never clears (§7.5 F7)", () => {
  test.each([[true], ["ENGAGED"], [1], [{}], [null]])("value %p engages", (value) => {
    const result = evaluate("F7", { agentSnapshot: { emergencyStop: { value } } });
    expect(result.outcome).not.toBe(OUTCOME.SATISFIED);
  });

  test("only an explicit false clears", () => {
    expect(evaluate("F7", { agentSnapshot: { emergencyStop: { value: false } } }).outcome).toBe(OUTCOME.SATISFIED);
  });

  test("a stale reading is INDETERMINATE, not last-known-good", () => {
    const result = evaluate("F7", {
      agentSnapshot: { emergencyStop: { observedAt: new Date(fx.DECISION_TIME_MS - 60_000) } },
    });
    expect(result.outcome).toBe(OUTCOME.INDETERMINATE);
  });
});

describe("F8 — graded, not binary (§7.5 F8, §16.5)", () => {
  test("a DEGRADED fault does not bar work", () => {
    const result = evaluate("F8", { agentSnapshot: { faults: [{ code: "x", severity: "DEGRADED", active: true }] } });
    expect(result.outcome).toBe(OUTCOME.SATISFIED);
  });

  test("BLOCKING is the boundary, and CRITICAL is past it", () => {
    expect(evaluate("F8", { agentSnapshot: { faults: [{ code: "x", severity: "BLOCKING", active: true }] } }).outcome).toBe(
      OUTCOME.VIOLATED,
    );
    expect(evaluate("F8", { agentSnapshot: { faults: [{ code: "x", severity: "CRITICAL", active: true }] } }).outcome).toBe(
      OUTCOME.VIOLATED,
    );
  });

  test("an inactive BLOCKING fault does not bar work", () => {
    const result = evaluate("F8", { agentSnapshot: { faults: [{ code: "x", severity: "BLOCKING", active: false }] } });
    expect(result.outcome).toBe(OUTCOME.SATISFIED);
  });

  test("an unrankable severity is INDETERMINATE, not 'probably fine'", () => {
    const result = evaluate("F8", { agentSnapshot: { faults: [{ code: "x", severity: "WEIRD", active: true }] } });
    expect(result.outcome).toBe(OUTCOME.INDETERMINATE);
  });
});

describe("F3 — 'no hold' and 'hold status unknown' are different inputs", () => {
  test("null means consulted-and-none: SATISFIED", () => {
    expect(evaluate("F3", { agentSnapshot: { operatorHold: null } }).outcome).toBe(OUTCOME.SATISFIED);
  });

  test("absent means not-established: INDETERMINATE", () => {
    // Reading an unconsulted hold service as "no hold" would silently re-admit every
    // agent an operator had withdrawn.
    expect(evaluate("F3", { agentSnapshot: { operatorHold: R } }).outcome).toBe(OUTCOME.INDETERMINATE);
  });

  test("a quarantine flag on an otherwise-ACTIVE agent is caught here, not by F2", () => {
    const patch = { agentSnapshot: { quarantined: true } };
    expect(evaluate("F2", patch).outcome).toBe(OUTCOME.SATISFIED);
    expect(evaluate("F3", patch).outcome).toBe(OUTCOME.VIOLATED);
  });
});

describe("F5 — an agent-reported firmware version is not an input (§23.5)", () => {
  test("a self-reported version is INDETERMINATE even when it is in the supported set", () => {
    const result = evaluate("F5", { agentSnapshot: { firmwareVersionSource: "AGENT_REPORT" } });
    expect(result.outcome).toBe(OUTCOME.INDETERMINATE);
  });

  test("an unlisted mission type is INDETERMINATE, not unrestricted", () => {
    const result = evaluate("F5", { mission: { missionType: "HAZMAT" } });
    expect(result.outcome).toBe(OUTCOME.INDETERMINATE);
  });
});

describe("F6 — validity at mission end, not decision time (§2.3, §7.5 F6)", () => {
  test("a certificate valid now but expiring mid-mission is VIOLATED", () => {
    const result = evaluate("F6", {
      agentSnapshot: {
        capabilityBundle: {
          capabilities: [
            {
              name: "handling_certificate",
              kind: "CERTIFIED",
              value: true,
              validFrom: new Date(fx.DECISION_TIME_MS - 86_400_000),
              validUntil: BEFORE_END,
              source: "COMMISSIONING_RECORD",
            },
          ],
        },
      },
    });
    expect(result.outcome).toBe(OUTCOME.VIOLATED);
  });

  test("a certificate with no stated expiry is INDETERMINATE, not valid forever", () => {
    const result = evaluate("F6", {
      agentSnapshot: {
        capabilityBundle: {
          capabilities: [
            { name: "handling_certificate", kind: "CERTIFIED", value: true, validUntil: null, source: "COMMISSIONING_RECORD" },
          ],
        },
      },
    });
    expect(result.outcome).toBe(OUTCOME.INDETERMINATE);
  });

  test("a certificate expiring just after mission end is SATISFIED — the boundary", () => {
    const result = evaluate("F6", {
      agentSnapshot: { calibrations: [{ name: "lidar", validUntil: new Date(fx.PLAN_END_MS) }] },
    });
    expect(result.outcome).toBe(OUTCOME.SATISFIED);
  });
});

describe("F27 — authorisation is a property of the whole route (§7.5 F27)", () => {
  test("legal endpoints do not rescue a route crossing an unauthorised zone", () => {
    const result = evaluate("F27", { plan: { route: { zonesTraversed: ["zone-1", "zone-99", "zone-2"] } } });
    expect(result.outcome).toBe(OUTCOME.VIOLATED);
    expect(result.observed.unauthorisedZones).toEqual(["zone-99"]);
  });

  test("an absent traversed-zone list is INDETERMINATE, not an empty route", () => {
    expect(evaluate("F27", { plan: { route: { zonesTraversed: R } } }).outcome).toBe(OUTCOME.INDETERMINATE);
  });
});

describe("F30 — restrictions apply at traversal time (§7.5 F30)", () => {
  test("a closure after the traversal window does not bind", () => {
    expect(evaluate("F30").outcome).toBe(OUTCOME.SATISFIED);
  });

  test("a closure beginning exactly at the exit does not bind — half-open intervals", () => {
    const result = evaluate("F30", {
      plan: {
        route: {
          zoneTraversals: [
            {
              zoneId: "zone-1",
              enterMs: fx.PLAN_START_MS,
              exitMs: fx.PLAN_END_MS,
              restrictions: [{ kind: "CURFEW", closedFromMs: fx.PLAN_END_MS, closedUntilMs: fx.PLAN_END_MS + 3_600_000 }],
            },
          ],
        },
      },
    });
    expect(result.outcome).toBe(OUTCOME.SATISFIED);
  });
});

describe("F22 — mass at every point in the plan (§15.4)", () => {
  test("a peak at an intermediate stop is caught, not only the endpoints", () => {
    const result = evaluate("F22", {
      plan: {
        loadState: [
          { sequence: 1, massUpperBoundKg: 10, cog: { withinEnvelope: true } },
          { sequence: 2, massUpperBoundKg: 19, cog: { withinEnvelope: true } },
          { sequence: 3, massUpperBoundKg: 4, cog: { withinEnvelope: true } },
        ],
      },
    });
    expect(result.outcome).toBe(OUTCOME.VIOLATED);
    expect(result.observed.stopSequence).toBe(2);
  });

  test("the upper bound of the tolerance is what binds, not the expectation (§15.1)", () => {
    const result = evaluate("F22", {
      plan: { loadState: [{ sequence: 1, massKg: 10, massUpperBoundKg: R, cog: { withinEnvelope: true } }] },
    });
    expect(result.outcome).toBe(OUTCOME.INDETERMINATE);
    expect(result.reason).toMatch(/upper bound/);
  });

  test("exactly at the limit is SATISFIED — 20 kg rated x 0.9 = 18 kg", () => {
    const result = evaluate("F22", {
      plan: { loadState: [{ sequence: 1, massUpperBoundKg: 18, cog: { withinEnvelope: true } }] },
    });
    expect(result.outcome).toBe(OUTCOME.SATISFIED);
  });
});

describe("F23 — tier-3 budget exhaustion is INDETERMINATE (§15.3)", () => {
  test("budget exhaustion is not evidence that no placement exists", () => {
    const result = evaluate("F23", { plan: { packing: { verdict: "BUDGET_EXHAUSTED", tier: 3 } } });
    expect(result.outcome).toBe(OUTCOME.INDETERMINATE);
    expect(result.outcome).not.toBe(OUTCOME.VIOLATED);
  });

  test("an unrecognised verdict is INDETERMINATE, never FEASIBLE", () => {
    expect(evaluate("F23", { plan: { packing: { verdict: "PROBABLY_OK" } } }).outcome).toBe(OUTCOME.INDETERMINATE);
  });
});

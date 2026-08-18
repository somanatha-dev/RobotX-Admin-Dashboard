"use strict";

/**
 * Engine lane — the Phase 6 ↔ Phase 7 seam, exercised by composition rather than by
 * field-name comparison.
 *
 * ── Why this suite exists ───────────────────────────────────────────────────
 * `IMPLEMENTATION_EXECUTION_PLAN.md` makes Phase 7 a hard prerequisite of Phase 6, and
 * Phase 6 was implemented before it. Phase 6's own review recorded that as a disclosed
 * sequencing violation whose consequences were conservative: F22–F26, F34 and F35 are
 * all class **I**, so a missing Phase 7 input becomes `INDETERMINATE` and denies rather
 * than admitting. Phase 7's review then closed the gap by reading each producer and
 * each consumer and confirming the field names and enums matched, field for field.
 *
 * Both are true and neither is composition. `payloadModel.test.js` and
 * `energyModel.test.js` do compose the producers into the seven predicates one at a
 * time — that coverage is real and this suite does not repeat it. What no test did was
 * run a plan whose Phase 7 fragments came from the real producers through the **whole
 * gate**, which is where the properties Phase 6 actually claims live:
 *
 *   - a physics-feasible plan reaches cost as a branded `FeasibleCandidate`;
 *   - a physics-*infeasible* plan is structurally unable to reach cost (I14);
 *   - the systemic guard's tally is driven by real producer output, not by fixtures;
 *   - the composed pipeline is deterministic and replayable (T6, I10);
 *   - a commit-time volatile re-check sees a real Phase 7 state change.
 *
 * Every plan in this file is built by `phase7Plan()`, which runs `payload/packing.js`,
 * `payload/loadState.js`, `energy/tiers.js` and `energy/eReturn.js` for real and grafts
 * their output onto the fixture plan. Nothing here hand-writes a `plan.energy`,
 * `plan.loadState` or `plan.packing`.
 */

const fx = require("./helpers/feasibilityFixture");
const efx = require("./helpers/energyFixture");

const gate = require("../../src/engine/feasibility/evaluate");
const register = require("../../src/engine/feasibility/register");
const systemicGuard = require("../../src/engine/feasibility/systemicGuard");
const volatileSubset = require("../../src/engine/feasibility/volatileSubset");
const { OUTCOME } = require("../../src/engine/feasibility/threeValued");
const tenets = require("../../src/engine/guards/tenets");

const f26 = require("../../src/engine/feasibility/predicates/f26");
const f34 = require("../../src/engine/feasibility/predicates/f34");
const f35 = require("../../src/engine/feasibility/predicates/f35");

const tiers = require("../../src/engine/energy/tiers");
const eReturn = require("../../src/engine/energy/eReturn");
const packing = require("../../src/engine/payload/packing");
const loadState = require("../../src/engine/payload/loadState");
const container = require("../../src/engine/payload/container");
const spec = require("../../src/engine/payload/spec");

const SLA_CLASS = "STANDARD";

/* ═══════════════════════════════════════════════════════════════════════════
   Real Phase 7 producer output, grafted onto the fixture plan
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Run the four Phase 7 producers and return exactly the three plan fragments the seven
 * waiting predicates read.
 *
 * @param {object} [options]
 * @param {object[]} [options.items] the consignment
 * @param {number} [options.usableWh] `E_usable(a)`
 * @param {{meanWh:number,sdWh:number}} [options.distribution] the predictive
 *   distribution of `E_mission`
 * @param {object} [options.projection] the pinned charger-availability projection
 * @returns {{ packing: object, loadState: object[], energy: object,
 *             producer: { tiers: object, eReturn: object, loadState: object } }}
 */
function phase7Fragments(options) {
  const opts = options || {};
  const containerModel = efx.containerModel();
  const items = opts.items || [efx.item({ massKg: 8, massToleranceKg: 0.5 })];

  // §15.3 — the tiered packing search.
  const packed = packing.evaluate({
    container: containerModel,
    consignment: { items },
    packingEfficiency: 0.75,
    nodeBudget: 5000,
  });

  // §15.4 — the per-stop load-state projection, over the packing placement.
  const projected = loadState.project({
    stops: efx.stops(),
    container: container.normalise(containerModel).container,
    compartmentLoads: packed.compartmentLoads,
  });

  // §14.5 — the three shortfall tiers.
  const distribution = opts.distribution || { meanWh: 200, sdWh: 20 };
  const usableWh = opts.usableWh === undefined ? 700 : opts.usableWh;
  const evaluated = tiers.evaluate({
    usableWh,
    distribution,
    layers: efx.reserveLayers(),
    config: efx.config(),
    slaClass: SLA_CLASS,
  });

  // §14.5 — E_return and charger reachability.
  const reach = eReturn.evaluate({
    candidates: efx.reachabilityCandidates(),
    projection: opts.projection === undefined ? efx.projection() : opts.projection,
    decisionTimeMs: efx.DECISION_TIME_MS,
    projectedEndMs: fx.PLAN_END_MS,
    usableWh,
    missionWh: distribution.meanWh,
    floorWh: 80,
    availabilityMargin: 1.15,
    projectionMaxAgeSeconds: 120,
    uncalibratedReserveFactor: 1.25,
  });

  return {
    packing: packed,
    loadState: projected.loadState,
    energy: tiers.planEnergyFragment(evaluated, reach.verdict),
    producer: { tiers: evaluated, eReturn: reach, loadState: projected },
  };
}

/**
 * The fixture plan with its three hand-written Phase 7 fragments replaced by real
 * producer output. The other 31 predicates continue to read the fixture, which is what
 * isolates this suite's subject to the seam.
 *
 * @param {object} [options] as `phase7Fragments`
 * @returns {object} `{ plan, fragments }`
 */
function phase7Plan(options) {
  const fragments = phase7Fragments(options);
  return {
    plan: {
      ...fx.plan(),
      packing: fragments.packing,
      loadState: fragments.loadState,
      energy: fragments.energy,
    },
    fragments,
  };
}

/**
 * A full evaluation context over a Phase 7-produced plan.
 *
 * @param {object} [options] as `phase7Fragments`
 * @returns {object} `{ context, fragments }`
 */
function phase7Context(options) {
  const built = phase7Plan(options);
  return {
    context: { ...fx.context(), plan: built.plan },
    fragments: built.fragments,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   §14.5 — F34 and the energy model must resolve the same α[tier]
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§14.5 — F34 resolves α[tier] the same way the authoritative energy model does", () => {
  // F34 deliberately re-derives its own targets rather than reading the `target` field
  // `energy/tiers.js` computed: a predicate must not take its threshold from the module
  // whose output it is checking. That independence is only safe while the two
  // transcriptions agree on how `energy.shortfall_probability` is indexed — and they
  // once did not. `energy/tiers.js`'s `alphaFor()` reads `map[slaClass][tier]`; F34's
  // generic indexed read looked at `map[tier][slaClass]`, transposed. Under the flat
  // tier-keyed map `config/derived.js` publishes today both land on the same number and
  // the disagreement is invisible; under a class-keyed map they part, and they part in
  // the permissive direction for F34.

  /** A class-keyed map: strict targets for CRITICAL, looser fleet defaults beside them. */
  const classKeyed = {
    T1: 1e-2,
    T2: 1e-5,
    T3: 1e-7,
    CRITICAL: { T1: 1e-4, T2: 1e-6, T3: 1e-9 },
  };

  test("a class-keyed α wins over the tier-keyed default, exactly as energy/tiers.js reads it", () => {
    const config = { ...fx.config(), "energy.shortfall_probability": classKeyed };
    // Between the CRITICAL target (1e-4) and the fleet default (1e-2). The energy model
    // calls this infeasible for a CRITICAL mission.
    const probabilities = { T1: 1e-3, T2: 1e-7, T3: 1e-10 };

    const verdict = f34.evaluate({
      mission: { slaClass: "CRITICAL" },
      plan: { energy: { tierProbabilities: probabilities } },
      config,
    });

    // Before the fix this was SATISFIED: F34 compared against the 1e-2 fleet default
    // while the energy model used 1e-4. A class I predicate admitting a plan the
    // authoritative model calls infeasible is a false positive, which is exactly what
    // §7.3's "unknown is never permission" and T1's "safety constraints are absolute"
    // exist to make impossible.
    expect(verdict.outcome).toBe(OUTCOME.VIOLATED);
    expect(verdict.required.alpha).toBe(1e-4);
    expect(verdict.observed.bindingTier).toBe("T1");
  });

  test("the fleet default still applies to a class with no class-keyed entry", () => {
    const config = { ...fx.config(), "energy.shortfall_probability": classKeyed };
    const verdict = f34.evaluate({
      mission: { slaClass: SLA_CLASS },
      plan: { energy: { tierProbabilities: { T1: 1e-3, T2: 1e-7, T3: 1e-10 } } },
      config,
    });
    expect(verdict.outcome).toBe(OUTCOME.SATISFIED);
    expect(verdict.required.alpha.T1).toBe(1e-2);
  });

  test("the transposed shape neither module declares is INDETERMINATE, not guessed at", () => {
    // `energy/tiers.js` refuses this shape (`alphaFor()` returns ok:false). F34 must
    // refuse it too, or the set of maps F34 accepts stops being a subset of the set the
    // producer accepts — and "F34 admits ⟹ the energy model agrees" stops holding.
    const config = {
      ...fx.config(),
      "energy.shortfall_probability": { T1: { CRITICAL: 1e-4 }, T2: { CRITICAL: 1e-6 }, T3: { CRITICAL: 1e-9 } },
    };
    expect(tiers.alphaFor(config, "T1", "CRITICAL").ok).toBe(false);
    const verdict = f34.evaluate({
      mission: { slaClass: "CRITICAL" },
      plan: { energy: { tierProbabilities: { T1: 1e-3, T2: 1e-7, T3: 1e-10 } } },
      config,
    });
    expect(verdict.outcome).toBe(OUTCOME.INDETERMINATE);
  });

  test("an α at or above 1 is unresolved, not a tier that every plan satisfies", () => {
    // Appendix A bounds this parameter to [0, 1] and `energy/tiers.js` rejects α ≥ 1.
    // Admitting it here would make T1 vacuously satisfied for every plan ever evaluated.
    const config = { ...fx.config(), "energy.shortfall_probability": { T1: 1.5, T2: 1e-5, T3: 1e-7 } };
    expect(tiers.alphaFor(config, "T1", SLA_CLASS).ok).toBe(false);
    const verdict = f34.evaluate({
      mission: { slaClass: SLA_CLASS },
      plan: { energy: { tierProbabilities: { T1: 0.9, T2: 1e-7, T3: 1e-10 } } },
      config,
    });
    expect(verdict.outcome).toBe(OUTCOME.INDETERMINATE);
  });

  test("across every map shape, F34's verdict and the energy model's agree", () => {
    // The property the two independent transcriptions exist to preserve, asserted
    // directly rather than inferred from the cases above.
    const shapes = [
      { T1: 1e-2, T2: 1e-5, T3: 1e-7 },
      classKeyed,
      { T1: { CRITICAL: 1e-4 }, T2: { CRITICAL: 1e-6 }, T3: { CRITICAL: 1e-9 } },
      { T1: 1.5, T2: 1e-5, T3: 1e-7 },
      { T1: 0, T2: 1e-5, T3: 1e-7 },
    ];

    for (const map of shapes) {
      const config = { ...fx.config(), "energy.shortfall_probability": map };
      const producerResolves = tiers.TIER_NAMES.every((tier) => tiers.alphaFor(config, tier, "CRITICAL").ok);
      const verdict = f34.evaluate({
        mission: { slaClass: "CRITICAL" },
        plan: { energy: { tierProbabilities: { T1: 1e-3, T2: 1e-7, T3: 1e-10 } } },
        config,
      });
      const predicateResolves = verdict.outcome !== OUTCOME.INDETERMINATE;
      expect({ map, predicateResolves }).toEqual({ map, predicateResolves: producerResolves });
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The whole gate over a Phase 7-produced plan
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the feasibility gate over a plan whose fragments the Phase 7 producers built", () => {
  test("the producers resolve, and the gate admits and brands the candidate", () => {
    const { context, fragments } = phase7Context();

    // The producers actually ran — this is not a fixture wearing a producer's name.
    expect(fragments.producer.tiers.ok).toBe(true);
    expect(fragments.producer.eReturn.ok).toBe(true);
    expect(fragments.producer.loadState.ok).toBe(true);
    expect(fragments.packing.verdict).toBe(packing.VERDICT.FEASIBLE);
    expect(fragments.energy.tierProbabilities).toBeTruthy();

    const candidate = { agentId: "agent-1", legId: "leg-1" };
    const result = gate.gate(candidate, context, { collectAll: true });

    expect(result.outcome.denials).toEqual([]);
    expect(result.feasible).toBe(true);
    expect(result.outcome.evaluated).toHaveLength(register.PREDICATE_COUNT);

    // I14: the candidate reaches cost only because it carries the brand, and the brand
    // records the evidence — which predicates ran, under which config version.
    expect(tenets.isFeasible(result.candidate)).toBe(true);
    expect(() => tenets.assertFeasible(result.candidate, "test")).not.toThrow();
    expect(tenets.feasibilityEvidence(result.candidate).predicatesEvaluated).toHaveLength(38);
  });

  test("all seven Phase 7-dependent predicates are SATISFIED on real producer output", () => {
    const { context } = phase7Context();
    const outcome = gate.evaluateCandidate(context, { collectAll: true });
    for (const id of ["F22", "F23", "F24", "F25", "F26", "F34", "F35"]) {
      expect({ id, outcome: outcome.verdicts[id].outcome }).toEqual({ id, outcome: OUTCOME.SATISFIED });
    }
  });

  test("a physics-infeasible energy projection cannot reach cost evaluation (I14)", () => {
    // A mission that consumes most of the pack: the tier conditions fail on real
    // arithmetic, not on a hand-set probability.
    const { context, fragments } = phase7Context({ distribution: { meanWh: 560, sdWh: 40 } });

    expect(fragments.producer.tiers.ok).toBe(true);
    expect(fragments.producer.tiers.feasible).toBe(false);

    const candidate = { agentId: "agent-1", legId: "leg-1" };
    const result = gate.gate(candidate, context, { collectAll: true });

    expect(result.feasible).toBe(false);
    // Not merely refused — there is nothing for the cost evaluator to receive.
    expect(result.candidate).toBeNull();
    expect(() => tenets.assertFeasible(candidate, "cost/phi")).toThrow(/did not pass the feasibility gate/);

    const f34Denial = result.outcome.denials.find((row) => row.predicateId === "F34");
    expect(f34Denial.outcome).toBe(OUTCOME.VIOLATED);
    expect(f34Denial.constraintClass).toBe("I");
    // The predicate and the producer name the same binding tier, so the tier an
    // operator sees on the rejection is the tier the energy model says binds (§7.7).
    expect(f34Denial.result.observed.bindingTier).toBe(fragments.producer.tiers.bindingTier);
  });

  test("an overloaded consignment is denied by F22 on the real per-stop projection", () => {
    // The projection is real; the agent is a smaller one. 11 kg + 0.5 kg tolerance is
    // the upper bound §15.1 requires F22 to use, against a 10 kg rating at
    // `payload.safety_factor` 0.9 → 9 kg. F22 reads the *upper* bound, so the 11 kg
    // expectation alone would not have caught this.
    const { plan, fragments } = phase7Plan({
      items: [efx.item({ itemId: "heavy", massKg: 11, massToleranceKg: 0.5, loadBearingLimitKg: 30 })],
    });
    expect(fragments.producer.loadState.ok).toBe(true);
    expect(plan.loadState[0].massUpperBoundKg).toBeCloseTo(11.5, 9);
    expect(plan.loadState[0].massExpectationKg).toBeCloseTo(11, 9);

    const snapshot = { ...fx.agentSnapshot(), containerModel: { ...fx.agentSnapshot().containerModel, totalMassLimitKg: 10 } };
    const outcome = gate.evaluateCandidate({ ...fx.context(), agentSnapshot: snapshot, plan }, { collectAll: true });

    expect(outcome.verdicts.F22.outcome).toBe(OUTCOME.VIOLATED);
    expect(outcome.verdicts.F22.observed.stopSequence).toBe(1);
    expect(outcome.feasible).toBe(false);
  });

  test("a stale charger projection degrades the basis, and F35 accepts the degraded basis", () => {
    // §14.5's fallback is depot-only *plus* the uncalibrated reserve factor: a smaller
    // envelope, not a suspended constraint. F35 must admit it and record it, because
    // denying every candidate on a stale projection is the availability outage §7.4
    // exists to avoid — while still refusing a verdict that cannot name its projection.
    const { context, fragments } = phase7Context({
      projection: efx.projection({ publishedAtMs: efx.DECISION_TIME_MS - 600_000 }),
    });

    expect(fragments.producer.eReturn.basis).toBe(eReturn.BASIS.DEPOT_ONLY);
    const outcome = gate.evaluateCandidate(context, { collectAll: true });
    expect(outcome.verdicts.F35.outcome).toBe(OUTCOME.SATISFIED);
    expect(outcome.verdicts.F35.observed.basis).toBe("DEPOT_ONLY");
  });

  test("the two modules' BASIS enums are independent transcriptions that agree", () => {
    expect(Object.keys(f35.BASIS).sort()).toEqual(Object.keys(eReturn.BASIS).sort());
    for (const key of Object.keys(f35.BASIS)) expect(f35.BASIS[key]).toBe(eReturn.BASIS[key]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Absence of a producer is denial, proven against real absence
   ═══════════════════════════════════════════════════════════════════════════ */

describe("a Phase 7 producer that resolves nothing denies, and never admits", () => {
  // The property Phase 6's review verified by reading each module. Here it is driven by
  // the producers themselves failing to resolve, which is the state a real outage
  // produces: `planEnergyFragment()` returns `null`, `project()` returns `ok:false`,
  // `packing.evaluate()` returns a non-FEASIBLE verdict.

  test("planEnergyFragment returns null when the tier evaluation cannot resolve, and F34/F35 deny", () => {
    const evaluated = tiers.evaluate({
      usableWh: 700,
      distribution: { meanWh: 200, sdWh: 20 },
      layers: efx.reserveLayers(),
      config: { ...efx.config(), "energy.shortfall_probability": null },
      slaClass: SLA_CLASS,
    });
    expect(evaluated.ok).toBe(false);
    expect(tiers.planEnergyFragment(evaluated, null)).toBeNull();

    const context = { ...fx.context(), plan: { ...fx.plan(), energy: null } };
    const outcome = gate.evaluateCandidate(context, { collectAll: true });
    expect(outcome.verdicts.F34.outcome).toBe(OUTCOME.INDETERMINATE);
    expect(outcome.verdicts.F35.outcome).toBe(OUTCOME.INDETERMINATE);
    expect(outcome.feasible).toBe(false);
    expect(outcome.deniedForIndeterminacyOnly).toBe(true);
  });

  test("a load-state projection that cannot resolve denies F22 and F24", () => {
    const projected = loadState.project({ stops: [], container: null, compartmentLoads: [] });
    expect(projected.ok).toBe(false);
    expect(projected.loadState).toBeNull();

    const context = { ...fx.context(), plan: { ...fx.plan(), loadState: projected.loadState } };
    const outcome = gate.evaluateCandidate(context, { collectAll: true });
    expect(outcome.verdicts.F22.outcome).toBe(OUTCOME.INDETERMINATE);
    expect(outcome.verdicts.F24.outcome).toBe(OUTCOME.INDETERMINATE);
    expect(outcome.feasible).toBe(false);
  });

  test("every one of the seven is never-overridable with a mandatory DENY, so absence cannot admit", () => {
    // Six are class I; F25 is §7.5's `C/R`, governed by the stricter half, R. Both
    // classes are "never overridable" under §7.2, which is what makes `DENY` mandatory
    // for all seven under §7.3 — and what makes a missing Phase 7 producer a denial
    // rather than a silent admission.
    for (const id of ["F22", "F23", "F24", "F25", "F26", "F34", "F35"]) {
      const entry = register.predicate(id);
      expect({ id, neverOverridable: ["I", "R"].includes(entry.constraintClass), policy: entry.policy }).toEqual({
        id,
        neverOverridable: true,
        policy: "DENY",
      });
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §7.4 — the systemic guard, driven by a real producer outage
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§7.4 — a fleet-wide Phase 7 outage trips the guard without relaxing anything", () => {
  /**
   * Evaluate a fleet where `fraction` of the agents have no resolvable energy
   * projection, and tally exactly as §7.4 step 1 requires.
   *
   * @param {number} fraction
   * @param {number} size
   * @returns {{ tally: object, assessment: object }}
   */
  function fleetRound(fraction, size) {
    const healthy = phase7Plan().plan;
    const outaged = { ...healthy, energy: null };
    const blind = Math.round(size * fraction);

    let deniedForIndeterminacyOnly = 0;
    let admitted = 0;
    for (let index = 0; index < size; index += 1) {
      const context = { ...fx.context(), plan: index < blind ? outaged : healthy };
      const outcome = gate.evaluateCandidate(context, { collectAll: true });
      if (outcome.feasible) admitted += 1;
      if (outcome.deniedForIndeterminacyOnly) deniedForIndeterminacyOnly += 1;
    }

    const tally = { evaluated: size, admitted, deniedForIndeterminacyOnly };
    return { tally, assessment: systemicGuard.assess(tally, fx.config()) };
  }

  test("a healthy fleet does not trip the guard", () => {
    const { tally, assessment } = fleetRound(0, 20);
    expect(tally.admitted).toBe(20);
    expect(tally.deniedForIndeterminacyOnly).toBe(0);
    expect(assessment.tripped).toBe(false);
    expect(assessment.fraction).toBe(0);
  });

  test("one blind agent constrains only that agent, not the shard", () => {
    const { tally, assessment } = fleetRound(0.05, 20);
    expect(tally.deniedForIndeterminacyOnly).toBe(1);
    expect(tally.admitted).toBe(19);
    // 0.05 is below the configured 0.30 threshold: a local data failure, not a systemic one.
    expect(assessment.tripped).toBe(false);
  });

  test("a fleet-wide outage trips the guard into Restricted Operation", () => {
    const { tally, assessment } = fleetRound(0.8, 20);
    expect(tally.deniedForIndeterminacyOnly).toBe(16);
    expect(assessment.fraction).toBeCloseTo(0.8, 9);
    expect(assessment.threshold).toBe(0.3);
    expect(assessment.tripped).toBe(true);
  });

  test("exactly at the threshold the guard does not trip — §7.4 says 'exceeds'", () => {
    const { assessment } = fleetRound(0.3, 20);
    expect(assessment.fraction).toBeCloseTo(0.3, 9);
    expect(assessment.tripped).toBe(false);
  });

  test("Restricted Operation relaxes no I or R predicate, and F34/F35 still deny", () => {
    const { assessment } = fleetRound(0.8, 20);
    expect(assessment.tripped).toBe(true);

    // The envelope may shrink; it may not waive anything.
    const envelope = systemicGuard.restrictions(fx.config(), { enteredAtMs: fx.DECISION_TIME_MS });
    expect(systemicGuard.assertRelaxesNothing(envelope).problems).toEqual([]);
    expect(envelope.energyReserveMultiplier).toBeGreaterThanOrEqual(1);
    // §7.4 step 3(d) — last-known-good admission *and* independent corroboration, both,
    // never either: an unmonitored agent vouching for itself is what §23.5 forbids.
    expect(envelope.lastKnownGood.requiresIndependentCorroboration).toBe(true);
    expect(envelope.recordCommitmentsAsDegraded).toBe(true);
    // §7.4 step 4 — the mode is time-boxed, so it cannot become the steady state.
    expect(envelope.timeBox.maxDurationMs).toBeGreaterThan(0);

    // And the gate itself is unchanged by the mode: the same blind candidate is still
    // denied, on the same class I predicates, with the guard tripped. There is no
    // parameter by which the envelope could have reached the gate at all.
    const context = { ...fx.context(), plan: { ...phase7Plan().plan, energy: null } };
    const outcome = gate.evaluateCandidate(context, { collectAll: true });
    expect(outcome.feasible).toBe(false);
    expect(outcome.verdicts.F34.outcome).toBe(OUTCOME.INDETERMINATE);
    expect(outcome.verdicts.F35.outcome).toBe(OUTCOME.INDETERMINATE);
  });

  test("restoring the producers clears the trip", () => {
    expect(fleetRound(0.8, 20).assessment.tripped).toBe(true);
    expect(fleetRound(0, 20).assessment.tripped).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §10.3.2 step 3 — the commit-time volatile re-check over real producer output
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§10.3.2 step 3 — a stale positive does not survive a real Phase 7 state change", () => {
  test("F34 and F35 are both on the enumerated volatile subset", () => {
    const subset = volatileSubset.subset();
    expect(subset).toEqual(expect.arrayContaining(["F34", "F35"]));
    expect(volatileSubset.assertSubset().problems).toEqual([]);
  });

  test("a plan feasible at decision time is re-denied at commit when the energy state moves", async () => {
    // T0 — the round admits the candidate on a real energy projection.
    const admitted = phase7Context();
    const first = gate.gate({ agentId: "agent-1", legId: "leg-1" }, admitted.context, { collectAll: true });
    expect(first.feasible).toBe(true);

    // T1 — the agent's usable energy falls before the commit lands. The producers are
    // re-run; nothing about the plan or the config changed.
    const degraded = phase7Context({ usableWh: 430 });
    expect(degraded.fragments.producer.tiers.feasible).toBe(false);

    // T2 — commit step 3 re-evaluates only the volatile subset, against the *new*
    // state, read under the row locks. `buildContext` is the adapter that reads it.
    const recheck = volatileSubset.createVolatileRecheck({
      buildContext: async () => degraded.context,
    });
    const verdict = await recheck({ commitmentId: "c1", agentId: "agent-1", legId: "leg-1" });

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("VOLATILE_FEASIBILITY_LOST");
    expect(verdict.detail).toMatch(/^F34 is VIOLATED at commit time/);
  });

  test("the re-check evaluates the volatile subset and nothing else", () => {
    const { context } = phase7Context({ usableWh: 430 });
    const outcome = volatileSubset.recheck(context);
    expect(outcome.evaluated.sort()).toEqual([...volatileSubset.SPECIFIED_SUBSET].sort());
    expect(outcome.ok).toBe(false);
    expect(outcome.failures.map((row) => row.predicateId)).toEqual(["F34"]);
  });

  test("a re-check whose context cannot be built must not report success", () => {
    // §10.3.2 step 3: "a re-check that cannot build its inputs must not report success
    // — that is the informal bypass under latency pressure §7.1 predicts."
    expect(() => volatileSubset.createVolatileRecheck({})).toThrow(/buildContext adapter/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   T6, I10 — the composed pipeline is deterministic and replayable
   ═══════════════════════════════════════════════════════════════════════════ */

describe("T6, I10 — the producer → predicate pipeline replays identically", () => {
  test("the same inputs give the same producer output and the same verdicts, 100 times", () => {
    const first = phase7Context();
    const reference = JSON.stringify(gate.evaluateCandidate(first.context, { collectAll: true }).verdicts);

    for (let run = 0; run < 100; run += 1) {
      const repeat = phase7Context();
      expect(JSON.stringify(repeat.fragments.energy)).toBe(JSON.stringify(first.fragments.energy));
      expect(JSON.stringify(gate.evaluateCandidate(repeat.context, { collectAll: true }).verdicts)).toBe(reference);
    }
  });

  test("a serialised Phase 7 plan deserialises to the same verdicts (§9.6, Phase 10 replay)", () => {
    const { context } = phase7Context();
    const direct = gate.evaluateCandidate(context, { collectAll: true });

    // Phase 10 replays a decision from its recorded inputs, which arrive as JSON. A
    // verdict that survives the round trip is one a replay can reproduce; a hidden
    // non-serialisable input would show up here as a changed outcome.
    const revived = JSON.parse(JSON.stringify({ plan: context.plan }));
    const replayed = gate.evaluateCandidate({ ...context, plan: revived.plan }, { collectAll: true });

    for (const id of ["F22", "F23", "F24", "F25", "F26", "F34", "F35"]) {
      expect({ id, outcome: replayed.verdicts[id].outcome }).toEqual({ id, outcome: direct.verdicts[id].outcome });
    }
    expect(replayed.feasible).toBe(direct.feasible);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §15.3, §7.5 F26 — the security class and the lock class are one relation
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§15.3 — F26 and the container model agree on security class ↔ lock class", () => {
  // Phase 7's independent verification (Finding 1) found `f26.js` reading
  // `item.requiredLockClass`, a field no producer anywhere populates. Deleting that dead
  // branch alone would have left F26 reading "a security-classified item requires *a*
  // lock class" while `container.satisfiesSecurityClass()` reads "requires *its own*
  // lock class" — F26 admitting a strict superset of what the producer admits, on a
  // class R predicate. §15.1 gives the item a security class, §15.2 gives the
  // compartment a lock class, and §15.3 tier 1 requires the two be *compatible*, so the
  // relation is the specification's and F26 now checks it. These tests pin the
  // direction: F26's SATISFIED set is a subset of the container model's.
  const SECURITY_CLASSES = [null, "SEALED_LOCKER", "TAMPER_EVIDENT", "CHAIN_OF_CUSTODY"];

  /**
   * One compartment holding one item, in exactly the shape F26 reads.
   *
   * @param {string|null} securityClass
   * @param {string|null} lockClass
   * @returns {object}
   */
  const loadOf = (securityClass, lockClass) => ({
    plan: {
      packing: {
        compartmentLoads: [
          {
            compartmentId: "c1",
            lockClass,
            items: [{ itemId: "i1", hazardClasses: [], securityClass, segregation: { incompatibleHazardClasses: [] } }],
          },
        ],
      },
    },
  });

  test("a security-classified item in a compartment carrying a different lock class is VIOLATED", () => {
    const result = f26.evaluate(loadOf("SEALED_LOCKER", "TAMPER_EVIDENT"));
    expect(result.outcome).toBe(OUTCOME.VIOLATED);
    expect(result.required).toEqual({ securityClass: "SEALED_LOCKER", lockClass: "SEALED_LOCKER" });
    expect(result.observed.lockClass).toBe("TAMPER_EVIDENT");
  });

  test("a security-classified item in a compartment with no lock class at all is VIOLATED", () => {
    const result = f26.evaluate(loadOf("SEALED_LOCKER", null));
    expect(result.outcome).toBe(OUTCOME.VIOLATED);
    // The two refusals stay distinguishable: "not lockable" and "wrong lock" are
    // different operator instructions, and §7.7 aggregates the reason.
    expect(result.required).toEqual({ securityClass: "SEALED_LOCKER", lockClass: "any" });
  });

  test("a matching lock class is SATISFIED, and an unclassified item needs no lock", () => {
    expect(f26.evaluate(loadOf("SEALED_LOCKER", "SEALED_LOCKER")).outcome).toBe(OUTCOME.SATISFIED);
    expect(f26.evaluate(loadOf(null, null)).outcome).toBe(OUTCOME.SATISFIED);
    expect(f26.evaluate(loadOf(null, "SEALED_LOCKER")).outcome).toBe(OUTCOME.SATISFIED);
  });

  test("across the whole class matrix, F26 SATISFIED ⟹ the container model admits it", () => {
    let admittedByBoth = 0;
    for (const securityClass of SECURITY_CLASSES) {
      for (const lockClass of SECURITY_CLASSES) {
        const outcome = f26.evaluate(loadOf(securityClass, lockClass)).outcome;
        const admits = container.satisfiesSecurityClass({ securityClass }, { compartmentId: "c1", lockClass }).ok;

        // The subset property, which is what makes "F26 admits ⟹ the container model
        // agrees" structural rather than coincidental.
        if (outcome === OUTCOME.SATISFIED) {
          expect({ securityClass, lockClass, admits }).toEqual({ securityClass, lockClass, admits: true });
          admittedByBoth += 1;
        }
        // And, today, exact agreement in both directions — two independent
        // transcriptions of one specification relation. A future container model that
        // widened compatibility would break this equality while leaving the subset
        // property above intact, which is the conservative direction for a class R gate.
        expect({ securityClass, lockClass, outcome: outcome === OUTCOME.SATISFIED }).toEqual({
          securityClass,
          lockClass,
          outcome: admits,
        });
      }
    }
    expect(admittedByBoth).toBe(7); // 4 unclassified rows + 3 exact matches
  });

  test("no producer in the tree supplies a per-item required lock class", () => {
    // The field the dead branch read. `payload/spec.js` normalises the item shape §15.1
    // specifies, and §15.1's security attribute is the security class — there is no
    // second, per-item lock-class declaration to honour.
    const normalised = spec.normalise({
      consignmentId: "c-1",
      items: [efx.item({ securityClass: "SECURE_A" })],
    });
    expect(normalised.consignment.items[0].securityClass).toBe("SECURE_A");
    expect(normalised.consignment.items[0].requiredLockClass).toBeUndefined();
    expect(spec.ATTRIBUTES.map((attribute) => attribute.field)).not.toContain("requiredLockClass");
  });

  test("the real packing producer never places an item under a mismatched lock class", () => {
    // The end-to-end statement: F26's new refusal is a second, independent barrier, not
    // a relocation of the first. `SECURE_B` matches no compartment in the fixture
    // container, whose only lock class is `SECURE_A`.
    const mismatched = packing.evaluate({
      container: efx.containerModel(),
      consignment: { items: [efx.item({ itemId: "sec-1", securityClass: "SECURE_B" })] },
      packingEfficiency: 0.75,
      nodeBudget: 5000,
    });
    expect(mismatched.verdict).not.toBe(packing.VERDICT.FEASIBLE);

    const matched = packing.evaluate({
      container: efx.containerModel(),
      consignment: {
        items: [
          efx.item({
            itemId: "sec-2",
            securityClass: "SECURE_A",
            lengthMm: 150,
            widthMm: 150,
            heightMm: 150,
            volumeLitres: 3,
          }),
        ],
      },
      packingEfficiency: 0.75,
      nodeBudget: 5000,
    });
    expect(matched.verdict).toBe(packing.VERDICT.FEASIBLE);
    for (const load of matched.compartmentLoads) {
      for (const item of load.items) {
        if (item.securityClass) expect(load.lockClass).toBe(item.securityClass);
      }
    }
    expect(f26.evaluate({ plan: { packing: matched } }).outcome).toBe(OUTCOME.SATISFIED);
  });
});

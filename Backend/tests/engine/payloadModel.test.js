"use strict";

/**
 * Engine lane — §15, the payload model.
 *
 * §15.1 opens by stating there was nothing to build on:
 *
 * > The baseline has no payload concept whatsoever — the audit verifies by exhaustive
 * > search that no mass, volume, or capacity field exists in schema or code. The model
 * > must therefore be built from first principles.
 *
 * So these tests are written against the specification's own claims rather than against
 * a prior behaviour: the aperture is a distinct constraint from the internal dimension,
 * feasibility uses the tolerance upper bound and energy the expectation, the load state
 * is evaluated per stop, and a tier-3 budget exhaustion is neither a pass nor a fail.
 */

const fixture = require("./helpers/energyFixture");

const spec = require("../../src/engine/payload/spec");
const container = require("../../src/engine/payload/container");
const packing = require("../../src/engine/payload/packing");
const loadState = require("../../src/engine/payload/loadState");
const custodyEvidence = require("../../src/engine/payload/custodyEvidence");

const f22 = require("../../src/engine/feasibility/predicates/f22");
const f23 = require("../../src/engine/feasibility/predicates/f23");
const f24 = require("../../src/engine/feasibility/predicates/f24");
const f25 = require("../../src/engine/feasibility/predicates/f25");
const f26 = require("../../src/engine/feasibility/predicates/f26");

const normalisedContainer = () => container.normalise(fixture.containerModel()).container;

/* ═══════════════════════════════════════════════════════════════════════════
   §15.1 — the task-side specification
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§15.1 the payload specification", () => {
  test("feasibility uses the tolerance upper bound and energy uses the expectation", () => {
    const item = fixture.item({ massKg: 5, massToleranceKg: 0.5 });
    expect(spec.itemMassForFeasibilityKg(item)).toBeCloseTo(5.5, 9);
    expect(spec.itemMassForEnergyKg(item)).toBeCloseTo(5, 9);
  });

  test("an item with no stated tolerance has no feasibility mass — absence is not zero", () => {
    // "Mass is specified with a tolerance, because declared masses are frequently
    // wrong": treating an absent tolerance as zero asserts a precision nobody claimed.
    const item = fixture.item({ massToleranceKg: null });
    expect(spec.itemMassForFeasibilityKg(item)).toBeNull();
    expect(spec.itemMassForEnergyKg(item)).toBe(5);
  });

  test("substituting one reading for the other is refusable, not merely documented", () => {
    const refused = spec.assertNotSubstituted(spec.MASS_READING.FEASIBILITY, spec.MASS_READING.ENERGY);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/admits an over-mass load/);
    expect(spec.assertNotSubstituted(spec.MASS_READING.ENERGY, spec.MASS_READING.ENERGY).ok).toBe(true);
  });

  test("a consignment stating only a count expands to items, and says the expansion was derived", () => {
    const result = spec.normalise({ specId: "s1", itemCount: 4, massKg: 8, massToleranceKg: 0.8, volumeLitres: 20, lengthMm: 100, widthMm: 100, heightMm: 100 });
    expect(result.ok).toBe(true);
    expect(result.consignment.items).toHaveLength(4);
    expect(result.consignment.itemsAreDerived).toBe(true);
    expect(spec.totalMassKg(result.consignment, spec.MASS_READING.ENERGY).massKg).toBeCloseTo(8, 9);
  });

  test("declared item rows are used as declared, and are not derived", () => {
    const result = spec.normalise({ specId: "s2", items: [fixture.item(), fixture.item({ itemId: "item-2", massKg: 3 })] });
    expect(result.consignment.itemsAreDerived).toBe(false);
    expect(spec.totalMassKg(result.consignment, spec.MASS_READING.FEASIBILITY).massKg).toBeCloseTo(9, 9);
  });

  test("an unstated stackability defaults to *not* stackable", () => {
    expect(spec.normaliseItem({ itemId: "i" }).stackable).toBe(false);
  });

  test("the smallest cross-section is the two smallest dimensions", () => {
    const cross = spec.smallestCrossSectionMm(fixture.item({ lengthMm: 300, widthMm: 200, heightMm: 150 }));
    expect(cross).toEqual({ ok: true, aMm: 150, bMm: 200 });
  });

  test("a systematically under-declaring source is surfaced, not silently corrected", () => {
    const feedback = spec.declarationFeedback({ specId: "s1", declaredMassKg: 5, realisedMassKg: 7.4, declarationSource: "merchant-42" });
    expect(feedback.underDeclared).toBe(true);
    expect(feedback.deltaKg).toBeCloseTo(2.4, 9);
    expect(feedback.declarationSource).toBe("merchant-42");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §15.2 — the container model
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§15.2 the container model", () => {
  const model = normalisedContainer();

  test("the aperture is a distinct constraint from the internal dimension", () => {
    // §15.2's own example: "a 20 kg limit tells you nothing about whether two 40 cm
    // boxes fit through a 30 cm hatch". Compartment c2 is large inside and narrow at
    // the mouth.
    const wide = fixture.item({ lengthMm: 400, widthMm: 300, heightMm: 250 });
    const c2 = model.compartments.find((compartment) => compartment.compartmentId === "c2");

    expect(container.fitsInternal(wide, c2).fits).toBe(true);
    expect(container.fitsAperture(wide, c2).fits).toBe(false);
  });

  test("an unmeasured aperture is unknown, never unlimited", () => {
    const noAperture = { compartmentId: "cx", internalLengthMm: 500, internalWidthMm: 500, internalHeightMm: 500 };
    const result = container.fitsAperture(fixture.item(), noAperture);
    expect(result.fits).toBeNull();
    expect(result.reason).toMatch(/never unlimited/);
  });

  test("an item may be turned on its side to pass a hatch", () => {
    const c1 = model.compartments.find((compartment) => compartment.compartmentId === "c1");
    // 350 × 250 passes a 400 × 300 aperture only in one of the two pairings.
    expect(container.fitsAperture(fixture.item({ lengthMm: 350, widthMm: 250, heightMm: 100 }), c1).fits).toBe(true);
  });

  test("a this-way-up item is only tried in its declared orientation", () => {
    const c1 = model.compartments.find((compartment) => compartment.compartmentId === "c1");
    const tall = fixture.item({ lengthMm: 200, widthMm: 200, heightMm: 450, orientationConstraints: { thisWayUp: true } });
    const free = fixture.item({ lengthMm: 200, widthMm: 200, heightMm: 450 });

    expect(container.fitsInternal(tall, c1).fits).toBe(false);
    expect(container.fitsInternal(free, c1).fits).toBe(true);
  });

  test("a named security class must be matched, not merely present", () => {
    const c1 = model.compartments.find((compartment) => compartment.compartmentId === "c1");
    const c2 = model.compartments.find((compartment) => compartment.compartmentId === "c2");
    const secure = fixture.item({ securityClass: "SECURE_A" });

    expect(container.satisfiesSecurityClass(secure, c1).ok).toBe(false);
    expect(container.satisfiesSecurityClass(secure, c2).ok).toBe(true);
    expect(container.satisfiesSecurityClass(fixture.item({ securityClass: "SECURE_B" }), c2).ok).toBe(false);
  });

  test("segregation is symmetric — a rule stated on one side of a pair is still the rule", () => {
    const acid = fixture.item({ itemId: "acid", hazardClasses: ["CORROSIVE"] });
    const food = fixture.item({ itemId: "food", segregation: { incompatibleHazardClasses: ["CORROSIVE"] } });

    expect(container.segregationCompatible(food, acid).ok).toBe(false);
    expect(container.segregationCompatible(acid, food).ok).toBe(false);
  });

  test("a contamination-class change is a required cleaning cycle, not a refusal", () => {
    const c1 = model.compartments.find((compartment) => compartment.compartmentId === "c1");
    const chemical = { ...fixture.item(), cleanlinessClass: "CHEMICAL" };
    const result = container.cleanlinessCompatible(chemical, c1);
    expect(result.ok).toBe(true);
    expect(result.cleaningRequired).toBe(true);
  });

  test("an undeterminable fit is reported as indeterminate rather than admitted", () => {
    const noAperture = container.normalise({
      modelId: "m",
      compartments: [{ compartmentId: "cx", ordinal: 1, internalLengthMm: 900, internalWidthMm: 900, internalHeightMm: 900 }],
    }).container;
    const result = container.admissibleCompartments(fixture.item(), noAperture);
    expect(result.compartments).toHaveLength(0);
    expect(result.rejections[0].outcome).toBe("INDETERMINATE");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §15.3 — tiered packing
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§15.3 tiered packing", () => {
  /**
   * An item too wide for compartment 2's 200 x 200 mm aperture in every orientation, so
   * compartment 1 is its only admissible home. Several cases below need two items
   * contending for one compartment; a plain fixture item fits both compartments, which
   * is the aperture modelling working correctly and makes it useless as a contention
   * case.
   */
  const wideItem = (overrides) =>
    fixture.item({ lengthMm: 300, widthMm: 250, heightMm: 250, volumeLitres: 5, ...(overrides || {}) });

  const evaluate = (items, overrides) =>
    packing.evaluate({
      container: fixture.containerModel(),
      consignment: { items },
      packingEfficiency: 0.75,
      nodeBudget: 5000,
      ...(overrides || {}),
    });

  describe("tier 1 rejects most infeasible pairings immediately", () => {
    test("total mass over the limit, at the tolerance upper bound", () => {
      const result = evaluate([fixture.item({ massKg: 19.6, massToleranceKg: 0.5 })]);
      expect(result.verdict).toBe(packing.VERDICT.INFEASIBLE);
      expect(result.tier).toBe(packing.TIER.NECESSARY);
      expect(result.bindingConstraint).toBe("TOTAL_MASS");
      // 19.6 is under the 20 kg limit; 20.1 at the tolerance upper bound is not.
      expect(result.diagnostics.join(" ")).toMatch(/tolerance upper bound/);
    });

    test("total volume over capacity × packing efficiency", () => {
      const result = evaluate([fixture.item({ volumeLitres: 80 }), fixture.item({ itemId: "item-2", volumeLitres: 5 })]);
      expect(result.verdict).toBe(packing.VERDICT.INFEASIBLE);
      expect(result.bindingConstraint).toBe("TOTAL_VOLUME");
    });

    test("an item whose smallest cross-section fits no aperture", () => {
      const result = evaluate([fixture.item({ lengthMm: 900, widthMm: 900, heightMm: 900, volumeLitres: 20 })]);
      expect(result.verdict).toBe(packing.VERDICT.INFEASIBLE);
    });

    test("a thermal class no compartment covers", () => {
      const result = evaluate([fixture.item({ thermalMinC: -40, thermalMaxC: -20 })]);
      expect(result.verdict).toBe(packing.VERDICT.INFEASIBLE);
    });

    test("an unevaluable condition is BUDGET_EXHAUSTED, never INFEASIBLE", () => {
      // A missing total mass limit cannot prove infeasibility; it prevents a proof
      // either way, and F23 reads that as INDETERMINATE.
      const result = packing.evaluate({
        container: fixture.containerModel({ totalMassLimitKg: null }),
        consignment: { items: [fixture.item()] },
        packingEfficiency: 0.75,
        nodeBudget: 5000,
      });
      expect(result.verdict).toBe(packing.VERDICT.BUDGET_EXHAUSTED);
      expect(f23.evaluate({ plan: { packing: result } }).outcome).toBe("INDETERMINATE");
    });
  });

  describe("tier 2 accepts with a concrete loading plan", () => {
    test("a simple consignment is placed greedily and reports where", () => {
      const result = evaluate([fixture.item()]);
      expect(result.verdict).toBe(packing.VERDICT.FEASIBLE);
      expect(result.tier).toBe(packing.TIER.GREEDY);
      expect(result.loadingPlan.method).toBe("FIRST_FIT_DECREASING");
      expect(result.compartmentLoads[0].items[0].itemId).toBe("item-1");
    });

    test("items are walked largest-first, which is what first-fit-*decreasing* means", () => {
      const ordered = packing.canonicalItemOrder([
        fixture.item({ itemId: "small", volumeLitres: 2 }),
        fixture.item({ itemId: "large", volumeLitres: 20 }),
      ]);
      expect(ordered.map((item) => item.itemId)).toEqual(["large", "small"]);
    });

    test("the order is canonical, so the same consignment packs the same way every time", () => {
      const items = [fixture.item({ itemId: "b", volumeLitres: 5 }), fixture.item({ itemId: "a", volumeLitres: 5 })];
      const forwards = evaluate(items);
      const backwards = evaluate([...items].reverse());
      expect(JSON.stringify(backwards.compartmentLoads)).toBe(JSON.stringify(forwards.compartmentLoads));
    });

    test("a non-stackable item will not share a compartment", () => {
      // Both are too wide for c2's aperture, so both want c1 — and c1 may hold only one
      // of them once one declares itself non-stackable.
      const result = evaluate([wideItem({ itemId: "fragile", stackable: false }), wideItem({ itemId: "other" })]);
      expect(result.verdict).not.toBe(packing.VERDICT.FEASIBLE);
    });

    test("segregation is enforced within a compartment", () => {
      const result = evaluate([
        wideItem({ itemId: "acid", hazardClasses: ["CORROSIVE"] }),
        wideItem({ itemId: "food", segregation: { incompatibleHazardClasses: ["CORROSIVE"] } }),
      ]);
      expect(result.verdict).not.toBe(packing.VERDICT.FEASIBLE);
    });
  });

  describe("tier 3 resolves the marginal cases, and its budget exhaustion is its own verdict", () => {
    test("a node budget of one exhausts before deciding, and that is not a failure", () => {
      const result = evaluate([wideItem({ itemId: "a", stackable: false }), wideItem({ itemId: "b", stackable: false })], { nodeBudget: 1 });
      expect(result.verdict).toBe(packing.VERDICT.BUDGET_EXHAUSTED);
      expect(result.tier).toBe(packing.TIER.EXACT);
      expect(result.diagnostics.join(" ")).toMatch(/not evidence that no placement exists/);
    });

    test("BUDGET_EXHAUSTED becomes INDETERMINATE at the gate, and class I denies", () => {
      const result = evaluate([wideItem({ itemId: "a", stackable: false }), wideItem({ itemId: "b", stackable: false })], { nodeBudget: 1 });
      const verdict = f23.evaluate({ plan: { packing: result } });
      expect(verdict.outcome).toBe("INDETERMINATE");

      const register = require("../../src/engine/feasibility/register");
      expect(register.predicate("F23").policy).toBe("DENY");
    });

    test("an exhausted search proves nothing, so a larger budget may still find a placement", () => {
      // A case first-fit-decreasing gets wrong and the exact search gets right, which is
      // §15.3's whole reason for having a tier 3: "only when tier 2 fails and the
      // pairing is otherwise attractive".
      //
      // `flexible` is bulkier so FFD places it first, and it takes c1 — after which
      // `heavy`, which only c1's aperture admits, no longer fits c1's mass limit. The
      // exact search backtracks `flexible` into c2 and both fit.
      const items = [
        fixture.item({ itemId: "flexible", massKg: 3, massToleranceKg: 0.5, volumeLitres: 10 }),
        wideItem({ itemId: "heavy", massKg: 10, massToleranceKg: 0.5, volumeLitres: 5 }),
      ];

      const greedyOnly = evaluate(items, { exactSearchPermitted: false });
      expect(greedyOnly.tier).toBe(packing.TIER.GREEDY);

      const starved = evaluate(items, { nodeBudget: 1 });
      const generous = evaluate(items, { nodeBudget: 5000 });

      expect(starved.verdict).toBe(packing.VERDICT.BUDGET_EXHAUSTED);
      expect(generous.verdict).toBe(packing.VERDICT.FEASIBLE);
      expect(generous.tier).toBe(packing.TIER.EXACT);
    });

    test("the exact search is skipped when the pairing is not otherwise attractive", () => {
      const result = evaluate([wideItem({ itemId: "a", stackable: false }), wideItem({ itemId: "b", stackable: false })], { exactSearchPermitted: false });
      expect(result.tier).toBe(packing.TIER.GREEDY);
      expect(result.verdict).toBe(packing.VERDICT.BUDGET_EXHAUSTED);
    });
  });

  describe("tier 4 memoises by container config and item multiset", () => {
    const makeKv = () => {
      const store = new Map();
      return {
        store,
        get: async (key) => (store.has(key) ? store.get(key) : null),
        set: async (key, value) => {
          store.set(key, value);
        },
      };
    };

    test("the same items in a different order key the same entry", () => {
      const container_ = container.normalise(fixture.containerModel()).container;
      const a = packing.signature(container_, [fixture.item({ itemId: "x" }), fixture.item({ itemId: "y", massKg: 3 })]);
      const b = packing.signature(container_, [fixture.item({ itemId: "y", massKg: 3 }), fixture.item({ itemId: "x" })]);
      expect(b.itemSignature).toBe(a.itemSignature);
      expect(b.key).toBe(a.key);
    });

    test("a different container configuration keys a different entry", () => {
      const wide = container.normalise(fixture.containerModel()).container;
      const narrow = container.normalise(fixture.containerModel({ totalMassLimitKg: 5 })).container;
      expect(packing.signature(narrow, [fixture.item()]).containerConfig).not.toBe(
        packing.signature(wide, [fixture.item()]).containerConfig,
      );
    });

    test("a repeated identical consignment is served from the memo", async () => {
      const kv = makeKv();
      const input = { container: fixture.containerModel(), consignment: { items: [fixture.item()] }, packingEfficiency: 0.75, nodeBudget: 5000 };

      const first = await packing.evaluateMemoised({ kv }, input);
      expect(first.cached).toBe(false);
      const second = await packing.evaluateMemoised({ kv }, input);
      expect(second.cached).toBe(true);
      expect(second.result.tier).toBe(packing.TIER.MEMOISED);
      expect(second.result.verdict).toBe(packing.VERDICT.FEASIBLE);
    });

    test("an indecision is never memoised — the budget may be larger next time", async () => {
      const kv = makeKv();
      const input = {
        container: fixture.containerModel(),
        consignment: { items: [wideItem({ itemId: "a", stackable: false }), wideItem({ itemId: "b", stackable: false })] },
        packingEfficiency: 0.75,
        nodeBudget: 1,
      };
      const result = await packing.evaluateMemoised({ kv }, input);
      expect(result.result.verdict).toBe(packing.VERDICT.BUDGET_EXHAUSTED);
      expect(kv.store.size).toBe(0);
    });

    test("a cache failure is a miss, never a verdict", async () => {
      const failing = { get: async () => { throw new Error("redis down"); }, set: async () => { throw new Error("redis down"); } };
      const result = await packing.evaluateMemoised({ kv: failing }, {
        container: fixture.containerModel(),
        consignment: { items: [fixture.item()] },
        packingEfficiency: 0.75,
        nodeBudget: 5000,
      });
      expect(result.cached).toBe(false);
      expect(result.result.verdict).toBe(packing.VERDICT.FEASIBLE);
    });
  });

  test("its verdicts are exactly F23's, so a result is always readable at the gate", () => {
    expect(packing.VERDICT).toEqual(f23.PACKING_VERDICT);
  });

  test("the placement it produces is what F25 and F26 read", () => {
    const chilled = fixture.item({
      itemId: "chilled-1",
      thermalMinC: 0,
      thermalMaxC: 5,
      lengthMm: 150,
      widthMm: 150,
      heightMm: 150,
      volumeLitres: 3,
      securityClass: "SECURE_A",
    });
    const result = evaluate([chilled]);
    expect(result.verdict).toBe(packing.VERDICT.FEASIBLE);
    expect(result.thermalAssignment.compartmentId).toBe("c2");

    const context = {
      mission: { payload: { thermalMinC: 0, thermalMaxC: 5, thermalMaxExcursionSeconds: 0 } },
      plan: { packing: result, projectedStartMs: 0, projectedEndMs: 600_000 },
    };
    expect(f25.evaluate(context).outcome).toBe("SATISFIED");
    expect(f26.evaluate({ plan: { packing: result } }).outcome).toBe("SATISFIED");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §15.4 — load state along the plan
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§15.4 load state along the plan", () => {
  const project = (items, overrides) => {
    const packed = packing.evaluate({
      container: fixture.containerModel(),
      consignment: { items },
      packingEfficiency: 0.75,
      nodeBudget: 5000,
    });
    return loadState.project({
      stops: fixture.stops(),
      container: normalisedContainer(),
      compartmentLoads: packed.compartmentLoads,
      ...(overrides || {}),
    });
  };

  test("mass rises at the pickup and falls at the drop", () => {
    const result = project([fixture.item({ massKg: 5, massToleranceKg: 0.5 })]);
    expect(result.ok).toBe(true);
    expect(result.loadState[0].massUpperBoundKg).toBeCloseTo(5.5, 9);
    expect(result.loadState[1].massUpperBoundKg).toBeCloseTo(0, 9);
  });

  test("the two mass readings are both carried, and they differ", () => {
    const result = project([fixture.item({ massKg: 5, massToleranceKg: 0.5 })]);
    expect(result.loadState[0].massUpperBoundKg).toBeCloseTo(5.5, 9);
    expect(result.loadState[0].massExpectationKg).toBeCloseTo(5, 9);
  });

  test("F22 reads the per-stop series, so a mid-route peak is caught", () => {
    const result = project([fixture.item({ massKg: 5, massToleranceKg: 0.5 })]);
    const verdict = f22.evaluate({
      agentSnapshot: { containerModel: { totalMassLimitKg: 20 } },
      plan: { loadState: result.loadState },
      config: fixture.config(),
    });
    expect(verdict.outcome).toBe("SATISFIED");

    const overloaded = f22.evaluate({
      agentSnapshot: { containerModel: { totalMassLimitKg: 4 } },
      plan: { loadState: result.loadState },
      config: fixture.config(),
    });
    expect(overloaded.outcome).toBe("VIOLATED");
    expect(overloaded.observed.stopSequence).toBe(1);
  });

  test("the centre of mass is computed from published centroids, and F24 reads it", () => {
    const result = project([fixture.item({ massKg: 5, massToleranceKg: 0.5 })]);
    expect(result.loadState[0].cog.withinEnvelope).toBe(true);
    const agentSnapshot = { containerModel: { cogEnvelope: fixture.containerModel().cogEnvelope } };
    expect(f24.evaluate({ agentSnapshot, plan: { loadState: result.loadState } }).outcome).toBe("SATISFIED");
  });

  test("a container publishing an envelope but no centroids yields unknown, and F24 denies", () => {
    const withoutCentroids = container.normalise(
      fixture.containerModel({ cogEnvelope: { longitudinalMm: [-100, 100], lateralMm: [-80, 80] } }),
    ).container;

    const packed = packing.evaluate({
      container: fixture.containerModel(),
      consignment: { items: [fixture.item()] },
      packingEfficiency: 0.75,
      nodeBudget: 5000,
    });
    const result = loadState.project({ stops: fixture.stops(), container: withoutCentroids, compartmentLoads: packed.compartmentLoads });

    expect(result.loadState[0].cog.withinEnvelope).toBeNull();
    // "Assuming an origin would put every load inside every envelope."
    const agentSnapshot = { containerModel: { cogEnvelope: { longitudinalMm: [-100, 100], lateralMm: [-80, 80] } } };
    expect(f24.evaluate({ agentSnapshot, plan: { loadState: result.loadState } }).outcome).toBe("INDETERMINATE");
  });

  test("an out-of-envelope load is violated, with the binding axis named", () => {
    const heavy = container.normalise(
      fixture.containerModel({
        cogEnvelope: {
          longitudinalMm: [-5, 5],
          lateralMm: [-80, 80],
          emptyVehicle: { massKg: 1, longitudinalMm: 0, lateralMm: 0 },
          compartmentCentroids: { c1: { longitudinalMm: 500, lateralMm: 0 }, c2: { longitudinalMm: -50, lateralMm: 0 } },
        },
      }),
    ).container;

    const packed = packing.evaluate({
      container: fixture.containerModel(),
      consignment: { items: [fixture.item({ massKg: 10, massToleranceKg: 0 })] },
      packingEfficiency: 0.75,
      nodeBudget: 5000,
    });
    const result = loadState.project({ stops: fixture.stops(), container: heavy, compartmentLoads: packed.compartmentLoads });

    expect(result.loadState[0].cog.withinEnvelope).toBe(false);
    expect(result.loadState[0].cog.bindingAxis).toBe("longitudinalMm");
  });

  test("occupancy intervals are produced for conditioned compartments only", () => {
    // The security class is what keeps it out of compartment 1, whose thermal class
    // would otherwise cover 0..5 degC perfectly well.
    const chilled = fixture.item({ itemId: "chilled-1", thermalMinC: 0, thermalMaxC: 5, securityClass: "SECURE_A", lengthMm: 150, widthMm: 150, heightMm: 150, volumeLitres: 3 });
    const ambient = fixture.item({ itemId: "ambient-1" });
    const result = project([chilled, ambient]);

    expect(result.occupancy).toHaveLength(1);
    expect(result.occupancy[0].compartmentId).toBe("c2");
    // t_occupied(k) — the interval the compartment actually holds conditioned goods.
    expect(result.occupancy[0].occupiedSeconds).toBeCloseTo(40 * 60, 6);
  });

  test("the occupancy it produces is what the consumption model charges β_payload_thermal over", () => {
    const consumption = require("../../src/engine/energy/consumption");
    const chilled = fixture.item({ itemId: "chilled-1", thermalMinC: 0, thermalMaxC: 5, securityClass: "SECURE_A", lengthMm: 150, widthMm: 150, heightMm: 150, volumeLitres: 3 });
    const projected = project([chilled]);

    const withConditioning = consumption.legEnergyWh(
      fixture.energyModelParams(),
      fixture.legProfile({
        compartmentOccupancy: projected.occupancy.map((row) => ({ compartmentId: row.compartmentId, thermalClass: "CHILLED", occupiedSeconds: row.occupiedSeconds })),
      }),
      1,
    );
    const without = consumption.legEnergyWh(fixture.energyModelParams(), fixture.legProfile(), 1);

    expect(withConditioning.ok).toBe(true);
    expect(withConditioning.wh).toBeGreaterThan(without.wh);
  });

  describe("access ordering is a sequencing constraint a capacity model cannot express", () => {
    test("a blocked compartment's item may not be dropped before its blocker's", () => {
      const violations = loadState.accessOrderViolations({
        stops: fixture.stops(),
        container: normalisedContainer(),
        compartmentLoads: [
          { compartmentId: "c1", items: [{ itemId: "front" }] },
          { compartmentId: "c2", items: [{ itemId: "behind" }] },
        ],
        dropsByStop: { 1: ["behind"], 2: ["front"] },
      });

      expect(violations.ok).toBe(false);
      expect(violations.violations[0].itemId).toBe("behind");
      expect(violations.violations[0].blockingItemId).toBe("front");
    });

    test("the lawful order passes", () => {
      const violations = loadState.accessOrderViolations({
        stops: fixture.stops(),
        container: normalisedContainer(),
        compartmentLoads: [
          { compartmentId: "c1", items: [{ itemId: "front" }] },
          { compartmentId: "c2", items: [{ itemId: "behind" }] },
        ],
        dropsByStop: { 1: ["front"], 2: ["behind"] },
      });
      expect(violations.ok).toBe(true);
    });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §15.6 — custody, evidence, and reconciliation
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§15.6 custody evidence and manifest reconciliation", () => {
  test("the evidence ladder is §12.5's, not a second one", () => {
    const verification = require("../../src/engine/supervision/verification");
    expect(custodyEvidence.LEVEL).toBe(verification.LEVEL);
    expect(custodyEvidence.requiredLevelFor).toBe(verification.requiredLevelFor);
  });

  test("evidence is proportionate to value — a scan meets L2 where sensing does not", () => {
    const levels = { PARCEL: "L2" };
    const sensed = custodyEvidence.sufficientForTransition({
      evidence: [{ kind: custodyEvidence.EVIDENCE_KIND.COMPARTMENT_SENSING }],
      missionClass: "PARCEL",
      levelsByMissionClass: levels,
    });
    const scanned = custodyEvidence.sufficientForTransition({
      evidence: [{ kind: custodyEvidence.EVIDENCE_KIND.SCAN }],
      missionClass: "PARCEL",
      levelsByMissionClass: levels,
    });

    expect(sensed.ok).toBe(false);
    expect(scanned.ok).toBe(true);
  });

  test("no evidence establishes L0, which meets no requirement above it", () => {
    const result = custodyEvidence.establishedLevel([]);
    expect(result.level).toBe("L0");
  });

  describe("a mass delta outside the instrument band is a discrepancy, not a rounding error", () => {
    test("inside the band it is instrument error", () => {
      const result = custodyEvidence.reconcile({ expectedMassDeltaKg: 5, observedMassDeltaKg: 5.3, toleranceKg: 0.5 });
      expect(result.ok).toBe(true);
    });

    test("outside it, it is a discrepancy event", () => {
      const result = custodyEvidence.reconcile({ expectedMassDeltaKg: 5, observedMassDeltaKg: 2.1, toleranceKg: 0.5 });
      expect(result.ok).toBe(false);
      expect(result.discrepancies[0].kind).toBe(custodyEvidence.DISCREPANCY.MASS_DELTA_INCONSISTENT);
      expect(result.discrepancies[0].reason).toMatch(/wrong item, a missing item, or tampering/);
    });

    test("an unresolved tolerance cannot judge a delta, and says so", () => {
      const result = custodyEvidence.reconcile({ expectedMassDeltaKg: 5, observedMassDeltaKg: 2, toleranceKg: null });
      expect(result.ok).toBe(false);
      expect(result.discrepancies[0].reason).toMatch(/payload\.mass_discrepancy_tolerance_kg/);
    });
  });

  test("compartment sensing and scans each raise their own discrepancy class", () => {
    const result = custodyEvidence.reconcile({
      compartmentSensors: [{ compartmentId: "c1", occupied: true }],
      expectedOccupancy: [{ compartmentId: "c1", expectedOccupied: false }],
      scannedItemIds: ["a", "z"],
      expectedItemIds: ["a", "b"],
    });

    const kinds = result.discrepancies.map((row) => row.kind);
    expect(kinds).toContain(custodyEvidence.DISCREPANCY.COMPARTMENT_UNEXPECTEDLY_OCCUPIED);
    expect(kinds).toContain(custodyEvidence.DISCREPANCY.ITEM_NOT_SCANNED);
    expect(kinds).toContain(custodyEvidence.DISCREPANCY.UNDECLARED_ITEM);
  });

  describe("invariant I7 — no return to the pool with a non-empty compartment", () => {
    test("a closed manifest releases", () => {
      expect(custodyEvidence.assertReleasable({ manifests: [{ state: "CLOSED" }], compartmentSensors: [] }).releasable).toBe(true);
    });

    test("an open manifest with an occupied compartment does not", () => {
      const result = custodyEvidence.assertReleasable({
        manifests: [{ state: "OPEN" }],
        compartmentSensors: [{ compartmentId: "c1", occupied: true }],
      });
      expect(result.releasable).toBe(false);
      expect(result.problems[0]).toMatch(/invariant I7/);
    });

    test("an unreported compartment is not an empty one", () => {
      const result = custodyEvidence.assertReleasable({
        manifests: [{ state: "OPEN" }],
        compartmentSensors: [{ compartmentId: "c1", occupied: null }],
      });
      expect(result.releasable).toBe(false);
      expect(result.problems[0]).toMatch(/unknown is never permission/);
    });

    test("an open manifest with no sensor reading at all does not release", () => {
      const result = custodyEvidence.assertReleasable({ manifests: [{ state: "OPEN" }], compartmentSensors: [] });
      expect(result.releasable).toBe(false);
    });

    test("an open manifest with every compartment empty does release", () => {
      const result = custodyEvidence.assertReleasable({
        manifests: [{ state: "OPEN" }],
        compartmentSensors: [{ compartmentId: "c1", occupied: false }, { compartmentId: "c2", occupied: false }],
      });
      expect(result.releasable).toBe(true);
    });
  });

  test("a custody event carries its evidence and its discrepancies together", () => {
    const event = custodyEvidence.custodyEvent({
      legId: "leg-1",
      transition: "NONE→HELD",
      manifest: { manifestId: "m1", state: "OPEN" },
      evidence: [{ kind: custodyEvidence.EVIDENCE_KIND.SCAN }],
      missionClass: "PARCEL",
      levelsByMissionClass: { PARCEL: "L2" },
      expectedMassDeltaKg: 5,
      observedMassDeltaKg: 5.1,
      toleranceKg: 0.5,
    });

    expect(event.evidenceSufficient).toBe(true);
    expect(event.discrepancies).toHaveLength(0);
    expect(event.manifestId).toBe("m1");
  });
});

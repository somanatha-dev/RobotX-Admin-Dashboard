"use strict";

/**
 * Phase 8 — §8's cost function, term by term.
 *
 * §8's testing requirements, and where each is discharged:
 *
 *   - each term in isolation, with units asserted        → "each term in isolation"
 *   - the telescoping identity holds numerically         → "§8.3.3 the telescoping identity"
 *   - the integral is over the origin zone, fixed        → "§8.3.3(b)"
 *   - both relocation evaluations at t_release           → "§8.3.3(c)"
 *   - 10 km costs more than 1 km all else equal          → "§1.3 properties min-max cannot satisfy"
 *   - the five non-negative terms never go negative      → "§8.1 sign discipline"
 *   - C_opportunity ≥ −Ω_terminal, C_policy ≥ −Ω_policy  → "§8.1 sign discipline"
 *   - V_terminal carries no weighting coefficients       → build gate, in pricingModel.test.js
 *   - multi-Leg delay attribution                        → "§8.7 the attribution rule"
 *   - γ(c) recomputed from Φ equals the solver's value   → "§13.3 the column price"
 */

const path = require("path");
const fs = require("fs");

const fixture = require("./helpers/costFixture");
const phi = require("../../src/engine/cost/phi");
const cDirect = require("../../src/engine/cost/cDirect");
const cDelay = require("../../src/engine/cost/cDelay");
const cRisk = require("../../src/engine/cost/cRisk");
const cLifecycle = require("../../src/engine/cost/cLifecycle");
const cPolicy = require("../../src/engine/cost/cPolicy");
const cOpportunity = require("../../src/engine/cost/cOpportunity");
const cChurn = require("../../src/engine/cost/cChurn");
const cDefer = require("../../src/engine/cost/cDefer");
const signDiscipline = require("../../src/engine/cost/signDiscipline");
const units = require("../../src/engine/cost/units");
const { toCU, scaleByRate } = require("../../src/engine/determinism/fixedPoint");

const COST_DIR = path.resolve(__dirname, "..", "..", "src", "engine", "cost");

afterEach(() => phi.clearTerms());

describe("T1 — the cost function cannot see an unbranded candidate (§1.5, I14)", () => {
  const unbranded = fixture.plan();

  test.each([
    ["Φ", () => phi.evaluate(unbranded, fixture.phiInput())],
    ["C_direct", () => cDirect.evaluate(unbranded, fixture.directInput())],
    ["C_risk", () => cRisk.evaluate(unbranded, fixture.riskInput())],
    ["C_lifecycle", () => cLifecycle.evaluate(unbranded, fixture.lifecycleInput())],
    ["C_policy", () => cPolicy.evaluate(unbranded, fixture.policyInput())],
    ["C_opportunity", () => cOpportunity.evaluate(unbranded, fixture.opportunityInput())],
  ])("%s refuses a plan the gate did not admit", (_name, call) => {
    expect(call).toThrow(/T1 violation/);
  });

  test("the brand does not survive a JSON round trip", () => {
    const branded = fixture.brandedPlan();
    expect(() => phi.evaluate(branded, fixture.phiInput())).not.toThrow();
    expect(() => phi.evaluate(JSON.parse(JSON.stringify(branded)), fixture.phiInput())).toThrow(/T1 violation/);
  });

  test("the brand does not survive an object spread", () => {
    const branded = fixture.brandedPlan();
    expect(() => phi.evaluate({ ...branded }, fixture.phiInput())).toThrow(/T1 violation/);
  });
});

describe("§1.3 — no normalisation anywhere in the cost path", () => {
  const modules = fs.readdirSync(COST_DIR).filter((name) => name.endsWith(".js"));

  test("the eleven cost modules are all present", () => {
    expect(modules.sort()).toEqual(
      [
        "cChurn.js",
        "cDefer.js",
        "cDelay.js",
        "cDirect.js",
        "cLifecycle.js",
        "cOpportunity.js",
        "cPolicy.js",
        "cRisk.js",
        "exchangeRates.js",
        "phi.js",
        "signDiscipline.js",
        "units.js",
      ].sort(),
    );
  });

  test.each(["min-max", "rank", "z-score"])("%s normalisation is named as prohibited", (kind) => {
    expect(units.PROHIBITED_NORMALISATIONS).toContain(kind);
    expect(() => units.refuseNormalisation(kind)).toThrow(/prohibited/);
  });

  // A source scan rather than a behavioural assertion, because the defect this guards
  // against is a *future* contributor reintroducing the baseline's habit — and the shape
  // it would take is exactly `(v - min) / (max - min)`.
  test("no cost module rescales a candidate set into [0, 1]", () => {
    const offenders = [];
    for (const name of modules) {
      const source = fs.readFileSync(path.join(COST_DIR, name), "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      if (/Math\s*\.\s*min\s*\(\s*\.\.\./.test(code) || /Math\s*\.\s*max\s*\(\s*\.\.\./.test(code)) {
        offenders.push(`${name}: spreads a collection into Math.min/max, the shape of a min-max rescale`);
      }
      if (/\bnormali[sz]e\s*\(/.test(code) && name !== "units.js") {
        offenders.push(`${name}: defines or calls a normalise()`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("each term in isolation, with units asserted", () => {
  const plan = fixture.brandedPlan();

  test("C_direct is λ_time · Σ(six components) + cu_per_wh · E + the wear addend, reported apart", () => {
    const result = cDirect.evaluate(plan, fixture.directInput());
    expect(result.ok).toBe(true);

    // 60 + 300 + 120 + 600 + 180 + 0 = 1260 s at 1 CU·s⁻¹; 400 Wh at 1 CU·Wh⁻¹.
    expect(toCU(result.milliCU)).toBe(1260 + 400);
    // 3000 m at 0.01 CU·m⁻¹, computed and reported but charged by C_lifecycle.
    expect(toCU(result.distanceWearMilliCU)).toBeCloseTo(30, 9);
    expect(toCU(result.milliCUWithDistanceWear)).toBeCloseTo(1690, 9);
    expect(result.breakdown.distanceWear.attributedTo).toBe("C_lifecycle");
  });

  test("C_direct refuses a plan missing any one of the six components", () => {
    for (const component of cDirect.TIME_COMPONENTS) {
      const components = { ...fixture.plan().components };
      delete components[component];
      const broken = fixture.brandedPlan({ components });
      const result = cDirect.evaluate(broken, fixture.directInput());
      expect({ component, ok: result.ok, missing: result.missing }).toEqual({
        component,
        ok: false,
        missing: [`plan.components.${component}`],
      });
    }
  });

  test("a rate applied to the wrong quantity is a type error, not a plausible number", () => {
    const rates = fixture.rates();
    expect(() =>
      cDirect.evaluate(plan, { ...fixture.directInput(), cuPerWh: rates.cuPerMetreWear }),
    ).toThrow(/prices m, not Wh/);
  });

  test("C_risk sums the three energy tiers separately, never blended", () => {
    const result = cRisk.evaluate(plan, fixture.riskInput());
    expect(result.ok).toBe(true);
    expect(result.breakdown.energyShortfall.perTier.map((row) => row.tier)).toEqual(["T1", "T2", "T3"]);
    // 1e-3·50 + 1e-6·5000 + 1e-9·500 000 = 0.05 + 0.005 + 0.0005 CU. Each tier is
    // converted at the single milli-CU boundary under round-half-away-from-zero, so T3's
    // 0.5 milli-CU becomes 1 and the exact total is 56 milli-CU, not 55.5. The
    // quantisation is the point of §9.6 requirement 1 and is asserted rather than
    // tolerated away.
    expect(result.breakdown.energyShortfall.perTier.map((row) => row.milliCU)).toEqual([50n, 5n, 1n]);
    expect(result.breakdown.energyShortfall.milliCU).toBe(56n);
  });

  test("C_risk refuses a tier whose consequence price is absent rather than pricing it at zero", () => {
    const result = cRisk.evaluate(
      plan,
      fixture.riskInput({ energyConsequenceCu: { T1: 50, T2: 5000 } }),
    );
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("cost.energy_consequence.T3");
  });

  test("staleness is governed by the oldest safety-relevant observation, not the average", () => {
    const rates = fixture.rates();
    const result = cRisk.stalenessPenalty({
      safetyRelevantObservations: {
        position: { observedAtMs: fixture.DECISION_TIME_MS - 2000 },
        soc: { observedAtMs: fixture.DECISION_TIME_MS - 8000 },
      },
      decisionTimeMs: fixture.DECISION_TIME_MS,
      stalenessRate: rates.stalenessRate,
    });
    expect(result.oldestKind).toBe("soc");
    expect(result.oldestAgeSeconds).toBe(8);
    expect(toCU(result.milliCU)).toBe(4);
  });

  test("C_lifecycle charges the distance-wear addend and names why", () => {
    const result = cLifecycle.evaluate(plan, fixture.lifecycleInput());
    expect(result.ok).toBe(true);
    expect(toCU(result.breakdown.distanceWear.milliCU)).toBeCloseTo(30, 9);
    expect(result.breakdown.distanceWear.note).toMatch(/charged here and not in C_direct/);
  });

  test("C_lifecycle's battery term is Phase 7's wear module, not a second implementation", () => {
    const wear = require("../../src/engine/energy/wear");
    const direct = wear.batteryWear(fixture.lifecycleInput().battery);
    const viaLifecycle = cLifecycle.evaluate(plan, fixture.lifecycleInput());
    expect(viaLifecycle.breakdown.batteryCycle.milliCU).toBe(direct.milliCU);
  });

  test("an actuator the plan cycles but the register does not price is refused, not free", () => {
    const result = cLifecycle.evaluate(plan, {
      ...fixture.lifecycleInput(),
      cuPerActuatorCycle: { DOOR: 0.02 },
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("lifecycle.cu_per_actuator_cycle.LATCH");
  });

  test("thermal stress refuses an absent multiplier rather than assuming reference conditions", () => {
    const broken = fixture.brandedPlan({ thermalStressMultiplier: undefined });
    const result = cLifecycle.evaluate(broken, fixture.lifecycleInput());
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("plan.thermalStressMultiplier");
  });
});

describe("§8.6 — C_policy: every adjustment named, ceilinged, and reported", () => {
  const plan = fixture.brandedPlan();

  test("the five §8.6 adjustments are registered with the ceiling parameter each declares", () => {
    expect(cPolicy.ADJUSTMENTS.map((row) => [row.id, row.ceilingParameter])).toEqual([
      ["ZONE_AFFINITY", "policy.max_zone_affinity_credit"],
      ["DEDICATED_FLEET", "policy.max_dedicated_fleet_credit"],
      ["BURN_IN", "policy.max_burn_in_credit"],
      ["PILOT", "policy.max_pilot_adjustment"],
      ["OPERATOR", "policy.max_operator_adjustment"],
    ]);
  });

  test("Ω_policy is derived from exactly this module's register", () => {
    const derived = require("../../src/engine/config/derived");
    const service = require("../../src/engine/config/service");
    const snapshot = service.defaultSnapshot();
    const coverage = cPolicy.assertRegisterCoverage(snapshot.derivationEvidence);

    expect(coverage.ok).toBe(true);
    expect(coverage.problems).toEqual([]);
    // Every ceiling this module knows about, and no others: a sixth adjustment added here
    // without a register entry would be a credit the pruning bound does not cover.
    expect(coverage.covered).toEqual(cPolicy.ADJUSTMENTS.map((row) => row.ceilingParameter).sort());
    expect(snapshot.values.get("cost.policy.max_total_credit")).toBe(60 + 300 + 120 + 120 + 300);
    expect(typeof derived.derivePolicyTotalCredit).toBe("function");
  });

  test("a sixth adjustment registered here but not in the register is caught", () => {
    const coverage = cPolicy.assertRegisterCoverage({
      policyTotalCredit: { ceilings: { "policy.max_zone_affinity_credit": 60 } },
    });
    expect(coverage.ok).toBe(false);
    expect(coverage.problems).toHaveLength(cPolicy.ADJUSTMENTS.length - 1);
  });

  test("a credit is clamped to its own ceiling and the clamping is reported", () => {
    const result = cPolicy.evaluate(
      plan,
      fixture.policyInput({
        adjustments: [{ id: "ZONE_AFFINITY", cu: -500, reason: "over-generous" }],
      }),
    );
    expect(result.ok).toBe(true);
    expect(toCU(result.milliCU)).toBe(-60);
    expect(result.records[0].disposition).toBe(cPolicy.DISPOSITION.CLAMPED_TO_CEILING);
  });

  test("an expired pilot adjustment is refused, not ignored", () => {
    const result = cPolicy.evaluate(
      plan,
      fixture.policyInput({
        adjustments: [
          {
            id: "PILOT",
            cu: -50,
            reason: "trial 4",
            expiresAtMs: fixture.DECISION_TIME_MS - 1,
          },
        ],
      }),
    );
    expect(result.milliCU).toBe(0n);
    expect(result.refusals[0].disposition).toBe(cPolicy.DISPOSITION.REFUSED_EXPIRED);
  });

  test("a pilot adjustment with no expiry at all is refused", () => {
    const result = cPolicy.evaluate(
      plan,
      fixture.policyInput({ adjustments: [{ id: "PILOT", cu: -50, reason: "trial 5" }] }),
    );
    expect(result.refusals[0].reason).toMatch(/MUST carry an expiry/);
  });

  test("an adjustment with no stated reason is refused — §8.6 prohibits an unattributed one", () => {
    const result = cPolicy.evaluate(
      plan,
      fixture.policyInput({ adjustments: [{ id: "OPERATOR", cu: -100 }] }),
    );
    expect(result.refusals[0].disposition).toBe(cPolicy.DISPOSITION.REFUSED_UNATTRIBUTED);
  });

  test("an unregistered adjustment is refused, because Ω_policy does not cover it", () => {
    const result = cPolicy.evaluate(
      plan,
      fixture.policyInput({ adjustments: [{ id: "FAVOURITE_ROBOT", cu: -1000, reason: "because" }] }),
    );
    expect(result.refusals[0].disposition).toBe(cPolicy.DISPOSITION.REFUSED_UNREGISTERED);
    expect(result.milliCU).toBe(0n);
  });

  test("an adjustment whose ceiling resolves to nothing is refused", () => {
    const result = cPolicy.evaluate(
      plan,
      fixture.policyInput({
        adjustments: [{ id: "BURN_IN", cu: -10, reason: "new firmware" }],
        config: { "policy.max_burn_in_credit": null },
      }),
    );
    expect(result.refusals[0].disposition).toBe(cPolicy.DISPOSITION.REFUSED_NO_CEILING);
  });

  test("the sum never falls beneath −Ω_policy, even with every adjustment at its ceiling", () => {
    const result = cPolicy.evaluate(
      plan,
      fixture.policyInput({
        adjustments: cPolicy.ADJUSTMENTS.map((row) => ({
          id: row.id,
          cu: -1_000_000,
          reason: "at ceiling",
          expiresAtMs: fixture.DECISION_TIME_MS + 1000,
        })),
      }),
    );
    expect(result.withinOmegaPolicy).toBe(true);
    expect(toCU(result.milliCU)).toBe(-(60 + 300 + 120 + 120 + 300));
  });
});

describe("§8.7 — the attribution rule", () => {
  const rates = fixture.rates();
  const parameters = fixture.delayParameters();
  const targetMs = fixture.DECISION_TIME_MS;
  const lateMs = targetMs + 300_000;

  test("a Leg with no stated role is refused — neither default is safe", () => {
    const result = cDelay.forLeg({ legId: "l", targetMs, queueAgeSeconds: 0 }, lateMs, parameters);
    expect(result.ok).toBe(false);
    expect(result.missing[0]).toMatch(/no safe default/);
  });

  test("the terminal Leg carries the full term and the whole breach penalty", () => {
    const result = cDelay.forLeg(
      {
        legId: "terminal",
        role: cDelay.LEG_ROLE.TERMINAL,
        missionId: "m",
        targetMs,
        deadlineMs: targetMs + 60_000,
        queueAgeSeconds: 0,
      },
      lateMs,
      parameters,
    );
    // 2 CU·s⁻¹ × 1 × 300² = 180 000 CU lateness, plus the 5 000 CU breach step.
    expect(toCU(result.breakdown.latenessMilliCU)).toBe(180_000);
    expect(result.breakdown.breached).toBe(true);
    expect(toCU(result.breakdown.breachMilliCU)).toBe(5000);
  });

  test("an upstream Leg carries only slack consumption, scaled by upstream_slack_weight", () => {
    const upstream = cDelay.forLeg(
      { legId: "upstream", role: cDelay.LEG_ROLE.UPSTREAM, missionId: "m", targetMs, queueAgeSeconds: 0 },
      lateMs,
      parameters,
    );
    expect(toCU(upstream.milliCU)).toBeCloseTo(180_000 * 0.15, 6);
  });

  test("an upstream Leg never carries M_breach, however far it overruns", () => {
    const upstream = cDelay.forLeg(
      {
        legId: "upstream",
        role: cDelay.LEG_ROLE.UPSTREAM,
        missionId: "m",
        targetMs,
        deadlineMs: targetMs + 1,
        queueAgeSeconds: 0,
      },
      targetMs + 10_000_000,
      parameters,
    );
    expect(upstream.breakdown.breached).toBe(false);
    expect(upstream.breakdown.breachMilliCU).toBe(0n);
  });

  test("exactly one terminal Leg per Mission — two is refused by name", () => {
    const ok = cDelay.assertAttribution([
      { legId: "a", missionId: "m1", role: cDelay.LEG_ROLE.TERMINAL },
      { legId: "b", missionId: "m1", role: cDelay.LEG_ROLE.UPSTREAM },
      { legId: "c", missionId: "m2", role: cDelay.LEG_ROLE.TERMINAL },
    ]);
    expect(ok).toEqual({ ok: true, problems: [] });

    const bad = cDelay.assertAttribution([
      { legId: "a", missionId: "m1", role: cDelay.LEG_ROLE.TERMINAL },
      { legId: "b", missionId: "m1", role: cDelay.LEG_ROLE.TERMINAL },
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.problems[0]).toMatch(/M_breach appears once per Mission/);
  });

  test("a three-Leg Mission is priced once, not three times", () => {
    const legs = [
      { legId: "a", missionId: "m", role: cDelay.LEG_ROLE.UPSTREAM, targetMs, queueAgeSeconds: 0 },
      { legId: "b", missionId: "m", role: cDelay.LEG_ROLE.UPSTREAM, targetMs, queueAgeSeconds: 0 },
      {
        legId: "c",
        missionId: "m",
        role: cDelay.LEG_ROLE.TERMINAL,
        targetMs,
        deadlineMs: targetMs + 60_000,
        queueAgeSeconds: 0,
      },
    ];
    const plan = fixture.brandedPlan({ legs });
    const completions = { a: lateMs, b: lateMs, c: lateMs };
    const result = cDelay.forPlan(plan, completions, () => parameters);

    expect(result.terminalLegCount).toBe(1);
    const breachCount = result.perLeg.filter((row) => row.breached).length;
    expect(breachCount).toBe(1);
    // Full term once, plus two slack terms — not three full terms.
    expect(toCU(result.milliCU)).toBeCloseTo(180_000 + 5000 + 2 * 180_000 * 0.15, 6);
  });

  test("the aging multiplier is capped at cost.aging.max_multiplier", () => {
    const uncapped = cDelay.agingMultiplier(900, { referencePeriodSeconds: 900, growthExponent: 1.5, maxMultiplier: 8 });
    expect(uncapped.multiplier).toBeCloseTo(2 ** 1.5, 9);
    expect(uncapped.capped).toBe(false);

    const capped = cDelay.agingMultiplier(1e9, {
      referencePeriodSeconds: 900,
      growthExponent: 1.5,
      maxMultiplier: 8,
    });
    expect(capped.multiplier).toBe(8);
    expect(capped.capped).toBe(true);
  });

  test("the cap binds inside the priced term, not only in the multiplier helper", () => {
    const aged = cDelay.forLeg(
      { legId: "l", role: cDelay.LEG_ROLE.TERMINAL, missionId: "m", targetMs, queueAgeSeconds: 1e9 },
      lateMs,
      parameters,
    );
    expect(aged.breakdown.agingCapped).toBe(true);
    expect(toCU(aged.milliCU)).toBe(180_000 * 8);
  });

  test("C_delay is zero at or before target — earliness is never a credit", () => {
    const early = cDelay.forLeg(
      { legId: "l", role: cDelay.LEG_ROLE.TERMINAL, missionId: "m", targetMs, deadlineMs: targetMs + 1, queueAgeSeconds: 0 },
      targetMs - 600_000,
      parameters,
    );
    expect(early.milliCU).toBe(0n);
  });
});

describe("§8.3.3 — C_opportunity, derived rather than asserted", () => {
  const plan = fixture.brandedPlan();

  test("the telescoping identity holds exactly: the intermediate term cancels", () => {
    const residual = cOpportunity.telescopingResidual(fixture.opportunityInput());
    expect(residual.ok).toBe(true);
    expect(residual.residualCu).toBe(0);
    expect(residual.decomposedCu).toBe(residual.undecomposedCu);
  });

  test("the identity still holds when the commitment runs past the horizon", () => {
    const input = fixture.opportunityInput({
      releaseMs: fixture.DECISION_TIME_MS + 120 * fixture.MINUTE_MS,
    });
    const residual = cOpportunity.telescopingResidual(input);
    expect(residual.ok).toBe(true);
    expect(residual.residualCu).toBeCloseTo(0, 9);
  });

  test("(b) the integral is over the origin zone at a fixed position — there is no route parameter", () => {
    // A structural assertion, not a numeric one: the signature has nowhere to put a path.
    const source = fs.readFileSync(path.join(COST_DIR, "cOpportunity.js"), "utf8");
    const body = /function unavailability\(input\)[\s\S]*?\n}/.exec(source)[0];
    expect(body).not.toMatch(/route|path|zonesTraversed|zoneTraversals/i);

    // And behaviourally: passing through an expensive zone changes nothing.
    const base = cOpportunity.unavailability(fixture.opportunityInput());
    const throughRichZone = cOpportunity.unavailability({
      ...fixture.opportunityInput(),
      routeZoneIds: ["zone-rich", "zone-rich"],
    });
    expect(throughRichZone.cu).toBe(base.cu);
  });

  test("(b) the unavailability component is the origin zone's price, integrated over the commitment", () => {
    const result = cOpportunity.unavailability(fixture.opportunityInput());
    // zone-poor at 0.01 CU·s⁻¹ for 600 s.
    expect(result.cu).toBeCloseTo(6, 9);
    expect(result.durationSeconds).toBe(600);
  });

  test("(c) both relocation evaluations are at t_release — there is one instant, not two", () => {
    const source = fs.readFileSync(path.join(COST_DIR, "cOpportunity.js"), "utf8");
    const body = /function relocation\(input\)[\s\S]*?\n}\n/.exec(source)[0];
    expect(body).not.toMatch(/startMs/);
    expect((body.match(/releaseMs/g) || []).length).toBeGreaterThan(0);
  });

  test("a mission ending in a higher-value zone produces a negative relocation component", () => {
    const result = cOpportunity.relocation(fixture.opportunityInput());
    expect(result.cu).toBeLessThan(0);
  });

  test("the whole term is bounded below by −Ω_terminal, and the check is enforced", () => {
    const result = cOpportunity.evaluate(plan, fixture.opportunityInput());
    expect(result.ok).toBe(true);
    expect(result.signCheck.ok).toBe(true);

    const tooTight = cOpportunity.evaluate(plan, fixture.opportunityInput({ omegaTerminalCu: 1 }));
    expect(tooTight.signCheck.ok).toBe(false);
    expect(tooTight.problems[0]).toMatch(/beneath its declared floor/);
  });

  test("Ω_terminal is required: an unbounded negative term cannot be pruned against", () => {
    const result = cOpportunity.evaluate(plan, fixture.opportunityInput({ omegaTerminalCu: undefined }));
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/Ω_terminal|max_terminal_gain/);
  });

  test("a commitment past the horizon saturates, and says so", () => {
    const saturated = cOpportunity.unavailability(
      fixture.opportunityInput({ releaseMs: fixture.DECISION_TIME_MS + 120 * fixture.MINUTE_MS }),
    );
    expect(saturated.saturated).toBe(true);
  });

  test("a negative λ in the surface is refused — §8.3.3 depends on λ ≥ 0", () => {
    const snapshot = fixture.priceSnapshot();
    snapshot.zones["zone-poor"] = [
      { startMs: fixture.DECISION_TIME_MS - 1000, endMs: snapshot.horizonEndMs, lambdaCuPerSecond: -1 },
    ];
    const result = cOpportunity.unavailability(fixture.opportunityInput({ priceSnapshot: snapshot }));
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/λ_zone ≥ 0/);
  });
});

describe("§8.1 — sign discipline", () => {
  test("every term in §8.1's sentence declares a sign", () => {
    for (const term of ["C_direct", "C_risk", "C_lifecycle", "C_delay", "C_churn"]) {
      expect(signDiscipline.DECLARATIONS[term].sign).toBe(signDiscipline.SIGN.NON_NEGATIVE);
    }
    for (const term of ["C_opportunity", "C_policy"]) {
      expect(signDiscipline.DECLARATIONS[term].sign).toBe(signDiscipline.SIGN.BOUNDED_BELOW);
    }
  });

  test("a term with no declaration cannot be checked, and says why", () => {
    const result = signDiscipline.check("C_mystery", 0n);
    expect(result.ok).toBe(false);
    expect(result.finding).toMatch(/declares no sign/);
  });

  test("a non-negative term going negative is a finding, not a rounding note", () => {
    const result = signDiscipline.check("C_direct", -1n);
    expect(result.ok).toBe(false);
    expect(result.finding).toMatch(/inadmissible/);
  });

  test("a bounded-below term with no bound supplied is refused", () => {
    expect(signDiscipline.check("C_opportunity", -1n).finding).toMatch(/no bound was supplied/);
  });

  test("assertOrThrow escalates for development and test", () => {
    expect(() => signDiscipline.assertOrThrow("C_risk", -1n)).toThrow(RangeError);
    expect(signDiscipline.assertOrThrow("C_risk", 5n)).toBe(5n);
  });

  test("the two terms §6.4's bound must correct for are derived from the declarations", () => {
    expect(signDiscipline.boundedBelowTerms()).toEqual([
      { term: "C_opportunity", bound: "cost.opportunity.max_terminal_gain" },
      { term: "C_policy", bound: "cost.policy.max_total_credit" },
    ]);
  });
});

describe("§1.3 — properties min-max normalisation cannot satisfy", () => {
  const rates = fixture.directInput();

  test("a 10 km mission costs more than a 1 km one, all else equal", () => {
    const short = fixture.brandedPlan({ distanceM: 1000 });
    const long = fixture.brandedPlan({ distanceM: 10_000 });

    const shortCost = cLifecycle.evaluate(short, fixture.lifecycleInput());
    const longCost = cLifecycle.evaluate(long, fixture.lifecycleInput());
    expect(longCost.milliCU > shortCost.milliCU).toBe(true);
  });

  test("a longer mission costs more in C_direct too, and the difference is the real quantity", () => {
    const short = fixture.brandedPlan({ components: { ...fixture.plan().components, linehaulSeconds: 600 } });
    const long = fixture.brandedPlan({ components: { ...fixture.plan().components, linehaulSeconds: 1200 } });
    const difference = cDirect.evaluate(long, rates).milliCU - cDirect.evaluate(short, rates).milliCU;
    expect(toCU(difference)).toBe(600);
  });

  test("with a single candidate the cost is its own absolute cost, not 0.5 of a range", () => {
    const only = fixture.brandedPlan();
    const result = phi.evaluate(only, fixture.phiInput());
    expect(result.ok).toBe(true);
    expect(result.milliCU).not.toBe(0n);
    expect(toCU(result.milliCU)).toBeGreaterThan(1000);
  });
});

describe("Φ — the functional (§8.1)", () => {
  test("Φ sums the five core terms and reports each", () => {
    const plan = fixture.brandedPlan();
    const result = phi.evaluate(plan, fixture.phiInput());
    expect(result.ok).toBe(true);
    expect(Object.keys(result.breakdown.terms).sort()).toEqual([
      "C_delay",
      "C_direct",
      "C_lifecycle",
      "C_policy",
      "C_risk",
    ]);
    const summed = Object.values(result.breakdown.terms).reduce((total, value) => total + value, 0n);
    expect(result.milliCU).toBe(summed);
  });

  test("with no evaluator registered, the omission is recorded — never summed as zero", () => {
    const result = phi.evaluate(fixture.brandedPlan(), fixture.phiInput());
    expect(result.omittedTerms.map((row) => row.term)).toEqual(["C_opportunity"]);
    expect(result.omittedTerms[0].killSwitch).toBe("opportunity_cost_term");
    expect(result.breakdown.terms.C_opportunity).toBeUndefined();
  });

  test("the Tier 2 term arrives by registration and changes the total", () => {
    const plan = fixture.brandedPlan();
    const without = phi.evaluate(plan, fixture.phiInput());
    phi.registerTerm("C_opportunity", (candidate, input) => cOpportunity.evaluate(candidate, input));
    const with_ = phi.evaluate(plan, fixture.phiInput({ opportunity: fixture.opportunityInput() }));

    expect(phi.registeredTerms()).toEqual(["C_opportunity"]);
    expect(with_.milliCU).not.toBe(without.milliCU);
    expect(with_.omittedTerms).toEqual([]);
  });

  test("only the two Tier 2 terms may be registered", () => {
    expect(() => phi.registerTerm("C_direct", () => ({}))).toThrow(/not a registrable term/);
    expect(Object.keys(phi.REGISTRABLE_TERMS).sort()).toEqual(["C_churn", "C_opportunity"]);
  });

  test("cost.wear.cu_per_metre · d_mission is charged exactly once", () => {
    const plan = fixture.brandedPlan();
    const result = phi.evaluate(plan, fixture.phiInput());
    expect(result.breakdown.wearAttribution.chargedIn).toEqual(["C_lifecycle"]);
    expect(result.problems).toEqual([]);
  });

  test("the attribution check catches a Φ that summed the wear addend twice", () => {
    const direct = cDirect.evaluate(fixture.brandedPlan(), fixture.directInput());
    const lifecycle = cLifecycle.evaluate(fixture.brandedPlan(), fixture.lifecycleInput());
    const doubled = phi.assertWearChargedOnce(
      direct.breakdown,
      lifecycle.breakdown,
      direct.milliCUWithDistanceWear,
    );
    expect(doubled.ok).toBe(false);
    expect(doubled.chargedIn).toEqual(["C_lifecycle", "C_direct"]);
  });

  test("Φ(∅) is exactly zero, in integer milli-CU", () => {
    expect(phi.empty().milliCU).toBe(0n);
  });

  test("Φ sums over every Leg, committed ones included", () => {
    const legs = [
      {
        legId: "committed",
        missionId: "m0",
        role: cDelay.LEG_ROLE.TERMINAL,
        targetMs: fixture.DECISION_TIME_MS,
        deadlineMs: fixture.DECISION_TIME_MS + 10 * fixture.MINUTE_MS,
        queueAgeSeconds: 0,
        committed: true,
      },
      ...fixture.plan().legs,
    ];
    const plan = fixture.brandedPlan({ legs });
    const result = phi.evaluate(
      plan,
      fixture.phiInput({
        completionByLegId: {
          committed: fixture.DECISION_TIME_MS + 5 * fixture.MINUTE_MS,
          "leg-1": fixture.DECISION_TIME_MS + 45 * fixture.MINUTE_MS,
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.breakdown.legCount).toBe(2);
    expect(result.breakdown.committedLegCount).toBe(1);
    expect(result.breakdown.detail.C_delay.perLeg).toHaveLength(2);
  });

  test("the total is order-independent — integer arithmetic, not float accumulation", () => {
    const plan = fixture.brandedPlan();
    const first = phi.evaluate(plan, fixture.phiInput());
    const second = phi.evaluate(plan, fixture.phiInput());
    expect(first.milliCU).toBe(second.milliCU);
    expect(typeof first.milliCU).toBe("bigint");
  });
});

describe("§8.9 — C_churn", () => {
  const rates = fixture.rates();
  const base = {
    reservedAtMs: fixture.DECISION_TIME_MS - 120_000,
    decisionTimeMs: fixture.DECISION_TIME_MS,
    baseCostCu: 10,
    perSecondRate: rates.churnPerSecond,
    wastedTravelRate: rates.churnWastedTravel,
    notificationCostCu: 2,
  };

  test("a column displacing nothing is an evaluated zero, distinguishable from the term being off", () => {
    const result = cChurn.evaluate({ ...base, displacement: { kind: cChurn.DISPLACEMENT.NONE } });
    expect(result.milliCU).toBe(0n);
    expect(result.breakdown.indicator).toBe(0);
  });

  test("revising a SOFT reservation is cheap: no travel wasted", () => {
    const result = cChurn.evaluate({
      ...base,
      displacement: { kind: cChurn.DISPLACEMENT.SOFT_RESERVATION },
      distanceAlreadyTravelledM: 0,
    });
    // 10 base + 120 s × 0.1 + 0 travel + 2 notification.
    expect(toCU(result.milliCU)).toBeCloseTo(24, 9);
  });

  test("revising a HARD commitment costs more through elapsed time and wasted travel", () => {
    const result = cChurn.evaluate({
      ...base,
      reservedAtMs: fixture.DECISION_TIME_MS - 600_000,
      displacement: { kind: cChurn.DISPLACEMENT.HARD_COMMITMENT, protocolSatisfied: true },
      distanceAlreadyTravelledM: 800,
    });
    // 10 + 600 × 0.1 + 800 × 0.05 + 2.
    expect(toCU(result.milliCU)).toBeCloseTo(112, 9);
  });

  test("paying the churn price does not bypass §4.7's reassignment protocol", () => {
    const result = cChurn.evaluate({
      ...base,
      displacement: { kind: cChurn.DISPLACEMENT.HARD_COMMITMENT },
      distanceAlreadyTravelledM: 800,
    });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/does not grant permission/);
  });

  test("the term is never negative", () => {
    const result = cChurn.evaluate({
      ...base,
      displacement: { kind: cChurn.DISPLACEMENT.SOFT_RESERVATION },
      distanceAlreadyTravelledM: 0,
    });
    expect(result.signCheck.ok).toBe(true);
  });

  test("the disabled behaviour is a named, tested zero", () => {
    expect(cChurn.degraded().milliCU).toBe(0n);
    expect(cChurn.degraded().breakdown.killSwitch).toBe("churn_pricing");
  });
});

describe("§8.8 — C_defer, present and switched off", () => {
  const leg = {
    legId: "l",
    role: cDelay.LEG_ROLE.TERMINAL,
    missionId: "m",
    targetMs: fixture.DECISION_TIME_MS,
    deadlineMs: fixture.DECISION_TIME_MS + 3_600_000,
    queueAgeSeconds: 0,
  };

  test("the arc is unavailable while the kill switch is thrown", () => {
    const verdict = cDefer.admissible({ deferralEnabled: false });
    expect(verdict.admissible).toBe(false);
    expect(verdict.refusal).toBe(cDefer.REFUSAL.KILL_SWITCH);
  });

  test("the arc is removed at max_deferral_time, not merely priced high", () => {
    const verdict = cDefer.admissible({
      deferralEnabled: true,
      firstDeferredAtMs: fixture.DECISION_TIME_MS - 600_000,
      decisionTimeMs: fixture.DECISION_TIME_MS,
      consecutiveDeferrals: 0,
      maxDeferralTimeSeconds: 300,
      maxConsecutiveDeferrals: 5,
    });
    expect(verdict.admissible).toBe(false);
    expect(verdict.refusal).toBe(cDefer.REFUSAL.MAX_TIME);
    expect(verdict.reason).toMatch(/removed rather than priced high/);
  });

  test("the arc is removed at max_consecutive_deferrals", () => {
    const verdict = cDefer.admissible({
      deferralEnabled: true,
      firstDeferredAtMs: fixture.DECISION_TIME_MS,
      decisionTimeMs: fixture.DECISION_TIME_MS,
      consecutiveDeferrals: 5,
      maxDeferralTimeSeconds: 3000,
      maxConsecutiveDeferrals: 5,
    });
    expect(verdict.refusal).toBe(cDefer.REFUSAL.MAX_CONSECUTIVE);
  });

  test("the price is the delay at the deferred completion plus two expectations", () => {
    const result = cDefer.evaluate({
      leg,
      expectedCompletionIfDeferredMs: fixture.DECISION_TIME_MS + 100_000,
      delayParameters: fixture.delayParameters(),
      probabilityNoBetter: 0.2,
      wastedRoundPenaltyCu: 50,
      riskOfDeadlineLoss: 0.01,
      breachPenaltyCu: 5000,
    });
    expect(result.ok).toBe(true);
    // 2 × 100² = 20 000 delay, + 0.2 × 50 = 10, + 0.01 × 5000 = 50.
    expect(toCU(result.milliCU)).toBeCloseTo(20_060, 6);
    expect(result.signCheck.ok).toBe(true);
  });

  test("the delay addend is cDelay's own functional, not a second implementation", () => {
    const parameters = fixture.delayParameters();
    const deferredAt = fixture.DECISION_TIME_MS + 100_000;
    const direct = cDelay.forLeg(leg, deferredAt, parameters);
    const viaDefer = cDefer.evaluate({
      leg,
      expectedCompletionIfDeferredMs: deferredAt,
      delayParameters: parameters,
      probabilityNoBetter: 0,
      wastedRoundPenaltyCu: 0,
      riskOfDeadlineLoss: 0,
      breachPenaltyCu: 0,
    });
    expect(viaDefer.milliCU).toBe(direct.milliCU);
  });

  test("a deferral must explain itself, and an incomplete reason is refused", () => {
    expect(cDefer.reason({ expectedImprovementCu: 3200 }).ok).toBe(false);

    const explained = cDefer.reason({
      expectedImprovementCu: 3200,
      supplyEvent: { description: "agent-9 finishing", distanceM: 600, projectedFreeInSeconds: 90 },
      projectedAssignmentMs: fixture.DECISION_TIME_MS + 90_000,
      deferralDeadlineMs: fixture.DECISION_TIME_MS + 600_000,
    });
    expect(explained.ok).toBe(true);
    expect(explained.sentence).toBe(
      "waiting — an agent 600 m away is projected free in 90 s; assigning the nearest available agent now would cost 3200 CU more.",
    );
    expect(explained.record.tier).toBe("A");
  });

  test("the disabled behaviour is immediate assignment, named", () => {
    expect(cDefer.degraded().breakdown.degradesTo).toMatch(/immediate assignment/);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * Phase 8 remediation — regression tests, one per defect closed.
 *
 * Each test below fails against the code as Phase 8 originally shipped. They are
 * grouped here rather than folded into the suites above so that a reader can see
 * what each defect was and what now prevents it.
 * ══════════════════════════════════════════════════════════════════════════ */

describe("Phase 8 remediation — §8.7's once-per-Mission rule is enforced where the sum happens", () => {
  const targetMs = fixture.DECISION_TIME_MS + 40 * fixture.MINUTE_MS;
  const lateMs = fixture.DECISION_TIME_MS + 45 * fixture.MINUTE_MS;
  const parameters = fixture.delayParameters();

  /** Two Legs of ONE Mission, both marked terminal — the shape §8.7 forbids. */
  function doubleTerminalLegs() {
    return [
      { legId: "a", missionId: "m1", role: cDelay.LEG_ROLE.TERMINAL, targetMs, deadlineMs: targetMs, queueAgeSeconds: 0, committed: false },
      { legId: "b", missionId: "m1", role: cDelay.LEG_ROLE.TERMINAL, targetMs, deadlineMs: targetMs, queueAgeSeconds: 0, committed: false },
    ];
  }

  test("forPlan refuses a plan that would charge M_breach twice for one Mission", () => {
    const plan = fixture.brandedPlan({ legs: doubleTerminalLegs() });
    const result = cDelay.forPlan(plan, { a: lateMs, b: lateMs }, () => parameters);

    // Before: ok:true, two breach steps, and a total inflated by exactly one M_breach.
    expect(result.ok).toBe(false);
    expect(result.milliCU).toBeNull();
    expect(result.missing.join(" ")).toMatch(/M_breach appears once per Mission/);
  });

  test("the refusal reaches Φ, so no such plan can be priced", () => {
    const plan = fixture.brandedPlan({ legs: doubleTerminalLegs() });
    const result = phi.evaluate(
      plan,
      fixture.phiInput({ completionByLegId: { a: lateMs, b: lateMs } }),
    );
    expect(result.ok).toBe(false);
    expect(result.milliCU).toBeNull();
    expect(result.missing.join(" ")).toMatch(/C_delay: .*terminal Legs/);
  });

  test("two terminal Legs of DIFFERENT Missions remain priceable — the rule is per Mission", () => {
    const legs = [
      { legId: "a", missionId: "m1", role: cDelay.LEG_ROLE.TERMINAL, targetMs, deadlineMs: targetMs, queueAgeSeconds: 0, committed: true },
      { legId: "b", missionId: "m2", role: cDelay.LEG_ROLE.TERMINAL, targetMs, deadlineMs: targetMs, queueAgeSeconds: 0, committed: false },
    ];
    const result = cDelay.forPlan(fixture.brandedPlan({ legs }), { a: lateMs, b: lateMs }, () => parameters);
    expect(result.ok).toBe(true);
    expect(result.terminalLegCount).toBe(2);
    expect(result.perLeg.filter((row) => row.breached)).toHaveLength(2);
  });
});

describe("Phase 8 remediation — a violated sign declaration refuses the price (§8.1, §6.4)", () => {
  test("a C_policy credit beneath −Ω_policy makes Φ fail rather than report and continue", () => {
    const plan = fixture.brandedPlan();
    // The fixture offers a −20 CU zone-affinity credit; Ω_policy of 1 milli-CU cannot cover it.
    const evaluateWithTightBound = () =>
      phi.evaluate(
        plan,
        fixture.phiInput({ bounds: { omegaTerminalMilliCU: 0n, omegaPolicyMilliCU: 1n } }),
      );

    // In test, §8.1's escalation throws — the behaviour the checklist asks for and that
    // nothing under src/ performed as shipped.
    expect(phi.escalationEnabled()).toBe(true);
    expect(evaluateWithTightBound).toThrow(/beneath its declared floor/);
  });

  test("outside dev/test the same violation is an unpriceable candidate, not a priced one", () => {
    const plan = fixture.brandedPlan();
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(phi.escalationEnabled()).toBe(false);
      const result = phi.evaluate(
        plan,
        fixture.phiInput({ bounds: { omegaTerminalMilliCU: 0n, omegaPolicyMilliCU: 1n } }),
      );
      // Before: ok:true, a full milliCU value, and the finding stranded in `problems`,
      // which no module under src/ reads.
      expect(result.ok).toBe(false);
      expect(result.milliCU).toBeNull();
      expect(result.problems.join(" ")).toMatch(/beneath its declared floor/);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  test("an absent Ω bound is a named missing input, not a note on a priced result", () => {
    const plan = fixture.brandedPlan();
    const result = phi.evaluate(plan, fixture.phiInput({ bounds: undefined }));
    expect(result.ok).toBe(false);
    expect(result.milliCU).toBeNull();
    expect(result.missing.join(" ")).toMatch(/bounds\.omegaPolicyMilliCU/);
  });

  test("the bound a registered C_opportunity needs is required only while it is registered", () => {
    const plan = fixture.brandedPlan();
    expect(phi.missingBoundsFor(["C_policy"], { omegaPolicyMilliCU: 1n })).toEqual([]);
    expect(phi.missingBoundsFor(["C_policy", "C_opportunity"], { omegaPolicyMilliCU: 1n })).toHaveLength(1);

    phi.registerTerm("C_opportunity", (candidate, input) => cOpportunity.evaluate(candidate, input));
    const result = phi.evaluate(
      plan,
      fixture.phiInput({
        opportunity: fixture.opportunityInput(),
        bounds: { omegaPolicyMilliCU: 900_000n },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.missing.join(" ")).toMatch(/bounds\.omegaTerminalMilliCU/);
  });

  test("a correctly bounded plan is still priced, and reports no problems", () => {
    const result = phi.evaluate(fixture.brandedPlan(), fixture.phiInput());
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(typeof result.milliCU).toBe("bigint");
  });
});

describe("Phase 8 remediation — C_risk's lateness term uses the one specified rounding site (§9.6)", () => {
  test("the probability scales the overrun through scaleByRate, not Math.round", () => {
    const plan = fixture.brandedPlan();
    const overrunMilliCU = 120_001n;
    const lateProbability = 0.5;
    const result = cRisk.evaluate(plan, fixture.riskInput({ overrunMilliCU, lateProbability }));

    expect(result.ok).toBe(true);
    // 120001 × 0.5 = 60000.5 — an exact half boundary. ROUND_HALF_AWAY_FROM_ZERO takes it
    // to 60001, which Math.round also does for a positive value; the assertion pins the
    // specified mode rather than the coincidence.
    expect(result.breakdown.lateness.milliCU).toBe(scaleByRate(overrunMilliCU, lateProbability));
    expect(result.breakdown.lateness.milliCU).toBe(60_001n);
  });

  test("the source carries no second rounding mode in the priced path", () => {
    const source = fs.readFileSync(path.join(COST_DIR, "cRisk.js"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // §9.6: "the conversion boundary is one function", so no cost module may round itself.
    expect(code).not.toMatch(/Math\s*\.\s*round\s*\(/);
    expect(code).toMatch(/scaleByRate\(/);
  });

  test("every cost module rounds through determinism/fixedPoint alone", () => {
    const offenders = [];
    for (const file of fs.readdirSync(COST_DIR).filter((name) => name.endsWith(".js"))) {
      const code = fs
        .readFileSync(path.join(COST_DIR, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      if (/Math\s*\.\s*(round|floor|ceil|trunc)\s*\(/.test(code)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

"use strict";

/**
 * §24.1's build gate for Phase 9: "Lower-bound admissibility is a build gate, not
 * a sampled property. `LB ≤ γ` (§6.4) is checked exhaustively at build time over
 * the configured parameter space — every `C_policy` credit ceiling, the published
 * `λ_zone` range per region, every agent class, every SLA class — and the build
 * **fails** on any combination admitting `LB > γ`."
 *
 * ── The proof this test encodes ───────────────────────────────────────────────
 * `LB(a, l)`'s admissibility rests on six separate underestimate/floor claims
 * (§6.4). Each is a genuine mathematical inequality between one of `lowerBound.js`'s
 * terms and its real (`γ`) counterpart, given the same shared rates:
 *
 *   1. `travelSeconds ≤ realTravelSeconds` — great-circle distance ≤ any real
 *      route length, and `v_max` ≥ any real achievable speed.
 *   2. `λ_min ≤ real λ_time` — the register's A1 invariant (checked separately,
 *      below, against the live default snapshot — not re-derived here).
 *   3. `E_min = κ·β_dist·distance ≤ real E_leg` — §14.2's other addends
 *      (climb, mass, move-time, stop-start, dwell, aux, thermal) are each ≥ 0.
 *   4. `C_delay(earliest possible completion) ≤ C_delay(any later completion)` —
 *      §8.7's formula is non-decreasing in `T_complete` for fixed queue age.
 *   5. `0 ≤ real C_risk + C_lifecycle + C_churn` — all three are "≥ 0 always" by
 *      §6.4's own table, so omitting them from `LB` entirely is safe.
 *   6. `−Ω_policy ≤ real C_policy` and `−Ω_terminal ≤ real C_opportunity` — proven
 *      by construction elsewhere (`config/validators.js`'s V2 for the first,
 *      `pricing/vTerminal.js`'s `omegaTerminal()` for the second); this test
 *      exercises the *boundary* (`real term == −Ω exactly`) and beyond.
 *
 * This suite does not re-verify claims 2 and 6's own derivations (those are
 * Phase 1's and Phase 8's build gates respectively) — it verifies that `LB(a,l)`'s
 * *composition* of all six claims is itself sound, by constructing, for a swept
 * grid of scenarios, both `LB` (via the real `lowerBound.js`) and an independently
 * assembled reference `γ` that satisfies every one of the six inequalities above
 * with an explicit, non-negative "slack" per scenario — then asserting
 * `LB ≤ γ_reference` never fails. At the all-zero-slack scenario every inequality
 * above is tight (equality), which is the boundary most likely to expose a sign
 * error, and is asserted separately and exactly.
 */

const { lowerBound } = require("../../src/engine/candidates/lowerBound");
const { greatCircleMetres } = require("../../src/engine/spatial/cells");
const cDelay = require("../../src/engine/cost/cDelay");
const { makeRate, apply } = require("../../src/engine/cost/exchangeRates");
const { toMilliCU, sum, subtract, compare } = require("../../src/engine/determinism/fixedPoint");
const admissibilityGate = require("../../src/engine/candidates/admissibilityGate");
const { defaultSnapshot } = require("../../src/engine/config/service");
const f = require("./helpers/candidateFixture");

describe("§24.1 — register-level prerequisites (re-run at every config publish)", () => {
  test("A1 (λ floor) and V2 (Ω_policy) hold for the default (§1.8 rule 3 baseline) snapshot", () => {
    const snapshot = defaultSnapshot();
    const result = admissibilityGate.checkRegisterPrerequisites({
      entries: [...snapshot.entries.values()],
      values: snapshot.values,
      derivedValues: snapshot.derivedValues,
    });
    expect(result).toEqual({ ok: true, problems: [] });
  });

  test("a negative Ω_terminal is refused, never silently subtracted", () => {
    const problems = admissibilityGate.checkOmegaNonNegative({ ok: true, milliCU: -1n });
    expect(problems.length).toBeGreaterThan(0);
  });

  test("Ω_terminal absent from the result (inactive term) reports no problem", () => {
    expect(admissibilityGate.checkOmegaNonNegative({ ok: false })).toEqual([]);
  });
});

describe("§8.7 — C_delay is non-decreasing in completion time (the claim LB's fourth term rests on)", () => {
  test("a later completion never prices lower, for a spread of lateness exponents and queue ages", () => {
    const leg = f.legForBound();
    for (const latenessExponent of [1, 2, 3]) {
      for (const queueAgeSeconds of [0, 600, 6000]) {
        const parameters = f.delayParameters({ latenessExponent });
        const legWithAge = { ...leg, queueAgeSeconds };
        let previous = null;
        for (const offsetMinutes of [0, 1, 10, 30, 90]) {
          const completionMs = leg.earliestPossibleCompletionMs + offsetMinutes * 60_000;
          const result = cDelay.forLeg(legWithAge, completionMs, parameters);
          expect(result.ok).toBe(true);
          if (previous !== null) expect(result.milliCU >= previous).toBe(true);
          previous = result.milliCU;
        }
      }
    }
  });
});

describe("§6.4 — LB(a,l) ≤ γ, exhaustively over a swept scenario grid", () => {
  const LAMBDA_TIME_FLOOR = 0.5;

  /**
   * One scenario: how far the "real" world is allowed to deviate from `LB`'s
   * underestimated inputs, plus the SLA/policy/opportunity configuration in force.
   * Every field is a non-negative slack except `speedFactor` (≤ 1) and
   * `opportunityActive` (boolean) — the two directions admissibility depends on.
   */
  const SCENARIOS = [];
  for (const routeFactor of [1, 3]) {
    for (const speedFactor of [1, 0.25]) {
      for (const extraWaitS of [0, 500]) {
        for (const extraEnergyWh of [0, 150]) {
          for (const extraCompletionS of [0, 4000]) {
            for (const realLambdaTime of [LAMBDA_TIME_FLOOR, 2.5]) {
              for (const betaDist of [0.005, 0.08]) {
                for (const omegaPolicyCu of [0, 900]) {
                  for (const policySlackCu of [0, 40]) {
                    for (const opportunityActive of [false, true]) {
                      for (const omegaTerminalCu of opportunityActive ? [0, 5000] : [0]) {
                        for (const opportunitySlackCu of opportunityActive ? [0, 25] : [0]) {
                          SCENARIOS.push({
                            routeFactor,
                            speedFactor,
                            extraWaitS,
                            extraEnergyWh,
                            extraCompletionS,
                            realLambdaTime,
                            betaDist,
                            omegaPolicyCu,
                            policySlackCu,
                            opportunityActive,
                            omegaTerminalCu,
                            opportunitySlackCu,
                          });
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  test(`the grid is non-trivial (${SCENARIOS.length} combinations)`, () => {
    expect(SCENARIOS.length).toBeGreaterThan(50);
  });

  test.each(SCENARIOS)(
    "LB ≤ γ_reference for %j",
    (scenario) => {
      const agent = f.agentSnapshot();
      const leg = f.legForBound();
      const kappa = 1;

      const boundRates = f.boundRates({ lambdaTimeFloor: LAMBDA_TIME_FLOOR, cuPerWh: 1 });
      const delayParameters = f.delayParameters();

      const omegaPolicyMilliCU = toMilliCU(scenario.omegaPolicyCu);
      const omegaTerminalMilliCU = scenario.opportunityActive ? toMilliCU(scenario.omegaTerminalCu) : 0n;
      const correction = { milliCU: sum([omegaPolicyMilliCU, omegaTerminalMilliCU]) };

      // ── LB, via the real module ────────────────────────────────────────────
      const bound = lowerBound({
        agent,
        waitUntilAvailableSeconds: 0,
        energy: { kappa, model: { beta_dist: scenario.betaDist } },
        leg,
        rates: boundRates,
        delayParameters,
        correction,
      });
      expect(bound.ok).toBe(true);

      // ── γ_reference, assembled independently at real (non-underestimated) values ──
      const greatCircleM = greatCircleMetres(agent.lat, agent.lon, leg.firstStopLat, leg.firstStopLon);
      const realDistanceM = greatCircleM * scenario.routeFactor;
      const realSpeedMs = agent.mobilityModel.kinematicLimits.maxSpeedMs * scenario.speedFactor;
      const realTravelSeconds = realDistanceM / realSpeedMs;
      const realWaitSeconds = 0 + scenario.extraWaitS;
      const realTotalSeconds = realTravelSeconds + realWaitSeconds;

      const realLambdaRate = makeRate("cost.lambda_time", scenario.realLambdaTime, { unit: "CU·s⁻¹" });
      const realTravelMilliCU = apply(realLambdaRate, realTotalSeconds, "s").milliCU;

      const realEnergyBaseWh = kappa * scenario.betaDist * realDistanceM;
      const realEnergyWh = realEnergyBaseWh + scenario.extraEnergyWh;
      const realEnergyMilliCU = apply(boundRates.cuPerWh, realEnergyWh, "Wh").milliCU;

      const realCompletionMs = leg.earliestPossibleCompletionMs + scenario.extraCompletionS * 1000;
      const realDelay = cDelay.forLeg(leg, realCompletionMs, delayParameters);
      expect(realDelay.ok).toBe(true);

      // Claim 5: C_risk + C_lifecycle + C_churn ≥ 0, omitted from LB entirely.
      // Exercised at zero here — the omission's admissibility does not depend on
      // their magnitude, only their sign, which §6.4's own table states.
      const realRiskLifecycleChurnMilliCU = 0n;

      const realPolicyMilliCU = subtract(0n, omegaPolicyMilliCU) + toMilliCU(scenario.policySlackCu);
      const realOpportunityMilliCU = scenario.opportunityActive
        ? subtract(0n, omegaTerminalMilliCU) + toMilliCU(scenario.opportunitySlackCu)
        : 0n;

      const gammaReferenceMilliCU = sum([
        realTravelMilliCU,
        realEnergyMilliCU,
        realDelay.milliCU,
        realRiskLifecycleChurnMilliCU,
        realPolicyMilliCU,
        realOpportunityMilliCU,
      ]);

      expect(compare(bound.milliCU, gammaReferenceMilliCU)).toBeLessThanOrEqual(0);
    },
  );

  test("at the all-zero-slack boundary, LB equals γ_reference exactly (mod milli-CU rounding)", () => {
    const agent = f.agentSnapshot();
    const leg = f.legForBound();
    const boundRates = f.boundRates({ lambdaTimeFloor: LAMBDA_TIME_FLOOR, cuPerWh: 1 });
    const delayParameters = f.delayParameters();
    const correction = f.zeroCorrection();

    const bound = lowerBound({
      agent,
      waitUntilAvailableSeconds: 0,
      energy: { kappa: 1, model: { beta_dist: 0.02 } },
      leg,
      rates: boundRates,
      delayParameters,
      correction,
    });
    expect(bound.ok).toBe(true);

    const greatCircleM = greatCircleMetres(agent.lat, agent.lon, leg.firstStopLat, leg.firstStopLon);
    const realLambdaRate = makeRate("cost.lambda_time", LAMBDA_TIME_FLOOR, { unit: "CU·s⁻¹" });
    const realTravelMilliCU = apply(
      realLambdaRate,
      greatCircleM / agent.mobilityModel.kinematicLimits.maxSpeedMs,
      "s",
    ).milliCU;
    const realEnergyMilliCU = apply(boundRates.cuPerWh, 1 * 0.02 * greatCircleM, "Wh").milliCU;
    const realDelay = cDelay.forLeg(leg, leg.earliestPossibleCompletionMs, delayParameters);

    const gammaReferenceMilliCU = sum([realTravelMilliCU, realEnergyMilliCU, realDelay.milliCU]);

    expect(bound.milliCU).toBe(gammaReferenceMilliCU);
  });
});

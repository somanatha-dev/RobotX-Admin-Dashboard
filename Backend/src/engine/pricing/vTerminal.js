"use strict";

/**
 * `V_avail` and `V_terminal` (§8.3.2) — **Tier 2**, mechanism T2-06, kill switch
 * `opportunity_cost_term`.
 *
 * > Fix an absolute **valuation horizon** `T_H = decision_time + cost.opportunity.value_horizon`.
 * > For an agent standing *available* at position `p` from time `t`, define its
 * > availability value:
 *
 * ```
 * V_avail(p, t) = ∫[ t → T_H ]  λ_zone( zone(p), τ )  dτ           (CU, ≥ 0; zero for t ≥ T_H)
 * ```
 *
 * > The terminal value of a state is that availability value less the CU-denominated costs
 * > the state imposes before the agent can actually be useful:
 *
 * ```
 * V_terminal(p, soc, t) =  V_avail(p, t)
 *                        − expected_charge_access_cost( p, soc, t )
 *                        − soc_deficit_cost( soc )
 * ```
 *
 * ── The one rule this module exists to hold ────────────────────────────────
 * > Every component is already in CU, so **`V_terminal` carries no free weighting
 * > coefficients at all.** This is deliberate. A dimensionless weight multiplying an
 * > already-priced quantity is a second, unexplained exchange rate hidden inside the most
 * > complex term in the model, and it contradicts the unit discipline that §1.3 identifies
 * > as the design's central methodological commitment.
 *
 * > **`V_terminal` has no weighting coefficients** and therefore **no register entries**.
 * > Its three components are each already denominated in CU and are summed directly
 * > (§8.3.2). … removing the weights removes three otherwise-uncalibratable parameters
 * > from the model's hardest-to-calibrate term.
 *
 * `vTerminal()` is therefore literally `a − b − c`, and it takes no configuration object,
 * no weights argument, and no snapshot: there is no parameter through which a coefficient
 * could be introduced. The Phase 8 build gate scans this file and asserts that the
 * function's body contains no multiplication and that the module reads no register entry.
 * A gate that can be satisfied by reading the code is weaker than one satisfied by the
 * shape of the signature, so both are in place.
 *
 * ── The three components, and what each means ──────────────────────────────
 * > The three components mean: ending in a zone with high forecast demand is *valuable*;
 * > ending far from any available charger with a low state of charge is *expensive*;
 * > ending below the operational reserve incurs the cost of the mandatory charge that
 * > follows.
 *
 * The two subtracted costs are computed here from **already-registered** rates —
 * `cost.lambda_time` for the time an agent spends getting to and waiting at a charger, and
 * `cost.energy.cu_per_wh` for the energy the deficit must buy back. Neither introduces a
 * new coefficient; both are the same exchange rates `C_direct` uses, which is what makes
 * "the cost of being badly placed" commensurable with "the cost of doing the work".
 *
 * ── Approximation, stated (§8.3) ───────────────────────────────────────────
 * > `V_avail` is a finite-horizon, single-agent, myopic approximation to a cost-to-go: it
 * > prices the marginal agent against a *forecast* supply curve rather than solving the
 * > full multi-agent dynamic program.
 *
 * Two error sources follow — horizon truncation and supply-response error — and both are
 * measured rather than assumed away. `vAvail()` reports whether the horizon truncated the
 * integral so the first is observable per evaluation.
 *
 * Determinism: the surface is pinned by version, the integral is a finite sum over the
 * surface's own buckets in canonical order, and no clock is read.
 */

/** @structural milliseconds in one second */
const MS_PER_SECOND = 1000;

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * `V_avail(p, t) = ∫[t → T_H] λ_zone(zone(p), τ) dτ`.
 *
 * The surface is piecewise constant over its published buckets, so the integral is an
 * exact finite sum rather than a quadrature — there is no integration-step parameter and
 * no discretisation error, which is what makes two evaluations of the same commitment
 * agree to the last milli-CU on replay.
 *
 * @param {object} input
 * @param {object} input.snapshot the pinned price surface
 * @param {string} input.zoneId
 * @param {number} input.fromMs `t`
 * @param {number} input.horizonEndMs `T_H`
 * @returns {{ ok: boolean, cu: number|null, bucketsUsed: number, coveredToMs: number|null,
 *             truncatedByHorizon: boolean, problems: string[] }}
 */
function vAvail(input) {
  const source = input || {};
  const problems = [];

  if (!source.snapshot || typeof source.snapshot !== "object") problems.push("no pinned price snapshot");
  if (!isNumber(source.fromMs)) problems.push("fromMs");
  if (!isNumber(source.horizonEndMs)) problems.push("horizonEndMs");
  if (source.zoneId === null || source.zoneId === undefined || source.zoneId === "") problems.push("zoneId");
  if (problems.length > 0) {
    return { ok: false, cu: null, bucketsUsed: 0, coveredToMs: null, truncatedByHorizon: false, problems };
  }

  // §8.3.2: zero for t ≥ T_H. Stated as a boundary condition rather than emerging from an
  // empty sum, so the horizon's meaning survives a change to the bucket representation.
  if (source.fromMs >= source.horizonEndMs) {
    return {
      ok: true,
      cu: 0,
      bucketsUsed: 0,
      coveredToMs: source.horizonEndMs,
      truncatedByHorizon: true,
      problems: [],
    };
  }

  const zones = source.snapshot.zones || {};
  const buckets = zones[String(source.zoneId)];
  if (!Array.isArray(buckets) || buckets.length === 0) {
    return {
      ok: false,
      cu: null,
      bucketsUsed: 0,
      coveredToMs: null,
      truncatedByHorizon: false,
      problems: [
        `the pinned price surface (version ${String(source.snapshot.version)}) publishes no λ_zone for ` +
          `zone "${String(source.zoneId)}". A zone with no published price is not a zone worth zero — ` +
          "the Capacity Pricing client pads the surface with the configured prior precisely so that " +
          "this module never has to invent one (§5.2)",
      ],
    };
  }

  let accumulated = 0;
  let used = 0;
  let coveredToMs = null;

  // Canonical order over the surface's own buckets. The sum is over disjoint intervals, so
  // the order does not change the value; it fixes the reported bucket list.
  const ordered = [...buckets].sort((a, b) => a.startMs - b.startMs);

  for (const bucket of ordered) {
    if (!isNumber(bucket.startMs) || !isNumber(bucket.endMs) || !isNumber(bucket.lambdaCuPerSecond)) {
      return {
        ok: false,
        cu: null,
        bucketsUsed: used,
        coveredToMs,
        truncatedByHorizon: false,
        problems: [`zone "${String(source.zoneId)}" publishes a malformed bucket`],
      };
    }
    if (bucket.lambdaCuPerSecond < 0) {
      return {
        ok: false,
        cu: null,
        bucketsUsed: used,
        coveredToMs,
        truncatedByHorizon: false,
        problems: [
          `zone "${String(source.zoneId)}" publishes λ = ${bucket.lambdaCuPerSecond}. §8.3.3 depends on ` +
            "λ_zone ≥ 0 for the unavailability component to be non-negative, which is what keeps " +
            "C_opportunity bounded below by −Ω_terminal alone (§6.4)",
        ],
      };
    }

    const overlapStart = Math.max(bucket.startMs, source.fromMs);
    const overlapEnd = Math.min(bucket.endMs, source.horizonEndMs);
    if (coveredToMs === null && bucket.startMs <= source.fromMs) coveredToMs = bucket.endMs;
    else if (coveredToMs !== null && bucket.startMs <= coveredToMs) coveredToMs = Math.max(coveredToMs, bucket.endMs);

    if (overlapEnd <= overlapStart) continue;
    accumulated += bucket.lambdaCuPerSecond * ((overlapEnd - overlapStart) / MS_PER_SECOND);
    used += 1;
  }

  const requiredToMs = source.horizonEndMs;
  if (coveredToMs === null || coveredToMs < requiredToMs) {
    return {
      ok: false,
      cu: null,
      bucketsUsed: used,
      coveredToMs,
      truncatedByHorizon: false,
      problems: [
        `the price surface covers zone "${String(source.zoneId)}" only to ${String(coveredToMs)}, short of ` +
          `the valuation horizon ${requiredToMs}. An integral truncated by a gap in the surface is not the ` +
          "same quantity as one truncated at T_H, and treating the uncovered tail as zero would understate " +
          "the value of every agent in that zone",
      ],
    };
  }

  return { ok: true, cu: accumulated, bucketsUsed: used, coveredToMs, truncatedByHorizon: false, problems: [] };
}

/**
 * `expected_charge_access_cost(p, soc, t)` — in CU, from already-registered rates.
 *
 * The time to reach the nearest charger available at `t`, plus the projected queue wait,
 * priced at `cost.lambda_time`; plus the energy that approach consumes, priced at
 * `cost.energy.cu_per_wh`. Both rates are the ones `C_direct` uses, so the cost of being
 * badly placed is denominated identically to the cost of doing the work.
 *
 * No coefficient is introduced. The function takes two rates that already exist in the
 * register and one physical quantity each.
 *
 * @param {object} input
 * @param {number} input.travelSeconds to the nearest charger available at `t`
 * @param {number} input.queueWaitSeconds from the pinned charger availability projection
 * @param {number} input.approachEnergyWh
 * @param {object} input.lambdaTime a `makeRate("cost.lambda_time", …)`
 * @param {object} input.cuPerWh a `makeRate("cost.energy.cu_per_wh", …)`
 * @returns {{ ok: boolean, cu: number|null, breakdown: object|null, missing: string[] }}
 */
function chargeAccessCost(input) {
  const source = input || {};
  const missing = [];

  if (!isNumber(source.travelSeconds) || source.travelSeconds < 0) missing.push("travelSeconds");
  if (!isNumber(source.queueWaitSeconds) || source.queueWaitSeconds < 0) missing.push("queueWaitSeconds");
  if (!isNumber(source.approachEnergyWh) || source.approachEnergyWh < 0) missing.push("approachEnergyWh");
  if (!source.lambdaTime || !isNumber(source.lambdaTime.value)) missing.push("cost.lambda_time");
  if (!source.cuPerWh || !isNumber(source.cuPerWh.value)) missing.push("cost.energy.cu_per_wh");
  if (missing.length > 0) return { ok: false, cu: null, breakdown: null, missing };

  const timeCu = (source.travelSeconds + source.queueWaitSeconds) * source.lambdaTime.value;
  const energyCu = source.approachEnergyWh * source.cuPerWh.value;

  return {
    ok: true,
    cu: timeCu + energyCu,
    breakdown: Object.freeze({
      travelSeconds: source.travelSeconds,
      queueWaitSeconds: source.queueWaitSeconds,
      timeCu,
      approachEnergyWh: source.approachEnergyWh,
      energyCu,
    }),
    missing: [],
  };
}

/**
 * `soc_deficit_cost(soc)` — the cost of the mandatory charge that follows a terminal state
 * below the operational reserve.
 *
 * > ending below the operational reserve incurs the cost of the mandatory charge that
 * > follows.
 *
 * Zero at or above the reserve. Below it, the deficit in watt-hours priced at
 * `cost.energy.cu_per_wh` plus the charge duration priced at `cost.lambda_time` — the
 * duration coming from §14.6's nonlinear curve, supplied by the caller, because this
 * module does not decide charge policy and does not choose a target SoC (§14.6).
 *
 * @param {object} input
 * @param {number} input.deficitWh how far below the operational reserve the state ends
 * @param {number} input.chargeSeconds to restore it, from the charge curve
 * @param {object} input.lambdaTime
 * @param {object} input.cuPerWh
 * @returns {{ ok: boolean, cu: number|null, breakdown: object|null, missing: string[] }}
 */
function socDeficitCost(input) {
  const source = input || {};
  const missing = [];

  if (!isNumber(source.deficitWh) || source.deficitWh < 0) missing.push("deficitWh");
  if (!isNumber(source.chargeSeconds) || source.chargeSeconds < 0) missing.push("chargeSeconds");
  if (!source.lambdaTime || !isNumber(source.lambdaTime.value)) missing.push("cost.lambda_time");
  if (!source.cuPerWh || !isNumber(source.cuPerWh.value)) missing.push("cost.energy.cu_per_wh");
  if (missing.length > 0) return { ok: false, cu: null, breakdown: null, missing };

  const energyCu = source.deficitWh * source.cuPerWh.value;
  const timeCu = source.chargeSeconds * source.lambdaTime.value;

  return {
    ok: true,
    cu: energyCu + timeCu,
    breakdown: Object.freeze({
      deficitWh: source.deficitWh,
      energyCu,
      chargeSeconds: source.chargeSeconds,
      timeCu,
    }),
    missing: [],
  };
}

/**
 * `V_terminal(p, soc, t) = V_avail(p, t) − expected_charge_access_cost − soc_deficit_cost`.
 *
 * Three CU quantities, subtracted. **No weights, no configuration, no snapshot.** The
 * signature is the guarantee: there is no argument through which a dimensionless
 * coefficient could reach this expression.
 *
 * @param {{ vAvailCu: number, chargeAccessCu: number, socDeficitCu: number }} input
 * @returns {{ ok: boolean, cu: number|null, components: object|null, missing: string[] }}
 */
function vTerminal(input) {
  const source = input || {};
  const missing = [];

  if (!isNumber(source.vAvailCu)) missing.push("vAvailCu");
  if (!isNumber(source.chargeAccessCu)) missing.push("chargeAccessCu");
  if (!isNumber(source.socDeficitCu)) missing.push("socDeficitCu");
  if (missing.length > 0) return { ok: false, cu: null, components: null, missing };

  return {
    ok: true,
    cu: source.vAvailCu - source.chargeAccessCu - source.socDeficitCu,
    components: Object.freeze({
      vAvailCu: source.vAvailCu,
      chargeAccessCu: source.chargeAccessCu,
      socDeficitCu: source.socDeficitCu,
    }),
    missing: [],
  };
}

/**
 * `Ω_terminal(region, t)` (§6.4) — the maximum achievable terminal-value gain over the
 * search region.
 *
 * ```
 * Ω_terminal = ( max λ_zone(z,·) − min λ_zone(z,·) ) · H_value
 *              + max_charge_access_gain(region)
 *              + max_soc_deficit_gain(class)
 * ```
 *
 * > All three quantities are computed once per round from the same price snapshot the cost
 * > function uses (§8.3), published by the Capacity Pricing Service alongside the price
 * > surface, and recorded in the decision record.
 *
 * Computed here, from the surface, rather than accepted as a number: §6.4's admissibility
 * argument requires `Ω_terminal` to bound the *actual* relocation gain the *same* surface
 * can produce, and a value published independently of the surface could be stale by
 * exactly the amount that makes the bound wrong. Phase 9's `candidates/omega.js` consumes
 * what this produces; it does not recompute it.
 *
 * @param {object} input
 * @param {object} input.snapshot the pinned price surface
 * @param {number} input.valueHorizonSeconds `cost.opportunity.value_horizon`
 * @param {number} input.maxChargeAccessGainCu the largest charge-access cost any state in
 *   the region carries — a gain of that size is achievable by relocating away from it
 * @param {number} input.maxSocDeficitGainCu likewise for the SoC-deficit component
 * @returns {{ ok: boolean, cu: number|null, breakdown: object|null, problems: string[] }}
 */
function omegaTerminal(input) {
  const source = input || {};
  const problems = [];

  if (!source.snapshot || typeof source.snapshot !== "object") problems.push("no pinned price snapshot");
  if (!isNumber(source.valueHorizonSeconds) || source.valueHorizonSeconds <= 0) {
    problems.push("cost.opportunity.value_horizon");
  }
  if (!isNumber(source.maxChargeAccessGainCu) || source.maxChargeAccessGainCu < 0) {
    problems.push("maxChargeAccessGainCu");
  }
  if (!isNumber(source.maxSocDeficitGainCu) || source.maxSocDeficitGainCu < 0) problems.push("maxSocDeficitGainCu");
  if (problems.length > 0) return { ok: false, cu: null, breakdown: null, problems };

  let minLambda = null;
  let maxLambda = null;
  const zones = source.snapshot.zones || {};

  for (const zoneId of Object.keys(zones).sort()) {
    for (const bucket of zones[zoneId] || []) {
      if (!isNumber(bucket.lambdaCuPerSecond)) continue;
      if (minLambda === null || bucket.lambdaCuPerSecond < minLambda) minLambda = bucket.lambdaCuPerSecond;
      if (maxLambda === null || bucket.lambdaCuPerSecond > maxLambda) maxLambda = bucket.lambdaCuPerSecond;
    }
  }

  if (minLambda === null || maxLambda === null) {
    return {
      ok: false,
      cu: null,
      breakdown: null,
      problems: ["the price surface publishes no λ_zone values, so Ω_terminal cannot be derived from it"],
    };
  }

  const spreadCu = (maxLambda - minLambda) * source.valueHorizonSeconds;
  const cu = spreadCu + source.maxChargeAccessGainCu + source.maxSocDeficitGainCu;

  return {
    ok: true,
    cu,
    breakdown: Object.freeze({
      minLambdaCuPerSecond: minLambda,
      maxLambdaCuPerSecond: maxLambda,
      valueHorizonSeconds: source.valueHorizonSeconds,
      spreadCu,
      maxChargeAccessGainCu: source.maxChargeAccessGainCu,
      maxSocDeficitGainCu: source.maxSocDeficitGainCu,
      priceSnapshotVersion: source.snapshot.version ?? null,
    }),
    problems: [],
  };
}

module.exports = {
  MS_PER_SECOND,
  vAvail,
  chargeAccessCost,
  socDeficitCost,
  vTerminal,
  omegaTerminal,
};

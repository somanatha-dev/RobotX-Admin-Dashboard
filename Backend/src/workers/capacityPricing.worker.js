"use strict";

/**
 * The λ_zone estimator refresh (§8.3.1, §5.2, §6.4). **Tier 1** by path.
 *
 * Publishes a new `ZonePriceSnapshot` version from the forecast, with `Ω_terminal` derived
 * from the same surface, and mirrors it into `engine:price:{version}`.
 *
 * ── Why the Tier 2 client is injected rather than imported ─────────────────
 * The estimate itself belongs to `pricing/capacityPricingClient.js`, which §1.8 classifies
 * **Tier 2** (T2-06, kill switch `opportunity_cost_term`). `src/workers/` is Tier 1 by
 * path, so a static `require` of that module would be a §1.8 rule-2 violation and the build
 * gate would fail it. The gate's own documentation names the compliant pattern:
 *
 * > The compliant pattern for a Tier 1 module that wants an optional Tier 2 enhancement is
 * > dependency inversion: the Tier 2 module registers itself with, or **is injected into**,
 * > the Tier 1 module. A Tier 2 mechanism statically linked into the Tier 1 path is a kill
 * > switch that cannot actually be thrown.
 *
 * That is not a technicality here. `refresh()` **checks the kill switch first and refuses
 * to run when it is thrown**, so the injection is a real control rather than a way past the
 * gate: with `opportunity_cost_term` thrown there is no publication, the opportunity term
 * has no evaluator registered with `Φ`, and the round is the five-term Tier 1 functional.
 * The same worker file, injected with nothing, does nothing.
 *
 * ── What it publishes, and why the bound travels with it ───────────────────
 * > `Ω_terminal` … computed once per round from the same price snapshot the cost function
 * > uses (§8.3), **published by the Capacity Pricing Service alongside the price surface**,
 * > and recorded in the decision record.
 *
 * > Static per-zone `lambda_zone_prior` from config; **`Ω_terminal` recomputed from those
 * > static prices, so the bound stays admissible under degradation** (§5.2).
 *
 * The client derives `Ω_terminal` from the surface it is about to publish — live, padded, or
 * wholly prior-driven — and this worker writes the two together in one version. A bound and
 * a surface that could be published separately would eventually be a proof about prices
 * nobody used, which §6.4 identifies as worse than having no bound.
 *
 * ── Insert-only, versioned, never updated ──────────────────────────────────
 * A refresh writes a **new** version. A round pinned the previous one and recorded it, and a
 * surface editable after a round consumed it would make that round unreplayable (§9.6).
 *
 * ── Built, tested, and not started ─────────────────────────────────────────
 * Nothing in `server.js` calls `refresh()`; `ENGINE_ENABLED` is false and Phase 15 owns
 * production scheduling, matching every other worker in this codebase.
 */

const { getPrisma } = require("../db/prisma");

/** Why a refresh did not publish. */
const SKIPPED = Object.freeze({
  KILL_SWITCH: "OPPORTUNITY_COST_TERM_DISABLED",
  NO_CLIENT: "NO_PRICING_CLIENT_INJECTED",
  NO_ZONES: "NO_ZONES_REQUESTED",
});

/**
 * Refresh the λ_zone surface for one region and publish a new version.
 *
 * @param {object} deps
 * @param {object} deps.pricing the Tier 2 `pricing/capacityPricingClient` module, injected
 * @param {object} [deps.forecast] the Tier 2 `pricing/forecastClient` module, injected
 * @param {object} [deps.prisma]
 * @param {object} [deps.kv]
 * @param {object} input
 * @param {boolean} input.opportunityCostTermEnabled the resolved kill-switch state
 * @param {number} input.version the new version to write
 * @param {string[]} input.zoneIds every zone the round may value an agent in
 * @param {Record<string, string>} input.zoneRowIdByZoneId zone id → durable row id
 * @param {number} input.fromMs
 * @param {number} input.horizonEndMs `T_H`
 * @param {number} input.valueHorizonSeconds `cost.opportunity.value_horizon`
 * @param {number} input.decisionTimeMs
 * @param {object} input.forecastSources `{ live, lastGood, seasonalBaseline, maxAgeSeconds }`
 * @param {object|Map} input.config
 * @param {number} input.maxChargeAccessGainCu
 * @param {number} input.maxSocDeficitGainCu
 * @param {number} [input.mirrorTtlSeconds]
 * @param {boolean} [input.persist]
 * @returns {Promise<{ ok: boolean, skipped: string|null, snapshot: object|null,
 *                     omegaTerminalCu: number|null, written: number,
 *                     degradation: object|null, problems: string[] }>}
 */
async function refresh(deps, input) {
  const source = input || {};
  const pricing = deps && deps.pricing;

  // The kill switch is checked before anything else, so a thrown switch produces no
  // publication at all rather than a publication nobody consumes (§22.5 rule 1).
  if (source.opportunityCostTermEnabled !== true) {
    return {
      ok: true,
      skipped: SKIPPED.KILL_SWITCH,
      snapshot: null,
      omegaTerminalCu: null,
      written: 0,
      degradation: null,
      problems: [],
    };
  }
  if (!pricing || typeof pricing.publish !== "function") {
    return {
      ok: false,
      skipped: SKIPPED.NO_CLIENT,
      snapshot: null,
      omegaTerminalCu: null,
      written: 0,
      degradation: null,
      problems: [
        "no Capacity Pricing client was injected. §1.8 rule 2 forbids this Tier 1 worker from importing " +
          "the Tier 2 client statically, so the composition root supplies it — and supplies nothing when " +
          "the opportunity_cost_term switch is thrown",
      ],
    };
  }
  if (!Array.isArray(source.zoneIds) || source.zoneIds.length === 0) {
    return {
      ok: false,
      skipped: SKIPPED.NO_ZONES,
      snapshot: null,
      omegaTerminalCu: null,
      written: 0,
      degradation: null,
      problems: ["no zones were requested; a surface must state which zones it is complete for"],
    };
  }

  // ── Estimator 1: the forecast-driven queueing estimate ────────────────────
  const zones = {};
  const problems = [];
  let estimator = pricing.ESTIMATOR.STATIC_PRIOR;
  let forecastDegradation = null;
  let forecastVersion = null;

  const forecastModule = deps && deps.forecast;
  if (forecastModule && typeof forecastModule.resolve === "function") {
    const resolved = forecastModule.resolve({
      ...(source.forecastSources || {}),
      decisionTimeMs: source.decisionTimeMs,
    });
    forecastDegradation = resolved.degradation;

    if (resolved.forecast) {
      forecastVersion = String(resolved.forecast.version);
      estimator = pricing.ESTIMATOR.FORECAST_QUEUEING;

      for (const zoneId of [...source.zoneIds].map(String).sort()) {
        const zone = resolved.forecast.zones[zoneId];
        if (!zone) continue;
        const estimate = pricing.queueingEstimate({
          arrivalRate: zone.arrivalRate,
          projectedSupply: zone.projectedSupply,
          responseCurve: zone.responseCurve,
        });
        if (!estimate.ok) {
          // Left unpublished rather than defaulted: `publish()` pads an absent zone with
          // the configured prior, which is §5.2's declared degradation, and records that
          // it did. Inventing a number here would hide the padding.
          problems.push(`zone "${zoneId}": ${estimate.reason}`);
          continue;
        }
        if (estimate.reason) problems.push(`zone "${zoneId}": ${estimate.reason}`);
        zones[zoneId] = [
          {
            startMs: source.fromMs,
            endMs: source.horizonEndMs,
            lambdaCuPerSecond: estimate.lambdaCuPerSecond,
          },
        ];
      }
    }
  }

  const published = pricing.publish({
    version: source.version,
    publishedAtMs: source.decisionTimeMs,
    zones,
    requiredZoneIds: source.zoneIds,
    fromMs: source.fromMs,
    horizonEndMs: source.horizonEndMs,
    valueHorizonSeconds: source.valueHorizonSeconds,
    config: source.config,
    estimator,
    maxChargeAccessGainCu: source.maxChargeAccessGainCu,
    maxSocDeficitGainCu: source.maxSocDeficitGainCu,
  });

  if (!published.ok) {
    return {
      ok: false,
      skipped: null,
      snapshot: null,
      omegaTerminalCu: null,
      written: 0,
      degradation: forecastDegradation,
      problems: [...problems, ...published.problems],
    };
  }

  const omegaTerminalCu = published.omegaTerminal.cu;

  if (source.persist !== true) {
    return {
      ok: true,
      skipped: null,
      snapshot: published.snapshot,
      omegaTerminalCu,
      written: 0,
      degradation: forecastDegradation || published.degradation,
      problems,
    };
  }

  const prisma = (deps && deps.prisma) || getPrisma();
  let written = 0;

  for (const zoneId of Object.keys(published.snapshot.zones).sort()) {
    const rowId = (source.zoneRowIdByZoneId || {})[zoneId];
    if (!rowId) {
      problems.push(`zone "${zoneId}" has no durable row id; the surface row cannot be written`);
      continue;
    }
    let bucketIndex = 0;
    for (const bucket of published.snapshot.zones[zoneId]) {
      bucketIndex += 1;
      try {
        await prisma.zonePriceSnapshot.create({
          data: {
            version: source.version,
            zoneId: rowId,
            bucket: `${bucketIndex}`,
            bucketStart: new Date(bucket.startMs),
            bucketEnd: new Date(bucket.endMs),
            lambdaCuPerSecond: bucket.lambdaCuPerSecond,
            // A padded interval is a prior, and §5.2 requires the degradation to be
            // flagged rather than inferred — so the estimator is recorded per row.
            estimator: bucket.padded ? pricing.ESTIMATOR.STATIC_PRIOR : estimator,
            omegaTerminalCu,
            forecastVersion,
            publishedAt: new Date(source.decisionTimeMs),
            publishedBy: "capacityPricing.worker",
          },
        });
        written += 1;
      } catch (error) {
        problems.push(`zone "${zoneId}" bucket ${bucketIndex}: ${error && error.message}`);
      }
    }
  }

  if (deps && deps.kv && typeof pricing.write === "function") {
    await pricing.write(deps, published.snapshot, source.mirrorTtlSeconds);
  }

  return {
    ok: problems.length === 0,
    skipped: null,
    snapshot: published.snapshot,
    omegaTerminalCu,
    written,
    degradation: forecastDegradation || published.degradation,
    problems,
  };
}

module.exports = {
  SKIPPED,
  refresh,
};

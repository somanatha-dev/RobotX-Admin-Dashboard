"use strict";

/**
 * The **D1 / D8 configuration seam**: where a benchmark adapter is told about a deployment that
 * this repository does not own and must not invent.
 *
 * B1 Step 1 — *"deploy each candidate engine against the target region extract, with per-profile
 * contraction hierarchies BUILT"* — is blocked by **D1** (there is no region, no boundary, no
 * extract) and **D3** (the speed model behind a profile's edge costs is a stub). **D8** — extract
 * vintage, refresh cadence, re-contraction window — is unresolved as well. None of those is
 * decided here, defaulted here, or guessed here.
 *
 * So the adapters take everything region-shaped from **one module the operator writes**, named by
 * a single environment variable:
 *
 * ```
 *   ROUTING_B1_DEPLOYMENT=/absolute/path/to/b1Deployment.js
 * ```
 *
 * ```js
 *   module.exports = {
 *     osrm: {
 *       baseUrl: "http://osrm.internal:5000",       // self-hosted; a public host is refused
 *       engineProfile: "foot",                       // D3 — the profile whose hierarchy was built
 *       snapRadiusM: 25,                             // R13 — the bound outside which a point FAILS
 *       matrixTimeoutMs: 150,                        // §5.2's budget; NOT a registered parameter
 *       maxLocationsPerQuery: 100,                   // the deployment's own --max-table-size
 *       profile: { energyWhPerMetre: …, speedMetresPerSecond: … },
 *       travelTimeSpread: { source: "…", model: "PROPORTIONAL", value: … },   // N29
 *       projectCell: (cellId) => ({ lat, lon }),      // N27 — one implementation, all candidates
 *       chargerCatalogue: async ({ destCellId }) => [{ chargerId, lat, lon }],
 *       deployment: { shape: "…", extract: "…", profilesBuilt: "…", hierarchyBuildTime: "…" },
 *     },
 *     valhalla: { … }, graphhopper: { … },
 *   };
 * ```
 *
 * A module is a file rather than a set of environment variables because two of the required
 * seams — `projectCell` and `chargerCatalogue` — are **functions**, and because the region facts
 * belong outside this repository until D1 answers. Nothing in `Backend/` ships such a file, and
 * this module never writes one: with the variable unset, every candidate reports `NOT_DEPLOYED`
 * and the benchmark reports `NOT_MEASURED`, which is the true state of B1 today.
 */

const path = require("path");

/** The one environment variable this layer reads. */
const DEPLOYMENT_ENV = "ROUTING_B1_DEPLOYMENT";

/**
 * Load the operator's deployment module, if one is named.
 *
 * @param {object} [env] defaults to `process.env`
 * @returns {{ ok: boolean, deployment: object|null, reason: string }}
 */
function loadDeployment(env) {
  const source = env || process.env;
  const configured = source[DEPLOYMENT_ENV];
  if (!configured) {
    return {
      ok: false,
      deployment: null,
      reason:
        `${DEPLOYMENT_ENV} is not set. B1 Step 1 has not been performed: no candidate engine is deployed, no region ` +
        "extract exists (D1) and no contraction hierarchy has been built (D1 + D3). Every candidate is therefore " +
        "NOT_DEPLOYED and every benchmark row is NOT_MEASURED — which is not a pass",
    };
  }
  let loaded;
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    loaded = require(path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured));
  } catch (error) {
    return { ok: false, deployment: null, reason: `${DEPLOYMENT_ENV}="${configured}" could not be loaded: ${error.message}` };
  }
  if (!loaded || typeof loaded !== "object") {
    return { ok: false, deployment: null, reason: `${DEPLOYMENT_ENV}="${configured}" did not export an object keyed by candidate id` };
  }
  return { ok: true, deployment: loaded, reason: "" };
}

/**
 * The configuration for one candidate, or the reason there is none.
 *
 * @param {string} candidateId
 * @param {object} [env]
 * @returns {{ ok: boolean, config: object|null, reason: string }}
 */
function configFor(candidateId, env) {
  const { ok, deployment, reason } = loadDeployment(env);
  if (!ok) return { ok: false, config: null, reason };
  const config = deployment[candidateId];
  if (!config || typeof config !== "object") {
    return { ok: false, config: null, reason: `the deployment module names no configuration for candidate "${candidateId}"` };
  }
  return { ok: true, config, reason: "" };
}

/**
 * Materialise one candidate's module export: a working adapter, or an honest refusal.
 *
 * This is what lets `npm run routing:b1 -- --engine ./tools/routing/adapters/osrm.js` work
 * against the tool's existing `--engine <module>` seam without the module pretending to be an
 * engine it has not been given. With no deployment configured the result carries **no `matrix`
 * function at all**, so the tool's existing adapter check refuses it, and `availability` tells
 * the reader which of the four reasons it was.
 *
 * @param {string} candidateId
 * @param {(config: object) => object} create the candidate's factory
 * @param {object} contract the shared adapter contract module
 * @param {object} [env]
 * @returns {object} an adapter, or an `unavailable` descriptor
 */
function materialise(candidateId, create, contract, env) {
  const { ok, config, reason } = configFor(candidateId, env);
  if (!ok) return contract.unavailable(candidateId, contract.AVAILABILITY.NOT_DEPLOYED, reason);
  try {
    return create(config);
  } catch (error) {
    // A configuration this adapter cannot use is reported, never worked around. Substituting a
    // default for a missing snap radius, timeout or spread source would be the adapter deciding
    // something §32.5 assigns to the operator, the register or an open decision.
    return contract.unavailable(candidateId, contract.AVAILABILITY.MISCONFIGURED, error.message);
  }
}

module.exports = { DEPLOYMENT_ENV, loadDeployment, configFor, materialise };

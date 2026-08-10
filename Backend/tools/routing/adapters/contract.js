"use strict";

/**
 * B1 **benchmark** adapter layer — the engine-neutral part.
 *
 * ── What this is, and the two things it is not ─────────────────────────────
 * This module holds everything the four candidate benchmark adapters share:
 * configuration validation, request validation, output normalisation, the status
 * discriminator, the timeout, and the availability discriminator. It is
 * **B1 Step 2** work — `ADR-33`'s consequences clause, *"one executable benchmark adapter
 * per candidate to the contract at `b1Benchmark.js:84–98`, hardened per §32.5 of the Phase 15
 * consolidated report."*
 *
 * It is **not** `src/engine/routing/client.js` — the production Routing Service client, which
 * is **Phase 8**'s, is blocked by N25/N26 as well as by B1, and owns §5.2's degradation ladder
 * and §18.3 B6's uniform-treatment rule. Nothing here walks a ladder; an adapter reports what
 * happened and stops.
 *
 * It is **not** a routing engine. No adapter in this directory fabricates a distance, a
 * duration, a road network, a region, an extract or a charger. Every one of those arrives
 * through an explicit configuration seam supplied by whoever performs **Step 1**, and an
 * adapter that has not been given one refuses to answer rather than inventing it.
 *
 * ── The three seams, and which external decision each one is waiting for ───
 *
 *   `projectCell`       `cellId → { lat, lon }`. **N27** is undecided — §32.5 recommends the
 *                       projection live in the Phase 8 client rather than in each adapter, and
 *                       records that moving it *"changes `b1Benchmark.js`'s header contract and
 *                       is therefore a Phase 8 change, not a Step 2 change."* So A1 stands as
 *                       written (cell in, cell out) and the projection is **injected**: one
 *                       implementation, supplied once, shared by all four candidates, and
 *                       relocatable to the client without touching an adapter.
 *
 *   `chargerCatalogue`  A routing engine does not know where chargers are. §20.3 item 3's
 *                       return-leg population needs candidate charger locations from the map /
 *                       Charging Scheduler side (ADR-21's pinned availability projection), so
 *                       the catalogue is injected and no adapter ships one.
 *
 *   `deployment`        Extract identity and vintage, profiles built, hierarchy build time.
 *                       **D1** owns the extract and **D8** owns vintage, refresh cadence and
 *                       the re-contraction window; both are unresolved. These are carried as
 *                       opaque operator-supplied strings, reported in `description` because
 *                       `b1Benchmark.js:89–90` requires it, and **chosen here never**.
 *
 * ── N29, and why no adapter defaults a spread ──────────────────────────────
 * `cellPairCache.buildEntry` requires a finite non-negative `travelSdSeconds`; §8.4 prices
 * `p_late` *"from the ETA predictive distribution, not the point estimate"*. **None of the
 * shortlisted engines returns a spread** — OSRM's `table`, Valhalla's `sources_to_targets` and
 * GraphHopper's `route` all return a point estimate. N29 records that turning that silence into
 * `0` asserts *"this ETA is certain"*, in the optimistic direction. So `travelTimeSpread` is
 * **required configuration with a named source**, and an adapter constructed without one does
 * not start.
 *
 * ── Determinism (R10, §9.6) ───────────────────────────────────────────────
 * Nothing here reads a clock, samples, or iterates an unordered collection. Destination order
 * is the caller's, de-duplicated first-seen; charger order is a total order with an id
 * tie-break. Whether the *engine* is deterministic is R10, and it is Step 3's to measure.
 */

const { compareStrings } = require("../../../src/engine/determinism/ordering");

/**
 * What happened to one requested origin→destination pair, or to one query.
 *
 * §32.5 records that the shipped contract *"cannot distinguish six conditions that must be
 * distinguished, because an omitted matrix entry and a thrown error are the only two signals it
 * has"*, and that §18.3 B6's uniform-treatment rule — *"if any candidate's route is unavailable,
 * all candidates in that decision use the degraded estimator"* — makes the distinction
 * load-bearing, because it exists to stop a candidate scoring best on missing data.
 *
 * This is the adapter layer's discriminator. It is **additive**: `b1Benchmark.js` reads
 * `destCellId`, `distanceM`, `travelSeconds` and `travelSdSeconds`, so a non-`OK` entry is
 * carried through it and correctly refused by `buildEntry` rather than cached. Landing the
 * discriminator into the A1 header contract itself is a **Phase 8** change (§32.11) and is not
 * made here — this layer proves it out without moving the contract other documents cite.
 *
 * @structural §32.5's six failure conditions, plus success
 */
const ROUTE_STATUS = Object.freeze({
  /** A route was found; physics fields are present and finite. */
  OK: "OK",
  /** Genuinely unreachable under this profile. Returned explicitly, never omitted. */
  NO_ROUTE: "NO_ROUTE",
  /** A location lies outside the cut extract, or outside the bounded snap radius (R13). */
  EXTRACT_MISS: "EXTRACT_MISS",
  /** The configured hard budget elapsed and the request was aborted. */
  TIMEOUT: "TIMEOUT",
  /** The engine answered, but not in a shape this adapter can read. */
  MALFORMED_RESPONSE: "MALFORMED_RESPONSE",
  /** The request was refused before the engine was called. */
  MALFORMED_REQUEST: "MALFORMED_REQUEST",
  /** The engine is unreachable, or failed internally. Distinct from NO_ROUTE. */
  ENGINE_FAILURE: "ENGINE_FAILURE",
});

/**
 * Whether a candidate can be measured at all.
 *
 * B1 Step 1 — deploy each candidate against the target region extract with per-profile
 * contraction hierarchies **built** — is blocked by **D1** and **D3**. Until it is done, every
 * adapter is `NOT_DEPLOYED`, and the honest report of an undeployed candidate is
 * `NOT_MEASURED` on every row. `b1Benchmark.js` reads this so that an unconfigured candidate
 * cannot be mistaken for a fast one.
 *
 * @structural why a candidate cannot be measured
 */
const AVAILABILITY = Object.freeze({
  /** Configured against a real deployment; the benchmark may time it. */
  AVAILABLE: "AVAILABLE",
  /** The adapter exists and is complete; no deployment has been configured for it. */
  NOT_DEPLOYED: "NOT_DEPLOYED",
  /** No implementation of this candidate exists to adapt to. */
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
  /** A deployment was configured and the configuration is not usable. */
  MISCONFIGURED: "MISCONFIGURED",
});

/** The §27 item 2 shortlist, verbatim and in the order both frozen documents state it. */
const CANDIDATE_IDS = Object.freeze(["osrm", "valhalla", "graphhopper", "inhouse"]);

/**
 * An adapter-level failure carrying the discriminator. Thrown rather than returned when the
 * whole query failed, so that no destination in it can be read as reachable or unreachable.
 */
class AdapterError extends Error {
  /**
   * @param {string} engineId
   * @param {string} status one of `ROUTE_STATUS`
   * @param {string} reason
   * @param {object} [detail]
   */
  constructor(engineId, status, reason, detail) {
    super(`${engineId}: ${reason}`);
    this.name = "AdapterError";
    this.engineId = engineId;
    this.status = status;
    this.reason = reason;
    this.detail = detail || null;
  }
}

/**
 * Hosts that would make a measurement evidence about somebody else's cluster.
 *
 * §5.2 and **ADR-11** make self-hosting non-negotiable — ADR-11's rejected option is *"metered
 * external API in the hot path"* — and §20.3 item 5 gives the reason a hosted service cannot
 * satisfy: *"the precomputation is the optimisation, and a metered request-per-query API cannot
 * provide it."* R1 is the one requirement in §32.4 marked *non-negotiable*, so it is enforced
 * in code rather than in a comment.
 */
const HOSTED_HOSTS = Object.freeze([
  "router.project-osrm.org",
  "routing.openstreetmap.de",
  "valhalla1.openstreetmap.de",
  "valhalla.mapzen.com",
  "graphhopper.com",
  "api.mapbox.com",
]);

/**
 * Strings that are a note to oneself rather than a value. Compared lower-cased and with
 * trailing punctuation stripped, so "TBD." and "tbd" are the same non-answer.
 *
 * The list is deliberately narrow: only tokens that cannot be a truthful answer to any of the
 * four fields. "none" and "not built" are **not** here, because for `profilesBuilt` and
 * `hierarchyBuildTime` they are exactly the honest answer for a candidate Step 1 has not
 * deployed — and a check that refused an honest negative would push operators toward writing
 * something that reads better instead.
 * @structural placeholder tokens, not a tunable list
 */
const PLACEHOLDER_TOKENS = new Set(["tbd", "tba", "todo", "n/a", "unknown", "unspecified", "pending", "?", "-", "--", "xxx", "fixme", "placeholder"]);

/** @param {unknown} value @returns {boolean} */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** @param {unknown} value @returns {boolean} */
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * Reject a base URL that is absent, unparseable, or a public hosted service.
 *
 * @param {string} engineId
 * @param {unknown} baseUrl
 * @returns {string} the normalised base, without a trailing slash
 * @throws {AdapterError} MALFORMED_REQUEST
 */
function assertSelfHosted(engineId, baseUrl) {
  if (!isNonEmptyString(baseUrl)) {
    throw new AdapterError(engineId, ROUTE_STATUS.MALFORMED_REQUEST, "baseUrl is required — B1 requires a self-hosted deployment (§5.2, ADR-11, R1)");
  }
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new AdapterError(engineId, ROUTE_STATUS.MALFORMED_REQUEST, `baseUrl "${baseUrl}" is not a URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AdapterError(engineId, ROUTE_STATUS.MALFORMED_REQUEST, `baseUrl "${baseUrl}" must be http or https`);
  }
  const host = parsed.hostname.toLowerCase();
  if (HOSTED_HOSTS.some((hosted) => host === hosted || host.endsWith(`.${hosted}`))) {
    throw new AdapterError(
      engineId,
      ROUTE_STATUS.MALFORMED_REQUEST,
      `baseUrl "${baseUrl}" is a public hosted routing service. B1 procures a SELF-HOSTED engine ` +
        "(§5.2, ADR-11 rejected 'metered external API in the hot path', §32.4 R1) and a measurement " +
        "against a hosted host is evidence about somebody else's cluster, not about this candidate",
    );
  }
  return baseUrl.replace(/\/+$/u, "");
}

/**
 * Validate the configuration every candidate adapter needs, and normalise it.
 *
 * Nothing is defaulted that would amount to a choice. `chargerTimeoutMs` falls back to the
 * operator's own `matrixTimeoutMs` — reusing a supplied number, not inventing one — and that is
 * the only fallback in this function.
 *
 * §5.2's two hard budgets (150 ms matrix, 400 ms path) are **not** registered parameters:
 * §32.5's failure table records `route.matrix_timeout` and `route.path_timeout` as
 * *"unregistered (§6)"*. Registering them is §22.1 governance work and is not Step 2's, so the
 * budget arrives through configuration and no adapter states one.
 *
 * @param {string} engineId
 * @param {object} config
 * @param {{ requiresSnapRadius?: boolean }} [options]
 * @returns {object} the normalised configuration
 * @throws {AdapterError} MALFORMED_REQUEST listing every problem at once
 */
function normaliseConfig(engineId, config, options) {
  const settings = options || {};
  const source = config || {};
  const problems = [];

  let baseUrl = null;
  try {
    baseUrl = assertSelfHosted(engineId, source.baseUrl);
  } catch (error) {
    problems.push(error.reason);
  }

  if (!isNonEmptyString(source.engineProfile)) {
    problems.push(
      "engineProfile is required — the engine-side profile/costing name whose contraction hierarchy was built. " +
        "It is D3's (the fleet's mobility models and their speed models) and is never chosen here",
    );
  }
  if (typeof source.projectCell !== "function") {
    problems.push(
      "projectCell(cellId) -> { lat, lon } is required. No routing engine accepts a cell token (N27), and no " +
        "adapter invents a coordinate: the projection is supplied once and shared by every candidate",
    );
  }
  if (typeof source.chargerCatalogue !== "function") {
    problems.push(
      "chargerCatalogue({ destCellId, profileKey, timeBucket }) -> [{ chargerId, lat, lon }] is required. " +
        "A routing engine does not know where chargers are; §20.3 item 3's population is supplied, never fabricated",
    );
  }
  if (!isFiniteNumber(source.matrixTimeoutMs) || source.matrixTimeoutMs <= 0) {
    problems.push(
      "matrixTimeoutMs is required and must be a positive number of milliseconds. §5.2 states 150 ms for the " +
        "matrix query and 400 ms for the path query; neither is a registered parameter (§32.5, §6), so the budget " +
        "is supplied by configuration and this adapter states none",
    );
  }
  if (settings.requiresSnapRadius && (!isFiniteNumber(source.snapRadiusM) || source.snapRadiusM <= 0)) {
    problems.push(
      "snapRadiusM is required and must be positive. R13: a point outside the extract must FAIL, not silently " +
        "snap to the nearest edge — a plausible wrong answer is the failure class `assertVersionInKey` exists to prevent",
    );
  }

  const spread = normaliseSpread(source.travelTimeSpread, problems);
  const profile = normaliseVehicleProfile(source.profile, problems);
  const deployment = normaliseDeployment(source.deployment, problems);

  if (problems.length > 0) {
    throw new AdapterError(engineId, ROUTE_STATUS.MALFORMED_REQUEST, `invalid configuration:\n  - ${problems.join("\n  - ")}`, { problems });
  }

  return Object.freeze({
    baseUrl,
    engineProfile: source.engineProfile,
    projectCell: source.projectCell,
    chargerCatalogue: source.chargerCatalogue,
    matrixTimeoutMs: source.matrixTimeoutMs,
    chargerTimeoutMs: isFiniteNumber(source.chargerTimeoutMs) && source.chargerTimeoutMs > 0 ? source.chargerTimeoutMs : source.matrixTimeoutMs,
    snapRadiusM: isFiniteNumber(source.snapRadiusM) ? source.snapRadiusM : null,
    travelTimeSpread: spread,
    profile,
    deployment,
    transport: typeof source.transport === "function" ? source.transport : null,
  });
}

/**
 * The **named** source of `travelSdSeconds` (N29).
 *
 * @param {unknown} declared
 * @param {string[]} problems collected, so one throw reports every configuration defect
 * @returns {object|null}
 */
function normaliseSpread(declared, problems) {
  if (!declared || typeof declared !== "object") {
    problems.push(
      "travelTimeSpread is required. No shortlisted engine returns a travel-time spread, and §8.4 prices p_late " +
        "from the ETA predictive distribution rather than the point estimate. N29: defaulting the spread to 0 " +
        "asserts 'this ETA is certain', which is the optimistic direction — so the source must be named",
    );
    return null;
  }
  if (!isNonEmptyString(declared.source)) {
    problems.push("travelTimeSpread.source is required — a free-text name of where the spread comes from (N29, §32.4 R7)");
  }
  if (declared.model !== "PROPORTIONAL" && declared.model !== "ABSOLUTE_SECONDS") {
    problems.push('travelTimeSpread.model must be "PROPORTIONAL" (a fraction of travelSeconds) or "ABSOLUTE_SECONDS"');
  }
  if (!isFiniteNumber(declared.value) || declared.value < 0) {
    problems.push("travelTimeSpread.value must be a finite non-negative number");
  }
  if (problems.length > 0) return null;
  return Object.freeze({ source: declared.source, model: declared.model, value: declared.value });
}

/**
 * The vehicle the candidate is routing, not the engine's configuration.
 *
 * `b1Benchmark.js:632–636` keeps these deliberately off the parameter register: *"they describe
 * the vehicle the candidate engine is routing, and a benchmark that resolved them from the
 * engine's config would be measuring the config."* The tool falls back to `0.05` and `5` when an
 * adapter declares none; an adapter that is being measured should declare its own, so this is
 * required rather than defaulted here.
 *
 * @param {unknown} declared
 * @param {string[]} problems
 * @returns {object|null}
 */
function normaliseVehicleProfile(declared, problems) {
  if (!declared || typeof declared !== "object") {
    problems.push("profile { energyWhPerMetre, speedMetresPerSecond } is required — the mobility profile the engine is routing (b1Benchmark.js:632–636)");
    return null;
  }
  if (!isFiniteNumber(declared.energyWhPerMetre) || declared.energyWhPerMetre <= 0) problems.push("profile.energyWhPerMetre must be a positive number");
  if (!isFiniteNumber(declared.speedMetresPerSecond) || declared.speedMetresPerSecond <= 0) problems.push("profile.speedMetresPerSecond must be a positive number");
  if (problems.length > 0) return null;
  return Object.freeze({ energyWhPerMetre: declared.energyWhPerMetre, speedMetresPerSecond: declared.speedMetresPerSecond });
}

/**
 * The operational facts B1 Step 4 records, carried opaquely.
 *
 * `b1Benchmark.js:89–90` requires `description` to state *"deployment shape, extract, profiles,
 * hierarchy build time"*, and `:590–591` requires Step 4 to record the hierarchy build time and
 * the extract refresh cadence because *"they do not appear in §20.1 and they are operational
 * costs the decision must carry"*. **D1** owns the extract and **D8** owns vintage, refresh
 * cadence and re-contraction window; both are open, so every field here is a string the operator
 * supplies and none is chosen, defaulted or validated for content.
 *
 * @param {unknown} declared
 * @param {string[]} problems
 * @returns {object|null}
 */
function normaliseDeployment(declared, problems) {
  if (!declared || typeof declared !== "object") {
    problems.push(
      "deployment { shape, extract, profilesBuilt, hierarchyBuildTime } is required — b1Benchmark.js:89–90 requires " +
        "the description to state them, and Step 4 records them as operational costs (b1Benchmark.js:590–591). " +
        "The extract is D1's and its vintage/refresh cadence is D8's: both are carried verbatim, never chosen here",
    );
    return null;
  }
  for (const field of ["shape", "extract", "profilesBuilt", "hierarchyBuildTime"]) {
    if (!isNonEmptyString(declared[field])) {
      problems.push(`deployment.${field} is required (a string the operator supplies; this adapter chooses none)`);
      continue;
    }
    // PHASE 15 — a placeholder is not an answer. The four fields are carried opaquely
    // *because* D1 owns the extract and D8 owns its vintage, and the point of carrying them is
    // that Step 4 records real operational costs against a real extract. "TBD" satisfies "a
    // non-empty string" and satisfies nothing else: it would reach `description`, reach the
    // Step 5 record, and read there as though somebody had answered. Refusing it invents no
    // value — it declines to accept a non-answer as one.
    if (PLACEHOLDER_TOKENS.has(declared[field].trim().toLowerCase().replace(/[.\s]+$/u, ""))) {
      problems.push(
        `deployment.${field} is "${declared[field]}", which is a placeholder rather than a value. This field is ` +
          "carried verbatim into the adapter's description and into B1 Step 4's operational record; a placeholder " +
          "there is indistinguishable from an answer. The extract is D1's and its vintage/refresh cadence is D8's — " +
          "both are open, and an adapter is not the place either is settled",
      );
    }
  }
  if (problems.length > 0) return null;
  return Object.freeze({
    shape: declared.shape,
    extract: declared.extract,
    profilesBuilt: declared.profilesBuilt,
    hierarchyBuildTime: declared.hierarchyBuildTime,
  });
}

/**
 * The `description` string the A1 contract requires, assembled from the operator's own words.
 *
 * @param {object} config normalised
 * @param {string} engineNote what this adapter does with the engine's API
 * @returns {string}
 */
function describeDeployment(config, engineNote) {
  return (
    `${config.deployment.shape}; extract ${config.deployment.extract}; ` +
    `profiles ${config.deployment.profilesBuilt}; hierarchy build ${config.deployment.hierarchyBuildTime}; ` +
    `${engineNote}; travelSdSeconds from ${config.travelTimeSpread.source}`
  );
}

/**
 * Validate a `matrix()` request and normalise its destinations.
 *
 * Rejected **before** the engine is called, per §32.5's *"Malformed request — reject before
 * querying; never substitute a default"*. De-duplication is first-seen so the answer order is
 * the caller's own and identical across runs (R10).
 *
 * @param {string} engineId
 * @param {object} request
 * @returns {{ originCellId: string, destCellIds: string[], profileKey: string, timeBucket: * }}
 * @throws {AdapterError} MALFORMED_REQUEST
 */
function normaliseMatrixRequest(engineId, request) {
  const source = request || {};
  const problems = [];

  if (!isNonEmptyString(source.originCellId)) problems.push("originCellId must be a non-empty cell token");
  if (!Array.isArray(source.destCellIds) || source.destCellIds.length === 0) problems.push("destCellIds must be a non-empty array of cell tokens");
  else if (!source.destCellIds.every(isNonEmptyString)) problems.push("every destCellId must be a non-empty cell token");
  if (!isNonEmptyString(source.profileKey)) {
    problems.push(
      "profileKey must be a non-empty string — mobilityModel.routingProfileKey(model, { loaded }). ADR-33 rider 2: " +
        "the caller MUST have called validateModel() first, because routingProfileKey() is total and yields " +
        "unknown:unknown:* for a broken model, so two differently-broken models would share cache entries",
    );
  }
  // §9.6 item 4: the bucket is the caller's, from the round's pinned decision time. An adapter
  // that derived one would be reading a clock, which §32.5 forbids outright. N28 records that
  // nothing in src/ produces one yet — that producer is the absent composition root's, not this
  // adapter's, and the requirement here is only that the caller supplied *something*.
  if (source.timeBucket === undefined || source.timeBucket === null) problems.push("timeBucket must be supplied by the caller (§9.6 item 4) — an adapter never reads a clock");

  if (problems.length > 0) throw new AdapterError(engineId, ROUTE_STATUS.MALFORMED_REQUEST, `invalid matrix request:\n  - ${problems.join("\n  - ")}`, { problems });

  const seen = new Set();
  const destCellIds = [];
  for (const destCellId of source.destCellIds) {
    if (seen.has(destCellId)) continue;
    seen.add(destCellId);
    destCellIds.push(destCellId);
  }

  return { originCellId: source.originCellId, destCellIds, profileKey: source.profileKey, timeBucket: source.timeBucket };
}

/**
 * Validate a `nearestChargers()` request.
 *
 * @param {string} engineId
 * @param {object} request
 * @returns {{ destCellId: string, profileKey: string, timeBucket: *, k: number }}
 * @throws {AdapterError} MALFORMED_REQUEST
 */
function normaliseChargerRequest(engineId, request) {
  const source = request || {};
  const problems = [];

  if (!isNonEmptyString(source.destCellId)) problems.push("destCellId must be a non-empty cell token");
  if (!isNonEmptyString(source.profileKey)) problems.push("profileKey must be a non-empty string (ADR-33 rider 2: validate the model before you key)");
  if (source.timeBucket === undefined || source.timeBucket === null) problems.push("timeBucket must be supplied by the caller (§9.6 item 4)");
  // `route.charger_reachability_k` is resolved from the register by the caller and passed in.
  // An adapter that defaulted it would be stating a registered parameter's value.
  if (!Number.isInteger(source.k) || source.k < 1) problems.push("k must be a positive integer — route.charger_reachability_k, resolved from the register by the caller");

  if (problems.length > 0) throw new AdapterError(engineId, ROUTE_STATUS.MALFORMED_REQUEST, `invalid nearestChargers request:\n  - ${problems.join("\n  - ")}`, { problems });

  return { destCellId: source.destCellId, profileKey: source.profileKey, timeBucket: source.timeBucket, k: source.k };
}

/**
 * Project one cell token to a coordinate through the injected seam, classifying its failure.
 *
 * @param {string} engineId
 * @param {object} config normalised
 * @param {string} cellId
 * @returns {{ lat: number, lon: number }}
 * @throws {AdapterError} MALFORMED_REQUEST
 */
function project(engineId, config, cellId) {
  let point;
  try {
    point = config.projectCell(cellId);
  } catch (error) {
    throw new AdapterError(engineId, ROUTE_STATUS.MALFORMED_REQUEST, `projectCell("${cellId}") failed: ${error.message}`);
  }
  if (!point || !isFiniteNumber(point.lat) || !isFiniteNumber(point.lon)) {
    throw new AdapterError(engineId, ROUTE_STATUS.MALFORMED_REQUEST, `projectCell("${cellId}") did not return a { lat, lon } pair`);
  }
  if (point.lat < -90 || point.lat > 90 || point.lon < -180 || point.lon > 180) {
    throw new AdapterError(engineId, ROUTE_STATUS.MALFORMED_REQUEST, `projectCell("${cellId}") returned an out-of-range coordinate`);
  }
  return { lat: point.lat, lon: point.lon };
}

/**
 * Compute `travelSdSeconds` from the configured, **named** source (N29).
 *
 * @param {object} config normalised
 * @param {number} travelSeconds
 * @returns {number}
 */
function spreadSeconds(config, travelSeconds) {
  const spread = config.travelTimeSpread;
  const value = spread.model === "PROPORTIONAL" ? travelSeconds * spread.value : spread.value;
  return value < 0 ? 0 : value;
}

/**
 * One successful matrix answer, validated to the units both caches enforce.
 *
 * `cellPairCache.buildEntry` refuses a non-finite or negative value in any of the three fields,
 * so a normalisation that let one through would produce an entry that is silently never cached.
 *
 * @param {string} engineId
 * @param {object} config normalised
 * @param {{ destCellId: string, distanceM: number, travelSeconds: number }} answer
 * @returns {object} frozen
 * @throws {AdapterError} MALFORMED_RESPONSE
 */
function okAnswer(engineId, config, answer) {
  if (!isFiniteNumber(answer.distanceM) || answer.distanceM < 0) {
    throw new AdapterError(engineId, ROUTE_STATUS.MALFORMED_RESPONSE, `distance for ${answer.destCellId} is not a finite non-negative number of metres`);
  }
  if (!isFiniteNumber(answer.travelSeconds) || answer.travelSeconds < 0) {
    throw new AdapterError(engineId, ROUTE_STATUS.MALFORMED_RESPONSE, `duration for ${answer.destCellId} is not a finite non-negative number of seconds`);
  }
  return Object.freeze({
    destCellId: answer.destCellId,
    status: ROUTE_STATUS.OK,
    distanceM: answer.distanceM,
    travelSeconds: answer.travelSeconds,
    travelSdSeconds: spreadSeconds(config, answer.travelSeconds),
  });
}

/**
 * One unsuccessful matrix answer, returned rather than omitted.
 *
 * §32.5: *"Return the destination with an explicit no-route status. **Never omit silently,
 * never fabricate a distance**."* The physics fields are `null` — not `0`, not a straight-line
 * estimate — so `cellPairCache.buildEntry` refuses the entry and nothing downstream can read a
 * fabricated distance. Reconstructing one is the §5.2 degradation ladder's job, and the ladder
 * is the Phase 8 client's.
 *
 * @param {string} destCellId
 * @param {string} status one of `ROUTE_STATUS`
 * @param {string} reason
 * @returns {object} frozen
 */
function failedAnswer(destCellId, status, reason) {
  return Object.freeze({ destCellId, status, distanceM: null, travelSeconds: null, travelSdSeconds: null, reason });
}

/**
 * Nearest-`k` ordering, total and id-tie-broken.
 *
 * The same order `chargerReachabilityCache.buildEntry` applies (`distanceM`, then `chargerId`),
 * with `travelSeconds` between them: two chargers at an identical distance on different profiles
 * are not interchangeable, and a tie broken by array position would make the answer depend on
 * the catalogue's iteration order.
 *
 * @param {object[]} chargers
 * @param {number} k
 * @returns {object[]} frozen
 */
function nearestK(chargers, k) {
  const reachable = chargers.filter((charger) => charger.status === ROUTE_STATUS.OK);
  // The tie-break is `determinism/ordering.compareStrings`, not `localeCompare`. That module's
  // header states the reason and this file's header claims the property: "`localeCompare`
  // depends on the host's ICU data and collation locale, so the same two ids can order
  // differently on two hosts. A total order whose result depends on where it ran is not a
  // total order for replay purposes." Two chargers at an identical distance and duration is
  // not a hypothetical — a catalogue seeded from a grid produces them — and an order that
  // differed between the build machine and the shard would be a §9.6 replay defect that only
  // ever showed up as an inexplicable diff.
  reachable.sort((a, b) => a.distanceM - b.distanceM || a.travelSeconds - b.travelSeconds || compareStrings(a.chargerId, b.chargerId));
  return Object.freeze(reachable.slice(0, k));
}

/**
 * Read the injected charger catalogue for one destination cell.
 *
 * @param {string} engineId
 * @param {object} config normalised
 * @param {object} request normalised
 * @returns {Promise<object[]>}
 * @throws {AdapterError}
 */
async function catalogueFor(engineId, config, request) {
  let chargers;
  try {
    chargers = await config.chargerCatalogue({ destCellId: request.destCellId, profileKey: request.profileKey, timeBucket: request.timeBucket });
  } catch (error) {
    throw new AdapterError(engineId, ROUTE_STATUS.ENGINE_FAILURE, `chargerCatalogue failed: ${error.message}`);
  }
  if (!Array.isArray(chargers)) {
    throw new AdapterError(engineId, ROUTE_STATUS.MALFORMED_RESPONSE, "chargerCatalogue did not return an array");
  }
  for (const charger of chargers) {
    if (!charger || !isNonEmptyString(charger.chargerId) || !isFiniteNumber(charger.lat) || !isFiniteNumber(charger.lon)) {
      throw new AdapterError(engineId, ROUTE_STATUS.MALFORMED_RESPONSE, "chargerCatalogue returned an entry without { chargerId, lat, lon }");
    }
  }
  return chargers;
}

/**
 * Split a destination list so no single matrix query exceeds the deployment's own location cap.
 *
 * Not a convenience. Every shortlisted matrix API is capped — OSRM's `--max-table-size` defaults
 * to 100 **locations**, Valhalla's `max_matrix_locations` is configured per costing — and §20.1's
 * own workload puts 100 destination cells plus an origin in a single cluster. An adapter that
 * could not split would report a candidate's matrix row as a refused request rather than as a
 * measurement, which is the benchmark answering a question about its own request size.
 *
 * Chunks are sequential and index-ordered, so the assembled answer is identical on every run
 * (R10) and the caller's destination order is preserved.
 *
 * @param {*[]} destinations
 * @param {number|null} maxLocationsPerQuery counting the shared origin
 * @returns {*[][]}
 */
function chunkDestinations(destinations, maxLocationsPerQuery) {
  if (!maxLocationsPerQuery || maxLocationsPerQuery >= destinations.length + 1) return [destinations];
  const perChunk = Math.max(1, maxLocationsPerQuery - 1);
  const chunks = [];
  for (let index = 0; index < destinations.length; index += perChunk) chunks.push(destinations.slice(index, index + perChunk));
  return chunks;
}

/**
 * Read an optional positive-integer deployment limit, or `null` for "unset".
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function optionalLocationCap(value) {
  return Number.isInteger(value) && value > 1 ? value : null;
}

/**
 * A candidate that cannot be measured, in the shape `b1Benchmark.js` can report honestly.
 *
 * It exports **no** `matrix`, so the tool's existing adapter check refuses it, and it carries
 * `availability` so the tool can say *why* rather than only that something was wrong.
 *
 * @param {string} id
 * @param {string} status one of `AVAILABILITY`
 * @param {string} reason
 * @returns {object} frozen
 */
function unavailable(id, status, reason) {
  return Object.freeze({
    id,
    description: `${status} — ${reason}`,
    availability: Object.freeze({ status, reason }),
  });
}

/**
 * Run one engine call under a hard budget, aborting rather than waiting.
 *
 * §5.2 gives the matrix query a hard timeout, and the reason it must be *hard* is §18.3 B6: a
 * late answer that still arrives is a candidate scored on data another candidate did not get.
 *
 * @param {string} engineId
 * @param {number} timeoutMs
 * @param {string} what
 * @param {(signal: AbortSignal) => Promise<*>} run
 * @returns {Promise<*>}
 * @throws {AdapterError} TIMEOUT
 */
async function withTimeout(engineId, timeoutMs, what, run) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // The timer must not hold a CLI process open past its own work.
  if (typeof timer.unref === "function") timer.unref();

  try {
    return await run(controller.signal);
  } catch (error) {
    if (timedOut) throw new AdapterError(engineId, ROUTE_STATUS.TIMEOUT, `${what} exceeded its ${timeoutMs} ms budget and was aborted`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  ROUTE_STATUS,
  AVAILABILITY,
  CANDIDATE_IDS,
  AdapterError,
  HOSTED_HOSTS,
  PLACEHOLDER_TOKENS,
  assertSelfHosted,
  normaliseConfig,
  normaliseMatrixRequest,
  normaliseChargerRequest,
  describeDeployment,
  project,
  spreadSeconds,
  okAnswer,
  failedAnswer,
  nearestK,
  catalogueFor,
  chunkDestinations,
  optionalLocationCap,
  unavailable,
  withTimeout,
};

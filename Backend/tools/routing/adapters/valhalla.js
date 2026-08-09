"use strict";

/**
 * B1 candidate **Valhalla** — benchmark adapter.
 *
 * One of the four §27 item 2 candidates. **B1 Step 2** only: it makes Valhalla measurable
 * against the frozen benchmark contract. It selects nothing (Step 5), deploys nothing (Step 1,
 * blocked by **D1**), and is not the Phase 8 production routing client.
 *
 * ── Which Valhalla capability this maps onto ──────────────────────────────
 * `matrix()` → **`POST /sources_to_targets`**, with a single source (the origin cell) and the
 * cluster's destination cells as targets. That is §20.3 item 4's shape: one matrix per cell
 * cluster, shared across the Legs in it.
 *
 * `nearestChargers()` → the same endpoint, source pinned to the destination cell and the targets
 * taken from the injected charger catalogue, then ordered and truncated to `k`. Valhalla has no
 * notion of a charger; §20.3 item 3's population comes from the catalogue seam.
 *
 * ── Units — the one place this adapter must not be careless ───────────────
 * Valhalla's matrix returns **`distance` in the requested `units`** and **`time` in seconds**.
 * The default is kilometres, and a naive read would report a route 1000× shorter than it is.
 * So `units: "kilometres"` is sent explicitly, the response's echoed `units` is **checked**, and
 * the conversion to metres is the single multiplication below. An unexpected or absent `units`
 * is a malformed response, never a guess.
 *
 * ── R13, the bounded snap ─────────────────────────────────────────────────
 * Every location carries `radius`, so a point outside the cut extract fails with error 171
 * (*"No suitable edges near location"*) instead of snapping to whatever edge happens to be
 * nearest. That is reported as `EXTRACT_MISS`, distinct from `NO_ROUTE`.
 *
 * ── Determinism (R10) ─────────────────────────────────────────────────────
 * Answers are keyed back by Valhalla's own `to_index` rather than by array position, and
 * assembled in the caller's destination order. No clock, no sampling, no cache (§32.5).
 */

const contract = require("./contract");
const { jsonTransport } = require("./transport");
const deployment = require("./deployment");

const ID = "valhalla";

/** Kilometres to metres. Valhalla's matrix distance is in the requested units, never metres. */
const METRES_PER_KILOMETRE = 1000;

/** The `units` value this adapter sends and requires back. */
const UNITS = "kilometers";

/**
 * Valhalla error codes, mapped onto §32.5's failure conditions.
 *
 * Only codes whose meaning is unambiguous are mapped; anything else is an engine failure rather
 * than a guess, because misreading an error as `NO_ROUTE` would tell §18.3 B6's uniform-treatment
 * rule that a destination is genuinely unreachable when the engine merely refused the question.
 */
const ERROR_STATUS = Object.freeze({
  171: contract.ROUTE_STATUS.EXTRACT_MISS, // No suitable edges near location
  170: contract.ROUTE_STATUS.NO_ROUTE, // Locations are in unconnected regions
  154: contract.ROUTE_STATUS.NO_ROUTE, // Path distance exceeds the max distance limit
  150: contract.ROUTE_STATUS.MALFORMED_REQUEST, // Exceeded max locations
  151: contract.ROUTE_STATUS.MALFORMED_REQUEST, // Exceeded max time
  152: contract.ROUTE_STATUS.MALFORMED_REQUEST, // Exceeded max distance
  153: contract.ROUTE_STATUS.MALFORMED_REQUEST, // Too many shape points
  160: contract.ROUTE_STATUS.MALFORMED_REQUEST, // Insufficiently specified required parameter
  106: contract.ROUTE_STATUS.MALFORMED_REQUEST, // Try any of the supported actions
});

/**
 * Read one `sources_to_targets` response into a per-target-index lookup.
 *
 * @param {object} payload
 * @param {number} expected number of targets
 * @returns {Map<number, {distanceKm: number|null, timeSeconds: number|null}>}
 * @throws {contract.AdapterError}
 */
function readMatrix(payload, expected) {
  if (!payload || typeof payload !== "object") {
    throw new contract.AdapterError(ID, contract.ROUTE_STATUS.MALFORMED_RESPONSE, "sources_to_targets did not answer with a JSON object");
  }
  if (payload.error_code !== undefined || payload.error !== undefined) {
    const status = ERROR_STATUS[payload.error_code] || contract.ROUTE_STATUS.ENGINE_FAILURE;
    throw new contract.AdapterError(ID, status, `sources_to_targets answered error ${String(payload.error_code)} — ${String(payload.error)}`, {
      errorCode: payload.error_code,
    });
  }
  if (payload.units !== undefined && payload.units !== UNITS) {
    // Never converted from an unexpected unit. `units: "miles"` coming back from a request that
    // asked for kilometres means the deployment overrode the request, and silently applying a
    // second conversion factor is exactly the plausible-wrong-answer failure R13 also guards.
    throw new contract.AdapterError(
      ID,
      contract.ROUTE_STATUS.MALFORMED_RESPONSE,
      `sources_to_targets answered units "${String(payload.units)}" for a request that asked for "${UNITS}"`,
    );
  }

  const rows = Array.isArray(payload.sources_to_targets) ? payload.sources_to_targets[0] : null;
  if (!Array.isArray(rows)) {
    throw new contract.AdapterError(ID, contract.ROUTE_STATUS.MALFORMED_RESPONSE, "sources_to_targets returned no row for the single source");
  }
  if (rows.length !== expected) {
    throw new contract.AdapterError(ID, contract.ROUTE_STATUS.MALFORMED_RESPONSE, `sources_to_targets answered ${rows.length} cells for ${expected} targets`);
  }

  const byIndex = new Map();
  rows.forEach((cell, position) => {
    if (!cell || typeof cell !== "object") {
      throw new contract.AdapterError(ID, contract.ROUTE_STATUS.MALFORMED_RESPONSE, `sources_to_targets cell ${position} is not an object`);
    }
    // `to_index` is Valhalla's own statement of which target a cell answers. Trusting array
    // position instead would make the answer depend on a response ordering the API does not
    // promise, which is a determinism defect (R10) that would only ever show up intermittently.
    const index = Number.isInteger(cell.to_index) ? cell.to_index : position;
    byIndex.set(index, {
      distanceKm: cell.distance === null || cell.distance === undefined ? null : cell.distance,
      timeSeconds: cell.time === null || cell.time === undefined ? null : cell.time,
    });
  });
  return byIndex;
}

/**
 * Build one adapter against a deployed, self-hosted Valhalla.
 *
 * @param {object} config see `contract.normaliseConfig`; plus `maxLocationsPerQuery`
 * @returns {object} the adapter
 * @throws {contract.AdapterError} MALFORMED_REQUEST on invalid configuration
 */
function create(config) {
  const settings = contract.normaliseConfig(ID, config, { requiresSnapRadius: true });
  // Valhalla's `max_matrix_locations` is a per-costing service limit set by the deployment's own
  // configuration, so the cap is the operator's to state and this adapter chooses none.
  const maxLocationsPerQuery = contract.optionalLocationCap(config && config.maxLocationsPerQuery);
  const transport = settings.transport || jsonTransport(ID);

  /**
   * One `sources_to_targets` round trip: one source, `targets.length` targets.
   *
   * @param {{lat:number,lon:number}} source
   * @param {{lat:number,lon:number}[]} targets
   * @param {AbortSignal} signal
   * @returns {Promise<Map<number, object>>}
   */
  async function matrixQuery(source, targets, signal) {
    const location = (point) => ({ lat: point.lat, lon: point.lon, radius: settings.snapRadiusM });
    const { httpStatus, body } = await transport({
      method: "POST",
      url: `${settings.baseUrl}/sources_to_targets`,
      signal,
      body: {
        sources: [location(source)],
        targets: targets.map(location),
        costing: settings.engineProfile,
        units: UNITS,
      },
    });
    if (httpStatus >= 500) {
      throw new contract.AdapterError(ID, contract.ROUTE_STATUS.ENGINE_FAILURE, `sources_to_targets answered HTTP ${httpStatus}`, { httpStatus });
    }
    // Valhalla returns its own `error_code` in a 400 body, and that code is what says which of
    // §32.5's six conditions occurred, so the body is read rather than the status line.
    return readMatrix(body, targets.length);
  }

  return Object.freeze({
    id: ID,
    description: contract.describeDeployment(
      settings,
      `Valhalla /sources_to_targets, costing ${settings.engineProfile}, one query per cell cluster, radius=${settings.snapRadiusM} m, units=${UNITS}`,
    ),
    availability: Object.freeze({ status: contract.AVAILABILITY.AVAILABLE, reason: "configured against a self-hosted Valhalla deployment" }),
    profile: settings.profile,

    /**
     * §20.3 item 4 — one matrix per cell cluster.
     *
     * @param {object} request `{ originCellId, destCellIds, profileKey, timeBucket }`
     * @returns {Promise<object[]>} one entry per requested destination, in request order
     */
    async matrix(request) {
      const query = contract.normaliseMatrixRequest(ID, request);
      const origin = contract.project(ID, settings, query.originCellId);
      const destinations = query.destCellIds.map((destCellId) => ({ destCellId, point: contract.project(ID, settings, destCellId) }));

      return contract.withTimeout(ID, settings.matrixTimeoutMs, "the Valhalla sources_to_targets query", async (signal) => {
        const answers = [];
        for (const chunk of contract.chunkDestinations(destinations, maxLocationsPerQuery)) {
          // eslint-disable-next-line no-await-in-loop
          const byIndex = await matrixQuery(origin, chunk.map((entry) => entry.point), signal);
          chunk.forEach((entry, index) => {
            const cell = byIndex.get(index);
            // Valhalla reports an unreachable pair as `null` distance and time. Returned as an
            // explicit NO_ROUTE rather than omitted, and with no fabricated distance.
            if (!cell || cell.distanceKm === null || cell.timeSeconds === null) {
              answers.push(contract.failedAnswer(entry.destCellId, contract.ROUTE_STATUS.NO_ROUTE, "Valhalla returned a null distance/time for this pair — unreachable under this costing"));
              return;
            }
            answers.push(
              contract.okAnswer(ID, settings, {
                destCellId: entry.destCellId,
                distanceM: cell.distanceKm * METRES_PER_KILOMETRE,
                travelSeconds: cell.timeSeconds,
              }),
            );
          });
        }
        return answers;
      });
    },

    /**
     * §20.3 item 3 — the return-leg population, nearest `k` chargers from a destination cell.
     *
     * @param {object} request `{ destCellId, profileKey, timeBucket, k }`
     * @returns {Promise<object[]>} at most `k`, nearest first
     */
    async nearestChargers(request) {
      const query = contract.normaliseChargerRequest(ID, request);
      const origin = contract.project(ID, settings, query.destCellId);
      const catalogue = await contract.catalogueFor(ID, settings, query);
      if (catalogue.length === 0) return [];

      return contract.withTimeout(ID, settings.chargerTimeoutMs, "the Valhalla charger sources_to_targets query", async (signal) => {
        const scored = [];
        for (const chunk of contract.chunkDestinations(catalogue, maxLocationsPerQuery)) {
          // eslint-disable-next-line no-await-in-loop
          const byIndex = await matrixQuery(origin, chunk.map((charger) => ({ lat: charger.lat, lon: charger.lon })), signal);
          chunk.forEach((charger, index) => {
            const cell = byIndex.get(index);
            if (!cell || cell.distanceKm === null || cell.timeSeconds === null) {
              scored.push({ chargerId: charger.chargerId, status: contract.ROUTE_STATUS.NO_ROUTE });
              return;
            }
            scored.push({
              chargerId: charger.chargerId,
              chargerClass: charger.chargerClass ?? null,
              isDepot: charger.isDepot === true,
              status: contract.ROUTE_STATUS.OK,
              distanceM: cell.distanceKm * METRES_PER_KILOMETRE,
              travelSeconds: cell.timeSeconds,
            });
          });
        }
        return contract.nearestK(scored, query.k);
      });
    },
  });
}

/**
 * The module IS the adapter when a deployment is configured, and an honest refusal when it is
 * not — so the tool's existing `--engine <module>` seam selects it directly, and an unconfigured
 * candidate can never be mistaken for a fast one.
 */
module.exports = Object.assign({ id: ID, create }, deployment.materialise(ID, create, contract));

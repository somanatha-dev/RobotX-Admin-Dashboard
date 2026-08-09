"use strict";

/**
 * B1 candidate **OSRM** — benchmark adapter.
 *
 * One of the four §27 item 2 candidates. This module is **B1 Step 2** and nothing else: it
 * makes OSRM measurable against the frozen benchmark contract. It does not select OSRM (Step 5,
 * on recorded evidence), it does not deploy OSRM (Step 1, blocked by **D1**), and it is not the
 * Phase 8 production routing client.
 *
 * ── Which OSRM capability this maps onto ──────────────────────────────────
 * `matrix()` → the **Table** service, `GET /table/v1/{profile}/{coords}`, which is the query
 * §20.3 item 4 describes: one matrix per cell cluster, shared across the Legs in it. `sources=0`
 * pins the origin cell and `destinations=1;…;n` are the cluster's destination cells, so one
 * round trip answers the whole cluster — the shape `b1Benchmark.js:331–344` times.
 *
 * `nearestChargers()` → the same Table service, origin pinned to the destination cell and the
 * destinations taken from the injected charger catalogue, then ordered and truncated to `k`.
 * OSRM has no "nearest charger" concept; it has no idea what a charger is. §20.3 item 3's
 * population is supplied by the catalogue seam and this adapter measures the routing only.
 *
 * ── Units, checked against OSRM's own documentation ───────────────────────
 * `durations` are **seconds** and `distances` are **metres**, both floats. Neither is scaled
 * here. `distances` requires `annotations=distance`, which needs OSRM ≥ 5.20 — an engine that
 * answers without the block is reported as a malformed response rather than defaulted.
 *
 * ── R13, the bounded snap ─────────────────────────────────────────────────
 * `radiuses=` is sent for every coordinate. Without it OSRM snaps to the nearest edge **at any
 * distance**, so a point outside the extract comes back with a plausible route from somewhere
 * else entirely — the failure class §32.5 R13 exists to prevent. With it, an unsnappable
 * coordinate returns `code: "NoSegment"`, which this adapter reports as `EXTRACT_MISS`.
 *
 * ── What this adapter deliberately does not do ────────────────────────────
 * No public host (`assertSelfHosted` refuses `router.project-osrm.org` outright — §5.2, ADR-11,
 * R1). No cache of any kind (§32.5). No clock, no sampling, no unordered iteration (R10). No
 * fallback distance when OSRM says there is no route.
 */

const contract = require("./contract");
const { jsonTransport } = require("./transport");
const deployment = require("./deployment");

const ID = "osrm";

/**
 * OSRM's `code` values, mapped onto §32.5's failure conditions.
 *
 * The mapping matters more than it looks: `NoSegment` and `NoRoute` are different findings
 * about the deployment — the first says a coordinate is outside the graph the extract was cut
 * to, the second says two points on the graph are not connected — and §18.3 B6's
 * uniform-treatment rule only makes sense if a client can tell them apart.
 */
const CODE_STATUS = Object.freeze({
  NoSegment: contract.ROUTE_STATUS.EXTRACT_MISS,
  NoRoute: contract.ROUTE_STATUS.NO_ROUTE,
  NoTable: contract.ROUTE_STATUS.NO_ROUTE,
  TooBig: contract.ROUTE_STATUS.MALFORMED_REQUEST,
  InvalidQuery: contract.ROUTE_STATUS.MALFORMED_REQUEST,
  InvalidOptions: contract.ROUTE_STATUS.MALFORMED_REQUEST,
  InvalidValue: contract.ROUTE_STATUS.MALFORMED_REQUEST,
  InvalidService: contract.ROUTE_STATUS.MALFORMED_REQUEST,
  NotImplemented: contract.ROUTE_STATUS.ENGINE_FAILURE,
});

/** OSRM orders a coordinate `lon,lat`. Reversing it is a silent 90°-rotated answer. */
function coordinate(point) {
  return `${point.lon},${point.lat}`;
}

/**
 * Read one OSRM Table response into `{ distances, durations }` rows for a single source.
 *
 * @param {object} payload
 * @param {number} expected number of destinations
 * @returns {{ durations: (number|null)[], distances: (number|null)[] }}
 * @throws {contract.AdapterError}
 */
function readTable(payload, expected) {
  if (!payload || typeof payload !== "object") {
    throw new contract.AdapterError(ID, contract.ROUTE_STATUS.MALFORMED_RESPONSE, "the Table service did not answer with a JSON object");
  }
  if (payload.code !== "Ok") {
    const status = CODE_STATUS[payload.code] || contract.ROUTE_STATUS.ENGINE_FAILURE;
    throw new contract.AdapterError(ID, status, `the Table service answered code "${String(payload.code)}"${payload.message ? ` — ${payload.message}` : ""}`, {
      code: payload.code,
    });
  }
  const durations = Array.isArray(payload.durations) ? payload.durations[0] : null;
  const distances = Array.isArray(payload.distances) ? payload.distances[0] : null;
  if (!Array.isArray(durations)) {
    throw new contract.AdapterError(ID, contract.ROUTE_STATUS.MALFORMED_RESPONSE, "the Table service returned no durations row");
  }
  if (!Array.isArray(distances)) {
    // Never substituted. `distanceM` is a required output (§32.5) and a distance derived from a
    // duration and an assumed speed would be this adapter's arithmetic reported as the engine's
    // measurement.
    throw new contract.AdapterError(
      ID,
      contract.ROUTE_STATUS.MALFORMED_RESPONSE,
      "the Table service returned no distances row — send annotations=duration,distance and deploy OSRM ≥ 5.20; " +
        "distanceM is a required output and is never derived from a duration here",
    );
  }
  if (durations.length !== expected || distances.length !== expected) {
    throw new contract.AdapterError(
      ID,
      contract.ROUTE_STATUS.MALFORMED_RESPONSE,
      `the Table service answered ${durations.length} durations and ${distances.length} distances for ${expected} destinations`,
    );
  }
  return { durations, distances };
}

/**
 * Build one adapter against a deployed, self-hosted OSRM.
 *
 * @param {object} config see `contract.normaliseConfig`; plus `maxLocationsPerQuery`
 * @returns {object} the adapter
 * @throws {contract.AdapterError} MALFORMED_REQUEST on invalid configuration
 */
function create(config) {
  const settings = contract.normaliseConfig(ID, config, { requiresSnapRadius: true });
  // `--max-table-size` is the deployment's, not this adapter's: unset means "send one query and
  // let OSRM answer TooBig if it is over the limit", which is a true report about the deployment.
  const maxLocationsPerQuery = contract.optionalLocationCap(config && config.maxLocationsPerQuery);
  const transport = settings.transport || jsonTransport(ID);

  /**
   * One Table round trip: source at index 0, every other coordinate a destination.
   *
   * @param {{lat:number,lon:number}} origin
   * @param {{lat:number,lon:number}[]} destinations
   * @param {AbortSignal} signal
   * @returns {Promise<{ durations: (number|null)[], distances: (number|null)[] }>}
   */
  async function table(origin, destinations, signal) {
    const points = [origin, ...destinations];
    const path = points.map(coordinate).join(";");
    const destinationIndices = destinations.map((unused, index) => index + 1).join(";");
    const radiuses = points.map(() => settings.snapRadiusM).join(";");
    const url =
      `${settings.baseUrl}/table/v1/${encodeURIComponent(settings.engineProfile)}/${path}` +
      `?sources=0&destinations=${destinationIndices}&annotations=duration,distance&radiuses=${radiuses}`;

    const { httpStatus, body } = await transport({ method: "GET", url, signal });
    if (httpStatus >= 500) {
      throw new contract.AdapterError(ID, contract.ROUTE_STATUS.ENGINE_FAILURE, `the Table service answered HTTP ${httpStatus}`, { httpStatus });
    }
    // A 400 from OSRM carries a `code` that says which of the six conditions it is, so it is
    // read rather than rejected on the status line alone.
    return readTable(body, destinations.length);
  }

  return Object.freeze({
    id: ID,
    description: contract.describeDeployment(
      settings,
      `OSRM Table service /table/v1/${settings.engineProfile}, one query per cell cluster, radiuses=${settings.snapRadiusM} m`,
    ),
    availability: Object.freeze({ status: contract.AVAILABILITY.AVAILABLE, reason: "configured against a self-hosted OSRM deployment" }),
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

      return contract.withTimeout(ID, settings.matrixTimeoutMs, "the OSRM Table query", async (signal) => {
        const answers = [];
        for (const chunk of contract.chunkDestinations(destinations, maxLocationsPerQuery)) {
          // eslint-disable-next-line no-await-in-loop
          const { durations, distances } = await table(origin, chunk.map((entry) => entry.point), signal);
          chunk.forEach((entry, index) => {
            const travelSeconds = durations[index];
            const distanceM = distances[index];
            // OSRM reports an unreachable pair as `null` in both matrices. Returned as an
            // explicit NO_ROUTE rather than omitted, so §18.3 B6's uniform treatment can see it.
            if (travelSeconds === null || distanceM === null) {
              answers.push(contract.failedAnswer(entry.destCellId, contract.ROUTE_STATUS.NO_ROUTE, "OSRM returned null for this pair — unreachable under this profile"));
              return;
            }
            answers.push(contract.okAnswer(ID, settings, { destCellId: entry.destCellId, distanceM, travelSeconds }));
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

      return contract.withTimeout(ID, settings.chargerTimeoutMs, "the OSRM charger Table query", async (signal) => {
        const scored = [];
        for (const chunk of contract.chunkDestinations(catalogue, maxLocationsPerQuery)) {
          // eslint-disable-next-line no-await-in-loop
          const { durations, distances } = await table(origin, chunk.map((charger) => ({ lat: charger.lat, lon: charger.lon })), signal);
          chunk.forEach((charger, index) => {
            const travelSeconds = durations[index];
            const distanceM = distances[index];
            if (travelSeconds === null || distanceM === null) {
              scored.push({ chargerId: charger.chargerId, status: contract.ROUTE_STATUS.NO_ROUTE });
              return;
            }
            scored.push({
              chargerId: charger.chargerId,
              chargerClass: charger.chargerClass ?? null,
              isDepot: charger.isDepot === true,
              status: contract.ROUTE_STATUS.OK,
              distanceM,
              travelSeconds,
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

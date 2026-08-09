"use strict";

/**
 * B1 candidate **GraphHopper** — benchmark adapter.
 *
 * One of the four §27 item 2 candidates. **B1 Step 2** only: it makes GraphHopper measurable
 * against the frozen benchmark contract. It selects nothing (Step 5), deploys nothing (Step 1,
 * blocked by **D1**), and is not the Phase 8 production routing client.
 *
 * ── The capability difference this adapter must not hide ──────────────────
 * GraphHopper's **Matrix API is not part of the self-hostable open-source server** — it is a
 * hosted/licensed product. §5.2 and **ADR-11** make self-hosting non-negotiable, and §32.4 R1
 * marks it the one requirement that is not negotiable at all, so this adapter **may not** reach
 * for the hosted matrix. `assertSelfHosted` refuses `graphhopper.com` outright.
 *
 * What the self-hosted server does expose is `GET /route`, one origin–destination pair per
 * request. So `matrix()` here is a **fan-out of N point-to-point queries**, and that is a real
 * property of this candidate rather than a shortcoming of this file. §20.3 item 4's whole claim
 * is that one matrix per cell cluster amortises across the Legs in it; a candidate that cannot
 * batch pays the amortisation back in round trips, and `approach_routing_matrix` is precisely
 * the row where B1 is supposed to see that. **The benchmark is not weakened to hide it, and the
 * fan-out is not presented as a matrix query.**
 *
 * `matrixConcurrency` exists so the measurement is about GraphHopper rather than about this
 * loop: a deployment that would be queried with a connection pool should be measured that way.
 * It defaults to **1**, results are assembled by destination index regardless of completion
 * order, and the answer is therefore identical on every run (R10).
 *
 * ── Units ─────────────────────────────────────────────────────────────────
 * GraphHopper returns `distance` in **metres** and `time` in **milliseconds**. The millisecond
 * conversion is the single division below; nothing else is scaled.
 *
 * ── R13, and the limitation recorded rather than papered over ─────────────
 * The self-hosted `/route` endpoint has **no per-point snap-radius parameter**, so §32.4 R13 —
 * *"a point outside the extract must fail, not silently snap"* — is only partly satisfied:
 * GraphHopper does raise `PointNotFoundException` / `PointOutOfBoundsException` outside the
 * extract, but the snap distance inside it is unbounded and unreported. That is stated in this
 * adapter's `description` so it reaches the Step 5 record, and it is **not** simulated here by
 * an adapter-side distance check, which would be this file's arithmetic reported as the engine's
 * behaviour.
 */

const contract = require("./contract");
const { jsonTransport } = require("./transport");
const deployment = require("./deployment");

const ID = "graphhopper";

/** GraphHopper reports `time` in milliseconds; every other duration in this system is seconds. */
const MILLISECONDS_PER_SECOND = 1000;

/**
 * GraphHopper signals the condition through a Java exception class name in `hints[].details`.
 *
 * The distinction is the one §32.5 requires and §18.3 B6 depends on: a point outside the cut
 * extract is a finding about the extract, and two connected-region failures are a finding about
 * the graph. Reading either as the other would let a candidate be judged on the wrong evidence.
 */
const DETAIL_STATUS = Object.freeze([
  ["PointOutOfBoundsException", contract.ROUTE_STATUS.EXTRACT_MISS],
  ["PointNotFoundException", contract.ROUTE_STATUS.EXTRACT_MISS],
  ["ConnectionNotFoundException", contract.ROUTE_STATUS.NO_ROUTE],
  ["MaximumNodesExceededException", contract.ROUTE_STATUS.NO_ROUTE],
]);

/**
 * Classify a non-2xx `/route` answer.
 *
 * @param {object|string|null} body
 * @returns {{ status: string, reason: string }}
 */
function classify(body) {
  const hints = body && typeof body === "object" && Array.isArray(body.hints) ? body.hints : [];
  const message = body && typeof body === "object" && typeof body.message === "string" ? body.message : String(body === null ? "" : body);
  for (const hint of hints) {
    const details = hint && typeof hint.details === "string" ? hint.details : "";
    for (const [needle, status] of DETAIL_STATUS) {
      if (details.includes(needle)) return { status, reason: `${needle}${hint.message ? ` — ${hint.message}` : ""}` };
    }
  }
  // Unrecognised: an engine failure, never NO_ROUTE. Guessing "unreachable" from an error the
  // adapter does not understand would tell the uniform-treatment rule something untrue.
  return { status: contract.ROUTE_STATUS.ENGINE_FAILURE, reason: message || "GraphHopper refused the query without a recognised hint" };
}

/**
 * Read one `/route` answer into physics, or into the reason there is none.
 *
 * @param {number} httpStatus
 * @param {object|string|null} body
 * @returns {{ ok: true, distanceM: number, travelSeconds: number }|{ ok: false, status: string, reason: string }}
 * @throws {contract.AdapterError} on a malformed 2xx answer
 */
function readRoute(httpStatus, body) {
  if (httpStatus >= 500) {
    throw new contract.AdapterError(ID, contract.ROUTE_STATUS.ENGINE_FAILURE, `/route answered HTTP ${httpStatus}`, { httpStatus });
  }
  if (httpStatus >= 400) return Object.assign({ ok: false }, classify(body));
  if (!body || typeof body !== "object" || !Array.isArray(body.paths)) {
    throw new contract.AdapterError(ID, contract.ROUTE_STATUS.MALFORMED_RESPONSE, "/route answered 2xx without a paths array");
  }
  if (body.paths.length === 0) {
    // A 200 with no path is GraphHopper saying it found nothing, which is a route answer.
    return { ok: false, status: contract.ROUTE_STATUS.NO_ROUTE, reason: "/route returned an empty paths array" };
  }
  const path = body.paths[0];
  if (!path || typeof path.distance !== "number" || typeof path.time !== "number") {
    throw new contract.AdapterError(ID, contract.ROUTE_STATUS.MALFORMED_RESPONSE, "/route returned a path without a numeric distance and time");
  }
  return { ok: true, distanceM: path.distance, travelSeconds: path.time / MILLISECONDS_PER_SECOND };
}

/**
 * Run `tasks` with at most `limit` in flight, returning results in **input order**.
 *
 * Completion order is not result order: a matrix whose rows depended on which request finished
 * first would fail §9.6's byte-for-byte replay requirement intermittently, which is the worst
 * way for a determinism defect to exist.
 *
 * @param {(() => Promise<*>)[]} tasks
 * @param {number} limit
 * @returns {Promise<*[]>}
 */
async function inOrder(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= tasks.length) return;
      // eslint-disable-next-line no-await-in-loop
      results[index] = await tasks[index]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/**
 * Build one adapter against a deployed, self-hosted GraphHopper.
 *
 * @param {object} config see `contract.normaliseConfig`; plus `matrixConcurrency`
 * @returns {object} the adapter
 * @throws {contract.AdapterError} MALFORMED_REQUEST on invalid configuration
 */
function create(config) {
  // `requiresSnapRadius` is false: the self-hosted /route endpoint has no radius parameter, so
  // demanding one in configuration would imply this adapter enforces a bound it cannot enforce.
  const settings = contract.normaliseConfig(ID, config, { requiresSnapRadius: false });
  const concurrency = Number.isInteger(config && config.matrixConcurrency) && config.matrixConcurrency > 0 ? config.matrixConcurrency : 1;
  const transport = settings.transport || jsonTransport(ID);

  /**
   * One `/route` round trip.
   *
   * `calc_points=false` and `instructions=false` because the benchmark contract needs distance
   * and duration and nothing else; asking for geometry would charge this candidate for
   * serialising a polyline the measurement then discards. The **path/geometry** query is a
   * separate §5.2 row with its own 400 ms budget and is **not in A1** at all (N24).
   *
   * @param {{lat:number,lon:number}} from
   * @param {{lat:number,lon:number}} to
   * @param {AbortSignal} signal
   * @returns {Promise<object>}
   */
  async function route(from, to, signal) {
    const url =
      `${settings.baseUrl}/route?point=${from.lat},${from.lon}&point=${to.lat},${to.lon}` +
      `&profile=${encodeURIComponent(settings.engineProfile)}&calc_points=false&instructions=false`;
    const { httpStatus, body } = await transport({ method: "GET", url, signal });
    return readRoute(httpStatus, body);
  }

  return Object.freeze({
    id: ID,
    description: contract.describeDeployment(
      settings,
      `self-hosted GraphHopper GET /route, profile ${settings.engineProfile}; the open-source server ships NO matrix ` +
        `endpoint, so one cell-cluster matrix is a fan-out of N point-to-point queries at concurrency ${concurrency}; ` +
        "R13 PARTIAL — /route accepts no snap radius, so the snap distance inside the extract is unbounded and unreported",
    ),
    availability: Object.freeze({ status: contract.AVAILABILITY.AVAILABLE, reason: "configured against a self-hosted GraphHopper deployment" }),
    profile: settings.profile,

    /**
     * §20.3 item 4 — one matrix per cell cluster, served here as N `/route` queries.
     *
     * @param {object} request `{ originCellId, destCellIds, profileKey, timeBucket }`
     * @returns {Promise<object[]>} one entry per requested destination, in request order
     */
    async matrix(request) {
      const query = contract.normaliseMatrixRequest(ID, request);
      const origin = contract.project(ID, settings, query.originCellId);
      const destinations = query.destCellIds.map((destCellId) => ({ destCellId, point: contract.project(ID, settings, destCellId) }));

      // One budget for the whole cluster matrix, not one per leg of the fan-out. §5.2's timeout
      // bounds the matrix query the round issues, and a per-request budget would let N of them
      // sum to N× the number the architecture states.
      return contract.withTimeout(ID, settings.matrixTimeoutMs, "the GraphHopper /route fan-out", async (signal) => {
        const answered = await inOrder(destinations.map((entry) => () => route(origin, entry.point, signal)), concurrency);
        return destinations.map((entry, index) => {
          const result = answered[index];
          if (!result.ok) return contract.failedAnswer(entry.destCellId, result.status, result.reason);
          return contract.okAnswer(ID, settings, { destCellId: entry.destCellId, distanceM: result.distanceM, travelSeconds: result.travelSeconds });
        });
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

      return contract.withTimeout(ID, settings.chargerTimeoutMs, "the GraphHopper charger /route fan-out", async (signal) => {
        const answered = await inOrder(catalogue.map((charger) => () => route(origin, { lat: charger.lat, lon: charger.lon }, signal)), concurrency);
        const scored = catalogue.map((charger, index) => {
          const result = answered[index];
          if (!result.ok) return { chargerId: charger.chargerId, status: result.status };
          return {
            chargerId: charger.chargerId,
            chargerClass: charger.chargerClass ?? null,
            isDepot: charger.isDepot === true,
            status: contract.ROUTE_STATUS.OK,
            distanceM: result.distanceM,
            travelSeconds: result.travelSeconds,
          };
        });
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

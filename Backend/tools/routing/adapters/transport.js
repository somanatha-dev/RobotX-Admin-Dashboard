"use strict";

/**
 * The one place a B1 benchmark adapter touches a socket.
 *
 * Every adapter takes its transport as an injected function so that the engine call is the only
 * thing behind the `ATTRIBUTION.ENGINE` timer, and so that an adapter's unit tests can exercise
 * request construction and response parsing **without a network**. `b1Benchmark.js` attributes
 * `approach_routing_matrix` and `charger_reachability_miss` to the engine because *"the timer
 * brackets a call into the adapter"* — anything this module did beyond one round trip would be
 * measured as the engine's.
 *
 * The transport contract, deliberately thin:
 *
 * ```js
 *   transport({ method, url, body, headers, signal })
 *     -> { httpStatus: number, body: object|string|null }
 * ```
 *
 * It resolves for **every** HTTP status. A 400 from a routing engine is usually a *routed*
 * answer — "connection between locations not found" — and turning it into a thrown error here
 * would erase the distinction between `NO_ROUTE` and `ENGINE_FAILURE` that §32.5 requires the
 * adapter to make. Only a transport-level failure throws.
 *
 * **No caching, at any level.** §32.5: *"Caching belongs OUTSIDE the adapter, at the two levels
 * that already exist. No second cache is invented here, and none may be added inside an
 * adapter."* A cache here would make the `ENGINE` rows measure this file, and would be un-keyed
 * by profile, time bucket and `charger_availability_version`.
 */

const { AdapterError, ROUTE_STATUS } = require("./contract");

/**
 * A JSON transport over `fetch`, with the abort signal supplied by the caller's budget.
 *
 * @param {string} engineId used only to attribute a failure
 * @returns {(request: object) => Promise<{ httpStatus: number, body: * }>}
 */
function jsonTransport(engineId) {
  return async function request({ method, url, body, headers, signal }) {
    let response;
    try {
      response = await fetch(url, {
        method: method || "GET",
        signal,
        headers: Object.assign({ accept: "application/json" }, body ? { "content-type": "application/json" } : null, headers || null),
        body: body === undefined || body === null ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      // An abort surfaces here too; `withTimeout` is what distinguishes it, because only it
      // knows whether the budget elapsed or the caller cancelled for another reason.
      if (error && error.name === "AbortError") throw error;
      throw new AdapterError(engineId, ROUTE_STATUS.ENGINE_FAILURE, `${method || "GET"} ${url} failed at the transport: ${error.message}`);
    }

    const text = await response.text();
    if (text.length === 0) return { httpStatus: response.status, body: null };
    try {
      return { httpStatus: response.status, body: JSON.parse(text) };
    } catch {
      // Not thrown: an engine that answers HTML on an error path is an engine failure the
      // adapter classifies with its own status, and the raw text is what makes it diagnosable.
      return { httpStatus: response.status, body: text };
    }
  };
}

module.exports = { jsonTransport };

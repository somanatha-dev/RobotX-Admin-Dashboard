"use strict";

/**
 * B1 candidate **in-house** — benchmark adapter. **NOT_IMPLEMENTED, and deliberately so.**
 *
 * §27 item 2 and execution plan §6.1 both list *"OSRM, Valhalla, GraphHopper, or **in-house**"*,
 * so the candidate is real and belongs in the roster. What does not exist is anything to adapt
 * **to**. An adapter's only legitimate job is to translate between the frozen benchmark contract
 * and an engine; with no engine, a module here could only be a second implementation of the
 * arithmetic it is supposed to be measuring — and any figure it produced would be a property of
 * this file, reported under a candidate's name. That is precisely the fabrication
 * `b1Benchmark.js` exists to refuse: *"It never reports an unmeasured row as a pass."*
 *
 * ── What was searched, and what was found ─────────────────────────────────
 * `src/engine/routing/` holds `cellPairCache.js`, `chargerReachabilityCache.js` and
 * `inProcessCache.js` — three **caches**, each of which explicitly takes the routing call as an
 * injected function so that it carries no dependency on any engine. There is no graph builder,
 * no contraction-hierarchy precomputation, no edge-cost model and no query engine anywhere in
 * `src/` or `tools/`.
 *
 * The nearest thing in the repository is `src/services/routing.service.js`, and it is **not** an
 * in-house routing engine by any reading of §5.2:
 *
 *   - it runs A* over an **already-supplied waypoint array**, not over a road or sidewalk graph
 *     cut from an extract;
 *   - it has no contraction hierarchy or any other precomputation, and §20.3 item 5 makes the
 *     precomputation *"the reason routing must be self-hosted"* — `b1Benchmark.js:586–587`:
 *     *"an engine measured without it is not measured"*;
 *   - it obtains real geometry from a **metered external API**, which is the option **ADR-11**
 *     records as *rejected*, and which §6.1 B1 names as *"explicitly incompatible with the hot
 *     path"*. It is the legacy path B1 replaces (finding **N30**), not a candidate to replace it
 *     with.
 *
 * Adapting it would enter the rejected option into the benchmark as the in-house candidate.
 *
 * ── What would change this file ───────────────────────────────────────────
 * An actual in-house geodesic engine — graph built from the D1 extract, per-profile edge costs
 * from D3's speed models, contraction hierarchies precomputed, a matrix query and a nearest-`k`
 * query — deployed like any other candidate. At that point this module implements `create()`
 * exactly as `osrm.js` and `valhalla.js` do, against whatever transport that engine exposes, and
 * the rest of the adapter layer needs no change. **Building that engine is not B1 Step 2, and
 * nothing here anticipates its shape.**
 */

const contract = require("./contract");

const ID = "inhouse";

const REASON =
  "no in-house routing engine exists in this repository. src/engine/routing/ holds three caches, each taking the " +
  "routing call as an injected function; there is no graph, no per-profile edge-cost model, no contraction-hierarchy " +
  "precomputation and no query engine. The nearest module runs A* over a supplied waypoint array and takes its " +
  "geometry from a metered external API — the option ADR-11 records as rejected and §6.1 B1 names as incompatible " +
  "with the hot path, so it is the legacy path B1 replaces (N30), not a candidate. An adapter written now could only " +
  "measure itself";

/**
 * Refuse to build. Kept as a function so the candidate has the same shape as the other three and
 * the roster can report it uniformly.
 *
 * @returns {never}
 * @throws {contract.AdapterError} NOT_IMPLEMENTED, carried as an engine failure
 */
function create() {
  throw new contract.AdapterError(ID, contract.ROUTE_STATUS.ENGINE_FAILURE, REASON);
}

/**
 * No `matrix` and no `nearestChargers`: the benchmark's existing adapter check refuses this
 * module, every row stays `NOT_MEASURED`, and `NOT_MEASURED` is not `PASS`.
 */
module.exports = Object.assign({ id: ID, create }, contract.unavailable(ID, contract.AVAILABILITY.NOT_IMPLEMENTED, REASON));

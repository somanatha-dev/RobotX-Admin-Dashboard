"use strict";

/**
 * The B1 candidate roster — **discovery and selection** for `tools/routing/b1Benchmark.js`.
 *
 * §27 item 2 and execution plan §6.1 name four candidates, and B1 Step 3 runs the benchmark
 * *"per candidate"*. This module is what makes "per candidate" a list the tool can walk rather
 * than four file paths somebody has to remember, and it is what makes an **undeployed** candidate
 * report the reason it cannot be measured instead of simply being absent.
 *
 * It selects nothing. Ranking, ordering and choosing are **B1 Step 5**, on recorded evidence, and
 * the order below is §27 item 2's own — not a preference.
 *
 * ```
 *   npm run routing:b1 -- --candidates            the roster and why each row is where it is
 *   npm run routing:b1 -- --engine osrm           by candidate id, through this registry
 *   npm run routing:b1 -- --engine ./some/file.js unchanged: the tool's original module seam
 * ```
 */

const contract = require("./contract");
const deployment = require("./deployment");

/**
 * Every candidate module, in §27 item 2's stated order.
 *
 * Requiring them materialises each one against `ROUTING_B1_DEPLOYMENT` (see `deployment.js`), so
 * a module either **is** an adapter or carries the `availability` reason it is not.
 */
const MODULES = Object.freeze({
  osrm: require("./osrm"),
  valhalla: require("./valhalla"),
  graphhopper: require("./graphhopper"),
  inhouse: require("./inhouse"),
});

/**
 * The adapter registered for a candidate id, or `null` if the id is not one of the four.
 *
 * @param {string} candidateId
 * @returns {object|null}
 */
function byId(candidateId) {
  return Object.prototype.hasOwnProperty.call(MODULES, candidateId) ? MODULES[candidateId] : null;
}

/**
 * What an adapter's availability is, for a module that may predate this field.
 *
 * @param {object} adapter
 * @returns {{ status: string, reason: string }}
 */
function availabilityOf(adapter) {
  if (adapter && adapter.availability && typeof adapter.availability.status === "string") return adapter.availability;
  // A hand-written adapter passed by path need not carry the field; if it can answer a matrix it
  // is available, and if it cannot the tool's existing check refuses it for that reason instead.
  return adapter && typeof adapter.matrix === "function"
    ? { status: contract.AVAILABILITY.AVAILABLE, reason: "adapter supplied by module path" }
    : { status: contract.AVAILABILITY.NOT_DEPLOYED, reason: "the module exports no matrix() function" };
}

/**
 * One row per candidate: what it is, whether it can be measured, and why not.
 *
 * @returns {object[]}
 */
function roster() {
  return contract.CANDIDATE_IDS.map((candidateId) => {
    const adapter = MODULES[candidateId];
    const availability = availabilityOf(adapter);
    return Object.freeze({
      id: candidateId,
      status: availability.status,
      reason: availability.reason,
      description: adapter && typeof adapter.description === "string" ? adapter.description : null,
      measurable: availability.status === contract.AVAILABILITY.AVAILABLE,
    });
  });
}

module.exports = {
  CANDIDATE_IDS: contract.CANDIDATE_IDS,
  // Re-exported so `b1Benchmark.js` compares against the enum rather than against a string
  // literal: the tool decides whether to measure on this value, and a drifted copy of it would
  // silently turn an undeployed candidate into a measured one.
  AVAILABILITY: contract.AVAILABILITY,
  DEPLOYMENT_ENV: deployment.DEPLOYMENT_ENV,
  byId,
  availabilityOf,
  roster,
};
